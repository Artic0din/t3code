import { totalTokens } from "@t3tools/provider-core/server/usage";
import { describe, expect, it } from "vite-plus/test";

import { commandCodeUsageFormat } from "./commandCodeUsage.ts";

const session = {
  type: "session",
  version: 3,
  id: "18ab800a-0b24-47ae-b3ae-eb617e0b17d2",
  timestamp: "2026-11-13T09:49:34.064Z",
};
const assistant = {
  type: "message",
  id: "308e4223",
  parentId: "c31eed1d",
  timestamp: "2026-11-13T09:49:36.412Z",
  message: { role: "assistant", content: [] },
  usage: {
    inputTokens: 36058,
    outputTokens: 6,
    cacheReadTokens: 6400,
    cacheWriteTokens: 100,
    costUsd: 0.0044715,
  },
  model: "deepseek/deepseek-v4.1-flash",
};

const parseAll = (lines: readonly unknown[]) => {
  const state = commandCodeUsageFormat.state!.initial();
  return lines.flatMap((line) => commandCodeUsageFormat.parseLine(JSON.stringify(line), state));
};

describe("commandCodeUsageFormat", () => {
  it("splits inclusive input counters and keeps the reported cost and session", () => {
    const [record] = parseAll([session, assistant]);
    expect(record).toMatchObject({
      provider: "commandcode",
      timestampMs: Date.parse("2026-11-13T09:49:36.412Z"),
      model: "deepseek/deepseek-v4.1-flash",
      sessionId: "18ab800a-0b24-47ae-b3ae-eb617e0b17d2",
      reportedCostUsd: 0.0044715,
      totals: {
        uncachedInputTokens: 29558,
        cachedInputTokens: 6400,
        cacheCreationTokens: 100,
        outputTokens: 6,
        reasoningTokens: 0,
      },
    });
    expect(totalTokens(record!.totals)).toBe(36064);
  });

  it("ignores user turns, empty usage and malformed lines, and keeps free and missing costs apart", () => {
    const { costUsd: _cost, ...uncosted } = assistant.usage;
    const records = parseAll([
      session,
      { ...assistant, id: "user", message: { role: "user", content: [] } },
      {
        ...assistant,
        id: "empty",
        usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
      },
      { ...assistant, id: "no-model", model: undefined },
      { ...assistant, id: "free", usage: { ...assistant.usage, costUsd: 0 } },
      { ...assistant, id: "byok", usage: uncosted },
    ]);
    expect(records.map((record) => [record.reportedCostUsd, record.totals.outputTokens])).toEqual([
      [0, 6],
      [null, 6],
    ]);
    expect(commandCodeUsageFormat.parseLine("{not json", { sessionId: "" })).toEqual([]);
  });

  it("dedupes a reply copied into a forked session", () => {
    const [original] = parseAll([session, assistant]);
    const [forked] = parseAll([{ ...session, id: "fork" }, assistant]);
    const [next] = parseAll([session, { ...assistant, id: "next" }]);
    expect(forked?.dedupeKey).toBe(original?.dedupeKey);
    expect(next?.dedupeKey).not.toBe(original?.dedupeKey);
  });
});
