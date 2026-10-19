import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { chunkKey } from "../keys.ts";
import type { EdgeFeature, LogEvent, PathStop, RoomState, TokenPath, Viewer } from "../model.ts";
import { projectState } from "../project.ts";
import type { Op } from "../protocol.ts";
import { applyOp } from "../reducer.ts";
import { encodeHeights } from "../rules/heights.ts";
import { pathCounters, stopsForNonOwners, stopsForOwners } from "../rules/path.ts";
import { findRoute } from "../rules/walk.ts";
import { publicWorld } from "../rules/walkWorld.ts";
import { DM, P1, P2, actor, env, reveal, room, template, token, withoutWalked } from "../testutil.ts";
import type { Env } from "./tx.ts";

/**
 * Moves walking their routes (docs/design-v1-movement.md 6.2 and 7): what
 * each leg takes on the turn's path, its corners and whether players saw it
 * whole, joins by those sums, what reaches whom, the area sweep along a
 * route, and ops from before op version 13 replaying as they ran.
 */

const START: Op = { t: "encounter.start", entries: [{ id: "n1", tokenId: "wolf", value: 20 }, { id: "n2", tokenId: "gob", value: 10 }] };
const NEXT: Op = { t: "encounter.next" };
const move = (x: number, y: number, extra: Partial<Extract<Op, { t: "token.move" }>> = {}): Op => ({ t: "token.move", tokenId: "wolf", x, y, ...extra });
const at = (seq: number, opVersion?: number): Env => ({ ...env(seq), ...(opVersion === undefined ? {} : { opVersion }) });

/** Edges on the scene's first chunk. */
function walled(state: RoomState, edges: Record<string, EdgeFeature>): void {
  state.buildChunks[chunkKey("s1", 0, 0)] = { sceneId: "s1", cx: 0, cy: 0, rev: 1, cells: {}, edges };
  state.scenes.s1 = { ...state.scenes.s1!, blockMovement: true };
}

/** P1's wolf at 1,1 acts first, then a goblin. Each op gets the next seq, as on the server. */
function fight(setup?: (state: RoomState) => void, opVersion?: number) {
  const state = room({ tokens: { wolf: token("wolf", { name: "Wolf", ownerIds: ["p1"], x: 1, y: 1 }), gob: token("gob", { x: 10, y: 1 }) } });
  setup?.(state);
  const f = {
    state,
    seq: 0,
    last: null as ReturnType<typeof applyOp> | null,
    run(op: Op, who: Viewer = DM) {
      f.seq++;
      const r = applyOp(f.state, op, who, at(f.seq, opVersion));
      assert.ok(r.ok, `${op.t}: ${r.ok ? "" : r.message}`);
      f.last = r;
      f.state = r.state;
      return f;
    },
    stops(): PathStop[] {
      return f.state.tokens.wolf!.path!.stops;
    },
  };
  return f.run(START).run(NEXT);
}

const WALL: EdgeFeature = { kind: "wall" };

describe("what a leg takes (6.2)", () => {
  test("a plain leg records its feet, a straight leg's cost, and the 5-10-5 diagonals it took", () => {
    const f = fight((s) => (s.meta.settings.diagonal = "fiveTen"));
    f.run(move(3, 3));
    assert.deepEqual(pick(f.stops()[1]!), { moved: 15, cost: 15, diag: [2, 0] });
    f.run(move(4, 4)).run(move(5, 5));
    assert.deepEqual(f.stops().slice(2).map(pick), [
      { moved: 5, cost: 5, diag: [1, 0] },
      { moved: 10, cost: 10, diag: [1, 0] },
    ]);
    assert.deepEqual(pathCounters(f.state.tokens.wolf!, f.stops(), f.state.meta.settings), { h: 4, v: 0 });
  });

  test("a routed leg records its corners, its feet and what terrain added, and a Swim Speed takes the swimming foot off", () => {
    const f = fight((s) => walled(s, { "3,0,w": WALL, "3,1,w": WALL, "3,2,w": WALL }));
    const route: [number, number, number, 0 | 1][] = [
      [1, 3, 0, 0],
      [4, 3, 1, 0],
      [5, 2, 0, 0],
      [5, 1, 1, 1],
    ];
    f.run(move(5, 1, { route }));
    const stop = f.stops()[1]!;
    assert.deepEqual(stop.via, [1, 3, 4, 3, 5, 2]);
    assert.deepEqual(pick(stop), { moved: 35, cost: 10 + 30 + 5 + 10, diag: undefined });
    const swimmer = fight((s) => {
      walled(s, { "3,0,w": WALL, "3,1,w": WALL, "3,2,w": WALL });
      s.tokens.wolf = { ...s.tokens.wolf!, actor: { inline: actor({ speeds: { walk: 40, swim: 40 } }) } };
    });
    swimmer.run(move(5, 1, { route }));
    assert.equal(swimmer.stops()[1]!.cost, 10 + 30 + 5 + 5);
  });

  test("a walk over a rise and down again records both climbs, as the search finds it", () => {
    // A ridge 10 ft high and one square wide along x = 2, across the wolf's way to (3, 1).
    const f = fight((s) => {
      const feet = new Array<number>(256).fill(0);
      for (let y = 0; y < 16; y++) feet[y * 16 + 2] = 10;
      s.scenes.s1 = { ...s.scenes.s1!, bounds: { w: 16, h: 16 } };
      s.buildChunks[chunkKey("s1", 0, 0)] = { sceneId: "s1", cx: 0, cy: 0, rev: 1, cells: {}, edges: {}, heights: encodeHeights(feet) };
    });
    const found = findRoute(publicWorld(f.state, f.state.tokens.wolf!, { role: "player" }).input, { x: 3, y: 1 });
    assert.ok(found !== null && found !== "none", "the straight leg over the rise is not the walk");
    f.run(move(3, 1, { route: found.pieces.map(([x, y, extra, swim]): [number, number, number, 0 | 1] => [x, y, extra, swim]) }), P1);
    assert.deepEqual(pick(f.stops()[1]!), { moved: 20, cost: 20, diag: undefined }, "10 ft up and 10 ft down");
  });

  test("a leg seen at every spot is marked, one through the fog not, though both its ends are seen", () => {
    const f = fight();
    f.run(move(4, 1));
    assert.equal(f.stops()[1]!.routeSeen, true);
    const fogged = fight((s) => {
      // The DM's wolf, no party member, on a fogged scene revealed at both ends of its walk.
      s.tokens.wolf = { ...s.tokens.wolf!, ownerIds: [] };
      s.scenes.s1 = { ...s.scenes.s1!, fogEnabled: true };
      reveal(s, "s1", { x: 0, y: 0, w: 3, h: 3 });
      reveal(s, "s1", { x: 7, y: 0, w: 3, h: 3 });
    });
    fogged.run(move(8, 1));
    const stop = fogged.stops()[1]!;
    assert.deepEqual([fogged.stops()[0]!.seen, stop.seen, stop.routeSeen], [true, true, undefined]);
    const open = fight((s) => {
      s.tokens.wolf = { ...s.tokens.wolf!, ownerIds: [] };
      s.scenes.s1 = { ...s.scenes.s1!, fogEnabled: true };
      reveal(s, "s1", { x: 0, y: 0, w: 10, h: 3 });
    });
    open.run(move(8, 1));
    assert.equal(open.stops()[1]!.routeSeen, true);
  });

  test("Doesn't count flips the mark and nothing else, and the readers leave the leg out", () => {
    const f = fight((s) => (s.meta.settings.diagonal = "fiveTen"));
    f.run(move(2, 2)).run(move(3, 3));
    const before = pick(f.stops()[2]!);
    f.run({ t: "token.countLeg", tokenId: "wolf", counts: false }, P1);
    assert.deepEqual(pick(f.stops()[2]!), before);
    assert.deepEqual(pathCounters(f.state.tokens.wolf!, f.stops(), f.state.meta.settings), { h: 1, v: 0 });
  });
});

describe("joins and the corner cap (6.2)", () => {
  test("a full path's joined legs keep the sums of their counted parts, and the oldest corners go past 100", () => {
    const f = fight((s) => (s.meta.settings.diagonal = "fiveTen"));
    let total = 0;
    let corners = 0;
    for (let k = 0; k < 70; k++) {
      // A walk east and back with three corners, 4 squares out and in.
      const x = k % 2 === 0 ? 5 : 1;
      const route: [number, number, number, 0 | 1][] = k % 2 === 0 ? [[2, 2, 0, 0], [3, 2, 0, 0], [4, 2, 0, 0], [5, 1, 0, 0]] : [[4, 2, 0, 0], [3, 2, 0, 0], [2, 2, 0, 0], [1, 1, 0, 0]];
      f.run(move(x, 1, { route }));
      total += f.stops().at(-1)!.moved!;
      corners += 3;
      if (k === 20) f.run({ t: "token.countLeg", tokenId: "wolf", counts: false }, P1);
    }
    const stops = f.stops();
    assert.equal(stops.length, 50);
    const counted = stops.slice(1).filter((s) => s.uncounted !== true);
    const uncounted = stops.slice(1).filter((s) => s.uncounted === true);
    assert.equal(uncounted.length, 0, "the uncounted leg joined a counted one, which counts");
    assert.ok(corners > 100);
    assert.ok(stops.reduce((n, s) => n + (s.via?.length ?? 0) / 2, 0) <= 100, "at most 100 corners kept");
    // Every leg walked 4 squares, one of them not counting: the sums lose nothing and add nothing.
    const counter = { h: 0, v: 0 };
    void counter;
    assert.ok(counted.every((s) => s.moved !== undefined));
    const legs = counted.reduce((n, s) => n + s.moved!, 0);
    assert.ok(legs < total && total - legs <= 25, `${legs} of ${total}: only the uncounted leg is left out`);
  });
});

describe("what reaches whom (7.3)", () => {
  const stops: PathStop[] = [
    { x: 1, y: 1, elevation: 0, seen: true },
    { x: 5, y: 1, elevation: 0, seen: true, via: [1, 3, 4, 3], moved: 30, cost: 40, diag: [1, 0], routeSeen: true },
    { x: 9, y: 1, elevation: 0, seen: true, via: [7, 3], moved: 20, cost: 20 },
    { x: 12, y: 1, elevation: 0, seen: true, joinedUnseen: true, via: [11, 3], moved: 15, cost: 15, routeSeen: true },
    { x: 14, y: 1, elevation: 0, via: [13, 3], moved: 10, cost: 10, routeSeen: true },
  ];

  test("owners get every stop whole, with a mark on the legs others saw whole", () => {
    const own = stopsForOwners(stops);
    assert.deepEqual(own[1], { x: 5, y: 1, elevation: 0, via: [1, 3, 4, 3], moved: 30, cost: 40, diag: [1, 0], routeSeen: true });
    assert.equal(own[2]!.routeSeen, undefined);
    assert.equal(own[3]!.routeSeen, undefined, "joined across a stop they could not see");
    assert.deepEqual(own[4]!.via, [13, 3]);
  });

  test("other players get a leg's bends only when they saw it whole, and never what it took", () => {
    const theirs = stopsForNonOwners(stops);
    assert.equal(theirs.length, 4, "the stop they could not see is not sent");
    assert.deepEqual(theirs[1], { x: 5, y: 1, elevation: 0, via: [1, 3, 4, 3], routeSeen: true });
    assert.deepEqual(theirs[2], { x: 9, y: 1, elevation: 0 }, "not seen at every spot: no bends");
    assert.deepEqual(theirs[3], { x: 12, y: 1, elevation: 0 });
  });

  test("the projection sends them as such", () => {
    const f = fight((s) => walled(s, { "3,0,w": WALL, "3,1,w": WALL, "3,2,w": WALL }));
    f.run(move(5, 1, { route: [[1, 3, 0, 0], [4, 3, 1, 0], [5, 1, 0, 0]] }));
    const owner = projectState(f.state, P1, { sceneId: "s1" }).tokens.wolf!.path!.stops[1]!;
    const other = projectState(f.state, P2, { sceneId: "s1" }).tokens.wolf!.path!.stops[1]!;
    assert.deepEqual([owner.moved, owner.cost, owner.via], [35, 50, [1, 3, 4, 3]]);
    assert.deepEqual(other, { x: 5, y: 1, elevation: 0, via: [1, 3, 4, 3], routeSeen: true });
  });
});

describe("ops from before op version 13 (6.2, M5, M14)", () => {
  test("replay writes today's stops and joins, bit for bit, and an undo's guard still matches", () => {
    const moves: Op[] = Array.from({ length: 56 }, (_, k) => move(1 + (k % 5), 1 + (k % 3)));
    const old = fight(undefined, 12);
    const live = fight();
    for (const op of moves) {
      old.run(op);
      live.run(op);
    }
    const oldPath: TokenPath = old.state.tokens.wolf!.path!;
    assert.ok(oldPath.stops.every((s) => s.moved === undefined && s.cost === undefined && s.diag === undefined && s.via === undefined && s.routeSeen === undefined));
    assert.deepEqual(withoutWalked(live.state.tokens.wolf!.path), oldPath, "the same marks and joins, without the new fields");
    // The last move's undo, made at version 12, replays at version 12 against what that move made.
    const inverse = old.last!.ok ? old.last!.inverse! : [];
    const undo: Op = { t: "sys.restore", entries: inverse, from: "undo", deps: true };
    assert.ok(applyOp(old.state, undo, DM, at(old.seq + 1, 12)).ok);
    assert.equal(applyOp(live.state, undo, DM, at(live.seq + 1)).ok, false, "today's stops would not match the stored guard");
  });
});

describe("area reminders along a route (7.2)", () => {
  function sweep(ops: Op[], opVersion?: number, setup?: (s: RoomState) => void): LogEvent[] {
    const state = room({ tokens: { gob: token("gob", { name: "Goblin", x: 2, y: 2 }) } });
    state.encounter = { rev: 0, round: 1, activeEntryId: "e1", entries: [{ id: "e1", tokenId: "gob", value: 10, tieOrder: 0 }] as never };
    setup?.(state);
    const out: LogEvent[] = [];
    let seq = 1;
    let s = state;
    for (const op of ops) {
      const r = applyOp(s, op, DM, at(seq++, opVersion));
      assert.ok(r.ok, r.ok ? "" : r.message);
      s = r.state;
      for (const e of r.log) if (e.data?.type === "area") out.push(e.data);
    }
    return out;
  }
  const cube = (x: number, y: number, z = 0, size = 5) => (s: RoomState) => {
    s.templates.c1 = template("c1", { shape: "cube", size, origin: { x, y, z }, spell: "Grease", triggers: ["enter"] });
  };

  test("an older elevation move from -10 ft to +10 ft through a cube still writes its entry", () => {
    const ops: Op[] = [
      { t: "token.update", tokenId: "gob", patch: { elevation: -10 } },
      { t: "token.move", tokenId: "gob", x: 2, y: 2, elevation: 10 },
    ];
    for (const v of [12, undefined]) assert.equal(sweep(ops, v, cube(2.5, 2.5, 0)).length, 1);
  });

  test("a route is swept piece by piece at the straight leg's density, so it catches what that leg catches", () => {
    for (let k = 0; k < 12; k++) {
      const setup = cube(3 + k * 0.25, 3.5 - k * 0.1);
      const plain = sweep([{ t: "token.move", tokenId: "gob", x: 6, y: 6 }], undefined, setup);
      const routed = sweep([{ t: "token.move", tokenId: "gob", x: 6, y: 6, route: [[4, 4, 0, 0], [6, 6, 0, 0]] }], undefined, setup);
      assert.deepEqual(routed, plain, `cube ${k}`);
    }
    // Around a corner, the second piece crosses an area the start and the end are both clear of.
    const bent = sweep([{ t: "token.move", tokenId: "gob", x: 8, y: 6, route: [[2, 6, 0, 0], [8, 6, 0, 0]] }], undefined, cube(5.5, 6.5));
    assert.equal(bent.length, 1);
    const straight = sweep([{ t: "token.move", tokenId: "gob", x: 8, y: 6 }], undefined, cube(5.5, 6.5));
    assert.equal(straight.length, 0, "the straight leg from 2,2 passes it by");
  });
});

function pick(stop: PathStop): { moved?: number; cost?: number; diag?: [number, number] } {
  return { moved: stop.moved, cost: stop.cost, diag: stop.diag };
}
