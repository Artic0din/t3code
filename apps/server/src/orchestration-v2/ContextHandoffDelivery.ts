import type {
  OrchestrationV2ContextHandoff,
  OrchestrationV2ProviderThread,
  OrchestrationV2HistoricalMessage,
} from "@t3tools/contracts";
import type { ProviderAdapterV2HistoricalContext } from "./ProviderAdapter.ts";
import * as Effect from "effect/Effect";
import * as DateTime from "effect/DateTime";
import * as Schema from "effect/Schema";
import { historyCost, renderHistory, selectHistory } from "./ContextHandoffBudget.ts";
import type { SupersededHistoryPlans } from "./ContextHandoffBudget.ts";
import {
  contextHandoffDeliveryState,
  deliverySnapshot,
  historyItemKey,
  isPlanSnapshot,
  isOlderPlanSnapshot,
  planSnapshotCovered,
} from "./ContextHandoffSnapshots.ts";

/** Persist before/after injection: an ambiguous pending delivery requires a fresh native thread. */
export const deliverContextHandoffs = Effect.fn("orchestrationV2.deliverContextHandoffs")(
  function* <InjectError = never, PersistError = never, BudgetError = never>(input: {
    readonly handoffs: ReadonlyArray<OrchestrationV2ContextHandoff>;
    readonly providerThread: OrchestrationV2ProviderThread;
    readonly budget: number | Effect.Effect<number, BudgetError>;
    readonly deferInline?: boolean;
    readonly alreadyDeliveredItemIds: ReadonlySet<string>;
    readonly alreadyDeliveredHandoffs?: ReadonlyArray<OrchestrationV2ContextHandoff>;
    readonly supersededPlans?: SupersededHistoryPlans;
    readonly inject?: (
      history: ProviderAdapterV2HistoricalContext,
    ) => Effect.Effect<boolean, InjectError>;
    readonly persist: (handoff: OrchestrationV2ContextHandoff) => Effect.Effect<void, PersistError>;
  }) {
    const nativeThreadId = input.providerThread.nativeThreadRef?.nativeId ?? undefined;
    const receipts = [...(input.alreadyDeliveredHandoffs ?? []), ...input.handoffs].filter(
      (handoff) =>
        nativeThreadId !== undefined && handoff.delivery?.nativeThreadId === nativeThreadId,
    );
    const state = contextHandoffDeliveryState(receipts);
    const pending = input.handoffs.filter(
      (handoff) =>
        nativeThreadId === undefined ||
        handoff.delivery?.nativeThreadId !== nativeThreadId ||
        handoff.delivery.status === "pending" ||
        (handoff.delivery.snapshots !== undefined &&
          (() => {
            const previous = contextHandoffDeliveryState([handoff]);
            const currentPlans = new Map(
              [
                ...(handoff.history?.messages ?? [])
                  .filter(isPlanSnapshot)
                  .map((message) =>
                    deliverySnapshot(message, 0, true, DateTime.toEpochMillis(handoff.createdAt)),
                  ),
                ...(handoff.history?.omittedPlanSnapshots ?? []).map((snapshot) => ({
                  ...snapshot,
                  capturedAtMs: DateTime.toEpochMillis(handoff.createdAt),
                })),
              ].map((snapshot) => [historyItemKey(snapshot), snapshot]),
            );
            return [...currentPlans].some(
              ([key, snapshot]) =>
                !planSnapshotCovered(snapshot, previous.coveredPlans.get(key)) ||
                isOlderPlanSnapshot(previous.coveredPlans.get(key) ?? {}, snapshot),
            );
          })()),
    );
    if (pending.length === 0 || (input.deferInline && input.inject === undefined))
      return { context: "", delivered: Effect.void };
    const budget = typeof input.budget === "number" ? input.budget : yield* input.budget;
    let coverage = pending
      .map(
        (handoff) =>
          `Context handoff (${handoff.strategy === "fork_delta_summary" ? "merge_back / fork_delta_summary" : handoff.strategy}):\n${
            handoff.history?.coverage ??
            `From thread ${handoff.threadId}, runs ${handoff.coveredRunOrdinals.from}-${handoff.coveredRunOrdinals.to}. Recover history with t3_thread_read, view=activity; paginate with afterPosition, and use itemId/textOffset for long items.`
          }`,
      )
      .join("\n");
    // Repeated failures can accumulate many recovery markers. Keep a single
    // thread-level entry point when detailed coverage would crowd out history;
    // its activity includes the original handoff/fork source references.
    if (historyCost([], coverage) > Math.min(4_000, budget / 2)) {
      const strategies = Array.from(new Set(pending.map((handoff) => handoff.strategy)));
      coverage = `Context handoff (${strategies.join(", ")}). ${pending.length} handoff records; detailed coverage references omitted. Recover history with t3_thread_read({threadId:"${input.providerThread.appThreadId ?? pending[0]!.threadId}",view:"activity",limit:20,maxCharsPerItem:4000}); paginate with afterPosition=nextPosition. Follow fork/handoff source references in activity. For long items use itemId and textOffset=nextTextOffset until null.`;
    }
    type Candidate = {
      message: OrchestrationV2HistoricalMessage;
      handoffId: OrchestrationV2ContextHandoff["id"];
      freshness: number;
      capturedAt: number;
      sourceOrdinal: number | undefined;
    };
    const candidates = new Map<string, Candidate>();
    const supersededSources = new Map<OrchestrationV2ContextHandoff["id"], Set<string>>();
    const pendingBySource = new Map<
      OrchestrationV2HistoricalMessage["threadId"],
      OrchestrationV2ContextHandoff[]
    >();
    const structuralHandoffs = [
      ...pending.filter((handoff) => handoff.strategy !== "fork_delta_summary"),
      ...pending.filter((handoff) => handoff.strategy === "fork_delta_summary"),
    ];
    for (const handoff of structuralHandoffs) {
      const key = handoff.history?.messages[0]?.threadId ?? handoff.threadId;
      const source = pendingBySource.get(key) ?? [];
      source.push(handoff);
      pendingBySource.set(key, source);
    }
    const orderedHandoffs = [...pendingBySource.values()].flatMap((source) =>
      source.toSorted(
        (left, right) =>
          left.coveredRunOrdinals.from - right.coveredRunOrdinals.from ||
          right.coveredRunOrdinals.to - left.coveredRunOrdinals.to ||
          (right.history?.messages.length ?? 0) - (left.history?.messages.length ?? 0) ||
          DateTime.toEpochMillis(left.createdAt) - DateTime.toEpochMillis(right.createdAt),
      ),
    );
    for (const handoff of orderedHandoffs) {
      for (const message of handoff.history?.messages ?? []) {
        const key = historyItemKey(message);
        const freshness = message.sourceUpdatedAtMs ?? DateTime.toEpochMillis(handoff.createdAt);
        const capturedAt = DateTime.toEpochMillis(handoff.createdAt);
        if (
          !isPlanSnapshot(message) &&
          (state.deliveredKeys.has(key) ||
            (!state.knownItemIds.has(message.itemId) &&
              input.alreadyDeliveredItemIds.has(message.itemId)))
        )
          continue;
        const previous = candidates.get(key);
        if (previous !== undefined) {
          previous.sourceOrdinal ??= message.sourceOrdinal;
          if (
            freshness < previous.freshness ||
            (freshness === previous.freshness && capturedAt < previous.capturedAt)
          )
            continue;
          if (
            deliverySnapshot(previous.message, 0).contentHash ===
            deliverySnapshot(message, 0).contentHash
          ) {
            if (freshness === previous.freshness && capturedAt === previous.capturedAt) continue;
          }
          const finalizesPrevious =
            (previous.message.status === "running" || previous.message.status === "pending") &&
            message.status !== "running" &&
            message.status !== "pending";
          if (!isPlanSnapshot(message) && freshness === previous.freshness && !finalizesPrevious)
            continue;
          const omitted = supersededSources.get(previous.handoffId) ?? new Set<string>();
          omitted.add(key);
          supersededSources.set(previous.handoffId, omitted);
        }
        candidates.set(key, {
          message,
          handoffId: handoff.id,
          freshness,
          capturedAt,
          sourceOrdinal: message.sourceOrdinal ?? previous?.sourceOrdinal,
        });
      }
    }
    const bySource = new Map<OrchestrationV2HistoricalMessage["threadId"], Candidate[]>();
    for (const candidate of candidates.values()) {
      const source = bySource.get(candidate.message.threadId) ?? [];
      source.push(candidate);
      bySource.set(candidate.message.threadId, source);
    }
    const messages = [...bySource.values()]
      .flatMap((source) =>
        (new Set(source.map((candidate) => candidate.message.providerThreadId)).size === 1 &&
        source.every(
          (candidate): candidate is Candidate & { sourceOrdinal: number } =>
            candidate.sourceOrdinal !== undefined,
        )
          ? source.toSorted((left, right) => left.sourceOrdinal - right.sourceOrdinal)
          : source
        ).map((candidate) => candidate.message),
      )
      .filter(
        (message) =>
          !isPlanSnapshot(message) ||
          (!planSnapshotCovered(
            deliverySnapshot(message, 0, true, candidates.get(historyItemKey(message))?.capturedAt),
            state.latestPlans.get(historyItemKey(message)),
          ) &&
            !isOlderPlanSnapshot(
              deliverySnapshot(
                message,
                0,
                true,
                candidates.get(historyItemKey(message))?.capturedAt,
              ),
              state.coveredPlans.get(historyItemKey(message)),
            )),
      );
    // Old preview handoffs remain readable. Their preformatted context is included
    // as a whole when it fits, otherwise the coverage marker points to retrieval.
    const oldContext = pending
      .filter((handoff) => handoff.history === undefined)
      .map((handoff) => handoff.summaryText)
      .join("\n\n");
    const fullCoverage =
      oldContext && historyCost([], `${coverage}\n${oldContext}`) + 512 <= budget
        ? `${coverage}\n${oldContext}`
        : coverage;
    const selected = selectHistory({
      messages,
      ...(input.supersededPlans === undefined ? {} : { supersededPlans: input.supersededPlans }),
      coverage: fullCoverage,
      omittedItems: pending.reduce((sum, handoff) => sum + (handoff.history?.omittedItems ?? 0), 0),
      budget,
    });
    if (historyCost(selected.messages, selected.context) > budget) {
      if (input.deferInline) return { context: "", delivered: Effect.void };
      return yield* new ContextHandoffBudgetError();
    }
    const selectedKeys = new Set(selected.messages.map(historyItemKey));
    const omittedKeys = new Set(
      messages.filter((message) => !selectedKeys.has(historyItemKey(message))).map(historyItemKey),
    );
    const selectedHashes = new Map(
      selected.messages.map((message) => [
        historyItemKey(message),
        deliverySnapshot(message, 0).contentHash,
      ]),
    );
    const order = state.maxOrder + 1;
    const persist = (status: "pending" | "injected" | "inline") =>
      Effect.forEach(
        pending,
        (handoff) =>
          input.persist({
            ...handoff,
            ...(nativeThreadId === undefined
              ? {}
              : {
                  delivery: {
                    nativeThreadId,
                    status,
                    order,
                    contexts: [
                      ...(handoff.delivery?.nativeThreadId === nativeThreadId
                        ? (handoff.delivery.contexts ?? [
                            {
                              order: 0,
                              bytes: historyCost(
                                [],
                                handoff.history?.coverage ?? handoff.summaryText,
                              ),
                            },
                          ])
                        : []),
                      { order, bytes: Buffer.byteLength(selected.context) },
                    ],
                    snapshots: [
                      ...(handoff.delivery?.nativeThreadId === nativeThreadId
                        ? (handoff.delivery.snapshots?.filter((snapshot) => snapshot.delivered) ??
                          (handoff.history?.messages ?? [])
                            .filter((message) => handoff.delivery?.itemIds.includes(message.itemId))
                            .map((message) => deliverySnapshot(message, 0)))
                        : []),
                      ...(handoff.history?.messages ?? []).map((message) =>
                        deliverySnapshot(
                          message,
                          order,
                          candidates.get(historyItemKey(message))?.handoffId === handoff.id &&
                            selectedHashes.get(historyItemKey(message)) ===
                              deliverySnapshot(message, 0).contentHash,
                          DateTime.toEpochMillis(handoff.createdAt),
                        ),
                      ),
                      ...(handoff.history?.omittedPlanSnapshots ?? []).map((snapshot) => ({
                        ...snapshot,
                        capturedAtMs: DateTime.toEpochMillis(handoff.createdAt),
                        order,
                        textBytes: 0,
                        delivered: false,
                      })),
                    ],
                    omittedItemIds: [
                      ...(handoff.history?.omittedItemIds ?? []),
                      ...(handoff.history?.messages ?? [])
                        .filter(
                          (message) =>
                            omittedKeys.has(historyItemKey(message)) ||
                            supersededSources.get(handoff.id)?.has(historyItemKey(message)),
                        )
                        .map((message) => message.itemId),
                    ],
                    itemIds: Array.from(
                      new Set([
                        ...(handoff.delivery?.nativeThreadId === nativeThreadId
                          ? handoff.delivery.itemIds
                          : []),
                        ...selected.messages
                          .filter(
                            (message) =>
                              candidates.get(historyItemKey(message))?.handoffId === handoff.id,
                          )
                          .map((message) => message.itemId),
                      ]),
                    ),
                  },
                }),
          }),
        { discard: true },
      );
    if (input.inject !== undefined && nativeThreadId !== undefined) {
      if (
        pending.some(
          (handoff) =>
            handoff.delivery?.nativeThreadId === nativeThreadId &&
            handoff.delivery.status === "pending",
        )
      ) {
        return yield* new ContextHandoffDeliveryUncertainError();
      }
      yield* persist("pending");
      const injected = yield* input.inject({
        messages: selected.messages,
        context: selected.context,
      });
      if (injected) {
        yield* persist("injected");
        return { context: "", delivered: Effect.void };
      }
    } else {
      // Text-only delivery can also be accepted before a connection drops.
      yield* persist("pending");
    }
    if (input.deferInline) {
      // Compaction APIs cannot accept an inline transcript. Keep it available
      // for the next ordinary turn when native injection is unsupported.
      yield* Effect.forEach(pending, input.persist, { discard: true });
      return { context: "", delivered: Effect.void };
    }
    return {
      context: renderHistory(selected.messages, selected.context),
      delivered: persist("inline"),
    };
  },
);

export class ContextHandoffBudgetError extends Schema.TaggedError<ContextHandoffBudgetError>()(
  "ContextHandoffBudgetError",
  {},
) {
  override get message() {
    return "Insufficient context allowance for the provider handoff. Compact the target conversation or use a larger-context model; the current request has not been truncated.";
  }
}
export class ContextHandoffDeliveryUncertainError extends Schema.TaggedError<ContextHandoffDeliveryUncertainError>()(
  "ContextHandoffDeliveryUncertainError",
  {},
) {
  override get message() {
    return "Historical context delivery is uncertain; replace the native thread before retrying.";
  }
}
