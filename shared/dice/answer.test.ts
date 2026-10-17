import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { DiceResult, LogEvent, RollChange, RollRequest, RollTarget, RoomState, Viewer } from "../model.ts";
import { ANSWERED_MEANWHILE, SETTLED_MEANWHILE, canApply } from "../permissions.ts";
import { projectEntity } from "../project.ts";
import type { Op, OpOf } from "../protocol.ts";
import { applyOp } from "../reducer.ts";
import { FINAL } from "../reducer/rolls.ts";
import { DM, P1, P2, actor, character, companionBlock, effect, env, room, token } from "../testutil.ts";
import { NO_BONUS, OUT_OF_RANGE, resolveDiceOp } from "./resolve.ts";
import { CANNOT_REROLL, LUCKY_CHANGES_NOTHING, type Draw } from "./roll.ts";

/**
 * A request's answer rolled on the server, end to end without the actor
 * (docs/design-v1-dice.md 4.1, 4.3, 5.1 and 5.4): permissions, the resolve
 * with a scripted draw, and the reducer, as the actor runs them in order.
 */
const BATCH = "AbCdEfGhIjKlMnOp";
let tags = 0;

function draws(faces: number[]): Draw {
  return () => {
    const face = faces.shift();
    assert.ok(face !== undefined, "a face for every die");
    return face;
  };
}

/** Bree's (p1) owl with a companion block whose Dexterity save is +2, and Bree herself with no stat block. Dex save, DC 13. */
function setup(request: Partial<RollRequest> = {}, owl: Partial<RollTarget> = {}): RoomState {
  return room({
    characters: { bree: character("bree", { name: "Bree", ownerIds: ["p1"] }) },
    companionBlocks: { b1: companionBlock("b1", "bree") },
    tokens: { owl: token("owl", { kind: "npc", name: "Owl", ownerIds: ["p1"], actor: { inline: actor({ blockId: "b1" }) } }) },
    rolls: {
      r1: {
        id: "r1",
        rev: 0,
        test: { kind: "save", choices: [{ ability: "dex" }] },
        dc: 13,
        dcShown: false,
        resultShown: true,
        at: "2026-10-17T20:00:00.000Z",
        targets: [{ tokenId: "owl", ...owl }, { characterId: "bree" }],
        ...request,
      },
    },
  });
}

type Outcome = { ok: true; state: RoomState; target: RollTarget; line: Extract<LogEvent, { type: "roll" }> } | { ok: false; code: string; message: string };

/** Permissions, then the resolve, then the reducer, as the actor runs them. */
function roll(state: RoomState, who: Viewer, op: Omit<OpOf<"roll.dice">, "t" | "tag" | "rollId"> & { rollId?: string }, faces: number[]): Outcome {
  const full: OpOf<"roll.dice"> = { t: "roll.dice", tag: `tag-${++tags}`, rollId: "r1", ...op };
  const decision = canApply(full, who, state, { canUseAsset: () => true });
  if (!decision.ok) return decision;
  const resolved = resolveDiceOp(full, state, { draw: draws(faces), batch: BATCH });
  if (!resolved.ok) return resolved;
  const applied = applyOp(state, resolved.op, who, env(state.log.length + 10));
  if (!applied.ok) return applied;
  const request = applied.state.rolls.r1!;
  const target = request.targets.find((t) => ("tokenId" in op.target ? t.tokenId === op.target.tokenId : t.characterId === op.target.characterId))!;
  const line = applied.log.at(-1)?.data as Extract<LogEvent, { type: "roll" }>;
  return { ok: true, state: applied.state, target, line };
}

function ok(outcome: Outcome): Extract<Outcome, { ok: true }> {
  assert.ok(outcome.ok, outcome.ok ? "" : `${outcome.code}: ${outcome.message}`);
  return outcome;
}

describe("a request's answer rolled on the server", () => {
  test("the owl's own bonus rolls 1d20+2: total, result, dice and tag on the target and its line (Appendix D)", () => {
    const done = ok(roll(setup(), P1, { target: { tokenId: "owl" } }, [9]));
    assert.equal(done.target.total, 11);
    assert.equal(done.target.result, "fail");
    assert.deepEqual(done.target.dice, { formula: "1d20+2", faces: [9], total: 11 });
    assert.equal(done.target.tag, "tag-1");
    assert.equal(done.target.by, "p1");
    assert.equal(done.target.typedBonus, undefined);
    assert.deepEqual(done.line.dice, done.target.dice);
    assert.equal(done.line.tag, "tag-1");
  });

  test("a mode goes on the d20 alone, cancelled is kept, and an extra adds after the bonus", () => {
    const adv = ok(roll(setup(), P1, { target: { tokenId: "owl" }, mode: "adv", extra: "1d4" }, [4, 15, 3]));
    assert.deepEqual(adv.target.dice, { formula: "2d20kh1+2+1d4", faces: [4, 15, 3], total: 20, mode: "adv" });
    assert.equal(adv.target.result, "pass");
    const both = ok(roll(setup(), P1, { target: { tokenId: "owl" }, cancelled: true, extra: "-1" }, [12]));
    assert.deepEqual(both.target.dice, { formula: "1d20+2-1", faces: [12], total: 13, cancelled: true });
  });

  test("a creature with no bonus known rolls the player's typed one, marked so, and none at all is refused before a draw", () => {
    const typed = ok(roll(setup(), P1, { target: { characterId: "bree" }, bonus: 4 }, [10]));
    assert.equal(typed.target.total, 14);
    assert.equal(typed.target.typedBonus, true);
    assert.equal(typed.line.typedBonus, true);
    assert.deepEqual(roll(setup(), P1, { target: { characterId: "bree" } }, []), { ok: false, code: "invalid", message: NO_BONUS });
    const known = ok(roll(setup(), P1, { target: { tokenId: "owl" }, bonus: 9 }, [10]));
    assert.equal(known.target.total, 12, "the server's own bonus wins over a typed one");
    assert.equal(known.target.typedBonus, undefined);
  });

  test("a roll that could total outside -50 to 100 is refused", () => {
    assert.deepEqual(roll(setup(), P1, { target: { characterId: "bree" }, bonus: 30, extra: "10d10" }, []), { ok: false, code: "invalid", message: OUT_OF_RANGE });
  });

  test("Stunned fails the Dexterity save whatever the total, and a Stunned the DM hid does not", () => {
    const stunned = setup();
    const owl = stunned.tokens.owl!;
    stunned.tokens.owl = { ...owl, actor: { inline: { ...(owl.actor as { inline: ReturnType<typeof actor> }).inline, effects: [effect("e1", { key: "stunned" })] } } };
    const failed = ok(roll(stunned, P1, { target: { tokenId: "owl" } }, [19]));
    assert.equal(failed.target.total, 21);
    assert.equal(failed.target.result, "fail");
    assert.equal(failed.target.dice?.fails, "stunned");
    const hidden = setup();
    hidden.tokens.owl = { ...owl, actor: { inline: { ...(owl.actor as { inline: ReturnType<typeof actor> }).inline, effects: [effect("e1", { key: "stunned", hiddenFromPlayers: true })] } } };
    const passed = ok(roll(hidden, P1, { target: { tokenId: "owl" } }, [19]));
    assert.equal(passed.target.result, "pass");
    assert.equal(passed.target.dice?.fails, undefined);
  });

  test("a player rolls only a waiting creature, and their typed total after a roll is final", () => {
    const done = ok(roll(setup(), P1, { target: { tokenId: "owl" } }, [9]));
    assert.deepEqual(roll(done.state, P1, { target: { tokenId: "owl" } }, [20]), { ok: false, code: "invalid", message: ANSWERED_MEANWHILE });
    const typed = applyOp(done.state, { t: "roll.answer", rollId: "r1", target: { tokenId: "owl" }, total: 18 }, P1, env(99));
    assert.deepEqual(typed.ok ? null : { code: typed.code, message: typed.message }, { code: "forbidden", message: FINAL });
    const typedFirst = applyOp(setup(), { t: "roll.answer", rollId: "r1", target: { tokenId: "owl" }, total: 18 }, P1, env(99));
    assert.ok(typedFirst.ok);
    assert.deepEqual(roll(typedFirst.state, P1, { target: { tokenId: "owl" } }, [20]), { ok: false, code: "invalid", message: ANSWERED_MEANWHILE }, "a typed answer, then Roll: one answer path");
  });

  test("the DM's Roll with unanswered stands only on a waiting creature, and without it replaces the answer, keeping the old as previous", () => {
    const done = ok(roll(setup(), P1, { target: { tokenId: "owl" } }, [9]));
    assert.deepEqual(roll(done.state, DM, { target: { tokenId: "owl" }, unanswered: true }, [20]), { ok: false, code: "invalid", message: ANSWERED_MEANWHILE });
    const replaced = ok(roll(done.state, DM, { target: { tokenId: "owl" } }, [16]));
    assert.equal(replaced.target.total, 18);
    assert.equal(replaced.target.previous?.total, 11);
    assert.deepEqual(replaced.target.previous?.dice?.faces, [9]);
  });

  test("two choices and none sent read as the first, as roll.answer does, and a choice the test lacks is refused", () => {
    const two = setup({ test: { kind: "save", choices: [{ ability: "dex" }, { ability: "str" }] } });
    const done = ok(roll(two, P1, { target: { tokenId: "owl" } }, [10]));
    assert.equal(done.target.choice, 0);
    assert.equal(done.line.choice, 0);
    const str = ok(roll(two, P1, { target: { tokenId: "owl" }, choice: 1 }, [10]));
    assert.equal(str.target.total, 12, "the owl's Strength save is +2");
    assert.equal(str.target.choice, 1);
    assert.equal((roll(setup(), P1, { target: { tokenId: "owl" }, choice: 1 }, []) as { code: string }).code, "invalid");
  });

  test("a player names only a creature of theirs, and a request or creature not there is gone", () => {
    assert.equal((roll(setup(), P2, { target: { tokenId: "owl" } }, []) as { code: string }).code, "gone");
    assert.equal((roll(setup(), P1, { target: { tokenId: "owl" }, rollId: "nope" }, []) as { code: string }).code, "gone");
    assert.equal((roll(setup(), DM, { target: { tokenId: "nobody" } }, []) as { code: string }).code, "gone");
  });
});

describe("the DM's Allow of a change (5.4)", () => {
  /** Owl's rolled answer, then a pending ask on it. */
  function asked(reason: RollChange["reason"], faces: number[], mode?: "adv" | "dis", extra?: Partial<RollChange>): RoomState {
    const done = ok(roll(setup(), P1, { target: { tokenId: "owl" }, ...(mode ? { mode } : {}), ...(faces.length > 2 ? { extra: "1d4" } : {}) }, faces));
    const state = structuredClone(done.state);
    const owl = state.rolls.r1!.targets[0]!;
    owl.change = { id: "ask1", on: owl.tag!, reason, ...extra };
    return state;
  }

  test("Heroic Inspiration on a disadvantage roll of 1 and 18 with +1d4 redraws the 1 alone, keeps the lower, and is final again", () => {
    const state = asked("heroic-inspiration", [1, 18, 2], "dis");
    const allowed = ok(roll(state, DM, { target: { tokenId: "owl" }, change: "ask1" }, [11]));
    assert.deepEqual(allowed.target.dice, { formula: "2d20kl1+2+1d4", faces: [11, 18, 2], total: 15, mode: "dis" });
    assert.equal(allowed.target.result, "pass");
    assert.equal(allowed.target.change, undefined, "the ask clears");
    assert.equal(allowed.target.changed?.id, "ask1");
    assert.deepEqual(allowed.target.previous?.dice?.faces, [1, 18, 2]);
    assert.equal(allowed.line.changed?.reason, "heroic-inspiration");
    assert.deepEqual(roll(allowed.state, P1, { target: { tokenId: "owl" } }, [20]), { ok: false, code: "invalid", message: ANSWERED_MEANWHILE });
  });

  test("on an advantage roll it redraws the dropped d20, and naming the Bless die redraws that alone", () => {
    const adv = ok(roll(asked("heroic-inspiration", [18, 3], "adv"), DM, { target: { tokenId: "owl" }, change: "ask1" }, [19]));
    assert.deepEqual(adv.target.dice?.faces, [18, 19]);
    const bless = ok(roll(asked("heroic-inspiration", [1, 18, 2], "dis", { face: 2 }), DM, { target: { tokenId: "owl" }, change: "ask1" }, [4]));
    assert.deepEqual(bless.target.dice?.faces, [1, 18, 4]);
  });

  test("Halfling Luck redraws a d20 showing 1, and one naming another face is refused before any draw", () => {
    const luck = ok(roll(asked("halfling-luck", [1]), DM, { target: { tokenId: "owl" }, change: "ask1" }, [14]));
    assert.deepEqual(luck.target.dice?.faces, [14]);
    assert.deepEqual(roll(asked("halfling-luck", [9]), DM, { target: { tokenId: "owl" }, change: "ask1" }, []), { ok: false, code: "invalid", message: CANNOT_REROLL });
  });

  test("Lucky draws one more d20 on a normal roll, rolls a disadvantage roll normally with nothing drawn, and is refused on an advantage roll", () => {
    const normal = ok(roll(asked("lucky", [6]), DM, { target: { tokenId: "owl" }, change: "ask1" }, [17]));
    assert.deepEqual(normal.target.dice, { formula: "2d20kh1+2", faces: [6, 17], total: 19, mode: "adv" });
    const dis = ok(roll(asked("lucky", [15, 4], "dis"), DM, { target: { tokenId: "owl" }, change: "ask1" }, []));
    assert.deepEqual(dis.target.dice, { formula: "1d20+2", faces: [15], total: 17, cancelled: true });
    assert.deepEqual(roll(asked("lucky", [15, 4], "adv"), DM, { target: { tokenId: "owl" }, change: "ask1" }, []), { ok: false, code: "invalid", message: LUCKY_CHANGES_NOTHING });
  });

  test("Bardic Inspiration on a rolled 12 against DC 15 adds its d8: 12 + 5 is 17, a pass, with previous keeping 12", () => {
    const state = setup({ dc: 15 });
    const done = ok(roll(state, P1, { target: { tokenId: "owl" } }, [10]));
    assert.equal(done.target.total, 12);
    const withAsk = structuredClone(done.state);
    withAsk.rolls.r1!.targets[0]!.change = { id: "ask1", on: done.target.tag!, reason: "bardic-inspiration", die: 8 };
    const allowed = ok(roll(withAsk, DM, { target: { tokenId: "owl" }, change: "ask1" }, [5]));
    assert.equal(allowed.target.total, 17);
    assert.equal(allowed.target.result, "pass");
    assert.equal(allowed.target.previous?.total, 12);
    assert.equal(allowed.target.dice?.formula, "1d20+2+1d8");
  });

  test("an Allow naming an ask no longer pending, a second Allow, or a player's Allow draws nothing", () => {
    const state = asked("heroic-inspiration", [3]);
    assert.deepEqual(roll(state, DM, { target: { tokenId: "owl" }, change: "older" }, []), { ok: false, code: "invalid", message: SETTLED_MEANWHILE });
    const first = ok(roll(state, DM, { target: { tokenId: "owl" }, change: "ask1" }, [12]));
    assert.deepEqual(roll(first.state, DM, { target: { tokenId: "owl" }, change: "ask1" }, []), { ok: false, code: "invalid", message: SETTLED_MEANWHILE }, "a second device's Allow");
    assert.equal((roll(state, P1, { target: { tokenId: "owl" }, change: "ask1" }, []) as { code: string }).code, "forbidden");
    // An ask naming an older answer than the current one.
    const stale = structuredClone(state);
    stale.rolls.r1!.targets[0]!.change!.on = "someone-else";
    assert.deepEqual(roll(stale, DM, { target: { tokenId: "owl" }, change: "ask1" }, []), { ok: false, code: "invalid", message: SETTLED_MEANWHILE });
  });
});

describe("who reads a rolled answer (5.2)", () => {
  test("its dice go to the creature's players with the target and the line, and the old dice in previous stay the DM's", () => {
    const done = ok(roll(setup(), P1, { target: { tokenId: "owl" } }, [9]));
    const replaced = ok(roll(done.state, DM, { target: { tokenId: "owl" } }, [16]));
    const mine = projectEntity("roll:r1", replaced.state, P1, { sceneId: "s1" }) as RollRequest;
    assert.deepEqual(mine.targets[0]?.dice?.faces, [16]);
    assert.equal(mine.targets[0]?.previous, undefined);
    assert.equal(projectEntity("roll:r1", replaced.state, P2, { sceneId: "s1" }), null);
    const lineId = replaced.state.log.at(-1)!.id;
    const line = projectEntity(`log:${lineId}`, replaced.state, P1, { sceneId: "s1" }) as { data: Extract<LogEvent, { type: "roll" }> };
    assert.deepEqual(line.data.dice?.faces, [16]);
    assert.equal(projectEntity(`log:${lineId}`, replaced.state, P2, { sceneId: "s1" }), null, "no other player gets it, rolled or typed");
  });

  test("a rolled save its condition failed is no mark line, so it reaches its players with pass or fail hidden", () => {
    const state = setup({ resultShown: false });
    const owl = state.tokens.owl!;
    state.tokens.owl = { ...owl, actor: { inline: { ...(owl.actor as { inline: ReturnType<typeof actor> }).inline, effects: [effect("e1", { key: "paralyzed" })] } } };
    const done = ok(roll(state, P1, { target: { tokenId: "owl" } }, [20]));
    const line = projectEntity(`log:${done.state.log.at(-1)!.id}`, done.state, P1, { sceneId: "s1" }) as { data: Extract<LogEvent, { type: "roll" }> } | null;
    assert.ok(line, "the line reaches Bree");
    assert.equal(line.data.result, undefined, "with the result hidden");
  });
});

describe("a death save rolled on the server", () => {
  function dying(deathSaves = { ok: 0, fail: 0 }): RoomState {
    return room({ tokens: { thorn: token("thorn", { kind: "pc", name: "Thorn", ownerIds: ["p1"], actor: { inline: actor({ hp: { cur: 0, max: 20, temp: 0 }, life: "dying", deathSaves }) } }) } });
  }

  function deathRoll(state: RoomState, who: Viewer, faces: number[], extra: Partial<OpOf<"actor.deathRoll">> = {}): RoomState {
    const op: OpOf<"actor.deathRoll"> = { t: "actor.deathRoll", tag: `death-${++tags}`, target: { tokenId: "thorn" }, ...extra };
    assert.ok(canApply(op, who, state, { canUseAsset: () => true }).ok);
    const resolved = resolveDiceOp(op, state, { draw: draws(faces), batch: BATCH });
    assert.ok(resolved.ok);
    const applied = applyOp(state, resolved.op, who, env(5));
    assert.ok(applied.ok, applied.ok ? "" : applied.message);
    return applied.state;
  }

  const saves = (s: RoomState) => (s.tokens.thorn!.actor as { inline: ReturnType<typeof actor> }).inline;

  test("10 or more succeeds, less fails, a natural 1 fails twice, counted from the state then", () => {
    assert.deepEqual(saves(deathRoll(dying({ ok: 1, fail: 0 }), P1, [10])).deathSaves, { ok: 2, fail: 0 });
    assert.deepEqual(saves(deathRoll(dying({ ok: 1, fail: 1 }), P1, [9])).deathSaves, { ok: 1, fail: 2 });
    assert.deepEqual(saves(deathRoll(dying({ ok: 0, fail: 1 }), P1, [1])).deathSaves, { ok: 0, fail: 3 });
    assert.equal(saves(deathRoll(dying({ ok: 0, fail: 1 }), P1, [1])).life, "dead");
    assert.equal(saves(deathRoll(dying({ ok: 2, fail: 0 }), P1, [15])).life, "stable");
  });

  test("a natural 20 regains 1 HP, and a creature no longer dying gets the line and no change", () => {
    const up = saves(deathRoll(dying(), P1, [20]));
    assert.equal(up.hp.cur, 1);
    assert.equal(up.life, "alive");
    const alive = room({ tokens: { thorn: token("thorn", { kind: "pc", ownerIds: ["p1"] }) } });
    const after = deathRoll(alive, P1, [3]);
    assert.deepEqual(saves(after), saves(alive));
    const line = after.log.at(-1)!.data as Extract<LogEvent, { type: "dice" }>;
    assert.equal(line.rolls[0]?.label, "Death save");
    assert.equal(line.to, "all");
  });

  test("a DM's death roll is secret and an extra adds to the total", () => {
    const state = deathRoll(dying(), DM, [8], { extra: "2" });
    const line = state.log.find((e) => e.data?.type === "dice")!.data as Extract<LogEvent, { type: "dice" }>;
    assert.equal(line.to, "dm");
    assert.equal((line.rolls[0] as DiceResult).total, 10);
    assert.deepEqual(saves(state).deathSaves, { ok: 1, fail: 0 });
  });

  test("a player rolls only for a creature of theirs, and the DM for one that exists", () => {
    const op: Op = { t: "actor.deathRoll", tag: "x", target: { tokenId: "thorn" } };
    assert.equal(canApply(op, P2, dying(), { canUseAsset: () => true }).ok, false);
    assert.equal(canApply({ ...op, target: { tokenId: "nobody" } } as Op, DM, dying(), { canUseAsset: () => true }).ok, false);
  });
});
