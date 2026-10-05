import type { EnvironmentId, GitResolvedIssue, ThreadId } from "@t3tools/contracts";
import { isAtomCommandInterrupted } from "@t3tools/client-runtime/state/runtime";
import { parseIssueReference } from "@t3tools/shared/git";
import { useAtomValue } from "@effect/atom-react";
import { useDebouncedValue } from "@tanstack/react-pacer";
import { Atom } from "effect/unstable/reactivity";
import { CircleDotIcon } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { useIssueResolution, usePrepareIssueThreadAction } from "~/lib/sourceControlActions";
import { cn } from "~/lib/utils";
import { appAtomRegistry } from "~/rpc/atomRegistry";
import { Button } from "./ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "./ui/dialog";
import { Input } from "./ui/input";
import { Spinner } from "./ui/spinner";

/**
 * Set by any entry point (command palette, branch picker) and rendered by the chat view, so the
 * dialog outlives a palette that closes the moment its command runs.
 */
const issueThreadDialogRequestAtom = Atom.make<{
  readonly reference: string | null;
  readonly key: number;
} | null>(null).pipe(Atom.keepAlive, Atom.withLabel("issues:start-dialog"));

export function openIssueThreadDialog(initialReference?: string): void {
  appAtomRegistry.set(issueThreadDialogRequestAtom, {
    reference: initialReference ?? null,
    key: Date.now(),
  });
}

export function closeIssueThreadDialog(): void {
  appAtomRegistry.set(issueThreadDialogRequestAtom, null);
}

export function useIssueThreadDialogRequest() {
  return useAtomValue(issueThreadDialogRequestAtom);
}

interface IssueThreadDialogProps {
  open: boolean;
  environmentId: EnvironmentId;
  threadId: ThreadId;
  cwd: string | null;
  initialReference: string | null;
  onOpenChange: (open: boolean) => void;
  onPrepared: (input: {
    issue: GitResolvedIssue;
    branch: string;
    worktreePath: string;
  }) => Promise<void> | void;
}

export function IssueThreadDialog({
  open,
  environmentId,
  threadId,
  cwd,
  initialReference,
  onOpenChange,
  onPrepared,
}: IssueThreadDialogProps) {
  const referenceInputRef = useRef<HTMLInputElement>(null);
  const [reference, setReference] = useState(initialReference ?? "");
  const [referenceDirty, setReferenceDirty] = useState(false);
  const [debouncedReference, referenceDebouncer] = useDebouncedValue(
    reference,
    { wait: 450 },
    (debouncerState) => ({ isPending: debouncerState.isPending }),
  );

  useEffect(() => {
    if (!open) return;
    const frame = window.requestAnimationFrame(() => {
      referenceInputRef.current?.focus();
      referenceInputRef.current?.select();
    });
    return () => {
      window.cancelAnimationFrame(frame);
    };
  }, [open]);

  const parsedReference = parseIssueReference(reference);
  const parsedDebouncedReference = parseIssueReference(debouncedReference);
  const scope = useMemo(() => ({ environmentId, cwd }), [cwd, environmentId]);
  const issueResolution = useIssueResolution({
    ...scope,
    reference: open ? parsedDebouncedReference : null,
  });
  const prepareIssueThreadAction = usePrepareIssueThreadAction(scope);

  const resolvedIssue =
    parsedReference !== null && parsedReference === parsedDebouncedReference
      ? (issueResolution.data?.issue ?? null)
      : null;
  const isResolving =
    open &&
    parsedReference !== null &&
    resolvedIssue === null &&
    issueResolution.error === null &&
    (referenceDebouncer.state.isPending ||
      parsedReference !== parsedDebouncedReference ||
      issueResolution.isPending);

  const handleConfirm = useCallback(async () => {
    if (!parsedReference) {
      setReferenceDirty(true);
      return;
    }
    if (!resolvedIssue || !cwd) return;
    const result = await prepareIssueThreadAction.run({ reference: parsedReference, threadId });
    if (result._tag === "Failure") {
      if (isAtomCommandInterrupted(result)) prepareIssueThreadAction.resetError();
      return;
    }
    await onPrepared({
      issue: result.value.issue,
      branch: result.value.branch,
      worktreePath: result.value.worktreePath,
    });
    onOpenChange(false);
  }, [
    cwd,
    onOpenChange,
    onPrepared,
    parsedReference,
    prepareIssueThreadAction,
    resolvedIssue,
    threadId,
  ]);

  const validationMessage = !referenceDirty
    ? null
    : parsedReference === null
      ? "Paste a GitHub issue URL or enter 123 / #123."
      : null;
  const errorMessage =
    validationMessage ??
    (resolvedIssue === null && issueResolution.error
      ? issueResolution.error
      : prepareIssueThreadAction.error instanceof Error
        ? prepareIssueThreadAction.error.message
        : prepareIssueThreadAction.error
          ? "Failed to start the issue thread."
          : null);
  const canStart =
    cwd !== null && resolvedIssue !== null && !isResolving && !prepareIssueThreadAction.isPending;

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (!prepareIssueThreadAction.isPending) onOpenChange(nextOpen);
      }}
    >
      <DialogPopup className="max-w-xl">
        <DialogHeader>
          <DialogTitle className="flex items-center">
            <CircleDotIcon className="me-2 size-4" />
            Start work from issue
          </DialogTitle>
          <DialogDescription>
            Resolve a GitHub issue, then start a draft thread in a new worktree on its own branch.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <label className="grid gap-1.5">
            <span className="text-xs font-medium text-foreground">Issue</span>
            <Input
              ref={referenceInputRef}
              placeholder="Issue URL, #123, or 123"
              value={reference}
              onChange={(event) => {
                setReferenceDirty(true);
                setReference(event.target.value);
              }}
              onKeyDown={(event) => {
                if (event.key !== "Enter") return;
                if (event.nativeEvent.isComposing || event.keyCode === 229) return;
                event.preventDefault();
                if (canStart || !parsedReference) void handleConfirm();
              }}
            />
          </label>

          {resolvedIssue ? (
            <div className="rounded-xl border border-border/70 bg-muted/24 p-3">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="truncate font-medium text-sm">{resolvedIssue.title}</p>
                  <p className="truncate text-muted-foreground text-xs">#{resolvedIssue.number}</p>
                </div>
                <span
                  className={cn(
                    "shrink-0 text-xs capitalize",
                    resolvedIssue.state === "open" ? "text-success" : "text-muted-foreground",
                  )}
                >
                  {resolvedIssue.state}
                </span>
              </div>
            </div>
          ) : null}

          {isResolving ? (
            <div className="flex items-center gap-2 text-muted-foreground text-xs">
              <Spinner size="sm" />
              Resolving issue...
            </div>
          ) : null}

          {errorMessage ? <p className="text-destructive text-xs">{errorMessage}</p> : null}
        </DialogPanel>
        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => onOpenChange(false)}
            disabled={prepareIssueThreadAction.isPending}
          >
            Cancel
          </Button>
          <Button
            type="button"
            size="sm"
            onClick={() => {
              void handleConfirm();
            }}
            disabled={!canStart}
          >
            {prepareIssueThreadAction.isPending ? "Starting..." : "Start work"}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
