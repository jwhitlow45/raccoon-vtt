import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { installHook, type Hook } from "./isoTest.ts";

/*
 * The test hook (isoTest.ts) belongs to each board that mounts with the
 * test flag. View as a player mounts a second board over the DM's, and as
 * it went it took the hook with it, so the DM's board, still there, had
 * none, and pervision.e2e.ts's Isometric step waited for it in vain
 * (ISO5P2-FV-4).
 */

const current = () => (globalThis as Record<string, unknown>).__rvttIsoHook;
const hook = (): Hook => ({ pick: () => {}, turn: () => {} });

describe("the isometric test hook", () => {
  test("a board mounted over another takes the hook, and hands it back as it goes", () => {
    const main = hook();
    const preview = hook();
    const offMain = installHook(main);
    const offPreview = installHook(preview);
    assert.equal(current(), preview, "the board on top has it");
    offPreview();
    assert.equal(current(), main, "the board still mounted has it again");
    offMain();
    assert.equal(current(), undefined, "none once no board is mounted");
  });

  test("the first board going while the second stands leaves the second's", () => {
    const first = hook();
    const second = hook();
    const offFirst = installHook(first);
    const offSecond = installHook(second);
    offFirst();
    assert.equal(current(), second);
    offSecond();
    assert.equal(current(), undefined);
  });
});

// The preview's own view must be the only state the hook can change.
const { createStore } = await import("zustand/vanilla");
const { FOLLOW_THE_SCENE, readView, viewKey, displayViewKey } = await import("../../features/view/store.ts");
const { viewTestHook } = await import("./isoTest.ts");

test("FU39-B: preview picks and turns stay in its memory and never write the DM's room view", () => {
  const key = viewKey("fu39-b-preview");
  const before = readView(key);
  const memory = createStore(() => FOLLOW_THE_SCENE);
  const preview = viewTestHook(key, "scene", memory);
  preview.pick("isometric");
  preview.turn(2);
  assert.equal(readView(key), before, "the DM's saved view is untouched");
  assert.deepEqual(memory.getState(), { pick: "isometric", turns: [["scene", 2]] });
  preview.pick("follow");
  assert.deepEqual(memory.getState(), { pick: null, turns: [["scene", 2]] });
});

test("FU39-B: a room and a table display still use their separate saved views", () => {
  const key = viewKey("fu39-b-main");
  const display = displayViewKey("fu39-b-main");
  const main = viewTestHook(key, "scene");
  const tv = viewTestHook(display, "scene");
  main.pick("isometric");
  main.turn(1);
  tv.pick("topDown");
  tv.turn(3);
  assert.deepEqual(readView(key), { pick: "isometric", turns: [["scene", 1]] });
  assert.deepEqual(readView(display), { pick: "topDown", turns: [["scene", 3]] });
});
