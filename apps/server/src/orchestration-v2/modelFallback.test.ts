import { assert, describe, it } from "@effect/vitest";
import {
  CommandId,
  MessageId,
  ProviderInstanceId,
  RunId,
  ThreadId,
  type ModelSelection,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import {
  MODEL_FALLBACK_NOTE_PREFIX,
  decideFromProjection,
  modelFallbackCommand,
  nextModelFallbackCommand,
  planModelFallback,
  presentedDelegatedStatus,
  type FallbackRunEvidence,
  type ModelFallbackSignal,
} from "./modelFallback.ts";

const claude = ProviderInstanceId.make("claude");
const codex = ProviderInstanceId.make("codex");
const opus: ModelSelection = { instanceId: claude, model: "claude-opus-5.5" };
const opusNext: ModelSelection = { instanceId: claude, model: "claude-opus-5" };
const sonnet: ModelSelection = { instanceId: claude, model: "claude-sonnet-5" };
const gpt: ModelSelection = { instanceId: codex, model: "gpt-6-astra" };

const weekly: ModelFallbackSignal = {
  class: "usage_limit",
  message: "You've hit your weekly limit",
  resetAt: "2026-10-20T00:00:00.000Z",
};

function plan(
  patch: Partial<Parameters<typeof planModelFallback>[0]> & {
    readonly signal?: ModelFallbackSignal | null;
  } = {},
) {
  return planModelFallback({
    enabled: true,
    models: [sonnet, gpt],
    current: opus,
    tried: [opus],
    continuation: "supported",
    unavailableInstanceIds: [],
    signal: weekly,
    ...patch,
  });
}

describe("planModelFallback", () => {
  it("keeps today's pause when fallback is disabled", () => {
    assert.deepEqual(plan({ enabled: false }).type, "leave-paused");
  });

  it("selects the next configured model on an explicit quota signal", () => {
    const decision = plan({
      signal: {
        class: "usage_limit",
        message: "You've hit your weekly limit",
        code: "seven_day_opus",
        resetAt: "2026-10-20T00:00:00.000Z",
      },
    });
    assert.equal(decision.type, "switch");
    if (decision.type !== "switch") return;
    assert.deepEqual(decision.to, sonnet);
    assert.equal(decision.window, "weekly");
    assert.equal(decision.resetAt, "2026-10-20T00:00:00.000Z");
    assert.include(decision.detail, opus.model);
    assert.include(decision.detail, sonnet.model);
  });

  it.each([
    ["hourly", "hourly limit reached", "2026-10-13T02:00:00.000Z"],
    ["daily", "daily limit reached", "2026-10-14T00:00:00.000Z"],
    ["weekly", "weekly limit reached", "2026-10-20T00:00:00.000Z"],
    ["monthly", "monthly spend limit reached", "2026-11-01T00:00:00.000Z"],
  ] as const)("reports a %s window only when the provider named it", (window, message, resetAt) => {
    const decision = plan({
      signal: { class: "usage_limit", message, resetAt },
      models: [gpt],
    });
    assert.equal(decision.type, "switch");
    if (decision.type !== "switch") return;
    assert.equal(decision.window, window);
    assert.equal(decision.resetAt, resetAt);
  });

  it("does not invent a reset time", () => {
    const decision = plan({
      signal: { class: "usage_limit", message: "You've hit your weekly limit", resetAt: null },
      models: [gpt],
    });
    assert.equal(decision.type, "switch");
    if (decision.type !== "switch") return;
    assert.equal(decision.resetAt, null);
    assert.notInclude(decision.detail, "resets at");
  });

  it("does not claim a reset when the provider names conflicting windows", () => {
    const decision = plan({
      signal: {
        class: "usage_limit",
        message: "You've hit your monthly spend limit. Session resets at 10:10 AM.",
        resetAt: "2026-10-13T00:10:00.000Z",
      },
      models: [gpt],
    });
    assert.equal(decision.type, "switch");
    if (decision.type !== "switch") return;
    assert.equal(decision.window, "monthly");
    assert.equal(decision.resetAt, null);
    assert.notInclude(decision.detail, "2026-10-13");
  });

  it.each([
    ["permission_error", "authentication failed"],
    ["transport_error", "network timeout talking to the provider"],
    ["provider_error", "provider request failed"],
    ["unknown", "something went wrong"],
  ] as const)("does not treat %s as quota exhaustion", (failureClass, message) => {
    assert.equal(
      plan({ signal: { class: failureClass, message, resetAt: "2026-10-20T00:00:00.000Z" } }).type,
      "leave-paused",
    );
  });

  it("requires a structured usage_limit class for fallback planning", () => {
    assert.equal(
      plan({
        signal: {
          class: null,
          message: "The agent terminated early due to an API error and a usage limit.",
          resetAt: null,
        },
        models: [gpt],
      }).type,
      "leave-paused",
    );
    assert.equal(
      plan({
        signal: {
          class: null,
          message: "Implemented usage limit handling in the fallback module.",
          resetAt: null,
        },
      }).type,
      "leave-paused",
    );
  });

  it("skips models that share an account quota and does not loop", () => {
    const first = plan({
      signal: {
        class: "usage_limit",
        message: "You've hit your monthly spend limit",
        resetAt: null,
      },
    });
    assert.equal(first.type, "switch");
    if (first.type !== "switch") return;
    assert.deepEqual(first.to, gpt);

    const spendLimit: ModelFallbackSignal = {
      class: "usage_limit",
      message: "You've hit your monthly spend limit",
      resetAt: null,
    };
    const again = plan({
      current: gpt,
      tried: [opus, gpt],
      exhausted: [{ selection: opus, signal: spendLimit }],
      signal: spendLimit,
    });
    assert.equal(again.type, "pause");
    if (again.type !== "pause") return;
    assert.equal(again.reason, "exhausted");
    assert.include(again.detail, gpt.model);
  });

  it("treats an unqualified structured usage limit as instance-scoped", () => {
    const decision = plan({
      models: [sonnet, gpt],
      signal: {
        class: "usage_limit",
        message: "Provider stopped this request",
        code: "usageLimitExceeded",
        resetAt: null,
      },
    });
    assert.equal(decision.type, "switch");
    if (decision.type !== "switch") return;
    assert.deepEqual(decision.to, gpt);
  });

  it("skips another model on the same named quota and keeps a different family", () => {
    const decision = plan({
      models: [opusNext, sonnet, gpt],
      signal: {
        class: "usage_limit",
        message: "weekly limit reached",
        code: "seven_day_opus",
        resetAt: "2026-10-20T00:00:00.000Z",
      },
    });
    assert.equal(decision.type, "switch");
    if (decision.type !== "switch") return;
    assert.deepEqual(decision.to, sonnet);
  });

  it("skips an unavailable provider and pauses when continuation is unsafe", () => {
    const skipped = plan({ unavailableInstanceIds: [claude] });
    assert.equal(skipped.type, "switch");
    if (skipped.type !== "switch") return;
    assert.deepEqual(skipped.to, gpt);

    const paused = plan({ continuation: "unsupported" });
    assert.equal(paused.type, "pause");
    if (paused.type !== "pause") return;
    assert.equal(paused.reason, "unsupported-continuation");
    assert.include(paused.detail.toLowerCase(), "safe continuation");
    assert.include(paused.detail, opus.model);
  });

  it("continues past a skipped target to a later model", () => {
    const decision = plan({
      models: [sonnet, gpt],
      skipped: [sonnet],
      signal: {
        class: "usage_limit",
        message: "You've hit your weekly limit",
        code: "seven_day_opus",
        resetAt: "2026-10-20T00:00:00.000Z",
      },
    });
    assert.equal(decision.type, "switch");
    if (decision.type !== "switch") return;
    assert.deepEqual(decision.to, gpt);
  });

  it("follows list order and stops when every entry was already tried", () => {
    const decision = plan({ models: [gpt, sonnet] });
    assert.equal(decision.type, "switch");
    if (decision.type !== "switch") return;
    assert.deepEqual(decision.to, gpt);

    const exhausted = plan({ models: [gpt, sonnet], tried: [opus, gpt, sonnet], current: sonnet });
    assert.equal(exhausted.type, "pause");
  });
});

describe("decideFromProjection", () => {
  const limited = (
    modelSelection: ModelSelection,
    ordinal: number,
    code: string | null,
  ): FallbackRunEvidence => ({
    modelSelection,
    ordinal,
    status: "failed",
    startedAt: `2026-10-12T1${ordinal}:00:00.000Z`,
    completedAt: `2026-10-12T1${ordinal}:30:00.000Z`,
    failureClass: "usage_limit",
    message: "You've hit your weekly limit",
    code,
    resetAt: "2026-10-20T00:00:00.000Z",
  });

  it("ignores queued runs when building the quota chain", () => {
    const decision = decideFromProjection({
      enabled: true,
      models: [sonnet, gpt],
      unavailableInstanceIds: [],
      continuation: "supported",
      current: opus,
      runs: [
        limited(opus, 1, null),
        {
          modelSelection: opus,
          ordinal: 2,
          status: "queued",
          startedAt: null,
          completedAt: null,
          failureClass: null,
          message: "",
          resetAt: null,
        },
      ],
    });
    assert.equal(decision.type, "switch");
    if (decision.type !== "switch") return;
    assert.deepEqual(decision.to, gpt);
  });

  it("ignores a queued follow-up cancelled before it started", () => {
    const decision = decideFromProjection({
      enabled: true,
      models: [sonnet, gpt],
      unavailableInstanceIds: [],
      continuation: "supported",
      current: opus,
      runs: [
        limited(opus, 1, "seven_day_opus"),
        {
          modelSelection: opus,
          ordinal: 2,
          status: "cancelled",
          startedAt: null,
          completedAt: "2026-10-12T12:00:00.000Z",
          failureClass: null,
          message: "",
          resetAt: null,
        },
      ],
    });
    assert.equal(decision.type, "switch");
    if (decision.type !== "switch") return;
    assert.deepEqual(decision.to, sonnet);
  });

  it("keeps every family the chain exhausted, not only the newest", () => {
    const decision = decideFromProjection({
      enabled: true,
      models: [opus, gpt, sonnet, opusNext],
      unavailableInstanceIds: [],
      continuation: "supported",
      current: sonnet,
      runs: [
        limited(opus, 1, "seven_day_opus"),
        limited(gpt, 2, "weekly_gpt"),
        limited(sonnet, 3, "seven_day_sonnet"),
      ],
    });
    assert.equal(decision.type, "pause");
    if (decision.type !== "pause") return;
    assert.equal(decision.reason, "exhausted");
  });
});

describe("nextModelFallbackCommand", () => {
  it.effect("keeps retrying past any number of rejected attempts", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("thread-1");
      const runId = RunId.make("run-1");
      const rejected = new Set(
        Array.from({ length: 9 }, (_, index) =>
          String(
            modelFallbackCommand({ threadId, runId, decision: plan(), attempt: index + 1 })
              ?.commandId,
          ),
        ),
      );
      const command = yield* nextModelFallbackCommand({ threadId, runId, decision: plan() }, (id) =>
        Effect.succeed(
          rejected.has(String(id)) ? Option.some({ status: "rejected" }) : Option.none(),
        ),
      );
      assert.equal(
        command?.commandId,
        CommandId.make(
          `model-fallback:${threadId}:${runId}:${gpt.instanceId}:${gpt.model}:attempt-10`,
        ),
      );
    }),
  );
});

describe("presentedDelegatedStatus", () => {
  it("requires provider failure evidence to override a completed answer", () => {
    assert.equal(
      presentedDelegatedStatus({
        runStatus: "completed",
        resultText: "Implemented usage limit handling and monthly spend limit reporting.",
        failureClass: null,
      }),
      "completed",
    );
    assert.equal(
      presentedDelegatedStatus({
        runStatus: "completed",
        resultText: "The agent terminated early due to an API error and a usage limit.",
        failureClass: "usage_limit",
      }),
      "failed",
    );
    assert.equal(
      presentedDelegatedStatus({
        runStatus: "completed",
        resultText: "You've hit your monthly spend limit",
        failureClass: "usage_limit",
      }),
      "failed",
    );
  });

  it("leaves a genuine completion and a generic provider error unchanged", () => {
    assert.equal(
      presentedDelegatedStatus({
        runStatus: "completed",
        resultText: "Finished the research notes.",
        failureClass: null,
      }),
      "completed",
    );
    assert.equal(
      presentedDelegatedStatus({
        runStatus: "completed",
        resultText: "The agent terminated early due to an API error.",
        failureClass: null,
      }),
      "completed",
    );
    assert.equal(
      presentedDelegatedStatus({
        runStatus: "failed",
        resultText: "network timeout",
        failureClass: "transport_error",
      }),
      "failed",
    );
  });
});

describe("modelFallbackCommand", () => {
  const threadId = ThreadId.make("thread-1");
  const runId = RunId.make("run-1");

  it("dispatches the replacement model once and notes an unsafe pause", () => {
    const command = modelFallbackCommand({
      threadId,
      runId,
      decision: plan(),
    });
    assert.equal(command?.type, "message.dispatch");
    if (command?.type !== "message.dispatch") return;
    assert.deepEqual(command.modelSelection, gpt);
    assert.equal(command.modelFallbackOfRunId, runId);
    assert.equal(
      command.commandId,
      CommandId.make(`model-fallback:${threadId}:${runId}:${gpt.instanceId}:${gpt.model}`),
    );
    assert.equal(command.dispatchMode.type, "start_immediately");

    const note = modelFallbackCommand({
      threadId,
      runId,
      decision: plan({ continuation: "unsupported" }),
    });
    assert.equal(note?.type, "message.dispatch");
    if (note?.type !== "message.dispatch") return;
    assert.equal(String(note.commandId).startsWith(MODEL_FALLBACK_NOTE_PREFIX), true);
    assert.equal(note.createdBy, "system");
    assert.equal(note.modelSelection, undefined);
    assert.equal(note.modelFallbackOfRunId, runId);
    assert.equal(
      modelFallbackCommand({ threadId, runId, decision: plan({ enabled: false }) }),
      null,
    );
  });

  it("uses a new identity after a rejected attempt", () => {
    const first = modelFallbackCommand({ threadId, runId, decision: plan(), attempt: 1 });
    const second = modelFallbackCommand({ threadId, runId, decision: plan(), attempt: 2 });
    if (first?.type !== "message.dispatch" || second?.type !== "message.dispatch") return;
    assert.notEqual(first.commandId, second.commandId);
    assert.include(String(second.commandId), "attempt-2");
  });

  it("uses stable message ids", () => {
    const command = modelFallbackCommand({ threadId, runId, decision: plan() });
    if (command?.type !== "message.dispatch") return;
    assert.equal(
      command.messageId,
      MessageId.make(`model-fallback:${threadId}:${runId}:${gpt.instanceId}:${gpt.model}`),
    );
  });
});
