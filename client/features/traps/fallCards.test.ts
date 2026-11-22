import "../../components/testing/register.ts";
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { Fall, RoomState } from "#shared/model.ts";
import { character, room, scene, token } from "#shared/testutil.ts";
import { deskFalls, fallRead, foldedWithFalls, type FallNames } from "./desk.ts";

const { fallAlerts } = await import("./alerts.ts");
const { fallStart, FallCard } = await import("./FallCard.tsx");
const { createElement } = await import("react");
const { renderToStaticMarkup } = await import("react-dom/server");
const { createStore } = await import("zustand/vanilla");
const { RoomProvider } = await import("../../state/view.ts");
const { RoomScope, RoomScopeProvider } = await import("../../state/scope.ts");
const { deskDrawnIds, deskUnnamed } = await import("../rolls/DmDesk.tsx");

/*
 * The DM's fall cards (docs/design/design-v1-floors.md phase 4, 4.4): their
 * order on the desk, their words for a creature the DM's copy holds, one on
 * another scene and one no longer on the map, the folded button, and its
 * buttons.
 */

const NO_LABELS = new Map();

/** Tower's two floors and Crypt, a scene of its own, the DM looking at Tower's Upper floor. Thorn fell to Ground floor. */
function view(over: Partial<RoomState> = {}): RoomState {
  return room({
    scenes: {
      ground: scene("ground", { name: "Tower", floor: { of: "ground", level: 0, name: "Ground floor" } }),
      upper: scene("upper", { name: "Tower", order: 1, floor: { of: "ground", level: 1, name: "Upper floor" } }),
      crypt: scene("crypt", { name: "Crypt", order: 2, floor: { of: "crypt", level: 0, name: "Vault" } }),
      crypt2: scene("crypt2", { name: "Crypt", order: 3, floor: { of: "crypt", level: 1, name: "Nave" } }),
    },
    characters: { c1: character("c1", { name: "Thorn", ownerIds: ["p1"] }) },
    tokens: { thorn: token("thorn", { sceneId: "ground", kind: "pc", name: "Thorn", ownerIds: ["p1"], actor: { ref: "c1" } }) },
    ...over,
  });
}

const card = (over: Partial<Fall> = {}): Fall => {
  const made = over.made ?? 120;
  return { id: `${made}:0`, rev: 0, tokenId: "thorn", sceneId: "ground", from: "upper", ft: 10, made, ...over };
};

describe("fall cards on the DM desk", () => {
  test("newest first, by the op each fell in and then its place among that op's cards", () => {
    const cards = [card({ made: 120 }), card({ made: 130 }), { ...card({ made: 130 }), id: "130:1" }, card({ made: 9 })];
    assert.deepEqual(
      deskFalls(Object.fromEntries(cards.map((c) => [c.id, c]))).map((c) => c.id),
      ["130:1", "130:0", "120:0", "9:0"],
    );
    assert.deepEqual(deskFalls(undefined), []);
  });

  test("a creature the copy holds: its name, the drop and what Apply will do", () => {
    const read = fallRead(view(), card(), "upper", NO_LABELS);
    assert.equal(read.kind, "here");
    assert.equal(read.line, "Thorn fell 10 ft to Ground floor: 1d6 Bludgeoning, Prone.");
    assert.equal(read.region, "Fall: Thorn");
    assert.equal(read.whose, "Thorn's fall");
    assert.equal(read.dice, 1);
    const short = fallRead(view(), card({ ft: 5 }), "upper", NO_LABELS);
    assert.equal(short.line, "Thorn fell 5 ft to Ground floor: no damage.");
    assert.equal(short.dice, 0, "no Apply under 10 ft");
  });

  test("a creature on another scene, which the copy holds only once the DM goes there, and one no longer on the map", () => {
    const away = fallRead(view(), card({ tokenId: "imp", sceneId: "crypt" }), "upper", NO_LABELS);
    assert.deepEqual([away.kind, away.line, away.region], ["elsewhere", "A creature fell 10 ft to Vault on Crypt.", "Fall: a creature"]);
    const gone = fallRead(view(), card({ tokenId: "wolf" }), "upper", NO_LABELS);
    assert.deepEqual([gone.kind, gone.line, gone.whose], ["gone", "A creature fell 10 ft to Ground floor and is not on this scene now.", "this fall"]);
    assert.equal(fallRead(view(), card({ tokenId: "wolf" }), "crypt2", NO_LABELS).kind, "elsewhere", "from Crypt, Tower's creatures are not in the copy");
  });

  test("a creature moved to another scene keeps the name this device read off it, and Apply comes back once its scene shows (LP46A-FALL-2)", () => {
    const known: FallNames = new Map();
    const giant = card({ tokenId: "giant" });
    const onTower = view({ tokens: { ...view().tokens, giant: token("giant", { sceneId: "ground", name: "Giant" }) } });
    assert.equal(fallRead(onTower, giant, "upper", NO_LABELS, known).kind, "here");
    const { giant: _moved, ...left } = onTower.tokens;
    const moved = fallRead(view({ tokens: left }), giant, "upper", NO_LABELS, known);
    assert.deepEqual([moved.kind, moved.line, moved.region, moved.whose], ["gone", "Giant fell 10 ft to Ground floor and is not on this scene now.", "Fall: Giant", "Giant's fall"]);
    assert.deepEqual(moved.tokenIds, [], "no Apply where the group save cannot reach it");
    const onCave = view({ tokens: { giant: token("giant", { sceneId: "cave", name: "Giant" }) } });
    const there = fallRead(onCave, giant, "cave", NO_LABELS, known);
    assert.deepEqual([there.kind, there.tokenIds], ["here", ["giant"]], "named with Apply on its scene");
    const unread = fallRead(view({ tokens: left }), giant, "upper", NO_LABELS, new Map());
    assert.equal(unread.line, "A creature fell 10 ft to Ground floor and is not on this scene now.", "a device that never read it, as after a reload");
  });

  test("a mount and its rider moved away read as both, by the names last read", () => {
    const known: FallNames = new Map();
    const both = card({ tokenId: "horse", riders: ["bree"] });
    const held = view({ tokens: { ...view().tokens, horse: token("horse", { sceneId: "ground", name: "Horse" }), bree: token("bree", { sceneId: "ground", name: "Bree" }) } });
    fallRead(held, both, "upper", NO_LABELS, known);
    const away = fallRead(view(), both, "upper", NO_LABELS, known);
    assert.equal(away.line, "Horse and Bree fell 10 ft to Ground floor and are not on this scene now.");
  });

  test("riders that fell with it (D-261120-007): each named, Apply's rows each one the copy holds, the first still there leading", () => {
    const withMount = view({
      tokens: {
        ...view().tokens,
        horse: token("horse", { sceneId: "ground", name: "Horse" }),
        bree: token("bree", { sceneId: "ground", name: "Bree" }),
        pip: token("pip", { sceneId: "ground", name: "Pip" }),
        ida: token("ida", { sceneId: "ground", name: "Ida" }),
      },
    });
    const two = fallRead(withMount, card({ tokenId: "horse", riders: ["thorn"] }), "upper", NO_LABELS);
    assert.deepEqual([two.kind, two.line, two.region, two.whose, two.tokenIds], ["here", "Horse and Thorn fell 10 ft to Ground floor: each 1d6 Bludgeoning, Prone.", "Fall: Horse and Thorn", "Horse and Thorn's fall", ["horse", "thorn"]]);
    const many = fallRead(withMount, card({ tokenId: "horse", riders: ["thorn", "bree", "pip", "ida", "gone"] }), "upper", NO_LABELS);
    assert.equal(many.line, "Horse, Thorn, Bree and 2 more fell 10 ft to Ground floor: each 1d6 Bludgeoning, Prone.");
    assert.deepEqual(many.tokenIds, ["horse", "thorn", "bree", "pip", "ida"], "a rider no longer on the map has no row");
    const mountGone = fallRead(view(), card({ tokenId: "horse", riders: ["thorn"] }), "upper", NO_LABELS);
    assert.deepEqual([mountGone.kind, mountGone.line, mountGone.tokenIds], ["here", "Thorn fell 10 ft to Ground floor: 1d6 Bludgeoning, Prone.", ["thorn"]], "a rider still takes the fall of a mount gone since");
    assert.deepEqual(fallStart(card({ tokenId: "horse", riders: ["thorn"] }), two.tokenIds).source, { kind: "fall", fallId: "120:0", tokenIds: ["horse", "thorn"] });
  });

  test("a character shown by two tokens is named once, in the card, its region, its buttons and the toast, while Apply keeps both tokens (LP47B-FALL-1)", () => {
    const twice = view({
      tokens: {
        ...view().tokens,
        horse: token("horse", { sceneId: "ground", name: "Horse" }),
        carried: token("carried", { sceneId: "ground", kind: "pc", name: "Thorn", ownerIds: ["p1"], actor: { ref: "c1" } }),
      },
    });
    const c = card({ tokenId: "horse", riders: ["thorn", "carried"] });
    const read = fallRead(twice, c, "upper", NO_LABELS);
    assert.deepEqual([read.line, read.region, read.whose], ["Horse and Thorn fell 10 ft to Ground floor: each 1d6 Bludgeoning, Prone.", "Fall: Horse and Thorn", "Horse and Thorn's fall"]);
    assert.deepEqual(read.tokenIds, ["horse", "thorn", "carried"]);
    const alone = fallRead(twice, card({ tokenId: "thorn", riders: ["carried"] }), "upper", NO_LABELS);
    assert.equal(alone.line, "Thorn fell 10 ft to Ground floor: 1d6 Bludgeoning, Prone.");
    assert.deepEqual(fallAlerts([c], twice, "upper", NO_LABELS).map((a) => a.text), ["Horse and Thorn fell 10 ft to Ground floor."]);
  });

  test("two tokens of one character read as one name once both have left the scene shown too (LP47B-FALL-1)", () => {
    const known: FallNames = new Map();
    const withTwo = view({
      tokens: {
        ...view().tokens,
        horse: token("horse", { sceneId: "ground", name: "Horse" }),
        carried: token("carried", { sceneId: "ground", kind: "pc", name: "Thorn", ownerIds: ["p1"], actor: { ref: "c1" } }),
      },
    });
    const c = card({ tokenId: "horse", riders: ["thorn", "carried"] });
    assert.equal(fallRead(withTwo, c, "upper", NO_LABELS, known).line, "Horse and Thorn fell 10 ft to Ground floor: each 1d6 Bludgeoning, Prone.");
    const gone = fallRead(view({ tokens: {} }), c, "upper", NO_LABELS, known);
    assert.deepEqual([gone.kind, gone.line, gone.region, gone.whose], ["gone", "Horse and Thorn fell 10 ft to Ground floor and are not on this scene now.", "Fall: Horse and Thorn", "Horse and Thorn's fall"]);
  });

  test("Apply's page: the creature that fell, by the card's id, in the Dice panel", () => {
    const input = fallStart(card(), ["thorn"]);
    assert.deepEqual(input.source, { kind: "fall", fallId: "120:0", tokenIds: ["thorn"] });
    assert.equal(input.panel, "dice");
    assert.deepEqual(input.test, { kind: "none" });
    assert.equal(input.outcome?.damage, "1d6 Bludgeoning");
  });

  test("the folded button counts falls as it counts traps", () => {
    assert.equal(foldedWithFalls(null, 0, "more"), null);
    assert.deepEqual(foldedWithFalls(null, 2, "sheet"), { text: "2 falls", label: "2 falls: 2 creatures fell. Close the sheet to see them." });
    assert.deepEqual(foldedWithFalls({ text: "Rolls 1/3", label: "Rolls 1/3: 1 of 3 answered" }, 1, "more"), { text: "1 fall, Rolls 1/3", label: "1 fall, Rolls 1/3: 1 more creature fell, 1 of 3 answered" });
  });

  test("the summary names falls after traps and before asks, and the column draws them in that order", () => {
    assert.equal(deskUnnamed({ traps: 1, falls: 2, asks: 1, cards: 0 }), 3);
    assert.equal(deskUnnamed({ traps: 0, falls: 2, asks: 1, cards: 3 }), 4, "the falls lead with no trap");
    assert.equal(deskUnnamed({ traps: 0, falls: 0, asks: 2, cards: 3 }), 3);
    assert.deepEqual(deskDrawnIds({ traps: [{ due: { id: "s1" } }], falls: [{ id: "120:0" }], asks: [{ id: "a1" }], cards: [], button: false }), ["trap:s1", "fall:120:0", "cast:a1"]);
  });
});

describe("the fall card's buttons", () => {
  function markup(c: Fall, sceneId = "upper"): string {
    const store = createStore(() => ({ view: view(), you: { role: "dm", memberId: "dm1" }, sceneId }));
    const element = createElement(FallCard, { card: c, open: true, onToggle() {}, toggleRef() {}, onDismiss() {} });
    return renderToStaticMarkup(createElement(RoomProvider, { store: store as never, actions: {} as never, ui: {} as never, children: createElement(RoomScopeProvider, { scope: new RoomScope(), children: element }) }));
  }
  const buttons = (html: string) => [...html.matchAll(/<button[^>]*>(?:<[^>]*>)*([^<]*)</g)].map((m) => m[1]).filter((t) => t !== "");

  test("a region named for its creature, found by its card's id, titled Fall", () => {
    const html = markup(card());
    assert.match(html, /role="region" aria-label="Fall: Thorn" data-fall-card="120:0"/);
    assert.deepEqual(buttons(html), ["Fall", "Apply", "Dismiss"]);
    assert.match(html, /aria-label="Dismiss Thorn&#x27;s fall"/);
    assert.deepEqual(buttons(markup(card({ ft: 5 }))), ["Fall", "Dismiss"], "no damage, nothing to apply");
  });

  test("another scene's card offers Show, and one whose creature left the map Dismiss alone", () => {
    assert.deepEqual(buttons(markup(card({ tokenId: "imp", sceneId: "crypt" }))), ["Fall", "Show", "Dismiss"]);
    assert.deepEqual(buttons(markup(card({ tokenId: "wolf" }))), ["Fall", "Dismiss"]);
  });
});
