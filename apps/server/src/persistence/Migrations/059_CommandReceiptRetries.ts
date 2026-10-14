import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`ALTER TABLE orchestration_command_receipts ADD COLUMN retry_group TEXT`;
  yield* sql`ALTER TABLE orchestration_command_receipts ADD COLUMN retry_attempt INTEGER`;
  yield* sql`ALTER TABLE orchestration_command_receipts ADD COLUMN retry_bootstrapped INTEGER NOT NULL DEFAULT 0`;
  yield* sql`
    CREATE INDEX idx_orch_command_receipts_retry
    ON orchestration_command_receipts(aggregate_kind, aggregate_id, retry_group, retry_attempt DESC)
    WHERE retry_group IS NOT NULL
  `;
  yield* sql`
    CREATE INDEX orchestration_v2_projection_runs_delivery_recovery_idx
    ON orchestration_v2_projection_runs(thread_id)
    WHERE CASE WHEN json_valid(payload_json)
      THEN json_type(payload_json, '$.delegatedCompletion.delivery') = 'object'
      ELSE 0 END
  `;
  yield* sql`
    CREATE INDEX orchestration_v2_projection_subagents_result_recovery_idx
    ON orchestration_v2_projection_subagents(child_thread_id, thread_id, subagent_id)
    WHERE origin = 'app_owned' AND child_thread_id IS NOT NULL
      AND CASE WHEN json_valid(payload_json)
        THEN json_type(payload_json, '$.result') = 'null'
        ELSE 0 END
  `;
});
