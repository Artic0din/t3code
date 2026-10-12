import { ProviderInstanceId, RunId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { isThreadWorking } from "./threadInbox.ts";
import {
  ATTENTION_VIEWS,
  attentionEnvironmentsUnavailable,
  attentionInboxEmptyCopy,
  attentionViewCountText,
  attentionViewFromMenuId,
  attentionViewLabel,
  countAttentionViews,
  filterThreadsByAttentionView,
  readAttentionView,
  type AttentionThread,
} from "./threadAttention.ts";

function thread(patch: Partial<AttentionThread> = {}): AttentionThread {
  return {
    hasActionableProposedPlan: false,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    interactionMode: "default",
    latestRun: null,
    runtime: null,
    ...patch,
  };
}

const completedRun = {
  runId: RunId.make("run-done"),
  status: "completed" as const,
  requestedAt: "2026-06-01T00:00:00.000Z",
  startedAt: "2026-06-01T00:00:00.000Z",
  completedAt: "2026-06-01T00:01:00.000Z",
  assistantMessageId: null,
};

const idleRuntime = {
  status: "idle" as const,
  activeRunId: null,
  providerInstanceId: ProviderInstanceId.make("codex"),
  providerName: "Codex",
  lastError: null,
  lastErrorClass: null,
  updatedAt: "2026-06-01T00:01:00.000Z",
};

describe("attention view membership", () => {
  it("keeps a pending approval out of failure and ordinary completion", () => {
    const approval = thread({
      hasPendingApprovals: true,
      latestRun: { ...completedRun, status: "waiting" },
      runtime: { ...idleRuntime, status: "waiting", activeRunId: RunId.make("run-done") },
    });

    expect(filterThreadsByAttentionView([approval], "needs-approval")).toEqual([approval]);
    expect(filterThreadsByAttentionView([approval], "waiting-for-me")).toEqual([approval]);
    expect(filterThreadsByAttentionView([approval], "failed")).toEqual([]);
    expect(isThreadWorking(approval)).toBe(false);
  });

  it("treats a question as waiting for the user and not as an approval or a failure", () => {
    const question = thread({
      hasPendingUserInput: true,
      latestRun: { ...completedRun, status: "waiting" },
      runtime: { ...idleRuntime, status: "running", activeRunId: RunId.make("run-done") },
    });

    expect(filterThreadsByAttentionView([question], "waiting-for-me")).toEqual([question]);
    expect(filterThreadsByAttentionView([question], "needs-approval")).toEqual([]);
    expect(filterThreadsByAttentionView([question], "failed")).toEqual([]);
  });

  it("treats a settled plan as waiting for review and a running plan as ordinary work", () => {
    const planReady = thread({
      interactionMode: "plan",
      hasActionableProposedPlan: true,
      latestRun: completedRun,
      runtime: idleRuntime,
    });
    const planRunning = thread({
      interactionMode: "plan",
      hasActionableProposedPlan: true,
      latestRun: { ...completedRun, status: "running", completedAt: null },
      runtime: { ...idleRuntime, status: "running", activeRunId: RunId.make("run-done") },
    });
    const finished = thread({
      latestRun: completedRun,
      runtime: { ...idleRuntime, status: "completed" },
    });

    expect(filterThreadsByAttentionView([planReady], "waiting-for-me")).toEqual([planReady]);
    expect(filterThreadsByAttentionView([planReady], "needs-approval")).toEqual([]);
    expect(filterThreadsByAttentionView([planReady], "failed")).toEqual([]);
    expect(isThreadWorking(planReady)).toBe(false);
    expect(filterThreadsByAttentionView([planRunning], "waiting-for-me")).toEqual([]);
    expect(isThreadWorking(planRunning)).toBe(true);
    expect(filterThreadsByAttentionView([finished], "waiting-for-me")).toEqual([]);
    expect(filterThreadsByAttentionView([finished], "needs-approval")).toEqual([]);
    expect(filterThreadsByAttentionView([finished], "failed")).toEqual([]);
  });

  it("keeps a failed runtime out of waiting and a usage limit out of failed", () => {
    const failed = thread({
      latestRun: { ...completedRun, status: "failed" },
      runtime: { ...idleRuntime, status: "failed" },
    });
    const limited = thread({
      latestRun: { ...completedRun, status: "failed" },
      runtime: { ...idleRuntime, status: "failed", lastErrorClass: "usage_limit" },
    });

    expect(filterThreadsByAttentionView([failed], "failed")).toEqual([failed]);
    expect(filterThreadsByAttentionView([failed], "waiting-for-me")).toEqual([]);
    expect(filterThreadsByAttentionView([failed], "needs-approval")).toEqual([]);
    expect(filterThreadsByAttentionView([limited], "failed")).toEqual([]);
    expect(filterThreadsByAttentionView([limited], "waiting-for-me")).toEqual([]);
  });

  it("uses the live runtime when a failed run and a later run disagree", () => {
    const failedThenRunning = thread({
      latestRun: { ...completedRun, status: "failed" },
      runtime: { ...idleRuntime, status: "running", activeRunId: RunId.make("run-next") },
    });
    const completedThenFailed = thread({
      latestRun: completedRun,
      runtime: { ...idleRuntime, status: "failed" },
    });
    const failedAndAsking = thread({
      hasPendingApprovals: true,
      latestRun: { ...completedRun, status: "failed" },
      runtime: { ...idleRuntime, status: "failed" },
    });

    expect(filterThreadsByAttentionView([failedThenRunning], "failed")).toEqual([]);
    expect(filterThreadsByAttentionView([completedThenFailed], "failed")).toEqual([
      completedThenFailed,
    ]);
    expect(filterThreadsByAttentionView([failedAndAsking], "failed")).toEqual([failedAndAsking]);
    expect(filterThreadsByAttentionView([failedAndAsking], "needs-approval")).toEqual([
      failedAndAsking,
    ]);
    expect(filterThreadsByAttentionView([failedAndAsking], "waiting-for-me")).toEqual([
      failedAndAsking,
    ]);
  });
});

describe("attention view selection", () => {
  it("restores a saved view and returns unknown or missing values to All", () => {
    const threads = [
      thread({ hasPendingApprovals: true }),
      thread({ latestRun: completedRun, runtime: { ...idleRuntime, status: "completed" } }),
    ];

    expect(readAttentionView("needs-approval")).toBe("needs-approval");
    expect(readAttentionView("failed")).toBe("failed");
    expect(readAttentionView("waiting-for-me")).toBe("waiting-for-me");
    expect(readAttentionView("all")).toBe("all");
    expect(readAttentionView(undefined)).toBe("all");
    expect(readAttentionView(null)).toBe("all");
    expect(readAttentionView("kanban")).toBe("all");
    expect(filterThreadsByAttentionView(threads, readAttentionView("all"))).toBe(threads);
    expect(filterThreadsByAttentionView(threads, readAttentionView("needs-approval"))).toEqual([
      threads[0],
    ]);
    expect(attentionViewFromMenuId("attention:failed")).toBe("failed");
    expect(attentionViewFromMenuId("attention:all")).toBe("all");
    expect(attentionViewFromMenuId("attention:kanban")).toBeNull();
    expect(attentionViewFromMenuId("project:all")).toBeNull();
  });

  it("preserves inbox order and counts each view from the same summaries", () => {
    const approval = thread({ hasPendingApprovals: true });
    const question = thread({ hasPendingUserInput: true });
    const failed = thread({ runtime: { ...idleRuntime, status: "failed" } });
    const finished = thread({
      latestRun: completedRun,
      runtime: { ...idleRuntime, status: "completed" },
    });
    const threads = [finished, failed, question, approval];

    expect(filterThreadsByAttentionView(threads, "waiting-for-me")).toEqual([question, approval]);
    expect(countAttentionViews(threads)).toEqual({
      all: 4,
      "needs-approval": 1,
      failed: 1,
      "waiting-for-me": 2,
    });
    for (const entry of ATTENTION_VIEWS) {
      expect(attentionViewLabel(entry.id)).toBe(entry.label);
    }
  });

  it("does not present an unavailable environment as zero pending work", () => {
    expect(attentionEnvironmentsUnavailable([{ phase: "connected" }, { phase: "offline" }])).toBe(
      1,
    );
    expect(attentionEnvironmentsUnavailable([{ phase: "connected" }])).toBe(0);
    expect(
      attentionViewCountText({
        view: "needs-approval",
        matchedCount: 0,
        unavailableEnvironmentCount: 1,
      }),
    ).toBe("Count unavailable");
    expect(
      attentionViewCountText({
        view: "needs-approval",
        matchedCount: 0,
        unavailableEnvironmentCount: 0,
      }),
    ).toBe("0");
    expect(
      attentionViewCountText({
        view: "all",
        matchedCount: 3,
        unavailableEnvironmentCount: 1,
      }),
    ).toBeUndefined();
    expect(attentionInboxEmptyCopy({ view: "all", unavailableEnvironmentCount: 2 })).toBeNull();
    expect(attentionInboxEmptyCopy({ view: "failed", unavailableEnvironmentCount: 1 })).toEqual({
      title: "Environment unavailable",
      detail: "This view cannot show a clear count until every environment is connected.",
    });
    expect(
      attentionInboxEmptyCopy({ view: "waiting-for-me", unavailableEnvironmentCount: 0 }),
    ).toEqual({
      title: "Nothing in Waiting for me",
      detail: "Threads that need this kind of attention will show up here.",
    });
  });
});
