import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { Actor, RoomState, UseMark, Viewer } from "../model.ts";
import type { Op } from "../protocol.ts";
import { applyOp, type Applied } from "../reducer.ts";
import { DM, actor, character, env, room, token } from "../testutil.ts";

/**
 * Turn records and their resets (docs/design-v1-combat-controls.md 2.3,
 * 2.4 and 3.3): what each creature of a turn gets when the turn starts, by
 * Next or by a removal, what Previous puts back, and what a fight's end
 * clears.
 */

const legendary = { actionsMax: 3, actionsUsed: 0, resistMax: 3, resistUsed: 0 };
const breath: UseMark = { kind: "recharge", name: "Fire Breath", used: 1, max: 1, min: 5 };
const rays: UseMark = { kind: "turn", name: "Fiery Rays", used: 1, max: 1 };
const dominate: UseMark = { kind: "day", name: "Dominate Mind", used: 1, max: 2 };

/**
 * Rows: Dragon 20, Thorn 15 (a character with a shared wolf), Goblin 12,
 * Bree 10 (beside the warhorse), Warhorse 8. Nobody has acted yet.
 */
function fight(setup?: (s: RoomState) => void, opVersion?: number) {
  const state = room({
    tokens: {
      dragon: token("dragon", { name: "Adult Red Dragon", size: "huge", x: 20, y: 5, actor: { inline: actor({ hp: { cur: 256, max: 256, temp: 0 }, legendary }) } }),
      gob: token("gob", { name: "Goblin", x: 25, y: 20 }),
      thorn: token("thorn", { kind: "pc", name: "Thorn", x: 10, y: 10, actor: { ref: "thorn" } }),
      wolf: token("wolf", { kind: "npc", name: "Wolf", x: 11, y: 10, ownerIds: ["p1"], companion: { of: "thorn", turn: "shared" } }),
      horse: token("horse", { name: "Warhorse", kind: "npc", size: "large", x: 4, y: 4, actor: { inline: actor({ speeds: { walk: 60 } }) } }),
      bree: token("bree", { name: "Bree", kind: "pc", x: 6, y: 4, ownerIds: ["p2"] }),
    },
    characters: { thorn: character("thorn", { name: "Thorn", ownerIds: ["p1"] }) },
  });
  setup?.(state);
  const f = {
    state,
    seq: 0,
    last: null as Applied | null,
    run(op: Op, who: Viewer = DM) {
      f.seq++;
      const r = applyOp(f.state, op, who, { ...env(f.seq), ...(opVersion !== undefined ? { opVersion } : {}) });
      assert.ok(r.ok, `${op.t}: ${r.ok ? "" : r.message}`);
      f.last = r;
      f.state = r.state;
      return f;
    },
    next() {
      return f.run({ t: "encounter.next" });
    },
    prev() {
      return f.run({ t: "encounter.prev" });
    },
    of(id: string): Actor {
      const t = f.state.tokens[id]!;
      return "inline" in t.actor ? t.actor.inline : f.state.characters[t.actor.ref]!.actor;
    },
    put(id: string, patch: Partial<Actor>) {
      const t = f.state.tokens[id]!;
      f.state = { ...f.state };
      if ("ref" in t.actor) f.state.characters = { ...f.state.characters, [t.actor.ref]: { ...f.state.characters[t.actor.ref]!, actor: { ...f.of(id), ...patch } } };
      else f.state.tokens = { ...f.state.tokens, [id]: { ...t, actor: { inline: { ...f.of(id), ...patch } } } };
      return f;
    },
    active(): string | undefined {
      const e = f.state.encounter!;
      return e.entries.find((x) => x.id === e.activeEntryId)?.tokenId;
    },
  };
  return f.run({
    t: "encounter.start",
    entries: [
      { id: "ed", tokenId: "dragon", value: 20 },
      { id: "et", tokenId: "thorn", value: 15 },
      { id: "eg", tokenId: "gob", value: 12 },
      { id: "eb", tokenId: "bree", value: 10 },
      { id: "eh", tokenId: "horse", value: 8 },
    ],
  });
}

describe("turn records (docs/design-v1-combat-controls.md 2.3)", () => {
  test("a dragon's turn start stamps its record: the op's seq, the row and round, its HP and life, and its recharges due", () => {
    const f = fight((s) => {
      s.tokens.dragon = { ...s.tokens.dragon!, actor: { inline: { ...(s.tokens.dragon!.actor as { inline: Actor }).inline, uses: { "actions:fire-breath": breath, "actions:dominate-mind": dominate } } } };
    });
    f.next();
    assert.equal(f.active(), "dragon");
    assert.deepEqual(f.of("dragon").turnRecord, { id: f.seq, entryId: "ed", round: 1, hp: 256, life: "alive", due: ["actions:fire-breath"] });
    assert.deepEqual(f.of("dragon").uses, { "actions:fire-breath": breath, "actions:dominate-mind": dominate }, "a start keeps every mark but the once a turn ones");
  });

  test("a healthy goblin with nothing to track gets no record, and its token stays the very same", () => {
    const f = fight().next().next();
    const before = f.state.tokens.gob;
    f.next();
    assert.equal(f.active(), "gob");
    assert.equal(f.state.tokens.gob, before);
    assert.equal(f.of("gob").turnRecord, undefined);
    f.put("gob", { hp: { cur: 3, max: 7, temp: 0 } }).next().next().next().next().next();
    assert.equal(f.active(), "gob");
    assert.equal(f.of("gob").turnRecord?.hp, 3, "hurt, it gets one");
  });

  test("a breath spent on its own turn is not due until its next start", () => {
    const f = fight().next();
    f.run({ t: "actor.use", target: { tokenId: "dragon" }, use: { kind: "ability", key: "actions:fire-breath", name: "Fire Breath", limit: "recharge", max: 1, min: 5 } });
    assert.equal(f.of("dragon").turnRecord!.due, undefined);
    f.next().next().next().next().next();
    assert.equal(f.active(), "dragon");
    assert.deepEqual(f.of("dragon").turnRecord!.due, ["actions:fire-breath"]);
  });

  test("a start takes the once a turn marks and refills the pips, and Previous puts both back", () => {
    const f = fight().next().next();
    f.run({ t: "actor.use", target: { tokenId: "dragon" }, use: { kind: "legendary", cost: 2, key: "legendaryActions:fiery-rays", name: "Fiery Rays", once: true } });
    assert.deepEqual(f.of("dragon").uses, { "legendaryActions:fiery-rays": rays });
    f.next().next().next().next();
    assert.equal(f.active(), "dragon");
    assert.equal(f.of("dragon").uses, undefined);
    assert.equal(f.of("dragon").legendary!.actionsUsed, 0);
    const record = f.of("dragon").turnRecord;
    f.prev();
    assert.deepEqual(f.of("dragon").uses, { "legendaryActions:fiery-rays": rays }, "the mark comes back whole, its name too");
    assert.equal(f.of("dragon").legendary!.actionsUsed, 2);
    assert.notDeepEqual(f.of("dragon").turnRecord, record, "the record goes back to the one before");
    assert.equal(f.of("dragon").turnRecord!.round, 1);
  });

  test("Previous removes a creature's first record, puts back an older one, and Next after it starts the turn again with a new one", () => {
    const f = fight().next().next();
    assert.equal(f.active(), "thorn");
    assert.equal(f.of("thorn").turnRecord, undefined, "healthy, with nothing to track");
    f.put("thorn", { hp: { cur: 0, max: 30, temp: 0 }, life: "dying" }).next().next().next().next().next();
    assert.equal(f.active(), "thorn");
    const first = f.of("thorn").turnRecord!;
    assert.deepEqual([first.round, first.life], [2, "dying"]);
    f.prev();
    assert.equal(f.of("thorn").turnRecord, undefined, "a first record is removed");
    f.next();
    assert.equal(f.of("thorn").turnRecord!.id, f.seq, "the turn starts again with a new record");
    f.next().next().next().next().next();
    assert.equal(f.of("thorn").turnRecord!.round, 3);
    f.prev();
    assert.equal(f.of("thorn").turnRecord!.round, 2, "Previous puts back the record the start replaced");
  });

  test("a shared companion and a controlled mount get records with the turn, a healthy one included", () => {
    const f = fight().next();
    f.run({ t: "token.attach", tokenId: "bree", to: "horse", kind: "ride", steer: true, x: 5, y: 4, elevation: 0 });
    f.next();
    assert.equal(f.active(), "thorn");
    assert.deepEqual(f.of("wolf").turnRecord, { id: f.seq, entryId: "et", round: 1, hp: 20, life: "alive" });
    f.next().next();
    assert.equal(f.active(), "bree");
    assert.deepEqual(f.state.encounter!.turnStart?.mounts, ["horse"]);
    assert.deepEqual(f.of("horse").turnRecord, { id: f.seq, entryId: "eb", round: 1, hp: 20, life: "alive" });
  });

  test("a mount's marked row starts nothing new, so a recharge failed on its rider's turn gets no second roll", () => {
    const f = fight((s) => {
      s.tokens.horse = { ...s.tokens.horse!, actor: { inline: { ...(s.tokens.horse!.actor as { inline: Actor }).inline, uses: { "actions:fire-breath": breath }, legendary } } };
    });
    f.run({ t: "token.attach", tokenId: "bree", to: "horse", kind: "ride", steer: true, x: 5, y: 4, elevation: 0 });
    f.next().next().next().next();
    assert.equal(f.active(), "bree");
    const record = f.of("horse").turnRecord!;
    assert.deepEqual(record.due, ["actions:fire-breath"]);
    f.run({ t: "actor.use", target: { tokenId: "horse" }, use: { kind: "legendary", cost: 1 } });
    const horse = f.state.tokens.horse;
    f.next();
    assert.equal(f.active(), "horse");
    assert.equal(f.state.encounter!.entries.find((e) => e.id === "eh")!.markRound, 1);
    assert.equal(f.state.tokens.horse, horse, "no record, no reset: the turn began with its rider's");
    assert.equal(f.of("horse").legendary!.actionsUsed, 1);
  });

  test("before op version 20 a marked row's Next refills its pips and writes no record", () => {
    const f = fight((s) => {
      s.tokens.horse = { ...s.tokens.horse!, actor: { inline: { ...(s.tokens.horse!.actor as { inline: Actor }).inline, legendary: { ...legendary, actionsUsed: 2 } } } };
    }, 19);
    f.run({ t: "token.attach", tokenId: "bree", to: "horse", kind: "ride", steer: true, x: 5, y: 4, elevation: 0 });
    f.next().next().next().next();
    assert.equal(f.of("horse").legendary!.actionsUsed, 2, "a rider's turn wrote nothing on its mount then");
    f.next();
    assert.equal(f.active(), "horse");
    assert.equal(f.of("horse").legendary!.actionsUsed, 0);
    assert.equal(f.of("horse").turnRecord, undefined);
    assert.equal(f.state.encounterHistory.at(-1)!.turnUses, undefined);
  });

  test("a removal that passes the turn on starts it with records, ticks no duration and keeps Reactions", () => {
    const f = fight().next();
    f.run({ t: "encounter.update", entryId: "et", patch: { reactionUsed: true } });
    f.run({ t: "actor.effect.add", target: { characterId: "thorn" }, effect: { id: "bless", key: "blessed", duration: { mode: "rounds", rounds: 2, of: { entryId: "et" } } } });
    const effects = f.of("thorn").effects;
    f.run({ t: "encounter.remove", entryIds: ["ed"] });
    assert.equal(f.active(), "thorn");
    assert.equal(f.state.encounter!.entries.find((e) => e.id === "et")!.reactionUsed, true, "Reactions as today");
    assert.deepEqual(f.of("thorn").effects, effects, "no duration ticks");
    assert.deepEqual(f.of("wolf").turnRecord, { id: f.seq, entryId: "et", round: 1, hp: 20, life: "alive" });
    assert.equal(f.state.encounterHistory.length, 1, "it saves no step");
  });

  test("the active token's deletion with a mount sharing the turn starts the next turn with records for both", () => {
    const f = fight();
    f.run({ t: "token.attach", tokenId: "bree", to: "horse", kind: "ride", steer: true, x: 5, y: 4, elevation: 0 });
    f.next().next().next();
    assert.equal(f.active(), "gob");
    f.run({ t: "token.delete", tokenId: "gob" });
    assert.equal(f.active(), "bree");
    assert.deepEqual(f.state.encounter!.turnStart?.mounts, ["horse"]);
    assert.equal(f.of("horse").turnRecord!.entryId, "eb");
    assert.equal(f.of("horse").turnRecord!.id, f.seq);
  });

  test("before op version 20 a removal that passes the turn on writes no actor", () => {
    const f = fight((s) => {
      s.tokens.gob = { ...s.tokens.gob!, actor: { inline: actor({ hp: { cur: 1, max: 7, temp: 0 }, legendary: { ...legendary, actionsUsed: 1 } }) } };
    }, 19);
    f.next();
    f.run({ t: "encounter.remove", entryIds: ["ed", "et"] });
    assert.equal(f.active(), "gob");
    assert.equal(f.of("gob").turnRecord, undefined);
    assert.equal(f.of("gob").legendary!.actionsUsed, 1);
    assert.ok(!f.last!.touched.some((k) => k === "token:gob"));
  });

  test("Previous skips a creature relinked since, and leaves off marks past the bound", () => {
    const f = fight().next().next();
    f.run({ t: "actor.use", target: { tokenId: "dragon" }, use: { kind: "legendary", cost: 1, key: "legendaryActions:fiery-rays", name: "Fiery Rays", once: true } });
    f.next().next().next().next();
    assert.equal(f.active(), "dragon");
    // Relinked to another block: its keys named the old one.
    f.run({ t: "token.update", tokenId: "dragon", patch: { actor: { srdId: "young-red-dragon" } } });
    f.prev();
    assert.equal(f.of("dragon").uses, undefined, "a relinked dragon gets no marks back");
    const g = fight().next().next();
    g.run({ t: "actor.use", target: { tokenId: "dragon" }, use: { kind: "legendary", cost: 1, key: "legendaryActions:fiery-rays", name: "Fiery Rays", once: true } });
    g.next().next().next().next();
    const full: Record<string, UseMark> = {};
    for (let i = 0; i < 16; i++) full[`actions:a${i}`] = { kind: "day", name: `A${i}`, used: 1, max: 2 };
    g.put("dragon", { uses: full }).prev();
    assert.equal(Object.keys(g.of("dragon").uses!).length, 16);
    assert.equal(g.of("dragon").uses!["legendaryActions:fiery-rays"], undefined, "a mark that would not fit is left off");
  });

  test("Previous skips a creature deleted since", () => {
    const f = fight().next();
    f.run({ t: "token.attach", tokenId: "bree", to: "horse", kind: "ride", steer: true, x: 5, y: 4, elevation: 0 });
    f.next().next().next();
    assert.equal(f.active(), "bree");
    assert.ok(f.state.encounterHistory.at(-1)!.turnUses?.some((t) => t.holderId === "horse"));
    f.run({ t: "token.delete", tokenId: "horse" });
    f.prev();
    assert.equal(f.state.tokens.horse, undefined);
  });
});

describe("a fight's end (docs/design-v1-combat-controls.md 2.4)", () => {
  test("clears what lasts a turn from every actor, a creature removed earlier included, and keeps counted uses, recharges and pips", () => {
    const f = fight().next();
    f.run({ t: "actor.use", target: { tokenId: "dragon" }, use: { kind: "legendary", cost: 1, key: "legendaryActions:fiery-rays", name: "Fiery Rays", once: true } });
    f.run({ t: "actor.use", target: { tokenId: "dragon" }, use: { kind: "ability", key: "actions:fire-breath", name: "Fire Breath", limit: "recharge", max: 1, min: 5 } });
    f.run({ t: "actor.use", target: { tokenId: "dragon" }, use: { kind: "ability", key: "actions:dominate-mind", name: "Dominate Mind", limit: "day", max: 2 } });
    f.run({ t: "actor.use", target: { tokenId: "dragon" }, use: { kind: "resist" } });
    assert.ok(f.of("dragon").turnRecord);
    f.run({ t: "encounter.remove", entryIds: ["ed"] });
    f.run({ t: "encounter.end" });
    const dragon = f.of("dragon");
    assert.equal(dragon.turnRecord, undefined);
    assert.equal(dragon.hurt, undefined);
    assert.deepEqual(dragon.uses, { "actions:fire-breath": { ...breath, used: 1 }, "actions:dominate-mind": dominate });
    assert.deepEqual(dragon.legendary, { actionsMax: 3, actionsUsed: 1, resistMax: 3, resistUsed: 1 });
    assert.equal(f.of("wolf").turnRecord, undefined);
  });

  test("before op version 20 it writes no actor", () => {
    const f = fight((s) => {
      s.tokens.dragon = { ...s.tokens.dragon!, actor: { inline: { ...(s.tokens.dragon!.actor as { inline: Actor }).inline, uses: { "legendaryActions:fiery-rays": rays } } } };
    }, 19);
    f.next().run({ t: "encounter.end" });
    assert.deepEqual(f.of("dragon").uses, { "legendaryActions:fiery-rays": rays });
  });
});
