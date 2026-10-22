import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { RoomState } from "#shared/model.ts";
import type { Op } from "#shared/protocol.ts";
import { applyOp } from "#shared/reducer.ts";
import type { RoutePiece } from "#shared/rules/route.ts";
import { publicWorld } from "#shared/rules/walkWorld.ts";
import { DM, actor, env, room, token } from "#shared/testutil.ts";
import { planWalk } from "./drop.ts";
import { frameFields, walkPreview } from "./preview.ts";
import { line, thorn, world } from "./testing.ts";

/** A lone drag's picture and frames (docs/design-v1-movement.md 3.1, review MV-O-6 and MV-O-9). */

describe("the picture of a drag's walk", () => {
  test("a route past 64 pieces is drawn and read to where it is cut, so its frames stay within the cap", () => {
    const view = world({ blockMovement: false });
    const token = thorn({ x: 0, y: 0 });
    const zigzag = Array.from({ length: 70 }, (_, i): RoutePiece => [i % 2 === 0 ? 1 : 0, i + 1, 0, 0]);
    const preview = walkPreview({ view, token, target: { x: 1, y: 70 }, answer: { kind: "route", route: { pieces: zigzag, points: [], endsBlocked: false } }, held: null, world: null, role: "player" });
    assert.deepEqual(preview.to, { x: zigzag[63]![0], y: zigzag[63]![1] });
    assert.equal(preview.corners.length, 63, "one corner short of the 64 pieces, 126 numbers in a frame");
    // Each piece of the zigzag is one square down and one across: 5 ft under every diagonal 5 ft.
    assert.equal(preview.read.dragFt, 64 * 5);
    // Others' line ends where the walk lands too, not at the finger.
    assert.equal(preview.cut, true);
    const frame = frameFields(preview);
    assert.deepEqual([frame.x, frame.y, frame.path!.length, frame.ft], [zigzag[63]![0], zigzag[63]![1], 126, 320]);
    const whole = walkPreview({ view, token, target: { x: 1, y: 5 }, answer: { kind: "route", route: { pieces: zigzag.slice(0, 5), points: [], endsBlocked: false } }, held: null, world: null, role: "player" });
    assert.deepEqual([whole.cut, frameFields(whole).x], [false, undefined], "a walk not cut leaves the frame at the token");
  });

  test("the picture is the walk the drop lands with, and one past 300 squares of reach, which the drop would not take, is drawn straight", () => {
    const view = world({ blockMovement: false });
    view.scenes.s1 = { ...view.scenes.s1!, bounds: { w: 120, h: 120 } };
    const token = thorn({ x: 0, y: 0 });
    const target = { x: 1, y: 0 };
    const route = (pieces: RoutePiece[]) => ({ kind: "route" as const, route: { pieces, points: [], endsBlocked: false } });
    // Out a hundred squares, across and back: four pieces, 399 squares of reach.
    const far: RoutePiece[] = [[0, 100, 0, 0], [100, 100, 0, 0], [100, 0, 0, 0], [1, 0, 0, 0]];
    const long = walkPreview({ view, token, target, answer: route(far), held: null, world: null, role: "player" });
    assert.deepEqual([long.to, long.corners, long.read.dragFt], [target, [], 5]);
    assert.equal(planWalk(view, token, target, "walk", route(far), 5).moves[0]!.route, undefined, "the drop goes straight too");
    // Within reach the picture's corners are the drop's route.
    const near: RoutePiece[] = [[0, 10, 0, 0], [10, 10, 0, 0], [10, 0, 0, 0], [1, 0, 0, 0]];
    const short = walkPreview({ view, token, target, answer: route(near), held: null, world: null, role: "player" });
    const move = planWalk(view, token, target, "walk", route(near), 5).moves[0]!;
    assert.deepEqual(short.corners, move.route!.slice(0, -1).map(([x, y]) => ({ x, y })));
    assert.deepEqual(short.to, { x: move.x, y: move.y });
  });

  test("a straight walk reads what it walks over as the drop counts it, once its own route is checked (review ASTRA-15)", () => {
    const view = world({ edges: line("w", 6, 0, 30) });
    const chunk = view.buildChunks["s1:0,0"] ?? { sceneId: "s1", cx: 0, cy: 0, rev: 1, cells: {}, edges: {} };
    view.buildChunks["s1:0,0"] = { ...chunk, cells: { ...chunk.cells, "4,5": "rubble" } };
    const token = thorn({ x: 2, y: 5 });
    const held = { x: 5, y: 5 };
    const none = { kind: "none" as const, capped: false };
    // Held at the wall over a square of rubble: 15 ft straight, 20 ft walked, and the drop sends the walk.
    const seen = publicWorld(view, token, { role: "player" });
    const plain = walkPreview({ view, token, target: { x: 9, y: 5 }, answer: none, held, world: seen, role: "player" });
    assert.equal(plain.read.dragFt, 15, "before its route is checked");
    const pieces: RoutePiece[] = [[3, 5, 0, 0], [4, 5, 1, 0], [5, 5, 0, 0]];
    const walked = walkPreview({ view, token, target: { x: 9, y: 5 }, answer: none, held, world: seen, role: "player", straight: { to: held, pieces } });
    assert.deepEqual([walked.to, walked.read.dragFt], [held, 20]);
    const drop = planWalk(view, token, { x: 9, y: 5 }, "walk", none, 5, () => ({ kind: "route", route: { pieces } }));
    assert.deepEqual([drop.moves[0]!.x, drop.moves[0]!.route, drop.stop?.searched], [5, pieces, true]);
  });

  test("a walk held at a wall is drawn and read to the wall, not through it", () => {
    const view = world({ edges: line("w", 6, 0, 30) });
    const token = thorn({ x: 2, y: 5 });
    const held = { x: 5, y: 5 };
    const preview = walkPreview({ view, token, target: { x: 9, y: 5 }, answer: { kind: "none", capped: false }, held, world: null, role: "player" });
    assert.deepEqual([preview.to, preview.corners, preview.read.dragFt], [held, [], 15]);
    const free = walkPreview({ view, token, target: { x: 9, y: 5 }, answer: { kind: "none", capped: false }, held: null, world: null, role: "player" });
    assert.deepEqual([free.to, free.read.dragFt], [{ x: 9, y: 5 }, 35], "nothing held: the finger's spot");
  });
});

describe("a drag off a ride reads what the reducer stores (docs/design-v1-attach.md 7.3)", () => {
  /** Bree (P1's, walking 30 ft) on her own turn, riding an independent warhorse at 4,4. */
  function riding(diagonal: "five" | "fiveTen" = "five"): RoomState {
    let state = room({
      tokens: {
        horse: token("horse", { name: "Warhorse", kind: "npc", size: "large", x: 4, y: 4, actor: { inline: actor({ speeds: { walk: 60 } }) } }),
        bree: token("bree", { name: "Bree", kind: "pc", x: 4, y: 4, ownerIds: ["p1"], attached: { to: "horse", kind: "ride" }, actor: { inline: actor({ speeds: { walk: 30 } }) } }),
        gob: token("gob", { x: 20, y: 20 }),
      },
    });
    state.meta.settings = { ...state.meta.settings, diagonal };
    for (const [i, op] of ([{ t: "encounter.start", entries: [{ id: "e1", tokenId: "bree", value: 15 }, { id: "e2", tokenId: "gob", value: 5 }] }, { t: "encounter.next" }] as Op[]).entries()) {
      const r = applyOp(state, op, DM, env(i + 1));
      assert.ok(r.ok);
      state = r.state;
    }
    return state;
  }

  /** The preview's leg and the cost the reducer stores for the same drop, summed over the stops it adds. */
  function both(state: RoomState, target: { x: number; y: number }, pieces?: RoutePiece[]): [number, number] {
    const bree = state.tokens.bree!;
    const answer = pieces ? { kind: "route" as const, route: { pieces, points: [], endsBlocked: false } } : { kind: "open" as const };
    const preview = walkPreview({ view: state, token: bree, target, answer, held: null, world: publicWorld(state, bree, { role: "dm" }), role: "dm" });
    const r = applyOp(state, { t: "token.move", tokenId: "bree", x: target.x, y: target.y, ...(pieces ? { route: pieces } : {}) }, DM, env(9));
    assert.ok(r.ok);
    const before = bree.path?.stops.length ?? 1;
    const stored = r.state.tokens.bree!.path!.stops.slice(before).reduce((sum, s) => sum + (s.cost ?? 0), 0);
    return [preview.read.dragFt, stored];
  }

  test("straight off, routed off and with the 5-10-5 diagonals running on, the band reads the stored half Speed and the rest", () => {
    assert.deepEqual(both(riding(), { x: 8, y: 4 }), [25, 25]);
    assert.deepEqual(both(riding(), { x: 7, y: 6 }, [[7, 4, 0, 0], [7, 6, 0, 0]]), [30, 30]);
    const [shown, stored] = both(riding("fiveTen"), { x: 8, y: 8 });
    assert.equal(shown, stored);
    // A drop that keeps her seat is an ordinary leg.
    assert.deepEqual(both(riding(), { x: 5, y: 5 }), [5, 5]);
  });
});
