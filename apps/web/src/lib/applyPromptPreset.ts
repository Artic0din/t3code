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
  useComposerDraftStore,
  type ComposerThreadDraftState,
  type ComposerThreadTarget,
} from "../composerDraftStore";

export function composerDraftToPromptPresetDraft(
  draft: ComposerThreadDraftState,
  effectiveAgentSettings?: PromptPresetAgentSettings,
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
    ...effectiveAgentSettings,
  };
}

export function applyPromptPresetToComposer(input: {
  readonly threadRef: ComposerThreadTarget;
  readonly draft: ComposerThreadDraftState;
  readonly presets: readonly PromptPreset[];
  readonly presetId: string;
  readonly disposition: PromptPresetApplyDisposition;
  readonly providers: Parameters<typeof promptPresetCapabilitiesFromProviders>[0];
  readonly effectiveAgentSettings?: PromptPresetAgentSettings | undefined;
  readonly threadState?: PromptPresetThreadState | undefined;
}): PromptPresetResult<PromptPresetDraft> {
  const stored = composerDraftToPromptPresetDraft(input.draft);
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

  const store = useComposerDraftStore.getState();
  if (result.value.text !== current.text) {
    store.setPrompt(input.threadRef, result.value.text);
  }
  if (
    result.value.providerInstanceId &&
    result.value.model &&
    (preset?.providerInstanceId !== undefined || preset?.model !== undefined) &&
    (result.value.providerInstanceId !== stored.providerInstanceId ||
      result.value.model !== stored.model)
  ) {
    store.setModelSelection(
      input.threadRef,
      createModelSelection(result.value.providerInstanceId, result.value.model),
      { explicit: true, replaceOptions: true },
    );
  }
  if (preset?.runtimeMode !== undefined && result.value.runtimeMode !== stored.runtimeMode) {
    store.setRuntimeMode(input.threadRef, result.value.runtimeMode);
  }
  if (
    preset?.interactionMode !== undefined &&
    result.value.interactionMode !== stored.interactionMode
  ) {
    store.setInteractionMode(input.threadRef, result.value.interactionMode);
  }
  return result;
}
