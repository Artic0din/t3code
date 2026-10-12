import { useAtomValue } from "@effect/atom-react";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { ThreadId, type OrchestrationV2ThreadShell } from "@t3tools/contracts";
import {
  presentExternalSessionActivity,
  type ExternalSessionActivityRefresh,
  type ExternalSessionActivityRow,
} from "@t3tools/shared/externalSessionActivity";
import { useNavigate } from "@tanstack/react-router";
import { Atom } from "effect/reactivity";
import { useEffect, useMemo, useRef, useState } from "react";

import { useArchivedThreadSnapshots } from "../../lib/archivedThreadsState";
import { agentSessionImport, refreshAgentSessionScan } from "../../state/agentSessions";
import {
  readExternalSessionActivityEnabled,
  writeExternalSessionActivityEnabled,
} from "../../state/externalSessionActivityPreference";
import { environmentThreadShells } from "../../state/threads";
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
  const refreshGeneration = useRef(0);
  const threads = useAtomValue(
    environmentId === null
      ? NO_THREADS
      : environmentThreadShells.environmentThreadsAtom(environmentId),
  );
  const { snapshots: archivedSnapshots } = useArchivedThreadSnapshots(
    environmentId === null ? [] : [environmentId],
  );
  const refreshScan = useAtomCommand(refreshAgentSessionScan, { reportFailure: false });
  const importSession = useAtomCommand(agentSessionImport, { reportFailure: false });
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
    const kept = previous;
    const env = environmentId;
    const generation = ++refreshGeneration.current;
    setRefreshPending(true);
    void refreshScan({ environmentId: env, input: {} }).then((result) => {
      if (generation !== refreshGeneration.current) return;
      setRefreshPending(false);
      if (result._tag === "Success") {
        setActionMessage(null);
        setRefresh({ _tag: "succeeded", result: result.value });
        return;
      }
      if (result._tag === "Failure") {
        setRefresh({ _tag: "failed", message: failureText(result), previous: kept });
      }
    });
  };

  const onAction = (row: ExternalSessionActivityRow) => {
    if (environmentId === null || row.action.kind === "explain") {
      setActionMessage("Choose one environment before using this session.");
      return;
    }
    if (row.action.kind === "open") {
      void navigate({
        to: "/$environmentId/$threadId",
        params: buildThreadRouteParams({
          environmentId,
          threadId: ThreadId.make(row.action.threadId),
        }),
      });
      return;
    }
    void importSession({
      environmentId,
      input: {
        projectId: row.action.projectId,
        expectedWorkspaceRoot: row.action.expectedWorkspaceRoot,
        providerInstanceId: row.action.providerInstanceId,
        providerSessionId: row.action.providerSessionId,
      },
    }).then((result) => {
      if (result._tag === "Failure") {
        setActionMessage(failureText(result));
        return;
      }
      setActionMessage(null);
    });
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
      {actionMessage !== null ? <SettingsRow title="Import" description={actionMessage} /> : null}
      {rows.map((row) => (
        <SettingsRow
          key={`${row.providerInstanceId}:${row.providerSessionId}`}
          title={`${row.providerLabel} ${row.providerSessionId}`}
          description={rowDescription(row)}
          control={
            row.action.kind === "explain" ? null : (
              <Button type="button" size="sm" variant="outline" onClick={() => onAction(row)}>
                {row.action.kind === "open" ? "Open" : "Import"}
              </Button>
            )
          }
        />
      ))}
    </SettingsSection>
  );
}
