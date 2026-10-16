import {
  CommandId,
  IsoDateTime,
  ProjectId,
  TaskContextGroup,
  TaskContextGroupError,
  TaskContextGroupId,
  TaskContextResourceId,
  TaskContextGroupResourceInput,
  TASK_CONTEXT_TITLE_MAX_CHARS,
  ThreadId,
  isHttpUrl,
  linkedThreadDoesNotWidenWorkspace,
  nextMemberThreadIds,
  nextResources,
  refuseClientPathResource,
  type ApplicationStoredEvent,
  type OrchestrationMessageContext,
  type TaskContextGroupForThreadResult,
  type TaskContextGroupGetResult,
  type TaskContextGroupListResult,
  type TaskContextGroupMutateInput,
  type TaskContextGroupMutateResult,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as SqlClient from "effect/sql/SqlClient";
import * as Stream from "effect/Stream";

import * as ProjectService from "../project/ProjectService.ts";
import * as ApplicationEventStore from "../persistence/OrchestrationEventStore.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as TaskContextGroupStore from "./TaskContextGroupStore.ts";

const encodeGroup = Schema.encodeEffect(Schema.fromJsonString(TaskContextGroup));
const validateGroupDocument = Schema.encodeEffect(TaskContextGroup);
const decodeResource = Schema.decodeUnknownEffect(TaskContextGroupResourceInput, {
  onExcessProperty: "error",
});
export class TaskContextGroupService extends Context.Service<
  TaskContextGroupService,
  {
    readonly list: () => Effect.Effect<TaskContextGroupListResult, TaskContextGroupError>;
    readonly subscribeChanges: () => Stream.Stream<number, TaskContextGroupError>;
    readonly get: (
      groupId: TaskContextGroupId,
    ) => Effect.Effect<TaskContextGroupGetResult, TaskContextGroupError>;
    readonly forThread: (
      threadId: ThreadId,
    ) => Effect.Effect<TaskContextGroupForThreadResult, TaskContextGroupError>;
    readonly mutate: (
      input: TaskContextGroupMutateInput,
      authorize?: Effect.Effect<void, TaskContextGroupError>,
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

function affectsGroupReferences(event: ApplicationStoredEvent): boolean {
  const type = "event" in event ? event.event.type : event.type;
  return (
    type === "thread.created" ||
    type === "thread.metadata-updated" ||
    type === "thread.deleted" ||
    type === "project.created" ||
    type === "project.meta-updated" ||
    type === "project.deleted"
  );
}

const make = Effect.gen(function* () {
  const crypto = yield* Crypto.Crypto;
  const sql = yield* SqlClient.SqlClient;
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  const store = yield* TaskContextGroupStore.TaskContextGroupStore;
  const projects = yield* ProjectService.ProjectService;
  const applicationEvents = yield* ApplicationEventStore.OrchestrationEventStore;
  const lock = yield* Semaphore.make(1);
  const revision = yield* Ref.make(0);
  const changes = yield* PubSub.sliding<void>(1);
  const notifyChanged = PubSub.publish(changes, undefined).pipe(Effect.asVoid);
  const subscribeChanges = () =>
    Stream.unwrap(
      Effect.gen(function* () {
        const subscription = yield* PubSub.subscribe(changes);
        const afterSequence = yield* applicationEvents.latestApplicationSequence.pipe(
          Effect.mapError((error) => failure("orchestration_error", errorMessage(error))),
        );
        const referenceChanges = applicationEvents
          .streamProjectedApplicationEvents({
            afterSequence,
            project: (event) => ({
              sequence: event.sequence,
              affectsReferences: affectsGroupReferences(event),
            }),
          })
          .pipe(
            Stream.filter((event) => event.affectsReferences),
            Stream.map(() => undefined),
            Stream.mapError((error) => failure("orchestration_error", errorMessage(error))),
          );
        return Stream.concat(
          Stream.succeed(undefined),
          Stream.merge(Stream.fromSubscription(subscription), referenceChanges),
        ).pipe(Stream.mapEffect(() => Ref.updateAndGet(revision, (value) => value + 1)));
      }),
    );

  const requireThread = Effect.fn("TaskContextGroupService.requireThread")(function* (
    threadId: ThreadId,
  ) {
    const shell = yield* orchestrator
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

  const writeGroup = Effect.fn("TaskContextGroupService.writeGroup")(function* (
    group: TaskContextGroup,
  ) {
    yield* validateGroup(group);
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
    yield* notifyChanged;
  });

  const findGroup = store.get;

  const findGroupForThread = (threadId: ThreadId) =>
    Effect.gen(function* () {
      const shell = yield* requireThread(threadId);
      if (shell.taskContextGroupId == null) return null;
      const group = yield* findGroup(shell.taskContextGroupId);
      if (group === null) {
        return yield* failure("not_found", "The thread's shared context group was not found.");
      }
      return group;
    });

  const validateGroup = (group: TaskContextGroup) =>
    validateGroupDocument(group).pipe(
      Effect.mapError(() =>
        failure(
          "invalid_resource",
          "Shared context exceeds its limits. Shorten the brief or remove resources or members to fit the 64,000-character turn limit.",
        ),
      ),
      Effect.asVoid,
    );

  const refreshGroup = store.resolve;

  const syncShellMembership = Effect.fn("TaskContextGroupService.syncShellMembership")(
    function* (input: {
      readonly threadId: ThreadId;
      readonly group: TaskContextGroup;
      readonly op: "attach" | "detach";
    }) {
      yield* validateGroup(input.group);
      const commandId = CommandId.make(
        [
          "command",
          "task-context-group",
          input.op,
          encodeURIComponent(input.threadId),
          encodeURIComponent(input.group.id),
          yield* crypto.randomUUIDv4.pipe(Effect.orDie),
        ].join(":"),
      );
      yield* orchestrator
        .dispatch({
          type:
            input.op === "attach"
              ? "thread.task-context-group.attach"
              : "thread.task-context-group.detach",
          commandId,
          threadId: input.threadId,
          groupId: input.group.id,
          group: input.group,
        })
        .pipe(
          Effect.mapError((error) =>
            failure(
              "orchestration_error",
              `Unable to ${input.op} task context group on thread ${input.threadId}: ${errorMessage(error)}`,
            ),
          ),
        );
      yield* notifyChanged;
    },
  );

  const list = (): Effect.Effect<TaskContextGroupListResult, TaskContextGroupError> =>
    store.list().pipe(
      Effect.flatMap((groups) => Effect.forEach(groups, store.resolve, { concurrency: 1 })),
      Effect.map((groups) => ({ groups })),
    );

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
      const group = yield* findGroupForThread(threadId);
      if (group === null) return { group: null, relatedThreads: [] };
      const refreshed = yield* refreshGroup(group);
      const related = yield* Effect.forEach(
        refreshed.memberThreadIds.filter((memberId) => memberId !== threadId),
        (memberId) =>
          orchestrator.getThreadShell(memberId).pipe(
            Effect.mapError(() =>
              failure("orchestration_error", "Related threads could not be loaded."),
            ),
            Effect.map((thread) => ({
              threadId: memberId,
              title:
                thread === null || thread.deletedAt !== null
                  ? "Missing thread"
                  : thread.title.trim().slice(0, TASK_CONTEXT_TITLE_MAX_CHARS) || "Thread",
              availability:
                thread === null || thread.deletedAt !== null
                  ? ("missing" as const)
                  : ("available" as const),
            })),
          ),
        { concurrency: 1 },
      );
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
      resource = yield* decodeResource(resource).pipe(
        Effect.mapError(() => {
          const pathRefusal = refuseClientPathResource(resource);
          return failure(
            pathRefusal === null ? "invalid_resource" : "path_refused",
            pathRefusal ?? "The resource contains unsupported fields.",
          );
        }),
      );
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
            title: shell.title.trim().slice(0, TASK_CONTEXT_TITLE_MAX_CHARS) || "Thread",
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
            name: project.value.title.trim().slice(0, TASK_CONTEXT_TITLE_MAX_CHARS) || "Project",
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
    authorize: Effect.Effect<void, TaskContextGroupError> = Effect.void,
  ): Effect.Effect<TaskContextGroupMutateResult, TaskContextGroupError> =>
    lock.withPermits(1)(
      Effect.gen(function* () {
        yield* authorize;
        const timestamp = yield* nowIso();

        if (input.action === "create") {
          const shell = yield* requireThread(input.threadId);
          const existing = yield* findGroupForThread(shell.id);
          if (existing !== null) {
            if (shell.taskContextGroupId !== existing.id) {
              yield* syncShellMembership({
                threadId: shell.id,
                group: existing,
                op: "attach",
              });
            }
            return { group: yield* refreshGroup(existing) };
          }
          const group: TaskContextGroup = {
            id: yield* mintGroupId(),
            title:
              input.title ??
              (shell.title.trim().slice(0, TASK_CONTEXT_TITLE_MAX_CHARS) || "Shared task context"),
            brief: input.brief ?? "",
            resources: [],
            memberThreadIds: [shell.id],
            createdAt: timestamp,
            updatedAt: timestamp,
          };
          yield* syncShellMembership({
            threadId: shell.id,
            group,
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
                group: current,
                op: "attach",
              });
              return { group: yield* refreshGroup(current) };
            }
            next = { ...current, memberThreadIds: [...members], updatedAt: timestamp };
            yield* syncShellMembership({
              threadId: input.threadId,
              group: next,
              op: "attach",
            });
            return { group: yield* refreshGroup(next) };
          }
          case "detach-thread": {
            const members = nextMemberThreadIds(current.memberThreadIds, input.threadId, "detach");
            if (members === undefined) {
              return { group: yield* refreshGroup(current) };
            }
            next = { ...current, memberThreadIds: [...members], updatedAt: timestamp };
            const shell = yield* orchestrator
              .getThreadShell(input.threadId)
              .pipe(
                Effect.mapError(() =>
                  failure("orchestration_error", "The member thread could not be loaded."),
                ),
              );
            if (shell === null) {
              yield* writeGroup(next);
              return { group: yield* refreshGroup(next) };
            }
            yield* syncShellMembership({
              threadId: input.threadId,
              group: next,
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

  const enrichTurn = Effect.fn("TaskContextGroupService.enrichTurn")(function* (input: {
    readonly threadId: ThreadId;
    readonly text: string;
    readonly context: OrchestrationMessageContext | undefined;
  }) {
    const shell = yield* requireThread(input.threadId);
    const merged = yield* store.capture({
      thread: shell,
      text: input.text,
      context: input.context,
    });
    const isolation = linkedThreadDoesNotWidenWorkspace({
      ownWorktreePath: shell.worktreePath,
      ownProjectId: shell.projectId,
      siblingWorktreePath: null,
      siblingProjectId: shell.projectId,
    });
    return { ...merged, checkpointCwd: isolation.checkpointCwd, projectId: isolation.projectId };
  });

  return TaskContextGroupService.of({ list, get, forThread, mutate, enrichTurn, subscribeChanges });
});

export const layer: Layer.Layer<
  TaskContextGroupService,
  never,
  | Crypto.Crypto
  | SqlClient.SqlClient
  | Orchestrator.OrchestratorV2
  | TaskContextGroupStore.TaskContextGroupStore
  | ProjectService.ProjectService
  | ApplicationEventStore.OrchestrationEventStore
> = Layer.effect(TaskContextGroupService, make);
