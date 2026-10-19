import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { Character } from "#shared/model.ts";
import { characterKind, kindLine, kindLineText, sizeText, tokenKind } from "./creatureKind.ts";

const MEDIUM = sizeText("medium", { w: 1, h: 1 }, 5);

/** A character's actor as the kind line reads it: only whether it is in a shape. */
function thorn(level: number | undefined, shape?: { srdId: string; wild: boolean }): Pick<Character, "level" | "actor"> {
  const actor = { srdId: shape?.srdId, ...(shape?.wild ? { wildShape: true as const } : {}) } as Character["actor"];
  return { ...(level !== undefined ? { level } : {}), actor };
}

describe("the kind line (docs/design-v1-look-pass.md 2.11)", () => {
  test("the size reads as today: its name and feet, a custom size its two sides", () => {
    assert.equal(MEDIUM, "Medium (5 ft)");
    assert.equal(sizeText("large", { w: 2, h: 2 }, 5), "Large (10 ft)");
    assert.equal(sizeText("custom", { w: 2, h: 3 }, 5), "Custom (10 by 15 ft)");
    assert.equal(sizeText("small", { w: 1, h: 1 }, 10), "Small (10 ft)", "the room's feet per square");
  });

  test("a player character with a level, and with none", () => {
    assert.equal(kindLineText(kindLine(characterKind(thorn(5)), MEDIUM)), "Level 5 character · Medium (5 ft)");
    assert.equal(kindLineText(kindLine(characterKind(thorn(undefined)), MEDIUM)), "Character · Medium (5 ft)");
  });

  test("a character in Wild Shape, and in another shape, named from the SRD id with no load", () => {
    const large = sizeText("large", { w: 2, h: 2 }, 5);
    assert.equal(kindLineText(kindLine(characterKind(thorn(5, { srdId: "brown-bear", wild: true })), large)), "Level 5 character in Wild Shape as Brown Bear · Large (10 ft)");
    assert.equal(kindLineText(kindLine(characterKind(thorn(5, { srdId: "brown-bear", wild: false })), large)), "Level 5 character in the shape of Brown Bear · Large (10 ft)");
    assert.equal(kindLineText(kindLine(characterKind(thorn(undefined, { srdId: "giant-wolf-spider", wild: false })), MEDIUM)), "Character in the shape of Giant Wolf Spider · Medium (5 ft)");
  });

  test("a companion names its character in a part of its own", () => {
    const line = kindLine({ kind: "companion", of: "Thorn" }, MEDIUM);
    assert.equal(kindLineText(line), "Companion of Thorn · Medium (5 ft)");
    assert.equal(line.kind, "Companion of Thorn", "exactly the words the tracker's row uses");
    assert.equal(line.companionOf, "Thorn");
    assert.equal(kindLine({ kind: "monster" }, MEDIUM).companionOf, undefined, "nothing else names a character");
  });

  test("a monster or NPC with its CR where the viewer's copy holds it, else without", () => {
    const small = sizeText("small", { w: 1, h: 1 }, 5);
    assert.equal(kindLineText(kindLine({ kind: "monster", cr: "1/4" }, small)), "Monster, CR 1/4 · Small (5 ft)");
    assert.equal(kindLineText(kindLine({ kind: "npc", cr: "2" }, MEDIUM)), "NPC, CR 2 · Medium (5 ft)");
    assert.equal(kindLineText(kindLine({ kind: "monster" }, small)), "Monster · Small (5 ft)");
    assert.equal(kindLineText(kindLine({ kind: "npc", cr: "" }, MEDIUM)), "NPC · Medium (5 ft)", "an empty CR is none");
  });

  test("an object", () => {
    assert.equal(kindLineText(kindLine({ kind: "object" }, MEDIUM)), "Object · Medium (5 ft)");
  });
});

describe("a token's kind, from the viewer's copy", () => {
  test("a companion is one first, whatever its kind, while the copy holds its character", () => {
    assert.deepEqual(tokenKind({ token: { kind: "npc", companion: { of: "c1" } }, companionOf: "Thorn", cr: "1/4" }), { kind: "companion", of: "Thorn" });
    assert.deepEqual(tokenKind({ token: { kind: "object", companion: { of: "c1" } }, companionOf: "Thorn" }), { kind: "companion", of: "Thorn" });
    assert.deepEqual(tokenKind({ token: { kind: "npc", companion: { of: "c1" } }, cr: "1/4" }), { kind: "npc", cr: "1/4" }, "without its character, its own kind");
  });

  test("a player character's token reads its character, else says only Character", () => {
    assert.deepEqual(tokenKind({ token: { kind: "pc" }, character: thorn(5) }), { kind: "character", level: 5 });
    assert.deepEqual(tokenKind({ token: { kind: "pc" } }), { kind: "character" });
  });

  test("a monster, an NPC and an object", () => {
    assert.deepEqual(tokenKind({ token: { kind: "monster" }, cr: "10" }), { kind: "monster", cr: "10" });
    assert.deepEqual(tokenKind({ token: { kind: "npc" } }), { kind: "npc" });
    assert.deepEqual(tokenKind({ token: { kind: "object" }, cr: "1" }), { kind: "object" });
  });
});
