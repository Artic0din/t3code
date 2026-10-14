import { useAtomValue } from "@effect/atom-react";
import { useNavigate } from "@tanstack/react-router";
import {
  linkedIssueFromResolved,
  issueAvailabilityFromFailure,
  parseGitHubIssueUrl,
  relatedIssueThreads,
  type EnvironmentId,
  type ThreadId,
  type ThreadLinkedIssue,
} from "@t3tools/contracts";
import { useRef, useState } from "react";

import { useAtomCommand } from "~/state/use-atom-command";
import { buildThreadRouteParams } from "~/threadRoutes";
import { threadEnvironment } from "~/state/threads";
import { useIssueResolution } from "~/state/sourceControlActions";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { useArchivedThreadSnapshots } from "../../lib/archivedThreadsState";

function availabilityLabel(issue: ThreadLinkedIssue): string | null {
  switch (issue.availability) {
    case "open":
    case "closed":
      return null;
    case "missing":
      return "This issue could not be found. Unlink it or link it again.";
    case "inaccessible":
      return "This issue could not be read. Unlink it or link it again.";
    default: {
      const unreachable: never = issue.availability;
      return unreachable;
    }
  }
}

interface ThreadIssueRowProps {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly cwd: string | null;
  readonly linkedIssue: ThreadLinkedIssue | null;
}

export function ThreadIssueRow(props: ThreadIssueRowProps) {
  return (
    <ThreadIssueRowForTarget
      key={JSON.stringify([props.environmentId, props.threadId])}
      {...props}
    />
  );
}

function ThreadIssueRowForTarget(props: ThreadIssueRowProps) {
  const navigate = useNavigate();
  const snapshot = useAtomValue(threadEnvironment.snapshotAtom(props.environmentId));
  const archived = useArchivedThreadSnapshots(
    props.linkedIssue === null ? [] : [props.environmentId],
  );
  const archivedShells =
    archived.snapshots.find((entry) => entry.environmentId === props.environmentId)?.snapshot
      .threads ?? [];
  const threads = [...(snapshot?.threads ?? []), ...archivedShells];
  const linkIssue = useAtomCommand(threadEnvironment.linkIssue, { reportFailure: false });
  const unlinkIssue = useAtomCommand(threadEnvironment.unlinkIssue, { reportFailure: false });
  const [reference, setReference] = useState("");
  const referenceRevision = useRef(0);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const resolution = useIssueResolution({
    environmentId: props.environmentId,
    cwd: props.cwd,
    reference: reference.trim().length > 0 ? reference.trim() : null,
  });
  const related =
    props.linkedIssue === null
      ? []
      : relatedIssueThreads(threads, props.linkedIssue, props.threadId);
  const availability = props.linkedIssue === null ? null : availabilityLabel(props.linkedIssue);
  const resolved = resolution.data?.issue ?? null;
  const resolutionDetail = resolution.error;
  const unavailable =
    resolved === null && resolutionDetail !== null
      ? issueAvailabilityFromFailure(resolutionDetail)
      : null;
  const parsedFailure = unavailable === null ? null : parseGitHubIssueUrl(reference);
  const canSubmit =
    props.cwd !== null &&
    reference.trim().length > 0 &&
    !resolution.isPending &&
    (resolved !== null || parsedFailure !== null);

  const linkReference = async () => {
    if (props.cwd === null) return;
    const linkedIssue =
      resolved !== null
        ? linkedIssueFromResolved(resolved)
        : parsedFailure !== null && unavailable !== null
          ? { ...parsedFailure, title: null, availability: unavailable }
          : null;
    if (linkedIssue == null) {
      setSubmitError("That issue URL does not identify a GitHub issue.");
      return;
    }
    const requestedRevision = referenceRevision.current;
    const result = await linkIssue({
      environmentId: props.environmentId,
      input: {
        threadId: props.threadId,
        host: linkedIssue.host,
        repository: linkedIssue.repository,
        number: linkedIssue.number,
        url: linkedIssue.url,
        title: linkedIssue.title,
        availability: linkedIssue.availability,
      },
    });
    if (referenceRevision.current !== requestedRevision) return;
    if (result._tag === "Failure") {
      setSubmitError("Could not link the issue.");
      return;
    }
    referenceRevision.current += 1;
    setReference("");
    setSubmitError(null);
  };

  return (
    <div>
      {props.linkedIssue === null ? null : (
        <div>
          <a href={props.linkedIssue.url} target="_blank" rel="noreferrer">
            {props.linkedIssue.title ??
              `${props.linkedIssue.repository}#${props.linkedIssue.number}`}
          </a>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            onClick={() => {
              const issue = props.linkedIssue;
              if (issue === null) return;
              void (async () => {
                const result = await unlinkIssue({
                  environmentId: props.environmentId,
                  input: {
                    threadId: props.threadId,
                    host: issue.host,
                    repository: issue.repository,
                    number: issue.number,
                  },
                });
                if (result._tag === "Failure") {
                  setSubmitError("Could not unlink the issue.");
                }
              })();
            }}
          >
            Unlink
          </Button>
          {availability === null ? null : <p>{availability}</p>}
          {archived.isLoading ? <p>Loading related threads.</p> : null}
          {archived.error === null ? null : <p>{archived.error}</p>}
          {related.length === 0 ? (
            archived.isLoading || archived.error !== null ? null : (
              <p>No other threads are linked to this issue.</p>
            )
          ) : (
            <ul>
              {related.map((thread) => (
                <li key={thread.id}>
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    onClick={() => {
                      void navigate({
                        to: "/$environmentId/$threadId",
                        params: buildThreadRouteParams({
                          environmentId: props.environmentId,
                          threadId: thread.id,
                        }),
                      });
                    }}
                  >
                    {thread.title}
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (!canSubmit) return;
          void linkReference();
        }}
      >
        <Input
          size="sm"
          value={reference}
          placeholder={
            props.linkedIssue === null ? "Link a GitHub issue" : "Link a different issue"
          }
          aria-label={props.linkedIssue === null ? "Link a GitHub issue" : "Link a different issue"}
          onChange={(event) => {
            referenceRevision.current += 1;
            setReference(event.target.value);
            setSubmitError(null);
          }}
        />
        <Button type="submit" size="sm" variant="outline" disabled={!canSubmit}>
          {props.linkedIssue === null ? "Link" : "Relink"}
        </Button>
      </form>
      {submitError === null && resolutionDetail !== null ? <p>{resolutionDetail}</p> : null}
      {submitError === null ? null : <p>{submitError}</p>}
    </div>
  );
}
