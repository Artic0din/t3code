import {
  IsoDateTime,
  OrchestrationMessageContext,
  TaskContextGroup,
  TaskContextGroupError,
  TaskContextGroupId,
  TASK_CONTEXT_TITLE_MAX_CHARS,
  mergeTaskContextIntoMessage,
  restoreFrozenTaskContextIntoMessage,
  turnReceivedTaskContext,
  type OrchestrationMessageContext as MessageContext,
  type OrchestrationV2AppThread,
  type TaskContextGroupResource,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import * as ProjectStore from "./ProjectStore.ts";
import * as ProjectionStore from "./ProjectionStore.ts";

const encodeMessageContext = Schema.encodeEffect(OrchestrationMessageContext);

const validateMessageContext = Effect.fn("TaskContextGroupStore.validateMessageContext")(
  function* (message: { readonly text: string; readonly context: MessageContext | undefined }) {
    if (message.context !== undefined) {
      const invalid = () =>
        new TaskContextGroupError({
          code: "invalid_resource",
          message:
            "Shared context cannot fit in this message. Remove attached context and send again.",
        });
      const encoded = yield* encodeMessageContext(message.context).pipe(Effect.mapError(invalid));
      if (encoded.records.length !== message.context.records.length) return yield* invalid();
    }
    return message;
  },
);

export const restoreQueuedEdit = Effect.fn("TaskContextGroupStore.restoreQueuedEdit")(
  function* (input: {
    readonly text: string;
    readonly context: MessageContext | undefined;
    readonly frozenContext: MessageContext | undefined;
  }) {
    const frozen = input.frozenContext?.records.find((record) => record.kind === "task-context");
    if (frozen !== undefined && turnReceivedTaskContext(input.frozenContext) === null) {
      return yield* new TaskContextGroupError({
        code: "invalid_resource",
        message: "The queued shared context snapshot is invalid.",
      });
    }
    return yield* validateMessageContext(restoreFrozenTaskContextIntoMessage(input));
  },
);

export class TaskContextGroupStore extends Context.Service<
  TaskContextGroupStore,
  {
    readonly get: (
      groupId: TaskContextGroupId,
    ) => Effect.Effect<TaskContextGroup | null, TaskContextGroupError>;
    readonly list: () => Effect.Effect<ReadonlyArray<TaskContextGroup>, TaskContextGroupError>;
    readonly resolve: (
      group: TaskContextGroup,
    ) => Effect.Effect<TaskContextGroup, TaskContextGroupError>;
    readonly capture: (input: {
      readonly thread: Pick<OrchestrationV2AppThread, "id" | "taskContextGroupId">;
      readonly text: string;
      readonly context: OrchestrationMessageContext | undefined;
    }) => Effect.Effect<
      { readonly text: string; readonly context: OrchestrationMessageContext | undefined },
      TaskContextGroupError
    >;
  }
>()("t3/orchestration-v2/TaskContextGroupStore") {}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const threads = yield* ProjectionStore.ProjectionStoreV2;
  const projects = yield* ProjectStore.ProjectStoreV2;
  const decode = Schema.decodeUnknownOption(Schema.fromJsonString(TaskContextGroup));
  const storageError = () =>
    new TaskContextGroupError({
      code: "orchestration_error",
      message: "Shared context could not be loaded.",
    });
  const decodeRow = (document: string) => {
    const group = decode(document);
    return Option.isSome(group)
      ? Effect.succeed(group.value)
      : Effect.fail(
          new TaskContextGroupError({
            code: "orchestration_error",
            message: "Task context group document is corrupt.",
          }),
        );
  };
  const get = Effect.fn("TaskContextGroupStore.get")(function* (groupId: TaskContextGroupId) {
    const rows = yield* sql<{ readonly document_json: string }>`
      SELECT document_json FROM task_context_groups WHERE group_id = ${groupId}
    `.pipe(Effect.mapError(storageError));
    return rows[0] === undefined ? null : yield* decodeRow(rows[0].document_json);
  });
  const list = Effect.fn("TaskContextGroupStore.list")(function* () {
    const rows = yield* sql<{ readonly document_json: string }>`
      SELECT document_json FROM task_context_groups ORDER BY updated_at DESC, group_id ASC
    `.pipe(Effect.mapError(storageError));
    return yield* Effect.forEach(rows, (row) => decodeRow(row.document_json), { concurrency: 1 });
  });
  const resolveResource = Effect.fn("TaskContextGroupStore.resolveResource")(function* (
    resource: TaskContextGroupResource,
  ): Effect.fn.Return<TaskContextGroupResource, TaskContextGroupError> {
    switch (resource.kind) {
      case "note":
      case "url":
        return resource;
      case "thread": {
        const thread = yield* threads
          .getThreadShell(resource.threadId)
          .pipe(Effect.mapError(storageError));
        return thread === null || thread.deletedAt !== null
          ? { ...resource, title: resource.title ?? null, availability: "missing" }
          : {
              ...resource,
              title: thread.title.trim().slice(0, TASK_CONTEXT_TITLE_MAX_CHARS) || "Thread",
              availability: "available",
            };
      }
      case "project": {
        const project = yield* projects.get(resource.projectId).pipe(Effect.mapError(storageError));
        return Option.isNone(project) || project.value.deletedAt !== null
          ? { ...resource, name: resource.name ?? null, availability: "missing" }
          : {
              ...resource,
              name: project.value.title.trim().slice(0, TASK_CONTEXT_TITLE_MAX_CHARS) || "Project",
              availability: "available",
            };
      }
    }
  });
  const resolve = Effect.fn("TaskContextGroupStore.resolve")(function* (group: TaskContextGroup) {
    return {
      ...group,
      resources: yield* Effect.forEach(group.resources, resolveResource, { concurrency: 1 }),
    };
  });
  const capture: TaskContextGroupStore["Service"]["capture"] = Effect.fn(
    "TaskContextGroupStore.capture",
  )(function* (input) {
    if (input.text.trimStart().startsWith("/")) {
      return { text: input.text, context: input.context };
    }
    const groupId = input.thread.taskContextGroupId;
    const group = groupId == null ? null : yield* get(groupId);
    if (groupId != null && group === null) {
      return yield* new TaskContextGroupError({
        code: "not_found",
        message: "The thread's shared context group was not found.",
      });
    }
    if (group !== null && !group.memberThreadIds.includes(input.thread.id)) {
      return yield* new TaskContextGroupError({
        code: "orchestration_error",
        message: "Shared context membership is inconsistent.",
      });
    }
    const capturedAt: IsoDateTime = DateTime.formatIso(DateTime.toUtc(yield* DateTime.now));
    const merged = mergeTaskContextIntoMessage({
      ...input,
      group: group === null ? null : yield* resolve(group),
      capturedAt,
    });
    return yield* validateMessageContext(merged);
  });
  return TaskContextGroupStore.of({ get, list, resolve, capture });
});

export const layer = Layer.effect(TaskContextGroupStore, make);
