import type {
  AgentSessionObservation,
  AgentSessionImportResult,
  AgentSessionScanResult,
  AgentSessionSourceReport,
  ProjectId,
  ProviderInstanceId,
} from "@t3tools/contracts";

export interface ExternalSessionImportAction {
  readonly kind: "import";
  readonly projectId: ProjectId;
  readonly expectedWorkspaceRoot: string;
  readonly providerInstanceId: ProviderInstanceId;
  readonly providerSessionId: string;
}

export interface ExternalSessionOpenAction {
  readonly kind: "open";
  readonly threadId: string;
}

export interface ExternalSessionExplainAction {
  readonly kind: "explain";
  readonly reason: string;
}

export type ExternalSessionActivityAction =
  | ExternalSessionImportAction
  | ExternalSessionOpenAction
  | ExternalSessionExplainAction;

export interface ExternalSessionActivityRow {
  readonly providerLabel: "Claude" | "Codex";
  readonly providerInstanceId: ProviderInstanceId;
  readonly providerSessionId: string;
  readonly projectPath: string | null;
  readonly repository: string | null;
  readonly lastObservedActivityAt: string | null;
  readonly action: ExternalSessionActivityAction;
}

export interface ExternalSessionActivitySnapshot {
  readonly scannedAt: string;
  readonly authoritative: boolean;
  readonly detail: string | null;
  readonly rows: readonly ExternalSessionActivityRow[];
}

export type ExternalSessionActivityView =
  | { readonly status: "off" }
  | { readonly status: "idle" }
  | {
      readonly status: "refreshFailed";
      readonly message: string;
      readonly previous: ExternalSessionActivitySnapshot | null;
    }
  | { readonly status: "shown"; readonly snapshot: ExternalSessionActivitySnapshot };

export type ExternalSessionActivityRefresh =
  | { readonly _tag: "never" }
  | {
      readonly _tag: "failed";
      readonly message: string;
      readonly previous: ExternalSessionActivitySnapshot | null;
    }
  | { readonly _tag: "succeeded"; readonly result: AgentSessionScanResult };

const ADD_PROJECT_REASON = "Add this folder as a T3 project before importing the session.";
const DELETED_SESSION_REASON =
  "This imported session was deleted from T3. It cannot be imported again.";

export function externalSessionImportMessage(result: AgentSessionImportResult): string {
  const imported =
    result.importedCount === 0
      ? "No sessions were imported."
      : `Imported ${result.importedCount} session${result.importedCount === 1 ? "" : "s"}.`;
  const skipped =
    result.skippedCount === 0
      ? ""
      : ` Skipped ${result.skippedCount} session${result.skippedCount === 1 ? "" : "s"}.`;
  const retry =
    result.importedCount === 0 || result.skippedCount > 0 ? " Refresh and try again." : "";
  return `${imported}${skipped}${retry}`;
}

export function parseExternalSessionActivityEnabled(raw: string | null): boolean {
  return raw === "1";
}

export function serializeExternalSessionActivityEnabled(enabled: boolean): string {
  return enabled ? "1" : "0";
}

function externalSessionThreadId(
  observation: Pick<AgentSessionObservation, "providerInstanceId" | "providerSessionId">,
): string {
  return `import:${observation.providerInstanceId}:${observation.providerSessionId}`;
}

function providerLabel(provider: AgentSessionSourceReport["provider"]): "Claude" | "Codex" {
  switch (provider) {
    case "claudeAgent":
      return "Claude";
    case "codex":
      return "Codex";
    default: {
      const unreachable: never = provider;
      return unreachable;
    }
  }
}

function sessionAction(
  observation: AgentSessionObservation,
  knownThreadIds: ReadonlySet<string>,
): ExternalSessionActivityAction {
  if (observation.importedThreadDeleted === true) {
    return {
      kind: "explain",
      reason: DELETED_SESSION_REASON,
    };
  }
  const threadId = externalSessionThreadId(observation);
  if (knownThreadIds.has(threadId)) {
    return { kind: "open", threadId };
  }
  if (observation.projectId !== undefined && observation.projectPath !== null) {
    return {
      kind: "import",
      projectId: observation.projectId,
      expectedWorkspaceRoot: observation.projectPath,
      providerInstanceId: observation.providerInstanceId,
      providerSessionId: observation.providerSessionId,
    };
  }
  return { kind: "explain", reason: ADD_PROJECT_REASON };
}

function snapshotFromScan(
  result: AgentSessionScanResult,
  knownThreadIds: ReadonlySet<string>,
): ExternalSessionActivitySnapshot {
  if (result.sessions === undefined || result.sourceReports === undefined) {
    return {
      scannedAt: result.scannedAt,
      authoritative: false,
      detail: "This environment did not report external sessions.",
      rows: [],
    };
  }

  const notes: string[] = [];
  for (const report of result.sourceReports) {
    const name = providerLabel(report.provider);
    switch (report.homeState) {
      case "missing":
        notes.push(`${name} home is missing.`);
        break;
      case "unreadable":
        notes.push(`${name} home could not be read.`);
        break;
      case "present":
        break;
      default: {
        const unreachable: never = report.homeState;
        return unreachable;
      }
    }
    if (report.truncated) {
      notes.push(`${name} scan stopped early.`);
    }
  }
  if (result.sessionsTruncated === true) {
    notes.push("The session list stopped early.");
  }
  if (result.truncated === true && !result.sourceReports.some((report) => report.truncated)) {
    notes.push("The scan stopped early, so this is not a complete list.");
  }

  return {
    scannedAt: result.scannedAt,
    authoritative: notes.length === 0,
    detail: notes.length === 0 ? null : notes.join(" "),
    rows: result.sessions.map((observation) => ({
      providerLabel: providerLabel(observation.provider),
      providerInstanceId: observation.providerInstanceId,
      providerSessionId: observation.providerSessionId,
      projectPath: observation.projectPath,
      repository: observation.repository,
      lastObservedActivityAt: observation.lastObservedActivityAt,
      action: sessionAction(observation, knownThreadIds),
    })),
  };
}

export function presentExternalSessionActivity(input: {
  readonly enabled: boolean;
  readonly refresh: ExternalSessionActivityRefresh;
  readonly knownThreadIds: ReadonlySet<string>;
}): ExternalSessionActivityView {
  if (!input.enabled) return { status: "off" };
  switch (input.refresh._tag) {
    case "never":
      return { status: "idle" };
    case "failed":
      return {
        status: "refreshFailed",
        message: input.refresh.message,
        previous:
          input.refresh.previous === null
            ? null
            : {
                ...input.refresh.previous,
                rows: input.refresh.previous.rows.map((row) => {
                  const threadId = externalSessionThreadId(row);
                  return !(
                    row.action.kind === "explain" && row.action.reason === DELETED_SESSION_REASON
                  ) && input.knownThreadIds.has(threadId)
                    ? { ...row, action: { kind: "open" as const, threadId } }
                    : row;
                }),
              },
      };
    case "succeeded":
      return {
        status: "shown",
        snapshot: snapshotFromScan(input.refresh.result, input.knownThreadIds),
      };
    default: {
      const unreachable: never = input.refresh;
      return unreachable;
    }
  }
}
