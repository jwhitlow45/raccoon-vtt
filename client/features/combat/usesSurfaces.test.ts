import "../../components/testing/register.ts";
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { createStore } from "zustand/vanilla";
import type { RoomState, Viewer } from "#shared/model.ts";
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
const { UsesDrawer } = await import("./CombatUses.tsx");

const legendary = { actionsMax: 3, actionsUsed: 0, resistMax: 0, resistUsed: 0 };

function provide(state: RoomState, viewer: Viewer, child: ReturnType<typeof createElement>): string {
  const view = projectState(state, viewer, { sceneId: "s1" });
  const store = createStore(() => ({ view, you: { memberId: viewer.memberId, role: viewer.role }, roomId: "r1", connection: "open", pending: [], local: { selectedIds: [], multi: false } }));
  return renderToStaticMarkup(
    createElement(RoomProvider, {
      store: store as never,
      actions: { dispatch: () => 1, newId: () => "x" } as never,
      ui: {} as never,
      assets: { url: () => "" } as never,
      children: createElement(RoomScopeProvider, { scope: new RoomScope(), children: child }),
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
