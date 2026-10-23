import "../../components/testing/register.ts";
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { createStore } from "zustand/vanilla";
import type { RoomState, Token } from "#shared/model.ts";
import { DM, room, token } from "#shared/testutil.ts";

/*
 * The bar's attach parts (docs/design-v1-look-pass-2.md 2.7, 2.10 and 3.1).
 * A holder's line names each token once, under what the holder does with
 * it, and its actions show the short words, named in full for a reader.
 * Get off with no spot to go to is unavailable but focusable, and its note
 * is a line of its own, so the play row's buttons keep their widths.
 */

const { createElement } = await import("react");
const { renderToStaticMarkup } = await import("react-dom/server");
const { RoomProvider } = await import("../../state/view.ts");
const { DetachButton, DetachNote, GroupLine } = await import("./BarParts.tsx");

/** The warhorse Bree rides, carrying a torch and dragging Goblin 2. */
function stable(): RoomState {
  const state = room();
  const list: Token[] = [
    token("horse", { name: "Warhorse", size: "large", x: 5, y: 5 }),
    token("bree", { name: "Bree", kind: "pc", x: 5, y: 5, attached: { to: "horse", kind: "ride", steer: true } }),
    token("torch", { name: "Torch", kind: "object", size: "tiny", x: 5, y: 5, attached: { to: "horse", kind: "carry" } }),
    token("goblin", { name: "Goblin", number: 2, x: 7, y: 5, attached: { to: "horse", kind: "drag" } }),
  ];
  state.tokens = Object.fromEntries(list.map((t) => [t.id, t]));
  return state;
}

function render(view: RoomState, node: ReturnType<typeof createElement>): string {
  const store = createStore(() => ({ view, you: { role: "dm", memberId: DM.memberId } }));
  return renderToStaticMarkup(createElement(RoomProvider, { store: store as never, actions: {} as never, ui: {} as never, children: node }));
}

const buttons = (markup: string) => [...markup.matchAll(/<button([^>]*)>(?:<[^>]+>)*([^<]*)/g)].map((m) => ({ attrs: m[1] ?? "", text: m[2] ?? "" }));

describe("the bar's group line", () => {
  test("a holder's line reads Carrying, then Dragging, each name once, and its actions say Put down and Let go, named in full", () => {
    const view = stable();
    const markup = render(view, createElement(GroupLine, { token: view.tokens.horse! }));
    assert.match(markup, />Carrying<\/span>.*>Dragging<\/span>/);
    const found = buttons(markup);
    const named = (label: string) => found.find((b) => b.attrs.includes(`aria-label="${label}"`));
    assert.equal(named("Carrying Bree")?.text, "Bree");
    assert.equal(named("Carrying Torch")?.text, "Torch");
    assert.equal(named("Dragging Goblin 2")?.text, "Goblin 2");
    assert.equal(named("Put down Torch")?.text, "Put down");
    assert.equal(named("Let go of Goblin 2")?.text, "Let go");
    assert.equal(named("Carrying Goblin 2"), undefined, "a dragged creature is not carried");
  });

  test("gives each kind of link a row of its own: its word in the first column, its names and actions beside it (docs/design-v1-polish.md R5)", () => {
    const view = stable();
    const markup = render(view, createElement(GroupLine, { token: view.tokens.horse! }));
    assert.match(markup, /^<div role="group" aria-label="Attached tokens" style="display:grid;grid-template-columns:max-content minmax\(0, 1fr\)/);
    const cells = [...markup.matchAll(/<span aria-hidden="true" data-hold-word="(\w+)"[^>]*>(\w+)<\/span><div data-hold-names="(\w+)"[^>]*>(.*?)<\/div>/g)].map((m) => ({ word: m[2], cell: m[3], names: buttons(m[4] ?? "").map((b) => b.text) }));
    assert.deepEqual(cells, [
      { word: "Carrying", cell: "carrying", names: ["Bree", "Torch", "Put down"] },
      { word: "Dragging", cell: "dragging", names: ["Goblin 2", "Let go"] },
    ]);
  });

  test("keeps each name and action to its cell, its words wrapping there, and the word on its first name's first line (PL2-ASTRA-03)", () => {
    const view = stable();
    const markup = render(view, createElement(GroupLine, { token: view.tokens.horse! }));
    assert.match(markup, /^<div role="group" aria-label="Attached tokens" style="[^"]*align-items:baseline/);
    const found = buttons(markup);
    assert.equal(found.length, 5);
    for (const b of found) assert.match(b.attrs, /style="[^"]*flex:0 1 auto;max-width:100%;overflow-wrap:anywhere/, `${b.text} may run past its cell`);
  });

  test("a rider's line names its mount as the panel does", () => {
    const view = stable();
    const markup = render(view, createElement(GroupLine, { token: view.tokens.bree! }));
    assert.equal(buttons(markup)[0]?.text, "Riding Warhorse");
  });
});

describe("Get off with no room to get off", () => {
  const stuck = { choice: "getOff" as const, place: null, stuck: true };

  test("is aria-disabled, never natively disabled, and described by its note, which is a line of its own", () => {
    const view = stable();
    const button = render(view, createElement(DetachButton, { token: view.tokens.bree!, detach: stuck, noteId: "why" }));
    assert.match(button, /^<button[^>]*>Get off<\/button>$/, "the button alone, with no note inside its slot");
    assert.match(button, /aria-disabled="true"/);
    assert.match(button, /aria-describedby="why"/);
    assert.doesNotMatch(button, /\sdisabled=""/);
    const note = render(view, createElement(DetachNote, { detach: stuck, id: "why" }));
    assert.match(note, /^<p id="why"[^>]*>No room to get off.<\/p>$/);
  });

  test("with a spot, Get off is a plain button and there is no note", () => {
    const view = stable();
    const free = { choice: "getOff" as const, place: { x: 4, y: 5, elevation: 0 }, stuck: false };
    const button = render(view, createElement(DetachButton, { token: view.tokens.bree!, detach: free, noteId: "why" }));
    assert.doesNotMatch(button, /aria-disabled|aria-describedby/);
    assert.equal(render(view, createElement(DetachNote, { detach: free, id: "why" })), "");
  });
});
