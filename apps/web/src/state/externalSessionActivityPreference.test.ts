import { describe, expect, it } from "vite-plus/test";

import {
  readExternalSessionActivityEnabled,
  writeExternalSessionActivityEnabled,
} from "./externalSessionActivityPreference";

describe("external session activity preference", () => {
  it("stays off when storage is empty and records an explicit opt-in", () => {
    const values = new Map<string, string>();
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => {
        values.set(key, value);
      },
    };

    expect(readExternalSessionActivityEnabled(storage)).toBe(false);
    writeExternalSessionActivityEnabled(true, storage);
    expect(readExternalSessionActivityEnabled(storage)).toBe(true);
    writeExternalSessionActivityEnabled(false, storage);
    expect(readExternalSessionActivityEnabled(storage)).toBe(false);
  });

  it("treats blocked storage as off without throwing", () => {
    const storage = {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
    };

    expect(readExternalSessionActivityEnabled(storage)).toBe(false);
    expect(() => writeExternalSessionActivityEnabled(true, storage)).not.toThrow();
  });
});
