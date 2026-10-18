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
const { hasParty } = await import("./PartyDock.tsx");
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

  /*
   * The folded line scrolls sideways (docs/design-v1-side-headers.md 3.2),
   * so Tab must reach every chip for the strip to bring it into view. A
   * chip off the scene was `disabled`, which Tab skips, so a keyboard could
   * never read it.
   */
  test("a chip for a character off the scene stays in Tab's reach and says so, doing nothing when pressed", () => {
    const state = room({
      characters: { bram: character("bram", { name: "Bram", ownerIds: ["p2"], actor: actor({ hp: { cur: 9, max: 12, temp: 0 } }) }) },
      tokens: {},
    });
    let framed = 0;
    const markup = renderToStaticMarkup(createElement(FoldedParty, { entries: partyEntries(state, "s1"), onFrame: () => framed++ }));
    const button = /<button[^>]*>/.exec(markup)?.[0] ?? "";
    assert.doesNotMatch(button, /\sdisabled=""/, "not disabled, so Tab reaches it");
    assert.match(button, /aria-disabled="true"/);
    assert.match(button, /aria-label="Bram, HP 9\/12, not on this scene"/);
    assert.equal(framed, 0);
  });

  test("a long name is cut on its chip and kept whole in its name and tooltip", () => {
    const name = "Bartholomew Underhill of the Long Barrow";
    const state = room({
      characters: { bart: character("bart", { name, ownerIds: ["p1"] }) },
      tokens: { b1: token("b1", { kind: "pc", sceneId: "s1", actor: { ref: "bart" } }) },
    });
    const markup = renderToStaticMarkup(createElement(FoldedParty, { entries: partyEntries(state, "s1"), onFrame: () => {} }));
    assert.match(markup, new RegExp(`title="${name}"`));
    assert.match(markup, new RegExp(`aria-label="${name}, HP`));
    assert.match(markup, /<strong style="max-width:96px;overflow:hidden;text-overflow:ellipsis/);
  });
});

describe("the side panel's party bar", () => {
  test("shows once a player owns a character, not for characters the DM alone owns", () => {
    const owned = (ownerIds: string[]) =>
      room({
        members: { dm: { id: "dm", rev: 1, name: "Dana", color: "#f7df00", kind: "dm", createdAt: "2026-01-01T00:00:00.000Z" }, p1: { id: "p1", rev: 1, name: "Pat", color: "#30a46c", kind: "player", createdAt: "2026-01-01T00:00:00.000Z" } },
        characters: { c: character("c", { name: "Ayla", ownerIds }) },
      });
    assert.equal(hasParty(owned(["p1"])), true);
    assert.equal(hasParty(owned(["dm"])), false, "a character only the DM owns has no row in the bar");
    assert.equal(hasParty(owned([])), false);
    assert.equal(hasParty(room({})), false);
    assert.equal(hasParty(null), false);
  });
});

describe("a party member's row", () => {
  const rowOf = (life: "alive" | "dead", max = 24) => {
    const state = room({
      characters: { ayla: character("ayla", { name: "Ayla", ownerIds: ["p1"], actor: actor({ ac: 15, passivePerception: 13, life, hp: { cur: life === "dead" || max === 0 ? 0 : 18, max, temp: 0 } }) }) },
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

  // A long name took the row's whole width, since the row's text is a grid whose one column grew to it, and every row's HP went past the edge.
  test("keeps its HP in view beside a long name: one column no wider than the row", () => {
    const markup = rowOf("alive");
    assert.match(markup, /display:grid;grid-template-columns:minmax\(0, 1fr\)/);
  });

  test("hides a dead member's AC, as the token and the tracker do", () => {
    const markup = rowOf("dead");
    assert.doesNotMatch(markup, /Armor Class/);
    assert.doesNotMatch(markup, /AC 15/);
  });

  test("hides the AC of a member with no HP to show, who is drawn alive whatever life it stores, as the token and the tracker do (SOL-07)", () => {
    const markup = rowOf("dead", 0);
    assert.doesNotMatch(markup, /Dead/, "drawn alive");
    assert.doesNotMatch(markup, /Armor Class/);
    assert.doesNotMatch(markup, /AC 15/);
  });
});
