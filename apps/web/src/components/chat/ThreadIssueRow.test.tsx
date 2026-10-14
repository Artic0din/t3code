import type { EnvironmentId, ThreadId, ThreadLinkedIssue } from "@t3tools/contracts";
import { RegistryContext } from "@effect/atom-react";
import { AtomRegistry } from "effect/reactivity";
import { act } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

type LinkResult = { readonly _tag: "Success" } | { readonly _tag: "Failure" };

const state = vi.hoisted(() => ({
  resolution: { data: null as unknown, error: null as string | null, isPending: false },
  archivedRequests: [] as EnvironmentId[],
  archivedState: "success" as "success" | "loading" | "failure",
  archivedThreads: [] as unknown[],
  updateArchived: (_registry: AtomRegistry.AtomRegistry, _threads: unknown[]) => {},
  navigate: vi.fn(),
  linkIssue: vi.fn<(request: unknown) => Promise<LinkResult>>(),
  unlinkIssue: vi.fn<(request: unknown) => Promise<LinkResult>>(),
}));

vi.mock("@tanstack/react-router", () => ({ useNavigate: () => state.navigate }));
vi.mock("~/state/threads", async () => {
  const { Atom } = await import("effect/reactivity");
  const snapshot = Atom.make(null);
  return {
    threadEnvironment: { snapshotAtom: () => snapshot, linkIssue: "link", unlinkIssue: "unlink" },
  };
});
vi.mock("~/state/use-atom-command", () => ({
  useAtomCommand: (command: string) => (command === "link" ? state.linkIssue : state.unlinkIssue),
}));
vi.mock("~/state/sourceControlActions", () => ({
  useIssueResolution: (target: { reference: string | null }) =>
    target.reference === null ? { data: null, error: null, isPending: false } : state.resolution,
}));
vi.mock("../../rpc/atomRegistry", () => ({ appAtomRegistry: { refresh: vi.fn() } }));
vi.mock("../../connection/catalog", async () => {
  const { Atom, AsyncResult } = await import("effect/reactivity");
  const connected = Atom.make(AsyncResult.success({ phase: "connected" }));
  return { environmentCatalog: { stateAtom: () => connected } };
});
vi.mock("../../state/orchestration", async () => {
  const { Atom, AsyncResult } = await import("effect/reactivity");
  const Cause = await import("effect/Cause");
  const live = Atom.make<unknown[] | null>(null);
  state.updateArchived = (registry, threads) => registry.set(live, threads);
  return {
    orchestrationEnvironment: {
      archivedShell: ({ environmentId }: { environmentId: EnvironmentId }) => {
        state.archivedRequests.push(environmentId);
        return Atom.make((get) =>
          state.archivedState === "loading"
            ? AsyncResult.initial(true)
            : state.archivedState === "failure"
              ? AsyncResult.failure(Cause.fail(new Error("offline")))
              : AsyncResult.success(
                  { threads: get(live) ?? state.archivedThreads },
                  { waiting: true },
                ),
        );
      },
      archivedShellSnapshot: ({ environmentId }: { environmentId: EnvironmentId }) => {
        state.archivedRequests.push(environmentId);
        return Atom.make(
          state.archivedState === "loading"
            ? AsyncResult.initial(true)
            : state.archivedState === "failure"
              ? AsyncResult.failure(Cause.fail(new Error("offline")))
              : AsyncResult.success({ threads: state.archivedThreads }),
        );
      },
    },
  };
});
vi.mock("~/components/ui/button", () => ({ Button: "button" }));
vi.mock("~/components/ui/input", () => ({ Input: "input" }));

import { ThreadIssueRow } from "./ThreadIssueRow";

const environmentId = "env-a" as EnvironmentId;
const issueUrl = "https://github.com/acme/web/issues/12";
const linkedIssue: ThreadLinkedIssue = {
  host: "github.com",
  repository: "acme/web",
  number: 12,
  url: issueUrl,
  title: "Fix login",
  availability: "open",
};

let renderer: ReactTestRenderer;
let registry: AtomRegistry.AtomRegistry;

function row(
  threadId: string,
  issue: ThreadLinkedIssue | null = null,
  environment = environmentId,
) {
  return (
    <RegistryContext.Provider value={registry}>
      <ThreadIssueRow
        environmentId={environment}
        threadId={threadId as ThreadId}
        cwd="/repo"
        linkedIssue={issue}
      />
    </RegistryContext.Provider>
  );
}

function input() {
  return renderer.root.findByType("input");
}

async function type(value: string) {
  await act(async () => input().props.onChange({ target: { value } }));
}

async function submit() {
  await act(async () => renderer.root.findByType("form").props.onSubmit({ preventDefault() {} }));
}

beforeEach(() => {
  registry = AtomRegistry.make();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  state.resolution = { data: null, error: null, isPending: false };
  state.archivedRequests = [];
  state.archivedState = "success";
  state.archivedThreads = [];
  state.navigate.mockReset();
  state.linkIssue.mockReset();
  state.linkIssue.mockResolvedValue({ _tag: "Success" });
  state.unlinkIssue.mockReset();
  state.unlinkIssue.mockResolvedValue({ _tag: "Success" });
});

afterEach(() => {
  act(() => renderer.unmount());
  registry.dispose();
  vi.unstubAllGlobals();
});

describe("ThreadIssueRow", () => {
  it.each([
    ["resolved", "Success"],
    ["resolved", "Failure"],
    ["unavailable", "Success"],
    ["unavailable", "Failure"],
  ] as const)("preserves newer input when a %s link returns %s", async (kind, result) => {
    state.resolution =
      kind === "resolved"
        ? {
            data: {
              issue: { number: 12, title: "Fix login", body: null, url: issueUrl, state: "open" },
            },
            error: null,
            isPending: false,
          }
        : { data: null, error: "GitHub issue not found (HTTP 404)", isPending: false };
    let finish: (result: LinkResult) => void = () => {};
    state.linkIssue.mockReturnValue(new Promise((resolve) => (finish = resolve)));
    await act(async () => {
      renderer = create(row("thread-a"));
    });
    await type(issueUrl);
    await submit();
    await type("https://github.com/acme/web/issues/13");
    await act(async () => finish({ _tag: result }));
    expect(input().props.value).toBe("https://github.com/acme/web/issues/13");
    expect(JSON.stringify(renderer.toJSON())).not.toContain("Could not link the issue.");
    expect(state.linkIssue).toHaveBeenCalledWith(
      expect.objectContaining({
        input: expect.objectContaining({ threadId: "thread-a", number: 12 }),
      }),
    );
  });

  it.each([
    ["GitHub issue not found (HTTP 404)", "missing"],
    ["GitHub permission denied (HTTP 403)", "inaccessible"],
  ])("links an unavailable issue: %s", async (error, availability) => {
    state.resolution = { data: null, error, isPending: false };
    await act(async () => {
      renderer = create(row("thread-a"));
    });

    await type(issueUrl);
    expect(JSON.stringify(renderer.toJSON())).toContain(error);
    expect(renderer.root.findByProps({ type: "submit" }).props.disabled).toBe(false);
    await submit();

    expect(state.linkIssue).toHaveBeenCalledWith({
      environmentId,
      input: {
        threadId: "thread-a",
        host: "github.com",
        repository: "acme/web",
        number: 12,
        url: issueUrl,
        title: null,
        availability,
      },
    });
  });

  it.each(["thread", "environment"])(
    "starts a fresh editor when the %s changes",
    async (target) => {
      state.resolution = {
        data: {
          issue: { number: 12, title: "Fix login", body: null, url: issueUrl, state: "open" },
        },
        error: null,
        isPending: false,
      };
      let finishLink: (result: LinkResult) => void = () => {};
      state.linkIssue.mockReturnValue(new Promise((resolve) => (finishLink = resolve)));
      await act(async () => {
        renderer = create(row("thread-a"));
      });

      await type(issueUrl);
      await submit();
      await act(async () =>
        renderer.update(
          target === "thread" ? row("thread-b") : row("thread-a", null, "env-b" as EnvironmentId),
        ),
      );

      expect(input().props.value).toBe("");
      await type("acme/web#13");
      await act(async () => finishLink({ _tag: "Success" }));

      expect(input().props.value).toBe("acme/web#13");
      expect(state.linkIssue).toHaveBeenCalledWith(
        expect.objectContaining({ input: expect.objectContaining({ threadId: "thread-a" }) }),
      );
    },
  );

  it.each(["link", "unlink"])(
    "ignores a late %s failure after leaving and returning to a target",
    async (command) => {
      state.resolution = {
        data: {
          issue: { number: 12, title: "Fix login", body: null, url: issueUrl, state: "open" },
        },
        error: null,
        isPending: false,
      };
      let finish: (result: LinkResult) => void = () => {};
      state[command === "link" ? "linkIssue" : "unlinkIssue"].mockReturnValue(
        new Promise((resolve) => (finish = resolve)),
      );
      await act(async () => {
        renderer = create(row("thread-a", linkedIssue));
      });
      if (command === "link") {
        await type(issueUrl);
        await submit();
      } else {
        await act(async () => renderer.root.findByProps({ children: "Unlink" }).props.onClick());
      }
      await act(async () => renderer.update(row("thread-b")));
      await act(async () => renderer.update(row("thread-a", linkedIssue)));
      await type("new reference");
      await act(async () => finish({ _tag: "Failure" }));
      expect(input().props.value).toBe("new reference");
      expect(JSON.stringify(renderer.toJSON())).not.toContain(`Could not ${command} the issue.`);
    },
  );

  it("displays lookup failures and clears them when the environment changes", async () => {
    state.resolution = { data: null, error: "GitHub connection failed", isPending: false };
    await act(async () => {
      renderer = create(row("thread-a"));
    });
    await type(issueUrl);
    expect(JSON.stringify(renderer.toJSON())).toContain("GitHub connection failed");
    expect(renderer.root.findByProps({ type: "submit" }).props.disabled).toBe(true);
    await act(async () => renderer.update(row("thread-a", null, "env-b" as EnvironmentId)));
    expect(input().props.value).toBe("");
    expect(JSON.stringify(renderer.toJSON())).not.toContain("GitHub connection failed");
  });

  it("keeps link submission disabled while resolution is pending", async () => {
    state.resolution = { data: null, error: null, isPending: true };
    await act(async () => {
      renderer = create(row("thread-a"));
    });
    await type(issueUrl);
    expect(renderer.root.findByProps({ type: "submit" }).props.disabled).toBe(true);
    await submit();
    expect(state.linkIssue).not.toHaveBeenCalled();
  });

  it("loads archived threads only when an issue is linked", async () => {
    await act(async () => {
      renderer = create(row("thread-a"));
    });
    expect(state.archivedRequests).toEqual([]);

    await act(async () => renderer.update(row("thread-a", linkedIssue)));
    expect(state.archivedRequests).toEqual([environmentId]);
    await act(async () => renderer.update(row("thread-a")));
    expect(state.archivedRequests).toEqual([environmentId]);
  });

  it("opens archived related work in the current environment", async () => {
    state.archivedThreads = [{ id: "archived-a", title: "Earlier work", linkedIssue }];
    await act(async () => {
      renderer = create(row("thread-a", linkedIssue));
    });
    await act(async () => renderer.root.findByProps({ children: "Earlier work" }).props.onClick());
    expect(state.navigate).toHaveBeenCalledWith({
      to: "/$environmentId/$threadId",
      params: { environmentId, threadId: "archived-a" },
    });
  });

  it("updates related archived work while the issue stays open", async () => {
    await act(async () => {
      renderer = create(row("thread-a", linkedIssue));
    });
    await act(async () => {
      state.updateArchived(registry, [
        { id: "archived-live", title: "New archived work", linkedIssue },
      ]);
    });
    expect(JSON.stringify(renderer.toJSON())).toContain("New archived work");
    await act(async () => state.updateArchived(registry, []));
    expect(JSON.stringify(renderer.toJSON())).not.toContain("New archived work");
  });

  it.each([
    ["loading", "Loading related threads."],
    ["failure", "Failed to load archived threads."],
  ] as const)(
    "shows the archived %s state without claiming there is no related work",
    async (status, message) => {
      state.archivedState = status;
      await act(async () => {
        renderer = create(row("thread-a", linkedIssue));
      });
      expect(JSON.stringify(renderer.toJSON())).toContain(message);
      expect(JSON.stringify(renderer.toJSON())).not.toContain("No other threads are linked");
    },
  );
});
