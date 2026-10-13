// @vitest-environment jsdom
import { act, useLayoutEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { EnvironmentId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

const mocks = vi.hoisted(() => ({
  update: vi.fn(),
  toast: vi.fn(),
  presets: [{ id: "text", name: "Text", instructions: "Preset instructions" }],
}));
vi.mock("../../hooks/useSettings", () => ({
  useEnvironmentSettings: () => mocks.presets,
}));
vi.mock("../../state/use-atom-command", () => ({ useAtomCommand: () => mocks.update }));
vi.mock("../../state/server", () => ({ serverEnvironment: { updateSettings: "update" } }));
vi.mock("../ui/toast", () => ({ toastManager: { add: mocks.toast } }));

import { useComposerPromptPresets } from "./useComposerPromptPresets";
import { getActiveComposerDraftTarget } from "../../activeComposerDraftTarget";
import { readComposerThreadDraft, useComposerDraftStore } from "../../composerDraftStore";
import { applyPromptPresetToComposer } from "../../lib/applyPromptPreset";

const environmentId = EnvironmentId.make("env");
const target = scopeThreadRef(environmentId, ThreadId.make("thread"));
const effectiveAgentSettings = {
  providerInstanceId: ProviderInstanceId.make("codex"),
  model: "test-model",
  runtimeMode: "full-access" as const,
  interactionMode: "default" as const,
};
let root: Root;
let container: HTMLDivElement;
let actions: ReturnType<typeof useComposerPromptPresets>;

function Composer({ enabled }: { enabled: boolean }) {
  const state = useComposerPromptPresets({
    environmentId,
    threadRef: target,
    draft: readComposerThreadDraft(target),
    providers: [],
    effectiveAgentSettings,
    threadState: { hasStartedSession: false },
    enabled,
  });
  useLayoutEffect(() => {
    actions = state;
  });
  return null;
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  mocks.update.mockClear();
  useComposerDraftStore.setState({ draftsByThreadKey: {} });
  useComposerDraftStore.getState().setPrompt(target, "Hidden ordinary draft");
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

it("removes the palette target during pending input and restores it when the ordinary composer returns", async () => {
  await act(() => root.render(<Composer enabled />));
  expect(getActiveComposerDraftTarget()?.threadRef).toEqual(target);
  await act(() => root.render(<Composer enabled={false} />));
  const paletteTarget = getActiveComposerDraftTarget();
  if (paletteTarget) {
    applyPromptPresetToComposer({
      ...paletteTarget,
      draft: readComposerThreadDraft(paletteTarget.threadRef),
      presets: mocks.presets,
      presetId: "text",
      disposition: "replace",
      providers: [],
    });
  }
  expect(getActiveComposerDraftTarget()).toBeNull();
  expect(readComposerThreadDraft(target).prompt).toBe("Hidden ordinary draft");
  await act(() => root.render(<Composer enabled />));
  expect(getActiveComposerDraftTarget()?.threadRef).toEqual(target);
});

it("blocks preset application and saving during pending input without touching the hidden draft", async () => {
  await act(() => root.render(<Composer enabled={false} />));
  let applied = true;
  let saved = true;
  await act(() => {
    applied = actions.apply("text", "replace");
    saved = actions.save({
      name: "Wrong draft",
      instructions: "Hidden ordinary draft",
      includeAgentSettings: false,
      replaceInstructions: true,
    });
    actions.remove("text");
  });
  expect(applied).toBe(false);
  expect(saved).toBe(false);
  expect(readComposerThreadDraft(target).prompt).toBe("Hidden ordinary draft");
  expect(mocks.update).not.toHaveBeenCalled();
});
