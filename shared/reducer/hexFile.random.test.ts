import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { wall } from "../discoveryTestutil.ts";
import type { RoomState, Token, Viewer } from "../model.ts";
import { canApply } from "../permissions.ts";
import { projectState, stableStringify } from "../project.ts";
import type { Op, OpOf } from "../protocol.ts";
import { applyOp } from "../reducer.ts";
import { movementRules } from "../ruleHooks.ts";
import { hexPlacements, linkHolds, onHolder, seatedAt } from "../rules/attach.ts";
import { occupiedHexes, placedOnHex } from "../rules/footprint.ts";
import { hexCenter, hexDistance, hexKey, hexNeighbors, type Hex, type HexGrid } from "../rules/hex.ts";
import { routeWorld } from "../rules/hexWalk.ts";
import { compareAlong, fileHeightsAlong, followerTrace, hexFileClasses, hexFileRoutes, pointAt } from "../rules/route.ts";
import { COLUMNS, onHex, ROWS } from "../rules/hexWalls.testkit.ts";
import { planWalks, walkedIn } from "../rules/moveLeg.ts";
import { groundUnder, onSqueezedLattice, ownWalk } from "../rules/movement.ts";
import { footing, footprintGround } from "../rules/heights.ts";
import { planTrapMove, trapHits, trapLandings, trapMoments, trapSpotHeights, trapWalks } from "../rules/traps.ts";
import { groupWalkWorld } from "../rules/walkWorld.ts";
import { chance, DM, env, int, P1, P2, pick, rng, template, trap } from "../testutil.ts";
import { caseOf, insideCaseOf, keepOf, raised, seatedMove, wayInto, withImpAhead, withMouse, withOgre, withRises, withStop, type Case } from "./hexFile.testkit.ts";

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

const VIEWERS: readonly Viewer[] = [P1, P2];

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

/**
 * After a trap's cut `cut` of a move in `s`, which left `after`: each walk
 * hex by hex that left its start stands level with its holder where the cut
 * leaves that, by attach's rule (docs/design/design-v1-attach.md 5.1). One
 * that never left its start keeps its own height there (review
 * FU45B-ASTRA-06). How many it checked.
 */
function levelWithHolders(s: RoomState, cut: Op, after: RoomState, actor: Viewer, at: string): number {
  let checked = 0;
  const walks = planWalks(cut, s, actor, {});
  for (const m of walks) {
    const holder = walks.find((h) => h.tokenId === m.carriedBy);
    if (!m.along || !holder) continue;
    const [was, now] = [s.tokens[m.tokenId]!, after.tokens[m.tokenId]!];
    if (now.x === was.x && now.y === was.y) continue;
    const [held, holds] = [s.tokens[holder.tokenId]!, after.tokens[holder.tokenId]!];
    const link = was.attached!;
    const ground = groundUnder(s.buildChunks, followerTrace(was, [was])[0]!, now);
    const want = onHolder(link.kind) ? holds.elevation + (was.elevation - held.elevation) : footing(s.buildChunks, holder.trace[0]!) === "ground" ? ground : Math.max(was.elevation + (holds.elevation - held.elevation), ground);
    assert.ok(Math.abs(now.elevation - want) < 1e-9, `${at}: ${m.tokenId} at ${now.elevation}, level with ${holder.tokenId} at ${holds.elevation} is ${want}`);
    checked++;
  }
  return checked;
}

/** The holder raised 40 ft and brought down to the ground or to 25 ft, or climbing from the ground to 30 ft, as feet up and down. */
const HEIGHTS = [
  [40, 0],
  [40, 25],
  [0, 30],
] as const;

/** The least walks of each kind the moment oracle must meet on each grid, about half of what it meets. */
const KINDS: readonly (readonly [string, number])[] = [
  ["in the file", 6000],
  ["out of the file", 450],
  ["hidden", 1700],
  ["Large or bigger", 240],
  ["riding or carried", 200],
  ["dragged", 6000],
  ["in a chain", 2400],
  ["seen under a hidden holder", 260],
  ["flying", 6000],
  ["on raised ground", 1800],
  ["Pat's", 3300],
  ["the DM's", 3300],
];

/** A sphere 5 ft round a creature's hex's middle at height `z`, as a trap's hits read an area. */
function ballAt(g: HexGrid, t: Token, z: number) {
  const { shape, size, origin, yaw, includeOrigin } = template("ball", { shape: "sphere", size: 5, origin: { ...hexCenter(g, occupiedHexes(g, t)[0]!), z }, includeOrigin: true });
  return { shape, size, origin, yaw, includeOrigin };
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
              const device = fileHeightsAlong(s.buildChunks, { id: "horse", elevation: horse.elevation, grounded: up === 0 }, memberOf, file, m.tokenId, lead);
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

    test("raised 40 ft and brought down to the ground or to 25 ft, or climbing from the ground to 30 ft, a stop trap on the way, an imp ahead of the holder on some: after every trap cut each walk hex by hex that left its start stands level with its holder where the cut leaves that (review HEXFILE-ASTRA-4)", () => {
      let cuts = 0;
      let checked = 0;
      for (const [kind, made] of [
        ["", caseOf],
        ["inside ", insideCaseOf],
      ] as const) {
        for (let seed = 1; seed <= 400; seed++) {
          const room = made(seed, g);
          if (!room) continue;
          for (const [ahead, start] of [
            ["", room],
            ["imp ahead, ", withImpAhead(room, seed)],
            ["mouse in tow, ", withMouse(room, seed)],
            ["ground raised, ", withRises(room, seed)],
          ] as const) {
            if (!start) continue;
            // On raised ground a walk on the ground too, where a stop can land the holder squeezed on lower ground.
            for (const [up, down] of ahead === "ground raised, " ? [[0, 0] as const, ...HEIGHTS] : HEIGHTS) {
              const { state: s, op } = withStop(raised(start, up, down), seed);
              for (const [who, actor] of [
                ["Pat", P1],
                ["the DM", DM],
              ] as const) {
                if (!canApply(op, actor, s, { canUseAsset: () => true }).ok) continue;
                const cut = planTrapMove(op, s, actor, {}).op;
                if (cut === op) continue;
                cuts++;
                const r = applyOp(s, op, actor, env(5));
                assert.ok(r.ok);
                checked += levelWithHolders(s, cut, r.state, actor, `${kind}seed ${seed}, ${ahead}${up} to ${down} ft, ${who}`);
              }
            }
          }
        }
      }
      assert.ok(cuts >= 800 && checked >= 1200, `cuts ${cuts}, walks checked ${checked}`);
    });

    test("a full-size warhorse beside the keep's mouth with ground raised round it, Bree riding, the goblin she or the warhorse drags and a rat behind it or not, on their ground or level with the warhorse, walking into the corridor onto the ground: after every trap cut each walk hex by hex stands level with its holder where the cut leaves that, and every token where the trap step lands it (review HEXFILE-ASTRA-6)", () => {
      let cuts = 0;
      let checked = 0;
      const shape = g.orient === "rows" ? "hexRows" : "hexColumns";
      for (const at of [
        { col: 5, row: 6 },
        { col: 5, row: 5 },
        { col: 4, row: 6 },
        { col: 5, row: 7 },
      ]) {
        const { path } = keepOf(g, 0, 0, "bree");
        // One hex raised 10 ft under the warhorse, beside it or on the corridor's first hexes, or two beside it.
        const near = new Map<string, Hex>();
        for (const h of occupiedHexes(g, onHex(g, "horse", "large", at))) for (const n of [h, ...hexNeighbors(g, h)]) near.set(hexKey(n), n);
        for (const h of path.slice(0, 3)) near.set(hexKey(h), h);
        for (const rises of [...[...near.values()].map((h) => [h]), [{ col: 5, row: 7 }, { col: 8, row: 7 }]]) {
          for (const by of ["bree", "horse"] as const) {
            for (const rat of [false, true]) {
              for (const level of [false, true]) {
                for (const t of [1, 2, 3]) {
                  let s = keepOf(g, 0, 0, "bree").s;
                  for (const h of rises) {
                    const r = applyOp(s, { t: "build.height", sceneId: "s1", cells: [hexKey(h)], height: 10 }, DM, env(1));
                    assert.ok(r.ok);
                    s = r.state;
                  }
                  const horse = onHex(g, "horse", "large", at, { name: "Warhorse", kind: "npc", ownerIds: ["p1"] });
                  const up = footprintGround(s.buildChunks, horse);
                  const on = (t: Token) => ({ ...t, elevation: level ? up : footprintGround(s.buildChunks, t) });
                  s.tokens = {
                    horse: { ...horse, elevation: up },
                    bree: { ...onHex(g, "bree", "medium", at, { name: "Bree", kind: "pc", ownerIds: ["p1"], attached: { to: "horse", kind: "ride", steer: true } }), elevation: up },
                    gob: on(onHex(g, "gob", "medium", at, { name: "Goblin", kind: "npc", ownerIds: ["p1"], attached: { to: by, kind: "drag" } })),
                    ...(rat ? { rat: on(onHex(g, "rat", "tiny", at, { name: "Rat", kind: "npc", ownerIds: ["p1"], attached: { to: "gob", kind: "drag" } })) } : {}),
                  };
                  if (!Object.values(s.tokens).every((x) => !x!.attached || linkHolds(g, s.meta.settings, x!.attached.kind, x!, s.tokens[x!.attached.to]!))) continue;
                  s.traps.stop = trap("stop", { grid: shape, zone: { cells: [{ x: path[t]!.col, y: path[t]!.row, w: 1, h: 1 }] }, rig: { on: ["enter"], who: "any", floor: false, resets: "never", stops: true, foundOnSpring: true, hits: "trigger", actions: [], find: [], notice: false } });
                  const way = wayInto(g, s, path[4]!);
                  if (!way) continue;
                  const op = { ...way, elevation: 0 };
                  for (const [who, actor] of [
                    ["Pat", P1],
                    ["the DM", DM],
                  ] as const) {
                    if (!canApply(op, actor, s, { canUseAsset: () => true }).ok) continue;
                    const cut = planTrapMove(op, s, actor, {}).op;
                    if (cut === op) continue;
                    cuts++;
                    const r = applyOp(s, op, actor, env(5));
                    assert.ok(r.ok);
                    const where = `the warhorse on ${at.col}, ${at.row}, raised ${rises.map((h) => `${h.col}, ${h.row}`).join(" and ")}, dragged by ${by}${rat ? ", a rat" : ""}${level ? ", level" : ""}, the trap on hex ${t}, ${who}`;
                    checked += levelWithHolders(s, cut, r.state, actor, where);
                    for (const [id, pose] of trapLandings(op, s, actor, {})) {
                      const stored = r.state.tokens[id]!;
                      assert.ok(Math.abs(stored.elevation - pose.elevation) < 1e-9, `${where}: ${id} stored at ${stored.elevation}, landed at ${pose.elevation}`);
                    }
                  }
                }
              }
            }
          }
        }
      }
      assert.ok(cuts >= 1800 && checked >= 2700, `cuts ${cuts}, walks checked ${checked}`);
    });

    test("every walk the move takes along by its holder's moments, of every kind (in the file or too big for it, seen or hidden, ridden, dragged, at the end of a chain, seen under a hidden holder, flying or on raised ground), for Pat and for the DM: at every moment the trap step has it where the move has it, the area sweep's height, its place on its own points and where it waits on its last, an area's hits reading it there, and its triggers read each spot at that height (review HEXFILE-OPUS-11, HEXFILE-OPUS-12, HEXFILE-ASTRA-7)", () => {
      // Where the trap step and the move may differ by design, each excluded by its rule alone:
      // - a walk with no moments of its own (no `along`: the lead, what rides it, one dragged by its place, every walk before op
      //   62) is read spot by spot at its group's step (5.6), its spots on the ground its trace reads, as before op 62, which the
      //   op 61 differential keeps.
      // - between its own points the trap step has a walk on its latest one (5.6), where the move's leg and the sweep's hex line have
      //   it partway, so its place is compared at its own points' moments and once it waits on its last.
      // - a walk that ends where it started, neither in the file nor carrying one there (moveLeg.ts walkedIn): the move writes none
      //   of it, and neither the area sweep nor the trap step reads it, as before op 62.
      // - a stop's poses (stoodAt, stoppedAt): trapMoments reads every moment before any stop, so FU45B-ASTRA-06's stood-at height for
      //   one that never left its start and FU45B-ASTRA-10/11's kept walks and seats are the stop oracle's (`levelWithHolders`) and
      //   the landings', which read them against the stored room.
      const kinds = new Map<string, number>();
      const count = (kind: string) => kinds.set(kind, (kinds.get(kind) ?? 0) + 1);
      const differences: string[] = [];
      let different = 0;
      const differ = (what: string) => {
        if (different++ < 5) differences.push(what);
      };
      let moments = 0;
      let placed = 0;
      let moving = 0;
      let spots = 0;
      for (const [kind, made] of [
        ["", caseOf],
        ["inside ", insideCaseOf],
      ] as const) {
        for (let seed = 1; seed <= 300; seed++) {
          const room = made(seed, g);
          if (!room) continue;
          const ogre = withOgre(room, seed);
          for (const [variant, start] of [
            ["", room],
            ["imp ahead, ", withImpAhead(room, seed)],
            ["mouse in tow, ", withMouse(room, seed)],
            ["ogre in tow, ", ogre],
            ["ground raised, ", withRises(room, seed)],
            ["ogre on raised ground, ", ogre && withRises(ogre, seed)],
          ] as const) {
            if (!start) continue;
            const rises = variant.endsWith("raised ground, ") || variant === "ground raised, ";
            for (const [up, down] of rises ? [[0, 0] as const, ...HEIGHTS] : HEIGHTS) {
              const { state: s, op } = raised(start, up, down);
              for (const [who, actor] of [
                ["Pat", P1],
                ["the DM", DM],
              ] as const) {
                const walks = planWalks(op, s, actor, {});
                const at = trapMoments(op, s, actor, {});
                const trapped = trapWalks(op, s, actor, {});
                const heights = trapSpotHeights(op, s, actor, {});
                const all = trapped.flatMap((w) => w.spots.map((p) => p.progress));
                const walked = walkedIn(walks);
                for (const m of walks) {
                  if (!m.along || !walked(m)) continue;
                  const token = s.tokens[m.tokenId]!;
                  const holder = s.tokens[m.carriedBy!]!;
                  const link = token.attached!.kind;
                  for (const [yes, name] of [
                    [m.file === true, "in the file"],
                    [m.file !== true, "out of the file"],
                    [token.visibility === "dm", "hidden"],
                    [token.size === "large" || token.size === "huge" || token.size === "gargantuan", "Large or bigger"],
                    [onHolder(link), "riding or carried"],
                    [link === "drag", "dragged"],
                    [m.carriedBy !== op.tokenId, "in a chain"],
                    [token.visibility !== "dm" && holder.visibility === "dm", "seen under a hidden holder"],
                    [up > 0 || down > 0, "flying"],
                    [rises, "on raised ground"],
                    [actor === P1, "Pat's"],
                    [actor === DM, "the DM's"],
                  ] as const) {
                    if (yes) count(name);
                  }
                  // The first point of the run it ends on, where it reaches its last place, its start for one that never leaves it.
                  let k = m.route.length - 1;
                  while (k > 0 && m.route[k - 1]!.x === m.route[k]!.x && m.route[k - 1]!.y === m.route[k]!.y) k--;
                  const reached = m.along[k]!;
                  const own = new Set(m.along.map((p) => p.join("/")));
                  const where = (p: readonly number[]) => `${kind}seed ${seed}, ${variant}${up} to ${down} ft, ${who}, ${m.tokenId} at ${p.join("/")}`;
                  for (const p of all) {
                    const want = pointAt(m.route, p, m.along);
                    const t = at(p)[m.tokenId]!;
                    moments++;
                    if (Math.abs(t.elevation - want.elevation) > 1e-9) differ(`${where(p)}: the trap step at ${t.elevation} ft, the move at ${want.elevation} ft`);
                    if (own.has(p.join("/")) || compareAlong(p, reached) >= 0) {
                      placed++;
                      if (Math.abs(t.x - want.x) > 1e-9 || Math.abs(t.y - want.y) > 1e-9) differ(`${where(p)}: the trap step at ${t.x}, ${t.y}, the move at ${want.x}, ${want.y}`);
                    }
                    // Where the move has it still coming down or going up there, a sphere round that height catches it.
                    if (Math.abs(want.elevation - m.route[m.route.length - 1]!.elevation) < 1e-6) continue;
                    moving++;
                    const ball = trap("ball", { grid: g.orient === "rows" ? "hexRows" : "hexColumns", rig: { on: ["enter"], who: "any", floor: false, resets: "never", stops: false, foundOnSpring: true, hits: { area: { ...ballAt(g, t, want.elevation + 0.5) } }, actions: [], find: [], notice: false } });
                    if (!trapHits(ball, { ...s, tokens: at(p) }, []).includes(m.tokenId)) differ(`${where(p)}: a sphere round ${want.elevation} ft misses it`);
                  }
                  const mine = trapped.find((w) => w.tokenId === m.tokenId)!;
                  mine.spots.forEach((spot, j) => {
                    spots++;
                    const want = pointAt(m.route, spot.progress, m.along).elevation;
                    const height = heights.get(m.tokenId)?.[j];
                    if (height === undefined || Math.abs(height - want) > 1e-9) differ(`${where(spot.progress)}: its triggers read spot ${j} at ${height} ft, the move has it at ${want} ft`);
                  });
                }
              }
            }
          }
        }
      }
      assert.deepEqual(differences, [], `${different} differences`);
      const counts = Object.fromEntries(kinds);
      assert.ok(moments >= 180000 && placed >= 120000 && moving >= 85000 && spots >= 38000, `moments ${moments}, places ${placed}, still moving ${moving}, spots ${spots}`);
      for (const [name, least] of KINDS) assert.ok((kinds.get(name) ?? 0) >= least, `walks ${name}: ${kinds.get(name) ?? 0}, ${JSON.stringify(counts)}`);
    });

    test("a rider dropped on a seat of her mount's stand (LP40-HEX-SEAT): at every corner of the mount's walk and at its end the trap step has every walk where the move has it, every token lands where the trap step had it, the rider sits there, and a hidden rider beside her changes no player's copy", () => {
      let moves = 0;
      let seated = 0;
      let corners = 0;
      let twins = 0;
      for (let seed = 1; seed <= 3000; seed++) {
        const room = caseOf(seed, g);
        if (!room) continue;
        const made = seatedMove(g, room, seed);
        if (!made) continue;
        const { state: s, op, rider } = made;
        for (const [who, actor] of [
          ["Pat", P1],
          ["the DM", DM],
        ] as const) {
          if (!canApply(op, actor, s, { canUseAsset: () => true }).ok) continue;
          const at = `${name} seed ${seed}, ${who}`;
          moves++;
          const walks = planWalks(op, s, actor, {});
          const lead = walks.find((m) => m.tokenId === "horse")!;
          const ridden = walks.find((m) => m.tokenId === rider)!;
          // The rule seats a rider every player sees for Pat, and any for the DM.
          if ((actor === DM || s.tokens[rider]!.visibility !== "dm") && planTrapMove(op, s, actor, {}).op === op) {
            assert.deepEqual([ridden.to.x, ridden.to.y], [op.seat!.x, op.seat!.y], `${at}: ${rider} sits where she was dropped`);
            seated++;
          }
          const moment = trapMoments(op, s, actor, {});
          for (let i = 0; i < lead.route.length; i++) {
            const p: readonly [number, number, number] = i === lead.route.length - 1 ? [i - 1, 1, 1] : [i, 0, 1];
            const tokens = moment(p);
            for (const m of walks) {
              if (m.along) continue;
              const want = m.route[Math.min(i, m.route.length - 1)]!;
              const t = tokens[m.tokenId]!;
              assert.deepEqual([t.x, t.y, Math.round(t.elevation * 1e9) / 1e9], [want.x, want.y, Math.round(want.elevation * 1e9) / 1e9], `${at}: ${m.tokenId} at the walk's point ${i}`);
            }
            corners++;
          }
          const r = applyOp(s, op, actor, env(5));
          assert.ok(r.ok, at);
          const cut = planTrapMove(op, s, actor, {}).op !== op;
          for (const [id, pose] of trapLandings(op, s, actor, {})) {
            // A passenger on a holder a cut lands squeezed short of its walk sits on the squeezed stand, where the trap step read it
            // at its walk's spot there, the gap older than op 51 `checkedMove` leaves too. Every other passenger, the seated rider
            // and what rides on her among them, lands where the trap step had it (review HEXOP-ASTRA-1).
            const link = s.tokens[id]!.attached;
            if (cut && link && onHolder(link.kind) && r.state.tokens[link.to]?.squeeze === true) continue;
            const t: Token = r.state.tokens[id]!;
            assert.deepEqual([t.x, t.y, t.elevation], [pose.x, pose.y, pose.elevation], `${at}: ${id} where the trap step left it`);
          }
          // The shown rider with and without a hidden rider beside her: the same copy for every player.
          if (actor !== P1 || s.tokens[rider]!.visibility === "dm") continue;
          const twin = riderTwins(g, fogged(s));
          if (!twin) continue;
          const a = applyOp(structuredClone(twin.alone), op, P1, env(5));
          const b = applyOp(structuredClone(twin.beside), op, P1, env(5));
          assert.equal(a.ok, b.ok, `${at}: the answer with the hidden rider`);
          if (!a.ok || !b.ok) continue;
          assert.deepEqual(copies(b.state, twin.alone), copies(a.state, twin.alone), `${at}: every player's copy with the hidden rider`);
          twins++;
        }
      }
      // About 640 to 700 moves on each layout, 575 to 640 seated, 230 to 265 twins.
      assert.ok(moves >= 500 && seated >= 450 && corners >= 1100 && twins >= 180, `moves ${moves}, seated ${seated}, corners ${corners}, twins ${twins}`);
    });
  });
}
