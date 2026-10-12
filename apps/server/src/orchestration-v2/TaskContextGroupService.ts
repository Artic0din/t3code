import {
  CommandId,
  IsoDateTime,
  ProjectId,
  TaskContextGroup,
  TaskContextGroupError,
  TaskContextGroupId,
  TaskContextResourceId,
  ThreadId,
  isHttpUrl,
  linkedThreadDoesNotWidenWorkspace,
  mergeTaskContextIntoMessage,
  nextMemberThreadIds,
  nextResources,
  refuseClientPathResource,
  relatedTaskContextThreads,
  type OrchestrationMessageContext,
  type TaskContextGroupForThreadResult,
  type TaskContextGroupGetResult,
  type TaskContextGroupListResult,
  type TaskContextGroupMutateInput,
  type TaskContextGroupMutateResult,
  type TaskContextGroupResource,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as SqlClient from "effect/sql/SqlClient";

import * as ProjectService from "../project/ProjectService.ts";
import * as ThreadManagementService from "./ThreadManagementService.ts";

const encodeGroup = Schema.encodeEffect(Schema.fromJsonString(TaskContextGroup));
const decodeGroup = Schema.decodeUnknownOption(Schema.fromJsonString(TaskContextGroup));

type GroupRow = {
  readonly group_id: string;
  readonly document_json: string;
  readonly updated_at: string;
};

export class TaskContextGroupService extends Context.Service<
  TaskContextGroupService,
  {
    readonly list: () => Effect.Effect<TaskContextGroupListResult, TaskContextGroupError>;
    readonly get: (
      groupId: TaskContextGroupId,
    ) => Effect.Effect<TaskContextGroupGetResult, TaskContextGroupError>;
    readonly forThread: (
      threadId: ThreadId,
    ) => Effect.Effect<TaskContextGroupForThreadResult, TaskContextGroupError>;
    readonly mutate: (
      input: TaskContextGroupMutateInput,
    ) => Effect.Effect<TaskContextGroupMutateResult, TaskContextGroupError>;
    readonly enrichTurn: (input: {
      readonly threadId: ThreadId;
      readonly text: string;
      readonly context: OrchestrationMessageContext | undefined;
    }) => Effect.Effect<
      {
        readonly text: string;
        readonly context: OrchestrationMessageContext | undefined;
        readonly checkpointCwd: string | null;
        readonly projectId: ProjectId | null;
      },
      TaskContextGroupError
    >;
  }
>()("t3/orchestration-v2/TaskContextGroupService") {}

function failure(code: TaskContextGroupError["code"], message: string): TaskContextGroupError {
  return new TaskContextGroupError({ code, message });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function nowIso(): Effect.Effect<IsoDateTime> {
  return DateTime.now.pipe(Effect.map((value) => DateTime.formatIso(DateTime.toUtc(value))));
}

const make = Effect.gen(function* () {
  const crypto = yield* Crypto.Crypto;
  const sql = yield* SqlClient.SqlClient;
  const threads = yield* ThreadManagementService.ThreadManagementService;
  const projects = yield* ProjectService.ProjectService;
  const lock = yield* Semaphore.make(1);

  const requireThread = Effect.fn("TaskContextGroupService.requireThread")(function* (
    threadId: ThreadId,
  ) {
    const shell = yield* threads
      .getThreadShell(threadId)
      .pipe(
        Effect.mapError((error) =>
          failure(
            "orchestration_error",
            `Unable to locate thread ${threadId}: ${errorMessage(error)}`,
          ),
        ),
      );
    if (shell === null || shell.deletedAt !== null) {
      return yield* failure("thread_not_found", `Thread ${threadId} was not found.`);
    }
    return shell;
  });

  const decodeRow = (row: GroupRow): Effect.Effect<TaskContextGroup, TaskContextGroupError> => {
    const decoded = decodeGroup(row.document_json);
    if (Option.isNone(decoded)) {
      return Effect.fail(failure("orchestration_error", "Task context group document is corrupt."));
    }
    return Effect.succeed(decoded.value);
  };

  const listRows = () =>
    sql<GroupRow>`
      SELECT group_id, document_json, updated_at
      FROM task_context_groups
      ORDER BY updated_at DESC, group_id ASC
    `.pipe(
      Effect.mapError((error) =>
        failure(
          "orchestration_error",
          `Unable to list task context groups: ${errorMessage(error)}`,
        ),
      ),
    );

  const getRow = (groupId: TaskContextGroupId) =>
    sql<GroupRow>`
      SELECT group_id, document_json, updated_at
      FROM task_context_groups
      WHERE group_id = ${groupId}
    `.pipe(
      Effect.mapError((error) =>
        failure(
          "orchestration_error",
          `Unable to load task context group ${groupId}: ${errorMessage(error)}`,
        ),
      ),
      Effect.map((rows) => rows[0] ?? null),
    );

  const writeGroup = Effect.fn("TaskContextGroupService.writeGroup")(function* (
    group: TaskContextGroup,
  ) {
    const documentJson = yield* encodeGroup(group).pipe(
      Effect.mapError((error) =>
        failure(
          "orchestration_error",
          `Unable to encode task context group: ${errorMessage(error)}`,
        ),
      ),
    );
    yield* sql`
      INSERT INTO task_context_groups (group_id, document_json, updated_at)
      VALUES (${group.id}, ${documentJson}, ${group.updatedAt})
      ON CONFLICT(group_id) DO UPDATE SET
        document_json = excluded.document_json,
        updated_at = excluded.updated_at
    `.pipe(
      Effect.mapError((error) =>
        failure(
          "orchestration_error",
          `Unable to persist task context group: ${errorMessage(error)}`,
        ),
      ),
    );
  });

  const findGroup = (groupId: TaskContextGroupId) =>
    Effect.gen(function* () {
      const row = yield* getRow(groupId);
      if (row === null) return null;
      return yield* decodeRow(row);
    });

  const findGroupForThread = (threadId: ThreadId) =>
    Effect.gen(function* () {
      const rows = yield* listRows();
      for (const row of rows) {
        const group = yield* decodeRow(row);
        if (group.memberThreadIds.includes(threadId)) return group;
      }
      return null;
    });

  const refreshResource = Effect.fn("TaskContextGroupService.refreshResource")(function* (
    resource: TaskContextGroupResource,
  ) {
    switch (resource.kind) {
      case "note":
      case "url":
        return resource;
      case "thread": {
        const shell = yield* threads
          .getThreadShell(resource.threadId)
          .pipe(
            Effect.mapError((error) =>
              failure(
                "orchestration_error",
                `Unable to resolve thread ${resource.threadId}: ${errorMessage(error)}`,
              ),
            ),
          );
        if (shell === null || shell.deletedAt !== null) {
          return {
            ...resource,
            title: resource.title ?? null,
            availability: "missing" as const,
          } satisfies TaskContextGroupResource;
        }
        return {
          ...resource,
          title: shell.title,
          availability: "available" as const,
        } satisfies TaskContextGroupResource;
      }
      case "project": {
        const project = yield* projects
          .getById(resource.projectId)
          .pipe(
            Effect.mapError((error) =>
              failure(
                "orchestration_error",
                `Unable to resolve project ${resource.projectId}: ${errorMessage(error)}`,
              ),
            ),
          );
        if (Option.isNone(project) || project.value.deletedAt !== null) {
          return {
            ...resource,
            name: resource.name ?? null,
            availability: "missing" as const,
          } satisfies TaskContextGroupResource;
        }
        return {
          ...resource,
          name: project.value.title,
          availability: "available" as const,
        } satisfies TaskContextGroupResource;
      }
      default: {
        const unreachable: never = resource;
        return unreachable;
      }
    }
  });

  const refreshGroup = Effect.fn("TaskContextGroupService.refreshGroup")(function* (
    group: TaskContextGroup,
  ) {
    const resources = yield* Effect.forEach(group.resources, refreshResource, { concurrency: 1 });
    return { ...group, resources };
  });

  const syncShellMembership = Effect.fn("TaskContextGroupService.syncShellMembership")(
    function* (input: {
      readonly threadId: ThreadId;
      readonly groupId: TaskContextGroupId;
      readonly op: "attach" | "detach";
    }) {
      const commandId = CommandId.make(
        [
          "command",
          "task-context-group",
          input.op,
          encodeURIComponent(input.threadId),
          encodeURIComponent(input.groupId),
          yield* crypto.randomUUIDv4.pipe(Effect.orDie),
        ].join(":"),
      );
      yield* threads
        .dispatch({
          type:
            input.op === "attach"
              ? "thread.task-context-group.attach"
              : "thread.task-context-group.detach",
          commandId,
          threadId: input.threadId,
          groupId: input.groupId,
        })
        .pipe(
          Effect.mapError((error) =>
            failure(
              "orchestration_error",
              `Unable to ${input.op} task context group on thread ${input.threadId}: ${errorMessage(error)}`,
            ),
          ),
        );
    },
  );

  const list = (): Effect.Effect<TaskContextGroupListResult, TaskContextGroupError> =>
    Effect.gen(function* () {
      const rows = yield* listRows();
      const groups = yield* Effect.forEach(
        rows,
        (row) => decodeRow(row).pipe(Effect.flatMap(refreshGroup)),
        { concurrency: 1 },
      );
      return { groups };
    });

  const get = (
    groupId: TaskContextGroupId,
  ): Effect.Effect<TaskContextGroupGetResult, TaskContextGroupError> =>
    Effect.gen(function* () {
      const group = yield* findGroup(groupId);
      if (group === null) return { group: null };
      return { group: yield* refreshGroup(group) };
    });

  const forThread = (
    threadId: ThreadId,
  ): Effect.Effect<TaskContextGroupForThreadResult, TaskContextGroupError> =>
    Effect.gen(function* () {
      const shell = yield* requireThread(threadId);
      const byShell =
        shell.taskContextGroupId === undefined || shell.taskContextGroupId === null
          ? null
          : yield* findGroup(shell.taskContextGroupId);
      const group = byShell ?? (yield* findGroupForThread(threadId));
      if (group === null) return { group: null, relatedThreads: [] };
      const refreshed = yield* refreshGroup(group);
      const snapshot = yield* threads
        .getShellSnapshot()
        .pipe(
          Effect.mapError((error) =>
            failure("orchestration_error", `Unable to read threads: ${errorMessage(error)}`),
          ),
        );
      const related = relatedTaskContextThreads(
        [...snapshot.threads, ...snapshot.archivedThreads].map((thread) => ({
          id: thread.id,
          title: thread.title,
          taskContextGroupId: thread.taskContextGroupId ?? null,
        })),
        refreshed.id,
        threadId,
      ).map((thread) => ({ threadId: thread.id, title: thread.title }));
      return { group: refreshed, relatedThreads: related };
    });

  const mintResourceId = () =>
    crypto.randomUUIDv4.pipe(
      Effect.orDie,
      Effect.map((id) => TaskContextResourceId.make(`tcr_${id}`)),
    );

  const mintGroupId = () =>
    crypto.randomUUIDv4.pipe(
      Effect.orDie,
      Effect.map((id) => TaskContextGroupId.make(`tcg_${id}`)),
    );

  const resolveAttachResource = Effect.fn("TaskContextGroupService.resolveAttachResource")(
    function* (
      resource: Extract<TaskContextGroupMutateInput, { action: "attach-resource" }>["resource"],
    ) {
      const pathRefusal = refuseClientPathResource(resource);
      if (pathRefusal !== null) {
        return yield* failure("path_refused", pathRefusal);
      }
      const resourceId = yield* mintResourceId();
      switch (resource.kind) {
        case "note":
          return {
            kind: "note" as const,
            resourceId,
            title: resource.title,
            body: resource.body,
          };
        case "url": {
          if (!isHttpUrl(resource.url)) {
            return yield* failure("invalid_resource", "URL resources must use http or https.");
          }
          return {
            kind: "url" as const,
            resourceId,
            title: resource.title,
            url: resource.url.trim(),
          };
        }
        case "thread": {
          const shell = yield* requireThread(resource.threadId);
          return {
            kind: "thread" as const,
            resourceId,
            threadId: shell.id,
            title: shell.title,
            availability: "available" as const,
          };
        }
        case "project": {
          const project = yield* projects
            .getById(resource.projectId)
            .pipe(
              Effect.mapError((error) =>
                failure(
                  "orchestration_error",
                  `Unable to resolve project ${resource.projectId}: ${errorMessage(error)}`,
                ),
              ),
            );
          if (Option.isNone(project) || project.value.deletedAt !== null) {
            return yield* failure(
              "project_not_found",
              `Project ${resource.projectId} was not found.`,
            );
          }
          return {
            kind: "project" as const,
            resourceId,
            projectId: project.value.id,
            name: project.value.title,
            availability: "available" as const,
          };
        }
        default: {
          const unreachable: never = resource;
          return unreachable;
        }
      }
    },
  );

  const mutate = (
    input: TaskContextGroupMutateInput,
  ): Effect.Effect<TaskContextGroupMutateResult, TaskContextGroupError> =>
    lock.withPermits(1)(
      Effect.gen(function* () {
        const timestamp = yield* nowIso();

        if (input.action === "create") {
          const shell = yield* requireThread(input.threadId);
          const existing = yield* findGroupForThread(shell.id);
          if (existing !== null) {
            if (shell.taskContextGroupId !== existing.id) {
              yield* syncShellMembership({
                threadId: shell.id,
                groupId: existing.id,
                op: "attach",
              });
            }
            return { group: yield* refreshGroup(existing) };
          }
          const group: TaskContextGroup = {
            id: yield* mintGroupId(),
            title: input.title ?? (shell.title.trim().slice(0, 200) || "Shared task context"),
            brief: input.brief ?? "",
            resources: [],
            memberThreadIds: [shell.id],
            createdAt: timestamp,
            updatedAt: timestamp,
          };
          yield* writeGroup(group);
          yield* syncShellMembership({
            threadId: shell.id,
            groupId: group.id,
            op: "attach",
          });
          return { group };
        }

        const current = yield* findGroup(input.groupId);
        if (current === null) {
          return yield* failure("not_found", `Task context group ${input.groupId} was not found.`);
        }

        let next: TaskContextGroup;
        switch (input.action) {
          case "update-brief": {
            next = { ...current, brief: input.brief, updatedAt: timestamp };
            break;
          }
          case "attach-thread": {
            yield* requireThread(input.threadId);
            const other = yield* findGroupForThread(input.threadId);
            if (other !== null && other.id !== current.id) {
              return yield* failure(
                "invalid_resource",
                `Thread ${input.threadId} already belongs to another task context group.`,
              );
            }
            const members = nextMemberThreadIds(current.memberThreadIds, input.threadId, "attach");
            if (members === undefined) {
              yield* syncShellMembership({
                threadId: input.threadId,
                groupId: current.id,
                op: "attach",
              });
              return { group: yield* refreshGroup(current) };
            }
            next = { ...current, memberThreadIds: [...members], updatedAt: timestamp };
            yield* writeGroup(next);
            yield* syncShellMembership({
              threadId: input.threadId,
              groupId: next.id,
              op: "attach",
            });
            return { group: yield* refreshGroup(next) };
          }
          case "detach-thread": {
            const members = nextMemberThreadIds(current.memberThreadIds, input.threadId, "detach");
            if (members === undefined) {
              yield* syncShellMembership({
                threadId: input.threadId,
                groupId: current.id,
                op: "detach",
              });
              return { group: yield* refreshGroup(current) };
            }
            next = { ...current, memberThreadIds: [...members], updatedAt: timestamp };
            yield* writeGroup(next);
            yield* syncShellMembership({
              threadId: input.threadId,
              groupId: next.id,
              op: "detach",
            });
            return { group: yield* refreshGroup(next) };
          }
          case "attach-resource": {
            const resource = yield* resolveAttachResource(input.resource);
            const resources = nextResources(current.resources, { type: "attach", resource });
            if (resources === undefined) {
              return { group: yield* refreshGroup(current) };
            }
            next = { ...current, resources: [...resources], updatedAt: timestamp };
            break;
          }
          case "detach-resource": {
            const resources = nextResources(current.resources, {
              type: "detach",
              resourceId: input.resourceId,
            });
            if (resources === undefined) {
              return { group: yield* refreshGroup(current) };
            }
            next = { ...current, resources: [...resources], updatedAt: timestamp };
            break;
          }
          default: {
            const unreachable: never = input;
            return unreachable;
          }
        }

        yield* writeGroup(next);
        return { group: yield* refreshGroup(next) };
      }),
    );

  const enrichTurn = (input: {
    readonly threadId: ThreadId;
    readonly text: string;
    readonly context: OrchestrationMessageContext | undefined;
  }) =>
    Effect.gen(function* () {
      const shell = yield* requireThread(input.threadId);
      const byShell =
        shell.taskContextGroupId === undefined || shell.taskContextGroupId === null
          ? null
          : yield* findGroup(shell.taskContextGroupId);
      const group = byShell ?? (yield* findGroupForThread(input.threadId));
      const refreshed = group === null ? null : yield* refreshGroup(group);
      const capturedAt = yield* nowIso();
      const merged = mergeTaskContextIntoMessage({
        text: input.text,
        context: input.context,
        group: refreshed,
        capturedAt,
      });
      const isolation = linkedThreadDoesNotWidenWorkspace({
        ownWorktreePath: shell.worktreePath,
        ownProjectId: shell.projectId,
        siblingWorktreePath: null,
        siblingProjectId: shell.projectId,
      });
      return {
        text: merged.text,
        context: merged.context,
        checkpointCwd: isolation.checkpointCwd,
        projectId: isolation.projectId,
      };
    });

  return TaskContextGroupService.of({ list, get, forThread, mutate, enrichTurn });
});

export const layer: Layer.Layer<
  TaskContextGroupService,
  never,
  | Crypto.Crypto
  | SqlClient.SqlClient
  | ThreadManagementService.ThreadManagementService
  | ProjectService.ProjectService
> = Layer.effect(TaskContextGroupService, make);
