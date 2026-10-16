import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  type AuthSessionState,
  type ExecutionEnvironmentCapabilities,
  type ProjectId,
  type TaskContextGroupMutateInput,
  type ThreadId,
} from "@t3tools/contracts";

export function taskContextAccess(
  capabilities: Pick<ExecutionEnvironmentCapabilities, "taskContextGroups"> | undefined,
  session: Pick<AuthSessionState, "authenticated" | "scopes"> | null,
) {
  const supported = capabilities?.taskContextGroups === true;
  const authenticated = supported && session?.authenticated === true;
  return {
    supported,
    readable: authenticated && session?.scopes?.includes(AuthOrchestrationReadScope) === true,
    writable: authenticated && session?.scopes?.includes(AuthOrchestrationOperateScope) === true,
  };
}

type ResourceInput = Extract<
  TaskContextGroupMutateInput,
  { action: "attach-resource" }
>["resource"];
export type TaskContextResourceDraft = {
  kind: ResourceInput["kind"];
  title: string;
  text: string;
  threadId: ThreadId | null;
  projectId: ProjectId | null;
};

export const TASK_CONTEXT_RESOURCE_KINDS = ["note", "url", "thread", "project"] as const;

export function taskContextBriefAfterMutation(input: {
  readonly threadId: ThreadId;
  readonly draft: string;
  readonly mutation: TaskContextGroupMutateInput;
  readonly savedBrief: string;
}): string {
  return input.mutation.action === "create" ||
    (input.mutation.action === "attach-thread" && input.mutation.threadId === input.threadId)
    ? input.savedBrief
    : input.draft;
}

export function taskContextResourceInput(draft: TaskContextResourceDraft): ResourceInput | null {
  switch (draft.kind) {
    case "note":
      return draft.title.trim()
        ? { kind: "note", title: draft.title.trim(), body: draft.text }
        : null;
    case "url":
      return draft.title.trim() && draft.text.trim()
        ? { kind: "url", title: draft.title.trim(), url: draft.text.trim() }
        : null;
    case "thread":
      return draft.threadId === null ? null : { kind: "thread", threadId: draft.threadId };
    case "project":
      return draft.projectId === null ? null : { kind: "project", projectId: draft.projectId };
  }
}
