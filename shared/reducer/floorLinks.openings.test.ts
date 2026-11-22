import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { ANA, ATTIC, GROUND, UPPER, applied, putOp, putOpeningOp, refusal, run, thornToken, tower, withOpening, withStairs } from "../floorLinksTestutil.ts";
import { LIMITS } from "../limits.ts";
import type { CellRect, FloorLink, RoomState, Scene } from "../model.ts";
import type { Op } from "../protocol.ts";
import { LINK_WORDS } from "../rules/floorLinks.ts";
import { token } from "../testutil.ts";

/*
 * The DM's openings and moved ends in the reducer (docs/design/design-v1-floors.md
 * phase 4, 3, 8.1, 8.2): placing an opening, the kind, lock and hiding an
 * update may change, ends moved and resized on each floor's own squares,
 * the climb that lands by the far end's offset, and hidden stairs that are
 * no stairs to a player.
 */

const end = (s: RoomState, id: string): FloorLink => s.floorLinks![id]!;
const update = (linkId: string, patch: Record<string, unknown>): Op => ({ t: "floorLink.update", linkId, patch }) as Op;
const raise = (sceneId: string, cells: string[], height: number): Op => ({ t: "build.height", sceneId, cells, height });
const rect = (x: number, y: number, w = 1, h = 1): CellRect => ({ x, y, w, h });

describe("placing an opening (3)", () => {
  test("both ends on one rect, each on its own floor's ground there, made by the op", () => {
    const raised = run(tower(), raise(UPPER, ["6,6", "7,6", "6,7", "7,7"], 5));
    const r = applied(raised, putOpeningOp());
    const [hole, below] = [end(r.state, "o1"), end(r.state, "o2")];
    assert.deepEqual([hole.sceneId, hole.to, hole.pair, below.sceneId, below.to, below.pair], [UPPER, GROUND, "o2", GROUND, UPPER, "o1"]);
    assert.deepEqual([hole.kind, below.kind], ["opening", "opening"]);
    assert.deepEqual(hole.rect, below.rect);
    assert.deepEqual([hole.ground, below.ground], [5, 0]);
    assert.equal(hole.made, below.made);
    assert.equal(hole.rev, below.rev);
  });

  test("an opening 8 by 8 is placed, and one onto a wall below is refused in the builder's words", () => {
    assert.ok(applied(tower(), putOpeningOp({ rect: rect(2, 2, 8, 8) })).state.floorLinks!.o1);
    const walled = run(tower(), { t: "build.edge", sceneId: GROUND, edges: [{ key: "7,6,w", feature: { kind: "wall" } }] });
    assert.equal(refusal(walled, putOpeningOp()), LINK_WORDS.wall("Ground floor"));
  });
});

describe("an update's kind, lock and hiding (3, 8.1)", () => {
  test("a change of kind to or from an opening is refused in kindChange's words, and stairs become a ladder as before", () => {
    assert.equal(refusal(withStairs(), update("l1", { kind: "opening" })), "Remove them and place an opening.");
    assert.equal(refusal(withStairs(tower(), { kind: "ladder" }), update("l1", { kind: "opening" })), "Remove it and place an opening.");
    assert.equal(refusal(withOpening(), update("o1", { kind: "stairs" })), "Remove it and place stairs.");
    assert.equal(refusal(withOpening(), update("o2", { kind: "ladder" })), "Remove it and place a ladder.");
    const ladder = run(withStairs(), update("l1", { kind: "ladder" }));
    assert.deepEqual([end(ladder, "l1").kind, end(ladder, "l2").kind], ["ladder", "ladder"]);
  });

  test("an opening is never locked or hidden", () => {
    assert.equal(refusal(withOpening(), update("o1", { locked: true })), LINK_WORDS.openingLocked);
    assert.equal(refusal(withOpening(), update("o2", { hidden: true })), LINK_WORDS.openingHidden);
    // Unlocking or showing one changes nothing it holds.
    assert.equal(end(run(withOpening(), update("o1", { hidden: false })), "o1").hidden, undefined);
  });

  test("hiding stairs hides both ends, rev moving on together, and showing them takes it off both", () => {
    const s = withStairs();
    const hidden = run(s, update("l2", { hidden: true }));
    assert.deepEqual([end(hidden, "l1").hidden, end(hidden, "l2").hidden], [true, true]);
    assert.equal(end(hidden, "l1").rev, end(s, "l1").rev + 1);
    assert.equal(end(hidden, "l1").rev, end(hidden, "l2").rev);
    const shown = run(hidden, update("l1", { hidden: false }));
    assert.deepEqual([end(shown, "l1").hidden, end(shown, "l2").hidden], [undefined, undefined]);
  });
});

describe("ends moved and resized (8.2)", () => {
  test("rect alone moves both ends of an opening, and a pairRect of other squares is refused", () => {
    const moved = run(withOpening(), update("o1", { rect: rect(12, 12, 2, 2) }));
    assert.deepEqual([end(moved, "o1").rect, end(moved, "o2").rect], [rect(12, 12, 2, 2), rect(12, 12, 2, 2)]);
    assert.equal(refusal(withOpening(), update("o1", { rect: rect(12, 12, 2, 2), pairRect: rect(13, 12, 2, 2) })), LINK_WORDS.sameSquares("opening"));
  });

  test("stairs on squares move this floor's end alone, and both ends take the ground of their own squares", () => {
    const s = run(withStairs(), raise(UPPER, ["8,5", "9,5"], 5));
    const moved = run(s, update("l2", { rect: rect(8, 5, 2, 1) }));
    assert.deepEqual([end(moved, "l1").rect, end(moved, "l2").rect], [rect(3, 3, 2, 1), rect(8, 5, 2, 1)]);
    assert.deepEqual([end(moved, "l1").ground, end(moved, "l2").ground], [0, 5]);
    assert.equal(end(moved, "l1").rev, end(moved, "l2").rev);
  });

  test("a resize names both ends at one size, and one end alone or two sizes is refused", () => {
    const s = withStairs();
    const resized = run(s, update("l1", { rect: rect(3, 3, 1, 1), pairRect: rect(8, 5, 1, 1) }));
    assert.deepEqual([end(resized, "l1").rect, end(resized, "l2").rect], [rect(3, 3, 1, 1), rect(8, 5, 1, 1)]);
    assert.equal(refusal(s, update("l1", { rect: rect(3, 3, 1, 1) })), LINK_WORDS.oneSize("stairs"));
    assert.equal(refusal(s, update("l1", { rect: rect(3, 3, 1, 1), pairRect: rect(8, 5, 2, 1) })), LINK_WORDS.oneSize("stairs"));
  });

  test("on hexes stairs moved on one floor are refused, and moved on both together are taken", () => {
    const base = tower();
    const scenes = Object.fromEntries(Object.entries(base.scenes).map(([id, sc]) => [id, sc.floor ? ({ ...sc, gridShape: "hexRows" } as Scene) : sc]));
    const hex = run({ ...base, scenes }, putOp({ rect: rect(3, 3) }));
    assert.equal(refusal(hex, update("l1", { rect: rect(6, 6) })), LINK_WORDS.sameSquares("stairs"));
    const both = run(hex, update("l1", { rect: rect(6, 6), pairRect: rect(6, 6) }));
    assert.deepEqual([end(both, "l1").rect, end(both, "l2").rect], [rect(6, 6), rect(6, 6)]);
  });

  test("a move onto a wall, another end or past the floor's edge is refused in the builder's words", () => {
    const walled = run(withStairs(), { t: "build.edge", sceneId: UPPER, edges: [{ key: "9,5,w", feature: { kind: "wall" } }] });
    assert.equal(refusal(walled, update("l2", { rect: rect(8, 5, 2, 1) })), LINK_WORDS.wall("Upper floor"));
    const two = withStairs(withStairs(), { id: "l3", pairId: "l4", rect: rect(10, 10), kind: "ladder" });
    assert.equal(refusal(two, update("l1", { rect: rect(10, 10, 2, 1) })), LINK_WORDS.overEnd("ladder", "Upper floor", "Ground floor"));
    assert.equal(refusal(withStairs(), update("l1", { rect: rect(19, 3, 2, 1) })), LINK_WORDS.pastEdge("Ground floor"));
  });

  test("at the scene's cap of pairs an update is not counted against itself", () => {
    let full = withStairs();
    for (let k = 1; k < LIMITS.floorLinksPerScene; k++) full = run(full, putOp({ id: `f${k}a`, pairId: `f${k}b`, sceneId: UPPER, to: ATTIC, rect: rect(k % 10, 14 + Math.floor(k / 10)), kind: "ladder" }));
    const moved = run(full, update("l1", { rect: rect(3, 8, 2, 1), pairRect: rect(3, 8, 2, 1) }));
    assert.deepEqual(end(moved, "l2").rect, rect(3, 8, 2, 1));
    assert.ok(refusal(full, putOp({ id: "x1", pairId: "x2", rect: rect(12, 3) })).startsWith("Tower has"), "a new pair is still refused there");
  });
});

describe("a climb of moved stairs (8.2)", () => {
  test("lands shifted by the far end's offset with what rides on it, both ways", () => {
    const owl = token("owl", { name: "Owl", size: "tiny", x: 3, y: 3, attached: { to: "thorn", kind: "perch" } });
    const s = run(withStairs(tower({ tokens: { thorn: thornToken(), owl } })), update("l2", { rect: rect(8, 5, 2, 1) }));
    const up = applied(s, { t: "token.climb", tokenId: "thorn", linkId: "l1" }, ANA).state;
    assert.deepEqual([up.tokens.thorn!.sceneId, up.tokens.thorn!.x, up.tokens.thorn!.y], [UPPER, 8, 5]);
    assert.deepEqual([up.tokens.owl!.sceneId, up.tokens.owl!.x, up.tokens.owl!.y, up.tokens.owl!.attached?.to], [UPPER, 8, 5, "thorn"]);
    const down = applied(up, { t: "token.climb", tokenId: "thorn", linkId: "l2" }, ANA).state;
    assert.deepEqual([down.tokens.thorn!.sceneId, down.tokens.thorn!.x, down.tokens.thorn!.y], [GROUND, 3, 3]);
  });
});

describe("hidden stairs in the reducer (8.1)", () => {
  test("a player's climb of hidden stairs is no stairs, and the DM's climbs them", () => {
    const hidden = run(withStairs(), update("l1", { hidden: true }));
    assert.equal(refusal(hidden, { t: "token.climb", tokenId: "thorn", linkId: "l1" }, ANA), LINK_WORDS.noStairs);
    assert.equal(applied(hidden, { t: "token.climb", tokenId: "thorn", linkId: "l1" }).state.tokens.thorn!.sceneId, UPPER);
  });
});
