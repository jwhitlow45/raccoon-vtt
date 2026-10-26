import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { RoomState, Scene } from "./model.ts";
import { ON_HEXES, canApply, companionWords, withinCompanionReach, type PermissionDeps } from "./permissions.ts";
import { opSchema, type Op, type TokenInput } from "./protocol.ts";
import { SQUARES, type Grid } from "./rules/grid.ts";
import { hexCenter, type Hex, type HexGrid } from "./rules/hex.ts";
import { DM, P1, actor, character, room, scene, token, trap } from "./testutil.ts";

/**
 * Phase H1's line on a hex scene (docs/design-v1-hex-grids.md section 6,
 * HX-D20): the server refuses every op whose rules are not hex yet, in the
 * words of the limit lines, and reads a companion's reach and a player's
 * placement by hexes.
 */
const deps: PermissionDeps = { canUseAsset: () => true };
const ROWS: HexGrid = { shape: "hex", orient: "rows" };

/** s1 on hex rows, the players' scene, and s2 on squares. */
function hexRoom(overrides: Partial<Scene> = {}): RoomState {
  return room({ scenes: { s1: scene("s1", { gridShape: "hexRows", ...overrides }), s2: scene("s2", { order: 1 }) } });
}

/** The decision on an op as the server reads it: through the protocol first. */
function decide(op: Op, state: RoomState = hexRoom(), who = DM): string {
  const d = canApply(opSchema.parse(op), who, state, deps);
  return d.ok ? "ok" : `${d.code}: ${d.message}`;
}

/** A Medium's top-left on a hex, its box centered on the hex's center. */
function onHex(h: Hex, side = 1): { x: number; y: number } {
  const c = hexCenter(ROWS, h);
  return { x: c.x - side / 2, y: c.y - side / 2 };
}

const wall = { id: "w00000000001", a: [2, 2] as [number, number], b: [5, 2] as [number, number], f: { kind: "wall" as const } };

describe("H1's refusals on a hex scene", () => {
  const buildOps = (sceneId: string): Op[] => [
    { t: "build.paint", sceneId, terrain: "stone", cells: ["1,1"] },
    { t: "build.erase", sceneId, cells: ["1,1"] },
    { t: "build.rect", sceneId, terrain: "stone", x: 1, y: 1, w: 2, h: 2 },
    { t: "build.poly", sceneId, terrain: "stone", points: [0, 0, 4, 0, 4, 4] },
    { t: "build.edge", sceneId, edges: [{ key: "1,1,n", feature: { kind: "wall" } }] },
    { t: "build.walls", sceneId, put: [wall] },
    { t: "build.height", sceneId, cells: ["1,1"], height: 10 },
    { t: "build.stairs", sceneId, cells: ["1,1"], up: "n" },
    { t: "build.rough", sceneId, cells: ["1,1"], on: true },
  ];

  test("every build op that writes cell keys or walls, and only on hexes", () => {
    for (const op of buildOps("s1")) assert.equal(decide(op), `invalid: ${ON_HEXES.build}`, op.t);
    for (const op of buildOps("s2")) assert.equal(decide(op), "ok", `${op.t} on squares`);
  });

  test("lights, stamps, labels and Clear build stay", () => {
    const ops: Op[] = [
      { t: "build.label", sceneId: "s1", labelId: "l1", label: { x: 2, y: 2, text: "Crypt", size: 1 } },
      { t: "build.lights", sceneId: "s1", put: [{ id: "lt1", x: 3, y: 3, bright: 20, dim: 20, color: "#ffcc88", on: true, walls: false }] },
      { t: "build.clear", sceneId: "s1" },
    ];
    for (const op of ops) assert.equal(decide(op), "ok", op.t);
  });

  test("traps, made or changed", () => {
    const { rev: _rev, state: _state, rig, ...rest } = trap("t1");
    assert.equal(decide({ t: "trap.create", trap: { ...rest, rig: rig! } }), `invalid: ${ON_HEXES.traps}`);
    assert.equal(decide({ t: "trap.create", trap: { ...rest, sceneId: "s2", rig: rig! } }), "ok");
    const held = hexRoom();
    held.traps.t1 = trap("t1");
    assert.equal(decide({ t: "trap.update", trapId: "t1", patch: { name: "Spikes" } }, held), `invalid: ${ON_HEXES.traps}`);
  });

  test("an attach, and a move with a route or a squeeze, while a plain move goes", () => {
    const state = hexRoom();
    state.tokens = { horse: token("horse", { size: "large", ...onHex({ col: 4, row: 4 }, 2) }), bree: token("bree", { kind: "pc", ...onHex({ col: 8, row: 4 }) }) };
    assert.equal(decide({ t: "token.attach", tokenId: "bree", to: "horse", kind: "ride", ...onHex({ col: 4, row: 4 }), elevation: 0 }, state), `invalid: ${ON_HEXES.attach}`);
    const to = onHex({ col: 10, row: 4 });
    assert.equal(decide({ t: "token.move", tokenId: "bree", ...to, route: [[to.x, to.y, 0, 0]] }, state), `invalid: ${ON_HEXES.walk}`);
    assert.equal(decide({ t: "token.move", tokenId: "horse", ...onHex({ col: 6, row: 6 }, 2), squeeze: true }, state), `invalid: ${ON_HEXES.squeeze}`);
    assert.equal(decide({ t: "token.move", tokenId: "bree", ...to }, state), "ok");
  });

  test("a player's own walk on hexes hears the same words", () => {
    const state = hexRoom();
    state.characters.bree = character("bree", { ownerIds: ["p1"] });
    state.tokens.bt = token("bt", { kind: "pc", actor: { ref: "bree" }, ownerIds: ["p1"], ...onHex({ col: 3, row: 3 }) });
    const to = onHex({ col: 4, row: 3 });
    assert.equal(decide({ t: "token.move", tokenId: "bt", ...to, route: [[to.x, to.y, 0, 0]] }, state, P1), `invalid: ${ON_HEXES.walk}`);
  });

  test("a holder with a rider, or the rider, sent onto a hex scene, while a token alone goes", () => {
    const state = room({ scenes: { s1: scene("s1"), s2: scene("s2", { order: 1, gridShape: "hexColumns" }) } });
    state.tokens = {
      horse: token("horse", { size: "large", x: 4, y: 4 }),
      bree: token("bree", { kind: "pc", x: 4, y: 4, attached: { to: "horse", kind: "ride" } }),
      gob: token("gob", { x: 9, y: 9 }),
    };
    assert.equal(decide({ t: "token.update", tokenId: "horse", patch: { sceneId: "s2" } }, state), `invalid: ${ON_HEXES.attach}`);
    assert.equal(decide({ t: "token.update", tokenId: "bree", patch: { sceneId: "s2" } }, state), `invalid: ${ON_HEXES.attach}`);
    assert.equal(decide({ t: "token.update", tokenId: "gob", patch: { sceneId: "s2" } }, state), "ok");
    const squares = room({ tokens: state.tokens });
    assert.equal(decide({ t: "token.update", tokenId: "horse", patch: { sceneId: "s2" } }, squares), "ok", "onto squares");
  });

  test("Reveal room's fog shapes, drafted or live, while every other shape goes", () => {
    const cells = { id: "f1", mode: "reveal" as const, shape: { kind: "cells" as const, cells: ["1,1"] } };
    const rect = { id: "f2", mode: "reveal" as const, shape: { kind: "rect" as const, x: 1, y: 1, w: 2, h: 2 } };
    assert.equal(decide({ t: "fog.draft", sceneId: "s1", add: [rect, cells] }), `invalid: ${ON_HEXES.roomFog}`);
    assert.equal(decide({ t: "fog.live", sceneId: "s1", ops: [cells] }), `invalid: ${ON_HEXES.roomFog}`);
    assert.equal(decide({ t: "fog.draft", sceneId: "s1", add: [rect], remove: ["f0"] }), "ok");
    assert.equal(decide({ t: "fog.live", sceneId: "s1", ops: [rect] }), "ok");
    assert.equal(decide({ t: "fog.live", sceneId: "s2", ops: [cells] }), "ok", "on squares");
  });
});

describe("a companion's reach on hexes (section 9)", () => {
  function setup(): RoomState {
    const state = hexRoom();
    state.characters.bree = character("bree", { name: "Bree", ownerIds: ["p1"] });
    state.tokens.bt = token("bt", { kind: "pc", name: "Bree", actor: { ref: "bree" }, disposition: "ally", ...onHex({ col: 5, row: 5 }) });
    return state;
  }
  const spirit = (at: { x: number; y: number }, over: Partial<TokenInput> = {}): Op => ({
    t: "token.create",
    token: {
      id: "ws",
      sceneId: "s1",
      kind: "npc",
      name: "Wildfire Spirit",
      size: "small",
      ...at,
      layer: "token",
      disposition: "ally",
      actor: { inline: actor({ hp: { cur: 15, max: 15, temp: 0 }, ac: 13, dmNotes: "" }) },
      companion: { of: "bree", turn: "shared" },
      ...over,
    },
  });

  test("a companion on the next hex is 5 ft away, two hexes off is 10 ft, outside its reach", () => {
    // Row 5 is odd, shifted half a hex right: its neighbors below are 5,6 and 6,6, above 5,4 and 6,4.
    for (const h of [
      { col: 6, row: 5 },
      { col: 5, row: 4 },
      { col: 6, row: 6 },
      { col: 5, row: 6 },
    ]) {
      assert.equal(decide(spirit(onHex(h)), setup(), P1), "ok", `${h.col},${h.row}`);
    }
    assert.equal(decide(spirit(onHex({ col: 7, row: 5 })), setup(), P1), `forbidden: ${companionWords.tooFar("Bree")}`);
    assert.equal(decide(spirit(onHex({ col: 5, row: 3 })), setup(), P1), `forbidden: ${companionWords.tooFar("Bree")}`);
    assert.equal(decide(spirit(onHex({ col: 4, row: 6 })), setup(), P1), `forbidden: ${companionWords.tooFar("Bree")}`, "beside on squares, two hexes off");
    assert.equal(decide(spirit(onHex({ col: 6, row: 5 }), { elevation: 10 }), setup(), P1), `forbidden: ${companionWords.tooFar("Bree")}`, "height counts too");
  });

  test("a Gargantuan beside a Medium: 5 ft when a hex of each touches", () => {
    const settings = room().meta.settings;
    const garg = { size: "gargantuan" as const, ...onHex({ col: 10, row: 10 }, 4), elevation: 0 };
    // The Gargantuan's anchor is its top hex's lower point: (10,10)'s center moved by HEX_R, so its box sits there.
    const anchorAt = { x: garg.x, y: garg.y + 0.5773502691896258 };
    const big = { ...garg, ...anchorAt };
    const near = (h: Hex) => withinCompanionReach(settings, ROWS, { size: "medium", ...onHex(h), elevation: 0 }, big);
    // The ring of nine around the Large three: (12,10) is east of (11,10), which is in the ring.
    assert.equal(near({ col: 12, row: 10 }), true);
    assert.equal(near({ col: 13, row: 10 }), false);
  });

  test("squares read the room's rule as before", () => {
    const settings = room().meta.settings;
    const grid: Grid = SQUARES;
    assert.equal(withinCompanionReach(settings, grid, { size: "medium", x: 6, y: 6, elevation: 0 }, { size: "medium", x: 5, y: 5, elevation: 0 }), true);
    assert.equal(withinCompanionReach(settings, grid, { size: "medium", x: 7, y: 5, elevation: 0 }, { size: "medium", x: 5, y: 5, elevation: 0 }), false);
  });
});

describe("a player's token inside a hex scene (section 4.2)", () => {
  function setup(): RoomState {
    const state = hexRoom();
    state.characters.bree = character("bree", { name: "Bree", ownerIds: ["p1"] });
    return state;
  }
  const place = (at: { x: number; y: number }): Op => ({ t: "token.create", token: { id: "bt", sceneId: "s1", kind: "pc", name: "Bree", size: "medium", ...at, actor: { ref: "bree" } } });

  test("is read on the hex it snaps to: inside when that hex is one of the scene's", () => {
    assert.equal(decide(place({ x: -0.4, y: 0.077 }), setup(), P1), "ok", "its box pokes out, but it stands on hex 0,0");
    assert.equal(decide(place(onHex({ col: 39, row: 0 })), setup(), P1), "ok");
    assert.equal(decide(place(onHex({ col: 39, row: 1 })), setup(), P1), "forbidden: place it inside the map", "an odd row holds one fewer");
  });

  test("the DM may still stand a token on the hex past an odd row's end, so an area reads a creature there (review HX2-OPUS-14)", () => {
    const state = setup();
    const past = onHex({ col: 39, row: 1 });
    assert.equal(decide({ t: "token.create", token: { id: "g1", sceneId: "s1", kind: "monster", name: "Goblin", size: "medium", ...past, actor: { inline: actor() } } }, state), "ok");
    state.tokens.g1 = token("g1", { sceneId: "s1", x: 2, y: 2 });
    assert.equal(decide({ t: "token.move", tokenId: "g1", ...past }, state), "ok");
  });
});
