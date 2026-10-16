import "../../components/testing/register.ts";
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { createStore } from "zustand/vanilla";
import type { RoomState, Token } from "#shared/model.ts";
import { projectState } from "#shared/project.ts";
import { DM, P1, actor, character, entry, room, token } from "#shared/testutil.ts";

/*
 * A creature companion made an effect keeps its stored life and death saves
 * underneath (docs/design-v1-combat-flow.md 3.6.6), and nothing draws them:
 * its tracker sub-row is never dimmed or struck through as dead, and its
 * panel's Stats show no AC. Made a creature again, they show as they were.
 * Each case renders as the DM and as its owner.
 */

const { createElement } = await import("react");
const { renderToStaticMarkup } = await import("react-dom/server");
const { RoomProvider } = await import("../../state/view.ts");
const { RoomScope, RoomScopeProvider } = await import("../../state/scope.ts");
const { EntryRow } = await import("./Row.tsx");
const { StatsFields } = await import("../tokens/StatsSection.tsx");

function party(kind: "npc" | "object", life: "dead" | "dying"): RoomState {
  const state = room({ characters: { bree: character("bree", { name: "Bree", ownerIds: ["p1"] }) } });
  state.tokens.bt = token("bt", { kind: "pc", name: "Bree", actor: { ref: "bree" }, x: 2, y: 2 });
  state.tokens.ws = token("ws", {
    kind,
    name: "Wildfire Spirit",
    ownerIds: ["p1"],
    x: 3,
    y: 2,
    companion: { of: "bree", turn: "shared" },
    actor: { inline: actor({ hp: { cur: 0, max: 15, temp: 0 }, ac: 13, life, deathSaves: { ok: 1, fail: 1 } }) },
  });
  state.encounter = { rev: 0, round: 1, activeEntryId: null, entries: [entry("e-bree", { tokenId: "bt", value: 15 })] };
  return state;
}

function renderRow(state: RoomState, viewer: typeof DM): string {
  const view = projectState(state, viewer, { sceneId: "s1" });
  const store = createStore(() => ({ view, you: { memberId: viewer.memberId, role: viewer.role }, local: { selectedIds: [], multi: false } }));
  const row = createElement(EntryRow, {
    entry: view.encounter!.entries[0]!,
    active: false,
    role: viewer.role,
    mine: viewer.role !== "dm",
    expanded: false,
    picking: false,
    selected: false,
    onExpand() {},
    onShow() {},
    onShowToken() {},
    drag: null,
    rowRef: () => {},
  });
  return renderToStaticMarkup(
    createElement(RoomProvider, {
      store: store as never,
      actions: {} as never,
      ui: {} as never,
      assets: { url: () => "" } as never,
      children: createElement(RoomScopeProvider, { scope: new RoomScope(), children: createElement("ol", null, row) }),
    }),
  );
}

/** The sub-row's markup: the nested list under Bree's row. */
function subRow(markup: string): string {
  const at = markup.indexOf("Acting on");
  assert.ok(at >= 0, "the spirit is nested under Bree");
  return markup.slice(at);
}

function renderStats(state: RoomState): string {
  const t = state.tokens.ws as Token;
  const a = "inline" in t.actor ? t.actor.inline : undefined;
  const { hpLess } = hpLessModule;
  return renderToStaticMarkup(createElement(StatsFields, { actor: a!, canEdit: () => true, onPatch() {}, dm: true, noAc: hpLess(a, t) }));
}
const hpLessModule = await import("#shared/rules/hp.ts");

describe("a companion made an effect shows none of the life it stores (SOL-03)", () => {
  for (const viewer of [DM, P1]) {
    test(`a dead spirit made an effect is not struck or dimmed, and is again once a creature, as ${viewer.memberId}`, () => {
      const creature = subRow(renderRow(party("npc", "dead"), viewer));
      assert.match(creature, /line-through/, "a dead creature companion is struck through");
      const effect = subRow(renderRow(party("object", "dead"), viewer));
      assert.doesNotMatch(effect, /line-through/);
      assert.doesNotMatch(effect, /opacity:0.45/);
      assert.doesNotMatch(effect, /Armor Class/);
    });
  }

  test("its AC field goes while it is an effect, and comes back as a creature", () => {
    assert.doesNotMatch(renderStats(party("object", "dying")), /aria-label="Armor Class"/);
    assert.match(renderStats(party("npc", "dying")), /aria-label="Armor Class"/);
  });

  test("shownLife: alive while HP-less, the stored life otherwise, for a dying or a dead one", () => {
    const { shownLife } = hpLessModule;
    for (const life of ["dead", "dying"] as const) {
      const t = party("object", life).tokens.ws!;
      const a = "inline" in t.actor ? t.actor.inline : undefined;
      assert.equal(shownLife(a, t), "alive");
      assert.equal(shownLife(a, { ...t, kind: "npc" }), life);
    }
  });
});
