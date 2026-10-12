import { describe, expect, it } from "vite-plus/test";

import { ProjectId, TaskContextGroupId, TaskContextResourceId, ThreadId } from "./baseSchemas.ts";
import { ComposerContextId } from "./composerContext.ts";
import {
  buildTaskContextTurnSnapshot,
  isHttpUrl,
  linkedThreadDoesNotWidenWorkspace,
  mergeTaskContextIntoMessage,
  nextMemberThreadIds,
  nextResources,
  nextTaskContextGroupId,
  refuseClientPathResource,
  relatedTaskContextThreads,
  turnReceivedTaskContext,
  type TaskContextGroup,
} from "./taskContextGroup.ts";

const groupId = TaskContextGroupId.make("tcg:feature-auth");
const threadA = ThreadId.make("thread:frontend");
const threadB = ThreadId.make("thread:backend");
const projectA = ProjectId.make("project:frontend");
const projectB = ProjectId.make("project:backend");

const group = (patch: Partial<TaskContextGroup> = {}): TaskContextGroup => ({
  id: groupId,
  title: "Auth cutover",
  brief: "Ship auth across web and API.",
  resources: [],
  memberThreadIds: [threadA],
  createdAt: "2026-10-13T00:00:00.000Z",
  updatedAt: "2026-10-13T00:00:00.000Z",
  ...patch,
});

describe("task context group membership", () => {
  it("attaches and detaches threads idempotently", () => {
    expect(nextMemberThreadIds([threadA], threadB, "attach")).toEqual([threadA, threadB]);
    expect(nextMemberThreadIds([threadA, threadB], threadB, "attach")).toBeUndefined();
    expect(nextMemberThreadIds([threadA, threadB], threadB, "detach")).toEqual([threadA]);
    expect(nextMemberThreadIds([threadA], threadB, "detach")).toBeUndefined();
  });

  it("does not let a stale detach clear a newer group membership", () => {
    const current = TaskContextGroupId.make("tcg:other");
    expect(
      nextTaskContextGroupId(current, {
        type: "thread.task-context-group.detach",
        groupId,
      }),
    ).toBeUndefined();
    expect(
      nextTaskContextGroupId(groupId, {
        type: "thread.task-context-group.detach",
        groupId,
      }),
    ).toBeNull();
    expect(
      nextTaskContextGroupId(groupId, {
        type: "thread.task-context-group.attach",
        groupId,
      }),
    ).toBeUndefined();
  });

  it("finds related threads only for the same group", () => {
    const threads = [
      { id: threadA, title: "Frontend", taskContextGroupId: groupId },
      { id: threadB, title: "Backend", taskContextGroupId: groupId },
      {
        id: ThreadId.make("thread:other"),
        title: "Other",
        taskContextGroupId: TaskContextGroupId.make("tcg:other"),
      },
    ];
    expect(relatedTaskContextThreads(threads, groupId, threadA).map((thread) => thread.id)).toEqual(
      [threadB],
    );
  });
});

describe("task context resources", () => {
  it("refuses client filesystem paths as server authority", () => {
    expect(refuseClientPathResource({ kind: "note", path: "/Users/me/repo/src/a.ts" })).toMatch(
      /path/,
    );
    expect(
      refuseClientPathResource({ kind: "project", projectId: "project:x", worktreePath: "/tmp/x" }),
    ).toMatch(/worktreePath/);
    expect(refuseClientPathResource({ kind: "filesystem" })).toMatch(/filesystem/);
    expect(
      refuseClientPathResource({ kind: "url", title: "Docs", url: "https://example.com" }),
    ).toBeNull();
  });

  it("accepts only http(s) urls", () => {
    expect(isHttpUrl("https://example.com/docs")).toBe(true);
    expect(isHttpUrl("file:///tmp/secret")).toBe(false);
    expect(isHttpUrl("not a url")).toBe(false);
  });

  it("attaches and detaches resources without duplicates", () => {
    const note = {
      kind: "note" as const,
      resourceId: TaskContextResourceId.make("res:note"),
      title: "Decision",
      body: "Use shared brief.",
    };
    const project = {
      kind: "project" as const,
      resourceId: TaskContextResourceId.make("res:project"),
      projectId: projectB,
      name: "API",
      availability: "available" as const,
    };
    expect(nextResources([], { type: "attach", resource: note })).toEqual([note]);
    expect(nextResources([note], { type: "attach", resource: note })).toBeUndefined();
    expect(nextResources([note], { type: "attach", resource: project })).toEqual([note, project]);
    expect(nextResources([note, project], { type: "detach", resourceId: note.resourceId })).toEqual(
      [project],
    );
  });
});

describe("per-repository isolation", () => {
  it("keeps checkpoint cwd and project on the owning thread after linking", () => {
    expect(
      linkedThreadDoesNotWidenWorkspace({
        ownWorktreePath: "/wt/frontend",
        ownProjectId: projectA,
        siblingWorktreePath: "/wt/backend",
        siblingProjectId: projectB,
      }),
    ).toEqual({ checkpointCwd: "/wt/frontend", projectId: projectA });
  });
});

describe("turn snapshot inspectability", () => {
  it("snapshots the live brief onto a turn without rewriting older turns", () => {
    const first = mergeTaskContextIntoMessage({
      text: "Start the API change.",
      context: undefined,
      group: group({ brief: "v1 brief" }),
      capturedAt: "2026-10-13T01:00:00.000Z",
    });
    const firstSnapshot = turnReceivedTaskContext(first.context);
    expect(firstSnapshot?.brief).toBe("v1 brief");
    expect(first.text).toContain("t3-context://v1/task-context/");

    const second = mergeTaskContextIntoMessage({
      text: "Continue.",
      context: undefined,
      group: group({ brief: "v2 brief" }),
      capturedAt: "2026-10-13T02:00:00.000Z",
    });
    expect(turnReceivedTaskContext(first.context)?.brief).toBe("v1 brief");
    expect(turnReceivedTaskContext(second.context)?.brief).toBe("v2 brief");
  });

  it("builds a stable unknown context record for provider projection", () => {
    const built = buildTaskContextTurnSnapshot(group(), "2026-10-13T03:00:00.000Z");
    expect(built.record.kind).toBe("task-context");
    expect(built.record.contextId).toEqual(expect.any(String));
    expect(ComposerContextId.make(built.record.contextId)).toBe(built.record.contextId);
    expect(built.snapshot.memberThreadIds).toEqual([threadA]);
  });
});
