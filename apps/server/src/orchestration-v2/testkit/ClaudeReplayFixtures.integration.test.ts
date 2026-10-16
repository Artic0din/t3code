import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import {
  CommandId,
  isProviderNativeSubagentThread,
  MessageId,
  ProviderDriverKind,
  type ProviderReplayTranscript,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Stream from "effect/Stream";

import { classifyClaudeNativeTool } from "../Adapters/ClaudeAdapterV2.ts";
import { ClaudeOrchestratorReplayHarness } from "../Adapters/ClaudeAdapterV2.testkit.ts";
import * as IdAllocator from "../IdAllocator.ts";
import * as Orchestrator from "../Orchestrator.ts";
import * as EventSink from "../EventSink.ts";
import * as EffectWorker from "../EffectWorker.ts";
import { userFacingDispatchErrorMessage } from "../UserFacingErrors.ts";
import { provideDeterministicTestRuntime } from "./DeterministicRuntime.ts";
import { ORCHESTRATOR_REPLAY_FIXTURES } from "./fixtures/index.ts";
import { subagentInput } from "./fixtures/subagent/input.ts";
import { runOrchestratorV2Scenario } from "./OrchestratorScenario.ts";
import * as ProviderReplayHarness from "./ProviderReplayHarness.ts";
import { materializeReplayTranscriptRuntimeInstructions } from "./ReplayTranscriptNdjson.ts";
import { CLAUDE_MODEL_SELECTION, materializeFixtureInput } from "./fixtures/shared.ts";
import {
  THREAD_FORK_NATIVE_CONTINUE_FORK_MARKER,
  THREAD_FORK_NATIVE_CONTINUE_RECALL,
  THREAD_FORK_NATIVE_CONTINUE_SOURCE_MARKER,
  THREAD_MERGE_BACK_FORK_MARKER,
  THREAD_MERGE_BACK_RECALL,
  THREAD_MERGE_BACK_SIBLINGS_FIRST_MARKER,
  THREAD_MERGE_BACK_SIBLINGS_RECALL,
  THREAD_MERGE_BACK_SIBLINGS_SECOND_MARKER,
  THREAD_MERGE_BACK_SIBLINGS_SOURCE_MARKER,
  THREAD_MERGE_BACK_SOURCE_MARKER,
} from "./fixtures/shared.ts";
import { readProviderReplayTranscript } from "./ReplayTranscriptNdjson.ts";
import { makeProviderReplayGate } from "./ProviderReplayGate.testkit.ts";

const readTranscript = Effect.fn("readClaudeReplayFixture")(function* (file: URL) {
  return yield* readProviderReplayTranscript(file);
}, Effect.provide(NodeServices.layer));

function readClaudeTranscriptFixture(path: string) {
  return readTranscript(new URL(`./fixtures/${path}/claude_transcript.ndjson`, import.meta.url));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function metadataString(transcript: ProviderReplayTranscript, key: string): string {
  const value = transcript.metadata?.[key];
  if (typeof value !== "string") {
    throw new Error(`${transcript.scenario} metadata.${key} must be a string.`);
  }
  return value;
}

function metadataStringArray(
  transcript: ProviderReplayTranscript,
  key: string,
): ReadonlyArray<string> {
  const value = transcript.metadata?.[key];
  if (!Array.isArray(value) || !value.every((entry) => typeof entry === "string")) {
    throw new Error(`${transcript.scenario} metadata.${key} must be a string array.`);
  }
  return value;
}

type FramedReplayEntry = Extract<
  ProviderReplayTranscript["entries"][number],
  { readonly frame: unknown }
>;

function frameRecord(entry: FramedReplayEntry): Record<string, unknown> {
  if (!isRecord(entry.frame)) {
    throw new Error("Replay entry frame must be an object.");
  }
  return entry.frame;
}

function findEntryFrame(
  transcript: ProviderReplayTranscript,
  label: string,
): Record<string, unknown> {
  const entry = transcript.entries.find(
    (candidate): candidate is FramedReplayEntry =>
      "label" in candidate && candidate.label === label && "frame" in candidate,
  );
  assert.isDefined(entry, `${transcript.scenario} must include replay entry ${label}`);
  return frameRecord(entry);
}

function successResultTexts(transcript: ProviderReplayTranscript): ReadonlyArray<string> {
  return transcript.entries.flatMap((entry) => {
    if (entry.type !== "emit_inbound" || !isRecord(entry.frame)) {
      return [];
    }
    if (entry.frame.type !== "result" || entry.frame.subtype !== "success") {
      return [];
    }
    return typeof entry.frame.result === "string" ? [entry.frame.result] : [];
  });
}

function claudeToolUseNamesFromTranscript(
  transcript: ProviderReplayTranscript,
): ReadonlyArray<string> {
  return transcript.entries.flatMap((entry) => {
    if (
      entry.type !== "emit_inbound" ||
      !isRecord(entry.frame) ||
      entry.frame.type !== "assistant"
    ) {
      return [];
    }

    const message = entry.frame.message;
    const content = isRecord(message) ? message.content : undefined;
    if (!Array.isArray(content)) {
      return [];
    }

    return content.flatMap((part) =>
      isRecord(part) &&
      typeof part.id === "string" &&
      typeof part.name === "string" &&
      "input" in part
        ? [part.name]
        : [],
    );
  });
}

describe("Claude Agent SDK replay fixtures", () => {
  it.effect(
    "persists native child quota failure and explains unsupported continuation while the parent stays active",
    () =>
      Effect.gen(function* () {
        const raw = yield* readClaudeTranscriptFixture("subagent");
        const terminalEntry = raw.entries.find(
          (entry): entry is FramedReplayEntry =>
            entry.type === "emit_inbound" &&
            isRecord(entry.frame) &&
            entry.frame.subtype === "task_notification",
        );
        assert.isDefined(terminalEntry);
        const terminal = frameRecord(terminalEntry);
        const childAssistant = raw.entries.find(
          (entry): entry is FramedReplayEntry =>
            entry.type === "emit_inbound" &&
            isRecord(entry.frame) &&
            entry.frame.type === "assistant" &&
            entry.frame.parent_tool_use_id === terminal.tool_use_id,
        );
        assert.isDefined(childAssistant);
        const childFrame = frameRecord(childAssistant);
        assert.isTrue(isRecord(childFrame.message));
        const message = isRecord(childFrame.message) ? childFrame.message : {};
        const failedFrame = {
          ...terminal,
          status: "failed",
          summary: "You've hit your weekly limit",
        };
        const entries = raw.entries.flatMap((entry) => {
          if (entry === terminalEntry)
            return [
              {
                type: "emit_inbound" as const,
                frame: {
                  ...childFrame,
                  uuid: "00000000-0000-4000-8000-000000000101",
                  error: "rate_limit",
                  message: {
                    ...message,
                    id: "native-quota-assistant",
                    content: [{ type: "text", text: "You've hit your weekly limit" }],
                  },
                },
              },
              { ...entry, frame: failedFrame },
              { ...entry, frame: { ...failedFrame, uuid: "00000000-0000-4000-8000-000000000102" } },
            ];
          if (
            entry.type === "emit_inbound" &&
            isRecord(entry.frame) &&
            entry.frame.type === "result"
          )
            return [{ ...entry, label: "native-quota:parent-result" }];
          return [entry];
        });
        const transcript = yield* ClaudeOrchestratorReplayHarness.decodeTranscript(
          materializeReplayTranscriptRuntimeInstructions(
            { ...raw, entries },
            { driver: ProviderDriverKind.make("claudeAgent"), model: CLAUDE_MODEL_SELECTION.model },
          ),
        );
        const materialized = yield* materializeFixtureInput({
          scenario: "subagent",
          fixtureInput: subagentInput(),
          driver: ProviderDriverKind.make("claudeAgent"),
          modelSelection: CLAUDE_MODEL_SELECTION,
        }).pipe(Effect.provide(IdAllocator.layer), provideDeterministicTestRuntime);
        const scenario = {
          name: "subagent/claudeAgent:native-quota",
          transcript,
          commands: materialized.commands,
          steps: materialized.steps,
          projectionThreadIds: materialized.projectionThreadIds,
        };
        const gate = makeProviderReplayGate(["native-quota:parent-result"]);
        yield* Effect.gen(function* () {
          yield* Effect.addFinalizer(() => Effect.sync(() => gate.releaseAll()));
          const sink = yield* EventSink.EventSinkV2;
          const orchestrator = yield* Orchestrator.OrchestratorV2;
          const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
          const nativeFailed = yield* sink.stream({ eventType: "subagent.updated" }).pipe(
            Stream.filter(
              ({ event }) =>
                event.type === "subagent.updated" &&
                event.payload.nativeTaskRef?.nativeId === terminal.task_id &&
                event.payload.status === "failed",
            ),
            Stream.take(1),
            Stream.runDrain,
            Effect.forkScoped,
          );
          const executing = yield* runOrchestratorV2Scenario(scenario).pipe(Effect.forkScoped);
          yield* Fiber.join(nativeFailed);
          const parentId = materialized.projectionThreadIds[0];
          assert.isDefined(parentId);
          const parent = yield* orchestrator.getThreadProjection(parentId);
          const task = parent.subagents.find(
            (row) => row.nativeTaskRef?.nativeId === terminal.task_id,
          );
          assert.isDefined(task);
          assert.equal(task.failure?.class, "usage_limit");
          assert.isNotNull(task.childThreadId);
          const child = yield* orchestrator.getThreadProjection(task.childThreadId);
          assert.lengthOf(child.runs, 0);
          assert.isTrue(isProviderNativeSubagentThread(child.thread));
          assert.equal(parent.runs[0]?.status, "running");
          assert.deepEqual(parent.thread.modelSelection, CLAUDE_MODEL_SELECTION);
          const notices = parent.turnItems.filter(
            (item) => item.type === "system_notice" && item.nodeId === task.id,
          );
          assert.lengthOf(notices, 1);
          assert.include(
            notices[0]?.type === "system_notice" ? notices[0].message : "",
            "cannot safely continue",
          );
          assert.isFalse(
            parent.turnItems.some(
              (item) =>
                item.type === "error" &&
                item.nodeId === parent.runs[0]?.rootNodeId &&
                item.failure?.class === "usage_limit",
            ),
          );
          gate.releaseAll();
          yield* Fiber.join(executing);
          yield* worker.drain();
          const settled = yield* orchestrator.getThreadProjection(parentId);
          assert.lengthOf(settled.runs, 1);
          assert.equal(settled.runs[0]?.status, "completed");
          assert.lengthOf(
            settled.turnItems.filter(
              (item) => item.type === "system_notice" && item.nodeId === task.id,
            ),
            1,
          );
          assert.lengthOf(
            settled.contextTransfers.filter((transfer) => transfer.type === "subagent_result"),
            0,
          );
        }).pipe(
          Effect.provide(
            ProviderReplayHarness.layerProviderReplay(scenario, ClaudeOrchestratorReplayHarness, {
              replayGate: gate,
              modelFallback: { enabled: true, models: [CLAUDE_MODEL_SELECTION] },
            }),
          ),
          provideDeterministicTestRuntime,
          Effect.scoped,
        );
      }),
  );

  it.effect("refuses messages to a native subagent thread without touching it", () =>
    Effect.gen(function* () {
      const raw = yield* readClaudeTranscriptFixture("subagent");
      const transcript = yield* ClaudeOrchestratorReplayHarness.decodeTranscript(
        materializeReplayTranscriptRuntimeInstructions(raw, {
          driver: ProviderDriverKind.make("claudeAgent"),
          model: CLAUDE_MODEL_SELECTION.model,
        }),
      );
      const materialized = yield* materializeFixtureInput({
        scenario: "subagent",
        fixtureInput: subagentInput(),
        driver: ProviderDriverKind.make("claudeAgent"),
        modelSelection: CLAUDE_MODEL_SELECTION,
      }).pipe(Effect.provide(IdAllocator.layer), provideDeterministicTestRuntime);
      const scenario = {
        name: "subagent/claudeAgent:read-only-child",
        transcript,
        commands: materialized.commands,
        steps: materialized.steps,
        projectionThreadIds: materialized.projectionThreadIds,
      };
      yield* Effect.gen(function* () {
        const result = yield* runOrchestratorV2Scenario(scenario);
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const child = [...result.projections.values()].find((projection) =>
          isProviderNativeSubagentThread(projection.thread),
        );
        assert.isDefined(child);
        const before = yield* orchestrator.getThreadEventSequence(child.thread.id);

        const refused = yield* orchestrator
          .dispatch({
            type: "message.dispatch",
            createdBy: "user",
            creationSource: "web",
            commandId: CommandId.make("command:subagent:message-native-child"),
            threadId: child.thread.id,
            messageId: MessageId.make("message:subagent:message-native-child"),
            text: "Also check the tests.",
            attachments: [],
            dispatchMode: { type: "start_immediately" },
          })
          .pipe(Effect.flip);
        assert.equal(refused._tag, "OrchestratorSubagentThreadReadOnlyError");
        // The wire error carries this text to the web toast and mobile outbox.
        assert.equal(
          userFacingDispatchErrorMessage(refused),
          "This subagent is run by its provider and cannot take messages. Message the parent thread instead.",
        );
        assert.equal(yield* orchestrator.getThreadEventSequence(child.thread.id), before);
        const after = yield* orchestrator.getThreadProjection(child.thread.id);
        assert.lengthOf(after.runs, 0);
        assert.deepEqual(after.messages, child.messages);
      }).pipe(
        Effect.provide(
          ProviderReplayHarness.layerProviderReplay(scenario, ClaudeOrchestratorReplayHarness),
        ),
        provideDeterministicTestRuntime,
        Effect.scoped,
      );
    }),
  );

  it.effect("classifies every Claude fixture tool use through the native tool table", () =>
    Effect.gen(function* () {
      const unknownToolNames = new Set<string>();
      const seenToolNames = new Set<string>();

      for (const fixture of ORCHESTRATOR_REPLAY_FIXTURES) {
        for (const provider of fixture.providers) {
          if (provider.driver !== "claudeAgent") {
            continue;
          }

          const transcript = yield* readTranscript(provider.transcriptFile);
          for (const toolName of claudeToolUseNamesFromTranscript(transcript)) {
            seenToolNames.add(toolName);
            const classification = classifyClaudeNativeTool(toolName);
            // MCP tools are open-ended and deliberately become dynamic tools.
            if (!classification.known && !toolName.startsWith("mcp__")) {
              unknownToolNames.add(`${fixture.name}:${toolName}`);
            }
          }
        }
      }

      assert.isAtLeast(seenToolNames.size, 1, "expected Claude fixtures to contain tool uses");
      assert.deepEqual([...unknownToolNames], []);
    }),
  );

  it.effect("keeps unregistered native conversation-state transcripts reviewable", () =>
    Effect.gen(function* () {
      const rollback = yield* readClaudeTranscriptFixture("thread_rollback");
      assert.equal(rollback.metadata?.queryMode, "resume_at_cursor");
      const rollbackCursor = metadataString(rollback, "resumeSessionAt");
      const rollbackResumeFrame = findEntryFrame(rollback, "query.open:resume_at_cursor");
      const rollbackResumeOptions = rollbackResumeFrame.options;
      if (!isRecord(rollbackResumeOptions)) {
        throw new Error("Rollback resume query.open options must be an object.");
      }
      assert.equal(rollbackResumeOptions.resumeSessionAt, rollbackCursor);
      const rollbackFinalText = successResultTexts(rollback).at(-1) ?? "";
      assert.include(rollbackFinalText, "rollback fixture first turn complete");
      assert.notInclude(rollbackFinalText, "rollback fixture second turn complete");

      const latestFork = yield* readClaudeTranscriptFixture("thread_fork_native");
      assert.equal(latestFork.metadata?.queryMode, "fork_session");
      const latestForkedSessionId = metadataString(latestFork, "forkedNativeSessionId");
      const latestForkedFrame = findEntryFrame(latestFork, "session.forked");
      assert.equal(latestForkedFrame.sessionId, latestForkedSessionId);

      const priorFork = yield* readClaudeTranscriptFixture("thread_fork_native_prior_turn");
      assert.equal(priorFork.metadata?.queryMode, "fork_session_prior_turn");
      const priorForkCursor = metadataString(priorFork, "forkUpToMessageId");
      const priorForkFrame = findEntryFrame(priorFork, "session.fork");
      const priorForkOptions = priorForkFrame.options;
      if (!isRecord(priorForkOptions)) {
        throw new Error("Prior-turn fork options must be an object.");
      }
      assert.equal(priorForkOptions.upToMessageId, priorForkCursor);
      const priorForkFinalText = successResultTexts(priorFork).at(-1) ?? "";
      assert.include(priorForkFinalText, "fork boundary alpha");
      assert.notInclude(priorForkFinalText, "fork boundary beta");

      const continuedFork = yield* readClaudeTranscriptFixture("thread_fork_native_continue");
      assert.equal(continuedFork.metadata?.queryMode, "fork_session_continue");
      const continuedForkSessionId = metadataString(continuedFork, "forkedNativeSessionId");
      const continuedForkOpenFrame = findEntryFrame(continuedFork, "query.open:fork");
      const continuedForkOptions = continuedForkOpenFrame.options;
      if (!isRecord(continuedForkOptions)) {
        throw new Error("Continued fork query.open options must be an object.");
      }
      assert.equal(continuedForkOptions.resume, continuedForkSessionId);
      const continuedForkResults = successResultTexts(continuedFork);
      assert.deepEqual(continuedForkResults.slice(0, 2), [
        "source marker stored",
        "fork marker stored",
      ]);
      assert.equal(
        continuedForkResults.at(-1)?.replace(/\s*\|\s*/u, "|"),
        THREAD_FORK_NATIVE_CONTINUE_RECALL,
      );
      const recallPromptFrame = findEntryFrame(continuedFork, "prompt.offer:3");
      const recallMessage = recallPromptFrame.message;
      const recallMessageBody = isRecord(recallMessage) ? recallMessage.message : undefined;
      const recallPrompt =
        isRecord(recallMessageBody) && typeof recallMessageBody.content === "string"
          ? recallMessageBody.content
          : "";
      assert.notInclude(recallPrompt, THREAD_FORK_NATIVE_CONTINUE_SOURCE_MARKER);
      assert.notInclude(recallPrompt, THREAD_FORK_NATIVE_CONTINUE_FORK_MARKER);

      const siblingForks = yield* readClaudeTranscriptFixture("thread_fork_native_siblings");
      assert.equal(siblingForks.metadata?.queryMode, "fork_session_siblings");
      const siblingSessionIds = metadataStringArray(siblingForks, "forkedNativeSessionIds");
      assert.lengthOf(siblingSessionIds, 2);
      assert.notEqual(siblingSessionIds[0], siblingSessionIds[1]);
      const siblingResults = successResultTexts(siblingForks).map((text) =>
        text.replace(/\s*\|\s*/u, "|"),
      );
      assert.deepEqual(siblingResults, [
        "sibling source stored",
        "sibling-source-8R3D|sibling-first-5L2P",
        "sibling-source-8R3D|sibling-second-9N6C",
      ]);
      assert.notInclude(siblingResults[1] ?? "", "sibling-second-9N6C");
      assert.notInclude(siblingResults[2] ?? "", "sibling-first-5L2P");

      const mergeBack = yield* readClaudeTranscriptFixture("thread_merge_back_continue");
      assert.equal(mergeBack.metadata?.queryMode, "fork_session_merge_back");
      const mergeBackSourceSessionId = metadataString(mergeBack, "nativeSessionId");
      const mergeBackContinuationFrame = findEntryFrame(
        mergeBack,
        "query.open:source-continuation",
      );
      const mergeBackContinuationOptions = mergeBackContinuationFrame.options;
      if (!isRecord(mergeBackContinuationOptions)) {
        throw new Error("Merge-back source continuation options must be an object.");
      }
      assert.equal(mergeBackContinuationOptions.resume, mergeBackSourceSessionId);
      const mergeBackRecallFrame = findEntryFrame(mergeBack, "prompt.offer:4");
      const mergeBackRecallMessage = mergeBackRecallFrame.message;
      const mergeBackRecallBody = isRecord(mergeBackRecallMessage)
        ? mergeBackRecallMessage.message
        : undefined;
      const mergeBackRecallPrompt =
        isRecord(mergeBackRecallBody) && typeof mergeBackRecallBody.content === "string"
          ? mergeBackRecallBody.content
          : "";
      assert.notInclude(mergeBackRecallPrompt, THREAD_MERGE_BACK_SOURCE_MARKER);
      assert.notInclude(mergeBackRecallPrompt, THREAD_MERGE_BACK_FORK_MARKER);
      assert.equal(
        successResultTexts(mergeBack)
          .at(-1)
          ?.replace(/\s*\|\s*/gu, "|"),
        THREAD_MERGE_BACK_RECALL,
      );

      const siblingMergeBack = yield* readClaudeTranscriptFixture("thread_merge_back_siblings");
      assert.equal(siblingMergeBack.metadata?.queryMode, "fork_session_merge_back_siblings");
      const siblingMergeSessionIds = metadataStringArray(
        siblingMergeBack,
        "forkedNativeSessionIds",
      );
      assert.lengthOf(siblingMergeSessionIds, 2);
      assert.notEqual(siblingMergeSessionIds[0], siblingMergeSessionIds[1]);
      const siblingMergeRecallFrame = findEntryFrame(siblingMergeBack, "prompt.offer:6");
      const siblingMergeRecallMessage = siblingMergeRecallFrame.message;
      const siblingMergeRecallBody = isRecord(siblingMergeRecallMessage)
        ? siblingMergeRecallMessage.message
        : undefined;
      const siblingMergeRecallPrompt =
        isRecord(siblingMergeRecallBody) && typeof siblingMergeRecallBody.content === "string"
          ? siblingMergeRecallBody.content
          : "";
      assert.notInclude(siblingMergeRecallPrompt, THREAD_MERGE_BACK_SIBLINGS_SOURCE_MARKER);
      assert.notInclude(siblingMergeRecallPrompt, THREAD_MERGE_BACK_SIBLINGS_FIRST_MARKER);
      assert.notInclude(siblingMergeRecallPrompt, THREAD_MERGE_BACK_SIBLINGS_SECOND_MARKER);
      assert.equal(
        successResultTexts(siblingMergeBack)
          .at(-1)
          ?.replace(/\s*\|\s*/gu, "|"),
        THREAD_MERGE_BACK_SIBLINGS_RECALL,
      );

      const forkLocalRollback = yield* readClaudeTranscriptFixture(
        "thread_fork_native_fork_local_rollback",
      );
      assert.equal(forkLocalRollback.metadata?.queryMode, "fork_session_resume_at_fork_cursor");
      const forkLocalRollbackCursor = metadataString(forkLocalRollback, "resumeSessionAt");
      const forkLocalRollbackFrame = findEntryFrame(
        forkLocalRollback,
        "query.open:fork-resume-at-cursor",
      );
      const forkLocalRollbackOptions = forkLocalRollbackFrame.options;
      if (!isRecord(forkLocalRollbackOptions)) {
        throw new Error("Fork-local rollback resume query.open options must be an object.");
      }
      assert.equal(forkLocalRollbackOptions.resumeSessionAt, forkLocalRollbackCursor);
      const forkLocalRollbackFinalText = successResultTexts(forkLocalRollback).at(-1) ?? "";
      assert.include(forkLocalRollbackFinalText, "fork local source alpha");
      assert.include(forkLocalRollbackFinalText, "fork local first");
      assert.notInclude(forkLocalRollbackFinalText, "fork local second");
    }),
  );
});
