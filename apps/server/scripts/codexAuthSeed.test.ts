// @effect-diagnostics nodeBuiltinImport:off - tests the standalone Node utility.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

import { seedCodexAuth } from "./codexAuthSeed.ts";

// Windows without Developer Mode or elevation rejects file symlinks with EPERM.
const symlinkFailure = vi.hoisted(() => ({ code: null as string | null }));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    symlinkSync: (...args: Parameters<typeof actual.symlinkSync>) => {
      if (symlinkFailure.code !== null) {
        throw Object.assign(new Error(`symlink failed with ${symlinkFailure.code}`), {
          code: symlinkFailure.code,
        });
      }
      return actual.symlinkSync(...args);
    },
  };
});

let root: string;
let sourceAuthPath: string;
let isolatedHome: string;
let seededAuthPath: string;

beforeEach(() => {
  root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "codex-auth-seed-"));
  sourceAuthPath = NodePath.join(root, "auth.json");
  isolatedHome = NodePath.join(root, "isolated");
  seededAuthPath = NodePath.join(isolatedHome, "auth.json");
  NodeFS.mkdirSync(isolatedHome);
  symlinkFailure.code = null;
});

afterEach(() => {
  NodeFS.rmSync(root, { recursive: true, force: true });
});

it("keeps a refresh token Codex rotated during the run", () => {
  NodeFS.writeFileSync(sourceAuthPath, '{"tokens":"old"}');
  const syncBack = seedCodexAuth(sourceAuthPath, isolatedHome);
  NodeFS.writeFileSync(seededAuthPath, '{"tokens":"rotated"}');
  syncBack();
  expect(NodeFS.readFileSync(sourceAuthPath, "utf8")).toBe('{"tokens":"rotated"}');
});

it("seeds credentials when symlinks are not permitted", () => {
  symlinkFailure.code = "EPERM";
  NodeFS.writeFileSync(sourceAuthPath, '{"tokens":"old"}');
  seedCodexAuth(sourceAuthPath, isolatedHome);
  expect(NodeFS.readFileSync(seededAuthPath, "utf8")).toBe('{"tokens":"old"}');
});

it("keeps a rotated refresh token when symlinks are not permitted", () => {
  symlinkFailure.code = "EPERM";
  NodeFS.writeFileSync(sourceAuthPath, '{"tokens":"old"}');
  const syncBack = seedCodexAuth(sourceAuthPath, isolatedHome);
  NodeFS.writeFileSync(seededAuthPath, '{"tokens":"rotated"}');
  syncBack();
  expect(NodeFS.readFileSync(sourceAuthPath, "utf8")).toBe('{"tokens":"rotated"}');
});

it("leaves a concurrent login alone when Codex did not rotate the copy", () => {
  symlinkFailure.code = "EPERM";
  NodeFS.writeFileSync(sourceAuthPath, '{"tokens":"old"}');
  const syncBack = seedCodexAuth(sourceAuthPath, isolatedHome);
  NodeFS.writeFileSync(sourceAuthPath, '{"tokens":"refreshed-elsewhere"}');
  syncBack();
  expect(NodeFS.readFileSync(sourceAuthPath, "utf8")).toBe('{"tokens":"refreshed-elsewhere"}');
});

it("does not overwrite a concurrent login with a rotated copy", () => {
  symlinkFailure.code = "EPERM";
  NodeFS.writeFileSync(sourceAuthPath, '{"tokens":"old"}');
  const syncBack = seedCodexAuth(sourceAuthPath, isolatedHome);
  NodeFS.writeFileSync(seededAuthPath, '{"tokens":"rotated"}');
  NodeFS.writeFileSync(sourceAuthPath, '{"tokens":"refreshed-elsewhere"}');
  syncBack();
  expect(NodeFS.readFileSync(sourceAuthPath, "utf8")).toBe('{"tokens":"refreshed-elsewhere"}');
});

it("propagates symlink errors other than a privilege failure", () => {
  symlinkFailure.code = "ENOSPC";
  NodeFS.writeFileSync(sourceAuthPath, '{"tokens":"old"}');
  expect(() => seedCodexAuth(sourceAuthPath, isolatedHome)).toThrow("symlink failed with ENOSPC");
});

it("seeds nothing when only OPENAI_API_KEY provides credentials", () => {
  symlinkFailure.code = "EPERM";
  seedCodexAuth(sourceAuthPath, isolatedHome)();
  expect(NodeFS.readdirSync(isolatedHome)).toEqual([]);
});
