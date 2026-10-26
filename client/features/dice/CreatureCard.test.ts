import "../../components/testing/register.ts";
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { theme } from "../../lib/theme.ts";
import type { CreaturePicture } from "../tokens/CreatureHeader.tsx";

const { createElement } = await import("react");
const { renderToStaticMarkup } = await import("react-dom/server");
const { CARD_PICTURES, CreatureCard, DICE_CARD } = await import("./CreatureCard.tsx");

/*
 * The creature card's frame and header (docs/design-v1-dice-pass.md 5),
 * drawn from props alone, so it renders here with no Room around it.
 */

const picture = (initials: string, overrides: Partial<CreaturePicture> = {}): CreaturePicture => ({ image: undefined, shape: "circle", aspect: 1, ring: theme.color.hostile, initials, ...overrides });

function card(props: Parameters<typeof CreatureCard>[0]): string {
  return renderToStaticMarkup(createElement(CreatureCard, props));
}

/** Each drawn picture's width, in the order drawn. */
function widths(markup: string): number[] {
  return [...markup.matchAll(/width:(\d+)px;height:\d+px/g)].map((m) => Number(m[1]));
}

describe("the creature card", () => {
  test("is marked, and framed in the page's background inside one outline, 12 px in", () => {
    assert.equal(DICE_CARD, "[data-dice-card]");
    const markup = card({ name: "Thorn" });
    assert.match(markup, /^<div data-dice-card=""/);
    assert.match(markup, new RegExp(`padding:${theme.space(3)}px;background:${theme.color.bg};border:1px solid ${theme.color.border};border-radius:${theme.radius.md}px`));
  });

  test("one creature: its picture at 48 px, then its name as the h3 and the kind line, then the body", () => {
    const markup = card({
      pictures: [picture("AB")],
      name: "Adult Black Dragon",
      line: { kind: "Monster, CR 14", size: "Huge (15 ft)" },
      children: createElement("p", { id: "body" }, "Initiative +2"),
    });
    assert.deepEqual(widths(markup), [48]);
    assert.match(markup, /<h3 style="[^"]*font-size:18px;font-weight:700[^"]*">Adult Black Dragon<\/h3>/);
    // The size stays whole on one line, so a wrapped line never leaves "ft)" alone (FU32-FT-ALONE).
    assert.match(markup, /<p data-kind-line="" style="[^"]*font-size:13px[^"]*">Monster, CR 14 · <span style="white-space:nowrap">Huge \(15 ft\)<\/span><\/p>/);
    assert.ok(markup.indexOf("Adult Black Dragon") < markup.indexOf("Monster, CR 14"));
    assert.ok(markup.indexOf("Huge (15 ft)") < markup.indexOf('id="body"'), "the body under the header");
    assert.match(markup, /<span aria-hidden="true"/, "the picture is decoration");
  });

  test("a companion: its character's portrait as a 20 px badge, ringed in the card's fill, and the character's name its own part of the line", () => {
    const markup = card({
      pictures: [picture("Wo", { ring: theme.color.ally })],
      // An uploaded portrait reads the Room's assets, so a shipped icon stands in for it.
      badge: { image: { icon: "wolf", color: theme.color.neutral }, initials: "Th" },
      name: "Wolf",
      line: { kind: "Companion of Thorn", size: "Medium (5 ft)", companionOf: "Thorn" },
    });
    assert.match(markup, new RegExp(`outline:${theme.line.strong}px solid ${theme.color.bg}`));
    assert.doesNotMatch(markup, new RegExp(theme.color.surface), "never the panel's surface, which the card does not wear");
    assert.match(markup, /<span>Companion of Thorn<\/span> · <span style="white-space:nowrap">Medium \(5 ft\)<\/span>/);
  });

  test("several selected: up to three 32 px pictures, each after the first overlapping by 8 px, and no badge", () => {
    const markup = card({
      pictures: [picture("G1"), picture("G2"), picture("Ow"), picture("G3")],
      badge: { image: undefined, initials: "X" },
      name: "4 selected",
      line: "Goblin 1, Goblin 2, Owlbear, Goblin 3",
    });
    assert.equal(CARD_PICTURES, 3);
    assert.deepEqual(widths(markup), [32, 32, 32]);
    assert.equal([...markup.matchAll(/margin-left:-8px/g)].length, 2);
    assert.equal([...markup.matchAll(new RegExp(`outline:${theme.line.strong}px solid ${theme.color.bg}`, "g"))].length, 2, "each overlapping picture parted from the one under it");
    assert.ok(!markup.includes(">X<"), "no badge among several");
    assert.match(markup, /<h3[^>]*>4 selected<\/h3>/);
    assert.match(markup, /<p data-kind-line=""[^>]*>Goblin 1, Goblin 2, Owlbear, Goblin 3<\/p>/);
  });

  test("a square picture keeps its corners when it overlaps", () => {
    const markup = card({ pictures: [picture("G1"), picture("Cr", { shape: "square" })], name: "2 selected" });
    assert.match(markup, new RegExp(`margin-left:-8px;border-radius:${theme.radius.sm}px`));
  });

  test("a player's tabs stand in for the picture and the name: the tabs, then the kind line, then the body", () => {
    const markup = card({
      tabs: createElement("div", { role: "tablist", "aria-label": "Roll for" }, "Thorn Wolf"),
      line: { kind: "Level 5 character", size: "Medium (5 ft)" },
      children: createElement("p", { id: "body" }, "Death Save"),
    });
    assert.ok(!markup.includes("<h3"), "the tabs name the creature, so no heading says it twice");
    assert.deepEqual(widths(markup), []);
    const tabs = markup.indexOf('role="tablist"');
    const line = markup.indexOf("Level 5 character");
    const body = markup.indexOf('id="body"');
    assert.ok(tabs >= 0 && tabs < line && line < body);
  });

  test("nothing to roll for: the frame around its note alone", () => {
    const markup = card({ children: createElement("p", null, "Select a token to roll for it.") });
    assert.match(markup, /^<div data-dice-card="" style="[^"]*"><p>Select a token to roll for it\.<\/p><\/div>$/);
  });

  test("the header shows with no body, as while the options load", () => {
    const markup = card({ pictures: [picture("Th")], name: "Thorn", line: { kind: "Level 5 character", size: "Medium (5 ft)" } });
    assert.match(markup, /Thorn<\/h3>/);
    assert.match(markup, /Level 5 character · <span style="white-space:nowrap">Medium \(5 ft\)<\/span>/);
  });
});
