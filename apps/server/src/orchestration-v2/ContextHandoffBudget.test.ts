import type { ProviderAdapterV2HistoricalContext } from "./ProviderAdapter.ts";
import { assert, describe, it } from "@effect/vitest";
import {
  ContextHandoffId,
  PROVIDER_SEND_TURN_MAX_ATTACHMENTS,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderThreadId,
  MessageId,
  PlanId,
  RunId,
  ThreadId,
  TurnItemId,
  OrchestrationV2ContextHandoff,
  type OrchestrationV2HistoricalMessage,
  type OrchestrationV2ProviderThread,
  type OrchestrationV2TurnItem,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import {
  contextUsageForHandoff,
  handoffBudget,
  historyCost,
  historyResponseItems,
  selectHistory,
  historicalMessage,
} from "./ContextHandoffBudget.ts";
import { projectContextHandoffForWire } from "./WireProjection.ts";
import { deliverContextHandoffs } from "./ContextHandoffDelivery.ts";
import { deliveredHandoffTextForEstimate } from "./ProviderTurnStartService.ts";

const encodeJson = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));
const decodeHandoff = Schema.decodeUnknownSync(OrchestrationV2ContextHandoff);

const now = DateTime.makeUnsafe("2026-09-17T00:00:00Z");
const threadId = ThreadId.make("thread:handoff");
const providerThread: OrchestrationV2ProviderThread = {
  id: ProviderThreadId.make("provider-thread:target"),
  driver: ProviderDriverKind.make("codex"),
  providerInstanceId: ProviderInstanceId.make("codex"),
  providerSessionId: null,
  appThreadId: threadId,
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
const message = (
  id: string,
  role: "user" | "assistant",
  text: string,
): OrchestrationV2HistoricalMessage => ({
  itemId: TurnItemId.make(id),
  role,
  text,
  threadId,
  runId: RunId.make("run:source"),
  providerThreadId: ProviderThreadId.make("provider-thread:source"),
  status: "interrupted",
  kind: role === "user" ? "user_message" : "assistant_message",
});
const messages = [
  message("item:one", "user", "Preserve every line.\n\n  And this indentation.\n"),
  message("item:two", "assistant", "Partial work: 日本語 🧪 مرحبا\n" + "x".repeat(600)),
];
const turnBase = {
  threadId,
  runId: RunId.make("run:source"),
  nodeId: null,
  providerThreadId: ProviderThreadId.make("provider-thread:source"),
  providerTurnId: null,
  nativeItemRef: null,
  parentItemId: null,
  status: "completed" as const,
  title: null,
  startedAt: now,
  completedAt: now,
  updatedAt: now,
};
function userTurn(id: string, text: string, ordinal: number): OrchestrationV2TurnItem {
  return {
    ...turnBase,
    id: TurnItemId.make(id),
    ordinal,
    messageId: MessageId.make(`message:${id}`),
    createdBy: "user",
    creationSource: "server",
    type: "user_message",
    inputIntent: "turn_start",
    text,
    attachments: [],
  };
}
function assistantTurn(id: string, text: string, ordinal: number): OrchestrationV2TurnItem {
  return {
    ...turnBase,
    id: TurnItemId.make(id),
    ordinal,
    messageId: MessageId.make(`message:${id}`),
    type: "assistant_message",
    text,
    streaming: false,
  };
}
function todoTurn(input: {
  readonly id: string;
  readonly planId: string;
  readonly ordinal: number;
  readonly steps: ReadonlyArray<{
    readonly text: string;
    readonly status: "pending" | "running" | "completed";
  }>;
  readonly explanation?: string;
}): Extract<OrchestrationV2TurnItem, { readonly type: "todo_list" }> {
  return {
    ...turnBase,
    id: TurnItemId.make(input.id),
    ordinal: input.ordinal,
    type: "todo_list",
    planId: PlanId.make(input.planId),
    steps: input.steps.map((step, index) => ({
      id: `step-${index}`,
      text: step.text,
      status: step.status,
    })),
    ...(input.explanation === undefined ? {} : { explanation: input.explanation }),
  };
}
function commandTurn(input: {
  readonly id: string;
  readonly ordinal: number;
  readonly command: string;
  readonly output: string;
  readonly exitCode: number;
}): Extract<OrchestrationV2TurnItem, { type: "command_execution" }> {
  return {
    ...turnBase,
    id: TurnItemId.make(input.id),
    ordinal: input.ordinal,
    type: "command_execution",
    input: input.command,
    output: input.output,
    exitCode: input.exitCode,
  };
}
function historyFrom(items: ReadonlyArray<OrchestrationV2TurnItem>) {
  return items.flatMap((item) => {
    const historical = historicalMessage(item);
    return historical === null ? [] : [historical];
  });
}
const handoff: OrchestrationV2ContextHandoff = {
  id: ContextHandoffId.make("handoff:one"),
  threadId,
  targetRunId: RunId.make("run:target"),
  fromProviderThreadIds: [],
  toProviderThreadId: providerThread.id,
  coveredRunOrdinals: { from: 1, to: 2 },
  strategy: "full_thread_summary",
  status: "ready",
  summaryMessageId: null,
  summaryText: "",
  history: {
    messages,
    coverage: "Historical context; retrieve thread:handoff with t3_thread_read.",
    omittedItems: 0,
  },
  createdByProviderInstanceId: null,
  createdAt: now,
  updatedAt: now,
};

describe("handoff budget", () => {
  it("keeps old preview handoffs readable and delivery history off the wire", () => {
    const projected = projectContextHandoffForWire({
      ...handoff,
      summaryText: "private transcript and command output",
      delivery: {
        nativeThreadId: "native:target",
        status: "injected",
        itemIds: [messages[0]!.itemId],
      },
    });
    assert.equal(projected.summaryText, "");
    assert.isUndefined(projected.history);
    assert.isUndefined(projected.delivery);
    assert.equal(decodeHandoff(projected).id, handoff.id);
    assert.deepEqual(handoff.history?.messages, messages);
  });
  it("carries command outcomes as attributed activity and excludes reasoning", () => {
    const base = {
      id: TurnItemId.make("item:command"),
      threadId,
      runId: RunId.make("run:source"),
      nodeId: null,
      providerThreadId: providerThread.id,
      providerTurnId: null,
      nativeItemRef: null,
      parentItemId: null,
      ordinal: 1,
      status: "failed" as const,
      title: null,
      startedAt: now,
      completedAt: now,
      updatedAt: now,
    };
    const command = historicalMessage({
      ...base,
      type: "command_execution",
      input: "vp test",
      output: "Failure near the end: " + "界".repeat(300),
      exitCode: 1,
    });
    assert.equal(command?.role, "assistant");
    assert.equal(command?.kind, "command_execution");
    assert.include(command!.text, "Exit code: 1");
    assert.include(command!.text, "界".repeat(300));
    assert.isNull(
      historicalMessage({
        ...base,
        type: "reasoning",
        text: "private reasoning",
        streaming: false,
      }),
    );
    assert.equal(historyResponseItems([command!], "Activity")[1]?.type, "message");
  });

  it("includes each todo step and its status for a user, todo list, and assistant", () => {
    const selected = selectHistory({
      messages: historyFrom([
        userTurn("item:user", "Continue the migration", 1),
        todoTurn({
          id: "item:todo",
          planId: "plan:migration",
          ordinal: 2,
          explanation: "Keep the live plan",
          steps: [
            { status: "completed", text: "Read the issue" },
            { status: "running", text: "Map the todo list" },
            { status: "pending", text: "Add the regression" },
          ],
        }),
        assistantTurn("item:assistant", "DONE", 3),
      ]),
      coverage: "History",
      budget: 16_000,
    });
    const text = selected.messages.map((entry) => entry.text).join("\n");
    assert.include(text, "completed: Read the issue");
    assert.include(text, "running: Map the todo list");
    assert.include(text, "pending: Add the regression");
    assert.include(text, "Explanation: Keep the live plan");
    assert.include(text, "DONE");
  });

  it("keeps the latest todo list when large recent items fill a tight budget", () => {
    const selected = selectHistory({
      messages: historyFrom([
        userTurn("item:early", "EARLY_DECISION store checkpoints as git refs", 1),
        {
          ...turnBase,
          id: TurnItemId.make("item:plan"),
          ordinal: 2,
          type: "proposed_plan",
          planId: PlanId.make("plan:proposal"),
          markdown: "PROPOSED_PLAN_KEEP",
          streaming: false,
        },
        todoTurn({
          id: "item:todo-live",
          planId: "plan:migration",
          ordinal: 3,
          steps: [{ status: "running", text: "LIVE_STEP keep this update" }],
        }),
        assistantTurn("item:filler-a", "b".repeat(3_000), 4),
        assistantTurn("item:filler-b", "c".repeat(3_000), 5),
        assistantTurn("item:latest-assistant", "DONE", 6),
        userTurn("item:latest-user", "LATEST_REQUEST continue", 7),
      ]),
      coverage: "History",
      budget: 8_000,
    });
    const text = selected.messages.map((entry) => entry.text).join("\n");
    assert.include(text, "running: LIVE_STEP keep this update");
    assert.include(text, "PROPOSED_PLAN_KEEP");
    assert.include(text, "EARLY_DECISION store checkpoints as git refs");
    assert.include(text, "LATEST_REQUEST continue");
  });

  it("replays only the latest todo state for a plan", () => {
    const selected = selectHistory({
      messages: historyFrom([
        userTurn("item:user", "Continue the migration", 1),
        todoTurn({
          id: "item:todo-old",
          planId: "plan:migration",
          ordinal: 2,
          steps: [{ status: "pending", text: "STALE_STEP drop this update" }],
        }),
        todoTurn({
          id: "item:todo-live",
          planId: "plan:migration",
          ordinal: 3,
          steps: [{ status: "running", text: "LIVE_STEP keep this update" }],
        }),
        assistantTurn("item:assistant", "DONE", 4),
      ]),
      coverage: "History",
      budget: 16_000,
    });
    const text = selected.messages.map((entry) => entry.text).join("\n");
    assert.include(text, "running: LIVE_STEP keep this update");
    assert.notInclude(text, "STALE_STEP drop this update");
    assert.include(selected.omittedItemIds, TurnItemId.make("item:todo-old"));
    assert.equal(selected.omittedItems, 1);
  });

  it("omits a removed todo plan while keeping a completed live plan", () => {
    const selected = selectHistory({
      messages: historyFrom([
        {
          ...todoTurn({
            id: "item:todo-removed",
            planId: "plan:removed",
            ordinal: 1,
            steps: [{ status: "pending", text: "OBSOLETE_STEP" }],
          }),
          status: "cancelled",
        },
        todoTurn({
          id: "item:todo-live",
          planId: "plan:live",
          ordinal: 2,
          steps: [{ status: "completed", text: "LIVE_STEP" }],
        }),
      ]),
      coverage: "History",
      budget: 16_000,
    });
    const text = selected.messages.map((entry) => entry.text).join("\n");
    assert.notInclude(text, "OBSOLETE_STEP");
    assert.include(text, "completed: LIVE_STEP");
    assert.deepEqual(
      selected.messages.map((entry) => entry.itemId),
      [TurnItemId.make("item:todo-live")],
    );
  });

  it.each(["todo_list", "proposed_plan"] as const)(
    "counts retired %s text only for native occupancy",
    (kind) => {
      const plan = {
        ...todoTurn({
          id: "item:retired-native",
          planId: "plan:retired-native",
          ordinal: 1,
          steps: [{ status: "pending", text: "RETIRED_NATIVE_TEXT" }],
        }),
        status: "cancelled" as const,
      };
      const item =
        kind === "todo_list"
          ? plan
          : {
              ...plan,
              type: "proposed_plan" as const,
              markdown: "RETIRED_NATIVE_TEXT",
              streaming: false,
            };
      assert.isNull(historicalMessage(item));
      const native = historicalMessage(item, { includeCancelledPlans: true });
      assert.equal(
        native?.text,
        kind === "todo_list" ? "pending: RETIRED_NATIVE_TEXT" : "RETIRED_NATIVE_TEXT",
      );
      assert.equal(Buffer.byteLength(native!.text), kind === "todo_list" ? 28 : 19);
    },
  );

  it("keeps the newest distinct plan when older plans fill a tight budget", () => {
    const selected = selectHistory({
      messages: historyFrom([
        userTurn("item:early", "EARLY", 1),
        todoTurn({
          id: "item:todo-old-plan",
          planId: "plan:old",
          ordinal: 2,
          steps: [{ status: "completed", text: `OLD_PLAN ${"x".repeat(2_500)}` }],
        }),
        todoTurn({
          id: "item:todo-new-plan",
          planId: "plan:new",
          ordinal: 3,
          steps: [{ status: "running", text: `NEW_PLAN ${"y".repeat(2_500)}` }],
        }),
        userTurn("item:latest", "LATEST", 4),
      ]),
      coverage: "History",
      budget: 4_500,
    });
    const text = selected.messages.map((entry) => entry.text).join("\n");
    assert.include(text, "NEW_PLAN");
    assert.notInclude(text, "OLD_PLAN");
    assert.include(text, "LATEST");
  });

  it("coalesces durable plan updates that still carry planId", () => {
    const first = selectHistory({
      messages: historyFrom([
        userTurn("item:user", "Continue", 1),
        todoTurn({
          id: "item:todo-old",
          planId: "plan:migration",
          ordinal: 2,
          steps: [{ status: "pending", text: "STALE_STEP" }],
        }),
      ]),
      coverage: "History",
      budget: 16_000,
    });
    const second = selectHistory({
      messages: historyFrom([
        todoTurn({
          id: "item:todo-live",
          planId: "plan:migration",
          ordinal: 3,
          steps: [{ status: "running", text: "LIVE_STEP" }],
        }),
        assistantTurn("item:assistant", "DONE", 4),
      ]),
      coverage: "History",
      budget: 16_000,
    });
    const selected = selectHistory({
      messages: [...first.messages, ...second.messages],
      coverage: "Combined",
      budget: 16_000,
    });
    const text = selected.messages.map((entry) => entry.text).join("\n");
    assert.include(text, "LIVE_STEP");
    assert.notInclude(text, "STALE_STEP");
    assert.ok(first.messages.some((entry) => entry.planId === PlanId.make("plan:migration")));
  });

  it("keeps an early user decision and a shortened command when output is 60k", () => {
    const lines = Array.from({ length: 2_000 }, (_, index) => `row ${index} ${"x".repeat(24)}`);
    const output = lines.join("\n");
    assert.isAtLeast(output.length, 60_000);
    const selected = selectHistory({
      messages: historyFrom([
        userTurn("item:early", "EARLY_DECISION store checkpoints as git refs", 1),
        assistantTurn("item:assistant", "ASSISTANT_REPLY keep the summary", 2),
        commandTurn({
          id: "item:bulky-command",
          ordinal: 3,
          command: "vp test",
          output,
          exitCode: 2,
        }),
        userTurn("item:latest", "LATEST_REQUEST continue", 4),
      ]),
      coverage: "History",
      budget: 16_000,
    });
    const command = selected.messages.find((entry) => entry.kind === "command_execution");
    const text = selected.messages.map((entry) => entry.text).join("\n");
    assert.equal(command?.kind, "command_execution");
    assert.include(command?.text, "Command: vp test");
    assert.include(command?.text, "Exit code: 2");
    assert.include(command?.text, "item:bulky-command");
    assert.include(command?.text, "row 0 ");
    assert.include(command?.text, "row 1999 ");
    assert.notInclude(command?.text, "row 1000 ");
    assert.include(text, "EARLY_DECISION store checkpoints as git refs");
    assert.include(text, "ASSISTANT_REPLY keep the summary");
    assert.include(text, "LATEST_REQUEST continue");
  });

  it("shortens a long single-line command so the stub stays selectable", () => {
    const output = "x".repeat(60_000);
    const selected = selectHistory({
      messages: historyFrom([
        userTurn("item:early", "EARLY_DECISION store checkpoints as git refs", 1),
        assistantTurn("item:assistant", "ASSISTANT_REPLY keep the summary", 2),
        commandTurn({
          id: "item:one-line-command",
          ordinal: 3,
          command: "cat blob.json",
          output,
          exitCode: 0,
        }),
        userTurn("item:latest", "LATEST_REQUEST continue", 4),
      ]),
      coverage: "History",
      budget: 16_000,
    });
    const command = selected.messages.find((entry) => entry.kind === "command_execution");
    const text = selected.messages.map((entry) => entry.text).join("\n");
    assert.equal(command?.kind, "command_execution");
    assert.include(command?.text, "Command: cat blob.json");
    assert.include(command?.text, "Exit code: 0");
    assert.include(command?.text, "item:one-line-command");
    assert.isBelow(Buffer.byteLength(command!.text), 12_000);
    assert.include(text, "EARLY_DECISION store checkpoints as git refs");
    assert.include(text, "ASSISTANT_REPLY keep the summary");
  });

  it("counts full command output for native-context estimates", () => {
    const item = commandTurn({
      id: "item:native-command",
      ordinal: 1,
      command: "cat blob.json",
      output: "y".repeat(40_000),
      exitCode: 0,
    });
    const handoff = historicalMessage(item);
    const native = historicalMessage(item, { truncateCommandOutput: false });
    assert.isBelow(Buffer.byteLength(handoff!.text), 12_000);
    assert.isAtLeast(Buffer.byteLength(native!.text), 40_000);
    assert.include(native!.text, "y".repeat(40_000));
  });

  it("keeps exactly forty printed lines when output ends with a newline", () => {
    const lines = Array.from({ length: 40 }, (_, index) => `line-${index}`);
    const output = `${lines.join("\n")}\n`;
    const message = historicalMessage(
      commandTurn({
        id: "item:forty-lines",
        ordinal: 1,
        command: "printf lines",
        output,
        exitCode: 0,
      }),
    );
    assert.ok(message);
    assert.include(message.text, "line-0");
    assert.include(message.text, "line-20");
    assert.include(message.text, "line-39");
    assert.notInclude(message.text, "output truncated");
    assert.include(message.text, output);
  });

  it("keeps a JSON-heavy command stub selectable under the default budget", () => {
    const output = "\0".repeat(8_192);
    const selected = selectHistory({
      messages: historyFrom([
        userTurn("item:early", "EARLY_DECISION store checkpoints as git refs", 1),
        assistantTurn("item:assistant", "ASSISTANT_REPLY keep the summary", 2),
        commandTurn({
          id: "item:nul-command",
          ordinal: 3,
          command: "cat binary.blob",
          output,
          exitCode: 0,
        }),
        userTurn("item:latest", "LATEST_REQUEST continue", 4),
      ]),
      coverage: "History",
      budget: 16_000,
    });
    const command = selected.messages.find((entry) => entry.kind === "command_execution");
    assert.equal(command?.kind, "command_execution");
    assert.include(command?.text, "Command: cat binary.blob");
    assert.include(command?.text, "Exit code: 0");
    assert.include(command?.text, "item:nul-command");
    assert.isAtMost(Buffer.byteLength(JSON.stringify(command!.text)), 12_000);
    assert.ok(selected.messages.some((entry) => entry.text.includes("ASSISTANT_REPLY")));
  });

  it("keeps the assistant reply when a fitting command log would take the budget", () => {
    const selected = selectHistory({
      messages: historyFrom([
        userTurn("item:early", "EARLY_DECISION store checkpoints as git refs", 1),
        assistantTurn("item:assistant", `ASSISTANT_REPLY ${"s".repeat(5_000)}`, 2),
        commandTurn({
          id: "item:wide-command",
          ordinal: 3,
          command: "cat build.log",
          output: "w".repeat(12_000),
          exitCode: 3,
        }),
        userTurn("item:latest", "LATEST_REQUEST continue", 4),
      ]),
      coverage: "History",
      budget: 16_000,
    });
    const text = selected.messages.map((entry) => entry.text).join("\n");
    assert.include(text, "ASSISTANT_REPLY");
    assert.include(text, "EARLY_DECISION store checkpoints as git refs");
  });

  it.each(["x", "\0", "界", "🧪", '"', "\\"])(
    "bounds the complete command record with a 60k %s input",
    (character) => {
      const item = commandTurn({
        id: "item:long-input",
        ordinal: 2,
        command: `INPUT_HEAD ${character.repeat(60_000)} INPUT_TAIL`,
        output: `OUTPUT_HEAD ${character.repeat(60_000)} OUTPUT_TAIL`,
        exitCode: 7,
      });
      const selected = selectHistory({
        messages: historyFrom([userTurn("item:request", "Keep the command outcome.", 1), item]),
        coverage: "History",
        budget: 16_000,
      });
      const command = selected.messages.find((entry) => entry.itemId === item.id);
      assert.equal(command?.kind, "command_execution");
      assert.include(command!.text, "INPUT_HEAD");
      assert.include(command!.text, "INPUT_TAIL");
      assert.include(command!.text, "Exit code: 7");
      assert.include(command!.text, "OUTPUT_HEAD");
      assert.include(command!.text, "OUTPUT_TAIL");
      assert.include(command!.text, "item:long-input");
      assert.isAtMost(Buffer.byteLength(JSON.stringify(command!.text)), 8_192);
      assert.notInclude(command!.text, "\ufffd");
      assert.include(historicalMessage(item, { truncateCommandOutput: false })!.text, item.input);
    },
  );

  it("keeps a recent short command ahead of older activity under a tight budget", () => {
    const command = historicalMessage(
      commandTurn({
        id: "item:short-result",
        ordinal: 3,
        command: "vp test",
        output: `RECENT_RESULT ${"r".repeat(800)}`,
        exitCode: 1,
      }),
    )!;
    const selected = selectHistory({
      messages: [
        message("item:request", "user", "Continue."),
        {
          ...message("item:older-activity", "assistant", `OLDER_ACTIVITY ${"a".repeat(1_700)}`),
          kind: "file_change",
        },
        command,
        message("item:reply", "assistant", "Current answer."),
      ],
      coverage: "History",
      budget: 4_000,
    });
    assert.include(
      selected.messages.map((entry) => entry.itemId),
      command.itemId,
    );
    assert.notInclude(
      selected.messages.map((entry) => entry.itemId),
      TurnItemId.make("item:older-activity"),
    );
    assert.include(
      selected.messages.find((entry) => entry.itemId === command.itemId)!.text,
      "Exit code: 1",
    );
  });

  it("uses only the text from the handoff that actually delivered an overlapping item", () => {
    const full = message(
      "item:old-delivery",
      "assistant",
      `FULL_COMMAND_OUTPUT ${"x".repeat(60_000)}`,
    );
    const oldHandoff: OrchestrationV2ContextHandoff = {
      ...handoff,
      history: { ...handoff.history!, messages: [full] },
      delivery: { nativeThreadId: "native:target", status: "injected", itemIds: [full.itemId] },
    };
    const laterHandoff: OrchestrationV2ContextHandoff = {
      ...oldHandoff,
      id: ContextHandoffId.make("handoff:overlap"),
      history: { ...handoff.history!, messages: [{ ...full, text: "SHORT_COPY_NEVER_DELIVERED" }] },
      delivery: { nativeThreadId: "native:target", status: "inline", itemIds: [] },
    };
    assert.equal(
      deliveredHandoffTextForEstimate([oldHandoff, laterHandoff]).get(full.itemId),
      full.text,
    );
    assert.equal(deliveredHandoffTextForEstimate([laterHandoff]).size, 0);
    assert.equal(
      deliveredHandoffTextForEstimate([
        oldHandoff,
        { ...laterHandoff, delivery: { ...laterHandoff.delivery!, itemIds: [full.itemId] } },
      ]).get(full.itemId),
      full.text,
    );
    assert.equal(
      deliveredHandoffTextForEstimate([
        { ...laterHandoff, delivery: { ...laterHandoff.delivery!, itemIds: [full.itemId] } },
        oldHandoff,
      ]).get(full.itemId),
      full.text,
    );
  });

  it.effect.each([true, false])(
    "records the actual source of differing copies, injected=%s",
    (injected) =>
      Effect.gen(function* () {
        const full = message(
          "item:shared-command",
          "assistant",
          `FULL_OUTPUT ${"x".repeat(60_000)}`,
        );
        const first = { ...handoff, history: { ...handoff.history!, messages: [full] } };
        const second = {
          ...first,
          id: ContextHandoffId.make("handoff:duplicate-copy"),
          history: {
            ...first.history,
            messages: [{ ...full, text: "SHORT_COPY_NEVER_DELIVERED" }],
          },
        };
        const stored = new Map<ContextHandoffId, OrchestrationV2ContextHandoff>();
        let delivered: ReadonlyArray<OrchestrationV2HistoricalMessage> = [];
        const result = yield* deliverContextHandoffs({
          handoffs: [first, second],
          providerThread,
          budget: 64_000,
          alreadyDeliveredItemIds: new Set(),
          inject: (value) =>
            Effect.sync(() => {
              delivered = value.messages;
              return injected;
            }),
          persist: (value) =>
            Effect.sync(() => {
              stored.set(value.id, value);
            }),
        });
        yield* result.delivered;
        if (!injected) assert.include(result.context, full.text);
        assert.deepEqual(
          delivered.map((entry) => entry.text),
          [full.text],
        );
        assert.deepEqual(stored.get(first.id)!.delivery!.itemIds, [full.itemId]);
        assert.deepEqual(stored.get(second.id)!.delivery!.itemIds, []);
        assert.equal(
          deliveredHandoffTextForEstimate([...stored.values()]).get(full.itemId),
          full.text,
        );
      }),
  );

  it.each(["head", "tail"])(
    "keeps the other edge's line limit when the %s line is huge",
    (edge) => {
      const short = Array.from({ length: 20 }, (_, index) => `EDGE_${index}`).join("\n");
      const long = `LONG_EDGE ${"x".repeat(60_000)} END_EDGE`;
      const output =
        edge === "tail"
          ? `${short}\n${"MIDDLE\n".repeat(1_000)}${long}`
          : `${long}\n${"MIDDLE\n".repeat(1_000)}${short}`;
      const item = commandTurn({
        id: `item:mixed-${edge}`,
        ordinal: 1,
        command: "vp test",
        output,
        exitCode: 0,
      });
      const text = historicalMessage(item)!.text;
      assert.include(text, "EDGE_0");
      assert.include(text, "EDGE_19");
      assert.notInclude(text, "MIDDLE");
      assert.isAtMost(Buffer.byteLength(JSON.stringify(text)), 8_192);
    },
  );

  it("preserves head and tail lines without replaying the middle of a newline-heavy output", () => {
    const head = Array.from({ length: 20 }, (_, index) => `HEAD_${index}`).join("\n");
    const tail = Array.from({ length: 20 }, (_, index) => `TAIL_${index}`).join("\n");
    const item = commandTurn({
      id: "item:many-lines",
      ordinal: 1,
      command: "vp test",
      output: `${head}\n${"MIDDLE\n".repeat(100_000)}${tail}\n`,
      exitCode: 0,
    });
    const text = historicalMessage(item)!.text;
    assert.include(text, head);
    assert.include(text, tail);
    assert.include(text, "output truncated");
    assert.notInclude(text, "MIDDLE");
  });

  it("retains short conversations verbatim in role and order", () => {
    const selected = selectHistory({ messages, coverage: "History", budget: 16_000 });
    assert.deepEqual(selected.messages, messages);
    const items = historyResponseItems(selected.messages, selected.context);
    assert.deepEqual(
      items.map((item) => item.role),
      ["user", "user", "assistant"],
    );
    assert.include(items[1]!.content[0]!.text, messages[0]!.text);
    assert.include(items[2]!.content[0]!.text, messages[1]!.text);
    assert.equal(selected.omittedItems, 0);
  });

  it("omits oversized multilingual items whole, preserves original constraints and recent work", () => {
    const candidates = [
      messages[0]!,
      message("huge", "assistant", "界🧪".repeat(20_000)),
      message("old", "assistant", "a".repeat(4_000)),
      messages[1]!,
    ];
    const selected = selectHistory({
      messages: candidates,
      coverage: "thread:handoff runs 1-4",
      budget: 3_000,
    });
    assert.deepEqual(selected.messages, messages);
    assert.equal(selected.omittedItems, 2);
    assert.isAtMost(historyCost(selected.messages, selected.context), 3_000);
  });

  it("counts JSON escaping and UTF-8 bytes across many messages", () => {
    const candidates = Array.from({ length: 500 }, (_, i) =>
      message(`item:${i}`, i % 2 ? "assistant" : "user", '\u0000\\"🧪界'.repeat(15)),
    );
    for (const budget of [1_024, 4_000, 16_000]) {
      const selected = selectHistory({
        messages: candidates,
        coverage: "Retrieve omitted history",
        budget,
      });
      assert.isAtMost(historyCost(selected.messages, selected.context), budget);
      assert.isAbove(selected.omittedItems, 0);
    }
  });

  it("fits the final envelope at intermediate selected/omitted digit boundaries", () => {
    const candidates = Array.from({ length: 20 }, (_, index) =>
      message(`boundary:${index}`, "user", "Short request"),
    );
    for (let budget = 4_000; budget <= 9_000; budget++) {
      const selected = selectHistory({
        messages: candidates,
        coverage: "Recover history",
        omittedItems: 90,
        budget,
      });
      assert.isAtMost(historyCost(selected.messages, selected.context), budget);
    }
  });

  it("subtracts native usage, input, attachments, instructions and space for work", () => {
    const base = {
      tokenCap: 16_000,
      userText: "Continue",
      attachments: [],
      providerThread,
      nativeContextEstimate: 0,
      modelContextWindow: 32_000,
    };
    assert.isBelow(handoffBudget(base), 16_000);
    assert.isBelow(handoffBudget({ ...base, nativeContextEstimate: 8_000 }), handoffBudget(base));
    assert.equal(handoffBudget({ ...base, userText: "界".repeat(30_000) }), 0);
    assert.equal(
      handoffBudget({
        ...base,
        providerThread: {
          ...providerThread,
          contextUsage: { usedTokens: 23_000, maxTokens: 24_000 },
        },
      }),
      0,
    );
    for (const sizeBytes of [100_000, 10 * 1024 * 1024]) {
      const attachments = [
        {
          type: "image",
          id: "attachment",
          name: "image.png",
          mimeType: "image/png",
          sizeBytes,
        },
      ];
      const withImage = handoffBudget({ ...base, attachments });
      assert.isAbove(withImage, 4_000);
      assert.isBelow(withImage, handoffBudget(base));
      assert.equal(handoffBudget({ ...base, attachments: [...attachments, ...attachments] }), 0);
      assert.equal(
        handoffBudget({
          ...base,
          tokenCap: 64_000,
          modelContextWindow: 1_000_000,
          // The history byte cap is independent of both current text and image payloads.
          userText: "x".repeat(70_000),
          attachments,
          providerThread: {
            ...providerThread,
            contextUsage: { usedTokens: 0, maxTokens: 1_000_000 },
          },
        }),
        64_000,
      );
    }
    assert.equal(handoffBudget({ ...base, tokenCap: 2_000 }), 2_000);
  });

  it("keeps measured occupancy across a model change", () => {
    const previous = {
      usedTokens: 37_321,
      maxTokens: 258_400,
      autoCompactThreshold: 32_000,
    };
    assert.isNull(
      contextUsageForHandoff({
        sameNativeThread: false,
        sameSelection: false,
        reuseTelemetry: false,
        previousUsage: previous,
      }),
    );
    assert.equal(
      contextUsageForHandoff({
        sameNativeThread: true,
        sameSelection: true,
        reuseTelemetry: true,
        previousUsage: previous,
      }),
      previous,
    );
    assert.deepEqual(
      contextUsageForHandoff({
        sameNativeThread: true,
        sameSelection: false,
        reuseTelemetry: true,
        previousUsage: previous,
      }),
      { usedTokens: 37_321, maxTokens: 258_400 },
    );
    assert.deepEqual(
      contextUsageForHandoff({
        sameNativeThread: true,
        sameSelection: false,
        reuseTelemetry: false,
        previousUsage: previous,
      }),
      { usedTokens: 37_321, maxTokens: 258_400 },
    );
    assert.deepEqual(
      contextUsageForHandoff({
        sameNativeThread: true,
        sameSelection: false,
        reuseTelemetry: false,
        previousUsage: { usedTokens: 30_000, maxTokens: 32_000, autoCompactThreshold: 31_000 },
        knownModelWindow: 1_000_000,
      }),
      { usedTokens: 30_000, maxTokens: 1_000_000 },
    );

    const preserved = contextUsageForHandoff({
      sameNativeThread: true,
      sameSelection: false,
      reuseTelemetry: false,
      previousUsage: previous,
    });
    assert.equal(
      handoffBudget({
        tokenCap: 16_000,
        userText: "Continue work",
        attachments: [
          {
            type: "image",
            id: "screenshot-a",
            name: "a.png",
            mimeType: "image/png",
            sizeBytes: 100_000,
          },
          {
            type: "image",
            id: "screenshot-b",
            name: "b.png",
            mimeType: "image/png",
            sizeBytes: 100_000,
          },
        ],
        providerThread: { ...providerThread, contextUsage: preserved },
        nativeContextEstimate: 0,
        modelContextWindow: preserved?.maxTokens,
      }),
      16_000,
    );
    assert.equal(
      handoffBudget({
        tokenCap: 16_000,
        userText: "Continue work",
        attachments: [],
        providerThread,
        nativeContextEstimate: 120_000,
      }),
      0,
    );
  });
  it("reserves context for image batches up to the attachment limit, honoring smaller known windows", () => {
    let previousBudget = 16_000;
    for (let count = 1; count <= PROVIDER_SEND_TURN_MAX_ATTACHMENTS; count++) {
      const input = {
        tokenCap: 16_000,
        userText: "Compare these screenshots",
        providerThread,
        nativeContextEstimate: 0,
        attachments: Array.from({ length: count }, (_, index) => ({
          type: "image",
          id: `image-${index}`,
          name: "image.png",
          mimeType: "image/png",
          sizeBytes: 100_000,
        })),
      };
      const budget = handoffBudget(input);
      assert.isAtLeast(budget, 0);
      assert.isAtMost(budget, previousBudget);
      previousBudget = budget;
      if (count <= 8) assert.equal(budget, 16_000);
      if (count === 10) {
        assert.isAbove(budget, 0);
        assert.isBelow(budget, 16_000);
      }
      if (count === PROVIDER_SEND_TURN_MAX_ATTACHMENTS) assert.equal(budget, 0);
      if (budget > 0) {
        const selected = selectHistory({ messages, coverage: "Recover omitted history", budget });
        assert.isAtMost(historyCost(selected.messages, selected.context), budget);
      }
      assert.equal(handoffBudget({ ...input, modelContextWindow: 2_000_000 }), 16_000);
      assert.equal(handoffBudget({ ...input, modelContextWindow: 20_000 }), 0);
      assert.equal(
        handoffBudget({
          ...input,
          providerThread: { ...providerThread, contextUsage: { usedTokens: 0, maxTokens: 20_000 } },
        }),
        0,
      );
      assert.equal(
        handoffBudget({
          ...input,
          modelContextWindow: 1_000_000,
          providerThread: {
            ...providerThread,
            contextUsage: { usedTokens: 0, maxTokens: 1_000_000, autoCompactThreshold: 20_000 },
          },
        }),
        0,
      );
    }
  });
});

describe("handoff delivery", () => {
  it.effect.each([
    { native: true, label: "injected" },
    { native: false, label: "inline" },
  ])("records omitted recovery coverage separately from $label text", ({ native }) =>
    Effect.gen(function* () {
      const omittedBeforeDelivery = TurnItemId.make("item:omitted-during-preparation");
      const oversized = message("item:oversized", "user", "x".repeat(20_000));
      let durable: OrchestrationV2ContextHandoff = {
        ...handoff,
        history: {
          ...handoff.history!,
          messages: [...messages, oversized],
          omittedItems: 1,
          omittedItemIds: [omittedBeforeDelivery],
        },
      };
      const result = yield* deliverContextHandoffs({
        handoffs: [durable],
        providerThread,
        budget: 16_000,
        alreadyDeliveredItemIds: new Set(),
        inject: (value) => {
          assert.include(value.context, "omitted 2 items");
          assert.notInclude(
            value.messages.map((item) => item.itemId),
            oversized.itemId,
          );
          return Effect.succeed(native);
        },
        persist: (value) =>
          Effect.sync(() => {
            durable = value;
          }),
      });
      assert.equal(durable.delivery?.status, native ? "injected" : "pending");
      yield* result.delivered;
      assert.equal(durable.delivery?.status, native ? "injected" : "inline");
      assert.deepEqual(
        durable.delivery?.itemIds,
        messages.map((item) => item.itemId),
      );
      assert.deepEqual(durable.delivery?.omittedItemIds, [omittedBeforeDelivery, oversized.itemId]);
      assert.deepEqual(decodeHandoff(durable).delivery, durable.delivery);
    }),
  );
  it.effect("loads the history budget only when a handoff needs delivery", () =>
    Effect.gen(function* () {
      let reads = 0;
      const input = {
        providerThread,
        budget: Effect.sync(() => {
          reads++;
          return 16_000;
        }),
        alreadyDeliveredItemIds: new Set<string>(),
        persist: () => Effect.void,
      };
      yield* deliverContextHandoffs({ ...input, handoffs: [] });
      yield* deliverContextHandoffs({ ...input, handoffs: [handoff], deferInline: true });
      yield* deliverContextHandoffs({
        ...input,
        handoffs: [
          {
            ...handoff,
            delivery: {
              nativeThreadId: providerThread.nativeThreadRef!.nativeId!,
              status: "injected",
              itemIds: [],
            },
          },
        ],
      });
      assert.equal(reads, 0);
      const result = yield* deliverContextHandoffs({ ...input, handoffs: [handoff] });
      assert.equal(reads, 1);
      assert.include(result.context, messages[0]!.text);
    }),
  );

  it.effect("persists successful injection before turn start and skips it on retry", () =>
    Effect.gen(function* () {
      let durable = handoff;
      const history: unknown[] = [];
      const statuses: string[] = [];
      const input = {
        providerThread,
        budget: 16_000,
        alreadyDeliveredItemIds: new Set<string>(),
        inject: (value: ProviderAdapterV2HistoricalContext) =>
          Effect.sync(() => {
            history.push(...historyResponseItems(value.messages, value.context));
            return true;
          }),
        persist: (value: OrchestrationV2ContextHandoff) =>
          Effect.sync(() => {
            durable = value;
            statuses.push(value.delivery!.status);
          }),
      };
      const first = yield* deliverContextHandoffs({ ...input, handoffs: [durable] });
      assert.equal(first.context, "");
      assert.deepEqual(statuses, ["pending", "injected"]);
      assert.lengthOf(history, 3);
      // No turn has started. Reconstruct from the durable projection as a retry would.
      const second = yield* deliverContextHandoffs({ ...input, handoffs: [durable] });
      assert.equal(second.context, "");
      assert.lengthOf(history, 3);
    }),
  );

  it.effect(
    "uses the same selection on explicit native fallback, marking only accepted input",
    () =>
      Effect.gen(function* () {
        let durable = handoff;
        const result = yield* deliverContextHandoffs({
          handoffs: [handoff],
          providerThread,
          budget: 16_000,
          alreadyDeliveredItemIds: new Set(),
          inject: () => Effect.succeed(false),
          persist: (value) =>
            Effect.sync(() => {
              durable = value;
            }),
        });
        assert.include(result.context, messages[0]!.text);
        assert.include(result.context, messages[1]!.text);
        assert.equal(durable.delivery?.status, "pending");
        yield* result.delivered;
        assert.equal(durable.delivery?.status, "inline");
      }),
  );

  it.effect(
    "defers unsupported compaction history until a normal turn without marking delivery uncertain",
    () =>
      Effect.gen(function* () {
        let durable = handoff;
        const persist = (value: OrchestrationV2ContextHandoff) =>
          Effect.sync(() => {
            durable = value;
          });
        const compact = yield* deliverContextHandoffs({
          handoffs: [durable],
          providerThread,
          budget: 16_000,
          alreadyDeliveredItemIds: new Set(),
          deferInline: true,
          inject: () => Effect.succeed(false),
          persist,
        });
        yield* compact.delivered;
        assert.equal(compact.context, "");
        assert.isUndefined((() => durable.delivery)());
        const next = yield* deliverContextHandoffs({
          handoffs: [durable],
          providerThread,
          budget: 16_000,
          alreadyDeliveredItemIds: new Set(),
          inject: () => Effect.succeed(false),
          persist,
        });
        assert.include(next.context, messages[0]!.text);
        yield* next.delivered;
        assert.equal(durable.delivery?.status, "inline");
      }),
  );

  it.effect("bounds accumulated recovery markers while keeping omitted history discoverable", () =>
    Effect.gen(function* () {
      const many = Array.from({ length: 100 }, (_, index) => ({
        ...handoff,
        id: ContextHandoffId.make(`handoff:retry:${index}`),
      }));
      let captured: ProviderAdapterV2HistoricalContext | undefined;
      const result = yield* deliverContextHandoffs({
        handoffs: many,
        providerThread,
        budget: 2_500,
        alreadyDeliveredItemIds: new Set(),
        inject: (history) =>
          Effect.sync(() => {
            captured = history;
            return true;
          }),
        persist: () => Effect.void,
      });
      assert.equal(result.context, "");
      assert.isDefined(captured);
      assert.include(captured.context, "detailed coverage references omitted");
      assert.include(captured.context, "t3_thread_read");
      assert.include(captured.context, threadId);
      assert.isAtMost(historyCost(captured.messages, captured.context), 2_500);
      assert.isAbove(captured.messages.length, 0);
    }),
  );

  it.effect("does not redeliver after ambiguous injection failure", () =>
    Effect.gen(function* () {
      let durable = handoff;
      let calls = 0;
      const input = {
        providerThread,
        budget: 16_000,
        alreadyDeliveredItemIds: new Set<string>(),
        inject: () =>
          Effect.sync(() => {
            calls++;
          }).pipe(Effect.andThen(Effect.fail("connection lost"))),
        persist: (value: OrchestrationV2ContextHandoff) =>
          Effect.sync(() => {
            durable = value;
          }),
      };
      yield* deliverContextHandoffs({ ...input, handoffs: [durable] }).pipe(Effect.result);
      assert.equal(durable.delivery?.status, "pending");
      const retry = yield* deliverContextHandoffs({ ...input, handoffs: [durable] }).pipe(
        Effect.result,
      );
      assert.equal(retry._tag, "Failure");
      assert.equal(calls, 1);
    }),
  );

  it.effect("budgets multiple handoffs together and skips previously delivered items", () =>
    Effect.gen(function* () {
      const extra = {
        ...handoff,
        id: ContextHandoffId.make("handoff:two"),
        history: {
          ...handoff.history!,
          messages: [...messages, message("item:three", "assistant", "Latest result")],
        },
      };
      let delivered: ReadonlyArray<unknown> = [];
      yield* deliverContextHandoffs({
        handoffs: [handoff, extra],
        providerThread,
        budget: 2_500,
        alreadyDeliveredItemIds: new Set(["item:one"]),
        inject: (value) =>
          Effect.sync(() => {
            delivered = historyResponseItems(value.messages, value.context);
            return true;
          }),
        persist: () => Effect.void,
      });
      const serialized = yield* encodeJson(delivered);
      assert.isAtMost(Buffer.byteLength(serialized), 2_500);
      assert.notInclude(serialized, "Preserve every line");
      assert.equal(serialized.split("Partial work").length - 1, 1);
      assert.include(serialized, "Latest result");
    }),
  );

  it.effect("fails before delivery when even the coverage marker cannot fit", () =>
    Effect.gen(function* () {
      let calls = 0;
      const result = yield* deliverContextHandoffs({
        handoffs: [handoff],
        providerThread,
        budget: 0,
        alreadyDeliveredItemIds: new Set(),
        inject: () =>
          Effect.sync(() => {
            calls++;
            return true;
          }),
        persist: () => Effect.void,
      }).pipe(Effect.result);
      assert.equal(result._tag, "Failure");
      assert.equal(calls, 0);
    }),
  );
});
