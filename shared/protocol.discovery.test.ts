import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { uuidv7 } from "./ids.ts";
import { encodeTile, fullTileBits } from "./rules/fog.ts";
import { FORGET_ASK, clientOpSchema, opSchema, refusalCodes, serverMessageSchema, serverOnlyOpSchema } from "./protocol.ts";

/**
 * Map discovery's contract on the wire (docs/design-v1-map-discovery.md
 * 5.3, 6, 8.2 and 13, lane MD1): the map step's `sys.remember`, a builder
 * op's and an undo's `forget`, the DM-only refusal, a stopped walk's
 * `blocked`, a teleport past something unseen, and the room's default for
 * new scenes.
 */

const WALL = { id: "abcdefghijkl", a: [1, 1], b: [3, 1], f: { kind: "wall" } };
const TILE = encodeTile(fullTileBits());
const remember = (fields: Record<string, unknown>) => ({ t: "sys.remember", sceneId: "s1", layers: [], ...fields });

describe("sys.remember (5.3)", () => {
  test("takes a layer's chunks with keys to drop and entries to set, and forgotten tiles that keep their sight", () => {
    const op = remember({
      layers: [
        {
          chunks: [
            {
              cx: 0,
              cy: 0,
              drop: { cells: ["1,1"], labels: ["l1"] },
              set: {
                cells: { "2,2": "stone", "3,2": null },
                edges: { "2,2,n": { kind: "wall" }, "3,2,w": "auto", "4,2,n": null, "5,2,n": { kind: "door", state: "open", secret: true, discovered: true } },
                walls: { abcdefghijkl: [{ wall: WALL, cells: ["1,1", "2,1"] }, { wall: null, cells: ["3,1"] }] },
                heights: { "2,2": 10 },
                up: { "2,2": "n" },
                upDir: { "2,2": "e", "3,3": "." },
                rough: { "2,2": true },
                labels: { l2: { id: "l2", rev: 3, sceneId: "s1", x: 2, y: 2, text: "Hall", size: 1 }, l3: null },
                stamps: { st1: { id: "st1", rev: 0, sceneId: "s1", art: { key: "oak-tree" }, x: 1, y: 1, w: 1, h: 1, rotation: 0, z: 0, visibility: "all" }, st2: null },
              },
            },
          ],
        },
        { memberId: "p1", chunks: [{ cx: 12, cy: 12, set: { cells: { "192,192": "wood" } } }] },
      ],
      forget: [{ tiles: [{ tx: 0, ty: 0, keep: TILE }, { tx: 1, ty: 0 }] }],
    });
    assert.ok(opSchema.safeParse(op).success, JSON.stringify(opSchema.safeParse(op).error?.issues[0]));
    assert.ok(serverOnlyOpSchema.safeParse(op).success);
    // Only the server makes it: no socket may send one.
    assert.equal(clientOpSchema.safeParse(op).success, false);
  });

  test("holds what players saw: never a locked door, a hidden secret door, a DM-only stamp or a wall off the lattice", () => {
    const set = (entries: Record<string, unknown>) => remember({ layers: [{ chunks: [{ cx: 0, cy: 0, set: entries }] }] });
    const ok = (entries: Record<string, unknown>) => opSchema.safeParse(set(entries)).success;
    assert.equal(ok({ edges: { "1,1,n": { kind: "door", state: "locked", secret: false, discovered: false } } }), false);
    assert.equal(ok({ edges: { "1,1,n": { kind: "door", state: "closed", secret: true, discovered: false } } }), false);
    assert.equal(ok({ edges: { "1,1,n": { kind: "door", state: "closed", secret: false, discovered: false } } }), true);
    assert.equal(ok({ walls: { abcdefghijkl: [{ wall: { ...WALL, f: { kind: "door", state: "locked", secret: false, discovered: false } }, cells: ["1,1"] }] } }), false);
    assert.equal(ok({ walls: { abcdefghijkl: [{ wall: { ...WALL, b: [3.001, 1] }, cells: ["1,1"] }] } }), false);
    // As every free wall: two different ends, at most 8 cells apart.
    assert.equal(ok({ walls: { abcdefghijkl: [{ wall: { ...WALL, b: WALL.a }, cells: ["1,1"] }] } }), false, "a wall of no length");
    assert.equal(ok({ walls: { abcdefghijkl: [{ wall: { ...WALL, a: [0, 1], b: [8, 1] }, cells: ["1,1"] }] } }), true);
    assert.equal(ok({ walls: { abcdefghijkl: [{ wall: { ...WALL, a: [0, 1], b: [8.015625, 1] }, cells: ["1,1"] }] } }), false, "a wall past 8 cells");
    assert.equal(ok({ walls: { abcdefghijkl: [{ wall: WALL, cells: ["1,1", "1,1"] }] } }), false, "a version lists each cell once");
    assert.equal(ok({ walls: { abcdefghijkl: [] } }), false, "a wall's entry has a version");
    assert.equal(ok({ stamps: { st1: { id: "st1", rev: 0, sceneId: "s1", art: { key: "oak-tree" }, x: 1, y: 1, w: 1, h: 1, rotation: 0, z: 0, visibility: "dm" } } }), false);
    assert.equal(ok({ heights: { "1,1": 201 } }), false);
    assert.equal(ok({ up: { "1,1": "x" } }), false);
    assert.equal(ok({ upDir: { "1,1": "a" } }), false, "a direction players get is worked out, never by the rule");
    assert.equal(ok({ cells: Object.fromEntries(Array.from({ length: 257 }, (_, i) => [`${i},0`, "stone"])) }), false, "at most a chunk's cells");
  });

  test("names each layer, chunk and forgotten tile once, and holds something", () => {
    const chunk = { cx: 0, cy: 0, set: { cells: { "1,1": "stone" } } };
    assert.equal(opSchema.safeParse(remember({ layers: [{ chunks: [chunk] }, { chunks: [chunk] }] })).success, false);
    assert.equal(opSchema.safeParse(remember({ layers: [{ memberId: "p1", chunks: [chunk] }, { memberId: "p1", chunks: [chunk] }] })).success, false);
    assert.equal(opSchema.safeParse(remember({ layers: [{ chunks: [chunk, chunk] }] })).success, false);
    assert.equal(opSchema.safeParse(remember({ forget: [{ tiles: [{ tx: 0, ty: 0 }, { tx: 0, ty: 0 }] }] })).success, false);
    assert.equal(opSchema.safeParse(remember({ forget: [{ tiles: [{ tx: 0, ty: 0 }] }, { tiles: [{ tx: 1, ty: 0 }] }] })).success, false);
    assert.equal(opSchema.safeParse(remember({})).success, false, "nothing remembered");
    // A hex scene of the largest size files its memory up to chunk 14, past the square cells' 12 (sceneHexSpan).
    assert.equal(opSchema.safeParse(remember({ layers: [{ chunks: [{ cx: 14, cy: 14, set: { cells: { "229,229": "stone" } } }] }] })).success, true);
    assert.equal(opSchema.safeParse(remember({ layers: [{ chunks: [{ cx: 15, cy: 0, set: { cells: { "240,0": "stone" } } }] }] })).success, false, "past the largest scene");
    // Fog is a square raster on every grid, so a forgotten tile is one of the square cells'.
    assert.equal(opSchema.safeParse(remember({ forget: [{ tiles: [{ tx: 13, ty: 0 }] }] })).success, false);
  });
});

describe("the ask before forgetting (5.3)", () => {
  test("every builder op, and an undo or redo with the step's seq, may carry the DM's yes", () => {
    const ops = [
      { t: "build.paint", sceneId: "s1", terrain: "stone", cells: ["1,1"], forget: true },
      { t: "build.erase", sceneId: "s1", cells: ["1,1"], forget: true },
      { t: "build.rect", sceneId: "s1", terrain: null, x: 0, y: 0, w: 2, h: 2, forget: true },
      { t: "build.poly", sceneId: "s1", terrain: "wood", points: [0, 0, 4, 0, 0, 4], forget: true },
      { t: "build.edge", sceneId: "s1", edges: [{ key: "1,1,n", feature: { kind: "wall" } }], forget: true },
      { t: "build.label", sceneId: "s1", labelId: "l1", label: null, forget: true },
      { t: "build.clear", sceneId: "s1", forget: true },
      { t: "build.walls", sceneId: "s1", put: [WALL], forget: true },
      { t: "build.stamps", sceneId: "s1", remove: ["st1"], forget: true },
      { t: "build.height", sceneId: "s1", cells: ["1,1"], height: 5, forget: true },
      { t: "build.stairs", sceneId: "s1", cells: ["1,1"], up: "n", forget: true },
      { t: "build.rough", sceneId: "s1", cells: ["1,1"], on: true, forget: true },
      { t: "undo", head: uuidv7(), forget: 12 },
      { t: "redo", head: uuidv7(), forget: 13 },
      { t: "redo", head: uuidv7() },
    ];
    for (const op of ops) assert.ok(clientOpSchema.safeParse(op).success, JSON.stringify(op));
    assert.equal(clientOpSchema.safeParse({ t: "build.paint", sceneId: "s1", terrain: "stone", cells: ["1,1"], forget: false }).success, false, "only a yes is sent");
    assert.equal(clientOpSchema.safeParse({ t: "undo", head: uuidv7(), forget: true }).success, false, "an undo's yes names its step");
    assert.equal(clientOpSchema.safeParse({ t: "door.set", sceneId: "s1", door: { edge: "1,1,n" }, state: "open", forget: true }).success, false, "a door forgets silently");
  });

  test("legacy stack commands, including a remembered forget answer, need a reload", () => {
    for (const op of [{ t: "undo" }, { t: "redo" }, { t: "undo", forget: 12 }, { t: "redo", forget: 13 }, { t: "undo", of: 1 }]) {
      const parsed = clientOpSchema.safeParse(op);
      assert.equal(parsed.success, false, JSON.stringify(op));
      if (!parsed.success) assert.ok(parsed.error.issues.some((issue) => issue.message === "Reload to use Undo"));
    }
  });

  test("the refusal is its own code, and the question its own words", () => {
    assert.ok((refusalCodes as readonly string[]).includes("forget"));
    assert.equal(FORGET_ASK, "Players' remembered map here will be forgotten. Go ahead?");
    assert.ok(serverMessageSchema.safeParse({ t: "ev", seq: 4, changes: [], rejects: [{ n: 2, code: "forget", message: FORGET_ASK }] }).success);
  });
});

describe("a walk stopped by what the player cannot see (6)", () => {
  test("its ev names it in `blocked`, and its Teleport here sends `unknown`", () => {
    assert.ok(serverMessageSchema.safeParse({ t: "ev", seq: 4, changes: [], acks: [3], blocked: [3] }).success);
    assert.equal(serverMessageSchema.safeParse({ t: "ev", seq: 4, changes: [], blocked: [0] }).success, false);
    assert.ok(clientOpSchema.safeParse({ t: "token.move", tokenId: "t1", x: 2, y: 2, teleport: "unknown" }).success);
    assert.equal(clientOpSchema.safeParse({ t: "token.move", tokenId: "t1", x: 2, y: 2, teleport: "door" }).success, false);
  });
});

describe("what players see on new scenes (8.2)", () => {
  test("is a room setting of the three presets, with no way back to unset", () => {
    for (const choice of ["explore", "reveal", "all"]) assert.ok(clientOpSchema.safeParse({ t: "room.update", settings: { newScenePlayers: choice } }).success, choice);
    assert.equal(clientOpSchema.safeParse({ t: "room.update", settings: { newScenePlayers: "before" } }).success, false);
    assert.equal(clientOpSchema.safeParse({ t: "room.update", settings: { newScenePlayers: null } }).success, false);
  });
});
