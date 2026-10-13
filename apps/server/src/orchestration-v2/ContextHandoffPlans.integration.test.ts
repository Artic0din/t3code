import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  ClaudeSettings,
  CursorSettings,
  ProviderDriverKind,
  ProviderInstanceId,
} from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import * as ServerConfig from "../config.ts";
import { makeClaudeAdapterV2 } from "./Adapters/ClaudeAdapterV2.ts";
import { makeCursorAdapterV2 } from "./Adapters/CursorAdapterV2.ts";
import { historicalMessage, selectHistory } from "./ContextHandoffBudget.ts";
import * as IdAllocator from "./IdAllocator.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import { provideDeterministicTestRuntime } from "./testkit/DeterministicRuntime.ts";
import { runOrchestratorV2Scenario } from "./testkit/OrchestratorScenario.ts";
import { layerWithRegistry } from "./testkit/ProviderReplayHarness.ts";
import { materializeFixtureInput } from "./testkit/fixtures/shared.ts";

const nativeSessionId = "00000000-0000-4000-8000-000000000701";
const decodeClaudeSettings = Schema.decodeEffect(ClaudeSettings);
const decodeCursorSettings = Schema.decodeEffect(CursorSettings);

function claudeTodoFrames(turn: number, firstCompleted: boolean): ReadonlyArray<SDKMessage> {
  const callId = `handoff-todo-${turn}`;
  const content = turn === 1 ? "OLD_CHECKLIST" : "CURRENT_CHECKLIST";
  return [
    {
      type: "assistant",
      message: {
        model: "claude-sonnet-4-6",
        id: `msg_todo_${turn}`,
        type: "message",
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: callId,
            name: "TodoWrite",
            input: {
              todos: [{ content, status: turn === 1 && firstCompleted ? "completed" : "pending" }],
            },
          },
        ],
        stop_reason: "tool_use",
        stop_sequence: null,
        usage: {
          input_tokens: 1,
          output_tokens: 1,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
        },
      },
      parent_tool_use_id: null,
      uuid: `00000000-0000-4000-8000-00000000071${turn}`,
      session_id: nativeSessionId,
    },
    {
      type: "user",
      message: {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: callId, content: "ok" }],
      },
      parent_tool_use_id: null,
      uuid: `00000000-0000-4000-8000-00000000072${turn}`,
      session_id: nativeSessionId,
    },
    {
      type: "result",
      subtype: "success",
      is_error: false,
      result: `Recorded checklist ${turn}.`,
      num_turns: 1,
      stop_reason: "end_turn",
      duration_ms: 1,
      duration_api_ms: 1,
      total_cost_usd: 0,
      usage: {
        input_tokens: 1,
        output_tokens: 1,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
      },
      modelUsage: {},
      permission_denials: [],
      uuid: `00000000-0000-4000-8000-00000000073${turn}`,
      session_id: nativeSessionId,
    },
  ] as ReadonlyArray<SDKMessage>;
}

function todoRegistry(driver: "claudeAgent" | "cursor", firstCompleted: boolean) {
  return Layer.unwrap(
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const workspace = yield* fileSystem.makeTempDirectoryScoped({ prefix: "handoff-todo-" });
      const instanceId = ProviderInstanceId.make(driver);
      const idAllocator = yield* IdAllocator.IdAllocatorV2;
      let turn = 0;
      if (driver === "claudeAgent") {
        const frames = yield* Queue.unbounded<SDKMessage>();
        return ProviderAdapterRegistry.layerFromAdapters([
          makeClaudeAdapterV2({
            instanceId,
            settings: yield* decodeClaudeSettings({}),
            environment: { HOME: workspace },
            attachmentsDir: workspace,
            fileSystem,
            path,
            crypto: yield* Crypto.Crypto,
            idAllocator,
            queryRunner: {
              allocateSessionId: Effect.succeed(nativeSessionId),
              open: () =>
                Effect.succeed({
                  messages: Stream.fromQueue(frames),
                  offer: () =>
                    Effect.gen(function* () {
                      yield* Queue.offerAll(frames, claudeTodoFrames(++turn, firstCompleted));
                    }),
                  setModel: () => Effect.void,
                  setPermissionMode: () => Effect.void,
                  interrupt: Effect.void,
                  close: Effect.void,
                }),
              forkSession: () => Effect.die("unused forkSession"),
              subagentLaunchToolUseId: () => Effect.succeed(null),
              assertComplete: Effect.void,
            },
          }),
        ]);
      }
      return ProviderAdapterRegistry.layerFromAdapters([
        makeCursorAdapterV2({
          instanceId,
          settings: yield* decodeCursorSettings({}),
          environment: { HOME: workspace },
          fileSystem,
          path,
          idAllocator,
          serverConfig: yield* ServerConfig.ServerConfig.pipe(
            Effect.provide(ServerConfig.layerTest(workspace, { prefix: "handoff-todo-config-" })),
          ),
          runner: {
            assertComplete: Effect.void,
            open: () =>
              Effect.succeed({
                agentId: "handoff-todo-cursor",
                listMessages: Effect.succeed([]),
                close: Effect.void,
                send: (input) =>
                  Effect.gen(function* () {
                    turn += 1;
                    const nativeRunId = `handoff-todo-cursor-${turn}`;
                    const todos = [
                      {
                        content: turn === 1 ? "OLD_CHECKLIST" : "CURRENT_CHECKLIST",
                        status:
                          turn === 1 && firstCompleted
                            ? ("completed" as const)
                            : ("pending" as const),
                      },
                    ];
                    for (const type of ["tool-call-started", "tool-call-completed"] as const) {
                      if (input.onDelta !== undefined)
                        yield* input
                          .onDelta({
                            type,
                            modelCallId: `model-${turn}`,
                            callId: `handoff-todo-${turn}`,
                            toolCall: {
                              type: "updateTodos",
                              args: { todos },
                              ...(type === "tool-call-completed"
                                ? { result: { status: "success", value: { todos, totalCount: 1 } } }
                                : {}),
                            },
                          })
                          .pipe(Effect.orDie);
                    }
                    return {
                      agentId: "handoff-todo-cursor",
                      runId: nativeRunId,
                      wait: Effect.succeed({
                        id: nativeRunId,
                        requestId: `request-${turn}`,
                        status: "finished" as const,
                        model: { id: "composer-2.5" },
                        durationMs: 1,
                      }),
                      cancel: Effect.void,
                    };
                  }),
              }),
          },
        }),
      ]);
    }),
  ).pipe(Layer.provide(Layer.merge(NodeServices.layer, IdAllocator.layer)));
}

it.effect.each([
  { driver: "claudeAgent", firstCompleted: false },
  { driver: "cursor", firstCompleted: false },
  { driver: "claudeAgent", firstCompleted: true },
  { driver: "cursor", firstCompleted: true },
] as const)(
  "persists replacement $driver checklists, prior completed=$firstCompleted",
  ({ driver, firstCompleted }) =>
    Effect.gen(function* () {
      const name = `handoff-todo-${driver}`;
      const modelSelection = {
        instanceId: ProviderInstanceId.make(driver),
        model: driver === "cursor" ? "composer-2.5" : "claude-sonnet-4-6",
      };
      const scenario = yield* materializeFixtureInput({
        scenario: name,
        driver: ProviderDriverKind.make(driver),
        modelSelection,
        fixtureInput: {
          steps: [
            { type: "message", text: "Record the old checklist." },
            { type: "message", text: "Replace the checklist." },
          ],
        },
      }).pipe(Effect.provide(IdAllocator.layer));
      const result = yield* runOrchestratorV2Scenario({ name, ...scenario }).pipe(
        Effect.provide(layerWithRegistry({ name }, todoRegistry(driver, firstCompleted))),
      );
      const projection = result.projections.get(scenario.projectionThreadIds[0]!)!;
      const items = projection.turnItems.filter((item) => item.type === "todo_list");
      assert.equal(projection.runs.length, 2);
      assert.deepEqual(
        projection.runs.map((run) => run.status),
        ["completed", "completed"],
      );
      assert.deepEqual(
        items.map((item) => item.status),
        [firstCompleted ? "completed" : "cancelled", "completed"],
      );
      assert.notEqual(items[0]!.runId, items[1]!.runId);
      assert.notEqual(items[0]!.planId, items[1]!.planId);
      assert.deepEqual(
        projection.plans.map((plan) => plan.status),
        [firstCompleted ? "completed" : "superseded", "active"],
      );
      assert.equal(
        result.domainEvents.filter(
          (event) =>
            event.type === "turn-item.updated" &&
            event.payload.type === "todo_list" &&
            event.payload.status === "cancelled",
        ).length,
        firstCompleted ? 0 : 1,
      );
      const history = selectHistory({
        messages: items.flatMap((item) => {
          const message = historicalMessage(item);
          return message === null ? [] : [message];
        }),
        coverage: "Persisted checklist history.",
        budget: 16_000,
      });
      assert.deepEqual(
        history.messages.map((message) => message.text),
        firstCompleted
          ? ["completed: OLD_CHECKLIST", "pending: CURRENT_CHECKLIST"]
          : ["pending: CURRENT_CHECKLIST"],
      );
    }).pipe(provideDeterministicTestRuntime),
);
