import { createModelSelection } from "@t3tools/shared/model";
import type { PromptPreset, ServerProvider } from "@t3tools/contracts";
import {
  applyPromptPreset,
  promptPresetCapabilitiesFromProviders,
  type PromptPresetApplyDisposition,
  type PromptPresetDraft,
  type PromptPresetResult,
} from "@t3tools/client-runtime/promptPresets";

import {
  getComposerDraftSnapshot,
  setComposerDraftText,
  updateComposerDraftSettings,
  type ComposerDraft,
} from "../../state/use-composer-drafts";

export function mobileDraftToPromptPresetDraft(draft: ComposerDraft): PromptPresetDraft {
  return {
    text: draft.text,
    attachments: draft.attachments,
    context: draft.context === undefined ? [] : [draft.context],
    providerInstanceId: draft.modelSelection?.instanceId ?? null,
    model: draft.modelSelection?.model ?? null,
    runtimeMode: draft.runtimeMode ?? null,
    interactionMode: draft.interactionMode ?? null,
  };
}

export function applyPromptPresetToMobileDraft(input: {
  readonly draftKey: string;
  readonly presets: readonly PromptPreset[];
  readonly presetId: string;
  readonly disposition: PromptPresetApplyDisposition;
  readonly providers: readonly ServerProvider[];
}): PromptPresetResult<PromptPresetDraft> {
  const current = mobileDraftToPromptPresetDraft(getComposerDraftSnapshot(input.draftKey));
  const result = applyPromptPreset({
    draft: current,
    presets: input.presets,
    presetId: input.presetId,
    disposition: input.disposition,
    capabilities: promptPresetCapabilitiesFromProviders(input.providers),
  });
  if (!result.ok) return result;

  if (result.value.text !== current.text) {
    setComposerDraftText(input.draftKey, result.value.text);
  }
  const providerChanged = result.value.providerInstanceId !== current.providerInstanceId;
  const modelChanged = result.value.model !== current.model;
  const runtimeChanged = result.value.runtimeMode !== current.runtimeMode;
  const interactionChanged = result.value.interactionMode !== current.interactionMode;
  if (providerChanged || modelChanged || runtimeChanged || interactionChanged) {
    updateComposerDraftSettings(input.draftKey, {
      ...(result.value.providerInstanceId && result.value.model && (providerChanged || modelChanged)
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
