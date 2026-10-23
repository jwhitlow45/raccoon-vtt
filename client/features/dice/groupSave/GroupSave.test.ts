import "../../../components/testing/register.ts";
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { theme } from "../../../lib/theme.ts";
import { newPage } from "./chain.ts";

/*
 * The open group save in the Dice panel (docs/design-v1-dice-pass.md 7.8):
 * an info notice with Open, so a DM reads an unfinished group save as a
 * status rather than a sentence among the rolls.
 */

const { createElement } = await import("react");
const { renderToStaticMarkup } = await import("react-dom/server");
const { OpenGroupSave } = await import("./GroupSave.tsx");

const PAGE = newPage({
  id: "p",
  sceneId: "s1",
  source: { kind: "selection", tokenIds: ["g1", "g2"] },
  test: { kind: "save", ability: "dex" },
  dc: 13,
  secret: true,
  spell: false,
  switches: { dcShown: true, resultShown: true },
  outcome: { damage: "", conditions: [], saveEnds: { ability: "con", dc: null } },
});

describe("the open group save's notice (7.8)", () => {
  test("marked for the sweep, an info notice on the raised fill inside its outline, its words and then Open", () => {
    const markup = renderToStaticMarkup(createElement(OpenGroupSave, { page: PAGE, onOpen() {} }));
    assert.match(markup, /^<div data-open-group-save=""/);
    assert.ok(markup.includes(`border:1px solid ${theme.color.border};background:${theme.color.surfaceRaised}`), "the info tone's outline and fill");
    const words = markup.indexOf("Dexterity save for 2: set up.");
    assert.ok(words > 0, "what is open and where it stands");
    const open = markup.search(/<button[^>]*>Open<\/button>/);
    assert.ok(open > words, "Open after the words, as the notice's action");
  });

  test("the words follow the page as it goes: waiting rows once rolled", () => {
    const rolled = { ...PAGE, phase: "rolled" as const };
    const markup = renderToStaticMarkup(createElement(OpenGroupSave, { page: rolled, onOpen() {} }));
    assert.match(markup, /Dexterity save for 2: [a-z0-9 ]+\./);
    assert.doesNotMatch(markup, /set up\./);
  });
});
