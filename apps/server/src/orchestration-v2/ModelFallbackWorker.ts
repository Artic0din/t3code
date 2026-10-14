import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as Scheduler from "../scheduling/Scheduler.ts";
import { OrchestratorV2 } from "./Orchestrator.ts";

export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const orchestrator = yield* OrchestratorV2;
    const scheduler = yield* Scheduler.Scheduler;
    yield* scheduler.register("model-fallback", orchestrator.recoverModelFallbacks);
  }),
);
