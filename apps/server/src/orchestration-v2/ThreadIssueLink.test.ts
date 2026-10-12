import { assert, it } from "@effect/vitest";
import {
  CommandId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as SqlitePersistence from "../persistence/Sqlite.ts";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import * as Orchestrator from "./Orchestrator.ts";
import type { ProviderAdapterV2Shape } from "./ProviderAdapter.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import * as ThreadManagementService from "./ThreadManagementService.ts";
import * as ProviderReplayHarness from "./testkit/ProviderReplayHarness.ts";

const instanceId = ProviderInstanceId.make("codex");
const modelSelection = { instanceId, model: "gpt-5.1-codex" };
const adapter = {
  instanceId,
  driver: ProviderDriverKind.make("codex"),
  getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
  planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" as const }),
  openSession: () => Effect.die("Issue links do not start a provider"),
} as ProviderAdapterV2Shape;
const layerDatabase = SqlitePersistence.layerMemory;
const layerTest = ThreadManagementService.layer.pipe(
  Layer.provideMerge(
    Layer.mergeAll(
      layerDatabase,
      ProviderReplayHarness.layerWithRegistry(
        { name: "thread-issue-link" },
        ProviderAdapterRegistry.layerFromAdapters([adapter]),
        { databaseLayer: layerDatabase, runEffectWorker: false },
      ),
    ),
  ),
);

const issue = {
  host: "github.com",
  repository: "artic0din/t3code",
  number: 14,
  url: "https://github.com/artic0din/t3code/issues/14",
  title: "Persist issue links",
  availability: "open" as const,
};

const create = (threadId: ThreadId, linkedIssue?: typeof issue) =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    yield* orchestrator.dispatch({
      type: "thread.create",
      commandId: CommandId.make(`create:${threadId}`),
      threadId,
      projectId: ProjectId.make("project:issue-link"),
      title: threadId,
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      ...(linkedIssue === undefined ? {} : { linkedIssue }),
      createdBy: "user",
      creationSource: "web",
    });
  });

it.effect("persists an issue from thread creation and ignores a repeated link", () =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const threadId = ThreadId.make("thread:issue-create");
    yield* create(threadId, issue);
    const created = yield* orchestrator.getThreadProjection(threadId);
    assert.deepEqual(created.thread.linkedIssue, issue);

    yield* orchestrator.dispatch({
      type: "thread.issue.link",
      commandId: CommandId.make("link:repeat"),
      threadId,
      ...issue,
    });
    const after = yield* orchestrator.getThreadProjection(threadId);
    assert.deepEqual(after.thread.linkedIssue, issue);
  }).pipe(Effect.provide(layerTest)),
);

it.effect("relinks, keeps a stale unlink from clearing the new issue, and replays the link", () =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const threads = yield* ThreadManagementService.ThreadManagementService;
    const threadId = ThreadId.make("thread:issue-relink");
    const otherId = ThreadId.make("thread:issue-other-repo");
    yield* create(threadId);
    yield* create(otherId);
    yield* orchestrator.dispatch({
      type: "thread.issue.link",
      commandId: CommandId.make("link:first"),
      threadId,
      ...issue,
    });
    const replacement = {
      ...issue,
      repository: "other/repo",
      url: "https://github.com/other/repo/issues/14",
      title: "Same number",
    };
    yield* orchestrator.dispatch({
      type: "thread.issue.link",
      commandId: CommandId.make("link:relink"),
      threadId,
      ...replacement,
    });
    yield* orchestrator.dispatch({
      type: "thread.issue.link",
      commandId: CommandId.make("link:other"),
      threadId: otherId,
      ...issue,
      host: "github.example.com",
      url: "https://github.example.com/artic0din/t3code/issues/14",
    });
    yield* orchestrator.dispatch({
      type: "thread.issue.unlink",
      commandId: CommandId.make("unlink:stale"),
      threadId,
      host: issue.host,
      repository: issue.repository,
      number: issue.number,
    });
    const relinked = yield* orchestrator.getThreadProjection(threadId);
    assert.deepEqual(relinked.thread.linkedIssue, replacement);
    const other = yield* orchestrator.getThreadProjection(otherId);
    assert.equal(other.thread.linkedIssue?.host, "github.example.com");

    yield* orchestrator.dispatch({
      type: "thread.issue.unlink",
      commandId: CommandId.make("unlink:current"),
      threadId,
      host: replacement.host,
      repository: replacement.repository,
      number: replacement.number,
    });
    const unlinked = yield* orchestrator.getThreadProjection(threadId);
    assert.equal(unlinked.thread.linkedIssue, null);

    const shell = yield* threads.getThreadShell(otherId);
    assert.equal(shell?.linkedIssue?.host, "github.example.com");
  }).pipe(Effect.provide(layerTest)),
);
