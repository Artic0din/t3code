import { useNavigate } from "@tanstack/react-router";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";

import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";

import { buildThreadRouteParams } from "../../threadRoutes";
import { Button } from "../ui/button";
import { ThreadDetailsSection } from "./ThreadDetailsSection";

export function TaskContextGroupPanel(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
}) {
  const navigate = useNavigate();
  const query = useEnvironmentQuery(
    serverEnvironment.taskContextGroupForThread({
      environmentId: props.environmentId,
      input: { threadId: props.threadId },
    }),
  );
  const mutate = useAtomCommand(serverEnvironment.mutateTaskContextGroup, {
    label: "task context group",
  });
  const group = query.data?.group ?? null;
  const related = query.data?.relatedThreads ?? [];
  const unavailable =
    group?.resources.filter(
      (resource) =>
        (resource.kind === "project" || resource.kind === "thread") &&
        resource.availability !== undefined &&
        resource.availability !== "available",
    ) ?? [];

  if (query.error === null && group === null) {
    return (
      <ThreadDetailsSection headingId="thread-details-task-context-heading" title="Shared context">
        <div className="flex items-center justify-between gap-2 px-3 py-2">
          <p className="text-sm text-muted-foreground">No shared task context for this thread.</p>
          <Button
            size="xs"
            variant="ghost"
            onClick={() => {
              void mutate({
                environmentId: props.environmentId,
                input: { action: "create", threadId: props.threadId },
              });
            }}
          >
            Create
          </Button>
        </div>
      </ThreadDetailsSection>
    );
  }

  if (group === null) {
    return (
      <ThreadDetailsSection headingId="thread-details-task-context-heading" title="Shared context">
        <p className="px-3 py-2 text-sm text-muted-foreground">
          Shared context could not be loaded.
        </p>
      </ThreadDetailsSection>
    );
  }

  return (
    <ThreadDetailsSection headingId="thread-details-task-context-heading" title="Shared context">
      <div className="flex flex-col gap-2 px-3 py-2">
        <p className="text-sm font-medium text-foreground">{group.title}</p>
        {group.brief.trim().length > 0 ? (
          <p className="whitespace-pre-wrap text-sm text-muted-foreground">{group.brief}</p>
        ) : (
          <p className="text-sm text-muted-foreground">No brief yet.</p>
        )}
        {related.length > 0 ? (
          <div className="flex flex-col gap-1">
            <p className="text-xs text-muted-foreground">Related threads</p>
            {related.map((thread) => (
              <Button
                key={thread.threadId}
                size="xs"
                variant="ghost"
                onClick={() => {
                  void navigate({
                    to: "/$environmentId/$threadId",
                    params: buildThreadRouteParams(
                      scopeThreadRef(props.environmentId, thread.threadId),
                    ),
                  });
                }}
              >
                {thread.title}
              </Button>
            ))}
          </div>
        ) : null}
        {unavailable.length > 0 ? (
          <p className="text-sm text-destructive">
            {unavailable.length === 1
              ? "One linked resource is missing or inaccessible."
              : `${unavailable.length} linked resources are missing or inaccessible.`}
          </p>
        ) : null}
      </div>
    </ThreadDetailsSection>
  );
}
