import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { CHUNK_CELLS, type BuildChunk, type EdgeFeature, type RoomState, type Viewer } from "#shared/model.ts";
import { encodeHeights } from "#shared/rules/heights.ts";
import type { EphEvent, ServerMessage } from "#shared/protocol.ts";
import { DM, P1, P2, actor, character, reveal, room, scene, token } from "#shared/testutil.ts";
import { Connection } from "./connection.ts";
import { routeEphemeral } from "./ephemeral.ts";

/** A connection that has had its snapshot, keeping what it is sent. */
function viewer(who: Viewer): { conn: Connection; got: EphEvent[] } {
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
  const conn = new Connection(socket as never, { sessionId: `s-${who.memberId}`, roomId: "ROOM0000", memberId: who.memberId, role: who.role }, "203.0.113.1");
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
 * Build chunks on scene s1 with 10 ft ground over each `[x0, y0, x1, y1)`
 * rectangle and a wall along x = 10 from y = `wallFrom` to `wallTo`.
 */
function ground(raised: readonly [number, number, number, number][], wallFrom: number, wallTo: number): RoomState["buildChunks"] {
  const chunks: RoomState["buildChunks"] = {};
  const chunk = (x: number, y: number) => {
    const cx = Math.floor(x / CHUNK_CELLS);
    const cy = Math.floor(y / CHUNK_CELLS);
    return { k: (y - cy * CHUNK_CELLS) * CHUNK_CELLS + (x - cx * CHUNK_CELLS), chunk: (chunks[`s1:${cx},${cy}`] ??= { sceneId: "s1", cx, cy, rev: 1, cells: {}, edges: {} }) };
  };
  const feet = new Map<BuildChunk, number[]>();
  for (const [x0, y0, x1, y1] of raised)
    for (let y = y0; y < y1; y++)
      for (let x = x0; x < x1; x++) {
        const { k, chunk: c } = chunk(x, y);
        if (!feet.has(c)) feet.set(c, new Array<number>(CHUNK_CELLS * CHUNK_CELLS).fill(0));
        feet.get(c)![k] = 10;
      }
  for (const [c, f] of feet) c.heights = encodeHeights(f);
  for (let y = wallFrom; y < wallTo; y++) chunk(10, y).chunk.edges[`10,${y},w`] = { kind: "wall" };
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
    state.buildChunks = ground([[11, 6, 13, 10], [11, 10, 15, 20]], 10, 20);
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
    state.buildChunks = ground([[11, 6, 13, 10]], 8, 10);
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
