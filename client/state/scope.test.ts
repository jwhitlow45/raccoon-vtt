import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { RoomScope, scopeSlot } from "./scope.ts";

describe("room scopes", () => {
  test("each scope makes its own value of a slot, once", () => {
    let made = 0;
    const slot = scopeSlot(() => ({ n: ++made }));
    const dm = new RoomScope();
    const preview = new RoomScope();
    assert.equal(dm.get(slot), dm.get(slot));
    assert.notEqual(dm.get(slot), preview.get(slot));
    dm.get(slot).n = 10;
    assert.equal(preview.get(slot).n, 2);
    assert.equal(made, 2);
  });

  test("dispose stops what values run and keeps the values for a remount", () => {
    const stopped: number[] = [];
    const slot = scopeSlot(
      () => ({ timer: 7 }),
      (v) => stopped.push(v.timer),
    );
    const scope = new RoomScope();
    const value = scope.get(slot);
    scope.dispose();
    assert.deepEqual(stopped, [7]);
    assert.equal(scope.get(slot), value);
  });
});
