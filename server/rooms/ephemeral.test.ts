import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { chunkKey, wallChunk } from "#shared/keys.ts";
import { CHUNK_CELLS, type BuildChunk, type EdgeFeature, type FreeWall, type RoomState, type Viewer } from "#shared/model.ts";
import { encodeHeights } from "#shared/rules/heights.ts";
import { MAX_EPH_BYTES, type EphEvent, type Op, type ServerMessage } from "#shared/protocol.ts";
import { canApply } from "#shared/permissions.ts";
import { projectState } from "#shared/project.ts";
import { gridOfShape } from "#shared/rules/grid.ts";
import type { HexGrid } from "#shared/rules/hex.ts";
import { clipFootprint, sightClipOf } from "#shared/rules/vision.ts";
import { sceneWalls } from "#shared/rules/walls.ts";
import { applyOp } from "#shared/reducer.ts";
import { DM, P1, P2, actor, character, env, reveal, room, scene, token } from "#shared/testutil.ts";
import { Connection } from "./connection.ts";
import { cancelPreviews, MOST_PREVIEWS_SENT, PREVIEW_STALE_MS, rejudgePreviews, routeEphemeral } from "./ephemeral.ts";

/** A connection that has had its snapshot, keeping what it is sent, on the clock given or the real one. */
function viewer(who: Viewer, now?: () => number): { conn: Connection; got: EphEvent[] } {
  const got: EphEvent[] = [];
  const socket = {
    readyState: 1,
    OPEN: 1,
    CONNECTING: 0,
    send: (text: string) => {
      const msg = JSON.parse(text) as ServerMessage;
      if (msg.t === "eph") got.push(msg.e);
    },
    close: () => undefined,
    terminate: () => undefined,
  };
  const conn = new Connection(socket as never, { sessionId: `s-${who.memberId}`, roomId: "ROOM0000", memberId: who.memberId, role: who.role }, "203.0.113.1", now ? { now } : {});
  conn.held = new Map();
  conn.sceneId = "s1";
  return { conn, got };
}

function table(state: RoomState) {
  const dm = viewer(DM);
  const p1 = viewer(P1);
  const p2 = viewer(P2);
  const all = [dm.conn, p1.conn, p2.conn];
  return { dm, p1, p2, send: (from: Connection, e: EphEvent) => routeEphemeral(state, from, "s1", e, all) };
}

describe("drag previews", () => {
  test("a player's drag goes out only for a token they may move", () => {
    const state = room();
    state.tokens.mine = token("mine", { ownerIds: ["p1"] });
    state.tokens.theirs = token("theirs", { ownerIds: ["p2"] });
    const t = table(state);
    t.send(t.p1.conn, { k: "dragMove", tokenId: "mine", x: 4, y: 4 });
    assert.equal(t.dm.got.length, 1);
    assert.equal(t.p2.got.length, 1);
    // Moving someone else's token is refused, so its preview is too.
    t.send(t.p1.conn, { k: "dragMove", tokenId: "theirs", x: 9, y: 9 });
    assert.equal(t.dm.got.length, 1);
    assert.equal(t.p2.got.length, 1);
    // The DM may drag anything.
    t.send(t.dm.conn, { k: "dragMove", tokenId: "theirs", x: 9, y: 9 });
    assert.equal(t.p1.got.length, 1);
  });

  test("a drag that stops being allowed cancels the preview it left showing", () => {
    const state = room();
    state.tokens.mine = token("mine", { ownerIds: ["p1"] });
    const t = table(state);
    t.send(t.p1.conn, { k: "dragStart", tokenId: "mine", x: 3, y: 3 });
    state.tokens.mine = { ...state.tokens.mine!, locked: true };
    t.send(t.p1.conn, { k: "dragMove", tokenId: "mine", x: 5, y: 5 });
    assert.deepEqual(t.p2.got.at(-1), { k: "dragCancel", tokenId: "mine" });
    assert.equal(t.p1.conn.previewsSent.size, 0, "a preview no screen shows any more keeps no frame (review PV3-ASTRA-2)");
  });

  test("a cancelled drag, ruler or area reaches only those showing it, so a hidden token's id stays with the DM", () => {
    const state = room();
    state.tokens.lurker = token("lurker", { visibility: "dm" });
    state.tokens.gob = token("gob");
    const t = table(state);
    const dm2 = viewer(DM);
    const all = [t.dm.conn, dm2.conn, t.p1.conn, t.p2.conn];
    const send = (e: EphEvent) => routeEphemeral(state, t.dm.conn, "s1", e, all);
    send({ k: "dragStart", tokenId: "lurker", x: 3, y: 3 });
    send({ k: "dragCancel", tokenId: "lurker" });
    send({ k: "rulerEnd", id: "private-ruler" });
    send({ k: "aoeEnd", id: "private-area" });
    assert.deepEqual(t.p1.got, []);
    assert.deepEqual(t.p2.got, []);
    assert.deepEqual(dm2.got, [{ k: "dragStart", tokenId: "lurker", x: 3, y: 3 }, { k: "dragCancel", tokenId: "lurker" }]);
    // A visible drag's cancel still reaches everyone who was shown it.
    send({ k: "dragStart", tokenId: "gob", x: 3, y: 3 });
    send({ k: "dragCancel", tokenId: "gob" });
    assert.deepEqual(t.p1.got.at(-1), { k: "dragCancel", tokenId: "gob" });
    assert.deepEqual(t.p2.got.at(-1), { k: "dragCancel", tokenId: "gob" });
  });

  test("a drag's route cost reaches the DM and the token's owners, never other players (docs/design-v1-movement.md 6.5)", () => {
    const state = room();
    state.tokens.mine = token("mine", { ownerIds: ["p1"] });
    const t = table(state);
    t.send(t.dm.conn, { k: "dragMove", tokenId: "mine", x: 5, y: 5, path: [3, 4], ft: 35 });
    assert.deepEqual(t.p1.got.at(-1), { k: "dragMove", tokenId: "mine", x: 5, y: 5, path: [3, 4], ft: 35 });
    assert.deepEqual(t.p2.got.at(-1), { k: "dragMove", tokenId: "mine", x: 5, y: 5, path: [3, 4] });
    t.send(t.p1.conn, { k: "dragMove", tokenId: "mine", x: 6, y: 5, ft: 40 });
    assert.deepEqual(t.dm.got.at(-1), { k: "dragMove", tokenId: "mine", x: 6, y: 5, ft: 40 });
  });

  test("on a fogged scene a player never receives the path, the DM does", () => {
    const state = room();
    state.scenes.s1 = { ...state.scenes.s1!, fogEnabled: true };
    state.tokens.mine = token("mine", { ownerIds: ["p1"], fogExempt: true });
    const t = table(state);
    const path = [3, 3, 4, 4, 5, 5];
    t.send(t.p1.conn, { k: "dragMove", tokenId: "mine", x: 5, y: 5, path });
    assert.deepEqual(t.dm.got.at(-1), { k: "dragMove", tokenId: "mine", x: 5, y: 5, path });
    assert.deepEqual(t.p2.got.at(-1), { k: "dragMove", tokenId: "mine", x: 5, y: 5 });
    // Without fog the path is only map, so it goes out.
    state.scenes.s1 = { ...state.scenes.s1, fogEnabled: false };
    t.send(t.p1.conn, { k: "dragMove", tokenId: "mine", x: 6, y: 6, path });
    assert.deepEqual(t.p2.got.at(-1), { k: "dragMove", tokenId: "mine", x: 6, y: 6, path });
  });

  test("a creature revealed on its turn is previewed to players only on revealed ground, like any other", () => {
    const state = room();
    state.scenes.s1 = scene("s1", { fogEnabled: true });
    state.tokens.lurker = token("lurker", { x: 20, y: 2, fogExemptAuto: true });
    reveal(state, "s1", { x: 0, y: 0, w: 4, h: 4 });
    const t = table(state);
    t.send(t.dm.conn, { k: "dragMove", tokenId: "lurker", x: 2, y: 2 });
    assert.deepEqual(t.p1.got, [], "it stands in the fog, so players know nothing of it");
    state.tokens.lurker = { ...state.tokens.lurker!, x: 2, y: 2 };
    t.send(t.dm.conn, { k: "dragMove", tokenId: "lurker", x: 3, y: 3 });
    assert.deepEqual(t.p1.got, [{ k: "dragMove", tokenId: "lurker", x: 3, y: 3 }]);
    t.send(t.dm.conn, { k: "dragMove", tokenId: "lurker", x: 20, y: 2 });
    assert.deepEqual(t.p1.got.at(-1), { k: "dragCancel", tokenId: "lurker" });
  });
});

describe("rulers", () => {
  test("a ruler's ground heights reach every allowed receiver as sent, and a stop on a token a player cannot see still withholds it", () => {
    const state = room();
    state.tokens.gob = token("gob", { x: 2, y: 2 });
    state.tokens.lurker = token("lurker", { x: 5, y: 5, visibility: "dm" });
    const t = table(state);
    const climb: EphEvent = { k: "ruler", id: "r1", points: [{ x: 1.5, y: 1.5 }, { x: 2.5, y: 1.5, z: 10 }, { x: 3.5, y: 4.5, z: -5 }, { x: 2.5, y: 2.5, tokenId: "gob" }] };
    t.send(t.p1.conn, climb);
    assert.deepEqual(t.dm.got, [climb]);
    assert.deepEqual(t.p2.got, [climb]);

    const shared: EphEvent = { k: "ruler", id: "r2", points: [{ x: 1.5, y: 1.5, z: 10 }, { x: 5.5, y: 5.5, tokenId: "lurker" }], shared: true };
    t.send(t.dm.conn, shared);
    assert.deepEqual(t.p1.got, [], "the ruler ends on a hidden creature");
    assert.deepEqual(t.p2.got, [climb]);
  });
});

/**
 * Build chunks on scene s1 with ground over each `[x0, y0, x1, y1)`
 * rectangle at its height (10 ft unless it says), and a wall along each
 * `[x, from, to)`, from y = `from` to `to`.
 */
function ground(raised: readonly (readonly [number, number, number, number, number?])[], walls: readonly (readonly [number, number, number])[]): RoomState["buildChunks"] {
  const chunks: RoomState["buildChunks"] = {};
  const chunk = (x: number, y: number) => {
    const cx = Math.floor(x / CHUNK_CELLS);
    const cy = Math.floor(y / CHUNK_CELLS);
    return { k: (y - cy * CHUNK_CELLS) * CHUNK_CELLS + (x - cx * CHUNK_CELLS), chunk: (chunks[`s1:${cx},${cy}`] ??= { sceneId: "s1", cx, cy, rev: 1, cells: {}, edges: {} }) };
  };
  const feet = new Map<BuildChunk, number[]>();
  for (const [x0, y0, x1, y1, ft = 10] of raised)
    for (let y = y0; y < y1; y++)
      for (let x = x0; x < x1; x++) {
        const { k, chunk: c } = chunk(x, y);
        if (!feet.has(c)) feet.set(c, new Array<number>(CHUNK_CELLS * CHUNK_CELLS).fill(0));
        feet.get(c)![k] = ft;
      }
  for (const [c, f] of feet) c.heights = encodeHeights(f);
  for (const [x, from, to] of walls) for (let y = from; y < to; y++) chunk(x, y).chunk.edges[`${x},${y},w`] = { kind: "wall" };
  return chunks;
}

describe("drag previews on vision scenes (docs/design-v1-maps-vision.md 4.3.5)", () => {
  /*
   * A dark scene with a corridor one cell wide from x = 5 to 15 between
   * walls at y = 10 and y = 11, and a player's character with darkvision
   * 30 ft in the room south of it at (10, 13). The corridor is out of the
   * party's sight, the room south of its wall in it, and so is the open
   * ground just east of the corridor's end.
   */
  function corridor(): RoomState {
    const state = room();
    state.scenes.s1 = scene("s1", { vision: { on: true, light: "dark" } });
    const edges: Record<string, EdgeFeature> = {};
    for (let x = 5; x < 15; x++) {
      edges[`${x},10,n`] = { kind: "wall" };
      edges[`${x},11,n`] = { kind: "wall" };
    }
    state.buildChunks["s1:0,0"] = { sceneId: "s1", cx: 0, cy: 0, rev: 1, cells: {}, edges };
    state.characters.c1 = character("c1", { ownerIds: ["p1"], actor: actor({ senses: "darkvision 30 ft" }) });
    state.tokens.pc = token("pc", { kind: "pc", actor: { ref: "c1" }, x: 10, y: 13 });
    state.tokens.gob = token("gob", { x: 12, y: 13 });
    state.tokens.ogre = token("ogre", { size: "large", x: 16, y: 12 });
    return state;
  }

  test("a creature dragged out of the party's sight reaches no player, who gets a bare cancel, and comes back with sight", () => {
    const state = corridor();
    const t = table(state);
    t.send(t.dm.conn, { k: "dragStart", tokenId: "gob", x: 12, y: 13 });
    assert.equal(t.p1.got.length, 1);
    t.send(t.dm.conn, { k: "dragMove", tokenId: "gob", x: 25, y: 13 });
    assert.deepEqual(t.p1.got.at(-1), { k: "dragCancel", tokenId: "gob" });
    t.send(t.dm.conn, { k: "dragMove", tokenId: "gob", x: 26, y: 13 });
    assert.equal(t.p1.got.length, 2, "nothing more while it is out of sight");
    assert.deepEqual(t.dm.got, [], "the sender is not echoed");
    t.send(t.dm.conn, { k: "dragMove", tokenId: "gob", x: 13, y: 14 });
    assert.deepEqual(t.p1.got.at(-1), { k: "dragMove", tokenId: "gob", x: 13, y: 14 });
  });

  test("a creature revealed on its turn out of the party's sight sends players nothing until it stands in sight", () => {
    const state = corridor();
    state.tokens.lurker = token("lurker", { x: 25, y: 13, fogExemptAuto: true });
    const t = table(state);
    t.send(t.dm.conn, { k: "dragMove", tokenId: "lurker", x: 13, y: 14 });
    assert.deepEqual(t.p1.got, []);
    state.tokens.lurker = { ...state.tokens.lurker!, x: 13, y: 14 };
    t.send(t.dm.conn, { k: "dragMove", tokenId: "lurker", x: 12, y: 14 });
    assert.deepEqual(t.p1.got, [{ k: "dragMove", tokenId: "lurker", x: 12, y: 14 }]);
    t.send(t.dm.conn, { k: "dragMove", tokenId: "lurker", x: 25, y: 13 });
    assert.deepEqual(t.p1.got.at(-1), { k: "dragCancel", tokenId: "lurker" });
  });

  test("a party member's drag reaches players wherever it goes", () => {
    const state = corridor();
    state.tokens.gob = { ...state.tokens.gob!, partyVision: true };
    const t = table(state);
    t.send(t.dm.conn, { k: "dragMove", tokenId: "gob", x: 25, y: 13 });
    assert.deepEqual(t.p2.got, [{ k: "dragMove", tokenId: "gob", x: 25, y: 13 }]);
  });

  test("a Large creature dragged along a narrow corridor out of sight sends no frame at any point, and leaving it into sight sends again", () => {
    const state = corridor();
    const t = table(state);
    t.send(t.dm.conn, { k: "dragStart", tokenId: "ogre", x: 16, y: 12 });
    assert.equal(t.p1.got.length, 1, "it starts in sight");
    // Its center on the corridor's middle line, at fractional points: the full footprint would reach the lit room south of the wall.
    for (const x of [13.4, 12.37, 10.5, 8.01, 6.75]) {
      t.send(t.dm.conn, { k: "dragMove", tokenId: "ogre", x, y: 9.5 });
      assert.deepEqual(t.p1.got.at(-1), { k: "dragCancel", tokenId: "ogre" }, `at ${x}`);
    }
    assert.equal(t.p1.got.length, 2, "one cancel, then nothing");
    // The frame's own claim changes nothing: the server judges the footprint.
    t.send(t.dm.conn, { k: "dragMove", tokenId: "ogre", x: 11.2, y: 9.5, squeeze: true });
    assert.equal(t.p1.got.length, 2);
    t.send(t.dm.conn, { k: "dragMove", tokenId: "ogre", x: 11, y: 12 });
    assert.deepEqual(t.p1.got.at(-1), { k: "dragMove", tokenId: "ogre", x: 11, y: 12 });
  });

  test("a Large passenger dragged off its cart into a gap too narrow for it is judged squeezed, as its walk off the cart reads the gap (review AT-ASTRA-19)", () => {
    // A 4 by 4 cart at (9,6) at 10 ft carries the ogre. Below it a wall along x = 10 and 10 ft ground from x = 11 leave a
    // 5 ft gap, a gap only for a walker on the ground on a scene whose walls stop moves. A character with darkvision
    // stands west of the wall at (7,11).
    const state = room();
    state.scenes.s1 = scene("s1", { vision: { on: true, light: "dark" }, blockMovement: true });
    state.buildChunks = ground([[11, 6, 13, 10], [11, 10, 15, 20]], [[10, 10, 20]]);
    state.characters.c1 = character("c1", { ownerIds: ["p1"], actor: actor({ senses: "darkvision 30 ft" }) });
    state.tokens.pc = token("pc", { kind: "pc", actor: { ref: "c1" }, x: 7, y: 11 });
    state.tokens.cart = token("cart", { name: "Cart", kind: "object", size: "gargantuan", x: 9, y: 6, elevation: 10 });
    state.tokens.ogre = token("ogre", { size: "large", x: 9, y: 6, elevation: 10, attached: { to: "cart", kind: "carry" } });
    const t = table(state);
    // Its full footprint would reach west of the wall, in sight. Squeezed into the gap behind the wall, it is out of it.
    t.send(t.dm.conn, { k: "dragMove", tokenId: "ogre", x: 9.5, y: 13.4 });
    assert.deepEqual(t.p1.got, []);
    t.send(t.dm.conn, { k: "dragMove", tokenId: "ogre", x: 7, y: 12 });
    assert.deepEqual(t.p1.got, [{ k: "dragMove", tokenId: "ogre", x: 7, y: 12 }], "west of the wall it is in sight");
  });

  test("a Large passenger's drag that clears its cart and comes back onto it into a gap is judged squeezed, as its walk reaches the gap (review AT-ASTRA-21)", () => {
    // The cart at (9,6) at 10 ft carries the ogre. Under the cart's east half the ground is 10 ft, and a wall along x = 10
    // from y = 8 to 10 leaves a 5 ft gap under the cart's west half. Players have explored the cart's north west corner and
    // the cell (11,8), which the ogre's full footprint in the gap would touch and its squeezed one does not.
    const state = room();
    state.scenes.s1 = scene("s1", { fogEnabled: true, blockMovement: true });
    state.buildChunks = ground([[11, 6, 13, 10]], [[10, 8, 10]]);
    reveal(state, "s1", { x: 9, y: 6, w: 2, h: 2 });
    reveal(state, "s1", { x: 11, y: 8, w: 1, h: 1 });
    state.tokens.cart = token("cart", { name: "Cart", kind: "object", size: "gargantuan", x: 9, y: 6, elevation: 10 });
    state.tokens.ogre = token("ogre", { size: "large", x: 9, y: 6, elevation: 10, attached: { to: "cart", kind: "carry" } });
    const t = table(state);
    // West off the cart, round and back north into the gap: once clear of the cart, its inner ledge stops it like any other.
    t.send(t.dm.conn, { k: "dragMove", tokenId: "ogre", x: 9.5, y: 7.5, path: [7, 6, 7, 11, 9.5, 11, 9.5, 9.5, 9.5, 8.5] });
    assert.deepEqual(t.p1.got, []);
    // A frame with no route to read is judged for each way its last leg may start, and goes out only when none withholds it.
    t.send(t.dm.conn, { k: "dragMove", tokenId: "ogre", x: 9.5, y: 7.5 });
    assert.deepEqual(t.p1.got, []);
    t.send(t.dm.conn, { k: "dragMove", tokenId: "ogre", x: 9, y: 6, path: [] });
    assert.deepEqual(t.p1.got, [{ k: "dragMove", tokenId: "ogre", x: 9, y: 6 }], "on the cart's revealed corner it is shown");
    // Let go 10 ft up over the cart's low half, it walks off the ground, so with no route to read its last leg may start on it.
    const { attached: _link, ...loose } = state.tokens.ogre!;
    state.tokens.ogre = loose;
    t.send(t.dm.conn, { k: "dragMove", tokenId: "ogre", x: 9.5, y: 7.5 });
    assert.deepEqual(t.p1.got.at(-1), { k: "dragCancel", tokenId: "ogre" });
  });

  test("a Huge creature squeezed along a corridor walks it full size from its first corner, so no frame shows it where its move does not (review AT-ASTRA-22)", () => {
    // A corridor 10 ft wide between walls along x = 10 and x = 12, with 10 ft ground east of it and a 5 ft step in its east
    // half from y = 15. The giant stands squeezed in the corridor at 0 ft. Players have explored the corridor where it stands
    // and the cell (12,16), which its full footprint at the end touches and its squeezed one would not.
    const state = room();
    state.scenes.s1 = scene("s1", { fogEnabled: true, blockMovement: true });
    state.buildChunks = ground([[12, 8, 16, 22], [11, 15, 12, 18, 5]], [[10, 8, 22], [12, 8, 22]]);
    reveal(state, "s1", { x: 10, y: 10, w: 2, h: 2 });
    reveal(state, "s1", { x: 12, y: 16, w: 1, h: 1 });
    state.tokens.giant = token("giant", { size: "huge", x: 9.5, y: 9.5, elevation: 0, squeeze: true });
    const route: Op & { t: "token.move" } = { t: "token.move", tokenId: "giant", x: 9.5, y: 14.5, route: [[9.5, 12.5, 0, 0], [9.5, 14.5, 0, 0]] };
    // Full size from its first corner on, on the ground over the 10 ft beside the corridor, every ledge counts: the step
    // splits the squeezed footprint at the end, so that is no squeeze, and the move ends full size, in P1's sight.
    const squeezed = canApply({ ...route, squeeze: true }, DM, state, { canUseAsset: () => true });
    assert.deepEqual(squeezed.ok ? null : squeezed.code, "invalid");
    const r = applyOp(state, route, DM, env(1));
    assert.ok(r.ok);
    const shown = projectState(r.state, P1, { sceneId: "s1" }).tokens.giant;
    const t = table(state);
    for (const frame of [{ path: [9.5, 12.5] }, {}]) {
      t.send(t.dm.conn, { k: "dragMove", tokenId: "giant", x: 9.5, y: 14.5, ...frame });
      const got = t.p1.got.at(-1);
      assert.ok(got?.k !== "dragMove" || (shown?.x === 9.5 && shown.y === 14.5), JSON.stringify(got));
    }
  });

  test("a Large creature in the open beside the edge of sight is judged by its full footprint", () => {
    const state = corridor();
    const t = table(state);
    // Its west column is just inside darkvision, its middle cell just outside.
    t.send(t.dm.conn, { k: "dragMove", tokenId: "ogre", x: 16.2, y: 12.5 });
    assert.deepEqual(t.p1.got, [{ k: "dragMove", tokenId: "ogre", x: 16.2, y: 12.5 }]);
  });

  test("a player never receives a drag's path on a vision scene, with or without fog, and the DM does", () => {
    const state = corridor();
    state.tokens.mine = token("mine", { ownerIds: ["p2"], x: 11, y: 13 });
    const t = table(state);
    t.send(t.p2.conn, { k: "dragMove", tokenId: "mine", x: 12, y: 14, path: [11, 13, 12, 14] });
    assert.deepEqual(t.p1.got, [{ k: "dragMove", tokenId: "mine", x: 12, y: 14 }]);
    assert.deepEqual(t.dm.got, [{ k: "dragMove", tokenId: "mine", x: 12, y: 14, path: [11, 13, 12, 14] }]);
    // With vision off and no fog, the path goes to players as before.
    state.scenes.s1 = { ...state.scenes.s1!, vision: { on: false, light: "dark" } };
    t.send(t.p2.conn, { k: "dragMove", tokenId: "mine", x: 13, y: 14, path: [12, 14, 13, 14] });
    assert.deepEqual(t.p1.got.at(-1), { k: "dragMove", tokenId: "mine", x: 13, y: 14, path: [12, 14, 13, 14] });
  });

  test("on a fogged scene a preview counts the party's explored ground, as the merged fog shows players", () => {
    const state = room();
    state.scenes.s1 = scene("s1", { fogEnabled: true });
    state.tokens.gob = token("gob", { x: 2, y: 2 });
    reveal(state, "s1", { x: 0, y: 0, w: 4, h: 4 });
    // Explored ground the DM's own fog never revealed.
    const explored = room();
    explored.scenes.s1 = state.scenes.s1;
    reveal(explored, "s1", { x: 8, y: 0, w: 4, h: 4 });
    for (const [key, tile] of Object.entries(explored.fogTiles)) state.exploredTiles[key] = tile;
    const t = table(state);
    t.send(t.dm.conn, { k: "dragMove", tokenId: "gob", x: 9, y: 1 });
    assert.deepEqual(t.p1.got, [{ k: "dragMove", tokenId: "gob", x: 9, y: 1 }]);
    t.send(t.dm.conn, { k: "dragMove", tokenId: "gob", x: 20, y: 1 });
    assert.deepEqual(t.p1.got.at(-1), { k: "dragCancel", tokenId: "gob" });
  });
});

/**
 * What a socket's previews keep on the server (review PV3-ASTRA-2): the
 * last frame of each preview some screen shows, and no other, at most
 * MOST_PREVIEWS_SENT of them, each gone once it has had no frame for
 * PREVIEW_STALE_MS, with a bare cancel to the screens still holding it.
 */
describe("what a socket's previews keep", () => {
  function clocked(state: RoomState) {
    let clock = 1_000_000;
    const now = () => clock;
    const dm = viewer(DM, now);
    const p1 = viewer(P1, now);
    const p2 = viewer(P2, now);
    const all = [dm.conn, p1.conn, p2.conn];
    // Through the socket's own ephemeral budget, as the actor routes a frame.
    const send = (from: Connection, e: EphEvent) => {
      if (from.eph.take()) routeEphemeral(state, from, "s1", e, all);
    };
    return { dm, p1, p2, all, send, tick: (ms: number) => (clock += ms) };
  }
  const ruler = (id: string, shared?: boolean): EphEvent => ({ k: "ruler", id, points: Array.from({ length: 20 }, (_, i) => ({ x: 1.5 + i, y: 1.5 })), ...(shared === undefined ? {} : { shared }) });
  const keptBytes = (conn: Connection) => [...conn.previewsSent.values()].reduce((n, sent) => n + JSON.stringify(sent.last).length, 0);

  test("a preview no screen shows keeps no frame: rulers a player keeps to themselves, and a drag only its sender sees", () => {
    const state = room();
    state.tokens.lurker = token("lurker", { visibility: "dm" });
    const t = clocked(state);
    for (let i = 0; i < 1_000; i++) {
      t.send(t.p1.conn, ruler(`own-${i}`, false));
      t.tick(25);
    }
    assert.equal(t.p1.conn.previewsSent.size, 0);
    t.send(t.dm.conn, { k: "dragStart", tokenId: "lurker", x: 3, y: 3 });
    assert.equal(t.dm.conn.previewsSent.size, 0, "no player may see the hidden creature");
    assert.equal(t.p2.got.length, 0);
  });

  test("new rulers at the most the rate allows keep at most the socket's most, and the oldest's screens get a bare cancel", () => {
    const t = clocked(room());
    for (let i = 0; i < 1_000; i++) {
      t.send(t.p1.conn, ruler(`r-${i}`));
      assert.ok(t.p1.conn.previewsSent.size <= MOST_PREVIEWS_SENT, `after ${i + 1}: ${t.p1.conn.previewsSent.size} kept`);
      assert.ok(t.p2.conn.previewsHeld.size <= MOST_PREVIEWS_SENT);
      t.tick(25);
    }
    assert.equal(t.p1.conn.previewsSent.size, MOST_PREVIEWS_SENT);
    assert.ok(keptBytes(t.p1.conn) <= MOST_PREVIEWS_SENT * MAX_EPH_BYTES, `${keptBytes(t.p1.conn)} bytes kept`);
    const ends = t.p2.got.filter((e) => e.k === "rulerEnd").map((e) => (e as { id: string }).id);
    const shown = new Set(t.p2.got.filter((e) => e.k === "ruler").map((e) => (e as { id: string }).id));
    assert.equal(ends.length + MOST_PREVIEWS_SENT, shown.size, "every ruler shown and no longer kept was ended on the screen");
    assert.deepEqual([...t.p2.conn.previewsHeld.keys()].sort(), [...t.p1.conn.previewsSent.keys()].map((k) => `p1|${k}`).sort());
  });

  test("a preview with no frame for a while goes at the next frame or global batch, and one kept alive stays", () => {
    const state = room();
    const t = clocked(state);
    // The one kept alive came first, so only its later frames put it after the still one.
    t.send(t.p1.conn, ruler("alive"));
    t.send(t.p1.conn, ruler("still"));
    // A device sends a still preview's frame again every second.
    for (let s = 0; s < 30; s++) {
      t.tick(1_000);
      t.send(t.p1.conn, ruler("alive"));
    }
    assert.deepEqual([...t.p1.conn.previewsSent.keys()], ["ruler:alive"]);
    assert.deepEqual(
      t.p2.got.filter((e) => e.k === "rulerEnd"),
      [{ k: "rulerEnd", id: "still" }],
    );
    assert.deepEqual([...t.p2.conn.previewsHeld.keys()], ["p1|ruler:alive"]);
    t.tick(PREVIEW_STALE_MS);
    rejudgePreviews(state, t.all);
    assert.equal(t.p1.conn.previewsSent.size, 0);
    assert.deepEqual(t.p2.got.at(-1), { k: "rulerEnd", id: "alive" });
    assert.equal(t.p2.conn.previewsHeld.size, 0);
  });
});

/**
 * Two sockets of one member previewing the same thing (review PV3-ASTRA-3),
 * as a DM with a laptop and a phone dragging one token: a screen shows one
 * preview per member and id, from whichever socket sent its latest frame.
 * Tidying the other socket's entry, by expiry, eviction, a global batch's
 * judgment or that socket going away, leaves the screen's preview alone and
 * sends it nothing.
 */
describe("two sockets of one member on one preview", () => {
  function twoDms(state: RoomState) {
    let clock = 1_000_000;
    const now = () => clock;
    const a = viewer(DM, now);
    const b = viewer(DM, now);
    const p1 = viewer(P1, now);
    const all = [a.conn, b.conn, p1.conn];
    const send = (from: Connection, e: EphEvent) => routeEphemeral(state, from, "s1", e, all);
    return { a, b, p1, all, send, tick: (ms: number) => (clock += ms) };
  }
  const cancels = (got: EphEvent[]) => got.filter((e) => e.k === "dragCancel");

  test("the older socket's entry expiring leaves the newer one's drag on the screen", () => {
    const state = room();
    state.tokens.gob = token("gob", { x: 2, y: 2 });
    const t = twoDms(state);
    t.send(t.a.conn, { k: "dragStart", tokenId: "gob", x: 2, y: 2 });
    t.tick(9_000);
    t.send(t.b.conn, { k: "dragMove", tokenId: "gob", x: 3, y: 2 });
    t.tick(1_001);
    rejudgePreviews(state, t.all);
    assert.deepEqual(cancels(t.p1.got), []);
    assert.ok(t.p1.conn.previewsHeld.has("dm1|drag:gob"), "the screen still holds the drag");
    assert.equal(t.a.conn.previewsSent.size, 0, "the older entry went");
    assert.deepEqual([...t.b.conn.previewsSent.keys()], ["drag:gob"]);
    // Once the newer one is stale too, the screen gets its cancel.
    t.tick(PREVIEW_STALE_MS);
    rejudgePreviews(state, t.all);
    assert.deepEqual(cancels(t.p1.got), [{ k: "dragCancel", tokenId: "gob" }]);
  });

  test("the older socket's entry evicted past the most leaves the newer one's drag on the screen", () => {
    const state = room();
    state.tokens.gob = token("gob", { x: 2, y: 2 });
    const t = twoDms(state);
    t.send(t.a.conn, { k: "dragStart", tokenId: "gob", x: 2, y: 2 });
    t.send(t.b.conn, { k: "dragMove", tokenId: "gob", x: 3, y: 2 });
    for (let i = 0; i < MOST_PREVIEWS_SENT; i++) t.send(t.a.conn, { k: "ruler", id: `r-${i}`, points: [{ x: 1.5, y: 1.5 }], shared: true });
    assert.ok(!t.a.conn.previewsSent.has("drag:gob"), "the older socket's drag was its oldest, and went");
    assert.deepEqual(cancels(t.p1.got), []);
    assert.ok(t.p1.conn.previewsHeld.has("dm1|drag:gob"));
  });

  test("a global batch judges the newer frame the screen shows, not the older socket's", () => {
    const state = room();
    state.scenes.s1 = scene("s1", { fogEnabled: true });
    // The goblin stands on ground that stays revealed, so only where each frame shows it decides.
    state.tokens.gob = token("gob", { x: 12, y: 2 });
    reveal(state, "s1", { x: 0, y: 0, w: 16, h: 8 });
    const t = twoDms(state);
    t.send(t.a.conn, { k: "dragMove", tokenId: "gob", x: 2, y: 2 });
    t.send(t.b.conn, { k: "dragMove", tokenId: "gob", x: 12, y: 2 });
    // The DM hides the west, where the older socket's frame stands, and the newer one's stays revealed.
    const later = { ...state, fogTiles: {} };
    reveal(later, "s1", { x: 8, y: 0, w: 8, h: 8 });
    rejudgePreviews(later, t.all);
    assert.deepEqual(cancels(t.p1.got), []);
    assert.equal(t.p1.conn.previewsHeld.get("dm1|drag:gob"), t.b.conn.id, "the screen holds the newer socket's frame");
  });

  test("the older socket's entry goes at a global batch once no screen shows its frame, with no cancel", () => {
    const state = room();
    state.scenes.s2 = scene("s2", { order: 1 });
    state.tokens.gob = token("gob", { x: 2, y: 2 });
    const t = twoDms(state);
    // The newer socket is on another scene, so it never shows the older one's frame.
    t.b.conn.sceneId = "s2";
    t.send(t.a.conn, { k: "dragStart", tokenId: "gob", x: 2, y: 2 });
    t.send(t.b.conn, { k: "dragMove", tokenId: "gob", x: 3, y: 2 });
    assert.equal(t.p1.conn.previewsHeld.get("dm1|drag:gob"), t.b.conn.id);
    rejudgePreviews(state, t.all);
    assert.equal(t.a.conn.previewsSent.size, 0, "the older entry keeps no frame no screen shows");
    assert.deepEqual([...t.b.conn.previewsSent.keys()], ["drag:gob"]);
    assert.deepEqual(cancels(t.p1.got), []);
  });

  test("the older socket closing leaves the newer one's drag on the screen", () => {
    const state = room();
    state.tokens.gob = token("gob", { x: 2, y: 2 });
    const t = twoDms(state);
    t.send(t.a.conn, { k: "dragStart", tokenId: "gob", x: 2, y: 2 });
    t.send(t.b.conn, { k: "dragMove", tokenId: "gob", x: 3, y: 2 });
    cancelPreviews(t.a.conn, t.all);
    assert.deepEqual(cancels(t.p1.got), []);
    assert.ok(t.p1.conn.previewsHeld.has("dm1|drag:gob"));
    // The newer socket closing ends it.
    cancelPreviews(t.b.conn, t.all);
    assert.deepEqual(cancels(t.p1.got), [{ k: "dragCancel", tokenId: "gob" }]);
  });

  test("an end a screen misses while it resyncs, then its sender closing, leaves that screen holding no socket, and a new socket's frame still shows (review PV3-ASTRA-4)", () => {
    const state = room();
    const t = twoDms(state);
    const ruler: EphEvent = { k: "ruler", id: "r1", points: [{ x: 1.5, y: 1.5 }], shared: true };
    t.send(t.a.conn, ruler);
    assert.ok(t.p1.conn.previewsHeld.has("dm1|ruler:r1"));
    // p1 resyncs as the end arrives, so routing passes it by, and then the sender goes.
    const held = t.p1.conn.held;
    t.p1.conn.held = null;
    t.send(t.a.conn, { k: "rulerEnd", id: "r1" });
    cancelPreviews(t.a.conn, t.all);
    t.p1.conn.held = held;
    for (const owner of t.p1.conn.previewsHeld.values()) assert.equal(typeof owner, "number", "an entry names its socket by id, never the socket");
    // A new socket of the same member previews the same ruler, and the screen shows it.
    const c = viewer(DM);
    t.p1.got.length = 0;
    routeEphemeral(state, c.conn, "s1", ruler, [...t.all, c.conn]);
    assert.deepEqual(t.p1.got, [ruler]);
    assert.equal(t.p1.conn.previewsHeld.get("dm1|ruler:r1"), c.conn.id);
  });

  test("an explicit end from either socket ends the member's preview, as the screen keys it", () => {
    const state = room();
    state.tokens.gob = token("gob", { x: 2, y: 2 });
    const t = twoDms(state);
    t.send(t.a.conn, { k: "dragStart", tokenId: "gob", x: 2, y: 2 });
    t.send(t.b.conn, { k: "dragMove", tokenId: "gob", x: 3, y: 2 });
    t.send(t.a.conn, { k: "dragCancel", tokenId: "gob" });
    assert.deepEqual(cancels(t.p1.got), [{ k: "dragCancel", tokenId: "gob" }]);
    assert.ok(!t.p1.conn.previewsHeld.has("dm1|drag:gob"));
  });
});

describe("a drag preview on hexes beside a wall (docs/design-v1-hex-grids.md HX-D10)", () => {
  test("a Medium dragged to (5.49, 0.2), a wall at x = 5.4375 through its hex, stays unseen while only its sub-cells beyond the wall are revealed", () => {
    const g = gridOfShape("hexRows") as HexGrid;
    const state = room({ scenes: { s1: scene("s1", { gridShape: "hexRows", fogEnabled: true }), s2: scene("s2", { order: 1 }) } });
    const wall: FreeWall = { id: "e00000000001", a: [5.4375, 0], b: [5.4375, 3], f: { kind: "wall" } };
    const { cx, cy } = wallChunk(wall);
    state.buildChunks[chunkKey("s1", cx, cy)] = { sceneId: "s1", cx, cy, rev: 0, cells: {}, edges: {}, walls: [wall] };
    state.tokens.gob = token("gob", { x: 10, y: 10 });
    reveal(state, "s1", { x: 9, y: 9, w: 3, h: 3 });
    const at = { x: 5.49, y: 0.2 };
    const { subs, kept, keep } = clipFootprint(g, { ...state.tokens.gob, ...at }, sightClipOf(sceneWalls(state.scenes.s1!, state.buildChunks)));
    const revealSub = ([sx, sy]: readonly [number, number]) => reveal(state, "s1", { x: sx / 4, y: sy / 4, w: 0.25, h: 0.25 });
    const behind = subs.filter((_, i) => keep?.[i] !== 1);
    assert.equal(behind.length, 7);
    behind.forEach(revealSub);
    const t = table(state);
    t.send(t.dm.conn, { k: "dragMove", tokenId: "gob", x: 10, y: 10 });
    assert.deepEqual(t.p1.got, [{ k: "dragMove", tokenId: "gob", x: 10, y: 10 }], "on revealed ground it shows");
    t.send(t.dm.conn, { k: "dragMove", tokenId: "gob", ...at });
    assert.deepEqual(t.p1.got.at(-1), { k: "dragCancel", tokenId: "gob" }, "its sub-cells beyond the wall keep it hidden");
    revealSub(kept[0]!);
    t.send(t.dm.conn, { k: "dragMove", tokenId: "gob", ...at });
    assert.deepEqual(t.p1.got.at(-1), { k: "dragMove", tokenId: "gob", ...at }, "one on its own side shows it");
  });
});
