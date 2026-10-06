import { assert, it, vi } from "@effect/vitest";
import { GitCommandError, ProjectId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import { ChildProcessSpawner } from "effect/process";

import * as TerminalManager from "../terminal/Manager.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as ProjectService from "./ProjectService.ts";
import * as ProjectSetupScriptRunner from "./ProjectSetupScriptRunner.ts";

const gitWithPrefix = (prefix: string | null) =>
  Layer.mock(GitVcsDriver.GitVcsDriver)({
    execute: (input) =>
      prefix === null
        ? Effect.fail(
            new GitCommandError({
              operation: input.operation,
              command: "git rev-parse --show-prefix",
              cwd: input.cwd,
              detail: "not a git repository",
            }),
          )
        : Effect.succeed({
            exitCode: ChildProcessSpawner.ExitCode(0),
            stdout: input.args.includes("--show-prefix") ? `${prefix}\n` : "",
            stderr: "",
            stdoutTruncated: false,
            stderrTruncated: false,
          }),
  });

it.effect("resolves setup scripts through the standalone project service", () => {
  const open = vi.fn((input: Parameters<TerminalManager.TerminalManager["Service"]["open"]>[0]) =>
    Effect.succeed({
      threadId: input.threadId,
      terminalId: input.terminalId,
      cwd: input.cwd,
      worktreePath: input.worktreePath ?? null,
      status: "running" as const,
      pid: 123,
      history: "",
      exitCode: null,
      exitSignal: null,
      label: "Shell",
      updatedAt: "2026-06-20T00:00:00.000Z",
    }),
  );
  const write = vi.fn(
    (_input: Parameters<TerminalManager.TerminalManager["Service"]["write"]>[0]) => Effect.void,
  );
  const listeners: Array<Parameters<TerminalManager.TerminalManager["Service"]["subscribe"]>[0]> =
    [];
  const subscribe: TerminalManager.TerminalManager["Service"]["subscribe"] = (listener) =>
    Effect.sync(() => {
      listeners.push(listener);
      return () => undefined;
    });
  const projectId = ProjectId.make("project:setup-runner-v2");
  const project = {
    id: projectId,
    title: "Project",
    workspaceRoot: "/repo",
    repositoryIdentity: null,
    faviconPath: null,
    defaultModelSelection: null,
    scripts: [
      {
        id: "setup",
        name: "Setup",
        command: "vp install",
        icon: "configure" as const,
        runOnWorktreeCreate: true,
      },
    ],
    createdAt: "2026-06-20T00:00:00.000Z",
    updatedAt: "2026-06-20T00:00:00.000Z",
    deletedAt: null,
  };
  const layer = ProjectSetupScriptRunner.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(ProjectService.ProjectService)({
          getById: () => Effect.succeed(Option.some(project)),
        }),
        Layer.mock(TerminalManager.TerminalManager)({ open, write, subscribe }),
        gitWithPrefix(""),
        FileSystem.layerNoop({ exists: () => Effect.succeed(true) }),
        Path.layer,
        ServerSettings.layerTest(),
      ),
    ),
  );

  return Effect.gen(function* () {
    const runner = yield* ProjectSetupScriptRunner.ProjectSetupScriptRunner;
    const result = yield* runner.runForThread({
      threadId: "thread-1",
      projectId,
      worktreePath: "/repo-worktree",
    });
    assert.deepEqual(result, {
      status: "started",
      async: true,
      scriptId: "setup",
      scriptName: "Setup",
      scriptCommand: "vp install",
      terminalId: "setup-setup",
      cwd: "/repo-worktree",
    });
    assert.equal(open.mock.calls[0]?.[0].cwd, "/repo-worktree");
    assert.deepEqual(open.mock.calls[0]?.[0].env, {
      T3CODE_PROJECT_ROOT: "/repo",
      T3CODE_WORKTREE_PATH: "/repo-worktree",
      COLORTERM: "",
      NO_COLOR: "1",
      FORCE_COLOR: "0",
    });
    assert.equal(write.mock.calls[0]?.[0].data, "vp install\r");
    const lines: string[] = [];
    const observed = yield* runner.runForThread({
      threadId: "thread-1",
      projectId,
      worktreePath: "/repo-worktree",
      observeCompletion: {
        onOutputLine: (line) =>
          Effect.sync(() => {
            lines.push(line);
          }),
      },
    });
    assert.equal(observed.status, "started");
    const listener = listeners[0]!;
    yield* listener({
      type: "output",
      threadId: "thread-1",
      terminalId: "setup-setup",
      data: "Downloading 10%\rDownloading 20%\r\nDone\n",
    });
    assert.deepEqual(lines, ["Downloading 10%", "Downloading 20%", "Done"]);
    yield* listener({ type: "closed", threadId: "thread-1", terminalId: "setup-setup" });
  }).pipe(Effect.provide(layer));
});

const runSetupForSubfolderProject = (
  worktreeHasSubfolder: boolean,
  prefix: string | null = "packages/app/",
) => {
  const open = vi.fn((input: Parameters<TerminalManager.TerminalManager["Service"]["open"]>[0]) =>
    Effect.succeed({
      threadId: input.threadId,
      terminalId: input.terminalId,
      cwd: input.cwd,
      worktreePath: input.worktreePath ?? null,
      status: "running" as const,
      pid: 123,
      history: "",
      exitCode: null,
      exitSignal: null,
      label: "Shell",
      updatedAt: "2026-06-20T00:00:00.000Z",
    }),
  );
  const projectId = ProjectId.make("project:setup-runner-subfolder");
  const layer = ProjectSetupScriptRunner.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(ProjectService.ProjectService)({
          getById: () =>
            Effect.succeed(
              Option.some({
                id: projectId,
                title: "App",
                workspaceRoot: "/repo/packages/app",
                repositoryIdentity: null,
                faviconPath: null,
                defaultModelSelection: null,
                scripts: [
                  {
                    id: "setup",
                    name: "Setup",
                    command: "vp install",
                    icon: "configure" as const,
                    runOnWorktreeCreate: true,
                  },
                ],
                createdAt: "2026-06-20T00:00:00.000Z",
                updatedAt: "2026-06-20T00:00:00.000Z",
                deletedAt: null,
              }),
            ),
        }),
        Layer.mock(TerminalManager.TerminalManager)({
          open,
          write: () => Effect.void,
          subscribe: () => Effect.succeed(() => undefined),
        }),
        gitWithPrefix(prefix),
        FileSystem.layerNoop({ exists: () => Effect.succeed(worktreeHasSubfolder) }),
        Path.layer,
        ServerSettings.layerTest(),
      ),
    ),
  );
  return Effect.gen(function* () {
    const runner = yield* ProjectSetupScriptRunner.ProjectSetupScriptRunner;
    const result = yield* runner.runForThread({
      threadId: "thread-1",
      projectId,
      worktreePath: "/worktree",
    });
    return { result, openedCwd: open.mock.calls[0]?.[0].cwd };
  }).pipe(Effect.provide(layer));
};

it.effect("runs setup in the project's subfolder of the worktree", () =>
  Effect.gen(function* () {
    const { result, openedCwd } = yield* runSetupForSubfolderProject(true);
    assert.equal(openedCwd, "/worktree/packages/app");
    assert.equal(result.status === "started" ? result.cwd : null, "/worktree/packages/app");
  }),
);

it.effect("runs setup at the worktree root when the subfolder is missing there", () =>
  Effect.gen(function* () {
    const { openedCwd } = yield* runSetupForSubfolderProject(false);
    assert.equal(openedCwd, "/worktree");
  }),
);

it.effect("runs setup at the worktree root when git cannot read the project's prefix", () =>
  Effect.gen(function* () {
    const { openedCwd } = yield* runSetupForSubfolderProject(true, null);
    assert.equal(openedCwd, "/worktree");
  }),
);
