import { beforeEach, describe, expect, it } from "vite-plus/test";
import { EnvironmentId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
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

const codex = ProviderInstanceId.make("codex");
const target = scopeThreadRef(EnvironmentId.make("env"), ThreadId.make("thread"));
const providers = [
  {
    instanceId: codex,
    enabled: true,
    models: [{ slug: "old" }, { slug: "new" }],
  },
];

beforeEach(() => useComposerDraftStore.setState({ draftsByThreadKey: {} }));

describe("preset composer application", () => {
  it("records explicit preset choices even when they match inherited defaults", () => {
    const result = applyPromptPresetToComposer({
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
