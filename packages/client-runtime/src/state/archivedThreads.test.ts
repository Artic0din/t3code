import {
  EnvironmentId,
  ThreadId,
  type OrchestrationV2ArchivedShellSnapshot,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { AsyncResult, Atom, AtomRegistry } from "effect/reactivity";
import { expect, it } from "vite-plus/test";

import {
  createArchivedThreadSnapshotsAtomFamily,
  makeArchivedThreadsEnvironmentKey,
  parseArchivedThreadsEnvironmentKey,
  applyArchivedShellStreamItem,
} from "./archivedThreads.ts";
import { v2ThreadShell } from "./orchestrationV2TestFixtures.ts";
import type { SupervisorConnectionState } from "../connection/model.ts";

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
