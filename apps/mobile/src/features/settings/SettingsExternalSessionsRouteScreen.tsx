import { useAtomSet, useAtomValue } from "@effect/atom-react";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { ThreadId, type EnvironmentId } from "@t3tools/contracts";
import {
  presentExternalSessionActivity,
  externalSessionImportMessage,
  type ExternalSessionActivityRefresh,
  type ExternalSessionActivityRow,
} from "@t3tools/shared/externalSessionActivity";
import { AsyncResult } from "effect/reactivity";
import { useNavigation } from "@react-navigation/native";
import { useEffect, useMemo, useRef, useState } from "react";
import { View } from "react-native";

import { AppText as Text } from "../../components/AppText";
import { ScreenScrollView as ScrollView } from "../../components/ScreenScrollView";
import {
  refreshArchivedThreadsForEnvironment,
  useArchivedThreadSnapshots,
} from "../archive/useArchivedThreadSnapshots";
import { useThreadShells, waitForThreadShell } from "../../state/entities";
import { threadEnvironment } from "../../state/threads";
import { importAgentSession, refreshAgentSessionScan } from "../../state/external-session-activity";
import { mobilePreferencesAtom, updateMobilePreferencesAtom } from "../../state/preferences";
import { useAtomCommand } from "../../state/use-atom-command";
import {
  AndroidSettingsEnvironmentFilter,
  SettingsEnvironmentFilterHeader,
} from "./components/SettingsEnvironmentFilterHeader";
import { SettingsRow } from "./components/SettingsRow";
import { SettingsScreen } from "./components/SettingsScreen";
import { SettingsSection } from "./components/SettingsSection";
import { SettingsSwitchRow } from "./components/SettingsSwitchRow";
import { useSettingsEnvironmentFilter } from "./settings-environment-filter";

function failureText(result: Parameters<typeof squashAtomCommandFailure>[0]): string {
  const squashed = squashAtomCommandFailure(result);
  return squashed instanceof Error ? squashed.message : "Could not refresh external sessions.";
}

function rowDetail(row: ExternalSessionActivityRow): string {
  const activity =
    row.lastObservedActivityAt === null
      ? "No recorded activity in the scanned portion"
      : `Last observed activity ${row.lastObservedActivityAt}`;
  const reason = row.action.kind === "explain" ? row.action.reason : null;
  return [row.repository, row.projectPath, activity, reason]
    .filter((part) => part !== null && part.length > 0)
    .join(" · ");
}

export function SettingsExternalSessionsRouteScreen() {
  const navigation = useNavigation();
  const { selectedTargets } = useSettingsEnvironmentFilter();
  const environmentId =
    selectedTargets.length === 1 ? (selectedTargets[0]?.environmentId ?? null) : null;
  const preferencesResult = useAtomValue(mobilePreferencesAtom);
  const savePreferences = useAtomSet(updateMobilePreferencesAtom);
  const enabled = AsyncResult.isSuccess(preferencesResult)
    ? preferencesResult.value.externalSessionActivityEnabled === true
    : false;
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
  const threads = useThreadShells();
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
  const importSession = useAtomCommand(importAgentSession, { reportFailure: false });
  const unarchiveThread = useAtomCommand(threadEnvironment.unarchive, { reportFailure: false });
  const knownThreadIds = useMemo(() => {
    const ids = new Set<string>();
    if (environmentId === null) return ids;
    for (const thread of threads) {
      if (thread.environmentId === environmentId) ids.add(thread.id);
    }
    for (const entry of archivedSnapshots) {
      if (entry.environmentId !== environmentId) continue;
      for (const thread of entry.snapshot.threads) {
        ids.add(thread.id);
      }
    }
    return ids;
  }, [archivedSnapshots, environmentId, threads]);
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
      setActionMessage(
        row.action.kind === "explain"
          ? row.action.reason
          : "Choose one environment before using this session.",
      );
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
        if (
          !threads.some(
            (thread) => thread.environmentId === environmentId && thread.id === threadId,
          )
        ) {
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
        const params = { environmentId: String(environmentId), threadId: row.action.threadId };
        const root = navigation.getParent()?.getParent() ?? navigation.getParent() ?? navigation;
        root.navigate("Thread", params);
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
  const detail =
    view.status === "shown"
      ? view.snapshot.detail
      : view.status === "refreshFailed"
        ? view.message
        : null;
  const scannedAt =
    view.status === "shown" ? view.snapshot.scannedAt : (previous?.scannedAt ?? null);

  return (
    <>
      <SettingsEnvironmentFilterHeader />
      <SettingsScreen title="External sessions" trailing={<AndroidSettingsEnvironmentFilter />}>
        <ScrollView className="flex-1" contentContainerClassName="gap-4 px-5 pt-4 pb-8">
          <SettingsSection title="External sessions">
            <SettingsSwitchRow
              icon="clock"
              label="Recent external sessions"
              subtitle="Off until you turn this on. Refresh reads Claude and Codex sessions. Nothing is imported until you ask."
              value={enabled}
              onValueChange={(next) => {
                savePreferences({ externalSessionActivityEnabled: next });
              }}
            />
            {enabled ? (
              <SettingsRow
                icon="arrow.clockwise"
                label="Refresh"
                disabled={refreshPending}
                onPress={onRefresh}
              />
            ) : null}
          </SettingsSection>
          {view.status === "idle" ? (
            <Text className="px-1 text-base text-foreground-muted">
              Refresh to read recent sessions. T3 does not scan in the background.
            </Text>
          ) : null}
          {detail !== null ? (
            <Text className="px-1 text-base text-foreground-muted">{detail}</Text>
          ) : null}
          {scannedAt !== null ? (
            <Text className="px-1 text-base text-foreground-muted">Last scan {scannedAt}</Text>
          ) : null}
          {actionMessage !== null ? (
            <Text className="px-1 text-base text-foreground-muted">{actionMessage}</Text>
          ) : null}
          {archiveMessage !== null ? (
            <Text className="px-1 text-base text-foreground-muted">{archiveMessage}</Text>
          ) : null}
          {rows.length > 0 ? (
            <SettingsSection title="Sessions">
              {rows.map((row) => (
                <View key={`${row.providerInstanceId}:${row.providerSessionId}`}>
                  <SettingsRow
                    icon="doc.text"
                    label={`${row.providerLabel} ${row.providerSessionId}`}
                    disabled={
                      row.action.kind === "explain" ||
                      pendingAction !== null ||
                      (row.action.kind === "import" && !archivesReady)
                    }
                    value={
                      row.action.kind === "explain"
                        ? rowDetail(row)
                        : `${
                            pendingAction?.key ===
                            `${row.providerInstanceId}:${row.providerSessionId}`
                              ? pendingAction.kind === "open"
                                ? "Opening…"
                                : "Importing…"
                              : row.action.kind === "open"
                                ? "Open"
                                : "Import"
                          } · ${rowDetail(row)}`
                    }
                    onPress={
                      row.action.kind === "explain"
                        ? undefined
                        : () => {
                            void onAction(row);
                          }
                    }
                  />
                </View>
              ))}
            </SettingsSection>
          ) : null}
        </ScrollView>
      </SettingsScreen>
    </>
  );
}
