import "../../components/testing/register.ts";
import assert from "node:assert/strict";
import { describe, test } from "node:test";
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
const { FoldedParty } = await import("./PartyBar.tsx");

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
