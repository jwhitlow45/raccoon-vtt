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
  return render(pat, createElement(ClassResourceRows, { characterId: "pat", form }));
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
    assert.match(markup, /Rage<\/span> <span[^>]*>2 of 3<\/span>/);
    assert.match(markup, /Lay on Hands<\/span> <span[^>]*>25 of 25<\/span>/);
    assert.match(markup, />One back on a Short Rest, all on a Long Rest</);
    assert.match(markup, />Back on a Long Rest</);
    assert.match(markup, /^<div data-resource-list[^>]*><ul/, "a list, its rows its items");
    assert.equal([...markup.matchAll(/<li /g)].length, 2);
  });

  test("the off-turn list: Use and Give one back, a pool's Use… and Give back…, each named with its resource", () => {
    const markup = rows([rage, hands], "list");
    assert.ok(named(markup, "Use Rage, 2 of 3 left"));
    assert.ok(named(markup, "Give one back: Rage"));
    assert.ok(named(markup, "Use Lay on Hands, 25 of 25 left"));
    assert.ok(named(markup, "Give back Lay on Hands"));
    assert.match(markup, />Use…<\/button>/);
    assert.match(markup, />Give back…<\/button>/);
    assert.match(named(markup, "Use Lay on Hands, 25 of 25 left")!, /aria-expanded="false"/, "a pool's Use… opens its amount field");
    assert.doesNotMatch(named(markup, "Use Rage, 2 of 3 left")!, /aria-expanded/, "a count's Use spends at once");
    assert.equal(named(markup, "Edit Rage"), undefined, "Edit is the section's");
  });

  test("the turn card: Use alone", () => {
    const markup = rows([rage, hands], "card");
    assert.ok(named(markup, "Use Rage, 2 of 3 left"));
    assert.ok(named(markup, "Use Lay on Hands, 25 of 25 left"));
    assert.equal(named(markup, "Give one back: Rage"), undefined);
    assert.equal(named(markup, "Give back Lay on Hands"), undefined);
  });

  test("a Use with nothing left and a Give back with nothing spent stay in the Tab order and say why", () => {
    const markup = rows([{ ...rage, used: 3 }, hands], "list");
    const use = named(markup, "Use Rage, 0 of 3 left")!;
    assert.match(use, /aria-disabled="true"/);
    assert.doesNotMatch(use, / disabled=""/, "not the native disabled, which drops focus");
    const why = /aria-describedby="([^"]+)"/.exec(use)?.[1];
    assert.ok(why);
    assert.match(markup, new RegExp(`<span id="${why}" hidden="">Rage has no uses left.</span>`));
    const back = named(markup, "Give back Lay on Hands")!;
    assert.match(back, /aria-disabled="true"/);
    const full = /aria-describedby="([^"]+)"/.exec(back)?.[1];
    assert.match(markup, new RegExp(`<span id="${full}" hidden="">Lay on Hands is full.</span>`));
    assert.doesNotMatch(named(markup, "Give one back: Rage")!, /aria-disabled/, "one spent can come back");
    assert.doesNotMatch(named(markup, "Use Lay on Hands, 25 of 25 left")!, /aria-disabled/);
  });

  test("every button is a 44 px target", () => {
    for (const b of buttons(rows([rage, hands], "list"))) assert.match(b, /min-height:44px/, b);
  });
});

describe("a pool's amount field once its counts change under it (CCAC-OPUS-6)", () => {
  const spend = { verb: "Spend" as const, text: "5", error: "Spend 1 to 15." };
  const giveBack = { verb: "Give back" as const, text: "", error: null };

  test("it stays open while there is something to spend or give back", () => {
    assert.deepEqual(amountFor(null, hands, false), { amount: null, gone: null });
    assert.deepEqual(amountFor(spend, { ...hands, used: 24 }, false), { amount: spend, gone: null });
    assert.deepEqual(amountFor(giveBack, { ...hands, used: 1 }, false), { amount: giveBack, gone: null });
    assert.deepEqual(amountFor(spend, { ...hands, used: 24 }, true), { amount: spend, gone: null }, "a part spent here leaves the field open until the answer");
  });

  test("it closes with the row's own words once another device spent the last or gave back the rest, never reading 1 to 0", () => {
    assert.deepEqual(amountFor(spend, { ...hands, used: 25 }, false), { amount: null, gone: "No Lay on Hands is left." });
    assert.deepEqual(amountFor(giveBack, hands, false), { amount: null, gone: "Lay on Hands is full." });
  });

  test("it closes with no words while this row's own use of the whole pool waits for its answer, which is no refusal (CCAC-OPUS-11)", () => {
    assert.deepEqual(amountFor(spend, { ...hands, used: 25 }, true), { amount: null, gone: null });
    assert.deepEqual(amountFor(giveBack, hands, true), { amount: null, gone: null });
  });
});
