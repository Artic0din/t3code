// @vitest-environment jsdom
import { RegistryContext } from "@effect/atom-react";
import { scopeThreadRef, scopedThreadKey } from "@t3tools/client-runtime/environment";
import {
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type AgentSessionScanResult,
} from "@t3tools/contracts";
import { AsyncResult, Atom, AtomRegistry } from "effect/reactivity";
import * as Cause from "effect/Cause";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const state = vi.hoisted(() => ({
  environmentId: "environment-a",
  enabled: true,
  registry: null as AtomRegistry.AtomRegistry | null,
  threadAtoms: new Map<string, Atom.Writable<ReadonlyArray<{ id: string }>>>(),
  archiveRequests: [] as string[],
  archiveResponse: "ready" as "ready" | "pending" | "failed",
  archiveAtoms: new Map<
    string,
    Atom.Writable<AsyncResult.AsyncResult<{ threads: Array<{ id: string }> }, Error>>
  >(),
  archived: false,
  showArchiveProbe: false,
  scan: vi.fn(),
  import: vi.fn(),
  unarchive: vi.fn(),
  navigate: vi.fn(),
}));
vi.mock("@tanstack/react-router", () => ({ useNavigate: () => state.navigate }));
vi.mock("../../state/agentSessions", () => ({
  agentSessionImport: "import",
  refreshAgentSessionScan: "scan",
}));
vi.mock("../../state/use-atom-command", () => ({
  useAtomCommand: (command: "import" | "scan" | "unarchive") => state[command],
}));
vi.mock("../../state/externalSessionActivityPreference", () => ({
  readExternalSessionActivityEnabled: () => state.enabled,
  writeExternalSessionActivityEnabled: (enabled: boolean) => {
    state.enabled = enabled;
  },
}));
vi.mock("./SettingsScopeContext", () => ({
  useSettingsScope: () => ({
    scope: { environmentIds: [state.environmentId] },
    environment: { environmentId: state.environmentId },
  }),
}));
vi.mock("../../rpc/atomRegistry", () => ({
  get appAtomRegistry() {
    return state.registry;
  },
}));
vi.mock("../../state/threads", async () => {
  const { Atom } = await import("effect/reactivity");
  const threads = (environmentId: string) => {
    let atom = state.threadAtoms.get(environmentId);
    if (!atom) {
      atom = Atom.make<ReadonlyArray<{ id: string }>>([]).pipe(Atom.keepAlive);
      state.threadAtoms.set(environmentId, atom);
    }
    return atom;
  };
  return {
    threadEnvironment: { unarchive: "unarchive" },
    environmentThreadShells: { environmentThreadsAtom: threads },
  };
});
vi.mock("../../state/entities", async () => {
  const { waitForAtomValue } = await import("../../state/waitForAtomValue");
  const { environmentThreadShells } = await import("../../state/threads");
  return {
    waitForThreadShell: (ref: { environmentId: EnvironmentId; threadId: ThreadId }) =>
      waitForAtomValue({
        registry: state.registry!,
        atom: environmentThreadShells.environmentThreadsAtom(ref.environmentId),
        predicate: (threads) => threads.some((thread) => thread.id === ref.threadId),
        timeoutMs: 5000,
      }),
  };
});
vi.mock("../../state/orchestration", async () => {
  const { Atom, AsyncResult } = await import("effect/reactivity");
  return {
    orchestrationEnvironment: {
      archivedShellSnapshot: ({ environmentId }: { environmentId: string }) => {
        let atom = state.archiveAtoms.get(environmentId);
        if (!atom) {
          atom = Atom.writable(
            () => {
              state.archiveRequests.push(environmentId);
              if (state.archiveResponse === "pending") return AsyncResult.initial(true);
              if (state.archiveResponse === "failed")
                return AsyncResult.failure(Cause.fail(new Error("Archive unavailable")));
              return AsyncResult.success({
                threads: state.archived ? [{ id: "import:codex:session-a" }] : [],
              });
            },
            (context, value: AsyncResult.AsyncResult<{ threads: Array<{ id: string }> }, Error>) =>
              context.setSelf(value),
          );
          state.archiveAtoms.set(environmentId, atom);
        }
        return atom;
      },
    },
  };
});
vi.mock("../ui/button", () => ({ Button: "button" }));
vi.mock("../ui/switch", () => ({
  Switch: ({
    checked,
    onCheckedChange,
  }: {
    checked: boolean;
    onCheckedChange: (checked: boolean) => void;
  }) => (
    <input
      type="checkbox"
      checked={checked}
      onChange={(event) => onCheckedChange(event.target.checked)}
    />
  ),
}));
vi.mock("./settingsLayout", () => ({
  SettingsSection: ({
    children,
    headerAction,
  }: {
    children: ReactNode;
    headerAction: ReactNode;
  }) => (
    <section>
      {headerAction}
      {children}
    </section>
  ),
  SettingsRow: ({
    title,
    description,
    control,
  }: {
    title: string;
    description: string;
    control: ReactNode;
  }) => (
    <div>
      {title}
      {description}
      {control}
    </div>
  ),
}));

import { ExternalSessionActivitySection } from "./ExternalSessionActivitySection";
import * as ThreadUndo from "../../hooks/threadUndo";
import { useArchivedThreadSnapshots } from "../../lib/archivedThreadsState";

const scan: AgentSessionScanResult = {
  candidates: [],
  scannedAt: "2026-10-13T00:00:00.000Z",
  sessions: [
    {
      provider: "codex",
      providerInstanceId: ProviderInstanceId.make("codex"),
      providerSessionId: "session-a",
      projectId: ProjectId.make("project-a"),
      projectPath: "/workspace",
      repository: null,
      lastObservedActivityAt: null,
    },
  ],
  sourceReports: [
    {
      provider: "codex",
      providerInstanceId: ProviderInstanceId.make("codex"),
      homeState: "present",
      truncated: false,
    },
  ],
};
function deferred<A>() {
  let resolve!: (value: A) => void;
  const promise = new Promise<A>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
let root: Root;
let container: HTMLDivElement;
function ArchiveProbe() {
  const { snapshots } = useArchivedThreadSnapshots([EnvironmentId.make("environment-a")]);
  return (
    <aside>
      {snapshots.flatMap((entry) => entry.snapshot.threads.map((thread) => thread.id)).join(",")}
    </aside>
  );
}
function render() {
  root.render(
    <RegistryContext.Provider value={state.registry!}>
      <ExternalSessionActivitySection />
      {state.showArchiveProbe ? <ArchiveProbe /> : null}
    </RegistryContext.Provider>,
  );
}
function button(label: string) {
  return [...container.querySelectorAll("button")].find((entry) => entry.textContent === label)!;
}
async function click(label: string) {
  await act(async () => button(label).click());
}
async function toggle() {
  await act(async () => container.querySelector("input")!.click());
}
async function selectEnvironment(environmentId: string) {
  state.environmentId = environmentId;
  await act(async () => render());
}
function publishShell(environmentId = "environment-a") {
  state.registry!.set(state.threadAtoms.get(environmentId)!, [{ id: "import:codex:session-a" }]);
}

beforeEach(async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  state.environmentId = "environment-a";
  state.enabled = true;
  state.archived = false;
  state.showArchiveProbe = false;
  state.threadAtoms.clear();
  state.archiveRequests = [];
  state.archiveResponse = "ready";
  state.archiveAtoms.clear();
  state.registry = AtomRegistry.make();
  state.navigate.mockReset();
  state.unarchive.mockReset().mockResolvedValue({ _tag: "Success", value: {} });
  state.scan.mockReset().mockResolvedValue({ _tag: "Success", value: scan });
  state.import
    .mockReset()
    .mockResolvedValue({ _tag: "Success", value: { importedCount: 1, skippedCount: 0 } });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  state.registry!.dispose();
  container.remove();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("external session actions", () => {
  it("explains a deleted import without offering another dead-end Import", async () => {
    state.scan.mockResolvedValue({
      _tag: "Success",
      value: {
        ...scan,
        sessions: scan.sessions!.map((session) => ({ ...session, importedThreadDeleted: true })),
      },
    });
    await act(async () => render());
    await click("Refresh");
    expect(container.textContent).toContain(
      "This imported session was deleted from T3. It cannot be imported again.",
    );
    expect(button("Import")).toBeUndefined();
    expect(button("Open")).toBeUndefined();
    expect(state.import).not.toHaveBeenCalled();
    expect(state.unarchive).not.toHaveBeenCalled();
  });
  it("does not fetch archives while opted out or before a scan", async () => {
    state.enabled = false;
    await act(async () => render());
    expect(state.archiveRequests).toEqual([]);
    await toggle();
    expect(state.archiveRequests).toEqual([]);
    await click("Refresh");
    expect(state.archiveRequests).toEqual(["environment-a"]);
    await toggle();
    await selectEnvironment("environment-b");
    expect(state.archiveRequests).toEqual(["environment-a"]);
  });
  it("withholds Import until deferred archived identities are reconciled", async () => {
    state.archived = true;
    state.archiveResponse = "pending";
    await act(async () => render());
    await click("Refresh");
    expect(button("Import").disabled).toBe(true);
    expect(container.textContent).toContain("Checking archived sessions");
    await click("Import");
    expect(state.import).not.toHaveBeenCalled();
    await act(async () =>
      state.registry!.set(
        state.archiveAtoms.get("environment-a")!,
        AsyncResult.success({ threads: [{ id: "import:codex:session-a" }] }),
      ),
    );
    expect(button("Open").disabled).toBe(false);
    expect(state.import).not.toHaveBeenCalled();
  });
  it("reconciles retained rows when a scan fails before archived identities arrive", async () => {
    state.archived = true;
    state.archiveResponse = "pending";
    await act(async () => render());
    await click("Refresh");
    state.scan.mockResolvedValueOnce({
      _tag: "Failure",
      cause: Cause.fail(new Error("Scan unavailable")),
    });
    await click("Refresh");
    expect(container.textContent).toContain("Scan unavailable");
    await act(async () =>
      state.registry!.set(
        state.archiveAtoms.get("environment-a")!,
        AsyncResult.success({ threads: [{ id: "import:codex:session-a" }] }),
      ),
    );
    expect(button("Open")).toBeDefined();
    expect(button("Open").disabled).toBe(false);
    expect(button("Import")).toBeUndefined();
    expect(container.textContent).toContain("Scan unavailable");
    expect(state.import).not.toHaveBeenCalled();
  });
  it("shows archive failures and retries reconciliation on Refresh", async () => {
    state.archiveResponse = "failed";
    await act(async () => render());
    await click("Refresh");
    expect(button("Import").disabled).toBe(true);
    expect(container.textContent).toContain("Failed to load archived threads.");
    await click("Import");
    expect(state.import).not.toHaveBeenCalled();
    state.archiveResponse = "ready";
    await click("Refresh");
    expect(state.archiveRequests).toEqual(["environment-a", "environment-a"]);
    expect(button("Import").disabled).toBe(false);
    await click("Import");
    expect(container.textContent).toContain("Imported 1 session.");
  });
  it("does not fetch archives for an empty or older-server scan", async () => {
    state.scan
      .mockResolvedValueOnce({ _tag: "Success", value: { ...scan, sessions: [] } })
      .mockResolvedValueOnce({
        _tag: "Success",
        value: { candidates: [], scannedAt: scan.scannedAt },
      });
    await act(async () => render());
    await click("Refresh");
    await click("Refresh");
    expect(state.archiveRequests).toEqual([]);
  });
  it("does not reconcile a previous environment's scan in a new environment", async () => {
    await act(async () => render());
    await click("Refresh");
    await selectEnvironment("environment-b");
    expect(state.archiveRequests).toEqual(["environment-a"]);
    await click("Refresh");
    expect(state.archiveRequests).toEqual(["environment-a", "environment-b"]);
  });
  it("unarchives in the destination environment and waits for its shell before navigating", async () => {
    state.archived = true;
    const response = deferred<{ _tag: "Success"; value: object }>();
    state.unarchive.mockReturnValue(response.promise);
    await act(async () => render());
    await click("Refresh");
    await click("Open");
    expect(state.unarchive).toHaveBeenCalledWith({
      environmentId: "environment-a",
      input: { threadId: "import:codex:session-a" },
    });
    expect(state.navigate).not.toHaveBeenCalled();
    expect(button("Opening…").disabled).toBe(true);
    await act(async () => response.resolve({ _tag: "Success", value: {} }));
    expect(state.navigate).not.toHaveBeenCalled();
    await act(async () => publishShell());
    expect(state.navigate).toHaveBeenCalledTimes(1);
    expect(state.navigate.mock.calls[0]![0].params).toEqual({
      environmentId: "environment-a",
      threadId: "import:codex:session-a",
    });
  });
  it("refreshes shared archive membership after restoring a session", async () => {
    state.archived = true;
    const response = deferred<{ _tag: "Success"; value: object }>();
    state.unarchive.mockReturnValue(response.promise);
    await act(async () => render());
    await click("Refresh");
    state.showArchiveProbe = true;
    await act(async () => render());
    expect(container.querySelector("aside")!.textContent).toBe("import:codex:session-a");
    await click("Open");
    state.archived = false;
    await act(async () => response.resolve({ _tag: "Success", value: {} }));
    expect(container.querySelector("aside")!.textContent).toBe("");
    expect(state.navigate).not.toHaveBeenCalled();
    expect(button("Opening…").disabled).toBe(true);
    await act(async () => publishShell());
    expect(state.navigate).toHaveBeenCalledTimes(1);
  });
  it("refreshes the restored environment's archive even after Settings changes scope", async () => {
    state.archived = true;
    const response = deferred<{ _tag: "Success"; value: object }>();
    state.unarchive.mockReturnValue(response.promise);
    await act(async () => render());
    await click("Refresh");
    state.showArchiveProbe = true;
    await act(async () => render());
    await click("Open");
    await selectEnvironment("environment-b");
    state.archived = false;
    await act(async () => response.resolve({ _tag: "Success", value: {} }));
    expect(container.querySelector("aside")!.textContent).toBe("");
    expect(state.archiveRequests).toEqual(["environment-a", "environment-a"]);
    expect(state.navigate).not.toHaveBeenCalled();
  });
  it("expires the prior archive Undo while leaving unrelated claims available", async () => {
    const threadId = ThreadId.make("import:codex:session-a");
    const key = scopedThreadKey(scopeThreadRef(EnvironmentId.make("environment-a"), threadId));
    const archive = ThreadUndo.begin("archive", key);
    const pin = ThreadUndo.begin("pin", key);
    const otherEnvironment = ThreadUndo.begin(
      "archive",
      scopedThreadKey(scopeThreadRef(EnvironmentId.make("environment-b"), threadId)),
    );
    try {
      state.archived = true;
      await act(async () => render());
      await click("Refresh");
      await click("Open");
      expect(archive.isCurrent()).toBe(false);
      expect(pin.isCurrent()).toBe(true);
      expect(otherEnvironment.isCurrent()).toBe(true);
    } finally {
      archive.finish();
      pin.finish();
      otherEnvironment.finish();
      await act(async () => publishShell());
    }
  });
  it("opens an active thread without unarchiving", async () => {
    await act(async () => render());
    await act(async () => publishShell());
    await click("Refresh");
    await click("Open");
    expect(state.unarchive).not.toHaveBeenCalled();
    expect(state.navigate).toHaveBeenCalledTimes(1);
  });
  it("keeps a failed unarchive retryable without navigation", async () => {
    state.archived = true;
    state.unarchive.mockResolvedValue({
      _tag: "Failure",
      cause: Cause.fail(new Error("Permission denied")),
    });
    await act(async () => render());
    await click("Refresh");
    await click("Open");
    expect(state.navigate).not.toHaveBeenCalled();
    expect(container.textContent).toContain("Permission denied");
    expect(button("Open").disabled).toBe(false);
  });
  it("reports a missing shell without navigating", async () => {
    state.archived = true;
    await act(async () => render());
    await click("Refresh");
    vi.useFakeTimers();
    await click("Open");
    await act(async () => vi.advanceTimersByTimeAsync(5000));
    expect(state.navigate).not.toHaveBeenCalled();
    expect(container.textContent).toContain("did not appear");
    expect(button("Open").disabled).toBe(false);
  });
  it("does not navigate after changing environments during unarchive", async () => {
    state.archived = true;
    const response = deferred<{ _tag: "Success"; value: object }>();
    state.unarchive.mockReturnValue(response.promise);
    await act(async () => render());
    await click("Refresh");
    await click("Open");
    await selectEnvironment("environment-b");
    await act(async () => {
      publishShell("environment-a");
      response.resolve({ _tag: "Success", value: {} });
    });
    expect(state.navigate).not.toHaveBeenCalled();
    expect(container.textContent).not.toContain("did not appear");
  });
  it.each([
    { importedCount: 0, skippedCount: 1 },
    { importedCount: 0, skippedCount: 0 },
    { importedCount: 1, skippedCount: 2 },
  ])("reports aggregate import outcomes and permits a retry: %j", async (value) => {
    state.import.mockResolvedValue({ _tag: "Success", value });
    await act(async () => render());
    await click("Refresh");
    await click("Import");
    expect(container.textContent).toContain(
      value.importedCount === 0 ? "No sessions were imported." : "Imported 1 session.",
    );
    if (value.skippedCount > 0)
      expect(container.textContent).toContain(`Skipped ${value.skippedCount}`);
    expect(button("Import").disabled).toBe(false);
    await click("Import");
    expect(state.import).toHaveBeenCalledTimes(2);
  });
  it("preserves the new environment's import feedback when an old import completes", async () => {
    const response = deferred<{
      _tag: "Success";
      value: { importedCount: number; skippedCount: number };
    }>();
    state.import
      .mockReturnValueOnce(response.promise)
      .mockResolvedValueOnce({ _tag: "Success", value: { importedCount: 0, skippedCount: 2 } });
    await act(async () => render());
    await click("Refresh");
    await click("Import");
    await selectEnvironment("environment-b");
    await click("Refresh");
    await click("Import");
    expect(container.textContent).toContain("Skipped 2 sessions.");
    await act(async () =>
      response.resolve({ _tag: "Success", value: { importedCount: 0, skippedCount: 1 } }),
    );
    expect(container.textContent).toContain("Skipped 2 sessions.");
    expect(container.textContent).not.toContain("Skipped 1 session.");
  });
  it("ignores an old environment's import failure", async () => {
    const response = deferred<{ _tag: "Failure"; cause: Cause.Cause<Error> }>();
    state.import.mockReturnValue(response.promise);
    await act(async () => render());
    await click("Refresh");
    await click("Import");
    await selectEnvironment("environment-b");
    await act(async () =>
      response.resolve({ _tag: "Failure", cause: Cause.fail(new Error("Old import failed")) }),
    );
    expect(container.textContent).not.toContain("Old import failed");
  });
  it("does not navigate after changing scope while the restored shell is pending", async () => {
    state.archived = true;
    await act(async () => render());
    await click("Refresh");
    await click("Open");
    expect(state.navigate).not.toHaveBeenCalled();
    await selectEnvironment("environment-b");
    await act(async () => publishShell("environment-a"));
    expect(state.navigate).not.toHaveBeenCalled();
  });
  it("keeps failed imports retryable and reports a later success", async () => {
    state.import.mockResolvedValueOnce({
      _tag: "Failure",
      cause: Cause.fail(new Error("Import failed")),
    });
    await act(async () => render());
    await click("Refresh");
    await click("Import");
    expect(container.textContent).toContain("Import failed");
    expect(button("Import").disabled).toBe(false);
    await click("Import");
    expect(container.textContent).toContain("Imported 1 session.");
    expect(container.textContent).not.toContain("Import failed");
  });
  it("ignores an old environment's pending import result", async () => {
    const response = deferred<{
      _tag: "Success";
      value: { importedCount: number; skippedCount: number };
    }>();
    state.import.mockReturnValue(response.promise);
    await act(async () => render());
    await click("Refresh");
    await click("Import");
    expect(button("Importing…").disabled).toBe(true);
    await selectEnvironment("environment-b");
    await act(async () =>
      response.resolve({ _tag: "Success", value: { importedCount: 0, skippedCount: 1 } }),
    );
    expect(container.textContent).not.toContain("Skipped");
  });
});
