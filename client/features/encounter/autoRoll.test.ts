import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { createStore } from "zustand/vanilla";
import { batchRolls } from "#shared/dice/batch.ts";
import { advantageFields, parseFormula, type AdvantageSource } from "#shared/dice/formula.ts";
import { resolveDiceOp } from "#shared/dice/resolve.ts";
import { rollFormula } from "#shared/dice/roll.ts";
import type { DiceRoll, InitEntry, LogEntry, RoomState } from "#shared/model.ts";
import { canApply } from "#shared/permissions.ts";
import { projectState } from "#shared/project.ts";
import type { ClientOp, OpOf } from "#shared/protocol.ts";
import { applyOp } from "#shared/reducer.ts";
import { DM, P1, actor, apply, character, chance, comparable, effect, entry, env, int, pick, rng, room, token } from "#shared/testutil.ts";
import { findRolls } from "../dice/logic.ts";
import { presetFor } from "../dice/presets.ts";
import { createDicePanel, type DiceState, type PanelRoll } from "../dice/useDicePanel.ts";
import { ReceiptTracker, type ReceiptState } from "../dice/useReceipt.ts";
import { blankActor } from "../tokens/factory.ts";
import {
  MAY_HAVE_HAPPENED,
  NOT_READ,
  ROLL_MODES,
  clampValue,
  commonModifier,
  decodePrefs,
  describeRoll,
  encodePrefs,
  initiativeRolls,
  joinGroups,
  noBonusSet,
  notSet,
  planPress,
  planRolls,
  rollOps,
  rollRows,
  rollStillShown,
  rowsToRoll,
  settleRoll,
  valuesFrom,
  type RollMode,
  type RollPress,
  type RollRow,
} from "./autoRoll.ts";
import { entryName, sortedEntries } from "./logic.ts";

const row = (entryId: string, patch: Partial<RollRow> = {}): RollRow => ({
  entryId,
  tokenId: `t-${entryId}`,
  name: entryId,
  modifier: 2,
  sources: [],
  extra: [],
  value: null,
  ...patch,
});

const INVISIBLE: AdvantageSource = { kind: "adv", from: "invisible" };
const POISONED: AdvantageSource = { kind: "dis", from: "poisoned" };

const ids = (groups: { rows: { entryId: string }[] }[]) => groups.map((g) => g.rows.map((r) => r.entryId));

/** The rows as the tracker reads them, each with the initiative preset from the DM's view. */
function rowsOf(state: RoomState, entries: readonly InitEntry[] = sortedEntries(state.encounter?.entries ?? []), name: (e: InitEntry) => string = (e) => entryName(state, e)) {
  const dice = { you: { memberId: DM.memberId, role: "dm" as const }, view: state, srd: { monsters: null, rolls: null } };
  return rollRows(state, entries, name, (creature) => presetFor(dice, creature, { kind: "initiative" }, { rolls: null }));
}

/** A landed roll for each panel roll, in order, as the server's resolve would write it with these d20 faces. */
function landedRolls(rolls: readonly PanelRoll[], faces: readonly number[]): DiceRoll[] {
  let i = 0;
  const draw = (sides: number) => {
    const face = faces[i++];
    if (face === undefined) throw new Error("the test ran out of dice");
    assert.ok(face >= 1 && face <= sides);
    return face;
  };
  return rolls.map((roll) => {
    const parsed = parseFormula(roll.formula);
    assert.ok(parsed.ok, roll.formula);
    const fields = advantageFields(roll.sources ?? []);
    const rolled = rollFormula(parsed.formula, draw, fields.mode);
    assert.ok(rolled.ok);
    const out: DiceRoll = { ...rolled.result };
    if (fields.cancelled) out.cancelled = true;
    if (roll.label !== undefined) out.label = roll.label;
    if (roll.creature && "tokenId" in roll.creature) out.tokenId = roll.creature.tokenId;
    return out;
  });
}

const line = (tag: string, rolls: DiceRoll[], id = "1:0"): LogEntry => ({ id, at: "2026-10-17T20:00:00.000Z", kind: "event", data: { type: "dice", tag, by: DM.memberId, to: "dm", rolls } });

const committed = (rolls: DiceRoll[], tag = "tag"): ReceiptState => ({ state: "committed", lines: [line(tag, rolls)] });

/** A press as the device keeps it right after the tap. */
function pressOf(rows: readonly RollRow[], mode: RollMode, kept: readonly RollRow[] = [], tag = "tag"): RollPress {
  const plan = planPress(rows, mode, kept);
  return { mode, ...plan, tag: plan.groups.length > 0 ? tag : null, rolled: null, error: null, changed: [], done: false };
}

/** The fight as it stands for these rows: each at its value, or as patched. */
const entriesOf = (rows: readonly RollRow[], patch: Record<string, number | null> = {}) => rows.map((r) => ({ id: r.entryId, value: r.entryId in patch ? patch[r.entryId]! : r.value }));

/** One press landed with these faces against the rows' own fight. */
function landed(rows: readonly RollRow[], mode: RollMode, faces: readonly number[], kept: readonly RollRow[] = []) {
  const press = pressOf(rows, mode, kept);
  const receipt = press.tag === null ? null : committed(landedRolls(initiativeRolls(press.groups), faces));
  const settled = settleRoll(press, receipt, entriesOf([...rows, ...kept]));
  assert.ok(settled);
  return settled;
}

const setValues = (ops: readonly ClientOp[]) => ops.flatMap((op) => (op.t === "encounter.setValues" ? op.values : []));

describe("the modifier", () => {
  test("a row rolls with its creature's initiative bonus, never its score", () => {
    const state = room();
    state.tokens = { gob: token("gob", { actor: { inline: actor({ initBonus: -1, initScore: 15 }) } }) };
    assert.equal(rowsOf(state, [entry("e", { tokenId: "gob" })], () => "").rows[0]!.modifier, -1);
  });

  test("only a hand-made token's +0 reads as no bonus set", () => {
    assert.equal(noBonusSet(blankActor()), true);
    assert.equal(noBonusSet(blankActor({ initBonus: 3 })), false);
    assert.equal(noBonusSet(actor({ initBonus: 0, cr: "1/4" })), false, "a stat block's real +0");
    assert.equal(noBonusSet(undefined), false);
  });

  test("a crowd adds the modifier most of it has, the higher on a tie", () => {
    assert.equal(commonModifier([2, 2, 2, -1]), 2);
    assert.equal(commonModifier([1, 3]), 3);
    assert.equal(commonModifier([-1, -1, 4]), -1);
    assert.equal(commonModifier([0]), 0);
  });
});

describe("which rows roll", () => {
  test("monsters and NPCs the DM runs, never player characters or creatures a player owns", () => {
    const state = room();
    state.characters.c1 = character("c1");
    state.tokens = {
      gob: token("gob", { name: "Goblin", number: 1, actor: { inline: actor({ initBonus: 2 }) } }),
      npc: token("npc", { kind: "npc", name: "Guard", actor: { inline: actor({ initBonus: 1 }) } }),
      pc: token("pc", { kind: "pc", name: "Thorn", ownerIds: ["p1"], actor: { ref: "c1" } }),
      fam: token("fam", { kind: "npc", name: "Owl", ownerIds: ["p1"], actor: { inline: actor() } }),
    };
    const entries = [
      entry("e-gob", { tokenId: "gob", value: null, groupKey: "Goblin" }),
      entry("e-npc", { tokenId: "npc", value: 12, groupKey: "Guard" }),
      entry("e-pc", { tokenId: "pc", value: null }),
      entry("e-fam", { tokenId: "fam", value: null, groupKey: "Owl" }),
      entry("e-char", { characterId: "c1", value: null }),
      entry("e-lair", { label: "Lair", value: 20 }),
    ];
    const { rows, skipped } = rowsOf(state, entries);
    assert.deepEqual(rows, [
      { entryId: "e-gob", tokenId: "gob", name: "Goblin 1", groupKey: "Goblin", modifier: 2, sources: [], extra: [], value: null },
      { entryId: "e-npc", tokenId: "npc", name: "Guard", groupKey: "Guard", modifier: 1, sources: [], extra: [], value: 12 },
    ]);
    assert.deepEqual(skipped, []);
  });

  test("the preset comes from the DM's mark in place of the tracker's hint, with Poisoned and Exhaustion either way", () => {
    let state = room();
    const effects: Record<string, ReturnType<typeof effect>[]> = {
      inv: [effect("x", { key: "invisible" })],
      sur: [effect("y", { key: "surprised" })],
      stun: [effect("y", { key: "stunned" })],
      both: [effect("x", { key: "invisible" }), effect("y", { key: "surprised" })],
      marked: [effect("x", { key: "invisible" })],
      poisoned: [effect("x", { key: "poisoned" })],
      markedPoisoned: [effect("x", { key: "poisoned" })],
      tired: [effect("x", { key: "exhaustion", level: 2 })],
    };
    state.tokens = Object.fromEntries(Object.entries(effects).map(([id, list]) => [id, token(id, { actor: { inline: actor({ effects: list }) } })]));
    // The mark is read from the fight's own row, as every initiative path reads it (presetFor).
    const marks: Record<string, "adv" | "dis"> = { marked: "dis", markedPoisoned: "adv" };
    state = apply(state, { t: "encounter.start", entries: Object.keys(effects).map((id) => ({ id, tokenId: id, ...(marks[id] ? { advantage: marks[id] } : {}) })) });
    const { rows } = rowsOf(state);
    const byId = new Map(rows.map((r) => [r.entryId, r]));
    assert.deepEqual(
      Object.keys(effects).map((id) => [id, byId.get(id)!.sources.map((s) => `${s.kind} ${s.from}`), byId.get(id)!.extra]),
      [
        ["inv", ["adv invisible"], []],
        ["sur", ["dis surprised"], []],
        ["stun", ["dis stunned"], []],
        ["both", ["dis surprised", "adv invisible"], []],
        ["marked", ["dis tracker"], []],
        ["poisoned", ["dis poisoned"], []],
        ["markedPoisoned", ["adv tracker", "dis poisoned"], []],
        ["tired", [], ["-4"]],
      ],
    );
    // Invisible and Surprised cancel, and the roll says so.
    assert.deepEqual(advantageFields(byId.get("both")!.sources), { cancelled: true });
  });

  test("dead monsters and every creature on another scene are reported, not rolled", () => {
    const state = room();
    state.tokens = { dead: token("dead", { actor: { inline: actor({ life: "dead" }) } }) };
    const entries = [
      entry("e-dead", { tokenId: "dead" }),
      entry("e-away", { tokenId: "elsewhere", groupKey: "goblin" }),
      entry("e-pc-away", { tokenId: "pc-elsewhere" }),
    ];
    const { rows, skipped } = rowsOf(state, entries, () => "");
    assert.deepEqual(rows, []);
    assert.deepEqual(skipped, [
      { entryId: "e-dead", reason: "dead" },
      { entryId: "e-away", reason: "elsewhere" },
      { entryId: "e-pc-away", reason: "elsewhere" },
    ]);
  });

  test("the count of creatures elsewhere never depends on grouping: an ungrouped monster counts, a familiar counts as a creature", () => {
    // Two scenes: the DM views s1, and a goblin and a player's owl wait on s2.
    let state = room();
    state.tokens = {
      g1: token("g1", { name: "Goblin", number: 1, actor: { inline: actor({ srdId: "goblin-warrior" }) } }),
      away: token("away", { sceneId: "s2", name: "Goblin", number: 2, actor: { inline: actor({ srdId: "goblin-warrior" }) } }),
      owl: token("owl", { sceneId: "s2", kind: "npc", name: "Owl", ownerIds: ["p1"], actor: { inline: actor() } }),
    };
    state = apply(state, { t: "encounter.start", entries: ["g1", "away", "owl"].map((id) => ({ id: `e-${id}`, tokenId: id })) });
    const elsewhere = (s: RoomState) => {
      const dmView = projectState(s, DM, { sceneId: "s1" }) as unknown as RoomState;
      return rowsOf(dmView, sortedEntries(dmView.encounter!.entries), () => "")
        .skipped.filter((k) => k.reason === "elsewhere")
        .map((k) => k.entryId)
        .sort();
    };
    assert.equal(state.encounter!.entries.find((e) => e.id === "e-owl")!.groupKey, "Owl", "a familiar gets a group key too");
    assert.deepEqual(elsewhere(state), ["e-away", "e-owl"]);
    const ungrouped = apply(state, { t: "encounter.update", entryId: "e-away", patch: { groupKey: null } });
    assert.deepEqual(elsewhere(ungrouped), ["e-away", "e-owl"]);
  });

  test("by default only rows still waiting for a value roll", () => {
    const rows = [row("a"), row("b", { value: 14 }), row("c")];
    assert.deepEqual(
      rowsToRoll(rows, false).map((r) => r.entryId),
      ["a", "c"],
    );
    assert.deepEqual(
      rowsToRoll(rows, true).map((r) => r.entryId),
      ["a", "b", "c"],
    );
  });
});

describe("grouping", () => {
  const goblins = [row("g1", { groupKey: "goblin" }), row("g2", { groupKey: "goblin" }), row("g3", { groupKey: "goblin" })];
  const ogre = row("ogre", { groupKey: "ogre", modifier: -1 });
  const wolf = row("wolf", { groupKey: "wolf" });

  test("by creature, identical monsters share one roll and every other monster rolls its own", () => {
    const groups = planRolls([goblins[0]!, ogre, goblins[1]!, wolf, goblins[2]!], "creature");
    assert.deepEqual(ids(groups), [["g1", "g2", "g3"], ["ogre"], ["wolf"]]);
    assert.deepEqual(
      groups.map((g) => g.modifier),
      [2, -1, 2],
    );
  });

  test("by creature, an ungrouped monster rolls alone", () => {
    const groups = planRolls([goblins[0]!, row("g-alone"), goblins[1]!], "creature");
    assert.deepEqual(ids(groups), [["g1", "g2"], ["g-alone"]]);
  });

  test("by creature, a member with its own advantage or modifier splits off, so each total is its own", () => {
    const groups = planRolls([goblins[0]!, { ...goblins[1]!, sources: [INVISIBLE] }, { ...goblins[2]!, modifier: 4 }], "creature");
    assert.deepEqual(ids(groups), [["g1"], ["g2"], ["g3"]]);
    assert.deepEqual(
      groups.map((g) => [g.modifier, advantageFields(g.sources).mode ?? "none"]),
      [
        [2, "none"],
        [2, "adv"],
        [4, "none"],
      ],
    );
  });

  test("groups and joins with extras: an exhausted goblin never shares a roll or a value with the rested ones", () => {
    const tired = { ...goblins[2]!, extra: ["-2"] };
    const groups = planRolls([goblins[0]!, goblins[1]!, tired], "creature");
    assert.deepEqual(ids(groups), [["g1", "g2"], ["g3"]]);
    assert.deepEqual(
      groups.map((g) => g.extra),
      [[], ["-2"]],
    );
    // Two at the same level share, and a deeper level splits again.
    const twoTired = planRolls([{ ...goblins[0]!, extra: ["-2"] }, { ...goblins[1]!, extra: ["-2"] }, { ...goblins[2]!, extra: ["-4"] }], "creature");
    assert.deepEqual(ids(twoTired), [["g1", "g2"], ["g3"]]);
    // A waiting goblin joins only a group with its own penalty.
    const rested = [row("k1", { groupKey: "goblin", value: 14 }), row("k2", { groupKey: "goblin", value: 14 })];
    assert.deepEqual(joinGroups([row("new", { groupKey: "goblin", extra: ["-2"] })], rested).joined, []);
    assert.deepEqual(
      joinGroups([row("new", { groupKey: "goblin" })], rested).joined.map((j) => j.total),
      [14],
    );
  });

  test("by creature, the key compares what the sources resolve to, not the sources themselves", () => {
    const marked = { ...goblins[0]!, sources: [{ kind: "adv", from: "tracker" } as AdvantageSource] };
    const invisible = { ...goblins[1]!, sources: [INVISIBLE] };
    const cancelled = { ...goblins[2]!, sources: [INVISIBLE, POISONED] };
    const plain = row("g4", { groupKey: "goblin" });
    const groups = planRolls([marked, invisible, cancelled, plain], "creature");
    // Advantage from the mark and from Invisible roll alike. A cancelled roll is recorded as one, so it stands apart from a plain one.
    assert.deepEqual(ids(groups), [["g1", "g2"], ["g3"], ["g4"]]);
    assert.deepEqual(advantageFields(groups[1]!.sources), { cancelled: true });
  });

  test("one each gives every monster its own roll, groups or not", () => {
    assert.deepEqual(ids(planRolls([...goblins, ogre], "each")), [["g1"], ["g2"], ["g3"], ["ogre"]]);
  });

  test("all at once is one roll for every monster", () => {
    const [group] = planRolls([...goblins, ogre, wolf], "all");
    assert.deepEqual(ids([group!]), [["g1", "g2", "g3", "ogre", "wolf"]]);
    assert.equal(group!.modifier, 2);
    assert.equal(group!.mixedModifier, true);
    assert.equal(group!.mixedAdvantage, false);
    assert.equal(group!.mixedExtra, false);
    assert.deepEqual(group!.sources, []);
    assert.deepEqual(group!.extra, []);
  });

  test("all at once keeps an advantage every monster shares, and rolls straight when they differ", () => {
    const [shared] = planRolls([row("a", { sources: [POISONED] }), row("b", { sources: [{ kind: "dis", from: "surprised" }] })], "all");
    assert.equal(advantageFields(shared!.sources).mode, "dis");
    assert.equal(shared!.mixedAdvantage, false);
    assert.equal(shared!.mixedModifier, false);
    const [mixed] = planRolls([row("a", { sources: [INVISIBLE] }), row("b")], "all");
    assert.deepEqual(mixed!.sources, []);
    assert.equal(mixed!.mixedAdvantage, true);
  });

  test("all at once adds the extra most of them have, the first in order on a tie, and says they differ", () => {
    const [most] = planRolls([row("a", { extra: ["-2"] }), row("b"), row("c", { extra: ["-2"] })], "all");
    assert.deepEqual(most!.extra, ["-2"]);
    assert.equal(most!.mixedExtra, true);
    const [tie] = planRolls([row("a"), row("b", { extra: ["-4"] })], "all");
    assert.deepEqual(tie!.extra, []);
    assert.equal(tie!.mixedExtra, true);
    const [same] = planRolls([row("a", { extra: ["-2"] }), row("b", { extra: ["-2"] })], "all");
    assert.deepEqual(same!.extra, ["-2"]);
    assert.equal(same!.mixedExtra, false);
  });

  test("no rows, no rolls", () => {
    assert.deepEqual(planRolls([], "all"), []);
    assert.deepEqual(planRolls([], "creature"), []);
  });
});

describe("the rolls sent to the server", () => {
  test("one roll per shared roll: its label counts who shares it, its creature is the first row's token", () => {
    const groups = planRolls(
      [
        row("g1", { groupKey: "goblin", tokenId: "tok-g1" }),
        row("g2", { groupKey: "goblin", tokenId: "tok-g2" }),
        row("g3", { groupKey: "goblin", tokenId: "tok-g3" }),
        row("g4", { groupKey: "goblin", tokenId: "tok-g4" }),
        row("ogre", { modifier: -1, tokenId: "tok-ogre", sources: [POISONED] }),
      ],
      "creature",
    );
    assert.deepEqual(initiativeRolls(groups), [
      { formula: "1d20+2", label: "Initiative, shared by 4", creature: { tokenId: "tok-g1" }, sources: [], initiative: true },
      { formula: "1d20-1", label: "Initiative", creature: { tokenId: "tok-ogre" }, sources: [POISONED], initiative: true },
    ]);
  });

  test("the extra follows the modifier, and a +0 is a plain d20", () => {
    const groups = planRolls([row("a", { extra: ["-2"] }), row("b", { modifier: 0 }), row("c", { modifier: 0, extra: ["-4"] })], "each");
    assert.deepEqual(
      initiativeRolls(groups).map((r) => r.formula),
      ["1d20+2-2", "1d20", "1d20-4"],
    );
  });

  test("the panel sends them behind the screen with their own sources only, never the choices pressed for the next roll", () => {
    const sent: ClientOp[] = [];
    const store = createStore<DiceState>(() => ({ adv: false, dis: true, secret: false, version: 0, last: null }));
    const sender = { dispatch: (op: ClientOp) => sent.push(op), connected: () => true, receipts: new ReceiptTracker() };
    const panel = createDicePanel({ store, sender, secretStart: () => true });
    const groups = planRolls([row("a", { sources: [INVISIBLE] }), row("b", { sources: [INVISIBLE, POISONED] }), row("c")], "each");
    const tag = panel.roll(initiativeRolls(groups), { to: "dm" });
    assert.ok(tag);
    assert.equal(sent.length, 1);
    const op = sent[0] as OpOf<"dice.roll">;
    assert.equal(op.to, "dm");
    assert.equal(op.tag, tag);
    assert.ok(op.rolls.every((r) => r.initiative === true), "marked as initiative, for the order setting (docs/design-v1-combat-flow.md 11.3)");
    assert.deepEqual(
      op.rolls.map((r) => [r.formula, r.mode, r.cancelled]),
      [
        ["1d20+2", "adv", undefined],
        ["1d20+2", undefined, true],
        ["1d20+2", undefined, undefined],
      ],
    );
    assert.equal(store.getState().dis, true, "the panel's own Dis waits for its own roll");
  });

  test("230 monsters one each split into batches under one tag", () => {
    const rolls = initiativeRolls(planRolls(Array.from({ length: 230 }, (_, i) => row(`m${i}`)), "each"));
    const batched = batchRolls(
      rolls.map(({ sources = [], ...rest }) => ({ ...rest, ...advantageFields(sources) })),
      { tag: "0192f0a8-6c1e-7a4b-9c3d-2e1f0a9b8c7d", to: "dm" as const },
    );
    assert.ok(batched.ok);
    assert.equal(batched.ops.reduce((n, op) => n + op.rolls.length, 0), 230);
  });
});

describe("values from the landed rolls", () => {
  test("each row takes its group's total, from the line's own faces", () => {
    const groups = planRolls([row("g1", { groupKey: "goblin" }), row("g2", { groupKey: "goblin" }), row("ogre", { groupKey: "ogre", modifier: -1 }), row("wolf", { groupKey: "wolf", sources: [INVISIBLE] })], "creature");
    const out = valuesFrom(groups, landedRolls(initiativeRolls(groups), [12, 7, 3, 18]));
    assert.ok(out);
    assert.deepEqual(
      out.rolled.map((g) => [g.roll.faces, g.roll.mode, g.total]),
      [
        [[12], undefined, 14],
        [[7], undefined, 6],
        [[3, 18], "adv", 20],
      ],
    );
    assert.deepEqual(out.values, [
      { entryId: "g1", value: 14 },
      { entryId: "g2", value: 14 },
      { entryId: "ogre", value: 6 },
      { entryId: "wolf", value: 20 },
    ]);
  });

  test("totals stay inside what the op accepts", () => {
    const groups = planRolls([row("huge", { modifier: 90 }), row("tiny", { modifier: -60 })], "each");
    const out = valuesFrom(groups, landedRolls(initiativeRolls(groups), [20, 1]));
    assert.deepEqual(
      out?.values.map((v) => v.value),
      [100, -50],
    );
    assert.equal(clampValue(-51), -50);
  });

  test("rolls that do not answer the groups one to one set nothing", () => {
    const groups = planRolls([row("a"), row("b")], "each");
    const rolls = landedRolls(initiativeRolls(groups), [5, 6]);
    assert.equal(valuesFrom(groups, rolls.slice(0, 1)), null, "a batch missing");
    assert.equal(valuesFrom(groups, [rolls[1]!, rolls[0]!]), null, "another creature's roll in its place");
  });
});

describe("what lands sends", () => {
  test("over 100 rows go out in batches the op accepts, every row once", () => {
    const rows = Array.from({ length: 230 }, (_, i) => row(`m${i}`));
    const { ops, press } = landed(rows, "each", Array.from({ length: 230 }, (_, i) => (i % 20) + 1));
    assert.deepEqual(
      ops.map((op) => (op.t === "encounter.setValues" ? op.values.length : -1)),
      [100, 100, 30],
    );
    assert.deepEqual(
      setValues(ops).map((v) => v.entryId),
      rows.map((r) => r.entryId),
    );
    assert.equal(press.rolled?.length, 230);
    assert.equal(press.mode, "each");
  });

  test("a re-roll that lands on a row's own value leaves that row out, and the card still shows it", () => {
    const rows = [row("a", { value: 14 }), row("b", { value: 9 }), row("c", { value: 5 })];
    // d20 12 + 2 = 14 for a (unchanged), 3 + 2 = 5 for b, 3 + 2 = 5 for c (unchanged).
    const { ops, press } = landed(rows, "each", [12, 3, 3]);
    assert.deepEqual(ops, [{ t: "encounter.setValues", values: [{ entryId: "b", value: 5 }] }]);
    assert.deepEqual(
      press.rolled?.map((g) => [g.rows[0]!.entryId, g.total]),
      [
        ["a", 14],
        ["b", 5],
        ["c", 5],
      ],
    );
  });

  test("nothing to send when every total is already in place", () => {
    assert.deepEqual(landed([row("a", { value: 14 })], "each", [12]).ops, []);
  });

  test("a row typed after the tap keeps its value and is named, and a row gone from the fight is left out", () => {
    const rows = [row("a"), row("b"), row("c")];
    const press = pressOf(rows, "each");
    const receipt = committed(landedRolls(initiativeRolls(press.groups), [10, 11, 12]));
    const settled = settleRoll(press, receipt, [
      { id: "a", value: 7 },
      { id: "c", value: null },
    ]);
    assert.ok(settled);
    assert.deepEqual(settled.ops, [{ t: "encounter.setValues", values: [{ entryId: "c", value: 14 }] }]);
    assert.deepEqual(settled.press.changed, ["a"]);
  });

  test("a row that changed to the very total it rolled is neither set nor named", () => {
    const { ops, changed } = rollOps([{ entryId: "a", value: 12 }], [{ entryId: "a", value: null }], [{ id: "a", value: 12 }]);
    assert.deepEqual(ops, []);
    assert.deepEqual(changed, []);
  });
});

describe("settling a press", () => {
  const rows = [row("g1", { groupKey: "goblin" }), row("g2", { groupKey: "goblin" }), row("ogre")];
  const press = pressOf(rows, "creature");
  const atTap = entriesOf(rows);

  test("nothing happens while the dice are on their way", () => {
    assert.equal(settleRoll(press, null, atTap), null);
    assert.equal(settleRoll(press, { state: "sending" }, atTap), null);
    assert.equal(settleRoll(press, { state: "checking" }, atTap), null);
  });

  test("committed lines set the totals once, and a settled press never acts again", () => {
    const settled = settleRoll(press, committed(landedRolls(initiativeRolls(press.groups), [9, 4])), atTap);
    assert.ok(settled);
    assert.deepEqual(setValues(settled.ops), [
      { entryId: "g1", value: 11 },
      { entryId: "g2", value: 11 },
      { entryId: "ogre", value: 6 },
    ]);
    assert.equal(settled.press.done, true);
    assert.equal(settled.press.error, null);
    assert.equal(settleRoll(settled.press, committed(landedRolls(initiativeRolls(press.groups), [9, 4])), atTap), null);
  });

  test("a refused roll sets nothing and says why", () => {
    const settled = settleRoll(press, { state: "refused", code: "quota", message: "Too fast.", text: "You are rolling too fast." }, atTap);
    assert.deepEqual(settled, { press: { ...press, done: true, error: "Nothing was set. You are rolling too fast." }, ops: [] });
    assert.equal(notSet(""), "Nothing was set.");
  });

  test("one refused batch beside committed ones sets nothing either", () => {
    const receipt: ReceiptState = {
      state: "committed",
      lines: [line("tag", landedRolls(initiativeRolls(press.groups).slice(0, 1), [9]))],
      refused: { code: "quota", message: "Too fast.", text: "" },
    };
    const settled = settleRoll(press, receipt, atTap);
    assert.deepEqual(settled?.ops, []);
    assert.equal(settled?.press.error, "Nothing was set. Too fast.");
    assert.equal(settled?.press.rolled, null);
  });

  test("an unknown answer sets nothing and sends nothing again on its own", () => {
    const settled = settleRoll(press, { state: "unknown" }, atTap);
    assert.deepEqual(settled?.ops, []);
    assert.equal(settled?.press.error, MAY_HAVE_HAPPENED);
    assert.equal(settled?.press.error, "This may have happened. Check the log.");
    assert.equal(settleRoll(settled!.press, { state: "unknown" }, atTap), null);
  });

  test("lines that cannot be read set nothing", () => {
    const settled = settleRoll(press, { state: "committed", lines: [] }, atTap);
    assert.deepEqual(settled?.ops, []);
    assert.equal(settled?.press.error, NOT_READ);
  });

  test("with nothing to roll, the joined values go at once", () => {
    const kept = [row("k1", { groupKey: "goblin", value: 14 })];
    const joinOnly = pressOf([row("g3", { groupKey: "goblin" })], "creature", kept);
    assert.equal(joinOnly.tag, null);
    assert.deepEqual(initiativeRolls(joinOnly.groups), []);
    const settled = settleRoll(joinOnly, null, entriesOf([row("g3", { groupKey: "goblin" }), ...kept]));
    assert.deepEqual(settled?.ops, [{ t: "encounter.setValues", values: [{ entryId: "g3", value: 14 }] }]);
    assert.deepEqual(settled?.press.rolled, []);
  });
});

describe("a monster added mid-fight", () => {
  const goblins = [row("g1", { groupKey: "goblin", value: 14 }), row("g2", { groupKey: "goblin", value: 14 })];

  test("by creature, it takes its identical group's value instead of rolling alone", () => {
    const g3 = row("g3", { groupKey: "goblin" });
    const ogre = row("ogre", { groupKey: "ogre" });
    // One die only: the ogre's. A second roll would run out of dice.
    const { ops, press } = landed([g3, ogre], "creature", [9], goblins);
    assert.deepEqual(ops, [
      {
        t: "encounter.setValues",
        values: [
          { entryId: "ogre", value: 11 },
          { entryId: "g3", value: 14 },
        ],
      },
    ]);
    assert.deepEqual(
      press.joined.map((j) => [j.rows.map((r) => r.entryId), j.total]),
      [[["g3"], 14]],
    );
    assert.deepEqual(ids(press.groups), [["ogre"]]);
  });

  test("it rolls when it is not quite identical, ungrouped, or its group holds different values", () => {
    const invisible = row("g3", { groupKey: "goblin", sources: [INVISIBLE] });
    const tougher = row("g4", { groupKey: "goblin", modifier: 4 });
    const loner = row("g5");
    assert.deepEqual(joinGroups([invisible, tougher, loner], goblins).joined, []);
    const split = [row("g1", { groupKey: "goblin", value: 14 }), row("g2", { groupKey: "goblin", value: 6 })];
    assert.deepEqual(joinGroups([row("g3", { groupKey: "goblin" })], split).joined, []);
  });

  test("one each and all at once roll it as they always do", () => {
    const g3 = row("g3", { groupKey: "goblin" });
    assert.deepEqual(planPress([g3], "each", goblins).joined, []);
    assert.deepEqual(planPress([g3], "all", goblins).joined, []);
  });
});

describe("the card belongs to its fight", () => {
  const rows = [row("a", { groupKey: "goblin" }), row("b", { groupKey: "goblin" }), row("c")];
  const { press } = landed(rows, "creature", [12, 5]);
  const fightWith = (...entries: [string, number | null][]) => ({ entries: entries.map(([id, value]) => ({ id, value })) });

  test("it holds while its rows keep the totals it rolled", () => {
    assert.equal(rollStillShown(press, fightWith(["a", 14], ["b", 14], ["c", 7], ["pc", 12]), false), true);
    // The DM typed over one goblin: the others still carry the roll.
    assert.equal(rollStillShown(press, fightWith(["a", 3], ["b", 14], ["c", 3]), false), true);
  });

  test("it goes when the fight ends or another one starts", () => {
    assert.equal(rollStillShown(press, null, false), false);
    // A new fight has new rows, even when a total happens to match.
    assert.equal(rollStillShown(press, fightWith(["x", 14], ["y", 7]), false), false);
  });

  test("it goes when an undo takes the roll back, but not while the roll is still on its way", () => {
    assert.equal(rollStillShown(press, fightWith(["a", null], ["b", null], ["c", null]), false), false);
    assert.equal(rollStillShown(press, fightWith(["a", null], ["b", null], ["c", null]), true), true);
    assert.equal(rollStillShown(press, fightWith(["x", null]), true), false, "waiting never keeps it into another fight");
  });

  test("before its dice land, and when nothing was set, it holds while its rows are in the fight", () => {
    const waiting = pressOf(rows, "creature");
    assert.equal(rollStillShown(waiting, fightWith(["a", null]), false), true);
    const refused = { ...waiting, done: true, error: notSet("Too fast.") };
    assert.equal(rollStillShown(refused, fightWith(["c", 3]), false), true);
    assert.equal(rollStillShown(refused, fightWith(["x", 3]), false), false);
  });
});

describe("what the DM reads", () => {
  test("each roll's faces, plainly, with a typographic minus", () => {
    assert.equal(describeRoll({ formula: "1d20+2", faces: [12], total: 14 }), "d20 (12) +2 = 14");
    assert.equal(describeRoll({ formula: "2d20kh1-1", faces: [5, 17], total: 16 }), "2d20 with advantage (5, 17) keeps 17, −1 = 16");
    assert.equal(describeRoll({ formula: "2d20kl1", faces: [5, 17], total: 5 }), "2d20 with disadvantage (5, 17) keeps 5 = 5");
    assert.equal(describeRoll({ formula: "1d20+2-2", faces: [12], total: 12 }), "d20 (12) +2 −2 = 12");
    assert.equal(describeRoll({ formula: "1d20", faces: [9], total: 9 }), "d20 (9) = 9");
    assert.equal(describeRoll({ formula: "1d20+1-1d4", faces: [9, 3], total: 7 }), "d20 (9) +1 −1d4 (3) = 7");
  });

  test("a result whose faces do not match its formula reads as its formula and total", () => {
    assert.equal(describeRoll({ formula: "1d20+2", faces: [], total: 14 }), "1d20+2 = 14");
  });
});

describe("the remembered mode", () => {
  test("round trips, and anything else reads as by creature", () => {
    assert.deepEqual(decodePrefs(encodePrefs({ mode: "all" })), { mode: "all" });
    assert.deepEqual(decodePrefs(encodePrefs({ mode: "each" })), { mode: "each" });
    assert.deepEqual(decodePrefs(null), { mode: "creature" });
    assert.deepEqual(decodePrefs("{"), { mode: "creature" });
    assert.deepEqual(decodePrefs('{"mode":"boss"}'), { mode: "creature" });
    assert.deepEqual(decodePrefs("null"), { mode: "creature" });
  });
});

// ---------------------------------------------------------------- against the real reducer

/** A fight: Thorn (a PC), three goblins, an ogre and a hidden assassin, nobody rolled yet. */
function fight(): RoomState {
  let state = room();
  state.characters.c1 = character("c1", { name: "Thorn", actor: actor({ initBonus: 2 }) });
  state.tokens = {
    thorn: token("thorn", { kind: "pc", name: "Thorn", ownerIds: ["p1"], actor: { ref: "c1" }, x: 1, y: 1 }),
    g1: token("g1", { name: "Goblin", number: 1, actor: { inline: actor({ initBonus: 2, srdId: "goblin-warrior" }) }, x: 2, y: 2 }),
    g2: token("g2", { name: "Goblin", number: 2, actor: { inline: actor({ initBonus: 2, srdId: "goblin-warrior" }) }, x: 3, y: 2 }),
    g3: token("g3", { name: "Goblin", number: 3, actor: { inline: actor({ initBonus: 2, srdId: "goblin-warrior" }) }, x: 4, y: 2 }),
    ogre: token("ogre", { name: "Ogre", actor: { inline: actor({ initBonus: -1 }) }, x: 6, y: 6 }),
    sly: token("sly", { name: "Assassin", visibility: "dm", actor: { inline: actor({ initBonus: 4 }) }, x: 8, y: 8 }),
  };
  state = apply(state, {
    t: "encounter.start",
    entries: ["thorn", "g1", "g2", "g3", "ogre", "sly"].map((id) => ({ id: `e-${id}`, tokenId: id })),
  });
  return state;
}

let seq = 10;

/**
 * One press against the real reducer, every step but the network: the rows
 * and presets from the DM's view, the panel's `dice.roll` ops, the
 * server's resolve with these faces, the line it writes, the receipt of
 * that line, and the totals it sets.
 */
function pressed(before: RoomState, mode: RollMode, faces: readonly number[], opts: { reroll?: boolean; rows?: RollRow[] } = {}) {
  let state = before;
  const rows = opts.rows ?? rowsOf(state).rows;
  const toRoll = rowsToRoll(rows, opts.reroll ?? false);
  const kept = opts.reroll ? [] : rows.filter((r) => r.value !== null);
  let press: RollPress = pressOf(toRoll, mode, kept);
  let receipt: ReceiptState | null = null;
  if (press.groups.length > 0) {
    const sent: ClientOp[] = [];
    const store = createStore<DiceState>(() => ({ adv: false, dis: false, secret: null, version: 0, last: null }));
    const panel = createDicePanel({ store, sender: { dispatch: (op) => sent.push(op), connected: () => true, receipts: new ReceiptTracker() }, secretStart: () => true });
    const tag = panel.roll(initiativeRolls(press.groups), { to: "dm" });
    assert.ok(tag);
    press = { ...press, tag };
    let face = 0;
    const draw = (sides: number) => {
      const f = faces[face++];
      if (f === undefined) throw new Error("the test ran out of dice");
      assert.ok(f <= sides);
      return f;
    };
    for (const op of sent) {
      assert.equal(op.t, "dice.roll");
      const resolved = resolveDiceOp(op as OpOf<"dice.roll">, state, { draw, batch: "AbCdEfGhIjKlMnOp" });
      assert.ok(resolved.ok);
      state = apply(state, resolved.op, DM, seq++);
    }
    receipt = { state: "committed", lines: findRolls(state.log, tag) };
  }
  const settled = settleRoll(press, receipt, state.encounter!.entries);
  assert.ok(settled);
  const afterDice = state;
  for (const op of settled.ops) state = apply(state, op, DM, seq++);
  return { state, afterDice, press: settled.press, ops: settled.ops };
}

describe("auto initiative against the reducer", () => {
  test("the rolled values apply as one setValues, sorted, with the PC untouched", () => {
    const before = fight();
    const { state: after, ops, press } = pressed(before, "creature", [11, 9, 15]);
    // Rows without values sort by the tie rule (PCs first, then higher bonus), so the assassin's roll comes first.
    assert.deepEqual(
      setValues(ops).map((v) => [v.entryId, v.value]),
      [
        ["e-sly", 15],
        ["e-g1", 11],
        ["e-g2", 11],
        ["e-g3", 11],
        ["e-ogre", 14],
      ],
    );
    assert.equal(ops.length, 1);
    const order = sortedEntries(after.encounter!.entries).map((e) => [e.id, e.value]);
    assert.deepEqual(order, [
      ["e-sly", 15],
      ["e-ogre", 14],
      ["e-g1", 11],
      ["e-g2", 11],
      ["e-g3", 11],
      ["e-thorn", null],
    ]);
    // The one new log line is the DM's secret roll, each shared roll naming its first token. Nothing else about the room changed.
    assert.equal(after.log.length, before.log.length + 1);
    const data = after.log.at(-1)!.data;
    assert.ok(data?.type === "dice");
    assert.equal(data.to, "dm");
    assert.deepEqual(
      data.rolls.map((r) => [r.label, r.tokenId, r.total]),
      [
        ["Initiative", "sly", 15],
        ["Initiative, shared by 3", "g1", 11],
        ["Initiative", "ogre", 14],
      ],
    );
    assert.deepEqual(
      press.rolled?.map((g) => describeRoll(g.roll)),
      ["d20 (11) +4 = 15", "d20 (9) +2 = 11", "d20 (15) −1 = 14"],
    );
    assert.deepEqual(comparable({ ...after, encounter: null, log: [] }), comparable({ ...before, encounter: null, log: [] }));
  });

  test("a poisoned, an invisible and an exhausted goblin each roll on their own, as their presets say", () => {
    let state = fight();
    state.tokens.g1!.actor = { inline: actor({ initBonus: 2, srdId: "goblin-warrior", effects: [effect("p", { key: "poisoned" })] }) };
    state.tokens.g2!.actor = { inline: actor({ initBonus: 2, srdId: "goblin-warrior", effects: [effect("i", { key: "invisible" })] }) };
    state.tokens.g3!.actor = { inline: actor({ initBonus: 2, srdId: "goblin-warrior", effects: [effect("e", { key: "exhaustion", level: 1 })] }) };
    const { afterDice, ops } = pressed(state, "creature", [15, 11, 4, 18, 10, 8, 7]);
    const data = afterDice.log.at(-1)!.data;
    assert.ok(data?.type === "dice");
    assert.deepEqual(
      data.rolls.map((r) => [r.tokenId, r.formula, r.mode, r.total]),
      [
        ["sly", "1d20+4", undefined, 19],
        ["g1", "2d20kl1+2", "dis", 6],
        ["g2", "2d20kh1+2", "adv", 20],
        ["g3", "1d20+2-2", undefined, 8],
        ["ogre", "1d20-1", undefined, 6],
      ],
    );
    assert.deepEqual(
      setValues(ops).map((v) => v.value),
      [19, 6, 20, 8, 6],
    );
  });

  test("a tie with a player character follows the existing rule: the PC goes first", () => {
    let state = fight();
    state = apply(state, { t: "encounter.setValue", entryId: "e-thorn", value: 13 }, P1);
    state = pressed(state, "all", [11]).state;
    assert.deepEqual(
      sortedEntries(state.encounter!.entries).map((e) => e.id),
      ["e-thorn", "e-sly", "e-g1", "e-g2", "e-g3", "e-ogre"],
    );
  });

  test("one undo takes the whole roll back", () => {
    const before = fight();
    const { afterDice, ops } = pressed(before, "each", [3, 4, 5, 6, 7]);
    assert.equal(ops.length, 1);
    const r = applyOp(afterDice, ops[0]!, DM, env(seq++));
    assert.ok(r.ok && r.inverse);
    const back = applyOp(r.state, { t: "sys.restore", entries: r.inverse, from: "undo" }, DM, env(seq++));
    assert.ok(back.ok);
    assert.deepEqual(
      back.state.encounter!.entries.map((e) => [e.id, e.value]),
      before.encounter!.entries.map((e) => [e.id, e.value]),
    );
  });

  test("the card follows the fight through an undo, the end, and the next fight", () => {
    const before = fight();
    const { afterDice, ops, press } = pressed(before, "creature", [11, 9, 15]);
    const r = applyOp(afterDice, ops[0]!, DM, env(seq++));
    assert.ok(r.ok && r.inverse);
    assert.equal(rollStillShown(press, r.state.encounter, false), true);
    const undone = applyOp(r.state, { t: "sys.restore", entries: r.inverse, from: "undo" }, DM, env(seq++));
    assert.ok(undone.ok);
    assert.equal(rollStillShown(press, undone.state.encounter, false), false, "undo took the roll back");
    const ended = apply(r.state, { t: "encounter.end" });
    assert.equal(rollStillShown(press, ended.encounter, false), false, "the fight ended");
    const next = apply(ended, { t: "encounter.start", entries: ["g1", "g2", "ogre"].map((id) => ({ id: `next-${id}`, tokenId: id, value: 11 })) });
    assert.equal(rollStillShown(press, next.encounter, false), false, "a new fight with the same monsters and totals");
  });

  test("a goblin added mid-fight joins its group's value with no roll at all, and the DM can still ungroup it", () => {
    let state = pressed(fight(), "creature", [11, 9, 15]).state;
    state.tokens.g4 = token("g4", { name: "Goblin", number: 4, actor: { inline: actor({ initBonus: 2, srdId: "goblin-warrior" }) }, x: 5, y: 2 });
    state = apply(state, { t: "encounter.add", entries: [{ id: "e-g4", tokenId: "g4" }] });
    const logLength = state.log.length;
    // No dice at all: the new goblin rolls nothing.
    const joined = pressed(state, "creature", []);
    assert.equal(joined.press.tag, null);
    assert.equal(joined.state.log.length, logLength, "nothing was rolled");
    assert.deepEqual(
      sortedEntries(joined.state.encounter!.entries).map((e) => [e.id, e.value]),
      [
        ["e-sly", 15],
        ["e-ogre", 14],
        ["e-g1", 11],
        ["e-g2", 11],
        ["e-g3", 11],
        ["e-g4", 11],
        ["e-thorn", null],
      ],
    );
    // Ungrouped, it would have rolled on its own.
    const alone = rowsOf(state).rows.map((r) => (r.entryId === "e-g4" ? { ...r, groupKey: undefined } : r));
    const { press } = pressed(state, "creature", [4], { rows: alone });
    assert.deepEqual(press.joined, []);
    assert.deepEqual(ids(press.groups), [["e-g4"]]);
  });

  test("players cannot send it: setValues is the DM's", () => {
    const { ops, afterDice } = pressed(fight(), "creature", [11, 9, 15]);
    const decision = canApply(ops[0]!, P1, afterDice, { canUseAsset: () => true });
    assert.equal(decision.ok, false);
  });

  test("players receive exactly what typed values would give them, and of the dice only that the DM rolled in secret", () => {
    const before = fight();
    const { state: rolledState, ops } = pressed(before, "creature", [11, 9, 15]);
    // The same totals typed by hand, one value at a time.
    let typed = before;
    for (const v of setValues(ops)) typed = apply(typed, { t: "encounter.setValue", entryId: v.entryId, value: v.value });
    const opts = { sceneId: "s1" };
    const forPlayer = projectState(rolledState, P1, opts);
    // Five typed ops bump the encounter's rev five times, one setValues once: everything else must match.
    assert.deepEqual({ ...forPlayer.encounter!, rev: 0 }, { ...projectState(typed, P1, opts).encounter!, rev: 0 });
    // The hidden assassin's roll leaves players no trace: a bare secret line, no creature, label or number.
    assert.deepEqual(forPlayer.log.at(-1)!.data, { type: "dice", by: DM.memberId, to: "dm", rolls: [] });
    assert.deepEqual(forPlayer.log.slice(0, -1), projectState(typed, P1, opts).log);
    const shown = forPlayer.encounter!.entries;
    assert.ok(!shown.some((e) => e.id === "e-sly"), "the hidden assassin's row stays hidden");
    for (const e of shown) assert.deepEqual(Object.keys(e).sort(), ["hidden", "id", "inLair", "reactionUsed", "tieOrder", "tokenId", "value"]);
  });

  test("ungrouping is a DM-only row edit that players never see, and then each goblin rolls its own", () => {
    const before = fight();
    let state = before;
    for (const id of ["e-g1", "e-g2", "e-g3"]) state = apply(state, { t: "encounter.update", entryId: id, patch: { groupKey: null } });
    const opts = { sceneId: "s1" };
    assert.deepEqual(projectState(state, P1, opts).encounter!.entries, projectState(before, P1, opts).encounter!.entries);
    assert.equal(canApply({ t: "encounter.update", entryId: "e-g1", patch: { groupKey: null } }, P1, before, { canUseAsset: () => true }).ok, false);
    assert.deepEqual(ids(planRolls(rowsOf(state).rows, "creature")), [["e-sly"], ["e-g1"], ["e-g2"], ["e-g3"], ["e-ogre"]]);
    assert.deepEqual(ids(planRolls(rowsOf(before).rows, "creature")), [["e-sly"], ["e-g1", "e-g2", "e-g3"], ["e-ogre"]]);
  });
});

// ---------------------------------------------------------------- randomized

const SOURCE_SETS: AdvantageSource[][] = [[], [], [INVISIBLE], [POISONED], [{ kind: "adv", from: "tracker" }], [INVISIBLE, POISONED]];
const EXTRAS: string[][] = [[], [], ["-2"], ["-4"]];

/** The key By creature must share by, written out again so the test checks the rule rather than restating the code. */
const sameRoll = (a: RollRow, b: RollRow) =>
  a.groupKey === b.groupKey && a.modifier === b.modifier && JSON.stringify(advantageFields(a.sources)) === JSON.stringify(advantageFields(b.sources)) && a.extra.join() === b.extra.join();

describe("a press, randomized", () => {
  /*
   * 2,000 seeded presses, each followed by a random run of what can happen
   * before and after its dice land: the receipt sending, checking,
   * committed, refused, committed beside a refused batch, unknown or with
   * lines that cannot be read, the DM or another device typing a row, a row
   * leaving the fight, the fight ending. The device settles on every event,
   * as autoState.ts does on every receipt change. The invariants:
   * 1. A press sends its totals at most once, and never acts after it is done.
   * 2. Only committed lines for every batch set anything. A refusal, an
   *    unknown answer or lines that cannot be read set nothing and say why.
   * 3. A value is set only on a row still in the fight that holds the value
   *    it had at the tap, and never to the value it already holds.
   * 4. Every row of a shared roll takes that roll's total, clamped, and a
   *    joined row its group's value. A row changed meanwhile is named instead.
   * 5. Ops keep within the op's 100 values, and no row is set twice.
   * 6. The plan rolls every row once: by creature only rows that share the
   *    whole key share a roll, one each rolls each alone, all at once rolls
   *    one, and each roll names its first row's token and counts its rows.
   */
  test("2,000 sequences of answers, typed values, removals and ends keep every invariant", () => {
    // How each press settled, so the run is known to reach every outcome and to set and keep values.
    const seen = { committed: 0, refused: 0, partial: 0, unknown: 0, unread: 0, set: 0, changed: 0 };
    for (let seed = 1; seed <= 2_000; seed++) {
      const r = rng(seed);
      const rows: RollRow[] = Array.from({ length: int(r, 1, 30) }, (_, i) => {
        const patch: Partial<RollRow> = {
          modifier: pick(r, [-1, 2, 2, 5]),
          sources: [...pick(r, SOURCE_SETS)],
          extra: [...pick(r, EXTRAS)],
          value: chance(r, 0.4) ? int(r, 1, 25) : null,
        };
        if (chance(r, 0.8)) patch.groupKey = pick(r, ["goblin", "ogre", "wolf"]);
        return row(`m${i}`, patch);
      });
      const mode = pick(r, ROLL_MODES);
      const reroll = chance(r, 0.3);
      const toRoll = rowsToRoll(rows, reroll);
      if (toRoll.length === 0) continue;
      const kept = reroll ? [] : rows.filter((x) => x.value !== null);
      let press = pressOf(toRoll, mode, kept);
      const where = `seed ${seed}`;

      // 6: the plan.
      const planned = [...press.groups, ...press.joined].flatMap((g) => g.rows.map((x) => x.entryId));
      assert.deepEqual([...planned].sort(), toRoll.map((x) => x.entryId).sort(), where);
      if (mode === "all") assert.equal(press.groups.length, 1, where);
      if (mode === "each") assert.ok(press.groups.every((g) => g.rows.length === 1), where);
      // A row with no group key stands alone, and rows that share a roll share the whole key.
      if (mode === "creature") for (const g of press.groups) assert.ok(g.rows.length === 1 || g.rows.every((x) => x.groupKey !== undefined && sameRoll(x, g.rows[0]!)), where);
      if (mode !== "creature") assert.deepEqual(press.joined, [], where);
      const rolls = initiativeRolls(press.groups);
      rolls.forEach((roll, i) => {
        const g = press.groups[i]!;
        assert.deepEqual(roll.creature, { tokenId: g.rows[0]!.tokenId }, where);
        assert.equal(roll.label, g.rows.length === 1 ? "Initiative" : `Initiative, shared by ${g.rows.length}`, where);
      });

      let fightNow: { id: string; value: number | null }[] = entriesOf(rows);
      const atTap = new Map(rows.map((x) => [x.entryId, x.value]));
      let receipt: ReceiptState | null = press.tag === null ? null : { state: "sending" };
      let outcome: "committed" | "refused" | "partial" | "unknown" | "unread" | null = press.tag === null ? "committed" : null;
      let lines: DiceRoll[] = [];
      let sends = 0;
      for (let step = 0; step < 14; step++) {
        const event = pick(r, ["type", "remove", "end", "answer", "answer", "settle", "settle"] as const);
        if (event === "type" && fightNow.length > 0) {
          const target = pick(r, fightNow);
          fightNow = fightNow.map((e) => (e.id === target.id ? { ...e, value: chance(r, 0.2) ? null : int(r, -5, 30) } : e));
        } else if (event === "remove" && fightNow.length > 0) {
          const target = pick(r, fightNow);
          fightNow = fightNow.filter((e) => e.id !== target.id);
        } else if (event === "end" && chance(r, 0.2)) {
          fightNow = [];
        } else if (event === "answer" && outcome === null) {
          const next = pick(r, ["checking", "committed", "committed", "refused", "partial", "unknown", "unread"] as const);
          if (next === "checking") receipt = { state: "checking" };
          else {
            outcome = next;
            lines = landedRolls(
              rolls,
              Array.from({ length: rolls.length * 2 }, () => int(r, 1, 20)),
            );
            if (next === "committed") receipt = committed(lines);
            else if (next === "refused") receipt = { state: "refused", code: "quota", message: "Too fast.", text: "You are rolling too fast." };
            else if (next === "partial") receipt = { state: "committed", lines: [line("tag", lines.slice(0, -1))], refused: { code: "quota", message: "Too fast.", text: "" } };
            else if (next === "unknown") receipt = { state: "unknown" };
            else receipt = committed(lines.slice(1));
          }
        }
        const before = new Map(fightNow.map((e) => [e.id, e.value]));
        const settled = settleRoll(press, receipt, fightNow);
        if (!settled) {
          // 1 and 2: nothing settles while the answer is pending.
          assert.ok(press.done || outcome === null, where);
          continue;
        }
        sends++;
        if (outcome) seen[outcome]++;
        if (setValues(settled.ops).length > 0) seen.set++;
        if (settled.press.changed.length > 0) seen.changed++;
        assert.equal(sends, 1, `${where}: a press settles once`);
        assert.equal(settled.press.done, true, where);
        const set = setValues(settled.ops);
        // 5
        for (const op of settled.ops) assert.ok(op.t === "encounter.setValues" && op.values.length <= 100, where);
        assert.equal(new Set(set.map((v) => v.entryId)).size, set.length, where);
        if (outcome !== "committed") {
          // 2
          assert.deepEqual(settled.ops, [], where);
          assert.equal(settled.press.rolled, null, where);
          assert.ok(settled.press.error, where);
        } else {
          assert.equal(settled.press.error, null, where);
          // 4: what every row should take.
          const want = new Map<string, number>();
          (settled.press.rolled ?? []).forEach((g, i) => {
            assert.equal(g.total, clampValue(lines[i]!.total), where);
            for (const x of g.rows) want.set(x.entryId, g.total);
          });
          for (const g of press.joined) for (const x of g.rows) want.set(x.entryId, g.total);
          for (const v of set) {
            // 3
            assert.ok(before.has(v.entryId), `${where}: a row gone from the fight`);
            assert.equal(before.get(v.entryId), atTap.get(v.entryId), `${where}: a row changed after the tap`);
            assert.notEqual(before.get(v.entryId), v.value, where);
            assert.equal(v.value, want.get(v.entryId), where);
          }
          const setIds = new Set(set.map((v) => v.entryId));
          for (const [id, value] of want) {
            if (!before.has(id) || before.get(id) === value) continue;
            const isChanged: boolean = settled.press.changed.includes(id);
            assert.equal(setIds.has(id) || isChanged, true, `${where}: ${id} neither set nor named`);
            assert.equal(isChanged, before.get(id) !== atTap.get(id), where);
          }
        }
        // The fight takes the values, as the reducer would.
        const byId = new Map(set.map((v) => [v.entryId, v.value]));
        fightNow = fightNow.map((e) => (byId.has(e.id) ? { ...e, value: byId.get(e.id)! } : e));
        press = settled.press;
        // 1: never again.
        assert.equal(settleRoll(press, receipt, fightNow), null, where);
        for (const g of press.rolled ?? []) assert.ok(describeRoll(g.roll).endsWith(`= ${g.roll.total}`), where);
      }
    }
    for (const [kind, n] of Object.entries(seen)) assert.ok(n >= 50, `only ${n} presses ${kind}`);
  });
});
