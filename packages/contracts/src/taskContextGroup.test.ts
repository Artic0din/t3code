import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";

import { ProjectId, TaskContextGroupId, TaskContextResourceId, ThreadId } from "./baseSchemas.ts";
import { ComposerContextId, OrchestrationMessageContext } from "./composerContext.ts";
import {
  buildTaskContextTurnSnapshot,
  isHttpUrl,
  linkedThreadDoesNotWidenWorkspace,
  mergeTaskContextIntoMessage,
  restoreFrozenTaskContextIntoMessage,
  nextMemberThreadIds,
  nextResources,
  nextTaskContextGroupId,
  refuseClientPathResource,
  relatedTaskContextThreads,
  turnReceivedTaskContext,
  TaskContextGroup,
} from "./taskContextGroup.ts";

const groupId = TaskContextGroupId.make("tcg:feature-auth");
const threadA = ThreadId.make("thread:frontend");
const threadB = ThreadId.make("thread:backend");
const projectA = ProjectId.make("project:frontend");
const projectB = ProjectId.make("project:backend");
const isTaskContextGroup = Schema.is(TaskContextGroup);
const encodeMessageContext = Schema.encodeSync(OrchestrationMessageContext);

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
  it("restores the trusted queued brief and resolves collisions with replacement context", () => {
    const frozen = mergeTaskContextIntoMessage({
      text: "Work",
      context: undefined,
      group: group(),
      capturedAt: "2026-10-13T00:00:00.000Z",
    });
    const record = frozen.context!.records[0]!;
    const forged = buildTaskContextTurnSnapshot(
      group({ brief: "Forged" }),
      "2026-10-14T00:00:00.000Z",
    ).record;
    const restored = restoreFrozenTaskContextIntoMessage({
      text: "Edit [forged](t3-context://v1/task-context/forged)",
      context: {
        version: 1,
        records: [
          {
            version: 1,
            kind: "note",
            contextId: record.contextId,
            label: "Note",
            payload: { body: "Keep this note" },
          },
          { ...forged, contextId: ComposerContextId.make("forged") },
        ],
      },
      frozenContext: frozen.context,
    });
    expect(turnReceivedTaskContext(restored.context)).toEqual(
      turnReceivedTaskContext(frozen.context),
    );
    expect(restored.context?.records).toHaveLength(2);
    const snapshot = restored.context!.records[1]!;
    expect(snapshot.contextId).not.toBe(record.contextId);
    expect(restored.text).toContain(`/task-context/${snapshot.contextId})`);
    expect(restored.text).not.toContain("/forged)");
    expect(restored.context!.records[0]).toEqual({
      version: 1,
      kind: "note",
      contextId: record.contextId,
      label: "Note",
      payload: { body: "Keep this note" },
    });
  });

  it("keeps queued slash commands exact and removes snapshots when no frozen snapshot exists", () => {
    const frozen = mergeTaskContextIntoMessage({
      text: "Work",
      context: undefined,
      group: group(),
      capturedAt: "2026-10-13T00:00:00.000Z",
    });
    const slash = restoreFrozenTaskContextIntoMessage({
      text: " /compact",
      context: undefined,
      frozenContext: frozen.context,
    });
    expect(slash.text).toBe(" /compact");
    expect(turnReceivedTaskContext(slash.context)).toEqual(turnReceivedTaskContext(frozen.context));
    const absent = restoreFrozenTaskContextIntoMessage({
      text: frozen.text,
      context: frozen.context,
      frozenContext: undefined,
    });
    expect(absent.text.trim()).toBe("Work");
    expect(absent.context).toBeUndefined();
  });
  it("removes server-owned context from a send after detaching", () => {
    const previous = mergeTaskContextIntoMessage({
      text: "Work",
      context: undefined,
      group: group(),
      capturedAt: "2026-10-13T00:00:00.000Z",
    });
    const detached = mergeTaskContextIntoMessage({
      text: previous.text,
      context: previous.context,
      group: null,
      capturedAt: "2026-10-13T01:00:00.000Z",
    });
    expect(detached.text.trim()).toBe("Work");
    expect(turnReceivedTaskContext(detached.context)).toBeNull();
  });

  it("rejects content that cannot fit in a durable context record", () => {
    const oversized = group({
      brief: "b".repeat(32_000),
      resources: [0, 1].map((i) => ({
        kind: "note" as const,
        resourceId: TaskContextResourceId.make(`note_${i}`),
        title: "Note",
        body: "n".repeat(16_000),
      })),
    });
    expect(isTaskContextGroup(oversized)).toBe(false);
  });

  it("keeps slash commands unchanged", () => {
    expect(
      mergeTaskContextIntoMessage({
        text: " /compact",
        context: undefined,
        group: group(),
        capturedAt: "2026-10-13T00:00:00.000Z",
      }),
    ).toEqual({
      text: " /compact",
      context: undefined,
    });
  });

  it("replaces incoming task snapshots with one record and matching references", () => {
    const previous = ["old_a", "old_b"].map((id) => ({
      ...buildTaskContextTurnSnapshot(group(), "2026-10-13T00:00:00.000Z").record,
      contextId: ComposerContextId.make(id),
    }));
    const merged = mergeTaskContextIntoMessage({
      text: "[Old](t3-context://v1/task-context/old_a) and [Other](t3-context://v1/task-context/old_b)",
      context: { version: 1, records: previous },
      group: group({ brief: "Current" }),
      capturedAt: "2026-10-13T00:00:00.000Z",
    });
    const encoded = encodeMessageContext(merged.context!);
    expect(encoded.records).toHaveLength(1);
    expect(merged.text).not.toContain("/old_");
    expect(turnReceivedTaskContext(merged.context)?.brief).toBe("Current");
  });

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
