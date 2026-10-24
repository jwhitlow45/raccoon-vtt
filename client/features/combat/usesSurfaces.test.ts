import "../../components/testing/register.ts";
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { createStore } from "zustand/vanilla";
import type { RechargeUse } from "#shared/dice/uses.ts";
import type { RoomState, UseMark, Viewer } from "#shared/model.ts";
import { projectState } from "#shared/project.ts";
import type { Op } from "#shared/protocol.ts";
import { applyOp } from "#shared/reducer.ts";
import { DM, actor, character, entry, env, room, token } from "#shared/testutil.ts";

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
const { combatLocalSlot, rechargeRow } = await import("./state.ts");
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
    assert.match(markup, /Hidden from players/, "the options are open");
    assert.doesNotMatch(markup, /data-uses-group/);
  });

  test("a PC's options with no class resources", () => {
    const markup = rowMenu(state, "eb");
    assert.match(markup, /Hidden from players/, "the options are open");
    assert.doesNotMatch(markup, /data-uses-group/);
  });

  test("a creature with legendary counts keeps its group, with its pips", () => {
    const markup = rowMenu(state, "ed");
    assert.match(markup, /data-uses-group/);
    assert.match(markup, /Legendary Actions used: 0 of 3/);
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

const OFF = /A legendary action: after another creature(&#x27;|')s turn\./;

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
    assert.match(drawer(f.state, "horse"), /Spend a legendary action/);
  });
});

describe("a Roll recharge from the list that did not land says why in the list's status line (CCB-ASTRA-02)", () => {
  const breath: RechargeUse = { kind: "recharge", key: "actions:fire-breath", name: "Fire Breath", section: "actions", min: 5 };
  const mark: UseMark = { kind: "recharge", name: "Fire Breath", used: 1, max: 1, min: 5 };
  const state = room();
  state.tokens.dragon = token("dragon", { name: "Dragon", actor: { inline: actor({ uses: { [breath.key]: mark } }) } });
  const row = rechargeRow("t:dragon", breath.key);

  /** The list as it stands once this device's list sent `tag`, the Dice panel's row holding `rowTag`. */
  function listAfter(scope: Scope, tag: string, rowTag = tag): string {
    // A server render reads a store's initial state, so each store's state now stands as its initial one (as LibraryGrid.test.ts does).
    const local = scope.get(combatLocalSlot);
    local.setState({ rolls: { [row]: tag } });
    local.getInitialState = local.getState;
    const options = scope.get(optionSlot);
    options.setState({ tags: { [row]: rowTag } });
    options.getInitialState = options.getState;
    return provide(state, DM, createElement(CombatUses, { target: { tokenId: "dragon" }, form: "list", uses: [breath], loading: false, failed: false, ownTurn: false, name: "Dragon" }), scope);
  }
  const statusOf = (markup: string) => /<p role="status"[^>]*>([^<]*)<\/p>/.exec(markup)?.[1] ?? null;

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
      local.setState({ rolls: { [row]: "own" } });
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
