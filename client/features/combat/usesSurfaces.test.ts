import "../../components/testing/register.ts";
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { createStore } from "zustand/vanilla";
import type { RechargeUse } from "#shared/dice/uses.ts";
import { uuidv7 } from "#shared/ids.ts";
import type { RoomState, UseMark, Viewer } from "#shared/model.ts";
import { projectState } from "#shared/project.ts";
import type { Op } from "#shared/protocol.ts";
import { applyOp } from "#shared/reducer.ts";
import { DM, actor, character, entry, env, room, token } from "#shared/testutil.ts";
import type { ReceiptTracker as Tracker } from "../dice/useReceipt.ts";

/*
 * The combat uses where the DM meets them off a creature's turn
 * (docs/design-v1-combat-controls.md 5 and 6): a tracker row's options,
 * rendered as the DM opens them, and the token bar's Uses drawer, on
 * rooms the real reducer moved, so both surfaces read what lane A writes.
 */

const { createElement } = await import("react");
const { renderToStaticMarkup } = await import("react-dom/server");
const { RoomProvider } = await import("../../state/view.ts");
const { RoomScope, RoomScopeProvider } = await import("../../state/scope.ts");
const { EntryRow } = await import("../encounter/Row.tsx");
const { CombatUses, UsesDrawer } = await import("./CombatUses.tsx");
const { combatLocalSlot, rechargeRow, tellPassed } = await import("./state.ts");
const { optionSlot } = await import("../dice/optionState.ts");
const { receiptsSlot } = await import("../dice/useReceipt.ts");
type Scope = InstanceType<typeof RoomScope>;

const legendary = { actionsMax: 3, actionsUsed: 0, resistMax: 0, resistUsed: 0 };

function provide(state: RoomState, viewer: Viewer, child: ReturnType<typeof createElement>, scope: Scope = new RoomScope()): string {
  const view = projectState(state, viewer, { sceneId: "s1" });
  const store = createStore(() => ({ view, you: { memberId: viewer.memberId, role: viewer.role }, roomId: "r1", connection: "open", pending: [], local: { selectedIds: [], multi: false } }));
  return renderToStaticMarkup(
    createElement(RoomProvider, {
      store: store as never,
      actions: { dispatch: () => 1, newId: () => "x" } as never,
      ui: {} as never,
      assets: { url: () => "" } as never,
      children: createElement(RoomScopeProvider, { scope, children: child }),
    }),
  );
}

/** The DM's options for one row, open. */
function rowMenu(state: RoomState, entryId: string): string {
  const view = projectState(state, DM, { sceneId: "s1" });
  const row = view.encounter!.entries.find((e) => e.id === entryId)!;
  const el = createElement(EntryRow, {
    entry: row,
    active: view.encounter!.activeEntryId === entryId,
    role: "dm",
    mine: false,
    expanded: true,
    picking: false,
    selected: false,
    onExpand() {},
    onShow() {},
    onShowToken() {},
    drag: null,
    rowRef: () => {},
  });
  return provide(state, DM, createElement("ol", null, el));
}

function drawer(state: RoomState, tokenId: string): string {
  return provide(state, DM, createElement(UsesDrawer, { target: { tokenId }, name: "Warhorse", onClose() {} }));
}

describe("a row with no uses draws no Uses group (CCB-ASTRA-05, CCB-OPUS-1)", () => {
  const state = room({ characters: { bree: character("bree", { name: "Bree", ownerIds: ["p1"] }) } });
  state.tokens.g1 = token("g1", { name: "Goblin", x: 2, y: 2 });
  state.tokens.bt = token("bt", { kind: "pc", name: "Bree", x: 4, y: 2, actor: { ref: "bree" } });
  state.tokens.dragon = token("dragon", { name: "Dragon", x: 6, y: 2, actor: { inline: actor({ legendary }) } });
  state.encounter = { rev: 0, round: 1, activeEntryId: "eg", entries: [entry("eg", { tokenId: "g1", value: 15 }), entry("eb", { tokenId: "bt", value: 12 }), entry("ed", { tokenId: "dragon", value: 10 })] };

  test("a goblin's options, as the DM opens them", () => {
    const markup = rowMenu(state, "eg");
    assert.match(markup, /Row hidden from players/, "the options are open");
    assert.doesNotMatch(markup, /data-uses-group/);
  });

  test("a PC's options with no class resources", () => {
    const markup = rowMenu(state, "eb");
    assert.match(markup, /Row hidden from players/, "the options are open");
    assert.doesNotMatch(markup, /data-uses-group/);
  });

  test("a creature with legendary counts keeps its group, its counts as pips on its rows and no pips block under them", () => {
    const markup = rowMenu(state, "ed");
    assert.match(markup, /data-uses-group/);
    assert.equal([...markup.matchAll(/data-pip="left"/g)].length, 3);
    assert.doesNotMatch(markup, /data-pips|Legendary Actions used/);
  });
});

describe("a goblin whose only row is its skipped death save shows Uses in its row and its bar while its turn lasts (D-261024-40)", () => {
  test("Reopen in both, gone after Next", () => {
    let state = room();
    state.meta.settings = { ...state.meta.settings, monstersDieAtZero: false };
    state.tokens.g1 = token("g1", { name: "Goblin", x: 2, y: 2 });
    state.tokens.o1 = token("o1", { name: "Orc", x: 4, y: 2 });
    let seq = 0;
    const run = (op: Op) => {
      const r = applyOp(state, op, DM, env(++seq));
      assert.ok(r.ok, `${op.t}: ${r.ok ? "" : r.message}`);
      state = r.state;
    };
    run({ t: "actor.hp", target: { tokenId: "g1" }, change: { kind: "set", cur: 0 } });
    run({ t: "encounter.start", entries: [{ id: "eo", tokenId: "o1", value: 15 }, { id: "eg", tokenId: "g1", value: 10 }] });
    while (state.encounter!.activeEntryId !== "eg") run({ t: "encounter.next" });
    const goblinDrawer = () => provide(state, DM, createElement(UsesDrawer, { target: { tokenId: "g1" }, name: "Goblin", onClose() {} }));
    assert.doesNotMatch(rowMenu(state, "eg"), /data-uses-group/, "its death save is a card, not a use");
    const actorNow = state.tokens.g1!.actor;
    assert.ok("inline" in actorNow && actorNow.inline.turnRecord);
    run({ t: "actor.prompt", target: { tokenId: "g1" }, record: actorNow.inline.turnRecord.id, what: "deathSave", state: "skipped" });
    for (const markup of [rowMenu(state, "eg"), goblinDrawer()]) {
      assert.match(markup, />Death save skipped</);
      assert.match(markup, /aria-label="Reopen: Death save skipped"/);
    }
    assert.match(rowMenu(state, "eg"), /data-uses-group/);
    run({ t: "encounter.next" });
    assert.doesNotMatch(rowMenu(state, "eg"), /data-uses-group/);
    assert.doesNotMatch(goblinDrawer(), /Death save skipped/);
  });
});

/** A player's options for their own row, open. */
function ownRowMenu(state: RoomState, entryId: string, viewer: Viewer): string {
  const view = projectState(state, viewer, { sceneId: "s1" });
  const row = view.encounter!.entries.find((e) => e.id === entryId)!;
  const el = createElement(EntryRow, { entry: row, active: false, role: "player", mine: true, expanded: true, picking: false, selected: false, onExpand() {}, onShow() {}, onShowToken() {}, drag: null, rowRef: () => {} });
  return provide(state, viewer, createElement("ol", null, el));
}

/** Where each of `marks` first stands in `markup`, failing for one it lacks. */
function at(markup: string, marks: readonly (string | RegExp)[]): number[] {
  return marks.map((m) => {
    const i = typeof m === "string" ? markup.indexOf(m) : (m.exec(markup)?.index ?? -1);
    assert.ok(i >= 0, `no ${String(m)}`);
    return i;
  });
}

describe("the row's options lead with the creature's things in its Combat section's order, then the row's own (docs/design-v1-token-sections.md 4)", () => {
  const state = room({ characters: { bree: character("bree", { name: "Bree", ownerIds: ["p1"], resources: [{ id: "rage", name: "Rage", max: 2, used: 0, reset: "long" }] }) } });
  state.tokens.dragon = token("dragon", { name: "Dragon", x: 6, y: 2, actor: { inline: actor({ legendary }) } });
  state.tokens.bt = token("bt", { kind: "pc", name: "Bree", x: 4, y: 2, actor: { ref: "bree" } });
  // The dragon has no stat block, so only a row already in its lair offers In lair (GP2-1).
  state.encounter = { rev: 0, round: 1, activeEntryId: "eb", entries: [entry("eb", { tokenId: "bt", value: 12 }), entry("ed", { tokenId: "dragon", value: 10, inLair: true })] };
  const reaction = /role="switch"[^>]*aria-labelledby="[^"]*"[^>]*>(?:(?!<\/button>).)*Reaction used/;

  test("the DM's: Uses, Reaction used, Ready, then Roll again, Row hidden from players, In lair, the reminder, and Remove last", () => {
    const markup = rowMenu(state, "ed");
    const order = at(markup, ["data-uses-group", "Legendary Actions</span><span", reaction, 'aria-label="Trigger for the Ready action"', "Roll again, replaces 10", "Row hidden from players", "In lair", "Initiative roll reminder", 'aria-label="Remove from the fight"']);
    assert.deepEqual(order, [...order].sort((a, b) => a - b), JSON.stringify(order));
  });

  test("a player's own: Uses, Reaction used, Ready, then Roll again, and Remove last", () => {
    const markup = ownRowMenu(state, "eb", { memberId: "p1", role: "player" });
    const order = at(markup, ["data-uses-group", "Use Rage", reaction, 'aria-label="Trigger for the Ready action"', "Roll again, replaces 12", 'aria-label="Remove from the fight"']);
    assert.deepEqual(order, [...order].sort((a, b) => a - b), JSON.stringify(order));
    assert.doesNotMatch(markup, /Row hidden from players|In lair/, "none of the DM's");
  });
});

/**
 * Rows: Dragon 20, Bree 10, Warhorse 8, the warhorse a creature with
 * legendary counts that Bree rides and steers, so it acts on her turn.
 */
function mountedFight() {
  let state = room({ characters: { bree: character("bree", { name: "Bree", ownerIds: ["p1"] }) } });
  state.tokens.dragon = token("dragon", { name: "Dragon", x: 20, y: 5 });
  state.tokens.bree = token("bree", { kind: "pc", name: "Bree", x: 6, y: 4, ownerIds: ["p1"], actor: { ref: "bree" } });
  state.tokens.horse = token("horse", { name: "Warhorse", kind: "npc", size: "large", x: 4, y: 4, actor: { inline: actor({ legendary }) } });
  let seq = 0;
  const run = (op: Op) => {
    const r = applyOp(state, op, DM, env(++seq));
    assert.ok(r.ok, `${op.t}: ${r.ok ? "" : r.message}`);
    state = r.state;
  };
  run({ t: "encounter.start", entries: [{ id: "ed", tokenId: "dragon", value: 20 }, { id: "eb", tokenId: "bree", value: 10 }, { id: "eh", tokenId: "horse", value: 8 }] });
  run({ t: "encounter.next" });
  run({ t: "token.attach", tokenId: "bree", to: "horse", kind: "ride", steer: true, x: 5, y: 4, elevation: 0 });
  return { get state() { return state; }, next: () => run({ t: "encounter.next" }) };
}

const OFF = /A Legendary Action: after another creature(&#x27;|')s turn\./;

describe("a controlled mount on its rider's turn: the row and the bar agree it acts now (CCB-ASTRA-03, CCB-OPUS-6)", () => {
  test("on Bree's turn both hold its legendary actions, and both free them once a turn of another creature comes", () => {
    const f = mountedFight();
    // Bree got on the warhorse on the dragon's turn.
    assert.equal(f.state.encounter!.activeEntryId, "ed");
    f.next();
    assert.equal(f.state.encounter!.activeEntryId, "eb");
    assert.match(rowMenu(f.state, "eh"), OFF, "the row on its rider's turn");
    assert.match(drawer(f.state, "horse"), OFF, "the bar's drawer on its rider's turn");
    // Its own row only marks time, still its turn.
    f.next();
    assert.equal(f.state.encounter!.activeEntryId, "eh");
    assert.match(rowMenu(f.state, "eh"), OFF);
    assert.match(drawer(f.state, "horse"), OFF);
    // The dragon's turn: another creature's, so a legendary action is free in both.
    f.next();
    assert.equal(f.state.encounter!.activeEntryId, "ed");
    assert.doesNotMatch(rowMenu(f.state, "eh"), OFF);
    assert.doesNotMatch(drawer(f.state, "horse"), OFF);
    assert.match(drawer(f.state, "horse"), /Spend a Legendary Action/);
  });
});

/** The words of a uses list's status line, or null with none. */
const statusOf = (markup: string) => /<p role="status"[^>]*>([^<]*)<\/p>/.exec(markup)?.[1] ?? null;

describe("a Roll recharge from the list that did not land says why in the list's status line (CCB-ASTRA-02)", () => {
  const breath: RechargeUse = { kind: "recharge", key: "actions:fire-breath", name: "Fire Breath", section: "actions", min: 5 };
  const mark: UseMark = { kind: "recharge", name: "Fire Breath", used: 1, max: 1, min: 5 };
  const state = room();
  state.tokens.dragon = token("dragon", { name: "Dragon", actor: { inline: actor({ uses: { [breath.key]: mark } }) } });
  // The dragon's turn, which the list's rolls were sent on.
  state.encounter = { rev: 0, round: 1, activeEntryId: "e1", entries: [entry("e1", { tokenId: "dragon" })] };
  const TURN = "e1|1|";
  const row = rechargeRow("t:dragon", breath.key);

  /** The list as it stands once this device's list sent `tag` on the dragon's turn, the Dice panel's row holding `rowTag`. */
  function listAfter(scope: Scope, tag: string, rowTag = tag): string {
    // A server render reads a store's initial state, so each store's state now stands as its initial one (as LibraryGrid.test.ts does).
    const local = scope.get(combatLocalSlot);
    local.setState({ rolls: { [row]: { tag, turn: TURN } } });
    local.getInitialState = local.getState;
    const options = scope.get(optionSlot);
    options.setState({ tags: { [row]: rowTag } });
    options.getInitialState = options.getState;
    return provide(state, DM, createElement(CombatUses, { target: { tokenId: "dragon" }, form: "list", uses: [breath], loading: false, failed: false, ownTurn: false, name: "Dragon" }), scope);
  }

  test("refused, as when another device settled its prompt first", () => {
    const scope = new RoomScope();
    const tracker = scope.get(receiptsSlot);
    tracker.sending("r1", 0);
    tracker.answer("r1", 0, "refused", { code: "invalid", message: "Not saved. It was settled meanwhile.", text: "Not saved. It was settled meanwhile." });
    const markup = listAfter(scope, "r1");
    assert.match(markup, /Roll recharge/);
    assert.equal(statusOf(markup), "It was settled meanwhile.");
  });

  test("unknown, an answer lost on the way", async () => {
    const scope = new RoomScope();
    const tracker = scope.get(receiptsSlot);
    tracker.sending("r2", 0);
    tracker.answer("r2", 0, "unknown");
    // With no server to ask, the lookup settles the part unknown.
    await tracker.lookup("r2");
    assert.equal(tracker.state("r2")?.state, "unknown");
    assert.equal(statusOf(listAfter(scope, "r2")), "This may have happened. Check the log.");
  });

  test("a roll it sent that landed says its result while the mark agrees, and gives way to a spend after it (CCB-ASTRA-01)", () => {
    const rolled = (uses: Record<string, UseMark>) => {
      const scope = new RoomScope();
      const s = { ...state, tokens: { dragon: token("dragon", { name: "Dragon", actor: { inline: actor({ uses }) } }) } };
      s.log = [{ id: "5:0", at: "2026-10-23T20:00:00.000Z", kind: "event", data: { type: "dice", by: "dm1", to: "all", tag: "own", rolls: [{ formula: "1d6", faces: [6], total: 6, label: "Fire Breath recharge" }] } }];
      scope.get(receiptsSlot).sending("own", 0);
      scope.get(receiptsSlot).answer("own", 0, "taken");
      const local = scope.get(combatLocalSlot);
      local.setState({ rolls: { [row]: { tag: "own", turn: TURN } } });
      local.getInitialState = local.getState;
      const options = scope.get(optionSlot);
      options.setState({ tags: { [row]: "own" } });
      options.getInitialState = options.getState;
      return provide(s, DM, createElement(CombatUses, { target: { tokenId: "dragon" }, form: "list", uses: [breath], loading: false, failed: false, ownTurn: false, name: "Dragon" }), scope);
    };
    assert.match(rolled({}), />, Rolled 6: ready</);
    assert.match(rolled({ [breath.key]: mark }), />, Used</, "spent again after the ready roll");
  });

  test("never for a roll that landed, nor for the Dice panel's own roll of that recharge", () => {
    const scope = new RoomScope();
    const tracker = scope.get(receiptsSlot);
    tracker.sending("r3", 0);
    tracker.answer("r3", 0, "refused", { code: "invalid", message: "It was settled meanwhile.", text: "It was settled meanwhile." });
    assert.equal(statusOf(listAfter(scope, "r3", "panel-tag")), null, "the row's newest roll is the panel's");
    const landed = new RoomScope();
    landed.get(receiptsSlot).sending("r4", 0);
    landed.get(receiptsSlot).answer("r4", 0, "taken");
    assert.equal(statusOf(listAfter(landed, "r4")), null);
  });
});

describe("the list's trouble line on a creature with two recharges, and a remount in a later turn (CCB-ASTRA-06, CCB-OPUS-12)", () => {
  const fire: RechargeUse = { kind: "recharge", key: "actions:fire-breath", name: "Fire Breath", section: "actions", min: 5 };
  const frost: RechargeUse = { kind: "recharge", key: "actions:frost-breath", name: "Frost Breath", section: "actions", min: 6 };
  const used = (u: RechargeUse): UseMark => ({ kind: "recharge", name: u.name, used: 1, max: 1, min: u.min });
  const rowA = rechargeRow("t:dragon", fire.key);
  const rowB = rechargeRow("t:dragon", frost.key);
  // Rolled in this order, A first.
  const A = uuidv7(1_000);
  const B = uuidv7(2_000);
  const refuse = (tracker: Tracker, tag: string, text: string) => {
    tracker.sending(tag, 0);
    tracker.answer(tag, 0, "refused", { code: "invalid", message: text, text });
  };
  const lose = async (tracker: Tracker, tag: string) => {
    tracker.sending(tag, 0);
    tracker.answer(tag, 0, "unknown");
    await tracker.lookup(tag);
  };

  /** The dragon's list in `round`, its two rolls sent on round 1's turn, as the list that rolled B (silencing A) left them, or a list opened after one showed `seen`. */
  async function statusAfter(input: { answer(tracker: Tracker): void | Promise<void>; round: number; silenced?: string[]; seen?: string[] }): Promise<string | null> {
    const scope = new RoomScope();
    await input.answer(scope.get(receiptsSlot));
    const s = room();
    s.tokens.dragon = token("dragon", { name: "Dragon", actor: { inline: actor({ uses: { [fire.key]: used(fire), [frost.key]: used(frost) } }) } });
    s.encounter = { rev: 0, round: input.round, activeEntryId: "e1", entries: [entry("e1", { tokenId: "dragon" })] };
    const local = scope.get(combatLocalSlot);
    local.setState({ rolls: { [rowA]: { tag: A, turn: "e1|1|" }, [rowB]: { tag: B, turn: "e1|1|" } }, silenced: new Set(input.silenced), seen: new Set(input.seen) });
    local.getInitialState = local.getState;
    const options = scope.get(optionSlot);
    options.setState({ tags: { [rowA]: A, [rowB]: B } });
    options.getInitialState = options.getState;
    return statusOf(provide(s, DM, createElement(CombatUses, { target: { tokenId: "dragon" }, form: "list", uses: [fire, frost], loading: false, failed: false, ownTurn: false, name: "Dragon" }), scope));
  }

  test("A refused, then B refused: B's reason, with A silenced by the tap that rolled B or not", async () => {
    const both = (tracker: Tracker) => {
      refuse(tracker, A, "Fire Breath was settled meanwhile.");
      refuse(tracker, B, "Frost Breath was settled meanwhile.");
    };
    assert.equal(await statusAfter({ answer: both, round: 1, silenced: [A] }), "Frost Breath was settled meanwhile.");
    assert.equal(await statusAfter({ answer: both, round: 1 }), "Frost Breath was settled meanwhile.");
  });

  test("A refused, then B unknown: B's", async () => {
    const answer = async (tracker: Tracker) => {
      refuse(tracker, A, "Fire Breath was settled meanwhile.");
      await lose(tracker, B);
    };
    assert.equal(await statusAfter({ answer, round: 1, silenced: [A] }), "This may have happened. Check the log.");
  });

  test("A refused, then the list opened in a later turn, or again once a list showed it: nothing", async () => {
    const answer = (tracker: Tracker) => refuse(tracker, A, "Fire Breath was settled meanwhile.");
    assert.equal(await statusAfter({ answer, round: 1 }), "Fire Breath was settled meanwhile.", "on its turn, shown by no list yet");
    assert.equal(await statusAfter({ answer, round: 2 }), null);
    assert.equal(await statusAfter({ answer, round: 1, seen: [A] }), null);
  });

  test("a failure that came once its turn passed goes to one toast for every list, in the receipts' own words", async () => {
    const scope = new RoomScope();
    const tracker = scope.get(receiptsSlot);
    refuse(tracker, A, "Fire Breath was settled meanwhile.");
    await lose(tracker, B);
    const local = scope.get(combatLocalSlot);
    const told: [string, string][] = [];
    const notify = (text: string, tone: string) => void told.push([text, tone]);
    tellPassed([A, B], local, tracker, notify);
    // A second list open on the same creature finds them told.
    tellPassed([A, B], local, tracker, notify);
    assert.deepEqual(told, [
      ["Fire Breath was settled meanwhile.", "error"],
      ["A roll may have happened. Check the log.", "info"],
    ]);
    assert.deepEqual([...local.getState().seen], [A, B], "no list shows them after");
  });
});
