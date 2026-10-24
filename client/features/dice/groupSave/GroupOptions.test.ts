import "../../../components/testing/register.ts";
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { createStore } from "zustand/vanilla";
import type { LogEntry, PcStats, RoomState } from "#shared/model.ts";
import { projectState } from "#shared/project.ts";
import { actor, character, DM, room, token } from "#shared/testutil.ts";
import { theme } from "../../../lib/theme.ts";
import type { DiceView } from "../creature.ts";
import { diceFoldsSlot, severalKey } from "../diceFolds.ts";
import { receiptsSlot } from "../useReceipt.ts";

/*
 * Several selected creatures in the dice pass (docs/design-v1-dice-pass.md
 * 5.3): the card with their pictures and names, the groups under it, the
 * cells that say once what their label says, and a shared attack's state
 * kept in a slot by the attack's name, so a fold that unmounts its row, or
 * a selection that changes while the attack stays shared, keeps the hits.
 */

const { createElement } = await import("react");
const { renderToStaticMarkup } = await import("react-dom/server");
const { RoomProvider } = await import("../../../state/view.ts");
const { RoomScope, RoomScopeProvider } = await import("../../../state/scope.ts");
const { attackSummary, GroupOptions, keepShared, NO_ATTACK, patchShared, sharedAttacksOf, sharedAttacksSlot, unsentAc, watchSelection } = await import("./GroupOptions.tsx");

const STATS: PcStats = {
  abilities: { str: 10, dex: 18, con: 12, int: 10, wis: 12, cha: 10 },
  saves: ["dex"],
  skills: {},
  adjust: {},
  defenses: {},
  rolls: [
    { id: "r1", name: "Rapier", kind: "weapon", ability: "dex", attack: { prof: true, bonus: 0 }, dice: [{ formula: "1d8", mod: true, type: "piercing" }] },
    { id: "r2", name: "Dagger", kind: "weapon", ability: "dex", attack: { prof: true, bonus: 0 }, dice: [{ formula: "1d4", mod: true, type: "piercing" }] },
  ],
};

/** Three characters with a Rapier each, on tokens ta, tb and tc. */
function table(): RoomState {
  const state = room();
  for (const [id, name, owner] of [["a", "Thorn", "p1"], ["b", "Bree", "p2"], ["c", "Vex", "p1"]] as const) {
    state.characters[id] = { ...character(id, { name, ownerIds: [owner], level: 5 }), stats: STATS };
    state.tokens[`t${id}`] = token(`t${id}`, { kind: "pc", name, ownerIds: [owner], actor: { ref: id } });
  }
  return state;
}

const TAG = "tag-rapier";

/** The DM's view, the Rapier's two attacks landed against AC 12 at 15 and 20 (by default), and a scope to render in. */
function setup(faces: readonly [number, number] = [8, 13]) {
  const view = projectState(table(), DM, { sceneId: "s1" }) as unknown as RoomState;
  const dice: DiceView = { you: DM, view, srd: { monsters: null, rolls: null } };
  const shared = sharedAttacksOf(dice, [{ tokenId: "ta" }, { tokenId: "tb" }]);
  const log: LogEntry[] = [
    {
      id: "7:0",
      at: "2026-10-23T20:00:00.000Z",
      kind: "event",
      data: {
        type: "dice",
        tag: TAG,
        by: "dm1",
        to: "all",
        ac: 12,
        rolls: [
          { formula: "1d20+7", faces: [faces[0]], total: faces[0] + 7, label: "Rapier", tokenId: "ta" },
          { formula: "1d20+7", faces: [faces[1]], total: faces[1] + 7, label: "Rapier", tokenId: "tb" },
        ],
      },
    },
  ];
  const scope = new RoomScope();
  const tracker = scope.get(receiptsSlot);
  tracker.env = { lookup: async () => ({ parts: [] }), log: () => log };
  tracker.sending(TAG, 0);
  tracker.answer(TAG, 0, "taken");
  return { view: { ...view, log }, dice, shared, scope };
}

function render(s: ReturnType<typeof setup>, tokenIds: readonly string[]): string {
  const store = createStore(() => ({ view: s.view, roomId: "r1", connection: "open", you: DM, sceneId: "s1", local: { selectedIds: tokenIds, multi: false } }));
  return renderToStaticMarkup(
    createElement(RoomProvider, {
      store: store as never,
      actions: { dispatch: () => 1 } as never,
      ui: {} as never,
      assets: { url: () => "" } as never,
      children: createElement(RoomScopeProvider, { scope: s.scope, children: createElement(GroupOptions, { tokenIds }) }),
    }),
  );
}

/** The Rapier sent at Thorn and Bree against AC 12, as its tap leaves the slot. */
function sentAttack(s: ReturnType<typeof setup>): void {
  const rapier = s.shared.find((a) => a.name === "Rapier");
  assert.ok(rapier, "the two share the Rapier");
  const slot = s.scope.get(sharedAttacksSlot).store;
  slot.setState({ byName: { Rapier: { ac: 12, acSent: 12, sent: { tag: TAG, each: rapier.each, ac: 12 }, damageTag: null } } });
  // A server render reads a zustand store's first state.
  slot.getInitialState = slot.getState;
}

/** Each button's words, by its name. */
function cells(markup: string): Map<string, string> {
  return new Map([...markup.matchAll(/<button[^>]*aria-label="([^"]+)"[^>]*>(.*?)<\/button>/g)].map((m) => [m[1]!, m[2]!.replace(/<[^>]*>/g, "")]));
}

describe("several selected: the card and the groups (5.3)", () => {
  test("the card: their pictures, the count as its heading and their names as its line, then the DC and Set up a group save", () => {
    const markup = render(setup(), ["ta", "tb", "tc"]);
    assert.match(markup, /^<section aria-label="Group rolls"/, "the region the e2e suites find");
    assert.match(markup, /<div data-dice-card=""/);
    assert.match(markup, /<h3[^>]*>3 selected<\/h3>/);
    assert.match(markup, /<p data-kind-line=""[^>]*>Thorn, Bree, Vex<\/p>/);
    assert.equal([...markup.matchAll(/width:32px;height:32px/g)].length, 3, "three pictures at the several size");
    const card = markup.slice(markup.indexOf("data-dice-card"), markup.indexOf("data-panel-group"));
    assert.match(card, /aria-label="DC for the group"/);
    // Spanning the card, its words in the middle, so the card's rows keep one left edge.
    assert.match(card, /<button type="button" aria-label="Set up a group save"[^>]*style="display:flex;align-items:center;justify-content:center;/);
    assert.match(markup, /<button type="button" aria-label="DEX save for 3"[^>]*style="display:flex;align-items:center;justify-content:flex-start;/, "the groups' cells keep their words at the start");
  });

  test("under the card, the groups in order: Saves and checks, Skills, Shared attacks", () => {
    const markup = render(setup(), ["ta", "tb"]);
    const groups = [...markup.matchAll(/<span id="[^"]+" style="[^"]*">(Saves and checks|Skills|Shared attacks)<\/span>/g)].map((m) => m[1]);
    assert.deepEqual(groups, ["Saves and checks", "Skills", "Shared attacks"]);
    assert.ok(markup.indexOf("data-dice-card") < markup.indexOf("data-panel-group"));
  });

  test("a save's cell says DEX under the label Saves for 2, and keeps the whole name, DEX save for 2", () => {
    const markup = render(setup(), ["ta", "tb"]);
    const named = cells(markup);
    for (const a of ["STR", "DEX", "CON", "INT", "WIS", "CHA"]) {
      assert.equal(named.get(`${a} save for 2`), a);
      assert.equal(named.get(`${a} check for 2`), a);
    }
    const label = /<h4 id="([^"]+)" style="([^"]*)">Saves for 2<\/h4>/.exec(markup);
    assert.ok(label, "the saves' label, an h4 under the group's h3");
    assert.match(label[2]!, new RegExp(`font-size:${theme.font.small}px;font-weight:${theme.weight.bold}`));
    assert.match(label[2]!, /text-transform:uppercase/);
    assert.match(markup, new RegExp(`<div role="group" aria-labelledby="${label[1]}"`), "the grid named by its label");
    assert.match(markup, /<h4[^>]*>Checks for 2<\/h4>/);
  });

  test("the cells take a creature's option look: the control outline on the raised fill, a touch target tall", () => {
    const tag = /<button type="button" aria-label="DEX save for 2"[^>]*style="([^"]*)"/.exec(render(setup(), ["ta", "tb"]));
    assert.ok(tag);
    assert.ok(tag[1]!.includes(`border:1px solid ${theme.color.controlBorder}`));
    assert.ok(tag[1]!.includes(`background:${theme.color.surfaceRaised}`));
    assert.match(tag[1]!, new RegExp(`min-height:${theme.touch}px`));
  });

  test("Skills starts folded, so its cells are not drawn, and open its cells keep their names for 2", () => {
    const s = setup();
    assert.doesNotMatch(render(s, ["ta", "tb"]), /Athletics/);
    s.scope.get(diceFoldsSlot).tap(severalKey("skills"), true, false);
    const named = cells(render(s, ["ta", "tb"]));
    assert.equal(named.get("Athletics for 2"), "Athletics");
    assert.equal(named.get("Sleight of Hand for 2"), "Sleight of Hand");
  });

  test("folded, Saves and checks says its DC, or that there is none, and draws no cells", () => {
    const s = setup();
    s.scope.get(diceFoldsSlot).tap(severalKey("saves"), false, false);
    const markup = render(s, ["ta", "tb"]);
    assert.doesNotMatch(markup, /DEX save for 2/);
    assert.match(markup, />No DC<\/span>/);
  });

  test("a group with nothing in it is not drawn: two with no attack in common show no Shared attacks", () => {
    const s = setup();
    s.view.characters.b = { ...s.view.characters.b!, stats: { ...STATS, rolls: [] } };
    assert.doesNotMatch(render(s, ["ta", "tb"]), /Shared attacks/);
  });
});

describe("a shared attack's slot, by the attack's name (5.3)", () => {
  test("its hits and Roll damage come from the slot, so they draw on any render of the view", () => {
    const s = setup();
    sentAttack(s);
    const markup = render(s, ["ta", "tb"]);
    assert.match(markup, /15 hit, 20 hit/);
    assert.equal(cells(markup).get("Roll damage for 2 hits"), "Roll damage for 2 hits");
  });

  test("each attack reads its own name's state: the Dagger, never sent, shows no hits beside the Rapier's", () => {
    const s = setup();
    sentAttack(s);
    const markup = render(s, ["ta", "tb"]);
    assert.ok(cells(markup).has("Dagger for 2"), "both attacks are shared");
    assert.equal([...markup.matchAll(/15 hit, 20 hit/g)].length, 1);
    assert.equal([...markup.matchAll(/aria-label="Roll damage for 2 hits"/g)].length, 1);
    // Each row from its attack's button to the next row's line.
    const row = (name: string) => {
      const at = markup.indexOf(`aria-label="${name} for 2"`);
      const next = markup.indexOf("border-top:1px", at);
      return markup.slice(at, next < 0 ? undefined : next);
    };
    assert.match(row("Rapier"), /Roll damage for 2 hits/);
    assert.doesNotMatch(row("Dagger"), /Roll damage|hit/);
  });

  test("folded, the row unmounts and the group says the hits waiting, and reopened the hits and Roll damage are still there", () => {
    const s = setup();
    sentAttack(s);
    const folds = s.scope.get(diceFoldsSlot);
    folds.tap(severalKey("sharedAttacks"), false, false);
    const folded = render(s, ["ta", "tb"]);
    assert.doesNotMatch(folded, /Roll damage/);
    assert.doesNotMatch(folded, /Rapier for 2/);
    assert.match(folded, />(Dagger, Rapier: 2 hits|Rapier: 2 hits, Dagger)<\/span>/, "the folded line names the hits that wait for their damage");
    folds.tap(severalKey("sharedAttacks"), true, false);
    const open = render(s, ["ta", "tb"]);
    assert.match(open, /15 hit, 20 hit/);
    assert.equal(cells(open).get("Roll damage for 2 hits"), "Roll damage for 2 hits");
  });

  test("a selection that changes while the attack stays shared keeps its sent snapshot: the button counts three, the hits stay the two sent", () => {
    const s = setup();
    sentAttack(s);
    const markup = render(s, ["ta", "tb", "tc"]);
    const named = cells(markup);
    assert.equal(named.get("Rapier for 3"), "Rapier for 3");
    assert.match(markup, /15 hit, 20 hit/);
    assert.equal(named.get("Roll damage for 2 hits"), "Roll damage for 2 hits");
  });

  test("a selection that drops one sent and adds one not sent keeps the two sent, whose hits they are", () => {
    const s = setup();
    sentAttack(s);
    const markup = render(s, ["ta", "tc"]);
    assert.equal(cells(markup).get("Rapier for 2"), "Rapier for 2");
    assert.match(markup, /15 hit, 20 hit/);
    assert.equal(cells(markup).get("Roll damage for 2 hits"), "Roll damage for 2 hits");
  });

  test("a critical counts among the hits and a natural 1 misses, so one hit waits for its damage", () => {
    const s = setup([20, 1]);
    sentAttack(s);
    const markup = render(s, ["ta", "tb"]);
    assert.match(markup, /27 Critical Hit, 8 miss/);
    assert.equal(cells(markup).get("Roll damage for 1 hit"), "Roll damage for 1 hit");
    const state = s.scope.get(sharedAttacksSlot).store.getState().byName.Rapier!;
    assert.equal(attackSummary("Rapier", state, (tag) => s.scope.get(receiptsSlot).state(tag)), "Rapier: 1 hit");
  });

  /** The DM's room store over `state`, its selection as given, and the watch on it, the SRD never loaded. */
  function watched(state: RoomState, selectedIds: string[]) {
    const view = projectState(state, DM, { sceneId: "s1" }) as unknown as RoomState;
    const attacks = createStore(() => patchShared({ byName: {} }, "Rapier", { ac: 12 }));
    const room = createStore(() => ({ view, you: DM, local: { selectedIds } }));
    const stop = watchSelection(attacks, room as never, () => ({ monsters: null, rolls: null }));
    return { attacks, room, stop };
  }

  test("fewer than two selected clears every attack's state, drawn or not, and a selection of two or more keeps it", () => {
    const { attacks, room, stop } = watched(table(), ["ta", "tb"]);
    room.setState({ local: { selectedIds: ["ta", "tb", "tc"] } });
    assert.ok(attacks.getState().byName.Rapier, "three selected keep it");
    room.setState({ local: { selectedIds: ["ta", "tb"] } });
    assert.ok(attacks.getState().byName.Rapier, "two selected keep it");
    room.setState({ local: { selectedIds: ["ta"] } });
    assert.deepEqual(attacks.getState().byName, {}, "one selected clears it");
    attacks.setState(patchShared({ byName: {} }, "Rapier", { ac: 15 }));
    room.setState({ local: { selectedIds: [] } });
    assert.deepEqual(attacks.getState().byName, {}, "none selected clears it");
    stop();
    attacks.setState(patchShared({ byName: {} }, "Rapier", { ac: 15 }));
    room.setState({ local: { selectedIds: ["ta"] } });
    assert.ok(attacks.getState().byName.Rapier, "the watch ended");
  });

  test("a selection that stops sharing the attack drops its state, even while the view of several is away, and one sharing it all along keeps it", () => {
    // Dara and Eli carry a club, not a rapier. Fen carries a rapier and a dagger, Gil a rapier alone.
    const state = table();
    const CLUB: PcStats = { ...STATS, rolls: [{ id: "c1", name: "Club", kind: "weapon", ability: "str", attack: { prof: true, bonus: 0 }, dice: [{ formula: "1d4", mod: true, type: "bludgeoning" }] }] };
    const RAPIER: PcStats = { ...STATS, rolls: STATS.rolls.filter((r) => r.name === "Rapier") };
    for (const [id, name, stats] of [["d", "Dara", CLUB], ["e", "Eli", CLUB], ["f", "Fen", STATS], ["g", "Gil", RAPIER]] as const) {
      state.characters[id] = { ...character(id, { name, ownerIds: ["p1"], level: 5 }), stats };
      state.tokens[`t${id}`] = token(`t${id}`, { kind: "pc", name, ownerIds: ["p1"], actor: { ref: id } });
    }
    const through = watched(state, ["ta", "tb"]);
    through.room.setState({ local: { selectedIds: ["td", "te"] } });
    assert.deepEqual(through.attacks.getState().byName, {}, "Dara and Eli share no rapier");
    through.room.setState({ local: { selectedIds: ["tc", "tf"] } });
    assert.deepEqual(through.attacks.getState().byName, {}, "Vex and Fen's rapier starts afresh");
    through.stop();

    const along = watched(state, ["ta", "tb"]);
    along.room.setState({ local: { selectedIds: ["tc", "tf"] } });
    assert.ok(along.attacks.getState().byName.Rapier, "Vex and Fen share the rapier, so its state stays");
    along.stop();

    // A goblin's block waits for the SRD, so it alone says nothing of sharing yet, but a loaded block that lacks the attack drops it.
    state.tokens.gob = token("gob", { actor: { inline: { ...actor(), srdId: "goblin-warrior" } } });
    const waiting = watched(state, ["ta", "tb"]);
    waiting.room.setState({ local: { selectedIds: ["ta", "gob"] } });
    assert.ok(waiting.attacks.getState().byName.Rapier, "kept until the view of several reads the goblin's block");
    waiting.room.setState({ local: { selectedIds: ["td", "gob"] } });
    assert.deepEqual(waiting.attacks.getState().byName, {}, "Dara's loaded block has no rapier, whatever the goblin's holds");
    waiting.stop();

    // Two attacks kept: the one a loaded block lacks goes, and the one the loaded blocks hold waits on the goblin.
    const both = watched(state, ["ta", "tb"]);
    both.attacks.setState((a) => patchShared(a, "Dagger", { ac: 13 }));
    both.room.setState({ local: { selectedIds: ["ta", "gob", "tf"] } });
    assert.deepEqual(Object.keys(both.attacks.getState().byName), ["Rapier", "Dagger"], "Thorn and Fen hold both, and the goblin's block has yet to load");
    const rapierOnly = watched(state, ["ta", "tb"]);
    rapierOnly.attacks.setState((a) => patchShared(a, "Dagger", { ac: 13 }));
    rapierOnly.room.setState({ local: { selectedIds: ["ta", "gob", "tg"] } });
    assert.deepEqual(Object.keys(rapierOnly.attacks.getState().byName), ["Rapier"], "Gil has no dagger, so it goes while the rapier waits on the goblin");
    both.stop();
    rapierOnly.stop();
  });

  test("the slot's watch ends with its Room, and a Room used again after that watches anew", () => {
    let stopped = 0;
    const slot = sharedAttacksSlot.create();
    slot.stop = () => stopped++;
    sharedAttacksSlot.dispose?.(slot);
    assert.equal(stopped, 1);
    assert.equal(slot.stop, null);
  });

  test("an attack no longer shared drops its state, the others keep theirs, and with none to drop the state is the same object", () => {
    const one = patchShared({ byName: {} }, "Rapier", { ac: 12 });
    const two = patchShared(one, "Shortbow", { ac: 15 });
    assert.deepEqual(two.byName.Rapier, { ...NO_ATTACK, ac: 12 });
    assert.deepEqual(Object.keys(keepShared(two, ["Shortbow"]).byName), ["Shortbow"]);
    assert.deepEqual(keepShared(two, ["Shortbow"]).byName.Shortbow, two.byName.Shortbow);
    assert.equal(keepShared(two, ["Rapier", "Shortbow", "Dagger"]), two, "nothing to drop");
    assert.deepEqual(keepShared(two, []).byName, {});
  });

  test("one attack's change leaves the others as they were, and keeps its own other parts", () => {
    const s = patchShared(patchShared({ byName: {} }, "Rapier", { ac: 12, damageTag: "d1" }), "Shortbow", { ac: 15 });
    const next = patchShared(s, "Rapier", { ac: 14 });
    assert.equal(next.byName.Shortbow, s.byName.Shortbow);
    assert.deepEqual(next.byName.Rapier, { ...NO_ATTACK, ac: 14, damageTag: "d1" });
  });

  test("an AC typed since the last attack is unsaved until an attack sends it", () => {
    assert.equal(unsentAc(undefined), false);
    assert.equal(unsentAc(NO_ATTACK), false);
    assert.equal(unsentAc({ ...NO_ATTACK, ac: 12 }), true);
    assert.equal(unsentAc({ ...NO_ATTACK, ac: 12, acSent: 12 }), false);
    assert.equal(unsentAc({ ...NO_ATTACK, ac: null, acSent: 12 }), true, "a cleared AC is a change too");
  });

  test("the folded line: the name alone before an attack, after its damage, or with no hits, and the hits while they wait", () => {
    const s = setup();
    sentAttack(s);
    const state = s.scope.get(sharedAttacksSlot).store.getState().byName.Rapier!;
    const tracker = s.scope.get(receiptsSlot);
    const receipt = (tag: string) => tracker.state(tag);
    assert.equal(attackSummary("Rapier", undefined, receipt), "Rapier");
    assert.equal(attackSummary("Rapier", state, receipt), "Rapier: 2 hits");
    assert.equal(attackSummary("Rapier", { ...state, damageTag: "d1" }, receipt), "Rapier", "the damage rolled, nothing waits");
    assert.equal(attackSummary("Rapier", { ...state, sent: { ...state.sent!, ac: 16 } }, receipt), "Rapier: 1 hit", "judged by the AC it was sent with");
    assert.equal(attackSummary("Rapier", { ...state, sent: { ...state.sent!, ac: 25 } }, receipt), "Rapier");
    assert.equal(attackSummary("Rapier", { ...state, sent: { ...state.sent!, ac: null }, ac: 16 }, receipt), "Rapier: 1 hit", "with none sent, by the AC typed");
    assert.equal(attackSummary("Rapier", { ...state, sent: { ...state.sent!, tag: "not-yet" } }, () => ({ state: "sending" })), "Rapier", "no answer yet");
  });
});
