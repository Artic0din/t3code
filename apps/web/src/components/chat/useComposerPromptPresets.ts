import { useEffect, useRef, useState } from "react";

import {
  buildPromptPreset,
  createPromptPresetId,
  deletePromptPreset,
  savePromptPreset,
  type PromptPresetApplyDisposition,
} from "@t3tools/client-runtime/promptPresets";
import type { EnvironmentId, PromptPreset, ServerProvider } from "@t3tools/contracts";

import { useEnvironmentSettings, useUpdateEnvironmentSettings } from "../../hooks/useSettings";
import {
  applyPromptPresetToComposer,
  composerDraftToPromptPresetDraft,
  type PromptPresetModelChangeGuard,
} from "../../lib/applyPromptPreset";
import { toastManager } from "../ui/toast";
import type { ComposerThreadDraftState, ComposerThreadTarget } from "../../composerDraftStore";

export function useComposerPromptPresets(input: {
  readonly environmentId: EnvironmentId;
  readonly threadRef: ComposerThreadTarget;
  readonly draft: ComposerThreadDraftState;
  readonly providers: readonly ServerProvider[];
  readonly modelChangeGuard?: PromptPresetModelChangeGuard | undefined;
}) {
  const presets = useEnvironmentSettings(input.environmentId, (settings) => settings.promptPresets);
  const updateSettings = useUpdateEnvironmentSettings(input.environmentId);
  const [error, setError] = useState<string | null>(null);
  const localPresetsRef = useRef<readonly PromptPreset[]>(presets);

  useEffect(() => {
    localPresetsRef.current = presets;
  }, [presets]);

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
        presets: localPresetsRef.current,
        presetId,
        disposition,
        providers: input.providers,
        modelChangeGuard: input.modelChangeGuard,
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
      const previous = localPresetsRef.current.find((preset) => preset.id === saveInput.id);
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
      const saved = savePromptPreset(localPresetsRef.current, next);
      if (!saved.ok) {
        report(saved.message);
        return false;
      }
      localPresetsRef.current = saved.value;
      updateSettings({ promptPresets: [...saved.value] });
      setError(null);
      return true;
    },
    remove(presetId: string) {
      const next = deletePromptPreset(localPresetsRef.current, presetId);
      localPresetsRef.current = next;
      updateSettings({ promptPresets: [...next] });
      setError(null);
    },
  };
}
