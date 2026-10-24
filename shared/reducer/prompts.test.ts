import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { resolveDiceOp, type DiceOp } from "../dice/resolve.ts";
import type { Actor, RoomState, Settled, UseMark, Viewer } from "../model.ts";
import { NOT_DUE, SETTLED_MEANWHILE, TURN_OVER, canApply, noLongerDying } from "../permissions.ts";
import type { Op } from "../protocol.ts";
import { applyOp } from "../reducer.ts";
import { DM, P1, P2, actor, character, env, room, token } from "../testutil.ts";
import { hpUndoRestore } from "./hpUndo.ts";
import { rechargeLabel } from "./uses.ts";

/**
 * A turn's prompts (docs/design-v1-combat-controls.md 2.3 and 4): each is
 * the occurrence of its record and its name, settled once by the first
 * roll, Apply or Skip from any surface, with its result kept, and refused
 * once settled or once its turn is over, before any die is drawn.
 */

const breath: UseMark = { kind: "recharge", name: "Fire Breath", used: 1, max: 1, min: 5 };

/** Rows: Dragon 20, Thorn 15 (dying), Troll 12, Bree 10 on the warhorse 8. */
function table(): RoomState {
  const state = room({
    tokens: {
      dragon: token("dragon", { name: "Young Red Dragon", actor: { inline: actor({ hp: { cur: 170, max: 178, temp: 0 }, uses: { "actions:fire-breath": breath } }) } }),
      thorn: token("thorn", { kind: "pc", name: "Thorn", x: 10, y: 10, actor: { ref: "thorn" } }),
      troll: token("troll", { name: "Troll", x: 14, y: 10, actor: { inline: actor({ hp: { cur: 40, max: 94, temp: 0 } }) } }),
      horse: token("horse", { name: "Warhorse", kind: "npc", size: "large", x: 4, y: 4, actor: { inline: actor({ uses: { "actions:fire-breath": breath } }) } }),
      bree: token("bree", { name: "Bree", kind: "pc", x: 6, y: 4, ownerIds: ["p2"] }),
    },
    characters: { thorn: character("thorn", { name: "Thorn", ownerIds: ["p1"], actor: actor({ hp: { cur: 0, max: 30, temp: 0 }, life: "dying", deathSaves: { ok: 1, fail: 1 } }) }) },
  });
  state.meta.settings = { ...state.meta.settings, monstersDieAtZero: false };
  return state;
}

function fight() {
  const f = {
    state: table(),
    seq: 0,
    run(op: Op, who: Viewer = DM) {
      f.seq++;
      const r = applyOp(f.state, op, who, env(f.seq));
      assert.ok(r.ok, `${op.t}: ${r.ok ? "" : r.message}`);
      f.state = r.state;
      return f;
    },
    refusal(op: Op, who: Viewer = DM): string {
      const r = applyOp(f.state, op, who, env(f.seq + 1));
      assert.ok(!r.ok, `${op.t} was meant to be refused`);
      return r.message;
    },
    /** A roll as the server takes it: permitted first, before any die, then resolved with this face on every die. */
    roll(op: DiceOp, face: number, who: Viewer = DM) {
      const permitted = canApply(op, who, f.state, { canUseAsset: () => true });
      assert.ok(permitted.ok, permitted.ok ? "" : permitted.message);
      const resolved = resolveDiceOp(op, f.state, { draw: () => face, batch: "AbCdEfGhIjKlMnOp" });
      assert.ok(resolved.ok);
      return f.run(resolved.op, who);
    },
    /** Why the server refuses a roll before drawing, or null. */
    before(op: Op, who: Viewer = DM): string | null {
      const d = canApply(op, who, f.state, { canUseAsset: () => true });
      return d.ok ? null : d.message;
    },
    of(id: string): Actor {
      const t = f.state.tokens[id]!;
      return "inline" in t.actor ? t.actor.inline : f.state.characters[t.actor.ref]!.actor;
    },
    settled(id: string, what: string): Settled | undefined {
      return (f.of(id).turnRecord?.settled as Record<string, Settled> | undefined)?.[what];
    },
    record(id: string): number {
      return f.of(id).turnRecord!.id;
    },
  };
  f.run({
    t: "encounter.start",
    entries: [
      { id: "ed", tokenId: "dragon", value: 20 },
      { id: "et", tokenId: "thorn", value: 15 },
      { id: "er", tokenId: "troll", value: 12 },
      { id: "eb", tokenId: "bree", value: 10 },
      { id: "eh", tokenId: "horse", value: 8 },
    ],
  });
  return f;
}

const deathRoll = (record?: number): DiceOp => ({ t: "actor.deathRoll", tag: `d${record ?? "x"}`, target: { tokenId: "thorn" }, ...(record !== undefined ? { record } : {}) });
const recharge = (tokenId: string, record?: number, tag = "r1"): DiceOp => ({ t: "actor.rechargeRoll", tag, target: { tokenId }, key: "actions:fire-breath", name: "Fire Breath", min: 5, ...(record !== undefined ? { record } : {}) });
const skip = (tokenId: string, record: number, what: string, state: "skipped" | "open" = "skipped"): Op => ({ t: "actor.prompt", target: { tokenId }, record, what, state });

describe("a death save prompt (docs/design-v1-combat-controls.md 4.4)", () => {
  test("the first roll anywhere settles it with its total and outcome, and a second is refused before its die", () => {
    const f = fight().run({ t: "encounter.next" }).run({ t: "encounter.next" });
    const record = f.record("thorn");
    assert.equal(f.of("thorn").turnRecord!.life, "dying");
    f.roll(deathRoll(record), 14, P1);
    assert.deepEqual(f.settled("thorn", "deathSave"), { state: "done", total: 14, outcome: "success" });
    assert.deepEqual(f.of("thorn").deathSaves, { ok: 2, fail: 1 });
    assert.equal(f.before(deathRoll(record)), SETTLED_MEANWHILE);
    const again = resolveDiceOp(deathRoll(record), f.state, { draw: () => 3, batch: "AbCdEfGhIjKlMnOp" });
    assert.ok(again.ok);
    assert.equal(f.refusal(again.op), SETTLED_MEANWHILE, "and the reducer refuses a roll that got past");
  });

  test("a natural 1 counts two failures and a natural 20 regains 1 HP, each kept as its outcome", () => {
    const one = fight().run({ t: "encounter.next" }).run({ t: "encounter.next" });
    one.roll(deathRoll(one.record("thorn")), 1);
    assert.deepEqual(one.settled("thorn", "deathSave"), { state: "done", total: 1, outcome: "twoFailures" });
    const twenty = fight().run({ t: "encounter.next" }).run({ t: "encounter.next" });
    twenty.roll(deathRoll(twenty.record("thorn")), 20);
    assert.deepEqual(twenty.settled("thorn", "deathSave"), { state: "done", total: 20, outcome: "regain" });
    assert.equal(twenty.of("thorn").hp.cur, 1);
    // Next and Previous leave Thorn's record as it was: his turn resumes with its result.
    twenty.run({ t: "encounter.next" }).run({ t: "encounter.prev" });
    assert.deepEqual(twenty.settled("thorn", "deathSave"), { state: "done", total: 20, outcome: "regain" });
    const fail = fight().run({ t: "encounter.next" }).run({ t: "encounter.next" });
    fail.roll(deathRoll(fail.record("thorn")), 4);
    assert.equal(fail.settled("thorn", "deathSave")!.outcome, "failure");
  });

  test("a roll without a record stays manual and settles nothing", () => {
    const f = fight().run({ t: "encounter.next" }).run({ t: "encounter.next" });
    f.roll(deathRoll(), 12);
    assert.equal(f.settled("thorn", "deathSave"), undefined);
    assert.deepEqual(f.of("thorn").deathSaves, { ok: 2, fail: 1 });
  });

  test("healed from another device, the death save is over and a roll sent meanwhile is refused before its die", () => {
    const f = fight().run({ t: "encounter.next" }).run({ t: "encounter.next" });
    const record = f.record("thorn");
    f.run({ t: "actor.hp", target: { characterId: "thorn" }, change: { kind: "heal", amount: 5 } });
    assert.equal(f.before(deathRoll(record), P1), noLongerDying("Thorn"));
  });

  test("damage at 0 HP counts a failure and leaves the prompt open", () => {
    const f = fight().run({ t: "encounter.next" }).run({ t: "encounter.next" });
    const record = f.record("thorn");
    f.run({ t: "actor.hp", target: { characterId: "thorn" }, change: { kind: "damage", amount: 3 } });
    assert.equal(f.of("thorn").deathSaves.fail, 2);
    assert.equal(f.settled("thorn", "deathSave"), undefined);
    assert.equal(f.before(deathRoll(record), P1), null, "the card's Roll still settles it");
  });

  test("a roll after Next is refused: that turn is over", () => {
    const f = fight().run({ t: "encounter.next" }).run({ t: "encounter.next" });
    const record = f.record("thorn");
    f.run({ t: "encounter.next" });
    assert.equal(f.before(deathRoll(record), P1), TURN_OVER);
    assert.equal(f.before(skip("thorn", record, "deathSave"), P1), TURN_OVER);
  });

  test("a prompt the record never held is not due", () => {
    const f = fight().run({ t: "encounter.next" });
    assert.equal(f.before({ t: "actor.prompt", target: { tokenId: "dragon" }, record: f.record("dragon"), what: "deathSave", state: "skipped" }), NOT_DUE);
    assert.equal(f.before({ t: "actor.prompt", target: { tokenId: "dragon" }, record: f.record("dragon"), what: "recharge:actions:wing-attack", state: "skipped" }), NOT_DUE);
  });
});

describe("Skip and Reopen (docs/design-v1-combat-controls.md 4.1)", () => {
  test("the DM and whoever answers for the creature skip a prompt for everyone, reopen it while its turn runs, and never reopen a done one", () => {
    const f = fight().run({ t: "encounter.next" }).run({ t: "encounter.next" });
    const record = f.record("thorn");
    f.run(skip("thorn", record, "deathSave"), P1);
    assert.deepEqual(f.settled("thorn", "deathSave"), { state: "skipped" });
    assert.equal(f.before(skip("thorn", record, "deathSave")), SETTLED_MEANWHILE);
    f.run(skip("thorn", record, "deathSave", "open"), DM);
    assert.equal(f.settled("thorn", "deathSave"), undefined);
    assert.equal(f.of("thorn").turnRecord!.settled, undefined, "an empty record of answers goes");
    const twice = applyOp(f.state, skip("thorn", record, "deathSave", "open"), DM, env(f.seq + 1));
    assert.ok(twice.ok);
    assert.deepEqual(twice.touched, [], "reopening an open prompt changes nothing");
    f.roll(deathRoll(record), 11, P1);
    assert.equal(f.before(skip("thorn", record, "deathSave", "open")), SETTLED_MEANWHILE, "a roll's result stands");
  });

  test("another player never answers for Thorn", () => {
    const f = fight().run({ t: "encounter.next" }).run({ t: "encounter.next" });
    const d = canApply(skip("thorn", f.record("thorn"), "deathSave"), P2, f.state, { canUseAsset: () => true });
    assert.ok(!d.ok && d.code === "forbidden");
  });
});

describe("a recharge prompt (docs/design-v1-combat-controls.md 4.5)", () => {
  test("a roll of its range or more readies the ability, and less keeps it used, the result kept either way", () => {
    const f = fight().run({ t: "encounter.next" });
    const record = f.record("dragon");
    assert.deepEqual(f.of("dragon").turnRecord!.due, ["actions:fire-breath"]);
    f.roll(recharge("dragon", record), 5);
    assert.equal(f.of("dragon").uses, undefined);
    assert.deepEqual(f.settled("dragon", "recharge:actions:fire-breath"), { state: "done", total: 5, outcome: "ready" });
    const g = fight().run({ t: "encounter.next" });
    g.roll(recharge("dragon", g.record("dragon")), 2);
    assert.deepEqual(g.of("dragon").uses, { "actions:fire-breath": breath });
    assert.deepEqual(g.settled("dragon", "recharge:actions:fire-breath"), { state: "done", total: 2, outcome: "used" });
  });

  test("two devices rolling at once count one roll", () => {
    const f = fight().run({ t: "encounter.next" });
    const record = f.record("dragon");
    const first = resolveDiceOp(recharge("dragon", record, "a"), f.state, { draw: () => 2, batch: "AbCdEfGhIjKlMnOp" });
    const second = resolveDiceOp(recharge("dragon", record, "b"), f.state, { draw: () => 6, batch: "AbCdEfGhIjKlMnOp" });
    assert.ok(first.ok && second.ok);
    f.run(first.op);
    assert.equal(f.refusal(second.op), SETTLED_MEANWHILE);
    assert.equal(f.before(recharge("dragon", record, "c")), SETTLED_MEANWHILE);
  });

  test("its dice line names the roll and follows a roll's Secret", () => {
    const f = fight().run({ t: "encounter.next" });
    const op = resolveDiceOp(recharge("dragon", f.record("dragon")), f.state, { draw: () => 6, batch: "AbCdEfGhIjKlMnOp" });
    assert.ok(op.ok);
    const r = applyOp(f.state, op.op, DM, env(9));
    assert.ok(r.ok);
    const line = r.log.find((e) => e.data?.type === "dice")!.data as Extract<NonNullable<typeof r.log[0]["data"]>, { type: "dice" }>;
    assert.equal(line.rolls[0]!.label, "Fire Breath recharge");
    assert.equal(line.rolls[0]!.formula, "1d6");
    assert.equal(line.to, "dm", "the DM's monster rolls in secret");
    assert.equal(rechargeLabel("A".repeat(120)).length, 60);
    assert.ok(rechargeLabel("A".repeat(120)).endsWith("… recharge"));
    assert.equal(rechargeLabel(`${"A".repeat(50)}\u{1F525}\u{1F525}`).includes("\uD83D…"), false, "no half character");
  });

  test("Mark ready settles the open prompt as done, and a manual roll outside one settles nothing", () => {
    const f = fight().run({ t: "encounter.next" });
    f.run({ t: "actor.use", target: { tokenId: "dragon" }, use: { kind: "ability", key: "actions:fire-breath", name: "Fire Breath", limit: "recharge", max: 1, min: 5 }, back: true });
    assert.deepEqual(f.settled("dragon", "recharge:actions:fire-breath"), { state: "done", outcome: "ready" });
    assert.equal(f.before(recharge("dragon", f.record("dragon"))), SETTLED_MEANWHILE);
    const g = fight().run({ t: "encounter.next" }).run({ t: "encounter.next" });
    g.roll(recharge("dragon"), 6);
    assert.equal(g.of("dragon").uses, undefined, "a roll outside its prompt still readies the ability");
    assert.equal(g.settled("dragon", "recharge:actions:fire-breath"), undefined);
  });

  test("a mount that gets off mid-turn keeps its record and its prompt", () => {
    const f = fight();
    f.run({ t: "token.attach", tokenId: "bree", to: "horse", kind: "ride", steer: true, x: 5, y: 4, elevation: 0 });
    f.run({ t: "encounter.next" }).run({ t: "encounter.next" }).run({ t: "encounter.next" }).run({ t: "encounter.next" });
    assert.equal(f.state.encounter!.activeEntryId, "eb");
    const record = f.of("horse").turnRecord!;
    f.run({ t: "token.detach", tokenId: "bree", x: 6, y: 4 });
    assert.deepEqual(f.of("horse").turnRecord, record);
    f.roll(recharge("horse", record.id), 6);
    assert.equal(f.settled("horse", "recharge:actions:fire-breath")!.outcome, "ready");
  });
});

describe("a Regeneration prompt (docs/design-v1-combat-controls.md 4.3)", () => {
  const regenerate = (record: number, amount = 10): Op => ({ t: "actor.use", target: { tokenId: "troll" }, use: { kind: "regenerate", key: "traits:regeneration", amount, record } });

  test("Apply heals by the rules and settles it with the amount, once", () => {
    const f = fight().run({ t: "encounter.next" }).run({ t: "encounter.next" }).run({ t: "encounter.next" });
    const record = f.record("troll");
    f.run(regenerate(record));
    assert.equal(f.of("troll").hp.cur, 50);
    assert.deepEqual(f.settled("troll", "regeneration"), { state: "done", total: 10 });
    assert.equal(f.refusal(regenerate(record)), SETTLED_MEANWHILE);
    assert.equal(f.before(regenerate(record)), SETTLED_MEANWHILE);
  });

  test("taking the heal back reopens it while its turn runs, so its card returns", () => {
    const f = fight().run({ t: "encounter.next" }).run({ t: "encounter.next" }).run({ t: "encounter.next" });
    const record = f.record("troll");
    f.run(regenerate(record));
    const line = f.state.log.find((e) => e.data?.type === "hp" && e.data.change === "heal")!;
    assert.equal(line.data?.type === "hp" && line.data.revert?.record, record);
    const undo = hpUndoRestore(f.state, line.id);
    assert.ok(undo.ok);
    f.run({ t: "sys.restore", entries: undo.entries, from: "undo", deps: true, undid: line.id });
    assert.equal(f.of("troll").hp.cur, 40);
    assert.equal(f.settled("troll", "regeneration"), undefined);
    f.run(regenerate(record, 15));
    assert.equal(f.of("troll").hp.cur, 55);
  });

  test("a dying troll gets up, and a dead one regenerates only where healing brings back the dead", () => {
    const f = fight();
    f.state.tokens.troll = { ...f.state.tokens.troll!, actor: { inline: actor({ hp: { cur: 0, max: 94, temp: 0 }, life: "dying" }) } };
    f.run({ t: "encounter.next" }).run({ t: "encounter.next" }).run({ t: "encounter.next" });
    assert.equal(f.of("troll").turnRecord!.life, "dying");
    f.run(regenerate(f.record("troll")));
    assert.equal(f.of("troll").life, "alive");
    const g = fight();
    g.state.meta.settings = { ...g.state.meta.settings, skipDefeated: false, healRevives: false };
    g.state.tokens.troll = { ...g.state.tokens.troll!, actor: { inline: actor({ hp: { cur: 0, max: 94, temp: 0 }, life: "dead" }) } };
    g.run({ t: "encounter.next" }).run({ t: "encounter.next" }).run({ t: "encounter.next" });
    assert.equal(g.state.encounter!.activeEntryId, "er");
    const before = g.state.log.length;
    g.run(regenerate(g.record("troll")));
    assert.equal(g.of("troll").life, "dead");
    assert.deepEqual(g.settled("troll", "regeneration"), { state: "done", total: 0 });
    assert.equal(g.state.log.length, before, "no HP line for a heal that did nothing");
  });
});

describe("prompts that end before their roll (docs/design-v1-combat-controls.md 2.3)", () => {
  test("a rest that readies the ability mid-turn leaves its recharge prompt settled", () => {
    const f = fight().run({ t: "encounter.next" });
    f.run({ t: "actor.rest", target: { tokenId: "dragon" }, kind: "short", heal: 0 });
    assert.equal(f.of("dragon").uses, undefined);
    assert.equal(f.before(recharge("dragon", f.record("dragon"))), SETTLED_MEANWHILE);
  });

  test("a breath back mid-turn by a rest, a roll without its record or a new block, then spent again, settles its turn's roll as ready, and that roll is refused", () => {
    const spend: Op = { t: "actor.use", target: { tokenId: "dragon" }, use: { kind: "ability", key: "actions:fire-breath", name: "Fire Breath", limit: "recharge", max: 1, min: 5 } };
    const backs: Record<string, (f: ReturnType<typeof fight>) => void> = {
      rest: (f) => f.run({ t: "actor.rest", target: { tokenId: "dragon" }, kind: "short", heal: 0 }),
      "manual roll": (f) => f.roll(recharge("dragon"), 6),
      relink: (f) => f.run({ t: "token.update", tokenId: "dragon", patch: { actor: { srdId: "young-red-dragon" } } }),
    };
    for (const [how, back] of Object.entries(backs)) {
      const f = fight().run({ t: "encounter.next" });
      const record = f.record("dragon");
      back(f);
      assert.equal(f.of("dragon").uses, undefined, how);
      f.run(spend);
      assert.deepEqual(f.of("dragon").uses, { "actions:fire-breath": breath }, how);
      assert.deepEqual(f.settled("dragon", "recharge:actions:fire-breath"), { state: "done", outcome: "ready" }, how);
      assert.equal(f.before(recharge("dragon", record)), SETTLED_MEANWHILE, how);
      const resolved = resolveDiceOp(recharge("dragon", record), f.state, { draw: () => 6, batch: "AbCdEfGhIjKlMnOp" });
      assert.ok(resolved.ok);
      assert.equal(f.refusal(resolved.op), SETTLED_MEANWHILE, how);
    }
  });

  test("a spend after the turn's own roll, on another creature's turn, or of another kind, settles nothing more", () => {
    const spend: Op = { t: "actor.use", target: { tokenId: "dragon" }, use: { kind: "ability", key: "actions:fire-breath", name: "Fire Breath", limit: "recharge", max: 1, min: 5 } };
    const f = fight().run({ t: "encounter.next" });
    f.roll(recharge("dragon", f.record("dragon")), 6);
    f.run(spend);
    assert.deepEqual(f.settled("dragon", "recharge:actions:fire-breath"), { state: "done", total: 6, outcome: "ready" });
    const g = fight().run({ t: "encounter.next" }).run({ t: "actor.rest", target: { tokenId: "dragon" }, kind: "short", heal: 0 }).run({ t: "encounter.next" });
    const before = g.of("dragon").turnRecord;
    g.run(spend);
    assert.deepEqual(g.of("dragon").turnRecord, before);
    // A block edited since makes the breath 1/Day: that spend brings back no recharge, so the turn's roll stays open.
    const h = fight().run({ t: "encounter.next" });
    h.run({ t: "actor.use", target: { tokenId: "dragon" }, use: { kind: "ability", key: "actions:fire-breath", name: "Fire Breath", limit: "day", max: 1 } });
    assert.equal(h.settled("dragon", "recharge:actions:fire-breath"), undefined);
  });

  test("a shared companion moved off the row's scene keeps its record through its turn, and in the next round only the round refuses it", () => {
    let state = room({
      tokens: {
        thorn: token("thorn", { kind: "pc", name: "Thorn", actor: { ref: "thorn" } }),
        wolf: token("wolf", { kind: "npc", name: "Wolf", ownerIds: ["p1"], companion: { of: "thorn", turn: "shared" }, actor: { inline: actor({ hp: { cur: 5, max: 11, temp: 0 } }) } }),
      },
      characters: { thorn: character("thorn", { name: "Thorn", ownerIds: ["p1"] }) },
    });
    let seq = 0;
    const run = (op: Op) => {
      const r = applyOp(state, op, DM, env(++seq));
      assert.ok(r.ok, `${op.t}: ${r.ok ? "" : r.message}`);
      state = r.state;
    };
    const wolf = () => (state.tokens.wolf!.actor as { inline: Actor }).inline;
    run({ t: "encounter.start", entries: [{ id: "et", tokenId: "thorn", value: 10 }] });
    run({ t: "encounter.next" });
    const record = wolf().turnRecord!;
    assert.deepEqual([record.entryId, record.round], ["et", 1]);
    run({ t: "token.update", tokenId: "wolf", patch: { sceneId: "s2" } });
    const answer = skip("wolf", record.id, "regeneration");
    assert.ok(canApply(answer, DM, state, { canUseAsset: () => true }).ok, "its turn still runs");
    run({ t: "encounter.next" });
    assert.deepEqual([state.encounter!.round, state.encounter!.activeEntryId], [2, "et"]);
    assert.equal(wolf().turnRecord, record, "no start reached it on the other scene");
    const later = canApply(answer, DM, state, { canUseAsset: () => true });
    assert.ok(!later.ok && later.message === TURN_OVER);
    const r = applyOp(state, answer, DM, env(++seq));
    assert.ok(!r.ok && r.message === TURN_OVER);
  });

  test("a recharge roll never readies a mark of another kind under its key", () => {
    const f = fight();
    f.state.tokens.dragon = { ...f.state.tokens.dragon!, actor: { inline: actor({ uses: { "actions:fire-breath": { kind: "day", name: "Fire Breath", used: 1, max: 1 } } }) } };
    f.roll(recharge("dragon"), 6);
    assert.deepEqual(f.of("dragon").uses, { "actions:fire-breath": { kind: "day", name: "Fire Breath", used: 1, max: 1 } });
  });

  test("a Regeneration heal taken back after its turn reopens nothing", () => {
    const f = fight().run({ t: "encounter.next" }).run({ t: "encounter.next" }).run({ t: "encounter.next" });
    f.run({ t: "actor.use", target: { tokenId: "troll" }, use: { kind: "regenerate", key: "traits:regeneration", amount: 10, record: f.record("troll") } });
    f.run({ t: "encounter.next" });
    const line = f.state.log.find((e) => e.data?.type === "hp" && e.data.change === "heal")!;
    const undo = hpUndoRestore(f.state, line.id);
    assert.ok(undo.ok);
    f.run({ t: "sys.restore", entries: undo.entries, from: "undo", deps: true, undid: line.id });
    assert.deepEqual(f.settled("troll", "regeneration"), { state: "done", total: 10 });
  });
});
