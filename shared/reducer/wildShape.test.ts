import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { clientOpSchema, type ActorPatch, type Op } from "../protocol.ts";
import { applyOp } from "../reducer.ts";
import { hpUndoRestore } from "./hpUndo.ts";
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
  const BREE = { characterId: "bree" };
  const hit = (amount: number): Op => ({ t: "actor.hp", target: BREE, change: { kind: "damage", amount } });
  const grant = (amount: number): Op => ({ t: "actor.hp", target: BREE, change: { kind: "temp", amount } });
  const set = (values: { cur?: number; temp?: number }): Op => ({ t: "actor.hp", target: BREE, change: { kind: "set", ...values } });

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

  test("Polymorph's temporary HP go when it ends, damage keeping them its, and Wild Shape's stay", () => {
    let s = apply(setup(), shape({ ...BEAR, hp: { temp: 22 } }));
    assert.deepEqual(bree(s).unshaped, { ...own, shapeTemp: true });
    s = apply(s, hit(13));
    assert.equal(bree(s).hp.temp, 9);
    assert.equal(apply(s, shape({ srdId: null })).characters.bree!.actor.hp.temp, 0, "the 9 left go");
    const wild = apply(apply(setup(), shape({ ...BEAR, wildShape: true, hp: { temp: 5 } })), shape({ srdId: null }));
    assert.equal(wild.characters.bree!.actor.hp.temp, 5, "Wild Shape's stay");
    const unticked = apply(apply(apply(setup(), grant(4)), shape(BEAR)), shape({ srdId: null }));
    assert.equal(unticked.characters.bree!.actor.hp.temp, 4, "a shape that gave none takes none");
  });

  /**
   * Whose the pool is follows its source, never its size (W7-SOL-06,
   * ASTRA-16). Each run goes live and as ops stored at version 7 replay, and
   * both must end alike.
   */
  const runs: { name: string; ops: Op[]; temp: number; mark?: true }[] = [
    { name: "a higher grant replaces the pool, then damage takes it under the shape's 22", ops: [shape({ ...BEAR, hp: { temp: 22 } }), grant(30), hit(10)], temp: 20 },
    { name: "the shape's pool spent, then a grant under its 22", ops: [shape({ ...BEAR, hp: { temp: 22 } }), hit(17), grant(10)], temp: 10 },
    { name: "the shape's pool gone, then a grant and damage", ops: [shape({ ...BEAR, hp: { temp: 22 } }), hit(22), grant(8), hit(3)], temp: 5 },
    { name: "a set that changes the pool", ops: [shape({ ...BEAR, hp: { temp: 22 } }), set({ temp: 12 })], temp: 12 },
    { name: "a patch that changes the pool", ops: [shape({ ...BEAR, hp: { temp: 22 } }), shape({ hp: { temp: 6 } })], temp: 6 },
    { name: "a Long Rest, then a grant", ops: [shape({ ...BEAR, hp: { temp: 22 } }), hit(5), { t: "actor.rest", target: BREE, kind: "long" }, grant(7)], temp: 7 },
    { name: "Wild Shape after Polymorph, setting its own pool", ops: [shape({ ...BEAR, hp: { temp: 22 } }), shape({ srdId: "wolf", wildShape: true, hp: { temp: 30 } })], temp: 30 },
    { name: "a set of the current HP alone keeps the shape's pool", ops: [shape({ ...BEAR, hp: { temp: 22 } }), set({ cur: 15 }), hit(2)], temp: 0, mark: true },
    { name: "another shape's pool is that shape's", ops: [shape({ ...BEAR, hp: { temp: 22 } }), hit(20), shape({ srdId: "giant-eagle", hp: { temp: 42 } })], temp: 0, mark: true },
  ];
  for (const run of runs) {
    test(`End the shape: ${run.name}`, () => {
      for (const opVersion of [undefined, 7]) {
        let s = setup();
        for (const [i, op] of run.ops.entries()) {
          const r = applyOp(s, op, DM, { ...env(i + 1), ...(opVersion !== undefined ? { opVersion } : {}) });
          assert.ok(r.ok, `${op.t} at ${opVersion ?? "live"}`);
          s = r.state;
        }
        assert.equal(bree(s).unshaped?.shapeTemp, run.mark, `the mark at ${opVersion ?? "live"}`);
        const ended = applyOp(s, shape({ srdId: null }), DM, { ...env(run.ops.length + 1), ...(opVersion !== undefined ? { opVersion } : {}) });
        assert.ok(ended.ok);
        assert.equal(ended.state.characters.bree!.actor.hp.temp, run.temp, `the temporary HP left at ${opVersion ?? "live"}`);
      }
    });
  }

  test("damage taken back from the log leaves the shape's pool its", () => {
    let s = apply(setup(), shape({ ...BEAR, hp: { temp: 22 } }));
    s = apply(s, hit(10));
    const line = s.log.findLast((e) => e.data?.type === "hp")!;
    const built = hpUndoRestore(s, line.id);
    assert.ok(built.ok);
    s = apply(s, { t: "sys.restore", entries: built.entries, from: "undo", deps: true, undid: line.id }, DM, 3);
    assert.equal(bree(s).hp.temp, 22);
    assert.equal(apply(s, shape({ srdId: null })).characters.bree!.actor.hp.temp, 0);
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
