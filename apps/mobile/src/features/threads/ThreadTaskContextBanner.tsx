import { useAtomValue } from "@effect/atom-react";
import { StackActions, useNavigation } from "@react-navigation/native";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import {
  taskContextAccess,
  taskContextBriefAfterMutation,
  taskContextResourceInput,
  TASK_CONTEXT_RESOURCE_KINDS,
  type TaskContextResourceDraft,
} from "@t3tools/client-runtime/task-context-group";
import {
  TASK_CONTEXT_BRIEF_MAX_CHARS,
  TASK_CONTEXT_NOTE_MAX_CHARS,
  TASK_CONTEXT_TITLE_MAX_CHARS,
  type EnvironmentId,
  type TaskContextGroupMutateInput,
  type ThreadId,
} from "@t3tools/contracts";
import { useState } from "react";
import { KeyboardAvoidingView, Linking, Modal, Platform, ScrollView, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AppText as Text, AppTextInput } from "../../components/AppText";
import { ControlPill, ControlPillMenu } from "../../components/ControlPill";
import { useProjects, useThreadShells } from "../../state/entities";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { environmentSession } from "../../state/session";
import { useAtomCommand } from "../../state/use-atom-command";

type Props = { readonly environmentId: EnvironmentId; readonly threadId: ThreadId };

function Picker(props: {
  label: string;
  value: string | null;
  choices: ReadonlyArray<{ value: string; label: string }>;
  disabled: boolean;
  onChange: (value: string) => void;
}) {
  return (
    <ControlPillMenu
      title={props.label}
      actions={props.choices.map((item) => ({
        id: item.value,
        title: item.label,
        state: item.value === props.value ? "on" : "off",
        attributes: { disabled: props.disabled },
      }))}
      onPressAction={({ nativeEvent }) => props.onChange(nativeEvent.event)}
    >
      <ControlPill
        variant="pill"
        label={props.choices.find((item) => item.value === props.value)?.label ?? props.label}
        accessibilityLabel={props.label}
        disabled={props.disabled}
      />
    </ControlPillMenu>
  );
}

export function ThreadTaskContextBanner(props: Props) {
  const config = useAtomValue(serverEnvironment.configValueAtom(props.environmentId));
  if (config?.environment.capabilities.taskContextGroups !== true) return null;
  return <TaskContextControls key={`${props.environmentId}:${props.threadId}`} {...props} />;
}

function TaskContextControls(props: Props) {
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();
  const session = useEnvironmentQuery(environmentSession.sessionStateAtom(props.environmentId));
  const access = taskContextAccess({ taskContextGroups: true }, session.data);
  const query = useEnvironmentQuery(
    access.readable
      ? serverEnvironment.taskContextGroupForThread({
          environmentId: props.environmentId,
          input: { threadId: props.threadId },
        })
      : null,
  );
  const group = query.data?.group ?? null;
  const [open, setOpen] = useState(false);
  const groups = useEnvironmentQuery(
    access.readable && open && group === null
      ? serverEnvironment.taskContextGroupsList({
          environmentId: props.environmentId,
          input: {},
        })
      : null,
  );
  const threads = useThreadShells().filter(
    (thread) => thread.environmentId === props.environmentId,
  );
  const projects = useProjects().filter((project) => project.environmentId === props.environmentId);
  const mutate = useAtomCommand(serverEnvironment.mutateTaskContextGroup, { reportFailure: false });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [brief, setBrief] = useState("");
  const [title, setTitle] = useState("");
  const [joining, setJoining] = useState<string | null>(null);
  const [attaching, setAttaching] = useState<string | null>(null);
  const [resource, setResource] = useState<TaskContextResourceDraft>({
    kind: "note",
    title: "",
    text: "",
    threadId: null,
    projectId: null,
  });
  const disabled = busy || !access.writable;
  const resourceInput = taskContextResourceInput(resource);
  const perform = async (input: TaskContextGroupMutateInput) => {
    if (disabled) return;
    setBusy(true);
    setError(null);
    try {
      const result = await mutate({ environmentId: props.environmentId, input });
      if (result._tag === "Failure") {
        const cause = squashAtomCommandFailure(result);
        setError(cause instanceof Error ? cause.message : "Shared context could not be updated.");
      } else {
        setAttaching(null);
        setBrief((draft) =>
          taskContextBriefAfterMutation({
            threadId: props.threadId,
            draft,
            mutation: input,
            savedBrief: result.value.group.brief,
          }),
        );
        if (input.action === "attach-resource")
          setResource({ ...resource, title: "", text: "", threadId: null, projectId: null });
        if (input.action === "detach-thread" && input.threadId === props.threadId) setOpen(false);
      }
    } catch {
      setError("Shared context could not be updated. Retry the change.");
    } finally {
      setBusy(false);
    }
  };
  if (!access.readable || (query.isPending && query.data === null) || query.error !== null) {
    return (
      <View className="gap-2 px-4 py-2">
        <Text accessibilityRole="text">
          {session.error ??
            query.error ??
            (session.data === null || query.isPending
              ? "Loading shared context..."
              : "This connection cannot read shared context.")}
        </Text>
        {session.error || query.error ? (
          <ControlPill
            variant="pill"
            label="Retry shared context"
            onPress={() => {
              session.refresh();
              query.refresh();
            }}
          />
        ) : null}
      </View>
    );
  }
  return (
    <>
      <View className="gap-1 px-4 py-2">
        <Text className="text-sm font-t3-semibold">{group?.title ?? "Shared context"}</Text>
        {group?.brief ? (
          <Text className="text-sm text-foreground-muted" numberOfLines={3}>
            {group.brief}
          </Text>
        ) : null}
        {(query.data?.relatedThreads ?? []).map((thread) => (
          <ControlPill
            key={thread.threadId}
            variant="pill"
            label={thread.title}
            disabled={thread.availability === "missing"}
            onPress={() =>
              navigation.dispatch(
                StackActions.push("Thread", {
                  environmentId: props.environmentId,
                  threadId: thread.threadId,
                }),
              )
            }
          />
        ))}
        {group?.resources.some(
          (item) =>
            (item.kind === "thread" || item.kind === "project") &&
            item.availability !== "available",
        ) ? (
          <Text className="text-sm text-danger-foreground">
            A linked resource is missing or inaccessible.
          </Text>
        ) : null}
        <ControlPill
          variant="pill"
          label={group === null ? "Set up shared context" : "Open shared context"}
          onPress={() => {
            setBrief(group?.brief ?? "");
            setOpen(true);
          }}
        />
      </View>
      <Modal visible={open} animationType="slide" onRequestClose={() => setOpen(false)}>
        <KeyboardAvoidingView
          className="flex-1 bg-background"
          behavior={Platform.OS === "ios" ? "padding" : undefined}
        >
          <ScrollView
            keyboardShouldPersistTaps="handled"
            contentContainerStyle={{
              padding: 16,
              gap: 16,
              paddingTop: insets.top + 16,
              paddingBottom: insets.bottom + 24,
            }}
          >
            <View className="flex-row items-center justify-between">
              <Text className="text-lg font-t3-semibold">Shared context</Text>
              <ControlPill variant="pill" label="Done" onPress={() => setOpen(false)} />
            </View>
            {group === null ? (
              <>
                <Text>No shared task context for this thread.</Text>
                <Text>Group title</Text>
                <AppTextInput
                  accessibilityLabel="Group title"
                  maxLength={TASK_CONTEXT_TITLE_MAX_CHARS}
                  value={title}
                  onChangeText={setTitle}
                  editable={!disabled}
                />
                <ControlPill
                  variant="primary"
                  label="Create shared context"
                  disabled={disabled}
                  onPress={() => {
                    void perform({
                      action: "create",
                      threadId: props.threadId,
                      ...(title.trim() ? { title: title.trim() } : {}),
                    });
                  }}
                />
                {groups.isPending ? <Text>Loading existing groups...</Text> : null}
                {groups.error ? (
                  <>
                    <Text className="text-danger-foreground">{groups.error}</Text>
                    <ControlPill variant="pill" label="Retry groups" onPress={groups.refresh} />
                  </>
                ) : null}
                {(groups.data?.groups.length ?? 0) > 0 ? (
                  <>
                    <Picker
                      label="Existing group"
                      value={joining}
                      disabled={disabled}
                      choices={(groups.data?.groups ?? []).map((item) => ({
                        value: item.id,
                        label: item.title,
                      }))}
                      onChange={setJoining}
                    />
                    <ControlPill
                      variant="pill"
                      label="Join group"
                      disabled={disabled || joining === null}
                      onPress={() => {
                        const selected = groups.data?.groups.find((item) => item.id === joining);
                        if (selected)
                          void perform({
                            action: "attach-thread",
                            groupId: selected.id,
                            threadId: props.threadId,
                          });
                      }}
                    />
                  </>
                ) : null}
              </>
            ) : (
              <>
                <Text className="text-lg font-t3-semibold">{group.title}</Text>
                <Text>Shared brief</Text>
                <AppTextInput
                  accessibilityLabel="Shared brief"
                  maxLength={TASK_CONTEXT_BRIEF_MAX_CHARS}
                  value={brief}
                  onChangeText={setBrief}
                  editable={!disabled}
                  multiline
                  textAlignVertical="top"
                />
                <ControlPill
                  variant="primary"
                  label="Save brief"
                  disabled={disabled}
                  onPress={() => {
                    void perform({ action: "update-brief", groupId: group.id, brief });
                  }}
                />
                {(query.data?.relatedThreads ?? []).map((thread) => (
                  <View
                    key={thread.threadId}
                    className="flex-row items-center justify-between gap-2"
                  >
                    <Text className="flex-1">{thread.title}</Text>
                    <ControlPill
                      variant="pill"
                      label="Detach"
                      disabled={disabled}
                      onPress={() => {
                        void perform({
                          action: "detach-thread",
                          groupId: group.id,
                          threadId: thread.threadId,
                        });
                      }}
                    />
                  </View>
                ))}
                <Picker
                  label="Thread to attach"
                  value={attaching}
                  disabled={disabled}
                  choices={threads
                    .filter((item) => !group.memberThreadIds.includes(item.id))
                    .map((item) => ({ value: item.id, label: item.title }))}
                  onChange={setAttaching}
                />
                <ControlPill
                  variant="pill"
                  label="Attach thread"
                  disabled={disabled || attaching === null}
                  onPress={() => {
                    const selected = threads.find((item) => item.id === attaching);
                    if (selected)
                      void perform({
                        action: "attach-thread",
                        groupId: group.id,
                        threadId: selected.id,
                      });
                  }}
                />
                <Text>Resources</Text>
                {group.resources.length === 0 ? (
                  <Text className="text-foreground-muted">No resources attached.</Text>
                ) : null}
                {group.resources.map((item) => (
                  <View key={item.resourceId} className="gap-2">
                    <Text>
                      {item.kind === "project"
                        ? (item.name ?? item.projectId)
                        : item.kind === "thread"
                          ? (item.title ?? item.threadId)
                          : item.title}
                    </Text>
                    {item.kind === "note" ? (
                      <Text selectable>{item.body}</Text>
                    ) : item.kind === "url" ? (
                      <Text
                        accessibilityRole="link"
                        onPress={() => {
                          void Linking.openURL(item.url).catch(() =>
                            setError("The resource URL could not be opened."),
                          );
                        }}
                      >
                        {item.url}
                      </Text>
                    ) : item.availability !== "available" ? (
                      <Text className="text-danger-foreground">
                        Resource {item.availability ?? "unavailable"}.
                      </Text>
                    ) : null}
                    <ControlPill
                      variant="pill"
                      label="Remove resource"
                      disabled={disabled}
                      onPress={() => {
                        void perform({
                          action: "detach-resource",
                          groupId: group.id,
                          resourceId: item.resourceId,
                        });
                      }}
                    />
                  </View>
                ))}
                <Picker
                  label="Resource type"
                  value={resource.kind}
                  disabled={disabled}
                  choices={TASK_CONTEXT_RESOURCE_KINDS.map((kind) => ({
                    value: kind,
                    label: kind,
                  }))}
                  onChange={(value) => {
                    const kind = TASK_CONTEXT_RESOURCE_KINDS.find((item) => item === value);
                    if (kind) setResource({ ...resource, kind });
                  }}
                />
                {resource.kind === "note" || resource.kind === "url" ? (
                  <>
                    <Text>Resource title</Text>
                    <AppTextInput
                      accessibilityLabel="Resource title"
                      maxLength={TASK_CONTEXT_TITLE_MAX_CHARS}
                      value={resource.title}
                      editable={!disabled}
                      onChangeText={(value) => setResource({ ...resource, title: value })}
                    />
                    <Text>{resource.kind === "note" ? "Note text" : "Resource URL"}</Text>
                    <AppTextInput
                      accessibilityLabel={resource.kind === "note" ? "Note text" : "Resource URL"}
                      maxLength={resource.kind === "note" ? TASK_CONTEXT_NOTE_MAX_CHARS : 2048}
                      value={resource.text}
                      editable={!disabled}
                      multiline={resource.kind === "note"}
                      autoCapitalize={resource.kind === "url" ? "none" : "sentences"}
                      onChangeText={(value) => setResource({ ...resource, text: value })}
                    />
                  </>
                ) : resource.kind === "thread" ? (
                  <Picker
                    label="Thread reference"
                    value={resource.threadId}
                    disabled={disabled}
                    choices={threads.map((item) => ({ value: item.id, label: item.title }))}
                    onChange={(value) =>
                      setResource({
                        ...resource,
                        threadId: threads.find((item) => item.id === value)?.id ?? null,
                      })
                    }
                  />
                ) : (
                  <Picker
                    label="Project reference"
                    value={resource.projectId}
                    disabled={disabled}
                    choices={projects.map((item) => ({ value: item.id, label: item.title }))}
                    onChange={(value) =>
                      setResource({
                        ...resource,
                        projectId: projects.find((item) => item.id === value)?.id ?? null,
                      })
                    }
                  />
                )}
                <ControlPill
                  variant="pill"
                  label="Attach resource"
                  disabled={disabled || resourceInput === null}
                  onPress={() => {
                    if (resourceInput)
                      void perform({
                        action: "attach-resource",
                        groupId: group.id,
                        resource: resourceInput,
                      });
                  }}
                />
                <ControlPill
                  variant="pill"
                  label="Leave shared context"
                  disabled={disabled}
                  onPress={() => {
                    void perform({
                      action: "detach-thread",
                      groupId: group.id,
                      threadId: props.threadId,
                    });
                  }}
                />
              </>
            )}
            {!access.writable ? (
              <Text className="text-foreground-muted">
                This connection can read shared context. Editing requires orchestration access.
              </Text>
            ) : null}
            {busy ? <Text>Saving shared context...</Text> : null}
            {error ? (
              <Text accessibilityRole="alert" className="text-danger-foreground">
                {error}
              </Text>
            ) : null}
          </ScrollView>
        </KeyboardAvoidingView>
      </Modal>
    </>
  );
}
