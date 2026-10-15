import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { entry, reveal, room, scene, token } from "#shared/testutil.ts";
import { projectState } from "#shared/project.ts";
import { screenToWorld } from "../../lib/camera.ts";
import { revealedMask } from "../../lib/fogTiles.ts";
import { codeFromHash, displayPress, endedText, fitMapTarget, followCamera, formatDisplayCode, normalizeDisplayCode, refitAt, REFIT_MS, turnText } from "./logic.ts";

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
    assert.equal(displayPress({ overlay: "handout", menu: false, key: false }), "closeOverlay");
    assert.equal(displayPress({ overlay: "xcard", menu: false, key: true }), "closeOverlay");
    assert.equal(displayPress({ overlay: null, menu: false, key: false }), "openMenu");
    assert.equal(displayPress({ overlay: null, menu: false, key: true }), "openMenu", "any key shows the menu");
    assert.equal(displayPress({ overlay: null, menu: true, key: false }), "closeMenu");
    assert.equal(displayPress({ overlay: null, menu: true, key: true }), "menuKey", "a remote's keys work the menu");
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

describe("the end of a display", () => {
  test("a display paired with another room in another tab says it moved, not that the DM signed it out", () => {
    assert.equal(endedText("revoked", "ROOMBBBB").title, "This display now shows another room");
    assert.equal(endedText("revoked", null).title, "This display was signed out");
    assert.equal(endedText("deleted", "ROOMBBBB").title, "This room was deleted", "a deleted room says so whatever this device shows");
    assert.equal(endedText("denied", null).title, "The room refused this display");
  });
});
