import "../../components/testing/register.ts";
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { createStore } from "zustand/vanilla";
import type { LogEntry, PcStats, RollRequest, RoomState, Viewer } from "#shared/model.ts";
import { projectState } from "#shared/project.ts";
import { P1, character, room, token } from "#shared/testutil.ts";
import { creatureRolls, type DiceView } from "./creature.ts";
import { optionSlot } from "./optionState.ts";
import { diceChoicesSlot } from "./useDicePanel.ts";
import { receiptsSlot } from "./useReceipt.ts";

/*
 * A row shows no result of its own (docs/design-v1-dice-ui.md 4.1 and 12.1):
 * after a save, an attack and a damage roll land, their totals are in the
 * panel's header line and nowhere under the buttons.
 */

const { createElement } = await import("react");
const { renderToStaticMarkup } = await import("react-dom/server");
const { RoomProvider } = await import("../../state/view.ts");
const { RoomScope, RoomScopeProvider } = await import("../../state/scope.ts");
const { OptionsList } = await import("./RollOptions.tsx");
const { LastResult } = await import("./Roller.tsx");

const THORN: PcStats = {
  abilities: { str: 10, dex: 18, con: 12, int: 10, wis: 12, cha: 10 },
  saves: ["dex", "int"],
  skills: {},
  adjust: {},
  defenses: {},
  rolls: [{ id: "r1", name: "Rapier", kind: "weapon", ability: "dex", attack: { prof: true, bonus: 0 }, dice: [{ formula: "1d8", mod: true, type: "piercing" }] }],
};

// Totals no button's own words could hold, so finding one in the markup can only be a result.
const TOTALS = { save: 4141, attack: 4242, damage: 4343 };

function table(): RoomState {
  const state = room({ characters: { thorn: character("thorn", { name: "Thorn", ownerIds: ["p1"], level: 5 }) } });
  state.characters.thorn!.stats = THORN;
  state.tokens.tt = token("tt", { kind: "pc", name: "Thorn", ownerIds: ["p1"], actor: { ref: "thorn" } });
  return state;
}

function line(tag: string, total: number, label: string, n: number): LogEntry {
  return { id: `${n}:0`, at: "2026-10-17T20:00:00.000Z", kind: "event", data: { type: "dice", tag, by: "p1", to: "all", rolls: [{ formula: "1d20+7", faces: [total - 7], total, label }] } };
}

function render(viewer: Viewer, landed: boolean, pending = false, requests: RoomState["rolls"] = {}): string {
  const state = table();
  state.rolls = requests;
  const view = projectState(state, viewer, { sceneId: "s1" }) as unknown as RoomState;
  const dice: DiceView = { you: viewer, view, srd: { monsters: null, rolls: null } };
  const creature = { characterId: "thorn" } as const;
  const rolls = creatureRolls(dice, creature);
  assert.ok(rolls?.numbers, "Thorn's block gives the panel its numbers");
  const rapier = rolls.named.find((r) => r.name === "Rapier");
  assert.ok(rapier);
  const scope = new RoomScope();
  const log: LogEntry[] = [];
  if (landed) {
    const rows = {
      save: [`c:thorn|${JSON.stringify({ kind: "save", ability: "dex" })}`, "Dexterity save"],
      attack: [`c:thorn|${rapier.key}|attack`, "Rapier"],
      damage: [`c:thorn|${rapier.key}|damage`, "Rapier damage"],
    } as const;
    const tags: Record<string, string> = {};
    const tracker = scope.get(receiptsSlot);
    tracker.env = { lookup: async () => ({ parts: [] }), log: () => log };
    for (const [kind, [row, label]] of Object.entries(rows) as [keyof typeof rows, (typeof rows)[keyof typeof rows]][]) {
      const tag = `tag-${kind}`;
      tags[row] = tag;
      log.push(line(tag, TOTALS[kind], label, log.length + 1));
      tracker.sending(tag, 0);
      if (!(pending && kind === "save")) tracker.answer(tag, 0, "taken");
    }
    // A server render reads a zustand store's first state, so each store's state is made its first.
    const options = scope.get(optionSlot);
    options.setState({ tags });
    options.getInitialState = options.getState;
    const choices = scope.get(diceChoicesSlot);
    choices.setState({ last: { tag: "tag-damage", rolls: [{ formula: "1d20+7", label: "Rapier damage" }], to: "all" } });
    choices.getInitialState = choices.getState;
  }
  const store = createStore(() => ({ view: { ...view, log }, roomId: "r1", connection: "open", you: viewer, sceneId: "s1", local: { selectedIds: [], multi: false } }));
  return renderToStaticMarkup(
    createElement(RoomProvider, {
      store: store as never,
      actions: { dispatch: () => 1 } as never,
      ui: {} as never,
      assets: { url: () => "" } as never,
      children: createElement(RoomScopeProvider, {
        scope,
        children: [createElement(LastResult, { key: "last", onOpen() {} }), createElement(OptionsList, { key: "list", dice, rolls, creature, tokenId: "tt", name: "Thorn" })],
      }),
    }),
  );
}

describe("a roll option's result shows in the header line, never under its button (docs/design-v1-dice-ui.md 4.1)", () => {
  test("before any roll, the options draw and no total is anywhere", () => {
    const markup = render(P1, false);
    assert.match(markup, /DEX \+7/, "the save's button");
    assert.match(markup, /Rapier/);
    for (const total of Object.values(TOTALS)) assert.doesNotMatch(markup, new RegExp(String(total)));
  });

  test("after a save, an attack and a damage roll land, only the newest shows, once, in the header line", () => {
    const markup = render(P1, true);
    const at = markup.indexOf("Rolls for Thorn");
    assert.ok(at > 0, "the header line draws before the options");
    const header = markup.slice(0, at);
    const options = markup.slice(at);
    assert.match(header, /4,343/, "the newest roll's total, in the header line");
    for (const total of Object.values(TOTALS)) {
      assert.doesNotMatch(options, new RegExp(`${total}|${total.toLocaleString("en-US")}`), `no ${total} under a button`);
    }
    assert.match(options, /DEX \+7/, "the cell's words are as before the roll");
  });

  test("a row reads its own roll: one still on its way shows busy on its button", () => {
    const markup = render(P1, true, true);
    const busy = [...markup.matchAll(/<button[^>]*aria-busy="true"[^>]*>(.*?)<\/button>/g)].map((m) => m[1]);
    assert.equal(busy.length, 1, "only the roll still on its way");
    assert.match(busy[0]!, /DEX \+7/, "the Dex save waits for its line");
  });
});

describe("an ask for a skill opens the folded Skills group", () => {
  test("the skill's Asked button draws as the panel opens, where the group starts folded", () => {
    const button = (markup: string) => [...markup.matchAll(/<button[^>]*>(.*?)<\/button>/g)].map((m) => m[1]!.replace(/<[^>]*>/g, " ")).find((text) => text.includes("Perception"));
    assert.equal(button(render(P1, false)), undefined, "folded, Skills draws no buttons");
    const request: RollRequest = { id: "r1", rev: 0, test: { kind: "check", choices: [{ ability: "wis", skill: "perception" }] }, dcShown: false, resultShown: true, at: "2026-10-17T20:00:00.000Z", targets: [{ characterId: "thorn" }] };
    assert.match(button(render(P1, false, false, { r1: request })) ?? "", /Perception \+1.*Asked/);
  });
});
