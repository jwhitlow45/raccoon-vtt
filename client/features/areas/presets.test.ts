import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { AREA_SPELLS } from "#shared/srd/area-spells.ts";
import { newDraft, type AreaDraft } from "./placement.ts";
import { placedAtPoint, placementHint, presetDraft } from "./presets.ts";

const spell = (name: string) => AREA_SPELLS.find((s) => s.name === name)!;
const draft = (patch: Partial<AreaDraft> = {}): AreaDraft => ({ ...newDraft("d", "cone", "#fff"), ...patch });

describe("a spell keeps who the area is cast from (docs/design-v1-area-from-character.md 3.4)", () => {
  test("off, a spell, then on comes back from the same creature", () => {
    const off = draft({ point: { x: 4, y: 4, z: 0 }, lastCaster: "thorn" });
    const hands = presetDraft(spell("Burning Hands"), off, undefined);
    assert.equal(hands.casterId, undefined, "still off: a spell never falls back to another caster");
    assert.equal(hands.fromId, undefined);
    assert.equal(hands.lastCaster, "thorn");
  });

  test("a spell cast from a creature makes it the one to cast from again", () => {
    const d = presetDraft(spell("Fireball"), draft({ lastCaster: "pip" }), "thorn");
    assert.equal(d.casterId, "thorn");
    assert.equal(d.lastCaster, "thorn");
  });
});

describe("a cube spell placed at a point", () => {
  test("Entangle and Black Tentacles are, Thunderwave and a plain cube are not", () => {
    assert.equal(placedAtPoint(presetDraft(spell("Entangle"), draft(), "thorn")), true);
    assert.equal(placedAtPoint(presetDraft(spell("Black Tentacles"), draft(), "thorn")), true);
    assert.equal(placedAtPoint(presetDraft(spell("Thunderwave"), draft(), "thorn")), false);
    assert.equal(placedAtPoint(draft({ shape: "cube" })), false);
    assert.equal(placedAtPoint({ ...presetDraft(spell("Entangle"), draft(), undefined), fromId: "goblin" }), false, "once cast from an edge, it is not");
  });

  test("its hint, with your creature as its caster, says a tap on a creature centers it", () => {
    const entangle = presetDraft(spell("Entangle"), draft(), "thorn");
    assert.equal(placementHint(entangle, true), "Tap the middle of the square, or a creature to center it there.");
    assert.equal(placementHint(entangle), "Tap a token to cast from it, or tap the middle of the square.");
    assert.equal(placementHint({ ...entangle, casterId: undefined }, true), "Tap a token to cast from it, or tap the middle of the square.");
  });
});
