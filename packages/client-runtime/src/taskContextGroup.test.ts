import { describe, expect, it } from "vite-plus/test";
import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  ProjectId,
  TaskContextGroupId,
  ThreadId,
} from "@t3tools/contracts";
import {
  taskContextAccess,
  taskContextResourceInput,
  taskContextBriefAfterMutation,
} from "./taskContextGroup.ts";

describe("shared context brief editing", () => {
  it("preserves the saved brief through joining and then saving without edits", () => {
    const threadId = ThreadId.make("thread:joining");
    const groupId = TaskContextGroupId.make("group:existing");
    const savedBrief = "Coordinate the shared task.";
    const draft = taskContextBriefAfterMutation({
      threadId,
      draft: "",
      savedBrief,
      mutation: { action: "attach-thread", groupId, threadId },
    });
    const save = { action: "update-brief" as const, groupId, brief: draft };
    expect(save.brief).toBe(savedBrief);
    const pendingEdit = "Unsaved local revision";
    expect(
      taskContextBriefAfterMutation({
        threadId,
        draft: pendingEdit,
        savedBrief,
        mutation: {
          action: "attach-thread",
          groupId,
          threadId: ThreadId.make("thread:another-member"),
        },
      }),
    ).toBe(pendingEdit);
  });
});

describe("shared context client access", () => {
  it("requires server support and an authenticated read grant before mounting queries", () => {
    const session = { authenticated: true, scopes: [AuthOrchestrationReadScope] };
    expect(taskContextAccess({}, session).readable).toBe(false);
    expect(
      taskContextAccess({ taskContextGroups: true }, { ...session, authenticated: false }).readable,
    ).toBe(false);
    expect(
      taskContextAccess({ taskContextGroups: true }, { ...session, scopes: [] }).readable,
    ).toBe(false);
    expect(taskContextAccess({ taskContextGroups: true }, session)).toEqual({
      supported: true,
      readable: true,
      writable: false,
    });
  });

  it("enables mutations only while the destination session holds the operate grant", () => {
    const capabilities = { taskContextGroups: true };
    expect(taskContextAccess(capabilities, null).writable).toBe(false);
    expect(
      taskContextAccess(capabilities, {
        authenticated: true,
        scopes: [AuthOrchestrationReadScope, AuthOrchestrationOperateScope],
      }).writable,
    ).toBe(true);
    expect(
      taskContextAccess(capabilities, { authenticated: true, scopes: [AuthOrchestrationReadScope] })
        .writable,
    ).toBe(false);
  });
});

describe("shared context resource drafts", () => {
  it("requires explicit references and preserves note content when producing wire input", () => {
    const draft = {
      kind: "thread" as const,
      title: "Unrelated draft",
      text: "/local/path",
      threadId: null,
      projectId: null,
    };
    expect(taskContextResourceInput(draft)).toBeNull();
    const threadId = ThreadId.make("thread:selected");
    expect(taskContextResourceInput({ ...draft, threadId })).toEqual({ kind: "thread", threadId });
    const projectId = ProjectId.make("project:selected");
    expect(taskContextResourceInput({ ...draft, kind: "project", projectId })).toEqual({
      kind: "project",
      projectId,
    });
    expect(
      taskContextResourceInput({
        ...draft,
        kind: "note",
        title: " Decision ",
        text: "  Exact note\n",
      }),
    ).toEqual({ kind: "note", title: "Decision", body: "  Exact note\n" });
    expect(
      taskContextResourceInput({
        ...draft,
        kind: "url",
        title: " Docs ",
        text: " https://example.com/docs ",
      }),
    ).toEqual({ kind: "url", title: "Docs", url: "https://example.com/docs" });
  });
});
