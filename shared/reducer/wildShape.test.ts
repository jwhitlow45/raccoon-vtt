import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { ActorPatch, Op } from "../protocol.ts";
import { WILD_SHAPE_ALONE } from "../rules/pcStats.ts";
import { actor, apply, character, refused, room, token } from "../testutil.ts";

/** A shape on a character's own actor (docs/design-v1-pc-stats.md 3.6). */

function setup() {
  return room({
    characters: { bree: character("bree", { name: "Bree", actor: actor() }) },
    tokens: { t: token("t", { kind: "pc", actor: { ref: "bree" } }), wolf: token("wolf", { actor: { inline: actor() } }) },
  });
}

const shape = (patch: ActorPatch): Op => ({ t: "character.update", characterId: "bree", patch: { actor: patch } });

describe("Wild Shape on a character's actor", () => {
  test("a patch that sets the creature sets the mark as it says, absent being another shape, and clearing the creature ends either", () => {
    let s = apply(setup(), shape({ srdId: "brown-bear", wildShape: true }));
    assert.equal(s.characters.bree!.actor.srdId, "brown-bear");
    assert.equal(s.characters.bree!.actor.wildShape, true);
    s = apply(s, shape({ srdId: "brown-bear" }));
    assert.equal(s.characters.bree!.actor.wildShape, undefined, "the same creature as Polymorph");
    s = apply(s, shape({ srdId: "wolf", wildShape: true }));
    s = apply(s, shape({ srdId: null }));
    assert.equal(s.characters.bree!.actor.srdId, undefined);
    assert.equal("wildShape" in s.characters.bree!.actor, false);
  });

  test("through a token of the character, and an edit of anything else keeps the shape", () => {
    let s = apply(setup(), { t: "token.update", tokenId: "t", patch: { actor: { srdId: "brown-bear", wildShape: true } } });
    assert.equal(s.characters.bree!.actor.wildShape, true);
    s = apply(s, shape({ ac: 13 }));
    assert.equal(s.characters.bree!.actor.wildShape, true);
  });

  test("another link a patch sets ends the shape with the creature it replaces", () => {
    let s = apply(setup(), shape({ srdId: "brown-bear", wildShape: true }));
    s = apply(s, shape({ monsterId: "m1" }));
    assert.equal(s.characters.bree!.actor.srdId, undefined);
    assert.equal(s.characters.bree!.actor.wildShape, undefined);
  });

  test("the mark alone, with a creature cleared, or on a token's own actor is refused", () => {
    const s = apply(setup(), shape({ srdId: "brown-bear" }));
    assert.deepEqual(refused(s, shape({ wildShape: true })), { ok: false, code: "invalid", message: WILD_SHAPE_ALONE });
    assert.deepEqual(refused(s, shape({ srdId: null, wildShape: true })), { ok: false, code: "invalid", message: WILD_SHAPE_ALONE });
    assert.deepEqual(refused(s, { t: "token.update", tokenId: "wolf", patch: { actor: { srdId: "wolf", wildShape: true } } }), { ok: false, code: "invalid", message: WILD_SHAPE_ALONE });
    const inline = token("new", { actor: { inline: actor({ srdId: "wolf", wildShape: true }) } });
    const { rev: _rev, ...input } = inline;
    assert.equal(refused(s, { t: "token.create", token: input as never }).message, WILD_SHAPE_ALONE);
    const make = (a: ReturnType<typeof actor>): Op => ({ t: "character.create", character: { id: "c", name: "Cora", size: "medium", ownerIds: [], actor: a } });
    assert.equal(refused(s, make(actor({ wildShape: true }))).message, WILD_SHAPE_ALONE);
    assert.equal(apply(s, make(actor({ srdId: "wolf", wildShape: true }))).characters.c!.actor.wildShape, true);
  });
});
