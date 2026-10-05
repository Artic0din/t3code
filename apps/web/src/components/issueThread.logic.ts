import type { GitResolvedIssue } from "@t3tools/contracts";

/** The composer text a thread started from an issue opens with. */
export function buildIssuePrompt(issue: GitResolvedIssue): string {
  const body = issue.body?.trim();
  return [`Work on #${issue.number}: ${issue.title}`, body, issue.url]
    .filter((part): part is string => Boolean(part))
    .join("\n\n");
}

/** Never discards what the user already typed in a reused draft. */
export function mergeIssuePrompt(existing: string, issuePrompt: string, issueUrl: string): string {
  if (existing.trim().length === 0) return issuePrompt;
  if (existing.includes(issueUrl)) return existing;
  return `${existing.trimEnd()}\n\n${issuePrompt}`;
}
