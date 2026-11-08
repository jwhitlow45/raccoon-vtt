import assert from "node:assert/strict";
import { test } from "node:test";
import { DAYLIGHT, DAY_SECONDS, clockNow, lightAt } from "../calendar.ts";
import { chunkKey } from "../keys.ts";
import type { LightLevel, RoomClock, RoomState, Scene } from "../model.ts";
import type { Op, RestoreEntry } from "../protocol.ts";
import { applyOp } from "../reducer.ts";
import { DM, chance, character, env, int, pick, rng, room, scene, token } from "../testutil.ts";
import { undoScope } from "../undoScope.ts";

/**
 * Random sequences of clock ops near dawn and dusk, scene light picks,
 * Players see, phase switches, weather edits, door.set, build paints, token
 * moves, new scenes, fights started, turned, taken back and ended, and undo
 * and redo (docs/design/design-v1-calendar-c2c3.md 11). Invariants:
 *
 * 1. With a clock and no fight, every scene on Time of day is lit as
 *    `lightAt` the current time (6.3).
 * 2. Next and Previous write no scene.
 * 3. The pass writes only a scene's level, `lightAt` the current time, and
 *    only on a scene on Time of day when the clock really changed, the fight
 *    went, or that scene's own light settings changed: the op without the
 *    pass (version 54) leaves the room the same in every other way. So an op
 *    that changes neither the clock nor a scene's light settings writes no
 *    light.
 */

const H = 3_600;
const MAP = { assetId: "a-day", widthPx: 1920, heightPx: 1080, cellPx: 64, originPx: { x: 0, y: 0 } };
const PHASES = [
  { id: "day", name: "Day", assetId: "a-day", widthPx: 1920, heightPx: 1080 },
  { id: "night", name: "Night", assetId: "a-night", widthPx: 1920, heightPx: 1080, light: "dark" as const },
];
const LEVELS: LightLevel[] = ["bright", "dim", "dark"];
/** The edges of the parts of the day, where a step most often relights. */
const EDGES = [DAYLIGHT.dawn, DAYLIGHT.dawn + H, 12 * H, DAYLIGHT.dusk, DAYLIGHT.dusk + H];

function start(): RoomState {
  const state = room({
    characters: { bree: character("bree", { name: "Bree", ownerIds: ["p1"] }) },
    tokens: { gob: token("gob"), "bree-t": token("bree-t", { kind: "pc", actor: { ref: "bree" }, ownerIds: ["p1"] }) },
  });
  state.scenes.s1 = scene("s1", { map: MAP, vision: { on: false, light: "bright" } });
  state.scenes.s2 = scene("s2", { order: 1, vision: { on: false, light: "bright" } });
  state.buildChunks[chunkKey("s1", 0, 0)] = { sceneId: "s1", cx: 0, cy: 0, rev: 0, cells: {}, edges: { "9,5,w": { kind: "door", state: "closed", secret: false, discovered: false } } };
  const phased = applyOp(state, { t: "scene.update", sceneId: "s1", patch: { phases: PHASES } }, DM, env(1));
  assert.ok(phased.ok);
  return phased.state;
}

function nearEdge(r: () => number, now: number): number {
  return Math.floor(now / DAY_SECONDS) * DAY_SECONDS + pick(r, EDGES) + int(r, -90, 90);
}

let ids = 0;
function randomOp(r: () => number, state: RoomState): Op {
  const clock = state.clock;
  const now = clock ? clockNow(clock, state.encounter) : 12 * H;
  const sceneId = pick(r, ["s1", "s2"]);
  const was = state.scenes[sceneId]?.vision ?? { on: false, light: "bright" as const };
  const roll = r();
  if (roll < 0.05) return { t: "clock.start", id: `c${++ids}`, at: nearEdge(r, now), shown: chance(r, 0.6), calendar: { kind: "days" } };
  if (roll < 0.07) return { t: "clock.stop" };
  if (roll < 0.11) return chance(r, 0.5) ? { t: "clock.update", shown: chance(r, 0.5) } : { t: "clock.update", at: nearEdge(r, now) };
  if (roll < 0.16) return { t: "clock.set", at: nearEdge(r, now) };
  if (roll < 0.26) return { t: "clock.advance", by: pick(r, [1, 6, 30, 60, 600, H, 8 * H]) };
  if (roll < 0.3) return { t: "scene.update", sceneId, patch: { vision: { on: was.on, light: pick(r, LEVELS), byClock: false } } };
  if (roll < 0.36) return { t: "scene.update", sceneId, patch: { vision: { on: was.on, light: pick(r, LEVELS), byClock: true } } };
  if (roll < 0.39) return { t: "scene.update", sceneId, patch: { vision: { on: !was.on, light: was.light } } };
  if (roll < 0.42) return { t: "scene.setPhase", sceneId: "s1", phaseId: pick(r, ["day", "night"]) };
  if (roll < 0.45) return { t: "scene.update", sceneId, patch: { weather: chance(r, 0.5) ? null : { kind: "rain", ...(chance(r, 0.5) ? { heavy: true as const } : {}) } } };
  if (roll < 0.48) return { t: "door.set", sceneId: "s1", door: { edge: "9,5,w" }, state: pick(r, ["open", "closed"]) };
  if (roll < 0.51) return { t: "build.paint", sceneId: "s1", terrain: "stone", cells: [`${int(r, 0, 9)},${int(r, 0, 9)}`] };
  if (roll < 0.55) return { t: "token.move", tokenId: "gob", x: int(r, 0, 12), y: int(r, 0, 12) };
  if (roll < 0.57 && Object.keys(state.scenes).length < 5) {
    return { t: "scene.create", scene: { id: `n${++ids}`, name: "Copy", bounds: { w: 10, h: 10 }, vision: { on: false, light: pick(r, LEVELS), ...(chance(r, 0.7) ? { byClock: true as const } : {}) } } };
  }
  if (roll < 0.61) return { t: "encounter.start", entries: [{ id: `e${++ids}`, tokenId: "gob", value: 15 }, { id: `f${++ids}`, tokenId: "bree-t", value: 5 }] };
  if (roll < 0.8) return { t: "encounter.next" };
  if (roll < 0.86) return { t: "encounter.prev" };
  if (roll < 0.9) return { t: "encounter.end" };
  return { t: "clock.advance", by: pick(r, [6, 60]) };
}

function sameClock(a: RoomClock | null | undefined, b: RoomClock | null | undefined): boolean {
  if (!a || !b) return !a && !b;
  const x = a.daylight ?? DAYLIGHT;
  const y = b.daylight ?? DAYLIGHT;
  return a.id === b.id && a.t === b.t && x.dawn === y.dawn && x.dusk === y.dusk;
}

const lightSettings = (s: Scene | undefined) => (s ? JSON.stringify([s.phaseId ?? null, s.vision ?? null]) : null);
const withoutRev = (s: Scene | undefined) => (s ? { ...s, rev: 0 } : s);

type Scope = "play" | "setup";
type Stacks = Record<Scope, { undo: RestoreEntry[][]; redo: RestoreEntry[][] }>;

test("daylight keeps its invariants over random play, undo and redo", () => {
  const counts = { relit: 0, relitByClock: 0, relitBySettings: 0, restores: 0, checked: 0, nexts: 0, phases: 0, doors: 0 };
  for (let seed = 1; seed <= 60; seed++) {
    const r = rng(seed * 11 + 5);
    let state = start();
    let seq = 0;
    const stacks: Stacks = { play: { undo: [], redo: [] }, setup: { undo: [], redo: [] } };
    for (let i = 0; i < 200; i++) {
      const before = state;
      let op: Op;
      let restoring: { scope: Scope; from: "undo" | "redo" } | null = null;
      const scope: Scope = chance(r, 0.7) ? "play" : "setup";
      const choice = r();
      if (choice < 0.12 && stacks[scope].undo.length > 0) {
        restoring = { scope, from: "undo" };
        op = { t: "sys.restore", entries: stacks[scope].undo.pop()!, from: "undo", deps: true, scope, correction: { label: "a step" } } as Op;
      } else if (choice < 0.18 && stacks[scope].redo.length > 0) {
        restoring = { scope, from: "redo" };
        op = { t: "sys.restore", entries: stacks[scope].redo.pop()!, from: "redo", deps: true, scope, correction: { label: "a step" } } as Op;
      } else op = randomOp(r, state);
      const opScope = op.t === "sys.restore" ? null : undoScope(op, before);
      const result = applyOp(before, op, DM, env(++seq));
      const without = applyOp(before, op, DM, { ...env(seq), opVersion: 54 });
      assert.equal(result.ok, without.ok, `seed ${seed} step ${i} ${op.t}: the pass never refuses`);
      if (!result.ok || !without.ok) continue;
      state = result.state;
      const where = `seed ${seed} step ${i} ${op.t}`;
      if (op.t === "scene.setPhase") counts.phases++;
      if (op.t === "door.set") counts.doors++;
      const clock = state.clock;
      const now = clock ? clockNow(clock, state.encounter) : 0;

      // Invariant 1.
      if (clock && !state.encounter) {
        counts.checked++;
        for (const s of Object.values(state.scenes)) if (s.vision?.byClock) assert.equal(s.vision.light, lightAt(now, clock.daylight), `${where}: ${s.id} lit`);
      }
      // Invariant 2.
      if (op.t === "encounter.next" || op.t === "encounter.prev") {
        counts.nexts++;
        assert.ok(!result.touched.some((key) => key.startsWith("scene:")), `${where}: wrote a scene`);
      }
      // Invariant 3.
      assert.deepEqual({ ...result.state, scenes: {} }, { ...without.state, scenes: {} }, `${where}: the pass wrote outside the scenes`);
      assert.deepEqual(Object.keys(result.state.scenes).sort(), Object.keys(without.state.scenes).sort());
      const clockMoved = !sameClock(before.clock, clock) || (before.encounter !== null && state.encounter === null);
      for (const [id, lit] of Object.entries(result.state.scenes)) {
        const plain: Scene = without.state.scenes[id]!;
        if (JSON.stringify(withoutRev(lit)) === JSON.stringify(withoutRev(plain))) continue;
        counts.relit++;
        assert.ok(clock, `${where}: ${id} relit with no clock`);
        assert.equal(lit.vision?.byClock, true, `${where}: ${id} relit off Time of day`);
        assert.deepEqual(withoutRev({ ...lit, vision: { ...lit.vision!, light: plain.vision!.light } }), withoutRev(plain), `${where}: ${id} more than its level`);
        assert.equal(lit.vision!.light, lightAt(now, clock.daylight), `${where}: ${id} level`);
        const ownChange = lightSettings(before.scenes[id]) !== lightSettings(plain);
        assert.ok(clockMoved || ownChange, `${where}: ${id} relit with neither the clock nor its light settings changed`);
        if (clockMoved) counts.relitByClock++;
        else counts.relitBySettings++;
      }

      if (restoring) {
        counts.restores++;
        const stack = stacks[restoring.scope];
        if (result.inverse) (restoring.from === "undo" ? stack.redo : stack.undo).push(result.inverse);
      } else if (opScope && opScope !== "none" && result.inverse) {
        const stack = stacks[opScope];
        stack.undo.push(result.inverse);
        stack.redo.length = 0;
      }
    }
  }
  assert.ok(counts.relitByClock > 800, `enough relit by the clock (${counts.relitByClock})`);
  assert.ok(counts.relitBySettings > 200, `enough relit by a scene's own settings (${counts.relitBySettings})`);
  assert.ok(counts.checked > 1_500, `enough states checked with no fight (${counts.checked})`);
  assert.ok(counts.restores > 600, `enough restores (${counts.restores})`);
  assert.ok(counts.nexts > 1_000, `enough Next and Previous (${counts.nexts})`);
  assert.ok(counts.phases > 150, `enough phase switches (${counts.phases})`);
  assert.ok(counts.doors > 150, `enough doors (${counts.doors})`);
});
