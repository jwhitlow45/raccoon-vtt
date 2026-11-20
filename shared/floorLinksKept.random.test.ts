import assert from "node:assert/strict";
import { describe, test } from "node:test";
import fc from "fast-check";
import { ATTIC, GROUND, UPPER, putOp, run, tower, withStairs } from "./floorLinksTestutil.ts";
import type { RoomState, Viewer } from "./model.ts";
import { opSchema, type Op, type RestoreEntry } from "./protocol.ts";
import { applyOp } from "./reducer.ts";
import { freshLinksProblem, linksProblem } from "./rules/floorLinks.ts";
import { floorsOf } from "./rules/floors.ts";
import { DM, env } from "./testutil.ts";
import { markFinished, markWritable } from "./writable.ts";

/*
 * The stairs' half of floorProblem keeps its answer per scene while the
 * room's links, scenes, build and traps stay the same objects (D-261120-005).
 * Over random sequences of links added, moved, resized and removed, walls,
 * heights and pits under them, floors added, removed and reordered,
 * creatures walking, and undo and redo, every room the reducer makes is
 * asked as the actor asks it, refused ones too, and the kept answer for
 * every floor, a gone one included, equals one judged from nothing.
 */

type Act =
  | { k: "put"; from: number; up: boolean; x: number; y: number; w: number; h: number; kind: number }
  | { k: "move"; link: number; x: number; y: number; w: number; h: number; pair: boolean }
  | { k: "kind"; link: number }
  | { k: "remove"; link: number }
  | { k: "walk"; x: number; y: number }
  | { k: "add"; beside: number; above: boolean }
  | { k: "drop"; floor: number }
  | { k: "order"; turn: number }
  | { k: "raise"; floor: number; x: number; y: number; height: number }
  | { k: "wall"; floor: number; x: number; y: number; on: boolean }
  | { k: "pit"; floor: number; x: number; y: number }
  | { k: "bounds"; floor: number; w: number }
  | { k: "undo" }
  | { k: "redo" };

const n = fc.nat({ max: 40 });
const cell = fc.nat({ max: 7 });
const side = fc.integer({ min: 1, max: 3 });
const ACT: fc.Arbitrary<Act> = fc.oneof(
  { weight: 4, arbitrary: fc.record({ k: fc.constant("put" as const), from: n, up: fc.boolean(), x: cell, y: cell, w: side, h: side, kind: fc.nat({ max: 2 }) }) },
  { weight: 3, arbitrary: fc.record({ k: fc.constant("move" as const), link: n, x: cell, y: cell, w: side, h: side, pair: fc.boolean() }) },
  { weight: 1, arbitrary: fc.record({ k: fc.constant("kind" as const), link: n }) },
  { weight: 1, arbitrary: fc.record({ k: fc.constant("remove" as const), link: n }) },
  { weight: 4, arbitrary: fc.record({ k: fc.constant("walk" as const), x: cell, y: cell }) },
  { weight: 1, arbitrary: fc.record({ k: fc.constant("add" as const), beside: n, above: fc.boolean() }) },
  { weight: 1, arbitrary: fc.record({ k: fc.constant("drop" as const), floor: n }) },
  { weight: 1, arbitrary: fc.record({ k: fc.constant("order" as const), turn: n }) },
  { weight: 2, arbitrary: fc.record({ k: fc.constant("raise" as const), floor: n, x: cell, y: cell, height: fc.constantFrom(0, 5) }) },
  { weight: 2, arbitrary: fc.record({ k: fc.constant("wall" as const), floor: n, x: cell, y: cell, on: fc.boolean() }) },
  { weight: 1, arbitrary: fc.record({ k: fc.constant("pit" as const), floor: n, x: cell, y: cell }) },
  { weight: 1, arbitrary: fc.record({ k: fc.constant("bounds" as const), floor: n, w: fc.integer({ min: 4, max: 20 }) }) },
  { weight: 2, arbitrary: fc.constant({ k: "undo" as const }) },
  { weight: 1, arbitrary: fc.constant({ k: "redo" as const }) },
);

const KINDS = ["stairs", "ladder", "opening"] as const;

type World = { state: RoomState; seq: number; next: number; undo: RestoreEntry[][]; redo: RestoreEntry[][] };

const pickOf = <T>(list: readonly T[], i: number): T | undefined => (list.length === 0 ? undefined : list[i % list.length]);
const linkIds = (s: RoomState) => Object.keys(s.floorLinks ?? {}).sort();

function opFor(w: World, a: Act): Op | null {
  const s = w.state;
  const floors = floorsOf(s, GROUND);
  switch (a.k) {
    case "put": {
      const from = pickOf(floors, a.from);
      const level = from?.floor?.level;
      const to = level === undefined ? undefined : floors.find((f) => f.floor?.level === level + (a.up ? 1 : -1));
      if (!from || !to) return null;
      const id = w.next++;
      const kind = KINDS[a.kind]!;
      return { t: "floorLink.put", link: { id: `a${id}`, pairId: `b${id}`, sceneId: from.id, to: to.id, rect: { x: a.x, y: a.y, w: kind === "opening" ? a.w : 1, h: a.h }, kind } };
    }
    case "move": {
      const id = pickOf(linkIds(s), a.link);
      if (!id) return null;
      const rect = { x: a.x, y: a.y, w: s.floorLinks![id]!.kind === "opening" ? a.w : 1, h: a.h };
      return { t: "floorLink.update", linkId: id, patch: a.pair && s.floorLinks![id]!.kind !== "opening" ? { pairRect: rect } : { rect } };
    }
    case "kind": {
      const id = pickOf(linkIds(s), a.link);
      return id ? { t: "floorLink.update", linkId: id, patch: { kind: s.floorLinks![id]!.kind === "stairs" ? "ladder" : "stairs" } } : null;
    }
    case "remove": {
      const id = pickOf(linkIds(s), a.link);
      return id ? { t: "floorLink.delete", linkId: id } : null;
    }
    case "walk":
      return s.tokens.thorn ? { t: "token.move", tokenId: "thorn", x: a.x, y: a.y } : null;
    case "add": {
      const beside = pickOf(floors, a.beside);
      if (!beside || floors.length >= 6) return null;
      return { t: "scene.create", scene: { id: `f${w.next++}`, name: "Tower", bounds: { w: 20, h: 20 } }, floor: { beside: beside.id, side: a.above ? "above" : "below" } };
    }
    case "drop": {
      const floor = pickOf(
        floors.filter((f) => f.id !== GROUND && f.id !== s.tokens.thorn?.sceneId),
        a.floor,
      );
      return floor ? { t: "scene.delete", sceneId: floor.id } : null;
    }
    case "order": {
      if (floors.length < 2) return null;
      const ids = floors.map((f) => f.id);
      const k = a.turn % ids.length;
      return { t: "floor.order", sceneId: GROUND, floors: [...ids.slice(k), ...ids.slice(0, k)] };
    }
    case "raise": {
      const floor = pickOf(floors, a.floor);
      return floor ? { t: "build.height", sceneId: floor.id, cells: [`${a.x},${a.y}`], height: a.height } : null;
    }
    case "wall": {
      const floor = pickOf(floors, a.floor);
      return floor ? { t: "build.edge", sceneId: floor.id, edges: [{ key: `${a.x},${a.y},w`, feature: a.on ? { kind: "wall" } : null }] } : null;
    }
    case "pit": {
      const floor = pickOf(floors, a.floor);
      if (!floor) return null;
      const rig = { on: ["enter" as const], who: "any" as const, floor: true, resets: "never" as const, stops: true, foundOnSpring: true, pit: { floor: -10 }, hits: "trigger" as const, actions: [], find: [], notice: false };
      return { t: "trap.create", trap: { id: `p${w.next++}`, sceneId: floor.id, name: "Pit", zone: { cells: [{ x: a.x, y: a.y, w: 1, h: 1 }] }, rig } };
    }
    case "bounds": {
      const floor = pickOf(floors, a.floor);
      return floor ? { t: "scene.update", sceneId: floor.id, patch: { bounds: { w: a.w, h: 20 } } } : null;
    }
    case "undo": {
      const entries = w.undo.pop();
      return entries ? { t: "sys.restore", entries, from: "undo", deps: true } : null;
    }
    case "redo": {
      const entries = w.redo.pop();
      return entries ? { t: "sys.restore", entries, from: "redo", deps: true } : null;
    }
  }
}

/** Every floor the room names, the tower's and those a link still names after its floor went, as the actor may ask of any. */
function floorIds(s: RoomState): string[] {
  const ids = new Set([...Object.keys(s.scenes), GROUND, UPPER, ATTIC]);
  for (const link of Object.values(s.floorLinks ?? {})) {
    ids.add(link.sceneId);
    ids.add(link.to);
  }
  return [...ids].sort();
}

test("the stairs' kept answer equals one judged from nothing over random sequences (D-261120-005)", () => {
  let asked = 0;
  let kept = 0;
  let broken = 0;
  let changedUnderSameLinks = 0;
  fc.assert(
    fc.property(fc.array(ACT, { minLength: 5, maxLength: 40 }), (acts) => {
      const start = run(withStairs(tower()), putOp({ id: "c1", pairId: "c2", sceneId: UPPER, to: ATTIC, rect: { x: 6, y: 6, w: 1, h: 1 }, kind: "ladder" }));
      const w: World = { state: start, seq: 1000, next: 0, undo: [], redo: [] };
      let last = new Map<string, string | null>(floorIds(start).map((id) => [id, linksProblem(start, id)]));
      for (const a of acts) {
        const op = opFor(w, a);
        if (!op) continue;
        const who: Viewer = DM;
        const r = applyOp(w.state, opSchema.parse(op), who, env(++w.seq));
        if (!r.ok) continue;
        // Asked of the room the op made, as the actor asks before it refuses one that breaks the stairs.
        const sameLinks = r.state.floorLinks === w.state.floorLinks;
        const same = sameLinks && r.state.scenes === w.state.scenes && r.state.buildChunks === w.state.buildChunks && r.state.traps === w.state.traps;
        const answers = new Map<string, string | null>();
        for (const id of floorIds(r.state)) {
          const got = linksProblem(r.state, id);
          assert.equal(got, freshLinksProblem(r.state, id), `${op.t}: the kept answer for ${id}`);
          answers.set(id, got);
          asked++;
          if (same) kept++;
          if (got !== null) broken++;
          if (sameLinks && last.has(id) && last.get(id) !== got) changedUnderSameLinks++;
        }
        last = answers;
        // The actor commits only a room whose floors hold.
        if (floorIds(r.state).some((id) => answers.get(id) !== null)) continue;
        w.state = r.state;
        if (op.t === "sys.restore") {
          if (r.inverse) (op.from === "undo" ? w.redo : w.undo).push(r.inverse);
        } else if (r.inverse) {
          w.undo.push(r.inverse);
          w.redo = [];
        }
      }
    }),
    { numRuns: 300, seed: 2611205 },
  );
  // The sequences reach what they test: answers kept across walks, and answers a build, pit or floor edit changed while the links stayed.
  assert.ok(asked > 5000, `${asked} answers`);
  assert.ok(kept > 1000, `${kept} answers asked of a room whose links, scenes, build and traps an op left as they were`);
  assert.ok(broken > 300, `${broken} answers naming a broken rule`);
  assert.ok(changedUnderSameLinks > 100, `${changedUnderSameLinks} answers that changed while the links stayed the same objects`);
});

describe("the stairs' kept answer reads each collection it is judged on (D-261120-005)", () => {
  // Rooms an op never makes, as an import or a restore of one collection could: one collection new, the rest the same objects.
  const stairs = () => withStairs(tower());
  const ask = (s: RoomState) => linksProblem(s, GROUND);

  test("new ground under the stairs, with the links and scenes the same objects, is judged again", () => {
    const s = stairs();
    assert.equal(ask(s), null);
    const raised = run(s, { t: "build.height", sceneId: GROUND, cells: ["3,3"], height: 5 });
    const moved = { ...s, buildChunks: raised.buildChunks };
    assert.equal(ask(moved), freshLinksProblem(moved, GROUND));
    assert.match(ask(moved)!, /change the ground under the stairs/);
  });

  test("a pit under the stairs, with the rest the same objects, is judged again", () => {
    const s = stairs();
    assert.equal(ask(s), null);
    const rig = { on: ["enter" as const], who: "any" as const, floor: true, resets: "never" as const, stops: true, foundOnSpring: true, pit: { floor: -10 }, hits: "trigger" as const, actions: [], find: [], notice: false };
    const pitted = run(s, { t: "trap.create", trap: { id: "pit", sceneId: GROUND, name: "Pit", zone: { cells: [{ x: 3, y: 3, w: 1, h: 1 }] }, rig } });
    const moved = { ...s, traps: pitted.traps };
    assert.equal(ask(moved), freshLinksProblem(moved, GROUND));
    assert.notEqual(ask(moved), null);
  });

  test("floors that changed, with the rest the same objects, are judged again", () => {
    const s = stairs();
    assert.equal(ask(s), null);
    const scenes = { ...s.scenes, [UPPER]: { ...s.scenes[UPPER]!, floor: { ...s.scenes[UPPER]!.floor!, level: 2 } }, [ATTIC]: { ...s.scenes[ATTIC]!, floor: { ...s.scenes[ATTIC]!.floor!, level: 1 } } };
    const moved = { ...s, scenes };
    assert.equal(ask(moved), freshLinksProblem(moved, GROUND));
    assert.notEqual(ask(moved), null);
  });

  test("a collection an op may still write into is judged afresh each time", () => {
    const s = stairs();
    const chunks = { ...s.buildChunks };
    const open = { ...s, buildChunks: chunks };
    markWritable(chunks);
    try {
      assert.equal(ask(open), null);
      Object.assign(chunks, run(s, { t: "build.height", sceneId: GROUND, cells: ["3,3"], height: 5 }).buildChunks);
      assert.match(ask(open)!, /change the ground under the stairs/);
    } finally {
      markFinished(chunks);
    }
  });
});
