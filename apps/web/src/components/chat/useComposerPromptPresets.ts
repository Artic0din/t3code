import { useState } from "react";

import {
  buildPromptPreset,
  createPromptPresetId,
  deletePromptPreset,
  savePromptPreset,
  type PromptPresetApplyDisposition,
} from "@t3tools/client-runtime/promptPresets";
import type { EnvironmentId, ServerProvider } from "@t3tools/contracts";

import { useEnvironmentSettings, useUpdateEnvironmentSettings } from "../../hooks/useSettings";
import {
  applyPromptPresetToComposer,
  composerDraftToPromptPresetDraft,
} from "../../lib/applyPromptPreset";
import { toastManager } from "../ui/toast";
import type { ComposerThreadDraftState, ComposerThreadTarget } from "../../composerDraftStore";

export function useComposerPromptPresets(input: {
  readonly environmentId: EnvironmentId;
  readonly threadRef: ComposerThreadTarget;
  readonly draft: ComposerThreadDraftState;
  readonly providers: readonly ServerProvider[];
}) {
  const presets = useEnvironmentSettings(input.environmentId, (settings) => settings.promptPresets);
  const updateSettings = useUpdateEnvironmentSettings(input.environmentId);
  const [error, setError] = useState<string | null>(null);

  const report = (message: string) => {
    setError(message);
    toastManager.add({ type: "error", title: "Prompt preset", description: message });
  };

  return {
    presets,
    error,
    apply(presetId: string, disposition: PromptPresetApplyDisposition) {
      const result = applyPromptPresetToComposer({
        threadRef: input.threadRef,
        draft: input.draft,
        presets,
        presetId,
        disposition,
        providers: input.providers,
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
      const previous = presets.find((preset) => preset.id === saveInput.id);
      const next = buildPromptPreset({
        id: saveInput.id ?? createPromptPresetId(),
        name: saveInput.name,
        instructions:
          previous && !saveInput.replaceInstructions
            ? previous.instructions
            : saveInput.instructions,
        includeAgentSettings: saveInput.includeAgentSettings,
        draft: composerDraftToPromptPresetDraft(input.draft),
        ...(previous ? { previous } : {}),
      });
      const saved = savePromptPreset(presets, next);
      if (!saved.ok) {
        report(saved.message);
        return false;
      }
      updateSettings({ promptPresets: [...saved.value] });
      setError(null);
      return true;
    },
    remove(presetId: string) {
      updateSettings({ promptPresets: [...deletePromptPreset(presets, presetId)] });
      setError(null);
    },
  };
}
