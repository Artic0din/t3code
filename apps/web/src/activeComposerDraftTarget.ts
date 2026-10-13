import { useSyncExternalStore } from "react";
import type {
  PromptPresetAgentSettings,
  PromptPresetThreadState,
} from "@t3tools/client-runtime/promptPresets";
import type { EnvironmentId } from "@t3tools/contracts";
import type { ComposerThreadTarget } from "./composerDraftStore";

export interface ActiveComposerDraftTarget {
  readonly environmentId: EnvironmentId;
  readonly threadRef: ComposerThreadTarget;
  readonly effectiveAgentSettings: PromptPresetAgentSettings;
  readonly threadState: PromptPresetThreadState;
  readonly planModeEnabled?: boolean | undefined;
}

let activeTarget: ActiveComposerDraftTarget | null = null;
const listeners = new Set<() => void>();

function publish(next: ActiveComposerDraftTarget | null): void {
  activeTarget = next;
  for (const listener of listeners) listener();
}

export function registerActiveComposerDraftTarget(target: ActiveComposerDraftTarget): () => void {
  publish(target);
  return () => {
    if (activeTarget === target) publish(null);
  };
}

export function getActiveComposerDraftTarget(): ActiveComposerDraftTarget | null {
  return activeTarget;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function useActiveComposerDraftTarget(): ActiveComposerDraftTarget | null {
  return useSyncExternalStore(
    subscribe,
    getActiveComposerDraftTarget,
    getActiveComposerDraftTarget,
  );
}
