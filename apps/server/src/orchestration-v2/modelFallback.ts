import {
  CommandId,
  MessageId,
  type ModelSelection,
  type OrchestrationV2Command,
  type OrchestrationV2ProviderFailureClass,
  type OrchestrationV2Run,
  type RunId,
  type ThreadId,
} from "@t3tools/contracts";
import { modelSelectionsEqual } from "@t3tools/shared/model";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

export const MODEL_FALLBACK_NOTE_PREFIX = "model-fallback-note:";
const MODEL_FALLBACK_RETRY_PREFIX = "model-fallback-retry:";
const MODEL_FALLBACK_NOTE_RETRY_PREFIX = "model-fallback-note-retry:";

export function isModelFallbackNoteCommand(commandId: CommandId): boolean {
  return (
    commandId.startsWith(MODEL_FALLBACK_NOTE_PREFIX) ||
    commandId.startsWith(MODEL_FALLBACK_NOTE_RETRY_PREFIX)
  );
}

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

const WINDOW_MARKERS: ReadonlyArray<readonly [QuotaWindow, RegExp]> = [
  ["hourly", /\b(hourly|5-hour|five-hour|five hour|session)\b/i],
  ["daily", /\bdaily\b|\bper day\b/i],
  ["weekly", /\bweekly\b|\b7-day\b|\bseven[- ]day\b/i],
  ["monthly", /\bmonthly\b|\bper month\b/i],
];

function isAccountScopedQuota(signal: ModelFallbackSignal): boolean {
  return /\b(spend limit|monthly spend|account)\b/i.test(signal.message);
}

function explicitQuotaExhaustion(signal: ModelFallbackSignal | null): boolean {
  return signal?.class === "usage_limit";
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
  quotaOwnerKeys: ReadonlyMap<string, string> | undefined,
): boolean {
  const owner = quotaOwnerKeys?.get(current.instanceId);
  const sharesOwner =
    candidate.instanceId === current.instanceId ||
    (owner !== undefined && owner === quotaOwnerKeys?.get(candidate.instanceId));
  if (isInstanceScopedQuota(signal)) {
    return sharesOwner;
  }
  const family = quotaFamily(signal);
  if (family !== null) {
    return sharesOwner && candidate.model.toLowerCase().includes(family);
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
  readonly status: OrchestrationV2Run["status"];
  readonly startedAt: string | null;
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

interface ExhaustedQuota {
  readonly selection: ModelSelection;
  readonly signal: ModelFallbackSignal;
}

function quotaChain(runs: readonly FallbackRunEvidence[]): {
  readonly signal: ModelFallbackSignal | null;
  readonly current: ModelSelection | null;
  readonly tried: readonly ModelSelection[];
  readonly exhausted: readonly ExhaustedQuota[];
} {
  const ordered = [...runs]
    .filter(
      (run) => run.completedAt !== null && !(run.status === "cancelled" && run.startedAt === null),
    )
    .sort((left, right) => (runIsLater(left, right) ? -1 : 1));
  const tried: ModelSelection[] = [];
  const exhausted: ExhaustedQuota[] = [];
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
    exhausted.push({ selection: run.modelSelection, signal: nextSignal });
  }
  return {
    signal,
    current: tried[0] ?? null,
    tried,
    exhausted,
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
  readonly quotaOwnerKeys?: ReadonlyMap<string, string>;
}): ModelFallbackDecision {
  const chain = quotaChain(input.runs);
  return planModelFallback({
    enabled: input.enabled,
    models: input.models,
    current: chain.current ?? input.current,
    tried: chain.tried,
    skipped: input.skipped ?? [],
    exhausted: chain.exhausted,
    continuation: input.continuation,
    unavailableInstanceIds: input.unavailableInstanceIds,
    signal: chain.signal,
    ...(input.quotaOwnerKeys === undefined ? {} : { quotaOwnerKeys: input.quotaOwnerKeys }),
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
  /** Earlier quotas in this chain; a candidate sharing any of them is skipped. */
  readonly exhausted?: readonly ExhaustedQuota[];
  readonly signal: ModelFallbackSignal | null;
  readonly quotaOwnerKeys?: ReadonlyMap<string, string>;
}): ModelFallbackDecision {
  if (!input.enabled) return { type: "leave-paused", reason: "disabled" };
  if (!explicitQuotaExhaustion(input.signal) || input.signal === null) {
    return { type: "leave-paused", reason: "not-quota" };
  }
  const signal = input.signal;
  const windows = namedWindows(signal.message);
  const claim = claimedReset(signal, windows);
  const unavailable = new Set(input.unavailableInstanceIds);
  const exhausted = [{ selection: input.current, signal }, ...(input.exhausted ?? [])];
  const skipped = input.skipped ?? [];
  const next = input.models.find(
    (candidate) =>
      !unavailable.has(candidate.instanceId) &&
      !input.tried.some((tried) => modelSelectionsEqual(tried, candidate)) &&
      !skipped.some((entry) => modelSelectionsEqual(entry, candidate)) &&
      !exhausted.some((quota) =>
        sharesExhaustedQuota(candidate, quota.selection, quota.signal, input.quotaOwnerKeys),
      ),
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
  return input.failureClass === "usage_limit" ? "failed" : "completed";
}

function commandIdentity(
  threadId: ThreadId,
  runId: RunId,
  selection: ModelSelection | undefined,
): string {
  const target = selection === undefined ? "" : `:${selection.instanceId}:${selection.model}`;
  return `model-fallback:${threadId}:${runId}${target}`;
}

export function modelFallbackCommand(input: {
  readonly threadId: ThreadId;
  readonly runId: RunId;
  readonly decision: ModelFallbackDecision;
  /** Bump after a rejected receipt so a later sweep can retry the same target. */
  readonly attempt?: number;
}): Extract<OrchestrationV2Command, { readonly type: "message.dispatch" }> | null {
  if (input.decision.type === "leave-paused") return null;
  const note = input.decision.type === "pause";
  const attempt = input.attempt ?? 1;
  const group = note
    ? `${MODEL_FALLBACK_NOTE_PREFIX}${input.threadId}:${input.runId}`
    : commandIdentity(input.threadId, input.runId, input.decision.to);
  const identity =
    attempt <= 1
      ? group
      : `${note ? MODEL_FALLBACK_NOTE_RETRY_PREFIX : MODEL_FALLBACK_RETRY_PREFIX}${encodeURIComponent(group)}:attempt-${attempt}`;
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

export const nextModelFallbackCommand = Effect.fn("modelFallback.nextCommand")(function* <E>(
  input: {
    readonly threadId: ThreadId;
    readonly runId: RunId;
    readonly decision: ModelFallbackDecision;
  },
  receipt: (input: {
    readonly threadId: ThreadId;
    readonly retryGroup: CommandId;
  }) => Effect.Effect<
    Option.Option<{
      readonly commandId: CommandId;
      readonly status: "accepted" | "rejected";
      readonly retryAttempt?: number | null;
    }>,
    E
  >,
) {
  const first = modelFallbackCommand(input);
  if (first === null) return null;
  const prior = yield* receipt({ threadId: input.threadId, retryGroup: first.commandId });
  if (Option.isSome(prior) && prior.value.status === "accepted") {
    return {
      ...first,
      commandId: prior.value.commandId,
      messageId: MessageId.make(prior.value.commandId),
    };
  }
  const attempt = Option.isNone(prior)
    ? 1
    : (prior.value.retryAttempt ?? 1) + (prior.value.status === "rejected" ? 1 : 0);
  return modelFallbackCommand({ ...input, attempt });
});

export function modelFallbackRetry(command: OrchestrationV2Command) {
  if (command.type !== "message.dispatch" || command.modelFallbackOfRunId === undefined)
    return undefined;
  const note = isModelFallbackNoteCommand(command.commandId);
  const group = note
    ? `${MODEL_FALLBACK_NOTE_PREFIX}${command.threadId}:${command.modelFallbackOfRunId}`
    : commandIdentity(command.threadId, command.modelFallbackOfRunId, command.modelSelection);
  if (command.commandId === group) return { retryGroup: CommandId.make(group), retryAttempt: 1 };
  const prefix = `${note ? MODEL_FALLBACK_NOTE_RETRY_PREFIX : MODEL_FALLBACK_RETRY_PREFIX}${encodeURIComponent(group)}:attempt-`;
  const legacyPrefix = `${group}:attempt-`;
  const suffix = command.commandId.startsWith(prefix)
    ? command.commandId.slice(prefix.length)
    : command.commandId.startsWith(legacyPrefix)
      ? command.commandId.slice(legacyPrefix.length)
      : null;
  if (suffix === null || !/^[1-9]\d*$/.test(suffix) || Number(suffix) < 2) return undefined;
  return {
    retryGroup: CommandId.make(group),
    retryAttempt: Number(suffix),
  };
}
