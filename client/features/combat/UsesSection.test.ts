import "../../components/testing/register.ts";
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { createStore } from "zustand/vanilla";
import { LIMITS } from "#shared/limits.ts";
import type { DayUse, LegendaryUse, LimitedUse, RechargeUse } from "#shared/dice/uses.ts";
import type { Actor, Character, ClassResource, RoomState, Viewer } from "#shared/model.ts";
import { projectState } from "#shared/project.ts";
import { DM, P1, actor, character, room, token } from "#shared/testutil.ts";

const { createElement } = await import("react");
const { renderToStaticMarkup } = await import("react-dom/server");
const { UsesSection, NOTHING_TO_LIST } = await import("./UsesSection.tsx");
const { CombatUses } = await import("./CombatUses.tsx");
const { RoomProvider } = await import("../../state/view.ts");
const { RoomScope, RoomScopeProvider } = await import("../../state/scope.ts");

/*
 * Combat's Uses section as it draws (docs/design-v1-token-sections.md 3.1),
 * moved from the Class resources section's test: what it is for while a
 * character has nothing in it, its rows with Restore and Edit, Add after
 * them or the limit in its place, and the question a rise in level asks
 * once per class. Then a monster's list, its counts as pips on its rows,
 * and nothing at all for a creature with no use.
 */

const rage: ClassResource = { id: "rage", name: "Rage", max: 3, used: 1, reset: "shortOne", preset: "barbarian-rage", level: 5, atLevel: 5 };
const hands: ClassResource = { id: "hands", name: "Lay on Hands", max: 25, used: 0, reset: "long", pool: true, preset: "paladin-lay-on-hands", level: 5, atLevel: 5 };

function render(state: RoomState, viewer: Viewer, element: ReturnType<typeof createElement>): string {
  const view = projectState(state, viewer, { sceneId: "s1" });
  const store = createStore(() => ({ view, you: { memberId: viewer.memberId, role: viewer.role }, roomId: "r1", connection: "open", pending: [], local: { selectedIds: [], multi: false } }));
  return renderToStaticMarkup(
    createElement(RoomProvider, {
      store: store as never,
      actions: { dispatch: () => 1, newId: () => "x" } as never,
      ui: {} as never,
      assets: { url: () => "" } as never,
      children: createElement(RoomScopeProvider, { scope: new RoomScope(), children: element }),
    }),
  );
}

/** Pat's Uses on his character's page, as Pat sees it. */
const section = (over: Partial<Character>) => {
  const pat = character("pat", { name: "Pat", ...over });
  return render(room({ characters: { pat } }), P1, createElement(UsesSection, { target: { characterId: "pat" }, name: "Pat", character: pat }));
};

/** Each button's tag, from `<button` to its closing `>`, in order. */
const buttons = (markup: string) => [...markup.matchAll(/<button[^>]*>/g)].map((m) => m[0]);
const named = (markup: string, name: string) => buttons(markup).find((b) => b.includes(`aria-label="${name}"`));

describe("Combat's Uses for a character", () => {
  test("with none: what it is for, and Add, under the Uses heading", () => {
    const markup = section({});
    assert.match(markup, />Uses<\/h/);
    assert.doesNotMatch(markup, /Class resources/, "no Class resources heading");
    assert.ok(markup.includes(`>${NOTHING_TO_LIST.replace("&", "&amp;")}<`));
    assert.match(markup, />Add a class resource<\/button>/);
    assert.doesNotMatch(markup, /data-combat-uses/, "no empty list box to take a gap");
  });

  test("its rows with Restore and Edit on their button line, then Add", () => {
    const markup = section({ resources: [rage, hands], level: 5 });
    assert.ok(named(markup, "Restore one use of Rage"));
    assert.match(markup, /aria-label="Edit Rage"/);
    assert.match(markup, /aria-label="Edit Lay on Hands"/);
    // Edit stands with Use and Restore on one line: no element closes between Restore and Edit but Restore's own.
    const rageLine = markup.slice(markup.indexOf('aria-label="Restore one use of Rage"'), markup.indexOf('aria-label="Edit Rage"'));
    assert.equal([...rageLine.matchAll(/<\/div>/g)].length, 0, rageLine);
    assert.ok(markup.indexOf("Edit Lay on Hands") < markup.indexOf("Add a class resource"), "Add after the rows");
    assert.doesNotMatch(markup, /Your level went up/, "the level has not risen");
    assert.ok(!markup.includes(NOTHING_TO_LIST.slice(0, 20)), "no help line beside rows");
  });

  test("a level past what a class was read at asks to update that class, once", () => {
    const persistent: ClassResource = { id: "p", name: "Persistent Rage", max: 1, used: 0, reset: "long", preset: "barbarian-persistent-rage", level: 15, atLevel: 5 };
    const markup = section({ resources: [rage, persistent, hands], level: 6 });
    assert.equal([...markup.matchAll(/Your level went up\. Update Barbarian resources\?/g)].length, 1);
    assert.equal([...markup.matchAll(/Your level went up\. Update Paladin resources\?/g)].length, 1);
    assert.equal([...markup.matchAll(/>Update<\/button>/g)].length, 2);
    assert.ok(markup.indexOf("Your level went up") < markup.indexOf("Edit Rage"), "the question comes first");
  });

  test("its rows are a list named for its uses, or for its class resources beside a block's uses (LP22-SECT-4)", () => {
    assert.match(section({ resources: [rage] }), /<ul aria-label="Pat&#x27;s uses"/);
    const mixed = section({ resources: [rage], actor: actor({ legendary: { actionsMax: 3, actionsUsed: 0, resistMax: 0, resistUsed: 0 } }) });
    assert.match(mixed, /<ul aria-label="Pat&#x27;s uses"/, "the block's list");
    assert.match(mixed, /<ul aria-label="Pat&#x27;s class resources"/, "the class resources apart from it");
  });

  test("a full list says so in place of Add", () => {
    const many: ClassResource[] = Array.from({ length: LIMITS.resourcesPerCharacter }, (_, i) => ({ id: `o${i}`, name: `Own ${i}`, max: 1, used: 0, reset: "long" }));
    const markup = section({ resources: many });
    assert.doesNotMatch(markup, /Add a class resource/);
    assert.match(markup, />A character holds at most 12 class resources. Remove one to add another.</);
    assert.ok(section({ resources: many.slice(1) }).includes("Add a class resource"), "one short of the limit");
  });
});

describe("Combat's Uses for a creature of its own", () => {
  const legendary = { actionsMax: 3, actionsUsed: 1, resistMax: 2, resistUsed: 0 };
  const state = room();
  state.tokens.dragon = token("dragon", { name: "Dragon", ownerIds: ["p1"], actor: { inline: actor({ legendary }) } });
  state.tokens.goblin = token("goblin", { name: "Goblin" });
  const of = (tokenId: string, viewer: Viewer) => render(state, viewer, createElement(UsesSection, { target: { tokenId }, name: tokenId }));

  test("the DM reads its counts as pips on its rows, with no pips block under the list (docs/design-v1-monster-uses.md 3.1)", () => {
    const markup = of("dragon", DM);
    assert.match(markup, />Uses<\/h/);
    assert.match(markup, /Legendary Actions<\/span><span[^>]*>, 2 of 3 left</, "the list's row");
    assert.equal([...markup.matchAll(/data-pip="left"/g)].length, 4, "2 of 3 and 2 of 2 left");
    assert.doesNotMatch(markup, /data-pips|Legendary Actions used|Legendary Resistances used/);
    assert.doesNotMatch(markup, /aria-pressed/, "no pip to tap");
    assert.doesNotMatch(markup, /Add a class resource/, "no class resources for a creature of its own");
  });

  test("its player reads the same rows", () => {
    const markup = of("dragon", P1);
    assert.match(markup, /Legendary Actions<\/span><span[^>]*>, 2 of 3 left</);
    assert.equal([...markup.matchAll(/data-pip="left"/g)].length, 4);
    assert.doesNotMatch(markup, /Legendary Actions used/);
  });

  test("a creature with no use draws nothing", () => {
    assert.equal(of("goblin", DM), "");
  });
});

/*
 * A monster's rows (docs/design-v1-monster-uses.md 3): each title line with
 * its count as pips at its right end, to read only, in place of "x of y",
 * Restore always there and off while full, and the turn card's Legendary
 * Actions line.
 */
describe("a monster's rows, its counts as pips", () => {
  const lash: LegendaryUse = { kind: "legendary", key: "legendaryActions:lash", name: "Lash", section: "legendaryActions", cost: 1, once: false };
  const drain: LegendaryUse = { kind: "legendary", key: "legendaryActions:psychic-drain", name: "Psychic Drain", section: "legendaryActions", cost: 2, once: false };
  const dominate: DayUse = { kind: "day", key: "actions:dominate-mind", name: "Dominate Mind", section: "actions", max: 2, short: false };
  const breath: RechargeUse = { kind: "recharge", key: "actions:fire-breath", name: "Fire Breath", section: "actions", min: 5 };
  const block: LimitedUse[] = [lash, drain, dominate, breath];

  function list(over: Partial<Actor>, opts: { form?: "card" | "list"; ownTurn?: boolean; viewer?: Viewer } = {}): string {
    const state = room();
    state.tokens.aboleth = token("aboleth", { name: "Aboleth", ownerIds: ["p1"], actor: { inline: actor(over) } });
    return render(state, opts.viewer ?? DM, createElement(CombatUses, { target: { tokenId: "aboleth" }, form: opts.form ?? "list", uses: block, loading: false, failed: false, ownTurn: opts.ownTurn ?? false, name: "Aboleth" }));
  }
  const spent = { legendary: { actionsMax: 3, actionsUsed: 1, resistMax: 3, resistUsed: 1 }, uses: { [dominate.key]: { kind: "day" as const, name: "Dominate Mind", used: 1, max: 2 } } };
  const full = { legendary: { actionsMax: 3, actionsUsed: 0, resistMax: 3, resistUsed: 0 } };

  /** Each row's markup by its kind, in order. */
  const rowsOf = (markup: string) => markup.split(/(?=<li data-use-row=)/).slice(1).map((html) => ({ kind: /^<li data-use-row="(\w+)"/.exec(html)![1]!, html: html.slice(0, html.indexOf("</li>")) }));
  const row = (markup: string, kind: string, nth = 0) => rowsOf(markup).filter((r) => r.kind === kind)[nth]!.html;
  const pips = (html: string) => ({ left: [...html.matchAll(/data-pip="left"/g)].length, spent: [...html.matchAll(/data-pip="spent"/g)].length });
  const off = (markup: string, b: string | undefined) => {
    const why = b && /aria-describedby="([^"]+)"/.exec(b)?.[1];
    return why ? new RegExp(`<span id="${why}" hidden="">([^<]*)</span>`).exec(markup)?.[1] : undefined;
  };

  test("the Aboleth with a Resistance, a Lash and a Dominate Mind spent: its pips filled for what is left, no x of y", () => {
    const markup = list(spent);
    assert.deepEqual(pips(row(markup, "resist")), { left: 2, spent: 1 });
    assert.deepEqual(pips(row(markup, "legendary")), { left: 2, spent: 1 });
    assert.deepEqual(pips(row(markup, "ability", 0)), { left: 1, spent: 1 }, "Dominate Mind");
    assert.match(row(markup, "resist"), />Legendary Resistance<\/span><span/);
    assert.match(row(markup, "legendary"), />Legendary Actions<\/span><span/);
    assert.match(row(markup, "ability", 0), />Dominate Mind, 2\/Day<\/span><span/);
    assert.doesNotMatch(markup, />[^<]*\d of \d(?! left)[^<]*</, "no count in words on screen");
    // The pips only show: no button among them, and hidden from a screen reader.
    for (const part of markup.match(/<span data-use-pips=""[^>]*>.*?<\/span><\/div>/g) ?? []) {
      assert.match(part, /^<span data-use-pips="" aria-hidden="true"/);
      assert.doesNotMatch(part, /<button/);
    }
  });

  test("a screen reader hears each count after its name, and a recharge its state", () => {
    const markup = list({ ...spent, uses: { ...spent.uses, [breath.key]: { kind: "recharge", name: "Fire Breath", used: 1, max: 1, min: 5 } } });
    assert.match(row(markup, "legendary"), />Legendary Actions<\/span><span style="[^"]*">, 2 of 3 left<\/span><\/span>/);
    assert.match(row(markup, "resist"), />Legendary Resistance<\/span><span style="[^"]*">, 2 of 3 left<\/span><\/span>/);
    assert.match(row(markup, "ability", 0), />Dominate Mind, 2\/Day<\/span><span style="[^"]*">, 1 of 2 left<\/span><\/span>/);
    const fire = row(markup, "ability", 1);
    assert.match(fire, />Fire Breath, Recharge 5–6<\/span><span style="[^"]*">, Used<\/span><\/span><span data-use-pips="" aria-hidden="true"[^>]*>Used<\/span>/, "its state at the right end, as the pips stand");
  });

  test("a count of 6 shows 6 pips, as the Tarrasque's Legendary Resistance, and of 7 its words where they would stand", () => {
    const six = row(list({ legendary: { actionsMax: 0, actionsUsed: 0, resistMax: 6, resistUsed: 1 } }), "resist");
    assert.deepEqual(pips(six), { left: 5, spent: 1 });
    assert.match(six, /, 5 of 6 left</);
    const seven = row(list({ legendary: { actionsMax: 0, actionsUsed: 0, resistMax: 7, resistUsed: 1 } }), "resist");
    assert.deepEqual(pips(seven), { left: 0, spent: 0 });
    assert.match(seven, /<span data-use-pips="" aria-hidden="true"[^>]*>6 of 7<\/span>/);
    assert.match(seven, /, 6 of 7 left</);
  });

  test("Restore stays on every count, off while it is full and saying why, so a row keeps its shape (D-261026-2)", () => {
    const fullList = list(full);
    const restores = (markup: string) => buttons(markup).filter((b) => /aria-label="Restore one /.test(b));
    assert.deepEqual(
      restores(fullList).map((b) => [/aria-label="([^"]+)"/.exec(b)![1], /aria-disabled="true"/.test(b), off(fullList, b)]),
      [
        ["Restore one Legendary Resistance", true, "Legendary Resistance is full."],
        ["Restore one Legendary Action", true, "Legendary Actions are full."],
        ["Restore one use of Dominate Mind", true, "Dominate Mind is full."],
      ],
    );
    const spentList = list(spent);
    assert.deepEqual(
      restores(spentList).map((b) => /aria-disabled/.test(b)),
      [false, false, false],
    );
  });

  test("on its own turn its legendary actions are off and Restore still corrects the count", () => {
    const markup = list(spent, { ownTurn: true });
    assert.match(named(markup, "Use Lash, Legendary Action, 2 left")!, /aria-disabled="true"/);
    assert.doesNotMatch(named(markup, "Restore one Legendary Action")!, /aria-disabled/);
  });

  test("the turn card: Legendary Actions' pips and when they come, no buttons for them, and no Restore", () => {
    const markup = list(spent, { form: "card", ownTurn: true });
    const la = row(markup, "legendary");
    assert.deepEqual(pips(la), { left: 2, spent: 1 });
    assert.match(la, />After other creatures&#x27; turns</);
    assert.doesNotMatch(la, /<button/);
    assert.doesNotMatch(markup, /aria-label="Restore /);
  });

  test("its rows and the parts of its box stand 12 px apart (docs/design-v1-monster-uses.md 3.1)", () => {
    const markup = list(spent);
    assert.match(markup, /^<div data-combat-uses="list" style="[^"]*gap:12px/);
    assert.match(markup, /<ul aria-label="Aboleth&#x27;s uses" style="[^"]*gap:12px/);
  });

  test("a lent monster's player reads the same rows and pips", () => {
    const markup = list(spent, { viewer: P1 });
    assert.deepEqual(pips(row(markup, "resist")), { left: 2, spent: 1 });
    assert.ok(named(markup, "Restore one Legendary Resistance"));
  });
});
