import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import {
  COMPOSER_CONTEXT_UNKNOWN_PAYLOAD_MAX_CHARS,
  ComposerContextId,
  type ComposerContextRecord,
} from "./composerContext.ts";
import {
  IsoDateTime,
  ProjectId,
  TaskContextGroupId,
  TaskContextResourceId,
  ThreadId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";

const SHORT = Schema.String.check(Schema.isMaxLength(2_048));
export const TASK_CONTEXT_BRIEF_MAX_CHARS = 32_000;
export const TASK_CONTEXT_TITLE_MAX_CHARS = 200;
export const TASK_CONTEXT_NOTE_MAX_CHARS = 16_000;

export const TaskContextGroupTitle = TrimmedNonEmptyString.check(
  Schema.isMaxLength(TASK_CONTEXT_TITLE_MAX_CHARS),
);
export const TaskContextGroupBrief = Schema.String.check(
  Schema.isMaxLength(TASK_CONTEXT_BRIEF_MAX_CHARS),
);

export const TaskContextNoteResource = Schema.Struct({
  kind: Schema.Literal("note"),
  resourceId: TaskContextResourceId,
  title: TaskContextGroupTitle,
  body: Schema.String.check(Schema.isMaxLength(TASK_CONTEXT_NOTE_MAX_CHARS)),
});
export type TaskContextNoteResource = typeof TaskContextNoteResource.Type;

export const TaskContextUrlResource = Schema.Struct({
  kind: Schema.Literal("url"),
  resourceId: TaskContextResourceId,
  title: TaskContextGroupTitle,
  url: TrimmedNonEmptyString.check(Schema.isMaxLength(2_048)),
});
export type TaskContextUrlResource = typeof TaskContextUrlResource.Type;

export const TaskContextThreadResource = Schema.Struct({
  kind: Schema.Literal("thread"),
  resourceId: TaskContextResourceId,
  threadId: ThreadId,
  title: Schema.optional(Schema.NullOr(TaskContextGroupTitle)),
  availability: Schema.optional(Schema.Literals(["available", "missing", "inaccessible"])),
});
export type TaskContextThreadResource = typeof TaskContextThreadResource.Type;

export const TaskContextProjectResource = Schema.Struct({
  kind: Schema.Literal("project"),
  resourceId: TaskContextResourceId,
  projectId: ProjectId,
  name: Schema.optional(Schema.NullOr(TaskContextGroupTitle)),
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

const TaskContextGroupDocument = Schema.Struct({
  id: TaskContextGroupId,
  title: TaskContextGroupTitle,
  brief: TaskContextGroupBrief,
  resources: Schema.Array(TaskContextGroupResource).check(Schema.isMaxLength(100)),
  memberThreadIds: Schema.Array(ThreadId).check(Schema.isMaxLength(100)),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type TaskContextGroup = typeof TaskContextGroupDocument.Type;
export const TaskContextGroup = TaskContextGroupDocument.check(
  Schema.makeFilter((group) => taskContextGroupFitsMessage(group)),
);

function taskContextGroupFitsMessage(group: TaskContextGroup): boolean {
  const resources = group.resources.map((resource) => {
    if (resource.kind === "thread") {
      return {
        ...resource,
        title: "\u0000".repeat(TASK_CONTEXT_TITLE_MAX_CHARS),
        availability: "inaccessible",
      };
    }
    if (resource.kind === "project") {
      return {
        ...resource,
        name: "\u0000".repeat(TASK_CONTEXT_TITLE_MAX_CHARS),
        availability: "inaccessible",
      };
    }
    return resource;
  });
  return (
    JSON.stringify({
      groupId: group.id,
      title: group.title,
      brief: group.brief,
      resources,
      memberThreadIds: group.memberThreadIds,
      capturedAt: "2000-01-01T00:00:00.000Z",
    }).length <= COMPOSER_CONTEXT_UNKNOWN_PAYLOAD_MAX_CHARS
  );
}

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
      "permission_denied",
    ]),
    message: SHORT,
  },
) {}

export const TaskContextGroupListInput = Schema.Struct({});
export type TaskContextGroupListInput = typeof TaskContextGroupListInput.Type;

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

export const TaskContextGroupForThreadInput = Schema.Struct({
  threadId: ThreadId,
});
export type TaskContextGroupForThreadInput = typeof TaskContextGroupForThreadInput.Type;

export const TaskContextGroupForThreadResult = Schema.Struct({
  group: Schema.NullOr(TaskContextGroup),
  relatedThreads: Schema.Array(
    Schema.Struct({
      threadId: ThreadId,
      title: TaskContextGroupTitle,
      availability: Schema.optional(Schema.Literals(["available", "missing"])),
    }),
  ),
});
export type TaskContextGroupForThreadResult = typeof TaskContextGroupForThreadResult.Type;

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

const resourceInputs = [
  Schema.Struct({
    kind: Schema.Literal("note"),
    title: TaskContextGroupTitle,
    body: Schema.String.check(Schema.isMaxLength(TASK_CONTEXT_NOTE_MAX_CHARS)),
  }),
  Schema.Struct({
    kind: Schema.Literal("url"),
    title: TaskContextGroupTitle,
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
] as const;

export const TaskContextGroupResourceInput = Schema.Union(resourceInputs);

const AttachResourceAction = Schema.Struct({
  action: Schema.Literal("attach-resource"),
  groupId: TaskContextGroupId,
  resource: TaskContextGroupResourceInput,
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

// Retain unknown resource fields until service decoding can return a domain
// failure. Transport schema failures become RPC defects or MCP validation errors.
export const TaskContextGroupMutateRequest = Schema.Union([
  CreateAction,
  UpdateBriefAction,
  AttachThreadAction,
  DetachThreadAction,
  Schema.Struct({
    ...AttachResourceAction.fields,
    resource: Schema.Union(
      resourceInputs.map((resource) =>
        Schema.StructWithRest(resource, [Schema.Record(Schema.String, Schema.Unknown)]),
      ),
    ),
  }),
  DetachResourceAction,
]);

export const TaskContextGroupMutateResult = Schema.Struct({
  group: TaskContextGroup,
});
export type TaskContextGroupMutateResult = typeof TaskContextGroupMutateResult.Type;

export const TaskContextTurnSnapshot = Schema.Struct({
  groupId: TaskContextGroupId,
  title: TaskContextGroupTitle,
  brief: TaskContextGroupBrief,
  resources: Schema.Array(TaskContextGroupResource),
  memberThreadIds: Schema.Array(ThreadId),
  capturedAt: IsoDateTime,
});
export type TaskContextTurnSnapshot = typeof TaskContextTurnSnapshot.Type;

const TASK_CONTEXT_COMPOSER_KIND = "task-context" as const;

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
  const referenceMarkdown = formatTaskContextReference(record);
  return { record, referenceMarkdown, snapshot };
}

function formatTaskContextReference(record: ComposerContextRecord): string {
  const label = record.label.replace(/[[\]\\\r\n]/g, " ").trim() || "Shared task context";
  return `[${label}](t3-context://v1/${TASK_CONTEXT_COMPOSER_KIND}/${record.contextId})`;
}

function bindTaskContextIntoMessage(input: {
  readonly text: string;
  readonly context:
    | { readonly version: 1; readonly records: ReadonlyArray<ComposerContextRecord> }
    | undefined;
  readonly record: ComposerContextRecord | null;
}) {
  const retained = (input.context?.records ?? []).filter(
    (entry) => entry.kind !== TASK_CONTEXT_COMPOSER_KIND,
  );
  const previousReferences = /\[[^\]\r\n]*\]\(t3-context:\/\/v1\/task-context\/[a-z0-9_-]+\)/gi;
  const slashCommand = input.text.trimStart().startsWith("/");
  if (input.record === null) {
    return {
      text: slashCommand ? input.text : input.text.replace(previousReferences, ""),
      context: retained.length === 0 ? undefined : { version: 1 as const, records: retained },
    };
  }
  let contextId = input.record.contextId;
  let suffix = 0;
  while (retained.some((entry) => entry.contextId === contextId)) {
    contextId = ComposerContextId.make(`${input.record.contextId}_${++suffix}`);
  }
  const record = { ...input.record, contextId };
  const reference = formatTaskContextReference(record);
  const replaced = slashCommand ? input.text : input.text.replace(previousReferences, reference);
  const text =
    slashCommand || replaced.includes(reference) ? replaced : `${input.text}\n\n${reference}`;
  return { text, context: { version: 1 as const, records: [...retained, record] } };
}

export function restoreFrozenTaskContextIntoMessage(input: {
  readonly text: string;
  readonly context:
    | { readonly version: 1; readonly records: ReadonlyArray<ComposerContextRecord> }
    | undefined;
  readonly frozenContext:
    | { readonly version: 1; readonly records: ReadonlyArray<ComposerContextRecord> }
    | undefined;
}) {
  const record =
    input.frozenContext?.records.find((entry) => entry.kind === TASK_CONTEXT_COMPOSER_KIND) ?? null;
  return bindTaskContextIntoMessage({
    text: input.text,
    context: input.context ?? input.frozenContext,
    record,
  });
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
  if (input.text.trimStart().startsWith("/")) {
    return { text: input.text, context: input.context };
  }
  const record =
    input.group === null
      ? null
      : buildTaskContextTurnSnapshot(input.group, input.capturedAt).record;
  return bindTaskContextIntoMessage({ ...input, record });
}

const decodeTurnSnapshot = Schema.decodeUnknownOption(TaskContextTurnSnapshot);

export function turnReceivedTaskContext(
  context: { readonly records: ReadonlyArray<ComposerContextRecord> } | undefined | null,
): TaskContextTurnSnapshot | null {
  const record = context?.records.find((entry) => entry.kind === TASK_CONTEXT_COMPOSER_KIND);
  if (record === undefined || !("payload" in record)) return null;
  const decoded = decodeTurnSnapshot(record.payload);
  return Option.isSome(decoded) ? decoded.value : null;
}
