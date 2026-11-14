import assert from "node:assert/strict";
import { test } from "node:test";
import { copyWith, type CopyEnv } from "./clipboard.ts";

function env(over: Partial<CopyEnv>): CopyEnv {
  return { clipboard: undefined, execCopy: () => false, selectVisible: () => false, ...over };
}

test("the async clipboard is used first", async () => {
  const written: string[] = [];
  const result = await copyWith(
    env({
      clipboard: { writeText: async (t) => void written.push(t) },
      execCopy: () => assert.fail("not needed"),
    }),
    "link",
  );
  assert.equal(result, "copied");
  assert.deepEqual(written, ["link"]);
});

test("no clipboard (plain HTTP) falls back to execCommand", async () => {
  const copied: string[] = [];
  const result = await copyWith(env({ execCopy: (t) => (copied.push(t), true) }), "link");
  assert.equal(result, "copied");
  assert.deepEqual(copied, ["link"]);
});

test("a refused write falls back to execCommand", async () => {
  const result = await copyWith(env({ clipboard: { writeText: () => Promise.reject(new Error("denied")) }, execCopy: () => true }), "x");
  assert.equal(result, "copied");
});

test("an execCommand that throws still reaches the selection", async () => {
  const result = await copyWith(
    env({
      execCopy: () => {
        throw new Error("nope");
      },
      selectVisible: () => true,
    }),
    "x",
  );
  assert.equal(result, "selected");
});

test("both failing selects the visible text, or fails when there is none", async () => {
  assert.equal(await copyWith(env({ selectVisible: () => true }), "x"), "selected");
  assert.equal(await copyWith(env({}), "x"), "failed");
});
