import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { lift, liftSubs, wall } from "#shared/discoveryTestutil.ts";
import type { RoomState, Viewer } from "#shared/model.ts";
import { projectState, stableStringify } from "#shared/project.ts";
import type { EphEvent, EphEventOut, ServerMessage } from "#shared/protocol.ts";
import { occupiedHexes } from "#shared/rules/footprint.ts";
import { hexSubcells, type HexGrid } from "#shared/rules/hex.ts";
import { COLUMNS, onHex, ROWS } from "#shared/rules/hexWalls.testkit.ts";
import { ownWalk, previewSqueezed, walkEnd } from "#shared/rules/movement.ts";
import { sceneWalls } from "#shared/rules/walls.ts";
import { DM, member, P1, room, scene, token } from "#shared/testutil.ts";
import { Connection } from "./connection.ts";
import { rejudgePreviews, routeEphemeral } from "./ephemeral.ts";

/**
 * Drag previews in paired rooms: two rooms whose players start with the
 * same copy, the second with walls only the DM's copy holds, send every
 * player the same frames and cancels, as they arrive and when a global
 * batch judges them again. On squares a creature that can squeeze is
 * judged by both its footprints (D-261101-187), on hexes by the hex rules.
 */

function viewer(who: Viewer): { conn: Connection; got: EphEventOut[] } {
  const got: EphEventOut[] = [];
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

/** The DM's frames in `state`, then a fog change on every copy and a global batch's judgment: what Pat receives, start to end. */
function patReceives(state: RoomState, frames: readonly EphEvent[], change?: (s: RoomState) => void): EphEventOut[] {
  const dm = viewer(DM);
  const p1 = viewer(P1);
  const all = [dm.conn, p1.conn];
  for (const e of frames) routeEphemeral(state, dm.conn, "s1", e, all);
  if (change) {
    const after = structuredClone(state);
    change(after);
    rejudgePreviews(after, all);
  }
  return p1.got;
}

function sameCopies(open: RoomState, walled: RoomState): void {
  assert.equal(stableStringify(projectState(walled, P1, { sceneId: "s1" })), stableStringify(projectState(open, P1, { sceneId: "s1" })), "Pat's copies start the same");
}

describe("squares: a drag preview past walls only the DM's copy holds (D-261101-187)", () => {
  /** An ogre nobody owns at 3,9 on a fog scene, its own squares revealed, and the square 8,11 its full footprint reaches at 8,9.5. */
  function hall(): RoomState {
    const s = room({ members: { dm1: member("dm1", "dm"), p1: member("p1") }, scenes: { s1: scene("s1", { bounds: { w: 30, h: 20 }, autoWalls: "off", fogEnabled: true }) } });
    s.buildChunks = {};
    s.tokens.ogre = token("ogre", { size: "large", x: 3, y: 9, name: "Ogre", kind: "npc" });
    lift(s, "dm", { x: 3, y: 9, w: 2, h: 2 });
    lift(s, "dm", { x: 8, y: 11, w: 1, h: 1 });
    return s;
  }
  function narrowed(open: RoomState): RoomState {
    const s = structuredClone(open);
    wall(s, "fu43pv000001", [9, 9.75], [15, 9.75]);
    wall(s, "fu43pv000002", [9, 11.25], [15, 11.25]);
    assert.equal(sceneWalls(s.scenes.s1!, s.buildChunks).stored.xy.length / 4, 2, "both walls stored");
    return s;
  }
  const at = { x: 8, y: 9.5 };

  test("Pat gets the same frames in both rooms, whatever corners the frame carries, and the walls make a narrow space there", () => {
    const open = hall();
    const walled = narrowed(open);
    sameCopies(open, walled);
    assert.equal(previewSqueezed(walled, walkEnd(walled, ownWalk(walled.tokens.ogre!), at)), true, "a narrow space in the walled room");
    assert.equal(previewSqueezed(open, walkEnd(open, ownWalk(open.tokens.ogre!), at)), false);
    for (const path of [undefined, [], [6, 9.5]] as const) {
      const frames: EphEvent[] = [
        { k: "dragStart", tokenId: "ogre", x: 3, y: 9 },
        { k: "dragMove", tokenId: "ogre", ...at, ...(path ? { path: [...path] } : {}) },
      ];
      const a = patReceives(open, frames);
      assert.deepEqual(patReceives(walled, frames), a, `path ${JSON.stringify(path)}`);
      // Its squeezed footprint at 8,9.5 is under the fog, so Pat's screen loses it in both.
      assert.deepEqual(a.at(-1), { k: "dragCancel", tokenId: "ogre" });
    }
  });

  test("a global batch judges a shown frame again alike in both rooms", () => {
    const open = hall();
    // The squares under its squeezed footprint there, which no wall crosses.
    lift(open, "dm", { x: 8, y: 10, w: 2, h: 1 });
    const walled = narrowed(open);
    sameCopies(open, walled);
    const frames: EphEvent[] = [{ k: "dragMove", tokenId: "ogre", ...at }];
    // Shown in both, then the squares under its squeezed footprint go back under the fog, the one its full footprint reaches kept.
    const hide = (s: RoomState) => lift(s, "dm", { x: 8, y: 10, w: 2, h: 1 }, "s1", false);
    const a = patReceives(open, frames, hide);
    assert.deepEqual(patReceives(walled, frames, hide), a);
    assert.deepEqual(a, [{ k: "dragMove", tokenId: "ogre", ...at }, { k: "dragCancel", tokenId: "ogre" }]);
  });
});

/** A Huge creature nobody owns, dragged from hex 3,3 to hex 9,6, its own sub-cells and `seen` revealed, and in the second room one short wall. */
for (const [name, g, seen, wallEnds] of [
  ["hex rows", ROWS, [[38, 25], [41, 21]], [[9.515625, 5.96875], [9.578125, 5.96875]]],
  ["hex columns", COLUMNS, [[29, 24], [32, 30]], [[8.234375, 6.84375], [8.203125, 6.890625]]],
] as const) {
  const shape = g.orient === "rows" ? "hexRows" : "hexColumns";
  const bounds = g.orient === "rows" ? { w: 22, h: 16 } : { w: 16, h: 22 };

  function hall(): RoomState {
    const s = room({ members: { dm1: member("dm1", "dm"), p1: member("p1") }, scenes: { s1: scene("s1", { gridShape: shape, bounds, autoWalls: "off", fogEnabled: true }) } });
    s.buildChunks = {};
    s.tokens.giant = onHex(g as HexGrid, "giant", "huge", { col: 3, row: 3 }, { name: "Giant", kind: "npc" });
    const own = occupiedHexes(g as HexGrid, s.tokens.giant).flatMap((h) => hexSubcells(g as HexGrid, h));
    liftSubs(s, "dm", [...own, ...seen.map(([x, y]) => [x, y] as [number, number])]);
    return s;
  }
  function walled(open: RoomState): RoomState {
    const s = structuredClone(open);
    wall(s, "fu43ph000001", [...wallEnds[0]], [...wallEnds[1]]);
    assert.equal(sceneWalls(s.scenes.s1!, s.buildChunks).stored.xy.length / 4, 1, "the wall is stored");
    return s;
  }

  test(`${name}: a Huge creature dragged where its full footprint is in sight reaches Pat alike in both rooms, as they arrive and when a global batch judges them again`, () => {
    const open = hall();
    const closed = walled(open);
    sameCopies(open, closed);
    const to = onHex(g as HexGrid, "to", "huge", { col: 9, row: 6 });
    const frames: EphEvent[] = [
      { k: "dragStart", tokenId: "giant", x: open.tokens.giant!.x, y: open.tokens.giant!.y },
      { k: "dragMove", tokenId: "giant", x: to.x, y: to.y },
    ];
    const a = patReceives(open, frames);
    assert.deepEqual(patReceives(closed, frames), a);
    assert.deepEqual(a.at(-1), { k: "dragMove", tokenId: "giant", x: to.x, y: to.y });
    const again = (s: RoomState) => lift(s, "dm", { x: 0, y: 0, w: 1, h: 1 }, "s1", false);
    assert.deepEqual(patReceives(closed, frames, again), patReceives(open, frames, again));
  });
}

/**
 * Three pairs: on hex rows the Huge creature's own sub-cells and one more
 * revealed with a wall beside it, and both pairs above. P1 gets the same
 * frames in both rooms and the same copy of the creature standing there,
 * full size or squeezed.
 */
for (const [name, g, seen, wallEnds] of [
  ["hex rows, one more sub-cell", ROWS, [[38, 25]], [[9.34375, 6.015625], [9.734375, 5.921875]]],
  ["hex rows, two more", ROWS, [[38, 25], [41, 21]], [[9.515625, 5.96875], [9.578125, 5.96875]]],
  ["hex columns, two more", COLUMNS, [[29, 24], [32, 30]], [[8.234375, 6.84375], [8.203125, 6.890625]]],
] as const) {
  const shape = g.orient === "rows" ? "hexRows" : "hexColumns";
  const bounds = g.orient === "rows" ? { w: 22, h: 16 } : { w: 16, h: 22 };
  function rooms(): { open: RoomState; closed: RoomState } {
    const open = room({ members: { dm1: member("dm1", "dm"), p1: member("p1") }, scenes: { s1: scene("s1", { gridShape: shape, bounds, autoWalls: "off", fogEnabled: true }) } });
    open.buildChunks = {};
    const start = onHex(g as HexGrid, "giant", "huge", { col: 3, row: 3 }, { name: "Giant", kind: "npc" });
    liftSubs(open, "dm", [...occupiedHexes(g as HexGrid, start).flatMap((h) => hexSubcells(g as HexGrid, h)), ...seen.map(([x, y]) => [x, y] as [number, number])]);
    open.tokens.giant = start;
    const closed = structuredClone(open);
    wall(closed, "pairwall0001", [...wallEnds[0]], [...wallEnds[1]]);
    return { open, closed };
  }

  test(`${name}: frames and the creature standing at hex 9,6 reach P1 alike in both rooms`, () => {
    const { open, closed } = rooms();
    sameCopies(open, closed);
    const to = onHex(g as HexGrid, "to", "huge", { col: 9, row: 6 });
    const frames: EphEvent[] = [{ k: "dragMove", tokenId: "giant", x: to.x, y: to.y }];
    assert.deepEqual(patReceives(closed, frames), patReceives(open, frames));
    for (const squeeze of [false, true]) {
      const stand = (s: RoomState) => {
        const t = structuredClone(s);
        t.tokens.giant = { ...t.tokens.giant!, x: to.x, y: to.y, ...(squeeze ? { squeeze: true as const } : {}) };
        return stableStringify(projectState(t, P1, { sceneId: "s1" }));
      };
      assert.equal(stand(closed), stand(open), squeeze ? "squeezed" : "full size");
    }
  });
}
