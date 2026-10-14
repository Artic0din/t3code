import type { EnvironmentId, ThreadId, ThreadLinkedIssue } from "@t3tools/contracts";
import { RegistryContext } from "@effect/atom-react";
import { AtomRegistry } from "effect/reactivity";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const state = vi.hoisted(() => ({
  archivedRequests: [] as EnvironmentId[],
  archivedState: "success" as "success" | "loading" | "failure",
}));

vi.mock("react-native", () => ({
  Linking: { openURL: vi.fn() },
  Pressable: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  ScrollView: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  Text: ({ children }: { children: ReactNode }) => <span>{children}</span>,
  View: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));
vi.mock("expo-haptics", () => ({ selectionAsync: vi.fn() }));
vi.mock("@react-navigation/native", () => ({
  StackActions: { push: vi.fn() },
  useNavigation: () => ({ dispatch: vi.fn() }),
}));
vi.mock("../../state/threads", async () => {
  const { Atom } = await import("effect/reactivity");
  const snapshot = Atom.make(null);
  return { threadEnvironment: { snapshotAtom: () => snapshot, unlinkIssue: "unlink" } };
});
vi.mock("../../state/use-atom-command", () => ({ useAtomCommand: () => vi.fn() }));
vi.mock("../../state/atom-registry", () => ({ appAtomRegistry: { refresh: vi.fn() } }));
vi.mock("../../connection/catalog", async () => {
  const { Atom, AsyncResult } = await import("effect/reactivity");
  const connected = Atom.make(AsyncResult.success({ phase: "connected" }));
  return { environmentCatalog: { stateAtom: () => connected } };
});
vi.mock("../../state/orchestration", async () => {
  const { Atom, AsyncResult } = await import("effect/reactivity");
  const Cause = await import("effect/Cause");
  return {
    orchestrationEnvironment: {
      archivedShell: ({ environmentId }: { environmentId: EnvironmentId }) => {
        state.archivedRequests.push(environmentId);
        return Atom.make(
          state.archivedState === "loading"
            ? AsyncResult.initial(true)
            : state.archivedState === "failure"
              ? AsyncResult.failure(Cause.fail(new Error("offline")))
              : AsyncResult.success(
                  {
                    threads: [
                      {
                        id: "archived-thread",
                        title: "Earlier work",
                        linkedIssue: {
                          host: "github.com",
                          repository: "acme/web",
                          number: 12,
                        },
                      },
                    ],
                  },
                  { waiting: true },
                ),
        );
      },
    },
  };
});

import { ThreadIssueBanner } from "./ThreadIssueBanner";

const environmentId = "env-a" as EnvironmentId;
const linkedIssue: ThreadLinkedIssue = {
  host: "github.com",
  repository: "acme/web",
  number: 12,
  url: "https://github.com/acme/web/issues/12",
  title: "Fix login",
  availability: "open",
};

function render(issue: ThreadLinkedIssue | null) {
  const registry = AtomRegistry.make();
  try {
    return renderToStaticMarkup(
      <RegistryContext.Provider value={registry}>
        <ThreadIssueBanner
          environmentId={environmentId}
          threadId={"thread-a" as ThreadId}
          linkedIssue={issue}
        />
      </RegistryContext.Provider>,
    );
  } finally {
    registry.dispose();
  }
}

beforeEach(() => {
  state.archivedRequests = [];
  state.archivedState = "success";
});

describe("ThreadIssueBanner", () => {
  it("loads archived threads only when an issue is linked", () => {
    expect(render(null)).toBe("");
    expect(state.archivedRequests).toEqual([]);

    expect(render(linkedIssue)).toContain("Fix login");
    expect(state.archivedRequests).toEqual([environmentId]);
  });

  it("includes archived work on the same issue", () => {
    expect(render(linkedIssue)).toContain("Earlier work");
  });

  it.each([
    ["loading", "Loading related threads."],
    ["failure", "Failed to load archived threads."],
  ] as const)("shows the archived %s state", (status, message) => {
    state.archivedState = status;
    expect(render(linkedIssue)).toContain(message);
  });
});
