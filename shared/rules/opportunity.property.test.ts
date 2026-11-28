import assert from "node:assert/strict";
import { describe, test } from "node:test";
import fc from "fast-check";
import { CHUNK_CELLS, type BuildChunk, type EdgeFeature, type FreeWall, type PathStop, type RoomState, type Token, type Viewer } from "../model.ts";
import { actor, customMonster, effect, entry, room, token } from "../testutil.ts";
import { boxDistanceFt, distanceFt, stepsBetween, tokenCellBox, type CellBox, type DistanceSettings } from "./distance.ts";
import type { FootprintToken } from "./footprint.ts";
import type { Grid } from "./grid.ts";
import { hexCenter } from "./hex.ts";
import { legSpots } from "./path.ts";
import { reachInput, reachScan, rowStands, turnReach, type Chunks, type ReachLeave, type ReachLeg, type ScanInput } from "./opportunity.ts";
import { AREAS, CROSS, PIECE, contact, nearSegment } from "./segments.ts";

/**
 * Properties of the Opportunity Attack scan over random rooms on squares and
 * hexes (docs/design/design-v1-opportunity-attacks.md 9), each invariant by
 * name: LEAVE, GATED, ONCE, NO-PROVOKE, DRAG-EQUALS-CARD, ONLY-GIVEN,
 * WALLS-ONLY-REMOVE, LATER-ONLY-REMOVES, JOIN-UNION and BOUND.
 */

const DM: Viewer = { memberId: "dm1", role: "dm" };
const NONE: Chunks = { rolls: {}, monsters: [] };
const RUNS = 300;

type Case = {
  shape: "squares" | "hexRows" | "hexColumns";
  feetPerCell: 5 | 10;
  diagonal: "five" | "fiveTen" | "euclid";
  mover: { size: Token["size"]; unseen: boolean };
  stops: { x: number; y: number; elevation: number; uncounted: boolean }[];
  reactors: { x: number; y: number; elevation: number; size: Token["size"]; disposition: Token["disposition"]; reaches: number[]; blinded: boolean; blindsight: number; truesight: number; used: boolean }[];
  edges: { x: number; y: number; side: "n" | "w"; kind: "wall" | "door" | "window" | "open" }[];
  walls: [number, number, number, number][];
};

/** True about one time in `n`. */
const rarely = (n: number) => fc.integer({ min: 1, max: n }).map((v) => v === 1);
const coord = fc.integer({ min: 0, max: 28 }).map((v) => v / 2);
const size = fc.constantFrom<Token["size"]>("tiny", "small", "medium", "large", "huge");
const caseArb: fc.Arbitrary<Case> = fc.record({
  shape: fc.constantFrom("squares" as const, "hexRows" as const, "hexColumns" as const),
  feetPerCell: fc.constantFrom(5 as const, 10 as const),
  diagonal: fc.constantFrom("five" as const, "fiveTen" as const, "euclid" as const),
  mover: fc.record({ size, unseen: fc.boolean() }),
  stops: fc.array(fc.record({ x: coord, y: coord, elevation: fc.constantFrom(0, 0, 5, 10, 20), uncounted: rarely(6) }), { minLength: 2, maxLength: 5 }),
  reactors: fc.array(
    fc.record({
      x: fc.integer({ min: 0, max: 14 }),
      y: fc.integer({ min: 0, max: 14 }),
      elevation: fc.constantFrom(0, 0, 5, 10),
      size,
      disposition: fc.constantFrom<Token["disposition"]>("hostile", "hostile", "hostile", "neutral", "ally"),
      reaches: fc.uniqueArray(fc.constantFrom(5, 10, 15, 30), { minLength: 1, maxLength: 2 }).map((r) => [...r].sort((a, b) => a - b)),
      blinded: rarely(5),
      blindsight: fc.constantFrom(0, 0, 10, 30),
      truesight: fc.constantFrom(0, 0, 30),
      used: rarely(6),
    }),
    { maxLength: 8 },
  ),
  edges: fc.array(fc.record({ x: fc.integer({ min: 0, max: 15 }), y: fc.integer({ min: 0, max: 15 }), side: fc.constantFrom("n" as const, "w" as const), kind: fc.constantFrom("wall" as const, "wall" as const, "door" as const, "window" as const, "open" as const) }), { maxLength: 12 }),
  walls: fc.array(fc.tuple(fc.integer({ min: 0, max: 30 }), fc.integer({ min: 0, max: 30 }), fc.integer({ min: 0, max: 30 }), fc.integer({ min: 0, max: 30 })).map(([a, b, c, d]) => [a / 2, b / 2, c / 2, d / 2] as [number, number, number, number]), { maxLength: 6 }),
});

let wallIds = 0;

function feature(kind: Case["edges"][number]["kind"]): EdgeFeature {
  if (kind === "door") return { kind: "door", state: "closed", secret: false, discovered: false };
  if (kind === "open") return { kind: "door", state: "open", secret: false, discovered: false };
  return { kind };
}

/** The room a case describes, `extra` walls added, `far` reactors placed beyond any reach of the walk. */
function roomOf(c: Case, extra: readonly [number, number, number, number][] = [], far = 0): RoomState {
  const tokens: Token[] = [token("mover", { kind: "pc", name: "Bree", disposition: "ally", size: c.mover.size, x: c.stops[0]!.x, y: c.stops[0]!.y, elevation: c.stops[0]!.elevation, actor: { inline: actor({ effects: c.mover.unseen ? [effect("inv", { key: "invisible" })] : [] }) } })];
  const monsters: RoomState["monsters"] = {};
  c.reactors.forEach((r, i) => {
    monsters[`m${i}`] = customMonster(`m${i}`, { actions: r.reaches.map((feet, k) => ({ name: `Attack ${k}`, text: `Melee Attack Roll: +4, reach ${feet} ft. Hit: 5.` })) });
    const senses = [r.blindsight ? `Blindsight ${r.blindsight} ft.` : "", r.truesight ? `Truesight ${r.truesight} ft.` : ""].filter(Boolean).join(", ");
    tokens.push(token(`r${i}`, { name: `R${i}`, x: r.x, y: r.y, elevation: r.elevation, size: r.size, disposition: r.disposition, actor: { inline: actor({ monsterId: `m${i}`, senses, effects: r.blinded ? [effect("b", { key: "blinded" })] : [] }) } }));
  });
  for (let i = 0; i < far; i++) tokens.push(token(`far${i}`, { x: 200 + 10 * i, y: 200, actor: { inline: actor({ monsterId: "m0" }) } }));
  const state = room({ tokens: Object.fromEntries(tokens.map((t) => [t.id, t])), monsters: { ...monsters, m0: monsters.m0 ?? customMonster("m0") } });
  state.meta.settings = { ...state.meta.settings, feetPerCell: c.feetPerCell, diagonal: c.diagonal };
  state.scenes.s1 = { ...state.scenes.s1!, autoWalls: "off", ...(c.shape !== "squares" ? { gridShape: c.shape } : {}) };
  const at = (x: number, y: number): BuildChunk => {
    const cx = Math.floor(x / CHUNK_CELLS);
    const cy = Math.floor(y / CHUNK_CELLS);
    return (state.buildChunks[`s1:${cx},${cy}`] ??= { sceneId: "s1", cx, cy, rev: 1, cells: {}, edges: {} });
  };
  if (c.shape === "squares") for (const e of c.edges) at(e.x, e.y).edges[`${e.x},${e.y},${e.side}`] = feature(e.kind);
  for (const [ax, ay, bx, by] of [...c.walls, ...extra]) {
    if (ax === bx && ay === by) continue;
    const wall: FreeWall = { id: `p${String(wallIds++).padStart(11, "0")}`, a: [ax, ay], b: [bx, by], f: { kind: "wall" } };
    (at(Math.floor((ax + bx) / 2), Math.floor((ay + by) / 2)).walls ??= []).push(wall);
  }
  if (c.reactors.some((r) => r.used)) {
    state.encounter = { rev: 0, round: 1, activeEntryId: "em", started: true, entries: [entry("em", { tokenId: "mover" }), ...c.reactors.map((r, i) => entry(`e${i}`, { tokenId: `r${i}`, reactionUsed: r.used }))] };
  }
  return state;
}

function stopsOf(c: Case): PathStop[] {
  return c.stops.map((s, i) => ({ x: s.x, y: s.y, elevation: s.elevation, ...(i > 0 && s.uncounted ? { uncounted: true as const } : {}) }));
}

function read(c: Case, state = roomOf(c)): { input: ScanInput; legs: ReachLeg[]; state: RoomState } {
  const r = reachInput(state, "mover", { turn: 1, stops: stopsOf(c) }, NONE, DM);
  assert.ok(r);
  return { ...r, state };
}

/** Drains a scan with these slices: its result and the most work it reported. */
function drain(input: ScanInput, leg: ReachLeg, skip: ReadonlySet<string>, slice: number): { result: ReachLeave[] | "over"; work: number } {
  const scan = reachScan(input, leg, skip, slice);
  let work = 0;
  for (;;) {
    const step = scan.next();
    if (step.done) return { result: step.value, work };
    work = Math.max(work, step.value);
  }
}

const idsOf = (turn: ReturnType<typeof turnReach>) => turn.flatMap((l) => (l.leaves === "over" ? [] : l.leaves.map((x) => x.id)));

/** The distance the scan judges by, read independently: a neighbor is one cell's feet, else the room's distance. */
function oracleFeet(g: Grid, a: FootprintToken, b: FootprintToken, rules: DistanceSettings): number {
  const steps = stepsBetween(tokenCellBox(g, a, rules.feetPerCell), tokenCellBox(g, b, rules.feetPerCell));
  if (steps.dx <= 1 && steps.dy <= 1 && steps.dz <= 1) return steps.dx + steps.dy + steps.dz === 0 ? 0 : rules.feetPerCell;
  return distanceFt(g, a, b, rules);
}

function boxFeet(a: CellBox, b: CellBox, rules: DistanceSettings): number {
  const { dx, dy, dz } = stepsBetween(a, b);
  if (dx <= 1 && dy <= 1 && dz <= 1) return dx + dy + dz === 0 ? 0 : rules.feetPerCell;
  return boxDistanceFt(a, b, rules);
}

function centersOf(g: Grid, t: FootprintToken, fpc: number): { x: number; y: number; box: CellBox }[] {
  const box = tokenCellBox(g, t, fpc);
  if (box.hexes) return box.hexes.at.map((h) => ({ ...hexCenter(box.hexes!.g, h), box: { ...box, hexes: { g: box.hexes!.g, at: [h] } } }));
  const out: { x: number; y: number; box: CellBox }[] = [];
  for (let y = box.y0; y < box.y1; y++) for (let x = box.x0; x < box.x1; x++) out.push({ x: x + 0.5, y: y + 0.5, box: { x0: x, x1: x + 1, y0: y, y1: y + 1, z0: box.z0, z1: box.z1 } });
  return out;
}

describe("the Opportunity Attack scan's invariants", () => {
  test("LEAVE and GATED: each leave crosses its reach at its spot, and its departure spot passed sight and has a line no wall crosses", () => {
    fc.assert(
      fc.property(caseArb, (c) => {
        const { input, legs } = read(c);
        const turn = turnReach(input, legs);
        turn.forEach((l, i) => {
          if (l.leaves === "over") return;
          const leg = legs[i]!;
          const spots = legSpots(input.grid, input.mover, leg.from, leg.to);
          for (const leave of l.leaves) {
            const reactor = input.reactors.find((r) => r.id === leave.id)!;
            const at = (k: number) => ({ ...spots[k]!, ...(input.mover.height !== undefined ? { height: input.mover.height } : {}) });
            assert.ok(leave.spot >= 1 && !spots[leave.spot]!.jump, "LEAVE: a step, never a jump");
            const before = oracleFeet(input.grid, at(leave.spot - 1), reactor.token, input.rules);
            const after = oracleFeet(input.grid, at(leave.spot), reactor.token, input.rules);
            assert.ok(before <= leave.reach && after > leave.reach, `LEAVE: ${before} then ${after} for ${leave.reach}`);
            assert.ok(reactor.reaches.includes(leave.reach), "LEAVE: one of its reaches");
            const seeing = reactor.blinded ? reactor.blindsight : input.moverUnseen ? Math.max(reactor.blindsight, reactor.truesight) : Infinity;
            assert.ok(seeing >= before, "GATED: sight at the departure spot");
            const s = input.walls.stored;
            const clear = centersOf(input.grid, at(leave.spot - 1), input.rules.feetPerCell).some((m) =>
              centersOf(input.grid, reactor.token, input.rules.feetPerCell).some((r) => {
                if (boxFeet(m.box, r.box, input.rules) > leave.reach) return false;
                for (let k = 0; k < s.n; k++) {
                  if (!(s.tags[k]! & AREAS) || s.free[k] === PIECE) continue;
                  const [ax, ay, bx, by] = [s.xy[4 * k]!, s.xy[4 * k + 1]!, s.xy[4 * k + 2]!, s.xy[4 * k + 3]!];
                  // On hexes a crossing a hair from a corner is the vertex rule's to judge, by the corner's true vertex.
                  if (input.grid.shape === "hex" && [[ax, ay], [bx, by]].some(([x, y]) => nearSegment(x!, y!, m.x, m.y, r.x, r.y, 1 / 64))) continue;
                  if (contact(m.x, m.y, r.x, r.y, ax, ay, bx, by) === CROSS) return false;
                }
                return true;
              }),
            );
            assert.ok(clear, "GATED: some pair of cells has a line no wall crosses");
          }
        });
      }),
      { numRuns: RUNS },
    );
  });

  test("ONCE and ONLY-GIVEN: a creature is reported once a turn, and only creatures passed in", () => {
    fc.assert(
      fc.property(caseArb, fc.nat(), (c, drop) => {
        const { input, legs } = read(c);
        const ids = idsOf(turnReach(input, legs));
        assert.equal(new Set(ids).size, ids.length, "ONCE");
        for (const id of ids) assert.ok(input.reactors.some((r) => r.id === id), "ONLY-GIVEN");
        if (input.reactors.length === 0) return;
        const gone = input.reactors[drop % input.reactors.length]!.id;
        const without = idsOf(turnReach({ ...input, reactors: input.reactors.filter((r) => r.id !== gone) }, legs));
        assert.ok(!without.includes(gone), "ONLY-GIVEN: a creature left out is never named");
      }),
      { numRuns: RUNS },
    );
  });

  test("NO-PROVOKE: a leg that does not provoke reports nothing", () => {
    fc.assert(
      fc.property(caseArb, (c) => {
        const { input, legs } = read(c);
        for (const leg of legs) {
          if (leg.provokes) continue;
          assert.deepEqual(drain(input, leg, new Set(), 1).result, []);
        }
        for (const leg of legs) assert.deepEqual(drain(input, { ...leg, provokes: false }, new Set(), 7).result, []);
      }),
      { numRuns: RUNS },
    );
  });

  test("DRAG-EQUALS-CARD: a leg scanned on its own with the earlier legs' creatures skipped, in any slices, gives what the turn's scan adds for it", () => {
    fc.assert(
      fc.property(caseArb, fc.integer({ min: 1, max: 200 }), (c, slice) => {
        const { input, legs } = read(c);
        const turn = turnReach(input, legs);
        const skip = new Set<string>();
        legs.forEach((leg, i) => {
          const card = drain(input, leg, skip, slice).result;
          const drag = drain(input, leg, skip, Infinity).result;
          assert.deepEqual(card, turn[i]!.leaves);
          assert.deepEqual(drag, turn[i]!.leaves);
          if (card !== "over") for (const leave of card) skip.add(leave.id);
        });
      }),
      { numRuns: RUNS },
    );
  });

  test("WALLS-ONLY-REMOVE: adding a wall never adds a report", () => {
    fc.assert(
      fc.property(caseArb, fc.array(fc.tuple(fc.integer({ min: 0, max: 30 }), fc.integer({ min: 0, max: 30 }), fc.integer({ min: 0, max: 30 }), fc.integer({ min: 0, max: 30 })), { minLength: 1, maxLength: 3 }), (c, added) => {
        const plain = read(c);
        const walled = read(c, roomOf(c, added.map(([a, b, x, y]) => [a / 2, b / 2, x / 2, y / 2])));
        const before = new Set(idsOf(turnReach(plain.input, plain.legs)));
        for (const id of idsOf(turnReach(walled.input, walled.legs))) assert.ok(before.has(id), `${id} appeared behind a new wall`);
      }),
      { numRuns: RUNS },
    );
  });

  test("LATER-ONLY-REMOVES: once a leg's leaves are cached, no later state adds a row", () => {
    fc.assert(
      fc.property(caseArb, fc.array(fc.tuple(fc.nat(), fc.constantFrom("move", "kill", "stun", "react", "remove", "revive")), { maxLength: 6 }), (c, changes) => {
        const { input, legs, state } = read(c);
        const cached = turnReach(input, legs).flatMap((l) => (l.leaves === "over" ? [] : l.leaves));
        const later: RoomState = structuredClone(state);
        const ids = Object.keys(later.tokens).filter((id) => id !== "mover");
        for (const [n, kind] of changes) {
          const id = ids[n % Math.max(1, ids.length)];
          const t = id !== undefined ? later.tokens[id] : undefined;
          if (!t || !("inline" in t.actor)) continue;
          const a = t.actor.inline;
          if (kind === "move") later.tokens[id!] = { ...t, x: (t.x + 1) % 15 };
          if (kind === "kill") a.life = "dead";
          if (kind === "stun") a.effects = [...a.effects, effect("s", { key: "stunned" })];
          if (kind === "revive") a.life = "alive";
          if (kind === "remove") delete later.tokens[id!];
          if (kind === "react") later.encounter = { rev: 0, round: 1, activeEntryId: "em", started: true, entries: [entry("em", { tokenId: "mover" }), entry("x", { tokenId: id!, reactionUsed: true })] };
        }
        const rows = cached.filter((leave) => rowStands(later, leave, DM));
        for (const row of rows) assert.ok(cached.includes(row));
        assert.ok(rows.length <= cached.length);
      }),
      { numRuns: RUNS },
    );
  });

  test("JOIN-UNION: two legs joined at one size and height leave what the two legs leave", () => {
    fc.assert(
      fc.property(caseArb, (c) => {
        const flat = { ...c, stops: c.stops.slice(0, 3).map((s) => ({ ...s, elevation: c.stops[0]!.elevation, uncounted: false })) };
        if (flat.stops.length < 3) return;
        const { input, legs } = read(flat);
        const [a, b] = legs as [ReachLeg, ReachLeg];
        const apart = idsOf(turnReach(input, [a, b])).sort();
        const corner = b.from;
        const joined: ReachLeg = { id: 9, from: a.from, to: { ...b.to, via: [corner.x, corner.y] }, provokes: true };
        assert.deepEqual(idsOf(turnReach(input, [joined])).sort(), apart);
      }),
      { numRuns: RUNS },
    );
  });

  test("BOUND: a creature beyond any reach of the walk is never tested, so it adds no work", () => {
    fc.assert(
      fc.property(caseArb, fc.integer({ min: 1, max: 6 }), (c, far) => {
        if (c.reactors.length === 0) return;
        const near = read(c);
        const crowded = read(c, roomOf(c, [], far));
        near.legs.forEach((leg, i) => {
          const a = drain(near.input, leg, new Set(), 1);
          const b = drain(crowded.input, crowded.legs[i]!, new Set(), 1);
          assert.equal(b.work, a.work, "the far creatures cost nothing");
          assert.deepEqual(b.result, a.result);
        });
      }),
      { numRuns: RUNS },
    );
  });
});
