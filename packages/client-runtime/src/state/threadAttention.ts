import type { EnvironmentConnectionPhase } from "../connection/presentation.ts";

import { threadPlanReviewIsWaiting, type WorkingThreadInput } from "./threadInbox.ts";

// Needs approval is a pending approval only. Waiting for me is any turn a
// person has to answer: that approval, a question, or a settled plan. Failed
// is a failed runtime that is not a usage limit. A finished turn with none
// of those stays out of every named view, and All leaves the inbox alone.

export const ATTENTION_VIEWS = [
  { id: "all", label: "All" },
  { id: "needs-approval", label: "Needs approval" },
  { id: "failed", label: "Failed" },
  { id: "waiting-for-me", label: "Waiting for me" },
] as const;

export type AttentionViewId = (typeof ATTENTION_VIEWS)[number]["id"];

export type AttentionThread = WorkingThreadInput;

export interface AttentionViewCounts {
  readonly all: number;
  readonly "needs-approval": number;
  readonly failed: number;
  readonly "waiting-for-me": number;
}

function attentionViewById(value: string): AttentionViewId | null {
  for (const entry of ATTENTION_VIEWS) {
    if (entry.id === value) return entry.id;
  }
  return null;
}

export function attentionViewLabel(view: AttentionViewId): string {
  switch (view) {
    case "all":
      return "All";
    case "needs-approval":
      return "Needs approval";
    case "failed":
      return "Failed";
    case "waiting-for-me":
      return "Waiting for me";
    default: {
      const exhaustive: never = view;
      return exhaustive;
    }
  }
}

export function readAttentionView(value: unknown): AttentionViewId {
  if (typeof value !== "string") return "all";
  return attentionViewById(value) ?? "all";
}

export function attentionViewMenuId(view: AttentionViewId): string {
  return `attention:${view}`;
}

export function attentionViewFromMenuId(id: string): AttentionViewId | null {
  if (!id.startsWith("attention:")) return null;
  return attentionViewById(id.slice("attention:".length));
}

export function threadNeedsApproval(thread: AttentionThread): boolean {
  return thread.hasPendingApprovals;
}

export function threadFailed(thread: AttentionThread): boolean {
  return thread.runtime?.status === "failed" && thread.runtime.lastErrorClass !== "usage_limit";
}

export function threadWaitingForMe(thread: AttentionThread): boolean {
  return (
    thread.hasPendingApprovals || thread.hasPendingUserInput || threadPlanReviewIsWaiting(thread)
  );
}

export function threadMatchesAttentionView(
  thread: AttentionThread,
  view: AttentionViewId,
): boolean {
  switch (view) {
    case "all":
      return true;
    case "needs-approval":
      return threadNeedsApproval(thread);
    case "failed":
      return threadFailed(thread);
    case "waiting-for-me":
      return threadWaitingForMe(thread);
    default: {
      const exhaustive: never = view;
      return exhaustive;
    }
  }
}

export function filterThreadsByAttentionView<T extends AttentionThread>(
  threads: readonly T[],
  view: AttentionViewId,
): readonly T[] {
  if (view === "all") return threads;
  return threads.filter((thread) => threadMatchesAttentionView(thread, view));
}

export function countAttentionViews(threads: readonly AttentionThread[]): AttentionViewCounts {
  const counts: {
    all: number;
    "needs-approval": number;
    failed: number;
    "waiting-for-me": number;
  } = {
    all: threads.length,
    "needs-approval": 0,
    failed: 0,
    "waiting-for-me": 0,
  };
  for (const thread of threads) {
    if (threadNeedsApproval(thread)) counts["needs-approval"] += 1;
    if (threadFailed(thread)) counts.failed += 1;
    if (threadWaitingForMe(thread)) counts["waiting-for-me"] += 1;
  }
  return counts;
}

export function attentionEnvironmentsUnavailable(
  environments: readonly { readonly phase: EnvironmentConnectionPhase }[],
): number {
  let unavailable = 0;
  for (const environment of environments) {
    if (environment.phase !== "connected") unavailable += 1;
  }
  return unavailable;
}

export function attentionViewCountText(input: {
  readonly view: AttentionViewId;
  readonly matchedCount: number;
  readonly unavailableEnvironmentCount: number;
}): string | undefined {
  if (input.view === "all") return undefined;
  if (input.unavailableEnvironmentCount > 0) return "Count unavailable";
  return String(input.matchedCount);
}

export function attentionInboxEmptyCopy(input: {
  readonly view: AttentionViewId;
  readonly unavailableEnvironmentCount: number;
}): { readonly title: string; readonly detail: string } | null {
  if (input.view === "all") return null;
  if (input.unavailableEnvironmentCount > 0) {
    return {
      title: "Environment unavailable",
      detail: "This view cannot show a clear count until every environment is connected.",
    };
  }
  return {
    title: `Nothing in ${attentionViewLabel(input.view)}`,
    detail: "Threads that need this kind of attention will show up here.",
  };
}
