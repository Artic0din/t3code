import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import {
  presentExternalSessionActivity,
  type ExternalSessionActivityRefresh,
  type ExternalSessionActivityRow,
} from "@t3tools/shared/externalSessionActivity";
import { useNavigation } from "@react-navigation/native";
import { useMemo, useState } from "react";
import { View } from "react-native";

import { AppText as Text } from "../../components/AppText";
import { ScreenScrollView as ScrollView } from "../../components/ScreenScrollView";
import { useThreadShells } from "../../state/entities";
import {
  importAgentSession,
  readExternalSessionActivityEnabled,
  refreshAgentSessionScan,
  writeExternalSessionActivityEnabled,
} from "../../state/external-session-activity";
import { useAtomCommand } from "../../state/use-atom-command";
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
  const [enabled, setEnabled] = useState(() => readExternalSessionActivityEnabled());
  const [refresh, setRefresh] = useState<ExternalSessionActivityRefresh>({ _tag: "never" });
  const [actionMessage, setActionMessage] = useState<string | null>(null);
  const threads = useThreadShells();
  const refreshScan = useAtomCommand(refreshAgentSessionScan, { reportFailure: false });
  const importSession = useAtomCommand(importAgentSession, { reportFailure: false });
  const knownThreadIds = useMemo(() => {
    const ids = new Set<string>();
    if (environmentId === null) return ids;
    for (const thread of threads) {
      if (thread.environmentId === environmentId) ids.add(thread.id);
    }
    return ids;
  }, [environmentId, threads]);
  const view = presentExternalSessionActivity({ enabled, refresh, knownThreadIds });
  const previous =
    view.status === "shown"
      ? view.snapshot
      : view.status === "refreshFailed"
        ? view.previous
        : null;

  const onRefresh = () => {
    if (environmentId === null) {
      setRefresh({
        _tag: "failed",
        message: "Choose one environment before refreshing external sessions.",
        previous,
      });
      return;
    }
    const kept = previous;
    void refreshScan({ environmentId, input: {} }).then((result) => {
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
      setActionMessage(
        row.action.kind === "explain"
          ? row.action.reason
          : "Choose one environment before using this session.",
      );
      return;
    }
    if (row.action.kind === "open") {
      const params = { environmentId: String(environmentId), threadId: row.action.threadId };
      const root = navigation.getParent()?.getParent() ?? navigation.getParent() ?? navigation;
      root.navigate("Thread", params);
      return;
    }
    void importSession({
      environmentId,
      input: {
        projectId: row.action.projectId,
        expectedWorkspaceRoot: row.action.expectedWorkspaceRoot,
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
  const detail =
    view.status === "shown"
      ? view.snapshot.detail
      : view.status === "refreshFailed"
        ? view.message
        : null;
  const scannedAt =
    view.status === "shown" ? view.snapshot.scannedAt : (previous?.scannedAt ?? null);

  return (
    <SettingsScreen title="External sessions">
      <ScrollView className="flex-1" contentContainerClassName="gap-4 px-5 pt-4 pb-8">
        <SettingsSection title="External sessions">
          <SettingsSwitchRow
            icon="clock"
            label="Recent external sessions"
            subtitle="Off until you turn this on. Refresh reads Claude and Codex sessions. Nothing is imported until you ask."
            value={enabled}
            onValueChange={(next) => {
              setEnabled(next);
              writeExternalSessionActivityEnabled(next);
            }}
          />
          {enabled ? (
            <SettingsRow icon="arrow.clockwise" label="Refresh" onPress={onRefresh} />
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
        {rows.length > 0 ? (
          <SettingsSection title="Sessions">
            {rows.map((row) => (
              <View key={`${row.providerLabel}:${row.providerSessionId}`}>
                <SettingsRow
                  icon="doc.text"
                  label={`${row.providerLabel} ${row.providerSessionId}`}
                  value={
                    row.action.kind === "explain"
                      ? rowDetail(row)
                      : `${row.action.kind === "open" ? "Open" : "Import"} · ${rowDetail(row)}`
                  }
                  onPress={row.action.kind === "explain" ? undefined : () => onAction(row)}
                />
              </View>
            ))}
          </SettingsSection>
        ) : null}
      </ScrollView>
    </SettingsScreen>
  );
}
