import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  CommandId,
  EnvironmentId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Crypto from "effect/Crypto";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import { HttpClient } from "effect/http";
import { ChildProcessSpawner } from "effect/process";
import { HostProcessEnvironment, HostProcessWorkingDirectory } from "@t3tools/shared/hostProcess";

import * as SqlitePersistence from "../persistence/Sqlite.ts";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import * as Orchestrator from "./Orchestrator.ts";
import type { ProviderAdapterV2Shape } from "./ProviderAdapter.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import * as ThreadManagementService from "./ThreadManagementService.ts";
import * as ThreadIssueService from "./ThreadIssueService.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as GitWorkflow from "../git/GitWorkflowService.ts";
import * as GitManager from "../git/GitManager.ts";
import * as GitHubApi from "../sourceControl/GitHubApi.ts";
import * as GitHubCli from "../sourceControl/GitHubCli.ts";
import * as GitHubCredentials from "../sourceControl/GitHubCredentials.ts";
import * as GitHubGraphQlBudget from "../sourceControl/githubGraphQlBudget.ts";
import * as GitHubSourceControlProvider from "../sourceControl/GitHubSourceControlProvider.ts";
import * as SourceControlProviderRegistry from "../sourceControl/SourceControlProviderRegistry.ts";
import * as SourceControlRateLimit from "../sourceControl/SourceControlRateLimit.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as TextGeneration from "../textGeneration/TextGeneration.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as ProjectSetupScriptRunner from "../project/ProjectSetupScriptRunner.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ProjectStore from "./ProjectStore.ts";
import type { McpInvocationScope } from "../mcp/McpInvocationContext.ts";
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

const create = (
  threadId: ThreadId,
  linkedIssue?: typeof issue,
  worktreePath: string | null = null,
) =>
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
      worktreePath,
      ...(linkedIssue === undefined ? {} : { linkedIssue }),
      createdBy: "user",
      creationSource: "web",
    });
  });

it.effect("preserves pull-request sync events when issue commands are added", () =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const threadId = ThreadId.make("thread:pr-events");
    yield* create(threadId);
    const linked = yield* orchestrator.dispatch({
      type: "thread.pull-request.link",
      commandId: CommandId.make("pr:link"),
      threadId,
      host: "github.com",
      repository: "acme/web",
      number: 12,
      url: "https://github.com/acme/web/pull/12",
      source: "manual",
    });
    assert.equal(linked.storedEvents.at(-1)?.event.type, "thread.pull-request-synced");
    const unlinked = yield* orchestrator.dispatch({
      type: "thread.pull-request.unlink",
      commandId: CommandId.make("pr:unlink"),
      threadId,
      host: "github.com",
      repository: "acme/web",
      number: 12,
    });
    assert.equal(unlinked.storedEvents.at(-1)?.event.type, "thread.pull-request-synced");
  }).pipe(Effect.provide(layerTest)),
);

const scope: McpInvocationScope = {
  environmentId: EnvironmentId.make("env-test"),
  capabilities: new Set(["orchestration"]),
  issuedAt: 0,
  requestNamespace: "issue-test",
  thread: undefined,
  client: undefined,
};
const layerIssue = ThreadIssueService.layer.pipe(
  Layer.provideMerge(
    Layer.mergeAll(
      layerTest,
      Layer.mock(ProjectService.ProjectService)({ getById: () => Effect.succeed(Option.none()) }),
      Layer.mock(GitWorkflow.GitWorkflowService)({
        resolveIssue: () =>
          Effect.succeed({
            issue: {
              number: issue.number,
              title: issue.title,
              body: null,
              url: issue.url,
              state: "open" as const,
            },
          }),
      }),
      Layer.succeed(
        Crypto.Crypto,
        Crypto.make({
          randomBytes: (size) => new Uint8Array(size).fill(1),
          digest: (_algorithm, data) => Effect.succeed(data),
        }),
      ),
    ),
  ),
);

const makeCredentialBoundaryHarness = Effect.gen(function* () {
  const credentialHosts: string[] = [];
  const authTokenCalls: ReadonlyArray<string>[] = [];
  const httpRequests: string[] = [];
  const base = Layer.mergeAll(
    NodeServices.layer,
    ServerSettings.ServerSettingsService.layerTest(),
    Layer.succeed(HostProcessEnvironment, {
      GH_HOST: "enterprise.example",
      GH_ENTERPRISE_TOKEN: "synthetic-enterprise-token",
    }),
    Layer.succeed(HostProcessWorkingDirectory, "/workspace"),
    Layer.mock(GitVcsDriver.GitVcsDriver)({}),
    Layer.mock(VcsProcess.VcsProcess)({
      run: (input) =>
        Effect.sync(() => {
          assert.equal(input.command, "gh");
          assert.deepEqual(input.args.slice(0, 2), ["auth", "token"]);
          authTokenCalls.push(input.args);
          return {
            exitCode: ChildProcessSpawner.ExitCode(0),
            stdout: "",
            stderr: "",
            stdoutTruncated: false,
            stderrTruncated: false,
          };
        }),
    }),
    Layer.succeed(
      HttpClient.HttpClient,
      HttpClient.make((request) => {
        httpRequests.push(request.url);
        return Effect.die("Issue URL rejection must not send an HTTP request");
      }),
    ),
  );
  const credentials = Layer.effect(
    GitHubCredentials.GitHubCredentials,
    GitHubCredentials.make.pipe(
      Effect.map((service) => ({
        ...service,
        get: (host: string) =>
          Effect.sync(() => credentialHosts.push(host)).pipe(Effect.andThen(service.get(host))),
      })),
    ),
  ).pipe(Layer.provide(base));
  const api = GitHubApi.layer.pipe(
    Layer.provide(credentials),
    Layer.provide(GitHubGraphQlBudget.layer),
    Layer.provide(SourceControlRateLimit.layer),
    Layer.provide(base),
  );
  const github = Layer.effect(GitHubCli.GitHubCli, GitHubCli.make).pipe(
    Layer.provideMerge(api),
    Layer.provide(base),
  );
  const registry = Layer.effect(
    SourceControlProviderRegistry.SourceControlProviderRegistry,
    GitHubSourceControlProvider.make.pipe(
      Effect.map((provider) =>
        SourceControlProviderRegistry.SourceControlProviderRegistry.of({
          resolveLink: (input) => provider.resolveLink?.(input),
          get: () => Effect.succeed(provider),
          resolveHandle: () => Effect.succeed({ provider, context: null }),
          resolve: () => Effect.succeed(provider),
          discover: Effect.succeed([]),
        }),
      ),
    ),
  ).pipe(Layer.provide(github));
  const manager = yield* GitManager.make.pipe(
    Effect.provide(
      Layer.mergeAll(
        base,
        registry,
        Layer.mock(TextGeneration.TextGeneration)({}),
        Layer.mock(ProviderRegistry.ProviderRegistry)({}),
        Layer.mock(ProjectSetupScriptRunner.ProjectSetupScriptRunner)({}),
        Layer.mock(ProjectionStore.ProjectionStoreV2)({}),
        Layer.mock(ProjectStore.ProjectStoreV2)({}),
      ),
    ),
  );
  return { manager, credentialHosts, authTokenCalls, httpRequests };
});

it.effect(
  "never looks up credentials for arbitrary issue URLs, including retries of saved links",
  () =>
    Effect.gen(function* () {
      const { manager, credentialHosts, authTokenCalls, httpRequests } =
        yield* makeCredentialBoundaryHarness;
      const reference = "https://attacker.example/acme/web/issues/12";
      const unavailable = {
        host: "attacker.example",
        repository: "acme/web",
        number: 12,
        url: reference,
        title: null,
        availability: "inaccessible" as const,
      };
      yield* Effect.gen(function* () {
        const service = yield* ThreadIssueService.ThreadIssueService;
        const threads = yield* ThreadManagementService.ThreadManagementService;
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const threadId = ThreadId.make("thread:credential-boundary");
        yield* create(threadId, undefined, "/workspace");
        for (const clientRequestId of ["first", "retry"]) {
          const result = yield* service
            .link(scope, { threadId, reference, clientRequestId })
            .pipe(Effect.result);
          assert.deepEqual(credentialHosts, []);
          assert.deepEqual(authTokenCalls, []);
          assert.isTrue(Result.isFailure(result));
        }
        yield* orchestrator.dispatch({
          type: "thread.issue.link",
          commandId: CommandId.make("seed:unavailable-host"),
          threadId,
          ...unavailable,
        });
        assert.deepEqual((yield* service.related(scope, { threadId })).linkedIssue, unavailable);
        assert.deepEqual((yield* threads.getThreadShell(threadId))?.linkedIssue, unavailable);
        yield* threads.getShellSnapshot();
        yield* orchestrator.dispatch({
          type: "thread.archive",
          commandId: CommandId.make("archive:unavailable-host"),
          threadId,
        });
        const archived = yield* threads.getShellSnapshot({ location: "archive" });
        assert.deepEqual(
          archived.archivedThreads.find((thread) => thread.id === threadId)?.linkedIssue,
          unavailable,
        );
        yield* orchestrator.dispatch({
          type: "thread.unarchive",
          commandId: CommandId.make("unarchive:unavailable-host"),
          threadId,
        });
        const retry = yield* service
          .link(scope, { threadId, reference, clientRequestId: "saved-retry" })
          .pipe(Effect.result);
        const lookup = yield* manager
          .resolveIssue({ cwd: "/workspace", reference })
          .pipe(Effect.result);
        assert.isTrue(Result.isFailure(retry));
        assert.isTrue(Result.isFailure(lookup));
        assert.deepEqual((yield* threads.getThreadShell(threadId))?.linkedIssue, unavailable);
        assert.isTrue((yield* service.unlink(scope, { threadId })).unlinked);
        assert.deepEqual(credentialHosts, []);
        assert.deepEqual(authTokenCalls, []);
        assert.deepEqual(httpRequests, []);
      }).pipe(
        Effect.provide(
          ThreadIssueService.layer.pipe(
            Layer.provideMerge(
              Layer.mergeAll(
                layerTest,
                NodeServices.layer,
                Layer.mock(ProjectService.ProjectService)({
                  getById: () => Effect.succeed(Option.none()),
                }),
                Layer.mock(GitWorkflow.GitWorkflowService)({ resolveIssue: manager.resolveIssue }),
              ),
            ),
          ),
        ),
      );
      yield* manager
        .resolveIssue({ cwd: "/workspace", reference: "https://github.com/acme/web/issues/12" })
        .pipe(Effect.result);
      assert.deepEqual(credentialHosts, ["github.com"]);
      assert.deepEqual(authTokenCalls, [["auth", "token", "--hostname", "github.com"]]);
    }),
);

it.effect("records an already-linked MCP request so retries cannot replace a later link", () =>
  Effect.gen(function* () {
    const service = yield* ThreadIssueService.ThreadIssueService;
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const threadId = ThreadId.make("thread:noop-link");
    yield* create(threadId, issue, "/workspace");
    yield* service.link(scope, { threadId, reference: issue.url, clientRequestId: "repeat" });
    const replacement = {
      ...issue,
      number: 15,
      url: "https://github.com/artic0din/t3code/issues/15",
    };
    yield* orchestrator.dispatch({
      type: "thread.issue.link",
      commandId: CommandId.make("replace:no-op-link"),
      threadId,
      ...replacement,
    });
    yield* service.link(scope, { threadId, reference: issue.url, clientRequestId: "repeat" });
    assert.deepEqual(
      (yield* orchestrator.getThreadProjection(threadId)).thread.linkedIssue,
      replacement,
    );
  }).pipe(Effect.provide(layerIssue)),
);

it.effect("records an already-unlinked MCP request so retries cannot clear a later link", () =>
  Effect.gen(function* () {
    const service = yield* ThreadIssueService.ThreadIssueService;
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const threadId = ThreadId.make("thread:noop-unlink");
    yield* create(threadId);
    assert.equal(
      (yield* service.unlink(scope, { threadId, clientRequestId: "repeat" })).unlinked,
      false,
    );
    yield* orchestrator.dispatch({
      type: "thread.issue.link",
      commandId: CommandId.make("replace:no-op-unlink"),
      threadId,
      ...issue,
    });
    assert.equal(
      (yield* service.unlink(scope, { threadId, clientRequestId: "repeat" })).unlinked,
      false,
    );
    assert.deepEqual((yield* orchestrator.getThreadProjection(threadId)).thread.linkedIssue, issue);
  }).pipe(Effect.provide(layerIssue)),
);

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
