import { useAtomValue } from "@effect/atom-react";
import { scopeThreadRef, scopedThreadKey } from "@t3tools/client-runtime/environment";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { ThreadId, type EnvironmentId, type OrchestrationV2ThreadShell } from "@t3tools/contracts";
import {
  presentExternalSessionActivity,
  externalSessionImportMessage,
  type ExternalSessionActivityRefresh,
  type ExternalSessionActivityRow,
} from "@t3tools/shared/externalSessionActivity";
import { useNavigate } from "@tanstack/react-router";
import { Atom } from "effect/reactivity";
import { useEffect, useMemo, useRef, useState } from "react";

import * as ThreadUndo from "../../hooks/threadUndo";
import {
  refreshArchivedThreadsForEnvironment,
  useArchivedThreadSnapshots,
} from "../../lib/archivedThreadsState";
import { agentSessionImport, refreshAgentSessionScan } from "../../state/agentSessions";
import { waitForThreadShell } from "../../state/entities";
import {
  readExternalSessionActivityEnabled,
  writeExternalSessionActivityEnabled,
} from "../../state/externalSessionActivityPreference";
import { environmentThreadShells, threadEnvironment } from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";
import { buildThreadRouteParams } from "../../threadRoutes";
import { Button } from "../ui/button";
import { Switch } from "../ui/switch";
import { useSettingsScope } from "./SettingsScopeContext";
import { SettingsRow, SettingsSection } from "./settingsLayout";

const NO_THREADS = Atom.make<ReadonlyArray<OrchestrationV2ThreadShell>>([]).pipe(
  Atom.withLabel("external-session-activity:no-threads"),
);

function failureText(result: Parameters<typeof squashAtomCommandFailure>[0]): string {
  const squashed = squashAtomCommandFailure(result);
  return squashed instanceof Error ? squashed.message : "Could not refresh external sessions.";
}

function rowDescription(row: ExternalSessionActivityRow): string {
  const activity =
    row.lastObservedActivityAt === null
      ? "No recorded activity in the scanned portion"
      : `Last observed activity ${row.lastObservedActivityAt}`;
  const reason = row.action.kind === "explain" ? row.action.reason : null;
  return [row.repository, row.projectPath, activity, reason]
    .filter((part) => part !== null && part.length > 0)
    .join(" · ");
}

export function ExternalSessionActivitySection() {
  const navigate = useNavigate();
  const { scope, environment } = useSettingsScope();
  const environmentId =
    scope.environmentIds.length === 1 ? (environment?.environmentId ?? null) : null;
  const [enabled, setEnabled] = useState(() => readExternalSessionActivityEnabled());
  const [refresh, setRefresh] = useState<ExternalSessionActivityRefresh>({ _tag: "never" });
  const [actionMessage, setActionMessage] = useState<string | null>(null);
  const [refreshPending, setRefreshPending] = useState(false);
  const [scannedEnvironmentId, setScannedEnvironmentId] = useState<EnvironmentId | null>(null);
  const [pendingAction, setPendingAction] = useState<{
    key: string;
    kind: "open" | "import";
  } | null>(null);
  const actionInFlight = useRef(false);
  const actionGeneration = useRef(0);
  const refreshGeneration = useRef(0);
  const threads = useAtomValue(
    environmentId === null
      ? NO_THREADS
      : environmentThreadShells.environmentThreadsAtom(environmentId),
  );
  const hasScannedSessions =
    refresh._tag === "succeeded"
      ? (refresh.result.sessions?.length ?? 0) > 0
      : refresh._tag === "failed" && (refresh.previous?.rows.length ?? 0) > 0;
  const {
    snapshots: archivedSnapshots,
    isLoading: archivesLoading,
    error: archiveError,
    refresh: refreshArchives,
  } = useArchivedThreadSnapshots(
    enabled &&
      environmentId !== null &&
      scannedEnvironmentId === environmentId &&
      hasScannedSessions
      ? [environmentId]
      : [],
  );
  const archivesReady =
    !archivesLoading &&
    archiveError === null &&
    archivedSnapshots.some((entry) => entry.environmentId === environmentId);
  const archiveMessage =
    enabled && scannedEnvironmentId === environmentId && hasScannedSessions
      ? archiveError !== null
        ? `${archiveError} Refresh and try again before importing.`
        : !archivesReady
          ? "Checking archived sessions…"
          : null
      : null;
  const refreshScan = useAtomCommand(refreshAgentSessionScan, { reportFailure: false });
  const importSession = useAtomCommand(agentSessionImport, { reportFailure: false });
  const unarchiveThread = useAtomCommand(threadEnvironment.unarchive, { reportFailure: false });
  const knownThreadIds = useMemo(() => {
    const ids = new Set(threads.map((thread) => thread.id));
    for (const entry of archivedSnapshots) {
      for (const thread of entry.snapshot.threads) {
        ids.add(thread.id);
      }
    }
    return ids;
  }, [archivedSnapshots, threads]);
  const view = presentExternalSessionActivity({ enabled, refresh, knownThreadIds });
  const previous =
    view.status === "shown"
      ? view.snapshot
      : view.status === "refreshFailed"
        ? view.previous
        : null;

  useEffect(() => {
    refreshGeneration.current += 1;
    setRefresh({ _tag: "never" });
    setActionMessage(null);
    setRefreshPending(false);
    setScannedEnvironmentId(null);
    actionInFlight.current = false;
    setPendingAction(null);
    actionGeneration.current += 1;
    return () => {
      actionGeneration.current += 1;
      refreshGeneration.current += 1;
    };
  }, [environmentId]);

  const onRefresh = () => {
    if (environmentId === null) {
      setRefresh({
        _tag: "failed",
        message: "Choose one environment before refreshing external sessions.",
        previous,
      });
      return;
    }
    if (refreshPending) return;
    refreshArchives();
    const kept = previous;
    const env = environmentId;
    const generation = ++refreshGeneration.current;
    setRefreshPending(true);
    void refreshScan({ environmentId: env, input: {} }).then((result) => {
      if (generation !== refreshGeneration.current) return;
      setRefreshPending(false);
      if (result._tag === "Success") {
        setActionMessage(null);
        setScannedEnvironmentId(env);
        setRefresh({ _tag: "succeeded", result: result.value });
        return;
      }
      if (result._tag === "Failure") {
        setRefresh({ _tag: "failed", message: failureText(result), previous: kept });
      }
    });
  };

  const onAction = async (row: ExternalSessionActivityRow) => {
    if (environmentId === null || row.action.kind === "explain") {
      setActionMessage("Choose one environment before using this session.");
      return;
    }
    if (actionInFlight.current) return;
    if (row.action.kind === "import" && !archivesReady) return;
    actionInFlight.current = true;
    const generation = actionGeneration.current;
    setPendingAction({
      key: `${row.providerInstanceId}:${row.providerSessionId}`,
      kind: row.action.kind,
    });
    setActionMessage(null);
    try {
      if (row.action.kind === "open") {
        const threadId = ThreadId.make(row.action.threadId);
        if (!threads.some((thread) => thread.id === threadId)) {
          ThreadUndo.invalidate(
            "archive",
            scopedThreadKey(scopeThreadRef(environmentId, threadId)),
          );
          const result = await unarchiveThread({ environmentId, input: { threadId } });
          if (result._tag === "Success") refreshArchivedThreadsForEnvironment(environmentId);
          if (generation !== actionGeneration.current) return;
          if (result._tag === "Failure") {
            setActionMessage(failureText(result));
            return;
          }
          const ready = await waitForThreadShell(scopeThreadRef(environmentId, threadId));
          if (generation !== actionGeneration.current) return;
          if (!ready) {
            setActionMessage("The restored thread did not appear. Refresh and try again.");
            return;
          }
        }
        await navigate({
          to: "/$environmentId/$threadId",
          params: buildThreadRouteParams({
            environmentId,
            threadId,
          }),
        });
        return;
      }
      const result = await importSession({
        environmentId,
        input: {
          projectId: row.action.projectId,
          expectedWorkspaceRoot: row.action.expectedWorkspaceRoot,
          providerInstanceId: row.action.providerInstanceId,
          providerSessionId: row.action.providerSessionId,
        },
      });
      if (generation !== actionGeneration.current) return;
      if (result._tag === "Failure") {
        setActionMessage(failureText(result));
        return;
      }
      setActionMessage(externalSessionImportMessage(result.value));
    } catch (error) {
      if (generation === actionGeneration.current) {
        setActionMessage(error instanceof Error ? error.message : "Could not use this session.");
      }
    } finally {
      if (generation === actionGeneration.current) {
        actionInFlight.current = false;
        setPendingAction(null);
      }
    }
  };

  const rows = view.status === "shown" ? view.snapshot.rows : (previous?.rows ?? []);
  const scannedAt =
    view.status === "shown" ? view.snapshot.scannedAt : (previous?.scannedAt ?? null);
  const detail =
    view.status === "shown"
      ? view.snapshot.detail
      : view.status === "refreshFailed"
        ? view.message
        : null;

  return (
    <SettingsSection
      id="external-sessions"
      title="External sessions"
      headerAction={
        enabled ? (
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={refreshPending}
            onClick={onRefresh}
          >
            Refresh
          </Button>
        ) : null
      }
    >
      <SettingsRow
        title="Recent external sessions"
        description="Show Claude and Codex sessions from this environment. Refresh reads them. Nothing is imported until you ask."
        control={
          <Switch
            checked={enabled}
            onCheckedChange={(checked) => {
              setEnabled(checked);
              writeExternalSessionActivityEnabled(checked);
            }}
            aria-label="Recent external sessions"
          />
        }
      />
      {view.status === "idle" ? (
        <SettingsRow
          title="No scan yet"
          description="Refresh to read recent sessions. T3 does not scan in the background."
        />
      ) : null}
      {detail !== null ? <SettingsRow title="Scan" description={detail} /> : null}
      {scannedAt !== null ? <SettingsRow title="Last scan" description={scannedAt} /> : null}
      {actionMessage !== null ? <SettingsRow title="Session" description={actionMessage} /> : null}
      {archiveMessage !== null ? (
        <SettingsRow title="Archive" description={archiveMessage} />
      ) : null}
      {rows.map((row) => (
        <SettingsRow
          key={`${row.providerInstanceId}:${row.providerSessionId}`}
          title={`${row.providerLabel} ${row.providerSessionId}`}
          description={rowDescription(row)}
          control={
            row.action.kind === "explain" ? null : (
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={
                  pendingAction !== null || (row.action.kind === "import" && !archivesReady)
                }
                onClick={() => {
                  void onAction(row);
                }}
              >
                {pendingAction?.key === `${row.providerInstanceId}:${row.providerSessionId}`
                  ? pendingAction.kind === "open"
                    ? "Opening…"
                    : "Importing…"
                  : row.action.kind === "open"
                    ? "Open"
                    : "Import"}
              </Button>
            )
          }
        />
      ))}
    </SettingsSection>
  );
}
