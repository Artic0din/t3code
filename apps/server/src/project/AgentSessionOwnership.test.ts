import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import {
  AgentSessionImportInput,
  AuthOrchestrationOperateScope,
  EventId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  WsRpcGroup,
  WS_METHODS,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as RpcTest from "effect/rpc/RpcTest";
import * as TestClock from "effect/testing/TestClock";

import * as ServerConfig from "../config.ts";
import * as RpcAuthorization from "../auth/RpcAuthorization.ts";
import * as EventSink from "../orchestration-v2/EventSink.ts";
import * as IdAllocator from "../orchestration-v2/IdAllocator.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as RuntimeLayer from "../orchestration-v2/runtimeLayer.ts";
import * as ProviderSessionRuntime from "../persistence/ProviderSessionRuntime.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as AgentSessionImporter from "./AgentSessionImporter.ts";
import * as AgentSessionScanner from "./AgentSessionScanner.ts";
import * as ProjectService from "./ProjectService.ts";

const nowMs = Date.parse("2026-10-13T00:00:00.000Z");
const projectId = ProjectId.make("ownership-project");
const sessionId = "37b9d43f-5efe-4a9a-8590-8b3906d4c908";
const importGroup = WsRpcGroup.omit(
  ...[...WsRpcGroup.requests.keys()].filter(
    (
      tag,
    ): tag is Exclude<
      keyof typeof RpcAuthorization.RPC_REQUIRED_SCOPES,
      typeof WS_METHODS.agentSessionsImport
    > => tag !== WS_METHODS.agentSessionsImport,
  ),
);
const importClient = Effect.gen(function* () {
  const importer = yield* AgentSessionImporter.AgentSessionImporter;
  return yield* RpcTest.makeClient(importGroup).pipe(
    Effect.provide(
      Layer.mergeAll(
        importGroup.toLayerHandler(
          WS_METHODS.agentSessionsImport,
          importer.importRecentAgentThreads,
        ),
        RpcAuthorization.layer([AuthOrchestrationOperateScope]),
      ),
    ),
  );
});

const fixture = Effect.fn("AgentSessionOwnership.fixture")(function* (
  source: "codex" | "claudeAgent",
  secondHome?: "shared" | "distinct" | "shared-disabled",
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const home = yield* fs.makeTempDirectoryScoped({ prefix: "t3-ownership-home-" });
  const workspace = yield* fs.makeTempDirectoryScoped({ prefix: "t3-ownership-project-" });
  const filePath =
    source === "codex"
      ? path.join(home, "sessions", "2026", "10", "13", "rollout-session.jsonl")
      : path.join(home, "projects", "project", `${sessionId}.jsonl`);
  yield* fs.makeDirectory(path.dirname(filePath), { recursive: true });
  const record =
    source === "codex"
      ? {
          type: "session_meta",
          timestamp: DateTime.formatIso(DateTime.makeUnsafe(nowMs)),
          payload: { id: sessionId, cwd: workspace },
        }
      : {
          type: "user",
          timestamp: DateTime.formatIso(DateTime.makeUnsafe(nowMs)),
          sessionId,
          cwd: workspace,
          message: { role: "user", content: "External prompt" },
        };
  yield* fs.writeFileString(
    filePath,
    `${JSON.stringify(record)}\n${JSON.stringify({ type: "event_msg", payload: { type: "user_message", message: "External prompt" } })}\n`,
  );
  yield* fs.utimes(filePath, nowMs / 1000, nowMs / 1000);
  const otherInstanceId = ProviderInstanceId.make(`${source}-other`);
  const otherHome =
    secondHome === "distinct"
      ? yield* fs.makeTempDirectoryScoped({ prefix: "t3-ownership-other-home-" })
      : home;
  if (secondHome === "distinct") {
    const otherFilePath = path.join(otherHome, path.relative(home, filePath));
    yield* fs.makeDirectory(path.dirname(otherFilePath), { recursive: true });
    yield* fs.copyFile(filePath, otherFilePath);
    yield* fs.utimes(otherFilePath, nowMs / 1000, nowMs / 1000);
  }
  const projectionLayer = ProjectionStore.layer;
  const layer = AgentSessionImporter.layer.pipe(
    Layer.provideMerge(AgentSessionScanner.layer),
    Layer.provideMerge(
      Layer.mergeAll(
        projectionLayer,
        RuntimeLayer.layerEventSink,
        IdAllocator.layer,
        ProviderSessionRuntime.layer,
        Layer.unwrap(
          Effect.gen(function* () {
            const projections = yield* ProjectionStore.ProjectionStoreV2;
            return Layer.mock(Orchestrator.OrchestratorV2)({
              getThreadRecords: (threadId, fields) =>
                projections
                  .getThreadRecords(threadId, fields)
                  .pipe(
                    Effect.mapError(
                      (cause) => new Orchestrator.OrchestratorProjectionError({ threadId, cause }),
                    ),
                  ),
            });
          }),
        ).pipe(Layer.provide(projectionLayer)),
        Layer.mock(ProjectService.ProjectService)({
          getById: () =>
            Effect.succeed(Option.some({ id: projectId, workspaceRoot: workspace } as never)),
        }),
        Layer.mock(ProjectStore.ProjectStoreV2)({
          listShells: () => Effect.succeed([{ id: projectId, workspaceRoot: workspace } as never]),
        }),
      ),
    ),
    Layer.provide(SqlitePersistence.layerMemory),
    Layer.provideMerge(
      ServerSettings.layerTest({
        providers: { codex: { homePath: home }, claudeAgent: { homePath: home } },
        ...(secondHome === undefined
          ? {}
          : {
              providerInstances: {
                [source]: { driver: ProviderDriverKind.make(source), config: { homePath: home } },
                [otherInstanceId]: {
                  driver: ProviderDriverKind.make(source),
                  config: { homePath: otherHome },
                  ...(secondHome === "shared-disabled" ? { enabled: false } : {}),
                },
              },
            }),
      }),
    ),
    Layer.provideMerge(ServerConfig.layerTest(workspace, { prefix: "t3-ownership-config-" })),
  );
  return {
    layer,
    workspace,
    filePath,
    otherInstanceId,
    providerInstanceId: ProviderInstanceId.make(source),
  };
});

const persistNativeOwner = Effect.fn("AgentSessionOwnership.persistNativeOwner")(function* (
  source: "codex" | "claudeAgent",
  providerInstanceId: ProviderInstanceId,
  location: "active" | "archived" | "deleted" = "active",
  historyOrigin: "native" | "v1_import" = "native",
  existingThreadId?: ThreadId,
  nativeSessionId: string = sessionId,
) {
  const sink = yield* EventSink.EventSinkV2;
  const ids = yield* IdAllocator.IdAllocatorV2;
  const now = DateTime.makeUnsafe(nowMs);
  const threadId = existingThreadId ?? ThreadId.make(`native-t3:${providerInstanceId}`);
  const driver = ProviderDriverKind.make(source);
  const providerThreadId = ids.derive.providerThread({
    driver,
    providerInstanceId,
    nativeThreadId: nativeSessionId,
  });
  yield* sink.write({
    events: [
      {
        id: EventId.make(`${threadId}:created`),
        type: "thread.created",
        threadId,
        occurredAt: now,
        payload: {
          createdBy: "user",
          creationSource: "web",
          id: threadId,
          projectId,
          title: "Native T3 session",
          providerInstanceId,
          modelSelection: { instanceId: providerInstanceId, model: "model" },
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          activeProviderThreadId: providerThreadId,
          historyOrigin,
          lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
          forkedFrom: null,
          createdAt: now,
          updatedAt: now,
          archivedAt: location === "archived" ? now : null,
          settledOverride: null,
          settledAt: null,
          lastVisitedAt: null,
          deletedAt: location === "deleted" ? now : null,
        },
      },
      {
        id: EventId.make(`${threadId}:provider`),
        type: "provider-thread.updated",
        threadId,
        occurredAt: now,
        payload: {
          id: providerThreadId,
          driver,
          providerInstanceId,
          providerSessionId: null,
          appThreadId: threadId,
          ownerNodeId: null,
          nativeThreadRef: { driver, nativeId: nativeSessionId, strength: "strong" },
          nativeConversationHeadRef: null,
          status: "idle",
          firstRunOrdinal: null,
          lastRunOrdinal: null,
          handoffIds: [],
          forkedFrom: null,
          createdAt: now,
          updatedAt: now,
        },
      },
    ],
  });
  return threadId;
});

it.layer(NodeServices.layer)("persisted external session ownership", (it) => {
  it.effect.each(["Importable", "AlreadyImported"] as const)(
    "does not count a deleted imported session as success through %s",
    (outcome) =>
      Effect.gen(function* () {
        yield* TestClock.setTime(nowMs);
        const { layer, workspace, filePath, providerInstanceId } = yield* fixture("codex");
        yield* Effect.gen(function* () {
          const importer = yield* AgentSessionImporter.AgentSessionImporter;
          const scanner = yield* AgentSessionScanner.AgentSessionScanner;
          const sink = yield* EventSink.EventSinkV2;
          const projections = yield* ProjectionStore.ProjectionStoreV2;
          const input: AgentSessionImportInput = {
            projectId,
            expectedWorkspaceRoot: workspace,
            providerInstanceId,
            providerSessionId: sessionId,
          };
          expect(yield* importer.importRecentAgentThreads(input)).toEqual({
            importedCount: 1,
            skippedCount: 0,
          });
          const threadId = ThreadId.make(`import:${providerInstanceId}:${sessionId}`);
          const before = yield* projections.getThreadRecords(threadId, ["providerThreads"]);
          yield* sink.write({
            events: [
              {
                id: EventId.make("delete-import"),
                type: "thread.deleted",
                threadId,
                occurredAt: DateTime.makeUnsafe(nowMs),
                payload: { ...before.thread, deletedAt: DateTime.makeUnsafe(nowMs) },
              },
            ],
          });
          if (outcome === "Importable") {
            const fs = yield* FileSystem.FileSystem;
            yield* fs.utimes(filePath, (nowMs - 1000) / 1000, (nowMs - 1000) / 1000);
          }
          const result = yield* importer.importRecentAgentThreads(input);
          expect(result).toEqual({ importedCount: 0, skippedCount: 1 });
          const client = yield* importClient;
          expect(yield* client[WS_METHODS.agentSessionsImport](input)).toEqual(result);
          expect((yield* projections.getThread(threadId)).deletedAt).not.toBeNull();
          expect(
            (yield* projections.getThreadRecords(threadId, ["providerThreads"])).providerThreads,
          ).toEqual(before.providerThreads);
          const scan = yield* scanner.scan;
          expect(scan.sessions?.[0]).toMatchObject({
            providerSessionId: sessionId,
            importedThreadDeleted: true,
          });
        }).pipe(Effect.provide(layer));
      }),
  );

  it.effect.each(["codex", "claudeAgent"] as const)(
    "excludes T3-owned %s sessions and rejects stale Import actions",
    (source) =>
      Effect.gen(function* () {
        yield* TestClock.setTime(nowMs);
        const { layer, providerInstanceId, workspace } = yield* fixture(source);
        yield* Effect.gen(function* () {
          const scanner = yield* AgentSessionScanner.AgentSessionScanner;
          const importer = yield* AgentSessionImporter.AgentSessionImporter;
          const projections = yield* ProjectionStore.ProjectionStoreV2;
          const initial = yield* scanner.scan;
          expect(initial.sessions).toHaveLength(1);
          const nativeId = yield* persistNativeOwner(source, providerInstanceId);
          expect((yield* scanner.scan).sessions).toEqual([]);
          const staleInput = {
            projectId,
            expectedWorkspaceRoot: workspace,
            providerInstanceId,
            providerSessionId: sessionId,
          };
          expect(yield* importer.importRecentAgentThreads(staleInput)).toEqual({
            importedCount: 0,
            skippedCount: 1,
          });
          const client = yield* importClient;
          expect(yield* client[WS_METHODS.agentSessionsImport](staleInput)).toEqual({
            importedCount: 0,
            skippedCount: 1,
          });
          expect(
            (yield* projections.getThreadRecords(nativeId, ["providerThreads"])).providerThreads[0]
              ?.appThreadId,
          ).toBe(nativeId);
          expect(
            yield* projections
              .getThread(ThreadId.make(`import:${providerInstanceId}:${sessionId}`))
              .pipe(Effect.result),
          ).toMatchObject({ _tag: "Failure" });
        }).pipe(Effect.provide(layer));
      }),
  );
  it.effect.each(["codex", "claudeAgent"] as const)(
    "preserves the same %s session ID in a distinct configured home",
    (source) =>
      Effect.gen(function* () {
        yield* TestClock.setTime(nowMs);
        const { layer, providerInstanceId, otherInstanceId, workspace } = yield* fixture(
          source,
          "distinct",
        );
        yield* Effect.gen(function* () {
          const scanner = yield* AgentSessionScanner.AgentSessionScanner;
          const importer = yield* AgentSessionImporter.AgentSessionImporter;
          yield* persistNativeOwner(source, providerInstanceId);
          const result = yield* scanner.scan;
          expect(result.sessions?.map((session) => session.providerInstanceId)).toEqual([
            otherInstanceId,
          ]);
          expect(
            yield* importer.importRecentAgentThreads({
              projectId,
              expectedWorkspaceRoot: workspace,
              providerInstanceId: otherInstanceId,
              providerSessionId: sessionId,
            }),
          ).toEqual({ importedCount: 1, skippedCount: 0 });
          const projections = yield* ProjectionStore.ProjectionStoreV2;
          const native = yield* projections.getThreadRecords(
            ThreadId.make(`native-t3:${providerInstanceId}`),
            ["providerThreads"],
          );
          const imported = yield* projections.getThreadRecords(
            ThreadId.make(`import:${otherInstanceId}:${sessionId}`),
            ["providerThreads"],
          );
          expect(native.providerThreads[0]?.providerInstanceId).toBe(providerInstanceId);
          expect(imported.providerThreads[0]?.providerInstanceId).toBe(otherInstanceId);
          expect(imported.providerThreads[0]?.id).not.toBe(native.providerThreads[0]?.id);
        }).pipe(Effect.provide(layer));
      }),
  );
  it.effect.each(["archived", "deleted"] as const)(
    "keeps %s native sessions owned by T3 out of the activity list",
    (location) =>
      Effect.gen(function* () {
        yield* TestClock.setTime(nowMs);
        const { layer, providerInstanceId } = yield* fixture("codex");
        yield* Effect.gen(function* () {
          yield* persistNativeOwner("codex", providerInstanceId, location);
          const scanner = yield* AgentSessionScanner.AgentSessionScanner;
          expect((yield* scanner.scan).sessions).toEqual([]);
        }).pipe(Effect.provide(layer));
      }),
  );
  it.effect("recognizes a native owner through an alias of the same configured home", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(nowMs);
      const { layer, otherInstanceId } = yield* fixture("codex", "shared");
      yield* Effect.gen(function* () {
        yield* persistNativeOwner("codex", otherInstanceId);
        const scanner = yield* AgentSessionScanner.AgentSessionScanner;
        expect((yield* scanner.scan).sessions).toEqual([]);
        const importer = yield* AgentSessionImporter.AgentSessionImporter;
        expect(yield* importer.importRecentAgentThreads({ projectId })).toEqual({
          importedCount: 0,
          skippedCount: 1,
        });
      }).pipe(Effect.provide(layer));
    }),
  );
  it.effect.each(["migrated-or-forked", "provider-switched"] as const)(
    "excludes a native binding on a %s thread with v1_import history",
    (kind) =>
      Effect.gen(function* () {
        yield* TestClock.setTime(nowMs);
        const { layer, providerInstanceId } = yield* fixture("codex");
        yield* Effect.gen(function* () {
          const ownerId =
            kind === "provider-switched"
              ? ThreadId.make(`import:${providerInstanceId}:previous-native-session`)
              : undefined;
          yield* persistNativeOwner("codex", providerInstanceId, "active", "v1_import", ownerId);
          const scanner = yield* AgentSessionScanner.AgentSessionScanner;
          expect((yield* scanner.scan).sessions).toEqual([]);
          const importer = yield* AgentSessionImporter.AgentSessionImporter;
          expect(yield* importer.importRecentAgentThreads({ projectId })).toEqual({
            importedCount: 0,
            skippedCount: 1,
          });
        }).pipe(Effect.provide(layer));
      }),
  );
  it.effect("recognizes ownership from a disabled instance sharing an enabled home", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(nowMs);
      const { layer, otherInstanceId } = yield* fixture("codex", "shared-disabled");
      yield* Effect.gen(function* () {
        yield* persistNativeOwner("codex", otherInstanceId);
        const scanner = yield* AgentSessionScanner.AgentSessionScanner;
        expect((yield* scanner.scan).sessions).toEqual([]);
        const importer = yield* AgentSessionImporter.AgentSessionImporter;
        expect(yield* importer.importRecentAgentThreads({ projectId })).toEqual({
          importedCount: 0,
          skippedCount: 1,
        });
      }).pipe(Effect.provide(layer));
    }),
  );
  it.effect.each(["codex", "claudeAgent"] as const)(
    "recomputes %s import ownership after a new shared-home instance is configured",
    (source) =>
      Effect.gen(function* () {
        yield* TestClock.setTime(nowMs);
        const { layer, otherInstanceId, providerInstanceId, workspace } = yield* fixture(source);
        yield* Effect.gen(function* () {
          const scanner = yield* AgentSessionScanner.AgentSessionScanner;
          expect(
            (yield* scanner.scan).sessions?.map((session) => session.providerInstanceId),
          ).toEqual([providerInstanceId]);
          const settings = yield* ServerSettings.ServerSettingsService;
          const previous = yield* settings.getSettings;
          yield* settings.updateSettings({
            providerInstances: {
              ...previous.providerInstances,
              [otherInstanceId]: {
                driver: ProviderDriverKind.make(source),
                config: previous.providers[source],
              },
            },
          });
          const nativeId = yield* persistNativeOwner(source, otherInstanceId);
          const refreshScanner = yield* AgentSessionScanner.make;
          expect((yield* refreshScanner.scan).sessions).toEqual([]);
          const input = {
            projectId,
            expectedWorkspaceRoot: workspace,
            providerInstanceId,
            providerSessionId: sessionId,
          };
          const importer = yield* AgentSessionImporter.AgentSessionImporter;
          expect(yield* importer.importRecentAgentThreads(input)).toEqual({
            importedCount: 0,
            skippedCount: 1,
          });
          const client = yield* importClient;
          expect(yield* client[WS_METHODS.agentSessionsImport](input)).toEqual({
            importedCount: 0,
            skippedCount: 1,
          });
          const projections = yield* ProjectionStore.ProjectionStoreV2;
          expect(
            (yield* projections.getShellSnapshot()).threads.map((thread) => thread.id),
          ).toEqual([nativeId]);
        }).pipe(Effect.provide(layer));
      }),
  );
  it.effect.each(["unchanged", "updated"] as const)(
    "reconciles the preserved instance before selecting an %s imported transcript",
    (transcriptState) =>
      Effect.gen(function* () {
        yield* TestClock.setTime(nowMs);
        const { layer, providerInstanceId, workspace, filePath } = yield* fixture(
          "codex",
          "shared",
        );
        yield* Effect.gen(function* () {
          const importer = yield* AgentSessionImporter.AgentSessionImporter;
          expect(yield* importer.importRecentAgentThreads({ projectId })).toEqual({
            importedCount: 1,
            skippedCount: 0,
          });
          const settings = yield* ServerSettings.ServerSettingsService;
          const previous = yield* settings.getSettings;
          yield* settings.updateSettings({
            providerInstances: {
              ...previous.providerInstances,
              [providerInstanceId]: {
                ...previous.providerInstances[providerInstanceId]!,
                enabled: false,
              },
            },
          });
          const scanner = yield* AgentSessionScanner.AgentSessionScanner;
          expect(
            (yield* scanner.scan).sessions?.map((session) => session.providerInstanceId),
          ).toEqual([providerInstanceId]);
          if (transcriptState === "updated") {
            const fs = yield* FileSystem.FileSystem;
            yield* fs.utimes(filePath, (nowMs - 1000) / 1000, (nowMs - 1000) / 1000);
          }
          const input = {
            projectId,
            expectedWorkspaceRoot: workspace,
            providerInstanceId,
            providerSessionId: sessionId,
          };
          expect(yield* importer.importRecentAgentThreads(input)).toEqual({
            importedCount: 1,
            skippedCount: 0,
          });
          const client = yield* importClient;
          expect(yield* client[WS_METHODS.agentSessionsImport](input)).toEqual({
            importedCount: 1,
            skippedCount: 0,
          });
          const projections = yield* ProjectionStore.ProjectionStoreV2;
          expect(
            (yield* projections.getShellSnapshot()).threads.map((thread) => thread.id),
          ).toEqual([`import:${providerInstanceId}:${sessionId}`]);
        }).pipe(Effect.provide(layer));
      }),
  );
  it.effect("checks the completed source against an exact session selector", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(nowMs);
      const { layer, filePath, workspace, providerInstanceId } = yield* fixture("codex");
      const fs = yield* FileSystem.FileSystem;
      const contents = yield* fs.readFileString(filePath);
      yield* fs.writeFileString(
        filePath,
        `${JSON.stringify({ cwd: workspace })}\n${"{}\n".repeat(1000)}${contents}`,
      );
      yield* fs.utimes(filePath, nowMs / 1000, nowMs / 1000);
      yield* Effect.gen(function* () {
        const importer = yield* AgentSessionImporter.AgentSessionImporter;
        expect(yield* importer.importRecentAgentThreads({ projectId })).toEqual({
          importedCount: 1,
          skippedCount: 0,
        });
        const input = {
          projectId,
          expectedWorkspaceRoot: workspace,
          providerInstanceId,
          providerSessionId: "another-session",
        };
        expect(yield* importer.importRecentAgentThreads(input)).toEqual({
          importedCount: 0,
          skippedCount: 0,
        });
        const client = yield* importClient;
        expect(yield* client[WS_METHODS.agentSessionsImport](input)).toEqual({
          importedCount: 0,
          skippedCount: 0,
        });
        const projections = yield* ProjectionStore.ProjectionStoreV2;
        expect((yield* projections.getShellSnapshot()).threads.map((thread) => thread.id)).toEqual([
          `import:${providerInstanceId}:${sessionId}`,
        ]);
      }).pipe(Effect.provide(layer));
    }),
  );
  it.effect("rechecks a replaced transcript against native home-alias ownership", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(nowMs);
      const { layer, otherInstanceId, filePath } = yield* fixture("codex", "shared");
      yield* Effect.gen(function* () {
        const scanner = yield* AgentSessionScanner.AgentSessionScanner;
        expect((yield* scanner.scan).sessions?.[0]?.providerSessionId).toBe(sessionId);
        const replacementId = "cd1e31f4-2784-4486-9d0b-e1d0fcc5ad31";
        yield* persistNativeOwner(
          "codex",
          otherInstanceId,
          "active",
          "native",
          undefined,
          replacementId,
        );
        const fs = yield* FileSystem.FileSystem;
        const contents = yield* fs.readFileString(filePath);
        yield* fs.writeFileString(filePath, contents.replaceAll(sessionId, replacementId));
        yield* fs.utimes(filePath, (nowMs - 1000) / 1000, (nowMs - 1000) / 1000);
        const importer = yield* AgentSessionImporter.AgentSessionImporter;
        expect(yield* importer.importRecentAgentThreads({ projectId })).toEqual({
          importedCount: 0,
          skippedCount: 1,
        });
        const client = yield* importClient;
        expect(yield* client[WS_METHODS.agentSessionsImport]({ projectId })).toEqual({
          importedCount: 0,
          skippedCount: 1,
        });
      }).pipe(Effect.provide(layer));
    }),
  );
  it.effect(
    "keeps a deleted import unavailable after its shared home's canonical instance changes",
    () =>
      Effect.gen(function* () {
        yield* TestClock.setTime(nowMs);
        const { layer, providerInstanceId, otherInstanceId, workspace } = yield* fixture(
          "codex",
          "shared",
        );
        yield* Effect.gen(function* () {
          const importer = yield* AgentSessionImporter.AgentSessionImporter;
          expect(yield* importer.importRecentAgentThreads({ projectId })).toEqual({
            importedCount: 1,
            skippedCount: 0,
          });
          const threadId = ThreadId.make(`import:${providerInstanceId}:${sessionId}`);
          const projections = yield* ProjectionStore.ProjectionStoreV2;
          const thread = yield* projections.getThread(threadId);
          const sink = yield* EventSink.EventSinkV2;
          const now = DateTime.makeUnsafe(nowMs);
          yield* sink.write({
            events: [
              {
                id: EventId.make("alias-delete"),
                type: "thread.deleted",
                threadId,
                occurredAt: now,
                payload: { ...thread, deletedAt: now },
              },
            ],
          });
          const settings = yield* ServerSettings.ServerSettingsService;
          const previous = yield* settings.getSettings;
          yield* settings.updateSettings({
            providerInstances: {
              ...previous.providerInstances,
              [providerInstanceId]: {
                ...previous.providerInstances[providerInstanceId]!,
                enabled: false,
              },
            },
          });
          const scanner = yield* AgentSessionScanner.AgentSessionScanner;
          expect((yield* scanner.scan).sessions?.[0]).toMatchObject({
            providerInstanceId: otherInstanceId,
            importedThreadDeleted: true,
          });
          const input = {
            projectId,
            expectedWorkspaceRoot: workspace,
            providerInstanceId: otherInstanceId,
            providerSessionId: sessionId,
          };
          expect(yield* importer.importRecentAgentThreads(input)).toEqual({
            importedCount: 0,
            skippedCount: 1,
          });
          const client = yield* importClient;
          expect(yield* client[WS_METHODS.agentSessionsImport](input)).toEqual({
            importedCount: 0,
            skippedCount: 1,
          });
          expect((yield* projections.getThread(threadId)).deletedAt).not.toBeNull();
        }).pipe(Effect.provide(layer));
      }),
  );
  it.effect(
    "keeps an active import's identity when its shared home's canonical instance changes",
    () =>
      Effect.gen(function* () {
        yield* TestClock.setTime(nowMs);
        const { layer, providerInstanceId } = yield* fixture("codex", "shared");
        yield* Effect.gen(function* () {
          const importer = yield* AgentSessionImporter.AgentSessionImporter;
          expect(yield* importer.importRecentAgentThreads({ projectId })).toEqual({
            importedCount: 1,
            skippedCount: 0,
          });
          const settings = yield* ServerSettings.ServerSettingsService;
          const previous = yield* settings.getSettings;
          yield* settings.updateSettings({
            providerInstances: {
              ...previous.providerInstances,
              [providerInstanceId]: {
                ...previous.providerInstances[providerInstanceId]!,
                enabled: false,
              },
            },
          });
          const scanner = yield* AgentSessionScanner.AgentSessionScanner;
          expect((yield* scanner.scan).sessions?.[0]?.providerInstanceId).toBe(providerInstanceId);
          expect(yield* importer.importRecentAgentThreads({ projectId })).toEqual({
            importedCount: 1,
            skippedCount: 0,
          });
          const projections = yield* ProjectionStore.ProjectionStoreV2;
          expect(
            (yield* projections.getShellSnapshot()).threads.map((thread) => thread.id),
          ).toEqual([`import:${providerInstanceId}:${sessionId}`]);
        }).pipe(Effect.provide(layer));
      }),
  );
});
