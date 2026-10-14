import { assert, it } from "@effect/vitest";
import { CommandId, MessageId, RunId, ThreadId, ProviderInstanceId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SqlClient from "effect/sql/SqlClient";
import * as Tracer from "effect/Tracer";

import * as Sqlite from "../persistence/Sqlite.ts";
import * as Receipts from "./CommandReceiptStore.ts";
import {
  modelFallbackCommand,
  modelFallbackRetry,
  nextModelFallbackCommand,
} from "./modelFallback.ts";

const threadId = ThreadId.make("thread:retry-history");
const runId = RunId.make("run:retry-history");
const decision = {
  type: "switch" as const,
  to: { instanceId: ProviderInstanceId.make("codex"), model: "custom-𝒙:attempt-2" },
  detail: "Continue",
  window: null,
  resetAt: null,
};
const first = modelFallbackCommand({ threadId, runId, decision })!;
const layer = Receipts.layer.pipe(Layer.provideMerge(Sqlite.layerMemory));

function receiptQueryTracer(queries: string[]) {
  return Tracer.make({
    span(options) {
      const span = new Tracer.NativeSpan(options);
      const end = span.end.bind(span);
      span.end = (endTime, exit) => {
        end(endTime, exit);
        const query = span.attributes.get("db.query.text");
        if (typeof query === "string" && query.includes("orchestration_command_receipts"))
          queries.push(query);
      };
      return span;
    },
  });
}

it.effect.each(["accepted", "rejected"] as const)(
  "advances past a %s original identity classified as another model's legacy retry",
  (status) =>
    Effect.gen(function* () {
      const receipts = yield* Receipts.CommandReceiptStoreV2;
      const baseDecision = { ...decision, to: { ...decision.to, model: "custom-𝒙" } };
      const base = modelFallbackCommand({ threadId, runId, decision: baseDecision })!;
      const now = yield* DateTime.now;
      for (const command of [base, first]) {
        yield* receipts.insertIfAbsent({
          commandId: command.commandId,
          threadId,
          commandType: "message.dispatch",
          acceptedAt: now,
          resultSequence: 0,
          status: command.commandId === first.commandId ? status : "rejected",
          error: status === "rejected" ? "Refused" : null,
        });
      }
      yield* nextModelFallbackCommand(
        { threadId, runId, decision: baseDecision },
        receipts.getLatestRetry,
      );
      const next = yield* nextModelFallbackCommand(
        { threadId, runId, decision },
        receipts.getLatestRetry,
      );
      assert.equal(
        next?.commandId,
        CommandId.make(`model-fallback-retry:${encodeURIComponent(first.commandId)}:attempt-2`),
      );
      assert.isNotNull(next);
      if (next === null) return;
      assert.isTrue(Option.isNone(yield* receipts.getByCommandId(next.commandId)));
      assert.deepEqual(
        yield* nextModelFallbackCommand({ threadId, runId, decision }, receipts.getLatestRetry),
        next,
      );
      const queries: string[] = [];
      const restarted = yield* nextModelFallbackCommand(
        { threadId, runId, decision },
        receipts.getLatestRetry,
      ).pipe(
        Effect.provide(Layer.fresh(Receipts.layer)),
        Effect.withTracer(receiptQueryTracer(queries)),
      );
      assert.deepEqual(restarted, next);
      assert.equal(queries.length, 3);
      assert.isTrue(queries.every((query) => query.trimStart().startsWith("SELECT")));
    }).pipe(Effect.provide(layer)),
);

it.effect("recovers when another model owns the next legacy retry identity", () =>
  Effect.gen(function* () {
    const receipts = yield* Receipts.CommandReceiptStoreV2;
    const now = yield* DateTime.now;
    const other = modelFallbackCommand({
      threadId,
      runId,
      decision: { ...decision, to: { ...decision.to, model: `${decision.to.model}:attempt-2` } },
    })!;
    for (const command of [other, first])
      yield* receipts.insertIfAbsent({
        commandId: command.commandId,
        threadId,
        commandType: "message.dispatch",
        acceptedAt: now,
        resultSequence: 0,
        status: "rejected",
        error: "Refused",
        ...modelFallbackRetry(command),
      });
    const input = { threadId, runId, decision };
    const next = yield* nextModelFallbackCommand(input, receipts.getLatestRetry);
    assert.isNotNull(next);
    if (next === null) return;
    assert.isTrue(Option.isNone(yield* receipts.getByCommandId(next.commandId)));
    assert.deepEqual(yield* nextModelFallbackCommand(input, receipts.getLatestRetry), next);
    assert.deepEqual(modelFallbackRetry(next), { retryGroup: first.commandId, retryAttempt: 2 });
    yield* receipts.insertIfAbsent({
      commandId: next.commandId,
      threadId,
      commandType: "message.dispatch",
      acceptedAt: now,
      resultSequence: 0,
      status: "rejected",
      error: "Refused",
      ...modelFallbackRetry(next),
    });
    const following = yield* nextModelFallbackCommand(input, receipts.getLatestRetry);
    assert.isNotNull(following);
    if (following === null) return;
    assert.notEqual(following.commandId, next.commandId);
    assert.deepEqual(modelFallbackRetry(following), {
      retryGroup: first.commandId,
      retryAttempt: 3,
    });
  }).pipe(Effect.provide(layer)),
);

it.effect.each(["accepted", "rejected"] as const)(
  "recovers a %s legacy descendant after another group classifies its original identity",
  (status) =>
    Effect.gen(function* () {
      const receipts = yield* Receipts.CommandReceiptStoreV2;
      const baseDecision = { ...decision, to: { ...decision.to, model: "custom-𝒙" } };
      const base = modelFallbackCommand({ threadId, runId, decision: baseDecision })!;
      const legacyId = CommandId.make(`${first.commandId}:attempt-7`);
      const now = yield* DateTime.now;
      for (const commandId of [base.commandId, first.commandId, legacyId]) {
        yield* receipts.insertIfAbsent({
          commandId,
          threadId,
          commandType: "message.dispatch",
          acceptedAt: now,
          resultSequence: 0,
          status: commandId === legacyId ? status : "rejected",
          error: status === "rejected" ? "Refused" : null,
        });
      }
      yield* nextModelFallbackCommand(
        { threadId, runId, decision: baseDecision },
        receipts.getLatestRetry,
      );
      const input = { threadId, runId, decision };
      const next = yield* nextModelFallbackCommand(input, receipts.getLatestRetry);
      assert.equal(
        next?.commandId,
        status === "accepted"
          ? legacyId
          : CommandId.make(`model-fallback-retry:${encodeURIComponent(first.commandId)}:attempt-8`),
      );
      const restarted = yield* nextModelFallbackCommand(input, receipts.getLatestRetry).pipe(
        Effect.provide(Layer.fresh(Receipts.layer)),
      );
      assert.deepEqual(restarted, next);
    }).pipe(Effect.provide(layer)),
);

it.effect("bootstraps a legacy retry chain once and uses one indexed read after restart", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const receipts = yield* Receipts.CommandReceiptStoreV2;
    const now = DateTime.formatIso(yield* DateTime.now);
    yield* sql`
      WITH RECURSIVE history(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM history WHERE n < 1000)
      INSERT INTO orchestration_command_receipts
        (command_id, aggregate_kind, aggregate_id, accepted_at, result_sequence, status, command_type)
      SELECT CASE WHEN n = 1 THEN ${first.commandId} ELSE ${`${first.commandId}:attempt-`} || n END,
        'thread', ${threadId}, ${now}, 0, 'rejected', 'message.dispatch' FROM history
    `;
    yield* sql`
      WITH RECURSIVE history(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM history WHERE n < 1000)
      INSERT INTO orchestration_command_receipts
        (command_id, aggregate_kind, aggregate_id, accepted_at, result_sequence, status, command_type)
      SELECT ${`${first.commandId}:attempt-`} || n || '-custom', 'thread', ${threadId},
        ${now}, 0, 'rejected', 'message.dispatch' FROM history
    `;
    yield* receipts.insertIfAbsent({
      commandId: CommandId.make(`${first.commandId}:attempt-01001`),
      threadId,
      commandType: "message.dispatch",
      acceptedAt: yield* DateTime.now,
      resultSequence: 0,
      status: "accepted",
      error: null,
    });
    const input = { threadId, runId, decision };
    const next = yield* nextModelFallbackCommand(input, receipts.getLatestRetry);
    assert.equal(
      next?.commandId,
      CommandId.make(`model-fallback-retry:${encodeURIComponent(first.commandId)}:attempt-1001`),
    );
    const [left, right] = yield* Effect.all(
      [
        nextModelFallbackCommand(input, receipts.getLatestRetry),
        nextModelFallbackCommand(input, receipts.getLatestRetry),
      ],
      { concurrency: 2 },
    );
    assert.deepEqual(left, right);
    const queries: string[] = [];
    const restarted = yield* nextModelFallbackCommand(input, receipts.getLatestRetry).pipe(
      Effect.provide(Layer.fresh(Receipts.layer)),
      Effect.withTracer(receiptQueryTracer(queries)),
    );
    assert.deepEqual(restarted, next);
    assert.equal(queries.length, 1);
    assert.isTrue(queries[0]?.trimStart().startsWith("SELECT"));
    const plan = yield* sql<{ readonly detail: string }>`
      EXPLAIN QUERY PLAN SELECT command_id FROM orchestration_command_receipts
      WHERE aggregate_kind = 'thread' AND aggregate_id = ${threadId} AND retry_group = ${first.commandId}
      ORDER BY retry_attempt DESC LIMIT 1
    `;
    assert.isTrue(plan.some((row) => row.detail.includes("idx_orch_command_receipts_retry")));
    assert.isFalse(plan.some((row) => row.detail.includes("TEMP B-TREE")));
    assert.isNotNull(next);
    if (next === null) return;
    const metadata = modelFallbackRetry(next);
    assert.deepEqual(metadata, { retryGroup: first.commandId, retryAttempt: 1001 });
    yield* receipts.insertIfAbsent({
      commandId: next.commandId,
      threadId,
      commandType: "message.dispatch",
      acceptedAt: yield* DateTime.now,
      resultSequence: 0,
      status: "accepted",
      error: null,
      ...metadata,
    });
    assert.deepEqual(yield* nextModelFallbackCommand(input, receipts.getLatestRetry), next);
    assert.deepEqual(modelFallbackRetry(first), { retryGroup: first.commandId, retryAttempt: 1 });
  }).pipe(Effect.provide(layer)),
);

it.effect("rolls back legacy classification when the original receipt cannot be marked", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const receipts = yield* Receipts.CommandReceiptStoreV2;
    const now = yield* DateTime.now;
    for (const attempt of [1, 2]) {
      const commandId =
        attempt === 1 ? first.commandId : CommandId.make(`${first.commandId}:attempt-${attempt}`);
      yield* receipts.insertIfAbsent({
        commandId,
        threadId,
        commandType: "message.dispatch",
        acceptedAt: now,
        resultSequence: 0,
        status: "rejected",
        error: "Refused",
      });
    }
    yield* sql.unsafe(`
      CREATE TRIGGER refuse_retry_bootstrap BEFORE UPDATE ON orchestration_command_receipts
      WHEN OLD.command_id = '${first.commandId}' AND NEW.retry_attempt = 1
      BEGIN SELECT RAISE(ABORT, 'Refused original receipt classification'); END
    `);
    yield* receipts.getLatestRetry({ threadId, retryGroup: first.commandId }).pipe(Effect.flip);
    const rows = yield* sql<{
      readonly retry_group: string | null;
      readonly retry_bootstrapped: number;
    }>`SELECT retry_group, retry_bootstrapped FROM orchestration_command_receipts`;
    assert.isTrue(rows.every((row) => row.retry_group === null));
    assert.isTrue(rows.every((row) => row.retry_bootstrapped === 0));
    yield* sql`DROP TRIGGER refuse_retry_bootstrap`;
    const latest = yield* receipts.getLatestRetry({ threadId, retryGroup: first.commandId });
    assert.isTrue(Option.isSome(latest));
    if (Option.isSome(latest)) assert.equal(latest.value.retryAttempt, 2);
  }).pipe(Effect.provide(layer)),
);

it.effect("replays an accepted legacy retry without allocating a fresh identity", () =>
  Effect.gen(function* () {
    const receipts = yield* Receipts.CommandReceiptStoreV2;
    const legacyId = CommandId.make(`${first.commandId}:attempt-7`);
    yield* receipts.insertIfAbsent({
      commandId: legacyId,
      threadId,
      commandType: "message.dispatch",
      acceptedAt: yield* DateTime.now,
      resultSequence: 0,
      status: "accepted",
      error: null,
      retryGroup: first.commandId,
      retryAttempt: 7,
    });
    const command = yield* nextModelFallbackCommand(
      { threadId, runId, decision },
      receipts.getLatestRetry,
    );
    assert.equal(command?.commandId, legacyId);
    assert.equal(command?.messageId, MessageId.make(legacyId));
    assert.equal(
      (yield* receipts.getLatestRetry({ threadId, retryGroup: first.commandId }))._tag,
      "Some",
    );
  }).pipe(Effect.provide(layer)),
);
