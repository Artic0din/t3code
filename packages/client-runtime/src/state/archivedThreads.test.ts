import {
  EnvironmentId,
  ORCHESTRATION_V2_WS_METHODS,
  OrchestrationV2GetShellSnapshotError,
  ProjectId,
  ThreadId,
  type OrchestrationV2ArchivedShellSnapshot,
  type OrchestrationV2ArchivedShellStreamItem,
} from "@t3tools/contracts";
import { it as effectIt } from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { AsyncResult, Atom, AtomRegistry } from "effect/reactivity";
import { RpcClientError } from "effect/rpc";
import * as Socket from "effect/socket/Socket";
import { expect, it } from "vite-plus/test";

import {
  createArchivedThreadSnapshotsAtomFamily,
  makeArchivedThreadsEnvironmentKey,
  parseArchivedThreadsEnvironmentKey,
  applyArchivedShellStreamItem,
} from "./archivedThreads.ts";
import { v2Now, v2Project, v2ThreadShell } from "./orchestrationV2TestFixtures.ts";
import { createOrchestrationEnvironmentAtoms } from "./orchestration.ts";
import {
  AVAILABLE_CONNECTION_STATE,
  PrimaryConnectionTarget,
  type PreparedConnection,
  type SupervisorConnectionState,
} from "../connection/model.ts";
import { EnvironmentRegistry } from "../connection/registry.ts";
import { EnvironmentSupervisor } from "../connection/supervisor.ts";
import type { WsRpcProtocolClient } from "../rpc/protocol.ts";
import type { RpcSession } from "../rpc/session.ts";
import { EnvironmentRpcUnavailableError } from "../rpc/client.ts";
import { createEnvironmentRpcSubscriptionAtomFamily } from "./runtime.ts";

effectIt.effect.each(["success", "server failure", "disconnected", "transport failure"] as const)(
  "refreshes an archived thread's missing project with %s",
  (outcome) =>
    Effect.gen(function* () {
      const environmentId = EnvironmentId.make("archive-live-projects");
      const oldThread = { ...v2ThreadShell, id: ThreadId.make("archive-old"), archivedAt: v2Now };
      const project = {
        ...v2Project,
        id: ProjectId.make("project-created-later"),
        title: "New project",
      };
      const newThread = { ...oldThread, id: ThreadId.make("archive-new"), projectId: project.id };
      const initial: OrchestrationV2ArchivedShellSnapshot = {
        schemaVersion: 1,
        snapshotSequence: 10,
        projects: [v2Project],
        threads: [oldThread],
      };
      const refreshed = {
        ...initial,
        snapshotSequence: 12,
        projects: [v2Project, project],
        threads: [oldThread, { ...newThread, title: "Authoritative thread" }],
      };
      const events = yield* Queue.unbounded<OrchestrationV2ArchivedShellStreamItem>();
      const refreshes = yield* Ref.make(0);
      const refreshSettled = yield* Deferred.make<void>();
      const client = {
        [ORCHESTRATION_V2_WS_METHODS.subscribeArchivedShell]: () => Stream.fromQueue(events),
        [ORCHESTRATION_V2_WS_METHODS.getArchivedShellSnapshot]: () =>
          Ref.update(refreshes, (count) => count + 1).pipe(
            Effect.andThen(
              outcome === "success"
                ? Effect.succeed(refreshed)
                : Effect.fail(
                    outcome === "server failure"
                      ? new OrchestrationV2GetShellSnapshotError({
                          message: "Archive refresh rejected",
                        })
                      : outcome === "transport failure"
                        ? new RpcClientError.RpcClientError({
                            reason: new Socket.SocketCloseError({ code: 1006 }),
                          })
                        : new EnvironmentRpcUnavailableError({
                            environmentId,
                            message: "Disconnected during refresh",
                          }),
                  ),
            ),
            Effect.ensuring(Deferred.succeed(refreshSettled, undefined)),
          ),
      } as unknown as WsRpcProtocolClient;
      const supervisor = EnvironmentSupervisor.of({
        target: new PrimaryConnectionTarget({
          environmentId,
          label: "Archive test",
          httpBaseUrl: "https://archive.example.test",
          wsBaseUrl: "wss://archive.example.test",
        }),
        state: yield* SubscriptionRef.make<SupervisorConnectionState>({
          ...AVAILABLE_CONNECTION_STATE,
          phase: "connected",
        }),
        session: yield* SubscriptionRef.make(Option.some({ client } as RpcSession)),
        prepared: yield* SubscriptionRef.make<Option.Option<PreparedConnection>>(Option.none()),
        connect: Effect.void,
        disconnect: Effect.void,
        retryNow: Effect.void,
      });
      const followStream: EnvironmentRegistry["Service"]["followStream"] = (
        _environmentId,
        stream,
      ) => Stream.provideService(stream, EnvironmentSupervisor, supervisor);
      const runtime = Atom.runtime(
        Layer.succeed(
          EnvironmentRegistry,
          EnvironmentRegistry.of({ followStream } as EnvironmentRegistry["Service"]),
        ),
      );
      const source = createOrchestrationEnvironmentAtoms(runtime).archivedShell({
        environmentId,
        input: {},
      });
      const connection = Atom.make<
        AsyncResult.AsyncResult<Pick<SupervisorConnectionState, "phase">, never>
      >(AsyncResult.success({ phase: "connected" as const }));
      const snapshots = createArchivedThreadSnapshotsAtomFamily({
        getSnapshotAtom: () => source,
        getConnectionStateAtom: () => connection,
        labelPrefix: "test:archive-live-projects",
      })(makeArchivedThreadsEnvironmentKey([environmentId]));
      const registry = AtomRegistry.make();
      yield* Effect.addFinalizer(() => Effect.sync(() => registry.dispose()));
      registry.mount(snapshots);
      const receivedInitial = yield* Deferred.make<void>();
      const receivedUpdate = yield* Deferred.make<void>();
      const receivedRemoval = yield* Deferred.make<void>();
      registry.subscribe(source, (result) => {
        const snapshot = Option.getOrNull(AsyncResult.value(result));
        if (snapshot?.snapshotSequence === 10) Deferred.doneUnsafe(receivedInitial, Effect.void);
        if (snapshot?.snapshotSequence === 12 || result._tag === "Failure")
          Deferred.doneUnsafe(receivedUpdate, Effect.void);
        if (snapshot?.snapshotSequence === 13) Deferred.doneUnsafe(receivedRemoval, Effect.void);
      });
      const groupedIds = () =>
        registry
          .get(snapshots)
          .snapshots.flatMap(({ snapshot }) =>
            snapshot.projects.flatMap((project) =>
              snapshot.threads
                .filter((thread) => thread.projectId === project.id)
                .map((thread) => thread.id),
            ),
          )
          .sort();
      yield* Queue.offer(events, { kind: "snapshot", snapshot: initial });
      yield* Deferred.await(receivedInitial);
      expect(groupedIds()).toEqual(["archive-old"]);
      yield* Queue.offer(events, { kind: "thread.updated", sequence: 11, thread: newThread });
      if (outcome === "disconnected" || outcome === "transport failure") {
        yield* Deferred.await(refreshSettled);
        yield* Effect.yieldNow;
        registry.set(connection, AsyncResult.success({ phase: "offline" as const }));
      } else {
        yield* Deferred.await(receivedUpdate);
      }
      expect(yield* Ref.get(refreshes)).toBe(1);
      if (outcome !== "success") {
        expect(registry.get(snapshots)).toEqual({
          snapshots: [{ environmentId, snapshot: initial }],
          error: "Failed to load archived threads.",
          isLoading: false,
        });
        if (outcome === "disconnected" || outcome === "transport failure") {
          const reconnected = { ...refreshed, snapshotSequence: 1 };
          const control = createEnvironmentRpcSubscriptionAtomFamily(runtime, {
            label: "test:raw-archive-reconnect",
            tag: ORCHESTRATION_V2_WS_METHODS.subscribeArchivedShell,
          })({ environmentId, input: {} });
          const controlReceived = yield* Deferred.make<void>();
          registry.subscribe(control, (result) => {
            const item = Option.getOrNull(AsyncResult.value(result));
            if (item?.kind === "thread.updated" && item.sequence === 2)
              Deferred.doneUnsafe(controlReceived, Effect.void);
          });
          registry.mount(control);
          const nextClient = {
            ...client,
            [ORCHESTRATION_V2_WS_METHODS.subscribeArchivedShell]: () =>
              Stream.make(
                { kind: "snapshot", snapshot: reconnected } as const,
                {
                  kind: "thread.updated",
                  sequence: 2,
                  thread: { ...newThread, title: "Reconnected thread" },
                } as const,
              ).pipe(Stream.concat(Stream.never)),
          } as unknown as WsRpcProtocolClient;
          yield* SubscriptionRef.set(
            supervisor.session,
            Option.some({ client: nextClient } as RpcSession),
          );
          yield* Deferred.await(controlReceived);
          yield* Effect.yieldNow;
          registry.set(connection, AsyncResult.success({ phase: "connected" as const }));
          expect(groupedIds()).toEqual(["archive-new", "archive-old"]);
          expect(
            registry.get(snapshots).snapshots[0]?.snapshot.threads.map((thread) => thread.title),
          ).toEqual(["Thread", "Reconnected thread"]);
          expect(registry.get(snapshots).error).toBeNull();
        }
        return;
      }
      expect(groupedIds()).toEqual(["archive-new", "archive-old"]);
      expect(registry.get(snapshots).snapshots[0]?.snapshot.projects).toEqual([v2Project, project]);
      yield* Queue.offerAll(events, [
        {
          kind: "thread.updated",
          sequence: 10,
          thread: { ...newThread, projectId: ProjectId.make("stale-project") },
        },
        { kind: "thread.updated", sequence: 11, thread: { ...newThread, title: "Stale title" } },
        { kind: "thread.removed", sequence: 13, threadId: oldThread.id },
      ]);
      yield* Deferred.await(receivedRemoval);
      expect(groupedIds()).toEqual(["archive-new"]);
      expect(
        registry.get(snapshots).snapshots[0]?.snapshot.threads.map((thread) => thread.title),
      ).toEqual(["Authoritative thread"]);
      expect(yield* Ref.get(refreshes)).toBe(1);
    }),
);

it.each(["available", "offline", "blocked"] as const)(
  "settles an unavailable archive while %s and recovers after reconnect",
  (phase) => {
    const environmentId = EnvironmentId.make("env-unavailable");
    const connection = Atom.make<
      AsyncResult.AsyncResult<Pick<SupervisorConnectionState, "phase">, never>
    >(AsyncResult.success({ phase: "connecting" as const }));
    const source = Atom.make<AsyncResult.AsyncResult<OrchestrationV2ArchivedShellSnapshot, Error>>(
      AsyncResult.initial(true),
    );
    const snapshots = createArchivedThreadSnapshotsAtomFamily({
      getSnapshotAtom: () => source,
      getConnectionStateAtom: () => connection,
      labelPrefix: "test:unavailable-archive",
    })(makeArchivedThreadsEnvironmentKey([environmentId]));
    const registry = AtomRegistry.make();
    try {
      const unmount = registry.mount(snapshots);
      expect(registry.get(snapshots)).toEqual({ snapshots: [], error: null, isLoading: true });
      registry.set(connection, AsyncResult.success({ phase }));
      expect(registry.get(snapshots)).toEqual({
        snapshots: [],
        error: "Failed to load archived threads.",
        isLoading: false,
      });
      const snapshot = {
        schemaVersion: 1,
        snapshotSequence: 1,
        projects: [],
        threads: [v2ThreadShell],
      };
      registry.set(connection, AsyncResult.success({ phase: "connected" as const }));
      registry.set(source, AsyncResult.success(snapshot, { waiting: true }));
      expect(registry.get(snapshots)).toEqual({
        snapshots: [{ environmentId, snapshot }],
        error: null,
        isLoading: false,
      });
      unmount();
    } finally {
      registry.dispose();
    }
  },
);

it("settles initial loading after a live snapshot arrives while its stream stays open", () => {
  const environmentId = EnvironmentId.make("env-live");
  const snapshot: OrchestrationV2ArchivedShellSnapshot = {
    schemaVersion: 1,
    snapshotSequence: 1,
    projects: [],
    threads: [v2ThreadShell],
  };
  const source = Atom.make<AsyncResult.AsyncResult<OrchestrationV2ArchivedShellSnapshot, Error>>(
    AsyncResult.initial(true),
  );
  const snapshots = createArchivedThreadSnapshotsAtomFamily({
    getSnapshotAtom: () => source,
    getConnectionStateAtom: () => Atom.make(AsyncResult.success({ phase: "connected" as const })),
    labelPrefix: "test:live-archive",
  })(makeArchivedThreadsEnvironmentKey([environmentId]));
  const registry = AtomRegistry.make();
  try {
    const unmount = registry.mount(snapshots);
    expect(registry.get(snapshots)).toEqual({ snapshots: [], error: null, isLoading: true });
    registry.set(source, AsyncResult.success(snapshot, { waiting: true }));
    expect(registry.get(snapshots)).toEqual({
      snapshots: [{ environmentId, snapshot }],
      error: null,
      isLoading: false,
    });
    unmount();
  } finally {
    registry.dispose();
  }
});

it("keeps related archive membership and issue links current through stream updates", () => {
  const snapshot: OrchestrationV2ArchivedShellSnapshot = {
    schemaVersion: 1,
    snapshotSequence: 10,
    projects: [],
    threads: [v2ThreadShell],
  };
  const issue = {
    host: "github.com",
    repository: "acme/web",
    number: 14,
    url: "https://github.com/acme/web/issues/14",
    title: "Fix login",
    availability: "open" as const,
  };
  const updated = applyArchivedShellStreamItem(snapshot, {
    kind: "thread.updated",
    sequence: 11,
    thread: { ...v2ThreadShell, linkedIssue: issue },
  });
  expect(updated?.threads.map((thread) => thread.linkedIssue)).toEqual([issue]);
  const removed = applyArchivedShellStreamItem(updated, {
    kind: "thread.removed",
    sequence: 12,
    threadId: v2ThreadShell.id,
  });
  expect(removed).toEqual({ ...snapshot, snapshotSequence: 12, threads: [] });
  expect(
    applyArchivedShellStreamItem(removed, {
      kind: "thread.updated",
      sequence: 11,
      thread: v2ThreadShell,
    }),
  ).toEqual(removed);
  const replacement = {
    ...snapshot,
    snapshotSequence: 1,
    threads: [{ ...v2ThreadShell, id: ThreadId.make("reconnected") }],
  };
  expect(
    applyArchivedShellStreamItem(removed, { kind: "snapshot", snapshot: replacement }),
  ).toEqual(replacement);
});

it("round-trips environment keys in sorted order", () => {
  const envA = EnvironmentId.make("env-a");
  const envB = EnvironmentId.make("env-b");
  const key = makeArchivedThreadsEnvironmentKey([envB, envA]);

  expect(parseArchivedThreadsEnvironmentKey(key)).toEqual([envA, envB]);
});

it("does not expose an archived snapshot failure message", () => {
  const environmentId = EnvironmentId.make("env-sensitive");
  const snapshotsAtom = createArchivedThreadSnapshotsAtomFamily<Error>({
    getConnectionStateAtom: () => Atom.make(AsyncResult.success({ phase: "connected" as const })),
    getSnapshotAtom: () =>
      Atom.make(
        AsyncResult.failure<OrchestrationV2ArchivedShellSnapshot, Error>(
          Cause.fail(new Error("credential=secret-value")),
        ),
      ),
    labelPrefix: "test:archived-thread-snapshots",
  });
  const registry = AtomRegistry.make();

  expect(registry.get(snapshotsAtom(makeArchivedThreadsEnvironmentKey([environmentId])))).toEqual({
    snapshots: [],
    error: "Failed to load archived threads.",
    isLoading: false,
  });

  registry.dispose();
});
