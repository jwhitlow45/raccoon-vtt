import "../../components/testing/register.ts";
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { createStore } from "zustand/vanilla";
import type { LogEntry, PcStats, RollRequest, RoomState, UseMark, Viewer } from "#shared/model.ts";
import { projectState } from "#shared/project.ts";
import { SKILLS } from "#shared/rules/skills.ts";
import { DM, P1, actor, character, customMonster, entry, room, token } from "#shared/testutil.ts";
import { creatureRolls, type DiceView } from "./creature.ts";
import { DICE_FOLD_KEYS, diceFoldsSlot } from "./diceFolds.ts";
import { optionSlot } from "./optionState.ts";
import { openedBlock } from "./cast/cast.ts";
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
const { OptionsList, PlayerOptions, useOptionsEndOnGroup } = await import("./RollOptions.tsx");
const { LastResult } = await import("./Roller.tsx");

const THORN: PcStats = {
  abilities: { str: 10, dex: 18, con: 12, int: 10, wis: 12, cha: 10 },
  saves: ["dex", "int"],
  skills: {},
  adjust: {},
  defenses: {},
  rolls: [{ id: "r1", name: "Rapier", kind: "weapon", ability: "dex", attack: { prof: true, bonus: 0 }, dice: [{ formula: "1d8", mod: true, type: "piercing" }] }],
};

/**
 * The markup with FL-7's marks and a folded line's parts taken out, so
 * these tests read the words and layout as they were drawn before them
 * (proficiencySurfaces.test.ts reads the marks).
 */
function unmarked(markup: string): string {
  return markup
    .replace(/<span data-proficiency-marker="\w+"[^>]*><\/span>/g, "")
    .replace(/<span data-proficiency-label="" data-proficiency-level="\w+"[^>]*>([^<]*)<\/span>/g, "$1")
    .replace(/<span data-summary-more=""[^>]*><span><\/span>…<\/span>/g, "")
    .replace(/<span data-summary-part="" data-summary-join="[^"]*">((?:[^<]|<(?!\/?span))*)<\/span>/g, "$1")
    .replace(/(id="[^"]*-summary"[^>]*>)<span>([^<]*)<\/span>/g, "$1$2");
}

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

function render(viewer: Viewer, landed: boolean, pending = false, requests: RoomState["rolls"] = {}, open = true, typedBonus?: string): string {
  const state = table();
  if (typedBonus !== undefined) delete state.characters.thorn!.stats;
  state.rolls = requests;
  const view = projectState(state, viewer, { sceneId: "s1" }) as unknown as RoomState;
  const dice: DiceView = { you: viewer, view, srd: { monsters: null, rolls: null } };
  const creature = { characterId: "thorn" } as const;
  const rolls = creatureRolls(dice, creature);
  assert.ok(rolls);
  if (typedBonus === undefined) assert.ok(rolls.numbers, "Thorn's block gives the panel its numbers");
  const rapier = rolls.named.find((r) => r.name === "Rapier");
  if (typedBonus === undefined) assert.ok(rapier);
  const scope = new RoomScope();
  if (typedBonus !== undefined) {
    const options = scope.get(optionSlot);
    options.setState({ bonus: { "c:thorn": typedBonus } });
    options.getInitialState = options.getState;
  }
  // Every group open, as the e2e suites store them (e2e/harness.ts diceFoldsOpen), so these read the cells: a server render reads a phone's starts.
  if (open) for (const key of DICE_FOLD_KEYS) scope.get(diceFoldsSlot).tap(key, true, false);
  const log: LogEntry[] = [];
  if (landed) {
    assert.ok(rapier);
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
  return unmarked(renderToStaticMarkup(
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
  ));
}

test("skill names keep one line with room for their bonus in equal grid columns", () => {
  for (const typedBonus of [undefined, "", "-20", "+30"]) {
    const markup = render(P1, false, false, {}, true, typedBonus);
    assert.ok(/grid-template-columns:repeat\(auto-fill, minmax\(min\(100%, 200px\), 1fr\)\)/.test(markup), "skill columns leave room for the longest label");
    for (const { name } of Object.values(SKILLS)) {
      const label = new RegExp(`<span[^>]*>${name} [^<]*</span>`).exec(markup)?.[0];
      assert.ok(label, `${name} draws`);
      assert.match(label, /white-space:nowrap/, `${name} stays on one line`);
      if (typedBonus !== undefined) assert.ok(label.includes(`d20${typedBonus}`), "a creature without numbers keeps its typed bonus");
    }
  }
});

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
    assert.equal(button(render(P1, false, false, {}, false)), undefined, "folded, Skills draws no buttons");
    const request: RollRequest = { id: "r1", rev: 0, test: { kind: "check", choices: [{ ability: "wis", skill: "perception" }] }, dcShown: false, resultShown: true, at: "2026-10-17T20:00:00.000Z", targets: [{ characterId: "thorn" }] };
    assert.match(button(render(P1, false, false, { r1: request }, false)) ?? "", /Perception \+1.*Asked/);
  });
});

/*
 * The card and the groups (docs/design-v1-dice-pass.md 5 and 6): drawn on a
 * server render, which reads a phone's starts, so Saves and checks, Skills
 * and Traits start folded and the rest open.
 */
describe("the creature's card and groups", () => {
  /** Thorn, with a rapier and two spells of two levels, his wolf, and a request as given. */
  function room2(rolls: RoomState["rolls"] = {}, wolf = true): RoomState {
    const state = table();
    state.characters.thorn!.stats = {
      ...THORN,
      spellAbility: "wis",
      rolls: [
        ...THORN.rolls,
        { id: "sf", name: "Sacred Flame", kind: "spell", ability: "spell", level: 0, save: { ability: "dex", onPass: "none" }, dice: [{ formula: "1d8", type: "radiant" }] },
        { id: "gw", name: "Guiding Bolt", kind: "spell", ability: "spell", level: 1, attack: { prof: true, bonus: 0 }, dice: [{ formula: "4d6", type: "radiant" }] },
      ],
    };
    if (wolf) state.tokens.wolf = token("wolf", { kind: "monster", name: "Wolf", ownerIds: ["p1"], companion: { of: "thorn", turn: "own" } });
    state.rolls = rolls;
    return state;
  }

  function draw(input: { scope?: InstanceType<typeof RoomScope>; viewer?: Viewer; state: RoomState; body: "player" | "list"; creature?: { tokenId: string } }): string {
    const viewer = input.viewer ?? P1;
    const view = projectState(input.state, viewer, { sceneId: "s1" }) as unknown as RoomState;
    const scope = input.scope ?? new RoomScope();
    const store = createStore(() => ({ view, roomId: "r1", connection: "open", you: viewer, sceneId: "s1", local: { selectedIds: [], multi: false }, ephemeral: { drags: {} } }));
    const dice: DiceView = { you: viewer, view, srd: { monsters: null, rolls: null } };
    const creature = input.creature ?? ({ characterId: "thorn" } as const);
    const body =
      input.body === "player"
        ? createElement(PlayerOptions, { view, selected: [] })
        : createElement(OptionsList, { dice, rolls: creatureRolls(dice, creature)!, creature, tokenId: input.creature?.tokenId ?? "tt", name: input.creature ? "Goblin" : "Thorn" });
    return unmarked(renderToStaticMarkup(
      createElement(RoomProvider, {
        store: store as never,
        actions: { dispatch: () => 1, newId: () => "x" } as never,
        ui: { notify() {} } as never,
        assets: { url: () => "" } as never,
        children: createElement(RoomScopeProvider, { scope, children: body }),
      }),
    ));
  }

  // A group's heading less its folded line, which describes it rather than naming it.
  const headings = (markup: string, tag: "h3" | "h4") => [...markup.matchAll(new RegExp(`<${tag}[^>]*>(.*?)</${tag}>`, "g"))].map((m) => m[1]!.replace(/<span id="[^"]*-summary".*?<\/span>/, "").replace(/<[^>]*>/g, "").trim());

  test("one creature: a region named for it wraps its card, whose header names it, and its groups in today's order, Initiative in the card", () => {
    const markup = draw({ state: room2({}, false), body: "player" });
    assert.match(markup, /<section[^>]*aria-label="Rolls for Thorn"/);
    assert.ok(!markup.includes('role="tablist"'), "one creature takes no tabs");
    assert.deepEqual(headings(markup, "h3"), ["Thorn", "Saves and checks", "Skills", "Actions", "Spells"], "the heading keys walk the creature, then its groups");
    const card = markup.slice(markup.indexOf("data-dice-card"), markup.indexOf("Saves and checks"));
    assert.match(card, /Level 5 character · <span style="white-space:nowrap">Medium \(5 ft\)<\/span>/);
    assert.match(card, /Initiative \+2/, "Initiative stands in the card");
  });

  test("a folded group draws its line and none of its controls, and an open one draws them", () => {
    const markup = draw({ state: room2({}, false), body: "player" });
    assert.doesNotMatch(markup, /DEX \+7/, "Saves and checks folded on a phone draws no cell");
    assert.match(markup, /aria-expanded="false"[^>]*>.*?Saves and checks.*?Str \+0, Dex \+7/, "its folded line says the saves");
    assert.match(markup, /Rapier/, "Actions starts open");
    assert.deepEqual(headings(markup, "h4"), ["Cantrips", "Level 1"], "Spells by level, each an h4");
  });

  test("two or more: tabs across the card, named by the creatures, the picked one the Tab stop, each controlling the region, and no heading repeats the name", () => {
    const markup = draw({ state: room2(), body: "player" });
    const region = /<section id="([^"]+)" aria-label="Rolls for Thorn"/.exec(markup);
    assert.ok(region, "the region carries the id its tabs control");
    assert.match(markup, /role="tablist" aria-label="Roll for"/);
    const tabs = [...markup.matchAll(/<button[^>]*role="tab"[^>]*>.*?<\/button>/g)].map((m) => m[0]);
    assert.equal(tabs.length, 2);
    assert.match(tabs[0]!, /aria-selected="true"/);
    assert.match(tabs[0]!, /tabindex="0"/);
    assert.match(tabs[1]!, /aria-selected="false"/);
    assert.match(tabs[1]!, /tabindex="-1"/);
    for (const tab of tabs) assert.match(tab, new RegExp(`aria-controls="${region[1]}"`));
    // The picture is decoration, its initials hidden, so each tab is named by the creature's name alone.
    assert.deepEqual(tabs.map((t) => t.replace(/<span aria-hidden="true".*?<\/span><\/span>/, "").replace(/<[^>]*>/g, "")), ["Thorn", "Wolf"]);
    assert.ok(!headings(markup, "h3").includes("Thorn"), "the tab names Thorn, so no heading says it again");
    assert.ok(markup.indexOf('role="tablist"') < markup.indexOf("Level 5 character"), "the kind line under the tabs");
  });

  test("while the options load, the card's header shows at once and no group draws", () => {
    const state = room2({}, false);
    // In a beast's shape Thorn's options wait for the SRD's chunks, which a server render never loads.
    state.characters.thorn!.actor.srdId = "wolf";
    const markup = draw({ state, body: "player" });
    assert.deepEqual(headings(markup, "h3"), ["Thorn"]);
    assert.match(markup, /Level 5 character in Wild Shape as Wolf|Level 5 character in the shape of Wolf/);
    assert.ok(!markup.includes("data-panel-group"), "no group yet");
  });

  test("an ask opens its folded group once, and folded again it stays folded, its line leading with the ask", () => {
    const request: RollRequest = { id: "q1", rev: 0, test: { kind: "save", choices: [{ ability: "dex" }] }, dcShown: false, resultShown: true, at: "2026-10-23T20:00:00.000Z", targets: [{ characterId: "thorn" }] };
    const scope = new RoomScope();
    const first = draw({ scope, state: room2({ q1: request }, false), body: "list" });
    assert.match(first, /DEX \+7[^<]*<\/span><span[^>]*>Asked/, "Saves and checks opened on the render that first saw the ask");
    // The viewer folds it, and the options draw again, as after a tab pick.
    scope.get(diceFoldsSlot).tap("pc.saves", false, false);
    const again = draw({ scope, state: room2({ q1: request }, false), body: "list" });
    assert.doesNotMatch(again, /DEX \+7/, "seen, so it stays folded");
    assert.match(again, /Asked: DEX save · Str \+0/, "its line leads with the ask still waiting");
  });

  test("an ask for a monster opens the monster's Saves and checks, never a character's", () => {
    const state = room2({}, false);
    state.tokens.gob = token("gob", { kind: "monster", name: "Goblin" });
    state.rolls = { q2: { id: "q2", rev: 0, test: { kind: "save", choices: [{ ability: "con" }] }, dcShown: false, resultShown: true, at: "2026-10-23T20:00:00.000Z", targets: [{ tokenId: "gob" }] } };
    const scope = new RoomScope();
    const markup = draw({ scope, viewer: DM, state, body: "list", creature: { tokenId: "gob" } });
    assert.match(markup, /Constitution save, answers the DM&#x27;s request/);
    const folds = scope.get(diceFoldsSlot).get({ width: 0, height: 0 });
    assert.equal(folds["monster.saves"], true);
    assert.equal(folds["pc.saves"], false, "a character's stay as they start");
  });

  test("a player's block opens the group of its row once, and a new opening of the same spell opens it again", () => {
    const scope = new RoomScope();
    const folds = scope.get(diceFoldsSlot);
    folds.tap("pc.spells", false, false);
    const options = scope.get(optionSlot);
    const spec = { key: "c:thorn", creature: { characterId: "thorn" }, spell: "Sacred Flame", roll: "sf" };
    options.setState(openedBlock(options.getState(), spec));
    options.getInitialState = options.getState;
    assert.match(draw({ scope, state: room2({}, false), body: "list" }), /aria-label="Ask for saves: Sacred Flame"/, "Spells opened, and the block draws under its row");
    folds.tap("pc.spells", false, false);
    const folded = draw({ scope, state: room2({}, false), body: "list" });
    assert.doesNotMatch(folded, /aria-label="Ask for saves: Sacred Flame"/, "the same opening opens it no more");
    assert.match(folded, /Ask for saves waiting: Sacred Flame · DC \d+ · \+\d+ to hit · 2 spells/, "its folded line leads with the block waiting");
    options.setState(openedBlock(options.getState(), spec));
    options.getInitialState = options.getState;
    assert.match(draw({ scope, state: room2({}, false), body: "list" }), /aria-label="Ask for saves: Sacred Flame"/, "reopened, it opens again");
  });
});

describe("whether the options end on a group, which Recent rolls joins (docs/design-v1-dice-pass.md 6.1)", () => {
  /** What the hook says for this viewer and selection, read from the data alone, as the panel reads it on any page it starts on. */
  function ends(viewer: Viewer, selectedIds: string[], edit?: (state: RoomState) => void): boolean {
    const state = table();
    state.tokens.gob = token("gob", { kind: "monster", name: "Goblin" });
    state.tokens.gob2 = token("gob2", { kind: "monster", name: "Goblin" });
    edit?.(state);
    const view = projectState(state, viewer, { sceneId: "s1" }) as unknown as RoomState;
    const store = createStore(() => ({ view, roomId: "r1", connection: "open", you: viewer, sceneId: "s1", local: { selectedIds, multi: false }, ephemeral: { drags: {} } }));
    const Probe = () => createElement("i", null, String(useOptionsEndOnGroup()));
    const markup = renderToStaticMarkup(
      createElement(RoomProvider, {
        store: store as never,
        actions: { dispatch: () => 1, newId: () => "x" } as never,
        ui: { notify() {} } as never,
        assets: { url: () => "" } as never,
        children: createElement(RoomScopeProvider, { scope: new RoomScope(), children: createElement(Probe) }),
      }),
    );
    return markup === "<i>true</i>";
  }

  test("the DM with nobody selected ends on the card", () => {
    assert.equal(ends(DM, []), false);
  });

  test("several selected always end on their groups", () => {
    assert.equal(ends(DM, ["gob", "gob2"]), true);
  });

  test("one creature ends on its groups once its options have loaded, and on its card while they load", () => {
    assert.equal(ends(DM, ["gob"]), true);
    assert.equal(ends(DM, ["tt"]), true, "Thorn's token, by his stat block");
    // A block from the SRD waits for its chunk, which a server render never loads.
    assert.equal(ends(DM, ["gob"], (s) => (s.tokens.gob!.actor = { inline: { ...actor(), srdId: "goblin-warrior" } })), false);
    assert.equal(ends(DM, ["missing"]), false, "a selected token gone from the view");
  });

  test("a player ends on their creature's groups, and on the card with no creature to pick", () => {
    assert.equal(ends(P1, []), true);
    assert.equal(ends(P1, [], (s) => {
      s.characters.thorn!.ownerIds = [];
      s.tokens.tt!.ownerIds = [];
    }), false);
  });
});

/*
 * Used and X/Day are room state (docs/design-v1-combat-controls.md 6): a
 * row reads them from the creature's actor, so every device and a reload
 * show the same, and an X/Day row counts what is left with its Use.
 */
describe("a row's recharge and X/Day uses, read from the room", () => {
  const LURKER = customMonster("lurker", {
    actions: [
      { name: "Fire Breath (Recharge 5–6)", text: "Dexterity Saving Throw: DC 13, each creature in a 15-foot Cone. Failure: 24 (7d6) Fire damage. Success: Half damage." },
      { name: "Dominate Mind (2/Day)", text: "Wisdom Saving Throw: DC 15, one creature it can see within 30 feet. Failure: The target has the Charmed condition." },
    ],
  });

  function draw(viewer: Viewer, uses?: Record<string, UseMark>): string {
    const state = room({
      monsters: { lurker: LURKER },
      tokens: { lurk: token("lurk", { kind: "monster", name: "Lurker", actor: { inline: actor({ monsterId: "lurker", ...(uses ? { uses } : {}) }) } }) },
    });
    const view = projectState(state, viewer, { sceneId: "s1" }) as unknown as RoomState;
    const store = createStore(() => ({ view, roomId: "r1", connection: "open", you: viewer, sceneId: "s1", local: { selectedIds: ["lurk"], multi: false }, ephemeral: { drags: {} } }));
    const dice: DiceView = { you: viewer, view, srd: { monsters: null, rolls: null } };
    const creature = { tokenId: "lurk" } as const;
    return renderToStaticMarkup(
      createElement(RoomProvider, {
        store: store as never,
        actions: { dispatch: () => 1, newId: () => "x" } as never,
        ui: { notify() {} } as never,
        assets: { url: () => "" } as never,
        children: createElement(RoomScopeProvider, { scope: new RoomScope(), children: createElement(OptionsList, { dice, rolls: creatureRolls(dice, creature)!, creature, tokenId: "lurk", name: "Lurker" }) }),
      }),
    );
  }
  const chip = (markup: string, label: string) => new RegExp(`<button[^>]*aria-label="${label}"[^>]*>`).exec(markup)?.[0] ?? null;

  test("Used is pressed only while the room holds the breath's mark", () => {
    assert.match(chip(draw(DM), "Mark Fire Breath used") ?? "", /aria-pressed="false"/);
    const used = draw(DM, { "actions:fire-breath": { kind: "recharge", name: "Fire Breath", used: 1, max: 1, min: 5 } });
    assert.match(chip(used, "Fire Breath is used. Tap when it recharges") ?? "", /aria-pressed="true"/);
  });

  test("an X/Day row counts what is left with its Use, which is off with its reason at 0", () => {
    const fresh = draw(DM);
    assert.match(fresh, /2\/Day, 2 left/);
    assert.ok(chip(fresh, "Use Dominate Mind, 2 of 2 left"));
    const one = draw(DM, { "actions:dominate-mind": { kind: "day", name: "Dominate Mind", used: 1, max: 2 } });
    assert.match(one, /2\/Day, 1 left/);
    assert.doesNotMatch(chip(one, "Use Dominate Mind, 1 of 2 left") ?? "missing", /aria-disabled/);
    const none = draw(DM, { "actions:dominate-mind": { kind: "day", name: "Dominate Mind", used: 2, max: 2 } });
    assert.match(none, /2\/Day, 0 left/);
    const off = chip(none, "Use Dominate Mind, 0 of 2 left") ?? "";
    assert.match(off, /aria-disabled="true"/);
    const reason = /aria-describedby="([^"]+)"/.exec(off)?.[1];
    assert.ok(reason && new RegExp(`id="${reason}"[^>]*>No uses left<`).test(none), "the off Use says why");
  });

  test("the breath's mark is not the X/Day ability's, and a mark of another kind under a key counts for neither", () => {
    const markup = draw(DM, { "actions:fire-breath": { kind: "day", name: "Fire Breath", used: 1, max: 1 } });
    assert.match(chip(markup, "Mark Fire Breath used") ?? "", /aria-pressed="false"/);
    assert.match(markup, /2\/Day, 2 left/);
  });
});

/*
 * The Dice panel's death save row waits while this device shows the
 * creature's Regeneration open, as every death save Roll does
 * (docs/design-v1-combat-controls.md 2.3 and 4.4).
 */
describe("the death save row while Regeneration is open", () => {
  const TROLL = customMonster("troll", {
    name: "Troll",
    traits: [{ name: "Regeneration", text: "The troll regains 15 Hit Points at the start of each of its turns. If the troll takes Acid or Fire damage, this trait doesn't function at the start of the troll's next turn." }],
  });

  function draw(settled: boolean): string {
    const record = { id: 7, entryId: "e1", round: 2, hp: 0, life: "dying" as const, ...(settled ? { settled: { regeneration: { state: "done" as const, total: 15 } } } : {}) };
    const state = room({
      monsters: { troll: TROLL },
      tokens: { tr: token("tr", { kind: "monster", name: "Troll", actor: { inline: actor({ monsterId: "troll", hp: { cur: 0, max: 84, temp: 0 }, life: "dying", turnRecord: record }) } }) },
      encounter: { rev: 0, round: 2, activeEntryId: "e1", entries: [entry("e1", { tokenId: "tr" })] },
    });
    const view = projectState(state, DM, { sceneId: "s1" }) as unknown as RoomState;
    const store = createStore(() => ({ view, roomId: "r1", connection: "open", you: DM, sceneId: "s1", local: { selectedIds: ["tr"], multi: false }, ephemeral: { drags: {} } }));
    const dice: DiceView = { you: DM, view, srd: { monsters: null, rolls: null } };
    const creature = { tokenId: "tr" } as const;
    return renderToStaticMarkup(
      createElement(RoomProvider, {
        store: store as never,
        actions: { dispatch: () => 1, newId: () => "x" } as never,
        ui: { notify() {} } as never,
        assets: { url: () => "" } as never,
        children: createElement(RoomScopeProvider, { scope: new RoomScope(), children: createElement(OptionsList, { dice, rolls: creatureRolls(dice, creature)!, creature, tokenId: "tr", name: "Troll" }) }),
      }),
    );
  }
  const deathSave = (markup: string) => /<button[^>]*aria-label="Death Save[^"]*"[^>]*>/.exec(markup)?.[0] ?? "";

  test("off with its reason while Regeneration is open, and on once it is settled", () => {
    const waiting = deathSave(draw(false));
    assert.match(waiting, /disabled=""/);
    assert.match(waiting, /title="Waiting for Regeneration"/);
    const settled = deathSave(draw(true));
    assert.ok(settled, "the row draws while the troll is dying");
    assert.doesNotMatch(settled, /disabled=""/);
  });
});
