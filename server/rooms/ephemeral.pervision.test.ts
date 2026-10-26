import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { Actor, RoomState, Viewer } from "#shared/model.ts";
import type { EphEvent, ServerMessage } from "#shared/protocol.ts";
import { applyOp } from "#shared/reducer.ts";
import { encodeTile, fullTileBits } from "#shared/rules/fog.ts";
import { clearVisionCache } from "#shared/rules/vision.ts";
import { DM, P1, P2, actor, env, room, scene, token } from "#shared/testutil.ts";
import { SERVER_ACTOR } from "./actor.ts";
import { Connection } from "./connection.ts";
import { rejudgePreviews, routeEphemeral } from "./ephemeral.ts";
import { exploreOp } from "./explore.ts";

/**
 * Drag frames and live rulers on a per-player scene
 * (docs/design-v1-per-player-vision.md 7.2 and 7.5, lane PV3): each player
 * judged by their own sight with vision on and their own fog with fog
 * alone, nothing withheld with both off, and previews held across a batch
 * that re-projects everything judged again.
 */

const DISPLAY: Viewer = { memberId: "display:abcdefghijkl", role: "player" };

function viewer(who: Viewer, display = false): { conn: Connection; got: EphEvent[] } {
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
  const conn = new Connection(socket as never, { sessionId: `s-${who.memberId}`, roomId: "ROOM0000", memberId: who.memberId, role: who.role, display }, "203.0.113.1");
  conn.held = new Map();
  conn.sceneId = "s1";
  return { conn, got };
}

function table() {
  const dm = viewer(DM);
  const p1 = viewer(P1);
  const p2 = viewer(P2);
  const display = viewer(DISPLAY, true);
  const all = [dm.conn, p1.conn, p2.conn, display.conn];
  return { dm, p1, p2, display, all, clear: () => [dm, p1, p2, display].forEach((v) => (v.got.length = 0)) };
}

const dark = (senses = "darkvision 30 ft"): { inline: Actor } => ({ inline: actor({ senses }) });

/** Layer bits revealing a tile's west `cells` columns. */
function west(cells: number): string {
  return encodeTile(fullTileBits().map((_, i) => ((i % 8) * 8 < cells * 4 ? 0xff : 0)));
}

describe("drag frames on a per-player scene", () => {
  test("with fog alone, two holders with the same sources and different maps are judged apart, and the one who loses the drag gets its cancel", () => {
    const state = room();
    state.scenes.s1 = scene("s1", { bounds: { w: 48, h: 16 }, fogEnabled: true, vision: { on: false, light: "bright", perPlayer: true } });
    state.holders = { s1: { sceneId: "s1", rev: 0, entries: [{ memberId: "p1", on: true }, { memberId: "p2", on: true }] } };
    // Both remember the party's ground in the west, and only p1 the ground past it.
    state.exploredTiles = { "s1:0,0": { sceneId: "s1", tx: 0, ty: 0, rev: 0, bits: west(8) } };
    state.exploredBy = { "s1:p1:1,0": { sceneId: "s1", memberId: "p1", tx: 1, ty: 0, rev: 0, bits: encodeTile(fullTileBits()) } };
    state.tokens.gob = token("gob", { x: 3, y: 8 });
    const t = table();
    const send = (e: EphEvent) => routeEphemeral(state, t.dm.conn, "s1", e, t.all);
    send({ k: "dragStart", tokenId: "gob", x: 3, y: 8 });
    for (const v of [t.p1, t.p2, t.display]) assert.equal(v.got.length, 1, `${v.conn.memberId} sees the drag start on shared ground`);
    t.clear();
    send({ k: "dragMove", tokenId: "gob", x: 20, y: 8 });
    assert.deepEqual(t.p1.got, [{ k: "dragMove", tokenId: "gob", x: 20, y: 8 }], "p1 remembers the ground it is dragged to");
    assert.deepEqual(t.p2.got, [{ k: "dragCancel", tokenId: "gob" }], "p2 does not, and its preview goes");
    assert.deepEqual(t.display.got, [{ k: "dragCancel", tokenId: "gob" }]);
    assert.equal(t.dm.got.length, 0, "the sender gets nothing back");
  });

  test("with vision on, each holder is judged by their own sight, and the display by the shared sight", () => {
    clearVisionCache();
    const state = room();
    state.scenes.s1 = scene("s1", { bounds: { w: 48, h: 16 }, fogEnabled: true, vision: { on: true, light: "dark", perPlayer: true } });
    state.holders = { s1: { sceneId: "s1", rev: 0, entries: [{ memberId: "p1", on: true }, { memberId: "p2", on: true }] } };
    // Each character sees 6 cells around it, so both see the goblin where it stands, between them.
    state.tokens.a = token("a", { kind: "pc", ownerIds: ["p1"], x: 16, y: 8, actor: dark() });
    state.tokens.b = token("b", { kind: "pc", ownerIds: ["p2"], x: 28, y: 8, actor: dark() });
    state.tokens.gob = token("gob", { x: 22, y: 8 });
    const t = table();
    const dmView = viewer(DM);
    const all = [...t.all, dmView.conn];
    const send = (e: EphEvent) => routeEphemeral(state, t.dm.conn, "s1", e, all);
    send({ k: "dragStart", tokenId: "gob", x: 22, y: 8 });
    assert.equal(t.p1.got.length + t.p2.got.length, 2, "both see the drag start");
    assert.equal(t.display.got.length, 0, "the shared sight sees nothing here, so the display does not know the goblin");
    t.clear();
    send({ k: "dragMove", tokenId: "gob", x: 12, y: 8 });
    assert.deepEqual(t.p1.got, [{ k: "dragMove", tokenId: "gob", x: 12, y: 8 }]);
    assert.deepEqual(t.p2.got, [{ k: "dragCancel", tokenId: "gob" }]);
    t.clear();
    send({ k: "dragMove", tokenId: "gob", x: 32, y: 8 });
    assert.deepEqual(t.p1.got, [{ k: "dragCancel", tokenId: "gob" }]);
    assert.deepEqual(t.p2.got, [{ k: "dragMove", tokenId: "gob", x: 32, y: 8 }]);
    assert.deepEqual(t.display.got, []);
    assert.equal(dmView.got.length, 3, "a DM gets every frame");
  });

  test("with vision and fog both off nothing is withheld", () => {
    const state = room();
    state.scenes.s1 = scene("s1", { bounds: { w: 48, h: 16 }, fogEnabled: false, vision: { on: false, light: "dark", perPlayer: true } });
    state.holders = { s1: { sceneId: "s1", rev: 0, entries: [{ memberId: "p1", on: true }] } };
    state.tokens.gob = token("gob", { x: 3, y: 8 });
    const t = table();
    routeEphemeral(state, t.dm.conn, "s1", { k: "dragMove", tokenId: "gob", x: 40, y: 8 }, t.all);
    for (const v of [t.p1, t.p2, t.display]) assert.equal(v.got.length, 1, v.conn.memberId);
  });
});

/**
 * A dark scene for the whole party: p1's character in the west and p2's in
 * the east, each with darkvision 30 ft, and a goblin beside p1's. The
 * party sees it, so every player shows the DM's drag of it and p2's ruler
 * to it.
 */
function partyTable(): RoomState {
  const state = room();
  state.scenes.s1 = scene("s1", { bounds: { w: 48, h: 16 }, fogEnabled: true, vision: { on: true, light: "dark" } });
  state.tokens.a = token("a", { kind: "pc", ownerIds: ["p1"], x: 4, y: 8, actor: dark() });
  state.tokens.b = token("b", { kind: "pc", ownerIds: ["p2"], x: 40, y: 8, actor: dark() });
  state.tokens.gob = token("gob", { x: 6, y: 8 });
  return state;
}

describe("previews held across a batch that re-projects everything", () => {
  test("a switch to Per player cancels a held drag and live ruler for each receiver who no longer sees the goblin, and no other", () => {
    clearVisionCache();
    let state = partyTable();
    const t = table();
    routeEphemeral(state, t.dm.conn, "s1", { k: "dragStart", tokenId: "gob", x: 6, y: 8 }, t.all);
    const ruler: EphEvent = { k: "ruler", id: "r1", points: [{ x: 40.5, y: 8.5, tokenId: "b" }, { x: 6.5, y: 8.5, tokenId: "gob" }] };
    routeEphemeral(state, t.p2.conn, "s1", ruler, t.all);
    assert.equal(t.p1.got.length, 2, "p1 shows the drag and p2's ruler");
    assert.equal(t.display.got.length, 2);
    t.clear();
    // A batch that changes nothing a preview reads leaves every one held.
    rejudgePreviews(state, t.all);
    for (const v of [t.dm, t.p1, t.p2, t.display]) assert.deepEqual(v.got, [], v.conn.memberId);
    // The switch, and the explore step after it, which lists both players.
    const switched = applyOp(state, { t: "scene.update", sceneId: "s1", patch: { vision: { on: true, light: "dark", perPlayer: true } } }, DM, env(2));
    assert.ok(switched.ok && switched.global);
    const explore = exploreOp(switched.state);
    assert.ok(explore?.join?.length === 2);
    const listed = applyOp(switched.state, explore, SERVER_ACTOR, env(3));
    assert.ok(listed.ok);
    state = listed.state;
    rejudgePreviews(state, t.all);
    assert.deepEqual(t.p1.got, [], "p1's character sees the goblin: p1 keeps both");
    assert.deepEqual(t.p2.got, [{ k: "dragCancel", tokenId: "gob" }], "p2's does not: the drag goes, and p2's own ruler is p2's");
    assert.deepEqual(t.display.got, [
      { k: "dragCancel", tokenId: "gob" },
      { k: "rulerEnd", id: "r1" },
    ]);
    assert.deepEqual(t.dm.got, [], "the DM keeps p2's ruler");
    // Judged once: a second pass sends nothing more.
    t.clear();
    rejudgePreviews(state, t.all);
    for (const v of [t.dm, t.p1, t.p2, t.display]) assert.deepEqual(v.got, [], v.conn.memberId);
  });

  test("a drag the sender may no longer make is cancelled for everyone holding it", () => {
    clearVisionCache();
    const state = partyTable();
    const t = table();
    routeEphemeral(state, t.p1.conn, "s1", { k: "dragMove", tokenId: "a", x: 5, y: 8 }, t.all);
    assert.equal(t.p2.got.length, 1);
    t.clear();
    const locked = { ...state, tokens: { ...state.tokens, a: { ...state.tokens.a!, locked: true } } };
    rejudgePreviews(locked, t.all);
    assert.deepEqual(t.p2.got, [{ k: "dragCancel", tokenId: "a" }]);
    assert.deepEqual(t.dm.got, [{ k: "dragCancel", tokenId: "a" }]);
  });
});
