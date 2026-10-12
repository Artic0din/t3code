import { ProviderInstanceId, ProjectId, type AgentSessionScanResult } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  parseExternalSessionActivityEnabled,
  presentExternalSessionActivity,
  serializeExternalSessionActivityEnabled,
} from "./externalSessionActivity.ts";

const codex = ProviderInstanceId.make("codex");

const scan = {
  candidates: [],
  scannedAt: "2026-08-22T12:00:00.000Z",
  sessions: [
    {
      provider: "codex" as const,
      providerInstanceId: codex,
      providerSessionId: "session-1",
      projectPath: "/projects/repo",
      projectId: ProjectId.make("project-1"),
      repository: "pingdotgg/t3code",
      lastObservedActivityAt: "2026-08-20T12:00:00.000Z",
    },
  ],
  sourceReports: [
    {
      provider: "codex" as const,
      providerInstanceId: codex,
      homeState: "present" as const,
      truncated: false,
    },
  ],
} satisfies AgentSessionScanResult;

describe("external session activity preference", () => {
  it("stays off until the stored value is enabled", () => {
    expect(parseExternalSessionActivityEnabled(null)).toBe(false);
    expect(parseExternalSessionActivityEnabled("0")).toBe(false);
    expect(parseExternalSessionActivityEnabled("1")).toBe(true);
    expect(serializeExternalSessionActivityEnabled(false)).toBe("0");
    expect(serializeExternalSessionActivityEnabled(true)).toBe("1");
  });
});

describe("presentExternalSessionActivity", () => {
  it("hides every session until the preference is on", () => {
    expect(
      presentExternalSessionActivity({
        enabled: false,
        refresh: { _tag: "succeeded", result: scan },
        knownThreadIds: new Set(),
      }),
    ).toEqual({ status: "off" });
  });

  it("does not invent a scan when the preference turns on", () => {
    expect(
      presentExternalSessionActivity({
        enabled: true,
        refresh: { _tag: "never" },
        knownThreadIds: new Set(),
      }),
    ).toEqual({ status: "idle" });
  });

  it("offers import until the session's thread exists, then open", () => {
    const available = presentExternalSessionActivity({
      enabled: true,
      refresh: { _tag: "succeeded", result: scan },
      knownThreadIds: new Set(),
    });
    const imported = presentExternalSessionActivity({
      enabled: true,
      refresh: { _tag: "succeeded", result: scan },
      knownThreadIds: new Set(["import:codex:session-1"]),
    });

    expect(available).toEqual({
      status: "shown",
      snapshot: {
        scannedAt: "2026-08-22T12:00:00.000Z",
        authoritative: true,
        detail: null,
        rows: [
          {
            providerLabel: "Codex",
            providerInstanceId: codex,
            providerSessionId: "session-1",
            projectPath: "/projects/repo",
            repository: "pingdotgg/t3code",
            lastObservedActivityAt: "2026-08-20T12:00:00.000Z",
            action: {
              kind: "import",
              projectId: "project-1",
              expectedWorkspaceRoot: "/projects/repo",
              providerInstanceId: codex,
              providerSessionId: "session-1",
            },
          },
        ],
      },
    });
    expect(imported).toEqual({
      status: "shown",
      snapshot: {
        scannedAt: "2026-08-22T12:00:00.000Z",
        authoritative: true,
        detail: null,
        rows: [
          {
            providerLabel: "Codex",
            providerInstanceId: codex,
            providerSessionId: "session-1",
            projectPath: "/projects/repo",
            repository: "pingdotgg/t3code",
            lastObservedActivityAt: "2026-08-20T12:00:00.000Z",
            action: { kind: "open", threadId: "import:codex:session-1" },
          },
        ],
      },
    });
  });

  it("explains a session that is not in a T3 project", () => {
    const result: AgentSessionScanResult = {
      ...scan,
      sessions: [
        {
          ...scan.sessions[0]!,
          projectPath: "/projects/repo",
          projectId: undefined,
        },
      ],
    };

    expect(
      presentExternalSessionActivity({
        enabled: true,
        refresh: { _tag: "succeeded", result },
        knownThreadIds: new Set(),
      }),
    ).toMatchObject({
      snapshot: {
        rows: [
          {
            action: {
              kind: "explain",
              reason: "Add this folder as a T3 project before importing the session.",
            },
          },
        ],
      },
    });
  });

  it("does not present an unreadable home as an empty session list", () => {
    const result: AgentSessionScanResult = {
      candidates: [],
      scannedAt: "2026-08-22T12:00:00.000Z",
      sessions: [],
      sourceReports: [
        {
          provider: "claudeAgent",
          providerInstanceId: ProviderInstanceId.make("claudeAgent"),
          homeState: "unreadable",
          truncated: false,
        },
      ],
    };

    expect(
      presentExternalSessionActivity({
        enabled: true,
        refresh: { _tag: "succeeded", result },
        knownThreadIds: new Set(),
      }),
    ).toEqual({
      status: "shown",
      snapshot: {
        scannedAt: "2026-08-22T12:00:00.000Z",
        authoritative: false,
        detail: "Claude home could not be read.",
        rows: [],
      },
    });
  });

  it("does not present a missing session report as an empty list", () => {
    const result: AgentSessionScanResult = {
      candidates: [],
      scannedAt: "2026-08-22T12:00:00.000Z",
    };

    expect(
      presentExternalSessionActivity({
        enabled: true,
        refresh: { _tag: "succeeded", result },
        knownThreadIds: new Set(),
      }),
    ).toEqual({
      status: "shown",
      snapshot: {
        scannedAt: "2026-08-22T12:00:00.000Z",
        authoritative: false,
        detail: "This environment did not report external sessions.",
        rows: [],
      },
    });
  });

  it("keeps the previous sessions when refresh fails", () => {
    const shown = presentExternalSessionActivity({
      enabled: true,
      refresh: { _tag: "succeeded", result: scan },
      knownThreadIds: new Set(),
    });
    const previous = shown.status === "shown" ? shown.snapshot : null;

    expect(
      presentExternalSessionActivity({
        enabled: true,
        refresh: {
          _tag: "failed",
          message: "Failed to scan agent sessions during read-settings.",
          previous,
        },
        knownThreadIds: new Set(),
      }),
    ).toEqual({
      status: "refreshFailed",
      message: "Failed to scan agent sessions during read-settings.",
      previous,
    });
  });
});
