import {
  DEFAULT_SERVER_SETTINGS,
  ProviderInstanceId,
  ServerSettings,
  type PromptPreset,
} from "@t3tools/contracts";
import { applyServerSettingsPatch } from "@t3tools/shared/serverSettings";
import { splitSharedServerPatch } from "./state/sharedSettings.ts";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import {
  applyPromptPreset,
  buildPromptPreset,
  deletePromptPreset,
  promptPresetCapabilitiesFromProviders,
  savePromptPreset,
  type PromptPresetCapabilities,
  type PromptPresetDraft,
} from "./promptPresets.ts";

const codex = ProviderInstanceId.make("codex");
const claude = ProviderInstanceId.make("claude");

const capabilities: PromptPresetCapabilities = {
  providers: [
    {
      instanceId: codex,
      models: ["gpt-5"],
      runtimeModes: ["full-access", "approval-required"],
      interactionModes: ["default", "plan"],
    },
    {
      instanceId: claude,
      models: ["opus"],
      runtimeModes: ["full-access"],
      interactionModes: ["default"],
    },
  ],
};

function draft(overrides: Partial<PromptPresetDraft> = {}): PromptPresetDraft {
  return {
    text: "keep this",
    attachments: [{ id: "file" }],
    context: [{ id: "terminal" }],
    providerInstanceId: codex,
    model: "gpt-5",
    runtimeMode: "full-access",
    interactionMode: "default",
    ...overrides,
  };
}

function preset(overrides: Partial<PromptPreset> = {}): PromptPreset {
  return {
    id: "plan",
    name: "Plan",
    instructions: "Write a plan.",
    ...overrides,
  };
}

describe("applyPromptPreset", () => {
  it("inserts instructions and keeps attachments, context, and omitted settings", () => {
    const current = draft();
    const result = applyPromptPreset({
      draft: current,
      presets: [preset()],
      presetId: "plan",
      disposition: "insert",
      capabilities,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.text).toBe("keep this\n\nWrite a plan.");
    expect(result.value.attachments).toBe(current.attachments);
    expect(result.value.context).toBe(current.context);
    expect(result.value.providerInstanceId).toBe(codex);
    expect(result.value.model).toBe("gpt-5");
    expect(result.value.runtimeMode).toBe("full-access");
    expect(result.value.interactionMode).toBe("default");
    expect(current.text).toBe("keep this");
  });

  it("replaces prompt text only when replacement is explicit", () => {
    const current = draft();
    const result = applyPromptPreset({
      draft: current,
      presets: [preset({ instructions: "Replacement" })],
      presetId: "plan",
      disposition: "replace",
      capabilities,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.text).toBe("Replacement");
    expect(result.value.attachments).toBe(current.attachments);
    expect(result.value.context).toBe(current.context);
  });

  it("overrides only the agent settings a preset sets", () => {
    const result = applyPromptPreset({
      draft: draft(),
      presets: [preset({ runtimeMode: "approval-required", interactionMode: "plan" })],
      presetId: "plan",
      disposition: "insert",
      capabilities,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.runtimeMode).toBe("approval-required");
    expect(result.value.interactionMode).toBe("plan");
    expect(result.value.providerInstanceId).toBe(codex);
    expect(result.value.model).toBe("gpt-5");
  });

  it("leaves the draft unchanged when the preset was deleted", () => {
    const current = draft();
    const result = applyPromptPreset({
      draft: current,
      presets: [],
      presetId: "gone",
      disposition: "replace",
      capabilities,
    });
    expect(result).toMatchObject({ ok: false, code: "missing" });
    expect(current).toEqual(draft());
  });

  it("does not switch provider when the provider, model, or mode is unavailable", () => {
    const current = draft();
    const cases = [
      preset({ id: "provider", providerInstanceId: ProviderInstanceId.make("missing") }),
      preset({ id: "model", model: "opus" }),
      preset({
        id: "other-provider-model",
        providerInstanceId: claude,
        model: "gpt-5",
      }),
      preset({ id: "mode", runtimeMode: "auto" }),
      preset({
        id: "plan-mode",
        providerInstanceId: claude,
        model: "opus",
        interactionMode: "plan",
      }),
    ] as const;
    for (const entry of cases) {
      const result = applyPromptPreset({
        draft: current,
        presets: [entry],
        presetId: entry.id,
        disposition: "replace",
        capabilities,
      });
      expect(result.ok).toBe(false);
      expect(current).toEqual(draft());
    }
    expect(
      applyPromptPreset({
        draft: current,
        presets: [cases[0]],
        presetId: "provider",
        disposition: "replace",
        capabilities,
      }),
    ).toMatchObject({ code: "provider" });
    expect(
      applyPromptPreset({
        draft: current,
        presets: [cases[1]],
        presetId: "model",
        disposition: "replace",
        capabilities,
      }),
    ).toMatchObject({ code: "model" });
    expect(
      applyPromptPreset({
        draft: current,
        presets: [cases[3]],
        presetId: "mode",
        disposition: "replace",
        capabilities,
      }),
    ).toMatchObject({ code: "runtime-mode" });
    expect(
      applyPromptPreset({
        draft: current,
        presets: [cases[4]],
        presetId: "plan-mode",
        disposition: "replace",
        capabilities,
      }),
    ).toMatchObject({ code: "interaction-mode" });
  });

  it("applies an available provider and model together", () => {
    const result = applyPromptPreset({
      draft: draft(),
      presets: [preset({ providerInstanceId: claude, model: "opus" })],
      presetId: "plan",
      disposition: "insert",
      capabilities,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.providerInstanceId).toBe(claude);
    expect(result.value.model).toBe("opus");
    expect(result.value.runtimeMode).toBe("full-access");
  });

  it("does not switch provider when the current mode is unavailable there", () => {
    const current = draft({ runtimeMode: "approval-required" });
    const result = applyPromptPreset({
      draft: current,
      presets: [preset({ providerInstanceId: claude, model: "opus" })],
      presetId: "plan",
      disposition: "replace",
      capabilities,
    });
    expect(result).toMatchObject({ ok: false, code: "runtime-mode" });
    expect(current.text).toBe("keep this");
    expect(current.providerInstanceId).toBe(codex);
  });
});

describe("prompt preset records", () => {
  it("rejects an empty name and a full list, and edits by id", () => {
    const saved = savePromptPreset([], preset());
    expect(saved.ok).toBe(true);
    if (!saved.ok) return;
    const renamed = savePromptPreset(saved.value, preset({ name: "Review" }));
    expect(renamed.ok).toBe(true);
    if (!renamed.ok) return;
    expect(renamed.value).toEqual([preset({ name: "Review" })]);
    expect(savePromptPreset([], preset({ name: "   " })).ok).toBe(false);
    const full = Array.from({ length: 32 }, (_, index) => preset({ id: `p-${index}` }));
    expect(savePromptPreset(full, preset({ id: "overflow" }))).toMatchObject({ code: "full" });
    expect(deletePromptPreset(renamed.value, "plan")).toEqual([]);
    expect(deletePromptPreset(renamed.value, "missing")).toEqual(renamed.value);
  });

  it("keeps previous agent settings unless the draft settings are included", () => {
    const previous = preset({
      providerInstanceId: codex,
      model: "gpt-5",
      runtimeMode: "full-access",
    });
    const kept = buildPromptPreset({
      id: previous.id,
      name: "Plan",
      instructions: previous.instructions,
      includeAgentSettings: false,
      draft: draft({ providerInstanceId: claude, model: "opus", runtimeMode: "approval-required" }),
      previous,
    });
    expect(kept.providerInstanceId).toBe(codex);
    expect(kept.model).toBe("gpt-5");
    const replaced = buildPromptPreset({
      id: previous.id,
      name: "Plan",
      instructions: "next",
      includeAgentSettings: true,
      draft: draft({ providerInstanceId: claude, model: "opus", runtimeMode: "approval-required" }),
      previous,
    });
    expect(replaced).toMatchObject({
      instructions: "next",
      providerInstanceId: claude,
      model: "opus",
      runtimeMode: "approval-required",
    });
  });

  it("hides disabled providers from capability checks", () => {
    expect(
      promptPresetCapabilitiesFromProviders([
        {
          instanceId: codex,
          enabled: false,
          models: [{ slug: "gpt-5" }],
        },
        {
          instanceId: claude,
          enabled: true,
          availability: "unavailable",
          models: [{ slug: "opus" }],
        },
      ]).providers,
    ).toEqual([]);
  });
});

describe("prompt preset persistence", () => {
  it("defaults missing presets to an empty environment-owned list", () => {
    expect(Schema.decodeSync(ServerSettings)({}).promptPresets).toEqual([]);
    expect(DEFAULT_SERVER_SETTINGS.promptPresets).toEqual([]);
  });

  it("keeps presets on the environment that stored them", () => {
    const owned = preset();
    const other = preset({ id: "other", name: "Other" });
    const left = { ...DEFAULT_SERVER_SETTINGS, promptPresets: [owned] };
    const right = { ...DEFAULT_SERVER_SETTINGS, promptPresets: [other] };
    const cleared = applyServerSettingsPatch(left, { promptPresets: [] });
    expect(cleared.promptPresets).toEqual([]);
    expect(left.promptPresets).toEqual([owned]);
    expect(right.promptPresets).toEqual([other]);
    const split = splitSharedServerPatch({
      promptPresets: [owned],
      sidebarAutoSettleOnMerge: false,
    });
    expect(split.localPatch.promptPresets).toEqual([owned]);
    expect(split.sharedPatch).not.toHaveProperty("promptPresets");
  });
});
