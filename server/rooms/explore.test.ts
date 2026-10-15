import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { tileKey } from "#shared/keys.ts";
import type { RoomState } from "#shared/model.ts";
import { visionRules } from "#shared/ruleHooks.ts";
import { decodeTile, encodeTile, fullTileBits, getBit, TILE_BYTES } from "#shared/rules/fog.ts";
import { seenFogBits } from "#shared/rules/vision.ts";
import { actor, apply, character, reveal, room, scene, token } from "#shared/testutil.ts";
import { exploreOp } from "./explore.ts";

/**
 * The explore step (docs/design-v1-maps-vision.md 4.3.3) on real party
 * sight: a player character with darkvision on a dark scene, and a goblin
 * three cells from it.
 */
function dark(): RoomState {
  const state = room();
  state.scenes.s1 = scene("s1", { fogEnabled: true, vision: { on: true, light: "dark" } });
  state.characters.c1 = character("c1", { actor: actor({ senses: "darkvision 30 ft" }) });
  state.tokens.pc = token("pc", { kind: "pc", actor: { ref: "c1" }, x: 20, y: 5 });
  state.tokens.gob = token("gob", { x: 23, y: 5 });
  return state;
}

/** Whether the sub-cell at the center of a cell is set in a tile's bits, in scene cells. */
function cellSet(bits: string | undefined, x: number, y: number): boolean {
  const b = bits ? decodeTile(bits) : null;
  return b !== null && getBit(b, (x % 16) * 4 + 1, (y % 16) * 4 + 1);
}

describe("the explore step", () => {
  test("records every sub-cell the party sees that the explored layer lacks, and then nothing more", () => {
    const state = dark();
    const op = exploreOp(state);
    assert.ok(op);
    assert.equal(op.sceneId, "s1");
    // Darkvision 30 ft from (20.5, 5.5) reaches tiles (0, 0) and (1, 0), in row order.
    assert.deepEqual(
      op.tiles.map((t) => [t.tx, t.ty]),
      [
        [0, 0],
        [1, 0],
      ],
    );
    for (const t of op.tiles) {
      const sight = visionRules.partySight(state, "s1").tiles.get(`${t.tx},${t.ty}`)!;
      assert.equal(t.bits, encodeTile(seenFogBits(sight)));
    }
    const after = apply(state, op);
    assert.ok(cellSet(after.exploredTiles[tileKey("s1", 1, 0)]?.bits, 23, 5), "the goblin's ground is explored");
    assert.ok(!cellSet(after.exploredTiles[tileKey("s1", 1, 0)]?.bits, 30, 5), "ground past darkvision is not");
    assert.equal(exploreOp(after), null, "nothing new to record");
  });

  test("ground the DM's fog already reveals is recorded too, so undoing the reveal leaves it to players", () => {
    const state = dark();
    reveal(state, "s1", { x: 0, y: 0, w: 40, h: 30 });
    const op = exploreOp(state);
    assert.ok(op && op.tiles.length === 2);
  });

  test("joins what the layer held with what the party sees, and only adds", () => {
    const state = dark();
    const held = new Uint8Array(TILE_BYTES);
    // Cell (2, 2) was explored long ago, far from where the party stands now.
    for (let sy = 8; sy < 12; sy++) for (let sx = 8; sx < 12; sx++) held[(sy * 64 + sx) >> 3]! |= 1 << ((sy * 64 + sx) & 7);
    state.exploredTiles[tileKey("s1", 1, 0)] = { sceneId: "s1", tx: 1, ty: 0, rev: 4, bits: encodeTile(held) };
    const op = exploreOp(state);
    const tile = op?.tiles.find((t) => t.tx === 1);
    assert.ok(tile);
    assert.ok(cellSet(tile.bits, 18, 2), "the old ground stays");
    assert.ok(cellSet(tile.bits, 23, 5), "the new ground is added");
    // A tile that already holds everything the party sees there is left out.
    state.exploredTiles[tileKey("s1", 1, 0)] = { sceneId: "s1", tx: 1, ty: 0, rev: 5, bits: encodeTile(fullTileBits()) };
    assert.deepEqual(
      exploreOp(state)?.tiles.map((t) => t.tx),
      [0],
    );
  });

  test("explores only the player scene, only with vision and fog on, and never behind a blackout", () => {
    const off = dark();
    off.scenes.s1 = { ...off.scenes.s1!, vision: { on: false, light: "dark" } };
    assert.equal(exploreOp(off), null, "vision off");
    const noFog = dark();
    noFog.scenes.s1 = { ...noFog.scenes.s1!, fogEnabled: false };
    assert.equal(exploreOp(noFog), null, "fog off: nothing is remembered");
    const elsewhere = dark();
    elsewhere.meta = { ...elsewhere.meta, playerSceneId: "s2" };
    assert.equal(exploreOp(elsewhere), null, "a DM previewing a vision scene explores nothing");
    const blackout = dark();
    blackout.meta = { ...blackout.meta, view: { ...blackout.meta.view, blackout: true } };
    assert.equal(exploreOp(blackout), null, "players are shown nothing behind a blackout");
  });

  test("a party that sees nothing explores nothing", () => {
    const state = dark();
    state.characters.c1 = character("c1", { actor: actor({ senses: "" }) });
    assert.equal(exploreOp(state), null);
  });
});
