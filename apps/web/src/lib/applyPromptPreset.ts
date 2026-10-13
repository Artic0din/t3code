import { createModelSelection } from "@t3tools/shared/model";
import type { PromptPreset, ServerProvider } from "@t3tools/contracts";
import type { UnifiedSettings } from "@t3tools/contracts/settings";

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
  composerTargetKey,
  type ComposerThreadDraftState,
  type ComposerThreadTarget,
} from "../composerDraftStore";
import {
  getActiveComposerDraftTarget,
  type ActiveComposerDraftTarget,
} from "../activeComposerDraftTarget";
import { getCustomModelOptionsByInstance } from "../modelSelection";

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
  readonly providers: readonly ServerProvider[];
  readonly settings: UnifiedSettings;
  readonly effectiveAgentSettings?: PromptPresetAgentSettings | undefined;
  readonly threadState?: PromptPresetThreadState | undefined;
  readonly expectedActiveTarget?: ActiveComposerDraftTarget | null | undefined;
  readonly planModeEnabled?: boolean | undefined;
  readonly serverSupportsPromptPresets?: boolean | undefined;
}): PromptPresetResult<PromptPresetDraft> {
  if (input.serverSupportsPromptPresets === false)
    return {
      ok: false,
      code: "unsupported",
      message: "Prompt presets are not supported by this server. Update the server.",
    };
  const activeTarget =
    input.expectedActiveTarget === undefined ? null : getActiveComposerDraftTarget();
  if (
    input.expectedActiveTarget !== undefined &&
    (!input.expectedActiveTarget ||
      !activeTarget ||
      activeTarget.environmentId !== input.expectedActiveTarget.environmentId ||
      composerTargetKey(activeTarget.threadRef) !== composerTargetKey(input.threadRef))
  ) {
    return { ok: false, code: "missing", message: "Open a composer before applying a preset." };
  }
  const stored = composerDraftToPromptPresetDraft(input.draft);
  const current = {
    ...stored,
    ...(activeTarget?.effectiveAgentSettings ?? input.effectiveAgentSettings),
  };
  const modelOptions = getCustomModelOptionsByInstance(input.settings, input.providers);
  const result = applyPromptPreset({
    draft: current,
    presets: input.presets,
    presetId: input.presetId,
    disposition: input.disposition,
    capabilities: promptPresetCapabilitiesFromProviders(
      input.providers.map((provider) => ({
        ...provider,
        models: modelOptions.get(provider.instanceId) ?? [],
      })),
      { planModeEnabled: (activeTarget?.planModeEnabled ?? input.planModeEnabled) === true },
    ),
    threadState: activeTarget?.threadState ?? input.threadState,
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
