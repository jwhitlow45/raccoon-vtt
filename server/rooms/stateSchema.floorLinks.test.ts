import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { ANA, fallCard, onThornsTurn, run, tower, trapdoor, withFalls, withHiddenStairs, withOpening, withStairs, withTrapdoor } from "#shared/floorLinksTestutil.ts";
import type { FloorLink, RoomState } from "#shared/model.ts";
import { IMPORT_LIMITS } from "./importRoom.ts";
import { lastLineSeq, remapState } from "./remap.ts";
import { MADE_MOST, parseRoomState } from "./stateSchema.ts";

/**
 * Stairs and ladders in a backup (docs/design/design-v1-floors.md phase 2,
 * 3 and 5): the stored-state schema takes each end and a
 * path's `prior` strictly, the floor check holds the ends to their floors
 * wherever they point, and the import gives them new ids, keeps their
 * stamps, and starts its op sequence past the newest of them.
 */

/** The tower with stairs, after Thorn climbed them on its turn, as JSON carries it. */
function climbed(): RoomState {
  const state = run(onThornsTurn(withStairs(tower())), { t: "token.climb", tokenId: "thorn", linkId: "l1" }, ANA);
  return JSON.parse(JSON.stringify(state)) as RoomState;
}

function refusal(state: unknown): string {
  const parsed = parseRoomState(state);
  assert.ok(!parsed.ok, "the backup should be refused");
  return parsed.message;
}

const end = (state: RoomState, id: string): FloorLink => state.floorLinks![id]!;

describe("stairs in the stored-state schema", () => {
  test("a room after a climb parses whole: both ends, and the path's prior", () => {
    const state = climbed();
    assert.ok(state.tokens.thorn!.path?.prior, "the climb wrote a prior");
    const parsed = parseRoomState(state);
    assert.ok(parsed.ok, parsed.ok ? "" : parsed.message);
    assert.deepEqual(parsed.state.floorLinks, state.floorLinks);
    assert.deepEqual(parsed.state.tokens.thorn!.path, state.tokens.thorn!.path);
  });

  test("an empty record of stairs reads as none, and the import keeps none", () => {
    const parsed = parseRoomState({ ...tower(), floorLinks: {} });
    assert.ok(parsed.ok);
    assert.equal("floorLinks" in parsed.state, false);
  });

  test("an end's fields are held to what the reducer writes", () => {
    const state = climbed();
    const broken = (patch: Record<string, unknown>, id = "l1") => ({ ...state, floorLinks: { ...state.floorLinks, [id]: { ...end(state, id), ...patch } } });
    assert.match(refusal(broken({ extra: 1 })), /^floorLinks\.l1: /);
    assert.match(refusal(broken({ rect: { x: 3, y: 3, w: 5, h: 1 } })), /^floorLinks\.l1\.rect\.w: /);
    assert.match(refusal(broken({ kind: "ramp" })), /^floorLinks\.l1\.kind: /);
    assert.match(refusal(broken({ locked: false })), /^floorLinks\.l1\.locked: /);
    assert.match(refusal(broken({ ground: 1.5 })), /^floorLinks\.l1\.ground: /);
    assert.match(refusal(broken({ made: -1 })), /^floorLinks\.l1\.made: /);
    assert.match(refusal(broken({ id: "not plain!" })), /^floorLinks\.l1\.id: /);
    assert.match(refusal({ ...state, floorLinks: { ...state.floorLinks, other: end(state, "l1") } }), /^floorLinks\.other: an entry under another id/);
  });

  test("a stamp past the newest op a backup may name is refused in words that name the stairs, not the log (FLR2D-OPUS-25)", () => {
    assert.equal(MADE_MOST, IMPORT_LIMITS.lineSeq, "the stamp's bound is the import's seq bound");
    const state = climbed();
    const stamped = (made: number) => ({ ...state, floorLinks: { l1: { ...end(state, "l1"), made }, l2: { ...end(state, "l2"), made } } });
    assert.equal(refusal(stamped(MADE_MOST + 1)), "floorLinks.l1.made: stairs placed past the newest op a backup may name");
    assert.ok(parseRoomState(stamped(MADE_MOST)).ok);
  });

  test("a path's prior is held to a stop's totals, its public diagonals always there", () => {
    const state = climbed();
    const path = state.tokens.thorn!.path!;
    const withPrior = (prior: unknown) => ({ ...state, tokens: { ...state.tokens, thorn: { ...state.tokens.thorn!, path: { ...path, prior } } } });
    assert.match(refusal(withPrior({ moved: 10 })), /^tokens\.thorn\.path\.prior\.seenDiag: /);
    assert.match(refusal(withPrior({ seenDiag: [0, 0], ft: 3 })), /^tokens\.thorn\.path\.prior: /);
    assert.match(refusal(withPrior({ seenDiag: [0, 0], moved: -5 })), /^tokens\.thorn\.path\.prior\.moved: /);
    assert.ok(parseRoomState(withPrior({ moved: 25, cost: 35, diag: [1, 0], seenDiag: [1, 0] })).ok);
  });

  test("stairs that do not fit their floors are refused by the floor check, ends naming no scene of the room included", () => {
    const state = climbed();
    // Every floor of the tower answers for its stairs, the first by id first.
    const words = (message: string) => message.replace(/^scenes\.[^.]+\.floor: /, "");
    assert.equal(words(refusal({ ...state, floorLinks: { l1: end(state, "l1") } })), "Tower's stairs and ladders don't fit its floors any more.");
    assert.equal(words(refusal({ ...state, floorLinks: { ...state.floorLinks, l1: { ...end(state, "l1"), ground: 5 } } })), "That would change the ground under the stairs to Upper floor. Remove them first.");
    // A pair between two scenes the room does not hold is no scene's to check but its own.
    const ghost = (id: string, pair: string, sceneId: string, to: string): FloorLink => ({ ...end(state, "l1"), id, pair, sceneId, to });
    assert.match(refusal({ ...state, floorLinks: { ...state.floorLinks, g1: ghost("g1", "g2", "gone1", "gone2"), g2: ghost("g2", "g1", "gone2", "gone1") } }), /^scenes\.gone1\.floor: /);
  });
});

describe("stairs through an import's remap", () => {
  test("both ends come under new ids, each naming the other's, on their floors' new ids, with their stamps and ground", () => {
    const state = climbed();
    let n = 0;
    const out = remapState(state, { assets: new Map(), newId: () => `n${++n}` });
    const ends = Object.values(out.floorLinks ?? {});
    assert.equal(ends.length, 2);
    const scenes = new Map(Object.values(out.scenes).map((s) => [s.floor?.name, s.id]));
    const lower = ends.find((e) => e.sceneId === scenes.get("Ground floor"))!;
    const upper = ends.find((e) => e.sceneId === scenes.get("Upper floor"))!;
    assert.ok(lower && upper, "one end on each floor");
    assert.deepEqual([lower.pair, upper.pair, lower.to, upper.to], [upper.id, lower.id, upper.sceneId, lower.sceneId]);
    for (const [e, was] of [[lower, end(state, "l1")], [upper, end(state, "l2")]] as const) {
      assert.notEqual(e.id, was.id, "a new id");
      assert.deepEqual({ ...e, id: was.id, pair: was.pair, sceneId: was.sceneId, to: was.to }, was, "the rest as it was");
      assert.equal(out.floorLinks![e.id], e, "filed under its new id");
    }
    const parsed = parseRoomState(JSON.parse(JSON.stringify(out)));
    assert.ok(parsed.ok, parsed.ok ? "" : parsed.message);
  });

  test("the new room's op sequence starts past the newest stamp, though every line is older (ASTRA-16)", () => {
    const state = climbed();
    const lines = lastLineSeq({ ...state, floorLinks: {} });
    const late = lines + 1_000;
    const stamped = { ...state, floorLinks: { l1: { ...end(state, "l1"), made: late }, l2: { ...end(state, "l2"), made: late } } };
    assert.equal(lastLineSeq(stamped), late);
    assert.equal(lastLineSeq(state), Math.max(lines, end(state, "l1").made));
  });
});

/*
 * Phase 4's stored shapes (docs/design/design-v1-floors.md phase 4, 3, 4.4,
 * 4.6 and 8.1): an opening's ends, hidden stairs, a trapdoor and the fall
 * cards, each held to what the reducer writes. How a pair's ends fit
 * together stays floorProblem's.
 */
describe("openings, hidden ends, trapdoors and fall cards in the stored-state schema", () => {
  test("a room with each parses whole and keeps them", () => {
    const state = JSON.parse(JSON.stringify(withFalls(withTrapdoor(withOpening(withHiddenStairs(tower()), { rect: { x: 8, y: 8, w: 8, h: 8 } })), fallCard(), fallCard({ made: 121 })))) as RoomState;
    const parsed = parseRoomState(state);
    assert.ok(parsed.ok, parsed.ok ? "" : parsed.message);
    assert.deepEqual(parsed.state.floorLinks, state.floorLinks);
    assert.deepEqual(parsed.state.falls, state.falls);
    assert.equal(parsed.state.traps.td1?.rig?.below, true);
  });

  test("an empty record of fall cards reads as none, and the import keeps none", () => {
    const parsed = parseRoomState({ ...tower(), falls: {} });
    assert.ok(parsed.ok);
    assert.equal("falls" in parsed.state, false);
  });

  test("an opening is never locked or hidden and keeps to 8 squares a side, stairs and ladders to 4", () => {
    const opened = withOpening(tower(), { rect: { x: 2, y: 2, w: 8, h: 8 } });
    const broken = (patch: Record<string, unknown>, state: RoomState = opened, id = "o1") => ({ ...state, floorLinks: { ...state.floorLinks, [id]: { ...end(state, id), ...patch } } });
    assert.equal(refusal(broken({ locked: true })), "floorLinks.o1.locked: Openings can't be locked.");
    assert.equal(refusal(broken({ hidden: true })), "floorLinks.o1.hidden: Openings can't be hidden.");
    assert.match(refusal(broken({ rect: { x: 2, y: 2, w: 9, h: 1 } })), /^floorLinks\.o1\.rect\.w: /);
    const stairs = withStairs();
    assert.equal(refusal(broken({ rect: { x: 3, y: 3, w: 1, h: 5 } }, stairs, "l1")), "floorLinks.l1.rect.h: Stairs and ladders are at most 4 squares a side.");
    assert.match(refusal(broken({ hidden: false }, stairs, "l1")), /^floorLinks\.l1\.hidden: /);
  });

  test("a trapdoor never opens a pit too", () => {
    const both = trapdoor("td1", { rig: { ...trapdoor().rig!, pit: { floor: -10 } } });
    assert.equal(refusal(withTrapdoor(tower(), both)), "traps.td1.rig.below: A trap opens a pit or drops to the floor below, not both.");
  });

  test("a fall card keeps to its shape, made by an op a backup may name, whose seq leads its id", () => {
    const card = (over: Record<string, unknown>) => ({ ...tower(), falls: { "120:0": { ...fallCard(), ...over } } });
    assert.match(refusal(card({ extra: 1 })), /^falls\.120:0: /);
    assert.match(refusal(card({ ft: -1 })), /^falls\.120:0\.ft: /);
    assert.equal(refusal(card({ made: MADE_MOST + 1, id: `${MADE_MOST + 1}:0` })), "falls.120:0.made: a fall made past the newest op a backup may name");
    assert.equal(refusal(card({ made: 121 })), "falls.120:0.id: a fall card's id names the op it was made in");
    assert.match(refusal({ ...tower(), falls: { "121:0": fallCard() } }), /^falls\.121:0: an entry under another id/);
    const many = Object.fromEntries(Array.from({ length: 11 }, (_, i) => fallCard({ made: 200 + i })).map((c) => [c.id, c]));
    assert.match(refusal({ ...tower(), falls: many }), /^falls: at most 10 fall cards/);
  });
});

