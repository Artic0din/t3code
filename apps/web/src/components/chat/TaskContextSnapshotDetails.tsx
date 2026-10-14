import { isHttpUrl, type TaskContextTurnSnapshot } from "@t3tools/contracts";

export function TaskContextSnapshotDetails({ snapshot }: { snapshot: TaskContextTurnSnapshot }) {
  return (
    <div className="flex max-h-80 flex-col gap-3 overflow-y-auto p-2 text-sm">
      <p className="font-medium">{snapshot.title}</p>
      <p className="text-muted-foreground">
        Captured {new Date(snapshot.capturedAt).toLocaleString()}
      </p>
      <p className="whitespace-pre-wrap">{snapshot.brief || "No shared brief was supplied."}</p>
      {snapshot.resources.length === 0 ? (
        <p className="text-muted-foreground">No resources were supplied.</p>
      ) : (
        snapshot.resources.map((resource) => (
          <div key={resource.resourceId}>
            <p className="font-medium">
              {resource.kind === "project"
                ? (resource.name ?? resource.projectId)
                : resource.kind === "thread"
                  ? (resource.title ?? resource.threadId)
                  : resource.title}
            </p>
            {resource.kind === "note" ? (
              <p className="whitespace-pre-wrap">{resource.body}</p>
            ) : resource.kind === "url" && isHttpUrl(resource.url) ? (
              <a
                className="break-all underline"
                href={resource.url}
                target="_blank"
                rel="noreferrer"
              >
                {resource.url}
              </a>
            ) : resource.kind === "url" ? (
              <p className="break-all">{resource.url}</p>
            ) : (
              <p className="text-muted-foreground">{resource.availability ?? "unavailable"}</p>
            )}
          </div>
        ))
      )}
      <details>
        <summary>Member threads ({snapshot.memberThreadIds.length})</summary>
        <p className="whitespace-pre-wrap break-all text-muted-foreground">
          {snapshot.memberThreadIds.join("\n")}
        </p>
      </details>
      <p className="text-muted-foreground">
        References do not change this thread's repository access.
      </p>
    </div>
  );
}
