import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import { AgentSessionScanResult } from "./agentSessions.ts";

const decodeScanResult = Schema.decodeUnknownSync(AgentSessionScanResult);

const candidate = {
  path: "/projects/repo",
  title: "repo",
  sources: ["codex"],
  threadCount: 3,
  lastActiveAt: "2026-08-20T12:00:00.000Z",
  alreadyImported: false,
} as const;

describe("AgentSessionScanResult", () => {
  it("decodes candidates from servers that predate the git scan", () => {
    const result = decodeScanResult({
      candidates: [candidate],
      scannedAt: "2026-08-22T12:00:00.000Z",
    });

    expect(result.candidates[0]?.git).toBeUndefined();
  });

  it("preserves reported git identity", () => {
    const git = { remoteKey: "github.com/pingdotgg/t3code", repository: "pingdotgg/t3code" };
    const result = decodeScanResult({
      candidates: [{ ...candidate, git }],
      scannedAt: "2026-08-22T12:00:00.000Z",
    });

    expect(result.candidates[0]?.git).toEqual(git);
  });

  it("keeps a scan that predates session reports free of an empty session list", () => {
    const result = decodeScanResult({
      candidates: [candidate],
      scannedAt: "2026-08-22T12:00:00.000Z",
    });

    expect(result.sessions).toBeUndefined();
    expect(result.sourceReports).toBeUndefined();
  });

  it("decodes session observations separately from scan time", () => {
    const result = decodeScanResult({
      candidates: [],
      scannedAt: "2026-08-22T12:00:00.000Z",
      sessions: [
        {
          provider: "codex",
          providerInstanceId: "codex",
          providerSessionId: "session-1",
          projectPath: "/projects/repo",
          repository: "pingdotgg/t3code",
          lastObservedActivityAt: "2026-08-20T12:00:00.000Z",
        },
      ],
      sourceReports: [
        {
          provider: "codex",
          providerInstanceId: "codex",
          homeState: "present",
          truncated: false,
        },
      ],
    });

    expect(result.sessions).toEqual([
      {
        provider: "codex",
        providerInstanceId: "codex",
        providerSessionId: "session-1",
        projectPath: "/projects/repo",
        repository: "pingdotgg/t3code",
        lastObservedActivityAt: "2026-08-20T12:00:00.000Z",
      },
    ]);
    expect(result.scannedAt).toBe("2026-08-22T12:00:00.000Z");
    expect(result.sourceReports).toEqual([
      {
        provider: "codex",
        providerInstanceId: "codex",
        homeState: "present",
        truncated: false,
      },
    ]);
  });
});
