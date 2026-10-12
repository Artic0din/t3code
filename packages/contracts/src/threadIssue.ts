import * as Schema from "effect/Schema";

import { PositiveInt, ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";
import type { GitResolvedIssue } from "./git.ts";

/** Host, repository, and issue number. The same number on another host or repository is a different issue. */
export const ThreadIssueKey = Schema.Struct({
  host: TrimmedNonEmptyString,
  repository: TrimmedNonEmptyString,
  number: PositiveInt,
});
export type ThreadIssueKey = typeof ThreadIssueKey.Type;

/**
 * Last known reachability of a linked issue. `missing` and `inaccessible` stay on the
 * thread so the user can open, unlink, or relink them; they are not cleared on failure.
 */
export const ThreadIssueAvailability = Schema.Literals([
  "open",
  "closed",
  "missing",
  "inaccessible",
]);
export type ThreadIssueAvailability = typeof ThreadIssueAvailability.Type;

export const ThreadLinkedIssue = Schema.Struct({
  ...ThreadIssueKey.fields,
  url: TrimmedNonEmptyString,
  title: Schema.NullOr(TrimmedNonEmptyString),
  availability: ThreadIssueAvailability,
});
export type ThreadLinkedIssue = typeof ThreadLinkedIssue.Type;

function canonicalIssueKey(key: ThreadIssueKey): ThreadIssueKey {
  return {
    host: key.host
      .trim()
      .toLowerCase()
      .replace(/^www\./, ""),
    repository: key.repository.trim().toLowerCase(),
    number: key.number,
  };
}

export function canonicalThreadIssue(issue: ThreadLinkedIssue): ThreadLinkedIssue {
  return {
    ...canonicalIssueKey(issue),
    url: issue.url.trim(),
    title: issue.title?.trim() ? issue.title.trim() : null,
    availability: issue.availability,
  };
}

export function threadIssueKeysEqual(left: ThreadIssueKey, right: ThreadIssueKey): boolean {
  const a = canonicalIssueKey(left);
  const b = canonicalIssueKey(right);
  return a.host === b.host && a.repository === b.repository && a.number === b.number;
}

/** GitHub issue URL, including GitHub Enterprise hostnames. Pull request URLs are not issues. */
export function parseGitHubIssueUrl(
  value: string,
): (ThreadIssueKey & { readonly url: string }) | null {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    return null;
  }
  const parts = url.pathname.split("/").filter((part) => part.length > 0);
  const issuesIndex = parts.indexOf("issues");
  if (issuesIndex < 2) return null;
  const number = Number(parts[issuesIndex + 1]);
  if (!Number.isInteger(number) || number <= 0) return null;
  const host = url.hostname
    .trim()
    .toLowerCase()
    .replace(/^www\./, "");
  const repository = `${parts[issuesIndex - 2]}/${parts[issuesIndex - 1]}`.toLowerCase();
  return {
    host,
    repository,
    number,
    url: `${url.protocol}//${url.host}/${repository}/issues/${number}`,
  };
}

export function linkedIssueFromResolved(issue: GitResolvedIssue): ThreadLinkedIssue | null {
  const parsed = parseGitHubIssueUrl(issue.url);
  if (parsed === null || parsed.number !== issue.number) return null;
  return canonicalThreadIssue({
    host: parsed.host,
    repository: parsed.repository,
    number: parsed.number,
    url: parsed.url,
    title: issue.title,
    availability: issue.state,
  });
}

/** Classify a failed issue lookup. Null means the failure is not an issue-availability state. */
export function issueAvailabilityFromFailure(detail: string): "missing" | "inaccessible" | null {
  const text = detail.toLowerCase();
  if (
    text.includes("not found") ||
    text.includes("could not find") ||
    text.includes("no issue") ||
    text.includes("404")
  ) {
    return "missing";
  }
  if (
    text.includes("auth") ||
    text.includes("forbidden") ||
    text.includes("permission") ||
    text.includes("401") ||
    text.includes("403") ||
    text.includes("credential") ||
    text.includes("login")
  ) {
    return "inaccessible";
  }
  return null;
}

export function linkedIssuesEqual(
  left: ThreadLinkedIssue | null | undefined,
  right: ThreadLinkedIssue | null | undefined,
): boolean {
  if (left == null || right == null) return left == null && right == null;
  const a = canonicalThreadIssue(left);
  const b = canonicalThreadIssue(right);
  return (
    a.host === b.host &&
    a.repository === b.repository &&
    a.number === b.number &&
    a.url === b.url &&
    a.title === b.title &&
    a.availability === b.availability
  );
}

/**
 * Next stored issue for a link or unlink. `undefined` means the command changes nothing,
 * so a repeated link does not create a second association and a stale unlink does not
 * clear a newer one.
 */
export function nextLinkedIssue(
  current: ThreadLinkedIssue | null | undefined,
  command:
    | {
        readonly type: "thread.issue.link";
        readonly host: string;
        readonly repository: string;
        readonly number: number;
        readonly url: string;
        readonly title: string | null;
        readonly availability: ThreadIssueAvailability;
      }
    | {
        readonly type: "thread.issue.unlink";
        readonly host: string;
        readonly repository: string;
        readonly number: number;
      },
): ThreadLinkedIssue | null | undefined {
  if (command.type === "thread.issue.unlink") {
    if (current == null || !threadIssueKeysEqual(current, command)) return undefined;
    return null;
  }
  const next = canonicalThreadIssue({
    host: command.host,
    repository: command.repository,
    number: command.number,
    url: command.url,
    title: command.title,
    availability: command.availability,
  });
  if (linkedIssuesEqual(current, next)) return undefined;
  return next;
}

export function relatedIssueThreads<
  T extends { readonly id: ThreadId; readonly linkedIssue?: ThreadLinkedIssue | null | undefined },
>(threads: readonly T[], issue: ThreadIssueKey, exceptThreadId?: ThreadId): readonly T[] {
  return threads.filter(
    (thread) =>
      thread.id !== exceptThreadId &&
      thread.linkedIssue != null &&
      threadIssueKeysEqual(thread.linkedIssue, issue),
  );
}

/**
 * The issue that may be written when a draft is sent. A cancelled draft and a send that
 * does not belong to the draft that holds the issue both write nothing.
 */
export function durableIssueForSend(input: {
  readonly linkedIssue: ThreadLinkedIssue | null | undefined;
  readonly cancelled: boolean;
  readonly belongsToDraft: boolean;
}): ThreadLinkedIssue | null {
  if (input.cancelled || !input.belongsToDraft) return null;
  return input.linkedIssue ?? null;
}

/** A resolve or link result applies only while the user is still on the environment that asked. */
export function issueLinkApplies(input: {
  readonly requestedEnvironmentId: string;
  readonly activeEnvironmentId: string;
}): boolean {
  return input.requestedEnvironmentId === input.activeEnvironmentId;
}

/** Latest explicit issue start wins. An unparseable URL leaves the draft's current issue alone. */
export const ThreadIssueMcpLinkInput = Schema.Struct({
  threadId: Schema.optional(ThreadId),
  reference: TrimmedNonEmptyString,
  clientRequestId: Schema.optional(TrimmedNonEmptyString),
});
export type ThreadIssueMcpLinkInput = typeof ThreadIssueMcpLinkInput.Type;

export const ThreadIssueMcpThreadInput = Schema.Struct({
  threadId: Schema.optional(ThreadId),
  clientRequestId: Schema.optional(TrimmedNonEmptyString),
});
export type ThreadIssueMcpThreadInput = typeof ThreadIssueMcpThreadInput.Type;

export const ThreadIssueMcpLinkResult = Schema.Struct({
  threadId: ThreadId,
  linkedIssue: ThreadLinkedIssue,
  alreadyLinked: Schema.Boolean,
});
export type ThreadIssueMcpLinkResult = typeof ThreadIssueMcpLinkResult.Type;

export const ThreadIssueMcpUnlinkResult = Schema.Struct({
  threadId: ThreadId,
  unlinked: Schema.Boolean,
});
export type ThreadIssueMcpUnlinkResult = typeof ThreadIssueMcpUnlinkResult.Type;

export const ThreadIssueMcpRelatedResult = Schema.Struct({
  threadId: ThreadId,
  linkedIssue: Schema.NullOr(ThreadLinkedIssue),
  threads: Schema.Array(Schema.Struct({ threadId: ThreadId, title: Schema.String })),
});
export type ThreadIssueMcpRelatedResult = typeof ThreadIssueMcpRelatedResult.Type;

export function draftIssueAfterStart(
  current: ThreadLinkedIssue | null | undefined,
  issue: GitResolvedIssue,
): ThreadLinkedIssue | null | undefined {
  return linkedIssueFromResolved(issue) ?? current;
}
