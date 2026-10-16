import "../../components/testing/register.ts";
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { createStore } from "zustand/vanilla";
import { actor, character, room, token } from "#shared/testutil.ts";
import { partyEntries } from "./party.ts";

/*
 * The folded party bar's pills are buttons that frame a character's token.
 * With `role="listitem"` on each button, its list item role replaced its
 * button role, and a screen reader heard nothing to press (LPD-REGRESS-4).
 * Each pill is a button inside a list item of its own.
 */

const { createElement } = await import("react");
const { renderToStaticMarkup } = await import("react-dom/server");
const { Entry, FoldedParty } = await import("./PartyBar.tsx");
const { RoomProvider } = await import("../../state/view.ts");
const { RoomScope, RoomScopeProvider } = await import("../../state/scope.ts");

describe("the folded party bar", () => {
  test("is a list of items, each holding a button that keeps its button role", () => {
    const state = room({
      characters: {
        ayla: character("ayla", { name: "Ayla", ownerIds: ["p1"], actor: actor({ hp: { cur: 18, max: 24, temp: 0 } }) }),
        bram: character("bram", { name: "Bram", ownerIds: ["p2"] }),
      },
      tokens: { a1: token("a1", { kind: "pc", sceneId: "s1", actor: { ref: "ayla" } }) },
    });
    const markup = renderToStaticMarkup(createElement(FoldedParty, { entries: partyEntries(state, "s1"), onFrame: () => {} }));
    assert.match(markup, /^<div role="list"/);
    const items = [...markup.matchAll(/<div role="listitem"[^>]*>(<[a-z]+)([^>]*)>/g)];
    assert.equal(items.length, 2);
    for (const [, tag, attrs] of items) {
      assert.equal(tag, "<button", "a list item holds the pill's button");
      assert.doesNotMatch(attrs ?? "", /\brole=/, "the button keeps its own role");
    }
    assert.match(markup, /aria-label="Ayla, HP 18\/24\. Show it on the map"/);
  });
});

describe("a party member's row", () => {
  const rowOf = (life: "alive" | "dead") => {
    const state = room({
      characters: { ayla: character("ayla", { name: "Ayla", ownerIds: ["p1"], actor: actor({ ac: 15, passivePerception: 13, life, hp: { cur: life === "dead" ? 0 : 18, max: 24, temp: 0 } }) }) },
      tokens: { a1: token("a1", { kind: "pc", sceneId: "s1", actor: { ref: "ayla" } }) },
    });
    const [entry] = partyEntries(state, "s1");
    assert.ok(entry);
    // The row's portrait reads the room's view.
    const store = createStore(() => ({ view: state, you: { role: "dm" } }));
    const row = createElement(Entry, { entry, onFrame: () => {} });
    return renderToStaticMarkup(createElement(RoomProvider, { store: store as never, actions: {} as never, ui: {} as never, children: createElement(RoomScopeProvider, { scope: new RoomScope(), children: row }) }));
  };

  test("shows AC on the shield and Passive Perception as PP", () => {
    const markup = rowOf("alive");
    assert.match(markup, /role="img" aria-label="Armor Class 15"/);
    assert.match(markup, /aria-label="Ayla: HP 18\/24, AC 15, Passive Perception 13\. Show it on the map"/);
    assert.match(markup, />Passive Perception 13</);
  });

  test("hides a dead member's AC, as the token and the tracker do", () => {
    const markup = rowOf("dead");
    assert.doesNotMatch(markup, /Armor Class/);
    assert.doesNotMatch(markup, /AC 15/);
  });
});
