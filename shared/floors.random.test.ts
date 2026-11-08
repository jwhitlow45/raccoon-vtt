import assert from "node:assert/strict";
import { test } from "node:test";
import fc from "fast-check";
import { parseKey, type EntityKey } from "./keys.ts";
import type { RoomState, Viewer } from "./model.ts";
import { canApply } from "./permissions.ts";
import { allKeys, applyChanges, dependents, diffProjection, heldOf, projectEntity, projectState, stableStringify, type HeldEntry, type ProjectedState } from "./project.ts";
import { opSchema, type Op, type RestoreEntry } from "./protocol.ts";
import { applyOp, type Applied } from "./reducer.ts";
import { floorProblem, floorsOf, heldFloors, startFloor, unhiddenPartyMember } from "./rules/floors.ts";
import { AT, DM, P1, P2, actor, character, room, scene } from "./testutil.ts";

/*
 * Several floors as a state machine (docs/design/design-v1-floors.md 15): adds,
 * removals, orders, Show and Hide, Move to floor, Move players here,
 * creatures made and deleted, their owners, Hidden and party vision,
 * blackouts and undos, in random order. After every step:
 *
 * 1. floorProblem holds on every scene: one shape, levels 0 to n - 1, free
 *    names, at most 8, main floors their own, no stray mark.
 * 2. heldFloors holds, for every player and the table display outside a
 *    blackout, the floor of every unhidden party member on the players'
 *    scene, and the start floor.
 * 3. No player's or display's projection holds a record of a floor outside
 *    their held floors.
 * 4. Each viewer's copy, built from every step's changes, a viewer whose
 *    held floors changed re-projected whole (8.1), is the fresh projection.
 */

const DISPLAY: Viewer = { memberId: "display:abcdefghijkl", role: "player" };
const VIEWERS = [DM, P1, P2, DISPLAY] as const;
/** The DM views the tower, by its main floor, as a DM's socket names it. */
const DM_OPTS = { sceneId: "t" };
const BASE = Date.parse(AT);

type Act =
  | { k: "add"; beside: number; above: boolean }
  | { k: "remove"; floor: number }
  | { k: "order"; turn: number }
  | { k: "open"; floor: number; open: boolean }
  | { k: "create"; id: number; floor: number; kind: "pc1" | "pc2" | "monster" | "ally"; hidden: boolean }
  | { k: "moveTo"; token: number; floor: number }
  | { k: "players"; floor: number }
  | { k: "delete"; token: number }
  | { k: "owners"; token: number; to: 0 | 1 | 2 }
  | { k: "hide"; token: number; hidden: boolean }
  | { k: "lend"; token: number; on: boolean }
  | { k: "blackout"; on: boolean }
  | { k: "undo" };

const n = fc.nat({ max: 40 });
const ACT: fc.Arbitrary<Act> = fc.oneof(
  { weight: 5, arbitrary: fc.record({ k: fc.constant("add" as const), beside: n, above: fc.boolean() }) },
  { weight: 2, arbitrary: fc.record({ k: fc.constant("remove" as const), floor: n }) },
  { weight: 1, arbitrary: fc.record({ k: fc.constant("order" as const), turn: n }) },
  { weight: 2, arbitrary: fc.record({ k: fc.constant("open" as const), floor: n, open: fc.boolean() }) },
  { weight: 4, arbitrary: fc.record({ k: fc.constant("create" as const), id: n, floor: n, kind: fc.constantFrom("pc1" as const, "pc2" as const, "monster" as const, "ally" as const), hidden: fc.boolean() }) },
  { weight: 4, arbitrary: fc.record({ k: fc.constant("moveTo" as const), token: n, floor: n }) },
  { weight: 2, arbitrary: fc.record({ k: fc.constant("players" as const), floor: n }) },
  { weight: 1, arbitrary: fc.record({ k: fc.constant("delete" as const), token: n }) },
  { weight: 1, arbitrary: fc.record({ k: fc.constant("owners" as const), token: n, to: fc.constantFrom(0 as const, 1 as const, 2 as const) }) },
  { weight: 2, arbitrary: fc.record({ k: fc.constant("hide" as const), token: n, hidden: fc.boolean() }) },
  { weight: 1, arbitrary: fc.record({ k: fc.constant("lend" as const), token: n, on: fc.boolean() }) },
  { weight: 1, arbitrary: fc.record({ k: fc.constant("blackout" as const), on: fc.boolean() }) },
  { weight: 2, arbitrary: fc.constant({ k: "undo" as const }) },
);

type World = { state: RoomState; seq: number; next: number; undo: RestoreEntry[][] };

function start(): World {
  return {
    state: room({
      meta: { ...room().meta, playerSceneId: "t" },
      scenes: { t: scene("t", { name: "Tower" }), s2: scene("s2", { name: "Camp", order: 1 }) },
      characters: { c1: character("c1", { ownerIds: ["p1"] }), c2: character("c2", { ownerIds: ["p2"] }) },
    }),
    seq: 0,
    next: 0,
    undo: [],
  };
}

const tower = (s: RoomState) => floorsOf(s, "t");
const pickOf = <T>(list: readonly T[], i: number): T | undefined => (list.length === 0 ? undefined : list[i % list.length]);
const tokenIds = (s: RoomState) => Object.keys(s.tokens).sort();

function opFor(w: World, a: Act): Op | null {
  const s = w.state;
  const floors = tower(s);
  switch (a.k) {
    case "add": {
      const beside = pickOf(floors, a.beside)!;
      return { t: "scene.create", scene: { id: `f${w.next++}`, name: "Tower", bounds: { w: 12, h: 12 } }, floor: { beside: beside.id, side: a.above ? "above" : "below" } };
    }
    case "remove": {
      const others = floors.filter((f) => f.id !== "t");
      const floor = pickOf(others, a.floor);
      return floor ? { t: "scene.delete", sceneId: floor.id } : null;
    }
    case "order": {
      if (floors.length < 2) return null;
      const ids = floors.map((f) => f.id);
      const k = a.turn % ids.length;
      return { t: "floor.order", sceneId: "t", floors: [...ids.slice(k), ...ids.slice(0, k)] };
    }
    case "open": {
      const floor = pickOf(floors, a.floor);
      return floor?.floor ? { t: "floor.open", sceneId: floor.id, open: a.open } : null;
    }
    case "create": {
      const floor = pickOf([...floors, ownScene(s, "s2")], a.floor)!;
      const id = `k${a.id}`;
      if (s.tokens[id]) return null;
      const base = { id, sceneId: floor.id, name: id, size: "medium" as const, x: 1 + (a.id % 8), y: 1 + (a.id % 5), ...(a.hidden ? { visibility: "dm" as const } : {}) };
      if (a.kind === "pc1" || a.kind === "pc2") return { t: "token.create", token: { ...base, kind: "pc", actor: { ref: a.kind === "pc1" ? "c1" : "c2" } } };
      return { t: "token.create", token: { ...base, kind: "monster", actor: { inline: actor() }, ...(a.kind === "ally" ? { partyVision: true } : {}) } };
    }
    case "moveTo": {
      const id = pickOf(tokenIds(s), a.token);
      const floor = pickOf([...floors, ownScene(s, "s2")], a.floor);
      return id && floor ? { t: "token.update", tokenId: id, patch: { sceneId: floor.id } } : null;
    }
    case "players": {
      const floor = pickOf([...floors, ownScene(s, "s2")], a.floor)!;
      return { t: "room.setPlayerScene", sceneId: floor.id };
    }
    case "delete": {
      const id = pickOf(tokenIds(s), a.token);
      return id ? { t: "token.delete", tokenId: id } : null;
    }
    case "owners": {
      const id = pickOf(tokenIds(s), a.token);
      return id ? { t: "token.update", tokenId: id, patch: { ownerIds: [[], ["p1"], ["p2"]][a.to]! } } : null;
    }
    case "hide": {
      const id = pickOf(tokenIds(s), a.token);
      return id ? { t: "token.update", tokenId: id, patch: { visibility: a.hidden ? "dm" : "all" } } : null;
    }
    case "lend": {
      const id = pickOf(tokenIds(s), a.token);
      return id ? { t: "token.update", tokenId: id, patch: { partyVision: a.on } } : null;
    }
    case "blackout":
      return { t: "view.blackout", blackout: a.on };
    case "undo": {
      const entries = w.undo.pop();
      return entries ? { t: "sys.restore", entries, from: "undo", deps: true } : null;
    }
  }
}

function ownScene(s: RoomState, id: string) {
  return s.scenes[id]!;
}

// Invariant 4, the fan-out as server/rooms/fanout.ts publishBatch runs it, with 8.1's whole re-projection.

type Conn = { viewer: Viewer; held: Map<EntityKey, HeldEntry>; view: ProjectedState; floors: string };

const optsOf = (viewer: Viewer) => (viewer.role === "dm" ? DM_OPTS : { sceneId: null });
const floorsKey = (state: RoomState, viewer: Viewer) => [...heldFloors(state, viewer, optsOf(viewer))].sort().join(" ");

function candidates(before: RoomState, r: Applied, whole: boolean): EntityKey[] {
  if (whole || r.global) return [...new Set([...allKeys(before), ...allKeys(r.state)])].sort();
  return [...new Set([...r.touched, ...dependents(before, r.touched, r.state), ...dependents(r.state, r.touched, before)])].sort();
}

/** Fields a copy built from changes holds empty where a fresh snapshot leaves them out (keys.ts writeEntity), which read the same. */
function normalized(view: ProjectedState): string {
  const out: Record<string, unknown> = { ...view };
  for (const field of ["sounds", "playlists", "openFloors", "holders", "sightAll", "fogAll", "exploredAny"]) {
    const value = out[field];
    if (value !== undefined && value !== null && typeof value === "object" && Object.keys(value).length === 0) delete out[field];
  }
  if (out.playing === null) delete out.playing;
  return stableStringify(out);
}

/** Every floor a projection's records name, from the keys it holds and the records themselves. */
function floorsIn(view: ProjectedState): Set<string> {
  const out = new Set<string>(Object.keys(view.scenes));
  for (const key of heldOf(view).keys()) {
    const parsed = parseKey(key);
    if (parsed && "sceneId" in parsed) out.add(parsed.sceneId);
  }
  for (const list of [view.tokens, view.templates, view.drawings, view.labels, view.stamps, view.lights, view.pins, view.traps] as Record<string, { sceneId: string }>[]) {
    for (const record of Object.values(list ?? {})) out.add(record.sceneId);
  }
  return out;
}

test("floors keep their invariants, held sets and every viewer's copy over random sequences of floor ops", () => {
  let applied = 0;
  let adds = 0;
  let removals = 0;
  let moves = 0;
  let undos = 0;
  let heldChanges = 0;
  let split = 0;
  fc.assert(
    fc.property(fc.array(ACT, { minLength: 10, maxLength: 50 }), (acts) => {
      const w = start();
      const conns: Conn[] = VIEWERS.map((viewer) => {
        const view = projectState(w.state, viewer, optsOf(viewer));
        return { viewer, held: heldOf(view), view, floors: floorsKey(w.state, viewer) };
      });
      for (const [i, a] of acts.entries()) {
        const made = opFor(w, a);
        if (made === null) continue;
        const parsed = opSchema.safeParse(made);
        assert.ok(parsed.success, `act ${i}: the generator made an invalid ${made.t}: ${parsed.success ? "" : parsed.error.message}`);
        const op = parsed.data;
        const before = w.state;
        if (!canApply(op, DM, before, { canUseAsset: () => true }).ok) continue;
        const r = applyOp(before, op, DM, { seq: ++w.seq, at: new Date(BASE + w.seq * 1000).toISOString() });
        if (!r.ok) continue;
        // The actor refuses a step that breaks a floor rule (floorProblem beside checkLimits). Only a restore may try.
        const problem = Object.keys({ ...before.scenes, ...r.state.scenes }).map((id) => floorProblem(r.state, id)).find((p) => p !== null);
        if (problem !== undefined) {
          assert.equal(op.t, "sys.restore", `act ${i} (${op.t}) broke a floor rule: ${problem}`);
          continue;
        }
        applied++;
        if (op.t === "scene.create") adds++;
        if (op.t === "scene.delete") removals++;
        if (op.t === "token.update" && op.patch.sceneId !== undefined) moves++;
        if (op.t === "sys.restore") undos++;
        else if (r.inverse && op.t !== "token.update") w.undo.push(r.inverse);
        w.state = r.state;
        const s = r.state;
        const where = `act ${i} (${op.t})`;

        // 2. Every unhidden party member's floor on the players' scene, and the start floor, are held outside a blackout.
        const start = startFloor(s);
        const onPlayers = new Set(start === null ? [] : floorsOf(s, start).map((f) => f.id));
        for (const viewer of [P1, P2, DISPLAY]) {
          const held = heldFloors(s, viewer, { sceneId: null });
          if (s.meta.view.blackout) {
            assert.equal(held.size, 0, `${where}: ${viewer.memberId} holds nothing behind a blackout`);
            continue;
          }
          if (start !== null) assert.ok(held.has(start), `${where}: ${viewer.memberId} holds the start floor`);
          for (const t of Object.values(s.tokens)) {
            if (onPlayers.has(t.sceneId) && unhiddenPartyMember(s, t)) assert.ok(held.has(t.sceneId), `${where}: ${viewer.memberId} holds ${t.id}'s floor`);
          }
        }
        if (floorsOf(s, "t").length > 1 && new Set(Object.values(s.tokens).filter((t) => onPlayers.has(t.sceneId)).map((t) => t.sceneId)).size > 1) split++;

        // 3 and 4.
        const keyed = (whole: boolean) => candidates(before, r, whole);
        for (const c of conns) {
          const opts = optsOf(c.viewer);
          const floors = floorsKey(s, c.viewer);
          const whole = floors !== c.floors;
          if (whole) heldChanges++;
          c.floors = floors;
          const next = new Map<EntityKey, unknown>();
          for (const key of keyed(whole)) next.set(key, projectEntity(key, s, c.viewer, opts));
          const diff = diffProjection(c.held, next);
          c.held = diff.held;
          c.view = applyChanges(c.view, diff.changes);
          const fresh = projectState(s, c.viewer, opts);
          if (normalized(c.view) !== normalized(fresh)) assert.deepEqual(JSON.parse(normalized(c.view)), JSON.parse(normalized(fresh)), `${where}: ${c.viewer.memberId}'s copy is the fresh projection`);
          if (c.viewer.role === "player") {
            const held = heldFloors(s, c.viewer, opts);
            for (const floor of floorsIn(fresh)) assert.ok(held.has(floor), `${where}: ${c.viewer.memberId}'s projection holds ${floor}, a floor they do not hold`);
          }
        }
      }
    }),
    { numRuns: 300 },
  );
  // The generator reaches the paths that matter, so the invariants hold over something.
  assert.ok(applied > 3_000, `only ${applied} steps applied`);
  assert.ok(adds > 500 && removals > 100 && moves > 250, `${adds} adds, ${removals} removals, ${moves} moves to a floor`);
  assert.ok(undos > 50, `${undos} undos`);
  assert.ok(heldChanges > 300, `${heldChanges} held set changes`);
  assert.ok(split > 300, `${split} steps with the party split across floors`);
});
