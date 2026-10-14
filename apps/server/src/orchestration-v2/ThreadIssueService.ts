import {
  CommandId,
  issueAvailabilityFromFailure,
  linkedIssueFromResolved,
  nextLinkedIssue,
  OrchestratorMcpFailure,
  parseGitHubIssueUrl,
  relatedIssueThreads,
  ThreadId,
  type ThreadLinkedIssue,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as GitWorkflow from "../git/GitWorkflowService.ts";
import type { McpInvocationScope } from "../mcp/McpInvocationContext.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ThreadManagementService from "./ThreadManagementService.ts";

export class ThreadIssueService extends Context.Service<
  ThreadIssueService,
  {
    readonly link: (
      scope: McpInvocationScope,
      input: {
        readonly threadId?: ThreadId | undefined;
        readonly reference: string;
        readonly clientRequestId?: string | undefined;
      },
    ) => Effect.Effect<
      {
        readonly threadId: ThreadId;
        readonly linkedIssue: ThreadLinkedIssue;
        readonly alreadyLinked: boolean;
      },
      OrchestratorMcpFailure
    >;
    readonly unlink: (
      scope: McpInvocationScope,
      input: {
        readonly threadId?: ThreadId | undefined;
        readonly clientRequestId?: string | undefined;
      },
    ) => Effect.Effect<
      { readonly threadId: ThreadId; readonly unlinked: boolean },
      OrchestratorMcpFailure
    >;
    readonly related: (
      scope: McpInvocationScope,
      input: { readonly threadId?: ThreadId | undefined },
    ) => Effect.Effect<
      {
        readonly threadId: ThreadId;
        readonly linkedIssue: ThreadLinkedIssue | null;
        readonly threads: ReadonlyArray<{ readonly threadId: ThreadId; readonly title: string }>;
      },
      OrchestratorMcpFailure
    >;
  }
>()("t3/orchestration-v2/ThreadIssueService") {}

function failure(code: OrchestratorMcpFailure["code"], message: string): OrchestratorMcpFailure {
  return new OrchestratorMcpFailure({ code, message });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const make = Effect.gen(function* () {
  const crypto = yield* Crypto.Crypto;
  const threads = yield* ThreadManagementService.ThreadManagementService;
  const projects = yield* ProjectService.ProjectService;
  const git = yield* GitWorkflow.GitWorkflowService;

  const commandId = (input: {
    readonly scope: McpInvocationScope;
    readonly threadId: ThreadId;
    readonly action: string;
    readonly requestKey: string;
  }) =>
    CommandId.make(
      [
        "command",
        "mcp",
        encodeURIComponent(input.scope.requestNamespace),
        "thread-issue",
        encodeURIComponent(input.threadId),
        input.action,
        encodeURIComponent(input.requestKey),
      ].join(":"),
    );

  const requireThread = Effect.fn("ThreadIssueService.requireThread")(function* (
    scope: McpInvocationScope,
    threadId: ThreadId | undefined,
  ) {
    if (!scope.capabilities.has("orchestration")) {
      return yield* failure(
        "capability_denied",
        "This MCP credential does not grant orchestration capabilities.",
      );
    }
    const id = threadId ?? scope.thread?.threadId;
    if (id === undefined) {
      return yield* failure(
        "target_required",
        "Pass threadId: this MCP client is not running inside a T3 thread.",
      );
    }
    const shell = yield* threads
      .getThreadShell(id)
      .pipe(
        Effect.mapError((error) =>
          failure("orchestration_error", `Unable to locate thread ${id}: ${errorMessage(error)}`),
        ),
      );
    if (shell === null || shell.deletedAt !== null) {
      return yield* failure("thread_not_found", `Thread ${id} was not found.`);
    }
    return shell;
  });

  const link = Effect.fn("ThreadIssueService.link")(function* (
    scope: McpInvocationScope,
    input: {
      readonly threadId?: ThreadId | undefined;
      readonly reference: string;
      readonly clientRequestId?: string | undefined;
    },
  ) {
    const shell = yield* requireThread(scope, input.threadId);
    const project = yield* projects
      .getById(shell.projectId)
      .pipe(
        Effect.mapError((error) =>
          failure("orchestration_error", `Unable to read the project: ${errorMessage(error)}`),
        ),
      );
    const cwd = shell.worktreePath ?? (Option.isSome(project) ? project.value.workspaceRoot : null);
    if (cwd == null) {
      return yield* failure(
        "orchestration_error",
        `Thread ${shell.id} has no workspace to resolve an issue.`,
      );
    }
    const resolved = yield* git.resolveIssue({ cwd, reference: input.reference }).pipe(
      Effect.map((result) => linkedIssueFromResolved(result.issue)),
      Effect.catch((error) => {
        const availability = issueAvailabilityFromFailure(errorMessage(error));
        const parsed = parseGitHubIssueUrl(input.reference);
        if (availability === null || parsed === null) {
          return Effect.fail(
            failure(
              "orchestration_error",
              `Unable to resolve issue ${input.reference}: ${errorMessage(error)}`,
            ),
          );
        }
        return Effect.succeed({
          host: parsed.host,
          repository: parsed.repository,
          number: parsed.number,
          url: parsed.url,
          title: null,
          availability,
        } satisfies ThreadLinkedIssue);
      }),
    );
    if (resolved === null) {
      return yield* failure(
        "orchestration_error",
        `Issue ${input.reference} does not have a GitHub issue URL.`,
      );
    }
    const requestKey = input.clientRequestId ?? (yield* crypto.randomUUIDv4.pipe(Effect.orDie));
    const updateCommandId = commandId({
      scope,
      threadId: shell.id,
      action: "link",
      requestKey,
    });
    const alreadyLinked =
      nextLinkedIssue(shell.linkedIssue, {
        type: "thread.issue.link",
        ...resolved,
      }) === undefined;
    yield* threads
      .dispatch({
        type: "thread.issue.link",
        commandId: updateCommandId,
        threadId: shell.id,
        host: resolved.host,
        repository: resolved.repository,
        number: resolved.number,
        url: resolved.url,
        title: resolved.title,
        availability: resolved.availability,
      })
      .pipe(
        Effect.mapError((error) =>
          failure(
            "orchestration_error",
            `Unable to link issue on thread ${shell.id}: ${errorMessage(error)}`,
          ),
        ),
      );
    return { threadId: shell.id, linkedIssue: resolved, alreadyLinked };
  });

  const unlink = Effect.fn("ThreadIssueService.unlink")(function* (
    scope: McpInvocationScope,
    input: {
      readonly threadId?: ThreadId | undefined;
      readonly clientRequestId?: string | undefined;
    },
  ) {
    const shell = yield* requireThread(scope, input.threadId);
    const requestKey = input.clientRequestId ?? (yield* crypto.randomUUIDv4.pipe(Effect.orDie));
    const updateCommandId = commandId({ scope, threadId: shell.id, action: "unlink", requestKey });
    const current = shell.linkedIssue ?? null;
    yield* threads
      .dispatch({
        type: "thread.issue.unlink",
        commandId: updateCommandId,
        threadId: shell.id,
        ...(current === null
          ? { expectedIssue: null }
          : { host: current.host, repository: current.repository, number: current.number }),
      })
      .pipe(
        Effect.mapError((error) =>
          failure(
            "orchestration_error",
            `Unable to unlink issue on thread ${shell.id}: ${errorMessage(error)}`,
          ),
        ),
      );
    const updated = yield* requireThread(scope, shell.id);
    return { threadId: shell.id, unlinked: current !== null && updated.linkedIssue == null };
  });

  const related = Effect.fn("ThreadIssueService.related")(function* (
    scope: McpInvocationScope,
    input: { readonly threadId?: ThreadId | undefined },
  ) {
    const shell = yield* requireThread(scope, input.threadId);
    const linkedIssue = shell.linkedIssue ?? null;
    if (linkedIssue === null) return { threadId: shell.id, linkedIssue: null, threads: [] };
    const snapshot = yield* threads
      .getShellSnapshot()
      .pipe(
        Effect.mapError((error) =>
          failure("orchestration_error", `Unable to read threads: ${errorMessage(error)}`),
        ),
      );
    return {
      threadId: shell.id,
      linkedIssue,
      threads: relatedIssueThreads(
        [...snapshot.threads, ...snapshot.archivedThreads],
        linkedIssue,
        shell.id,
      ).map((thread) => ({ threadId: thread.id, title: thread.title })),
    };
  });

  return ThreadIssueService.of({ link, unlink, related });
});

export const layer: Layer.Layer<
  ThreadIssueService,
  never,
  | Crypto.Crypto
  | ThreadManagementService.ThreadManagementService
  | ProjectService.ProjectService
  | GitWorkflow.GitWorkflowService
> = Layer.effect(ThreadIssueService, make);
