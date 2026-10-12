import {
  type PromptPreset,
  type ProviderInstanceId,
  type ProviderInteractionMode,
  type RuntimeMode,
  MAX_PROMPT_PRESETS,
  PromptPreset as PromptPresetSchema,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";

export type PromptPresetApplyDisposition = "insert" | "replace";

export interface PromptPresetDraft {
  readonly text: string;
  readonly attachments: readonly unknown[];
  readonly context: readonly unknown[];
  readonly providerInstanceId: ProviderInstanceId | null;
  readonly model: string | null;
  readonly runtimeMode: RuntimeMode | null;
  readonly interactionMode: ProviderInteractionMode | null;
}

export interface PromptPresetProviderCapability {
  readonly instanceId: ProviderInstanceId;
  readonly models: ReadonlyArray<string>;
  readonly runtimeModes?: ReadonlyArray<RuntimeMode> | undefined;
  readonly interactionModes?: ReadonlyArray<ProviderInteractionMode> | undefined;
}

export interface PromptPresetCapabilities {
  readonly providers: ReadonlyArray<PromptPresetProviderCapability>;
}

export type PromptPresetFailureCode =
  | "missing"
  | "provider"
  | "model"
  | "runtime-mode"
  | "interaction-mode"
  | "invalid"
  | "full";

export type PromptPresetResult<A> =
  | { readonly ok: true; readonly value: A }
  | { readonly ok: false; readonly code: PromptPresetFailureCode; readonly message: string };

const decodePreset = Schema.decodeUnknownExit(PromptPresetSchema);
const ALL_RUNTIME_MODES = [
  "approval-required",
  "auto-accept-edits",
  "auto",
  "full-access",
] as const;
const ALL_INTERACTION_MODES = ["default", "plan"] as const;

export function createPromptPresetId(): string {
  // getRandomValues works on non-secure LAN HTTP; crypto.randomUUID() does not.
  const bytes = globalThis.crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function promptPresetCapabilitiesFromProviders(
  providers: ReadonlyArray<{
    readonly instanceId: ProviderInstanceId;
    readonly enabled: boolean;
    readonly availability?: string | undefined;
    readonly models: ReadonlyArray<{
      readonly slug: string;
      readonly aliases?: ReadonlyArray<string> | undefined;
    }>;
    readonly supportedRuntimeModes?: ReadonlyArray<RuntimeMode> | undefined;
    readonly showInteractionModeToggle?: boolean | undefined;
  }>,
): PromptPresetCapabilities {
  return {
    providers: providers.flatMap((provider) => {
      if (!provider.enabled || provider.availability === "unavailable") return [];
      const capability: PromptPresetProviderCapability = {
        instanceId: provider.instanceId,
        models: provider.models.flatMap((model) => [model.slug, ...(model.aliases ?? [])]),
        ...(provider.supportedRuntimeModes && provider.supportedRuntimeModes.length > 0
          ? { runtimeModes: provider.supportedRuntimeModes }
          : {}),
        ...(provider.showInteractionModeToggle === false
          ? { interactionModes: ["default"] as const }
          : {}),
      };
      return [capability];
    }),
  };
}

export function buildPromptPreset(input: {
  readonly id: string;
  readonly name: string;
  readonly instructions: string;
  readonly includeAgentSettings: boolean;
  readonly draft: PromptPresetDraft;
  readonly previous?: PromptPreset | undefined;
}): PromptPreset {
  const source = input.includeAgentSettings ? agentSettingsFromDraft(input.draft) : input.previous;
  return {
    id: input.id,
    name: input.name,
    instructions: input.instructions,
    ...(source?.providerInstanceId !== undefined
      ? { providerInstanceId: source.providerInstanceId }
      : {}),
    ...(source?.model !== undefined ? { model: source.model } : {}),
    ...(source?.runtimeMode !== undefined ? { runtimeMode: source.runtimeMode } : {}),
    ...(source?.interactionMode !== undefined ? { interactionMode: source.interactionMode } : {}),
  };
}

export function savePromptPreset(
  presets: readonly PromptPreset[],
  preset: PromptPreset,
): PromptPresetResult<readonly PromptPreset[]> {
  const decoded = decodePreset(preset);
  if (decoded._tag === "Failure") {
    return {
      ok: false,
      code: "invalid",
      message: "Name a preset with instructions that fit the saved-prompt limit.",
    };
  }
  const nextPreset = decoded.value;
  const index = presets.findIndex((entry) => entry.id === nextPreset.id);
  if (index === -1 && presets.length >= MAX_PROMPT_PRESETS) {
    return {
      ok: false,
      code: "full",
      message: `This environment already has ${MAX_PROMPT_PRESETS} prompt presets. Delete one first.`,
    };
  }
  const next =
    index === -1
      ? [...presets, nextPreset]
      : presets.map((entry, entryIndex) => (entryIndex === index ? nextPreset : entry));
  return { ok: true, value: next };
}

export function deletePromptPreset(
  presets: readonly PromptPreset[],
  presetId: string,
): readonly PromptPreset[] {
  return presets.filter((preset) => preset.id !== presetId);
}

export function applyPromptPreset(input: {
  readonly draft: PromptPresetDraft;
  readonly presets: readonly PromptPreset[];
  readonly presetId: string;
  readonly disposition: PromptPresetApplyDisposition;
  readonly capabilities: PromptPresetCapabilities;
}): PromptPresetResult<PromptPresetDraft> {
  const preset = input.presets.find((entry) => entry.id === input.presetId);
  if (!preset) {
    return {
      ok: false,
      code: "missing",
      message: "That prompt preset was deleted. Refresh the list and choose another.",
    };
  }

  const providerInstanceId = preset.providerInstanceId ?? input.draft.providerInstanceId;
  const provider =
    providerInstanceId === null
      ? undefined
      : input.capabilities.providers.find((entry) => entry.instanceId === providerInstanceId);

  if (preset.providerInstanceId !== undefined && !provider) {
    return failure(
      "provider",
      "That provider is not available in this environment. Choose another, or edit the preset.",
    );
  }

  const model = preset.model ?? input.draft.model;
  if (preset.model !== undefined || preset.providerInstanceId !== undefined) {
    if (!provider || model === null || !provider.models.includes(model)) {
      return failure(
        "model",
        "That model is not available on the selected provider. The provider was left unchanged.",
      );
    }
  }

  const runtimeMode = preset.runtimeMode ?? input.draft.runtimeMode;
  if (
    (preset.runtimeMode !== undefined || preset.providerInstanceId !== undefined) &&
    runtimeMode !== null &&
    !supportsRuntimeMode(provider, runtimeMode)
  ) {
    return failure(
      "runtime-mode",
      "That mode is not available on the selected provider. The draft was left unchanged.",
    );
  }

  const interactionMode = preset.interactionMode ?? input.draft.interactionMode;
  if (
    (preset.interactionMode !== undefined || preset.providerInstanceId !== undefined) &&
    interactionMode !== null &&
    !supportsInteractionMode(provider, interactionMode)
  ) {
    return failure(
      "interaction-mode",
      "Plan mode is not available on the selected provider. The draft was left unchanged.",
    );
  }

  return {
    ok: true,
    value: {
      text:
        input.disposition === "replace"
          ? preset.instructions
          : insertInstructions(input.draft.text, preset.instructions),
      attachments: input.draft.attachments,
      context: input.draft.context,
      providerInstanceId,
      model,
      runtimeMode,
      interactionMode,
    },
  };
}

function failure(
  code: PromptPresetFailureCode,
  message: string,
): PromptPresetResult<PromptPresetDraft> {
  return { ok: false, code, message };
}

function insertInstructions(text: string, instructions: string): string {
  if (instructions.length === 0) return text;
  if (text.length === 0) return instructions;
  return `${text}\n\n${instructions}`;
}

function agentSettingsFromDraft(draft: PromptPresetDraft): PromptPreset {
  return {
    id: "draft",
    name: "draft",
    instructions: "",
    ...(draft.providerInstanceId ? { providerInstanceId: draft.providerInstanceId } : {}),
    ...(draft.model ? { model: draft.model } : {}),
    ...(draft.runtimeMode ? { runtimeMode: draft.runtimeMode } : {}),
    ...(draft.interactionMode ? { interactionMode: draft.interactionMode } : {}),
  };
}

function supportsRuntimeMode(
  provider: PromptPresetProviderCapability | undefined,
  mode: RuntimeMode,
): boolean {
  const supported = provider?.runtimeModes ?? ALL_RUNTIME_MODES;
  return supported.includes(mode);
}

function supportsInteractionMode(
  provider: PromptPresetProviderCapability | undefined,
  mode: ProviderInteractionMode,
): boolean {
  const supported = provider?.interactionModes ?? ALL_INTERACTION_MODES;
  return supported.includes(mode);
}
