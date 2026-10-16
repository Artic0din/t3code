import { assert, it } from "@effect/vitest";
import {
  EventId,
  NodeId,
  PlanId,
  ProjectId,
  ProviderInstanceId,
  ProviderDriverKind,
  ProviderThreadId,
  RunId,
  ThreadId,
  TurnItemId,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2PlanArtifact,
  type OrchestrationV2TurnItem,
  type OrchestrationV2ProviderThread,
  type OrchestrationV2ContextHandoff,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import * as SqlitePersistence from "../persistence/Sqlite.ts";
import { historicalMessage, readSupersededHistoryPlans } from "./ContextHandoffBudget.ts";
import { deliverContextHandoffs } from "./ContextHandoffDelivery.ts";
import * as ContextHandoffService from "./ContextHandoffService.ts";
import * as EventStore from "./EventStore.ts";
import * as IdAllocator from "./IdAllocator.ts";
import * as ProjectionStore from "./ProjectionStore.ts";

const threadId = ThreadId.make("thread:legacy-plans");
const now = DateTime.makeUnsafe("2026-01-01T00:00:00Z");
const providerInstanceId = ProviderInstanceId.make("claude");
const providerThreadId = ProviderThreadId.make("provider-thread:legacy-plans");
const runIds = [RunId.make("run:legacy-old"), RunId.make("run:legacy-current")];
const snapshots = [
  { kind: "todo_list", text: "OLD_TODO", planStatus: "superseded" },
  { kind: "proposed_plan", text: "OLD_PROPOSAL", planStatus: "superseded" },
  { kind: "todo_list", text: "COMPLETED_WORK", planStatus: "completed" },
  { kind: "todo_list", text: "CURRENT_TODO", planStatus: "active" },
] as const;

const events: ReadonlyArray<OrchestrationV2DomainEvent> = [
  {
    id: EventId.make("event:legacy-plans:thread"),
    type: "thread.created",
    threadId,
    occurredAt: now,
    payload: {
      id: threadId,
      projectId: ProjectId.make("project:legacy-plans"),
      title: "Pre-change plan history",
      createdBy: "user",
      creationSource: "web",
      providerInstanceId,
      modelSelection: { instanceId: providerInstanceId, model: "claude-sonnet-4-6" },
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      activeProviderThreadId: null,
      lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
      forkedFrom: null,
      createdAt: now,
      updatedAt: now,
      archivedAt: null,
      settledOverride: null,
      settledAt: null,
      lastVisitedAt: null,
      deletedAt: null,
    },
  },
  ...snapshots.flatMap((snapshot, index): OrchestrationV2DomainEvent[] => {
    const runId = runIds[index === 3 ? 1 : 0]!;
    const planId = PlanId.make(`plan:legacy:${index}`);
    const nodeId = NodeId.make(`node:legacy:${index}`);
    const steps = [
      {
        id: `step:${index}`,
        text: snapshot.text,
        status: snapshot.planStatus === "completed" ? "completed" : "pending",
      },
    ] as const;
    const itemBase = {
      id: TurnItemId.make(`item:legacy:${index}`),
      threadId,
      runId,
      nodeId,
      providerThreadId,
      providerTurnId: null,
      nativeItemRef: null,
      parentItemId: null,
      ordinal: index + 1,
      status: "completed" as const,
      title: null,
      startedAt: now,
      completedAt: now,
      updatedAt: now,
      planId,
    };
    const planBase = {
      id: planId,
      threadId,
      runId,
      nodeId,
      status: snapshot.planStatus,
      createdAt: now,
      updatedAt: now,
    };
    const item: OrchestrationV2TurnItem =
      snapshot.kind === "todo_list"
        ? { ...itemBase, type: "todo_list", steps }
        : { ...itemBase, type: "proposed_plan", markdown: snapshot.text, streaming: false };
    const plan: OrchestrationV2PlanArtifact =
      snapshot.kind === "todo_list"
        ? { ...planBase, kind: "todo_list", steps }
        : { ...planBase, kind: "proposed_plan", markdown: snapshot.text };
    return [
      {
        id: EventId.make(`event:legacy:${index}:item`),
        type: "turn-item.updated",
        threadId,
        runId,
        occurredAt: now,
        payload: item,
      },
      {
        id: EventId.make(`event:legacy:${index}:plan`),
        type: "plan.updated",
        threadId,
        runId,
        occurredAt: now,
        payload: plan,
      },
    ];
  }),
];

function testLayer(storage: "sql" | "memory") {
  const projections = storage === "sql" ? ProjectionStore.layer : ProjectionStore.layerMemory;
  return Layer.mergeAll(
    projections,
    EventStore.layer,
    ContextHandoffService.layer.pipe(Layer.provide(Layer.merge(IdAllocator.layer, projections))),
  ).pipe(Layer.provide(SqlitePersistence.layerMemory));
}

it.effect.each(["sql", "memory"] as const)(
  "%s replay excludes pre-change superseded plans across handoff paths",
  (storage) =>
    Effect.gen(function* () {
      const eventStore = yield* EventStore.EventStoreV2;
      const store = yield* ProjectionStore.ProjectionStoreV2;
      const service = yield* ContextHandoffService.ContextHandoffServiceV2;
      yield* eventStore.append({ events });
      const persisted = yield* Stream.runCollect(eventStore.read({ threadId }));
      for (const stored of persisted) yield* store.apply(stored.event);
      const rawItems = (yield* store.getThreadRecords(threadId, ["turnItems"])).turnItems;
      const resumeItems = yield* store.getTurnStartHistory(threadId, runIds);
      const base = {
        threadId,
        targetRunId: RunId.make("run:handoff-target"),
        transferId: null,
        fromProviderThreadIds: [providerThreadId],
        toProviderThreadId: ProviderThreadId.make("provider-thread:target"),
        fromProviderInstanceId: providerInstanceId,
        toProviderInstanceId: ProviderInstanceId.make("codex"),
        coveredRunOrdinals: { from: 1, to: 2 },
        createdAt: now,
      };
      const handoffs = [
        yield* service.prepareProviderHandoff({
          ...base,
          strategy: "full_thread_summary",
          items: rawItems,
        }),
        yield* service.prepareProviderHandoff({
          ...base,
          strategy: "delta_since_target_last_seen",
          items: resumeItems,
        }),
        yield* service.prepareForkDelta({
          ...base,
          sourceThreadId: threadId,
          targetThreadId: ThreadId.make("thread:parent"),
          deltaItems: rawItems,
        }),
      ];
      for (const handoff of handoffs) {
        assert.deepEqual(
          handoff.history?.messages.map((message) => message.text),
          ["completed: COMPLETED_WORK", "pending: CURRENT_TODO"],
        );
        assert.deepEqual(
          handoff.history?.omittedItemIds,
          rawItems.slice(0, 2).map((item) => item.id),
        );
        assert.equal(handoff.history?.omittedItems, 2);
      }
      const oldMessages = rawItems.flatMap((item) => {
        const message = historicalMessage(item);
        if (message === null) return [];
        const cached = { ...message };
        delete cached.planId;
        return [cached];
      });
      const supersededPlans = yield* readSupersededHistoryPlans(store, oldMessages);
      const targetProvider: OrchestrationV2ProviderThread = {
        id: base.toProviderThreadId,
        driver: ProviderDriverKind.make("codex"),
        providerInstanceId: base.toProviderInstanceId,
        providerSessionId: null,
        appThreadId: threadId,
        ownerNodeId: null,
        nativeThreadRef: {
          driver: ProviderDriverKind.make("codex"),
          strength: "strong",
          nativeId: "native:legacy-target",
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
      for (const native of [true, false]) {
        let saved: OrchestrationV2ContextHandoff = {
          ...handoffs[0]!,
          history: {
            messages: oldMessages,
            coverage: "Cached pre-change history.",
            omittedItems: 0,
            omittedItemIds: [],
          },
        };
        const delivery = yield* deliverContextHandoffs({
          handoffs: [saved],
          providerThread: targetProvider,
          budget: 16_000,
          supersededPlans,
          alreadyDeliveredItemIds: new Set(),
          inject: (history) => {
            assert.deepEqual(
              history.messages.map((message) => message.text),
              ["completed: COMPLETED_WORK", "pending: CURRENT_TODO"],
            );
            return Effect.succeed(native);
          },
          persist: (handoff) =>
            Effect.sync(() => {
              saved = handoff;
            }),
        });
        yield* delivery.delivered;
        assert.deepEqual(
          saved.delivery?.itemIds,
          rawItems.slice(2).map((item) => item.id),
        );
        assert.deepEqual(
          saved.delivery?.omittedItemIds,
          rawItems.slice(0, 2).map((item) => item.id),
        );
        assert.equal(saved.delivery?.status, native ? "injected" : "inline");
        if (!native) {
          assert.notInclude(delivery.context, "OLD_TODO");
          assert.notInclude(delivery.context, "OLD_PROPOSAL");
        }
      }
      assert.deepEqual(
        rawItems.map((item) => item.status),
        Array(4).fill("completed"),
      );
      const nativeText = resumeItems.map(
        (item) => historicalMessage(item, { includeCancelledPlans: true })?.text ?? "",
      );
      assert.equal(
        nativeText.reduce((bytes, text) => bytes + Buffer.byteLength(text), 0),
        75,
      );
      assert.deepEqual(
        (yield* store.getThreadRecords(threadId, ["turnItems"])).turnItems,
        rawItems,
      );
      assert.equal((yield* Stream.runCollect(eventStore.read({ threadId }))).length, events.length);
    }).pipe(Effect.provide(testLayer(storage))),
);
