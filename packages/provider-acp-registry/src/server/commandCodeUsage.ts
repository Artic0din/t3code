import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import {
  parseTimestampMs,
  tokenCount,
  totalTokens,
  type ProviderUsageReader,
  type TranscriptUsageFormat,
  type UsageRecord,
} from "@t3tools/provider-core/server/usage";
import * as HostProcess from "@t3tools/shared/HostProcess";

import type { AcpRegistrySettings } from "../settings.ts";

const CommandCodeScanState = Schema.Struct({ sessionId: Schema.mutableKey(Schema.String) });
const Entry = Schema.Union([
  Schema.Struct({ type: Schema.Literal("session"), id: Schema.NonEmptyString }),
  Schema.Struct({
    type: Schema.Literal("message"),
    id: Schema.NonEmptyString,
    timestamp: Schema.String,
    model: Schema.NonEmptyString,
    message: Schema.Struct({ role: Schema.Literal("assistant") }),
    usage: Schema.Struct({
      inputTokens: Schema.optional(Schema.Unknown),
      outputTokens: Schema.optional(Schema.Unknown),
      cacheReadTokens: Schema.optional(Schema.Unknown),
      cacheWriteTokens: Schema.optional(Schema.Unknown),
      costUsd: Schema.optional(Schema.Unknown),
    }),
  }),
]);
const decodeEntry = Schema.decodeUnknownOption(Entry);

function parseRecord(
  parsed: unknown,
  state: typeof CommandCodeScanState.Type,
): readonly UsageRecord[] {
  const decoded = decodeEntry(parsed);
  if (Option.isNone(decoded)) return [];
  const entry = decoded.value;
  if (entry.type === "session") {
    state.sessionId = entry.id;
    return [];
  }
  const timestampMs = parseTimestampMs(entry.timestamp);
  if (timestampMs === null) return [];
  const { usage } = entry;
  const cachedInputTokens = tokenCount(usage.cacheReadTokens);
  const cacheCreationTokens = tokenCount(usage.cacheWriteTokens);
  const totals = {
    // Command Code records AI SDK totals, where input includes cache reads and writes.
    uncachedInputTokens: Math.max(
      0,
      tokenCount(usage.inputTokens) - cachedInputTokens - cacheCreationTokens,
    ),
    cachedInputTokens,
    cacheCreationTokens,
    outputTokens: tokenCount(usage.outputTokens),
    reasoningTokens: 0,
  };
  const cost = usage.costUsd;
  const reportedCostUsd =
    typeof cost === "number" && Number.isFinite(cost) && cost > 0 ? cost : null;
  if (totalTokens(totals) === 0 && reportedCostUsd === null) return [];
  return [
    {
      provider: "commandcode",
      timestampMs,
      model: entry.model,
      sessionId: state.sessionId,
      totals,
      reportedCostUsd,
      speed: "standard",
      // Forks copy message IDs and timestamps into a new session file.
      dedupeKey: JSON.stringify(["commandcode", entry.id, entry.timestamp, entry.model]),
    },
  ];
}

export const commandCodeUsageFormat: TranscriptUsageFormat<typeof CommandCodeScanState.Type> = {
  selectFields: {
    type: true,
    id: true,
    timestamp: true,
    model: true,
    usage: true,
    message: { role: true },
  },
  usageMarkers: ['"usage"', '"session"'],
  parseLine: (line, state) => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      return [];
    }
    return parseRecord(parsed, state);
  },
  parseProjected: parseRecord,
  state: { initial: () => ({ sessionId: "" }), schema: CommandCodeScanState },
  sharedSessionsAcrossFiles: true,
};

/** Command Code keeps every session, inside T3 Code or not, under ~/.commandcode/projects. */
export const commandCodeUsageReader: ProviderUsageReader<AcpRegistrySettings, Path.Path> = {
  kind: "transcripts",
  provider: "commandcode",
  format: commandCodeUsageFormat,
  directories: Effect.fn("commandCodeUsageReader.directories")(function* ({ environment }) {
    const path = yield* Path.Path;
    const home = environment.HOME || (yield* HostProcess.HomeDirectory);
    return [{ dir: path.join(home, ".commandcode", "projects") }];
  }),
};
