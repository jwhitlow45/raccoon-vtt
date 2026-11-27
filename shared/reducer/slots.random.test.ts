import assert from "node:assert/strict";
import { before, test } from "node:test";
import type { SrdRolls } from "../dice/bonus.ts";
import { resolveDiceOp } from "../dice/resolve.ts";
import type { ClassLevel, RoomState, Viewer } from "../model.ts";
import { expectOf } from "../permissions.ts";
import { projectState, stableStringify } from "../project.ts";
import type { Op, RestoreEntry } from "../protocol.ts";
import { applyOp } from "../reducer.ts";
import { EMPTY_PC_STATS } from "../rules/pcStats.ts";
import { slotsOf, spentWithin } from "../rules/spellSlots.ts";
import { loadSrdRolls } from "../srd/rolls.ts";
import { DM, P1, P2, actor, chance, character, env, int, pick, rng, room, token } from "../testutil.ts";

/**
 * Random sequences of spell slot, Pact Magic and Hit Point Die ops
 * (docs/design/design-v1-slots.md 13): spends and Restores, server rolls
 * with a fixed draw in and out of Wild Shape, typed dice, classes that grow,
 * shrink and empty, both rests, the party's Long Rest, re-sync Undos with
 * their exact spent counts, the DM's undo and redo of each step, and HP
 * changes. Invariants:
 *
 * 1. Every spent count is between 0 and its most, in the one normal form.
 * 2. HP never passes its most.
 * 3. A refused op changes nothing.
 * 4. A Long Rest leaves nothing spent, a Short Rest no Pact Magic slot.
 * 5. Replay of the applied ops rebuilds the same state.
 * 6. A non-owner's projection never holds `classes`, `spent` or `useRev`.
 */

let srd: SrdRolls = {};
before(async () => {
  srd = await loadSrdRolls();
});

const CHARS = ["bree", "thorn"] as const;

function start(): RoomState {
  return room({
    characters: {
      bree: character("bree", { name: "Bree", ownerIds: ["p1"], classes: [{ id: "wizard", level: 5 }, { id: "warlock", level: 3 }], actor: actor({ hp: { cur: 10, max: 40, temp: 0 } }) }),
      thorn: character("thorn", { name: "Thorn", ownerIds: ["p1"], classes: [{ id: "druid", level: 6 }, { id: "fighter", level: 4, third: true }], stats: { ...EMPTY_PC_STATS }, actor: actor({ hp: { cur: 30, max: 60, temp: 0 } }) }),
    },
    tokens: { t1: token("t1", { kind: "pc", actor: { ref: "bree" }, ownerIds: ["p1"] }), t2: token("t2", { kind: "pc", actor: { ref: "thorn" }, ownerIds: ["p1"] }) },
  });
}

function randomClasses(r: () => number): ClassLevel[] {
  if (chance(r, 0.1)) return [];
  const ids = ["wizard", "cleric", "paladin", "warlock", "fighter", "barbarian", "rogue"] as const;
  const out: ClassLevel[] = [];
  let left = 20;
  for (const id of ids) {
    if (!chance(r, 0.35) || left === 0) continue;
    const level = int(r, 1, Math.min(left, 10));
    left -= level;
    out.push(id === "fighter" || id === "rogue" ? { id, level, ...(chance(r, 0.5) ? { third: true as const } : {}) } : { id, level });
  }
  if (chance(r, 0.2) && left > 0) out.push({ id: "other", level: int(r, 1, left), die: pick(r, [6, 8, 10, 12] as const) });
  return out;
}

function randomOp(r: () => number, state: RoomState, seq: number): { op: Op; who: Viewer } | null {
  const id = pick(r, CHARS);
  const who = chance(r, 0.6) ? P1 : DM;
  const target = chance(r, 0.5) ? { characterId: id } : { tokenId: id === "bree" ? "t1" : "t2" };
  const back = chance(r, 0.3) ? { back: true as const } : {};
  const c = r();
  if (c < 0.22) return { op: { t: "actor.use", target, use: { kind: "slot", level: int(r, 1, 6) }, ...back }, who };
  if (c < 0.3) return { op: { t: "actor.use", target, use: { kind: "pact" }, ...back }, who };
  if (c < 0.4) {
    const die = pick(r, [6, 8, 10, 12] as const);
    return { op: back.back ? { t: "actor.use", target, use: { kind: "hitDie", die }, back: true } : { t: "actor.use", target, use: { kind: "hitDie", die, heal: int(r, 1, 15) } }, who };
  }
  if (c < 0.52) {
    const die = pick(r, [6, 8, 10] as const);
    const asked: Op = { t: "actor.hitDieRoll", tag: `h${seq}`, target, die, ...(id === "bree" && state.characters.bree!.actor.srdId === undefined ? { con: int(r, -2, 4) } : {}) };
    const resolved = resolveDiceOp(asked as never, state, { draw: (sides) => 1 + (seq % sides), batch: "AbCdEfGhIjKlMnOp", srd });
    return resolved.ok ? { op: resolved.op, who } : null;
  }
  if (c < 0.6) {
    const classes = randomClasses(r);
    return { op: { t: "character.update", characterId: id, patch: { classes, ...(classes.length > 0 ? { level: classes.reduce((s, x) => s + x.level, 0) } : {}) } }, who };
  }
  if (c < 0.66) return { op: { t: "actor.rest", target, kind: pick(r, ["short", "long"] as const) }, who };
  if (c < 0.7) return { op: { t: "actor.rest", target: { characterId: id }, kind: "long" }, who: DM };
  if (c < 0.76) {
    // A re-sync's Undo: the classes and the exact spent counts from before, with its guard, as pcSync.ts undoSync sends them.
    const character = state.characters[id]!;
    const classes = randomClasses(r);
    const spent = { slots: Array.from({ length: 9 }, () => int(r, 0, 3)), pact: int(r, 0, 2), dice: { d10: int(r, 0, 4), d6: int(r, 0, 4) } };
    return { op: { t: "character.update", characterId: id, patch: { classes, spent, ddbSync: null }, expect: expectOf(character, ["classes"]) }, who };
  }
  if (c < 0.82) {
    // Wild Shape on and off: Thorn as a Brown Bear over a +0 block, Bree as one with no block.
    const shaped = state.characters[id]!.actor.srdId !== undefined;
    return { op: { t: "character.update", characterId: id, patch: { actor: shaped ? { srdId: null, wildShape: null } : { srdId: "brown-bear", wildShape: true } } } as Op, who };
  }
  return { op: { t: "actor.hp", target, change: chance(r, 0.6) ? { kind: "damage", amount: int(r, 1, 20) } : { kind: "heal", amount: int(r, 1, 20) } }, who: DM };
}

for (const seed of [11, 23, 47]) {
  test(`seed ${seed}: 600 steps keep every count within its most, in normal form, private, and replay alike`, () => {
    const r = rng(seed);
    let state = start();
    const initial = state;
    const applied: { op: Op; who: Viewer; seq: number }[] = [];
    const undo: RestoreEntry[][] = [];
    const redo: RestoreEntry[][] = [];
    let accepted = 0;
    let refusedCount = 0;
    let restores = 0;
    let longRests = 0;
    for (let i = 0, seq = 1; i < 600; i++, seq++) {
      let op: Op;
      let who: Viewer = DM;
      let from: "undo" | "redo" | null = null;
      if (chance(r, 0.08) && undo.length > 0) {
        op = { t: "sys.restore", entries: undo.pop()!, from: "undo", deps: true, scope: "play" } as Op;
        from = "undo";
      } else if (chance(r, 0.04) && redo.length > 0) {
        op = { t: "sys.restore", entries: redo.pop()!, from: "redo", deps: true, scope: "play" } as Op;
        from = "redo";
      } else {
        const next = randomOp(r, state, seq);
        if (!next) continue;
        ({ op, who } = next);
      }
      const held = stableStringify(state);
      const result = applyOp(state, op, who, env(seq));
      if (!result.ok) {
        // Invariant 3: a refused op changed nothing, the state it was given included, held whole.
        assert.equal(stableStringify(state), held, `step ${i}: a refused ${op.t} changed the state`);
        refusedCount++;
        continue;
      }
      accepted++;
      applied.push({ op, who, seq });
      const beforeState = state;
      state = result.state;
      if (op.t === "sys.restore") restores++;
      if (result.inverse && who.role === "dm") {
        if (from === "undo") redo.push(result.inverse);
        else {
          undo.push(result.inverse);
          if (from === null) redo.length = 0;
        }
      }
      for (const id of CHARS) {
        const c = state.characters[id]!;
        // Invariant 1.
        assert.equal(stableStringify(spentWithin(c.spent, c.classes)), stableStringify(c.spent), `seed ${seed} step ${i} ${op.t}: ${id}'s spent in normal form within its counts`);
        if (c.spent?.slots) assert.equal(c.spent.slots.length, slotsOf(c.classes).slots.length);
        if (c.classes !== undefined) assert.ok(c.classes.length > 0, "no classes is none");
        // Invariant 2.
        assert.ok(c.actor.hp.cur <= c.actor.hp.max, `seed ${seed} step ${i}: HP within its most`);
      }
      // Invariant 4.
      if (op.t === "actor.rest") {
        const id = "characterId" in op.target ? op.target.characterId : op.target.tokenId === "t1" ? "bree" : "thorn";
        const c = state.characters[id]!;
        if (op.kind === "long") {
          longRests++;
          assert.equal(c.spent, undefined, `seed ${seed} step ${i}: a Long Rest leaves nothing spent`);
        } else assert.equal(c.spent?.pact, undefined, `seed ${seed} step ${i}: a Short Rest leaves no Pact Magic slot`);
        assert.equal(c.useRev, (beforeState.characters[id]!.useRev ?? 0) + 1, "a rest moves the stamp");
      }
      // Invariant 6.
      const pat = projectState(state, P2, { sceneId: "s1" });
      for (const id of CHARS) {
        const c = pat.characters[id] as Record<string, unknown> | undefined;
        assert.ok(!c || (!("classes" in c) && !("spent" in c) && !("useRev" in c)), `seed ${seed} step ${i}: Pat's copy holds none of the three`);
      }
      assert.doesNotMatch(JSON.stringify(pat.log), /"what":"(slot|pact|hitDie)"|"hitDie":/, `seed ${seed} step ${i}: Pat reads no slot or die line`);
    }
    assert.ok(accepted > 300, `enough applied (${accepted})`);
    assert.ok(refusedCount > 30, `enough refused (${refusedCount})`);
    assert.ok(restores > 10, `enough undos (${restores})`);
    assert.ok(longRests > 5, `enough Long Rests (${longRests})`);
    // Invariant 5.
    let replayed = initial;
    for (const { op, who, seq } of applied) {
      const again = applyOp(replayed, op, who, env(seq));
      assert.ok(again.ok, `replay of ${op.t} at ${seq}`);
      replayed = again.state;
    }
    assert.equal(stableStringify(replayed), stableStringify(state), `seed ${seed}: replay rebuilds the same state`);
  });
}
