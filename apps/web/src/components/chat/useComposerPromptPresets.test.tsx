// @vitest-environment jsdom
import { act, useLayoutEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import {
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  type PromptPreset,
  type ServerProvider,
} from "@t3tools/contracts";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { DEFAULT_UNIFIED_SETTINGS } from "@t3tools/contracts/settings";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

const mocks = vi.hoisted(() => ({
  update: vi.fn(),
  toast: vi.fn(),
  presets: [{ id: "text", name: "Text", instructions: "Preset instructions" }] as PromptPreset[],
  providers: [] as ServerProvider[],
  hiddenModels: [] as string[],
  supported: true as boolean | undefined,
}));
vi.mock("../../hooks/useSettings", () => ({
  useEnvironmentSettings: () => ({
    ...DEFAULT_UNIFIED_SETTINGS,
    promptPresets: mocks.presets,
    providerModelPreferences: { codex: { hiddenModels: mocks.hiddenModels, modelOrder: [] } },
  }),
}));
vi.mock("../../state/use-atom-command", () => ({ useAtomCommand: () => mocks.update }));
vi.mock("../../state/server", () => ({ serverEnvironment: { updateSettings: "update" } }));
vi.mock("../../state/entities", () => ({
  useEnvironmentSupportsPromptPresets: () => mocks.supported === true,
  readEnvironmentSupportsPromptPresets: () => mocks.supported === true,
}));
vi.mock("../ui/toast", () => ({ toastManager: { add: mocks.toast } }));

import { useComposerPromptPresets } from "./useComposerPromptPresets";
import { getActiveComposerDraftTarget } from "../../activeComposerDraftTarget";
import { DraftId, readComposerThreadDraft, useComposerDraftStore } from "../../composerDraftStore";
import { applyPromptPresetToComposer } from "../../lib/applyPromptPreset";

const environmentId = EnvironmentId.make("env");
const target = scopeThreadRef(environmentId, ThreadId.make("thread"));
const queuedTarget = DraftId.make("queued-edit:thread:run");
const effectiveAgentSettings = {
  providerInstanceId: ProviderInstanceId.make("codex"),
  model: "test-model",
  runtimeMode: "full-access" as const,
  interactionMode: "default" as const,
};
let root: Root;
let container: HTMLDivElement;
let actions: ReturnType<typeof useComposerPromptPresets>;

function Composer({
  enabled,
  fanout = false,
  queuedEdit = false,
}: {
  enabled: boolean;
  fanout?: boolean;
  queuedEdit?: boolean;
}) {
  const state = useComposerPromptPresets({
    environmentId,
    threadRef: queuedEdit ? queuedTarget : target,
    draft: readComposerThreadDraft(queuedEdit ? queuedTarget : target),
    providers: mocks.providers,
    effectiveAgentSettings,
    threadState: { hasStartedSession: false, isMultiModel: fanout, isQueuedEdit: queuedEdit },
    enabled,
    planModeEnabled: false,
  });
  useLayoutEffect(() => {
    actions = state;
  });
  return null;
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  mocks.update.mockReset();
  mocks.presets = [{ id: "text", name: "Text", instructions: "Preset instructions" }];
  mocks.providers = [];
  mocks.hiddenModels = [];
  mocks.supported = true;
  useComposerDraftStore.setState({ draftsByThreadKey: {} });
  useComposerDraftStore.getState().setPrompt(target, "Hidden ordinary draft");
  useComposerDraftStore.getState().setPrompt(queuedTarget, "Queued instructions");
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

it("uses updated model visibility in composer menu actions", async () => {
  mocks.presets = [{ id: "model", name: "Model", instructions: "New task", model: "test-model" }];
  mocks.providers = [
    {
      instanceId: effectiveAgentSettings.providerInstanceId,
      driver: ProviderDriverKind.make("codex"),
      enabled: true,
      installed: true,
      version: null,
      status: "ready",
      auth: { status: "authenticated" },
      checkedAt: "2026-01-01T00:00:00.000Z",
      models: [{ slug: "test-model", name: "Test", isCustom: false, capabilities: {} }],
      slashCommands: [],
      skills: [],
    },
  ];
  await act(() => root.render(<Composer enabled />));
  mocks.hiddenModels = ["test-model"];
  await act(() => root.render(<Composer enabled />));
  const original = readComposerThreadDraft(target);
  await act(() => {
    expect(actions.apply("model", "replace")).toBe(false);
  });
  expect(readComposerThreadDraft(target)).toEqual(original);
  expect(actions.error).toContain("model is not available");
  mocks.hiddenModels = [];
  await act(() => root.render(<Composer enabled />));
  await act(() => {
    expect(actions.apply("model", "replace")).toBe(true);
  });
  expect(readComposerThreadDraft(target).prompt).toBe("New task");
});

it.each(["Success", "Failure"] as const)(
  "reports save persistence (%s) before success",
  async (tag) => {
    mocks.update.mockResolvedValue({ _tag: tag });
    await act(() => root.render(<Composer enabled />));
    let saved: unknown;
    await act(async () => {
      saved = await actions.save({
        name: "Saved",
        instructions: "Instructions",
        includeAgentSettings: false,
        replaceInstructions: true,
      });
    });
    expect(saved).toBe(tag === "Success");
  },
);

it("saves fanout instructions while refusing incidental agent settings", async () => {
  mocks.update.mockResolvedValue({ _tag: "Success" });
  await act(() => root.render(<Composer enabled fanout />));
  const input = {
    name: "Fanout",
    instructions: "Instructions",
    includeAgentSettings: true,
    replaceInstructions: true,
  };
  let saved: unknown;
  await act(async () => {
    saved = await actions.save(input);
  });
  expect(saved).toBe(false);
  expect(mocks.update).not.toHaveBeenCalled();
  await act(async () => {
    saved = await actions.save({ ...input, includeAgentSettings: false });
  });
  expect(saved).toBe(true);
  expect(mocks.update.mock.calls[0]?.[0].input.patch.promptPresetMutation.preset).toEqual(
    expect.objectContaining({ instructions: "Instructions" }),
  );
  expect(
    mocks.update.mock.calls[0]?.[0].input.patch.promptPresetMutation.preset,
  ).not.toHaveProperty("providerInstanceId");
});

it.each(["new", "update", "replace"] as const)(
  "saves and reapplies queued-edit instructions (%s) without agent settings",
  async (operation) => {
    const previous = {
      id: "existing",
      name: "Existing",
      instructions: "Saved instructions",
      ...effectiveAgentSettings,
    };
    mocks.presets = [previous];
    mocks.update.mockImplementation(
      async ({
        input,
      }: {
        input: { patch: { promptPresetMutation: { preset: PromptPreset } } };
      }) => {
        mocks.presets = [input.patch.promptPresetMutation.preset];
        return { _tag: "Success" };
      },
    );
    const original = readComposerThreadDraft(queuedTarget);
    await act(() => root.render(<Composer enabled queuedEdit />));
    await act(async () => {
      expect(
        await actions.save({
          ...(operation !== "new" ? { id: previous.id } : {}),
          name: "Queued instructions",
          instructions: "Current queued instructions",
          includeAgentSettings: true,
          replaceInstructions: operation !== "update",
        }),
      ).toBe(true);
    });
    const saved = mocks.presets[0]!;
    expect(saved).toEqual({
      id: operation === "new" ? expect.any(String) : previous.id,
      name: "Queued instructions",
      instructions: operation === "update" ? previous.instructions : "Current queued instructions",
    });
    await act(() => root.render(<Composer enabled queuedEdit />));
    await act(() => {
      expect(actions.apply(saved.id, "replace")).toBe(true);
    });
    expect(readComposerThreadDraft(queuedTarget)).toEqual({
      ...original,
      prompt: saved.instructions,
    });
    expect(readComposerThreadDraft(target).prompt).toBe("Hidden ordinary draft");
  },
);

it("preserves agent settings when saving an ordinary draft", async () => {
  mocks.update.mockResolvedValue({ _tag: "Success" });
  await act(() => root.render(<Composer enabled />));
  await act(async () => {
    expect(
      await actions.save({
        name: "Ordinary",
        instructions: "Instructions",
        includeAgentSettings: true,
        replaceInstructions: true,
      }),
    ).toBe(true);
  });
  expect(mocks.update.mock.calls[0]?.[0].input.patch.promptPresetMutation.preset).toMatchObject(
    effectiveAgentSettings,
  );
});

it.each([false, undefined])(
  "does not publish preset controls for unsupported server capability (%s)",
  async (supported) => {
    mocks.supported = supported;
    await act(() => root.render(<Composer enabled />));
    expect(getActiveComposerDraftTarget()).toBeNull();
    let saved: unknown;
    await act(async () => {
      saved = await actions.save({
        name: "Unavailable",
        instructions: "Instructions",
        includeAgentSettings: false,
        replaceInstructions: true,
      });
    });
    expect(saved).toBe(false);
    expect(mocks.update).not.toHaveBeenCalled();
  },
);

it("rejects cached preset actions after server support is withdrawn", async () => {
  await act(() => root.render(<Composer enabled />));
  const cached = actions;
  mocks.supported = false;
  await act(async () => {
    expect(cached.apply("text", "replace")).toBe(false);
    expect(
      await cached.save({
        name: "Unavailable",
        instructions: "Instructions",
        includeAgentSettings: false,
        replaceInstructions: true,
      }),
    ).toBe(false);
    expect(await cached.remove("text")).toBe(false);
  });
  expect(mocks.update).not.toHaveBeenCalled();
  expect(readComposerThreadDraft(target).prompt).toBe("Hidden ordinary draft");
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
      settings: DEFAULT_UNIFIED_SETTINGS,
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
  await act(async () => {
    applied = actions.apply("text", "replace");
    saved = await actions.save({
      name: "Wrong draft",
      instructions: "Hidden ordinary draft",
      includeAgentSettings: false,
      replaceInstructions: true,
    });
    await actions.remove("text");
  });
  expect(applied).toBe(false);
  expect(saved).toBe(false);
  expect(readComposerThreadDraft(target).prompt).toBe("Hidden ordinary draft");
  expect(mocks.update).not.toHaveBeenCalled();
});

it.each(["Success", "Failure"] as const)(
  "reports the deletion acknowledgement (%s)",
  async (tag) => {
    mocks.update.mockResolvedValue({ _tag: tag });
    await act(() => root.render(<Composer enabled />));
    let removed: unknown;
    await act(async () => {
      removed = await actions.remove("text");
    });
    expect(removed).toBe(tag === "Success");
    expect(mocks.presets).toEqual([
      { id: "text", name: "Text", instructions: "Preset instructions" },
    ]);
  },
);
