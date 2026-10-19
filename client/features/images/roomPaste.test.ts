import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { LIMITS } from "#shared/limits.ts";
import { roomPasteRows, type RoomPasteInput } from "./roomPaste.ts";

const base: RoomPasteInput = { role: "dm", sceneCount: 3, token: null, onScene: true, stampMode: false, busy: { scene: false, handout: false } };
const ids = (over: Partial<RoomPasteInput>) => roomPasteRows({ ...base, ...over }).map((r) => r.id);

describe("the pasted image's offer", () => {
  test("is the DM's alone", () => {
    assert.deepEqual(roomPasteRows({ ...base, role: "player", token: "Thorn" }), []);
  });

  test("offers a new scene, a stamp and a handout, New scene first", () => {
    assert.deepEqual(ids({}), ["scene", "stamp", "handout"]);
    const rows = roomPasteRows(base);
    assert.deepEqual(
      rows.map((r) => [r.label, r.help]),
      [
        ["New scene", "Make a scene with it as the map."],
        ["Stamp", "Then tap the map to place it."],
        ["Handout", "Then choose who sees it."],
      ],
    );
  });

  test("with exactly one token selected, its picture comes first", () => {
    const rows = roomPasteRows({ ...base, token: "Goblin 2" });
    assert.deepEqual(rows.map((r) => r.id), ["token", "scene", "stamp", "handout"]);
    assert.equal(rows[0]!.label, "Picture for Goblin 2");
  });

  test("with Stamp mode on, Stamp comes first, even with a token selected", () => {
    assert.deepEqual(ids({ stampMode: true }), ["stamp", "scene", "handout"]);
    assert.deepEqual(ids({ stampMode: true, token: "Goblin 2" }), ["stamp", "scene", "token", "handout"]);
  });

  test("with no scene open there is nothing to stamp", () => {
    assert.deepEqual(ids({ onScene: false, stampMode: true }), ["scene", "handout"]);
  });

  test("New scene is disabled at the room's limit, saying so", () => {
    const row = roomPasteRows({ ...base, sceneCount: LIMITS.scenesPerRoom }).find((r) => r.id === "scene")!;
    assert.equal(row.disabled, true);
    assert.equal(row.help, `A room holds at most ${LIMITS.scenesPerRoom} scenes. Delete one to add another.`);
    assert.equal(roomPasteRows({ ...base, sceneCount: LIMITS.scenesPerRoom - 1 }).find((r) => r.id === "scene")!.disabled, false);
  });

  test("a busy entry's row is disabled", () => {
    const rows = roomPasteRows({ ...base, busy: { scene: true, handout: true } });
    assert.equal(rows.find((r) => r.id === "scene")!.disabled, true);
    assert.equal(rows.find((r) => r.id === "handout")!.disabled, true);
    assert.equal(rows.find((r) => r.id === "stamp")!.disabled, false);
  });
});
