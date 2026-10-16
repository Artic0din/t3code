import { act } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import {
  EnvironmentId,
  ThreadId,
  TaskContextGroupId,
  type TaskContextGroupForThreadResult,
} from "@t3tools/contracts";

const queries = vi.hoisted(() => ({
  membership: {
    data: null as TaskContextGroupForThreadResult | null,
    isSuccess: false,
    isPending: true,
    error: null as string | null,
    refresh: () => undefined,
  },
  list: vi.fn(() => "list"),
}));

vi.mock("@effect/atom-react", () => ({
  useAtomValue: () => ({ environment: { capabilities: { taskContextGroups: true } } }),
}));
vi.mock("@tanstack/react-router", () => ({ useNavigate: () => vi.fn() }));
vi.mock("../../state/server", () => ({
  serverEnvironment: {
    configValueAtom: () => "config",
    taskContextGroupForThread: () => "membership",
    taskContextGroupsList: queries.list,
  },
}));
vi.mock("../../state/session", () => ({
  environmentSession: { sessionStateAtom: () => "session" },
}));
vi.mock("../../state/query", () => ({
  useEnvironmentQuery: (atom: string | null) =>
    atom === "membership"
      ? queries.membership
      : {
          data:
            atom === "session"
              ? { authenticated: true, scopes: ["orchestration:read", "orchestration:operate"] }
              : { groups: [] },
          isSuccess: true,
          isPending: false,
          error: null,
          refresh: () => undefined,
        },
}));
vi.mock("../../state/entities", () => ({ useProjects: () => [], useThreadShells: () => [] }));
vi.mock("../../state/use-atom-command", () => ({ useAtomCommand: () => vi.fn() }));

import { TaskContextGroupPanel } from "./TaskContextGroupPanel";

describe("TaskContextGroupPanel requests", () => {
  let renderer: ReactTestRenderer | undefined;
  afterEach(() => act(() => renderer?.unmount()));

  it("waits for successful membership before requesting the group picker", () => {
    queries.list.mockClear();
    const element = (
      <TaskContextGroupPanel
        environmentId={EnvironmentId.make("test")}
        threadId={ThreadId.make("thread:test")}
      />
    );
    const render = () =>
      act(() => {
        if (renderer) renderer.update(<TaskContextGroupPanel {...element.props} />);
        else renderer = create(element);
      });
    queries.membership.data = null;
    queries.membership.isPending = true;
    queries.membership.isSuccess = false;
    render();
    expect(queries.list).not.toHaveBeenCalled();
    queries.membership.isPending = false;
    queries.membership.error = "Membership unavailable";
    render();
    expect(queries.list).not.toHaveBeenCalled();
    queries.membership.error = null;
    queries.membership.isSuccess = true;
    queries.membership.data = { group: null, relatedThreads: [] };
    render();
    expect(queries.list).toHaveBeenCalledTimes(1);
    queries.list.mockClear();
    queries.membership.data = {
      group: {
        id: TaskContextGroupId.make("group:test"),
        title: "Shared task",
        brief: "Saved",
        resources: [],
        memberThreadIds: [ThreadId.make("thread:test")],
        createdAt: "2026-10-13T00:00:00.000Z",
        updatedAt: "2026-10-13T00:00:00.000Z",
      },
      relatedThreads: [],
    };
    render();
    expect(queries.list).not.toHaveBeenCalled();
  });
});
