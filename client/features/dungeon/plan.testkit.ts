import type { TerrainId } from "#shared/model.ts";
import type { Side } from "./layout.ts";
import type { DungeonPlan, Planned } from "./plan.ts";
import type { DungeonSettings } from "./settings.ts";

/*
 * The invariants every plan keeps (docs/design/design-v1-dungeon-generator.md
 * section 13), read from the plan alone, as the landing lane will see it.
 * The design's numbers are written out here rather than imported, so a
 * changed constant in the generator fails a test instead of moving it.
 * The square rules mirror shared/rules/walls.ts: a stair links only the two
 * edges along the way it faces, and every other edge between two grounds is
 * a ledge.
 */

const MARGIN = 2;
const GAPS = { narrow: { sparse: 6, normal: 4, dense: 3 }, wide: { sparse: 7, normal: 5, dense: 4 } } as const;
const DAIS_RISE = 5;
const MAX_DOOR_EDGES = 200;
const MAX_TRAPS = 20;
const TRAP_SPACING = 6;
const PITS = new Set(["hidden-pit", "spiked-pit"]);
const FALLING_NET = "falling-net";
const POISONED_NEEDLE = "poisoned-needle";

const FLOORS: ReadonlySet<TerrainId> = new Set(["stone", "wood"]);
const BLOCKS_WALK: ReadonlySet<TerrainId> = new Set(["pillar", "pit"]);

/** A plan read back into grids. */
export class PlanGrid {
  readonly W: number;
  readonly H: number;
  readonly terrain: (TerrainId | undefined)[];
  readonly ground: Int16Array;
  readonly up: (Side | undefined)[];
  readonly room: Int16Array;
  readonly doors = new Map<string, DungeonPlan["doors"][number]["state"]>();
  readonly plan: DungeonPlan;

  constructor(plan: DungeonPlan) {
    this.plan = plan;
    const { w: W, h: H } = plan;
    this.W = W;
    this.H = H;
    this.terrain = new Array(W * H).fill(undefined);
    this.ground = new Int16Array(W * H);
    this.up = new Array(W * H).fill(undefined);
    this.room = new Int16Array(W * H).fill(-1);
    for (const [t, cells] of Object.entries(plan.paint)) for (const c of cells) this.terrain[this.k(c)] = t as TerrainId;
    for (const { ft, cells } of plan.heights) for (const c of cells) this.ground[this.k(c)] = ft;
    for (const { up, cells } of plan.stairs) for (const c of cells) this.up[this.k(c)] = up as Side;
    plan.rooms.forEach((r, i) => {
      for (let y = r.y; y < r.y + r.h; y++) for (let x = r.x; x < r.x + r.w; x++) this.room[y * W + x] = i;
    });
    for (const d of plan.doors) this.doors.set(d.edge, d.state);
  }

  k(cell: string): number {
    const [x, y] = cell.split(",").map(Number) as [number, number];
    return y * this.W + x;
  }

  painted(k: number): boolean {
    return this.terrain[k] !== undefined;
  }

  /** The 4 neighbors in the map, with the edge between. */
  neighbors(k: number): { n: number; edge: string; vertical: boolean }[] {
    const x = k % this.W;
    const y = (k - x) / this.W;
    const out: { n: number; edge: string; vertical: boolean }[] = [];
    if (y > 0) out.push({ n: k - this.W, edge: `${x},${y},n`, vertical: true });
    if (y < this.H - 1) out.push({ n: k + this.W, edge: `${x},${y + 1},n`, vertical: true });
    if (x > 0) out.push({ n: k - 1, edge: `${x},${y},w`, vertical: false });
    if (x < this.W - 1) out.push({ n: k + 1, edge: `${x + 1},${y},w`, vertical: false });
    return out;
  }

  /** Whether a stair links the edge: one on either side facing along the edge's crossing. */
  linked(a: number, b: number, vertical: boolean): boolean {
    const along = (s: Side | undefined) => s !== undefined && (vertical ? s === "n" || s === "s" : s === "e" || s === "w");
    return along(this.up[a]) || along(this.up[b]);
  }

  ledge(a: number, b: number, vertical: boolean): boolean {
    return this.ground[a] !== this.ground[b] && !this.linked(a, b, vertical);
  }
}

/** Every square reachable walking from `from`, through every door opened, over no ledge, pillar or pit. */
export function walk(g: PlanGrid, from: readonly number[]): Set<number> {
  const seen = new Set<number>();
  const queue = from.filter((k) => g.painted(k) && !BLOCKS_WALK.has(g.terrain[k]!));
  for (const k of queue) seen.add(k);
  while (queue.length > 0) {
    const k = queue.pop()!;
    for (const { n, vertical } of g.neighbors(k)) {
      if (seen.has(n) || !g.painted(n) || BLOCKS_WALK.has(g.terrain[n]!) || g.ledge(k, n, vertical)) continue;
      seen.add(n);
      queue.push(n);
    }
  }
  return seen;
}

/** Every 2 by 2 block a Large creature reaches from the blocks at `from`, squares clear and no ledge inside or crossed. */
export function walkLarge(g: PlanGrid, from: readonly number[]): Set<number> {
  const W = g.W;
  const clear = (k: number) => g.painted(k) && !BLOCKS_WALK.has(g.terrain[k]!);
  const block = (k: number) => {
    const x = k % W;
    const y = (k - x) / W;
    if (x >= W - 1 || y >= g.H - 1) return false;
    const c = [k, k + 1, k + W, k + W + 1];
    if (!c.every(clear)) return false;
    return !g.ledge(k, k + 1, false) && !g.ledge(k + W, k + W + 1, false) && !g.ledge(k, k + W, true) && !g.ledge(k + 1, k + W + 1, true);
  };
  const seen = new Set<number>();
  const queue = from.filter(block);
  for (const k of queue) seen.add(k);
  while (queue.length > 0) {
    const k = queue.pop()!;
    const x = k % W;
    for (const [n, a, b, vertical] of [
      [k - W, [k, k + 1], [k - W, k - W + 1], true],
      [k + W, [k + W, k + W + 1], [k + 2 * W, k + 2 * W + 1], true],
      [k - 1, [k, k + W], [k - 1, k + W - 1], false],
      [k + 1, [k + 1, k + W + 1], [k + 2, k + W + 2], false],
    ] as [number, number[], number[], boolean][]) {
      if (n < 0 || seen.has(n) || (n === k - 1 && x === 0) || (n === k + 1 && x >= W - 2)) continue;
      if (!block(n)) continue;
      if (g.ledge(a[0]!, b[0]!, vertical) || g.ledge(a[1]!, b[1]!, vertical)) continue;
      seen.add(n);
      queue.push(n);
    }
  }
  return seen;
}

/** Reveal room's flood (shared/rules/walls.ts floodRoom): painted squares up to walls and closed or locked doors. */
export function flood(g: PlanGrid, from: number): Set<number> {
  const seen = new Set([from]);
  const queue = [from];
  while (queue.length > 0) {
    const k = queue.pop()!;
    for (const { n, edge } of g.neighbors(k)) {
      if (seen.has(n) || !g.painted(n) || g.doors.has(edge)) continue;
      seen.add(n);
      queue.push(n);
    }
  }
  return seen;
}

/** Every problem with a plan, as sentences, or none. */
export function planProblems(planned: Planned, s: DungeonSettings): string[] {
  const { plan } = planned;
  const g = new PlanGrid(plan);
  const W = g.W;
  const out: string[] = [];
  const at = (k: number) => `${k % W},${Math.floor(k / W)}`;
  const say = (m: string) => {
    if (out.length < 20) out.push(m);
  };

  // Cells: in bounds, each painted once.
  const seen = new Set<string>();
  for (const cells of Object.values(plan.paint)) {
    for (const c of cells) {
      const [x, y] = c.split(",").map(Number) as [number, number];
      if (!(x >= 0 && y >= 0 && x < plan.w && y < plan.h)) say(`painted ${c} out of bounds`);
      if (seen.has(c)) say(`${c} painted twice`);
      seen.add(c);
    }
  }
  if (plan.rooms.length > plan.asked) say("more rooms than asked");
  if (plan.doors.length > MAX_DOOR_EDGES) say(`${plan.doors.length} door edges`);

  // Rooms: inside the margin, the gap kept, all painted, at their ground.
  const gap = GAPS[s.wide ? "wide" : "narrow"][s.density];
  plan.rooms.forEach((r, i) => {
    if (r.x < MARGIN || r.y < MARGIN || r.x + r.w > plan.w - MARGIN || r.y + r.h > plan.h - MARGIN) say(`room ${i} in the margin`);
    plan.rooms.forEach((o, j) => {
      if (j <= i) return;
      const xg = Math.max(o.x - (r.x + r.w), r.x - (o.x + o.w));
      const yg = Math.max(o.y - (r.y + r.h), r.y - (o.y + o.h));
      if (Math.max(xg, yg) < gap) say(`rooms ${i} and ${j} ${Math.max(xg, yg)} apart`);
    });
    if (r.entrance && r.ground !== 0) say("the entrance is raised");
    for (let y = r.y; y < r.y + r.h; y++) {
      for (let x = r.x; x < r.x + r.w; x++) {
        const k = y * W + x;
        if (!g.painted(k)) say(`room ${i} square ${x},${y} unpainted`);
        const ft = g.ground[k]!;
        if (ft !== r.ground && ft !== r.ground + DAIS_RISE) say(`room ${i} square ${x},${y} at ${ft} ft, room at ${r.ground}`);
      }
    }
  });
  if (plan.rooms.filter((r) => r.entrance).length !== (plan.rooms.length > 0 ? 1 : 0)) say("not one entrance");
  // Only the entrance stub crosses the margin.
  const stub = new Set(planned.stubPath ?? []);
  for (let k = 0; k < W * g.H; k++) {
    const x = k % W;
    const y = (k - x) / W;
    if (g.painted(k) && (x < MARGIN || y < MARGIN || x >= W - MARGIN || y >= g.H - MARGIN) && !stub.has(k)) say(`${at(k)} in the margin`);
  }
  // A dais keeps a square in from the walls.
  plan.rooms.forEach((r, i) => {
    for (let y = r.y; y < r.y + r.h; y++) {
      for (let x = r.x; x < r.x + r.w; x++) {
        const ring = x === r.x || y === r.y || x === r.x + r.w - 1 || y === r.y + r.h - 1;
        if (ring && g.ground[y * W + x] !== r.ground) say(`room ${i}'s dais touches its wall at ${x},${y}`);
      }
    }
  });

  // Doors: between a room's side square and a painted square outside it, never at a corner.
  for (const { edge } of plan.doors) {
    const [xs, ys, side] = edge.split(",");
    const x = Number(xs);
    const y = Number(ys);
    const [a, b] = side === "n" ? [(y - 1) * W + x, y * W + x] : [y * W + x - 1, y * W + x];
    const ra = y >= (side === "n" ? 1 : 0) ? g.room[a]! : -1;
    const rb = g.room[b]!;
    if ((ra >= 0) === (rb >= 0)) {
      say(`door ${edge} not on a room's side`);
      continue;
    }
    const outside = ra >= 0 ? b : a;
    const r = plan.rooms[ra >= 0 ? ra : rb]!;
    if (!g.painted(outside)) say(`door ${edge} opens onto rock`);
    const along = side === "n" ? x - r.x : y - r.y;
    const length = side === "n" ? r.w : r.h;
    if (along < 1 || along > length - 2) say(`door ${edge} at a corner`);
  }

  // No painted square touches a room but across a door, so every wall is automatic and Reveal room stops at the doors.
  for (let k = 0; k < W * g.H; k++) {
    if (!g.painted(k) || g.room[k]! >= 0) continue;
    for (const { n, edge } of g.neighbors(k)) if (g.room[n]! >= 0 && !g.doors.has(edge)) say(`${at(k)} touches room ${g.room[n]} without a door`);
  }

  // Ledges: none between two squares outside the rooms, none across a door, inside a room only round a dais.
  for (let k = 0; k < W * g.H; k++) {
    if (!g.painted(k)) continue;
    for (const { n, edge, vertical } of g.neighbors(k)) {
      if (n < k || !g.painted(n) || !g.ledge(k, n, vertical)) continue;
      const inRoom = g.room[k]! >= 0 && g.room[n]! >= 0;
      if (!inRoom) say(`ledge on ${edge}${g.doors.has(edge) ? " (a door)" : ""}`);
    }
  }

  // Stairs: on painted squares, and every one outside a room linked both ways along its axis.
  for (const { up, cells } of plan.stairs) {
    for (const c of cells) {
      const k = g.k(c);
      if (!g.painted(k)) say(`stair ${c} on rock`);
      if (g.room[k]! >= 0) continue;
      const x = k % W;
      const y = (k - x) / W;
      const [dx, dy] = up === "n" || up === "s" ? [0, 1] : [1, 0];
      for (const sign of [-1, 1]) {
        const nx = x + dx * sign;
        const ny = y + dy * sign;
        if (nx < 0 || ny < 0 || nx >= W || ny >= g.H) continue;
        if (!g.painted(ny * W + nx)) say(`stair ${c} faces rock`);
      }
      // A stair's sides are rock or the stair beside it on a Wide run, so no corridor square meets its side.
      for (const sign of [-1, 1]) {
        const nx = x + dy * sign;
        const ny = y + dx * sign;
        if (nx < 0 || ny < 0 || nx >= W || ny >= g.H) continue;
        const n = ny * W + nx;
        if (g.painted(n) && !(g.up[n] === up && g.ground[n] === g.ground[k])) say(`stair ${c} meets ${at(n)} at its side`);
      }
    }
  }

  // Walking from the way in: every room, every door opened.
  const stairsOut = (plan.stairs.flatMap((s) => s.cells.map((c) => g.k(c))) as number[]).filter((k) => {
    const x = k % W;
    const y = (k - x) / W;
    return x === 0 || y === 0 || x === W - 1 || y === g.H - 1;
  });
  const entrance = plan.rooms.findIndex((r) => r.entrance);
  if (plan.rooms.length > 0 && !planned.trace.stubFailed && stairsOut.length === 0) say("no stairs out at the edge");
  // Without a stub, the walk starts anywhere in the entrance room.
  const entranceSquares: number[] = [];
  if (entrance >= 0) {
    const r = plan.rooms[entrance]!;
    for (let y = r.y; y < r.y + r.h; y++) for (let x = r.x; x < r.x + r.w; x++) entranceSquares.push(y * W + x);
  }
  const starts = stairsOut.length > 0 ? stairsOut : entranceSquares;
  const reached = walk(g, starts);
  plan.rooms.forEach((r, i) => {
    let found = false;
    for (let y = r.y; y < r.y + r.h && !found; y++) for (let x = r.x; x < r.x + r.w; x++) if (reached.has(y * W + x)) found = true;
    if (!found) say(`room ${i} not reached`);
  });
  for (let k = 0; k < W * g.H; k++) if (g.painted(k) && !BLOCKS_WALK.has(g.terrain[k]!) && g.room[k]! < 0 && !reached.has(k)) say(`corridor ${at(k)} not reached`);
  if (s.wide && starts.length > 0) {
    const large = walkLarge(g, [...new Set(starts.flatMap((k) => [k, k - 1, k - W, k - W - 1]))].filter((k) => k >= 0));
    plan.rooms.forEach((r, i) => {
      let found = false;
      for (let y = r.y; y < r.y + r.h - 1 && !found; y++) for (let x = r.x; x < r.x + r.w - 1; x++) if (large.has(y * W + x)) found = true;
      if (!found) say(`room ${i} not reached by a Large creature`);
    });
  }

  // Reveal room: exactly the room.
  plan.rooms.forEach((r, i) => {
    const got = flood(g, (r.y + 1) * W + r.x + 1);
    if (got.size !== r.w * r.h || [...got].some((k) => g.room[k] !== i)) say(`Reveal room in room ${i} floods ${got.size} squares, not ${r.w * r.h}`);
  });

  // Nothing stands on a doorway's inside square, the lines from a room's doorways to its middle, or a dais's stair, the square before it and the square at its top.
  const width = s.wide ? 2 : 1;
  const doorsBySide = new Map<string, { k: number; side: Side }[]>();
  for (const { edge } of plan.doors) {
    const [xs, ys, axis] = edge.split(",");
    const x = Number(xs);
    const y = Number(ys);
    const above = axis === "n" ? (y - 1) * W + x : y * W + x - 1;
    const below = y * W + x;
    const inner = above >= 0 && g.room[above]! >= 0 && (axis === "n" ? y > 0 : x > 0) ? above : below;
    const side: Side = axis === "n" ? (inner === above ? "s" : "n") : inner === above ? "e" : "w";
    const group = `${g.room[inner]},${side}`;
    doorsBySide.set(group, [...(doorsBySide.get(group) ?? []), { k: inner, side }]);
  }
  const blockers = new Set<TerrainId>(["pillar", "pit", "rubble"]);
  const onLine = new Set<number>();
  for (const [group, cells] of doorsBySide) {
    const r = plan.rooms[Number(group.split(",")[0])]!;
    cells.sort((a, b) => a.k - b.k);
    for (let i = 0; i < cells.length; i += width) {
      const { k, side } = cells[i]!;
      const cx = k % W;
      const cy = (k - cx) / W;
      const mx = r.x + Math.floor((r.w - width) / 2);
      const my = r.y + Math.floor((r.h - width) / 2);
      const lane: number[] = [];
      const add = (x0: number, y0: number, x1: number, y1: number) => {
        for (let y = Math.min(y0, y1); y <= Math.max(y0, y1); y++) for (let x = Math.min(x0, x1); x <= Math.max(x0, x1); x++) lane.push(y * W + x);
      };
      if (side === "n" || side === "s") {
        add(cx, cy, cx + width - 1, side === "n" ? my + width - 1 : my);
        add(Math.min(cx, mx), my, Math.max(cx, mx) + width - 1, my + width - 1);
      } else {
        add(cx, cy, side === "w" ? mx + width - 1 : mx, cy + width - 1);
        add(mx, Math.min(cy, my), mx + width - 1, Math.max(cy, my) + width - 1);
      }
      for (const c of lane) if (blockers.has(g.terrain[c]!) || g.ground[c] !== r.ground) say(`the line from door ${at(k)} to the middle is blocked at ${at(c)}`);
      for (const c of lane) onLine.add(c);
    }
  }
  for (const { up, cells } of plan.stairs) {
    for (const c of cells) {
      const k = g.k(c);
      const i = g.room[k]!;
      if (i < 0) continue;
      const r = plan.rooms[i]!;
      const step = up === "n" ? -W : up === "s" ? W : up === "w" ? -1 : 1;
      const top = k + step;
      const before = k - step;
      if (g.ground[k] !== r.ground || g.ground[top] !== r.ground + DAIS_RISE || g.room[top] !== i) say(`dais stair ${c} does not climb onto a dais`);
      if (g.room[before] !== i || g.ground[before] !== r.ground) say(`dais stair ${c} has no floor before it`);
      for (const q of [k, top, before]) if (blockers.has(g.terrain[q]!)) say(`${at(q)} by the dais stair ${c} holds ${g.terrain[q]}`);
    }
  }

  // Traps.
  const trapMids: [number, number][] = [];
  const raisedRun = new Set<number>();
  for (let k = 0; k < W * g.H; k++) if (g.room[k]! < 0 && (g.ground[k] !== 0 || g.up[k] !== undefined)) raisedRun.add(k);
  if (plan.traps.length > MAX_TRAPS) say(`${plan.traps.length} traps`);
  if (s.traps === 0 && plan.traps.length > 0) say("traps on None");
  for (const t of plan.traps) {
    const z = t.zone;
    if ("cells" in z) {
      if (!PITS.has(t.preset)) say(`${t.preset} on squares`);
      const r = z.cells[0]!;
      const grounds = new Set<number>();
      for (let y = r.y; y < r.y + r.h; y++) {
        for (let x = r.x; x < r.x + r.w; x++) {
          const k = y * W + x;
          if (!FLOORS.has(g.terrain[k]!)) say(`trap on ${at(k)}, ${g.terrain[k] ?? "rock"}`);
          if (raisedRun.has(k) || g.up[k] !== undefined) say(`trap on a run or stair at ${at(k)}`);
          if (g.room[k]! >= 0 && plan.rooms[g.room[k]!]!.entrance) say("trap in the entrance room");
          if (g.room[k]! >= 0 && g.ground[k] !== plan.rooms[g.room[k]!]!.ground) say(`trap on a dais at ${at(k)}`);
          if (g.room[k]! < 0 && !s.wide) say(`pit trap in a Narrow corridor at ${at(k)}`);
          grounds.add(g.ground[k]!);
        }
      }
      if (grounds.size !== 1) say("pit trap over two grounds");
      // In a room, a pit lies on a doorway line, where the party walks.
      let line = false;
      for (let y = r.y; y < r.y + r.h; y++) for (let x = r.x; x < r.x + r.w; x++) if (onLine.has(y * W + x)) line = true;
      if (g.room[r.y * W + r.x]! >= 0 && !line) say(`pit trap at ${r.x},${r.y} off the doorway lines`);
      trapMids.push([2 * r.x + r.w, 2 * r.y + r.h]);
    } else if ("wire" in z) {
      if (t.preset !== FALLING_NET) say(`${t.preset} on a wire`);
      if (s.wide) say("a wire on Wide");
      const k = Math.floor(Math.min(z.wire.a[1], z.wire.b[1])) * W + Math.floor(Math.min(z.wire.a[0], z.wire.b[0]));
      if (!g.painted(k) || g.room[k]! >= 0) say(`wire off a corridor at ${at(k)}`);
      // Across its square from one wall's midpoint to the other's: rock past both ends.
      const across = z.wire.a[1] === z.wire.b[1];
      const ends = across ? [k - 1, k + 1] : [k - W, k + W];
      if (Math.abs(across ? z.wire.b[0] - z.wire.a[0] : z.wire.b[1] - z.wire.a[1]) !== 1 || ends.some((e) => g.painted(e))) say(`wire at ${at(k)} does not run wall to wall`);
      trapMids.push([z.wire.a[0] + z.wire.b[0], z.wire.a[1] + z.wire.b[1]]);
    } else {
      if (t.preset !== POISONED_NEEDLE) say(`${t.preset} on a door`);
      if (!("edge" in z.door) || g.doors.get(z.door.edge) !== "locked") say("needle on a door not locked");
      else {
        const [xs, ys, side] = z.door.edge.split(",");
        const x = Number(xs);
        const y = Number(ys);
        const sides = side === "n" ? [(y - 1) * W + x, y * W + x] : [y * W + x - 1, y * W + x];
        if (sides.some((k) => g.room[k]! >= 0 && plan.rooms[g.room[k]!]!.entrance)) say("needle in the entrance room");
        trapMids.push(side === "n" ? [2 * x + 1, 2 * y] : [2 * x, 2 * y + 1]);
      }
    }
  }
  for (let i = 0; i < trapMids.length; i++) {
    for (let j = i + 1; j < trapMids.length; j++) {
      const [a, b] = [trapMids[i]!, trapMids[j]!];
      if (Math.max(Math.abs(a[0] - b[0]), Math.abs(a[1] - b[1])) < 2 * TRAP_SPACING) say(`traps ${i} and ${j} closer than ${TRAP_SPACING}`);
    }
  }
  return out;
}
