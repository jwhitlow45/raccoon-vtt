import "../../components/testing/register.ts";
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { createStore } from "zustand/vanilla";
import type { RoomState, Token } from "#shared/model.ts";
import { DM, room, token } from "#shared/testutil.ts";

/*
 * The Attach list as card rows (docs/design-v1-look-pass-2.md 2.5 and 3,
 * lane 3). Its keys find the rows by `data-attach-row`, so every row's
 * button must carry it, the near rows and "Farther away" alike, or Down,
 * Home and End would skip a row. The keys themselves are e2e's (lp2-3c).
 */

const { createElement } = await import("react");
const { renderToStaticMarkup } = await import("react-dom/server");
const { RoomProvider } = await import("../../state/view.ts");
const { AttachList } = await import("./AttachButton.tsx");

/** Thorn with a horse and a torch in reach, and a pony 20 ft off, for the DM's "Farther away". */
function table(): RoomState {
  const state = room();
  const list: Token[] = [
    token("thorn", { name: "Thorn", kind: "pc", x: 5, y: 5, disposition: "ally" }),
    token("horse", { name: "Warhorse", kind: "npc", size: "large", x: 6, y: 5, disposition: "ally" }),
    token("torch", { name: "Torch", kind: "object", layer: "object", size: "tiny", x: 4.5, y: 6 }),
    token("pony", { name: "Pony", size: "large", x: 9, y: 5 }),
  ];
  state.tokens = Object.fromEntries(list.map((t) => [t.id, t]));
  return state;
}

function render(view: RoomState, capped: boolean, you: { role: "dm" | "player"; memberId: string } = { role: "dm", memberId: DM.memberId }): string {
  const store = createStore(() => ({ view, you }));
  const list = createElement(AttachList, { token: view.tokens.thorn!, capped, onDone() {} });
  return renderToStaticMarkup(createElement(RoomProvider, { store: store as never, actions: {} as never, ui: {} as never, assets: { url: () => "" } as never, children: list }));
}

describe("the Attach list's rows", () => {
  test("every row's button carries data-attach-row, the near rows and Farther away alike", () => {
    const markup = render(table(), true);
    const buttons = [...markup.matchAll(/<button[^>]*>/g)].map((m) => m[0]);
    assert.ok(buttons.length >= 4, `rows: ${buttons.length}`);
    for (const b of buttons) assert.match(b, /data-attach-row=""/);
    // Farther away heads a group of its own, named by its heading.
    const id = /<h3 id="([^"]+)"[^>]*>Farther away<\/h3>/.exec(markup)?.[1];
    assert.ok(id, "Farther away is a heading");
    assert.match(markup, new RegExp(`<div role="group" aria-labelledby="${id}"`));
    assert.match(markup.slice(markup.indexOf("Farther away")), /data-attach-row=""[^>]*>.*Ride Pony/);
  });

  test("Ride unfolds its question under its row, so its button says so, and only the pop-up holds the list to a side panel's width", () => {
    const capped = render(table(), true);
    assert.match(capped, /<button[^>]*aria-expanded="false"[^>]*>.*?Ride Warhorse/);
    assert.match(capped, /^<div[^>]*style="[^"]*max-width:360px/);
    const sheet = render(table(), false);
    assert.doesNotMatch(sheet.slice(0, sheet.indexOf(">")), /max-width/);
  });
});

describe("the Attach list with nothing in reach (review LP2L3)", () => {
  /** Thorn alone on the map. */
  function alone(): RoomState {
    const view = table();
    delete view.tokens.horse;
    delete view.tokens.torch;
    delete view.tokens.pony;
    return view;
  }

  test("says what the list is for, in the Empty look, and nothing to press", () => {
    const markup = render(alone(), true, { role: "player", memberId: "pat" });
    assert.match(markup, /<p style="[^"]*color:[^"]*">Nothing within 5 ft to ride, carry or drag\.<\/p>/);
    assert.doesNotMatch(markup, /<button/);
  });

  test("tells a player, as help under it, how a grappled creature joins it, and the DM only what it is for", () => {
    const player = render(alone(), true, { role: "player", memberId: "pat" });
    assert.match(player, /Nothing within 5 ft to ride, carry or drag\.<\/p><\/div><p[^>]*>A grappled creature can be dragged once the DM marks it Grappled\.<\/p>/);
    const dm = render(alone(), false);
    assert.match(dm, /Nothing within 5 ft to ride, carry or drag\./);
    assert.doesNotMatch(dm, /grappled creature/);
  });
});
