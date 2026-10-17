import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { clientOpSchema, type ActorPatch, type Op } from "../protocol.ts";
import { applyOp } from "../reducer.ts";
import { WILD_SHAPE_ALONE, withShapeRules } from "../rules/pcStats.ts";
import { DM, actor, apply, character, env, refused, room, token } from "../testutil.ts";

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

describe("a shape's AC, speeds and temporary HP (W7B-P-9)", () => {
  const BEAR: ActorPatch = { srdId: "brown-bear", ac: 11, speeds: { walk: 40, climb: 30 } };
  const own = { ac: 14, speeds: { walk: 30 } };
  const bree = (s: ReturnType<typeof setup>) => s.characters.bree!.actor;
  const hurt = (temp: number): Op => ({ t: "character.update", characterId: "bree", patch: { actor: { hp: { temp } } } });

  test("Wild Shape takes the creature's AC and speeds and keeps the character's, which End the shape puts back, and its temporary HP stay", () => {
    let s = apply(setup(), shape({ ...BEAR, wildShape: true, hp: { temp: 5 } }));
    assert.deepEqual([bree(s).ac, bree(s).speeds, bree(s).hp.temp], [11, { walk: 40, climb: 30 }, 5]);
    assert.deepEqual(bree(s).unshaped, own);
    s = apply(s, shape({ ac: 12 }));
    assert.deepEqual(bree(s).unshaped, own, "an edit while shaped changes the shape's numbers");
    s = apply(s, shape({ srdId: null }));
    assert.deepEqual([bree(s).ac, bree(s).speeds, bree(s).hp.temp], [14, { walk: 30 }, 5]);
    assert.equal("unshaped" in bree(s), false);
  });

  test("through a token of the character, a change of creature keeps the first numbers, and another link ends the shape the same way", () => {
    let s = apply(setup(), { t: "token.update", tokenId: "t", patch: { actor: { ...BEAR, wildShape: true } } });
    s = apply(s, shape({ srdId: "wolf", wildShape: true, ac: 13, speeds: { walk: 40 } }));
    assert.deepEqual(bree(s).unshaped, own);
    s = apply(s, shape({ monsterId: "m1" }));
    assert.deepEqual([bree(s).ac, bree(s).speeds, "unshaped" in bree(s)], [14, { walk: 30 }, false]);
  });

  test("the patch that ends a shape keeps the AC or speeds it sets itself", () => {
    let s = apply(setup(), shape({ ...BEAR, wildShape: true }));
    s = apply(s, shape({ srdId: null, ac: 16 }));
    assert.deepEqual([bree(s).ac, bree(s).speeds], [16, { walk: 30 }]);
  });

  test("Polymorph's temporary HP go when it ends, unless more came from elsewhere", () => {
    let s = apply(setup(), shape({ ...BEAR, hp: { temp: 22 } }));
    assert.deepEqual(bree(s).unshaped, { ...own, temp: 22 });
    s = apply(s, hurt(9));
    assert.equal(bree(s).hp.temp, 9);
    assert.equal(apply(s, shape({ srdId: null })).characters.bree!.actor.hp.temp, 0, "the 9 left go");
    assert.equal(apply(apply(s, hurt(30)), shape({ srdId: null })).characters.bree!.actor.hp.temp, 30, "a higher amount replaced them");
    const wild = apply(apply(setup(), shape({ ...BEAR, wildShape: true, hp: { temp: 5 } })), shape({ srdId: null }));
    assert.equal(wild.characters.bree!.actor.hp.temp, 5, "Wild Shape's stay");
    const unticked = apply(apply(apply(setup(), hurt(4)), shape(BEAR)), shape({ srdId: null }));
    assert.equal(unticked.characters.bree!.actor.hp.temp, 4, "a shape that gave none takes none");
  });

  test("an op stored before version 7 neither keeps nor puts back, so it replays as it ran", () => {
    const at6 = (state: ReturnType<typeof setup>, op: Op) => {
      const r = applyOp(state, op, DM, { ...env(1), opVersion: 6 });
      assert.ok(r.ok);
      return r.state;
    };
    let s = at6(setup(), shape({ ...BEAR, wildShape: true }));
    assert.equal("unshaped" in bree(s), false);
    s = at6(s, shape({ srdId: null }));
    assert.equal(bree(s).ac, 11);
  });

  test("no op carries it, and a file's is kept only on a character in a shape", () => {
    const ok = (op: unknown) => clientOpSchema.safeParse(op).success;
    const create = (a: ReturnType<typeof actor>) => ({ t: "character.create", character: { id: "c", name: "Cora", size: "medium", ownerIds: [], actor: a } });
    assert.ok(ok({ t: "character.update", characterId: "bree", patch: { actor: { ac: 12 } } }));
    assert.equal(ok({ t: "character.update", characterId: "bree", patch: { actor: { unshaped: own } } }), false);
    assert.ok(ok(create(actor({ srdId: "wolf" }))));
    assert.equal(ok(create(actor({ srdId: "wolf", unshaped: own }))), false);
    const state = setup();
    state.characters.bree!.actor = actor({ unshaped: own, ac: 11 });
    state.characters.cora = character("cora", { actor: actor({ srdId: "wolf", unshaped: own }) });
    state.tokens.wolf!.actor = { inline: actor({ srdId: "wolf", unshaped: own }) };
    const out = withShapeRules(state);
    assert.deepEqual(["unshaped" in out.characters.bree!.actor, out.characters.bree!.actor.ac], [false, 11], "no shape: the file's AC stands");
    assert.deepEqual(out.characters.cora!.actor.unshaped, own);
    assert.equal("unshaped" in (out.tokens.wolf!.actor as { inline: object }).inline, false);
  });
});
