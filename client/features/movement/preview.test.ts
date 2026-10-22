import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { RoomState } from "#shared/model.ts";
import type { Op } from "#shared/protocol.ts";
import { applyOp } from "#shared/reducer.ts";
import type { RoutePiece } from "#shared/rules/route.ts";
import { publicWorld } from "#shared/rules/walkWorld.ts";
import { DM, actor, env, room, token } from "#shared/testutil.ts";
import { dropView, moveOpsOf, planWalk } from "./drop.ts";
import { frameFields, walkPreview } from "./preview.ts";
import { line, raised, thorn, world } from "./testing.ts";
import { ownWalk } from "#shared/rules/movement.ts";

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
    const seen = publicWorld(view, ownWalk(token), { role: "player" });
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
  function riding(diagonal: "five" | "fiveTen" = "five", hidden: "horse" | "bree" | undefined = undefined, step = false): RoomState {
    const unseen = (id: string) => (hidden === id ? { visibility: "dm" as const } : {});
    // With `step`, the horse straddles a 10 ft step, standing on its high half at 10 ft, and Bree sits on its low half.
    const up = step ? { elevation: 10 } : {};
    let state = world({
      blockMovement: false,
      heights: step ? raised(5, 4, 6, 6, 10) : {},
      tokens: [
        token("horse", { name: "Warhorse", kind: "npc", size: "large", x: 4, y: 4, ...up, ...unseen("horse"), actor: { inline: actor({ speeds: { walk: 60 } }) } }),
        token("bree", { name: "Bree", kind: "pc", x: 4, y: 4, ...up, ownerIds: ["p1"], attached: { to: "horse", kind: "ride" }, ...unseen("bree"), actor: { inline: actor({ speeds: { walk: 30 } }) } }),
        token("gob", { x: 20, y: 20 }),
      ],
    });
    state.meta.settings = { ...state.meta.settings, diagonal, revealHiddenOnTurn: false };
    for (const [i, op] of ([{ t: "encounter.start", entries: [{ id: "e1", tokenId: "bree", value: 15 }, { id: "e2", tokenId: "gob", value: 5 }] }, { t: "encounter.next" }] as Op[]).entries()) {
      const r = applyOp(state, op, DM, env(i + 1));
      assert.ok(r.ok);
      state = r.state;
    }
    return state;
  }

  /** The preview's leg and the cost the reducer stores for the op the drop sends, summed over the stops it adds. */
  function both(room: RoomState, target: { x: number; y: number }, pieces?: RoutePiece[]): [number, number] {
    const state = dropView(room, "dm");
    const bree = state.tokens.bree!;
    const answer = pieces ? { kind: "route" as const, route: { pieces, points: [], endsBlocked: false } } : { kind: "open" as const };
    const preview = walkPreview({ view: state, token: bree, target, answer, held: null, world: publicWorld(state, ownWalk(bree), { role: "dm" }), role: "dm" });
    const plan = planWalk(state, bree, target, "free", pieces ? { kind: "route", route: { pieces } } : { kind: "open" }, state.meta.settings.feetPerCell);
    const [move] = moveOpsOf(plan.moves);
    assert.ok(move);
    const r = applyOp(state, move as Op, DM, env(9));
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
    // Round a wall by 5-10-5: down, then east clear of the horse, then one diagonal. The part off the horse keeps its route, so it took no diagonal, and the first diagonal after it is 5 ft (review AT-ASTRA-11).
    assert.deepEqual(both(riding("fiveTen"), { x: 7, y: 6 }, [[4, 5, 0, 0], [6, 5, 0, 0], [7, 6, 0, 0]]), [20, 20]);
    // A drop that keeps her seat is an ordinary leg, and so is one off a mount no player sees (8.0).
    assert.deepEqual(both(riding(), { x: 5, y: 5 }), [5, 5]);
    assert.deepEqual(both(riding("five", "horse"), { x: 8, y: 4 }), [20, 20]);
    // A hidden rider still pays, since only the DM and her owners read her path (review AT-O-19).
    assert.deepEqual(both(riding("five", "bree"), { x: 8, y: 4 }), [25, 25]);
  });

  test("behind the DM's blackout, where no player sees the mount, the DM's band reads the leg the store keeps, on flat ground and off a straddling horse (review AT-O-24)", () => {
    const dark = (state: RoomState): RoomState => ({ ...state, meta: { ...state.meta, view: { ...state.meta.view, blackout: true } } });
    const [flatShown, flatStored] = both(dark(riding()), { x: 8, y: 4 });
    assert.equal(flatShown, flatStored);
    assert.equal(flatStored, 20, "an ordinary leg: the mount every player sees is none behind a blackout");
    const [stepShown, stepStored] = both(dark(riding("five", undefined, true)), { x: 1, y: 4 });
    assert.equal(stepShown, stepStored);
  });

  test("off the low half of a horse straddling a step, the band reads the landing the drop sends, judged by the horse (review AT-ASTRA-13)", () => {
    // By her own footing Bree, at 10 ft over 0 ft ground, would fly off at 10 ft. Off a horse on the ground she lands on it.
    const state = riding("fiveTen", undefined, true);
    const plan = planWalk(dropView(state, "dm"), state.tokens.bree!, { x: 1, y: 4 }, "free", { kind: "open" }, 5);
    assert.equal(plan.moves[0]?.elevation, 0);
    const [shown, stored] = both(state, { x: 1, y: 4 });
    assert.equal(shown, stored);
    // She walks off as a walker on the ground (rules/attach.ts walkerFor): half her Speed to step down clear of the horse, then 10 ft.
    assert.equal(stored, 25);
  });
});
