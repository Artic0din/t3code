import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import {
  ProjectId,
  TaskContextGroupId,
  ThreadId,
  turnReceivedTaskContext,
  type Project,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as ServerConfig from "../config.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as TaskContextGroupService from "./TaskContextGroupService.ts";
import * as ThreadManagementService from "./ThreadManagementService.ts";

const projectA = ProjectId.make("project:frontend");
const projectB = ProjectId.make("project:backend");
const threadA = ThreadId.make("thread:frontend");
const threadB = ThreadId.make("thread:backend");

const project = (id: ProjectId, title: string): Project => ({
  id,
  title,
  workspaceRoot: `/repos/${title}`,
  defaultModelSelection: null,
  scripts: [],
  createdAt: "2026-10-13T00:00:00.000Z",
  updatedAt: "2026-10-13T00:00:00.000Z",
  deletedAt: null,
});

const shell = (id: ThreadId, projectId: ProjectId, worktreePath: string | null) =>
  ({
    id,
    projectId,
    title: String(id),
    worktreePath,
    deletedAt: null,
  }) as never;

const layerThreads = Layer.mock(ThreadManagementService.ThreadManagementService)({
  getThreadShell: (threadId) =>
    Effect.succeed(
      threadId === threadA
        ? shell(threadA, projectA, "/wt/frontend")
        : threadId === threadB
          ? shell(threadB, projectB, "/wt/backend")
          : null,
    ),
  getShellSnapshot: () =>
    Effect.succeed({
      threads: [shell(threadA, projectA, "/wt/frontend"), shell(threadB, projectB, "/wt/backend")],
      archivedThreads: [],
    } as never),
});

const layerProjects = Layer.mock(ProjectService.ProjectService)({
  getById: (projectId) =>
    Effect.succeed(
      projectId === projectA
        ? Option.some(project(projectA, "Frontend"))
        : projectId === projectB
          ? Option.some(project(projectB, "Backend"))
          : Option.none(),
    ),
});

const withService = <A, E>(
  body: (
    service: TaskContextGroupService.TaskContextGroupService["Service"],
  ) => Effect.Effect<A, E>,
) =>
  Effect.gen(function* () {
    const service = yield* TaskContextGroupService.TaskContextGroupService;
    return yield* body(service);
  }).pipe(
    Effect.provide(
      TaskContextGroupService.layer.pipe(
        Layer.provide(
          Layer.mergeAll(
            layerThreads,
            layerProjects,
            ServerConfig.layerTest(process.cwd(), { prefix: "t3-task-context-" }),
          ),
        ),
        Layer.provideMerge(NodeServices.layer),
      ),
    ),
  );

describe("TaskContextGroupService", () => {
  it.effect("creates a group, attaches a sibling thread and project resource, and persists", () =>
    withService((service) =>
      Effect.gen(function* () {
        const created = yield* service.mutate({
          action: "create",
          threadId: threadA,
          title: "Auth cutover",
          brief: "Ship auth across web and API.",
        });
        assert.equal(created.group.title, "Auth cutover");
        assert.deepEqual(created.group.memberThreadIds, [threadA]);

        const attached = yield* service.mutate({
          action: "attach-thread",
          groupId: created.group.id,
          threadId: threadB,
        });
        assert.deepEqual(attached.group.memberThreadIds, [threadA, threadB]);

        const withProject = yield* service.mutate({
          action: "attach-resource",
          groupId: created.group.id,
          resource: { kind: "project", projectId: projectB },
        });
        assert.equal(withProject.group.resources[0]?.kind, "project");
        if (withProject.group.resources[0]?.kind === "project") {
          assert.equal(withProject.group.resources[0].name, "Backend");
          assert.equal(withProject.group.resources[0].availability, "available");
        }

        const reloaded = yield* service.get(created.group.id);
        assert.isNotNull(reloaded.group);
        assert.equal(reloaded.group?.brief, "Ship auth across web and API.");

        const forThread = yield* service.forThread(threadA);
        assert.equal(forThread.group?.id, created.group.id);
        assert.deepEqual(
          forThread.relatedThreads.map((thread) => thread.threadId),
          [threadB],
        );
      }),
    ),
  );

  it.effect("refuses client filesystem paths and keeps checkpoint cwd on the owning thread", () =>
    withService((service) =>
      Effect.gen(function* () {
        const created = yield* service.mutate({
          action: "create",
          threadId: threadA,
          brief: "v1",
        });
        const refused = yield* service
          .mutate({
            action: "attach-resource",
            groupId: created.group.id,
            resource: {
              kind: "note",
              title: "Bad",
              body: "x",
              path: "/Users/me/secret.ts",
            } as never,
          })
          .pipe(Effect.flip);
        assert.equal(refused.code, "path_refused");

        const enriched = yield* service.enrichTurn({
          threadId: threadA,
          text: "Continue.",
          context: undefined,
        });
        assert.equal(enriched.checkpointCwd, "/wt/frontend");
        assert.equal(enriched.projectId, projectA);
        const snapshot = turnReceivedTaskContext(enriched.context);
        assert.equal(snapshot?.brief, "v1");

        yield* service.mutate({
          action: "update-brief",
          groupId: created.group.id,
          brief: "v2",
        });
        assert.equal(snapshot?.brief, "v1");
        const next = yield* service.enrichTurn({
          threadId: threadA,
          text: "Next.",
          context: undefined,
        });
        assert.equal(turnReceivedTaskContext(next.context)?.brief, "v2");
      }),
    ),
  );

  it.effect("marks missing projects and rejects non-http urls", () =>
    withService((service) =>
      Effect.gen(function* () {
        const created = yield* service.mutate({ action: "create", threadId: threadA });
        const badUrl = yield* service
          .mutate({
            action: "attach-resource",
            groupId: created.group.id,
            resource: { kind: "url", title: "Local", url: "file:///tmp/x" },
          })
          .pipe(Effect.flip);
        assert.equal(badUrl.code, "invalid_resource");

        const missing = yield* service
          .mutate({
            action: "attach-resource",
            groupId: created.group.id,
            resource: { kind: "project", projectId: ProjectId.make("project:missing") },
          })
          .pipe(Effect.flip);
        assert.equal(missing.code, "project_not_found");

        const groupId = TaskContextGroupId.make("tcg_missing");
        const notFound = yield* service
          .mutate({ action: "update-brief", groupId, brief: "x" })
          .pipe(Effect.flip);
        assert.equal(notFound.code, "not_found");
      }),
    ),
  );
});
