import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { heights, wall } from "../discoveryTestutil.ts";
import type { RoomState, Token, Viewer } from "../model.ts";
import { canApply } from "../permissions.ts";
import { projectState, stableStringify } from "../project.ts";
import type { Op, OpOf } from "../protocol.ts";
import { applyOp } from "../reducer.ts";
import { movementRules } from "../ruleHooks.ts";
import { offGridWallThrough, ownWalk, walkEnd } from "../rules/movement.ts";
import { linkHolds, onHolder } from "../rules/attach.ts";
import { footprintRect } from "../rules/footprint.ts";
import { SQUARES } from "../rules/grid.ts";
import { planWalks, walkedIn } from "../rules/moveLeg.ts";
import { planTrapMove, trapLandings, trapWalks } from "../rules/traps.ts";
import { chance, env, int, member, P1, P2, pick, rng, room, scene, token, trap } from "../testutil.ts";

/**
 * Random walks in single file aimed at one class of case (review
 * FU45B-ASTRA-06 to 08): a creature in the file whose walk ends where it
 * started, as on a loop, or that has not moved yet where a trap cuts the
 * walk, is walked like any other. Loops out of a corridor one square wide
 * and back in, followers placed on the holder's first corner so their
 * first piece has no length, carried chains (an imp carrying an owl that
 * drags a rat), creatures players cannot see, raised ground, stopping
 * traps and floor traps. For every move the server takes: every walk of a
 * creature every player sees in the file passes the leg test, on the cut
 * walk too, dispatch puts every token where the trap step's walks had it,
 * every walk of the group is in the lead's trap group, every link the
 * public pass walks holds, and every token every player sees stands where
 * the move's own stand test lets it stand (review FU45B-ASTRA-10), and
 * every link between two tokens every player sees that holds where the
 * trap step leaves them still holds (review FU45B-ASTRA-11). A second loop
 * does the same for group moves of two groups, a trap stopping one, both
 * or neither, toward a wall: a Large creature every player sees half a
 * square off its grid, dragged by a creature they may not see (review
 * FU45BR-OPUS-12), a Tiny one carried or perched in the middle of a chain,
 * and a goblin riding a Large horse, each holder hidden on most seeds.
 * Each case with a creature players cannot see is also played in two
 * fogged rooms, the second with short walls no player sees near the hidden
 * walks, and every player's copy and the undo mark must match
 * (`pairedTwin`, review FU45B-ASTRA-12), the tokens players see under a
 * hidden holder left out where those walls change a hidden walk (review
 * FU45BR-OPUS-13).
 */

/** A corridor one square wide along row 6, from x 6 to 14, its mouth to the west. */
function corridor(): RoomState {
  const s = room({ members: { dm1: member("dm1", "dm"), p1: member("p1"), p2: member("p2") }, scenes: { s1: scene("s1", { bounds: { w: 22, h: 12 }, blockMovement: true, autoWalls: "off" }) } });
  s.buildChunks = {};
  const runs: [[number, number], [number, number]][] = [[[6, 0], [6, 6]], [[6, 7], [6, 12]], [[14, 0], [14, 6]], [[14, 7], [14, 12]], [[6, 6], [14, 6]], [[6, 7], [14, 7]]];
  runs.forEach(([a, b], i) => wall(s, `fu45bl${String(i).padStart(6, "0")}`, a, b));
  return s;
}

type Case = { state: RoomState; op: OpOf<"token.move"> };

function caseOf(seed: number): Case | null {
  const r = rng(seed * 7727 + 11);
  const s = corridor();
  // Squeezed in the corridor, or west of it in the open.
  const inside = chance(r, 0.6);
  const hx = inside ? pick(r, [7.5, 8.5, 9.5, 10.5]) : int(r, 1, 3);
  const hy = inside ? 5.5 : int(r, 3, 6);
  s.tokens.horse = token("horse", { size: "large", x: hx, y: hy, name: "Warhorse", kind: "npc", ownerIds: ["p1"], ...(inside ? { squeeze: true as const } : {}) });
  // The walk: out of the corridor's mouth from inside it, to a corner or two west of it, then into it, ending squeezed, often back
  // where it started.
  const corners: [number, number][] = inside ? [[5, 5.5]] : [];
  for (let k = int(r, 1, 2); k > 0; k--) corners.push([int(r, 0, 8) / 2, int(r, 6, 16) / 2]);
  const end: [number, number] = inside && chance(r, 0.7) ? [hx, hy] : [pick(r, [7.5, 8.5, 9.5, 10.5, 11.5]), 5.5];
  const route: [number, number, number, 0 | 1][] = [...corners, [Math.min(end[0], 5), 5.5] as [number, number], end].map(([x, y]) => [x, y, 1, 0]);
  const first = route[0]!;
  // Followers: in the corridor behind a horse squeezed in it, where a loop back leaves them where they started; else some on the
  // walk's first corner, so their first piece in the file has no length, and the rest beside the horse.
  let behind = Math.floor(hx) + 1;
  const near = (big: boolean): [number, number] => {
    if (inside) return big ? [(behind -= 2) + 0.5, 5.5] : [(behind -= 1), 6];
    if (chance(r, 0.3)) return [first[0] + (big ? 0 : 0.5), first[1] + (big ? 0 : 0.5)];
    const side = pick(r, [[-1, 0], [2, 0], [0, -1], [0, 2], [-1, 1]] as const);
    return [Math.floor(hx) + side[0], Math.floor(hy) + side[1]];
  };
  const hidden = (): Partial<Token> => (chance(r, 0.25) ? { visibility: "dm" } : {});
  const lifted = (): Partial<Token> => (chance(r, 0.2) ? { elevation: 5 } : {});
  const [ix, iy] = near(false);
  s.tokens.imp = token("imp", { x: ix, y: iy, name: "imp", kind: "npc", attached: { to: "horse", kind: "drag" }, ...hidden(), ...lifted() });
  if (chance(r, 0.6)) {
    s.tokens.owl = token("owl", { size: "tiny", x: ix, y: iy, elevation: s.tokens.imp.elevation, name: "owl", kind: "npc", attached: { to: "imp", kind: "carry" }, ...hidden() });
    if (chance(r, 0.7)) {
      const [rx, ry] = inside ? near(false) : [ix - 1, iy];
      s.tokens.rat = token("rat", { x: rx, y: ry, name: "rat", kind: "npc", attached: { to: "owl", kind: "drag" }, ...hidden() });
    }
  }
  if (chance(r, 0.4)) {
    const big = chance(r, 0.3);
    const [ox, oy] = near(big);
    // Dragged by the horse, or by the last in line, which keeps it in reach of its own holder in the corridor.
    const by = inside ? (s.tokens.rat ? "rat" : "imp") : chance(r, 0.5) ? "imp" : "horse";
    s.tokens.ogre = token("ogre", { size: big ? "large" : "medium", x: ox, y: oy, name: "ogre", kind: "npc", attached: { to: by, kind: "drag" }, ...hidden(), ...lifted() });
  }
  // Traps on the way: one that stops a walk, and some on the floor, at cells the walk passes.
  const cells = [...route.map(([x, y]) => [Math.floor(x), Math.floor(y)]), [Math.floor(hx), Math.floor(hy)]];
  for (let k = int(r, 1, 3); k > 0; k--) {
    const [cx, cy] = pick(r, cells)!;
    const dx = int(r, -1, 1);
    const stops = k === 1 && chance(r, 0.7);
    s.traps[`t${k}`] = trap(`t${k}`, { zone: { cells: [{ x: cx! + dx, y: cy! + int(r, 0, 1), w: 1, h: stops ? 2 : 1 }] }, rig: { on: ["enter"], who: pick(r, ["any", "others"] as const), floor: true, resets: "never", stops, foundOnSpring: true, hits: "trigger", actions: [], find: [], notice: false } });
  }
  if (chance(r, 0.3)) heights(s, { x: int(r, 0, 4), y: int(r, 3, 8), w: int(r, 1, 3), h: 1 }, pick(r, [2, 5]));
  const holds = Object.values(s.tokens).every((t) => !t!.attached || linkHolds(SQUARES, s.meta.settings, t!.attached.kind, t!, s.tokens[t!.attached.to]!));
  if (!holds) return null;
  return { state: s, op: { t: "token.move", tokenId: "horse", x: end[0], y: end[1], squeeze: true, route } };
}

/**
 * Whether each token every player sees lands where the move's own stand test lets it stand full size (movement.ts
 * offGridWallThrough, migrate.ts stopsStandClear): its box off its grid crosses no wall, but in a real narrow space.
 */
function standsClear(before: RoomState, after: RoomState, at: string): void {
  for (const t of Object.values(after.tokens)) {
    if (!t || t.visibility === "dm" || t.squeeze === true) continue;
    const from = before.tokens[t.id]!;
    assert.equal(offGridWallThrough(after, walkEnd(after, ownWalk({ ...t, x: from.x, y: from.y, elevation: from.elevation }), t)), false, `${at}: ${t.id} stands at ${t.x}, ${t.y} with a wall through its box`);
  }
}

/**
 * Whether every link between two tokens every player sees that holds where
 * the trap step leaves them (`trapLandings`) still holds after the move
 * (review FU45B-ASTRA-11).
 */
function linksKept(before: RoomState, landed: ReadonlyMap<string, { x: number; y: number; elevation: number }>, after: RoomState, at: string): void {
  const poseOf = (id: string): Token => ({ ...before.tokens[id]!, ...landed.get(id) });
  for (const t of Object.values(before.tokens)) {
    const link = t?.attached;
    if (!t || !link || t.visibility === "dm" || before.tokens[link.to]!.visibility === "dm") continue;
    if (!linkHolds(SQUARES, before.meta.settings, link.kind, poseOf(t.id), poseOf(link.to))) continue;
    assert.equal(after.tokens[t.id]!.attached?.to, link.to, `${at}: ${t.id} still held by ${link.to}`);
  }
}

/**
 * Whether every seat holds after the move, seen or not: what is carried,
 * perched or rides keeps its seat on a walk, a cut too, since a holder
 * players cannot see that seats one they see walks at its step and a cut
 * keeps its walk, stopped where the seat holds (traps.ts seatsOfSeen and
 * seatingWalk, review FU45B-ASTRA-11). The one exception: one every player
 * sees, on a holder they cannot see, that a trap's cut lands where the stop
 * judged it, where no spot of the holder's own walk seats it, lets go
 * (D-261101-403, review FU45B-ASTRA-12). `landed` is where the trap step
 * leaves each token.
 */
function seatsKept(before: RoomState, landed: ReadonlyMap<string, unknown>, after: RoomState, at: string): void {
  for (const t of Object.values(before.tokens)) {
    const link = t?.attached;
    if (!t || !link || !onHolder(link.kind)) continue;
    if (after.tokens[t.id]!.attached?.to !== link.to && t.visibility !== "dm" && before.tokens[link.to]!.visibility === "dm" && landed.has(t.id)) continue;
    assert.equal(after.tokens[t.id]!.attached?.to, link.to, `${at}: ${t.id} still on ${link.to}`);
  }
}


/** Every player's copy of the scene, a player at a time. */
function copies(s: RoomState, viewers: readonly Viewer[] = [P1, P2]): string[] {
  return viewers.map((v) => stableStringify(projectState(s, v, { sceneId: "s1" })));
}

/** The plan's walks as plain points, to compare two rooms' plans. */
function walksOfPlan(op: Op, s: RoomState): string {
  return JSON.stringify(planWalks(op, s, P1, {}).map((m) => [m.tokenId, m.pass, m.route.map((p) => [p.x, p.y, p.elevation])]));
}

/** The tokens players see that a holder they cannot see carries, drags or seats, at any depth up the chain of holders. */
function underHidden(s: RoomState): Set<string> {
  const out = new Set<string>();
  for (const t of Object.values(s.tokens)) {
    if (!t || t.visibility === "dm") continue;
    const seen = new Set<string>();
    for (let up = t.attached ? s.tokens[t.attached.to] : undefined; up && !seen.has(up.id); up = up.attached ? s.tokens[up.attached.to] : undefined) {
      seen.add(up.id);
      if (up.visibility === "dm") {
        out.add(t.id);
        break;
      }
    }
  }
  return out;
}

/** Every player's copy of the scene without the tokens `left` names, a player at a time. */
function copiesWithout(s: RoomState, left: ReadonlySet<string>): string[] {
  return [P1, P2].map((v) => {
    const copy = projectState(s, v, { sceneId: "s1" });
    const tokens = Object.fromEntries(Object.entries(copy.tokens).filter(([id]) => !left.has(id)));
    return stableStringify({ ...copy, tokens });
  });
}

/** What `pairedTwin` compared: the twin whose walks matched, cut by a trap or whole, and how many twins whose walls changed a hidden walk. */
type Twins = { kept: "cut" | "whole" | null; changed: number };

/**
 * The paired rooms of a case with creatures players cannot see (review
 * FU45B-ASTRA-12): the room fogged, so players see none of its ground,
 * every token they see still seen through the fog, and a twin with a few
 * short walls on that unseen ground near the walks of the creatures they
 * cannot see. Where the twin's walls leave every walk of the move as it
 * was, every player's copy, the log in it, and the undo mark must be the
 * same in both rooms: those walls are a fair test of what the trap step
 * and its cut read. The first such twin is `kept`.
 *
 * Walls that do change a walk are compared too (review FU45BR-OPUS-13),
 * by the reveal's closure. A hidden walk those walls stop can move what
 * that walker carries, drags or seats, which players may see (the private
 * pass's own reveal, 8.0 and D-261101-274), and so on down the chain. So
 * the tokens players see under a holder they cannot see are left out, and
 * every other part of each player's copy must match. That holds only where
 * neither room is cut by a trap: a stop is judged where every walker of
 * the group stands, so a seen walker landing elsewhere under its hidden
 * holder can move where the whole group stops, the same accepted reveal
 * reaching the lead. A cut twin of this kind is not compared. Null `kept`
 * where no fair twin was found or the server refuses the move.
 */
function pairedTwin(state: RoomState, op: Op, r: () => number, at: string): Twins {
  const none: Twins = { kept: null, changed: 0 };
  if (!Object.values(state.tokens).some((t) => t?.visibility === "dm")) return none;
  const base = structuredClone(state);
  base.scenes.s1 = { ...base.scenes.s1!, fogEnabled: true };
  for (const t of Object.values(base.tokens)) if (t && t.visibility !== "dm") base.tokens[t.id] = { ...t, fogExempt: true };
  if (!canApply(op, P1, base, { canUseAsset: () => true }).ok) return none;
  const plan = walksOfPlan(op, base);
  const hidden = planWalks(op, base, P1, {}).filter((m) => base.tokens[m.tokenId]?.visibility === "dm");
  if (hidden.length === 0) return none;
  const under = underHidden(base);
  const baseCut = planTrapMove(op, base, P1, {}).op !== op;
  const a = applyOp(structuredClone(base), op, P1, env(5));
  assert.ok(a.ok, at);
  const after = { copies: copies(a.state), without: copiesWithout(a.state, under), trapped: a.trapped };
  const q = (v: number) => Math.round(v * 8) / 8;
  let changed = 0;
  for (let attempt = 0; attempt < 4; attempt++) {
    const twin = structuredClone(base);
    for (let k = 0, n = int(r, 1, 3); k < n; k++) {
      const m = pick(r, hidden);
      const p = pick(r, m.route);
      const x = q(p.x + (r() * 2 - 0.5));
      const y = q(p.y + (r() * 2 - 0.5));
      const len = pick(r, [0.25, 0.375, 0.5]);
      wall(twin, `fu45bp${String(attempt * 10 + k).padStart(6, "0")}`, [x, y], chance(r, 0.5) ? [x + len, y] : [x, y + len]);
    }
    if (!canApply(op, P1, twin, { canUseAsset: () => true }).ok) continue;
    assert.deepEqual(copies(twin), copies(base), `${at}: the players' copies start the same`);
    if (walksOfPlan(op, twin) !== plan) {
      if (baseCut || planTrapMove(op, twin, P1, {}).op !== op) continue;
      const b = applyOp(structuredClone(twin), op, P1, env(5));
      assert.ok(b.ok, at);
      const [pa, pb] = [after.without, copiesWithout(b.state, under)];
      assert.equal(pb[0], pa[0], `${at}: Pat's copy with walls he cannot see that change a hidden walk, tokens under a hidden holder left out`);
      assert.equal(pb[1], pa[1], `${at}: the other player's copy with walls they cannot see that change a hidden walk, tokens under a hidden holder left out`);
      assert.equal(b.trapped, after.trapped, `${at}: the undo mark with walls that change a hidden walk`);
      changed++;
      continue;
    }
    const b = applyOp(structuredClone(twin), op, P1, env(5));
    assert.ok(b.ok, at);
    const [pa, pb] = [after.copies, copies(b.state)];
    assert.equal(pb[0], pa[0], `${at}: Pat's copy with walls he cannot see`);
    assert.equal(pb[1], pa[1], `${at}: the other player's copy with walls they cannot see`);
    assert.equal(b.trapped, after.trapped, `${at}: the undo mark`);
    return { kept: baseCut ? "cut" : "whole", changed };
  }
  return { kept: null, changed };
}

describe("squares: random loops and cuts in single file (review FU45B-ASTRA-06 to 08)", () => {
  test("seed 2082: an owl every player sees on a hidden imp in the file steps back off the horse it stood on, on its seat, and the horse the stop squeezes onto raised ground lands as the trap step has it (TRAP-STOP-STACK)", () => {
    const { state: s, op } = caseOf(2082)!;
    const r = applyOp(s, op, P1, env(5));
    assert.ok(r.ok);
    const [horse, owl] = [r.state.tokens.horse!, r.state.tokens.owl!];
    assert.equal(horse.squeeze, true, "squeezed at the corridor's mouth, short of its walk's end");
    for (const [id, pose] of trapLandings(op, s, P1, {})) assert.deepEqual([r.state.tokens[id]!.x, r.state.tokens[id]!.y, r.state.tokens[id]!.elevation], [pose.x, pose.y, pose.elevation], `${id} where the trap step left it`);
    const [hb, ob] = [footprintRect(SQUARES, horse), footprintRect(SQUARES, owl)];
    assert.ok(ob.x >= hb.x + hb.w || ob.x + ob.w <= hb.x || ob.y >= hb.y + hb.h || ob.y + ob.h <= hb.y, `the owl at ${owl.x}, ${owl.y} off the horse's square at ${hb.x}, ${hb.y}`);
    assert.deepEqual([owl.attached?.to, r.state.tokens.rat!.attached?.to], ["imp", "owl"], "still on the imp, the rat in its reach");
  });

  test("every creature in the file is walked alike, moved or not: walls, the trap step's poses, its groups and links", () => {
    let taken = 0;
    let loops = 0;
    let cuts = 0;
    let still = 0;
    let twins = 0;
    let twinCuts = 0;
    let changedTwins = 0;
    for (let seed = 1; seed <= 1500; seed++) {
      const made = caseOf(seed);
      if (!made) continue;
      const { state: s, op } = made;
      if (!canApply(op, P1, s, { canUseAsset: () => true }).ok) continue;
      taken++;
      const at = `seed ${seed}: ${JSON.stringify(op)}`;
      const horse = s.tokens.horse!;
      if (op.x === horse.x && op.y === horse.y) loops++;
      const walks = planWalks(op, s, P1, {});
      const walked = walkedIn(walks, undefined);
      if (walks.some((m) => m.carriedBy !== undefined && walked(m) && m.from.x === m.to.x && m.from.y === m.to.y && m.from.elevation === m.to.elevation)) still++;
      // The walk dispatch moves, cut where a trap stops it: each walk every player sees in it passes the leg test.
      const cut = planTrapMove(op, s, P1, {}).op;
      if (cut !== op) cuts++;
      const cutWalks = planWalks(cut, s, P1, {});
      const cutWalked = walkedIn(cutWalks, undefined);
      for (const m of cutWalks) {
        if (m.carriedBy === undefined || m.pass !== "public" || !cutWalked(m) || s.tokens[m.tokenId]?.attached?.kind !== "drag") continue;
        for (let i = 1; i < m.route.length; i++) assert.equal(movementRules.legBlocker(s, m.trace[i - 1]!, { ...m.route[i]!, squeeze: false }), null, `${at}: ${m.tokenId} leg ${i}`);
      }
      // Every walk of the group is in the horse's trap group, whether it moved or not.
      for (const w of trapWalks(op, s, P1, {})) assert.equal(w.group, "horse", `${at}: ${w.tokenId}'s trap group`);
      // Dispatch puts each token where the trap step's walks left it.
      const r = applyOp(s, op, P1, env(5));
      assert.ok(r.ok, at);
      const landed = trapLandings(op, s, P1, {});
      for (const [id, pose] of landed) {
        const t: Token = r.state.tokens[id]!;
        assert.deepEqual([t.x, t.y, t.elevation], [pose.x, pose.y, pose.elevation], `${at}: ${id} where the trap step left it`);
      }
      standsClear(s, r.state, at);
      linksKept(s, landed, r.state, at);
      seatsKept(s, landed, r.state, at);
      const paired = pairedTwin(s, op, rng(seed * 104729 + 3), at);
      if (paired.kept) twins++;
      if (paired.kept === "cut") twinCuts++;
      changedTwins += paired.changed;
      // Every link the public pass walks holds: one under a holder players cannot see may let go, unread (D-261101-397).
      for (const m of walks) {
        const link = s.tokens[m.tokenId]!.attached;
        if (!link || m.pass !== "public") continue;
        assert.equal(r.state.tokens[m.tokenId]!.attached?.to, link.to, `${at}: ${m.tokenId} still held`);
      }
    }
    // Enough of the class that the rules above meet it: moves taken, loops back to the start, trap cuts, and creatures walked that
    // end where they started.
    assert.ok(taken >= 900, `moves taken: ${taken}`);
    assert.ok(loops >= 500, `loops: ${loops}`);
    assert.ok(cuts >= 430, `trap cuts: ${cuts}`);
    assert.ok(still >= 470, `walked, ending where they started: ${still}`);
    // Fogged twins with unseen walls compared, and of them cut by a trap: few, since off the ground players see a stop stands only
    // where the walk itself went, and the group moves below cut most of theirs.
    assert.ok(twins >= 350, `twins compared: ${twins}`);
    assert.ok(twinCuts >= 5, `twins cut by a trap: ${twinCuts}`);
    // Twins whose walls change a hidden walk and that neither room cuts: few, since walls near the hidden walks of a file mostly
    // meet the holder's own line, so the server refuses the move.
    assert.ok(changedTwins >= 5, `twins with a hidden walk changed, uncut: ${changedTwins}`);
  });

  test("a group move a trap cuts lands each group's walks as the trap step judged them, a group it never stopped as any move, and none across a wall (review FU45BR-OPUS-12, FU45B-ASTRA-10 and 11)", () => {
    let taken = 0;
    let cuts = 0;
    let oneStopped = 0;
    let ownJudged = 0;
    let carried = 0;
    let ridden = 0;
    let twins = 0;
    let twinCuts = 0;
    let changedTwins = 0;
    const hidden = { visibility: "dm" as const };
    for (let seed = 1; seed <= 3000; seed++) {
      const r = rng(seed * 6007 + 5);
      const s = room({ members: { dm1: member("dm1", "dm"), p1: member("p1"), p2: member("p2") }, scenes: { s1: scene("s1", { bounds: { w: 30, h: 20 }, blockMovement: true, autoWalls: "off" }) } });
      s.buildChunks = {};
      // A wall ahead of the first fighter's walk, which a Large creature it takes along half a square off the grid can stand across.
      const wx = int(r, 20, 22);
      wall(s, "fu45bm000000", [wx, int(r, 13, 14)], [wx, 16]);
      s.tokens.pc = token("pc", { x: 16, y: 13, name: "Pc", kind: "pc", ownerIds: ["p1"] });
      const shape = pick(r, ["brute", "brute", "carried", "ridden"] as const);
      if (shape === "brute") {
        const viaRat = chance(r, 0.7);
        if (viaRat) s.tokens.rat = token("rat", { x: 15.5, y: 14, name: "Rat", kind: "npc", ownerIds: [], ...(chance(r, 0.7) ? hidden : {}), attached: { to: "pc", kind: "drag" } });
        s.tokens.brute = token("brute", { size: "large", x: pick(r, [16, 16.5]), y: 14, name: "Brute", kind: "npc", ownerIds: [], ...(chance(r, 0.2) ? hidden : {}), attached: { to: viaRat ? "rat" : "pc", kind: "drag" } });
      } else if (shape === "carried") {
        // A creature the fighter drags carries a Tiny one, or bears it perched, which drags a third on some seeds: a seat in the
        // middle of the chain (review FU45B-ASTRA-11).
        s.tokens.imp = token("imp", { x: 16, y: 14, name: "Imp", kind: "npc", ownerIds: [], ...(chance(r, 0.7) ? hidden : {}), attached: { to: "pc", kind: "drag" } });
        s.tokens.owl = token("owl", { size: "tiny", x: pick(r, [16, 16.5]), y: pick(r, [14, 14.5]), name: "Owl", kind: "npc", ownerIds: [], ...(chance(r, 0.2) ? hidden : {}), attached: { to: "imp", kind: pick(r, ["carry", "perch"] as const) } });
        if (chance(r, 0.7)) s.tokens.rat = token("rat", { x: 15, y: 14, name: "Rat", kind: "npc", ownerIds: [], ...(chance(r, 0.2) ? hidden : {}), attached: { to: "owl", kind: "drag" } });
      } else {
        // A Large horse the fighter drags, half a square off the grid on some seeds, with a goblin riding it that drags a rat on some.
        const hx = pick(r, [16, 16.5]);
        s.tokens.horse = token("horse", { size: "large", x: hx, y: 14, name: "Horse", kind: "npc", ownerIds: [], ...(chance(r, 0.7) ? hidden : {}), attached: { to: "pc", kind: "drag" } });
        const rx = hx + pick(r, [0, 1]);
        const ry = 14 + pick(r, [0, 1]);
        s.tokens.rider = token("rider", { x: rx, y: ry, name: "Rider", kind: "npc", ownerIds: [], ...(chance(r, 0.2) ? hidden : {}), attached: { to: "horse", kind: "ride" } });
        if (chance(r, 0.5)) s.tokens.rat = token("rat", { x: rx - 1, y: ry, name: "Rat", kind: "npc", ownerIds: [], ...(chance(r, 0.2) ? hidden : {}), attached: { to: "rider", kind: "drag" } });
      }
      // The second fighter walks elsewhere, into a trap that stops it on most seeds, with a goblin it drags on some.
      s.tokens.pc2 = token("pc2", { x: 2, y: 2, name: "Pc2", kind: "pc", ownerIds: ["p1"] });
      if (chance(r, 0.5)) s.tokens.gob = token("gob", { x: 1, y: 2, name: "Gob", kind: "npc", attached: { to: "pc2", kind: "drag" } });
      if (chance(r, 0.8)) s.traps.t1 = trap("t1", { zone: { cells: [{ x: int(r, 3, 7), y: 2, w: 1, h: 1 }] } });
      if (chance(r, 0.7)) s.traps.t2 = trap("t2", { zone: { cells: [{ x: int(r, 17, 21), y: int(r, 13, 15), w: 1, h: 1 }] }, rig: { on: ["enter"], who: "any", floor: true, resets: "never", stops: chance(r, 0.7), foundOnSpring: true, hits: "trigger", actions: [], find: [], notice: false } });
      const holds = Object.values(s.tokens).every((t) => !t!.attached || linkHolds(SQUARES, s.meta.settings, t!.attached.kind, t!, s.tokens[t!.attached.to]!));
      if (!holds) continue;
      const moves = [{ tokenId: "pc", x: int(r, 18, 21), y: 13 }, { tokenId: "pc2", x: 8, y: 2 }];
      const op: Op = { t: "token.moveMany", moves: chance(r, 0.5) ? moves : [moves[1]!, moves[0]!] };
      if (!canApply(op, P1, s, { canUseAsset: () => true }).ok) continue;
      taken++;
      const at = `seed ${seed}: ${JSON.stringify(op)}`;
      const cutOp = planTrapMove(op, s, P1, {}).op;
      if (cutOp !== op) cuts++;
      // The groups the trap stopped: those whose named token's move the cut changed.
      const stopped = new Set(op.t === "token.moveMany" && cutOp.t === "token.moveMany" ? op.moves.filter((m, k) => m.x !== cutOp.moves[k]!.x || m.y !== cutOp.moves[k]!.y).map((m) => m.tokenId) : []);
      const groupOf = new Map(trapWalks(op, s, P1, {}).map((w) => [w.tokenId, w.group]));
      for (const [id, group] of groupOf) assert.equal(group, id === "pc2" || id === "gob" ? "pc2" : "pc", `${at}: ${id}'s trap group`);
      const passOf = new Map(planWalks(op, s, P1, {}).map((m) => [m.tokenId, m.pass]));
      if (stopped.size === 1) oneStopped++;
      // One every player sees under a holder they cannot see walks a route of its own, which the stop judges where it leaves it,
      // dragged, carried or ridden.
      const seenUnderHidden = (id: string, holder: string) => s.tokens[id] !== undefined && s.tokens[id]!.visibility !== "dm" && s.tokens[holder]!.visibility === "dm" && passOf.get(id) === "private";
      if (stopped.has("pc") && shape === "brute" && seenUnderHidden("brute", s.tokens.brute!.attached!.to)) ownJudged++;
      if (stopped.has("pc") && shape === "carried" && seenUnderHidden("owl", "imp")) carried++;
      if (stopped.has("pc") && shape === "ridden" && seenUnderHidden("rider", "horse")) ridden++;
      const done = applyOp(s, op, P1, env(5));
      assert.ok(done.ok, at);
      const landed = trapLandings(op, s, P1, {});
      for (const [id, pose] of landed) {
        const t: Token = done.state.tokens[id]!;
        assert.deepEqual([t.x, t.y, t.elevation], [pose.x, pose.y, pose.elevation], `${at}: ${id} where the trap step left it`);
      }
      standsClear(s, done.state, at);
      linksKept(s, landed, done.state, at);
      seatsKept(s, landed, done.state, at);
      const paired = pairedTwin(s, op, rng(seed * 104729 + 7), at);
      if (paired.kept) twins++;
      if (paired.kept === "cut") twinCuts++;
      changedTwins += paired.changed;
    }
    // Enough of the class: group moves taken, cut by a trap, with one group stopped and the other not, and a stopped walker every
    // player sees on a walk of its own under a holder they cannot see, dragged, carried or ridden.
    assert.ok(taken >= 2000, `group moves taken: ${taken}`);
    assert.ok(cuts >= 1650, `cut by a trap: ${cuts}`);
    assert.ok(oneStopped >= 1400, `one group stopped, the other not: ${oneStopped}`);
    assert.ok(ownJudged >= 70, `one every player sees under a hidden holder, stopped: ${ownJudged}`);
    assert.ok(carried >= 45, `one every player sees carried by a hidden holder, stopped: ${carried}`);
    assert.ok(ridden >= 45, `one every player sees riding a hidden horse, stopped: ${ridden}`);
    assert.ok(twins >= 1500, `twins compared: ${twins}`);
    assert.ok(twinCuts >= 1200, `twins cut by a trap: ${twinCuts}`);
    assert.ok(changedTwins >= 200, `twins with a hidden walk changed, uncut: ${changedTwins}`);
  });
});
