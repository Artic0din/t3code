import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import {
  CommandId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  MessageId,
  EventId,
  OrchestrationV2Command,
  TaskContextGroupId,
  turnReceivedTaskContext,
  type Project,
  type TaskContextGroupForThreadResult,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";

import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ApplicationEventStore from "../persistence/OrchestrationEventStore.ts";
import * as ProjectService from "../project/ProjectService.ts";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import * as Orchestrator from "./Orchestrator.ts";
import type { ProviderAdapterV2Shape } from "./ProviderAdapter.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import * as TaskContextGroupService from "./TaskContextGroupService.ts";
import * as TaskContextGroupStore from "./TaskContextGroupStore.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ProjectStore from "./ProjectStore.ts";
import * as ThreadManagementService from "./ThreadManagementService.ts";
import * as ThreadLaunchService from "./ThreadLaunchService.ts";
import * as ScheduledTasks from "../scheduledTasks/ScheduledTaskService.ts";
import * as Scheduler from "../scheduling/Scheduler.ts";
import * as SecretRequests from "../secrets/SecretRequests.ts";
import { ThreadToolkit } from "../mcp/toolkits/thread/tools.ts";
import * as ThreadHandlers from "../mcp/toolkits/thread/handlers.ts";
import * as McpToolAccess from "../mcp/McpToolAccess.ts";
import * as McpInvocationContext from "../mcp/McpInvocationContext.ts";
import { EnvironmentId, TaskContextGroupError, ComposerContextId } from "@t3tools/contracts";
import * as ProviderReplayHarness from "./testkit/ProviderReplayHarness.ts";
import { projectComposerContextForProvider } from "@t3tools/shared/composerContextReferences";

const instanceId = ProviderInstanceId.make("codex");
const modelSelection = { instanceId, model: "gpt-5.1-codex" };
const projectA = ProjectId.make("project:frontend");
const projectB = ProjectId.make("project:backend");
const threadA = ThreadId.make("thread:frontend");
const threadB = ThreadId.make("thread:backend");
const isPublicCommand = Schema.is(OrchestrationV2Command);

const adapter = {
  instanceId,
  driver: ProviderDriverKind.make("codex"),
  getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
  planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" as const }),
  openSession: () => Effect.die("Task context groups do not start a provider"),
} as ProviderAdapterV2Shape;

const layerDatabase = SqlitePersistence.layerMemory;

const project = (id: ProjectId, title: string): Project => ({
  id,
  title,
  workspaceRoot: `/repos/${title}`,
  defaultModelSelection: null,
  scripts: [],
  createdAt: "2026-10-13T00:00:00.000Z",
  updatedAt: "2026-10-13T00:00:00.000Z",
  deletedAt: null,
});

const layerProjects = Layer.mock(ProjectService.ProjectService)({
  getById: (projectId) =>
    Effect.succeed(
      projectId === projectA
        ? Option.some(project(projectA, "Frontend"))
        : projectId === projectB
          ? Option.some(project(projectB, "Backend"))
          : Option.none(),
    ),
});

const layerOrchestration = ThreadManagementService.layer.pipe(
  Layer.provideMerge(
    Layer.mergeAll(
      layerDatabase,
      ProviderReplayHarness.layerWithRegistry(
        { name: "task-context-group" },
        ProviderAdapterRegistry.layerFromAdapters([adapter]),
        { databaseLayer: layerDatabase, runEffectWorker: false },
      ),
    ),
  ),
);

const layerService = TaskContextGroupService.layer.pipe(
  Layer.provideMerge(
    Layer.mergeAll(
      layerProjects,
      ProjectStore.layer,
      TaskContextGroupStore.layer.pipe(
        Layer.provide(Layer.mergeAll(ProjectionStore.layer, ProjectStore.layer)),
      ),
      ApplicationEventStore.layer,
    ),
  ),
  Layer.provideMerge(layerOrchestration),
  Layer.provideMerge(NodeServices.layer),
);

const seedProject = (id: ProjectId) =>
  Effect.gen(function* () {
    const projects = yield* ProjectStore.ProjectStoreV2;
    if (Option.isSome(yield* projects.get(id))) return;
    const value = project(id, id === projectA ? "Frontend" : "Backend");
    yield* projects.apply({
      sequence: 0,
      eventId: EventId.make(`seed:${id}`),
      aggregateKind: "project",
      aggregateId: id,
      occurredAt: value.createdAt,
      commandId: null,
      causationEventId: null,
      correlationId: null,
      metadata: {},
      type: "project.created",
      payload: { ...value, projectId: id },
    });
  });

const createThread = (threadId: ThreadId, projectId: ProjectId, worktreePath: string | null) =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    yield* seedProject(projectId);
    yield* orchestrator.dispatch({
      type: "thread.create",
      commandId: CommandId.make(`create:${threadId}`),
      threadId,
      projectId,
      title: String(threadId),
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath,
      createdBy: "user",
      creationSource: "web",
    });
  });

describe("TaskContextGroup", () => {
  it.effect("delegates from a grouped parent without inheriting implicit membership", () =>
    Effect.gen(function* () {
      const service = yield* TaskContextGroupService.TaskContextGroupService;
      const threads = yield* ThreadManagementService.ThreadManagementService;
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      yield* createThread(threadA, projectA, "/wt/frontend");
      const group = (yield* service.mutate({
        action: "create",
        threadId: threadA,
        brief: "Parent context",
      })).group;
      const parent = yield* threads.sendToThread({
        projectId: projectA,
        threadId: threadA,
        commandId: CommandId.make("grouped-parent-run"),
        messageId: MessageId.make("grouped-parent-message"),
        text: "Parent work",
        attachments: [],
        mode: "queue",
        createdBy: "user",
        creationSource: "web",
      });
      assert.ok(parent.run.rootNodeId);
      yield* orchestrator.dispatch({
        type: "delegated_task.request",
        commandId: CommandId.make("grouped-parent-delegate"),
        parentThreadId: threadA,
        parentRunId: parent.run.id,
        parentNodeId: parent.run.rootNodeId,
        task: "Child work",
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        createdBy: "agent",
        creationSource: "mcp",
      });
      const parentProjection = yield* orchestrator.getThreadProjection(threadA);
      const childThreadId = parentProjection.subagents[0]?.childThreadId;
      assert.ok(childThreadId);
      const child = yield* orchestrator.getThreadProjection(childThreadId);
      assert.equal(child.thread.taskContextGroupId, null);
      assert.equal(child.thread.projectId, projectA);
      assert.equal(child.thread.worktreePath, "/wt/frontend");
      assert.equal(child.messages[0]?.text, "Child work");
      assert.equal(turnReceivedTaskContext(child.messages[0]?.context), null);
      assert.deepEqual((yield* service.get(group.id)).group?.memberThreadIds, [threadA]);
      assert.equal(parentProjection.thread.taskContextGroupId, group.id);
    }).pipe(Effect.provide(layerService)),
  );
  it.effect("refreshes live referenced entities without rewriting frozen snapshots", () =>
    Effect.gen(function* () {
      const service = yield* TaskContextGroupService.TaskContextGroupService;
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      yield* createThread(threadA, projectA, "/wt/frontend");
      yield* createThread(threadB, projectB, "/wt/backend");
      yield* orchestrator.dispatch({
        type: "thread.archive",
        commandId: CommandId.make("archive-reference"),
        threadId: threadB,
      });
      const created = yield* service.mutate({
        action: "create",
        threadId: threadA,
        brief: "Frozen metadata",
      });
      yield* service.mutate({
        action: "attach-thread",
        groupId: created.group.id,
        threadId: threadB,
      });
      yield* service.mutate({
        action: "attach-resource",
        groupId: created.group.id,
        resource: { kind: "thread", threadId: threadB },
      });
      const captured = yield* service.enrichTurn({
        threadId: threadA,
        text: "Work",
        context: undefined,
      });
      const frozen = turnReceivedTaskContext(captured.context);
      const releaseSubscription = yield* Deferred.make<void>();
      const views = yield* Queue.unbounded<TaskContextGroupForThreadResult>();
      yield* service.subscribeChanges().pipe(
        Stream.mapEffect(() => service.forThread(threadA)),
        Stream.tap((view) =>
          Queue.offer(views, view).pipe(Effect.andThen(Deferred.await(releaseSubscription))),
        ),
        Stream.runDrain,
        Effect.forkChild,
      );
      const initial = yield* Queue.take(views);
      assert.equal(initial.relatedThreads[0]?.availability, "available");
      yield* orchestrator.dispatch({
        type: "thread.metadata.update",
        commandId: CommandId.make("rename-shared-member"),
        threadId: threadB,
        title: "Renamed member",
      });
      yield* Deferred.succeed(releaseSubscription, undefined);
      const renamed = yield* Queue.take(views);
      assert.equal(renamed.relatedThreads[0]?.title, "Renamed member");
      assert.equal(
        renamed.group?.resources[0]?.kind === "thread" ? renamed.group.resources[0].title : null,
        "Renamed member",
      );
      yield* orchestrator.dispatch({
        type: "thread.delete",
        commandId: CommandId.make("delete-shared-member"),
        threadId: threadB,
      });
      const deleted = yield* Queue.take(views);
      assert.equal(deleted.relatedThreads[0]?.availability, "missing");
      assert.equal(
        deleted.group?.resources[0]?.kind === "thread"
          ? deleted.group.resources[0].availability
          : null,
        "missing",
      );
      assert.deepEqual(turnReceivedTaskContext(captured.context), frozen);
      assert.equal(
        frozen?.resources[0]?.kind === "thread" ? frozen.resources[0].title : null,
        initial.relatedThreads[0]?.title,
      );
    }).pipe(Effect.provide(layerService)),
  );

  it.effect("refreshes project references on committed rename and deletion", () =>
    Effect.gen(function* () {
      const service = yield* TaskContextGroupService.TaskContextGroupService;
      const events = yield* ApplicationEventStore.OrchestrationEventStore;
      const projects = yield* ProjectStore.ProjectStoreV2;
      yield* createThread(threadA, projectA, "/wt/frontend");
      yield* seedProject(projectB);
      const created = yield* service.mutate({ action: "create", threadId: threadA });
      yield* service.mutate({
        action: "attach-resource",
        groupId: created.group.id,
        resource: { kind: "project", projectId: projectB },
      });
      const views = yield* Queue.unbounded<TaskContextGroupForThreadResult>();
      yield* service.subscribeChanges().pipe(
        Stream.mapEffect(() => service.forThread(threadA)),
        Stream.tap((view) => Queue.offer(views, view)),
        Stream.runDrain,
        Effect.forkChild,
      );
      yield* Queue.take(views);
      const eventBase = {
        aggregateKind: "project" as const,
        aggregateId: projectB,
        occurredAt: "2026-10-14T00:00:00.000Z",
        commandId: null,
        causationEventId: null,
        correlationId: null,
        metadata: {},
      };
      const renamed = yield* events.appendProjectEvent({
        ...eventBase,
        eventId: EventId.make("rename-shared-project"),
        type: "project.meta-updated",
        payload: {
          projectId: projectB,
          title: "Renamed project",
          updatedAt: eventBase.occurredAt,
        },
      });
      yield* projects.apply(renamed);
      yield* events.publishCommitted([renamed]);
      const renamedView = (yield* Queue.take(views)).group?.resources[0];
      assert.equal(renamedView?.kind === "project" ? renamedView.name : null, "Renamed project");
      const deleted = yield* events.appendProjectEvent({
        ...eventBase,
        eventId: EventId.make("delete-shared-project"),
        type: "project.deleted",
        payload: { projectId: projectB, deletedAt: eventBase.occurredAt },
      });
      yield* projects.apply(deleted);
      yield* events.publishCommitted([deleted]);
      const deletedView = (yield* Queue.take(views)).group?.resources[0];
      assert.equal(deletedView?.kind === "project" ? deletedView.availability : null, "missing");
    }).pipe(Effect.provide(layerService)),
  );

  it.effect("preserves a frozen snapshot when MCP edits a queued message", () =>
    Effect.gen(function* () {
      const service = yield* TaskContextGroupService.TaskContextGroupService;
      const threads = yield* ThreadManagementService.ThreadManagementService;
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const toolkit = yield* ThreadToolkit;
      yield* createThread(threadA, projectA, "/wt/frontend");
      const created = yield* service.mutate({
        action: "create",
        threadId: threadA,
        brief: "Frozen brief",
      });
      yield* threads.sendToThread({
        projectId: projectA,
        threadId: threadA,
        commandId: CommandId.make("queue-active"),
        messageId: MessageId.make("queue-active-message"),
        text: "Active work",
        attachments: [],
        mode: "queue",
        createdBy: "user",
        creationSource: "web",
      });
      const queued = yield* threads.sendToThread({
        projectId: projectA,
        threadId: threadA,
        commandId: CommandId.make("queue-context"),
        messageId: MessageId.make("queue-context-message"),
        text: "Queued work",
        attachments: [],
        mode: "queue",
        createdBy: "user",
        creationSource: "web",
      });
      assert.equal(queued.run.status, "queued");
      yield* service.mutate({
        action: "update-brief",
        groupId: created.group.id,
        brief: "Later brief",
      });
      const edited = yield* toolkit
        .handle("t3_queue_edit", {
          threadId: threadA,
          queuedRunId: queued.run.id,
          text: "Revised work",
        })
        .pipe(
          Effect.flatMap(Stream.runCollect),
          Effect.provideService(McpInvocationContext.McpInvocationContext, {
            environmentId: EnvironmentId.make("test-environment"),
            requestNamespace: "queued-context",
            thread: undefined,
            client: { sessionId: "test-session", label: "Context test", access: "full-access" },
            capabilities: new Set(["orchestration"] as const),
            issuedAt: 0,
          }),
        );
      assert.equal(edited[0]?.isFailure, false);
      const projection = yield* orchestrator.getThreadProjection(threadA);
      const message = projection.messages.find((item) => item.id === queued.message.id);
      assert.ok(message);
      assert.deepEqual(message.context, queued.message.context);
      const input = projectComposerContextForProvider({
        text: message.text,
        records: message.context?.records ?? [],
      });
      assert.match(input, /Revised work/);
      assert.match(input, /Frozen brief/);
      assert.equal(input.includes("Later brief"), false);
    }).pipe(
      Effect.provide(
        McpToolAccess.HandlersLayer.layer(ThreadHandlers.layer).pipe(
          Layer.provideMerge(layerService),
        ),
      ),
    ),
  );

  it.effect("shows deleted members and permits detaching them without restoring the thread", () =>
    Effect.gen(function* () {
      const service = yield* TaskContextGroupService.TaskContextGroupService;
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      yield* createThread(threadA, projectA, "/wt/frontend");
      yield* createThread(threadB, projectB, "/wt/backend");
      const created = yield* service.mutate({ action: "create", threadId: threadA });
      yield* service.mutate({
        action: "attach-thread",
        groupId: created.group.id,
        threadId: threadB,
      });
      yield* orchestrator.dispatch({
        type: "thread.delete",
        commandId: CommandId.make("delete:member"),
        threadId: threadB,
      });
      const visible = yield* service.forThread(threadA);
      assert.deepEqual(
        visible.relatedThreads.map((thread) => thread.threadId),
        [threadB],
      );
      const detached = yield* service.mutate({
        action: "detach-thread",
        groupId: created.group.id,
        threadId: threadB,
      });
      assert.deepEqual(detached.group.memberThreadIds, [threadA]);
      const deleted = yield* orchestrator.getThreadProjection(threadB);
      assert.notEqual(deleted.thread.deletedAt, null);
      assert.equal(deleted.thread.taskContextGroupId, created.group.id);
      assert.equal(deleted.thread.worktreePath, "/wt/backend");
    }).pipe(Effect.provide(layerService)),
  );

  it.effect("publishes committed changes to another subscriber", () =>
    Effect.gen(function* () {
      const service = yield* TaskContextGroupService.TaskContextGroupService;
      const sql = yield* SqlClient.SqlClient;
      const observed = yield* Queue.unbounded<string | null>();
      yield* service.subscribeChanges().pipe(
        Stream.mapEffect(() =>
          service.forThread(threadA).pipe(
            Effect.map((result) => result.group?.brief ?? null),
            Effect.catchTags({ TaskContextGroupError: () => Effect.succeed(null) }),
          ),
        ),
        Stream.changes,
        Stream.tap((value) => Queue.offer(observed, value)),
        Stream.runDrain,
        Effect.forkChild,
      );
      assert.equal(yield* Queue.take(observed), null);
      yield* createThread(threadA, projectA, "/wt/frontend");
      const created = yield* service.mutate({
        action: "create",
        threadId: threadA,
        brief: "First",
      });
      assert.equal(yield* Queue.take(observed), "First");
      yield* sql`CREATE TRIGGER reject_brief BEFORE UPDATE ON task_context_groups
      BEGIN SELECT RAISE(ABORT, 'brief commit rejected'); END`;
      const failed = yield* service
        .mutate({ action: "update-brief", groupId: created.group.id, brief: "Rejected" })
        .pipe(Effect.flip);
      assert.equal(failed.code, "orchestration_error");
      assert.equal((yield* service.get(created.group.id)).group?.brief, "First");
      yield* sql`DROP TRIGGER reject_brief`;
      yield* service.mutate({
        action: "update-brief",
        groupId: created.group.id,
        brief: "Committed",
      });
      assert.equal(yield* Queue.take(observed), "Committed");
      assert.equal((yield* service.get(created.group.id)).group?.brief, "Committed");
    }).pipe(Effect.provide(layerService)),
  );

  it.effect("refuses message overflow and unauthorized group mutations", () =>
    Effect.gen(function* () {
      const service = yield* TaskContextGroupService.TaskContextGroupService;
      yield* createThread(threadA, projectA, "/wt/frontend");
      const created = yield* service.mutate({
        action: "create",
        threadId: threadA,
        brief: "Saved",
      });
      const records = Array.from({ length: 200 }, (_, index) => ({
        version: 1 as const,
        kind: "custom",
        contextId: ComposerContextId.make(`custom_${index}`),
        label: "Reference",
        payload: {},
      }));
      const overflow = yield* service
        .enrichTurn({ threadId: threadA, text: "Work", context: { version: 1, records } })
        .pipe(Effect.flip);
      assert.equal(overflow.code, "invalid_resource");
      const refused = yield* service
        .mutate(
          { action: "update-brief", groupId: created.group.id, brief: "Blocked" },
          Effect.fail(new TaskContextGroupError({ code: "permission_denied", message: "Denied" })),
        )
        .pipe(Effect.flip);
      assert.equal(refused.code, "permission_denied");
      assert.equal((yield* service.get(created.group.id)).group?.brief, "Saved");
    }).pipe(Effect.provide(layerService)),
  );

  it.effect("runs a scheduled task through durable shared context capture", () =>
    Effect.gen(function* () {
      const service = yield* TaskContextGroupService.TaskContextGroupService;
      const scheduler = yield* ScheduledTasks.ScheduledTaskService;
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      yield* createThread(threadA, projectA, "/wt/frontend");
      yield* service.mutate({ action: "create", threadId: threadA, brief: "Scheduled brief" });
      const saved = yield* scheduler.upsert({
        title: "Scheduled context",
        prompt: "Scheduled work",
        enabled: false,
        schedule: { type: "interval", everyMs: 60000 },
        projectId: projectA,
        threadId: threadA,
        workspaceStrategy: { type: "root" },
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
      });
      const fired = yield* scheduler.runNow({ id: saved.task.id });
      assert.equal(fired.task.lastRunStatus, "succeeded");
      const projection = yield* orchestrator.getThreadProjection(threadA);
      const message = projection.messages.find((item) => item.scheduledTaskId === saved.task.id);
      assert.equal(turnReceivedTaskContext(message?.context)?.brief, "Scheduled brief");
      assert.equal(projection.thread.projectId, projectA);
      assert.equal(projection.thread.worktreePath, "/wt/frontend");
    }).pipe(
      Effect.provide(
        ScheduledTasks.layer.pipe(
          Layer.provideMerge(
            Layer.mergeAll(
              Scheduler.layer,
              Layer.mock(ThreadLaunchService.ThreadLaunchService)({}),
              Layer.mock(SecretRequests.SecretRequests)({}),
            ),
          ),
          Layer.provideMerge(layerService),
        ),
      ),
    ),
  );

  it.effect("exposes group management through checked MCP tools", () =>
    Effect.gen(function* () {
      const service = yield* TaskContextGroupService.TaskContextGroupService;
      yield* createThread(threadA, projectA, "/wt/frontend");
      const created = yield* service.mutate({
        action: "create",
        threadId: threadA,
        brief: "Saved",
      });
      const tools = yield* ThreadToolkit;
      const scope = (
        access: "read-only" | "full-access",
      ): McpInvocationContext.McpInvocationScope => ({
        environmentId: EnvironmentId.make("test-environment"),
        requestNamespace: "test-context",
        thread: undefined,
        client: { sessionId: "test-session", label: "Context test", access },
        capabilities: new Set(["orchestration"]),
        issuedAt: 0,
      });
      const invoke = (access: "read-only" | "full-access") =>
        tools
          .handle("t3_task_context_mutate", {
            input: { action: "update-brief", groupId: created.group.id, brief: "MCP brief" },
          })
          .pipe(
            Effect.flatMap(Stream.runCollect),
            Effect.provideService(McpInvocationContext.McpInvocationContext, scope(access)),
          );
      const denied = yield* invoke("read-only");
      assert.equal(denied[0]?.isFailure, true);
      assert.equal((yield* service.get(created.group.id)).group?.brief, "Saved");
      const changed = yield* invoke("full-access");
      assert.equal(changed[0]?.isFailure, false);
      assert.equal((yield* service.get(created.group.id)).group?.brief, "MCP brief");
      const read = yield* tools
        .handle("t3_task_context_read", { threadId: threadA })
        .pipe(
          Effect.flatMap(Stream.runCollect),
          Effect.provideService(McpInvocationContext.McpInvocationContext, scope("read-only")),
        );
      assert.equal(read[0]?.isFailure, false);
      assert.equal(
        (read[0]?.result as { group: { brief: string } } | undefined)?.group.brief,
        "MCP brief",
      );
    }).pipe(
      Effect.provide(
        McpToolAccess.HandlersLayer.layer(ThreadHandlers.layer).pipe(
          Layer.provideMerge(layerService),
        ),
      ),
    ),
  );

  it.effect("captures shared context for messages generated inside orchestration", () =>
    Effect.gen(function* () {
      const service = yield* TaskContextGroupService.TaskContextGroupService;
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      yield* createThread(threadA, projectA, "/wt/frontend");
      yield* service.mutate({ action: "create", threadId: threadA, brief: "Generated turn brief" });
      yield* orchestrator.dispatch({
        type: "message.dispatch",
        commandId: CommandId.make("generated-send"),
        threadId: threadA,
        messageId: MessageId.make("generated-message"),
        text: "Generated work",
        attachments: [],
        dispatchMode: { type: "queue_after_active" },
        createdBy: "system",
        creationSource: "server",
      });
      const projection = yield* orchestrator.getThreadProjection(threadA);
      assert.equal(
        turnReceivedTaskContext(
          projection.messages.find((item) => item.id === "generated-message")?.context,
        )?.brief,
        "Generated turn brief",
      );
    }).pipe(Effect.provide(layerService)),
  );

  it.effect("replays an accepted send after its shared group becomes unavailable", () =>
    Effect.gen(function* () {
      const service = yield* TaskContextGroupService.TaskContextGroupService;
      const threads = yield* ThreadManagementService.ThreadManagementService;
      const sql = yield* SqlClient.SqlClient;
      yield* createThread(threadA, projectA, "/wt/frontend");
      yield* service.mutate({ action: "create", threadId: threadA, brief: "Accepted" });
      const command = {
        type: "message.dispatch" as const,
        commandId: CommandId.make("replayed-group-send"),
        threadId: threadA,
        messageId: MessageId.make("replayed-group-message"),
        text: "Work",
        attachments: [],
        dispatchMode: { type: "queue_after_active" as const },
        createdBy: "user" as const,
        creationSource: "web" as const,
      };
      const accepted = yield* threads.dispatch(command);
      yield* sql`DELETE FROM task_context_groups`;
      const replayed = yield* threads.dispatch(command);
      assert.equal(replayed.sequence, accepted.sequence);
      assert.deepEqual(replayed.storedEvents, accepted.storedEvents);
    }).pipe(Effect.provide(layerService)),
  );

  it.effect("rejects oversized edits without replacing the saved brief", () =>
    Effect.gen(function* () {
      const service = yield* TaskContextGroupService.TaskContextGroupService;
      yield* createThread(threadA, projectA, "/wt/frontend");
      const created = yield* service.mutate({
        action: "create",
        threadId: threadA,
        brief: "Saved",
      });
      const error = yield* service
        .mutate({
          action: "update-brief",
          groupId: created.group.id,
          brief: "\u0000".repeat(32_000),
        })
        .pipe(Effect.flip);
      assert.equal(error.code, "invalid_resource");
      assert.equal((yield* service.get(created.group.id)).group?.brief, "Saved");
    }).pipe(Effect.provide(layerService)),
  );

  it.effect("keeps both memberships unchanged when attach or detach persistence fails", () =>
    Effect.gen(function* () {
      const service = yield* TaskContextGroupService.TaskContextGroupService;
      const sql = yield* SqlClient.SqlClient;
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      yield* createThread(threadA, projectA, "/wt/frontend");
      yield* createThread(threadB, projectB, "/wt/backend");
      const created = yield* service.mutate({ action: "create", threadId: threadA });
      yield* sql`CREATE TRIGGER fail_membership BEFORE UPDATE ON orchestration_v2_projection_threads
        BEGIN SELECT RAISE(ABORT, 'membership commit rejected'); END`;
      const failedAttach = yield* service
        .mutate({
          action: "attach-thread",
          groupId: created.group.id,
          threadId: threadB,
        })
        .pipe(Effect.flip);
      assert.equal(failedAttach.code, "orchestration_error");
      assert.deepEqual((yield* service.get(created.group.id)).group?.memberThreadIds, [threadA]);
      assert.equal(
        (yield* orchestrator.getThreadProjection(threadB)).thread.taskContextGroupId ?? null,
        null,
      );
      yield* sql`DROP TRIGGER fail_membership`;
      yield* service.mutate({
        action: "attach-thread",
        groupId: created.group.id,
        threadId: threadB,
      });
      yield* sql`CREATE TRIGGER fail_membership BEFORE UPDATE ON orchestration_v2_projection_threads
        BEGIN SELECT RAISE(ABORT, 'membership commit rejected'); END`;
      const failedDetach = yield* service
        .mutate({
          action: "detach-thread",
          groupId: created.group.id,
          threadId: threadB,
        })
        .pipe(Effect.flip);
      assert.equal(failedDetach.code, "orchestration_error");
      assert.deepEqual((yield* service.get(created.group.id)).group?.memberThreadIds, [
        threadA,
        threadB,
      ]);
      assert.equal(
        (yield* orchestrator.getThreadProjection(threadB)).thread.taskContextGroupId,
        created.group.id,
      );
    }).pipe(Effect.provide(layerService)),
  );

  it.effect("rolls back the group when shell persistence fails", () =>
    Effect.gen(function* () {
      const service = yield* TaskContextGroupService.TaskContextGroupService;
      const sql = yield* SqlClient.SqlClient;
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      yield* createThread(threadA, projectA, "/wt/frontend");
      yield* sql`CREATE TRIGGER fail_membership BEFORE UPDATE ON orchestration_v2_projection_threads
        BEGIN SELECT RAISE(ABORT, 'membership commit rejected'); END`;
      const error = yield* service
        .mutate({ action: "create", threadId: threadA, brief: "Atomic" })
        .pipe(Effect.flip);
      assert.equal(error.code, "orchestration_error");
      const rows = yield* sql<{
        document_json: string;
      }>`SELECT document_json FROM task_context_groups`;
      assert.deepEqual(rows, []);
      assert.equal(
        (yield* orchestrator.getThreadProjection(threadA)).thread.taskContextGroupId ?? null,
        null,
      );
      yield* sql`DROP TRIGGER fail_membership`;
      const created = yield* service.mutate({
        action: "create",
        threadId: threadA,
        brief: "Atomic",
      });
      assert.equal(
        (yield* orchestrator.getThreadProjection(threadA)).thread.taskContextGroupId,
        created.group.id,
      );
    }).pipe(Effect.provide(layerService)),
  );

  it.effect("does not scan unrelated groups for ungrouped turns", () =>
    Effect.gen(function* () {
      const service = yield* TaskContextGroupService.TaskContextGroupService;
      const sql = yield* SqlClient.SqlClient;
      yield* createThread(threadA, projectA, "/wt/frontend");
      yield* sql`INSERT INTO task_context_groups VALUES ('corrupt', '{}', '2026-10-13T00:00:00.000Z')`;
      const result = yield* service.enrichTurn({
        threadId: threadA,
        text: "Plain",
        context: undefined,
      });
      assert.equal(result.text, "Plain");
      assert.equal(result.checkpointCwd, "/wt/frontend");
    }).pipe(Effect.provide(layerService)),
  );

  it("refuses public membership commands", () => {
    assert.isFalse(
      isPublicCommand({
        type: "thread.task-context-group.attach",
        commandId: CommandId.make("bypass"),
        threadId: threadA,
        groupId: TaskContextGroupId.make("nonexistent"),
      }),
    );
  });

  it.effect("snapshots shared context for scheduled and agent sends", () =>
    Effect.gen(function* () {
      const service = yield* TaskContextGroupService.TaskContextGroupService;
      const threads = yield* ThreadManagementService.ThreadManagementService;
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      yield* createThread(threadA, projectA, "/wt/frontend");
      yield* service.mutate({
        action: "create",
        threadId: threadA,
        brief: "Shared scheduled brief",
      });
      yield* threads.sendToThread({
        projectId: projectA,
        threadId: threadA,
        commandId: CommandId.make("scheduled-send"),
        messageId: MessageId.make("scheduled-message"),
        text: "Scheduled work",
        attachments: [],
        mode: "queue",
        createdBy: "user",
        creationSource: "mcp",
      });
      const projection = yield* orchestrator.getThreadProjection(threadA);
      const message = projection.messages.find((item) => item.id === "scheduled-message");
      assert.equal(turnReceivedTaskContext(message?.context)?.brief, "Shared scheduled brief");
    }).pipe(Effect.provide(layerService)),
  );

  it.effect("creates, attaches, detaches, and persists shell membership", () =>
    Effect.gen(function* () {
      const service = yield* TaskContextGroupService.TaskContextGroupService;
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      yield* createThread(threadA, projectA, "/wt/frontend");
      yield* createThread(threadB, projectB, "/wt/backend");

      const created = yield* service.mutate({
        action: "create",
        threadId: threadA,
        title: "Auth cutover",
        brief: "Ship auth across web and API.",
      });
      assert.equal(created.group.title, "Auth cutover");
      assert.deepEqual(created.group.memberThreadIds, [threadA]);

      const shellA = yield* orchestrator.getThreadProjection(threadA);
      assert.equal(shellA.thread.taskContextGroupId, created.group.id);

      const attached = yield* service.mutate({
        action: "attach-thread",
        groupId: created.group.id,
        threadId: threadB,
      });
      assert.deepEqual(attached.group.memberThreadIds, [threadA, threadB]);
      const shellB = yield* orchestrator.getThreadProjection(threadB);
      assert.equal(shellB.thread.taskContextGroupId, created.group.id);

      yield* service.mutate({
        action: "detach-thread",
        threadId: threadB,
        groupId: created.group.id,
      });
      const detachedShell = yield* orchestrator.getThreadProjection(threadB);
      assert.equal(detachedShell.thread.taskContextGroupId ?? null, null);

      const reloaded = yield* service.get(created.group.id);
      assert.isNotNull(reloaded.group);
      assert.equal(reloaded.group?.brief, "Ship auth across web and API.");
      assert.deepEqual(reloaded.group?.memberThreadIds, [threadA]);
    }).pipe(Effect.provide(layerService)),
  );

  it.effect("refuses client paths, snapshots brief per turn, and keeps worktree isolation", () =>
    Effect.gen(function* () {
      const service = yield* TaskContextGroupService.TaskContextGroupService;
      yield* createThread(threadA, projectA, "/wt/frontend");
      yield* createThread(threadB, projectB, "/wt/backend");

      const created = yield* service.mutate({
        action: "create",
        threadId: threadA,
        brief: "v1",
      });
      yield* service.mutate({
        action: "attach-thread",
        groupId: created.group.id,
        threadId: threadB,
      });

      const refused = yield* service
        .mutate({
          action: "attach-resource",
          groupId: created.group.id,
          resource: {
            kind: "note",
            title: "Bad",
            body: "x",
            path: "/Users/me/secret.ts",
          } as never,
        })
        .pipe(Effect.flip);
      assert.equal(refused.code, "path_refused");

      const enriched = yield* service.enrichTurn({
        threadId: threadA,
        text: "Continue.",
        context: undefined,
      });
      assert.equal(enriched.checkpointCwd, "/wt/frontend");
      assert.equal(enriched.projectId, projectA);
      const snapshot = turnReceivedTaskContext(enriched.context);
      assert.equal(snapshot?.brief, "v1");
      assert.isFalse(JSON.stringify(enriched).includes("/wt/backend"));

      yield* service.mutate({
        action: "update-brief",
        groupId: created.group.id,
        brief: "v2",
      });
      assert.equal(snapshot?.brief, "v1");
      const next = yield* service.enrichTurn({
        threadId: threadA,
        text: "Next.",
        context: undefined,
      });
      assert.equal(turnReceivedTaskContext(next.context)?.brief, "v2");
      assert.equal(next.checkpointCwd, "/wt/frontend");
    }).pipe(Effect.provide(layerService)),
  );
});
