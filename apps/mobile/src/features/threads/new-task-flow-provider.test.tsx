// @vitest-environment jsdom
import { act, useLayoutEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import {
  CommandId,
  EnvironmentId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import { createModelSelection } from "@t3tools/shared/model";
import type { ComposerDraft } from "../../state/use-composer-drafts";
import type { QueuedThreadMessage } from "../../state/thread-outbox";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

const fixture = vi.hoisted(() => ({
  projects: [] as unknown[],
  queued: [] as QueuedThreadMessage[],
  drafts: {} as Record<string, ComposerDraft>,
  empty: { text: "", attachments: [] } as ComposerDraft,
  listeners: new Set<() => void>(),
  hold: vi.fn(),
  release: vi.fn(),
  focused: true,
}));
vi.mock("@react-navigation/native", async () => {
  const { useEffect } = await import("react");
  return {
    useFocusEffect: (callback: () => (() => void) | undefined) =>
      useEffect(() => (fixture.focused ? callback() : undefined), [callback, fixture.focused]),
  };
});
function patchDraft(key: string, patch: Partial<ComposerDraft>) {
  fixture.drafts = {
    ...fixture.drafts,
    [key]: { ...(fixture.drafts[key] ?? fixture.empty), ...patch },
  };
  for (const listener of fixture.listeners) listener();
}
vi.mock("react-native", () => ({ Alert: { alert: vi.fn() } }));
vi.mock("../../state/entities", () => ({
  useProjects: () => fixture.projects,
  useThreadShells: () => [],
  useServerConfigs: () => new Map(),
  useEnvironmentServerConfig: () => null,
}));
vi.mock("../../state/use-remote-environment-registry", () => ({
  useSavedRemoteConnections: () => ({ savedConnectionsById: {} }),
  useRemoteConnectionStatus: () => ({ connectedEnvironments: [] }),
  setPendingConnectionError: vi.fn(),
}));
vi.mock("../../state/project-grouping", () => ({
  useMobileProjectGroupingSettings: () => ({ sidebarProjectGroupingMode: "project" }),
}));
vi.mock("./use-legacy-plan-mode-enabled", () => ({
  useLegacyPlanModeState: () => ({ enabled: false, loaded: true }),
}));
vi.mock("../home/homeThreadList", () => ({
  buildHomeProjectScopes: () => [],
  sortHomeProjectScopes: () => [],
}));
vi.mock("../../state/projects", () => ({
  projectEnvironment: { readFile: () => null, openScratch: "scratch" },
}));
vi.mock("../../state/vcs", () => ({ vcsEnvironment: { status: () => null } }));
vi.mock("../../state/query", () => ({
  useEnvironmentQuery: () => ({ data: null, isPending: false }),
}));
vi.mock("../../state/queries", () => ({
  useDebouncedValue: (value: string) => value,
  usePaginatedBranches: () => ({
    refs: [],
    data: null,
    isPending: false,
    isFetchingNextPage: false,
  }),
}));
vi.mock("../../state/use-atom-command", () => ({ useAtomCommand: () => vi.fn() }));
vi.mock("../../state/use-model-option-memory", () => ({
  rememberModelOptions: vi.fn(),
  withRememberedModelOptions: (_: unknown, value: unknown) => value,
}));
vi.mock("../../state/atom-registry", () => ({
  appAtomRegistry: { get: (atom: string) => (atom === "queue" ? fixture.queued : fixture.drafts) },
}));
vi.mock("../../state/thread-outbox", () => ({
  flattenQueuedThreadMessages: (messages: QueuedThreadMessage[]) => messages,
  threadOutboxManager: { queuedMessagesByThreadKeyAtom: "queue" },
}));
vi.mock("../../state/use-thread-outbox", () => ({
  holdEditingQueuedMessage: fixture.hold,
  releaseEditingQueuedMessage: fixture.release,
  useThreadOutboxMessages: () => fixture.queued,
}));
vi.mock("../../state/pending-task-editor-writes", () => ({
  capturePendingTaskEditorWriteBaseline: () => Promise.resolve(0),
  flushPendingTaskEditorWrite: () => Promise.resolve(false),
}));
vi.mock("../../state/use-composer-drafts", async () => {
  const { useSyncExternalStore } = await import("react");
  return {
    composerDraftsAtom: "drafts",
    createNewTaskDraft: () => "new-task:ordinary",
    isNewTaskDraftKey: (key: string) => key.startsWith("new-task:"),
    useComposerDraft: (key: string | null) =>
      useSyncExternalStore(
        (listener) => {
          fixture.listeners.add(listener);
          return () => {
            fixture.listeners.delete(listener);
          };
        },
        () => (key ? (fixture.drafts[key] ?? fixture.empty) : fixture.empty),
      ),
    getComposerDraftSnapshot: (key: string) => fixture.drafts[key] ?? fixture.empty,
    setComposerDraftText: (key: string, text: string) => patchDraft(key, { text }),
    setComposerDraftPresetText: (key: string, text: string) => patchDraft(key, { text }),
    setComposerDraftContext: (key: string, context: ComposerDraft["context"]) =>
      patchDraft(key, { context }),
    replaceComposerDraftAttachments: (key: string, attachments: ComposerDraft["attachments"]) =>
      patchDraft(key, { attachments }),
    updateComposerDraftSettings: patchDraft,
    isComposerDraftEmpty: (draft: ComposerDraft) =>
      draft.text === "" && draft.attachments.length === 0,
    useStickyComposerModelSelection: () => null,
    clearComposerDraft: vi.fn(),
    appendComposerDraftAttachments: vi.fn(),
    removeComposerDraftAttachment: vi.fn(),
    retargetNewTaskDraft: vi.fn(),
    scheduleUnusedComposerAttachmentCleanup: vi.fn(),
    setStickyComposerModelSelection: vi.fn(),
  };
});

import {
  NewTaskFlowProvider,
  useNewTaskFlow,
  useNewTaskComposerPresetTarget,
} from "./new-task-flow-provider";
import { getActiveComposerDraftTarget } from "./active-composer-draft-target";
import { useThreadComposerPresetTarget } from "./use-thread-composer-preset-target";
import { applyPromptPresetToMobileDraft } from "../keyboard/applyPromptPresetToDraft";

let root: Root;
let container: HTMLDivElement;
let flow: ReturnType<typeof useNewTaskFlow>;
const environmentId = EnvironmentId.make("env");
const projectId = ProjectId.make("project");
const modelSelection = createModelSelection(ProviderInstanceId.make("codex"), "test-model");
function Probe({
  ready = true,
  request,
}: {
  ready?: boolean;
  request?: Parameters<typeof useNewTaskComposerPresetTarget>[1];
}) {
  useNewTaskComposerPresetTarget(ready, request);
  const state = useNewTaskFlow();
  useLayoutEffect(() => {
    flow = state;
  });
  return null;
}

beforeEach(async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  fixture.drafts = { "new-task:ordinary": { text: "Ordinary draft", attachments: [] } };
  fixture.projects = [
    {
      id: projectId,
      environmentId,
      title: "Project",
      workspaceRoot: "/project",
      repositoryIdentity: null,
      defaultModelSelection: null,
      scripts: [],
      createdAt: "2026-10-13T00:00:00Z",
      updatedAt: "2026-10-13T00:00:00Z",
    },
  ];
  fixture.queued = [
    {
      messageId: MessageId.make("queued"),
      commandId: CommandId.make("command"),
      environmentId,
      threadId: ThreadId.make("future"),
      text: "Queued instructions",
      attachments: [],
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      createdAt: "2026-10-13T00:00:00Z",
      creation: {
        projectId,
        projectTitle: "Project",
        workspaceMode: "local",
        branch: null,
        worktreePath: null,
      },
    },
  ];
  fixture.hold.mockClear();
  fixture.release.mockClear();
  fixture.focused = true;
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(() =>
    root.render(
      <NewTaskFlowProvider>
        <Probe />
      </NewTaskFlowProvider>,
    ),
  );
});
afterEach(async () => {
  await act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

it("routes palette presets to queued task text, rejects settings, and cleans up the editor target", async () => {
  await act(() => {
    expect(flow.beginEditingPendingTask("queued")).toBe(true);
  });
  const target = getActiveComposerDraftTarget();
  expect(target?.draftKey).toBe("pending-task:queued");
  expect(fixture.hold).toHaveBeenCalledWith("queued");
  if (!target) throw new Error("Queued editor must publish a palette target");
  const presets = [
    { id: "text", name: "Text", instructions: "Review the task" },
    {
      id: "settings",
      name: "Settings",
      instructions: "Wrong task",
      runtimeMode: "approval-required" as const,
    },
  ];
  await act(() => {
    const textResult = applyPromptPresetToMobileDraft({
      ...target,
      presets,
      presetId: "text",
      disposition: "replace",
      providers: [],
    });
    expect(textResult.ok).toBe(true);
  });
  expect(fixture.drafts["pending-task:queued"]?.text).toBe("Review the task");
  expect(fixture.drafts["new-task:ordinary"]?.text).toBe("Ordinary draft");
  await act(() => {
    const settingsResult = applyPromptPresetToMobileDraft({
      ...target,
      presets,
      presetId: "settings",
      disposition: "replace",
      providers: [],
    });
    expect(settingsResult).toMatchObject({ ok: false, code: "agent-settings" });
  });
  expect(fixture.drafts["pending-task:queued"]?.text).toBe("Review the task");
  await act(() => flow.reset());
  expect(getActiveComposerDraftTarget()?.draftKey).toBe("new-task:ordinary");
  expect(getActiveComposerDraftTarget()?.threadState.isQueuedEdit).not.toBe(true);
  expect(fixture.release).toHaveBeenCalledWith("queued");
  await act(() => root.unmount());
  expect(getActiveComposerDraftTarget()).toBeNull();
});

it.each(["other-environment", "none"])(
  "keeps a queued editor on its own environment with %s project shells loaded",
  async (loadedProjects) => {
    const queuedEnvironment = EnvironmentId.make("env-queued");
    fixture.queued = fixture.queued.map((message) => ({
      ...message,
      environmentId: queuedEnvironment,
      creation: { ...message.creation!, projectId: ProjectId.make("missing-project") },
    }));
    if (loadedProjects === "none") fixture.projects = [];
    await act(() => {
      expect(flow.beginEditingPendingTask("queued")).toBe(true);
    });
    expect(getActiveComposerDraftTarget()?.draftKey).toBe("pending-task:queued");
    expect(getActiveComposerDraftTarget()?.environmentId).toBe(queuedEnvironment);
    await act(() => flow.reset());
  },
);

it.each(["Choose project", "Add project", "Add repository"])(
  "withdraws the composer target on %s and restores it on return",
  async (screen) => {
    await act(() => flow.beginEditingPendingTask("queued"));
    const target = getActiveComposerDraftTarget();
    expect(target?.draftKey).toBe("pending-task:queued");
    await act(() =>
      root.render(
        <NewTaskFlowProvider>
          <div>{screen}</div>
        </NewTaskFlowProvider>,
      ),
    );
    expect(getActiveComposerDraftTarget()).toBeNull();
    const staleResult = applyPromptPresetToMobileDraft({
      draftKey: target!.draftKey,
      expectedActiveTarget: target,
      presets: [{ id: "text", name: "Text", instructions: "Hidden write" }],
      presetId: "text",
      disposition: "replace",
      providers: [],
    });
    expect(staleResult).toMatchObject({ ok: false, code: "missing" });
    expect(fixture.drafts["pending-task:queued"]?.text).toBe("Queued instructions");
    await act(() =>
      root.render(
        <NewTaskFlowProvider>
          <Probe />
        </NewTaskFlowProvider>,
      ),
    );
    expect(getActiveComposerDraftTarget()?.draftKey).toBe("pending-task:queued");
  },
);

it("withdraws a mounted native-stack composer on blur and waits for the new target", async () => {
  await act(() => flow.beginEditingPendingTask("queued"));
  fixture.focused = false;
  await act(() =>
    root.render(
      <NewTaskFlowProvider>
        <Probe />
      </NewTaskFlowProvider>,
    ),
  );
  expect(getActiveComposerDraftTarget()).toBeNull();
  fixture.focused = true;
  await act(() =>
    root.render(
      <NewTaskFlowProvider>
        <Probe />
      </NewTaskFlowProvider>,
    ),
  );
  expect(getActiveComposerDraftTarget()?.draftKey).toBe("pending-task:queued");
  await act(() =>
    root.render(
      <NewTaskFlowProvider>
        <Probe ready={false} />
      </NewTaskFlowProvider>,
    ),
  );
  expect(getActiveComposerDraftTarget()).toBeNull();
  await act(() =>
    root.render(
      <NewTaskFlowProvider>
        <Probe />
      </NewTaskFlowProvider>,
    ),
  );
  expect(getActiveComposerDraftTarget()?.draftKey).toBe("pending-task:queued");
});

it("keeps presets on the visible composer after an intentional machine switch", async () => {
  const initialProjectRef = { environmentId, projectId };
  const otherEnvironment = EnvironmentId.make("other-machine");
  fixture.projects = [
    ...fixture.projects,
    { ...(fixture.projects[0] as object), environmentId: otherEnvironment },
  ];
  await act(() =>
    root.render(
      <NewTaskFlowProvider>
        <Probe request={{ initialProjectRef }} />
      </NewTaskFlowProvider>,
    ),
  );
  expect(getActiveComposerDraftTarget()?.environmentId).toBe(environmentId);
  await act(async () => {
    expect(await flow.switchEnvironment(otherEnvironment)).toBe(true);
  });
  expect(getActiveComposerDraftTarget()?.environmentId).toBe(otherEnvironment);
  const target = getActiveComposerDraftTarget();
  expect(target).not.toBeNull();
  const result = applyPromptPresetToMobileDraft({
    draftKey: target!.draftKey,
    expectedActiveTarget: target,
    presets: [{ id: "text", name: "Text", instructions: "Switched machine instructions" }],
    presetId: "text",
    disposition: "replace",
    providers: [],
  });
  expect(result.ok).toBe(true);
  expect(fixture.drafts[target!.draftKey]?.text).toBe("Switched machine instructions");
  await act(() =>
    root.render(
      <NewTaskFlowProvider>
        <Probe request={{ initialProjectRef: { environmentId, projectId } }} />
      </NewTaskFlowProvider>,
    ),
  );
  expect(getActiveComposerDraftTarget()).toBeNull();
});

it("withdraws the ordinary thread target while a questionnaire owns the composer", async () => {
  const target = {
    draftKey: "thread",
    environmentId,
    effectiveAgentSettings: {
      providerInstanceId: modelSelection.instanceId,
      model: modelSelection.model,
      runtimeMode: "full-access" as const,
      interactionMode: "default" as const,
    },
    threadState: { hasStartedSession: false },
  };
  fixture.drafts.thread = { text: "Ordinary draft", attachments: [] };
  function ThreadProbe({ questionnaireActive }: { questionnaireActive: boolean }) {
    useThreadComposerPresetTarget(target, questionnaireActive);
    return null;
  }
  await act(() => root.render(<ThreadProbe questionnaireActive={false} />));
  expect(getActiveComposerDraftTarget()).toBe(target);
  await act(() => root.render(<ThreadProbe questionnaireActive />));
  expect(getActiveComposerDraftTarget()).toBeNull();
  const result = applyPromptPresetToMobileDraft({
    draftKey: "thread",
    expectedActiveTarget: target,
    presets: [{ id: "text", name: "Text", instructions: "Hidden write" }],
    presetId: "text",
    disposition: "replace",
    providers: [],
  });
  expect(result).toMatchObject({ ok: false, code: "missing" });
  expect(fixture.drafts.thread.text).toBe("Ordinary draft");
  await act(() => root.render(<ThreadProbe questionnaireActive={false} />));
  expect(getActiveComposerDraftTarget()).toBe(target);
});

it("withdraws the draft target while a queued creation failure card owns the slot", async () => {
  const target = {
    draftKey: "thread",
    environmentId,
    effectiveAgentSettings: {
      providerInstanceId: modelSelection.instanceId,
      model: modelSelection.model,
      runtimeMode: "full-access" as const,
      interactionMode: "default" as const,
    },
    threadState: { hasStartedSession: false },
  };
  function FailureProbe({ failed }: { failed: boolean }) {
    useThreadComposerPresetTarget(target, false, failed);
    return null;
  }
  await act(() => root.render(<FailureProbe failed={false} />));
  expect(getActiveComposerDraftTarget()).toBe(target);
  await act(() => root.render(<FailureProbe failed />));
  expect(getActiveComposerDraftTarget()).toBeNull();
});
