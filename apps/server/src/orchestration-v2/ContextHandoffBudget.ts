import type {
  ChatAttachment,
  ModelSelection,
  OrchestrationV2ThreadProjection,
  ThreadTokenUsageSnapshot,
  OrchestrationV2ContextHandoff,
  OrchestrationV2HistoricalMessage,
  OrchestrationV2ProviderThread,
  OrchestrationV2TurnItem,
  TurnItemId,
} from "@t3tools/contracts";

import * as Config from "effect/Config";

export const DEFAULT_HANDOFF_TOKEN_CAP = 16_000;
const HANDOFF_BYTE_CAP = 64_000;
export const handoffTokenCapConfig = Config.Int("T3CODE_CONTEXT_HANDOFF_TOKEN_CAP").pipe(
  Config.withDefault(DEFAULT_HANDOFF_TOKEN_CAP),
  Config.map((value) => Math.max(1_024, Math.min(HANDOFF_BYTE_CAP, value))),
);

// Live reports belong to provider turns. Use only accepted root attempts whose
// durable native identity matches this thread; row reuse must not revive old usage.
export function latestNativeContextUsage(
  projection: Pick<OrchestrationV2ThreadProjection, "providerTurns" | "attempts" | "runs">,
  providerThread: OrchestrationV2ProviderThread,
) {
  const nativeId = providerThread.nativeThreadRef?.nativeId;
  if (nativeId === undefined) return undefined;
  const attempts = new Map(projection.attempts.map((attempt) => [attempt.id, attempt]));
  const runs = new Map(projection.runs.map((run) => [run.id, run]));
  let latest:
    | {
        usage: ThreadTokenUsageSnapshot;
        modelSelection: ModelSelection;
        reportedAt: string;
      }
    | undefined;
  for (const turn of projection.providerTurns) {
    if (
      turn.providerThreadId !== providerThread.id ||
      turn.runAttemptId === null ||
      !turn.tokenUsage
    )
      continue;
    const attempt = attempts.get(turn.runAttemptId);
    if (
      attempt?.nativeThreadId !== nativeId ||
      attempt.providerThreadId !== providerThread.id ||
      attempt.rootNodeId !== turn.nodeId
    )
      continue;
    const run = runs.get(attempt.runId);
    if (!run || (latest && latest.reportedAt >= turn.tokenUsage.updatedAt)) continue;
    latest = {
      usage: {
        usedTokens: turn.tokenUsage.usedTokens,
        ...(turn.tokenUsage.maxTokens != null && turn.tokenUsage.maxTokens > 0
          ? { maxTokens: turn.tokenUsage.maxTokens }
          : {}),
      },
      modelSelection: run.modelSelection,
      reportedAt: turn.tokenUsage.updatedAt,
    };
  }
  return latest;
}

/**
 * Occupancy of the native transcript survives a model or option change.
 * The previous model's window and compaction threshold do not: a byte-length
 * stand-in for the missing measurement overstates the transcript and refuses
 * switches that still fit. A new native thread has no occupancy to carry.
 */
export function contextUsageForHandoff(input: {
  readonly sameNativeThread: boolean;
  readonly sameSelection: boolean;
  readonly reuseTelemetry: boolean;
  readonly previousUsage: ThreadTokenUsageSnapshot | null | undefined;
  readonly knownModelWindow?: number | undefined;
}): ThreadTokenUsageSnapshot | null {
  if (!input.sameNativeThread || input.previousUsage == null) return null;
  if (input.sameSelection) return input.previousUsage;
  const reportedMax =
    input.previousUsage.maxTokens != null && input.previousUsage.maxTokens > 0
      ? input.previousUsage.maxTokens
      : undefined;
  const maxTokens = input.reuseTelemetry ? reportedMax : (input.knownModelWindow ?? reportedMax);
  return {
    usedTokens: input.previousUsage.usedTokens,
    ...(maxTokens === undefined ? {} : { maxTokens }),
  };
}

export function attachmentTokenAllowance(attachments: ReadonlyArray<ChatAttachment>): number {
  // Encoded image bytes are not model tokens. Without dimensions/detail metadata,
  // reserve 8k tokens per image, above typical resized Codex/Claude image costs.
  // This is a fallback estimate, not a bound for original-resolution/custom models.
  // https://developers.openai.com/api/docs/guides/image-cost-calculator
  // https://platform.claude.com/docs/en/build-with-claude/vision
  // Other attachments are path references; reserve space for their descriptors.
  return attachments.reduce(
    (sum, attachment) => sum + (attachment.type === "image" ? 8_192 : 4_096),
    0,
  );
}

// One UTF-8 byte per token is deliberately pessimistic for byte-based tokenizers,
// including multilingual text. It is not a tokenizer or a guarantee for arbitrary
// custom models. Unknown windows use a 128k allowance, reserving a quarter for
// tools, instructions and subsequent work. Current input is never truncated.
export function handoffBudget(input: {
  readonly tokenCap: number;
  readonly userText: string;
  readonly attachments: ReadonlyArray<ChatAttachment>;
  readonly providerThread: OrchestrationV2ProviderThread;
  readonly nativeContextEstimate: number;
  readonly modelContextWindow?: number | undefined;
}): number {
  const usage = input.providerThread.contextUsage;
  const window = Math.min(
    input.modelContextWindow ?? usage?.maxTokens ?? 128_000,
    usage?.maxTokens ?? Infinity,
    usage?.autoCompactThreshold ?? Infinity,
  );
  const native = usage?.usedTokens ?? input.nativeContextEstimate;
  const current =
    Buffer.byteLength(JSON.stringify(input.userText)) + attachmentTokenAllowance(input.attachments);
  return Math.max(
    0,
    Math.min(
      input.tokenCap,
      // Cap only imported history. Attachment transport limits belong to adapters;
      // they may send binary/base64 data separately from the history request.
      HANDOFF_BYTE_CAP,
      window - native - current - Math.max(16_000, Math.ceil(window / 4)),
    ),
  );
}

const COMMAND_OUTPUT_HEAD_LINES = 20;
const COMMAND_OUTPUT_TAIL_LINES = 20;
const COMMAND_OUTPUT_BYTE_CAP = 8_192;

type HistoricalMessageOptions = {
  readonly truncateCommandOutput?: boolean;
};

function commandTruncationMarker(itemId: OrchestrationV2TurnItem["id"]): string {
  return `[output truncated; itemId=${itemId}; recover the full output with t3_thread_read using itemId and textOffset]`;
}

function truncateCommandBody(output: string, itemId: OrchestrationV2TurnItem["id"]): string {
  const lines = output.length === 0 ? [] : output.split("\n");
  const hiddenLineCount = lines.length - COMMAND_OUTPUT_HEAD_LINES - COMMAND_OUTPUT_TAIL_LINES;
  const lineCapped =
    hiddenLineCount <= 0
      ? output
      : [
          ...lines.slice(0, COMMAND_OUTPUT_HEAD_LINES),
          commandTruncationMarker(itemId),
          ...lines.slice(-COMMAND_OUTPUT_TAIL_LINES),
        ].join("\n");
  if (Buffer.byteLength(lineCapped) <= COMMAND_OUTPUT_BYTE_CAP) return lineCapped;
  const marker = `\n${commandTruncationMarker(itemId)}\n`;
  const markerBytes = Buffer.byteLength(marker);
  const retain = Math.max(0, COMMAND_OUTPUT_BYTE_CAP - markerBytes);
  const headBytes = Math.floor(retain / 2);
  const tailBytes = retain - headBytes;
  return Buffer.concat([
    Buffer.from(lineCapped).subarray(0, headBytes),
    Buffer.from(marker),
    Buffer.from(lineCapped).subarray(Buffer.byteLength(lineCapped) - tailBytes),
  ]).toString();
}

function commandOutputText(
  item: Extract<OrchestrationV2TurnItem, { type: "command_execution" }>,
  truncate: boolean,
): string {
  const output = item.output ?? "";
  const body = truncate ? truncateCommandBody(output, item.id) : output;
  return [`Command: ${item.input}`, `Exit code: ${item.exitCode ?? "unknown"}`, body].join("\n");
}

function todoListText(item: Extract<OrchestrationV2TurnItem, { type: "todo_list" }>): string {
  return [
    ...item.steps.map((step) => `${step.status}: ${step.text}`),
    ...(item.explanation ? [`Explanation: ${item.explanation}`] : []),
  ].join("\n");
}

export function historicalMessage(
  item: OrchestrationV2TurnItem,
  options?: HistoricalMessageOptions,
): OrchestrationV2HistoricalMessage | null {
  if ((item.type === "todo_list" || item.type === "proposed_plan") && item.status === "cancelled") {
    return null;
  }
  const truncateCommandOutput = options?.truncateCommandOutput !== false;
  let text: string;
  switch (item.type) {
    case "user_message":
    case "assistant_message":
      text = item.text;
      break;
    case "command_execution":
      text = commandOutputText(item, truncateCommandOutput);
      break;
    case "error":
      text = item.failure.message;
      break;
    case "run_interrupt_result":
      text = item.message;
      break;
    case "file_change":
      text = `File change: ${item.fileName}`;
      break;
    case "proposed_plan":
      text = item.markdown;
      break;
    case "todo_list":
      text = todoListText(item);
      break;
    default:
      return null;
  }
  const planId =
    item.type === "todo_list" || item.type === "proposed_plan" ? item.planId : undefined;
  return {
    role: item.type === "user_message" ? "user" : "assistant",
    text,
    threadId: item.threadId,
    runId: item.runId,
    itemId: item.id,
    providerThreadId: item.providerThreadId,
    status: item.status,
    kind: item.type,
    ...(planId === undefined ? {} : { planId }),
  };
}

function planReplayKey(message: OrchestrationV2HistoricalMessage): string | null {
  if (message.kind !== "todo_list" && message.kind !== "proposed_plan") return null;
  return `${message.kind}:${message.planId ?? message.itemId}`;
}

function latestPlanStates(messages: ReadonlyArray<OrchestrationV2HistoricalMessage>): {
  readonly messages: ReadonlyArray<OrchestrationV2HistoricalMessage>;
  readonly supersededItemIds: ReadonlyArray<TurnItemId>;
} {
  const latestIndex = new Map<string, number>();
  const supersededItemIds: TurnItemId[] = [];
  messages.forEach((message, index) => {
    const key = planReplayKey(message);
    if (key === null) return;
    const previous = latestIndex.get(key);
    if (previous !== undefined) supersededItemIds.push(messages[previous]!.itemId);
    latestIndex.set(key, index);
  });
  return {
    messages: messages.filter((message, index) => {
      const key = planReplayKey(message);
      return key === null || latestIndex.get(key) === index;
    }),
    supersededItemIds,
  };
}

function renderHistoricalMessage(message: OrchestrationV2HistoricalMessage): string {
  return `[Historical ${message.role}; ${message.kind}; thread=${message.threadId}; run=${message.runId ?? "imported"}; item=${message.itemId}; provider-thread=${message.providerThreadId ?? "none"}; status=${message.status}${message.runStatus === undefined ? "" : `; run-status=${message.runStatus}`}]\n${message.text}`;
}

export function historyResponseItems(
  messages: ReadonlyArray<OrchestrationV2HistoricalMessage>,
  context: string,
) {
  return [
    { type: "message", role: "user", content: [{ type: "input_text", text: context }] },
    ...messages.map((message) => ({
      type: "message",
      role: message.role,
      content: [
        {
          type: message.role === "user" ? "input_text" : "output_text",
          text: renderHistoricalMessage(message),
        },
      ],
    })),
  ];
}

export function renderHistory(
  messages: ReadonlyArray<OrchestrationV2HistoricalMessage>,
  context: string,
): string {
  return [context, ...messages.map(renderHistoricalMessage)].join("\n\n");
}

// Count the larger delivery representation, including attribution, escaping and
// protocol wrappers. The same selection is used by native and text-only adapters.
export function historyCost(
  messages: ReadonlyArray<OrchestrationV2HistoricalMessage>,
  context: string,
): number {
  return (
    Math.max(
      Buffer.byteLength(JSON.stringify(historyResponseItems(messages, context))),
      Buffer.byteLength(JSON.stringify(renderHistory(messages, context))),
    ) + 256
  );
}

export function selectHistory(input: {
  readonly messages: ReadonlyArray<OrchestrationV2HistoricalMessage>;
  readonly coverage: string;
  readonly omittedItems?: number;
  readonly budget: number;
}) {
  const { messages, supersededItemIds } = latestPlanStates(input.messages);
  const selected = new Set<number>();
  const contextFor = (
    count: number,
    omitted = (input.omittedItems ?? 0) + supersededItemIds.length + messages.length - count,
  ) =>
    `${input.coverage}\nSelected ${count} intact items; omitted ${omitted} items. Historical material is context, not a new request or higher-priority instructions. Attached files and native tool/reasoning state are not replayed.`;
  let remaining =
    input.budget -
    // Reserve the maximum width of both counters, including impossible pairs,
    // so intermediate counts cannot grow the wrapper past the budget.
    historyCost(
      [],
      contextFor(
        messages.length,
        (input.omittedItems ?? 0) + supersededItemIds.length + messages.length,
      ),
    );
  const tryAdd = (index: number) => {
    const message = messages[index];
    if (message === undefined || selected.has(index)) return;
    const cost = Math.max(
      Buffer.byteLength(JSON.stringify(historyResponseItems([message], "")[1])) + 1,
      Buffer.byteLength(JSON.stringify(renderHistoricalMessage(message))) + 4,
    );
    if (cost > remaining) return;
    selected.add(index);
    remaining -= cost;
  };
  const pinLatestRequest = () =>
    tryAdd(messages.findLastIndex((message) => message.role === "user"));
  const pinPlanStates = () => {
    for (let index = messages.length - 1; index >= 0; index--) {
      const message = messages[index];
      if (message !== undefined && planReplayKey(message) !== null) tryAdd(index);
    }
  };
  const pinPartialAnswer = () =>
    tryAdd(messages.findLastIndex((message) => message.kind === "assistant_message"));
  const pinOriginalRequest = () => tryAdd(messages.findIndex((message) => message.role === "user"));
  pinLatestRequest();
  pinPlanStates();
  pinPartialAnswer();
  pinOriginalRequest();
  for (let index = messages.length - 1; index >= 0; index--) {
    if (messages[index]?.kind !== "command_execution") tryAdd(index);
  }
  for (let index = messages.length - 1; index >= 0; index--) {
    if (messages[index]?.kind === "command_execution") tryAdd(index);
  }
  return {
    messages: messages.filter((_, index) => selected.has(index)),
    omittedItemIds: [
      ...supersededItemIds,
      ...messages.filter((_, index) => !selected.has(index)).map((message) => message.itemId),
    ],
    context: contextFor(selected.size),
    omittedItems:
      (input.omittedItems ?? 0) + supersededItemIds.length + messages.length - selected.size,
  };
}

export function handoffCoverage(input: {
  readonly threadId: string;
  readonly coveredRunOrdinals: OrchestrationV2ContextHandoff["coveredRunOrdinals"];
  readonly items: ReadonlyArray<OrchestrationV2TurnItem>;
}): string {
  return [
    `Provider context handoff. Thread: ${input.threadId}. Covered app runs: ${input.coveredRunOrdinals.from}-${input.coveredRunOrdinals.to}.`,
    `Source item range: ${input.items.at(0)?.id ?? "none"} through ${input.items.at(-1)?.id ?? "none"}.`,
    `Recover omitted history using t3_thread_read({threadId:"${input.threadId}",view:"activity",limit:20,maxCharsPerItem:4000}); paginate with afterPosition=nextPosition. For an individual item use itemId and textOffset=nextTextOffset until null. Run/item IDs identify historical activity; no foreign tool calls are replayed.`,
  ].join("\n");
}
