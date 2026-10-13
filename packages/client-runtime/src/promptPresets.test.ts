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
  createPromptPresetId,
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
  it.each(["insert", "replace"] as const)(
    "strips legacy preset references on %s while preserving destination context",
    (disposition) => {
      const current = draft({ text: "Keep [local](t3-context://v1/file/local)" });
      const result = applyPromptPreset({
        draft: current,
        presets: [
          preset({
            instructions:
              "Inspect [log](t3-context://v1/terminal/old), [src/app.ts](t3-context://v1/file/local), ![shot.png](t3-context://v1/image/old_image), and [Prior chat](t3-context://v1/thread/thread_a).",
          }),
        ],
        presetId: "plan",
        disposition,
        capabilities,
      });
      expect(result).toEqual({
        ok: true,
        value: {
          ...current,
          text:
            disposition === "replace"
              ? "Inspect log, src/app.ts, shot.png, and Prior chat."
              : current.text + "\n\nInspect log, src/app.ts, shot.png, and Prior chat.",
        },
      });
      if (result.ok) {
        expect(result.value.context).toBe(current.context);
        expect(result.value.attachments).toBe(current.attachments);
      }
    },
  );

  it("rejects agent settings during queued editing before changing the prompt", () => {
    const current = draft();
    const result = applyPromptPreset({
      draft: current,
      presets: [preset({ runtimeMode: "approval-required" })],
      presetId: "plan",
      disposition: "replace",
      capabilities,
      threadState: { hasStartedSession: true, isQueuedEdit: true },
    });
    expect(result).toEqual({
      ok: false,
      code: "agent-settings",
      message:
        "Queued message editing supports instructions only. Choose a preset without agent settings.",
    });
    expect(current.text).toBe("keep this");
  });

  it("rejects provider changes on started threads without changing their prompt", () => {
    const current = draft();
    const result = applyPromptPreset({
      draft: current,
      presets: [preset({ providerInstanceId: claude, model: "opus" })],
      presetId: "plan",
      disposition: "replace",
      capabilities,
      threadState: { hasStartedSession: true, supportsProviderSwitchingViaHandoff: false },
    });
    expect(result).toEqual({
      ok: false,
      code: "provider",
      message:
        "This thread does not support switching providers after it has started. Start a new thread to use this preset's model.",
    });
    expect(current.text).toBe("keep this");
  });

  it("permits provider changes when the started thread supports handoff", () => {
    const result = applyPromptPreset({
      draft: draft(),
      presets: [preset({ providerInstanceId: claude, model: "opus" })],
      presetId: "plan",
      disposition: "replace",
      capabilities,
      threadState: { hasStartedSession: true, supportsProviderSwitchingViaHandoff: true },
    });
    expect(result).toEqual({
      ok: true,
      value: draft({ text: "Write a plan.", providerInstanceId: claude, model: "opus" }),
    });
  });

  it("rejects same-provider model changes when a new thread is required", () => {
    const result = applyPromptPreset({
      draft: draft(),
      presets: [preset({ model: "next" })],
      presetId: "plan",
      disposition: "replace",
      capabilities: {
        providers: [
          { instanceId: codex, models: ["gpt-5", "next"], requiresNewThreadForModelChange: true },
        ],
      },
      threadState: { hasStartedSession: true, supportsProviderSwitchingViaHandoff: true },
    });
    expect(result).toEqual({
      ok: false,
      code: "model",
      message:
        "This provider does not allow switching models after a conversation has started. Start a new thread to use this preset's model.",
    });
  });

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
  it("saves context chips as plain labels and preserves unrelated text and links", () => {
    const instructions =
      "Inspect [Build output](t3-context://v1/terminal/log), [src/app.ts](t3-context://v1/file/local), ![shot.png](t3-context://v1/image/img), and [Prior chat](t3-context://v1/thread/thread_a). Keep [docs](https://example.com/docs) and literal t3-context text.";
    const saved = buildPromptPreset({
      id: "portable",
      name: "Portable",
      instructions,
      includeAgentSettings: false,
      draft: draft(),
    });
    expect(saved.instructions).toBe(
      "Inspect Build output, src/app.ts, shot.png, and Prior chat. Keep [docs](https://example.com/docs) and literal t3-context text.",
    );
    expect(saved).not.toHaveProperty("context");
  });

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

  it("removes excluded agent settings from an existing preset", () => {
    const previous = preset({
      providerInstanceId: codex,
      model: "gpt-5",
      runtimeMode: "full-access",
      interactionMode: "plan",
    });
    const kept = buildPromptPreset({
      id: previous.id,
      name: "Plan",
      instructions: previous.instructions,
      includeAgentSettings: false,
      draft: draft({ providerInstanceId: claude, model: "opus", runtimeMode: "approval-required" }),
    });
    expect(kept).toEqual({ id: "plan", name: "Plan", instructions: "Write a plan." });
    expect(savePromptPreset([previous], kept)).toEqual({
      ok: true,
      value: [{ id: "plan", name: "Plan", instructions: "Write a plan." }],
    });
    const replaced = buildPromptPreset({
      id: previous.id,
      name: "Plan",
      instructions: "next",
      includeAgentSettings: true,
      draft: draft({ providerInstanceId: claude, model: "opus", runtimeMode: "approval-required" }),
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

  it.each([
    ["missing CLI", false, "authenticated", false],
    ["signed out", true, "unauthenticated", false],
    ["unknown authentication", true, "unknown", true],
    ["ready", true, "authenticated", true],
  ] as const)("matches picker eligibility for %s providers", (_, installed, status, usable) => {
    const providers = [
      {
        instanceId: codex,
        enabled: true,
        installed,
        auth: { status },
        models: [{ slug: "gpt-5" }],
      },
    ];
    const current = draft();
    const result = applyPromptPreset({
      draft: current,
      presets: [preset({ providerInstanceId: codex, model: "gpt-5" })],
      presetId: "plan",
      disposition: "replace",
      capabilities: promptPresetCapabilitiesFromProviders(providers),
    });
    expect(result.ok).toBe(usable);
    if (!usable) expect(result).toMatchObject({ code: "provider" });
    expect(current).toEqual(draft());
  });

  it("accepts catalog aliases when validating preset models", () => {
    const aliased = promptPresetCapabilitiesFromProviders([
      {
        instanceId: codex,
        enabled: true,
        models: [{ slug: "gpt-5", aliases: ["gpt-5-legacy"] }],
      },
    ]);
    const result = applyPromptPreset({
      draft: draft({ model: "gpt-5" }),
      presets: [preset({ model: "gpt-5-legacy" })],
      presetId: "plan",
      disposition: "insert",
      capabilities: aliased,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.model).toBe("gpt-5-legacy");
  });
});

describe("createPromptPresetId", () => {
  it("returns an RFC 4122 version-4 UUID from getRandomValues", () => {
    expect(createPromptPresetId()).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });
});

const decodeServerSettings = Schema.decodeSync(ServerSettings);

describe("prompt preset persistence", () => {
  it("defaults missing presets to an empty environment-owned list", () => {
    expect(decodeServerSettings({}).promptPresets).toEqual([]);
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
