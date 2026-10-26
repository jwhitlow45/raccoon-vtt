import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { EphEvent, ServerMessage } from "#shared/protocol.ts";
import type { Viewer } from "#shared/model.ts";
import { footprintRect, footprintSubcells, placedOnHex } from "#shared/rules/footprint.ts";
import { gridOfShape } from "#shared/rules/grid.ts";
import type { HexGrid } from "#shared/rules/hex.ts";
import { DM, P1, reveal, room, scene, token } from "#shared/testutil.ts";
import { Connection } from "./connection.ts";
import { routeEphemeral } from "./ephemeral.ts";

/**
 * A drag preview on a hex scene is judged as a creature standing there is
 * (docs/design-v1-hex-grids.md HX-D10): by the fog sub-cells inside the
 * hexes it stands on, never by its box.
 */

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
  const conn = new Connection(socket as never, { sessionId: `s-${who.memberId}`, roomId: "ROOM0000", memberId: who.memberId, role: who.role }, "203.0.113.1", {});
  conn.held = new Map();
  conn.sceneId = "s1";
  return { conn, got };
}

describe("drag previews on hexes", () => {
  test("a goblin dragged over ground revealed around its hexes stays unseen, and shows once a sub-cell of its hexes is revealed", () => {
    const g = gridOfShape("hexRows") as HexGrid;
    const state = room({ scenes: { s1: scene("s1", { gridShape: "hexRows", fogEnabled: true }), s2: scene("s2") } });
    const at = placedOnHex(g, { size: "large", x: 0, y: 0 }, { col: 8, row: 8 });
    state.tokens.gob = token("gob", { size: "large", x: 2, y: 2 });
    reveal(state, "s1", { x: 0, y: 0, w: 4, h: 4 });
    const placed = { ...state.tokens.gob, ...at };
    const inside = new Set(footprintSubcells(g, placed).map(([x, y]) => `${x},${y}`));
    const box = footprintRect(g, placed);
    for (let y = Math.floor(box.y * 4); y < Math.ceil((box.y + box.h) * 4); y++) {
      for (let x = Math.floor(box.x * 4); x < Math.ceil((box.x + box.w) * 4); x++) if (!inside.has(`${x},${y}`)) reveal(state, "s1", { x: x / 4, y: y / 4, w: 0.25, h: 0.25 });
    }
    const dm = viewer(DM);
    const p1 = viewer(P1);
    const send = (e: EphEvent) => routeEphemeral(state, dm.conn, "s1", e, [dm.conn, p1.conn]);
    send({ k: "dragMove", tokenId: "gob", x: 3, y: 3 });
    assert.deepEqual(p1.got, [{ k: "dragMove", tokenId: "gob", x: 3, y: 3 }], "on revealed ground it shows");
    send({ k: "dragMove", tokenId: "gob", ...at });
    assert.deepEqual(p1.got.at(-1), { k: "dragCancel", tokenId: "gob" }, "its box revealed around its hexes hides it");
    const [sx, sy] = [...inside][0]!.split(",").map(Number) as [number, number];
    reveal(state, "s1", { x: sx / 4, y: sy / 4, w: 0.25, h: 0.25 });
    send({ k: "dragMove", tokenId: "gob", ...at });
    assert.deepEqual(p1.got.at(-1), { k: "dragMove", tokenId: "gob", ...at });
  });
});
