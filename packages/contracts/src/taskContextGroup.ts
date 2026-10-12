import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { ComposerContextId, type ComposerContextRecord } from "./composerContext.ts";
import {
  IsoDateTime,
  ProjectId,
  TaskContextGroupId,
  TaskContextResourceId,
  ThreadId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";

const SHORT = Schema.String.check(Schema.isMaxLength(2_048));
const BRIEF_MAX = 32_000;
const TITLE_MAX = 200;
const NOTE_MAX = 16_000;

export const TaskContextGroupTitle = TrimmedNonEmptyString.check(Schema.isMaxLength(TITLE_MAX));
export const TaskContextGroupBrief = Schema.String.check(Schema.isMaxLength(BRIEF_MAX));

export const TaskContextNoteResource = Schema.Struct({
  kind: Schema.Literal("note"),
  resourceId: TaskContextResourceId,
  title: TrimmedNonEmptyString.check(Schema.isMaxLength(TITLE_MAX)),
  body: Schema.String.check(Schema.isMaxLength(NOTE_MAX)),
});
export type TaskContextNoteResource = typeof TaskContextNoteResource.Type;

export const TaskContextUrlResource = Schema.Struct({
  kind: Schema.Literal("url"),
  resourceId: TaskContextResourceId,
  title: TrimmedNonEmptyString.check(Schema.isMaxLength(TITLE_MAX)),
  url: TrimmedNonEmptyString.check(Schema.isMaxLength(2_048)),
});
export type TaskContextUrlResource = typeof TaskContextUrlResource.Type;

/** Reference to another thread. Identity only; never grants write or checkpoint access. */
export const TaskContextThreadResource = Schema.Struct({
  kind: Schema.Literal("thread"),
  resourceId: TaskContextResourceId,
  threadId: ThreadId,
  title: Schema.optional(Schema.NullOr(TrimmedNonEmptyString.check(Schema.isMaxLength(TITLE_MAX)))),
  availability: Schema.optional(Schema.Literals(["available", "missing", "inaccessible"])),
});
export type TaskContextThreadResource = typeof TaskContextThreadResource.Type;

/**
 * Reference to a project in this environment. Clients send projectId only.
 * The server resolves the display name; the workspace root never becomes a
 * provider write root or checkpoint cwd from this link.
 */
export const TaskContextProjectResource = Schema.Struct({
  kind: Schema.Literal("project"),
  resourceId: TaskContextResourceId,
  projectId: ProjectId,
  name: Schema.optional(Schema.NullOr(TrimmedNonEmptyString.check(Schema.isMaxLength(TITLE_MAX)))),
  availability: Schema.optional(Schema.Literals(["available", "missing", "inaccessible"])),
});
export type TaskContextProjectResource = typeof TaskContextProjectResource.Type;

export const TaskContextGroupResource = Schema.Union([
  TaskContextNoteResource,
  TaskContextUrlResource,
  TaskContextThreadResource,
  TaskContextProjectResource,
]);
export type TaskContextGroupResource = typeof TaskContextGroupResource.Type;

export const TaskContextGroup = Schema.Struct({
  id: TaskContextGroupId,
  title: TaskContextGroupTitle,
  brief: TaskContextGroupBrief,
  resources: Schema.Array(TaskContextGroupResource).check(Schema.isMaxLength(100)),
  memberThreadIds: Schema.Array(ThreadId).check(Schema.isMaxLength(100)),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type TaskContextGroup = typeof TaskContextGroup.Type;

export class TaskContextGroupError extends Schema.TaggedError<TaskContextGroupError>()(
  "TaskContextGroupError",
  {
    code: Schema.Literals([
      "not_found",
      "thread_not_found",
      "project_not_found",
      "invalid_resource",
      "cross_environment",
      "path_refused",
      "orchestration_error",
    ]),
    message: SHORT,
  },
) {}

export const TaskContextGroupListResult = Schema.Struct({
  groups: Schema.Array(TaskContextGroup),
});
export type TaskContextGroupListResult = typeof TaskContextGroupListResult.Type;

export const TaskContextGroupGetInput = Schema.Struct({
  groupId: TaskContextGroupId,
});
export type TaskContextGroupGetInput = typeof TaskContextGroupGetInput.Type;

export const TaskContextGroupGetResult = Schema.Struct({
  group: Schema.NullOr(TaskContextGroup),
});
export type TaskContextGroupGetResult = typeof TaskContextGroupGetResult.Type;

const CreateAction = Schema.Struct({
  action: Schema.Literal("create"),
  threadId: ThreadId,
  title: Schema.optional(TaskContextGroupTitle),
  brief: Schema.optional(TaskContextGroupBrief),
});

const UpdateBriefAction = Schema.Struct({
  action: Schema.Literal("update-brief"),
  groupId: TaskContextGroupId,
  brief: TaskContextGroupBrief,
});

const AttachThreadAction = Schema.Struct({
  action: Schema.Literal("attach-thread"),
  groupId: TaskContextGroupId,
  threadId: ThreadId,
});

const DetachThreadAction = Schema.Struct({
  action: Schema.Literal("detach-thread"),
  groupId: TaskContextGroupId,
  threadId: ThreadId,
});

const AttachResourceAction = Schema.Struct({
  action: Schema.Literal("attach-resource"),
  groupId: TaskContextGroupId,
  resource: Schema.Union([
    Schema.Struct({
      kind: Schema.Literal("note"),
      title: TrimmedNonEmptyString.check(Schema.isMaxLength(TITLE_MAX)),
      body: Schema.String.check(Schema.isMaxLength(NOTE_MAX)),
    }),
    Schema.Struct({
      kind: Schema.Literal("url"),
      title: TrimmedNonEmptyString.check(Schema.isMaxLength(TITLE_MAX)),
      url: TrimmedNonEmptyString.check(Schema.isMaxLength(2_048)),
    }),
    Schema.Struct({
      kind: Schema.Literal("thread"),
      threadId: ThreadId,
    }),
    Schema.Struct({
      kind: Schema.Literal("project"),
      projectId: ProjectId,
    }),
  ]),
});

const DetachResourceAction = Schema.Struct({
  action: Schema.Literal("detach-resource"),
  groupId: TaskContextGroupId,
  resourceId: TaskContextResourceId,
});

export const TaskContextGroupMutateInput = Schema.Union([
  CreateAction,
  UpdateBriefAction,
  AttachThreadAction,
  DetachThreadAction,
  AttachResourceAction,
  DetachResourceAction,
]);
export type TaskContextGroupMutateInput = typeof TaskContextGroupMutateInput.Type;

export const TaskContextGroupMutateResult = Schema.Struct({
  group: TaskContextGroup,
});
export type TaskContextGroupMutateResult = typeof TaskContextGroupMutateResult.Type;

/** Inspectable payload stored on a turn's message.context for kind `task-context`. */
export const TaskContextTurnSnapshot = Schema.Struct({
  groupId: TaskContextGroupId,
  title: TaskContextGroupTitle,
  brief: TaskContextGroupBrief,
  resources: Schema.Array(TaskContextGroupResource),
  memberThreadIds: Schema.Array(ThreadId),
  capturedAt: IsoDateTime,
});
export type TaskContextTurnSnapshot = typeof TaskContextTurnSnapshot.Type;

export const TASK_CONTEXT_COMPOSER_KIND = "task-context" as const;

/** Client filesystem paths are never accepted as server resource authority. */
export function refuseClientPathResource(input: unknown): string | null {
  if (typeof input !== "object" || input === null) return null;
  const record = input as Record<string, unknown>;
  for (const key of [
    "path",
    "absolutePath",
    "serverPath",
    "cwd",
    "worktreePath",
    "workspaceRoot",
  ]) {
    if (typeof record[key] === "string" && record[key].trim().length > 0) {
      return `Resource field "${key}" is not accepted; resolve resources on the server.`;
    }
  }
  if (record.kind === "file" || record.kind === "filesystem" || record.kind === "directory") {
    return `Resource kind "${String(record.kind)}" is not supported for shared task context.`;
  }
  return null;
}

export function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value.trim());
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

export function nextMemberThreadIds(
  current: ReadonlyArray<ThreadId>,
  threadId: ThreadId,
  op: "attach" | "detach",
): ReadonlyArray<ThreadId> | undefined {
  const has = current.includes(threadId);
  if (op === "attach") {
    if (has) return undefined;
    return [...current, threadId];
  }
  if (!has) return undefined;
  return current.filter((id) => id !== threadId);
}

export function nextResources(
  current: ReadonlyArray<TaskContextGroupResource>,
  op:
    | { type: "attach"; resource: TaskContextGroupResource }
    | { type: "detach"; resourceId: TaskContextResourceId },
): ReadonlyArray<TaskContextGroupResource> | undefined {
  if (op.type === "detach") {
    if (!current.some((resource) => resource.resourceId === op.resourceId)) return undefined;
    return current.filter((resource) => resource.resourceId !== op.resourceId);
  }
  const duplicate = current.some((resource) => {
    if (resource.resourceId === op.resource.resourceId) return true;
    if (resource.kind === "thread" && op.resource.kind === "thread") {
      return resource.threadId === op.resource.threadId;
    }
    if (resource.kind === "project" && op.resource.kind === "project") {
      return resource.projectId === op.resource.projectId;
    }
    if (resource.kind === "url" && op.resource.kind === "url") {
      return resource.url === op.resource.url;
    }
    return false;
  });
  if (duplicate) return undefined;
  return [...current, op.resource];
}

export function nextTaskContextGroupId(
  current: TaskContextGroupId | null | undefined,
  command:
    | { type: "thread.task-context-group.attach"; groupId: TaskContextGroupId }
    | { type: "thread.task-context-group.detach"; groupId: TaskContextGroupId },
): TaskContextGroupId | null | undefined {
  if (command.type === "thread.task-context-group.attach") {
    if (current === command.groupId) return undefined;
    return command.groupId;
  }
  if (current !== command.groupId) return undefined;
  return null;
}

export function relatedTaskContextThreads(
  threads: ReadonlyArray<{
    readonly id: ThreadId;
    readonly title: string;
    readonly taskContextGroupId?: TaskContextGroupId | null | undefined;
  }>,
  groupId: TaskContextGroupId,
  excludeThreadId?: ThreadId,
): ReadonlyArray<{ readonly id: ThreadId; readonly title: string }> {
  return threads
    .filter(
      (thread) =>
        thread.taskContextGroupId === groupId &&
        (excludeThreadId === undefined || thread.id !== excludeThreadId),
    )
    .map((thread) => ({ id: thread.id, title: thread.title }));
}

/**
 * Linking never returns another thread's worktree or project as this thread's
 * checkpoint/provider cwd. The helper encodes that isolation boundary for tests.
 */
export function linkedThreadDoesNotWidenWorkspace(input: {
  readonly ownWorktreePath: string | null;
  readonly ownProjectId: ProjectId;
  readonly siblingWorktreePath: string | null;
  readonly siblingProjectId: ProjectId;
}): {
  readonly checkpointCwd: string | null;
  readonly projectId: ProjectId;
} {
  return {
    checkpointCwd: input.ownWorktreePath,
    projectId: input.ownProjectId,
  };
}

export function buildTaskContextTurnSnapshot(
  group: TaskContextGroup,
  capturedAt: string,
): {
  readonly record: ComposerContextRecord;
  readonly referenceMarkdown: string;
  readonly snapshot: TaskContextTurnSnapshot;
} {
  const snapshot: TaskContextTurnSnapshot = {
    groupId: group.id,
    title: group.title,
    brief: group.brief,
    resources: [...group.resources],
    memberThreadIds: [...group.memberThreadIds],
    capturedAt,
  };
  const contextId = ComposerContextId.make(
    `tcg_${group.id.replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 96) || "group"}`,
  );
  const label = group.title.slice(0, 200) || "Shared task context";
  const record = {
    version: 1 as const,
    kind: TASK_CONTEXT_COMPOSER_KIND,
    contextId,
    label,
    payload: snapshot,
  } satisfies ComposerContextRecord;
  const referenceMarkdown = `[${label.replace(/[[\]\\\r\n]/g, " ").trim() || "Shared task context"}](t3-context://v1/${TASK_CONTEXT_COMPOSER_KIND}/${contextId})`;
  return { record, referenceMarkdown, snapshot };
}

export function mergeTaskContextIntoMessage(input: {
  readonly text: string;
  readonly context:
    | { readonly version: 1; readonly records: ReadonlyArray<ComposerContextRecord> }
    | undefined;
  readonly group: TaskContextGroup | null;
  readonly capturedAt: string;
}): {
  readonly text: string;
  readonly context:
    | { readonly version: 1; readonly records: ReadonlyArray<ComposerContextRecord> }
    | undefined;
} {
  if (input.group === null) {
    return { text: input.text, context: input.context };
  }
  const { record, referenceMarkdown } = buildTaskContextTurnSnapshot(input.group, input.capturedAt);
  const existing = input.context?.records ?? [];
  if (existing.some((entry) => entry.kind === TASK_CONTEXT_COMPOSER_KIND)) {
    return {
      text: input.text,
      context: {
        version: 1,
        records: existing.map((entry) =>
          entry.kind === TASK_CONTEXT_COMPOSER_KIND ? record : entry,
        ),
      },
    };
  }
  const text = input.text.includes("t3-context://v1/task-context/")
    ? input.text
    : `${referenceMarkdown}\n\n${input.text}`;
  return {
    text,
    context: { version: 1, records: [...existing, record] },
  };
}

export function turnReceivedTaskContext(
  context: { readonly records: ReadonlyArray<ComposerContextRecord> } | undefined | null,
): TaskContextTurnSnapshot | null {
  const record = context?.records.find((entry) => entry.kind === TASK_CONTEXT_COMPOSER_KIND);
  if (record === undefined || !("payload" in record)) return null;
  const decoded = Schema.decodeUnknownOption(TaskContextTurnSnapshot)(record.payload);
  return Option.isSome(decoded) ? decoded.value : null;
}
