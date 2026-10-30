import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { checkPair, dragged, serverApply, type Drag, type Pair } from "./differential.ts";
import { chunkKey, tileKey, wallChunk } from "./keys.ts";
import { FOG_SUBCELLS, type FreeWall, type RoomState } from "./model.ts";
import { projectState } from "./project.ts";
import { encodeTile, TILE_BYTES, TILE_SUB } from "./rules/fog.ts";
import { placedOnHex } from "./rules/footprint.ts";
import { hexCenter, hexSubcells, type HexGrid } from "./rules/hex.ts";
import { COLUMNS, ROWS, hexWallRoom, onHex, sideWall } from "./rules/hexWalls.testkit.ts";
import { DM, P1, P2, deepClone, reveal } from "./testutil.ts";

const DISPLAY = { memberId: "display:abcdefghijkl", role: "player" as const };

function at(g: HexGrid, along: number, across: number) {
  return g.orient === "rows" ? { col: along, row: across } : { col: across, row: along };
}

function base(g: HexGrid): RoomState {
  const state = hexWallRoom(g.orient === "rows" ? "hexRows" : "hexColumns", 12, 12, []);
  state.scenes.s1 = { ...state.scenes.s1!, fogEnabled: true, autoWalls: "off" };
  state.tokens.hero = onHex(g, "hero", "medium", at(g, 2, 3), { kind: "pc", ownerIds: ["p1"], disposition: "ally" });
  return state;
}

function addWall(state: RoomState, wall: FreeWall): void {
  const { cx, cy } = wallChunk(wall);
  const key = chunkKey("s1", cx, cy);
  const chunk = state.buildChunks[key] ?? { sceneId: "s1", cx, cy, rev: 0, cells: {}, edges: {} };
  state.buildChunks[key] = { ...chunk, walls: [...(chunk.walls ?? []), wall] };
}

function drags(g: HexGrid, state: RoomState): Drag[] {
  const hero = state.tokens.hero!;
  const to = { ...placedOnHex(g, hero, at(g, 4, 3)), ...(hero.squeeze ? { squeeze: true as const } : {}) };
  return [P1, DM].map((who) => ({ who, tokenId: hero.id, to }));
}

for (const g of [ROWS, COLUMNS]) describe(`hex differential inputs and public determinism, ${g.orient}`, () => {
  test("records a sub-cell difference on a legal staggered hex even when square visibility and the route agree", () => {
    const a = base(g);
    const h = at(g, 2, 3);
    const center = hexCenter(g, h);
    assert.ok(!Number.isInteger(center.x) || !Number.isInteger(center.y), "the probe is off the integer square scan");
    const subs = hexSubcells(g, h);
    const first = subs.find(([sx, sy]) => subs.some(([x, y]) => (x !== sx || y !== sy) && Math.floor(x / FOG_SUBCELLS) === Math.floor(sx / FOG_SUBCELLS) && Math.floor(y / FOG_SUBCELLS) === Math.floor(sy / FOG_SUBCELLS)))!;
    const second = subs.find(([sx, sy]) => (sx !== first[0] || sy !== first[1]) && Math.floor(sx / FOG_SUBCELLS) === Math.floor(first[0] / FOG_SUBCELLS) && Math.floor(sy / FOG_SUBCELLS) === Math.floor(first[1] / FOG_SUBCELLS))!;
    const fogAt = ([sx, sy]: readonly [number, number]) => {
      const bits = new Uint8Array(TILE_BYTES);
      const i = sy * TILE_SUB + sx;
      bits[i >> 3]! |= 1 << (i & 7);
      return { sceneId: "s1", tx: 0, ty: 0, rev: 1, bits: encodeTile(bits) };
    };
    a.fogTiles[tileKey("s1", 0, 0)] = fogAt(first);
    const b = deepClone(a);
    b.fogTiles[tileKey("s1", 0, 0)] = fogAt(second);
    const drag = drags(g, a)[1]!;
    const da = dragged(a, drag)!;
    const db = dragged(b, drag)!;
    assert.deepEqual(da.route, db.route, "the selected route cannot expose the missed input by itself");
    const ia = da.inputs as { seen: string[]; seenSub?: string[] };
    const ib = db.inputs as { seen: string[]; seenSub?: string[] };
    assert.deepEqual(ia.seen, ib.seen, "integer square scanning sees the same ground");
    assert.notDeepEqual(da.inputs, db.inputs, "the hex search reads different sub-cells");
    assert.deepEqual(ia.seenSub, [first.join(",")]);
    assert.deepEqual(ib.seenSub, [second.join(",")]);
  });

  for (const kind of ["hidden wall", "squeezing", "rider"] as const) test(`${kind}: equal player and table-display copies keep equal searches and outcomes`, () => {
    const a = base(g);
    reveal(a, "s1", { x: 0, y: 0, w: 7, h: 7 });
    if (kind === "squeezing") {
      a.tokens.hero = onHex(g, "hero", "large", at(g, 2, 3), { ...a.tokens.hero!, size: "large", squeeze: true });
      // A one-hex lane makes the stored squeeze legal and exercises both footprints in the search.
      for (let col = 0; col < 7; col++) {
        for (const d of [1, 2, 4, 5]) addWall(a, sideWall(g, at(g, col, 3), d));
      }
    }
    if (kind === "rider") {
      a.tokens.mount = onHex(g, "mount", "large", at(g, 2, 3), { kind: "pc", ownerIds: ["p1"], disposition: "ally" });
      a.tokens.hero = { ...a.tokens.hero!, attached: { to: "mount", kind: "ride" } };
    }
    const b = deepClone(a);
    addWall(b, sideWall(g, { col: 9, row: 9 }, 0));
    for (const viewer of [P1, P2, DISPLAY]) assert.deepEqual(projectState(a, viewer, { sceneId: "s1" }), projectState(b, viewer, { sceneId: "s1" }), `${viewer.memberId} starts with the same public state`);
    const moves = drags(g, a);
    for (const drag of moves) {
      const sent = dragged(a, drag);
      assert.ok(sent && sent.route !== "none", `${kind}: ${drag.who.role} finds a route`);
      if (kind === "squeezing") assert.ok(Array.isArray(sent.route) && sent.route.some(([, , extra]) => extra === 1), "the search charges the squeezed corridor");
      const moved = serverApply(a, sent.op, drag.who, 3);
      assert.ok(moved.ok, moved.ok ? "" : moved.message);
      assert.deepEqual({ x: moved.state.tokens.hero!.x, y: moved.state.tokens.hero!.y }, { x: drag.to.x, y: drag.to.y }, "the move reaches its destination");
      if (kind === "squeezing") assert.equal(moved.state.tokens.hero!.squeeze, true, "the op stores a legal squeezed end");
    }
    const pair: Pair = { name: `${g.orient}, ${kind}`, a, b, drags: moves };
    checkPair(pair);
  });
});
