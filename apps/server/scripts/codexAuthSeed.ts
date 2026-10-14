// @effect-diagnostics nodeBuiltinImport:off - standalone synchronous Node utility.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

/**
 * Seeds `isolatedHome/auth.json` from the user's real Codex login. Call the
 * returned function after the run to keep any refresh token Codex rotated.
 */
export function seedCodexAuth(sourceAuthPath: string, isolatedHome: string): () => void {
  const seededAuthPath = NodePath.join(isolatedHome, "auth.json");
  if (!NodeFS.existsSync(sourceAuthPath)) {
    return () => {};
  }
  // Codex rewrites auth.json in place when it rotates the single-use refresh
  // token, so a symlink carries the new token back to the real login.
  try {
    NodeFS.symlinkSync(NodePath.resolve(sourceAuthPath), seededAuthPath);
    return () => {};
  } catch (error) {
    // Windows rejects file symlinks without Developer Mode or elevation.
    if ((error as NodeJS.ErrnoException).code !== "EPERM") {
      throw error;
    }
  }
  const seeded = NodeFS.readFileSync(sourceAuthPath, "utf8");
  NodeFS.writeFileSync(seededAuthPath, seeded, { mode: 0o600 });
  return () => {
    const afterRun = NodeFS.readFileSync(seededAuthPath, "utf8");
    // shortcut: source equality is best-effort, use a separate measurement login when concurrent writes need strict protection.
    if (afterRun !== seeded && NodeFS.readFileSync(sourceAuthPath, "utf8") === seeded) {
      NodeFS.writeFileSync(sourceAuthPath, afterRun);
    }
  };
}
