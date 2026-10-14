import {
  EnvironmentId,
  type OrchestrationV2ArchivedShellSnapshot,
  type OrchestrationV2ArchivedShellStreamItem,
} from "@t3tools/contracts";
import * as Arr from "effect/Array";
import { pipe } from "effect/Function";
import * as Option from "effect/Option";
import * as Order from "effect/Order";
import { AsyncResult, Atom } from "effect/reactivity";
import type { SupervisorConnectionState } from "../connection/model.ts";

export interface ArchivedSnapshotEntry {
  readonly environmentId: EnvironmentId;
  readonly snapshot: OrchestrationV2ArchivedShellSnapshot;
}

export function applyArchivedShellStreamItem(
  snapshot: OrchestrationV2ArchivedShellSnapshot | null,
  item: OrchestrationV2ArchivedShellStreamItem,
): OrchestrationV2ArchivedShellSnapshot | null {
  if (item.kind === "snapshot") return item.snapshot;
  if (snapshot === null || item.sequence <= snapshot.snapshotSequence) return snapshot;
  const threads = snapshot.threads.filter(
    (thread) => thread.id !== (item.kind === "thread.updated" ? item.thread.id : item.threadId),
  );
  return {
    ...snapshot,
    snapshotSequence: item.sequence,
    threads: item.kind === "thread.updated" ? [...threads, item.thread] : threads,
  };
}

export interface ArchivedThreadSnapshotsState {
  readonly snapshots: ReadonlyArray<ArchivedSnapshotEntry>;
  readonly error: string | null;
  readonly isLoading: boolean;
}

const ARCHIVED_THREADS_ENVIRONMENT_KEY_SEPARATOR = "\u001f";
const environmentIdOrder = Order.String as Order.Order<EnvironmentId>;

export function makeArchivedThreadsEnvironmentKey(
  environmentIds: ReadonlyArray<EnvironmentId>,
): string {
  return pipe(environmentIds, Arr.sort(environmentIdOrder), (sortedEnvironmentIds) =>
    sortedEnvironmentIds.join(ARCHIVED_THREADS_ENVIRONMENT_KEY_SEPARATOR),
  );
}

export function parseArchivedThreadsEnvironmentKey(key: string): ReadonlyArray<EnvironmentId> {
  if (key.length === 0) {
    return [];
  }
  return pipe(
    key.split(ARCHIVED_THREADS_ENVIRONMENT_KEY_SEPARATOR),
    Arr.map((environmentId) => EnvironmentId.make(environmentId)),
  );
}

export function createArchivedThreadSnapshotsAtomFamily<E>(options: {
  readonly getConnectionStateAtom: (
    environmentId: EnvironmentId,
  ) => Atom.Atom<AsyncResult.AsyncResult<Pick<SupervisorConnectionState, "phase">, unknown>>;
  readonly getSnapshotAtom: (
    environmentId: EnvironmentId,
  ) => Atom.Atom<AsyncResult.AsyncResult<OrchestrationV2ArchivedShellSnapshot, E>>;
  readonly labelPrefix: string;
}) {
  return Atom.family((environmentKey: string) =>
    Atom.make((get): ArchivedThreadSnapshotsState => {
      const snapshots: ArchivedSnapshotEntry[] = [];
      let error: string | null = null;
      let isLoading = false;

      for (const environmentId of parseArchivedThreadsEnvironmentKey(environmentKey)) {
        const connection = get(options.getConnectionStateAtom(environmentId));
        const phase = Option.getOrNull(AsyncResult.value(connection))?.phase;
        const unavailable =
          connection._tag === "Failure" ||
          phase === "available" ||
          phase === "offline" ||
          phase === "blocked";
        const result = get(options.getSnapshotAtom(environmentId));
        const snapshot = Option.getOrNull(AsyncResult.value(result));
        isLoading ||= !unavailable && result.waiting && snapshot === null;
        if (snapshot !== null) {
          snapshots.push({ environmentId, snapshot });
        }

        if (error === null && (result._tag === "Failure" || unavailable)) {
          error = "Failed to load archived threads.";
        }
      }

      return { snapshots, error, isLoading };
    }).pipe(Atom.withLabel(`${options.labelPrefix}:${environmentKey}`)),
  );
}
