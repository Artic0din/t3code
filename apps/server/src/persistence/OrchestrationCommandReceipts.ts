/**
 * OrchestrationCommandReceiptRepository - Repository interface for command receipts.
 *
 * Owns persistence operations for deduplication and status tracking of
 * orchestration command handling.
 *
 * @module OrchestrationCommandReceiptRepository
 */
import { CommandId, IsoDateTime, NonNegativeInt, ProjectId, ThreadId } from "@t3tools/contracts";
import * as SqlClient from "effect/sql/SqlClient";
import * as SqlSchema from "effect/sql/SqlSchema";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import {
  toPersistenceSqlError,
  type OrchestrationCommandReceiptRepositoryError,
} from "./Errors.ts";

export const OrchestrationCommandReceipt = Schema.Struct({
  commandId: CommandId,
  aggregateKind: Schema.Literals(["project", "thread"]),
  aggregateId: Schema.Union([ProjectId, ThreadId]),
  commandType: Schema.String,
  acceptedAt: IsoDateTime,
  resultSequence: NonNegativeInt,
  status: Schema.Literals(["accepted", "rejected"]),
  error: Schema.NullOr(Schema.String),
  retryGroup: Schema.optionalKey(Schema.NullOr(CommandId)),
  retryAttempt: Schema.optionalKey(Schema.NullOr(NonNegativeInt)),
});
export type OrchestrationCommandReceipt = typeof OrchestrationCommandReceipt.Type;

export const GetByCommandIdInput = Schema.Struct({
  commandId: CommandId,
});
export type GetByCommandIdInput = typeof GetByCommandIdInput.Type;

/**
 * OrchestrationCommandReceiptRepository - Service tag for command receipt persistence.
 */
export class OrchestrationCommandReceiptRepository extends Context.Service<
  OrchestrationCommandReceiptRepository,
  {
    readonly insertIfAbsent: (
      receipt: OrchestrationCommandReceipt,
    ) => Effect.Effect<boolean, OrchestrationCommandReceiptRepositoryError>;

    /**
     * Insert or replace a command receipt row.
     *
     * Upserts by `commandId` for idempotent command-result tracking.
     */
    readonly upsert: (
      receipt: OrchestrationCommandReceipt,
    ) => Effect.Effect<void, OrchestrationCommandReceiptRepositoryError>;

    /**
     * Read a command receipt by command id.
     */
    readonly getByCommandId: (
      input: GetByCommandIdInput,
    ) => Effect.Effect<
      Option.Option<OrchestrationCommandReceipt>,
      OrchestrationCommandReceiptRepositoryError
    >;
    readonly getLatestRetry: (input: {
      readonly threadId: ThreadId;
      readonly retryGroup: CommandId;
    }) => Effect.Effect<
      Option.Option<OrchestrationCommandReceipt>,
      OrchestrationCommandReceiptRepositoryError
    >;
  }
>()("t3/persistence/OrchestrationCommandReceipts/OrchestrationCommandReceiptRepository") {}

const makeOrchestrationCommandReceiptRepository = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const upsertReceiptRow = SqlSchema.void({
    Request: OrchestrationCommandReceipt,
    execute: (receipt) =>
      sql`
        INSERT INTO orchestration_command_receipts (
          command_id,
          aggregate_kind,
          aggregate_id,
          command_type,
          accepted_at,
          result_sequence,
          status,
          error,
          retry_group,
          retry_attempt
        )
        VALUES (
          ${receipt.commandId},
          ${receipt.aggregateKind},
          ${receipt.aggregateId},
          ${receipt.commandType},
          ${receipt.acceptedAt},
          ${receipt.resultSequence},
          ${receipt.status},
          ${receipt.error},
          ${receipt.retryGroup ?? null},
          ${receipt.retryAttempt ?? null}
        )
        ON CONFLICT (command_id)
        DO UPDATE SET
          aggregate_kind = excluded.aggregate_kind,
            aggregate_id = excluded.aggregate_id,
            command_type = excluded.command_type,
          accepted_at = excluded.accepted_at,
          result_sequence = excluded.result_sequence,
          status = excluded.status,
          error = excluded.error,
          retry_group = COALESCE(excluded.retry_group, retry_group),
          retry_attempt = COALESCE(excluded.retry_attempt, retry_attempt)
      `,
  });

  const findReceiptByCommandId = SqlSchema.findOneOption({
    Request: GetByCommandIdInput,
    Result: OrchestrationCommandReceipt,
    execute: ({ commandId }) =>
      sql`
        SELECT
          command_id AS "commandId",
          aggregate_kind AS "aggregateKind",
          aggregate_id AS "aggregateId",
          command_type AS "commandType",
          accepted_at AS "acceptedAt",
          result_sequence AS "resultSequence",
          status,
          error,
          retry_group AS "retryGroup",
          retry_attempt AS "retryAttempt"
        FROM orchestration_command_receipts
        WHERE command_id = ${commandId}
      `,
  });

  const upsert: OrchestrationCommandReceiptRepository["Service"]["upsert"] = (receipt) =>
    upsertReceiptRow(receipt).pipe(
      Effect.mapError(toPersistenceSqlError("OrchestrationCommandReceiptRepository.upsert:query")),
    );

  const insertIfAbsent: OrchestrationCommandReceiptRepository["Service"]["insertIfAbsent"] = (
    receipt,
  ) =>
    sql<{ readonly command_id: string }>`
      INSERT INTO orchestration_command_receipts (
        command_id,
        aggregate_kind,
        aggregate_id,
        command_type,
        accepted_at,
        result_sequence,
        status,
        error,
        retry_group,
        retry_attempt
      )
      VALUES (
        ${receipt.commandId},
        ${receipt.aggregateKind},
        ${receipt.aggregateId},
        ${receipt.commandType},
        ${receipt.acceptedAt},
        ${receipt.resultSequence},
        ${receipt.status},
        ${receipt.error},
        ${receipt.retryGroup ?? null},
        ${receipt.retryAttempt ?? null}
      )
      ON CONFLICT(command_id) DO NOTHING
      RETURNING command_id
    `.pipe(
      Effect.map((rows) => rows.length === 1),
      Effect.mapError(
        toPersistenceSqlError("OrchestrationCommandReceiptRepository.insertIfAbsent:query"),
      ),
    );

  const getByCommandId: OrchestrationCommandReceiptRepository["Service"]["getByCommandId"] = (
    input,
  ) =>
    findReceiptByCommandId(input).pipe(
      Effect.mapError(
        toPersistenceSqlError("OrchestrationCommandReceiptRepository.getByCommandId:query"),
      ),
    );

  const getLatestRetry = Effect.fn("OrchestrationCommandReceiptRepository.getLatestRetry")(
    function* ({
      threadId,
      retryGroup,
    }: {
      readonly threadId: ThreadId;
      readonly retryGroup: CommandId;
    }) {
      const latest = SqlSchema.findOneOption({
        Request: Schema.Void,
        Result: OrchestrationCommandReceipt,
        execute: () => sql`
          SELECT command_id AS "commandId", aggregate_kind AS "aggregateKind", aggregate_id AS "aggregateId",
            command_type AS "commandType", accepted_at AS "acceptedAt", result_sequence AS "resultSequence",
            status, error, retry_group AS "retryGroup", retry_attempt AS "retryAttempt"
          FROM orchestration_command_receipts
          WHERE aggregate_kind = 'thread' AND aggregate_id = ${threadId} AND retry_group = ${retryGroup}
          ORDER BY retry_attempt DESC LIMIT 1
        `,
      });
      const existing = yield* latest(undefined);
      if (Option.isSome(existing)) return existing;
      const root = yield* findReceiptByCommandId({ commandId: retryGroup });
      if (
        Option.isNone(root) ||
        root.value.aggregateKind !== "thread" ||
        root.value.aggregateId !== threadId
      )
        return Option.none();
      const occupiedOriginal = Option.some({
        ...root.value,
        status: "rejected" as const,
        retryGroup,
        retryAttempt: 1,
      });
      const [bootstrap] = yield* sql<{ readonly complete: number }>`
        SELECT retry_bootstrapped AS complete FROM orchestration_command_receipts
        WHERE command_id = ${retryGroup}
      `;
      if (bootstrap?.complete === 1) return occupiedOriginal;
      const prefix = `${retryGroup}:attempt-`;
      yield* sql.withTransaction(
        Effect.gen(function* () {
          yield* sql`
        UPDATE orchestration_command_receipts
        SET retry_group = ${retryGroup}, retry_attempt = CAST(substr(command_id, length(${prefix}) + 1) AS INTEGER)
        WHERE retry_group IS NULL AND aggregate_kind = 'thread' AND aggregate_id = ${threadId}
          AND command_id >= ${prefix} AND command_id < ${`${retryGroup}:attempt.`}
          AND substr(command_id, length(${prefix}) + 1) GLOB '[1-9]*'
          AND substr(command_id, length(${prefix}) + 1) NOT GLOB '*[^0-9]*'
          AND CAST(substr(command_id, length(${prefix}) + 1) AS INTEGER) > 1
        `;
          yield* sql`
          UPDATE orchestration_command_receipts
          SET retry_group = COALESCE(retry_group, ${retryGroup}),
            retry_attempt = COALESCE(retry_attempt, 1), retry_bootstrapped = 1
          WHERE aggregate_kind = 'thread' AND aggregate_id = ${threadId}
            AND command_id = ${retryGroup}
        `;
        }),
      );
      const migrated = yield* latest(undefined);
      return Option.isSome(migrated) ? migrated : occupiedOriginal;
    },
    Effect.mapError(
      toPersistenceSqlError("OrchestrationCommandReceiptRepository.getLatestRetry:query"),
    ),
  );

  return {
    insertIfAbsent,
    upsert,
    getByCommandId,
    getLatestRetry,
  } satisfies OrchestrationCommandReceiptRepository["Service"];
});

export const layer = Layer.effect(
  OrchestrationCommandReceiptRepository,
  makeOrchestrationCommandReceiptRepository,
);
