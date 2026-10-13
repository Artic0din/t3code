import { resolveProviderInstanceEnabled, type ModelSelection } from "@t3tools/contracts";
import {
  latestExecutedRun,
  latestRootProviderFailure,
} from "@t3tools/shared/orchestrationV2ThreadError";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";

import * as ServerSettings from "../serverSettings.ts";
import * as Scheduler from "../scheduling/Scheduler.ts";
import { CommandReceiptStoreV2 } from "./CommandReceiptStore.ts";
import { decideFromProjection, nextModelFallbackCommand } from "./modelFallback.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ProviderSwitch from "./ProviderSwitchService.ts";
import * as ThreadManagement from "./ThreadManagementService.ts";

const makeSweep = Effect.gen(function* () {
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const threads = yield* ThreadManagement.ThreadManagementService;
  const settings = yield* ServerSettings.ServerSettingsService;
  const providerSwitch = yield* ProviderSwitch.ProviderSwitchServiceV2;
  const commandReceipts = yield* CommandReceiptStoreV2;
  return Effect.fn("ModelFallbackWorker.sweep")(function* () {
    const preferences = yield* settings.getSettings;
    if (!preferences.modelFallback.enabled) return;
    const now = yield* DateTime.now;
    const candidates = yield* projections.getLimitRecoveryCandidates({
      now,
      autoResume: false,
      snooze: false,
      fallback: true,
    });
    for (const candidate of candidates) {
      const projection = yield* projections.getThreadProjection(candidate.id).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("model-fallback.sweep-projection-failed", {
            threadId: candidate.id,
            cause,
          }).pipe(Effect.as(null)),
        ),
      );
      if (projection === null) continue;
      if (
        projection.thread.snoozedUntil != null &&
        DateTime.toEpochMillis(projection.thread.snoozedUntil) > DateTime.toEpochMillis(now)
      ) {
        continue;
      }
      const evidence = projection.runs.map((run) => {
        const failure = latestRootProviderFailure(run, projection.turnItems);
        return {
          modelSelection: run.modelSelection,
          ordinal: run.ordinal,
          status: run.status,
          startedAt: run.startedAt === null ? null : DateTime.formatIso(run.startedAt),
          completedAt: run.completedAt === null ? null : DateTime.formatIso(run.completedAt),
          failureClass: failure?.class ?? null,
          message: failure?.message ?? "",
          code: failure?.code ?? null,
          resetAt: failure?.resetAt ?? null,
        };
      });
      const unavailableInstanceIds = [
        ...new Set(preferences.modelFallback.models.map((model) => model.instanceId)),
      ].filter((instanceId) => {
        const instance = preferences.providerInstances[instanceId];
        return instance === undefined || !resolveProviderInstanceEnabled(instance);
      });
      const skipped: ModelSelection[] = [];
      let decision = decideFromProjection({
        enabled: true,
        models: preferences.modelFallback.models,
        unavailableInstanceIds,
        continuation: "supported",
        current: projection.thread.modelSelection,
        runs: evidence,
        skipped,
      });
      while (decision.type === "switch") {
        const planned = yield* providerSwitch
          .plan({ projection, targetModelSelection: decision.to })
          .pipe(Effect.exit);
        if (Exit.isSuccess(planned)) break;
        skipped.push(decision.to);
        decision = decideFromProjection({
          enabled: true,
          models: preferences.modelFallback.models,
          unavailableInstanceIds,
          continuation: "supported",
          current: projection.thread.modelSelection,
          runs: evidence,
          skipped,
        });
      }
      if (decision.type === "pause" && decision.reason === "exhausted" && skipped.length > 0) {
        const unsupported = decideFromProjection({
          enabled: true,
          models: preferences.modelFallback.models,
          unavailableInstanceIds,
          continuation: "unsupported",
          current: projection.thread.modelSelection,
          runs: evidence,
          skipped: [],
        });
        if (unsupported.type === "pause") decision = unsupported;
      }
      const run = latestExecutedRun(projection.runs);
      if (run === null || decision.type === "leave-paused") continue;
      const command = yield* nextModelFallbackCommand(
        { threadId: candidate.id, runId: run.id, decision },
        commandReceipts.getByCommandId,
      );
      if (command === null) continue;
      yield* threads.dispatch(command).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("model-fallback.sweep-dispatch-failed", {
            threadId: candidate.id,
            cause,
          }),
        ),
      );
    }
  });
});

export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const sweep = yield* makeSweep;
    const scheduler = yield* Scheduler.Scheduler;
    yield* scheduler.register("model-fallback", sweep());
  }),
);
