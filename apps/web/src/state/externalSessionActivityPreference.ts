import {
  parseExternalSessionActivityEnabled,
  serializeExternalSessionActivityEnabled,
} from "@t3tools/shared/externalSessionActivity";

const STORAGE_KEY = "t3.externalSessionActivity.enabled";

export function readExternalSessionActivityEnabled(
  storage: Pick<Storage, "getItem"> | null = typeof window === "undefined"
    ? null
    : window.localStorage,
): boolean {
  try {
    return parseExternalSessionActivityEnabled(storage?.getItem(STORAGE_KEY) ?? null);
  } catch {
    return false;
  }
}

export function writeExternalSessionActivityEnabled(
  enabled: boolean,
  storage: Pick<Storage, "setItem"> | null = typeof window === "undefined"
    ? null
    : window.localStorage,
): void {
  storage?.setItem(STORAGE_KEY, serializeExternalSessionActivityEnabled(enabled));
}
