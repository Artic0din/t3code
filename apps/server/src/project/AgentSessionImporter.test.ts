import { expect, it } from "@effect/vitest";
import {
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationV2DomainEvent,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";

import * as EventSink from "../orchestration-v2/EventSink.ts";
import * as IdAllocator from "../orchestration-v2/IdAllocator.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ProviderSessionRuntime from "../persistence/ProviderSessionRuntime.ts";
import * as AgentSessionImporter from "./AgentSessionImporter.ts";
import * as AgentSessionScanner from "./AgentSessionScanner.ts";
import * as ProjectService from "./ProjectService.ts";

const projectId = ProjectId.make("agent-session-import-project");
const providerInstanceId = ProviderInstanceId.make("codex");
const providerSessionId = "native-codex-thread";
const threadId = ThreadId.make(`import:${providerInstanceId}:${providerSessionId}`);

it.effect("imports messages once and preserves the provider native resume binding", () => {
  const writes: Array<ReadonlyArray<OrchestrationV2DomainEvent>> = [];
  const upserts: Array<unknown> = [];
  const recorded: Array<unknown> = [];
  const scans: Array<unknown> = [];
  let imported = false;
  const scanner = AgentSessionScanner.AgentSessionScanner.of({
    scan: Effect.die("unused"),
    recentThreads: (workspaceRoot, completedSources, sessionFilter) => {
      scans.push({ workspaceRoot, completedSources, sessionFilter });
      return Stream.succeed({
        _tag: "Importable",
        source: {
          provider: "codex",
          providerInstanceId,
          providerSessionId,
          filePath: "/tmp/native-codex-thread.jsonl",
          size: 100,
          mtimeMs: 2,
          device: 3,
          inode: 4,
          birthtimeMs: 1,
        },
        thread: {
          source: "codex",
          providerInstanceId,
          providerSessionId,
          title: "Imported thread",
          model: "gpt-5.4",
          createdAt: "2026-09-01T10:00:00.000Z",
          updatedAt: "2026-09-01T10:01:00.000Z",
          messages: [
            { role: "user", text: "Fix it", createdAt: "2026-09-01T10:00:00.000Z" },
            { role: "assistant", text: "Fixed", createdAt: "2026-09-01T10:01:00.000Z" },
          ],
        },
      });
    },
  });
  const layerTest = AgentSessionImporter.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.succeed(AgentSessionScanner.AgentSessionScanner, scanner),
        Layer.mock(ProjectService.ProjectService)({
          getById: () =>
            Effect.succeed(
              Option.some({ id: projectId, workspaceRoot: "/workspace/project" } as never),
            ),
        }),
        Layer.mock(Orchestrator.OrchestratorV2)({
          getThreadRecords: () =>
            imported
              ? Effect.succeed({
                  thread: { id: threadId, projectId, historyOrigin: "v1_import", deletedAt: null },
                } as never)
              : Effect.fail(new Orchestrator.OrchestratorProjectionError({ threadId })),
        }),
        Layer.mock(EventSink.EventSinkV2)({
          write: (input) =>
            Effect.sync(() => {
              writes.push(input.events);
              imported = true;
              return [];
            }),
        }),
        Layer.mock(ProviderSessionRuntime.ProviderSessionRuntimeRepository)({
          list: () => Effect.succeed([]),
          upsert: (input) => Effect.sync(() => void upserts.push(input)),
          recordImportedTranscript: (input) => Effect.sync(() => void recorded.push(input)),
        }),
        IdAllocator.layer,
        Layer.mock(ProjectionStore.ProjectionStoreV2)({
          getAgentSessionOwners: () => Effect.succeed([]),
        }),
      ),
    ),
  );

  return Effect.gen(function* () {
    const importer = yield* AgentSessionImporter.AgentSessionImporter;
    const selector = { providerInstanceId, providerSessionId };
    const input = { projectId, expectedWorkspaceRoot: "/workspace/project", ...selector };
    expect(yield* importer.importRecentAgentThreads({ projectId })).toEqual({
      importedCount: 1,
      skippedCount: 0,
    });
    expect(yield* importer.importRecentAgentThreads(input)).toEqual({
      importedCount: 1,
      skippedCount: 0,
    });

    expect(writes).toHaveLength(1);
    expect(writes[0]?.map((event) => event.type)).toEqual([
      "thread.created",
      "message.updated",
      "turn-item.updated",
      "message.updated",
      "turn-item.updated",
      "provider-thread.updated",
    ]);
    const created = writes[0]?.find((event) => event.type === "thread.created");
    const providerThread = writes[0]?.find((event) => event.type === "provider-thread.updated");
    expect(created?.payload).toMatchObject({
      id: threadId,
      activeProviderThreadId: providerThread?.payload.id,
      historyOrigin: "v1_import",
    });
    expect(providerThread?.payload).toMatchObject({
      appThreadId: threadId,
      nativeThreadRef: {
        driver: "codex",
        nativeId: providerSessionId,
        strength: "strong",
      },
    });
    expect(
      writes[0]
        ?.filter((event) => event.type === "message.updated")
        .map((event) => event.payload.text),
    ).toEqual(["Fix it", "Fixed"]);
    expect(upserts).toEqual([
      expect.objectContaining({
        threadId,
        providerInstanceId,
        resumeCursor: { threadId: providerSessionId },
      }),
    ]);
    expect(recorded).toHaveLength(2);
    expect(scans).toEqual([
      { workspaceRoot: "/workspace/project", completedSources: [], sessionFilter: undefined },
      { workspaceRoot: "/workspace/project", completedSources: [], sessionFilter: selector },
    ]);
  }).pipe(Effect.provide(layerTest));
});

it.effect.each([{ providerInstanceId }, { providerSessionId }])(
  "rejects partial selector %j before scanning or importing",
  (selector) => {
    const calls: Array<string> = [];
    const layerTest = AgentSessionImporter.layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          Layer.mock(AgentSessionScanner.AgentSessionScanner)({
            recentThreads: () => {
              calls.push("scan");
              return Stream.empty;
            },
          }),
          Layer.mock(ProjectService.ProjectService)({
            getById: () =>
              Effect.sync(() => {
                calls.push("project");
                return Option.some({ id: projectId, workspaceRoot: "/workspace/project" } as never);
              }),
          }),
          Layer.mock(ProviderSessionRuntime.ProviderSessionRuntimeRepository)({
            list: () =>
              Effect.sync(() => {
                calls.push("runtime");
                return [];
              }),
            upsert: () => Effect.sync(() => void calls.push("upsert")),
            recordImportedTranscript: () => Effect.sync(() => void calls.push("record")),
          }),
          Layer.mock(EventSink.EventSinkV2)({
            write: () =>
              Effect.sync(() => {
                calls.push("events");
                return [];
              }),
          }),
          Layer.mock(Orchestrator.OrchestratorV2)({}),
          IdAllocator.layer,
          Layer.mock(ProjectionStore.ProjectionStoreV2)({
            getAgentSessionOwners: () => Effect.succeed([]),
          }),
        ),
      ),
    );

    return Effect.gen(function* () {
      const importer = yield* AgentSessionImporter.AgentSessionImporter;
      const result = yield* importer
        .importRecentAgentThreads({ projectId, ...selector })
        .pipe(Effect.result);

      expect(result).toMatchObject({
        _tag: "Failure",
        failure: { _tag: "AgentSessionImportInvalidSelectorError" },
      });
      expect(calls).toEqual([]);
    }).pipe(Effect.provide(layerTest));
  },
);
