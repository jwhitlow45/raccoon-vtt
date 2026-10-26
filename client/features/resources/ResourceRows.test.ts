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
    assert.match(markup, /Lay on Hands<\/span> <span[^>]*>25 of 25<\/span>/, "its words beside the name past 6");
    assert.match(markup, />One back on a Short Rest, all on a Long Rest</);
    assert.match(markup, />Back on a Long Rest</);
    assert.match(markup, /^<div data-resource-list[^>]*><ul/, "a list, its rows its items");
    assert.equal([...markup.matchAll(/<li /g)].length, 2);
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
  /** The rows before the pips, Rage's 3 and Lay on Hands' 25, Edit and all, as the build found them. */
  const BEFORE = `<div data-resource-list="true" style="display:grid;gap:4px"><ul aria-label="Pat&#x27;s uses" style="list-style:none;margin:0;padding:0;display:grid;gap:12px"><li style="display:grid;gap:4px"><div style="display:flex;flex-wrap:wrap;align-items:center;column-gap:8px;row-gap:4px;min-height:44px"><div style="flex:1 1 auto;min-width:0"><div style="font-size:16px;line-height:1.2;overflow-wrap:anywhere"><span style="font-weight:600">Rage</span> <span style="color:#a7a5ad;font-variant-numeric:tabular-nums">2 of 3</span></div><div style="font-size:13px;line-height:1.4;color:#a7a5ad">One back on a Short Rest, all on a Long Rest</div></div><div style="flex:1 1 100%;min-width:0;max-width:100%;display:flex;flex-wrap:wrap;gap:4px"><button type="button" aria-label="Use Rage, 2 of 3 left" style="display:inline-flex;align-items:center;justify-content:center;gap:8px;min-height:44px;min-width:44px;font-size:14px;padding:0 12px;border-radius:10px;font-weight:600;font-family:Inter, system-ui, -apple-system, &quot;Segoe UI&quot;, Roboto, sans-serif;cursor:pointer;background:#2a2a32;border:1px solid #3a3a44;color:#f1efe9;white-space:nowrap;flex:1 1 auto">Use</button><button type="button" aria-label="Restore one use of Rage" style="display:inline-flex;align-items:center;justify-content:center;gap:8px;min-height:44px;min-width:44px;font-size:14px;padding:0 12px;border-radius:10px;font-weight:600;font-family:Inter, system-ui, -apple-system, &quot;Segoe UI&quot;, Roboto, sans-serif;cursor:pointer;background:#2a2a32;border:1px solid #3a3a44;color:#f1efe9;white-space:nowrap;flex:1 1 auto">Restore</button><button type="button" aria-label="Edit Rage" style="display:inline-flex;align-items:center;justify-content:center;gap:8px;min-height:44px;min-width:44px;font-size:14px;padding:0;border-radius:10px;font-weight:600;font-family:Inter, system-ui, -apple-system, &quot;Segoe UI&quot;, Roboto, sans-serif;cursor:pointer;background:#2a2a32;border:1px solid #3a3a44;color:#f1efe9;flex:none"><svg aria-hidden="true" focusable="false" viewBox="0 0 24 24" width="20" height="20" style="display:block;flex:none"><path fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" d="M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497zM15 5l4 4"></path></svg></button><div id="_R_39l_" role="tooltip" popover="manual" style="display:none;visibility:hidden;position:fixed;inset:auto;margin:0;overflow:visible;padding:4px 8px;border:1px solid #3a3a44;border-radius:6px;background:#2a2a32;color:#f1efe9;font-family:Inter, system-ui, -apple-system, &quot;Segoe UI&quot;, Roboto, sans-serif;font-size:13px;line-height:1.2;box-shadow:0 4px 16px rgba(0, 0, 0, 0.4);pointer-events:none">Edit Rage</div></div><span id="_R_5_-none" hidden="">Rage has no uses left.</span><span id="_R_5_-full" hidden="">Rage is full.</span></div></li><li style="display:grid;gap:4px"><div style="display:flex;flex-wrap:wrap;align-items:center;column-gap:8px;row-gap:4px;min-height:44px"><div style="flex:1 1 auto;min-width:0"><div style="font-size:16px;line-height:1.2;overflow-wrap:anywhere"><span style="font-weight:600">Lay on Hands</span> <span style="color:#a7a5ad;font-variant-numeric:tabular-nums">25 of 25</span></div><div style="font-size:13px;line-height:1.4;color:#a7a5ad">Back on a Long Rest</div></div><div style="flex:1 1 100%;min-width:0;max-width:100%;display:flex;flex-wrap:wrap;gap:4px"><button type="button" aria-expanded="false" aria-label="Use Lay on Hands, 25 of 25 left" style="display:inline-flex;align-items:center;justify-content:center;gap:8px;min-height:44px;min-width:44px;font-size:14px;padding:0 12px;border-radius:10px;font-weight:600;font-family:Inter, system-ui, -apple-system, &quot;Segoe UI&quot;, Roboto, sans-serif;cursor:pointer;background:#2a2a32;border:1px solid #3a3a44;color:#f1efe9;white-space:nowrap;flex:1 1 auto">Use…</button><button type="button" aria-expanded="false" aria-label="Restore Lay on Hands" aria-disabled="true" aria-describedby="_R_9_-full" style="display:inline-flex;align-items:center;justify-content:center;gap:8px;min-height:44px;min-width:44px;font-size:14px;padding:0 12px;border-radius:10px;font-weight:600;font-family:Inter, system-ui, -apple-system, &quot;Segoe UI&quot;, Roboto, sans-serif;cursor:default;background:#2a2a32;border:1px solid #3a3a44;color:#7c7a84;white-space:nowrap;flex:1 1 auto">Restore…</button><button type="button" aria-label="Edit Lay on Hands" style="display:inline-flex;align-items:center;justify-content:center;gap:8px;min-height:44px;min-width:44px;font-size:14px;padding:0;border-radius:10px;font-weight:600;font-family:Inter, system-ui, -apple-system, &quot;Segoe UI&quot;, Roboto, sans-serif;cursor:pointer;background:#2a2a32;border:1px solid #3a3a44;color:#f1efe9;flex:none"><svg aria-hidden="true" focusable="false" viewBox="0 0 24 24" width="20" height="20" style="display:block;flex:none"><path fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" d="M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497zM15 5l4 4"></path></svg></button><div id="_R_39p_" role="tooltip" popover="manual" style="display:none;visibility:hidden;position:fixed;inset:auto;margin:0;overflow:visible;padding:4px 8px;border:1px solid #3a3a44;border-radius:6px;background:#2a2a32;color:#f1efe9;font-family:Inter, system-ui, -apple-system, &quot;Segoe UI&quot;, Roboto, sans-serif;font-size:13px;line-height:1.2;box-shadow:0 4px 16px rgba(0, 0, 0, 0.4);pointer-events:none">Edit Lay on Hands</div></div><span id="_R_9_-none" hidden="">No Lay on Hands is left.</span><span id="_R_9_-full" hidden="">Lay on Hands is full.</span></div></li></ul></div>`;
  /** A row's name line: the only part that may change, the line before its "comes back" words. */
  const NAME_LINE = /<div style="[^"]*">(?:(?!<div).)*?<\/div>(?=<div style="font-size:13px)/;
  const withEdit = (resources: ClassResource[]) => render(character("pat", { name: "Pat", resources }), createElement(ClassResourceRows, { characterId: "pat", form: "list", label: "Pat's uses", edit() {} }));
  const pips = (html: string) => ({ left: [...html.matchAll(/data-pip="left"/g)].length, spent: [...html.matchAll(/data-pip="spent"/g)].length });

  test("only Rage's name line changed: its layout, Use, Restore, Edit and its rest as before, and Lay on Hands, past 6, as before throughout", () => {
    const now = withEdit([rage, hands]);
    assert.notEqual(now, BEFORE, "Rage's count changed");
    assert.equal(now.replace(NAME_LINE, "NAME_LINE"), BEFORE.replace(NAME_LINE, "NAME_LINE"));
  });

  test("a most of 6 or fewer: a pip for each use, filled for each one left, to read only, and the count spoken after the name", () => {
    const markup = rows([{ ...rage, max: 6, used: 2 }], "list");
    assert.deepEqual(pips(markup), { left: 4, spent: 2 });
    assert.match(markup, />Rage<\/span><span style="[^"]*">, 4 of 6 left<\/span><\/span>/);
    assert.doesNotMatch(markup, />4 of 6</, "no count in words on screen");
    const second = rows([{ id: "sw", name: "Second Wind", max: 3, used: 3, reset: "shortOne" }, { id: "as", name: "Action Surge", max: 1, used: 0, reset: "short" }], "card");
    assert.deepEqual(pips(second), { left: 1, spent: 3 }, "Second Wind none left, Action Surge one");
  });

  test("a most of 7 keeps its words beside the name", () => {
    const markup = rows([{ ...rage, max: 7, used: 2 }], "list");
    assert.deepEqual(pips(markup), { left: 0, spent: 0 });
    assert.match(markup, />Rage<\/span> <span style="[^"]*">5 of 7<\/span>/);
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
