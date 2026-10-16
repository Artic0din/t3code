import { useAtomValue } from "@effect/atom-react";
import { useNavigate } from "@tanstack/react-router";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import {
  taskContextAccess,
  taskContextResourceInput,
  TASK_CONTEXT_RESOURCE_KINDS,
  type TaskContextResourceDraft,
} from "@t3tools/client-runtime/task-context-group";
import {
  TASK_CONTEXT_BRIEF_MAX_CHARS,
  TASK_CONTEXT_NOTE_MAX_CHARS,
  TASK_CONTEXT_TITLE_MAX_CHARS,
  type EnvironmentId,
  type TaskContextGroupMutateInput,
  type ThreadId,
} from "@t3tools/contracts";
import { useState } from "react";

import { useProjects, useThreadShells } from "../../state/entities";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { environmentSession } from "../../state/session";
import { useAtomCommand } from "../../state/use-atom-command";
import { buildThreadRouteParams } from "../../threadRoutes";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Textarea } from "../ui/textarea";
import { ThreadDetailsSection } from "./ThreadDetailsSection";

type Props = { readonly environmentId: EnvironmentId; readonly threadId: ThreadId };

function Picker(props: {
  label: string;
  value: string | null;
  choices: ReadonlyArray<{ value: string; label: string }>;
  disabled: boolean;
  onChange: (value: string | null) => void;
}) {
  return (
    <Select
      value={props.value}
      items={props.choices}
      disabled={props.disabled}
      onValueChange={props.onChange}
    >
      <SelectTrigger size="sm" aria-label={props.label}>
        <SelectValue placeholder={props.label} />
      </SelectTrigger>
      <SelectPopup>
        {props.choices.map((choice) => (
          <SelectItem key={choice.value} value={choice.value}>
            {choice.label}
          </SelectItem>
        ))}
      </SelectPopup>
    </Select>
  );
}

export function TaskContextGroupPanel(props: Props) {
  const config = useAtomValue(serverEnvironment.configValueAtom(props.environmentId));
  if (config?.environment.capabilities.taskContextGroups !== true) return null;
  return <TaskContextControls key={`${props.environmentId}:${props.threadId}`} {...props} />;
}

function TaskContextControls(props: Props) {
  const navigate = useNavigate();
  const session = useEnvironmentQuery(environmentSession.sessionStateAtom(props.environmentId));
  const access = taskContextAccess({ taskContextGroups: true }, session.data);
  const query = useEnvironmentQuery(
    access.readable
      ? serverEnvironment.taskContextGroupForThread({
          environmentId: props.environmentId,
          input: { threadId: props.threadId },
        })
      : null,
  );
  const group = query.data?.group ?? null;
  const groups = useEnvironmentQuery(
    access.readable && query.isSuccess && !query.isPending && query.data?.group === null
      ? serverEnvironment.taskContextGroupsList({
          environmentId: props.environmentId,
          input: {},
        })
      : null,
  );
  const threads = useThreadShells(access.readable).filter(
    (thread) => thread.environmentId === props.environmentId,
  );
  const projects = useProjects().filter((project) => project.environmentId === props.environmentId);
  const mutate = useAtomCommand(serverEnvironment.mutateTaskContextGroup, { reportFailure: false });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [brief, setBrief] = useState("");
  const [title, setTitle] = useState("");
  const [joining, setJoining] = useState<string | null>(null);
  const [attaching, setAttaching] = useState<string | null>(null);
  const [resource, setResource] = useState<TaskContextResourceDraft>({
    kind: "note",
    title: "",
    text: "",
    threadId: null,
    projectId: null,
  });
  const disabled = busy || !access.writable;
  const resourceInput = taskContextResourceInput(resource);
  const perform = async (input: TaskContextGroupMutateInput) => {
    if (disabled) return;
    setBusy(true);
    setError(null);
    try {
      const result = await mutate({ environmentId: props.environmentId, input });
      if (result._tag === "Failure") {
        const cause = squashAtomCommandFailure(result);
        setError(cause instanceof Error ? cause.message : "Shared context could not be updated.");
      } else {
        setAttaching(null);
        if (input.action === "attach-resource")
          setResource({ ...resource, title: "", text: "", threadId: null, projectId: null });
        if (input.action === "detach-thread" && input.threadId === props.threadId)
          setEditing(false);
      }
    } catch {
      setError("Shared context could not be updated. Retry the change.");
    } finally {
      setBusy(false);
    }
  };
  const heading = "thread-details-task-context-heading";
  if (!access.readable || (query.isPending && query.data === null) || query.error !== null) {
    const message =
      session.error ??
      query.error ??
      (session.data === null || query.isPending
        ? "Loading shared context..."
        : "This connection cannot read shared context.");
    return (
      <ThreadDetailsSection headingId={heading} title="Shared context">
        <div className="flex flex-col gap-2 px-3 py-2">
          <p className="text-sm text-muted-foreground" role="status">
            {message}
          </p>
          {session.error || query.error ? (
            <Button
              size="xs"
              variant="ghost"
              onClick={() => {
                session.refresh();
                query.refresh();
              }}
            >
              Retry
            </Button>
          ) : null}
        </div>
      </ThreadDetailsSection>
    );
  }
  return (
    <ThreadDetailsSection headingId={heading} title="Shared context">
      <div className="flex flex-col gap-2 px-3 py-2" aria-busy={busy}>
        {group === null ? (
          <>
            <p className="text-sm text-muted-foreground">No shared task context for this thread.</p>
            <Input
              size="sm"
              aria-label="Group title"
              maxLength={TASK_CONTEXT_TITLE_MAX_CHARS}
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              disabled={disabled}
            />
            <Button
              size="xs"
              variant="ghost"
              disabled={disabled}
              onClick={() => {
                void perform({
                  action: "create",
                  threadId: props.threadId,
                  ...(title.trim() ? { title: title.trim() } : {}),
                });
              }}
            >
              Create shared context
            </Button>
            {groups.isPending ? (
              <p role="status" className="text-sm text-muted-foreground">
                Loading existing groups...
              </p>
            ) : null}
            {groups.error ? (
              <>
                <p role="alert" className="text-sm text-destructive">
                  {groups.error}
                </p>
                <Button size="xs" variant="ghost" onClick={groups.refresh}>
                  Retry groups
                </Button>
              </>
            ) : null}
            {(groups.data?.groups.length ?? 0) > 0 ? (
              <>
                <Picker
                  label="Existing group"
                  value={joining}
                  disabled={disabled}
                  choices={(groups.data?.groups ?? []).map((item) => ({
                    value: item.id,
                    label: item.title,
                  }))}
                  onChange={setJoining}
                />
                <Button
                  size="xs"
                  variant="ghost"
                  disabled={disabled || joining === null}
                  onClick={() => {
                    const selected = groups.data?.groups.find((item) => item.id === joining);
                    if (selected)
                      void perform({
                        action: "attach-thread",
                        groupId: selected.id,
                        threadId: props.threadId,
                      });
                  }}
                >
                  Join group
                </Button>
              </>
            ) : null}
          </>
        ) : (
          <>
            <p className="text-sm font-medium text-foreground">{group.title}</p>
            <p className="whitespace-pre-wrap text-sm text-muted-foreground">
              {group.brief || "No brief yet."}
            </p>
            {(query.data?.relatedThreads ?? []).map((thread) => (
              <div key={thread.threadId} className="flex items-center justify-between gap-2">
                <Button
                  size="xs"
                  variant="ghost"
                  disabled={thread.availability === "missing"}
                  onClick={() => {
                    void navigate({
                      to: "/$environmentId/$threadId",
                      params: buildThreadRouteParams(
                        scopeThreadRef(props.environmentId, thread.threadId),
                      ),
                    }).catch(() => setError("The related thread could not be opened."));
                  }}
                >
                  {thread.title}
                </Button>
                {editing ? (
                  <Button
                    size="xs"
                    variant="ghost"
                    disabled={disabled}
                    onClick={() => {
                      void perform({
                        action: "detach-thread",
                        groupId: group.id,
                        threadId: thread.threadId,
                      });
                    }}
                  >
                    Detach
                  </Button>
                ) : null}
              </div>
            ))}
            {group.resources.map((item) => (
              <div key={item.resourceId} className="flex items-start justify-between gap-2">
                <div className="min-w-0 text-sm">
                  <p>
                    {item.kind === "project"
                      ? (item.name ?? item.projectId)
                      : item.kind === "thread"
                        ? (item.title ?? item.threadId)
                        : item.title}
                  </p>
                  {item.kind === "note" ? (
                    <p className="whitespace-pre-wrap text-muted-foreground">{item.body}</p>
                  ) : item.kind === "url" ? (
                    <a
                      href={item.url}
                      target="_blank"
                      rel="noreferrer"
                      className="break-all underline"
                    >
                      {item.url}
                    </a>
                  ) : item.availability !== "available" ? (
                    <p className="text-destructive">
                      Resource {item.availability ?? "unavailable"}.
                    </p>
                  ) : null}
                </div>
                {editing ? (
                  <Button
                    size="xs"
                    variant="ghost"
                    disabled={disabled}
                    onClick={() => {
                      void perform({
                        action: "detach-resource",
                        groupId: group.id,
                        resourceId: item.resourceId,
                      });
                    }}
                  >
                    Remove
                  </Button>
                ) : null}
              </div>
            ))}
            {access.writable ? (
              <Button
                size="xs"
                variant="ghost"
                disabled={busy}
                onClick={() => {
                  setBrief(group.brief);
                  setEditing(!editing);
                }}
              >
                {editing ? "Close editor" : "Edit shared context"}
              </Button>
            ) : null}
            {editing ? (
              <>
                <label className="text-sm">
                  Shared brief
                  <Textarea
                    size="sm"
                    aria-label="Shared brief"
                    maxLength={TASK_CONTEXT_BRIEF_MAX_CHARS}
                    value={brief}
                    disabled={disabled}
                    onChange={(event) => setBrief(event.target.value)}
                  />
                </label>
                <Button
                  size="xs"
                  disabled={disabled}
                  onClick={() => {
                    void perform({ action: "update-brief", groupId: group.id, brief });
                  }}
                >
                  Save brief
                </Button>
                <Picker
                  label="Thread to attach"
                  value={attaching}
                  disabled={disabled}
                  choices={threads
                    .filter((item) => !group.memberThreadIds.includes(item.id))
                    .map((item) => ({ value: item.id, label: item.title }))}
                  onChange={setAttaching}
                />
                <Button
                  size="xs"
                  variant="ghost"
                  disabled={disabled || attaching === null}
                  onClick={() => {
                    const selected = threads.find((item) => item.id === attaching);
                    if (selected)
                      void perform({
                        action: "attach-thread",
                        groupId: group.id,
                        threadId: selected.id,
                      });
                  }}
                >
                  Attach thread
                </Button>
                <Picker
                  label="Resource type"
                  value={resource.kind}
                  disabled={disabled}
                  choices={TASK_CONTEXT_RESOURCE_KINDS.map((kind) => ({
                    value: kind,
                    label: kind,
                  }))}
                  onChange={(value) => {
                    const kind = TASK_CONTEXT_RESOURCE_KINDS.find((item) => item === value);
                    if (kind) setResource({ ...resource, kind });
                  }}
                />
                {resource.kind === "note" || resource.kind === "url" ? (
                  <>
                    <Input
                      size="sm"
                      aria-label="Resource title"
                      maxLength={TASK_CONTEXT_TITLE_MAX_CHARS}
                      value={resource.title}
                      disabled={disabled}
                      onChange={(event) => setResource({ ...resource, title: event.target.value })}
                    />
                    <Textarea
                      size="sm"
                      aria-label={resource.kind === "note" ? "Note text" : "Resource URL"}
                      maxLength={resource.kind === "note" ? TASK_CONTEXT_NOTE_MAX_CHARS : 2048}
                      value={resource.text}
                      disabled={disabled}
                      onChange={(event) => setResource({ ...resource, text: event.target.value })}
                    />
                  </>
                ) : resource.kind === "thread" ? (
                  <Picker
                    label="Thread reference"
                    value={resource.threadId}
                    disabled={disabled}
                    choices={threads.map((item) => ({ value: item.id, label: item.title }))}
                    onChange={(value) =>
                      setResource({
                        ...resource,
                        threadId: threads.find((item) => item.id === value)?.id ?? null,
                      })
                    }
                  />
                ) : (
                  <Picker
                    label="Project reference"
                    value={resource.projectId}
                    disabled={disabled}
                    choices={projects.map((item) => ({ value: item.id, label: item.title }))}
                    onChange={(value) =>
                      setResource({
                        ...resource,
                        projectId: projects.find((item) => item.id === value)?.id ?? null,
                      })
                    }
                  />
                )}
                <Button
                  size="xs"
                  variant="ghost"
                  disabled={disabled || resourceInput === null}
                  onClick={() => {
                    if (resourceInput)
                      void perform({
                        action: "attach-resource",
                        groupId: group.id,
                        resource: resourceInput,
                      });
                  }}
                >
                  Attach resource
                </Button>
                <Button
                  size="xs"
                  variant="ghost"
                  disabled={disabled}
                  onClick={() => {
                    void perform({
                      action: "detach-thread",
                      groupId: group.id,
                      threadId: props.threadId,
                    });
                  }}
                >
                  Leave shared context
                </Button>
              </>
            ) : null}
          </>
        )}
        {!access.writable ? (
          <p className="text-sm text-muted-foreground">
            This connection can read shared context. Editing requires orchestration access.
          </p>
        ) : null}
        {busy ? (
          <p role="status" className="text-sm text-muted-foreground">
            Saving shared context...
          </p>
        ) : null}
        {error ? (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        ) : null}
      </div>
    </ThreadDetailsSection>
  );
}
