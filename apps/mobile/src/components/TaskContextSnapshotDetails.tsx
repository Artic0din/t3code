import type { TaskContextTurnSnapshot } from "@t3tools/contracts";
import { View } from "react-native";
import { AppText as Text } from "./AppText";

export function TaskContextSnapshotDetails({ snapshot }: { snapshot: TaskContextTurnSnapshot }) {
  return (
    <View className="gap-3">
      <Text className="font-t3-semibold">{snapshot.title}</Text>
      <Text className="text-sm text-foreground-muted">
        Captured {new Date(snapshot.capturedAt).toLocaleString()}
      </Text>
      <Text selectable>{snapshot.brief || "No shared brief was supplied."}</Text>
      {snapshot.resources.length === 0 ? (
        <Text className="text-foreground-muted">No resources were supplied.</Text>
      ) : (
        snapshot.resources.map((resource) => (
          <View key={resource.resourceId}>
            <Text className="font-t3-semibold">
              {resource.kind === "project"
                ? (resource.name ?? resource.projectId)
                : resource.kind === "thread"
                  ? (resource.title ?? resource.threadId)
                  : resource.title}
            </Text>
            <Text selectable>
              {resource.kind === "note"
                ? resource.body
                : resource.kind === "url"
                  ? resource.url
                  : (resource.availability ?? "unavailable")}
            </Text>
          </View>
        ))
      )}
      <Text className="text-sm text-foreground-muted">
        Member threads ({snapshot.memberThreadIds.length})
      </Text>
      <Text selectable className="text-sm">
        {snapshot.memberThreadIds.join("\n")}
      </Text>
      <Text className="text-sm text-foreground-muted">
        References do not change this thread's repository access.
      </Text>
    </View>
  );
}
