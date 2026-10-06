import { describe, expect, it } from "vite-plus/test";

import { projectScriptRunCwd } from "./projectScripts.ts";

describe("projectScriptRunCwd", () => {
  it("runs in the project folder without a worktree", () => {
    expect(
      projectScriptRunCwd({
        project: { cwd: "/repo/packages/app" },
        repositoryRoot: "/repo",
        worktreePath: null,
      }),
    ).toBe("/repo/packages/app");
  });

  it("maps a subfolder project into the worktree", () => {
    expect(
      projectScriptRunCwd({
        project: { cwd: "/repo/packages/app" },
        repositoryRoot: "/repo/",
        worktreePath: "/worktrees/repo-1a2b/feature",
      }),
    ).toBe("/worktrees/repo-1a2b/feature/packages/app");
  });

  it("uses the worktree root for a root project", () => {
    expect(
      projectScriptRunCwd({
        project: { cwd: "/repo" },
        repositoryRoot: "/repo",
        worktreePath: "/worktrees/feature",
      }),
    ).toBe("/worktrees/feature");
  });

  it("falls back to the worktree root when the repository root is unknown or unrelated", () => {
    for (const repositoryRoot of [null, "/other", "/rep"]) {
      expect(
        projectScriptRunCwd({
          project: { cwd: "/repo/app" },
          repositoryRoot,
          worktreePath: "/worktrees/feature",
        }),
      ).toBe("/worktrees/feature");
    }
  });

  it("maps Windows paths with the worktree's separator", () => {
    expect(
      projectScriptRunCwd({
        project: { cwd: "C:\\Repo\\packages\\app" },
        repositoryRoot: "c:/repo",
        worktreePath: "C:\\worktrees\\feature",
      }),
    ).toBe("C:\\worktrees\\feature\\packages\\app");
  });

  it("maps a subfolder project when the repository is at a filesystem root", () => {
    expect(
      projectScriptRunCwd({
        project: { cwd: "/packages/app" },
        repositoryRoot: "/",
        worktreePath: "/worktrees/feature",
      }),
    ).toBe("/worktrees/feature/packages/app");
    expect(
      projectScriptRunCwd({
        project: { cwd: "C:\\packages\\app" },
        repositoryRoot: "C:\\",
        worktreePath: "C:\\worktrees\\feature",
      }),
    ).toBe("C:\\worktrees\\feature\\packages\\app");
  });
});
