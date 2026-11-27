import "../../../components/testing/register.ts";
import assert from "node:assert/strict";
import { describe, test } from "node:test";

/*
 * Sound hidden on this device (docs/design/design-v1-features.md 4 and 8,
 * D-261127-123): the page plays nothing, so the one playing page in the
 * browser yields to another, and a player's page never asks to play here.
 * A table display ignores this device's choices, and a member's page waits
 * for its role before it plays.
 */

const { soundShownHere } = await import("./SoundHost.tsx");
const { askEligible } = await import("./useSoundAsk.ts");

describe("Sound hidden on this device", () => {
  test("a member's page plays only with Sound shown and its role known", () => {
    assert.equal(soundShownHere(false, "dm", true), true);
    assert.equal(soundShownHere(false, "dm", false), false, "hidden, nothing plays here");
    assert.equal(soundShownHere(false, "player", false), false);
    assert.equal(soundShownHere(false, null, true), false, "no role yet: a DM who hid Sound would hear a first bar");
  });

  test("a table display plays whatever this device hides", () => {
    assert.equal(soundShownHere(true, null, false), true);
    assert.equal(soundShownHere(true, "dm", false), true);
  });

  test("a player's page asks to play here only with Sound shown", () => {
    const player = { preview: false, display: false, role: "player" as const, choice: null };
    assert.equal(askEligible({ ...player, soundShown: true }), true);
    assert.equal(askEligible({ ...player, soundShown: false }), false, "hidden, it never asks");
    assert.equal(askEligible({ ...player, role: "dm", soundShown: true }), false, "a DM is never asked");
    assert.equal(askEligible({ ...player, choice: "on", soundShown: true }), false, "a choice made answers it");
  });
});
