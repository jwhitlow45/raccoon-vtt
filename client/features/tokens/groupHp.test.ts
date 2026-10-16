import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { clientOpSchema } from "#shared/protocol.ts";
import { applyOp } from "#shared/reducer.ts";
import { actor, DM, room, token } from "#shared/testutil.ts";
import type { ClientOp } from "#shared/protocol.ts";
import { deadHealLine, deadLines, entryOperation, entryRefusal, groupAccess, hpOps, hpTargets, sendHpEntry, type EntryOperation, type HpTarget } from "./groupHp.ts";
import { parseHpInput, type HpMode } from "./hpInput.ts";

const target = (id: string, over: Partial<HpTarget> = {}): HpTarget => ({
  holder: `token:${id}`,
  target: { tokenId: id },
  name: id,
  access: "all",
  atZero: false,
  dead: false,
  max: 20,
  ...over,
});

describe("one HP entry for several creatures", () => {
  test("each creature gets its own op, and a shared character only once", () => {
    const ops = hpOps([target("a"), target("b"), target("pc1", { holder: "character:c" }), target("pc2", { holder: "character:c" })], { kind: "damage", amount: 7 }, false);
    assert.deepEqual(
      ops.map((o) => (o.t === "actor.hp" ? o.target : null)),
      [{ tokenId: "a" }, { tokenId: "b" }, { tokenId: "pc1" }],
    );
    for (const op of ops) assert.ok(clientOpSchema.safeParse(op).success);
  });

  test("what the viewer may not change is left out, and the entry offers only what all of them allow", () => {
    const mixed = [target("own"), target("goblin", { access: "relative" }), target("hidden", { access: "none" })];
    assert.equal(groupAccess(mixed), "relative");
    assert.equal(groupAccess([target("a"), target("b")]), "all");
    assert.equal(groupAccess([target("x", { access: "none" })]), "none");
    assert.deepEqual(
      hpOps(mixed, { kind: "heal", amount: 3 }, false).map((o) => (o.t === "actor.hp" ? o.target : null)),
      [{ tokenId: "own" }, { tokenId: "goblin" }],
    );
    assert.equal(hpOps(mixed, { kind: "set", cur: 1 }, false).length, 1, "a set reaches only the creature that allows it");
  });

  test("a critical hit counts only on creatures at 0 HP", () => {
    const ops = hpOps([target("up"), target("down", { atZero: true })], { kind: "damage", amount: 4 }, true);
    assert.deepEqual(
      ops.map((o) => (o.t === "actor.hp" && o.change.kind === "damage" ? o.change.crit ?? false : null)),
      [false, true],
    );
  });

  test("temporary HP is spent first on each creature, by the shared rules", () => {
    let state = room({
      tokens: {
        g1: token("g1", { actor: { inline: actor({ hp: { cur: 7, max: 7, temp: 5 } }) } }),
        g2: token("g2", { actor: { inline: actor({ hp: { cur: 7, max: 7, temp: 0 } }) } }),
      },
    });
    const targets = hpTargets([state.tokens.g1!, state.tokens.g2!], { role: "dm", memberId: DM.memberId, characters: state.characters, playersApplyDamage: false });
    assert.equal(groupAccess(targets), "all");
    for (const op of hpOps(targets, { kind: "damage", amount: 6 }, false)) {
      const r = applyOp(state, op, DM, { seq: 1, at: new Date(0).toISOString() });
      assert.ok(r.ok);
      state = r.state;
    }
    const hp = (id: string) => {
      const t = state.tokens[id]!;
      return "inline" in t.actor ? t.actor.inline.hp : undefined;
    };
    assert.deepEqual(hp("g1"), { cur: 6, max: 7, temp: 0 });
    assert.deepEqual(hp("g2"), { cur: 1, max: 7, temp: 0 });
  });

  test("one entry for several creatures is one undo step, and one for a single creature needs no group", () => {
    const sent: { op: ClientOp; group?: string }[] = [];
    let n = 0;
    const actions = {
      dispatch(op: ClientOp, opts?: { group?: string }) {
        sent.push({ op, ...(opts?.group !== undefined ? { group: opts.group } : {}) });
        return sent.length;
      },
      newId: () => `g${n++}`,
    };
    sendHpEntry(actions, [target("a"), target("b"), target("c")], { kind: "damage", amount: 7 }, false);
    assert.equal(sent.length, 3);
    assert.ok(sent.every((s) => s.group === "g0"), "every op of the entry shares one undo group");
    sent.length = 0;
    sendHpEntry(actions, [target("a")], { kind: "heal", amount: 2 }, false);
    assert.equal(sent.length, 1);
    assert.equal(sent[0]!.group, undefined);
  });
});

describe("the HP entry's lines on the dead (docs/design-v1-combat-flow.md 3.5)", () => {
  const thorn = target("thorn", { name: "Thorn", dead: true });
  const on = { revives: true, dm: true };
  const off = { revives: false, dm: true };
  /** The operation a DM's entry sends: the typed text once it parses, the chosen mode before, as HpEntry asks. */
  const op = (text: string, mode: HpMode, access: "all" | "relative" = "all"): EntryOperation => entryOperation(access, mode, text.trim() ? parseHpInput(text, mode) : null);

  test("a target's dead flag and maximum come from the viewer's copy", () => {
    const state = room({
      tokens: {
        dead: token("dead", { actor: { inline: actor({ hp: { cur: 0, max: 7, temp: 0 }, life: "dead" }) } }),
        up: token("up"),
      },
    });
    const [dead, up] = hpTargets([state.tokens.dead!, state.tokens.up!], { role: "dm", memberId: DM.memberId, characters: {}, playersApplyDamage: false });
    assert.deepEqual([dead!.dead, dead!.max, up!.dead], [true, 7, false]);
    const label = { ...state.tokens.dead!, actor: { inline: { life: "dead" as const, effects: [], hpLabel: "Dead" as const } } };
    assert.equal(hpTargets([label as never], { role: "player", memberId: "p1", characters: {}, playersApplyDamage: true })[0]!.max, undefined, "no HP in the viewer's copy, no maximum");
  });

  test("with healing on, a heal counts the dead it brings back, and so does a set of a current HP above 0", () => {
    assert.deepEqual(deadLines([thorn], op("5", "heal"), on), ["Brings back 1 dead creature."]);
    assert.deepEqual(deadLines([thorn, target("b", { dead: true }), target("c")], op("5", "heal"), on), ["Brings back 2 dead creatures."]);
    assert.deepEqual(deadLines([thorn], op("=4", "damage"), on), ["Brings back 1 dead creature."]);
    assert.deepEqual(deadLines([thorn], op("=0", "damage"), on), [], "a set of 0 brings nobody back");
    assert.deepEqual(deadLines([thorn], op("", "set"), on), [], "a set says nothing until its HP is typed");
  });

  test("the lines follow what will be sent: +5 under Damage is a heal, -7 under Heal is damage, and the mode decides only before anything parses", () => {
    assert.deepEqual(deadLines([thorn], op("+5", "damage"), on), ["Brings back 1 dead creature."]);
    assert.deepEqual(deadLines([thorn], op("-7", "heal"), on), []);
    assert.deepEqual(deadLines([thorn], op("-7", "heal"), off), [], "damage adds no line with the setting off either");
    assert.deepEqual(deadLines([thorn], op("", "heal"), on), ["Brings back 1 dead creature."]);
    assert.deepEqual(deadLines([thorn], op("", "damage"), on), []);
    assert.deepEqual(deadLines([thorn], op("t5", "heal"), off), [], "temporary HP adds no line");
  });

  test("the count leaves out a maximum of 0 and counts an unknown maximum", () => {
    assert.deepEqual(deadLines([target("z", { dead: true, max: 0 })], op("5", "heal"), on), []);
    assert.deepEqual(deadLines([target("u", { dead: true, max: undefined })], op("5", "heal"), on), ["Brings back 1 dead creature."]);
    assert.deepEqual(deadLines([target("z", { dead: true, max: 0 }), target("u", { dead: true, max: undefined })], op("=3", "set"), on), ["Brings back 1 dead creature."]);
  });

  test("with healing off, a heal and a set say the dead stay dead, for one target and a group, and only the DM is told to Revive first", () => {
    assert.deepEqual(deadLines([thorn], op("5", "heal"), off), ["Healing does nothing while Thorn is dead. Revive Thorn first."]);
    assert.deepEqual(deadLines([thorn], op("5", "heal"), { revives: false, dm: false }), ["Healing does nothing while Thorn is dead."]);
    assert.deepEqual(deadLines([thorn, target("b", { dead: true }), target("c")], op("5", "heal"), off), ["Healing does nothing to the 2 dead among them."]);
    assert.deepEqual(deadLines([thorn], op("=9", "damage"), off), ["Thorn stays dead at the new HP. Only Revive brings Thorn back."]);
    assert.deepEqual(deadLines([thorn], op("", "set"), off), ["Thorn stays dead at the new HP. Only Revive brings Thorn back."]);
    assert.deepEqual(deadLines([thorn, target("b", { dead: true })], op("=9", "set"), off), ["The 2 dead among them stay dead at the new HP. Only Revive brings them back."]);
    assert.deepEqual(deadLines([thorn], op("7", "damage"), off), []);
  });

  test("no line without a dead target, and creatures the viewer cannot reach or that share a character count once", () => {
    assert.deepEqual(deadLines([target("a"), target("b")], op("5", "heal"), off), []);
    assert.deepEqual(deadLines([target("x", { dead: true, access: "none" }), target("a")], op("5", "heal"), on), []);
    const twice = [target("pc1", { holder: "character:c", dead: true }), target("pc2", { holder: "character:c", dead: true })];
    assert.deepEqual(deadLines(twice, op("5", "heal"), on), ["Brings back 1 dead creature."]);
  });

  test("a player who may only deal damage and heal: a typed set or temporary HP is refused before Apply, and its lines follow the mode (SFB-P-10)", () => {
    const set = parseHpInput("=12", "damage");
    assert.ok(set.ok);
    assert.equal(entryRefusal("relative", set.change, 1), "You can only deal damage to or heal this creature.");
    assert.equal(entryRefusal("relative", set.change, 3), "You can only deal damage to or heal these creatures.");
    const temp = parseHpInput("t5", "heal");
    assert.ok(temp.ok);
    assert.notEqual(entryRefusal("relative", temp.change, 1), null);
    for (const text of ["7", "+5", "-3"]) {
      const parsed = parseHpInput(text, "damage");
      assert.ok(parsed.ok);
      assert.equal(entryRefusal("relative", parsed.change, 1), null, `${text} may go`);
    }
    assert.equal(entryRefusal("all", set.change, 1), null, "the DM sets HP");
    // =12 under Damage promises nothing to the dead, and under Heal says what the heal it will send does.
    assert.deepEqual(deadLines([thorn], op("=12", "damage", "relative"), on), []);
    assert.deepEqual(deadLines([thorn], op("=12", "heal", "relative"), on), ["Brings back 1 dead creature."]);
    assert.deepEqual(deadLines([thorn], op("=12", "damage", "relative"), off), [], "no line about a set it cannot send");
    assert.deepEqual(deadLines([thorn], op("=12", "damage"), on), ["Brings back 1 dead creature."], "the DM's set does");
  });

  test("a dead creature's bar tells a player who may heal it what healing will do", () => {
    assert.equal(deadHealLine("Bree", true), "Healing brings Bree back.");
    assert.equal(deadHealLine("Bree", false), "Healing does nothing while Bree is dead. Only the DM's Revive brings Bree back.");
  });
});
