import { createModelSelection } from "@t3tools/shared/model";
import type { PromptPreset } from "@t3tools/contracts";
import {
  applyPromptPreset,
  buildPromptPreset,
  promptPresetCapabilitiesFromProviders,
  type PromptPresetApplyDisposition,
  type PromptPresetDraft,
  type PromptPresetResult,
  type PromptPresetAgentSettings,
  type PromptPresetThreadState,
} from "@t3tools/client-runtime/promptPresets";

import {
  getComposerDraftSnapshot,
  setComposerDraftPresetText,
  updateComposerDraftSettings,
  type ComposerDraft,
} from "../../state/use-composer-drafts";
import {
  getActiveComposerDraftTarget,
  type ActiveComposerDraftTarget,
} from "../threads/active-composer-draft-target";

export function buildPromptPresetFromMobileDraft(input: {
  readonly id: string;
  readonly name: string;
  readonly draftKey: string;
  readonly effectiveAgentSettings?: PromptPresetAgentSettings;
  readonly threadState?: PromptPresetThreadState;
}): PromptPreset {
  const draft = getComposerDraftSnapshot(input.draftKey);
  return buildPromptPreset({
    id: input.id,
    name: input.name,
    instructions: draft.text,
    includeAgentSettings: input.threadState?.isQueuedEdit !== true,
    draft: mobileDraftToPromptPresetDraft(draft, input.effectiveAgentSettings),
  });
}

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
  readonly planModeEnabled?: boolean | undefined;
  readonly expectedActiveTarget?: ActiveComposerDraftTarget | null | undefined;
}): PromptPresetResult<PromptPresetDraft> {
  const activeTarget =
    input.expectedActiveTarget === undefined ? undefined : getActiveComposerDraftTarget();
  if (
    input.expectedActiveTarget !== undefined &&
    (!activeTarget || activeTarget !== input.expectedActiveTarget)
  ) {
    return { ok: false, code: "missing", message: "Open a composer before applying a preset." };
  }
  const stored = mobileDraftToPromptPresetDraft(getComposerDraftSnapshot(input.draftKey));
  const current = { ...stored, ...input.effectiveAgentSettings };
  const result = applyPromptPreset({
    draft: current,
    presets: input.presets,
    presetId: input.presetId,
    disposition: input.disposition,
    capabilities: promptPresetCapabilitiesFromProviders(input.providers, {
      planModeEnabled: input.planModeEnabled === true,
    }),
    threadState: activeTarget?.threadState ?? input.threadState,
  });
  if (!result.ok) return result;
  const preset = input.presets.find((entry) => entry.id === input.presetId);

  if (result.value.text !== current.text) {
    setComposerDraftPresetText(input.draftKey, result.value.text);
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
  return {
    ok: true,
    value: mobileDraftToPromptPresetDraft(getComposerDraftSnapshot(input.draftKey), {
      providerInstanceId: result.value.providerInstanceId,
      model: result.value.model,
      runtimeMode: result.value.runtimeMode,
      interactionMode: result.value.interactionMode,
    }),
  };
}
