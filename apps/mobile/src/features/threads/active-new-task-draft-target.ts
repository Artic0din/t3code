import type { EnvironmentId } from "@t3tools/contracts";
import { useSyncExternalStore } from "react";

export type ActiveNewTaskDraftTarget = {
  readonly draftKey: string;
  readonly environmentId: EnvironmentId;
};

let activeNewTaskDraftTarget: ActiveNewTaskDraftTarget | null = null;
const listeners = new Set<() => void>();

export function setActiveNewTaskDraftTarget(next: ActiveNewTaskDraftTarget | null): void {
  const previous = activeNewTaskDraftTarget;
  if (previous?.draftKey === next?.draftKey && previous?.environmentId === next?.environmentId) {
    return;
  }
  activeNewTaskDraftTarget = next;
  for (const listener of listeners) listener();
}

export function getActiveNewTaskDraftTarget(): ActiveNewTaskDraftTarget | null {
  return activeNewTaskDraftTarget;
}

export function useActiveNewTaskDraftTarget(): ActiveNewTaskDraftTarget | null {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    getActiveNewTaskDraftTarget,
    getActiveNewTaskDraftTarget,
  );
}
