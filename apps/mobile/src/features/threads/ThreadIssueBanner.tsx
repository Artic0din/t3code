import { useAtomValue } from "@effect/atom-react";
import { StackActions, useNavigation } from "@react-navigation/native";
import {
  relatedIssueThreads,
  type EnvironmentId,
  type ThreadId,
  type ThreadLinkedIssue,
} from "@t3tools/contracts";
import * as Haptics from "expo-haptics";
import { Linking, Pressable, ScrollView, Text, View } from "react-native";

import { useArchivedThreadSnapshots } from "../archive/useArchivedThreadSnapshots";
import { threadEnvironment } from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";

function issueLabel(issue: ThreadLinkedIssue): string {
  const title = issue.title ?? `${issue.repository}#${issue.number}`;
  switch (issue.availability) {
    case "open":
    case "closed":
      return title;
    case "missing":
      return `${title} could not be found`;
    case "inaccessible":
      return `${title} could not be read`;
    default: {
      const unreachable: never = issue.availability;
      return unreachable;
    }
  }
}

export function ThreadIssueBanner(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly linkedIssue: ThreadLinkedIssue | null;
}) {
  const navigation = useNavigation();
  const snapshot = useAtomValue(threadEnvironment.snapshotAtom(props.environmentId));
  const archived = useArchivedThreadSnapshots(
    props.linkedIssue === null ? [] : [props.environmentId],
  );
  const archivedShells =
    archived.snapshots.find((entry) => entry.environmentId === props.environmentId)?.snapshot
      .threads ?? [];
  const unlinkIssue = useAtomCommand(threadEnvironment.unlinkIssue, "unlink issue");
  if (props.linkedIssue === null) return null;
  const issue = props.linkedIssue;
  const related = relatedIssueThreads(
    [...(snapshot?.threads ?? []), ...archivedShells],
    issue,
    props.threadId,
  );
  return (
    <View className="gap-1 px-4 py-2">
      <Pressable
        accessibilityRole="link"
        onPress={() => {
          void Linking.openURL(issue.url);
        }}
      >
        <Text className="text-sm text-primary">{issueLabel(issue)}</Text>
      </Pressable>
      {archived.isLoading ? (
        <Text className="text-sm text-foreground-muted">Loading related threads.</Text>
      ) : null}
      {archived.error === null ? null : (
        <Text className="text-sm text-foreground-muted">{archived.error}</Text>
      )}
      {related.length > 0 ? (
        <ScrollView
          className="max-h-32"
          contentContainerClassName="gap-1"
          keyboardShouldPersistTaps="handled"
        >
          {related.map((thread) => (
            <Pressable
              key={thread.id}
              accessibilityRole="button"
              onPress={() => {
                void Haptics.selectionAsync();
                navigation.dispatch(
                  StackActions.push("Thread", {
                    environmentId: props.environmentId,
                    threadId: thread.id,
                  }),
                );
              }}
            >
              <Text className="text-sm text-foreground">{thread.title}</Text>
            </Pressable>
          ))}
        </ScrollView>
      ) : null}
      <Pressable
        accessibilityRole="button"
        onPress={() => {
          void unlinkIssue({
            environmentId: props.environmentId,
            input: {
              threadId: props.threadId,
              host: issue.host,
              repository: issue.repository,
              number: issue.number,
            },
          });
        }}
      >
        <Text className="text-sm text-foreground-muted">Unlink issue</Text>
      </Pressable>
    </View>
  );
}
