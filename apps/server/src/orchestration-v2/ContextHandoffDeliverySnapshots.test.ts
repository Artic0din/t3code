import { assert, it } from "@effect/vitest";
import {
  ContextHandoffId,
  EventId,
  PlanId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderThreadId,
  RunId,
  ThreadId,
  TurnItemId,
  type OrchestrationV2ContextHandoff,
  type OrchestrationV2HistoricalMessage,
  type OrchestrationV2ProviderThread,
  type OrchestrationV2TurnItem,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import * as SqlitePersistence from "../persistence/Sqlite.ts";
import { deliverContextHandoffs } from "./ContextHandoffDelivery.ts";
import { handoffBudget, historicalMessage, renderHistory } from "./ContextHandoffBudget.ts";
import {
  contextHandoffDeliveryState,
  deliverySnapshot,
  historyItemKey,
} from "./ContextHandoffSnapshots.ts";
import * as ContextHandoffService from "./ContextHandoffService.ts";
import * as IdAllocator from "./IdAllocator.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as EventStore from "./EventStore.ts";

const now = DateTime.makeUnsafe("2026-01-01T00:00:00Z");
const targetThreadId = ThreadId.make("thread:target");
const provider: OrchestrationV2ProviderThread = {
  id: ProviderThreadId.make("provider-thread:target"),
  driver: ProviderDriverKind.make("codex"),
  providerInstanceId: ProviderInstanceId.make("codex"),
  providerSessionId: null,
  appThreadId: targetThreadId,
  ownerNodeId: null,
  nativeThreadRef: {
    driver: ProviderDriverKind.make("codex"),
    strength: "strong",
    nativeId: "native:target",
  },
  nativeConversationHeadRef: null,
  status: "idle",
  firstRunOrdinal: null,
  lastRunOrdinal: null,
  handoffIds: [],
  forkedFrom: null,
  createdAt: now,
  updatedAt: now,
};

function snapshot(text: string, source = "source"): OrchestrationV2HistoricalMessage {
  return {
    threadId: ThreadId.make(`thread:${source}`),
    runId: RunId.make(`run:${source}`),
    itemId: TurnItemId.make("item:stable-plan"),
    providerThreadId: ProviderThreadId.make(`provider-thread:${source}`),
    role: "assistant",
    status: "running",
    kind: "todo_list",
    planId: PlanId.make(`plan:${source}`),
    text,
  };
}

function handoff(
  id: string,
  messages: ReadonlyArray<OrchestrationV2HistoricalMessage>,
): OrchestrationV2ContextHandoff {
  return {
    id: ContextHandoffId.make(`handoff:${id}`),
    threadId: targetThreadId,
    targetRunId: RunId.make("run:target"),
    fromProviderThreadIds: [],
    toProviderThreadId: provider.id,
    coveredRunOrdinals: { from: 1, to: 1 },
    strategy: "full_thread_summary",
    status: "ready",
    summaryMessageId: null,
    summaryText: "",
    history: { messages, coverage: "Recover source history with t3_thread_read.", omittedItems: 0 },
    createdByProviderInstanceId: null,
    createdAt: now,
    updatedAt: now,
  };
}

const immutable: OrchestrationV2HistoricalMessage = {
  ...snapshot("IMMUTABLE_REQUEST"),
  kind: "user_message",
  role: "user",
  status: "completed",
  itemId: TurnItemId.make("item:request"),
};

it.effect.each([
  { native: true, budget: 16_000 },
  { native: false, budget: 16_000 },
  { native: true, budget: 2_000 },
  { native: false, budget: 2_000 },
])("keeps inherited history before portable fork retries, %j", ({ native, budget }) =>
  Effect.gen(function* () {
    const parent = {
      ...immutable,
      itemId: TurnItemId.make("item:inherited-parent"),
      text: `PARENT_REQUEST ${"p".repeat(700)}`,
      sourceOrdinal: 500,
    };
    const child = {
      ...immutable,
      threadId: targetThreadId,
      itemId: TurnItemId.make("item:failed-child"),
      providerThreadId: provider.id,
      text: `CHILD_RETRY ${"c".repeat(700)}`,
      sourceOrdinal: 1,
    };
    let received: ReadonlyArray<OrchestrationV2HistoricalMessage> = [];
    const saved = new Map<ContextHandoffId, OrchestrationV2ContextHandoff>();
    const result = yield* deliverContextHandoffs({
      handoffs: [
        { ...handoff("inherited", [parent]), coveredRunOrdinals: { from: 1, to: 50 } },
        {
          ...handoff("child-retry", [child]),
          strategy: "delta_since_target_last_seen",
          createdAt: DateTime.makeUnsafe(DateTime.toEpochMillis(now) + 1_000),
        },
      ],
      providerThread: provider,
      budget,
      alreadyDeliveredItemIds: new Set(),
      persist: (record) => Effect.sync(() => void saved.set(record.id, record)),
      inject: (history) =>
        Effect.sync(() => {
          received = history.messages;
          return native;
        }),
    });
    yield* result.delivered;
    const expected = budget === 16_000 ? [parent.text, child.text] : [child.text];
    assert.deepEqual(
      received.map((message) => message.text),
      expected,
    );
    if (!native) {
      assert.include(result.context, child.text);
      if (budget === 16_000)
        assert.isBelow(result.context.indexOf(parent.text), result.context.indexOf(child.text));
      else assert.notInclude(result.context, parent.text);
    }
    assert.deepEqual(saved.get(ContextHandoffId.make("handoff:child-retry"))?.delivery?.itemIds, [
      child.itemId,
    ]);
  }),
);

it.effect("keeps source activity order across a delta and full native recovery", () =>
  Effect.gen(function* () {
    const earlier = {
      ...immutable,
      itemId: TurnItemId.make("item:earlier"),
      text: "EARLIER_REQUEST",
      sourceOrdinal: 1,
    };
    const answer = {
      ...immutable,
      role: "assistant" as const,
      kind: "assistant_message",
      itemId: TurnItemId.make("item:answer"),
      text: "EARLIER_ANSWER",
      sourceOrdinal: 2,
    };
    const recent = {
      ...immutable,
      itemId: TurnItemId.make("item:recent"),
      text: "LATEST_REQUEST",
      sourceOrdinal: 3,
    };
    const delta = { ...handoff("delta", [recent]), coveredRunOrdinals: { from: 2, to: 2 } };
    const full = {
      ...handoff("full", [earlier, answer, recent]),
      coveredRunOrdinals: { from: 1, to: 2 },
      createdAt: DateTime.makeUnsafe("2026-01-02T00:00:00Z"),
    };
    let received: ReadonlyArray<OrchestrationV2HistoricalMessage> = [];
    yield* deliverContextHandoffs({
      handoffs: [delta, full],
      providerThread: provider,
      budget: 16_000,
      alreadyDeliveredItemIds: new Set(),
      persist: () => Effect.void,
      inject: (history) =>
        Effect.sync(() => {
          received = history.messages;
          return true;
        }),
    });
    assert.deepEqual(
      received.map((message) => message.text),
      ["EARLIER_REQUEST", "EARLIER_ANSWER", "LATEST_REQUEST"],
    );
  }),
);

it.effect("preserves covered run order across provider-local ordinals", () =>
  Effect.gen(function* () {
    const earlier = {
      ...immutable,
      role: "assistant" as const,
      kind: "assistant_message",
      itemId: TurnItemId.make("item:older-provider-answer"),
      text: "EARLIER_ANSWER",
      providerThreadId: ProviderThreadId.make("provider-thread:older"),
      sourceOrdinal: 501,
    };
    const later = {
      ...earlier,
      itemId: TurnItemId.make("item:newer-provider-answer"),
      text: "LATEST_ANSWER",
      providerThreadId: ProviderThreadId.make("provider-thread:newer"),
      sourceOrdinal: 101,
    };
    let received: ReadonlyArray<OrchestrationV2HistoricalMessage> = [];
    yield* deliverContextHandoffs({
      handoffs: [
        { ...handoff("new-provider", [later]), coveredRunOrdinals: { from: 6, to: 6 } },
        { ...handoff("old-provider", [earlier]), coveredRunOrdinals: { from: 5, to: 5 } },
      ],
      providerThread: provider,
      budget: 16_000,
      alreadyDeliveredItemIds: new Set(),
      persist: () => Effect.void,
      inject: (history) =>
        Effect.sync(() => {
          received = history.messages;
          return true;
        }),
    });
    assert.deepEqual(
      received.map((message) => message.text),
      [earlier.text, later.text],
    );
  }),
);

it.effect("keeps parent recovery ahead of a fork with independent run counters", () =>
  Effect.gen(function* () {
    const parent = { ...immutable, threadId: targetThreadId, text: "PARENT_REQUEST" };
    const fork = { ...immutable, threadId: ThreadId.make("thread:fork"), text: "FORK_REQUEST" };
    let received: ReadonlyArray<OrchestrationV2HistoricalMessage> = [];
    yield* deliverContextHandoffs({
      handoffs: [
        {
          ...handoff("fork-counter", [fork]),
          strategy: "fork_delta_summary",
          coveredRunOrdinals: { from: 1, to: 3 },
        },
        { ...handoff("parent-recovery", [parent]), coveredRunOrdinals: { from: 1, to: 1 } },
      ],
      providerThread: provider,
      budget: 16_000,
      alreadyDeliveredItemIds: new Set(),
      persist: () => Effect.void,
      inject: (history) =>
        Effect.sync(() => {
          received = history.messages;
          return true;
        }),
    });
    assert.deepEqual(
      received.map((message) => message.text),
      [parent.text, fork.text],
    );
  }),
);

it.effect.each([true, false])(
  "uses capture time for tied plan updates and receipts, native=%s",
  (native) =>
    Effect.gen(function* () {
      const old = { ...snapshot("OLD_PLAN"), sourceUpdatedAtMs: DateTime.toEpochMillis(now) };
      const current = { ...old, text: "NEW_PLAN" };
      const stale = {
        ...handoff("cached-delta-tie", [old]),
        coveredRunOrdinals: { from: 2, to: 2 },
      };
      const fresh = {
        ...handoff("full-recovery-tie", [current]),
        createdAt: DateTime.makeUnsafe(DateTime.toEpochMillis(now) + 1_000),
        coveredRunOrdinals: { from: 1, to: 2 },
      };
      const saved = new Map<ContextHandoffId, OrchestrationV2ContextHandoff>();
      const received: string[] = [];
      const inject = (history: { messages: ReadonlyArray<OrchestrationV2HistoricalMessage> }) =>
        Effect.sync(() => {
          received.push(...history.messages.map((message) => message.text));
          return native;
        });
      const result = yield* deliverContextHandoffs({
        handoffs: [fresh, stale],
        providerThread: provider,
        budget: 16_000,
        alreadyDeliveredItemIds: new Set(),
        inject,
        persist: (record) =>
          Effect.sync(() => {
            saved.set(record.id, record);
          }),
      });
      yield* result.delivered;
      assert.deepEqual(received, [current.text]);
      const retry = yield* deliverContextHandoffs({
        handoffs: [{ ...stale, id: ContextHandoffId.make("handoff:late-cached-tie") }],
        alreadyDeliveredHandoffs: [...saved.values()],
        providerThread: provider,
        budget: 16_000,
        alreadyDeliveredItemIds: new Set([current.itemId]),
        inject,
        persist: () => Effect.void,
      });
      yield* retry.delivered;
      assert.deepEqual(received, [current.text]);
    }),
);

it.effect("orders overlapping recovery within each source before combining fork history", () =>
  Effect.gen(function* () {
    const earlier = {
      ...immutable,
      threadId: targetThreadId,
      itemId: TurnItemId.make("item:source-earlier"),
      text: "EARLIER_REQUEST",
      providerThreadId: ProviderThreadId.make("provider-thread:first"),
      sourceOrdinal: 501,
    };
    const later = {
      ...earlier,
      itemId: TurnItemId.make("item:source-later"),
      text: "LATEST_REQUEST",
      providerThreadId: ProviderThreadId.make("provider-thread:second"),
      sourceOrdinal: 101,
    };
    const fork = {
      ...immutable,
      threadId: ThreadId.make("thread:fork-cycle"),
      text: "FORK_REQUEST",
    };
    let received: ReadonlyArray<OrchestrationV2HistoricalMessage> = [];
    yield* deliverContextHandoffs({
      handoffs: [
        { ...handoff("cycle-delta", [later]), coveredRunOrdinals: { from: 2, to: 2 } },
        {
          ...handoff("cycle-fork", [fork]),
          createdAt: DateTime.makeUnsafe(DateTime.toEpochMillis(now) + 1_000),
        },
        {
          ...handoff("cycle-full", [earlier, later]),
          coveredRunOrdinals: { from: 1, to: 2 },
          createdAt: DateTime.makeUnsafe(DateTime.toEpochMillis(now) + 2_000),
        },
      ],
      providerThread: provider,
      budget: 16_000,
      alreadyDeliveredItemIds: new Set(),
      persist: () => Effect.void,
      inject: (history) =>
        Effect.sync(() => {
          received = history.messages;
          return true;
        }),
    });
    assert.deepEqual(
      received.map((message) => message.text),
      [earlier.text, later.text, fork.text],
    );
  }),
);

it.effect.each(["assistant_message", "command_execution"])(
  "uses finalized pending %s during native recovery",
  (kind) =>
    Effect.gen(function* () {
      const partial = {
        ...immutable,
        role: "assistant" as const,
        kind,
        status: "running",
        text: "PARTIAL unknown exit",
        sourceUpdatedAtMs: DateTime.toEpochMillis(now),
      };
      const finished = {
        ...partial,
        status: "completed",
        text: "FINAL output exit 0",
        sourceUpdatedAtMs: DateTime.toEpochMillis(DateTime.makeUnsafe("2026-01-02T00:00:00Z")),
      };
      const old = handoff("partial", [partial]);
      const full = {
        ...handoff("final", [finished]),
        createdAt: DateTime.makeUnsafe(finished.sourceUpdatedAtMs),
      };
      let received: ReadonlyArray<OrchestrationV2HistoricalMessage> = [];
      yield* deliverContextHandoffs({
        handoffs: [old, full],
        providerThread: provider,
        budget: 16_000,
        alreadyDeliveredItemIds: new Set(),
        persist: () => Effect.void,
        inject: (history) =>
          Effect.sync(() => {
            received = history.messages;
            return true;
          }),
      });
      assert.deepEqual(
        received.map((message) => message.text),
        [finished.text],
      );
    }),
);

it.effect.each([true, false])(
  "keeps finalized pending activity when update timestamps tie, native=%s",
  (native) =>
    Effect.gen(function* () {
      const partial = {
        ...immutable,
        kind: "assistant_message",
        role: "assistant" as const,
        status: "running",
        text: "PARTIAL",
        sourceUpdatedAtMs: DateTime.toEpochMillis(now),
      };
      const final = { ...partial, status: "completed", text: "FINAL" };
      let received: ReadonlyArray<OrchestrationV2HistoricalMessage> = [];
      const result = yield* deliverContextHandoffs({
        handoffs: [handoff("partial-tie", [partial]), handoff("final-tie", [final])],
        providerThread: provider,
        budget: 16_000,
        alreadyDeliveredItemIds: new Set(),
        persist: () => Effect.void,
        inject: (history) =>
          Effect.sync(() => {
            received = history.messages;
            return native;
          }),
      });
      yield* result.delivered;
      assert.deepEqual(
        received.map((message) => message.text),
        [final.text],
      );
      if (!native) assert.notInclude(result.context, partial.text);
    }),
);

it.effect("keeps preparation-stage recovery coverage for an unchanged oversized plan", () =>
  Effect.gen(function* () {
    const service = yield* ContextHandoffService.ContextHandoffServiceV2;
    const store = yield* EventStore.EventStoreV2;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    yield* projections.apply({
      id: EventId.make("event:omitted:thread"),
      type: "thread.created",
      threadId: targetThreadId,
      occurredAt: now,
      payload: {
        id: targetThreadId,
        projectId: ProjectId.make("project:omitted"),
        title: "Recovery coverage",
        createdBy: "user",
        creationSource: "web",
        providerInstanceId: provider.providerInstanceId,
        modelSelection: { instanceId: provider.providerInstanceId, model: "gpt-5" },
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        activeProviderThreadId: null,
        lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: targetThreadId },
        forkedFrom: null,
        createdAt: now,
        updatedAt: now,
        archivedAt: null,
        settledOverride: null,
        settledAt: null,
        lastVisitedAt: null,
        deletedAt: null,
      },
    });
    const item: OrchestrationV2TurnItem = {
      id: snapshot("").itemId,
      threadId: targetThreadId,
      runId: RunId.make("run:failed"),
      nodeId: null,
      providerThreadId: provider.id,
      providerTurnId: null,
      nativeItemRef: null,
      parentItemId: null,
      ordinal: 1,
      status: "running",
      title: null,
      startedAt: now,
      completedAt: null,
      updatedAt: now,
      type: "todo_list",
      planId: PlanId.make("plan:oversized"),
      steps: [{ id: "large", text: "x".repeat(60_000), status: "pending" }],
    };
    const prepared = yield* service.prepareProviderHandoff({
      threadId: targetThreadId,
      targetRunId: RunId.make("run:target"),
      transferId: null,
      fromProviderThreadIds: [provider.id],
      toProviderThreadId: provider.id,
      fromProviderInstanceId: provider.providerInstanceId,
      toProviderInstanceId: provider.providerInstanceId,
      coveredRunOrdinals: { from: 1, to: 1 },
      strategy: "delta_since_target_last_seen",
      items: [item],
      createdAt: now,
    });
    assert.deepEqual(prepared.history?.messages, []);
    assert.deepEqual(prepared.history?.omittedItemIds, [item.id]);
    let events = 0;
    let injections = 0;
    const deliver = (record: OrchestrationV2ContextHandoff) =>
      deliverContextHandoffs({
        handoffs: [record],
        providerThread: provider,
        budget: 16_000,
        alreadyDeliveredItemIds: new Set(record.delivery?.itemIds ?? []),
        alreadyDeliveredHandoffs: record.delivery === undefined ? [] : [record],
        inject: ({ messages }) =>
          Effect.sync(() => {
            assert.deepEqual(messages, []);
            injections++;
            return true;
          }),
        persist: (payload) =>
          store
            .append({
              events: [
                {
                  id: EventId.make(`event:omitted:${++events}`),
                  type: "context-handoff.updated",
                  threadId: targetThreadId,
                  occurredAt: now,
                  payload,
                },
              ],
            })
            .pipe(Effect.asVoid),
      });
    yield* deliver(prepared);
    const saved = (yield* Stream.runCollect(store.read())).at(-1)!.event;
    assert.equal(saved.type, "context-handoff.updated");
    if (saved.type !== "context-handoff.updated") return;
    const message = historicalMessage(item)!;
    assert.equal(
      contextHandoffDeliveryState([saved.payload]).coveredPlans.get(historyItemKey(message))
        ?.contentHash,
      deliverySnapshot(message, 0).contentHash,
    );
    const count = events;
    yield* deliver(saved.payload);
    assert.equal(events, count);
    assert.equal(injections, 1);
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        ContextHandoffService.layer.pipe(
          Layer.provideMerge(Layer.merge(IdAllocator.layer, ProjectionStore.layerMemory)),
        ),
        EventStore.layer.pipe(Layer.provide(SqlitePersistence.layerMemory)),
      ),
    ),
  ),
);

it.effect.each([true, false])("selects the updated same-batch plan, native=%s", (native) =>
  Effect.gen(function* () {
    const store = yield* EventStore.EventStoreV2;
    const received: OrchestrationV2HistoricalMessage[] = [];
    let eventIndex = 0;
    const old = handoff("old", [immutable, snapshot("pending: OLD")]);
    const current = handoff("new", [immutable, snapshot("completed: NEW")]);
    const input = {
      handoffs: [old, current],
      providerThread: provider,
      budget: 16_000,
      alreadyDeliveredItemIds: new Set<string>(),
      alreadyDeliveredHandoffs: [],
      inject: (history: { messages: ReadonlyArray<OrchestrationV2HistoricalMessage> }) =>
        Effect.sync(() => {
          if (native) received.push(...history.messages);
          return native;
        }),
      persist: (record: OrchestrationV2ContextHandoff) =>
        store
          .append({
            events: [
              {
                id: EventId.make(`event:same-batch:${++eventIndex}`),
                type: "context-handoff.updated" as const,
                threadId: targetThreadId,
                occurredAt: now,
                payload: record,
              },
            ],
          })
          .pipe(Effect.asVoid),
    };
    const result = yield* deliverContextHandoffs(input);
    yield* result.delivered;
    if (native)
      assert.deepEqual(
        received.map((message) => message.text),
        ["IMMUTABLE_REQUEST", "completed: NEW"],
      );
    else {
      assert.include(result.context, "completed: NEW");
      assert.notInclude(result.context, "pending: OLD");
    }
    const records = new Map<ContextHandoffId, OrchestrationV2ContextHandoff>();
    for (const stored of yield* Stream.runCollect(store.read())) {
      if (stored.event.type === "context-handoff.updated")
        records.set(stored.event.payload.id, stored.event.payload);
    }
    assert.deepEqual(records.get(old.id)?.delivery?.itemIds, [immutable.itemId]);
    assert.deepEqual(records.get(current.id)?.delivery?.itemIds, [snapshot("").itemId]);
    assert.include(records.get(old.id)?.delivery?.omittedItemIds ?? [], snapshot("").itemId);
  }).pipe(Effect.provide(EventStore.layer.pipe(Layer.provide(SqlitePersistence.layerMemory)))),
);

it.effect("redelivers a changed plan once after persisted prior delivery", () =>
  Effect.gen(function* () {
    const store = yield* EventStore.EventStoreV2;
    const received: string[] = [];
    let deliveredTextBytes = 0;
    let eventIndex = 0;
    const saved = new Map<ContextHandoffId, OrchestrationV2ContextHandoff>();
    const deliver = (candidate: OrchestrationV2ContextHandoff) => {
      const input = {
        handoffs: [candidate],
        providerThread: provider,
        budget: 16_000,
        alreadyDeliveredItemIds: new Set(
          [...saved.values()].flatMap((record) => record.delivery?.itemIds ?? []),
        ),
        alreadyDeliveredHandoffs: [...saved.values()],
        inject: (history: {
          messages: ReadonlyArray<OrchestrationV2HistoricalMessage>;
          context: string;
        }) =>
          Effect.sync(() => {
            received.push(...history.messages.map((message) => message.text));
            deliveredTextBytes += Buffer.byteLength(
              renderHistory(history.messages, history.context),
            );
            return true;
          }),
        persist: (record: OrchestrationV2ContextHandoff) =>
          store
            .append({
              events: [
                {
                  id: EventId.make(`event:successive:${++eventIndex}`),
                  type: "context-handoff.updated" as const,
                  threadId: targetThreadId,
                  occurredAt: now,
                  payload: record,
                },
              ],
            })
            .pipe(Effect.asVoid),
      };
      return deliverContextHandoffs(input).pipe(
        Effect.andThen(
          Effect.gen(function* () {
            saved.clear();
            for (const stored of yield* Stream.runCollect(store.read())) {
              if (stored.event.type === "context-handoff.updated")
                saved.set(stored.event.payload.id, stored.event.payload);
            }
          }),
        ),
      );
    };
    const first = handoff("first", [immutable, snapshot("pending: OLD")]);
    const second = handoff("second", [immutable, snapshot("completed: NEW")]);
    yield* deliver(first);
    yield* deliver(second);
    assert.deepEqual(received, ["IMMUTABLE_REQUEST", "pending: OLD", "completed: NEW"]);
    const importedState = contextHandoffDeliveryState([...saved.values()]);
    assert.equal(
      [...importedState.occupiedBytes.values()].reduce((sum, bytes) => sum + bytes, 0) +
        (importedState.contextBytes ?? 0),
      deliveredTextBytes,
    );
    const occupancy = contextHandoffDeliveryState([...saved.values()]).occupiedBytes;
    assert.equal(
      occupancy.get(historyItemKey(snapshot(""))),
      Buffer.byteLength(renderHistory([snapshot("pending: OLD"), snapshot("completed: NEW")], "")),
    );
    assert.equal(
      [...occupancy.values()].reduce((sum, bytes) => sum + bytes, 0),
      Buffer.byteLength(
        renderHistory([immutable, snapshot("pending: OLD"), snapshot("completed: NEW")], ""),
      ),
    );
    assert.equal(
      handoffBudget({
        tokenCap: 16_000,
        userText: "continue",
        attachments: [],
        providerThread: provider,
        nativeContextEstimate: deliveredTextBytes,
        modelContextWindow: 20_000,
      }),
      20_000 - 16_000 - 10 - deliveredTextBytes,
    );
    yield* deliver(handoff("unchanged", [immutable, snapshot("completed: NEW")]));
    const beforeRetry = eventIndex;
    yield* deliver(saved.get(second.id)!);
    assert.equal(eventIndex, beforeRetry);
    assert.deepEqual(received, ["IMMUTABLE_REQUEST", "pending: OLD", "completed: NEW"]);
  }).pipe(Effect.provide(EventStore.layer.pipe(Layer.provide(SqlitePersistence.layerMemory)))),
);

it.effect("keeps independent source threads with the same item ID", () =>
  Effect.gen(function* () {
    const received: OrchestrationV2HistoricalMessage[] = [];
    const records: OrchestrationV2ContextHandoff[] = [];
    const result = yield* deliverContextHandoffs({
      handoffs: [
        handoff("alpha", [snapshot("ALPHA", "alpha")]),
        handoff("beta", [{ ...snapshot("BETA", "beta"), planId: PlanId.make("plan:alpha") }]),
      ],
      providerThread: provider,
      budget: 16_000,
      alreadyDeliveredItemIds: new Set(),
      inject: (history) =>
        Effect.sync(() => {
          received.push(...history.messages);
          return true;
        }),
      persist: (record) =>
        Effect.sync(() => {
          records.push(record);
        }),
    });
    yield* result.delivered;
    assert.deepEqual(
      received.map((message) => message.text),
      ["ALPHA", "BETA"],
    );
    assert.deepEqual(
      records
        .filter((record) => record.delivery?.status === "injected")
        .map((record) => record.delivery?.itemIds),
      [[TurnItemId.make("item:stable-plan")], [TurnItemId.make("item:stable-plan")]],
    );
  }),
);

it.effect("persists successive versions of a reused handoff without losing occupancy", () =>
  Effect.gen(function* () {
    const received: string[] = [];
    let saved = handoff("reused", [immutable, snapshot("pending: OLD")]);
    const deliver = () => {
      const input = {
        handoffs: [saved],
        providerThread: provider,
        budget: 16_000,
        alreadyDeliveredItemIds: new Set(saved.delivery?.itemIds ?? []),
        alreadyDeliveredHandoffs: saved.delivery === undefined ? [] : [saved],
        inject: (history: { messages: ReadonlyArray<OrchestrationV2HistoricalMessage> }) =>
          Effect.sync(() => {
            received.push(...history.messages.map((message) => message.text));
            return true;
          }),
        persist: (record: OrchestrationV2ContextHandoff) =>
          Effect.sync(() => {
            saved = record;
          }),
      };
      return deliverContextHandoffs(input);
    };
    yield* deliver();
    saved = {
      ...saved,
      history: { ...saved.history!, messages: [immutable, snapshot("completed: NEW")] },
    };
    yield* deliver();
    assert.deepEqual(received, ["IMMUTABLE_REQUEST", "pending: OLD", "completed: NEW"]);
    assert.equal(
      contextHandoffDeliveryState([saved]).occupiedBytes.get(historyItemKey(snapshot(""))),
      Buffer.byteLength(renderHistory([snapshot("pending: OLD"), snapshot("completed: NEW")], "")),
    );
    yield* deliver();
    assert.lengthOf(received, 3);
    saved = {
      ...saved,
      history: { ...saved.history!, messages: [immutable, snapshot("pending: OLD")] },
    };
    yield* deliver();
    assert.deepEqual(received, [
      "IMMUTABLE_REQUEST",
      "pending: OLD",
      "completed: NEW",
      "pending: OLD",
    ]);
    assert.equal(
      contextHandoffDeliveryState([saved]).occupiedBytes.get(historyItemKey(snapshot(""))),
      Buffer.byteLength(
        renderHistory(
          [snapshot("pending: OLD"), snapshot("completed: NEW"), snapshot("pending: OLD")],
          "",
        ),
      ),
    );
  }),
);

it.effect.each([true, false])(
  "keeps fresh recovery state ahead of an older cached snapshot, native=%s",
  (native) =>
    Effect.gen(function* () {
      const received: OrchestrationV2HistoricalMessage[] = [];
      const old = handoff("older-recovery", [snapshot("pending: OLD")]);
      const fresh = {
        ...handoff("fresh-recovery", [snapshot("completed: NEW")]),
        createdAt: DateTime.makeUnsafe("2026-01-02T00:00:00Z"),
      };
      const result = yield* deliverContextHandoffs({
        handoffs: [fresh, old],
        providerThread: provider,
        budget: 16_000,
        alreadyDeliveredItemIds: new Set(),
        inject: (history) =>
          Effect.sync(() => {
            received.push(...history.messages);
            return native;
          }),
        persist: () => Effect.void,
      });
      yield* result.delivered;
      assert.deepEqual(
        received.map((message) => message.text),
        ["completed: NEW"],
      );
      if (!native) assert.notInclude(result.context, "pending: OLD");
    }),
);

it.effect("attributes omissions by source thread when item IDs overlap", () =>
  Effect.gen(function* () {
    const saved = new Map<ContextHandoffId, OrchestrationV2ContextHandoff>();
    const old = handoff("large-alpha", [snapshot("x".repeat(4_000), "alpha")]);
    const current = handoff("small-beta", [snapshot("BETA", "beta")]);
    const result = yield* deliverContextHandoffs({
      handoffs: [old, current],
      providerThread: provider,
      budget: 1_800,
      alreadyDeliveredItemIds: new Set(),
      inject: () => Effect.succeed(true),
      persist: (record) =>
        Effect.sync(() => {
          saved.set(record.id, record);
        }),
    });
    yield* result.delivered;
    assert.deepEqual(saved.get(old.id)?.delivery?.omittedItemIds, [snapshot("").itemId]);
    assert.deepEqual(saved.get(current.id)?.delivery?.itemIds, [snapshot("").itemId]);
    assert.deepEqual(saved.get(current.id)?.delivery?.omittedItemIds, []);
  }),
);

it.effect("uses updated source state when a reused handoff predates another cache", () =>
  Effect.gen(function* () {
    const received: string[] = [];
    let saved = handoff("old-record-updated", [snapshot("pending: OLD")]);
    const persist = (record: OrchestrationV2ContextHandoff) =>
      Effect.sync(() => {
        if (record.id === saved.id) saved = record;
      });
    const inject = (history: { messages: ReadonlyArray<OrchestrationV2HistoricalMessage> }) =>
      Effect.sync(() => {
        received.push(...history.messages.map((message) => message.text));
        return true;
      });
    yield* deliverContextHandoffs({
      handoffs: [saved],
      providerThread: provider,
      budget: 16_000,
      alreadyDeliveredItemIds: new Set(),
      inject,
      persist,
    });
    const stale = {
      ...handoff("newer-record-stale", [
        {
          ...snapshot("pending: OLD"),
          sourceUpdatedAtMs: DateTime.toEpochMillis(DateTime.makeUnsafe("2026-01-02T00:00:00Z")),
        },
      ]),
      createdAt: DateTime.makeUnsafe("2026-01-04T00:00:00Z"),
    };
    saved = {
      ...saved,
      history: {
        ...saved.history!,
        messages: [
          {
            ...snapshot("completed: NEW"),
            sourceUpdatedAtMs: DateTime.toEpochMillis(DateTime.makeUnsafe("2026-01-03T00:00:00Z")),
          },
        ],
      },
    };
    yield* deliverContextHandoffs({
      handoffs: [saved, stale],
      alreadyDeliveredHandoffs: [saved],
      providerThread: provider,
      budget: 16_000,
      alreadyDeliveredItemIds: new Set(saved.delivery!.itemIds),
      inject,
      persist,
    });
    assert.deepEqual(received, ["pending: OLD", "completed: NEW"]);
  }),
);

it.effect("does not roll a delivered plan back to an older source version", () =>
  Effect.gen(function* () {
    const old = { ...snapshot("pending: OLD"), sourceUpdatedAtMs: DateTime.toEpochMillis(now) };
    const current = {
      ...snapshot("completed: NEW"),
      sourceUpdatedAtMs: DateTime.toEpochMillis(DateTime.makeUnsafe("2026-01-03T00:00:00Z")),
    };
    let saved = handoff("current-version", [current]);
    const received: string[] = [];
    const inject = (history: { messages: ReadonlyArray<OrchestrationV2HistoricalMessage> }) =>
      Effect.sync(() => {
        received.push(...history.messages.map((message) => message.text));
        return true;
      });
    yield* deliverContextHandoffs({
      handoffs: [saved],
      providerThread: provider,
      budget: 16_000,
      alreadyDeliveredItemIds: new Set(),
      inject,
      persist: (record) =>
        Effect.sync(() => {
          saved = record;
        }),
    });
    yield* deliverContextHandoffs({
      handoffs: [handoff("late-stale-cache", [old])],
      alreadyDeliveredHandoffs: [saved],
      providerThread: provider,
      budget: 16_000,
      alreadyDeliveredItemIds: new Set(saved.delivery!.itemIds),
      inject,
      persist: () => Effect.void,
    });
    assert.deepEqual(received, [current.text]);
  }),
);

it.effect.each([true, false])(
  "advances covered freshness for an identical updated delivered plan, native=%s",
  (native) =>
    Effect.gen(function* () {
      const first = { ...snapshot("STATE_A"), sourceUpdatedAtMs: DateTime.toEpochMillis(now) };
      const latest = { ...first, sourceUpdatedAtMs: first.sourceUpdatedAtMs + 2_000 };
      const received: string[] = [];
      let saved = handoff("same-content-updated", [first]);
      const inject = (history: { messages: ReadonlyArray<OrchestrationV2HistoricalMessage> }) =>
        Effect.sync(() => {
          received.push(...history.messages.map((message) => message.text));
          return native;
        });
      const persist = (record: OrchestrationV2ContextHandoff) =>
        Effect.sync(() => {
          saved = record;
        });
      const firstResult = yield* deliverContextHandoffs({
        handoffs: [saved],
        providerThread: provider,
        budget: 16_000,
        alreadyDeliveredItemIds: new Set(),
        inject,
        persist,
      });
      yield* firstResult.delivered;
      saved = { ...saved, history: { ...saved.history!, messages: [latest] } };
      const updated = yield* deliverContextHandoffs({
        handoffs: [saved],
        alreadyDeliveredHandoffs: [saved],
        providerThread: provider,
        budget: 16_000,
        alreadyDeliveredItemIds: new Set([first.itemId]),
        inject,
        persist,
      });
      yield* updated.delivered;
      assert.equal(
        contextHandoffDeliveryState([saved]).coveredPlans.get(historyItemKey(first))
          ?.sourceUpdatedAtMs,
        latest.sourceUpdatedAtMs,
      );
      const stale = yield* deliverContextHandoffs({
        handoffs: [
          handoff("stale-middle", [
            { ...first, text: "STATE_B", sourceUpdatedAtMs: first.sourceUpdatedAtMs + 1_000 },
          ]),
        ],
        alreadyDeliveredHandoffs: [saved],
        providerThread: provider,
        budget: 16_000,
        alreadyDeliveredItemIds: new Set([first.itemId]),
        inject,
        persist: () => Effect.void,
      });
      yield* stale.delivered;
      assert.deepEqual(received, [first.text]);
    }),
);

it.effect.each([true, false])(
  "advances receipt freshness when the newest plan repeats earlier content, native=%s",
  (native) =>
    Effect.gen(function* () {
      const first = { ...snapshot("STATE_A"), sourceUpdatedAtMs: DateTime.toEpochMillis(now) };
      const middle = {
        ...first,
        text: "STATE_B",
        sourceUpdatedAtMs: first.sourceUpdatedAtMs + 1_000,
      };
      const latest = { ...first, sourceUpdatedAtMs: first.sourceUpdatedAtMs + 2_000 };
      const records = [
        { ...handoff("broad-A", [first]), coveredRunOrdinals: { from: 1, to: 3 } },
        { ...handoff("latest-A", [latest]), coveredRunOrdinals: { from: 2, to: 2 } },
        { ...handoff("middle-B", [middle]), coveredRunOrdinals: { from: 3, to: 3 } },
      ];
      let received: ReadonlyArray<OrchestrationV2HistoricalMessage> = [];
      const saved = new Map<ContextHandoffId, OrchestrationV2ContextHandoff>();
      const inject = (history: { messages: ReadonlyArray<OrchestrationV2HistoricalMessage> }) =>
        Effect.sync(() => {
          received = [...received, ...history.messages];
          return native;
        });
      const result = yield* deliverContextHandoffs({
        handoffs: records,
        providerThread: provider,
        budget: 16_000,
        alreadyDeliveredItemIds: new Set(),
        persist: (record) =>
          Effect.sync(() => {
            saved.set(record.id, record);
          }),
        inject,
      });
      yield* result.delivered;
      assert.deepEqual(
        received.map((message) => message.text),
        [latest.text],
      );
      const state = contextHandoffDeliveryState([...saved.values()]);
      assert.equal(
        state.latestPlans.get(historyItemKey(latest))?.sourceUpdatedAtMs,
        latest.sourceUpdatedAtMs,
      );
      const retry = yield* deliverContextHandoffs({
        handoffs: [handoff("late-middle", [middle])],
        alreadyDeliveredHandoffs: [...saved.values()],
        providerThread: provider,
        budget: 16_000,
        alreadyDeliveredItemIds: new Set([latest.itemId]),
        persist: () => Effect.void,
        inject,
      });
      yield* retry.delivered;
      assert.deepEqual(
        received.map((message) => message.text),
        [latest.text],
      );
    }),
);
