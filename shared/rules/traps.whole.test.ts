import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { describe, test } from "node:test";
import fc from "fast-check";
import { lift, wall } from "../discoveryTestutil.ts";
import { ANA, applied, tower, UPPER } from "../floorLinksTestutil.ts";
import type { CellRect, RoomState, Token, Trap, TrapRig, Viewer } from "../model.ts";
import { hash128, projectState, stableStringify } from "../project.ts";
import { holds } from "../propertyTestutil.ts";
import type { Op } from "../protocol.ts";
import { chance, DM, int, member, P1, P2, pick, rng, room, scene, token, trap } from "../testutil.ts";
import { footprintSize, occupiedRange, type CellRange } from "./footprint.ts";
import { SQUARES as SQ } from "./grid.ts";
import { planTrapMove, squeezeWalksWhole, trapWalks, WHOLE_SQUARES_OP_VERSION, type MovePlan } from "./traps.ts";

/**
 * Squeezing walks read whole squares (docs/design/design-v1-traps.md 5.3,
 * change format 70, traps.ts squeezeWalksWhole): on squares a walk that
 * starts or ends squeezed reads, at each spot between its ends, only the
 * squares wholly inside the creature's space there. The cases of the
 * squeezing walks' design, a twin whose walls lie under the fog, and four
 * properties: a room and its mirror spring alike (P1), nothing past the
 * squeezed space springs (P2), a walk with no squeeze plans as before (P3),
 * and a corpus stored before change format 70 plans as it did (P4).
 */

const FIXTURE = new URL("../reducer/wholeSquares.replay.fixture.json", import.meta.url);

/** A plan as one line: each springing's trap, how, pass, who set it off and whom it hits, then the op as the plan leaves it. */
function planLine(p: MovePlan): string {
  return stableStringify({ springings: p.springings.map((s) => [s.trap.id, s.how, s.pass, s.by, s.hits]), op: p.op });
}

function rigOf(r: () => number): TrapRig {
  return {
    on: pick(r, [["enter"], ["enter"], ["leave"], ["enter", "leave"]] as const).slice(),
    who: "any",
    floor: chance(r, 0.6),
    resets: "never",
    stops: chance(r, 0.4),
    foundOnSpring: chance(r, 0.5),
    hits: chance(r, 0.6) ? "trigger" : "zone",
    actions: [],
    find: [],
    notice: false,
  };
}

const SIZES: readonly Pick<Token, "size" | "w" | "h">[] = [
  { size: "tiny" },
  { size: "small" },
  { size: "medium" },
  { size: "large" },
  { size: "large" },
  { size: "large" },
  { size: "huge" },
  { size: "huge" },
  { size: "gargantuan" },
  { size: "custom", w: 2.5, h: 2.5 },
  { size: "custom", w: 1, h: 3 },
  { size: "custom", w: 3.5, h: 1.5 },
  { size: "custom", w: 0.5, h: 2 },
];

/**
 * One case of the corpus: a scene of squares with a few walls, now and
 * then the fog, traps of every rig, a creature of any size that may stand
 * squeezed, now and then hidden or with a creature in tow, and a walk of
 * it by the DM or its player, squeezed at its end or not, on a route of up
 * to three pieces, stored at a change format before 70.
 */
function corpusCase(seed: number): { state: RoomState; op: Op; who: Viewer; opVersion: number } {
  const r = rng(seed * 104_729 + 17);
  const W = 24;
  const H = 20;
  const state = room({
    members: { dm1: member("dm1", "dm"), p1: member("p1"), p2: member("p2") },
    scenes: { s1: scene("s1", { bounds: { w: W, h: H }, blockMovement: chance(r, 0.5), autoWalls: "off", fogEnabled: chance(r, 0.2) }) },
  });
  state.buildChunks = {};
  if (state.scenes.s1!.fogEnabled) lift(state, "dm", { x: 0, y: 0, w: int(r, 6, W), h: H });
  for (let i = 0, n = int(r, 0, 4); i < n; i++) {
    const x = int(r, 1, W - 8);
    const y = int(r, 1, H - 8);
    const len = int(r, 2, 6);
    wall(state, `wall${String(i).padStart(8, "0")}`, [x, y], chance(r, 0.5) ? [x + len, y] : [x, y + len]);
  }
  for (let i = 0, n = int(r, 2, 6); i < n; i++) {
    state.traps[`t${i}`] = trap(`t${i}`, { name: `Trap ${i + 1}`, zone: { cells: [{ x: int(r, 0, W - 3), y: int(r, 0, H - 3), w: int(r, 1, 3), h: int(r, 1, 3) }] }, rig: rigOf(r) });
  }
  const half = (lo: number, hi: number) => int(r, lo * 2, hi * 2) / 2;
  const size = pick(r, SIZES);
  const from = { x: half(1, W - 6), y: half(1, H - 6) };
  const mover: Token = token("bear", { ...size, ...from, name: "Bear", kind: "npc", ownerIds: ["p1"], ...(chance(r, 0.2) ? { visibility: "dm" as const } : {}) });
  state.tokens.bear = chance(r, 0.5) ? { ...mover, squeeze: true } : mover;
  if (chance(r, 0.25)) state.tokens.tow = token("tow", { x: Math.max(0, from.x - 1), y: from.y, name: "Goblin", kind: "npc", attached: { to: "bear", kind: "drag" }, ...(chance(r, 0.3) ? { visibility: "dm" as const } : {}) });
  const pieces = int(r, 1, 3);
  const route: [number, number, number, 0 | 1][] = [];
  for (let k = 0; k < pieces; k++) route.push([half(0, W - 5), half(0, H - 5), 0, 0]);
  const end = route[route.length - 1]!;
  const op: Op = { t: "token.move", tokenId: "bear", x: end[0], y: end[1], ...(chance(r, 0.6) ? { squeeze: true } : {}), ...(pieces > 1 || chance(r, 0.5) ? { route } : {}) };
  return { state, op, who: chance(r, 0.5) ? P1 : DM, opVersion: pick(r, [35, 41, 50, 62, 64, 66, 68, 69, 69, 69]) };
}

const CORPUS = 400;

function corpusPlans(opVersion?: number): string[] {
  return Array.from({ length: CORPUS }, (_, i) => {
    const c = corpusCase(i + 1);
    return hash128(planLine(planTrapMove(c.op, c.state, c.who, { opVersion: opVersion ?? c.opVersion })));
  });
}

describe("ops stored before change format 70 plan as they did (P4)", () => {
  // The corpus's hashes sit in the replay fixture beside its other sides. Write them again with REPLAY_WHOLE=corpus only from a
  // build before change format 70, since a later one would pin the new reading as the old.
  test("a seeded corpus of walks, recorded on the build before whole squares, plans the same springings, stops and hits at its stored change formats", () => {
    const now = corpusPlans();
    if (process.env.REPLAY_WHOLE === "corpus") {
      const was = JSON.parse(readFileSync(FIXTURE, "utf8")) as Record<string, unknown>;
      writeFileSync(FIXTURE, `${JSON.stringify({ ...was, corpus: now }, null, 2)}\n`);
    }
    const pinned = (JSON.parse(readFileSync(FIXTURE, "utf8")) as { corpus?: string[] }).corpus;
    assert.ok(pinned, "the corpus is pinned");
    assert.equal(now.length, pinned.length);
    assert.deepEqual(now.flatMap((h, i) => (h !== pinned[i] ? [i + 1] : [])), [], "these cases plan otherwise");
  });

  test("the corpus holds walks that start or end squeezed, many of which plan otherwise from change format 70", () => {
    const before = corpusPlans(WHOLE_SQUARES_OP_VERSION - 1);
    const from = corpusPlans(WHOLE_SQUARES_OP_VERSION);
    const moved = before.filter((h, i) => h !== from[i]).length;
    if (process.env.REPLAY_WHOLE === "count") console.log({ moved });
    assert.ok(moved >= 20, `${moved} of ${CORPUS} plan otherwise at change format 70`);
  });
});

// ---------------------------------------------------------------------------
// The cases (DEDGE design 11)

const STORED = WHOLE_SQUARES_OP_VERSION - 1;

function rigOver(over: Partial<TrapRig> = {}): TrapRig {
  return { on: ["enter"], who: "any", floor: true, resets: "never", stops: false, foundOnSpring: true, hits: "trigger", actions: [], find: [], notice: false, ...over };
}

function plate(id: string, cells: CellRect, over: Partial<TrapRig> = {}, sceneId = "s1"): Trap {
  return trap(id, { sceneId, name: id, zone: { cells: [cells] }, rig: rigOver(over) });
}

function summary(p: MovePlan): string[] {
  return p.springings.map((s) => `${s.trap.id}:${s.how}:${s.pass}:${s.by.join("+")}`);
}

/** The plans of an op stored at 69 and live, by the DM unless told otherwise. */
function both(state: RoomState, op: Op, who: Viewer = DM): { stored: MovePlan; live: MovePlan } {
  return { stored: planTrapMove(op, state, who, { opVersion: STORED }), live: planTrapMove(op, state, who, {}) };
}

/**
 * A scene 30 by 20 with a corridor one square wide along row 5, walled on
 * y = 5 and y = 6 from x 4 to 16, and Bear, a Large creature Ana plays, at
 * 1, 4 west of it.
 */
function corridor(over: { block?: boolean; bear?: Partial<Token> } = {}): RoomState {
  const s = room({ members: { dm1: member("dm1", "dm"), p1: member("p1"), p2: member("p2") }, scenes: { s1: scene("s1", { bounds: { w: 30, h: 20 }, blockMovement: over.block ?? true, autoWalls: "off" }) } });
  s.buildChunks = {};
  wall(s, "corridorn001", [4, 5], [10, 5]);
  wall(s, "corridorn002", [10, 5], [16, 5]);
  wall(s, "corridors001", [4, 6], [10, 6]);
  wall(s, "corridors002", [10, 6], [16, 6]);
  s.tokens.bear = token("bear", { size: "large", x: 1, y: 4, name: "Bear", kind: "pc", disposition: "ally", ownerIds: ["p1"], ...over.bear });
  return s;
}

/** Into the corridor by its mouth at 3.5, 4.5, to end squeezed at `x`, 4.5. */
const intoCorridor = (x: number): Op => ({ t: "token.move", tokenId: "bear", x, y: 4.5, squeeze: true, route: [[3.5, 4.5, 0, 0], [x, 4.5, 0, 0]] });

describe("a Large creature squeezing into a corridor along the map's edge (LP54-EDGE-1)", () => {
  // The tower's Upper floor, 20 by 20, in a frame turned to each edge: the corridor is the edge's row, walled one square in but
  // for a doorway from 12 to 15 along it. Bear stands at 13, 2 and squeezes to 13.5, -0.5, so its squeezed space is square 14 of
  // the edge's row alone, and at 13.5, 0 its full space rounded up took in square 15 too.
  type Edge = "north" | "south" | "west" | "east";
  const place = (edge: Edge, u: number, v: number, su: number, sv: number) =>
    edge === "north" ? { x: u, y: v } : edge === "south" ? { x: u, y: 20 - v - sv } : edge === "west" ? { x: v, y: u } : { x: 20 - v - sv, y: u };
  const cells = (edge: Edge, u: number, v: number, lu: number, lv: number): CellRect => {
    const a = place(edge, u, v, lu, lv);
    return edge === "north" || edge === "south" ? { ...a, w: lu, h: lv } : { ...a, w: lv, h: lu };
  };
  function edgeRoom(edge: Edge, doorAt: number): RoomState {
    const s = tower();
    s.meta = { ...s.meta, playerSceneId: UPPER };
    s.scenes[UPPER] = { ...s.scenes[UPPER]!, blockMovement: true, autoWalls: "off" };
    const pt = (u: number, v: number): [number, number] => {
      const p = place(edge, u, v, 0, 0);
      return [p.x, p.y];
    };
    wall(s, "edgewall0001", pt(0, 1), pt(12, 1), undefined, UPPER);
    wall(s, "edgewall0002", pt(15, 1), pt(20, 1), undefined, UPPER);
    s.tokens.bear = token("bear", { sceneId: UPPER, size: "large", ...place(edge, 13, 2, 2, 2), name: "Bear", kind: "pc", disposition: "ally", ownerIds: ["p1"] });
    s.traps.td1 = trap("td1", { sceneId: UPPER, name: "Trapdoor", zone: { cells: [cells(edge, doorAt, 0, 2, 1)] }, rig: { ...rigOver({ stops: true }), below: true } });
    return s;
  }

  for (const edge of ["north", "south", "west", "east"] as const) {
    test(`along the ${edge} edge, the trapdoor beside the square it ends on, on either side, stays armed and drops no one, for Ana and the DM`, () => {
      for (const doorAt of [15, 12]) {
        const s = edgeRoom(edge, doorAt);
        const end = place(edge, 13.5, -0.5, 2, 2);
        const op: Op = { t: "token.move", tokenId: "bear", x: end.x, y: end.y, squeeze: true };
        for (const who of [ANA, DM]) {
          const r = applied(s, op, who);
          const bear = r.state.tokens.bear!;
          assert.equal(r.state.traps.td1!.state, "armed", `the trapdoor at ${doorAt}, by ${who.role}`);
          assert.deepEqual([bear.sceneId, bear.x, bear.y, bear.squeeze], [UPPER, end.x, end.y, true], "Bear stays squeezed on Upper floor");
          assert.deepEqual(Object.keys(r.state.falls ?? {}), [], "no fall card");
        }
      }
    });
  }

  test("stored at 69, the walk along every edge springs the trapdoor past the square it ends on, as it was made", () => {
    // Snapping rounds half a square up, and each frame runs along its edge the way the scene's x or y grows.
    for (const edge of ["north", "south", "west", "east"] as const) {
      const s = edgeRoom(edge, 15);
      const end = place(edge, 13.5, -0.5, 2, 2);
      const op: Op = { t: "token.move", tokenId: "bear", x: end.x, y: end.y, squeeze: true };
      assert.equal(applied(s, op, ANA, STORED).state.traps.td1!.state, "sprung", edge);
    }
  });
});

describe("a Large creature squeezing into a corridor inside the map", () => {
  for (const block of [true, false]) {
    test(`darts behind the south wall stay armed wherever it ends, by a player or the DM, walls blocking players' moves ${block ? "on" : "off"}`, () => {
      for (const x of [9.5, 12.5, 14.5]) {
        const s = corridor({ block });
        s.traps.darts = plate("darts", { x: 9, y: 6, w: 3, h: 1 });
        const { stored, live } = both(s, intoCorridor(x));
        assert.deepEqual(summary(stored), ["darts:enter:public:bear"], `stored at 69, ending at ${x}, its rounded-up space reached them`);
        assert.deepEqual(summary(live), [], `ending at ${x}`);
        for (const who of [P1, DM]) assert.equal(applied(s, intoCorridor(x), who).state.traps.darts!.state, "armed", `ending at ${x}, by ${who.role}`);
      }
    });
  }

  test("darts behind the north wall stay armed, as they did", () => {
    for (const x of [9.5, 12.5, 14.5]) {
      const s = corridor();
      s.traps.darts = plate("darts", { x: 9, y: 4, w: 3, h: 1 });
      const { stored, live } = both(s, intoCorridor(x));
      assert.deepEqual([summary(stored), summary(live)], [[], []], `ending at ${x}`);
    }
  });

  test("a plate in the corridor on its way goes off and hits it, and a hit area past the south wall no longer finds it there", () => {
    const s = corridor();
    s.traps.plate = plate("plate", { x: 7, y: 5, w: 1, h: 1 }, { hits: "zone" });
    s.traps.hall = plate("hall", { x: 6, y: 5, w: 1, h: 1 }, { hits: { cells: [{ x: 5, y: 6, w: 4, h: 1 }] } });
    const { stored, live } = both(s, intoCorridor(12.5));
    const hits = (p: MovePlan) => Object.fromEntries(p.springings.map((x) => [x.trap.id, x.hits]));
    assert.deepEqual(hits(live), { hall: [], plate: ["bear"] });
    assert.deepEqual(hits(stored), { hall: ["bear"], plate: ["bear"] }, "stored at 69, its rounded-up space stood on row 6 when the hall went off");
  });

  test("a hidden Large creature the DM walks in reads the same squares in the private pass, so the darts stay armed", () => {
    const s = corridor({ bear: { visibility: "dm" } });
    s.traps.darts = plate("darts", { x: 9, y: 6, w: 3, h: 1 });
    const { stored, live } = both(s, intoCorridor(12.5));
    assert.deepEqual(summary(stored), ["darts:enter:private:bear"]);
    assert.deepEqual(summary(live), []);
    assert.equal(applied(s, intoCorridor(12.5), DM).state.traps.darts!.state, "armed");
  });

  test("a 2.5 by 2.5 creature that ends squeezed sets off no plate on the row its space half covers", () => {
    // Walking east at y 4 its space covers rows 4 and 5 whole and half of row 6, which snapping read whole.
    const s = corridor({ bear: { size: "custom", w: 2.5, h: 2.5, x: 0, y: 4 } });
    s.traps.row6 = plate("row6", { x: 8, y: 6, w: 1, h: 1 });
    s.traps.row5 = plate("row5", { x: 9, y: 5, w: 1, h: 1 });
    const op: Op = { t: "token.move", tokenId: "bear", x: 12, y: 4, squeeze: true };
    const { stored, live } = both(s, op);
    assert.deepEqual(summary(stored), ["row6:enter:public:bear", "row5:enter:public:bear"]);
    assert.deepEqual(summary(live), ["row5:enter:public:bear"], "the row it covers whole still counts");
  });

  test("a Huge creature in a corridor two squares wide reads its two squeezed rows", () => {
    const s = corridor({ bear: { size: "huge", x: 0, y: 4 } });
    s.buildChunks = {};
    wall(s, "corridorn001", [4, 5], [16, 5]);
    wall(s, "corridors001", [4, 7], [16, 7]);
    s.traps.row5 = plate("row5", { x: 8, y: 5, w: 1, h: 1 });
    s.traps.row6 = plate("row6", { x: 10, y: 6, w: 1, h: 1 });
    s.traps.row7 = plate("row7", { x: 12, y: 7, w: 1, h: 1 });
    const op: Op = { t: "token.move", tokenId: "bear", x: 13.5, y: 4.5, squeeze: true, route: [[3.5, 4.5, 0, 0], [13.5, 4.5, 0, 0]] };
    const { stored, live } = both(s, op);
    assert.deepEqual(summary(stored), ["row5:enter:public:bear", "row6:enter:public:bear", "row7:enter:public:bear"]);
    assert.deepEqual(summary(live), ["row5:enter:public:bear", "row6:enter:public:bear"]);
  });

  test("a walk through the corridor and out, full size at both ends, still sets off darts behind the south wall (DEDGE-THROUGH)", () => {
    const s = corridor();
    s.traps.darts = plate("darts", { x: 9, y: 6, w: 3, h: 1 });
    const op: Op = { t: "token.move", tokenId: "bear", x: 18, y: 4, route: [[3.5, 4.5, 0, 0], [16.5, 4.5, 0, 0], [18, 4, 0, 0]] };
    const { stored, live } = both(s, op);
    assert.deepEqual([summary(stored), summary(live)], [["darts:enter:public:bear"], ["darts:enter:public:bear"]]);
  });
});

describe("a walk that starts squeezed reads whole squares all the way to its end", () => {
  function squeezedIn(at: { x: number; y: number }): RoomState {
    const s = corridor({ bear: { ...at, squeeze: true } });
    return s;
  }

  test("around the bend of an L-shaped corridor, darts past the second arm's east wall stay armed", () => {
    // Down the first arm from 9.5, 4.5 to 9.5, 12.5, then on to 9, 15: after the first piece it walks full size, half a square off.
    const s = squeezedIn({ x: 9.5, y: 4.5 });
    s.traps.darts = plate("darts", { x: 11, y: 13, w: 1, h: 1 });
    const op: Op = { t: "token.move", tokenId: "bear", x: 9, y: 15, route: [[9.5, 12.5, 0, 0], [9, 15, 0, 0]] };
    const { stored, live } = both(s, op);
    assert.deepEqual(summary(stored), ["darts:enter:public:bear"]);
    assert.deepEqual(summary(live), []);
  });

  test("out of the corridor and south along x 16.5 across a room, a pit on column 18 it half covers stays armed (D-261128-046)", () => {
    const s = squeezedIn({ x: 9.5, y: 4.5 });
    s.traps.pit = plate("pit", { x: 18, y: 9, w: 1, h: 2 });
    const op: Op = { t: "token.move", tokenId: "bear", x: 16.5, y: 14, route: [[16.5, 4.5, 0, 0], [16.5, 14, 0, 0]] };
    const { stored, live } = both(s, op);
    assert.deepEqual(summary(stored), ["pit:enter:public:bear"]);
    assert.deepEqual(summary(live), [], "where it ends it stands snapped, past the pit");
  });

  test("where it ends full size half a square off, it is read as it stands, so the room and its mirror differ there (Sol's case)", () => {
    // From squeezed at 3.5, 3.5 to full size at 9.5, 3.5: it stands snapped to 10, 4, on 11, 5. Top to bottom, it snaps to 10,
    // H - 5 and stands clear of the mirrored plate on H - 6. Between the ends the two read alike.
    const H = 20;
    const s = squeezedIn({ x: 3.5, y: 3.5 });
    s.buildChunks = {};
    s.traps.plate = plate("plate", { x: 11, y: 5, w: 1, h: 1 });
    const mirror = squeezedIn({ x: 3.5, y: H - 3.5 - 2 });
    mirror.buildChunks = {};
    mirror.traps.plate = plate("plate", { x: 11, y: H - 6, w: 1, h: 1 });
    assert.deepEqual(summary(planTrapMove({ t: "token.move", tokenId: "bear", x: 9.5, y: 3.5 }, s, DM, {})), ["plate:enter:public:bear"]);
    assert.deepEqual(summary(planTrapMove({ t: "token.move", tokenId: "bear", x: 9.5, y: H - 3.5 - 2 }, mirror, DM, {})), []);
  });
});

describe("the whole-squares walk reads nothing the fog hides", () => {
  // Two rooms, fog on, everything revealed but a block over the corridor, whose walls one twin has and the other lacks.
  function twin(walled: boolean): RoomState {
    const s = corridor();
    s.scenes.s1 = { ...s.scenes.s1!, fogEnabled: true };
    if (!walled) s.buildChunks = {};
    lift(s, "dm", { x: 0, y: 0, w: 30, h: 3 });
    lift(s, "dm", { x: 0, y: 3, w: 4, h: 17 });
    lift(s, "dm", { x: 17, y: 3, w: 13, h: 17 });
    lift(s, "dm", { x: 4, y: 9, w: 13, h: 11 });
    s.traps.darts = plate("darts", { x: 9, y: 6, w: 3, h: 1 });
    s.traps.plate = plate("plate", { x: 7, y: 5, w: 1, h: 1 }, { stops: true });
    return s;
  }
  const copies = (s: RoomState) => [P1, P2].map((v) => stableStringify(projectState(s, v, { sceneId: "s1" }))).join("\n");

  test("a player's squeezing walk springs the same traps and leaves every player the same copy in both", () => {
    const [walled, open] = [twin(true), twin(false)];
    assert.equal(copies(walled), copies(open), "no player's copy holds the walls");
    for (const x of [9.5, 12.5]) {
      const op = intoCorridor(x);
      assert.deepEqual(summary(planTrapMove(op, walled, P1, {})), summary(planTrapMove(op, open, P1, {})), `ending at ${x}`);
      const after = [walled, open].map((s) => applied(s, op, P1).state);
      assert.equal(copies(after[0]!), copies(after[1]!), `ending at ${x}`);
    }
  });
});

// ---------------------------------------------------------------------------
// Properties (DEDGE design 12)

const W = 24;
const H = 20;

/** A piece of a route on the half-square lattice in one of eight directions, so its spots are exact and a mirror's are its mirror. */
const pieceArb = fc.record({ dir: fc.integer({ min: 0, max: 7 }), len: fc.integer({ min: 1, max: 12 }) });
const DIRS: readonly [number, number][] = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]];

/** Sides a squeeze shrinks or keeps, at least one of each footprint 2 or more, so it can squeeze, and none under 1.5, so every axis holds a whole square. */
const sideArb = fc.constantFrom(1.5, 2, 2, 2.5, 3, 3.5, 4);
const sizeArb: fc.Arbitrary<Pick<Token, "size" | "w" | "h">> = fc.oneof(
  fc.constantFrom<Pick<Token, "size" | "w" | "h">>({ size: "large" }, { size: "huge" }, { size: "gargantuan" }),
  fc.tuple(sideArb, sideArb).filter(([w, h]) => w >= 2 || h >= 2).map(([w, h]) => ({ size: "custom" as const, w, h })),
);
const trapArb = fc.record({ x: fc.integer({ min: 0, max: W - 4 }), y: fc.integer({ min: 0, max: H - 4 }), w: fc.integer({ min: 1, max: 4 }), h: fc.integer({ min: 1, max: 2 }), leave: fc.boolean() });

type WalkCase = { size: Pick<Token, "size" | "w" | "h">; startSqueezed: boolean; endSqueezed: boolean; sx: number; sy: number; pieces: { dir: number; len: number }[]; traps: { x: number; y: number; w: number; h: number; leave: boolean }[] };

/** A walk that starts or ends squeezed, each end squeezed or on whole squares, on a route of exact pieces kept inside the scene. */
const walkArb: fc.Arbitrary<WalkCase> = fc
  .record({
    size: sizeArb,
    ends: fc.constantFrom([true, true], [true, false], [false, true]),
    sx: fc.integer({ min: 4, max: 2 * (W - 8) }),
    sy: fc.integer({ min: 4, max: 2 * (H - 8) }),
    pieces: fc.array(pieceArb, { minLength: 1, maxLength: 3 }),
    traps: fc.array(trapArb, { minLength: 3, maxLength: 8 }),
  })
  .map(({ size, ends, sx, sy, pieces, traps }) => ({ size, startSqueezed: ends[0]!, endSqueezed: ends[1]!, sx: sx / 2, sy: sy / 2, pieces, traps }));

/** The route's corners, clamped to the scene, the last moved onto whole squares where the walk ends full size. */
function routeOf(c: WalkCase): [number, number][] {
  const { w, h } = footprintSize({ ...c.size, x: 0, y: 0 });
  const pts: [number, number][] = [];
  let x = c.sx;
  let y = c.sy;
  for (const p of c.pieces) {
    const [dx, dy] = DIRS[p.dir]!;
    const len = p.len / 2;
    x = Math.min(Math.max(x + dx * len, 1), W - w - 1);
    y = Math.min(Math.max(y + dy * len, 1), H - h - 1);
    pts.push([x, y]);
  }
  return pts;
}

/** Whether a full-size end stands on whole squares: whole sides at a whole position. */
const onWhole = (size: { w: number; h: number }, x: number, y: number) => [size.w, size.h, x, y].every(Number.isInteger);

/**
 * The room and op of a case, mirrored left to right, top to bottom, or not
 * at all. For a mirror (`strict`), null where a full-size end is off whole
 * squares or a piece the scene's edge clamped is off its eight directions.
 */
function caseRoom(c: WalkCase, mirror: "none" | "x" | "y", strict = true): { state: RoomState; op: Op } | null {
  const fs = footprintSize({ ...c.size, x: 0, y: 0 });
  const pts = routeOf(c);
  const [ex, ey] = pts[pts.length - 1]!;
  if (strict && ((!c.startSqueezed && !onWhole(fs, c.sx, c.sy)) || (!c.endSqueezed && !onWhole(fs, ex, ey)))) return null;
  let [px, py] = [c.sx, c.sy];
  for (const [x, y] of pts) {
    const dx = Math.abs(x - px);
    const dy = Math.abs(y - py);
    if (strict && dx !== 0 && dy !== 0 && dx !== dy) return null;
    [px, py] = [x, y];
  }
  const mx = (x: number, side: number) => (mirror === "x" ? W - x - side : x);
  const my = (y: number, side: number) => (mirror === "y" ? H - y - side : y);
  const state = room({ scenes: { s1: scene("s1", { bounds: { w: W, h: H }, autoWalls: "off" }) } });
  state.buildChunks = {};
  const bear = token("bear", { ...c.size, x: mx(c.sx, fs.w), y: my(c.sy, fs.h), name: "Bear", kind: "npc" });
  state.tokens.bear = c.startSqueezed ? { ...bear, squeeze: true } : bear;
  c.traps.forEach((t, i) => {
    state.traps[`t${i}`] = plate(`t${i}`, { x: mx(t.x, t.w), y: my(t.y, t.h), w: t.w, h: t.h }, { on: t.leave ? ["leave"] : ["enter"] });
  });
  const route: [number, number, number, 0 | 1][] = pts.map(([x, y]) => [mx(x, fs.w), my(y, fs.h), 0, 0]);
  const end = route[route.length - 1]!;
  const op: Op = { t: "token.move", tokenId: "bear", x: end[0], y: end[1], ...(c.endSqueezed ? { squeeze: true } : {}), route };
  return { state, op };
}

const sprung = (p: MovePlan) => p.springings.map((s) => `${s.trap.id}:${s.how}`).sort();

describe("whole-squares walks (property)", () => {
  test("P1: a room and its mirror, left to right and top to bottom, spring the same traps for a walk that starts or ends squeezed", () => {
    holds(
      fc.property(walkArb, (c) => {
        const plain = caseRoom(c, "none");
        fc.pre(plain !== null);
        const live = sprung(planTrapMove(plain!.op, plain!.state, DM, {}));
        for (const m of ["x", "y"] as const) {
          const mirrored = caseRoom(c, m)!;
          assert.deepEqual(sprung(planTrapMove(mirrored.op, mirrored.state, DM, {})), live, `mirrored on ${m}`);
        }
      }),
      200,
    );
  });

  test("P2: such a walk springs no trap wholly outside the squares its squeezed space covers along its route and at its two ends", () => {
    holds(
      fc.property(walkArb, (c) => {
        // Ends anywhere on the half-square lattice and pieces of any slope here: the bound holds wherever they stand.
        const { state, op } = caseRoom(c, "none", false)!;
        const bear = state.tokens.bear!;
        const walk = trapWalks(op, state, DM, {}).find((w) => w.tokenId === "bear")!;
        const covered: CellRange[] = [occupiedRange(SQ, bear)];
        for (const spot of walk.spots.slice(1, -1)) covered.push(occupiedRange(SQ, { ...bear, x: spot.x, y: spot.y, squeeze: true }));
        const last = walk.spots[walk.spots.length - 1]!;
        const { squeeze: _s, ...full } = bear;
        covered.push(occupiedRange(SQ, op.t === "token.move" && op.squeeze ? { ...full, x: last.x, y: last.y, squeeze: true } : { ...full, x: last.x, y: last.y }));
        const meets = (t: CellRect) => covered.some((r) => r.x0 < t.x + t.w && t.x < r.x1 && r.y0 < t.y + t.h && t.y < r.y1);
        for (const s of planTrapMove(op, state, DM, {}).springings) {
          const cells = (s.trap.zone as { cells: CellRect[] }).cells[0]!;
          assert.ok(meets(cells), `${s.trap.id} at ${JSON.stringify(cells)} lies outside every square the walk's squeezed space covers`);
        }
      }),
      200,
    );
  });

  test("P3: a walk that neither starts nor ends squeezed plans the same springings, stops and hits as with whole squares off", () => {
    assert.equal(squeezeWalksWhole(STORED), false, "change format 69 is the rule off");
    holds(
      fc.property(fc.integer({ min: 1, max: 1_000_000 }), (seed) => {
        const c = corpusCase(seed);
        const { squeeze: _s, ...bear } = c.state.tokens.bear!;
        c.state.tokens.bear = bear;
        const op = c.op.t === "token.move" ? (({ squeeze: _q, ...rest }) => rest)(c.op) : c.op;
        assert.equal(planLine(planTrapMove(op, c.state, c.who, {})), planLine(planTrapMove(op, c.state, c.who, { opVersion: STORED })));
      }),
      200,
    );
  });
});
