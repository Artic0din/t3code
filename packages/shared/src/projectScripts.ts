import { sha256 } from "@noble/hashes/sha2";
import type { ProjectId, ProjectScript, ServerSettings } from "@t3tools/contracts";

import { normalizeProjectPathForComparison } from "./path.ts";

const ACTION_TERMINAL_ID_PREFIX = "action-";
const ACTION_TERMINAL_ID_MAX_LENGTH = 128;

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

function sameProjectPath(left: string, right: string): boolean {
  return normalizeProjectPathForComparison(left) === normalizeProjectPathForComparison(right);
}

function joinRepositoryPrefix(root: string, prefix: string): string | null {
  const segments = prefix.split(/\/+/).filter((segment) => segment.length > 0);
  if (segments.some((segment) => segment === "." || segment === "..")) return null;
  if (segments.length === 0) return root;
  const separator = root.includes("\\") && !root.includes("/") ? "\\" : "/";
  const base = root.replace(/[\\/]+$/g, "");
  return `${base}${separator}${segments.join(separator)}`;
}

function actionTerminalIdForScript(scriptId: string): string {
  const candidate = `${ACTION_TERMINAL_ID_PREFIX}${scriptId}`;
  if (candidate.length <= ACTION_TERMINAL_ID_MAX_LENGTH) return candidate;
  const digest = Array.from(sha256(new TextEncoder().encode(scriptId)).slice(0, 16), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
  return `${ACTION_TERMINAL_ID_PREFIX}${digest}`;
}

export function projectScriptRunCwd(input: {
  project: {
    cwd: string;
    repositoryRelativePrefix?: string | null;
  };
  worktreePath?: string | null;
}): string | null {
  const worktreePath = input.worktreePath ?? null;
  if (worktreePath === null || sameProjectPath(worktreePath, input.project.cwd)) {
    return input.project.cwd;
  }
  const prefix = input.project.repositoryRelativePrefix;
  if (prefix === null) return null;
  if (prefix === undefined) return worktreePath;
  return joinRepositoryPrefix(worktreePath, prefix);
}

export function projectScriptActionTerminalId(input: {
  scriptId: string;
  cwd: string;
  worktreePath?: string | null;
}): string | null {
  const worktreePath = input.worktreePath ?? null;
  if (worktreePath === null || sameProjectPath(worktreePath, input.cwd)) return null;
  return actionTerminalIdForScript(input.scriptId);
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
