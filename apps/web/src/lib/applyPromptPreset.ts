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
  useComposerDraftStore,
  type ComposerThreadDraftState,
  type ComposerThreadTarget,
} from "../composerDraftStore";

export function composerDraftToPromptPresetDraft(
  draft: ComposerThreadDraftState,
): PromptPresetDraft {
  const providerInstanceId = draft.activeProvider;
  return {
    text: draft.prompt,
    attachments: [draft.images, draft.files, draft.persistedAttachments],
    context: [
      draft.terminalContexts,
      draft.previewAnnotations,
      draft.reviewComments,
      draft.threadContexts,
    ],
    providerInstanceId,
    model: providerInstanceId
      ? (draft.modelSelectionByProvider[providerInstanceId]?.model ?? null)
      : null,
    runtimeMode: draft.runtimeMode,
    interactionMode: draft.interactionMode,
  };
}

export function applyPromptPresetToComposer(input: {
  readonly threadRef: ComposerThreadTarget;
  readonly draft: ComposerThreadDraftState;
  readonly presets: readonly PromptPreset[];
  readonly presetId: string;
  readonly disposition: PromptPresetApplyDisposition;
  readonly providers: readonly ServerProvider[];
}): PromptPresetResult<PromptPresetDraft> {
  const current = composerDraftToPromptPresetDraft(input.draft);
  const result = applyPromptPreset({
    draft: current,
    presets: input.presets,
    presetId: input.presetId,
    disposition: input.disposition,
    capabilities: promptPresetCapabilitiesFromProviders(input.providers),
  });
  if (!result.ok) return result;

  const store = useComposerDraftStore.getState();
  if (result.value.text !== current.text) {
    store.setPrompt(input.threadRef, result.value.text);
  }
  if (
    result.value.providerInstanceId &&
    result.value.model &&
    (result.value.providerInstanceId !== current.providerInstanceId ||
      result.value.model !== current.model)
  ) {
    store.setModelSelection(
      input.threadRef,
      createModelSelection(result.value.providerInstanceId, result.value.model),
      { explicit: true },
    );
  }
  if (result.value.runtimeMode !== current.runtimeMode) {
    store.setRuntimeMode(input.threadRef, result.value.runtimeMode);
  }
  if (result.value.interactionMode !== current.interactionMode) {
    store.setInteractionMode(input.threadRef, result.value.interactionMode);
  }
  return result;
}
