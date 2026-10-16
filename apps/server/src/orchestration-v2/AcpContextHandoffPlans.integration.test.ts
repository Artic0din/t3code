import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { ProviderDriverKind, type ProviderReplayEntry } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import * as SqlitePersistence from "../persistence/Sqlite.ts";
import type { AcpReplayTranscript } from "./Adapters/AcpAdapterV2.testkit.ts";
import { AcpRegistryOrchestratorReplayHarness } from "./Adapters/AcpRegistryAdapterV2.testkit.ts";
import { ACP_REGISTRY_DEFAULT_INSTANCE_ID } from "./Adapters/AcpRegistryAdapterV2.ts";
import { historicalMessage, selectHistory } from "./ContextHandoffBudget.ts";
import * as IdAllocator from "./IdAllocator.ts";
import { provideDeterministicTestRuntime } from "./testkit/DeterministicRuntime.ts";
import { multiTurnInput } from "./testkit/fixtures/multi_turn/input.ts";
import { materializeFixtureInput } from "./testkit/fixtures/shared.ts";
import {
  runOrchestratorV2ProviderReplayScenario,
  type OrchestratorV2ProviderReplayScenario,
} from "./testkit/ProviderReplayHarness.ts";
import {
  materializeReplayTranscriptRuntimeInstructions,
  readProviderReplayTranscript,
} from "./testkit/ReplayTranscriptNdjson.ts";

const nativePlanId = "plan:A / é";

function planUpdate(label: string, update: unknown): ProviderReplayEntry {
  return {
    type: "emit_inbound",
    label,
    frame: {
      kind: "notification",
      method: "session/update",
      params: { sessionId: "grok-replay-session-1", update },
    },
  };
}

const runReopened = Effect.fnUntraced(function* (
  scenario: OrchestratorV2ProviderReplayScenario<AcpReplayTranscript>,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const directory = yield* fs.makeTempDirectoryScoped({ prefix: "acp-plan-reopen-" });
  const databaseLayer = SqlitePersistence.layerFromPath(path.join(directory, "state.sqlite")).pipe(
    Layer.provide(NodeServices.layer),
  );
  const promptIndex = scenario.transcript.entries.findIndex(
    (entry) => entry.type === "expect_outbound" && entry.label === "second.prompt",
  );
  const steps = scenario.steps ?? [];
  const firstIdle = steps.findIndex((step) => step.type === "await_thread_idle");
  const runPhase = (phaseSteps: typeof steps, entries: ReadonlyArray<ProviderReplayEntry>) =>
    Effect.scoped(
      runOrchestratorV2ProviderReplayScenario(
        {
          ...scenario,
          steps: phaseSteps,
          commands: phaseSteps.flatMap((step) => (step.type === "dispatch" ? [step.command] : [])),
          transcript: { ...scenario.transcript, entries },
        },
        AcpRegistryOrchestratorReplayHarness,
        { databaseLayer },
      ),
    );
  yield* runPhase(steps.slice(0, firstIdle + 1), [
    ...scenario.transcript.entries.slice(0, promptIndex),
    { type: "runtime_exit", status: "success" },
  ]);
  return yield* runPhase(steps.slice(firstIdle + 1), [
    ...scenario.transcript.entries.slice(0, 2),
    {
      type: "expect_outbound",
      label: "session.load",
      frame: {
        kind: "request",
        method: "session/load",
        params: { sessionId: "grok-replay-session-1", cwd: "<workspace>", mcpServers: "<any>" },
      },
    },
    {
      type: "emit_inbound",
      label: "session.loaded",
      frame: {
        kind: "response",
        method: "session/load",
        result: {
          sessionId: "grok-replay-session-1",
          models: {
            currentModelId: "grok-build",
            availableModels: [{ modelId: "grok-build", name: "Grok Build" }],
          },
        },
      },
    },
    ...scenario.transcript.entries.slice(promptIndex).map((entry) => {
      if (entry.type !== "expect_outbound" || entry.label !== "second.prompt") return entry;
      const frame = entry.frame;
      if (typeof frame !== "object" || frame === null || !("params" in frame)) return entry;
      const params = frame.params;
      if (
        typeof params !== "object" ||
        params === null ||
        !("prompt" in params) ||
        !Array.isArray(params.prompt)
      )
        return entry;
      return {
        ...entry,
        frame: {
          ...frame,
          params: {
            ...params,
            prompt: [
              {
                type: "text",
                text: "<t3_code_instructions>\n<any>\n</t3_code_instructions>\n\n<user_request>\nRespond with exactly: second fixture turn complete\n</user_request>",
              },
              ...params.prompt.slice(1),
            ],
          },
        },
      };
    }),
  ]);
});

const cases = [
  { action: "update", initialKind: "items", firstCompleted: false },
  { action: "update", initialKind: "markdown", firstCompleted: false },
  { action: "update", initialKind: "items", firstCompleted: true },
  { action: "remove", initialKind: "items", firstCompleted: false },
  { action: "remove", initialKind: "items", firstCompleted: true },
  { action: "legacy-empty", initialKind: "items", firstCompleted: false },
  { action: "remove", initialKind: "items", firstCompleted: true, reopen: true },
] as const;

it.effect.each(cases)(
  "persists ACP $action with prior $initialKind, completed=$firstCompleted",
  (testCase) =>
    Effect.gen(function* () {
      const { action, initialKind, firstCompleted } = testCase;
      const reopen = "reopen" in testCase && testCase.reopen;
      const legacy = action === "legacy-empty";
      const planId = legacy ? "legacy" : nativePlanId;
      const name = `acp-plan-${action}-${initialKind}-${firstCompleted}`;
      const modelSelection = {
        instanceId: ACP_REGISTRY_DEFAULT_INSTANCE_ID,
        model: "grok-build",
      };
      const input = yield* materializeFixtureInput({
        scenario: name,
        driver: ProviderDriverKind.make("acpRegistry"),
        modelSelection,
        fixtureInput: multiTurnInput(),
      }).pipe(Effect.provide(IdAllocator.layer));
      const recorded = yield* readProviderReplayTranscript(
        new URL("./testkit/fixtures/multi_turn/registry_transcript.ndjson", import.meta.url),
      ).pipe(Effect.provide(NodeServices.layer));
      const oldEntries = [
        { content: "OLD_A", priority: "high", status: firstCompleted ? "completed" : "pending" },
      ];
      const firstA = legacy
        ? { sessionUpdate: "plan", entries: oldEntries }
        : {
            sessionUpdate: "plan_update",
            plan:
              initialKind === "items"
                ? { type: "items", planId, entries: oldEntries }
                : { type: "markdown", planId, content: "OLD_A" },
          };
      const secondA = legacy
        ? { sessionUpdate: "plan", entries: [] }
        : action === "remove"
          ? { sessionUpdate: "plan_removed", planId }
          : {
              sessionUpdate: "plan_update",
              plan:
                initialKind === "items"
                  ? { type: "markdown", planId, content: "CURRENT_A" }
                  : {
                      type: "items",
                      planId,
                      entries: [{ content: "CURRENT_A", priority: "high", status: "pending" }],
                    },
            };
      const entries = recorded.entries.flatMap((entry): ReadonlyArray<ProviderReplayEntry> => {
        if (entry.type === "emit_inbound" && entry.label === "initialized") {
          return [
            {
              ...entry,
              frame: {
                kind: "response",
                method: "initialize",
                result: {
                  protocolVersion: 2,
                  agentCapabilities: {
                    loadSession: true,
                    mcpCapabilities: { http: true, sse: true },
                  },
                  authMethods: [{ id: "replay", name: "Replay" }],
                },
              },
            },
          ];
        }
        if (entry.type === "emit_inbound" && entry.label === "first.completed") {
          return [
            planUpdate("first.plan-a", firstA),
            planUpdate("first.plan-b", {
              sessionUpdate: "plan_update",
              plan: { type: "markdown", planId: "plan:B", content: "INDEPENDENT_B" },
            }),
            entry,
          ];
        }
        return entry.type === "emit_inbound" && entry.label === "second.completed"
          ? [planUpdate("second.plan-a", secondA), entry]
          : [entry];
      });
      const transcript = yield* AcpRegistryOrchestratorReplayHarness.decodeTranscript(
        materializeReplayTranscriptRuntimeInstructions(
          { ...recorded, scenario: name, entries },
          {
            driver: ProviderDriverKind.make("acpRegistry"),
            model: modelSelection.model,
          },
        ),
      );
      const scenario = { name, ...input, transcript };
      const result = yield* reopen
        ? runReopened(scenario).pipe(Effect.provide(NodeServices.layer), Effect.scoped)
        : runOrchestratorV2ProviderReplayScenario(scenario, AcpRegistryOrchestratorReplayHarness);
      const projection = result.projections.get(input.projectionThreadIds[0]!)!;
      assert.deepEqual(
        projection.runs.map((run) => run.status),
        ["completed", "completed"],
      );
      const plans = projection.turnItems.filter(
        (item) => item.type === "todo_list" || item.type === "proposed_plan",
      );
      const expectedOldStatus = action === "update" && firstCompleted ? "completed" : "cancelled";
      assert.deepEqual(
        plans.map((item) => item.status),
        action === "remove"
          ? [expectedOldStatus, "running"]
          : [expectedOldStatus, "running", "running"],
      );
      assert.equal(new Set(plans.map((item) => item.planId)).size, plans.length);
      assert.equal(
        plans[0]!.nativeItemRef!.nativeId!.endsWith(`:plan:${encodeURIComponent(planId)}`),
        true,
      );
      assert.equal(plans[1]!.nativeItemRef!.nativeId!.endsWith(":plan:plan%3AB"), true);
      const history = selectHistory({
        messages: plans.flatMap((item) => {
          const message = historicalMessage(item);
          return message === null ? [] : [message];
        }),
        coverage: "Persisted ACP plan history.",
        budget: 16_000,
      });
      const currentText = initialKind === "items" ? "CURRENT_A" : "pending: CURRENT_A";
      assert.deepEqual(
        history.messages.map((message) => message.text),
        action === "update"
          ? [...(firstCompleted ? ["completed: OLD_A"] : []), "INDEPENDENT_B", currentText]
          : legacy
            ? ["INDEPENDENT_B", ""]
            : ["INDEPENDENT_B"],
      );
      assert.deepEqual(
        plans.map((item) => projection.plans.find((plan) => plan.id === item.planId)!.status),
        action === "remove"
          ? ["superseded", "active"]
          : [firstCompleted ? "completed" : "superseded", "active", "active"],
      );
    }).pipe(provideDeterministicTestRuntime),
);
