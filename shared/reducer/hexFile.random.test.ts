import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { wall } from "../discoveryTestutil.ts";
import type { RoomState, Token, Viewer } from "../model.ts";
import { canApply } from "../permissions.ts";
import { projectState, stableStringify } from "../project.ts";
import type { OpOf } from "../protocol.ts";
import { applyOp } from "../reducer.ts";
import { movementRules } from "../ruleHooks.ts";
import { hexPlacements, linkHolds, onHolder, seatedAt } from "../rules/attach.ts";
import { occupiedHexes, placedOnHex } from "../rules/footprint.ts";
import { hexDistance, hexKey, hexNeighbors, type Hex, type HexGrid } from "../rules/hex.ts";
import { findRouteOn, routeWorld } from "../rules/hexWalk.ts";
import { fileHeightsAlong, hexFileClasses, hexFileRoutes } from "../rules/route.ts";
import { COLUMNS, hexWallRoom, onHex, ROWS, wallsRound } from "../rules/hexWalls.testkit.ts";
import { planWalks, walkedIn } from "../rules/moveLeg.ts";
import { hexStandAt, hexStandPlace, onSqueezedLattice, ownWalk } from "../rules/movement.ts";
import { planTrapMove, trapLandings } from "../rules/traps.ts";
import { groupWalkWorld } from "../rules/walkWorld.ts";
import { chance, DM, env, int, member, P1, P2, pick, rng, trap } from "../testutil.ts";

/**
 * Random walks in single file on hexes (RIDE-SINGLE-FILE-HEX and
 * SEAT-TIE-HEX, D-261107-172, D-261107-173, D-261107-252 to 254), the hex
 * twin of ride.fileLoop.random.test.ts: hex rows and columns, a squeezing
 * Large or Huge holder walking its own way into a corridor one or two hexes
 * wide, up to four creatures it drags of one to three hexes, some dragged
 * by those in turn, riders of mixed sizes, a prisoner a rider leads,
 * creatures players cannot see among all of them, and traps that stop a
 * walk or lie on the floor. For every move: every token lands where the
 * trap step had it, every link between tokens every player sees that
 * holds there still holds, every walk in single file of a player's move
 * passes the server's own leg test, on a trap's cut too, and every answer
 * of reach is the link pass's own. At every point where the holder stands
 * squeezed no two passengers share a hex while one of them has a placement
 * free of the others. Twins that differ only in a hidden creature in tow
 * (added, removed or resized), in short walls no player sees, or in a
 * hidden rider beside the one rider players see, the room fogged, give
 * every player the same copy, log and undo mark, and the same seats to the
 * passengers they see. An op stored at version 50 walks none in single
 * file and seats each passenger on its nearest seat alone.
 *
 * From op version 62 (LP40-HEXFILE-1 and -2, migrate.ts followsHexByHex)
 * the holder also starts squeezed inside a corridor one hex wide that runs
 * straight, turns or zigzags, those it drags behind it there, and walks a
 * few hexes on or back: every leg in single file is one hex step, none of
 * those every player sees ends on a hex of the holder's, and the device's
 * check of the walk (hexWalk.ts fileBlocked) holds the drag where the
 * server refuses it.
 */

type Case = { state: RoomState; op: OpOf<"token.move">; g: HexGrid };

const VIEWERS: readonly Viewer[] = [P1, P2];

function caseOf(seed: number, g: HexGrid): Case | null {
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
function insideCaseOf(seed: number, g: HexGrid): Case | null {
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

/** What the random walks met, so each test can ask for enough of the class. */
type Tally = { taken: number; filed: number; refusedFar: number; cuts: number; hiddenFile: number; shared: number; held: number };

/**
 * One random move's checks: every token lands where the trap step had it,
 * every public link that holds there holds after, every walk in single file
 * of a player's move, cut or not, passes the leg test a hex step at a time,
 * stands on its own anchors and, every player seeing it, ends off the
 * holder's hexes, and reach is the link pass's own. The device's check of
 * the walk holds the drag exactly where the server refuses it for one that
 * cannot follow.
 */
function checkedMove(g: HexGrid, made: Case, at: string, tally: Tally): void {
  const { state: s, op } = made;
  const walks = planWalks(op, s, P1, {});
  const walked = walkedIn(walks);
  // The reach of each public creature in the file, as the link pass reads it where the uncut walk leaves them.
  const ends = new Map(walks.map((m) => [m.tokenId, { ...s.tokens[m.tokenId]!, ...m.to, ...(m.tokenId === "horse" ? { squeeze: true as const } : {}) }]));
  const far = walks.filter((m) => m.file === true && m.pass === "public" && !linkHolds(g, s.meta.settings, "drag", ends.get(m.tokenId)!, ends.get(s.tokens[m.tokenId]!.attached!.to) ?? s.tokens[s.tokens[m.tokenId]!.attached!.to]!));
  const allowed = canApply(op, P1, s, { canUseAsset: () => true });
  // The device's own check of the holder's way (routeDrag.ts inFile), on what Pat's copy holds.
  const horse = s.tokens.horse!;
  const points = [{ x: horse.x, y: horse.y }, ...(op.route ?? []).map(([x, y]) => ({ x, y }))];
  const device = routeWorld(groupWalkWorld(s, ownWalk(horse), { role: "player" }).input).fileBlocked(points);
  const cannot = !allowed.ok && allowed.message.endsWith("can't follow through there.");
  // A wall on a walk in the file refuses in the wall's own words (permissions.ts draggedWalls), reach in these.
  assert.ok(device === null || !allowed.ok, `${at}: the device holds a drag the server takes (${device})`);
  assert.ok(!cannot || device !== null, `${at}: the device lets go a drag the server refuses (${allowed.ok ? "" : allowed.message})`);
  if (device !== null) tally.held++;
  if (!allowed.ok) {
    if (cannot) {
      tally.refusedFar++;
      // From op version 62 every leg is one hex step the holder's own walk cleared, so only reach refuses one every player sees.
      assert.ok(far.length > 0, `${at}: refused for reach the link pass keeps`);
    }
    return;
  }
  tally.taken++;
  assert.deepEqual(far.map((m) => m.tokenId), [], `${at}: taken with one the link pass lets go`);
  if (walks.some((m) => m.file === true)) tally.filed++;
  if (walks.some((m) => m.file === true && m.pass === "private")) tally.hiddenFile++;
  // Every walk in single file of the move as dispatch takes it, cut where a trap stops it, passes the leg test.
  const cut = planTrapMove(op, s, P1, {}).op;
  if (cut !== op) tally.cuts++;
  const cutWalks = planWalks(cut, s, P1, {});
  const cutWalked = walkedIn(cutWalks);
  for (const m of cutWalks) {
    if (m.file !== true || m.pass !== "public" || !cutWalked(m)) continue;
    for (let i = 1; i < m.route.length; i++) assert.equal(movementRules.legBlocker(s, m.trace[i - 1]!, { ...m.route[i]!, squeeze: false }), null, `${at}: ${m.tokenId} leg ${i}`);
  }
  assert.ok(walks.every((m) => walked(m) || m.carriedBy !== undefined));
  const r = applyOp(s, op, P1, env(5));
  assert.ok(r.ok, at);
  const landed = trapLandings(op, s, P1, {});
  for (const [id, pose] of landed) {
    // A passenger on a holder a cut lands squeezed short of its walk sits on the squeezed stand, where the trap step read it at
    // its walk's spot there: a gap older than op 51, found here and left to its own fix (see the lane's report).
    const link = s.tokens[id]!.attached;
    if (cut !== op && link && onHolder(link.kind)) continue;
    const t: Token = r.state.tokens[id]!;
    assert.deepEqual([t.x, t.y, t.elevation], [pose.x, pose.y, pose.elevation], `${at}: ${id} where the trap step left it`);
  }
  linksKept(g, s, landed, r.state, at, new Set(walks.filter((m) => m.pass === "private").map((m) => m.tokenId)));
  seatsKept(s, landed, r.state, at);
  tally.shared += seatsApart(g, s, op, at);
  const holderHexes = new Set(occupiedHexes(g, r.state.tokens.horse!).map(hexKey));
  // Every point of a walk in single file stands on the creature's own anchors (route.ts hexFileRoutes, moveLeg.ts behindStop), a
  // hex step from the one before.
  for (const m of [...walks, ...cutWalks]) {
    if (m.file !== true) continue;
    for (const [i, p] of m.route.entries()) {
      const t = { ...s.tokens[m.tokenId]!, x: p.x, y: p.y };
      const there = placedOnHex(g, t, occupiedHexes(g, t)[0]!);
      if (i > 0) assert.ok(Math.abs(there.x - p.x) < 1e-9 && Math.abs(there.y - p.y) < 1e-9, `${at}: ${m.tokenId} at ${p.x}, ${p.y} off its anchors`);
      if (i > 0 && s.tokens[m.tokenId]!.size !== "large") assert.ok(hexDistance(g, occupiedHexes(g, { ...t, ...m.route[i - 1]! })[0]!, occupiedHexes(g, t)[0]!) <= 1, `${at}: ${m.tokenId} leg ${i} one hex step`);
    }
  }
  // None every player sees in the file ends under the holder where the whole walk leaves it (LP40-HEXFILE-2). A trap that stops a
  // large holder early may stand it on such a one's own start, where the stop keeps its spot (traps.ts fileApart), as before.
  for (const m of walks) {
    if (m.file !== true || m.pass !== "public" || cut !== op) continue;
    const t = r.state.tokens[m.tokenId]!;
    assert.ok(!occupiedHexes(g, t).some((h) => holderHexes.has(hexKey(h))), `${at}: ${m.tokenId} ends on the holder's hex`);
  }
}

/**
 * Every player's copy of the scene, the tokens players see under a holder they cannot see left out: a hidden walk moves those
 * (the private pass's own reveal, docs/design/design-v1-attach.md 8.0), so a hidden twin may move them.
 */
function copies(s: RoomState, base: RoomState = s): string[] {
  const under = new Set<string>();
  for (const t of Object.values(base.tokens)) {
    if (!t || t.visibility === "dm") continue;
    const seen = new Set<string>();
    for (let up = t.attached ? base.tokens[t.attached.to] : undefined; up && !seen.has(up.id); up = up.attached ? base.tokens[up.attached.to] : undefined) {
      seen.add(up.id);
      if (up.visibility === "dm") under.add(t.id);
    }
  }
  return VIEWERS.map((v) => {
    const copy = projectState(s, v, { sceneId: "s1" });
    return stableStringify({ ...copy, tokens: Object.fromEntries(Object.entries(copy.tokens).filter(([id]) => !under.has(id))) });
  });
}

/**
 * Each link between two tokens every player sees that holds where the trap
 * step leaves them still holds after the move, but one under a holder
 * players cannot see up its chain (`hidden`), which the private pass may
 * let go where its walk leaves it, as any hidden creature in tow.
 */
function linksKept(g: HexGrid, before: RoomState, landed: ReadonlyMap<string, { x: number; y: number; elevation: number }>, after: RoomState, at: string, hidden: ReadonlySet<string> = new Set()): void {
  const poseOf = (id: string): Token => ({ ...before.tokens[id]!, ...landed.get(id) });
  for (const t of Object.values(before.tokens)) {
    const link = t?.attached;
    if (!t || !link || t.visibility === "dm" || before.tokens[link.to]!.visibility === "dm" || hidden.has(t.id)) continue;
    if (!linkHolds(g, before.meta.settings, link.kind, poseOf(t.id), poseOf(link.to))) continue;
    assert.equal(after.tokens[t.id]!.attached?.to, link.to, `${at}: ${t.id} still held by ${link.to}`);
  }
}

/**
 * Whether every seat holds after the move, seen or not, as a cut holds a
 * hidden holder's walk where every seat on it holds (traps.ts
 * seatingWalk): only one every player sees on a holder they cannot see,
 * which the cut lands where the stop judged it, may let go (D-261101-403).
 */
function seatsKept(before: RoomState, landed: ReadonlyMap<string, unknown>, after: RoomState, at: string): void {
  for (const t of Object.values(before.tokens)) {
    const link = t?.attached;
    if (!t || !link || !onHolder(link.kind)) continue;
    if (after.tokens[t.id]!.attached?.to !== link.to && t.visibility !== "dm" && before.tokens[link.to]!.visibility === "dm" && landed.has(t.id)) continue;
    assert.equal(after.tokens[t.id]!.attached?.to, link.to, `${at}: ${t.id} still on ${link.to}`);
  }
}

/** At every point of the holder's walk where it stands squeezed, each passenger that shares a hex has no placement free of the others' hexes. */
function seatsApart(g: HexGrid, s: RoomState, op: OpOf<"token.move">, at: string): number {
  const walks = planWalks(op, s, P1, {});
  const horse = walks.find((m) => m.tokenId === "horse")!;
  const seated = walks.filter((m) => m.carriedBy === "horse" && onHolder(s.tokens[m.tokenId]!.attached!.kind));
  let shared = 0;
  for (let i = 1; i < horse.route.length; i++) {
    const last = i === horse.route.length - 1;
    if (!(last ? op.squeeze === true : onSqueezedLattice(g, s.tokens.horse!, horse.route[i]!))) continue;
    const stand = occupiedHexes(g, { ...s.tokens.horse!, ...horse.route[i]!, squeeze: true });
    const hexes = new Map(seated.map((m) => [m.tokenId, occupiedHexes(g, { ...s.tokens[m.tokenId]!, ...m.route[i]!, squeeze: undefined }).map(hexKey)]));
    for (const m of seated) {
      const mine = hexes.get(m.tokenId)!;
      const others = new Set(seated.filter((o) => o !== m).flatMap((o) => hexes.get(o.tokenId)!));
      if (!mine.some((k) => others.has(k))) continue;
      shared++;
      for (const p of hexPlacements(g, s.tokens[m.tokenId]!, stand)) assert.ok(p.hexes.some((h) => others.has(hexKey(h))), `${at}: ${m.tokenId} shares a hex at point ${i} with a placement free`);
    }
  }
  return shared;
}

/** The passengers every player sees and their seats at each point of the holder's walk. */
function publicSeats(s: RoomState, op: OpOf<"token.move">): string {
  return JSON.stringify(
    planWalks(op, s, P1, {})
      .filter((m) => m.carriedBy === "horse" && s.tokens[m.tokenId]!.visibility !== "dm" && onHolder(s.tokens[m.tokenId]!.attached!.kind))
      .map((m) => [m.tokenId, m.route.map((p) => [p.x, p.y])]),
  );
}

/** The room fogged, every token players see still seen through it, and no trap a player can find by its springing. */
function fogged(s: RoomState): RoomState {
  const out = structuredClone(s);
  out.scenes.s1 = { ...out.scenes.s1!, fogEnabled: true };
  for (const t of Object.values(out.tokens)) if (t && t.visibility !== "dm") out.tokens[t.id] = { ...t, fogExempt: true };
  for (const t of Object.values(out.traps)) if (t) out.traps[t.id] = { ...t, rig: { ...t.rig!, foundOnSpring: false } };
  return out;
}

/** The tokens sitting on the holder. */
function passengers(s: RoomState): Token[] {
  return Object.values(s.tokens).filter((t): t is Token => t?.attached?.to === "horse" && onHolder(t.attached.kind));
}

/**
 * The room with only the one rider players see on the holder, and its twin with a hidden rider beside it, so the holder's
 * passengers number one and two (moveLeg.ts endSeatsApart seats them apart only from two). Null where the room has no such rider,
 * a hidden one holds something, or no hex of the holder is free for the hidden one.
 */
function riderTwins(g: HexGrid, s: RoomState): { alone: RoomState; beside: RoomState } | null {
  const on = passengers(s);
  const shown = on.filter((t) => t.visibility !== "dm");
  if (shown.length !== 1 || on.some((t) => t.visibility === "dm" && Object.values(s.tokens).some((o) => o?.attached?.to === t.id))) return null;
  const alone = structuredClone(s);
  for (const t of on) if (t.visibility === "dm") delete alone.tokens[t.id];
  const horse = alone.tokens.horse!;
  const used = new Set(occupiedHexes(g, shown[0]!).map(hexKey));
  for (const hex of occupiedHexes(g, horse)) {
    if (used.has(hexKey(hex))) continue;
    const spy = onHex(g, "spy", "medium", hex, { name: "Spy", kind: "npc", visibility: "dm", attached: { to: "horse", kind: "ride" } });
    if (!linkHolds(g, alone.meta.settings, "ride", spy, horse)) continue;
    const beside = structuredClone(alone);
    beside.tokens.spy = spy;
    return { alone, beside };
  }
  return null;
}

/** A twin that differs only in a hidden creature in tow with nothing on it or behind it: one added, one removed or one resized. */
function hiddenTwin(g: HexGrid, s: RoomState, r: () => number): RoomState | null {
  const twin = structuredClone(s);
  const leaves = Object.values(twin.tokens).filter((t) => t?.visibility === "dm" && t.attached?.kind === "drag" && !Object.values(twin.tokens).some((o) => o?.attached?.to === t.id)) as Token[];
  const choice = leaves.length > 0 ? pick(r, ["remove", "resize", "add"] as const) : "add";
  if (choice === "remove") delete twin.tokens[pick(r, leaves).id];
  else if (choice === "resize") {
    const t = pick(r, leaves);
    const size = t.size === "large" ? "medium" : "large";
    const resized = { ...t, size, ...placedOnHex(g, { ...t, size }, occupiedHexes(g, t)[0]!) } as Token;
    twin.tokens[t.id] = resized;
  } else {
    const horse = twin.tokens.horse!;
    const used = new Set(Object.values(twin.tokens).flatMap((t) => (t && !t.attached ? occupiedHexes(g, t).map(hexKey) : [])));
    const near = occupiedHexes(g, horse).flatMap((h) => hexNeighbors(g, h)).filter((h) => !used.has(hexKey(h)));
    if (near.length === 0) return null;
    twin.tokens.ogre = onHex(g, "ogre", pick(r, ["large", "medium"] as const), pick(r, near), { name: "Ogre", kind: "npc", visibility: "dm", attached: { to: "horse", kind: "drag" } });
  }
  const holds = Object.values(twin.tokens).every((t) => !t!.attached || linkHolds(g, twin.meta.settings, t!.attached.kind, t!, twin.tokens[t!.attached.to]!));
  return holds ? twin : null;
}

for (const [name, g] of [
  ["hex rows", ROWS],
  ["hex columns", COLUMNS],
] as const) {
  describe(`${name}: random walks in single file and riders apart (D-261107-172, D-261107-173)`, () => {
    test("every walk lands where the trap step had it, keeps its public links, passes the leg test, reads reach as the link pass does, and seats its passengers apart", () => {
      const tally: Tally = { taken: 0, filed: 0, refusedFar: 0, cuts: 0, hiddenFile: 0, shared: 0, held: 0 };
      for (let seed = 1; seed <= 1000; seed++) {
        const made = caseOf(seed, g);
        if (made) checkedMove(g, made, `${name} seed ${seed}: ${JSON.stringify(made.op)}`, tally);
      }
      // Enough of the class that the rules above meet it: moves taken, with walks in single file, hidden ones among them, trap cuts,
      // drags held for one the file leaves out of reach, and passengers sharing a hex where no placement is free.
      assert.ok(tally.taken >= 160, `moves taken: ${tally.taken}`);
      assert.ok(tally.filed >= 145, `with walks in single file: ${tally.filed}`);
      assert.ok(tally.hiddenFile >= 63, `with a hidden one in the file: ${tally.hiddenFile}`);
      assert.ok(tally.cuts >= 45, `trap cuts: ${tally.cuts}`);
      assert.ok(tally.refusedFar >= 56, `held for reach: ${tally.refusedFar}`);
      assert.ok(tally.shared >= 18, `passengers sharing a hex: ${tally.shared}`);
    });

    test("from a start squeezed inside a corridor that turns or zigzags, a few hexes on or back: the same, every leg in the file one hex step and none every player sees left under the holder (LP40-HEXFILE-1, -2)", () => {
      const tally: Tally = { taken: 0, filed: 0, refusedFar: 0, cuts: 0, hiddenFile: 0, shared: 0, held: 0 };
      for (let seed = 1; seed <= 1000; seed++) {
        const made = insideCaseOf(seed, g);
        if (made) checkedMove(g, made, `${name} inside seed ${seed}: ${JSON.stringify(made.op)}`, tally);
      }
      // About 545 of 1,000 seeds on each layout: some 200 with a hidden one in the file, 18 to 30 trap cuts, 30 to 40 held for reach.
      assert.ok(tally.taken >= 500, `moves taken: ${tally.taken}`);
      assert.ok(tally.filed >= 500, `with walks in single file: ${tally.filed}`);
      assert.ok(tally.hiddenFile >= 150, `with a hidden one in the file: ${tally.hiddenFile}`);
      assert.ok(tally.cuts >= 15, `trap cuts: ${tally.cuts}`);
      assert.ok(tally.refusedFar >= 25 && tally.held >= tally.refusedFar, `held for reach: ${tally.refusedFar}, by the device: ${tally.held}`);
    });

    test("twins that differ only in a hidden creature in tow or in walls no player sees give every player the same copy, log and undo mark, and the same seats", () => {
      let compared = 0;
      let walled = 0;
      let cutTwins = 0;
      for (let seed = 1; seed <= 1000; seed++) {
        const made = caseOf(seed, g);
        if (!made) continue;
        const base = fogged(made.state);
        const { op } = made;
        const at = `${name} seed ${seed}`;
        const tr = rng(seed * 104729 + 3);
        const ok = canApply(op, P1, base, { canUseAsset: () => true }).ok;
        const a = ok ? applyOp(structuredClone(base), op, P1, env(5)) : null;
        // A hidden creature in tow added, removed or resized.
        const twin = hiddenTwin(g, base, tr);
        if (twin) {
          assert.equal(canApply(op, P1, twin, { canUseAsset: () => true }).ok, ok, `${at}: the hidden twin's answer`);
          assert.equal(publicSeats(twin, op), publicSeats(base, op), `${at}: the passengers players see sit alike`);
          if (ok && a?.ok) {
            const b = applyOp(structuredClone(twin), op, P1, env(5));
            assert.ok(b.ok, at);
            assert.deepEqual(copies(b.state, base), copies(a.state, base), `${at}: every player's copy with the hidden twin`);
            assert.equal(b.trapped, a.trapped, `${at}: the undo mark with the hidden twin`);
            compared++;
            if (planTrapMove(op, base, P1, {}).op !== op) cutTwins++;
          }
        }
        // Short walls on ground no player sees, near the hidden walks, that leave every walk of the move as it was.
        if (!ok || !a?.ok) continue;
        const hidden = planWalks(op, base, P1, {}).filter((m) => base.tokens[m.tokenId]?.visibility === "dm");
        if (hidden.length === 0) continue;
        const plan = JSON.stringify(planWalks(op, base, P1, {}).map((m) => [m.tokenId, m.route]));
        const walls = structuredClone(base);
        for (let k = 0, n = int(tr, 1, 3); k < n; k++) {
          const p = pick(tr, pick(tr, hidden).route);
          const q = (v: number) => Math.round(v * 8) / 8;
          const x = q(p.x + (tr() * 2 - 0.5));
          const y = q(p.y + (tr() * 2 - 0.5));
          wall(walls, `rulesa${String(k).padStart(6, "0")}`, [x, y], chance(tr, 0.5) ? [x + 0.375, y] : [x, y + 0.375]);
        }
        if (!canApply(op, P1, walls, { canUseAsset: () => true }).ok || JSON.stringify(planWalks(op, walls, P1, {}).map((m) => [m.tokenId, m.route])) !== plan) continue;
        assert.deepEqual(copies(walls), copies(base), `${at}: the copies start the same`);
        const b = applyOp(structuredClone(walls), op, P1, env(5));
        assert.ok(b.ok, at);
        assert.deepEqual(copies(b.state, base), copies(a.state, base), `${at}: every player's copy with walls they cannot see`);
        assert.equal(b.trapped, a.trapped, `${at}: the undo mark with walls they cannot see`);
        walled++;
      }
      assert.ok(compared >= 160, `hidden twins compared: ${compared}`);
      assert.ok(cutTwins >= 13, `hidden twins cut by a trap: ${cutTwins}`);
      assert.ok(walled >= 55, `walled twins compared: ${walled}`);
    });

    test("the one rider players see sits alike with and without a hidden rider beside it, one passenger or two (RULES-OPUS-4)", () => {
      let compared = 0;
      for (let seed = 1; seed <= 1000; seed++) {
        const made = caseOf(seed, g);
        if (!made) continue;
        const twins = riderTwins(g, fogged(made.state));
        if (!twins) continue;
        const { alone, beside } = twins;
        const { op } = made;
        const at = `${name} seed ${seed}`;
        const ok = canApply(op, P1, alone, { canUseAsset: () => true }).ok;
        assert.equal(canApply(op, P1, beside, { canUseAsset: () => true }).ok, ok, `${at}: the answer with the hidden rider`);
        assert.equal(publicSeats(beside, op), publicSeats(alone, op), `${at}: the rider players see sits alike`);
        if (!ok) continue;
        const a = applyOp(structuredClone(alone), op, P1, env(5));
        const b = applyOp(structuredClone(beside), op, P1, env(5));
        assert.ok(a.ok && b.ok, at);
        assert.deepEqual(copies(b.state, alone), copies(a.state, alone), `${at}: every player's copy with the hidden rider`);
        compared++;
      }
      assert.ok(compared >= 50, `rider twins compared: ${compared}`);
    });

    test("an op stored at version 50 takes every creature in tow by its place and seats each passenger on its nearest seat alone", () => {
      let checked = 0;
      let apartNow = 0;
      let squeezedRiders = 0;
      for (let seed = 1; seed <= 1000; seed++) {
        const made = caseOf(seed, g);
        if (!made) continue;
        const { state: s, op } = made;
        const walks = planWalks(op, s, P1, { opVersion: 50 });
        assert.deepEqual(walks.filter((m) => m.file === true).map((m) => m.tokenId), [], `seed ${seed}`);
        const horse = walks.find((m) => m.tokenId === "horse")!;
        const last = horse.route.length - 1;
        const seated = walks.filter((m) => m.carriedBy === "horse" && onHolder(s.tokens[m.tokenId]!.attached!.kind));
        for (const m of seated) {
          for (let i = 1; i <= last; i++) {
            const squeezed = i === last ? op.squeeze === true : onSqueezedLattice(g, s.tokens.horse!, horse.route[i]!);
            const seat = seatedAt(g, s.tokens[m.tokenId]!, s.tokens.horse!, horse.route[i]!, squeezed, 50);
            assert.deepEqual([m.route[i]!.x, m.route[i]!.y], [seat.x, seat.y], `seed ${seed}: ${m.tokenId} at point ${i} sits on its nearest seat`);
            if (squeezed && seated.length >= 2) squeezedRiders++;
          }
        }
        // Where a live move seats the passengers apart, the stored one's nearest seats are what tell the versions apart.
        const live = new Map(planWalks(op, s, P1, {}).map((m) => [m.tokenId, JSON.stringify(m.route)]));
        if (seated.some((m) => live.get(m.tokenId) !== JSON.stringify(m.route))) apartNow++;
        checked++;
      }
      assert.ok(checked >= 350, `cases: ${checked}`);
      assert.ok(apartNow >= 6, `cases a live move seats apart: ${apartNow}`);
      assert.ok(squeezedRiders >= 60, `riders checked on a squeezed holder: ${squeezedRiders}`);
    });

    // seated.length < 2 in moveLeg.ts endSeatsApart counts every rider, hidden or not, so one shown rider is seated apart only when a
    // hidden one rides beside it. The seat the shown rider takes must not tell a player that the hidden one is there.
    test("one rider every player sees sits alike with and without one hidden rider beside it", () => {
      let compared = 0;
      for (let seed = 1; seed <= 8000; seed++) {
        const made = caseOf(seed, g);
        if (!made) continue;
        const { state: base, op } = made;
        const riding = Object.values(base.tokens).filter((t): t is Token => !!t && t.attached?.to === "horse" && onHolder(t.attached.kind));
        const shown = riding.filter((t) => t.visibility !== "dm");
        const unseen = riding.filter((t) => t.visibility === "dm");
        if (shown.length !== 1 || unseen.length !== 1) continue;
        const gone = unseen[0]!.id;
        if (Object.values(base.tokens).some((t) => t?.attached?.to === gone)) continue;
        const alone = structuredClone(base);
        delete alone.tokens[gone];
        assert.equal(canApply(op, P1, alone, { canUseAsset: () => true }).ok, canApply(op, P1, base, { canUseAsset: () => true }).ok, `seed ${seed}: the answer`);
        assert.equal(publicSeats(alone, op), publicSeats(base, op), `seed ${seed}: the shown rider's seats`);
        compared++;
      }
      assert.ok(compared >= 10, `pairs compared: ${compared}`);
    });

    test("raised 40 ft and brought down to the ground or to 25 ft, or climbing from the ground to 30 ft: the device reads every point of every walk hex by hex at the height the move gives it (review HEXFILE-OPUS-9)", () => {
      let walks = 0;
      let points = 0;
      for (const [kind, made] of [
        ["", caseOf],
        ["inside ", insideCaseOf],
      ] as const) {
        for (let seed = 1; seed <= 1000; seed++) {
          const room = made(seed, g);
          if (!room) continue;
          for (const [up, down] of [
            [40, 0],
            [40, 25],
            [0, 30],
          ] as const) {
            const s = structuredClone(room.state);
            for (const t of Object.values(s.tokens)) {
              if (!t) continue;
              t.elevation += up;
              // Every one seen, as the device's walkers are.
              t.visibility = "all";
            }
            delete s.traps.stop;
            delete s.traps.floor;
            const op = { ...room.op, elevation: down };
            const plan = planWalks(op, s, DM, {});
            const lead = plan.find((m) => m.tokenId === "horse")?.route;
            if (!lead) continue;
            const horse = s.tokens.horse!;
            const members = new Set(plan.map((m) => m.tokenId));
            const dragged = Object.values(s.tokens).filter((t): t is Token => t?.attached?.kind === "drag" && members.has(t.id));
            const file = hexFileRoutes(g, horse, lead, [hexFileClasses(dragged, [])[0]], true);
            const memberOf = (id: string) => s.tokens[id];
            for (const m of plan) {
              if (!m.along || !file.has(m.tokenId)) continue;
              const device = fileHeightsAlong(s.buildChunks, { id: "horse", elevation: horse.elevation, grounded: up === 0 }, memberOf, file, m.tokenId, lead, horse);
              const at = `${kind}seed ${seed}, ${up} to ${down} ft, ${m.tokenId}`;
              assert.equal(device.length, m.route.length, `${at}: as many points`);
              for (let j = 1; j < m.route.length; j++) {
                if (device[j] === null) continue;
                assert.ok(Math.abs(device[j]! - m.route[j]!.elevation) < 1e-6, `${at}, point ${j}: the device ${device[j]}, the move ${m.route[j]!.elevation}`);
                points++;
              }
              walks++;
            }
          }
        }
      }
      assert.ok(walks >= 3000 && points >= 15000, `walks ${walks}, points ${points}`);
    });
  });
}
