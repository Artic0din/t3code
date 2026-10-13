import { createModelSelection } from "@t3tools/shared/model";
import type { PromptPreset } from "@t3tools/contracts";
import {
  applyPromptPreset,
  promptPresetCapabilitiesFromProviders,
  type PromptPresetApplyDisposition,
  type PromptPresetDraft,
  type PromptPresetResult,
  type PromptPresetAgentSettings,
  type PromptPresetThreadState,
} from "@t3tools/client-runtime/promptPresets";

import {
  getComposerDraftSnapshot,
  setComposerDraftText,
  updateComposerDraftSettings,
  type ComposerDraft,
} from "../../state/use-composer-drafts";

export function mobileDraftToPromptPresetDraft(
  draft: ComposerDraft,
  effectiveAgentSettings?: PromptPresetAgentSettings,
): PromptPresetDraft {
  return {
    text: draft.text,
    attachments: draft.attachments,
    context: draft.context === undefined ? [] : [draft.context],
    providerInstanceId: draft.modelSelection?.instanceId ?? null,
    model: draft.modelSelection?.model ?? null,
    runtimeMode: draft.runtimeMode ?? null,
    interactionMode: draft.interactionMode ?? null,
    ...effectiveAgentSettings,
  };
}

export function applyPromptPresetToMobileDraft(input: {
  readonly draftKey: string;
  readonly presets: readonly PromptPreset[];
  readonly presetId: string;
  readonly disposition: PromptPresetApplyDisposition;
  readonly providers: Parameters<typeof promptPresetCapabilitiesFromProviders>[0];
  readonly effectiveAgentSettings?: PromptPresetAgentSettings | undefined;
  readonly threadState?: PromptPresetThreadState | undefined;
}): PromptPresetResult<PromptPresetDraft> {
  const stored = mobileDraftToPromptPresetDraft(getComposerDraftSnapshot(input.draftKey));
  const current = { ...stored, ...input.effectiveAgentSettings };
  const result = applyPromptPreset({
    draft: current,
    presets: input.presets,
    presetId: input.presetId,
    disposition: input.disposition,
    capabilities: promptPresetCapabilitiesFromProviders(input.providers),
    threadState: input.threadState,
  });
  if (!result.ok) return result;
  const preset = input.presets.find((entry) => entry.id === input.presetId);

  if (result.value.text !== current.text) {
    setComposerDraftText(input.draftKey, result.value.text);
  }
  const modelChanged =
    (preset?.providerInstanceId !== undefined || preset?.model !== undefined) &&
    (result.value.providerInstanceId !== stored.providerInstanceId ||
      result.value.model !== stored.model);
  const runtimeChanged =
    preset?.runtimeMode !== undefined && result.value.runtimeMode !== stored.runtimeMode;
  const interactionChanged =
    preset?.interactionMode !== undefined &&
    result.value.interactionMode !== stored.interactionMode;
  if (modelChanged || runtimeChanged || interactionChanged) {
    updateComposerDraftSettings(input.draftKey, {
      ...(result.value.providerInstanceId && result.value.model && modelChanged
        ? {
            modelSelection: createModelSelection(
              result.value.providerInstanceId,
              result.value.model,
            ),
          }
        : {}),
      ...(runtimeChanged && result.value.runtimeMode
        ? { runtimeMode: result.value.runtimeMode }
        : {}),
      ...(interactionChanged && result.value.interactionMode
        ? { interactionMode: result.value.interactionMode }
        : {}),
    });
  }
  return result;
}
