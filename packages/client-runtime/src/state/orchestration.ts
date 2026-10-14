import {
  ORCHESTRATION_V2_WS_METHODS,
  type OrchestrationV2ArchivedShellSnapshot,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { Atom } from "effect/reactivity";
import * as Stream from "effect/Stream";
import { applyArchivedShellStreamItem } from "./archivedThreads.ts";
import { request } from "../rpc/client.ts";

import {
  createEnvironmentRpcCommand,
  createEnvironmentRpcQueryAtomFamily,
  createEnvironmentRpcSubscriptionAtomFamily,
} from "./runtime.ts";
import type { EnvironmentRegistry } from "../connection/registry.ts";

export function createOrchestrationEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  return {
    v2: {
      dispatchCommand: createEnvironmentRpcCommand(runtime, {
        label: "environment-data:orchestration-v2:dispatch-command",
        tag: ORCHESTRATION_V2_WS_METHODS.dispatchCommand,
      }),
      threadProjection: createEnvironmentRpcQueryAtomFamily(runtime, {
        label: "environment-data:orchestration-v2:thread-projection",
        tag: ORCHESTRATION_V2_WS_METHODS.getThreadProjection,
        staleTimeMs: 0,
        idleTtlMs: 0,
      }),
      shell: createEnvironmentRpcSubscriptionAtomFamily(runtime, {
        label: "environment-data:orchestration-v2:shell",
        tag: ORCHESTRATION_V2_WS_METHODS.subscribeShell,
      }),
      thread: createEnvironmentRpcSubscriptionAtomFamily(runtime, {
        label: "environment-data:orchestration-v2:thread",
        tag: ORCHESTRATION_V2_WS_METHODS.subscribeThread,
        idleTtlMs: 0,
      }),
    },
    turnDiff: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:orchestration:turn-diff",
      tag: ORCHESTRATION_V2_WS_METHODS.getTurnDiff,
    }),
    workflowScript: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:orchestration:workflow-script",
      tag: ORCHESTRATION_V2_WS_METHODS.getWorkflowScript,
      // Scripts are immutable per run: cache generously.
      staleTimeMs: 300_000,
      idleTtlMs: 300_000,
    }),
    // Keyed by the item revision, so a live row refetches as its output grows.
    turnItem: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:orchestration:turn-item",
      tag: ORCHESTRATION_V2_WS_METHODS.getTurnItem,
      staleTimeMs: 60_000,
      idleTtlMs: 60_000,
    }),
    fullThreadDiff: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:orchestration:full-thread-diff",
      tag: ORCHESTRATION_V2_WS_METHODS.getFullThreadDiff,
    }),
    threadSearch: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:orchestration:thread-search",
      tag: ORCHESTRATION_V2_WS_METHODS.searchThreads,
      staleTimeMs: 30_000,
      idleTtlMs: 60_000,
    }),
    archivedShellSnapshot: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:orchestration:archived-shell-snapshot",
      tag: ORCHESTRATION_V2_WS_METHODS.getArchivedShellSnapshot,
    }),
    archivedShell: createEnvironmentRpcSubscriptionAtomFamily(runtime, {
      label: "environment-data:orchestration:archived-shell",
      tag: ORCHESTRATION_V2_WS_METHODS.subscribeArchivedShell,
      idleTtlMs: 0,
      transform: (stream) =>
        stream.pipe(
          Stream.scanEffect(
            (): OrchestrationV2ArchivedShellSnapshot | null => null,
            (snapshot, item) => {
              if (
                item.kind === "thread.updated" &&
                snapshot !== null &&
                item.sequence > snapshot.snapshotSequence &&
                !snapshot.projects.some((project) => project.id === item.thread.projectId)
              ) {
                const waitForReconnect = (cause: unknown) =>
                  Effect.logWarning(
                    "Archived thread project refresh lost its connection. Waiting for reconnect.",
                    { cause },
                  ).pipe(Effect.as(snapshot));
                return request(ORCHESTRATION_V2_WS_METHODS.getArchivedShellSnapshot, {}).pipe(
                  Effect.catchTags({
                    EnvironmentRpcUnavailableError: waitForReconnect,
                    RpcClientError: waitForReconnect,
                  }),
                );
              }
              return Effect.succeed(applyArchivedShellStreamItem(snapshot, item));
            },
          ),
          Stream.filter((snapshot) => snapshot !== null),
        ),
    }),
  };
}
