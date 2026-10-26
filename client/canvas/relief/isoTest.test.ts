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
