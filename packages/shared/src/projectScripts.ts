import type { ProjectId, ProjectScript, ServerSettings } from "@t3tools/contracts";

import { normalizeProjectPathForComparison, normalizeProjectPathForDispatch } from "./path.ts";

type ProjectScriptSettings = Pick<
  ServerSettings,
  | "defaultProjectScripts"
  | "projectScriptOverrides"
  | "projectSettingsOverrides"
  | "projectSettingsFolded"
>;

/**
 * The project's override wins, then environment defaults. Until the legacy
 * fields have been folded into `projectSettingsOverrides`, the old map (null
 * there meant "reset to machine defaults") and the aggregate's own scripts
 * still count, so a server that has not run the fold yet behaves as before.
 */
export function resolveProjectScripts(
  settings: ProjectScriptSettings,
  project: { id: ProjectId; scripts: readonly ProjectScript[] },
): readonly ProjectScript[] {
  const override = settings.projectSettingsOverrides[project.id]?.defaultProjectScripts;
  if (override !== undefined) return override;
  if (settings.projectSettingsFolded) return settings.defaultProjectScripts;
  const legacy = settings.projectScriptOverrides[project.id];
  if (legacy === null) return settings.defaultProjectScripts;
  return legacy ?? (project.scripts.length > 0 ? project.scripts : settings.defaultProjectScripts);
}

export function projectScriptsInheritDefaults(
  settings: ProjectScriptSettings,
  project: { id: ProjectId; scripts: readonly ProjectScript[] },
): boolean {
  if (settings.projectSettingsOverrides[project.id]?.defaultProjectScripts !== undefined) {
    return false;
  }
  if (settings.projectSettingsFolded) return true;
  const legacy = settings.projectScriptOverrides[project.id];
  return legacy === null || (legacy === undefined && project.scripts.length === 0);
}

interface ProjectScriptRuntimeEnvInput {
  project: {
    cwd: string;
  };
  worktreePath?: string | null;
  extraEnv?: Record<string, string>;
}

export function projectScriptCwd(input: {
  project: {
    cwd: string;
  };
  worktreePath?: string | null;
}): string {
  return input.worktreePath ?? input.project.cwd;
}

/**
 * Where a project script runs. In a worktree, a project registered at a repository subfolder runs
 * in the matching subfolder, as it does in its own checkout. Falls back to the worktree root when
 * the repository root is unknown or does not contain the project.
 */
export function projectScriptRunCwd(input: {
  project: {
    cwd: string;
  };
  repositoryRoot: string | null | undefined;
  worktreePath?: string | null;
}): string {
  const worktreePath = input.worktreePath;
  if (!worktreePath) return input.project.cwd;
  if (!input.repositoryRoot) return worktreePath;
  // Compare normalized forms so separator style and Windows letter case do not matter.
  const root = normalizeProjectPathForComparison(input.repositoryRoot);
  const projectCwd = normalizeProjectPathForComparison(input.project.cwd);
  if (projectCwd.length <= root.length || !projectCwd.startsWith(root)) return worktreePath;
  const relative = normalizeProjectPathForDispatch(input.project.cwd).slice(
    normalizeProjectPathForDispatch(input.repositoryRoot).length,
  );
  // A filesystem root such as "/" or "C:\" keeps its separator, so the boundary is already there.
  if (!/[\\/]$/.test(root) && !/^[\\/]/.test(relative)) return worktreePath;
  const separator = worktreePath.includes("\\") ? "\\" : "/";
  return [
    normalizeProjectPathForDispatch(worktreePath),
    ...relative.split(/[\\/]+/).filter((segment) => segment.length > 0),
  ].join(separator);
}

export function projectScriptRuntimeEnv(
  input: ProjectScriptRuntimeEnvInput,
): Record<string, string> {
  const env: Record<string, string> = {
    T3CODE_PROJECT_ROOT: input.project.cwd,
  };
  if (input.worktreePath) {
    env.T3CODE_WORKTREE_PATH = input.worktreePath;
  }
  if (input.extraEnv) {
    return { ...env, ...input.extraEnv };
  }
  return env;
}

export function setupProjectScript(scripts: readonly ProjectScript[]): ProjectScript | null {
  return scripts.find((script) => script.runOnWorktreeCreate) ?? null;
}
