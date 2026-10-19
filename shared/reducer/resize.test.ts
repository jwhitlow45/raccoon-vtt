import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { LogEvent, PathStop, RoomState, Viewer } from "../model.ts";
import { MAX_PATH_STOPS, type Op } from "../protocol.ts";
import { applyOp } from "../reducer.ts";
import { creaturesInArea } from "../rules/aoe.ts";
import { tokenHeightFt } from "../rules/footprint.ts";
import { DM, P1, apply, entry, env, refused, room, template, token, withoutWalked } from "../testutil.ts";
import { RESHAPE_NOT_A_MOVE } from "./tokens.ts";

/**
 * A resize as the reducer applies it (docs/design-v1-token-window.md 8.5
 * and 8.7): a token update of the size and the spot, which clears a
 * squeeze, keeps the elevation, and on the acting creature's turn is no
 * movement. Its old size goes on every earlier stop, and it appends an
 * uncounted stop where it leaves the creature.
 */
const START: Op = { t: "encounter.start", entries: [{ id: "n1", tokenId: "thorn", value: 20 }, { id: "n2", tokenId: "gob", value: 10 }] };
const resize = (size: string, x?: number, y?: number): Op => ({ t: "token.update", tokenId: "thorn", patch: { size, ...(x !== undefined ? { x } : {}), ...(y !== undefined ? { y } : {}) } as never });
const move = (x: number, y: number): Op => ({ t: "token.move", tokenId: "thorn", x, y });
const MEDIUM = { w: 1, h: 1 };
const LARGE = { w: 2, h: 2 };
/** A stop as the reducer records it here, where everyone sees everything. */
const at = (x: number, y: number, more: Partial<PathStop> = {}): PathStop => ({ x, y, elevation: 0, seen: true, ...more });

/** Thorn, P1's druid at 1,1, acting first, then a goblin far off. Each op takes the next seq, so the turn is named 2. */
function fight(over: Parameters<typeof token>[1] = {}) {
  const state = room({ tokens: { thorn: token("thorn", { kind: "npc", name: "Thorn", ownerIds: ["p1"], x: 1, y: 1, ...over }), gob: token("gob", { x: 20, y: 1 }) } });
  const f = {
    state,
    seq: 0,
    run(op: Op, who: Viewer = DM) {
      f.seq++;
      f.state = apply(f.state, op, who, f.seq);
      return f;
    },
    // The marks these tests read, without what each leg took (route tests check that).
    stops: () => withoutWalked(f.state.tokens.thorn!.path)!.stops,
  };
  return f.run(START).run({ t: "encounter.next" });
}

describe("a resize patch", () => {
  test("takes its spot and size, clears a squeeze, and keeps the elevation, the height following the footprint", () => {
    const state = room({ tokens: { ogre: token("ogre", { size: "large", x: 4.5, y: 4, squeeze: true, elevation: 10 }) } });
    const grown = apply(state, { t: "token.update", tokenId: "ogre", patch: { size: "huge", x: 4, y: 3 } });
    const ogre = grown.tokens.ogre!;
    assert.deepEqual([ogre.size, ogre.x, ogre.y, ogre.elevation, "squeeze" in ogre], ["huge", 4, 3, 10, false]);
    assert.equal(tokenHeightFt(ogre, 5), 15);
    assert.equal(ogre.path, undefined, "outside a fight, no path");
  });

  test("an attached emanation grows with its creature, and a creature that grows into an area that hits on entering is reminded", () => {
    const state = room();
    state.tokens.cleric = token("cleric", { kind: "pc", name: "Ayla", x: 5, y: 5, ownerIds: ["p1"], disposition: "ally" });
    state.tokens.g1 = token("g1", { name: "Goblin", number: 1, x: 9, y: 5 });
    state.templates.sg = template("sg", { shape: "emanation", size: 15, attachedTo: "cleric", casterId: "cleric", includeOrigin: false, spell: "Spirit Guardians", ownerId: "p1", triggers: ["enter"] });
    state.encounter = { rev: 0, round: 1, activeEntryId: "e-g1", entries: [entry("e-g1", { tokenId: "g1", value: 15 }), entry("e-cleric", { tokenId: "cleric", value: 10, tieOrder: 1 })] };
    const ctx = (s: RoomState) => ({ settings: s.meta.settings, bounds: s.scenes.s1!.bounds, tokens: s.tokens });
    const covered = (s: RoomState) => creaturesInArea(s.templates.sg!, [s.tokens.g1!], ctx(s));
    assert.deepEqual(covered(state), [], "the goblin stands just past its edge");
    const grown = apply(state, { t: "token.update", tokenId: "cleric", patch: { size: "huge", x: 4, y: 4 } });
    assert.deepEqual(covered(grown), ["g1"], "her Spirit Guardians grew with her");

    const entered = applyOp(state, { t: "token.update", tokenId: "g1", patch: { size: "huge", x: 8, y: 4 } }, DM, env(1));
    assert.ok(entered.ok);
    const reminders = entered.log.map((e) => e.data).filter((d): d is Extract<LogEvent, { type: "area" }> => d?.type === "area");
    assert.deepEqual(reminders.map((r) => [r.tokenId, r.trigger]), [["g1", "enter"]], "the goblin grew into it on its turn");
  });
});

describe("a resize on the acting creature's turn is not movement", () => {
  test("after counted moves, the old size goes on every earlier stop and an uncounted stop follows, the earlier places and marks as they were", () => {
    const f = fight();
    f.run(move(4, 1), P1).run({ t: "token.countLeg", tokenId: "thorn", counts: false }, P1).run(move(4, 3), P1);
    const before = f.stops();
    f.run(resize("large", 4, 3), P1);
    assert.deepEqual(f.stops(), [...before.map((s) => ({ ...s, footprint: MEDIUM })), at(4, 3, { uncounted: true })]);
    assert.deepEqual(before, [at(1, 1), at(4, 1, { uncounted: true }), at(4, 3)]);
    f.run(move(7, 3), P1);
    assert.deepEqual(f.stops().at(-1), at(7, 3), "a later move is a counted leg at the size now");
    f.run(resize("huge", 6, 2), P1);
    assert.deepEqual(
      f.stops().map((s) => s.footprint),
      [MEDIUM, MEDIUM, MEDIUM, LARGE, LARGE, undefined],
      "a second resize stamps only the stops made since the first",
    );
  });

  test("a resize in place appends its stop, a resize between Small and Medium appends none, and a resize before any move starts from the turn's start", () => {
    const f = fight();
    f.run(resize("large"), P1);
    assert.deepEqual(f.stops(), [at(1, 1, { footprint: MEDIUM }), at(1, 1, { uncounted: true })]);
    const g = fight();
    g.run(resize("small"), P1);
    assert.equal(g.state.tokens.thorn!.path, undefined, "one footprint, no stop");
  });

  test("off its turn, a resize leaves no path, and a player's copy that cannot see the turn's start leaves the path for the server", () => {
    const f = fight();
    f.run({ t: "token.update", tokenId: "gob", patch: { size: "large" } });
    assert.equal(f.state.tokens.gob!.path, undefined);
    f.run(move(4, 1), P1);
    const { turnStart: _start, ...unknown } = f.state.encounter!;
    const copy = { ...f.state, encounter: unknown };
    const predicted = apply(copy, resize("large", 4, 1), P1, 99);
    assert.equal(predicted.tokens.thorn!.path, f.state.tokens.thorn!.path);
  });

  test("Doesn't count is refused on a resize's leg, which never counts", () => {
    const f = fight();
    f.run(move(4, 1), P1).run(resize("large", 4, 1), P1);
    assert.equal(refused(f.state, { t: "token.countLeg", tokenId: "thorn", counts: true }, P1, 99).message, RESHAPE_NOT_A_MOVE);
    assert.equal(refused(f.state, { t: "token.countLeg", tokenId: "thorn", counts: false }, P1, 99).message, RESHAPE_NOT_A_MOVE);
    f.run(move(7, 1), P1).run({ t: "token.countLeg", tokenId: "thorn", counts: false }, P1);
    assert.equal(f.stops().at(-1)!.uncounted, true, "the move after it is marked as before");
  });

  test("a turn of a move and a resize after another until the path is full keeps 50 stops, joining the oldest corner", () => {
    const f = fight();
    for (let i = 0; i < 25; i++) {
      const big = i % 2 === 0;
      f.run(move(2 + 3 * i, 1), P1).run(resize(big ? "large" : "medium", 2 + 3 * i, 1), P1);
    }
    const stops = f.stops();
    assert.equal(stops.length, MAX_PATH_STOPS);
    assert.deepEqual(stops[0], at(1, 1, { footprint: MEDIUM }), "the turn's start stays");
    assert.deepEqual(stops[1], at(2, 1, { footprint: LARGE }), "the first move and the first resize joined, counted, at the resize's size");
    assert.equal(stops.at(-1)!.uncounted, true, "the latest resize's stop stays");
  });
});
