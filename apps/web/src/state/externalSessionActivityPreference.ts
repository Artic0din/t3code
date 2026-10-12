import {
  parseExternalSessionActivityEnabled,
  serializeExternalSessionActivityEnabled,
} from "@t3tools/shared/externalSessionActivity";

const STORAGE_KEY = "t3.externalSessionActivity.enabled";

function resolveLocalStorage(): Storage | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

export function readExternalSessionActivityEnabled(
  storage: Pick<Storage, "getItem"> | null = resolveLocalStorage(),
): boolean {
  try {
    return parseExternalSessionActivityEnabled(storage?.getItem(STORAGE_KEY) ?? null);
  } catch {
    return false;
  }
}

export function writeExternalSessionActivityEnabled(
  enabled: boolean,
  storage: Pick<Storage, "setItem"> | null = resolveLocalStorage(),
): void {
  try {
    storage?.setItem(STORAGE_KEY, serializeExternalSessionActivityEnabled(enabled));
  } catch {
    return;
  }
}
