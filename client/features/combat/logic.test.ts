import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { resolveDiceOp, type DiceOp } from "#shared/dice/resolve.ts";
import type { DayUse, LimitedUse, RechargeUse, RegenerationUse, RestUse } from "#shared/dice/uses.ts";
import type { Actor, RoomState, Settled, TurnRecord, UseMark, Viewer } from "#shared/model.ts";
import { canApply } from "#shared/permissions.ts";
import { clientOpSchema, type ClientOp, type Op } from "#shared/protocol.ts";
import { applyOp } from "#shared/reducer.ts";
import { DM, P1, actor, character, env, room, token } from "#shared/testutil.ts";
import { combatAlerts } from "./alerts.ts";
import {
  abilityHead,
  abilityOp,
  abilityState,
  answersFor,
  currentRecord,
  deathSaveResult,
  deathSaveWaits,
  deathSaveWords,
  legendaryHead,
  legendaryLabel,
  legendaryOffText,
  legendaryOp,
  legendaryText,
  markChips,
  openRecord,
  otherBackOp,
  otherHead,
  promptOp,
  promptsOf,
  rechargeResult,
  rechargeRollOp,
  rechargeWords,
  regeneratedWords,
  regenerateOp,
  regenerationNote,
  regenerationWords,
  skippedWords,
  turnParticipants,
  usesCount,
  usesPresence,
  usesRows,
  type UseRow,
} from "./logic.ts";
import { promptId, turnId } from "./state.ts";

/*
 * The combat uses' rules (docs/design-v1-combat-controls.md 4 to 6), on
 * fixtures and on rooms the real reducer moved through turn starts, so
 * what the cards read is what lane A's records write.
 */

const valid = (op: ClientOp) => {
  const parsed = clientOpSchema.safeParse(op);
  assert.ok(parsed.success, parsed.success ? "" : JSON.stringify(parsed.error.issues.slice(0, 2)));
};

const breath: RechargeUse = { kind: "recharge", key: "actions:fire-breath", name: "Fire Breath", section: "actions", min: 5 };
const phantasms: RestUse = { kind: "rest", key: "bonusActions:phantasms", name: "Phantasms", section: "bonusActions" };
const dominate: DayUse = { kind: "day", key: "actions:dominate-mind", name: "Dominate Mind", section: "actions", max: 2, short: false };
const regen: RegenerationUse = { kind: "regeneration", key: "traits:regeneration", name: "Regeneration", section: "traits", amount: 15, stops: ["acid", "fire"] };
const pounce = { kind: "legendary", key: "legendaryActions:pounce", name: "Pounce", section: "legendaryActions", cost: 1, once: false } as const;
const rays = { kind: "legendary", key: "legendaryActions:fiery-rays", name: "Fiery Rays", section: "legendaryActions", cost: 1, once: true } as const;
const wing = { kind: "legendary", key: "legendaryActions:wing-attack", name: "Wing Attack", section: "legendaryActions", cost: 2, once: false } as const;
const dragonUses: LimitedUse[] = [breath, pounce, rays, wing];
const legendary = { actionsMax: 3, actionsUsed: 0, resistMax: 3, resistUsed: 1 };
const breathMark: UseMark = { kind: "recharge", name: "Fire Breath", used: 1, max: 1, min: 5 };

const record = (overrides: Partial<TurnRecord> = {}): TurnRecord => ({ id: 7, entryId: "ed", round: 2, hp: 100, life: "alive", ...overrides });

describe("the turn record", () => {
  test("is current only while its row acts in its round", () => {
    const r = record();
    assert.equal(currentRecord({ activeEntryId: "ed", round: 2 }, { turnRecord: r }), r);
    assert.equal(currentRecord({ activeEntryId: "ed", round: 3 }, { turnRecord: r }), null);
    assert.equal(currentRecord({ activeEntryId: "et", round: 2 }, { turnRecord: r }), null);
    assert.equal(currentRecord(null, { turnRecord: r }), null);
    assert.equal(currentRecord({ activeEntryId: "ed", round: 2 }, {}), null);
  });

  test("an open roll settles a prompt only while it is open, else it stays manual", () => {
    const turn = { activeEntryId: "ed", round: 2 };
    const dying = { turnRecord: record({ life: "dying" }), life: "dying" as const };
    assert.equal(openRecord(turn, dying, "deathSave"), 7);
    assert.equal(openRecord(turn, { ...dying, life: "alive" }, "deathSave"), undefined, "healed meanwhile");
    assert.equal(openRecord(turn, { ...dying, turnRecord: record({ life: "dying", settled: { deathSave: { state: "done", total: 12, outcome: "success" } } }) }, "deathSave"), undefined);
    assert.equal(openRecord({ ...turn, round: 3 }, dying, "deathSave"), undefined);
    const due = { turnRecord: record({ due: [breath.key] }), life: "alive" as const, uses: { [breath.key]: breathMark } };
    assert.equal(openRecord(turn, due, `recharge:${breath.key}`), 7);
    assert.equal(openRecord(turn, { ...due, uses: {} }, `recharge:${breath.key}`), undefined, "marked ready meanwhile");
    assert.equal(openRecord(turn, { ...due, turnRecord: record() }, `recharge:${breath.key}`), undefined, "spent on its own turn, so not due");
  });
});

describe("prompts from a record", () => {
  test("Regeneration is due below the maximum or not alive, and with the HP its trait needs", () => {
    const hp = { cur: 60, max: 94, temp: 0 };
    assert.ok(promptsOf({ record: record({ hp: 60 }), actor: { life: "alive", hp }, regeneration: regen }).regeneration);
    assert.equal(promptsOf({ record: record({ hp: 94 }), actor: { life: "alive", hp: { ...hp, cur: 94 } }, regeneration: regen }).regeneration, null, "unhurt");
    assert.ok(promptsOf({ record: record({ hp: 0, life: "dead" }), actor: { life: "dead", hp: { ...hp, cur: 0 } }, regeneration: regen }).regeneration, "a dead troll may get up");
    const oni = { ...regen, amount: 10, stops: [], minHp: 1 };
    assert.equal(promptsOf({ record: record({ hp: 0, life: "dying" }), actor: { life: "dying", hp }, regeneration: oni }).regeneration, null, "the oni's needs 1 HP");
    assert.ok(promptsOf({ record: record({ hp: 1 }), actor: { life: "alive", hp }, regeneration: oni }).regeneration);
    assert.equal(promptsOf({ record: record({ hp: 60 }), actor: { life: "alive", hp }, regeneration: null }).regeneration, null, "no trait, no card");
  });

  test("a death save is due while the record says dying and it still is, and stays once settled", () => {
    const hp = { cur: 0, max: 30, temp: 0 };
    assert.ok(promptsOf({ record: record({ life: "dying" }), actor: { life: "dying", hp }, regeneration: null }).deathSave);
    assert.equal(promptsOf({ record: record({ life: "dying" }), actor: { life: "alive", hp }, regeneration: null }).deathSave, null, "healed from another device");
    const settled = { state: "done", total: 20, outcome: "regain" } as const;
    assert.deepEqual(promptsOf({ record: record({ life: "dying", settled: { deathSave: settled } }), actor: { life: "alive", hp }, regeneration: null }).deathSave, { what: "deathSave", settled });
    assert.equal(promptsOf({ record: record({ life: "alive" }), actor: { life: "dying", hp }, regeneration: null }).deathSave, null, "a trap hit after the start is not this turn's prompt");
  });

  test("a recharge is due per key the record named, while its mark is there or once settled", () => {
    const hp = { cur: 10, max: 10, temp: 0 };
    const due = record({ due: [breath.key, "actions:gone"] });
    const prompts = promptsOf({ record: due, actor: { life: "alive", hp, uses: { [breath.key]: breathMark } }, regeneration: null });
    assert.deepEqual(prompts.recharges, [{ what: `recharge:${breath.key}`, key: breath.key, name: "Fire Breath", min: 5, settled: undefined }]);
    const rolled = promptsOf({ record: { ...due, settled: { [`recharge:${breath.key}`]: { state: "done", total: 6, outcome: "ready" } as Settled } }, actor: { life: "alive", hp, uses: {} }, regeneration: null });
    assert.equal(rolled.recharges.length, 1);
    assert.equal(rolled.recharges[0]!.settled?.total, 6);
    // Its mark went with the roll, so the block names it and gives its range.
    const named = promptsOf({ record: { ...due, settled: { [`recharge:${breath.key}`]: { state: "done", total: 6, outcome: "ready" } as Settled } }, actor: { life: "alive", hp, uses: {} }, regeneration: null, uses: [breath] });
    assert.deepEqual([named.recharges[0]!.name, named.recharges[0]!.min], ["Fire Breath", 5]);
  });

  test("a death save waits on an open Regeneration this device has not dismissed", () => {
    const open = { what: "regeneration" as const, use: regen, settled: undefined };
    assert.equal(deathSaveWaits(open, false), true);
    assert.equal(deathSaveWaits(open, true), false);
    assert.equal(deathSaveWaits({ ...open, settled: { state: "skipped" } }, false), false);
    assert.equal(deathSaveWaits(null, false), false);
  });
});

describe("the words", () => {
  test("Regeneration's by the record's life, and its advisory note", () => {
    assert.deepEqual(regenerationWords("Troll", 15, "alive", false), { text: "Troll regenerates 15 HP.", apply: true });
    assert.deepEqual(regenerationWords("Troll", 15, "dying", false), { text: "Troll is at 0 HP and regenerates 15 HP.", apply: true });
    assert.deepEqual(regenerationWords("Troll", 15, "dead", true), { text: "Troll regenerates 15 HP and gets up.", apply: true });
    assert.equal(regenerationWords("Troll", 15, "dead", false).apply, false);
    assert.equal(regenerationNote(["fire", "cold"], ["acid", "fire"]), "Recorded Fire damage may stop Regeneration.");
    assert.equal(regenerationNote(["fire", "acid"], ["acid", "fire"]), "Recorded Acid and Fire damage may stop Regeneration.");
    assert.equal(regenerationNote(["cold"], ["acid", "fire"]), null);
    assert.equal(regenerationNote(undefined, ["acid", "fire"]), null);
    assert.equal(regeneratedWords({ state: "done", total: 15 }), "Regenerated 15 HP.");
  });

  test("a death save's, from its stored outcome", () => {
    assert.equal(deathSaveWords("Thorn", { ok: 1, fail: 2 }), "Thorn is dying. Death save: 1 success, 2 failures.");
    assert.equal(deathSaveWords("Thorn", { ok: 0, fail: 1 }), "Thorn is dying. Death save: 0 successes, 1 failure.");
    assert.equal(deathSaveResult("Thorn", { state: "done", total: 14, outcome: "success" }), "Rolled 14: a success.");
    assert.equal(deathSaveResult("Thorn", { state: "done", total: 1, outcome: "twoFailures" }), "Rolled 1: two failures.");
    assert.equal(deathSaveResult("Thorn", { state: "done", total: 20, outcome: "regain" }), "Rolled 20: Thorn regains 1 HP.");
    assert.equal(deathSaveResult("Thorn", { state: "done", total: 6, outcome: "failure" }), "Rolled 6: a failure.");
  });

  test("a recharge's", () => {
    assert.equal(rechargeWords("Fire Breath", 5), "Fire Breath can recharge (5–6).");
    assert.equal(rechargeWords("Roar", 6), "Roar can recharge (6).");
    assert.equal(rechargeResult("Fire Breath", { state: "done", total: 5, outcome: "ready" }), "Rolled 5: Fire Breath is ready.");
    assert.equal(rechargeResult("Fire Breath", { state: "done", total: 2, outcome: "used" }), "Rolled 2: Fire Breath stays used.");
    assert.equal(rechargeResult("Fire Breath", { state: "done", outcome: "ready" }), "Fire Breath is ready.");
    assert.equal(skippedWords("regeneration", {}), "Regeneration skipped");
    assert.equal(skippedWords(`recharge:${breath.key}`, { [breath.key]: "Fire Breath" }), "Fire Breath recharge skipped");
  });
});

describe("the list", () => {
  const rowsOf = (form: "card" | "list", over: { uses?: Record<string, UseMark>; ownTurn?: boolean; legendary?: typeof legendary; list?: readonly LimitedUse[] | null; record?: TurnRecord | null } = {}) =>
    usesRows({ form, uses: over.list === undefined ? dragonUses : over.list, actor: { legendary: over.legendary ?? legendary, ...(over.uses ? { uses: over.uses } : {}) }, ownTurn: over.ownTurn ?? false, record: over.record ?? null });
  const legendaryRow = (rows: UseRow[]) => rows.find((r): r is Extract<UseRow, { kind: "legendary" }> => r.kind === "legendary")!;

  test("the off-turn list: Resistance, the legendary actions as buttons, then the abilities", () => {
    const rows = rowsOf("list");
    assert.deepEqual(
      rows.map((r) => r.kind),
      ["resist", "legendary", "ability"],
    );
    const la = legendaryRow(rows);
    assert.deepEqual(
      la.buttons.map((b) => [legendaryText(b), b.off]),
      [
        ["Pounce", null],
        ["Fiery Rays", null],
        ["Wing Attack (2)", null],
      ],
    );
    assert.equal(legendaryHead(la, "list"), "Legendary actions 3 of 3");
    assert.equal(legendaryLabel(la.buttons[1]!, 3), "Use Fiery Rays, legendary action, 3 left");
  });

  test("a once-marked action waits until its creature's next turn, a dear one needs its pips, and none goes on its own turn", () => {
    const marked = legendaryRow(rowsOf("list", { uses: { [rays.key]: { kind: "turn", name: "Fiery Rays", used: 1, max: 1 } }, legendary: { ...legendary, actionsUsed: 2 } }));
    assert.deepEqual(
      marked.buttons.map((b) => [b.name, b.off, legendaryOffText(b)]),
      [
        ["Pounce", null, null],
        ["Fiery Rays", "once", "Until the start of its next turn"],
        ["Wing Attack", "needs", "Needs 2"],
      ],
    );
    const own = legendaryRow(rowsOf("list", { ownTurn: true }));
    assert.ok(own.buttons.every((b) => b.off === "ownTurn" && legendaryOffText(b) === "After another creature's turn"));
  });

  test("counts set by hand with no block's actions: one plain button", () => {
    const la = legendaryRow(rowsOf("list", { list: [] }));
    assert.deepEqual(la.buttons, [{ name: "", cost: 1, once: false, off: null }]);
    assert.equal(legendaryText(la.buttons[0]!), "Spend a legendary action");
  });

  test("the card lists no legendary action buttons, and says the pips come after other creatures' turns", () => {
    const la = legendaryRow(rowsOf("card", { ownTurn: true }));
    assert.deepEqual(la.buttons, []);
    assert.equal(legendaryHead(la, "card"), "Legendary actions 3 of 3, after other creatures' turns");
  });

  test("an ability's line and state: ready, used, a roll's result, an X/Day count", () => {
    const ready = rowsOf("list").find((r) => r.kind === "ability")!;
    assert.ok(ready.kind === "ability");
    assert.equal(abilityHead(ready), "Fire Breath, Recharge 5–6");
    assert.equal(abilityState(ready), "Ready");
    const used = rowsOf("list", { uses: { [breath.key]: breathMark } }).find((r) => r.kind === "ability")!;
    assert.ok(used.kind === "ability");
    assert.equal(abilityState(used), "Used");
    const rolled = rowsOf("card", { uses: {}, record: record({ settled: { [`recharge:${breath.key}`]: { state: "done", total: 5, outcome: "ready" } as Settled } }) }).find((r) => r.kind === "ability")!;
    assert.ok(rolled.kind === "ability");
    assert.equal(abilityState(rolled), "Rolled 5: ready");
    const day = usesRows({ form: "list", uses: [dominate, phantasms], actor: { uses: { [dominate.key]: { kind: "day", name: "Dominate Mind", used: 1, max: 2 } } }, ownTurn: false, record: null });
    assert.deepEqual(
      day.map((r) => (r.kind === "ability" ? `${abilityHead(r)} | ${abilityState(r)}` : r.kind)),
      ["Dominate Mind, 2/Day, 1 left | null", "Phantasms, after a rest | Ready"],
    );
  });

  test("a recharge roll's words give way to the mark it no longer matches, in the list and on the card (CCB-ASTRA-01)", () => {
    const settled = (total: number, outcome: "ready" | "used") => record({ settled: { [`recharge:${breath.key}`]: { state: "done", total, outcome } as Settled } });
    const breathRow = (form: "card" | "list", uses: Record<string, UseMark>, r: TurnRecord | null) => rowsOf(form, { uses, record: r }).find((x): x is Extract<UseRow, { kind: "ability" }> => x.kind === "ability")!;
    for (const form of ["card", "list"] as const) {
      assert.equal(abilityState(breathRow(form, {}, settled(6, "ready"))), "Rolled 6: ready", form);
      assert.equal(abilityState(breathRow(form, { [breath.key]: breathMark }, settled(6, "ready"))), "Used", `${form}: spent again after a ready roll`);
      assert.equal(abilityState(breathRow(form, { [breath.key]: breathMark }, settled(2, "used"))), "Rolled 2: used", form);
      assert.equal(abilityState(breathRow(form, {}, settled(2, "used"))), "Ready", `${form}: Mark ready after a used roll`);
    }
    // The list's own Roll recharge, which no prompt holds.
    assert.equal(abilityState(breathRow("list", {}, null), 6), "Rolled 6: ready");
    assert.equal(abilityState(breathRow("list", { [breath.key]: breathMark }, null), 6), "Used", "a ready roll, then spent again");
    assert.equal(abilityState(breathRow("list", { [breath.key]: breathMark }, null), 4), "Rolled 4: used", "below Recharge 5");
    assert.equal(abilityState(breathRow("list", {}, null), 4), "Ready", "a used roll, then Mark ready");
    // A roll of its own after the prompt's: whichever still matches the mark speaks.
    assert.equal(abilityState(breathRow("list", {}, settled(2, "used")), 6), "Rolled 6: ready");
    assert.equal(abilityState(breathRow("list", { [breath.key]: breathMark }, settled(2, "used")), 6), "Rolled 2: used");
  });

  test("marks the block no longer lists show under their stored name in the list, never while it loads", () => {
    const uses = { "actions:frost-breath": { kind: "recharge", name: "Frost Breath", used: 1, max: 1, min: 5 } as UseMark, [breath.key]: breathMark };
    const other = rowsOf("list", { uses }).filter((r) => r.kind === "other");
    assert.deepEqual(
      other.map((r) => (r.kind === "other" ? otherHead(r.mark) : "")),
      ["Frost Breath, used"],
    );
    assert.deepEqual(rowsOf("list", { uses, list: null }).filter((r) => r.kind === "other"), []);
    assert.deepEqual(rowsOf("card", { uses }).filter((r) => r.kind === "other"), []);
    // A mark of another kind under a listed key is from a block edited since (3.2).
    const changed = rowsOf("list", { uses: { [breath.key]: { kind: "day", name: "Fire Breath", used: 1, max: 3 } } });
    assert.ok(changed.some((r) => r.kind === "other" && r.key === breath.key));
    const still = changed.find((r) => r.kind === "ability");
    assert.ok(still?.kind === "ability");
    assert.equal(abilityState(still), "Ready", "the block's own recharge reads ready, the old mark aside");
    assert.equal(otherHead({ kind: "day", name: "Dominate Mind", used: 1, max: 2 }), "Dominate Mind, 1 of 2 used");
  });

  test("Regeneration is a line in the list, and skipped prompts are rows of the card with Reopen", () => {
    assert.ok(usesRows({ form: "list", uses: [regen], actor: {}, ownTurn: false, record: null }).some((r) => r.kind === "regeneration"));
    const card = usesRows({ form: "card", uses: [regen], actor: {}, ownTurn: true, record: record({ settled: { regeneration: { state: "skipped" }, deathSave: { state: "done", total: 3, outcome: "failure" } } }) });
    assert.deepEqual(card, [{ kind: "skipped", what: "regeneration", text: "Regeneration skipped" }]);
  });

  test("the folded row counts what the viewer can act on, and class resources", () => {
    assert.equal(usesCount(rowsOf("card"), undefined), 3);
    assert.equal(usesCount(rowsOf("card", { record: record({ settled: { regeneration: { state: "skipped" } } }) }), undefined), 3, "a skipped prompt is no use");
    assert.equal(usesCount(usesRows({ form: "list", uses: [regen], actor: {}, ownTurn: false, record: null }), undefined), 0, "nor is Regeneration's line");
    assert.equal(usesCount([], [{ id: "rage", name: "Rage", max: 3, used: 0, reset: "shortOne" }]), 1);
  });

  test("the DM's chips: three at most, X/Day as left over the most", () => {
    assert.deepEqual(markChips(undefined), { chips: [], more: 0 });
    const marks: Record<string, UseMark> = {
      "a:a": { kind: "recharge", name: "Fire Breath", used: 1, max: 1, min: 5 },
      "a:b": { kind: "day", name: "Dominate Mind", used: 1, max: 2 },
      "a:c": { kind: "rest", name: "Phantasms", used: 1, max: 1 },
      "a:d": { kind: "turn", name: "Fiery Rays", used: 1, max: 1 },
      "a:e": { kind: "day", name: "Scare", used: 1, max: 1 },
    };
    assert.deepEqual(markChips(marks), {
      chips: [
        { key: "a:a", text: "Fire Breath used" },
        { key: "a:b", text: "Dominate Mind 1/2" },
        { key: "a:c", text: "Phantasms used" },
      ],
      more: 2,
    });
  });

  test("two sections' abilities of one name make two chips, each under its own key (CCB-OPUS-10)", () => {
    const marks: Record<string, UseMark> = { "actions:fire-breath": breathMark, "bonusActions:fire-breath": breathMark };
    const { chips } = markChips(marks);
    assert.deepEqual(
      chips.map((c) => c.text),
      ["Fire Breath used", "Fire Breath used"],
    );
    assert.equal(new Set(chips.map((c) => c.key)).size, 2);
  });

  test("a creature shows Uses at once with counts, marks or resources, holds it while its block loads, and drops it with none", () => {
    assert.equal(usesPresence({ actor: { legendary }, resources: undefined, uses: null, loading: true }), "yes");
    assert.equal(usesPresence({ actor: { uses: { a: breathMark } }, resources: undefined, uses: null, loading: true }), "yes");
    assert.equal(usesPresence({ actor: {}, resources: [{}], uses: [], loading: false }), "yes");
    assert.equal(usesPresence({ actor: {}, resources: undefined, uses: null, loading: true }), "loading");
    assert.equal(usesPresence({ actor: {}, resources: undefined, uses: [], loading: false }), "no");
    assert.equal(usesPresence({ actor: {}, resources: undefined, uses: [breath], loading: false }), "yes");
    assert.equal(usesPresence({ actor: {}, resources: undefined, uses: null, loading: false }), "no", "failed");
  });

  test("a creature shows Uses only where its list has a row: legendary actions the block prints need counts to stand (CCB-OPUS-5)", () => {
    const drake: LimitedUse[] = [pounce, wing];
    const none = { actionsMax: 0, actionsUsed: 0, resistMax: 0, resistUsed: 0 };
    assert.equal(usesRows({ form: "list", uses: drake, actor: {}, ownTurn: false, record: null }).length, 0);
    assert.equal(usesPresence({ actor: {}, resources: undefined, uses: drake, loading: false }), "no");
    assert.equal(usesPresence({ actor: { legendary: none }, resources: undefined, uses: drake, loading: false }), "no", "counts of 0 draw no pips");
    assert.equal(usesPresence({ actor: { legendary: none }, resources: undefined, uses: null, loading: true }), "loading");
    assert.equal(usesPresence({ actor: { legendary: { ...none, actionsMax: 2 } }, resources: undefined, uses: drake, loading: false }), "yes");
    // What stays: class resources, a mark the block no longer lists, and a mark waiting for its block in the loading line.
    assert.equal(usesPresence({ actor: {}, resources: [{}], uses: drake, loading: false }), "yes");
    assert.equal(usesPresence({ actor: { uses: { "actions:frost-breath": breathMark } }, resources: undefined, uses: drake, loading: false }), "yes");
    assert.equal(usesPresence({ actor: { uses: { "actions:frost-breath": breathMark } }, resources: undefined, uses: null, loading: false }), "yes", "a failed block keeps its marks' place for the failure line");
  });
});

describe("the ops each button sends, as the protocol takes them", () => {
  const target = { tokenId: "dragon" };
  test("every kind", () => {
    for (const b of [{ key: rays.key, name: "Fiery Rays", cost: 1, once: true, off: null }, { key: wing.key, name: "Wing Attack", cost: 2, once: false, off: null }, { name: "", cost: 1, once: false, off: null }] as const) valid(legendaryOp(target, b));
    assert.deepEqual(legendaryOp(target, { key: rays.key, name: "Fiery Rays", cost: 1, once: true, off: null }), { t: "actor.use", target, use: { kind: "legendary", cost: 1, key: rays.key, name: "Fiery Rays", once: true } });
    for (const use of [breath, phantasms, dominate, { ...dominate, short: true }]) {
      valid(abilityOp(target, use));
      valid(abilityOp(target, use, { back: true }));
      valid(abilityOp(target, use, { ifReady: true, quiet: true }));
    }
    assert.equal("ifReady" in (abilityOp(target, breath, { back: true, ifReady: true }) as { use: object }).use, false, "a give back is never the Dice panel's mark");
    for (const mark of [breathMark, { kind: "rest", name: "Phantasms", used: 1, max: 1 }, { kind: "day", name: "Scare", used: 1, max: 3, short: true }, { kind: "turn", name: "Fiery Rays", used: 1, max: 1 }] as UseMark[]) valid(otherBackOp(target, "actions:x", mark));
    valid(rechargeRollOp("t1", target, breath, 7));
    valid(rechargeRollOp("t1", target, breath, undefined));
    valid(promptOp(target, 7, "regeneration", "skipped"));
    valid(promptOp(target, 7, `recharge:${breath.key}`, "open"));
    valid(regenerateOp(target, regen, 7));
  });
});

/** Rows: Dragon 20, Thorn 15 (dying), Troll 12, Bree 10 riding the warhorse. The warhorse's row marks time on Bree's turn. */
function table(): RoomState {
  const state = room({
    tokens: {
      dragon: token("dragon", { name: "Adult Red Dragon", actor: { inline: actor({ hp: { cur: 200, max: 256, temp: 0 }, legendary: { actionsMax: 3, actionsUsed: 0, resistMax: 3, resistUsed: 0 }, uses: { [breath.key]: breathMark } }) } }),
      thorn: token("thorn", { kind: "pc", name: "Thorn", x: 10, y: 10, actor: { ref: "thorn" } }),
      troll: token("troll", { name: "Troll", x: 14, y: 10, actor: { inline: actor({ hp: { cur: 40, max: 94, temp: 0 }, hurt: ["fire"] }) } }),
      goblin: token("goblin", { name: "Goblin", x: 16, y: 10 }),
    },
    characters: { thorn: character("thorn", { name: "Thorn", ownerIds: ["p1"], actor: actor({ hp: { cur: 0, max: 30, temp: 0 }, life: "dying", deathSaves: { ok: 1, fail: 0 } }) }) },
  });
  state.meta.settings = { ...state.meta.settings, monstersDieAtZero: false };
  return state;
}

function fight() {
  let state = table();
  let seq = 0;
  const f = {
    get state() {
      return state;
    },
    /** The acting row, read afresh, so a loop that waits on it reads each turn. */
    active(): string | null {
      return state.encounter?.activeEntryId ?? null;
    },
    run(op: Op, who: Viewer = DM) {
      seq++;
      const r = applyOp(state, op, who, env(seq));
      assert.ok(r.ok, `${op.t}: ${r.ok ? "" : r.message}`);
      state = r.state;
      return f;
    },
    roll(op: DiceOp, face: number, who: Viewer = DM) {
      const permitted = canApply(op, who, state, { canUseAsset: () => true });
      assert.ok(permitted.ok, permitted.ok ? "" : permitted.message);
      const resolved = resolveDiceOp(op, state, { draw: () => face, batch: "AbCdEfGhIjKlMnOp" });
      assert.ok(resolved.ok);
      return f.run(resolved.op, who);
    },
    of(id: string): Actor {
      const t = state.tokens[id]!;
      return "inline" in t.actor ? t.actor.inline : state.characters[t.actor.ref]!.actor;
    },
  };
  f.run({
    t: "encounter.start",
    entries: [
      { id: "ed", tokenId: "dragon", value: 20 },
      { id: "et", tokenId: "thorn", value: 15 },
      { id: "er", tokenId: "troll", value: 12 },
      { id: "eg", tokenId: "goblin", value: 5 },
    ],
  });
  return f;
}

const dmYou = { role: "dm" as const, memberId: "dm1" };
const patYou = { role: "player" as const, memberId: "p1" };

function cards(state: RoomState, you: typeof dmYou | typeof patYou, uses: (holder: string) => readonly LimitedUse[] | null = () => [], dismissed: ReadonlySet<string> = new Set()) {
  const participants = turnParticipants(state).filter((p) => answersFor(state, you, p.target) || (you.role === "dm" && p.record?.life === "dying"));
  return combatAlerts({ view: state, you, participants, uses: participants.map((p) => uses(p.holder)), loading: false, failed: false, dismissed });
}

describe("the cards of a turn, from what the reducer wrote at its start", () => {
  test("the dragon's turn: its recharge card and its turn card, the DM's alone", () => {
    const f = fight();
    while (f.active() !== "ed") f.run({ t: "encounter.next" });
    f.run({ t: "encounter.next" }).run({ t: "encounter.prev" });
    // A start that saw the breath spent: the turn record names it due.
    f.run({ t: "encounter.next" });
    while (f.active() !== "ed") f.run({ t: "encounter.next" });
    const dm = cards(f.state, dmYou, (h) => (h === "t:dragon" ? dragonUses : []));
    assert.deepEqual(
      dm.recharges.map((c) => [c.participant.name, c.prompt.name, c.prompt.min]),
      [["Adult Red Dragon", "Fire Breath", 5]],
    );
    assert.ok(dm.turn);
    assert.equal(dm.turn.name, "Adult Red Dragon");
    assert.equal(dm.turn.count, 3);
    assert.equal(dm.turn.id, turnId("ed", f.state.encounter!.round));
    const pat = cards(f.state, patYou);
    assert.deepEqual([pat.recharges, pat.turn], [[], null], "a player answers for none of it");
    // Dismissed here, the card stays away for this turn, and the DM's other device still shows it.
    const gone = cards(f.state, dmYou, (h) => (h === "t:dragon" ? dragonUses : []), new Set([dm.recharges[0]!.id, dm.turn.id]));
    assert.deepEqual([gone.recharges, gone.turn], [[], null]);
  });

  test("the recharge roll settles the card for every device, and a roll after Next is refused", () => {
    const f = fight();
    while (f.active() !== "ed" || !f.of("dragon").turnRecord?.due) f.run({ t: "encounter.next" });
    const id = f.of("dragon").turnRecord!.id;
    const op = rechargeRollOp("r1", { tokenId: "dragon" }, breath, openRecord(f.state.encounter, f.of("dragon"), `recharge:${breath.key}`));
    assert.equal(op.record, id);
    f.roll(op, 6);
    const after = cards(f.state, dmYou, (h) => (h === "t:dragon" ? dragonUses : []));
    assert.deepEqual(after.recharges[0]!.prompt.settled, { state: "done", total: 6, outcome: "ready" });
    assert.equal(rechargeResult("Fire Breath", after.recharges[0]!.prompt.settled!), "Rolled 6: Fire Breath is ready.");
    assert.equal(openRecord(f.state.encounter, f.of("dragon"), `recharge:${breath.key}`), undefined, "settled, the Dice panel's roll is manual again");
  });

  test("after the prompt's roll, a spend or Mark ready changes the line's words, and the card keeps the roll's answer (CCB-ASTRA-01)", () => {
    const breathLine = (f: ReturnType<typeof fight>, form: "card" | "list") => {
      const rows = usesRows({ form, uses: dragonUses, actor: f.of("dragon"), ownTurn: form === "card", record: currentRecord(f.state.encounter, f.of("dragon")) });
      const row = rows.find((r): r is Extract<UseRow, { kind: "ability" }> => r.kind === "ability")!;
      return abilityState(row);
    };
    const promptRoll = (face: number) => {
      const f = fight();
      while (f.active() !== "ed" || !f.of("dragon").turnRecord?.due) f.run({ t: "encounter.next" });
      return f.roll(rechargeRollOp("r1", { tokenId: "dragon" }, breath, openRecord(f.state.encounter, f.of("dragon"), `recharge:${breath.key}`)), face);
    };
    const ready = promptRoll(6);
    assert.deepEqual([breathLine(ready, "card"), breathLine(ready, "list")], ["Rolled 6: ready", "Rolled 6: ready"]);
    ready.run(abilityOp({ tokenId: "dragon" }, breath));
    assert.deepEqual([breathLine(ready, "card"), breathLine(ready, "list")], ["Used", "Used"]);
    const card = cards(ready.state, dmYou, (h) => (h === "t:dragon" ? dragonUses : []));
    assert.equal(rechargeResult("Fire Breath", card.recharges[0]!.prompt.settled!), "Rolled 6: Fire Breath is ready.", "the prompt's card keeps its answer");
    const used = promptRoll(2);
    assert.deepEqual([breathLine(used, "card"), breathLine(used, "list")], ["Rolled 2: used", "Rolled 2: used"]);
    used.run(abilityOp({ tokenId: "dragon" }, breath, { back: true }));
    assert.deepEqual([breathLine(used, "card"), breathLine(used, "list")], ["Ready", "Ready"]);
  });

  test("Thorn's turn: his death save card for Pat and for the DM, settled by the first roll, Skip to the turn card", () => {
    const f = fight();
    while (f.active() !== "et") f.run({ t: "encounter.next" });
    const pat = cards(f.state, patYou);
    assert.equal(pat.deathSaves.length, 1);
    assert.equal(pat.deathSaves[0]!.waits, false);
    assert.equal(cards(f.state, dmYou).deathSaves.length, 1, "the DM also gets a player's character's death save card");
    const recordId = f.of("thorn").turnRecord!.id;
    f.roll({ t: "actor.deathRoll", tag: "d1", target: { tokenId: "thorn" }, record: openRecord(f.state.encounter, f.of("thorn"), "deathSave") }, 20, P1);
    const settled = cards(f.state, patYou).deathSaves[0]!;
    assert.equal(deathSaveResult("Thorn", settled.prompt.settled!), "Rolled 20: Thorn regains 1 HP.");
    assert.equal(settled.record, recordId);
    assert.equal(settled.id, promptId("c:thorn", recordId, "deathSave"));
  });

  test("the DM's card of a player's dying character is its death save alone: its other prompts and its uses are its players'", () => {
    const f = fight();
    const state = f.state;
    state.characters.thorn = { ...state.characters.thorn!, resources: [{ id: "rage", name: "Rage", max: 3, used: 0, reset: "shortOne" }], actor: { ...state.characters.thorn!.actor, uses: { [breath.key]: breathMark } } };
    while (f.active() !== "et") f.run({ t: "encounter.next" });
    const shape = (who: typeof dmYou | typeof patYou) => {
      const c = cards(f.state, who, (h) => (h === "c:thorn" ? [regen, breath] : []));
      return [c.deathSaves.length, c.regenerations.length, c.recharges.length, c.turn?.blocks.length ?? 0];
    };
    assert.deepEqual(shape(patYou), [1, 1, 1, 1]);
    assert.deepEqual(shape(dmYou), [1, 0, 0, 0]);
  });

  test("a skipped death save leaves its card for the turn card's Reopen row", () => {
    const f = fight();
    while (f.active() !== "et") f.run({ t: "encounter.next" });
    const recordId = f.of("thorn").turnRecord!.id;
    f.run(promptOp({ tokenId: "thorn" }, recordId, "deathSave", "skipped") as Op, P1);
    const pat = cards(f.state, patYou);
    assert.deepEqual(pat.deathSaves, []);
    assert.ok(pat.turn);
    const block = pat.turn.blocks[0]!;
    const rows = usesRows({ form: "card", uses: block.uses, actor: f.of("thorn"), ownTurn: true, record: block.participant.record });
    assert.deepEqual(rows, [{ kind: "skipped", what: "deathSave", text: "Death save skipped" }]);
    f.run(promptOp({ tokenId: "thorn" }, recordId, "deathSave", "open") as Op, P1);
    assert.equal(cards(f.state, patYou).deathSaves.length, 1, "Reopen brings the card back");
  });

  test("the troll's Regeneration card notes the Fire it took, Apply settles it, and the death save waits on it while open", () => {
    const f = fight();
    f.run({ t: "actor.hp", target: { tokenId: "troll" }, change: { kind: "set", cur: 0 } });
    while (f.active() !== "er") f.run({ t: "encounter.next" });
    const dm = cards(f.state, dmYou, (h) => (h === "t:troll" ? [regen] : []));
    assert.equal(dm.regenerations.length, 1);
    const card = dm.regenerations[0]!;
    assert.equal(regenerationNote(card.participant.record?.took, regen.stops), "Recorded Fire damage may stop Regeneration.");
    assert.equal(regenerationWords("Troll", 15, card.participant.record!.life, dm.revives).text, "Troll is at 0 HP and regenerates 15 HP.");
    assert.equal(dm.deathSaves[0]?.waits, true, "the troll's death save waits for its Regeneration");
    const waitsGone = cards(f.state, dmYou, (h) => (h === "t:troll" ? [regen] : []), new Set([card.id]));
    assert.equal(waitsGone.deathSaves[0]?.waits, false, "dismissed here, the death save no longer waits here");
    f.run(regenerateOp({ tokenId: "troll" }, regen, card.record) as Op);
    assert.equal(f.of("troll").hp.cur, 15);
    const after = cards(f.state, dmYou, (h) => (h === "t:troll" ? [regen] : []));
    assert.equal(regeneratedWords(after.regenerations[0]!.prompt.settled!), "Regenerated 15 HP.");
  });

  test("a healthy goblin's turn brings no card", () => {
    const f = fight();
    while (f.active() !== "eg") f.run({ t: "encounter.next" });
    const dm = cards(f.state, dmYou);
    assert.deepEqual([dm.regenerations, dm.deathSaves, dm.recharges, dm.turn], [[], [], [], null]);
  });

  test("a use spent from the list moves the counts the turn card and the row read, and once marks wait for the dragon's turn", () => {
    const f = fight();
    while (f.active() !== "et") f.run({ t: "encounter.next" });
    f.run(legendaryOp({ tokenId: "dragon" }, { key: rays.key, name: rays.name, cost: 1, once: true, off: null }) as Op);
    const la = usesRows({ form: "list", uses: dragonUses, actor: f.of("dragon"), ownTurn: false, record: null }).find((r) => r.kind === "legendary");
    assert.ok(la?.kind === "legendary");
    assert.equal(la.left, 2);
    assert.equal(la.buttons.find((b) => b.key === rays.key)?.off, "once");
    while (f.active() !== "ed") f.run({ t: "encounter.next" });
    const fresh = usesRows({ form: "list", uses: dragonUses, actor: f.of("dragon"), ownTurn: false, record: null }).find((r) => r.kind === "legendary");
    assert.ok(fresh?.kind === "legendary");
    assert.equal(fresh.left, 3, "its pips refill at its turn start");
    assert.equal(fresh.buttons.find((b) => b.key === rays.key)?.off, null);
  });

  test("the turn's creatures: the landing row's own, record or not, then others by their record, and a row that marks time starts none of its own", () => {
    const f = fight();
    while (f.active() !== "eg") f.run({ t: "encounter.next" });
    assert.deepEqual(
      turnParticipants(f.state).map((p) => [p.holder, p.landing, p.record !== null]),
      [["t:goblin", true, false]],
    );
    const marked = { ...f.state, encounter: { ...f.state.encounter!, entries: f.state.encounter!.entries.map((e) => (e.id === "eg" ? { ...e, markRound: f.state.encounter!.round } : e)) } };
    assert.deepEqual(turnParticipants(marked), []);
    // Another holder with a current record joins after the landing row's, sorted by holder.
    const ridden = structuredClone(f.state);
    (ridden.tokens.troll!.actor as { inline: Actor }).inline.turnRecord = { id: 99, entryId: "eg", round: ridden.encounter!.round, hp: 40, life: "alive" };
    (ridden.tokens.dragon!.actor as { inline: Actor }).inline.turnRecord = { id: 99, entryId: "eg", round: ridden.encounter!.round, hp: 200, life: "alive" };
    ridden.characters.thorn!.actor.turnRecord = { id: 99, entryId: "eg", round: ridden.encounter!.round, hp: 0, life: "dying" };
    ridden.tokens.ant = token("ant", { name: "Giant Ant", actor: { inline: actor({ turnRecord: { id: 99, entryId: "eg", round: ridden.encounter!.round, hp: 20, life: "alive" } }) } });
    assert.deepEqual(
      turnParticipants(ridden).map((p) => p.holder),
      ["t:goblin", "c:thorn", "t:ant", "t:dragon", "t:troll"],
    );
    assert.equal(answersFor(ridden, patYou, { tokenId: "troll" }), false);
    assert.equal(answersFor(ridden, patYou, { tokenId: "thorn" }), true);
    assert.equal(answersFor(ridden, dmYou, { tokenId: "thorn" }), false);
    assert.equal(answersFor(ridden, dmYou, { tokenId: "troll" }), true);
  });
});
