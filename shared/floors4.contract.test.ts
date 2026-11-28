import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { floorOfKey } from "#server/rooms/fanout.ts";
import { FAR_TREATMENT } from "./farLine.ts";
import { ANA, BREE, UPPER, fallCard, fallRecord, putOp, putOpeningOp, tower, trapdoor, withFalls, withStairs } from "./floorLinksTestutil.ts";
import { allKeys } from "./project.ts";
import { collectionOf, keys, parseKey, readEntity, writeEntity } from "./keys.ts";
import { FALL_RIDERS_MOST, type RoomState, type Viewer } from "./model.ts";
import { canApply } from "./permissions.ts";
import { projectEntity, projectState, type ProjectedFall } from "./project.ts";
import { ID_RULES, STAIRS_SIDE_WORDS, opSchema, clientOpSchema, PIT_OR_BELOW, type Op } from "./protocol.ts";
import { opReads } from "./reads.ts";
import { applyOp } from "./reducer.ts";
import { DM, env, trap } from "./testutil.ts";

/*
 * Floors phase 4's contract (docs/design/design-v1-floors.md phase 4, 11):
 * the stored shapes and ops every lane of the phase builds on, the fall
 * card's key, which only the DM's projection ever holds, the op tables'
 * rows for `fall.settle`, and the shapes the reducer refuses until their
 * rules are built, so a room behaves as before.
 */

const DISPLAY: Viewer = { memberId: "display:abcdefghijkl", role: "player" };
const parses = (op: unknown) => opSchema.safeParse(op).success;
const issue = (op: unknown) => {
  const r = opSchema.safeParse(op);
  return r.success ? null : r.error.issues.map((i) => i.message).join("; ");
};

describe("the ops (11)", () => {
  test("an opening's ends are 1 to 8 squares a side, and stairs and ladders keep to 4 in the builder's words", () => {
    assert.ok(parses(putOpeningOp({ rect: { x: 0, y: 0, w: 8, h: 8 } })));
    assert.ok(!parses(putOpeningOp({ rect: { x: 0, y: 0, w: 9, h: 1 } })));
    for (const kind of ["stairs", "ladder"] as const) {
      assert.ok(parses(putOp({ kind, rect: { x: 0, y: 0, w: 4, h: 4 } })), kind);
      assert.equal(issue(putOp({ kind, rect: { x: 0, y: 0, w: 5, h: 1 } })), STAIRS_SIDE_WORDS, kind);
      assert.equal(issue(putOp({ kind, rect: { x: 0, y: 0, w: 1, h: 5 } })), STAIRS_SIDE_WORDS, kind);
    }
    assert.equal(STAIRS_SIDE_WORDS, "Stairs and ladders are at most 4 squares a side.");
  });

  test("an end's change may hide it, move this end or the far one, and still changes something", () => {
    const rect = { x: 2, y: 2, w: 3, h: 3 };
    for (const patch of [{ hidden: true }, { hidden: false }, { rect }, { pairRect: rect }, { kind: "opening" }, { locked: true, hidden: true }]) {
      assert.ok(parses({ t: "floorLink.update", linkId: "l1", patch }), JSON.stringify(patch));
    }
    assert.ok(!parses({ t: "floorLink.update", linkId: "l1", patch: {} }));
    assert.ok(!parses({ t: "floorLink.update", linkId: "l1", patch: { rect: { x: 2, y: 2, w: 9, h: 1 } } }));
    assert.ok(!parses({ t: "floorLink.update", linkId: "l1", patch: { to: "s3" } }));
  });

  test("a trap's rig may drop to the floor below, never with a pit, as made or changed", () => {
    const { id, sceneId, name, zone, rig } = trapdoor();
    const create = (r: object) => ({ t: "trap.create", trap: { id, sceneId, name, zone, rig: { ...rig, ...r } } });
    assert.ok(parses(create({ below: true })));
    assert.ok(!parses(create({ below: false })));
    assert.equal(issue(create({ below: true, pit: { floor: -10 } })), PIT_OR_BELOW);
    const update = (r: object) => ({ t: "trap.update", trapId: id, patch: { rig: r } });
    assert.ok(parses(update({ below: true })));
    assert.ok(parses(update({ below: null })));
    assert.ok(parses(update({ below: true, pit: null })));
    assert.equal(issue(update({ below: true, pit: { floor: -10 } })), PIT_OR_BELOW);
  });

  test("Dismiss names a card by its id, and a group save's outcome settles a fall, a trap or an ask, one thing at most", () => {
    assert.ok(clientOpSchema.safeParse({ t: "fall.settle", fallId: "120:0" }).success);
    for (const fallId of ["120", "a:0", "120:0:1", ""]) assert.ok(!parses({ t: "fall.settle", fallId }), fallId);
    const outcome = (more: object) => ({ t: "actor.outcome", plan: "p1", targets: [{ target: { tokenId: "thorn" }, amount: 3 }], ...more });
    assert.ok(parses(outcome({ fall: { fallId: "120:0", tokenIds: ["thorn"] } })));
    // The creatures it settles are those a card names: the one that fell and at most FALL_RIDERS_MOST riders (FLR4INT-ASTRA-05).
    const ids = (n: number) => Array.from({ length: n }, (_, i) => `t${i}`);
    assert.ok(parses(outcome({ fall: { fallId: "120:0", tokenIds: ids(FALL_RIDERS_MOST + 1) } })));
    assert.ok(!parses(outcome({ fall: { fallId: "120:0", tokenIds: ids(FALL_RIDERS_MOST + 2) } })));
    assert.ok(!parses(outcome({ fall: { fallId: "120:0" } })), "it names what it settles");
    const fall = { fallId: "120:0", tokenIds: ["thorn"] };
    for (const more of [{ fall, trap: { trapId: "t1", due: "5:0" } }, { fall, cast: "k1" }, { cast: "k1", trap: { trapId: "t1", due: "5:0" } }]) {
      assert.equal(issue(outcome(more)), "an outcome settles one thing", JSON.stringify(more));
    }
  });

  test("a restore carries a step's fall records beside its climb, each with the card its undo removed or none", () => {
    const restore = (falls: unknown) => ({ t: "sys.restore", from: "undo", entries: [{ key: "token:thorn", value: null }], falls });
    assert.ok(parses(restore([fallRecord()])));
    assert.ok(parses(restore([fallRecord({ card: fallCard() }), fallRecord({ tokenId: "bree", fallId: "120:1" })])));
    assert.ok(!parses(restore([])));
    assert.ok(!parses(restore([{ ...fallRecord(), extra: 1 }])));
    assert.ok(!parses(restore([fallRecord({ card: { ...fallCard(), ft: -5 } })])));
    assert.ok(!clientOpSchema.safeParse(restore([fallRecord()])).success, "only the server builds a restore");
  });
});

describe("the fall card's key (4.4, 10.1)", () => {
  test("reads and writes by key, room level, and the field goes once it holds none", () => {
    const card = fallCard();
    const key = keys.fall(card.id);
    assert.equal(key, "fall:120:0");
    assert.deepEqual(parseKey(key), { kind: "fall", id: "120:0" });
    assert.equal(collectionOf(key), "falls");
    const state = tower();
    const next = writeEntity(state, key, card);
    assert.equal(readEntity(next, key), card);
    assert.equal(readEntity(state, key), null);
    assert.equal("falls" in writeEntity(next, key, null), false);
    assert.equal(floorOfKey(next, key), null, "room level");
    assert.ok(allKeys(next).includes(key));
  });

  test("only the DM's projection holds a card, by key and whole", () => {
    const state = withFalls(tower(), fallCard(), fallCard({ made: 121, tokenId: "goblin" }));
    // As stored, with the creatures it names that the DM's copy lacks (`away`, project.away.test.ts) left out.
    const stored = (card: unknown) => (({ away: _away, ...rest }) => rest)(card as ProjectedFall);
    assert.deepEqual(stored(projectEntity(keys.fall("120:0"), state, DM, { sceneId: null })), fallCard());
    assert.deepEqual(Object.fromEntries(Object.entries(projectState(state, DM, { sceneId: null }).falls ?? {}).map(([id, card]) => [id, stored(card)])), state.falls);
    for (const viewer of [ANA, BREE, DISPLAY]) {
      assert.equal(projectEntity(keys.fall("120:0"), state, viewer, { sceneId: null }), null, viewer.memberId);
      const copy = projectState(state, viewer, { sceneId: null });
      assert.equal("falls" in copy, false, viewer.memberId);
      assert.doesNotMatch(JSON.stringify(copy), /120:0|"ft"/, `${viewer.memberId}'s copy names no card`);
    }
    assert.equal("falls" in projectState(tower(), DM, { sceneId: null }), false, "no field without a card");
  });
});

describe("`fall.settle`'s rows (4.4, 11)", () => {
  const deps = { canUseAsset: () => true };
  const decide = (state: RoomState, op: Op, who: Viewer) => {
    const d = canApply(op, who, state, deps);
    return d.ok ? "ok" : `${d.code}: ${d.message}`;
  };

  test("the DM's alone: a player's Dismiss is refused, the DM's passes the checks", () => {
    const state = withFalls(tower(), fallCard());
    const settle: Op = { t: "fall.settle", fallId: "120:0" };
    assert.equal(decide(state, settle, DM), "ok");
    for (const who of [ANA, BREE]) assert.match(decide(state, settle, who), /^forbidden: /, who.memberId);
  });

  test("bookkeeping on the far line, no ids minted, and it reads its card", () => {
    assert.equal(FAR_TREATMENT["fall.settle"], "bookkeeping");
    assert.equal(ID_RULES["fall.settle"], "none");
    assert.deepEqual(opReads({ t: "fall.settle", fallId: "120:0" }, tower()), { keys: [{ key: keys.fall("120:0") }], complete: [] });
  });
});

/*
 * The contract's shapes once their rules are built (docs/design/design-v1-floors.md
 * phase 4): an opening, a hidden, moved or resized end, a trapdoor, Dismiss
 * and a fall's outcome apply, and stairs, ladders and pits apply as before.
 */
describe("the shapes built", () => {
  test("an opening, a hidden, moved or resized end, a trapdoor, Dismiss and a fall's outcome apply", () => {
    const applies = (state: RoomState, op: Op) => {
      const r = applyOp(state, opSchema.parse(op), DM, env(130));
      assert.ok(r.ok, `${op.t}: ${r.ok ? "" : r.message}`);
    };
    const stairs = withStairs();
    applies(tower(), putOpeningOp());
    for (const patch of [{ hidden: true }, { rect: { x: 4, y: 4, w: 2, h: 1 } }, { pairRect: { x: 4, y: 4, w: 2, h: 1 } }]) applies(stairs, { t: "floorLink.update", linkId: "l1", patch });
    const { id, sceneId, name, zone, rig } = trapdoor();
    applies(tower(), { t: "trap.create", trap: { id, sceneId, name, zone, rig: rig! } });
    applies({ ...tower(), traps: { t1: trap("t1", { sceneId: UPPER }) } }, { t: "trap.update", trapId: "t1", patch: { rig: { below: true } } });
    applies(withFalls(tower(), fallCard()), { t: "fall.settle", fallId: "120:0" });
    applies(withFalls(tower(), fallCard()), { t: "actor.outcome", plan: "p1", fall: { fallId: "120:0", tokenIds: ["thorn"] }, targets: [{ target: { tokenId: "thorn" }, amount: 3 }] });
  });

  test("stairs and ladders, their lock and kind, and a pit still apply as before", () => {
    const stairs = withStairs();
    for (const patch of [{ locked: true }, { kind: "ladder" as const }]) {
      const r = applyOp(stairs, opSchema.parse({ t: "floorLink.update", linkId: "l1", patch }), DM, env(131));
      assert.ok(r.ok, JSON.stringify(patch));
    }
    const pit = trap("t1", { sceneId: UPPER, rig: { ...trap("t1").rig!, pit: { floor: -10 } } });
    const { id, sceneId, name, zone, rig } = pit;
    assert.ok(applyOp(tower(), opSchema.parse({ t: "trap.create", trap: { id, sceneId, name, zone, rig: rig! } }), DM, env(132)).ok);
  });
});
