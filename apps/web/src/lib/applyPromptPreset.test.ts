import { beforeEach, describe, expect, it } from "vite-plus/test";
import {
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  type ServerProvider,
} from "@t3tools/contracts";
import { DEFAULT_UNIFIED_SETTINGS, type UnifiedSettings } from "@t3tools/contracts/settings";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { createModelSelection } from "@t3tools/shared/model";

import { readComposerThreadDraft, useComposerDraftStore } from "../composerDraftStore";
import { applyPromptPresetToComposer, composerDraftToPromptPresetDraft } from "./applyPromptPreset";
import { buildPromptPreset } from "@t3tools/client-runtime/promptPresets";
import { DraftId } from "../composerDraftStore";
import {
  getActiveComposerDraftTarget,
  registerActiveComposerDraftTarget,
} from "../activeComposerDraftTarget";
import { getCustomModelOptionsByInstance } from "../modelSelection";

const codex = ProviderInstanceId.make("codex");
const target = scopeThreadRef(EnvironmentId.make("env"), ThreadId.make("thread"));
const providers: readonly ServerProvider[] = [
  {
    instanceId: codex,
    driver: ProviderDriverKind.make("codex"),
    enabled: true,
    installed: true,
    version: null,
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: "2026-01-01T00:00:00.000Z",
    models: [
      { slug: "old", name: "Old", isCustom: false, capabilities: {} },
      { slug: "new", name: "New", isCustom: false, capabilities: {}, aliases: ["new-alias"] },
    ],
    slashCommands: [],
    skills: [],
  },
];

beforeEach(() => useComposerDraftStore.setState({ draftsByThreadKey: {} }));

describe("preset composer application", () => {
  it.each(["new", "new-alias"])(
    "rejects a hidden built-in model or alias (%s) before mutation",
    (model) => {
      useComposerDraftStore.getState().setPrompt(target, "Original task");
      const original = readComposerThreadDraft(target);
      const settings = {
        ...DEFAULT_UNIFIED_SETTINGS,
        providerModelPreferences: { [codex]: { hiddenModels: ["new"], modelOrder: [] } },
      };
      expect(
        getCustomModelOptionsByInstance(settings, providers)
          .get(codex)
          ?.map((option) => option.slug),
      ).toEqual(["old"]);
      const result = applyPromptPresetToComposer({
        settings,
        threadRef: target,
        draft: original,
        providers,
        presets: [
          {
            id: "hidden",
            name: "Hidden",
            instructions: "New task",
            providerInstanceId: codex,
            model,
            runtimeMode: "auto",
          },
        ],
        presetId: "hidden",
        disposition: "replace",
      });
      expect(result).toMatchObject({ ok: false, code: "model" });
      expect(readComposerThreadDraft(target)).toEqual(original);
    },
  );

  it("revalidates a cached palette action against current model preferences", () => {
    useComposerDraftStore.getState().setPrompt(target, "Original task");
    const original = readComposerThreadDraft(target);
    const active = {
      environmentId: target.environmentId,
      threadRef: target,
      effectiveAgentSettings: {
        providerInstanceId: codex,
        model: "old",
        runtimeMode: null,
        interactionMode: null,
      },
      threadState: { hasStartedSession: false },
    };
    const unregister = registerActiveComposerDraftTarget(active);
    let settings: UnifiedSettings = DEFAULT_UNIFIED_SETTINGS;
    const cachedAction = () =>
      applyPromptPresetToComposer({
        settings,
        threadRef: target,
        draft: readComposerThreadDraft(target),
        providers,
        presets: [
          {
            id: "saved",
            name: "Saved",
            instructions: "New task",
            providerInstanceId: codex,
            model: "new-alias",
          },
        ],
        presetId: "saved",
        disposition: "insert",
        expectedActiveTarget: active,
      });
    settings = {
      ...settings,
      providerModelPreferences: { [codex]: { hiddenModels: ["new"], modelOrder: [] } },
    };
    expect(cachedAction()).toMatchObject({ ok: false, code: "model" });
    expect(readComposerThreadDraft(target)).toEqual(original);
    settings = DEFAULT_UNIFIED_SETTINGS;
    expect(cachedAction().ok).toBe(true);
    expect(readComposerThreadDraft(target).prompt).toBe("Original task\n\nNew task");
    unregister();
  });

  it.each(["new-alias", "custom-model"])(
    "accepts the effective custom instance model (%s)",
    (model) => {
      const instanceId = ProviderInstanceId.make("codex_custom");
      const catalog = [...providers, { ...providers[0]!, instanceId }];
      const settings = {
        ...DEFAULT_UNIFIED_SETTINGS,
        providerInstances: {
          [instanceId]: {
            driver: ProviderDriverKind.make("codex"),
            config: { customModels: ["custom-model"] },
          },
        },
        providerModelPreferences: {
          [codex]: { hiddenModels: ["new"], modelOrder: [] },
          [instanceId]: { hiddenModels: ["custom-model"], modelOrder: [] },
        },
      };
      const result = applyPromptPresetToComposer({
        settings,
        threadRef: target,
        draft: readComposerThreadDraft(target),
        providers: catalog,
        presets: [
          {
            id: "custom",
            name: "Custom",
            instructions: "Task",
            providerInstanceId: instanceId,
            model,
          },
        ],
        presetId: "custom",
        disposition: "replace",
      });
      expect(result.ok).toBe(true);
      expect(readComposerThreadDraft(target).modelSelectionByProvider[instanceId]?.model).toBe(
        model,
      );
      const original = readComposerThreadDraft(target);
      const wrongInstance = applyPromptPresetToComposer({
        settings,
        threadRef: target,
        draft: original,
        providers: catalog,
        presets: [
          {
            id: "wrong",
            name: "Wrong",
            instructions: "Wrong task",
            providerInstanceId: codex,
            model,
          },
        ],
        presetId: "wrong",
        disposition: "replace",
      });
      expect(wrongInstance).toMatchObject({ ok: false, code: "model" });
      expect(readComposerThreadDraft(target)).toEqual(original);
    },
  );

  it("rejects a removed custom model still present in the raw catalog", () => {
    useComposerDraftStore.getState().setPrompt(target, "Original task");
    const original = readComposerThreadDraft(target);
    const catalog = [
      {
        ...providers[0]!,
        models: [
          ...providers[0]!.models,
          { slug: "removed", name: "Removed", isCustom: true, capabilities: {} },
        ],
      },
    ];
    const settings = {
      ...DEFAULT_UNIFIED_SETTINGS,
      providerInstances: {
        [codex]: { driver: ProviderDriverKind.make("codex"), config: { customModels: [] } },
      },
    };
    const result = applyPromptPresetToComposer({
      settings,
      threadRef: target,
      draft: original,
      providers: catalog,
      presets: [
        {
          id: "removed",
          name: "Removed",
          instructions: "New task",
          providerInstanceId: codex,
          model: "removed",
        },
      ],
      presetId: "removed",
      disposition: "replace",
    });
    expect(result).toMatchObject({ ok: false, code: "model" });
    expect(readComposerThreadDraft(target)).toEqual(original);
  });

  it("rejects cached agent-setting actions after the composer enters fanout mode", () => {
    useComposerDraftStore.getState().setPrompt(target, "Original task");
    const original = readComposerThreadDraft(target);
    const active = {
      environmentId: target.environmentId,
      threadRef: target,
      effectiveAgentSettings: {
        providerInstanceId: codex,
        model: "old",
        runtimeMode: "full-access" as const,
        interactionMode: "default" as const,
      },
      threadState: { hasStartedSession: false },
    };
    const unregister = registerActiveComposerDraftTarget(active);
    const cached = () =>
      applyPromptPresetToComposer({
        threadRef: target,
        draft: readComposerThreadDraft(target),
        presets: [
          { id: "settings", name: "Settings", instructions: "New task", runtimeMode: "auto" },
        ],
        presetId: "settings",
        disposition: "replace",
        providers,
        expectedActiveTarget: active,
        settings: DEFAULT_UNIFIED_SETTINGS,
      });
    const unregisterFanout = registerActiveComposerDraftTarget({
      ...active,
      threadState: { ...active.threadState, isMultiModel: true },
    });
    expect(cached()).toMatchObject({ ok: false, code: "agent-settings" });
    expect(readComposerThreadDraft(target)).toEqual(original);
    unregister();
    unregisterFanout();
  });
  it("rejects a cached palette preset on a server without advertised support", () => {
    useComposerDraftStore.getState().setPrompt(target, "Original task");
    const original = readComposerThreadDraft(target);
    const result = applyPromptPresetToComposer({
      threadRef: target,
      draft: original,
      presets: [{ id: "text", name: "Text", instructions: "Hidden write" }],
      presetId: "text",
      disposition: "replace",
      providers,
      serverSupportsPromptPresets: false,
      settings: DEFAULT_UNIFIED_SETTINGS,
    });
    expect(result).toMatchObject({ ok: false, code: "unsupported" });
    expect(readComposerThreadDraft(target)).toEqual(original);
  });
  it.each(["missing", "signed out", "missing CLI"] as const)(
    "rejects a Plan-only preset with Plan disabled and a %s provider",
    (providerState) => {
      useComposerDraftStore.getState().setPrompt(target, "Original task");
      const original = readComposerThreadDraft(target);
      const result = applyPromptPresetToComposer({
        threadRef: target,
        draft: original,
        effectiveAgentSettings: {
          providerInstanceId: codex,
          model: "old",
          runtimeMode: null,
          interactionMode: null,
        },
        presets: [{ id: "plan", name: "Plan", instructions: "Plan task", interactionMode: "plan" }],
        presetId: "plan",
        disposition: "replace",
        providers:
          providerState === "missing"
            ? []
            : [
                {
                  ...providers[0]!,
                  installed: providerState !== "missing CLI",
                  auth: {
                    status: providerState === "signed out" ? "unauthenticated" : "authenticated",
                  },
                },
              ],
        planModeEnabled: false,
        settings: DEFAULT_UNIFIED_SETTINGS,
      });
      expect(result).toMatchObject({ ok: false, code: "interaction-mode" });
      expect(readComposerThreadDraft(target)).toEqual(original);
    },
  );
  it("uses the live client preference when a cached palette action outlives a Plan toggle", () => {
    const store = useComposerDraftStore.getState();
    store.setPrompt(target, "Original task");
    const original = readComposerThreadDraft(target);
    const active = {
      environmentId: target.environmentId,
      threadRef: target,
      effectiveAgentSettings: {
        providerInstanceId: codex,
        model: "old",
        runtimeMode: "full-access" as const,
        interactionMode: "default" as const,
      },
      threadState: { hasStartedSession: false },
      planModeEnabled: true,
    };
    const unregister = registerActiveComposerDraftTarget(active);
    const cachedAction = () =>
      applyPromptPresetToComposer({
        threadRef: target,
        draft: readComposerThreadDraft(target),
        presets: [{ id: "plan", name: "Plan", instructions: "Plan task", interactionMode: "plan" }],
        presetId: "plan",
        disposition: "replace",
        providers,
        expectedActiveTarget: active,
        planModeEnabled: true,
        settings: DEFAULT_UNIFIED_SETTINGS,
      });
    const unregisterDisabled = registerActiveComposerDraftTarget({
      ...active,
      planModeEnabled: false,
    });
    expect(cachedAction()).toMatchObject({ ok: false, code: "interaction-mode" });
    expect(readComposerThreadDraft(target)).toEqual(original);
    unregister();
    unregisterDisabled();
  });
  it.each([false, true])(
    "respects web plan availability (%s) without a latent override",
    (planModeEnabled) => {
      useComposerDraftStore.getState().setPrompt(target, "Original task");
      const original = readComposerThreadDraft(target);
      const result = applyPromptPresetToComposer({
        threadRef: target,
        draft: original,
        presets: [
          {
            id: "plan",
            name: "Plan",
            instructions: "Plan task",
            providerInstanceId: codex,
            model: "old",
            interactionMode: "plan",
          },
        ],
        presetId: "plan",
        disposition: "replace",
        providers,
        planModeEnabled,
        settings: DEFAULT_UNIFIED_SETTINGS,
      });
      expect(result.ok).toBe(planModeEnabled);
      if (planModeEnabled)
        expect(readComposerThreadDraft(target)).toMatchObject({
          prompt: "Plan task",
          interactionMode: "plan",
        });
      else {
        expect(result).toMatchObject({ code: "interaction-mode" });
        expect(readComposerThreadDraft(target)).toEqual(original);
      }
    },
  );
  it("rejects a cached palette action after pending input removes the active composer", () => {
    const store = useComposerDraftStore.getState();
    store.setPrompt(target, "Hidden ordinary draft");
    const activeTarget = {
      environmentId: target.environmentId,
      threadRef: target,
      effectiveAgentSettings: {
        providerInstanceId: codex,
        model: "old",
        runtimeMode: "full-access" as const,
        interactionMode: "default" as const,
      },
      threadState: { hasStartedSession: false },
    };
    const unregister = registerActiveComposerDraftTarget(activeTarget);
    const cachedAction = () =>
      applyPromptPresetToComposer({
        threadRef: target,
        draft: readComposerThreadDraft(target),
        expectedActiveTarget: activeTarget,
        settings: DEFAULT_UNIFIED_SETTINGS,
        presets: [{ id: "text", name: "Text", instructions: "Wrong target" }],
        presetId: "text",
        disposition: "replace",
        providers,
      });
    unregister();
    expect(cachedAction()).toMatchObject({ ok: false, code: "missing" });
    expect(readComposerThreadDraft(target).prompt).toBe("Hidden ordinary draft");
  });

  it("records explicit preset choices even when they match inherited defaults", () => {
    const result = applyPromptPresetToComposer({
      planModeEnabled: true,
      settings: DEFAULT_UNIFIED_SETTINGS,
      threadRef: target,
      draft: readComposerThreadDraft(target),
      effectiveAgentSettings: {
        providerInstanceId: codex,
        model: "old",
        runtimeMode: "full-access",
        interactionMode: "plan",
      },
      presets: [
        {
          id: "same",
          name: "Same",
          instructions: "Task",
          providerInstanceId: codex,
          model: "old",
          runtimeMode: "full-access",
          interactionMode: "plan",
        },
      ],
      presetId: "same",
      disposition: "replace",
      providers,
    });
    expect(result.ok).toBe(true);
    const stored = composerDraftToPromptPresetDraft(readComposerThreadDraft(target));
    expect({
      providerInstanceId: stored.providerInstanceId,
      model: stored.model,
      runtimeMode: stored.runtimeMode,
      interactionMode: stored.interactionMode,
    }).toEqual({
      providerInstanceId: codex,
      model: "old",
      runtimeMode: "full-access",
      interactionMode: "plan",
    });
  });

  it("leaves inherited settings implicit when a preset contains only instructions", () => {
    const result = applyPromptPresetToComposer({
      settings: DEFAULT_UNIFIED_SETTINGS,
      threadRef: target,
      draft: readComposerThreadDraft(target),
      effectiveAgentSettings: {
        providerInstanceId: codex,
        model: "old",
        runtimeMode: "full-access",
        interactionMode: "plan",
      },
      presets: [{ id: "text", name: "Text", instructions: "Task" }],
      presetId: "text",
      disposition: "replace",
      providers,
    });
    expect(result.ok).toBe(true);
    const stored = composerDraftToPromptPresetDraft(readComposerThreadDraft(target));
    expect({
      providerInstanceId: stored.providerInstanceId,
      model: stored.model,
      runtimeMode: stored.runtimeMode,
      interactionMode: stored.interactionMode,
    }).toEqual({ providerInstanceId: null, model: null, runtimeMode: null, interactionMode: null });
    expect(stored.text).toBe("Task");
  });

  it("saves the displayed settings when the draft has no explicit overrides", () => {
    const saved = buildPromptPreset({
      id: "saved",
      name: "Saved",
      instructions: "Task",
      includeAgentSettings: true,
      draft: composerDraftToPromptPresetDraft(readComposerThreadDraft(target), {
        providerInstanceId: codex,
        model: "old",
        runtimeMode: "full-access",
        interactionMode: "plan",
      }),
    });
    expect(saved).toEqual({
      id: "saved",
      name: "Saved",
      instructions: "Task",
      providerInstanceId: codex,
      model: "old",
      runtimeMode: "full-access",
      interactionMode: "plan",
    });
  });

  it("applies to the visible queued edit while preserving the ordinary draft", () => {
    const queuedTarget = DraftId.make("queued-edit:env:thread:run");
    useComposerDraftStore.getState().setPrompt(target, "Ordinary draft");
    useComposerDraftStore.getState().setPrompt(queuedTarget, "Queued draft");
    const unregister = registerActiveComposerDraftTarget({
      environmentId: target.environmentId,
      threadRef: queuedTarget,
      effectiveAgentSettings: {
        providerInstanceId: codex,
        model: "old",
        runtimeMode: "full-access",
        interactionMode: "default",
      },
      threadState: {
        hasStartedSession: true,
        isQueuedEdit: true,
        supportsProviderSwitchingViaHandoff: true,
      },
    });
    const active = getActiveComposerDraftTarget()!;
    const result = applyPromptPresetToComposer({
      ...active,
      settings: DEFAULT_UNIFIED_SETTINGS,
      draft: readComposerThreadDraft(active.threadRef),
      presets: [{ id: "text", name: "Text", instructions: "New instructions" }],
      presetId: "text",
      disposition: "insert",
      providers,
    });
    expect(result.ok).toBe(true);
    expect(readComposerThreadDraft(queuedTarget).prompt).toBe("Queued draft\n\nNew instructions");
    expect(readComposerThreadDraft(target).prompt).toBe("Ordinary draft");
    unregister();
  });

  it("clears old model options when switching to the preset model", () => {
    useComposerDraftStore
      .getState()
      .setModelSelection(
        target,
        createModelSelection(codex, "old", [{ id: "effort", value: "high" }]),
        { explicit: true },
      );
    const result = applyPromptPresetToComposer({
      settings: DEFAULT_UNIFIED_SETTINGS,
      threadRef: target,
      draft: readComposerThreadDraft(target),
      presets: [
        {
          id: "new",
          name: "New",
          instructions: "New task",
          providerInstanceId: codex,
          model: "new",
        },
      ],
      presetId: "new",
      disposition: "replace",
      providers,
    });
    expect(result.ok).toBe(true);
    expect(readComposerThreadDraft(target).modelSelectionByProvider[codex]).toEqual({
      instanceId: codex,
      model: "new",
    });
    expect(readComposerThreadDraft(target).prompt).toBe("New task");
  });

  it("validates a model-only preset against the displayed implicit provider", () => {
    const result = applyPromptPresetToComposer({
      settings: DEFAULT_UNIFIED_SETTINGS,
      threadRef: target,
      draft: readComposerThreadDraft(target),
      effectiveAgentSettings: {
        providerInstanceId: codex,
        model: "old",
        runtimeMode: "full-access",
        interactionMode: "default",
      },
      presets: [{ id: "new", name: "New", instructions: "New task", model: "new" }],
      presetId: "new",
      disposition: "replace",
      providers,
    });
    expect(result.ok).toBe(true);
    expect(readComposerThreadDraft(target).modelSelectionByProvider[codex]).toEqual({
      instanceId: codex,
      model: "new",
    });
    expect(readComposerThreadDraft(target).prompt).toBe("New task");
  });
});
