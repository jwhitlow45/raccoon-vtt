import assert from "node:assert/strict";
import { test } from "node:test";

const stored = new Map<string, string>();
Object.assign(globalThis, {
  localStorage: {
    getItem: (k: string) => stored.get(k) ?? null,
    setItem: (k: string, v: string) => void stored.set(k, String(v)),
    removeItem: (k: string) => void stored.delete(k),
  },
});
const { forgetDisplayRoom, rememberDisplayRoom, rememberedDisplayRoom } = await import("./remember.ts");

test("a display forgets only its own room, so Home keeps a room another tab paired it with since", () => {
  rememberDisplayRoom("ROOMAAAA");
  // Another tab of this browser pairs the device with another room, which signs it out of the first.
  rememberDisplayRoom("ROOMBBBB");
  forgetDisplayRoom("ROOMAAAA");
  assert.equal(rememberedDisplayRoom(), "ROOMBBBB");
  forgetDisplayRoom("ROOMBBBB");
  assert.equal(rememberedDisplayRoom(), null);
});
