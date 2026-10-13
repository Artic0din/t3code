import type { EnvironmentId } from "@t3tools/contracts";
import type {
  PromptPresetAgentSettings,
  PromptPresetThreadState,
} from "@t3tools/client-runtime/promptPresets";
import { useSyncExternalStore } from "react";

export type ActiveComposerDraftTarget = {
  readonly draftKey: string;
  readonly environmentId: EnvironmentId;
  readonly effectiveAgentSettings: PromptPresetAgentSettings;
  readonly threadState: PromptPresetThreadState;
};

let activeComposerDraftTarget: ActiveComposerDraftTarget | null = null;
const listeners = new Set<() => void>();

function publish(next: ActiveComposerDraftTarget | null): void {
  activeComposerDraftTarget = next;
  for (const listener of listeners) listener();
}

export function registerActiveComposerDraftTarget(target: ActiveComposerDraftTarget): () => void {
  publish(target);
  return () => {
    if (activeComposerDraftTarget === target) publish(null);
  };
}

export function getActiveComposerDraftTarget(): ActiveComposerDraftTarget | null {
  return activeComposerDraftTarget;
}

export function useActiveComposerDraftTarget(): ActiveComposerDraftTarget | null {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    getActiveComposerDraftTarget,
    getActiveComposerDraftTarget,
  );
}
