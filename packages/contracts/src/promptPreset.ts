import * as Schema from "effect/Schema";

import { TrimmedNonEmptyString } from "./baseSchemas.ts";
import { ProviderInstanceId } from "./providerInstance.ts";
import { ProviderInteractionMode, RuntimeMode } from "./providerPolicy.ts";

export const MAX_PROMPT_PRESETS = 32;
const MAX_PROMPT_PRESET_NAME_LENGTH = 80;
const MAX_PROMPT_PRESET_INSTRUCTIONS_LENGTH = 16_000;

export const PromptPresetId = TrimmedNonEmptyString.check(Schema.isMaxLength(64));
export const PromptPreset = Schema.Struct({
  id: PromptPresetId,
  name: TrimmedNonEmptyString.check(Schema.isMaxLength(MAX_PROMPT_PRESET_NAME_LENGTH)),
  instructions: Schema.String.check(Schema.isMaxLength(MAX_PROMPT_PRESET_INSTRUCTIONS_LENGTH)),
  providerInstanceId: Schema.optional(ProviderInstanceId),
  model: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(200))),
  runtimeMode: Schema.optional(RuntimeMode),
  interactionMode: Schema.optional(ProviderInteractionMode),
});
export type PromptPreset = typeof PromptPreset.Type;

export const PromptPresets = Schema.Array(PromptPreset).check(
  Schema.isMaxLength(MAX_PROMPT_PRESETS),
);
export type PromptPresets = typeof PromptPresets.Type;
