import {
  CommandId,
  MessageId,
  type ModelSelection,
  type OrchestrationV2Command,
  type OrchestrationV2ProviderFailureClass,
  type RunId,
  type ThreadId,
} from "@t3tools/contracts";
import { modelSelectionsEqual } from "@t3tools/shared/model";

export const MODEL_FALLBACK_NOTE_PREFIX = "model-fallback-note:";

export type QuotaWindow = "hourly" | "daily" | "weekly" | "monthly";

export interface ModelFallbackSignal {
  readonly class: OrchestrationV2ProviderFailureClass | null;
  readonly message: string;
  readonly code?: string | null;
  readonly resetAt?: string | null;
}

export type ModelFallbackDecision =
  | { readonly type: "leave-paused"; readonly reason: "disabled" | "not-quota" }
  | {
      readonly type: "pause";
      readonly reason: "exhausted" | "unsupported-continuation";
      readonly detail: string;
      readonly activeModel: ModelSelection;
    }
  | {
      readonly type: "switch";
      readonly to: ModelSelection;
      readonly detail: string;
      readonly window: QuotaWindow | null;
      readonly resetAt: string | null;
    };

const QUOTA_PHRASE = /\b(usage limits?|spend limits?|quota exceeded|rate limits? exceeded)\b/i;
const NON_QUOTA_CLASSES = new Set<OrchestrationV2ProviderFailureClass>([
  "provider_error",
  "transport_error",
  "permission_error",
  "validation_error",
  "unknown",
]);

const WINDOW_MARKERS: ReadonlyArray<readonly [QuotaWindow, RegExp]> = [
  ["hourly", /\b(hourly|5-hour|five-hour|five hour|session)\b/i],
  ["daily", /\bdaily\b|\bper day\b/i],
  ["weekly", /\bweekly\b|\b7-day\b|\bseven[- ]day\b/i],
  ["monthly", /\bmonthly\b|\bper month\b/i],
];

function isAccountScopedQuota(signal: ModelFallbackSignal): boolean {
  return /\b(spend limit|monthly spend|account)\b/i.test(signal.message);
}

function explicitQuotaExhaustion(
  signal: ModelFallbackSignal | null,
  options?: { readonly allowMessageHeuristic?: boolean },
): boolean {
  if (signal === null) return false;
  if (signal.class !== null && NON_QUOTA_CLASSES.has(signal.class)) return false;
  if (signal.class === "usage_limit") return true;
  return options?.allowMessageHeuristic === true && QUOTA_PHRASE.test(signal.message);
}

function namedWindows(message: string): QuotaWindow[] {
  return WINDOW_MARKERS.flatMap(([window, pattern]) => {
    if (window === "daily" && /\b7-day\b|\bseven[- ]day\b/i.test(message)) return [];
    return pattern.test(message) ? [window] : [];
  });
}

function claimedReset(
  signal: ModelFallbackSignal,
  windows: readonly QuotaWindow[],
): { readonly window: QuotaWindow | null; readonly resetAt: string | null } {
  const hit = signal.message.match(/\b(hourly|daily|weekly|monthly)\b/i);
  const window =
    windows.length === 1 ? windows[0]! : hit ? (hit[1]!.toLowerCase() as QuotaWindow) : null;
  const resetAt = signal.resetAt ?? null;
  const resetMs = resetAt === null ? Number.NaN : Date.parse(resetAt);
  if (windows.length !== 1 || !Number.isFinite(resetMs)) {
    return { window, resetAt: null };
  }
  return { window, resetAt };
}

function quotaFamily(signal: ModelFallbackSignal): string | null {
  const code = signal.code ?? "";
  return code.match(/(opus|sonnet|haiku|gpt)/i)?.[1]?.toLowerCase() ?? null;
}

function isInstanceScopedQuota(signal: ModelFallbackSignal): boolean {
  if (isAccountScopedQuota(signal)) return true;
  return signal.class === "usage_limit" && quotaFamily(signal) === null;
}

function sharesExhaustedQuota(
  candidate: ModelSelection,
  current: ModelSelection,
  signal: ModelFallbackSignal,
): boolean {
  if (isInstanceScopedQuota(signal)) {
    return candidate.instanceId === current.instanceId;
  }
  const family = quotaFamily(signal);
  if (family !== null) {
    return (
      candidate.instanceId === current.instanceId && candidate.model.toLowerCase().includes(family)
    );
  }
  return false;
}

function resetSentence(
  window: QuotaWindow | null,
  resetAt: string | null,
  conflicting: boolean,
): string {
  if (conflicting) {
    const named = window ?? "exhausted";
    return `The provider reported more than one quota window, so this does not say when the ${named} quota resets.`;
  }
  if (resetAt !== null) return `The provider reported a reset at ${resetAt}.`;
  return "The provider did not report when this quota resets.";
}

function describeLimit(model: string, window: QuotaWindow | null): string {
  return window === null
    ? `Usage limit reached on ${model}.`
    : `Usage limit reached on ${model} (${window}).`;
}

export interface FallbackRunEvidence {
  readonly modelSelection: ModelSelection;
  readonly ordinal: number;
  readonly completedAt: string | null;
  readonly failureClass: OrchestrationV2ProviderFailureClass | null;
  readonly message: string;
  readonly code?: string | null;
  readonly resetAt?: string | null;
}

function runIsLater(run: FallbackRunEvidence, other: FallbackRunEvidence): boolean {
  const end = (candidate: FallbackRunEvidence) =>
    candidate.completedAt === null ? Number.POSITIVE_INFINITY : Date.parse(candidate.completedAt);
  return end(run) === end(other) ? run.ordinal > other.ordinal : end(run) > end(other);
}

/** Models already burned in the current quota chain, newest first, stopping at a non-quota run. */
function quotaChain(runs: readonly FallbackRunEvidence[]): {
  readonly signal: ModelFallbackSignal | null;
  readonly current: ModelSelection | null;
  readonly tried: readonly ModelSelection[];
  readonly exhaustedInstanceIds: readonly string[];
} {
  const ordered = [...runs]
    .filter((run) => run.completedAt !== null)
    .sort((left, right) => (runIsLater(left, right) ? -1 : 1));
  const tried: ModelSelection[] = [];
  const exhaustedInstanceIds: string[] = [];
  let signal: ModelFallbackSignal | null = null;
  for (const run of ordered) {
    const nextSignal: ModelFallbackSignal = {
      class: run.failureClass,
      message: run.message,
      code: run.code ?? null,
      resetAt: run.resetAt ?? null,
    };
    if (!explicitQuotaExhaustion(nextSignal)) break;
    if (signal === null) signal = nextSignal;
    tried.push(run.modelSelection);
    if (isInstanceScopedQuota(nextSignal)) {
      exhaustedInstanceIds.push(run.modelSelection.instanceId);
    }
  }
  return {
    signal,
    current: tried[0] ?? null,
    tried,
    exhaustedInstanceIds,
  };
}

export function decideFromProjection(input: {
  readonly enabled: boolean;
  readonly models: readonly ModelSelection[];
  readonly unavailableInstanceIds: readonly string[];
  readonly continuation: "supported" | "unsupported";
  readonly current: ModelSelection;
  readonly runs: readonly FallbackRunEvidence[];
  readonly skipped?: readonly ModelSelection[];
}): ModelFallbackDecision {
  const chain = quotaChain(input.runs);
  return planModelFallback({
    enabled: input.enabled,
    models: input.models,
    current: chain.current ?? input.current,
    tried: chain.tried,
    skipped: input.skipped ?? [],
    exhaustedInstanceIds: chain.exhaustedInstanceIds,
    continuation: input.continuation,
    unavailableInstanceIds: input.unavailableInstanceIds,
    signal: chain.signal,
  });
}

export function planModelFallback(input: {
  readonly enabled: boolean;
  readonly models: readonly ModelSelection[];
  readonly current: ModelSelection;
  readonly tried: readonly ModelSelection[];
  readonly continuation: "supported" | "unsupported";
  readonly unavailableInstanceIds: readonly string[];
  /** Models already rejected for planning/switch this attempt (target-specific). */
  readonly skipped?: readonly ModelSelection[];
  /** Instances whose account or generic instance quota already stopped an earlier model. */
  readonly exhaustedInstanceIds?: readonly string[];
  readonly signal: ModelFallbackSignal | null;
}): ModelFallbackDecision {
  if (!input.enabled) return { type: "leave-paused", reason: "disabled" };
  if (!explicitQuotaExhaustion(input.signal) || input.signal === null) {
    return { type: "leave-paused", reason: "not-quota" };
  }
  const signal = input.signal;
  const windows = namedWindows(signal.message);
  const claim = claimedReset(signal, windows);
  const unavailable = new Set(input.unavailableInstanceIds);
  const exhaustedInstances = new Set(input.exhaustedInstanceIds ?? []);
  const skipped = input.skipped ?? [];
  const next = input.models.find(
    (candidate) =>
      !unavailable.has(candidate.instanceId) &&
      !exhaustedInstances.has(candidate.instanceId) &&
      !input.tried.some((tried) => modelSelectionsEqual(tried, candidate)) &&
      !skipped.some((entry) => modelSelectionsEqual(entry, candidate)) &&
      !sharesExhaustedQuota(candidate, input.current, signal),
  );
  if (next === undefined) {
    return {
      type: "pause",
      reason: "exhausted",
      activeModel: input.current,
      detail: `${describeLimit(input.current.model, claim.window)} Automatic fallback stopped because every configured model is unavailable or shares this quota. The active model is still ${input.current.model}.`,
    };
  }
  if (input.continuation === "unsupported") {
    return {
      type: "pause",
      reason: "unsupported-continuation",
      activeModel: input.current,
      detail: `${describeLimit(input.current.model, claim.window)} Automatic fallback did not switch because safe continuation is not supported here. The thread stays paused on ${input.current.model}.`,
    };
  }
  const conflicting = windows.length > 1;
  return {
    type: "switch",
    to: next,
    window: claim.window,
    resetAt: claim.resetAt,
    detail: `${describeLimit(input.current.model, claim.window)} ${resetSentence(claim.window, claim.resetAt, conflicting)} Continuing on ${next.model}. Completed tool actions are not replayed.`,
  };
}

export function presentedDelegatedStatus(input: {
  readonly runStatus: string;
  readonly resultText: string;
  readonly failureClass: OrchestrationV2ProviderFailureClass | null;
}): "completed" | "failed" | "cancelled" | "interrupted" | null {
  const terminal = (() => {
    switch (input.runStatus) {
      case "completed":
      case "failed":
      case "cancelled":
      case "interrupted":
        return input.runStatus;
      case "rolled_back":
        return "cancelled" as const;
      default:
        return null;
    }
  })();
  if (terminal !== "completed") return terminal;
  return explicitQuotaExhaustion(
    {
      class: input.failureClass,
      message: input.resultText,
      resetAt: null,
    },
    { allowMessageHeuristic: true },
  )
    ? "failed"
    : "completed";
}

function commandIdentity(
  threadId: ThreadId,
  runId: RunId,
  selection: ModelSelection | undefined,
  attempt: number,
): string {
  const target = selection === undefined ? "" : `:${selection.instanceId}:${selection.model}`;
  const retry = attempt <= 1 ? "" : `:attempt-${attempt}`;
  return `model-fallback:${threadId}:${runId}${target}${retry}`;
}

export function modelFallbackCommand(input: {
  readonly threadId: ThreadId;
  readonly runId: RunId;
  readonly decision: ModelFallbackDecision;
  /** Bump after a rejected receipt so a later sweep can retry the same target. */
  readonly attempt?: number;
}): OrchestrationV2Command | null {
  if (input.decision.type === "leave-paused") return null;
  const note = input.decision.type === "pause";
  const attempt = input.attempt ?? 1;
  const identity = note
    ? `${MODEL_FALLBACK_NOTE_PREFIX}${input.threadId}:${input.runId}${
        attempt <= 1 ? "" : `:attempt-${attempt}`
      }`
    : commandIdentity(input.threadId, input.runId, input.decision.to, attempt);
  return {
    type: "message.dispatch",
    commandId: CommandId.make(identity),
    messageId: MessageId.make(identity),
    threadId: input.threadId,
    modelFallbackOfRunId: input.runId,
    ...(note ? {} : { modelSelection: input.decision.to }),
    text: input.decision.detail,
    attachments: [],
    dispatchMode: { type: "start_immediately" },
    createdBy: note ? "system" : "user",
    creationSource: "server",
  };
}
