import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import {
  CommandId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  turnReceivedTaskContext,
  type Project,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ProjectService from "../project/ProjectService.ts";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import * as Orchestrator from "./Orchestrator.ts";
import type { ProviderAdapterV2Shape } from "./ProviderAdapter.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import * as TaskContextGroupService from "./TaskContextGroupService.ts";
import * as ThreadManagementService from "./ThreadManagementService.ts";
import * as ProviderReplayHarness from "./testkit/ProviderReplayHarness.ts";

const instanceId = ProviderInstanceId.make("codex");
const modelSelection = { instanceId, model: "gpt-5.1-codex" };
const projectA = ProjectId.make("project:frontend");
const projectB = ProjectId.make("project:backend");
const threadA = ThreadId.make("thread:frontend");
const threadB = ThreadId.make("thread:backend");

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
  Layer.provide(Layer.mergeAll(layerOrchestration, layerProjects)),
  Layer.provideMerge(layerOrchestration),
  Layer.provideMerge(NodeServices.layer),
);

const createThread = (threadId: ThreadId, projectId: ProjectId, worktreePath: string | null) =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
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

      yield* orchestrator.dispatch({
        type: "thread.task-context-group.detach",
        commandId: CommandId.make("detach:b"),
        threadId: threadB,
        groupId: created.group.id,
      });
      const detachedShell = yield* orchestrator.getThreadProjection(threadB);
      assert.equal(detachedShell.thread.taskContextGroupId ?? null, null);

      const reloaded = yield* service.get(created.group.id);
      assert.isNotNull(reloaded.group);
      assert.equal(reloaded.group?.brief, "Ship auth across web and API.");
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
