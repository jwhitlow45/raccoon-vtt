import "../../../components/testing/register.ts";
import assert from "node:assert/strict";
import { describe, test } from "node:test";

/*
 * The throw follows this role's Dice animation (docs/design/design-v1-features.md 8,
 * D-261127-310): a change, here or from another window, reaches the Room's
 * throw store, which ends a throw in the air and lets the renderer go as it
 * turns off (throw/store.test.ts), and throws the next roll as it turns on.
 */

const { followDiceAnimation } = await import("./useThrows.ts");

function store() {
  const inputs: { on?: boolean }[] = [];
  return { inputs, setInputs: (patch: { on?: boolean }) => void inputs.push(patch) };
}

describe("the throw and Dice animation", () => {
  test("hidden, the store is told it is off, and shown again, on", () => {
    const s = store();
    followDiceAnimation(s, false, false);
    followDiceAnimation(s, true, false);
    assert.deepEqual(s.inputs, [{ on: false }, { on: true }]);
  });

  test("a preview's store is told as well, which never throws anyway", () => {
    const s = store();
    followDiceAnimation(s, true, true);
    assert.deepEqual(s.inputs, [{ on: true }]);
  });
});
