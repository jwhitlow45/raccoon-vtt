import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { checkLimits, exploredReserve, exploringSceneId, LIMITS, serializedBytes } from "./limits.ts";
import type { BuildChunk, RoomState } from "./model.ts";
import { applyOp } from "./reducer.ts";
import { encodeTile, TILE_BYTES } from "./rules/fog.ts";
import { DM, env, room, scene, token } from "./testutil.ts";
import { sightPieces, sightPiecesCheck, tooManySightPieces } from "./visionLimits.ts";

/** The wave 4 caps (docs/design-v1-maps-vision.md 2.4). */

/** A scene's chunks holding a wall on every other north edge of every other row, so no two touch and none merge. */
function scatteredWalls(sceneId: string, rows: number): Record<string, BuildChunk> {
  const out: Record<string, BuildChunk> = {};
  for (let y = 0; y < rows * 2; y += 2) {
    for (let x = 0; x < 200; x += 2) {
      const key = `${sceneId}:${Math.floor(x / 16)},${Math.floor(y / 16)}`;
      const chunk = (out[key] ??= { sceneId, cx: Math.floor(x / 16), cy: Math.floor(y / 16), rev: 0, cells: {}, edges: {} });
      chunk.edges[`${x},${y},n`] = { kind: "wall" };
    }
  }
  return out;
}

describe("potential sight pieces", () => {
  test("count every piece that could block sight, a door the same open or closed", () => {
    const state = room();
    state.buildChunks["s1:0,0"] = { sceneId: "s1", cx: 0, cy: 0, rev: 0, cells: {}, edges: { "1,1,n": { kind: "door", state: "closed", secret: false, discovered: false }, "4,1,n": { kind: "wall" }, "7,1,n": { kind: "window" } } };
    assert.equal(sightPieces(state, "s1"), 2, "a window lets sight through");
    state.buildChunks["s1:0,0"] = { ...state.buildChunks["s1:0,0"], edges: { ...state.buildChunks["s1:0,0"].edges, "1,1,n": { kind: "door", state: "open", secret: false, discovered: false } } };
    assert.equal(sightPieces(state, "s1"), 2);
  });

  test("a vision scene over the cap refuses turning vision on and a build op that adds to it, and nothing else", () => {
    const over = room({ scenes: { s1: scene("s1", { bounds: { w: 200, h: 200 } }), s2: scene("s2", { order: 1 }) } });
    over.buildChunks = scatteredWalls("s1", 81);
    assert.ok(sightPieces(over, "s1") > LIMITS.sightPiecesPerScene);
    assert.deepEqual(sightPiecesCheck(over, "s1"), { ok: true }, "a scene without vision has no cap");
    const on = { ...over, scenes: { ...over.scenes, s1: { ...over.scenes.s1!, vision: { on: true, light: "dark" as const } } } };
    const refused = sightPiecesCheck(on, "s1", over);
    assert.deepEqual(refused, { ok: false, code: "quota", message: tooManySightPieces(sightPieces(on, "s1")) });
    assert.match(tooManySightPieces(9200), /^This scene has 9,200 wall pieces, more than vision can handle \(6,000\)\.$/);
    // Already over, a change that adds nothing passes, and one that adds a piece does not.
    assert.deepEqual(sightPiecesCheck(on, "s1", on), { ok: true });
    const more: RoomState = { ...on, buildChunks: { ...on.buildChunks, "s1:12,12": { sceneId: "s1", cx: 12, cy: 12, rev: 0, cells: {}, edges: { "199,199,w": { kind: "wall" } } } } };
    assert.equal(sightPiecesCheck(more, "s1", on).ok, false);
    assert.equal(sightPiecesCheck(more, "s1").ok, false, "an import's check is absolute");
  });
});

describe("the sight piece cap at 6,000 (the server-box gate, section 4.3.6)", () => {
  test("a scene of exactly 6,000 pieces turns vision on, and one piece more refuses", () => {
    const at = room({ scenes: { s1: scene("s1", { bounds: { w: 200, h: 200 } }), s2: scene("s2", { order: 1 }) } });
    at.buildChunks = scatteredWalls("s1", 60);
    assert.equal(sightPieces(at, "s1"), 6_000);
    const on = (s: RoomState): RoomState => ({ ...s, scenes: { ...s.scenes, s1: { ...s.scenes.s1!, vision: { on: true, light: "dark" } } } });
    assert.deepEqual(sightPiecesCheck(on(at), "s1", at), { ok: true });
    const one: RoomState = { ...at, buildChunks: { ...at.buildChunks, "s1:12,12": { sceneId: "s1", cx: 12, cy: 12, rev: 0, cells: {}, edges: { "199,199,w": { kind: "wall" } } } } };
    assert.equal(sightPieces(one, "s1"), 6_001);
    assert.deepEqual(sightPiecesCheck(on(one), "s1", one), { ok: false, code: "quota", message: "This scene has 6,001 wall pieces, more than vision can handle (6,000)." });
    // A build op that would cross it on a vision scene is refused the same way.
    assert.equal(sightPiecesCheck(on(one), "s1", on(at)).ok, false);
  });
});

describe("lit token lights", () => {
  const refused = { ok: false, code: "quota", message: "This scene already has 20 lit token lights." };
  const light = { bright: 20, dim: 20 };

  test("the DM's op that lights a 21st token or brings one is refused, and one already over takes edits that light no more", () => {
    const state = room();
    for (let i = 0; i < LIMITS.litTokenLightsPerScene; i++) state.tokens[`t${i}`] = token(`t${i}`, { light });
    state.tokens.dark = token("dark", { light: { bright: 0, dim: 0 } });
    state.tokens.other = token("other", { sceneId: "s2", light });
    assert.deepEqual(checkLimits(state, "s1"), { ok: true });
    const lit = applyOp(state, { t: "token.update", tokenId: "dark", patch: { light: { bright: 5, dim: 5 } } }, DM, env(1));
    assert.ok(lit.ok);
    assert.deepEqual(checkLimits(lit.state, "s1", state, "dm"), refused);
    const brought = applyOp(state, { t: "token.update", tokenId: "other", patch: { sceneId: "s1" } }, DM, env(1));
    assert.ok(brought.ok);
    assert.equal(checkLimits(brought.state, "s1", state, "dm").ok, false);
    const renamed = applyOp(lit.state, { t: "token.update", tokenId: "t0", patch: { name: "Torch" } }, DM, env(2));
    assert.ok(renamed.ok);
    assert.deepEqual(checkLimits(renamed.state, "s1", lit.state, "dm"), { ok: true });
  });

  test("a player's op is never refused by it, whatever lit creatures the scene holds, shown, unseen or hidden", () => {
    for (const [shown, hidden] of [[19, 0], [20, 0], [25, 0], [20, 6]] as const) {
      const state = room();
      for (let i = 0; i < shown; i++) state.tokens[`t${i}`] = token(`t${i}`, { light });
      for (let i = 0; i < hidden; i++) state.tokens[`h${i}`] = token(`h${i}`, { visibility: "dm", light });
      state.tokens.pc = token("pc", { kind: "pc", ownerIds: ["p1"] });
      const torch = applyOp(state, { t: "token.update", tokenId: "pc", patch: { light } }, DM, env(1));
      assert.ok(torch.ok);
      assert.deepEqual(checkLimits(torch.state, "s1", state, "player"), { ok: true }, `${shown} shown, ${hidden} hidden`);
    }
  });

  test("a token the DM hid is not counted, and the DM showing a lit one past the cap is refused", () => {
    const full = room();
    for (let i = 0; i < LIMITS.litTokenLightsPerScene; i++) full.tokens[`t${i}`] = token(`t${i}`, { light });
    for (let i = 0; i < 5; i++) full.tokens[`h${i}`] = token(`h${i}`, { visibility: "dm", light });
    assert.deepEqual(checkLimits(full, "s1"), { ok: true });
    const shown = applyOp(full, { t: "token.update", tokenId: "h0", patch: { visibility: "all" } }, DM, env(1));
    assert.ok(shown.ok);
    assert.deepEqual(checkLimits(shown.state, "s1", full, "dm"), refused);
    // Hiding a lit token makes room for another.
    const hid = applyOp(full, { t: "token.update", tokenId: "t0", patch: { visibility: "dm" } }, DM, env(1));
    assert.ok(hid.ok);
    const swapped = applyOp(hid.state, { t: "token.update", tokenId: "h0", patch: { visibility: "all" } }, DM, env(2));
    assert.ok(swapped.ok);
    assert.deepEqual(checkLimits(swapped.state, "s1", hid.state, "dm"), { ok: true });
  });

  test("a room import of a scene past it is taken, since players and turn reveals get there", () => {
    const state = room();
    for (let i = 0; i < LIMITS.litTokenLightsPerScene + 5; i++) state.tokens[`t${i}`] = token(`t${i}`, { light });
    assert.deepEqual(checkLimits(state, "s1"), { ok: true });
  });
});

describe("the explored layer's reserve", () => {
  /** The first `n` sub-cells of a tile seen, so each explore adds one more and the tile's rev moves on. */
  const firstSeen = (n: number) => {
    const bytes = new Uint8Array(TILE_BYTES);
    for (let i = 0; i < n; i++) bytes[i >> 3] = bytes[i >> 3]! | (1 << (i & 7));
    return encodeTile(bytes);
  };

  function exploring(sceneId = "0193b7a5-2c4e-7c3a-9f3e-0a1b2c3d4e5f"): RoomState {
    const state = room({ scenes: { [sceneId]: scene(sceneId, { bounds: { w: 40, h: 20 }, fogEnabled: true, vision: { on: true, light: "dark" } }), s2: scene("s2", { order: 1 }) } });
    state.meta.playerSceneId = sceneId;
    return state;
  }

  test("only the player scene with vision and fog on has one", () => {
    const state = exploring();
    const id = state.meta.playerSceneId!;
    assert.equal(exploringSceneId(state), id);
    assert.ok(exploredReserve(state) > 0);
    for (const change of [{ fogEnabled: false }, { vision: { on: false, light: "dark" as const } }]) {
      const off = { ...state, scenes: { ...state.scenes, [id]: { ...state.scenes[id]!, ...change } } };
      assert.equal(exploredReserve(off), 0, JSON.stringify(change));
    }
    assert.equal(exploredReserve({ ...state, meta: { ...state.meta, playerSceneId: "s2" } }), 0);
  });

  test("is the most each tile in bounds can take, so exploring never raises stored size plus reserve, across rev digits", () => {
    let state = exploring();
    const id = state.meta.playerSceneId!;
    const total = () => serializedBytes(state) + exploredReserve(state);
    const start = total();
    // A 40 x 20 scene has 3 x 2 tiles, each reserved in full.
    const one = exploredReserve(state) / 6;
    assert.ok(Number.isInteger(one) && one > 700);
    // Tile (0, 0) is written 110 times, so its rev passes 9 to 10 and 99 to 100. The others start along the way.
    for (let round = 1; round <= 110; round++) {
      const tiles = [{ tx: 0, ty: 0, bits: firstSeen(round) }];
      if (round % 20 === 0) tiles.push({ tx: (round / 20) % 3, ty: 1, bits: firstSeen(round) });
      const before = total();
      const r = applyOp(state, { t: "sys.explore", sceneId: id, tiles }, DM, env(round));
      assert.ok(r.ok);
      state = r.state;
      assert.ok(total() <= before, `round ${round}: ${total()} > ${before}`);
    }
    assert.equal(state.exploredTiles[`${id}:0,0`]!.rev, 110);
    assert.ok(total() <= start);
    // A tile outside the bounds, left when the scene shrank, counts only in the measured state.
    const shrunk = { ...state, scenes: { ...state.scenes, [id]: { ...state.scenes[id]!, bounds: { w: 16, h: 16 } } } };
    assert.equal(exploredReserve(shrunk), one - (serializedBytes({ [`${id}:0,0`]: state.exploredTiles[`${id}:0,0`] }) - 2 + 1));
  });

  test("is exactly what a tile at the widest rev measures, under every kind of scene id", () => {
    for (const id of ["a".repeat(36), "界".repeat(64), '"\\'.repeat(20), "\u0001\u001f\n".repeat(10)]) {
      const state = room({ scenes: { [id]: scene(id, { bounds: { w: 16, h: 16 }, fogEnabled: true, vision: { on: true, light: "dim" } }) } });
      state.meta.playerSceneId = id;
      const widest = { sceneId: id, tx: 0, ty: 0, rev: Number.MAX_SAFE_INTEGER, bits: "A".repeat(683) + "=" };
      const entry = serializedBytes({ [`${id}:0,0`]: widest }) - 2 + 1;
      assert.equal(exploredReserve(state), entry, JSON.stringify(id));
      state.exploredTiles[`${id}:0,0`] = widest;
      assert.equal(exploredReserve(state), 0, JSON.stringify(id));
    }
  });

  test("grows with the scene's own key, escapes and wide characters included", () => {
    const ascii = exploredReserve(exploring("a".repeat(36)));
    const wide = exploredReserve(exploring("界".repeat(36)));
    const quoted = exploredReserve(exploring('"'.repeat(36)));
    assert.ok(wide > ascii && quoted > ascii);
  });
});
