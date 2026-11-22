import assert from "node:assert/strict";
import { afterEach, describe, test } from "node:test";
import { browserBuildReload } from "./buildReload.ts";

type Storage = { getItem(key: string): string | null; setItem(key: string, value: string): void };

function useStorage(storage: Storage | undefined): void {
  Object.defineProperty(globalThis, "sessionStorage", { value: storage, configurable: true, writable: true });
}

function memory(overrides: Partial<Storage> = {}): Storage & { kept: Map<string, string> } {
  const kept = new Map<string, string>();
  return {
    kept,
    getItem: (key) => kept.get(key) ?? null,
    setItem: (key, value) => void kept.set(key, value),
    ...overrides,
  };
}

describe("the tab's record of the server version it reloaded for", () => {
  afterEach(() => useStorage(undefined));

  test("a fresh tab says null, and a kept version reads back", () => {
    useStorage(memory());
    const reload = browserBuildReload();
    assert.equal(reload.tried(), null);
    assert.equal(reload.remember(70), true);
    assert.equal(reload.tried(), 70);
  });

  test("storage that reads but refuses writes keeps nothing, and remember says so", () => {
    useStorage(memory({ setItem: () => { throw new Error("QuotaExceededError"); } }));
    const reload = browserBuildReload();
    assert.equal(reload.tried(), null);
    assert.equal(reload.remember(70), false);
  });

  test("storage that takes a write and keeps nothing is not a record either", () => {
    useStorage(memory({ setItem: () => undefined }));
    assert.equal(browserBuildReload().remember(70), false);
  });

  test("storage that cannot be read says unknown, and so does a value that is no version", () => {
    useStorage(memory({ getItem: () => { throw new Error("SecurityError"); } }));
    const reload = browserBuildReload();
    assert.equal(reload.tried(), "unknown");
    assert.equal(reload.remember(70), false);
    const odd = memory();
    odd.kept.set("raccoon.buildReloadFor", "soon");
    useStorage(odd);
    assert.equal(browserBuildReload().tried(), "unknown");
  });

  test("no storage at all says unknown", () => {
    useStorage(undefined);
    assert.equal(browserBuildReload().tried(), "unknown");
  });
});
