import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { GROUND, UPPER } from "#shared/floorLinksTestutil.ts";
import { LIMITS } from "#shared/limits.ts";
import type { RoomState, SightHolder } from "#shared/model.ts";
import { openTower, pc, subsOf, withAll } from "#shared/openingsTestutil.ts";
import { serverOnlyOpSchema, type OpOf } from "#shared/protocol.ts";
import { applyOp } from "#shared/reducer.ts";
import { decodeTile, getBit } from "#shared/rules/fog.ts";
import { actor, chance, env, int, member, pick, rng, token } from "#shared/testutil.ts";
import { SERVER_ACTOR } from "./actor.ts";
import { exploreOp, exploreOps, floorsExplored } from "./explore.ts";

/*
 * Exploring every floor at once (docs/design/design-v1-floors.md phase 4,
 * 7.2, D-261119-100 and 121): exploreOps gathers each floor's joins to its
 * holder list first and explores every floor with them pending, so a
 * player one floor adds borrows into the other floor's column in the same
 * pass, whatever the floors' order. Only a pending entry that is on lends.
 * With no opening its ops are the ones the floors give one by one.
 */

const DV = "Darkvision 10 ft";
const HOLE = subsOf();

function apply(state: RoomState, op: OpOf<"sys.explore">): RoomState {
  const parsed = serverOnlyOpSchema.safeParse(op);
  assert.ok(parsed.success, parsed.success ? "" : parsed.error.issues[0]?.message);
  const r = applyOp(state, parsed.data, SERVER_ACTOR, env(99));
  assert.ok(r.ok, r.ok ? "" : r.message);
  return r.state;
}

/** The floors one by one, each read off the state the one before left, as the actor explores them before exploreOps. */
function oneByOne(state: RoomState, floors: readonly string[]): OpOf<"sys.explore">[] {
  const out: OpOf<"sys.explore">[] = [];
  let s = state;
  for (const sceneId of floors) {
    const op = exploreOp(s, sceneId);
    if (!op) continue;
    out.push(op);
    s = apply(s, op);
  }
  return out;
}

const byFloor = (ops: readonly OpOf<"sys.explore">[]) => Object.fromEntries(ops.map((op) => [op.sceneId, op]));

/** Whether any of the hole's sub-cells is set in a member's new tiles of the op. */
function holeIn(op: OpOf<"sys.explore"> | undefined, memberId: string): boolean {
  const tile = op?.members?.find((m) => m.memberId === memberId)?.tiles.find((t) => t.tx === 0 && t.ty === 0);
  const bits = tile ? decodeTile(tile.bits) : null;
  return bits !== null && HOLE.some(([sx, sy]) => getBit(bits, sx, sy));
}

/** Both floors per-player and dark, Ana's scouts on each, the one below beside the hole, the one upstairs far from it. */
function room(holders: Record<string, SightHolder[]> = {}, opening = true): RoomState {
  const s = withAll(openTower({}, { perPlayer: [GROUND, UPPER], opening }), [pc("scoutBelow", "p1", GROUND, 5, 6, {}, DV), pc("scoutAbove", "p1", UPPER, 15, 15, {}, DV), pc("bree", "p2", UPPER, 3, 15, {}, DV)]);
  return { ...s, holders: Object.fromEntries(Object.entries(holders).map(([id, entries]) => [id, { sceneId: id, rev: 0, entries }])) };
}

describe("a player joining the holder lists as the floors are explored (D-261119-100)", () => {
  test("with no opening, exploreOps gives the floors' own ops, as one by one", () => {
    const s = room({}, false);
    for (const floors of [
      [GROUND, UPPER],
      [UPPER, GROUND],
    ]) {
      const ops = exploreOps(s, floors);
      assert.deepEqual(ops, oneByOne(s, floors), floors.join(" "));
      assert.equal(holeIn(byFloor(ops)[UPPER], "p1"), false);
      assert.deepEqual(byFloor(ops)[GROUND]?.join, [{ memberId: "p1", on: true }]);
    }
  });

  test("with one, Ana joining below borrows her own view below into her column upstairs, whichever floor comes first", () => {
    const s = room();
    const first = byFloor(exploreOps(s, [GROUND, UPPER]));
    const second = byFloor(exploreOps(s, [UPPER, GROUND]));
    assert.deepEqual(first, second, "the floors' order changes nothing");
    assert.equal(holeIn(first[UPPER], "p1"), true, "her scout below sees the hole, so her own layer upstairs gets it");
    assert.equal(holeIn(first[UPPER], "p2"), false, "Bree borrows nothing of Ana's");
    // The same as exploring the floor below first and the floor above off the state it left.
    assert.deepEqual(first, byFloor(oneByOne(s, [GROUND, UPPER])));
    // One by one the other way, the floor above would read her before she joins below: the order would decide.
    assert.equal(holeIn(byFloor(oneByOne(s, [UPPER, GROUND]))[UPPER], "p1"), false);
  });
});

describe("a whole-party floor explores its shared sight (7.2)", () => {
  test("the party's layer upstairs gets the hole only by what every player is lent below", () => {
    const partyHole = (op: OpOf<"sys.explore"> | undefined) => {
      const tile = op?.tiles.find((t) => t.tx === 0 && t.ty === 0);
      const bits = tile ? decodeTile(tile.bits) : null;
      return bits !== null && HOLE.some(([sx, sy]) => getBit(bits, sx, sy));
    };
    // Upstairs is whole party, the floor below per-player, where Ana's scout beside the hole lends to her alone.
    const own = withAll(openTower({}, { perPlayer: [GROUND] }), [pc("scoutBelow", "p1", GROUND, 5, 6, {}, DV), pc("bree", "p2", UPPER, 15, 15, {}, DV)]);
    const s = { ...own, holders: { [GROUND]: { sceneId: GROUND, rev: 0, entries: [{ memberId: "p1", on: true }] } } };
    assert.equal(partyHole(byFloor(exploreOps(s, [GROUND, UPPER]))[UPPER]), false);
    // An ally there lends to everyone, so then it does.
    const lent = withAll(s, [{ ...s.tokens.scoutBelow!, id: "allyBelow", ownerIds: [], partyVision: true }]);
    assert.equal(partyHole(byFloor(exploreOps(lent, [GROUND, UPPER]))[UPPER]), true);
  });
});

describe("a registration at the cap lends nothing (D-261119-121)", () => {
  const others = ["p3", "p4", "p5", "p6", "p7", "p8"];
  function capped(below: SightHolder[]): RoomState {
    const s = room({ [UPPER]: [{ memberId: "p1", on: true }], [GROUND]: [...others.slice(0, LIMITS.sightHoldersPerScene).map((memberId) => ({ memberId, on: true })), ...below] });
    return { ...s, members: { ...s.members, ...Object.fromEntries(others.map((id) => [id, member(id)])) } };
  }

  test("Ana, on upstairs and newly registered off below, borrows nothing below, the same as an existing entry that is off", () => {
    const fresh = capped([]);
    const stored = capped([{ memberId: "p1", on: false }]);
    for (const floors of [
      [GROUND, UPPER],
      [UPPER, GROUND],
    ]) {
      const ops = byFloor(exploreOps(fresh, floors));
      assert.deepEqual(ops[GROUND]?.join, [{ memberId: "p1", on: false }], "registered off at the cap");
      assert.equal(holeIn(ops[UPPER], "p1"), false, floors.join(" "));
      assert.deepEqual(ops[UPPER], byFloor(exploreOps(stored, floors))[UPPER], "the same op upstairs as with the stored entry off");
    }
    // With room under the cap she borrows.
    assert.equal(holeIn(byFloor(exploreOps(room({ [UPPER]: [{ memberId: "p1", on: true }] }), [UPPER, GROUND]))[UPPER], "p1"), true);
  });
});

describe("with no opening, exploreOps equals the floors one by one, on random per-player rooms", () => {
  test("random rooms of three floors", () => {
    const r = rng(7);
    for (let i = 0; i < 40; i++) {
      let s = openTower({ ground: pick(r, ["dark", "dim"]), upper: pick(r, ["dark", "bright"]), attic: "dark" }, { opening: false, perPlayer: [GROUND, UPPER, "at"].filter(() => chance(r, 0.7)) });
      s = { ...s, openFloors: { ...s.openFloors, at: { sceneId: "at", rev: 0 } } };
      const owners = ["p1", "p2", "p3"];
      const tokens = Array.from({ length: int(r, 1, 5) }, (_, k) =>
        token(`t${k}`, { kind: "pc", ownerIds: [pick(r, owners)], sceneId: pick(r, [GROUND, UPPER, "at"]), x: int(r, 0, 19), y: int(r, 0, 19), actor: { inline: actor({ senses: chance(r, 0.6) ? "Darkvision 30 ft" : "" }) }, ...(chance(r, 0.2) ? { partyVision: true } : {}) }),
      );
      s = withAll(s, tokens);
      if (chance(r, 0.5)) s = { ...s, holders: { [GROUND]: { sceneId: GROUND, rev: 0, entries: [{ memberId: "p2", on: chance(r, 0.5) }] } } };
      const floors = floorsExplored(s);
      assert.deepEqual(exploreOps(s, floors), oneByOne(s, floors), `room ${i}`);
    }
  });
});
