import type { GitResolvedIssue } from "@t3tools/contracts";

/** The composer text a thread started from an issue opens with. */
export function buildIssuePrompt(issue: GitResolvedIssue): string {
  const body = issue.body?.trim();
  return [`Work on #${issue.number}: ${issue.title}`, body, issue.url]
    .filter((part): part is string => Boolean(part))
    .join("\n\n");
}

function containsUrlToken(text: string, url: string): boolean {
  return text.split(/\s+/).some((token) => token.replace(/[.,!?;:)\]}>]+$/, "") === url);
}

/**
 * The project keeps one draft, so starting an issue reuses it. Text the user typed is kept and the
 * same issue is never added twice. `previousPrefill` is the exact text an earlier issue start wrote;
 * a draft still equal to it is replaced, so two issues never end up in one prompt.
 */
export function mergeIssuePrompt(
  existing: string,
  issuePrompt: string,
  issueUrl: string,
  previousPrefill?: string,
): string {
  if (existing.trim().length === 0 || existing === previousPrefill) return issuePrompt;
  if (containsUrlToken(existing, issueUrl)) return existing;
  return `${existing.trimEnd()}\n\n${issuePrompt}`;
}

/**
 * Next draft text for an issue start, plus the text a later start may replace. Only a prompt the
 * issue fully owns is replaceable; once user text is mixed in, later starts append instead.
 */
export function applyIssuePrefill(
  existing: string,
  previousPrefill: string | undefined,
  issue: GitResolvedIssue,
): { readonly prompt: string; readonly prefill: string | undefined } {
  const issuePrompt = buildIssuePrompt(issue);
  const prompt = mergeIssuePrompt(existing, issuePrompt, issue.url, previousPrefill);
  return { prompt, prefill: prompt === issuePrompt ? prompt : undefined };
}
