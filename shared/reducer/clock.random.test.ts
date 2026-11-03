import assert from "node:assert/strict";
import { test } from "node:test";
import { clockNow, fightSeconds, lineDate } from "../calendar.ts";
import { keys } from "../keys.ts";
import { LIMITS } from "../limits.ts";
import { lineAudience } from "../logRings.ts";
import type { Calendar, LogEntry, RoomState, Viewer } from "../model.ts";
import { projectState } from "../project.ts";
import type { Op, RestoreEntry } from "../protocol.ts";
import { applyOp, type Applied } from "../reducer.ts";
import { DM, P1, chance, character, env, int, pick, rng, room, token } from "../testutil.ts";

/**
 * Random sequences of the clock's ops, steps, fights started, turned and
 * ended, Previous, rests and undo and redo (docs/design/design-v1-calendar.md
 * 11), against a model of the clock kept from the ops alone. Invariants:
 *
 * 1. `t` stays within the bound.
 * 2. `t` is the model's: the start plus every step and fight not undone,
 *    short of the clamp.
 * 3. A clock line is shared exactly when the clock is shown as its op
 *    leaves it, and no player ever holds a line written while it was hidden.
 * 4. A DM's undo or redo through the correction gate with a clock before and
 *    after whose stored time and date text both change writes exactly one
 *    clock line, and every other restore writes none, an undone fight's end
 *    included.
 * 5. A Long Rest's stamp is the current time when the rest applied.
 */

const H = 3_600;
const CALENDARS: Calendar[] = [
  { kind: "days" },
  { kind: "months", months: [{ name: "Deepwinter", days: 30 }, { name: "Midwinter", days: 1 }, { name: "Thaw", days: 29 }], week: ["Moonday", "Tuesday", "Wodensday"], era: "AF" },
];

type Step = { entries: RestoreEntry[]; clockBefore: number | null; touchedClock: boolean };

function start(): RoomState {
  return room({
    characters: { bree: character("bree", { name: "Bree", ownerIds: ["p1"] }), thorn: character("thorn", { name: "Thorn", ownerIds: [] }) },
    tokens: { gob: token("gob"), bree: token("bree", { kind: "pc", actor: { ref: "bree" }, ownerIds: ["p1"] }), thorn: token("thorn", { kind: "pc", actor: { ref: "thorn" } }) },
  });
}

function randomOp(r: () => number, state: RoomState): { op: Op; who: Viewer } {
  const clock = state.clock;
  const now = clock ? clockNow(clock, state.encounter) : 0;
  const near = () => pick(r, [now + int(r, -3 * 86_400, 3 * 86_400), int(r, -400 * 86_400, 400 * 86_400), LIMITS.clockSecondsMax - int(r, 0, 120), -LIMITS.clockSecondsMax + int(r, 0, 120)]);
  const at = () => Math.max(-LIMITS.clockSecondsMax, Math.min(LIMITS.clockSecondsMax, near()));
  const roll = r();
  if (roll < 0.08) return { op: { t: "clock.start", id: `clock-${int(r, 1, 1_000_000)}`, at: at(), shown: chance(r, 0.6), calendar: pick(r, CALENDARS) }, who: DM };
  if (roll < 0.11) return { op: { t: "clock.stop" }, who: DM };
  if (roll < 0.2) {
    const update = { t: "clock.update" as const, ...(chance(r, 0.5) ? { shown: chance(r, 0.5) } : {}), ...(chance(r, 0.3) ? { calendar: pick(r, CALENDARS) } : {}), ...(chance(r, 0.4) ? { at: at() } : {}) };
    return { op: "shown" in update || "calendar" in update || "at" in update ? update : { ...update, shown: true }, who: DM };
  }
  if (roll < 0.26) return { op: { t: "clock.set", at: at() }, who: DM };
  if (roll < 0.42) return { op: { t: "clock.advance", by: pick(r, [600, H, 8 * H, int(r, 1, 59), int(r, 1, LIMITS.clockStepMax)]), ...(chance(r, 0.2) ? { why: "longRest" as const } : {}) }, who: DM };
  if (roll < 0.48) return { op: { t: "encounter.start", entries: [{ id: `e${int(r, 1, 1e6)}`, tokenId: "gob", value: 15 }, { id: `f${int(r, 1, 1e6)}`, tokenId: "bree", value: 5 }] }, who: DM };
  if (roll < 0.62) return { op: { t: "encounter.next" }, who: DM };
  if (roll < 0.66) return { op: { t: "encounter.prev" }, who: DM };
  if (roll < 0.72) return { op: { t: "encounter.end" }, who: DM };
  if (roll < 0.76) return { op: { t: "encounter.remove", entryIds: (state.encounter?.entries ?? []).map((e) => e.id).slice(0, 1).concat(state.encounter ? [] : ["none"]) }, who: DM };
  if (roll < 0.84) return { op: { t: "actor.rest", target: { characterId: pick(r, ["bree", "thorn"]) }, kind: chance(r, 0.8) ? "long" : "short" }, who: DM };
  return { op: { t: "actor.rest", target: { characterId: "bree" }, kind: "long" }, who: P1 };
}

function clockLinesOf(lines: readonly LogEntry[]): LogEntry[] {
  return lines.filter((line) => line.data?.type === "clock");
}

/** The model's stored time after an op that applied, from the op and the state before it alone. */
function modelAfter(model: number | null, op: Op, before: RoomState): number | null {
  const fight = (state: RoomState) => fightSeconds(state.encounter, false);
  switch (op.t) {
    case "clock.start":
      return op.at - fight(before);
    case "clock.stop":
      return null;
    case "clock.set":
      return op.at - fight(before);
    case "clock.update":
      return op.at !== undefined ? op.at - fight(before) : model;
    case "clock.advance":
      return model! + op.by;
    case "encounter.end":
      return model === null ? null : Math.min(LIMITS.clockSecondsMax, model + fightSeconds(before.encounter, true));
    default:
      return model;
  }
}

test("the clock keeps its invariants over random play, undo and redo", () => {
  let restores = 0;
  let restoreLines = 0;
  let stamps = 0;
  let ends = 0;
  for (let seed = 1; seed <= 60; seed++) {
    const r = rng(seed);
    let state = start();
    let seq = 0;
    let model: number | null = null;
    const undo: Step[] = [];
    const redo: Step[] = [];
    const hiddenLines = new Set<string>();
    const playerUndo: RestoreEntry[][] = [];
    for (let i = 0; i < 160; i++) {
      const before = state;
      const choice = r();
      let applied: Applied | null = null;
      let restoreOf: { step: Step; from: "undo" | "redo"; gate: boolean } | null = null;
      let op: Op;
      let who: Viewer = DM;
      if (choice < 0.12 && undo.length > 0) {
        const step = undo.pop()!;
        op = { t: "sys.restore", entries: step.entries, from: "undo", deps: true, scope: "play", correction: { label: "a step" } } as Op;
        restoreOf = { step, from: "undo", gate: true };
      } else if (choice < 0.18 && redo.length > 0) {
        const step = redo.pop()!;
        op = { t: "sys.restore", entries: step.entries, from: "redo", deps: true, scope: "play", correction: { label: "a step" } } as Op;
        restoreOf = { step, from: "redo", gate: true };
      } else if (choice < 0.21 && playerUndo.length > 0) {
        op = { t: "sys.restore", entries: playerUndo.pop()!, from: "undo", deps: true, scope: "play" } as Op;
        who = P1;
      } else {
        ({ op, who } = randomOp(r, state));
      }
      const result = applyOp(state, op, who, env(++seq));
      if (!result.ok) continue;
      applied = result;
      state = result.state;
      const touchedClock = result.touched.includes(keys.clock);
      // Invariant 2: the model follows the ops, an undone or redone step putting back the time it guarded.
      if (op.t === "sys.restore") {
        if (restoreOf?.step.touchedClock) model = restoreOf.step.clockBefore;
      } else {
        model = modelAfter(model, op, before);
      }
      assert.equal(state.clock?.t ?? null, model, `seed ${seed} step ${i} ${op.t}`);
      // Invariant 1.
      if (state.clock) assert.ok(Math.abs(state.clock.t) <= LIMITS.clockSecondsMax, `seed ${seed} step ${i}`);
      // Invariant 3.
      for (const line of clockLinesOf(applied.log)) {
        assert.equal(lineAudience(line), state.clock?.shown === true ? "shared" : "dm", `seed ${seed} step ${i} ${op.t}`);
        if (lineAudience(line) !== "shared") hiddenLines.add(line.id);
      }
      for (const line of clockLinesOf(projectState(state, P1, { sceneId: "s1" }).log)) assert.ok(!hiddenLines.has(line.id), `seed ${seed} step ${i}: a hidden line reached a player`);
      // Invariant 4.
      if (op.t === "sys.restore") {
        restores++;
        const lines = clockLinesOf(applied.log);
        restoreLines += lines.length;
        const gated = who.role === "dm" && restoreOf?.gate === true;
        const fightChanged = (before.encounter === null) !== (state.encounter === null);
        const dateChanged = before.clock && state.clock && before.clock.t !== state.clock.t ? lineDate(clockNow(before.clock, before.encounter), before.clock.calendar) !== lineDate(clockNow(state.clock, state.encounter), state.clock.calendar) : false;
        assert.equal(lines.length, gated && !fightChanged && dateChanged ? 1 : 0, `seed ${seed} step ${i}: restore lines`);
      }
      if (op.t === "encounter.end" && before.clock && fightSeconds(before.encounter, true) > 0) ends++;
      // Invariant 5.
      if (op.t === "actor.rest" && op.kind === "long" && before.clock && "characterId" in op.target) {
        stamps++;
        assert.deepEqual(state.characters[op.target.characterId]!.longRest, { at: clockNow(before.clock, before.encounter), clock: before.clock.id });
      }
      // The stacks: a new DM step clears redo, an undo's inverse is its redo and a redo's its undo.
      const step: Step = { entries: applied.inverse ?? [], clockBefore: before.clock?.t ?? null, touchedClock };
      if (op.t === "sys.restore" && restoreOf) {
        if (applied.inverse) (restoreOf.from === "undo" ? redo : undo).push(step);
      } else if (op.t !== "sys.restore" && applied.inverse) {
        if (who.role === "dm") {
          undo.push(step);
          redo.length = 0;
        } else playerUndo.push(applied.inverse);
      }
    }
  }
  assert.ok(restores > 300, `enough restores (${restores})`);
  assert.ok(restoreLines > 30, `enough restore lines (${restoreLines})`);
  assert.ok(stamps > 100, `enough stamps (${stamps})`);
  assert.ok(ends > 20, `enough fights ended with a clock (${ends})`);
});
