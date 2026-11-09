import assert from "node:assert/strict";
import { test } from "node:test";
import fc from "fast-check";
import { ANA, ATTIC, BREE, GROUND, UPPER, onThornsTurn, putOp, run, tower, withStairs } from "./floorLinksTestutil.ts";
import { keys } from "./keys.ts";
import type { RoomState, Token, Viewer } from "./model.ts";
import { canApply } from "./permissions.ts";
import { projectEntity, stableStringify } from "./project.ts";
import { opSchema, type Op, type RestoreEntry } from "./protocol.ts";
import { applyOp } from "./reducer.ts";
import { floorProblem, floorsOf, heldFloors } from "./rules/floors.ts";
import { DM, env, token } from "./testutil.ts";

/*
 * Stairs and ladders as a state machine (docs/design/design-v1-floors.md
 * phase 2, 14): puts, locks, kinds, removals, climbs by the DM and by Ana,
 * Move to floor, walks, floors added, removed and reordered, ground raised,
 * walls and pits under ends, and undos, in random order. Each op the actor
 * would refuse by floorProblem is refused here too. After every step:
 *
 * 1. floorProblem holds on the tower, and every pair is whole: each end's
 *    pair crosses back, on the floor it names, with one rev and `made`.
 * 2. No end names a floor that is gone or no longer of the tower.
 * 3. No player gets an end on a floor they do not hold, or one naming such
 *    a floor in `to`.
 * 4. Ana's climb answers alike, and lands alike, whatever the far floor
 *    holds: a wall and a hidden creature on the landing's floor, and that
 *    floor's fog, change no refusal, word or pose.
 * 5. Within a turn, Thorn's Moved never drops when it climbs: the climb's
 *    feet add to what the turn took.
 */

const PLAYERS: readonly Viewer[] = [ANA, BREE];

type Act =
  | { k: "put"; from: number; up: boolean; x: number; y: number; w: number; h: number; ladder: boolean }
  | { k: "lock"; link: number; on: boolean }
  | { k: "kind"; link: number }
  | { k: "remove"; link: number }
  | { k: "climb"; link: number; dm: boolean }
  | { k: "walk"; x: number; y: number }
  | { k: "onto"; link: number }
  | { k: "moveTo"; floor: number }
  | { k: "add"; beside: number; above: boolean }
  | { k: "drop"; floor: number }
  | { k: "order"; turn: number }
  | { k: "raise"; floor: number; x: number; y: number }
  | { k: "wall"; floor: number; x: number; y: number }
  | { k: "pit"; floor: number; x: number; y: number }
  | { k: "undo" };

const n = fc.nat({ max: 40 });
const cell = fc.nat({ max: 7 });
const ACT: fc.Arbitrary<Act> = fc.oneof(
  { weight: 5, arbitrary: fc.record({ k: fc.constant("put" as const), from: n, up: fc.boolean(), x: cell, y: cell, w: fc.integer({ min: 1, max: 4 }), h: fc.integer({ min: 1, max: 4 }), ladder: fc.boolean() }) },
  { weight: 1, arbitrary: fc.record({ k: fc.constant("lock" as const), link: n, on: fc.boolean() }) },
  { weight: 1, arbitrary: fc.record({ k: fc.constant("kind" as const), link: n }) },
  { weight: 1, arbitrary: fc.record({ k: fc.constant("remove" as const), link: n }) },
  { weight: 5, arbitrary: fc.record({ k: fc.constant("climb" as const), link: n, dm: fc.boolean() }) },
  { weight: 3, arbitrary: fc.record({ k: fc.constant("walk" as const), x: cell, y: cell }) },
  { weight: 5, arbitrary: fc.record({ k: fc.constant("onto" as const), link: n }) },
  { weight: 1, arbitrary: fc.record({ k: fc.constant("moveTo" as const), floor: n }) },
  { weight: 1, arbitrary: fc.record({ k: fc.constant("add" as const), beside: n, above: fc.boolean() }) },
  { weight: 1, arbitrary: fc.record({ k: fc.constant("drop" as const), floor: n }) },
  { weight: 1, arbitrary: fc.record({ k: fc.constant("order" as const), turn: n }) },
  { weight: 1, arbitrary: fc.record({ k: fc.constant("raise" as const), floor: n, x: cell, y: cell }) },
  { weight: 1, arbitrary: fc.record({ k: fc.constant("wall" as const), floor: n, x: cell, y: cell }) },
  { weight: 1, arbitrary: fc.record({ k: fc.constant("pit" as const), floor: n, x: cell, y: cell }) },
  { weight: 2, arbitrary: fc.constant({ k: "undo" as const }) },
);

type World = { state: RoomState; seq: number; next: number; undo: RestoreEntry[][] };

const pickOf = <T>(list: readonly T[], i: number): T | undefined => (list.length === 0 ? undefined : list[i % list.length]);
const floorsNow = (s: RoomState) => floorsOf(s, GROUND);
const linkIds = (s: RoomState) => Object.keys(s.floorLinks ?? {}).sort();

function opFor(w: World, a: Act): { op: Op; who: Viewer } | null {
  const s = w.state;
  const floors = floorsNow(s);
  const dm = (op: Op) => ({ op, who: DM });
  switch (a.k) {
    case "put": {
      const from = pickOf(floors, a.from);
      const level = from?.floor?.level;
      const to = level === undefined ? undefined : floors.find((f) => f.floor?.level === level + (a.up ? 1 : -1));
      if (!from || !to) return null;
      const id = w.next++;
      return dm({ t: "floorLink.put", link: { id: `a${id}`, pairId: `b${id}`, sceneId: from.id, to: to.id, rect: { x: a.x, y: a.y, w: a.w, h: a.h }, kind: a.ladder ? "ladder" : "stairs" } });
    }
    case "lock": {
      const id = pickOf(linkIds(s), a.link);
      return id ? dm({ t: "floorLink.update", linkId: id, patch: { locked: a.on } }) : null;
    }
    case "kind": {
      const id = pickOf(linkIds(s), a.link);
      return id ? dm({ t: "floorLink.update", linkId: id, patch: { kind: s.floorLinks![id]!.kind === "stairs" ? "ladder" : "stairs" } }) : null;
    }
    case "remove": {
      const id = pickOf(linkIds(s), a.link);
      return id ? dm({ t: "floorLink.delete", linkId: id }) : null;
    }
    case "climb": {
      const thorn = s.tokens.thorn;
      const here = linkIds(s).filter((id) => s.floorLinks![id]!.sceneId === thorn?.sceneId);
      // Mostly the end under Thorn, sometimes another one on its floor, whose refusal the far-floor check reads too.
      const under = here.filter((id) => {
        const r = s.floorLinks![id]!.rect;
        return thorn !== undefined && thorn.x >= r.x && thorn.y >= r.y && thorn.x < r.x + r.w && thorn.y < r.y + r.h;
      });
      const id = a.link % 4 === 0 ? pickOf(here, a.link) : (pickOf(under, a.link) ?? pickOf(here, a.link));
      return id ? { op: { t: "token.climb", tokenId: "thorn", linkId: id }, who: a.dm ? DM : ANA } : null;
    }
    case "walk":
      return { op: { t: "token.move", tokenId: "thorn", x: a.x, y: a.y }, who: ANA };
    case "onto": {
      // A walk onto an end on Thorn's floor, so climbs come often.
      const here = linkIds(s).filter((id) => s.floorLinks![id]!.sceneId === s.tokens.thorn?.sceneId);
      const id = pickOf(here, a.link);
      return id ? { op: { t: "token.move", tokenId: "thorn", x: s.floorLinks![id]!.rect.x, y: s.floorLinks![id]!.rect.y }, who: ANA } : null;
    }
    case "moveTo": {
      const floor = pickOf(floors, a.floor);
      return floor ? dm({ t: "token.update", tokenId: "thorn", patch: { sceneId: floor.id } }) : null;
    }
    case "add": {
      const beside = pickOf(floors, a.beside);
      if (!beside || floors.length >= 6) return null;
      return dm({ t: "scene.create", scene: { id: `f${w.next++}`, name: "Tower", bounds: { w: 20, h: 20 } }, floor: { beside: beside.id, side: a.above ? "above" : "below" } });
    }
    case "drop": {
      const floor = pickOf(
        floors.filter((f) => f.id !== GROUND && f.id !== s.tokens.thorn?.sceneId),
        a.floor,
      );
      return floor ? dm({ t: "scene.delete", sceneId: floor.id }) : null;
    }
    case "order": {
      if (floors.length < 2) return null;
      const ids = floors.map((f) => f.id);
      const k = a.turn % ids.length;
      return dm({ t: "floor.order", sceneId: GROUND, floors: [...ids.slice(k), ...ids.slice(0, k)] });
    }
    case "raise": {
      const floor = pickOf(floors, a.floor);
      return floor ? dm({ t: "build.height", sceneId: floor.id, cells: [`${a.x},${a.y}`], height: 5 }) : null;
    }
    case "wall": {
      const floor = pickOf(floors, a.floor);
      return floor ? dm({ t: "build.edge", sceneId: floor.id, edges: [{ key: `${a.x},${a.y},w`, feature: { kind: "wall" } }] }) : null;
    }
    case "pit": {
      const floor = pickOf(floors, a.floor);
      if (!floor) return null;
      const rig = { on: ["enter" as const], who: "any" as const, floor: true, resets: "never" as const, stops: true, foundOnSpring: true, pit: { floor: -10 }, hits: "trigger" as const, actions: [], find: [], notice: false };
      return dm({ t: "trap.create", trap: { id: `p${w.next++}`, sceneId: floor.id, name: "Pit", zone: { cells: [{ x: a.x, y: a.y, w: 1, h: 1 }] }, rig } });
    }
    case "undo": {
      const entries = w.undo.pop();
      return entries ? dm({ t: "sys.restore", entries, from: "undo", deps: true }) : null;
    }
  }
}

/** The actor's order: permissions, the reducer, then floorProblem on the tower (server/rooms/actor.ts). */
function step(w: World, op: Op, who: Viewer): { ok: true; state: RoomState; inverse: RestoreEntry[] | null } | { ok: false; message: string } {
  const parsed = opSchema.parse(op);
  const d = canApply(parsed, who, w.state, { canUseAsset: () => true });
  if (!d.ok) return { ok: false, message: d.message };
  const r = applyOp(w.state, parsed, who, env(++w.seq));
  if (!r.ok) return { ok: false, message: r.message };
  const problem = floorProblem(r.state, GROUND);
  if (problem !== null) return { ok: false, message: problem };
  return { ok: true, state: r.state, inverse: r.inverse };
}

function pairsWhole(s: RoomState): void {
  const floors = new Set(floorsNow(s).map((f) => f.id));
  for (const link of Object.values(s.floorLinks ?? {})) {
    const pair = s.floorLinks![link.pair];
    assert.ok(pair, `${link.id}'s pair`);
    assert.deepEqual([pair.pair, pair.sceneId, pair.to, pair.rev, pair.made, pair.kind], [link.id, link.to, link.sceneId, link.rev, link.made, link.kind]);
    assert.ok(floors.has(link.sceneId) && floors.has(link.to), `${link.id} names floors of the tower`);
  }
}

function playersHeld(s: RoomState): void {
  for (const viewer of PLAYERS) {
    const held = heldFloors(s, viewer, { sceneId: null });
    for (const id of linkIds(s)) {
      const got = projectEntity(keys.floorLink(id), s, viewer, { sceneId: null }) as { sceneId: string; to?: string } | null;
      if (got === null) continue;
      assert.ok(held.has(got.sceneId), `${viewer.memberId} gets ${id} on a floor held`);
      assert.ok(got.to === undefined || held.has(got.to), `${viewer.memberId} gets ${id}'s far floor only while held`);
      assert.equal("pair" in got || "ground" in got || "made" in got, false);
    }
  }
}

/** The same room with the far floor of `linkId` changed in ways a player on its near floor cannot see. */
function farChanged(s: RoomState, linkId: string): RoomState {
  const link = s.floorLinks![linkId]!;
  const far = s.floorLinks![link.pair]!;
  const ghost = token("ghost", { name: "Ghost", visibility: "dm", sceneId: link.to, x: far.rect.x, y: far.rect.y });
  const scenes = { ...s.scenes, [link.to]: { ...s.scenes[link.to]!, fogEnabled: !s.scenes[link.to]!.fogEnabled } };
  // A wall on the far floor beside its end, never across it, so floorProblem still holds.
  const x = far.rect.x + far.rect.w + 1;
  const chunks = applyOp({ ...s, scenes }, { t: "build.edge", sceneId: link.to, edges: [{ key: `${x},${far.rect.y},w`, feature: { kind: "wall" } }] }, DM, env(9_000_000));
  const walled = chunks.ok ? chunks.state : { ...s, scenes };
  return { ...walled, tokens: { ...walled.tokens, ghost } };
}

function answer(s: RoomState, linkId: string): string {
  const op: Op = { t: "token.climb", tokenId: "thorn", linkId };
  const d = canApply(op, ANA, s, { canUseAsset: () => true });
  if (!d.ok) return `refused ${d.code}: ${d.message}`;
  const r = applyOp(s, op, ANA, env(9_000_001));
  if (!r.ok) return `reduced ${r.code}: ${r.message}`;
  const t = r.state.tokens.thorn as Token;
  return stableStringify({ sceneId: t.sceneId, x: t.x, y: t.y, elevation: t.elevation, squeeze: t.squeeze ?? null, moved: t.path?.stops.at(-1)?.moved ?? null });
}

function movedFt(t: Token | undefined): number {
  const legs = (t?.path?.stops ?? []).slice(1).filter((s) => s.uncounted !== true);
  return (t?.path?.prior?.moved ?? 0) + legs.reduce((total, s) => total + (s.moved ?? 0), 0);
}

test("stairs keep their invariants, players' floors and equal answers over random sequences", () => {
  let climbs = 0;
  let puts = 0;
  let refusedByFloors = 0;
  let farChecks = 0;
  fc.assert(
    fc.property(fc.array(ACT, { minLength: 5, maxLength: 50 }), (acts) => {
      // Stairs under Thorn up to Upper floor, and a ladder from there up to Attic, so climbs come from the first step.
      const start = run(withStairs(tower()), putOp({ id: "c1", pairId: "c2", sceneId: UPPER, to: ATTIC, rect: { x: 6, y: 6, w: 1, h: 1 }, kind: "ladder" }));
      const w: World = { state: onThornsTurn(start), seq: 1000, next: 0, undo: [] };
      for (const a of acts) {
        const next = opFor(w, a);
        if (!next) continue;
        // Invariant 4, before the step: Ana's climb by each end under Thorn answers alike with the far floor changed.
        if (next.op.t === "token.climb" && next.who === ANA) {
          assert.equal(answer(farChanged(w.state, next.op.linkId), next.op.linkId), answer(w.state, next.op.linkId), "a far floor's difference");
          farChecks++;
        }
        const turn = w.state.tokens.thorn?.path?.turn;
        const before = movedFt(w.state.tokens.thorn);
        const r = step(w, next.op, next.who);
        if (!r.ok) {
          if (/stairs|ladder/.test(r.message) && next.op.t !== "token.climb" && next.op.t !== "floorLink.put") refusedByFloors++;
          continue;
        }
        w.state = r.state;
        if (next.op.t !== "sys.restore" && r.inverse) w.undo.push(r.inverse);
        if (next.op.t === "token.climb") {
          climbs++;
          // Invariant 5.
          if (turn !== undefined && w.state.tokens.thorn?.path?.turn === turn) assert.ok(movedFt(w.state.tokens.thorn) >= before, "Moved never drops on a climb");
        }
        if (next.op.t === "floorLink.put") puts++;
        // Invariants 1 to 3.
        assert.equal(floorProblem(w.state, GROUND), null);
        pairsWhole(w.state);
        playersHeld(w.state);
      }
    }),
    { numRuns: 400, seed: 2611091 },
  );
  // The sequences reach what they test.
  assert.ok(puts > 200, `${puts} puts`);
  assert.ok(climbs > 200, `${climbs} climbs`);
  assert.ok(farChecks > 150, `${farChecks} far-floor checks`);
  assert.ok(refusedByFloors > 40, `${refusedByFloors} edits refused for stairs`);
});
