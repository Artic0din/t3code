import { useEffect, useMemo, useState } from "react";

import {
  buildPromptPreset,
  createPromptPresetId,
  savePromptPreset,
  type PromptPresetApplyDisposition,
  type PromptPresetAgentSettings,
  type PromptPresetThreadState,
} from "@t3tools/client-runtime/promptPresets";
import type { EnvironmentId, ServerProvider } from "@t3tools/contracts";

import { useEnvironmentSettings } from "../../hooks/useSettings";
import { useAtomCommand } from "../../state/use-atom-command";
import { serverEnvironment } from "../../state/server";
import { registerActiveComposerDraftTarget } from "../../activeComposerDraftTarget";
import {
  applyPromptPresetToComposer,
  composerDraftToPromptPresetDraft,
} from "../../lib/applyPromptPreset";
import { toastManager } from "../ui/toast";
import type { ComposerThreadDraftState, ComposerThreadTarget } from "../../composerDraftStore";

export function useComposerPromptPresets(input: {
  readonly enabled: boolean;
  readonly environmentId: EnvironmentId;
  readonly threadRef: ComposerThreadTarget;
  readonly draft: ComposerThreadDraftState;
  readonly providers: readonly ServerProvider[];
  readonly effectiveAgentSettings: PromptPresetAgentSettings;
  readonly threadState: PromptPresetThreadState;
  readonly planModeEnabled: boolean;
}) {
  const presets = useEnvironmentSettings(input.environmentId, (settings) => settings.promptPresets);
  const updateSettings = useAtomCommand(serverEnvironment.updateSettings, {
    label: "prompt preset update",
    reportFailure: true,
  });
  const [error, setError] = useState<string | null>(null);
  const { environmentId, threadRef, effectiveAgentSettings, threadState, planModeEnabled } = input;
  const { providerInstanceId, model, runtimeMode, interactionMode } = effectiveAgentSettings;
  const {
    hasStartedSession,
    isQueuedEdit,
    currentProviderInstanceId,
    supportsProviderSwitchingViaHandoff,
  } = threadState;
  const activeTarget = useMemo(
    () => ({
      environmentId,
      threadRef,
      planModeEnabled,
      effectiveAgentSettings: { providerInstanceId, model, runtimeMode, interactionMode },
      threadState: {
        hasStartedSession,
        isQueuedEdit,
        currentProviderInstanceId,
        supportsProviderSwitchingViaHandoff,
      },
    }),
    [
      environmentId,
      threadRef,
      planModeEnabled,
      providerInstanceId,
      model,
      runtimeMode,
      interactionMode,
      hasStartedSession,
      isQueuedEdit,
      currentProviderInstanceId,
      supportsProviderSwitchingViaHandoff,
    ],
  );
  useEffect(
    () => (input.enabled ? registerActiveComposerDraftTarget(activeTarget) : undefined),
    [activeTarget, input.enabled],
  );

  const report = (message: string) => {
    setError(message);
    toastManager.add({ type: "error", title: "Prompt preset", description: message });
  };

  return {
    presets,
    error,
    apply(presetId: string, disposition: PromptPresetApplyDisposition) {
      if (!input.enabled) return false;
      const result = applyPromptPresetToComposer({
        threadRef: input.threadRef,
        draft: input.draft,
        presets,
        presetId,
        disposition,
        providers: input.providers,
        effectiveAgentSettings: input.effectiveAgentSettings,
        threadState: input.threadState,
        planModeEnabled,
      });
      if (!result.ok) {
        report(result.message);
        return false;
      }
      setError(null);
      return true;
    },
    save(saveInput: {
      readonly id?: string;
      readonly name: string;
      readonly instructions: string;
      readonly includeAgentSettings: boolean;
      readonly replaceInstructions: boolean;
    }) {
      if (!input.enabled) return false;
      const previous = presets.find((preset) => preset.id === saveInput.id);
      const next = buildPromptPreset({
        id: saveInput.id ?? createPromptPresetId(),
        name: saveInput.name,
        instructions:
          previous && !saveInput.replaceInstructions
            ? previous.instructions
            : saveInput.instructions,
        includeAgentSettings: saveInput.includeAgentSettings,
        draft: composerDraftToPromptPresetDraft(input.draft, input.effectiveAgentSettings),
      });
      const saved = savePromptPreset(presets, next);
      if (!saved.ok) {
        report(saved.message);
        return false;
      }
      void updateSettings({
        environmentId: input.environmentId,
        input: { patch: { promptPresetMutation: { operation: "upsert", preset: next } } },
      });
      setError(null);
      return true;
    },
    async remove(presetId: string) {
      if (!input.enabled) return false;
      const result = await updateSettings({
        environmentId: input.environmentId,
        input: { patch: { promptPresetMutation: { operation: "delete", presetId } } },
      });
      if (result._tag === "Success") setError(null);
      return result._tag === "Success";
    },
  };
}
