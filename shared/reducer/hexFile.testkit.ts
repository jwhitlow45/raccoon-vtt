import assert from "node:assert/strict";
import { wall } from "../discoveryTestutil.ts";
import type { RoomState, Token } from "../model.ts";
import type { OpOf } from "../protocol.ts";
import { hexPlacements, linkHolds } from "../rules/attach.ts";
import { occupiedHexes, placedOnHex } from "../rules/footprint.ts";
import { hexDistance, hexKey, hexNeighbors, type Hex, type HexGrid } from "../rules/hex.ts";
import { findRouteOn } from "../rules/hexWalk.ts";
import { hexWallRoom, onHex, wallsRound } from "../rules/hexWalls.testkit.ts";
import { hexStandAt, hexStandPlace, ownWalk } from "../rules/movement.ts";
import { groupWalkWorld } from "../rules/walkWorld.ts";
import { chance, int, member, pick, rng, trap } from "../testutil.ts";

/*
 * The random rooms of hexFile.random.test.ts, which the board's own random
 * tests read too (client/features/movement/drop.hexFile.random.test.ts): a
 * squeezing holder walking into a corridor or inside one, what it drags and
 * carries, some hidden, and traps on the way. Live play 40's keep, which
 * route.hexFile.test.ts walks.
 */

export type Case = { state: RoomState; op: OpOf<"token.move">; g: HexGrid };

export function caseOf(seed: number, g: HexGrid): Case | null {
  const r = rng(seed * 7919 + (g.orient === "rows" ? 1 : 2));
  const wide = pick(r, [1, 1, 2] as const);
  const size = wide === 1 ? "large" : pick(r, ["large", "huge"] as const);
  const shape = g.orient === "rows" ? "hexRows" : "hexColumns";
  const at = (along: number, across: number): Hex => (g.orient === "rows" ? { col: along, row: across } : { col: across, row: along });
  const top = int(r, 6, 9);
  const solid = (h: Hex) => {
    const along = g.orient === "rows" ? h.col : h.row;
    const across = g.orient === "rows" ? h.row : h.col;
    return along >= 9 && along <= 17 && (across < top || across >= top + wide);
  };
  const bounds = g.orient === "rows" ? { w: 26, h: 18 } : { w: 18, h: 26 };
  const s = hexWallRoom(shape, bounds.w, bounds.h, wallsRound(g, bounds, solid));
  s.members = { dm1: member("dm1", "dm"), p1: member("p1"), p2: member("p2") };
  s.scenes.s1 = { ...s.scenes.s1!, fogEnabled: false };
  const hidden = (p = 0.25): Partial<Token> => (chance(r, p) ? { visibility: "dm" } : {});
  s.tokens.horse = onHex(g, "horse", size, at(int(r, 2, 5), top + int(r, -1, 1)), { name: "Warhorse", kind: "npc", ownerIds: ["p1"] });
  const own = occupiedHexes(g, s.tokens.horse);
  const taken = new Set(own.map(hexKey));
  // Riders: on a Huge mount up to four, one of them Large on some seeds. On a Large one a Medium rider at most.
  const riders = size === "huge" ? pick(r, [0, 1, 2, 3, 3, 4] as const) : int(r, 0, 1);
  const seats = [...own];
  for (let i = 0; i < riders; i++) {
    const big = size === "huge" && i === 0 && chance(r, 0.3);
    const seat = big ? own[0]! : seats.splice(int(r, 0, seats.length - 1), 1)[0]!;
    const rider = onHex(g, `rider${i}`, big ? "large" : "medium", seat, { name: `Rider ${i}`, kind: "pc", ownerIds: ["p1"], attached: { to: "horse", kind: "ride", ...(i === 0 ? { steer: true } : {}) }, ...hidden(0.2) });
    // A Large rider takes the seat of its size nearest its place (attach.ts seatSpot), which stands on the mount's hexes.
    const fits = hexPlacements(g, rider, own)[0];
    s.tokens[rider.id] = big && fits ? { ...rider, ...fits.spot } : rider;
  }
  // The hexes round the holder off the rock, for what it drags, farthest from the corridor first.
  const around = [...new Map(own.flatMap((h) => hexNeighbors(g, h)).filter((h) => !taken.has(hexKey(h)) && !solid(h)).map((h) => [hexKey(h), h] as const)).values()];
  const place = (id: string, big: boolean): { x: number; y: number } | null => {
    for (let tries = 0; tries < 6 && around.length > 0; tries++) {
      const hex = around[int(r, 0, around.length - 1)]!;
      const probe = onHex(g, id, big ? "large" : "medium", hex);
      const hexes = occupiedHexes(g, probe);
      if (hexes.some((h) => solid(h) || taken.has(hexKey(h)))) continue;
      for (const h of hexes) taken.add(hexKey(h));
      for (let k = around.length - 1; k >= 0; k--) if (taken.has(hexKey(around[k]!))) around.splice(k, 1);
      return { x: probe.x, y: probe.y };
    }
    return null;
  };
  const towed = int(r, 1, 4);
  for (let i = 0; i < towed; i++) {
    const big = chance(r, 0.2);
    const spot = place(`tow${i}`, big);
    if (!spot) continue;
    const by = i > 0 && s.tokens[`tow${i - 1}`] && chance(r, 0.3) ? `tow${i - 1}` : "horse";
    const tow = onHex(g, `tow${i}`, big ? "large" : pick(r, ["medium", "medium", "small", "tiny"] as const), { col: 0, row: 0 }, { name: `Goblin ${i}`, kind: "npc", attached: { to: by, kind: "drag" }, ...hidden() });
    s.tokens[tow.id] = { ...tow, ...placedOnHex(g, tow, occupiedHexes(g, { ...tow, size: big ? "large" : "medium", ...spot })[0]!) };
  }
  // A Tiny owl the first goblin carries, which may drag a rat: a seat inside the file's chains, which a trap's cut holds (traps.ts
  // seatingWalk).
  const carrier = s.tokens.tow0;
  if (carrier && carrier.size !== "large" && chance(r, 0.45)) {
    s.tokens.owl = { ...onHex(g, "owl", "tiny", occupiedHexes(g, carrier)[0]!, { name: "Owl", kind: "npc", attached: { to: "tow0", kind: "carry" }, ...hidden() }), elevation: carrier.elevation };
    const spot = chance(r, 0.6) ? place("rat", false) : null;
    if (spot) s.tokens.rat = onHex(g, "rat", "tiny", occupiedHexes(g, { size: "medium", ...spot })[0]!, { name: "Rat", kind: "npc", attached: { to: "owl", kind: "drag" }, ...hidden() });
  }
  // A stub across the way from a goblin to the holder, which stops a hidden one's first leg (moveLeg.ts stoppedAtWalls) and so what
  // follows it in the file (moveLeg.ts behindStop), and refuses a public one's.
  const tows = Object.values(s.tokens).filter((t) => t!.id.startsWith("tow")) as Token[];
  if (tows.length > 0 && chance(r, 0.35)) {
    const t = pick(r, tows);
    const a = { x: t.x + 0.5, y: t.y + 0.5 };
    const b = { x: s.tokens.horse.x + 1, y: s.tokens.horse.y + 1 };
    const m = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    const len = Math.hypot(b.x - a.x, b.y - a.y) || 1;
    const n = { x: (-(b.y - a.y) / len) * 0.3, y: ((b.x - a.x) / len) * 0.3 };
    const q = (v: number) => Math.round(v * 64) / 64;
    wall(s, "rulesb000000", [q(m.x - n.x), q(m.y - n.y)], [q(m.x + n.x), q(m.y + n.y)]);
  }
  if (s.tokens.rider0 && s.tokens.rider0.size === "medium" && chance(r, 0.4)) {
    const spot = place("led", false);
    if (spot) s.tokens.led = { ...onHex(g, "led", "medium", { col: 0, row: 0 }, { name: "Prisoner", kind: "npc", attached: { to: "rider0", kind: "drag" }, ...hidden() }), ...spot };
  }
  // A trap that stops a walk at the corridor's mouth or inside it, and one on the floor, by hex keys (traps.ts zoneHexes).
  const grid = shape;
  if (chance(r, 0.45)) {
    const h = at(int(r, 6, 14), top);
    s.traps.stop = trap("stop", { grid, zone: { cells: [{ x: h.col, y: h.row, w: 1 + int(r, 0, 1), h: 1 + int(r, 0, 1) }] } });
  }
  if (chance(r, 0.25)) {
    const h = at(int(r, 2, 10), top + int(r, -2, 1));
    s.traps.floor = trap("floor", { grid, zone: { cells: [{ x: h.col, y: h.row, w: 2, h: 2 }] }, rig: { on: ["enter"], who: "any", floor: true, resets: "never", stops: false, foundOnSpring: true, hits: "trigger", actions: [], find: [], notice: false } });
  }
  const holds = Object.values(s.tokens).every((t) => !t!.attached || linkHolds(g, s.meta.settings, t!.attached.kind, t!, s.tokens[t!.attached.to]!));
  if (!holds) return null;
  // The holder's own way to a hex in the corridor, squeezed there, as the device searches it alone (routeDrag.ts inFile).
  const horse = s.tokens.horse;
  const goal = at(int(r, 10, 16), top + (wide - 1) * int(r, 0, 1));
  const inside = hexStandPlace(g, horse, { size: hexStandAt(g, horse, horse, true).size, ref: goal, squeezed: true });
  const found = findRouteOn({ ...groupWalkWorld(s, ownWalk(horse), { role: "player" }).input, towed: [] }, inside);
  if (!found || found === "none") return null;
  return { state: s, g, op: { t: "token.move", tokenId: "horse", ...inside, squeeze: true, route: found.pieces.map(([x, y, extra, swim]): [number, number, number, 0 | 1] => [x, y, extra, swim]) } };
}

/**
 * A holder squeezed inside a corridor one hex wide (LP40-HEXFILE-1): eleven
 * hexes from 12, 12, each step straight on, a turn of a sixth now and then,
 * or a zigzag between two directions all along, rock everywhere else. Up to
 * three creatures of one hex stand behind it in the corridor, each dragged
 * by the holder, the one before it, or a rider on the holder, some of them
 * hidden, and a trap may stop the walk. The holder walks its own way a few
 * hexes on or back, squeezed there.
 */
export function insideCaseOf(seed: number, g: HexGrid): Case | null {
  const r = rng(seed * 6007 + (g.orient === "rows" ? 3 : 4));
  const shape = g.orient === "rows" ? "hexRows" : "hexColumns";
  const zig = chance(r, 0.35);
  let d = int(r, 0, 5);
  const other = (d + pick(r, [1, 5])) % 6;
  const path: Hex[] = [{ col: 12, row: 12 }];
  for (let k = 1; k < 11; k++) {
    const dir = zig ? (k % 2 === 0 ? other : d) : chance(r, 0.15) ? (d = (d + pick(r, [1, 5])) % 6) : d;
    path.push(hexNeighbors(g, path[k - 1]!)[dir]!);
  }
  // One hex wide: no hex of it beside another but the ones before and after it.
  for (let a = 0; a < path.length; a++) for (let b = a + 2; b < path.length; b++) if (hexDistance(g, path[a]!, path[b]!) <= 1) return null;
  const open = new Set(path.map(hexKey));
  const bounds = { w: 26, h: 26 };
  const s = hexWallRoom(shape, bounds.w, bounds.h, wallsRound(g, bounds, (h) => !open.has(hexKey(h))));
  s.members = { dm1: member("dm1", "dm"), p1: member("p1"), p2: member("p2") };
  s.scenes.s1 = { ...s.scenes.s1!, fogEnabled: false };
  const hidden = (p = 0.25): Partial<Token> => (chance(r, p) ? { visibility: "dm" } : {});
  const k = int(r, 3, 7);
  const horse = onHex(g, "horse", "large", path[k]!, { name: "Warhorse", kind: "npc", ownerIds: ["p1"] });
  s.tokens.horse = { ...horse, ...hexStandPlace(g, horse, { size: "medium", ref: path[k]!, squeezed: true }), squeeze: true };
  if (chance(r, 0.4)) s.tokens.rider0 = onHex(g, "rider0", "medium", path[k]!, { name: "Rider 0", kind: "pc", ownerIds: ["p1"], attached: { to: "horse", kind: "ride", steer: true }, ...hidden(0.2) });
  const towed = int(r, 1, 3);
  for (let i = 0; i < towed && k - 1 - i >= 0; i++) {
    const by = i > 0 && chance(r, 0.3) ? `tow${i - 1}` : s.tokens.rider0 && chance(r, 0.3) ? "rider0" : "horse";
    s.tokens[`tow${i}`] = onHex(g, `tow${i}`, pick(r, ["medium", "medium", "small", "tiny"] as const), path[k - 1 - i]!, { name: `Goblin ${i}`, kind: "npc", attached: { to: by, kind: "drag" }, ...hidden() });
  }
  if (chance(r, 0.35)) {
    const h = path[int(r, 1, 10)]!;
    s.traps.stop = trap("stop", { grid: shape, zone: { cells: [{ x: h.col, y: h.row, w: 1, h: 1 }] } });
  }
  const holds = Object.values(s.tokens).every((t) => !t!.attached || linkHolds(g, s.meta.settings, t!.attached.kind, t!, s.tokens[t!.attached.to]!));
  if (!holds) return null;
  const j = Math.min(9, Math.max(1, k + pick(r, [-2, -1, 1, 1, 2, 2, 3])));
  if (j === k) return null;
  const inside = hexStandPlace(g, s.tokens.horse, { size: "medium", ref: path[j]!, squeezed: true });
  const found = findRouteOn({ ...groupWalkWorld(s, ownWalk(s.tokens.horse), { role: "player" }).input, towed: [] }, inside);
  if (!found || found === "none") return null;
  return { state: s, g, op: { t: "token.move", tokenId: "horse", ...inside, squeeze: true, route: found.pieces.map(([x, y, extra, swim]): [number, number, number, 0 | 1] => [x, y, extra, swim]) } };
}

/** The holder's own way to `ref`, squeezed there, as the device's search finds it alone, or null where it finds none. */
export function wayInto(g: HexGrid, s: RoomState, ref: Hex): OpOf<"token.move"> | null {
  const horse = s.tokens.horse!;
  const inside = hexStandPlace(g, horse, { size: hexStandAt(g, horse, horse, true).size, ref, squeezed: true });
  const found = findRouteOn({ ...groupWalkWorld(s, ownWalk(horse), { role: "player" }).input, towed: [] }, inside);
  if (!found || found === "none") return null;
  return { t: "token.move", tokenId: "horse", ...inside, squeeze: true, route: found.pieces.map(([x, y, extra, swim]): [number, number, number, 0 | 1] => [x, y, extra, swim]) };
}

/** The holder's own way to `ref` (`wayInto`), which there is. */
export function intoCorridor(g: HexGrid, s: RoomState, ref: Hex): OpOf<"token.move"> {
  const op = wayInto(g, s, ref);
  assert.ok(op, "a way in for the holder alone");
  return op;
}

/**
 * Live play 40's keep (LP40-HEXFILE-1 and -2): a corridor one hex wide east
 * from 7, 6 for five hexes along line 6, then four hexes down, rock round
 * it, open ground west of it. On hex rows the way down zigzags, and on hex
 * columns line 6 does. The warhorse stands squeezed on the corridor's hex
 * `at`, and the goblin is dragged from the hex `goblin` by the warhorse, or
 * by Bree riding it.
 */
export function keepOf(g: HexGrid, at: number, goblin: number, by: "horse" | "bree"): { s: RoomState; path: Hex[] } {
  const bounds = { w: 22, h: 16 };
  const path: Hex[] = [];
  const step = (from: Hex, pick: (n: Hex) => number) => [...hexNeighbors(g, from)].sort((a, b) => pick(a) - pick(b))[0]!;
  let h: Hex = { col: 7, row: 6 };
  for (let i = 0; i < 5; i++) {
    path.push(h);
    h = step(h, (n) => -(n.col * 10) + Math.abs(n.row - 6) * 100);
  }
  const corner = path[4]!;
  h = corner;
  for (let i = 0; i < 4; i++) {
    h = step(h, (n) => -(n.row * 10) + Math.abs(n.col - corner.col) * 3 - n.col * 0.01);
    path.push(h);
  }
  const inPath = new Set(path.map(hexKey));
  const last = path[path.length - 1]!.row;
  const solid = (q: Hex) => q.col >= 7 && q.col <= 15 && q.row >= 1 && q.row <= last && !inPath.has(hexKey(q));
  const s = hexWallRoom(g.orient === "rows" ? "hexRows" : "hexColumns", bounds.w, bounds.h, wallsRound(g, bounds, solid));
  const on = path[at]!;
  const horse = onHex(g, "horse", "large", on, { name: "Warhorse", kind: "npc", ownerIds: ["p1"] });
  s.tokens.horse = { ...horse, ...hexStandPlace(g, horse, { size: "medium", ref: on, squeezed: true }), squeeze: true };
  if (by === "bree") s.tokens.bree = onHex(g, "bree", "medium", on, { name: "Bree", kind: "pc", ownerIds: ["p1"], attached: { to: "horse", kind: "ride", steer: true } });
  s.tokens.gob = onHex(g, "gob", "medium", path[goblin]!, { name: "Goblin", kind: "npc", ownerIds: ["p1"], attached: { to: by, kind: "drag" } });
  return { s, path };
}
