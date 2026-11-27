import type { Token } from "#shared/model.ts";
import { anchorOfHex, occupiedCells, occupiedHexes, placedOnHex } from "#shared/rules/footprint.ts";
import { SQUARES } from "#shared/rules/grid.ts";
import { footprintHexes, parseHexKey, type Hex } from "#shared/rules/hex.ts";
import type { SrdMonster } from "#shared/srd/monsters.ts";
import { partyBudgets } from "../encounters/budget.ts";
import { REPORTS, type DungeonEdits, type RoomFacts } from "./edits.ts";
import { hexGridOf } from "./lattice.ts";
import type { DungeonPlan, KeyRoom, PlanMonster, Planned } from "./plan.ts";
import { seedStream, type Stream } from "./random.ts";
import type { Seed } from "./seed.ts";
import { GENERATOR_VERSION, isHexGrid, MAX_MONSTERS, MAX_ROOM_MONSTERS, raisedCount, type Theme } from "./settings.ts";
import { FIRST_FAMILY_WEIGHT, familyOf, type StockMonster } from "./stockPools.ts";
import type { StockRequest } from "./worker.ts";

/*
 * Stocking a generated dungeon with monsters (docs/design/design-v1-dungeon-stock.md
 * 4, D-261127-280 to 285). Pure, so the worker, the dialog, the wing pane
 * and the tests share it.
 */

/**
 * Creatures one room may hold: an edit of On or Other monsters claims
 * `perRoom`, Off claims none, and an unedited room claims `perRoom` when
 * the share picked it. A claim reads the choices alone, never a draw, a
 * budget or the pool, so the dialog can check it on every render.
 */
export function roomClaim(room: Pick<RoomFacts, "room" | "share">, edits: DungeonEdits["rooms"] | null, perRoom: number): number {
  const e = edits?.[room.room];
  if (e?.monsters === false) return 0;
  if (e?.monsters === true || e?.monstersDraw !== undefined) return perRoom;
  return room.share ? perRoom : 0;
}

/** Every room's claim, added up: what Make would stock at most, which must stay within `stockCapacity`. */
export function stockClaims(rooms: readonly Pick<RoomFacts, "room" | "share">[], edits: DungeonEdits["rooms"] | null, perRoom: number): number {
  return rooms.reduce((sum, r) => sum + roomClaim(r, edits, perRoom), 0);
}

/** Creatures a dungeon or wing may stock: the scene group's tokens left less the planned Rolling Stones, at most MAX_MONSTERS. */
export function stockCapacity(tokensLeft: number, stones: number): number {
  return Math.max(0, Math.min(MAX_MONSTERS, tokensLeft - stones));
}

/**
 * Creatures one room's fight may hold: the capacity shared by every kept
 * room, the entrance among them, so every room can be On at once within
 * it, at least one and at most MAX_ROOM_MONSTERS (D-261127-285).
 */
export function perRoomCap(capacity: number, keptRooms: number): number {
  return Math.max(1, Math.min(MAX_ROOM_MONSTERS, Math.floor(capacity / Math.max(1, keptRooms))));
}

/** The lane the share's rooms are shuffled on, after the key's and the dead ends' (plan.ts). */
export const LANE_STOCK_ROOMS = 7;
/** The first of the lanes a room's fight is drawn on, 16 a room, clear of the props' lanes: 1024 + 16 x room + monstersDraw. */
export const LANE_ROOM_MONSTERS = 1024;

/** The cells a size takes a side, as a creature's anchor counts them: Tiny to Medium one, Large two, Huge three. */
const SIDE: Readonly<Record<Exclude<SrdMonster["size"], "gargantuan">, number>> = { tiny: 1, small: 1, medium: 1, large: 2, huge: 3 };
type Size = keyof typeof SIDE;

/** What stocking reads of a plan's working (plan.ts `Planned`). */
export type StockInput = Pick<Planned, "plan" | "board" | "kept" | "entrance" | "lattice" | "standable" | "facts">;

/** A plan stocked: its creatures and key with the fights, the room panel's facts, and the claim check's numbers. */
export type Stocked = { plan: DungeonPlan; facts: RoomFacts[]; capacity: number; perRoom: number; claims: number };

/** One kind in a fight: its block and how many. */
type Pick1 = { m: StockMonster; n: number };

/**
 * A room's fight (stocking step 5): a family drawn by weight, then a
 * shape, solo (25%), a leader with followers (45%) or a band of one kind
 * (30%), each spending as much of the budget as it can within `most`
 * creatures. Ties are drawn, and a shape that cannot be made falls back to
 * the most XP one creature within the budget brings.
 */
export function drawFight(rng: Stream, pool: readonly StockMonster[], theme: Theme, budget: number, most: number): Pick1[] {
  const fits = pool.filter((m) => m.xp <= budget);
  if (fits.length === 0 || most < 1) return [];
  const families = [...new Set(fits.map((m) => familyOf(theme, m)))].sort((a, b) => a - b);
  const weights = families.map((f) => (f === 0 ? FIRST_FAMILY_WEIGHT : 1));
  let roll = rng.below(weights.reduce((a, b) => a + b, 0));
  let family = families[0]!;
  for (const [j, w] of weights.entries()) {
    if (roll < w) {
      family = families[j]!;
      break;
    }
    roll -= w;
  }
  const kin = fits.filter((m) => familyOf(theme, m) === family);
  const shape = rng.below(20);
  const best = <T>(options: readonly T[], total: (o: T) => number): T | null => {
    let top = -1;
    let ties: T[] = [];
    for (const o of options) {
      const t = total(o);
      if (t > top) {
        top = t;
        ties = [o];
      } else if (t === top) ties.push(o);
    }
    return ties.length > 0 ? rng.pick(ties) : null;
  };
  const solo = (): Pick1[] => [{ m: best(kin, (m) => m.xp)!, n: 1 }];
  if (shape < 5 || most === 1) return solo();
  if (shape < 14) {
    const pairs: [StockMonster, StockMonster, number][] = [];
    for (const lead of kin) {
      for (const f of kin) {
        if (f === lead || f.xp > lead.xp) continue;
        const n = Math.min(most - 1, Math.floor((budget - lead.xp) / f.xp));
        if (n >= 1) pairs.push([lead, f, n]);
      }
    }
    const pair = best(pairs, ([lead, f, n]) => lead.xp + f.xp * n);
    return pair ? [{ m: pair[0], n: 1 }, { m: pair[1], n: pair[2] }] : solo();
  }
  const bands = kin.flatMap((m): Pick1[] => {
    const n = Math.min(most, Math.floor(budget / m.xp));
    return n >= 2 ? [{ m, n }] : [];
  });
  const band = best(bands, (b) => b.m.xp * b.n);
  return band ? [band] : solo();
}

/** The key's lines for a fight: each kind's name and count, the first kind first. */
function linesOf(placed: readonly StockMonster[]): [string, number][] {
  const lines = new Map<string, number>();
  for (const m of placed) lines.set(m.name, (lines.get(m.name) ?? 0) + 1);
  return [...lines];
}

/**
 * The plan stocked (docs/design/design-v1-dungeon-stock.md 4, stocking
 * steps 1 to 7): the share's rooms picked on their own lane, each claiming
 * room's fight drawn on its own lane within its claim, and placed on the
 * room's standable cells, biggest first, nearest the room's middle. A
 * room's fight reads its own claim, lane and contents alone, so an edit in
 * one room never changes another's (D-261127-064). Nothing is trimmed to
 * the capacity: past it the dialog shows the claims over the limit with
 * Make off (D-261127-282). `taken` holds a wing scene's tokens.
 */
export function stockPlan(input: StockInput, seed: Seed, theme: Theme, stock: StockRequest, edits: DungeonEdits["rooms"] | null, taken: readonly Pick<Token, "size" | "x" | "y" | "w" | "h">[] = []): Stocked {
  const { plan, board, kept, entrance, lattice: L } = input;
  const capacity = stockCapacity(stock.tokensLeft, plan.stones.length);
  const perRoom = perRoomCap(capacity, kept.length);
  const others = kept.filter((i) => i !== entrance);
  const share = new Set(seedStream(seed, GENERATOR_VERSION, LANE_STOCK_ROOMS).shuffle([...others]).slice(0, raisedCount(stock.choices.monsters, kept.length)));
  const budget = partyBudgets(stock.party)[stock.choices.difficulty];
  const hex = isHexGrid(plan.grid) ? hexGridOf(plan.grid) : null;
  const ground = new Map<string, number>();
  for (const { ft, cells } of plan.heights) for (const c of cells) ground.set(c, ft);
  const groundAt = (k: number) => ground.get(L.keyOf(k)) ?? 0;
  const indexOf = (h: Hex): number | null => {
    const [x, y] = plan.grid === "hexColumns" ? [h.row, h.col] : [h.col, h.row];
    return L.inMap(x, y) ? y * L.W + x : null;
  };
  const occupied = new Set<number>();
  for (const t of taken) {
    if (hex) for (const h of occupiedHexes(hex, t)) {
      const k = indexOf(h);
      if (k !== null) occupied.add(k);
    }
    else for (const c of occupiedCells(SQUARES, t)) if (L.inMap(c.x, c.y)) occupied.add(c.y * L.W + c.x);
  }
  /** The cells a creature of `size` takes with its anchor on cell k (its reference hex on hexes), or null off the scene. */
  const cover = (size: Size, k: number): number[] | null => {
    if (!hex) {
      const s = SIDE[size];
      const x = k % L.W;
      const y = Math.floor(k / L.W);
      if (x + s > L.W || y + s > L.H) return null;
      const out: number[] = [];
      for (let dy = 0; dy < s; dy++) for (let dx = 0; dx < s; dx++) out.push((y + dy) * L.W + x + dx);
      return out;
    }
    const ref = parseHexKey(L.keyOf(k));
    if (!ref) return null;
    const out: number[] = [];
    for (const h of footprintHexes(hex, size, anchorOfHex(hex, size, ref))) {
      const q = indexOf(h);
      if (q === null) return null;
      out.push(q);
    }
    return out;
  };
  const cornerOf = (size: Size, k: number): { x: number; y: number } => {
    if (!hex) return { x: k % L.W, y: Math.floor(k / L.W) };
    const ref = parseHexKey(L.keyOf(k))!;
    return placedOnHex(hex, { size, x: 0, y: 0 }, ref);
  };
  const monsters: PlanMonster[] = [];
  const keyFights = new Map<number, NonNullable<KeyRoom["monsters"]>>();
  const fights = new Map<number, RoomFacts["monsters"]>();
  const spotless = new Set<number>();
  let claims = 0;
  for (const i of kept) {
    const claim = roomClaim({ room: i, share: share.has(i) }, edits, perRoom);
    claims += claim;
    if (claim === 0) {
      fights.set(i, { on: false, lines: [], xp: 0 });
      continue;
    }
    const r = board.rooms[i]!;
    const mid = { x: r.x + r.w / 2, y: r.y + r.h / 2 };
    // Each size's anchors in the room's own box, nearest its middle first, ties by row then column.
    const anchors = new Map<Size, { k: number; cells: number[] }[]>();
    for (const size of Object.keys(SIDE) as Size[]) {
      const list: { k: number; cells: number[]; d: number; x: number; y: number }[] = [];
      for (let y = r.y; y < r.y + r.h; y++) {
        for (let x = r.x; x < r.x + r.w; x++) {
          if (!L.inMap(x, y)) continue;
          const k = y * L.W + x;
          const cells = cover(size, k);
          if (!cells || !cells.every((q) => input.standable(i, q) && !occupied.has(q))) continue;
          const g = groundAt(cells[0]!);
          if (!cells.every((q) => groundAt(q) === g)) continue;
          const s = hex ? 1 : SIDE[size];
          list.push({ k, cells, d: (x + s / 2 - mid.x) ** 2 + (y + s / 2 - mid.y) ** 2, x, y });
        }
      }
      list.sort((a, b) => a.d - b.d || a.y - b.y || a.x - b.x);
      anchors.set(size, list);
    }
    const sized = stock.pool.filter((m): m is StockMonster & { size: Size } => m.size !== "gargantuan" && (anchors.get(m.size as Size)?.length ?? 0) > 0);
    const rng = seedStream(seed, GENERATOR_VERSION, LANE_ROOM_MONSTERS + 16 * i + ((edits?.[i]?.monstersDraw ?? 0) % 16));
    const fight = drawFight(rng, sized, theme, budget, claim);
    const creatures = fight.flatMap((p) => Array.from({ length: p.n }, () => p.m as StockMonster & { size: Size })).sort((a, b) => SIDE[b.size] - SIDE[a.size]);
    const used = new Set<number>();
    const placed: StockMonster[] = [];
    for (const m of creatures) {
      const spot = anchors.get(m.size)!.find((a) => a.cells.every((q) => !used.has(q)));
      // A creature with no anchor left is dropped with its XP, so the key lists what lands.
      if (!spot) continue;
      for (const q of spot.cells) used.add(q);
      placed.push(m);
      monsters.push({ srdId: m.srdId, room: i, ...cornerOf(m.size, spot.k) });
    }
    const lines = linesOf(placed);
    const xp = placed.reduce((sum, m) => sum + m.xp, 0);
    fights.set(i, { on: true, lines, xp });
    if (placed.length === 0) spotless.add(i);
    else keyFights.set(i, { lines, xp, budget });
  }
  const facts = input.facts.map((f) => ({
    ...f,
    share: share.has(f.room),
    monsters: fights.get(f.room) ?? null,
    ...(spotless.has(f.room) ? { reports: [...f.reports, REPORTS.noMonsterSpot] } : {}),
  }));
  const key = plan.key && plan.key.map((k) => (keyFights.has(k.room) ? { ...k, monsters: keyFights.get(k.room)! } : k));
  return { plan: { ...plan, key, monsters }, facts, capacity, perRoom, claims };
}
