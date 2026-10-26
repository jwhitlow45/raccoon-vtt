import "../../components/testing/register.ts";
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { createStore } from "zustand/vanilla";
import type { Character, ClassResource } from "#shared/model.ts";
import { character, room } from "#shared/testutil.ts";

const { createElement } = await import("react");
const { renderToStaticMarkup } = await import("react-dom/server");
const { amountFor, ClassResourceRows } = await import("./ResourceRows.tsx");
const { RoomProvider } = await import("../../state/view.ts");
const { RoomScope, RoomScopeProvider } = await import("../../state/scope.ts");

/*
 * A character's class resource rows as they draw
 * (docs/design-v1-combat-controls.md 7.2 and 9): each row's count, its
 * rest and its buttons in the turn card and in the off-turn list, and a
 * button that is off keeping its focus and saying why.
 */

const rage: ClassResource = { id: "rage", name: "Rage", max: 3, used: 1, reset: "shortOne", preset: "barbarian-rage", level: 5, atLevel: 5 };
const hands: ClassResource = { id: "hands", name: "Lay on Hands", max: 25, used: 0, reset: "long", pool: true, preset: "paladin-lay-on-hands", level: 5, atLevel: 5 };

function render(pat: Character, element: ReturnType<typeof createElement>): string {
  const store = createStore(() => ({ view: room({ characters: { pat } }), you: { role: "player", memberId: "p1" } }));
  return renderToStaticMarkup(createElement(RoomProvider, { store: store as never, actions: {} as never, ui: {} as never, children: createElement(RoomScopeProvider, { scope: new RoomScope(), children: element }) }));
}

const rows = (resources: ClassResource[] | undefined, form: "card" | "list") => {
  const pat = character("pat", { name: "Pat", ...(resources ? { resources } : {}) });
  return render(pat, createElement(ClassResourceRows, { characterId: "pat", form, label: "Pat's uses" }));
};

/** Each button's tag, from `<button` to its closing `>`, in order. */
const buttons = (markup: string) => [...markup.matchAll(/<button[^>]*>/g)].map((m) => m[0]);
const named = (markup: string, name: string) => buttons(markup).find((b) => b.includes(`aria-label="${name}"`));

describe("a character's class resource rows", () => {
  test("none, or none in this viewer's copy, draws nothing", () => {
    assert.equal(rows(undefined, "list"), "");
    assert.equal(rows([], "card"), "");
  });

  test("each row reads its name, what is left of its most and its rest", () => {
    const markup = rows([rage, hands], "list");
    assert.match(markup, />Rage<\/span><span style="[^"]*">, 2 of 3 left<\/span><\/span><svg data-use-pips="" aria-hidden="true"/, "pips for a most of 6 or fewer");
    assert.match(markup, />Lay on Hands<\/span><span style="[^"]*">, 25 of 25 left<\/span><\/span><span data-use-pips="" aria-hidden="true"[^>]*>25 of 25<\/span>/, "its words at the line's right end past 6, as pips stand, spoken once after the name");
    assert.match(markup, />One back on a Short Rest, all on a Long Rest</);
    assert.match(markup, />Back on a Long Rest</);
    assert.match(markup, /^<div data-resource-list[^>]*><ul/, "a list, its rows its items");
    assert.equal([...markup.matchAll(/<li /g)].length, 2);
  });

  test("a pool's words stand at the line's right end at every size, never as pips, and never break inside", () => {
    const small: ClassResource = { ...hands, name: "Focus Points", max: 5, used: 1 };
    const markup = rows([small], "list");
    assert.match(markup, />Focus Points<\/span><span style="[^"]*">, 4 of 5 left<\/span><\/span><span data-use-pips="" aria-hidden="true"[^>]*>4 of 5<\/span>/);
    assert.doesNotMatch(markup, /data-pip=/, "no pips for a pool of 5");
    assert.match(markup, /<span data-use-pips=""[^>]*white-space:nowrap[^>]*>4 of 5<\/span>/, "one unbreakable part");
    assert.equal([...markup.matchAll(/4 of 5/g)].length, 3, "the words once, the spoken count once, and Use's name once");
  });

  test("the off-turn list: Use and Restore, a pool's Use… and Restore…, each named with its resource", () => {
    const markup = rows([rage, hands], "list");
    assert.ok(named(markup, "Use Rage, 2 of 3 left"));
    assert.ok(named(markup, "Restore one use of Rage"));
    assert.ok(named(markup, "Use Lay on Hands, 25 of 25 left"));
    assert.ok(named(markup, "Restore Lay on Hands"));
    assert.match(markup, />Use…<\/button>/);
    assert.match(markup, />Restore…<\/button>/);
    assert.match(named(markup, "Use Lay on Hands, 25 of 25 left")!, /aria-expanded="false"/, "a pool's Use… opens its amount field");
    assert.doesNotMatch(named(markup, "Use Rage, 2 of 3 left")!, /aria-expanded/, "a count's Use spends at once");
    assert.equal(named(markup, "Edit Rage"), undefined, "Edit is the section's");
  });

  test("the turn card: Use alone", () => {
    const markup = rows([rage, hands], "card");
    assert.ok(named(markup, "Use Rage, 2 of 3 left"));
    assert.ok(named(markup, "Use Lay on Hands, 25 of 25 left"));
    assert.equal(named(markup, "Restore one use of Rage"), undefined);
    assert.equal(named(markup, "Restore Lay on Hands"), undefined);
  });

  test("a Use with nothing left and a Restore with nothing spent stay in the Tab order and say why", () => {
    const markup = rows([{ ...rage, used: 3 }, hands], "list");
    const use = named(markup, "Use Rage, 0 of 3 left")!;
    assert.match(use, /aria-disabled="true"/);
    assert.doesNotMatch(use, / disabled=""/, "not the native disabled, which drops focus");
    const why = /aria-describedby="([^"]+)"/.exec(use)?.[1];
    assert.ok(why);
    assert.match(markup, new RegExp(`<span id="${why}" hidden="">Rage has no uses left.</span>`));
    const back = named(markup, "Restore Lay on Hands")!;
    assert.match(back, /aria-disabled="true"/);
    const full = /aria-describedby="([^"]+)"/.exec(back)?.[1];
    assert.match(markup, new RegExp(`<span id="${full}" hidden="">Lay on Hands is full.</span>`));
    assert.doesNotMatch(named(markup, "Restore one use of Rage")!, /aria-disabled/, "one spent can come back");
    assert.doesNotMatch(named(markup, "Use Lay on Hands, 25 of 25 left")!, /aria-disabled/);
  });

  test("every button is a 44 px target", () => {
    for (const b of buttons(rows([rage, hands], "list"))) assert.match(b, /min-height:44px/, b);
  });
});

/*
 * The count as pips (D-261026-2's fifth and sixth amendments,
 * docs/design-v1-monster-uses.md 3.7): only the count changes. The row's
 * layout, its buttons and its "comes back" line stay as they were.
 */
describe("a class resource's count as pips", () => {
  const withEdit = (resources: ClassResource[]) => render(character("pat", { name: "Pat", resources }), createElement(ClassResourceRows, { characterId: "pat", form: "list", label: "Pat's uses", edit() {} }));
  const pips = (html: string) => ({ left: [...html.matchAll(/data-pip="left"/g)].length, spent: [...html.matchAll(/data-pip="spent"/g)].length });

  test("only the count changes: each row keeps its name line over its rest, then Use, Restore and Edit on a line of their own (D-261026-2's fifth amendment)", () => {
    const items = withEdit([rage, hands]).split(/(?=<li )/).slice(1);
    assert.equal(items.length, 2);
    const cases = [
      { li: items[0]!, name: "Rage", rest: "One back on a Short Rest, all on a Long Rest", labels: ["Use Rage, 2 of 3 left", "Restore one use of Rage", "Edit Rage"] },
      { li: items[1]!, name: "Lay on Hands", rest: "Back on a Long Rest", labels: ["Use Lay on Hands, 25 of 25 left", "Restore Lay on Hands", "Edit Lay on Hands"] },
    ];
    for (const c of cases) {
      // The row: a wrapping line of the words' column, then the buttons' line, which takes the whole width under it.
      assert.match(c.li, /^<li style="display:grid;gap:4px"><div style="display:flex;flex-wrap:wrap;align-items:center;column-gap:8px;row-gap:4px;min-height:44px"><div style="flex:1 1 auto;min-width:0">/, c.name);
      // The words' column: the name line, then the rest under it, and the buttons' line straight after.
      const restAt = c.li.indexOf(`>${c.rest}</div></div><div style="flex:1 1 100%;min-width:0;max-width:100%;display:flex;flex-wrap:wrap;gap:4px">`);
      assert.ok(restAt > c.li.indexOf(`>${c.name}<`), `${c.name}: its rest under its name, before its buttons`);
      assert.match(c.li, new RegExp(`<div style="font-size:13px;line-height:1.4;color:[^"]*">${c.rest}</div>`), `${c.name}: the rest's words as before`);
      assert.deepEqual(buttons(c.li).map((b) => /aria-label="([^"]+)"/.exec(b)?.[1]), c.labels, c.name);
    }
    // Rage's count as pips and Lay on Hands' in words, both at the name line's right end.
    assert.match(items[0]!, /<div style="flex:1 1 100%;min-width:0;display:flex[^"]*"><span[^>]*><span>Rage<\/span><span style="[^"]*">, 2 of 3 left<\/span><\/span><svg data-use-pips=""/);
    assert.match(items[1]!, /<div style="flex:1 1 100%;min-width:0;display:flex[^"]*"><span[^>]*><span>Lay on Hands<\/span><span style="[^"]*">, 25 of 25 left<\/span><\/span><span data-use-pips="" aria-hidden="true"[^>]*>25 of 25<\/span>/);
  });

  test("a most of 6 or fewer: a pip for each use, filled for each one left, to read only, and the count spoken after the name", () => {
    const markup = rows([{ ...rage, max: 6, used: 2 }], "list");
    assert.deepEqual(pips(markup), { left: 4, spent: 2 });
    assert.match(markup, />Rage<\/span><span style="[^"]*">, 4 of 6 left<\/span><\/span>/);
    assert.doesNotMatch(markup, />4 of 6</, "no count in words on screen");
    const second = rows([{ id: "sw", name: "Second Wind", max: 3, used: 3, reset: "shortOne" }, { id: "as", name: "Action Surge", max: 1, used: 0, reset: "short" }], "card");
    assert.deepEqual(pips(second), { left: 1, spent: 3 }, "Second Wind none left, Action Surge one");
  });

  test("a pool keeps its words at every size, as a paladin's 5 points of Lay on Hands (D-261026-2's eighth amendment)", () => {
    const markup = rows([{ ...hands, max: 5, used: 1 }], "list");
    assert.deepEqual(pips(markup), { left: 0, spent: 0 });
    assert.match(markup, />Lay on Hands<\/span><span style="[^"]*">, 4 of 5 left<\/span><\/span><span data-use-pips="" aria-hidden="true"[^>]*>4 of 5<\/span>/);
  });

  test("a most of 7 keeps its words at the name line's right end", () => {
    const markup = rows([{ ...rage, max: 7, used: 2 }], "list");
    assert.deepEqual(pips(markup), { left: 0, spent: 0 });
    assert.match(markup, />Rage<\/span><span style="[^"]*">, 5 of 7 left<\/span><\/span><span data-use-pips="" aria-hidden="true"[^>]*>5 of 7<\/span>/);
  });
});

describe("a pool's amount field once its counts change under it (CCAC-OPUS-6)", () => {
  const spend = { verb: "Spend" as const, text: "5", error: "Spend 1 to 15." };
  const restore = { verb: "Restore" as const, text: "", error: null };

  test("it stays open while there is something to spend or restore", () => {
    assert.deepEqual(amountFor(null, hands, false), { amount: null, gone: null });
    assert.deepEqual(amountFor(spend, { ...hands, used: 24 }, false), { amount: spend, gone: null });
    assert.deepEqual(amountFor(restore, { ...hands, used: 1 }, false), { amount: restore, gone: null });
    assert.deepEqual(amountFor(spend, { ...hands, used: 24 }, true), { amount: spend, gone: null }, "a part spent here leaves the field open until the answer");
  });

  test("it closes with the row's own words once another device spent the last or restored the rest, never reading 1 to 0", () => {
    assert.deepEqual(amountFor(spend, { ...hands, used: 25 }, false), { amount: null, gone: "No Lay on Hands is left." });
    assert.deepEqual(amountFor(restore, hands, false), { amount: null, gone: "Lay on Hands is full." });
  });

  test("it closes with no words while this row's own use of the whole pool waits for its answer, which is no refusal (CCAC-OPUS-11)", () => {
    assert.deepEqual(amountFor(spend, { ...hands, used: 25 }, true), { amount: null, gone: null });
    assert.deepEqual(amountFor(restore, hands, true), { amount: null, gone: null });
  });
});
