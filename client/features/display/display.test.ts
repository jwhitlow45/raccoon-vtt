import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { entry, reveal, room, scene, token } from "#shared/testutil.ts";
import { projectState } from "#shared/project.ts";
import { screenToWorld } from "../../lib/camera.ts";
import { pageName } from "../handouts/handouts.ts";
import { revealedMask } from "../../lib/fogTiles.ts";
import {
  barEnabled,
  barFirstFocus,
  barFocusAfter,
  barMove,
  codeFromHash,
  containRect,
  displayPress,
  endedText,
  fitMapTarget,
  followCamera,
  formatDisplayCode,
  normalizeDisplayCode,
  pageLine,
  refitAt,
  REFIT_MS,
  stepPage,
  turnText,
} from "./logic.ts";

describe("display codes", () => {
  test("typed loosely, read as the server reads them", () => {
    assert.equal(normalizeDisplayCode("K7QH 2MXA 4F"), "K7QH2MXA4F");
    assert.equal(normalizeDisplayCode("k7qh-2mxa-4f"), "K7QH2MXA4F");
    assert.equal(normalizeDisplayCode("K7QH 2MXA 4O"), "K7QH2MXA40", "O reads as zero");
    assert.equal(normalizeDisplayCode("K7QH 2MXA 4I"), "K7QH2MXA41", "I reads as one");
    assert.equal(normalizeDisplayCode("K7QH 2MXA 4U"), null, "U is not in the alphabet");
    assert.equal(normalizeDisplayCode("K7QH 2MXA"), null, "too short");
    assert.equal(normalizeDisplayCode("x".repeat(41)), null);
    assert.equal(formatDisplayCode("K7QH2MXA4F"), "K7QH 2MXA 4F");
    assert.equal(formatDisplayCode("k7qh2m"), "K7QH 2M");
  });

  test("an Open on this device link carries its code in the fragment", () => {
    assert.equal(codeFromHash("#code=K7QH2MXA4F"), "K7QH2MXA4F");
    assert.equal(codeFromHash("#x=1&code=k7qh%202mxa%204f"), "K7QH2MXA4F");
    assert.equal(codeFromHash("#code=nope"), null);
    assert.equal(codeFromHash("#code=%E0%A4%A"), null, "a broken escape is no code");
    assert.equal(codeFromHash(""), null);
  });
});

describe("the display's camera", () => {
  const view = { x: 20, y: 15, w: 9, h: 19.5 };

  test("Follow the DM fits the DM's area to a TV and to a phone, the whole area in view", () => {
    for (const viewport of [
      { width: 1920, height: 1080 },
      { width: 390, height: 844 },
      { width: 844, height: 390 },
    ]) {
      const cam = followCamera(viewport, view);
      const tl = screenToWorld(cam, { x: 0, y: 0 });
      const br = screenToWorld(cam, { x: viewport.width, y: viewport.height });
      assert.ok(tl.x <= view.x - view.w / 2 + 1e-9 && tl.y <= view.y - view.h / 2 + 1e-9, `${viewport.width}x${viewport.height} keeps the top left`);
      assert.ok(br.x >= view.x + view.w / 2 - 1e-9 && br.y >= view.y + view.h / 2 - 1e-9, `${viewport.width}x${viewport.height} keeps the bottom right`);
      const center = screenToWorld(cam, { x: viewport.width / 2, y: viewport.height / 2 });
      assert.ok(Math.abs(center.x - view.x) < 1e-9 && Math.abs(center.y - view.y) < 1e-9, "centered on the DM's center");
      // One side fits exactly: the same area, not the same pixels per cell.
      const fitsWidth = Math.abs(br.x - tl.x - view.w) < 1e-6;
      const fitsHeight = Math.abs(br.y - tl.y - view.h) < 1e-6;
      assert.ok(fitsWidth || fitsHeight);
    }
    // A portrait phone's view on a wide TV is fitted by its height.
    const tv = followCamera({ width: 1920, height: 1080 }, view);
    assert.ok(Math.abs(1080 / tv.scale - view.h) < 1e-6);
  });

  test("Fit the map fits the revealed ground and the party's tokens, never other tokens", () => {
    const state = room({
      scenes: { s1: scene("s1", { fogEnabled: true, bounds: { w: 60, h: 40 } }), s2: scene("s2") },
      tokens: {
        hero: token("hero", { kind: "pc", x: 40, y: 30, ownerIds: ["p1"] }),
        dmOwned: token("dmOwned", { x: 50, y: 5, ownerIds: ["dm1"] }),
        seenMonster: token("seenMonster", { x: 3, y: 3 }),
      },
    });
    reveal(state, "s1", { x: 2, y: 2, w: 8, h: 6 });
    // What a display holds: a player's projection for someone who owns nothing.
    const projected = projectState(state, { memberId: "display:abc", role: "player" }, { sceneId: null });
    assert.equal((projected.tokens.hero as { party?: true }).party, true);
    assert.equal((projected.tokens.seenMonster as { party?: true }).party, undefined);
    const target = fitMapTarget({ bounds: { w: 60, h: 40 }, revealed: revealedMask({ w: 60, h: 40 }, "s1", projected.fogTiles), tokens: Object.values(projected.tokens), sceneId: "s1" });
    // Revealed 2..10 x 2..8 and the hero at 40..41 x 30..31, a cell of room around them.
    assert.deepEqual(target, { x: 1, y: 1, width: 41, height: 31 });
    assert.deepEqual(
      fitMapTarget({ bounds: { w: 60, h: 40 }, revealed: null, tokens: Object.values(projected.tokens), sceneId: "s1" }),
      { x: 0, y: 0, width: 60, height: 40 },
      "with fog off, the whole scene",
    );
  });

  test("a changed area refits at most once every 2 s", () => {
    const a = { x: 0, y: 0, width: 10, height: 10 };
    const b = { x: 0, y: 0, width: 20, height: 10 };
    assert.equal(refitAt({ target: a, applied: a, appliedAt: 0, now: 100 }), null, "nothing new");
    assert.equal(refitAt({ target: b, applied: a, appliedAt: 0, now: 5_000 }), 5_000, "long enough ago: at once");
    assert.equal(refitAt({ target: b, applied: a, appliedAt: 4_000, now: 4_500 }), 4_000 + REFIT_MS, "else when 2 s have passed");
    assert.equal(refitAt({ target: a, applied: null, appliedAt: 0, now: 10 }), 10, "the first fit is at once");
  });
});

describe("a tap on the display", () => {
  test("a tap on an open handout or X-card closes it and nothing else, and the next opens the menu", () => {
    assert.equal(displayPress({ overlay: "handout", menu: false, key: null }), "closeOverlay");
    assert.equal(displayPress({ overlay: "xcard", menu: false, key: "Enter" }), "closeOverlay");
    assert.equal(displayPress({ overlay: null, menu: false, key: null }), "openMenu");
    assert.equal(displayPress({ overlay: null, menu: false, key: "Enter" }), "openMenu", "any key shows the menu");
    assert.equal(displayPress({ overlay: null, menu: true, key: null }), "closeMenu");
    assert.equal(displayPress({ overlay: null, menu: true, key: "Enter" }), "menuKey", "a remote's keys work the menu");
  });

  test("whose turn it is, when the display may see the creature that acts", () => {
    const state = room({ tokens: { g: token("g", { name: "Goblin", number: 2 }) } });
    const encounter = { round: 1, activeEntryId: "e1", entries: [entry("e1", { tokenId: "g" })], started: true } as unknown as NonNullable<typeof state.encounter>;
    assert.equal(turnText({ encounter, tokens: state.tokens, characters: {} }), "Turn: Goblin 2");
    assert.equal(turnText({ encounter: { ...encounter, activeEntryId: null }, tokens: state.tokens, characters: {} }), null);
    assert.equal(turnText({ encounter: { ...encounter, activeEntryId: "hidden" }, tokens: state.tokens, characters: {} }), null, "a row the display does not hold names no one");
    assert.equal(turnText({ encounter: null, tokens: {}, characters: {} }), null);
  });
});

describe("a handout of pages on the display", () => {
  const press = (key: string | null, paging: { page: number; bar: boolean; pages?: number }) =>
    displayPress({ overlay: "handout", menu: false, key, paging: { pages: 3, ...paging } });

  test("a tap on a document opens the bar, and a tap beside the open bar hides it", () => {
    assert.equal(press(null, { page: 0, bar: false }), "openBar");
    assert.equal(press(null, { page: 2, bar: true }), "hideBar");
  });

  test("the page keys step and stop at the ends", () => {
    for (const key of ["ArrowRight", "ArrowDown", "PageDown"]) {
      assert.equal(press(key, { page: 0, bar: false }), "nextPage", key);
      assert.equal(press(key, { page: 1, bar: false }), "nextPage", key);
      assert.equal(press(key, { page: 2, bar: false }), "none", `${key} on the last page`);
    }
    for (const key of ["ArrowLeft", "ArrowUp", "PageUp"]) {
      assert.equal(press(key, { page: 2, bar: false }), "previousPage", key);
      assert.equal(press(key, { page: 0, bar: false }), "none", `${key} on page 1`);
    }
    assert.equal(stepPage(0, 3, 1), 1);
    assert.equal(stepPage(2, 3, 1), 2, "no page after the last");
    assert.equal(stepPage(0, 3, -1), 0, "no page before the first");
  });

  test("PageUp and PageDown still step with the bar open, and stop at the ends", () => {
    assert.equal(press("PageDown", { page: 0, bar: true }), "nextPage");
    assert.equal(press("PageUp", { page: 1, bar: true }), "previousPage");
    assert.equal(press("PageDown", { page: 2, bar: true }), "none");
    assert.equal(press("PageUp", { page: 0, bar: true }), "none");
  });

  test("with the bar open the arrows move between its buttons, and Enter is left to press one", () => {
    assert.equal(press("ArrowRight", { page: 1, bar: true }), "barFocusNext");
    assert.equal(press("ArrowDown", { page: 1, bar: true }), "barFocusNext");
    assert.equal(press("ArrowLeft", { page: 1, bar: true }), "barFocusPrevious");
    assert.equal(press("ArrowUp", { page: 1, bar: true }), "barFocusPrevious");
    assert.equal(press("Enter", { page: 1, bar: true }), "barKey");
    assert.equal(press(" ", { page: 1, bar: true }), "barKey");

    // Around the enabled buttons, as in the menu, skipping a disabled page button.
    assert.equal(barMove(1, 3, "previous", 1), "next");
    assert.equal(barMove(1, 3, "next", 1), "close");
    assert.equal(barMove(1, 3, "close", 1), "previous");
    assert.equal(barMove(1, 3, "previous", -1), "close");
    assert.equal(barMove(0, 3, "next", -1), "close", "Previous page is disabled on page 1");
    assert.equal(barMove(0, 3, "close", 1), "next");
    assert.equal(barMove(2, 3, "close", 1), "previous", "Next page is disabled on the last");
    assert.deepEqual(barEnabled(0, 3), ["next", "close"]);
    assert.deepEqual(barEnabled(1, 3), ["previous", "next", "close"]);
    assert.deepEqual(barEnabled(2, 3), ["previous", "close"]);
    // A tap opened the bar, so focus is outside it: the first arrow lands where a key opening it would.
    assert.equal(barMove(0, 3, null, -1), "next");
    assert.equal(barMove(2, 3, null, 1), "close");
  });

  test("any other key opens the bar, with focus on Next page, or on Close on the last page", () => {
    assert.equal(press("Enter", { page: 0, bar: false }), "openBar");
    assert.equal(press("a", { page: 2, bar: false }), "openBar");
    assert.equal(barFirstFocus(0, 3), "next", "never the disabled Previous page");
    assert.equal(barFirstFocus(1, 3), "next");
    assert.equal(barFirstFocus(2, 3), "close");
  });

  test("a page button the new page disables hands focus to the other, never to Close", () => {
    assert.equal(barFocusAfter("next", 2, 3), "previous");
    assert.equal(barFocusAfter("previous", 0, 3), "next");
    assert.equal(barFocusAfter("next", 1, 3), null, "still enabled");
    assert.equal(barFocusAfter("close", 2, 3), null);
    assert.equal(barFocusAfter(null, 2, 3), null, "focus was not on the bar");
  });

  test("Escape hides the bar, and a second Escape closes the handout", () => {
    assert.equal(press("Escape", { page: 1, bar: true }), "hideBar");
    assert.equal(press("Escape", { page: 1, bar: false }), "closeOverlay");
  });

  test("one page is unchanged: a tap or any key closes it", () => {
    for (const key of [null, "Enter", "ArrowRight", "PageDown", "Escape"]) {
      assert.equal(press(key, { page: 0, bar: false, pages: 1 }), "closeOverlay", String(key));
      assert.equal(displayPress({ overlay: "handout", menu: false, key }), "closeOverlay", String(key));
    }
  });

  test("the X-card over a document closes first, whatever the bar", () => {
    for (const key of [null, "Enter", "ArrowRight", "Escape"]) {
      assert.equal(displayPress({ overlay: "xcard", menu: false, key, paging: { pages: 3, page: 1, bar: true } }), "closeOverlay", String(key));
    }
  });

  test("the page line, each page's name, and where a page draws fitted whole", () => {
    assert.equal(pageLine(1, 5), "Page 2 of 5");
    assert.equal(pageName("Strange letter", 1, 5), "Strange letter, page 2 of 5");
    // A Letter page on a wide TV area fills its height, centered across. A landscape page on a phone fills its width, centered down.
    assert.deepEqual(containRect({ width: 1888, height: 900 }, { width: 1584, height: 2048 }), { x: (1888 - (1584 * 900) / 2048) / 2, y: 0, width: (1584 * 900) / 2048, height: 900 });
    const phone = containRect({ width: 358, height: 700 }, { width: 2048, height: 1584 });
    assert.equal(phone.width, 358);
    assert.ok(Math.abs(phone.y - (700 - phone.height) / 2) < 1e-9 && phone.height < 300);
    assert.deepEqual(containRect({ width: 0, height: 0 }, { width: 10, height: 10 }), { x: 0, y: 0, width: 0, height: 0 }, "an area not yet laid out");
  });
});

describe("the end of a display", () => {
  test("a display paired with another room in another tab says it moved, not that the DM signed it out", () => {
    assert.equal(endedText("revoked", "ROOMBBBB").title, "This display now shows another room");
    assert.equal(endedText("revoked", null).title, "This display was signed out");
    assert.equal(endedText("deleted", "ROOMBBBB").title, "This room was deleted", "a deleted room says so whatever this device shows");
    assert.equal(endedText("denied", null).title, "The room refused this display");
  });
});
