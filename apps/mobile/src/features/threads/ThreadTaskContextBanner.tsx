import { StackActions, useNavigation } from "@react-navigation/native";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import * as Haptics from "expo-haptics";
import { Pressable, Text, View } from "react-native";

import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";

export function ThreadTaskContextBanner(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
}) {
  const navigation = useNavigation();
  const query = useEnvironmentQuery(
    serverEnvironment.taskContextGroupForThread({
      environmentId: props.environmentId,
      input: { threadId: props.threadId },
    }),
  );
  const group = query.data?.group ?? null;
  const related = query.data?.relatedThreads ?? [];
  if (group === null) return null;
  const unavailable = group.resources.some(
    (resource) =>
      (resource.kind === "project" || resource.kind === "thread") &&
      resource.availability !== undefined &&
      resource.availability !== "available",
  );
  return (
    <View className="gap-1 px-4 py-2">
      <Text className="text-sm font-medium text-foreground">{group.title}</Text>
      {group.brief.trim().length > 0 ? (
        <Text className="text-sm text-foreground-muted" numberOfLines={3}>
          {group.brief}
        </Text>
      ) : null}
      {related.map((thread) => (
        <Pressable
          key={thread.threadId}
          accessibilityRole="button"
          onPress={() => {
            void Haptics.selectionAsync();
            navigation.dispatch(
              StackActions.push("Thread", {
                environmentId: props.environmentId,
                threadId: thread.threadId,
              }),
            );
          }}
        >
          <Text className="text-sm text-foreground">{thread.title}</Text>
        </Pressable>
      ))}
      {unavailable ? (
        <Text className="text-sm text-danger-foreground">
          A linked resource is missing or inaccessible.
        </Text>
      ) : null}
    </View>
  );
}
