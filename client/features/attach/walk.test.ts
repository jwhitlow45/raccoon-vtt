import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { SQUARES } from "#shared/rules/grid.ts";
import type { EdgeFeature, RoomState, Token } from "#shared/model.ts";
import type { Op } from "#shared/protocol.ts";
import { applyOp } from "#shared/reducer.ts";
import { findRoute, WalkWorld, WorkBudget } from "#shared/rules/walk.ts";
import { groupWalkWorld, halvedAt, publicWorld, speedAreas } from "#shared/rules/walkWorld.ts";
import { canApply, LEDGE_IN_THE_WAY_BACK } from "#shared/permissions.ts";
import type { RoutePiece } from "#shared/rules/route.ts";
import { dropView, holdLabel, moveOpsOf, planGroup, planOne, planWalk, routeLanding, stopText, walkersStop, type Landed } from "../movement/drop.ts";
import { DM, P1, actor, effect, env, reveal, template, token } from "#shared/testutil.ts";
import { dragOf, groupDragOf } from "../movement/dragTesting.ts";
import { copyFor } from "./testing.ts";
import { worldFor } from "../movement/press.ts";
import { line, onTurn, raised, thorn, world } from "../movement/testing.ts";
import { extraWords } from "../measure/movement.ts";
import { tokenStop, type RulerStop } from "../measure/ruler.ts";
import { measureWalk } from "../measure/walkRuler.ts";
import { towingWord, walkersFor, walkersOfGroup } from "./walk.ts";
import { detachOp, getOffPlace } from "./detach.ts";
import { LEDGE_IN_THE_WAY, WALL_IN_THE_WAY, coreBlocked, legBlocker, ownWalk, walkEnd } from "#shared/rules/movement.ts";
import { landsAt, walkerFor } from "#shared/rules/attach.ts";

const goblin = (over: Partial<Token> = {}) => token("goblin", { name: "Goblin", x: 3, y: 5, attached: { to: "thorn", kind: "drag" }, ...over });

describe("a holder's walk", () => {
  test("dragging a creature costs every foot one more, on every piece of the route, and the creature never stands in the way", () => {
    const state = world({ blockMovement: false, tokens: [thorn({ x: 2, y: 5 }), goblin()] });
    const mover = state.tokens.thorn!;
    const plain = publicWorld(state, ownWalk(mover), { role: "player" });
    assert.equal(plain.spaces.some((s) => s.id === "goblin"), true);
    const grouped = groupWalkWorld(state, ownWalk(mover), { role: "player" });
    assert.equal(grouped.input.drag, 1);
    assert.equal(grouped.spaces.some((s) => s.id === "goblin"), false);
    assert.equal(grouped.input.creatures.length, grouped.spaces.length);
    const route = findRoute(grouped.input, { x: 6, y: 5 });
    assert.ok(route && route !== "none", "an open leg that costs extra is searched as a route");
    assert.ok(route.pieces.every((p) => p[2] === 1), "each piece carries the dragging foot");
  });

  test("a Tiny creature, one two sizes smaller and one players cannot see cost nothing, and a lone token's world is as it was", () => {
    const tiny = world({ tokens: [thorn({ x: 2, y: 5 }), goblin({ size: "tiny" })] });
    assert.equal(groupWalkWorld(tiny, ownWalk(tiny.tokens.thorn!), { role: "player" }).input.drag ?? 0, 0);
    const hidden = world({ tokens: [thorn({ x: 2, y: 5 }), goblin({ visibility: "dm" })] });
    assert.equal(groupWalkWorld(hidden, ownWalk(hidden.tokens.thorn!), { role: "dm" }).input.drag ?? 0, 0);
    const alone = world({ tokens: [thorn({ x: 2, y: 5 })] });
    assert.deepEqual(groupWalkWorld(alone, ownWalk(alone.tokens.thorn!), { role: "player" }).input.creatures, publicWorld(alone, ownWalk(alone.tokens.thorn!), { role: "player" }).input.creatures);
  });

  test("the label names the extra foot by how the holder moves the creature, apart from the ground's", () => {
    const state = world({ tokens: [thorn({ x: 2, y: 5 }), goblin()] });
    assert.equal(towingWord(state, "thorn", "player"), "dragging");
    const carried = world({ tokens: [thorn({ x: 2, y: 5 }), goblin({ size: "small", attached: { to: "thorn", kind: "carry" } })] });
    assert.equal(towingWord(carried, "thorn", "player"), "carrying");
    assert.deepEqual(extraWords([[4, 5, 1, 0]], false, false, "dragging"), ["dragging"]);
    assert.deepEqual(extraWords([[4, 5, 2, 0]], false, false, "dragging"), ["difficult terrain", "dragging"]);
    assert.deepEqual(extraWords([[4, 5, 1, 0]], false, false), ["difficult terrain"], "without a tow the foot is the ground's");
    assert.deepEqual(extraWords([[4, 5, 2, 0]], true, false, "carrying"), ["crawling", "carrying"]);
  });

  test("a walk held at its own wall and cut where the creature it drags meets one reads the cost its move stores", () => {
    // No way round the wall at x = 10, so the walk goes straight and holds at x = 9. The goblin, a row up, meets the wall at x = 6 first.
    for (const rubble of [false, true]) {
      const base = world({ edges: { ...line("w", 6, 0, 5), ...line("w", 10, 0, 30) }, tokens: [thorn({ x: 2, y: 5, actor: { inline: actor({ speeds: { walk: 60 } }) } }), goblin({ x: 2, y: 4, size: "small", actor: { inline: actor({ effects: [effect("g1", { key: "grappled" })] }) } })] });
      if (rubble) {
        const chunk = base.buildChunks["s1:0,0"] ?? { sceneId: "s1", cx: 0, cy: 0, rev: 1, cells: {}, edges: {} };
        base.buildChunks["s1:0,0"] = { ...chunk, cells: { ...chunk.cells, "3,5": "rubble", "4,5": "rubble" } };
      }
      const state = onTurn(base, "thorn");
      const drag = dragOf(copyFor(state, P1), "player", "thorn", { x: 12, y: 5 });
      assert.equal(drag.answer.kind, "none");
      const r = applyOp(state, drag.op as Op, P1, env(50));
      assert.ok(r.ok);
      const after = r.state.tokens.thorn!;
      const stored = after.path!.stops.slice(1).reduce((sum, s) => sum + (s.cost ?? 0), 0);
      assert.deepEqual([drag.preview.to, after.x, after.y], [{ x: 5, y: 5 }, 5, 5]);
      assert.deepEqual([drag.preview.read.dragFt, drag.frame.ft], [stored, stored], rubble ? "over rubble" : "on open ground");
      // Thorn has no way either, so the note says there is none rather than naming the goblin.
      assert.equal(stopText(drag.plan.stop!), "Stopped at a wall. There is no way around it that you have seen.");
    }
  });

  test("the walkers are the dragged creatures players see", () => {
    const state = world({ edges: line("w", 6, 0, 5), tokens: [thorn({ x: 2, y: 5 }), goblin(), token("ghost", { x: 1, y: 5, visibility: "dm", attached: { to: "thorn", kind: "drag" } })] });
    assert.deepEqual(walkersFor(state, "thorn", "dm").map((t) => t.id), ["goblin"]);
  });
});

describe("a holder's route search walks the creature it drags beside it with it (review LP12-AT-2)", () => {
  /**
   * Thorn (P1's, on his turn) drags a grappled goblin standing east of him, a wall along row 8 between them and the spot
   * below. `gaps` are the columns open in the wall: a 5 ft door at x 5, and maybe a 10 ft gap at x 12 and 13.
   */
  function towing(wide: boolean, goblinAt: { x: number; y: number } = { x: 5, y: 4 }, thornAt: { x: number; y: number } = { x: 4, y: 4 }): RoomState {
    const gaps = wide ? [5, 12, 13] : [5];
    const edges: Record<string, EdgeFeature> = {};
    for (let x = 0; x < 30; x++) if (!gaps.includes(x)) edges[`${x},8,n`] = { kind: "wall" };
    const grappledGoblin = goblin({ ...goblinAt, size: "small", actor: { inline: actor({ effects: [effect("g1", { key: "grappled" })] }) } });
    return onTurn(world({ edges, tokens: [thorn({ ...thornAt, actor: { inline: actor({ speeds: { walk: 60 } }) } }), grappledGoblin] }), "thorn");
  }

  test("past a 5 ft door the goblin cannot follow beside him, the drag finds the 10 ft gap they both fit through, and the server takes it", () => {
    const state = towing(true);
    const drag = dragOf(copyFor(state, P1), "player", "thorn", { x: 4, y: 11 });
    assert.equal(drag.answer.kind, "route");
    const op = drag.op as Op & { t: "token.move" };
    assert.deepEqual([op.x, op.y, drag.plan.stop, drag.hold], [4, 11, null, null]);
    assert.ok(op.route?.some(([x]) => x >= 12), `through the wide gap: ${JSON.stringify(op.route)}`);
    assert.ok(canApply(op, P1, state, { canUseAsset: () => true }).ok, JSON.stringify(op));
    const r = applyOp(state, op, P1, env(20));
    assert.ok(r.ok);
    assert.deepEqual([r.state.tokens.thorn!.x, r.state.tokens.thorn!.y, r.state.tokens.goblin!.x, r.state.tokens.goblin!.y], [4, 11, 5, 11]);
    const stored = r.state.tokens.thorn!.path!.stops.slice(1).reduce((sum, st) => sum + (st.cost ?? 0), 0);
    assert.deepEqual([drag.preview.read.dragFt, drag.frame.ft], [stored, stored]);
    // A walking ruler reads the drag it stands for, the same way round.
    const copy = copyFor(state, P1);
    const ruler = measureWalk({ view: copy, sceneId: "s1", stops: [tokenStop(SQUARES, copy.tokens.thorn!), { x: 4.5, y: 11.5 }], viewer: { role: "player" }, everything: false })!;
    assert.deepEqual(ruler.legs.map((leg) => [leg.ft, leg.none]), [[stored, false]]);
  });

  test("with only the 5 ft door, the drag reads No way through and the note names the goblin, held where it meets the wall", () => {
    const state = towing(false, { x: 6, y: 4 }, { x: 5, y: 4 });
    const drag = dragOf(copyFor(state, P1), "player", "thorn", { x: 5, y: 11 });
    assert.equal(drag.answer.kind, "none");
    assert.ok(drag.hold);
    assert.equal(holdLabel(drag.hold.blocker, drag.hold.noWay === true), "No way through");
    assert.equal(stopText(drag.plan.stop!), "Goblin can't follow through there.");
    const op = drag.op as Op & { t: "token.move" };
    assert.deepEqual([op.x, op.y, drag.preview.to], [5, 7, { x: 5, y: 7 }]);
    assert.ok(canApply(op, P1, state, { canUseAsset: () => true }).ok, JSON.stringify(op));
    // The ruler reads the leg as no way through too.
    const copy = copyFor(state, P1);
    const ruler = measureWalk({ view: copy, sceneId: "s1", stops: [tokenStop(SQUARES, copy.tokens.thorn!), { x: 5.5, y: 11.5 }], viewer: { role: "player" }, everything: false })!;
    assert.deepEqual(ruler.legs.map((leg) => leg.none), [true]);
  });

  test("the goblin keeps to ground players have seen: its step past a square under the fog never reads the square, raised or not (review FU20A-ASTRA-4)", () => {
    // Fog over the one square (6, 4) whose corner the goblin's diagonal step from (5, 4) to (6, 3) cuts, as Thorn steps from (4, 4) to (5, 3).
    const clears = [0, 10].map((feet) => {
      const grappledGoblin = goblin({ x: 5, y: 4, size: "small", actor: { inline: actor({ effects: [effect("g1", { key: "grappled" })] }) } });
      const state = onTurn(world({ heights: { "6,4": feet }, tokens: [thorn({ x: 4, y: 4, actor: { inline: actor({ speeds: { walk: 60 } }) } }), grappledGoblin] }), "thorn");
      state.scenes.s1 = { ...state.scenes.s1!, fogEnabled: true };
      reveal(state, "s1", { x: 0, y: 0, w: 6, h: 30 });
      reveal(state, "s1", { x: 6, y: 0, w: 24, h: 4 });
      reveal(state, "s1", { x: 6, y: 5, w: 24, h: 25 });
      reveal(state, "s1", { x: 7, y: 4, w: 23, h: 1 });
      const copy = copyFor(state, P1);
      const walk = new WalkWorld(worldFor(dropView(copy, "player"), copy.tokens.thorn!, "player").input);
      assert.equal(walk.tows, true);
      return [walk.towedClear(4, 4, 5, 3), walk.towedClear(4, 4, 4, 3)];
    });
    assert.deepEqual(clears, [[false, true], [false, true]]);
  });

  test("a goblin held 5 ft up beside him walks on its own ground behind his walk, so the drag takes him round raised ground it cannot climb, and the server takes it (review FU20A-ASTRA-3)", () => {
    const grappledGoblin = goblin({ x: 5, y: 4, elevation: 5, size: "small", actor: { inline: actor({ effects: [effect("g1", { key: "grappled" })] }) } });
    const state = onTurn(world({ heights: { "5,8": 5, "5,9": 5 }, tokens: [thorn({ x: 4, y: 4, actor: { inline: actor({ speeds: { walk: 60 } }) } }), grappledGoblin] }), "thorn");
    const drag = dragOf(copyFor(state, P1), "player", "thorn", { x: 4, y: 11 });
    assert.equal(drag.answer.kind, "route");
    const op = drag.op as Op & { t: "token.move" };
    assert.deepEqual([op.x, op.y, drag.plan.stop], [4, 11, null]);
    assert.ok(canApply(op, P1, state, { canUseAsset: () => true }).ok, JSON.stringify(op));
    const r = applyOp(state, op, P1, env(20));
    assert.ok(r.ok);
    assert.deepEqual([r.state.tokens.goblin!.x, r.state.tokens.goblin!.y, r.state.tokens.goblin!.elevation], [5, 11, 0]);
  });

  test("a goblin held 10 ft up over a 5 ft block beside him comes down to its ground at its first step, which the block's edge stops as the server's leg test reads it, so the note names it (review FU20A-ASTRA-3)", () => {
    const grappledGoblin = goblin({ x: 5, y: 4, elevation: 10, size: "small", actor: { inline: actor({ effects: [effect("g1", { key: "grappled" })] }) } });
    const state = onTurn(world({ heights: { "5,4": 5 }, tokens: [thorn({ x: 4, y: 4, actor: { inline: actor({ speeds: { walk: 60 } }) } }), grappledGoblin] }), "thorn");
    const drag = dragOf(copyFor(state, P1), "player", "thorn", { x: 4, y: 11 });
    assert.equal(drag.answer.kind, "none");
    assert.equal(stopText(drag.plan.stop!), "Goblin can't follow through there.");
    // Held where he stands, so nothing is sent, and the server refuses the straight walk there.
    assert.deepEqual([drag.op, drag.hold?.at, drag.hold?.noWay], [null, { x: 4, y: 4 }, true]);
    const straight = canApply({ t: "token.move", tokenId: "thorn", x: 4, y: 11 }, P1, state, { canUseAsset: () => true });
    assert.deepEqual(straight.ok ? null : straight.message, LEDGE_IN_THE_WAY);
  });

  test("a goblin straight behind him follows him through the 5 ft door, and alone he walks round the wall as before", () => {
    const behind = towing(false, { x: 5, y: 3 }, { x: 5, y: 4 });
    const drag = dragOf(copyFor(behind, P1), "player", "thorn", { x: 5, y: 11 });
    const op = drag.op as Op & { t: "token.move" };
    assert.deepEqual([op.x, op.y, drag.plan.stop], [5, 11, null]);
    const alone = towing(false, { x: 6, y: 4 }, { x: 5, y: 4 });
    delete alone.tokens.goblin;
    const walk = dragOf(copyFor(alone, P1), "player", "thorn", { x: 5, y: 11 });
    assert.deepEqual([(walk.op as Op & { t: "token.move" }).y, walk.plan.stop], [11, null]);
  });
});

describe("a new seat on a holder over uneven ground (docs/design-v1-attach.md 4.1)", () => {
  test("is planned at the holder's elevation, which the server takes from a player who may only re-seat the token", () => {
    // P1's warhorse straddles a 10 ft step, standing at 10 ft, and carries the DM's grappled kobold on its high half.
    const horse = token("horse", { name: "Warhorse", kind: "npc", size: "large", x: 4, y: 4, elevation: 10, ownerIds: ["p1"] });
    const kobold = token("kobold", { name: "Kobold", size: "small", x: 5, y: 4, elevation: 10, attached: { to: "horse", kind: "carry" }, actor: { inline: actor({ effects: [effect("g", { key: "grappled" })] }) } });
    const state = world({ blockMovement: false, heights: raised(5, 4, 6, 6, 10), tokens: [horse, kobold] });
    const answer = (moves: Landed[]) => canApply(moveOpsOf(moves)[0]!, P1, state, { canUseAsset: () => true }).ok;
    const seated = planOne(dropView(state, "player"), state.tokens.kobold!, { x: 4, y: 4 }, "free").moves;
    assert.deepEqual(seated, [{ tokenId: "kobold", x: 4, y: 4 }], "at the holder's 10 ft, its own height, not the low ground under its new seat");
    assert.equal(answer(seated), true);
    // Off its holder, a drop lands on the ground as a Get off does, judged from the horse on the ground.
    assert.deepEqual(planOne(dropView(state, "player"), state.tokens.kobold!, { x: 9, y: 9 }, "free").moves, [{ tokenId: "kobold", x: 9, y: 9, elevation: 0 }]);
    // Kept on the low half's seat, a drag off it by its own footing would stay at 10 ft over 0 ft ground.
    const low = world({ blockMovement: false, heights: raised(5, 4, 6, 6, 10), tokens: [horse, { ...kobold, x: 4, y: 4 }] });
    assert.deepEqual(planOne(dropView(low, "player"), low.tokens.kobold!, { x: 2, y: 4 }, "free").moves, [{ tokenId: "kobold", x: 2, y: 4, elevation: 0 }]);
  });
});

describe("a walk off a holder on the ground, searched, checked and stored on the ground (reviews AT-ASTRA-13 and AT-O-22)", () => {
  /** P1's Bree at 10 ft on the low half of a warhorse standing on a 10 ft step to its east, a 5 ft block at 2,4, on her turn. */
  function straddle(over: Partial<Token> = {}): RoomState {
    const horse = token("horse", { name: "Warhorse", kind: "npc", size: "large", x: 4, y: 4, elevation: 10, ownerIds: ["p1"], ...over });
    const bree = token("bree", { name: "Bree", kind: "pc", ownerIds: ["p1"], x: 4, y: 4, elevation: 10, attached: { to: "horse", kind: "ride" }, actor: { inline: actor({ speeds: { walk: 30 } }) } });
    let state = world({ heights: { ...raised(5, 0, 30, 30, 10), "2,4": 5 }, tokens: [horse, bree, token("gob", { x: 20, y: 20 })] });
    state.meta.settings = { ...state.meta.settings, diagonal: "fiveTen" };
    for (const [i, op] of ([{ t: "encounter.start", entries: [{ id: "e1", tokenId: "bree", value: 15 }, { id: "e2", tokenId: "gob", value: 5 }] }, { t: "encounter.next" }] as Op[]).entries()) {
      const r = applyOp(state, op, DM, env(i + 1));
      assert.ok(r.ok);
      state = r.state;
    }
    return state;
  }

  test("a drag west walks round the block on the ground, lands where the picture shows and stores what it read", () => {
    const state = straddle();
    const drag = dragOf(copyFor(state, P1), "player", "bree", { x: 1, y: 4 });
    assert.equal(drag.answer.kind, "route", "from the seat she walks on the ground, so the block's ledge stops the straight leg");
    const op = drag.op as Op;
    assert.equal(canApply(op, P1, state, { canUseAsset: () => true }).ok, true);
    const r = applyOp(state, op, P1, env(9));
    assert.ok(r.ok);
    const bree = r.state.tokens.bree!;
    assert.deepEqual([drag.preview.to, bree.elevation], [{ x: bree.x, y: bree.y }, 0]);
    assert.equal(drag.preview.read.dragFt, bree.path!.stops.slice(1).reduce((sum, s) => sum + (s.cost ?? 0), 0));
  });

  test("a route's landing, kept per route, is worked out again once the holder goes out of every player's sight", () => {
    const seen = straddle();
    const hidden: RoomState = { ...seen, tokens: { ...seen.tokens, horse: { ...seen.tokens.horse!, visibility: "dm" } } };
    // One route for both rooms, which share the build and the scene: only the holder's sight differs.
    const pieces: RoutePiece[] = [
      [3, 5, 0, 0],
      [1, 5, 0, 0],
    ];
    const ends = [seen, hidden].map((s) => routeLanding(dropView(s, "dm"), s.tokens.bree!, { x: 1, y: 5 }, pieces, 5)?.points.at(-1)?.elevation);
    assert.deepEqual(ends, [0, 10], "off a horse every player sees she lands on the ground, off one they cannot as a flier keeps her height");
  });

  test("the DM's drag off a holder no player sees lands and walks as a drag with no holder, op for op", () => {
    // Room a: a lone torch at 10 ft over the low half. Room b: the same torch, carried by a horse no player sees.
    const torch = (s: RoomState, linked: boolean) => {
      s.tokens.torch = token("torch", { name: "Torch", kind: "object", size: "tiny", x: 4, y: 4, elevation: 10, ...(linked ? { attached: { to: "horse", kind: "carry" } } : {}) });
      return s;
    };
    const a = torch(straddle({ visibility: "dm", ownerIds: [] }), false);
    const b = torch(straddle({ visibility: "dm", ownerIds: [] }), true);
    assert.deepEqual(copyFor(a, P1).tokens, copyFor(b, P1).tokens);
    for (const raw of [{ x: 1, y: 4 }, { x: 4.5, y: 4.5 }]) {
      const ops = [a, b].map((s) => dragOf(s, "dm", "torch", raw).op);
      assert.deepEqual(ops[0], ops[1], JSON.stringify(raw));
      const after = [a, b].map((s, i) => {
        const r = applyOp(s, ops[i] as Op, DM, env(9));
        assert.ok(r.ok);
        return copyFor(r.state, P1).tokens.torch;
      });
      assert.deepEqual(after[0], after[1], JSON.stringify(raw));
    }
  });
});

describe("a walk off a holder that straddles a step starts on the ground under the rider (review LP12-AT-4)", () => {
  /**
   * The warhorse at 10 ft on the platform's east step, its west half over the 10 ft platform at x 7 and its east half
   * over the low ground at x 8, with P1's Bree seated on its low half on an Independent ride, on her own turn, and now and
   * then the dust of review LP12-AT-4 on the horse, which slows whoever walks through it.
   */
  function step(dust: boolean): RoomState {
    const horse = token("horse", { name: "Warhorse", kind: "npc", size: "large", x: 7, y: 12, elevation: 10, actor: { inline: actor({ speeds: { walk: 60 } }) } });
    const bree = token("bree", { name: "Bree", kind: "pc", ownerIds: ["p1"], x: 8, y: 13, elevation: 10, attached: { to: "horse", kind: "ride" }, actor: { inline: actor({ speeds: { walk: 30 } }) } });
    let state = world({ heights: raised(0, 0, 8, 30, 10), tokens: [horse, bree] });
    if (dust) state.templates.dust = template("dust", { shape: "emanation", size: 10, attachedTo: "horse", includeOrigin: true, slows: { kind: "difficult" } });
    for (const [i, op] of ([{ t: "encounter.start", entries: [{ id: "e1", tokenId: "bree", value: 15 }] }, { t: "encounter.next" }] as Op[]).entries()) {
      const r = applyOp(state, op, DM, env(i + 1));
      assert.ok(r.ok);
      state = r.state;
    }
    return state;
  }

  test("two squares east count 10 ft walked, as a route through the dust and as a straight leg alike, and the label reads what the move stores", () => {
    for (const dust of [false, true]) {
      const state = step(dust);
      const drag = dragOf(copyFor(state, P1), "player", "bree", { x: 10, y: 13 });
      const op = drag.op as Op & { t: "token.move" };
      assert.deepEqual([op.x, op.y, op.route !== undefined], [10, 13, dust], dust ? "a route through the dust" : "the straight leg");
      const r = applyOp(state, op, P1, env(9));
      assert.ok(r.ok, r.ok ? "" : r.message);
      const stops = r.state.tokens.bree!.path!.stops.slice(1);
      assert.equal(stops.reduce((sum, st) => sum + (st.moved ?? 0), 0), 10, "the seat's 10 ft above the ground is no distance");
      assert.equal(drag.preview.read.dragFt, stops.reduce((sum, st) => sum + (st.cost ?? 0), 0), "the label reads what the move stores");
      // Getting off costs half her Speed, then the square past the horse 5 ft, or 10 ft through the dust.
      assert.equal(drag.preview.read.dragFt, dust ? 25 : 20);
    }
  });

  test("a step to another seat on the horse keeps her seat's height, so one square north reads 5 ft, as the move stores (review FU20A-OP-7)", () => {
    const state = step(false);
    const drag = dragOf(copyFor(state, P1), "player", "bree", { x: 8, y: 12 });
    const op = drag.op as Op & { t: "token.move" };
    assert.deepEqual([op.x, op.y, op.elevation ?? 10], [8, 12, 10], "still on the horse, at its height");
    const r = applyOp(state, op, P1, env(9));
    assert.ok(r.ok, r.ok ? "" : r.message);
    assert.equal(r.state.tokens.bree!.attached?.to, "horse");
    const stops = r.state.tokens.bree!.path!.stops.slice(1);
    assert.deepEqual(stops.map((st) => [st.moved, st.cost]), [[5, 5]]);
    assert.deepEqual([drag.preview.read.dragFt, drag.frame.ft], [5, 5]);
  });
});

describe("a group drag off a ride reads the dismount the reducer stores (review AT-ASTRA-15)", () => {
  test("a rider with 30 ft of Speed leaving her horse on her turn beside a token of hers: 15 ft to get off and 10 ft on, so 5 ft left", () => {
    const horse = token("horse", { name: "Warhorse", kind: "npc", size: "large", x: 4, y: 4, actor: { inline: actor({ speeds: { walk: 60 } }) } });
    const bree = token("bree", { name: "Bree", kind: "pc", ownerIds: ["p1"], x: 4, y: 4, attached: { to: "horse", kind: "ride" }, actor: { inline: actor({ speeds: { walk: 30 } }) } });
    let state = world({ tokens: [horse, bree, token("mate", { name: "Mate", kind: "pc", ownerIds: ["p1"], x: 10, y: 10 })] });
    for (const [i, op] of ([{ t: "encounter.start", entries: [{ id: "e1", tokenId: "bree", value: 15 }] }, { t: "encounter.next" }] as Op[]).entries()) {
      const r = applyOp(state, op, DM, env(i + 1));
      assert.ok(r.ok);
      state = r.state;
    }
    const drag = groupDragOf(copyFor(state, P1), "player", ["bree", "mate"], { x: 1, y: 4 });
    const r = applyOp(state, drag.op as Op, P1, env(9));
    assert.ok(r.ok);
    const stored = r.state.tokens.bree!.path!.stops.slice(1).reduce((sum, st) => sum + (st.cost ?? 0), 0);
    assert.deepEqual([stored, drag.label.dragFt, drag.frame.ft, drag.label.left?.leftFt], [25, 25, 25, 5]);
  });
});

describe("every check of a walk off a holder on the ground walks it on the ground, crossing only the ledges inside the holder (reviews AT-ASTRA-13, AT-O-25 and AT-O-26)", () => {
  /**
   * P1's Bree on the west half of a warhorse at 10 ft, in a 10 ft deep trench two squares wide (x 3 and 4) that runs the
   * scene's height, the horse's east half on the high ground at x 5. Her own turn, with a grappled goblin she may drag
   * and a companion of hers on the high ground.
   */
  function trench(extra: Token[] = []): RoomState {
    const horse = token("horse", { name: "Warhorse", kind: "npc", size: "large", x: 4, y: 4, elevation: 10, actor: { inline: actor({ speeds: { walk: 60 } }) } });
    const bree = token("bree", { name: "Bree", kind: "pc", ownerIds: ["p1"], x: 4, y: 4, elevation: 10, attached: { to: "horse", kind: "ride" }, actor: { inline: actor({ speeds: { walk: 30 } }) } });
    let state = world({ heights: { ...raised(0, 0, 3, 30, 10), ...raised(5, 0, 30, 30, 10) }, tokens: [horse, bree, ...extra] });
    for (const [i, op] of ([{ t: "encounter.start", entries: [{ id: "e1", tokenId: "bree", value: 15 }] }, { t: "encounter.next" }] as Op[]).entries()) {
      const r = applyOp(state, op, DM, env(i + 1));
      assert.ok(r.ok);
      state = r.state;
    }
    return state;
  }

  test("a drag out of the trench finds no way, is held at the ledge on the trench's floor, and the server refuses the plain leg over it", () => {
    const state = trench();
    const drag = dragOf(copyFor(state, P1), "player", "bree", { x: 1, y: 4 });
    assert.equal(drag.answer.kind, "none");
    const op = drag.op as Op & { t: "token.move" };
    assert.deepEqual([op.x, op.y, drag.plan.stop?.blocker], [3, 4, "ledge"]);
    assert.equal(canApply(op, P1, state, { canUseAsset: () => true }).ok, true);
    const r = applyOp(state, op, P1, env(9));
    assert.ok(r.ok);
    assert.deepEqual([r.state.tokens.bree!.x, r.state.tokens.bree!.elevation, drag.preview.to], [3, 0, { x: 3, y: 4 }]);
    const over = canApply({ t: "token.move", tokenId: "bree", x: 1, y: 4 }, P1, state, { canUseAsset: () => true });
    assert.deepEqual(over.ok ? null : over.message, LEDGE_IN_THE_WAY);
  });

  test("a group with the rider dragging a creature beside her sends only legs the server takes, and holds back the rest", () => {
    const goblin = token("goblin", { name: "Goblin", size: "small", x: 3, y: 4, attached: { to: "bree", kind: "drag" }, actor: { inline: actor({ effects: [effect("g1", { key: "grappled" })] }) } });
    const state = trench([goblin, token("mate", { name: "Mate", kind: "pc", ownerIds: ["p1"], x: 8, y: 8, elevation: 10 })]);
    let held = 0;
    for (const [dx, dy] of [[0, 3], [0, -3], [-2, 0], [2, 0], [-3, 0], [1, 3]] as const) {
      const view = dropView(copyFor(state, P1), "player");
      const plan = planGroup(view, [view.tokens.bree!, view.tokens.mate!], dx, dy, "walk", walkersOfGroup(view, [view.tokens.bree!, view.tokens.mate!], "player"));
      held += plan.held.length;
      for (const op of moveOpsOf(plan.moves)) {
        const answer = canApply(op, P1, state, { canUseAsset: () => true });
        assert.ok(answer.ok, `${dx},${dy}: ${answer.ok ? "" : answer.message} for ${JSON.stringify(op)}`);
      }
      // Each leg as the server's own leg test walks it, the rider's on the ground.
      for (const m of plan.moves) {
        const end = { x: m.x, y: m.y, elevation: m.elevation ?? state.tokens[m.tokenId]!.elevation };
        assert.equal(legBlocker(state, walkerFor(state, state.tokens[m.tokenId]!, () => true), end), null, `${dx},${dy}: ${JSON.stringify(m)}`);
      }
    }
    assert.ok(held >= 3, `${held} held`);
  });

  test("a drag east crosses the step under the horse onto the high ground, and routes round a wall from there", () => {
    for (const walled of [false, true]) {
      const state = trench();
      if (walled) state.buildChunks = world({ heights: { ...raised(0, 0, 3, 30, 10), ...raised(5, 0, 30, 30, 10) }, edges: line("w", 8, 0, 6) }).buildChunks;
      const drag = dragOf(copyFor(state, P1), "player", "bree", { x: 10, y: 4 });
      const op = drag.op as Op & { t: "token.move" };
      assert.deepEqual([op.x, op.y, drag.plan.stop], [10, 4, null], walled ? "round the wall" : "straight");
      if (walled) assert.ok((op.route?.length ?? 0) > 1, JSON.stringify(op));
      assert.equal(canApply(op, P1, state, { canUseAsset: () => true }).ok, true, JSON.stringify(op));
      const r = applyOp(state, op, P1, env(9));
      assert.ok(r.ok);
      assert.deepEqual([drag.preview.to, r.state.tokens.bree!.elevation], [{ x: 10, y: 4 }, 10]);
      assert.equal(drag.preview.read.dragFt, r.state.tokens.bree!.path!.stops.slice(1).reduce((sum, st) => sum + (st.cost ?? 0), 0));
    }
  });

  test("off a 10 ft horse she climbs no 20 ft ground: the ledge at the horse's side stops her", () => {
    const state = trench();
    // The ground beyond the horse's east half rises to 20 ft.
    state.buildChunks = world({ heights: { ...raised(0, 0, 3, 30, 10), ...raised(5, 0, 6, 30, 10), ...raised(6, 0, 30, 30, 20) } }).buildChunks;
    const drag = dragOf(copyFor(state, P1), "player", "bree", { x: 10, y: 4 });
    const op = drag.op as (Op & { t: "token.move" }) | null;
    assert.ok(!op || op.x < 6, JSON.stringify(op));
    assert.equal(drag.plan.stop?.blocker, "ledge");
    const over = canApply({ t: "token.move", tokenId: "bree", x: 7, y: 4, elevation: 20 }, P1, state, { canUseAsset: () => true });
    assert.deepEqual(over.ok ? null : over.message, LEDGE_IN_THE_WAY);
  });

  test("Get off finds a spot the server takes: up the step under the horse, as the trench's floor is past her reach", () => {
    const state = trench();
    const copy = copyFor(state, P1);
    const up = getOffPlace(copy, { role: "player", memberId: "p1" }, copy.tokens.bree!);
    assert.deepEqual(up, { x: 6, y: 5, elevation: 10 });
    assert.equal(canApply(detachOp("bree", up), P1, state, { canUseAsset: () => true }).ok, true);
    // On level ground, the spot found is one the server takes.
    const level = trench();
    level.buildChunks = world({}).buildChunks;
    level.tokens = { ...level.tokens, horse: { ...level.tokens.horse!, elevation: 0 }, bree: { ...level.tokens.bree!, elevation: 0 } };
    const place = getOffPlace(copyFor(level, P1), { role: "player", memberId: "p1" }, copyFor(level, P1).tokens.bree!);
    assert.ok(place);
    assert.equal(canApply(detachOp("bree", place), P1, level, { canUseAsset: () => true }).ok, true, JSON.stringify(place));
  });
});

describe("a walk off a holder crosses only the ledges whose whole length lies inside the holder, and only until it first clears it (reviews AT-O-26, AT-ASTRA-16 and AT-ASTRA-17)", () => {
  const deps = { canUseAsset: () => true };
  const refusal = (op: Op, state: RoomState) => {
    const answer = canApply(op, P1, state, deps);
    return answer.ok ? null : answer.message;
  };
  /** The room on `mover`'s turn. */
  function onItsTurn(state: RoomState, mover: string): RoomState {
    for (const [i, op] of ([{ t: "encounter.start", entries: [{ id: "e1", tokenId: mover, value: 20 }, { id: "e2", tokenId: "gob", value: 5 }] }, { t: "encounter.next" }] as Op[]).entries()) {
      const r = applyOp(state, op, DM, env(i + 1));
      assert.ok(r.ok);
      state = r.state;
    }
    return state;
  }
  const bree = (over: Partial<Token>) => token("bree", { name: "Bree", kind: "pc", ownerIds: ["p1"], x: 4, y: 4, elevation: 10, actor: { inline: actor({ speeds: { walk: 30 } }) }, ...over });
  const gob = token("gob", { name: "Goblin", x: 25, y: 25 });

  test("a horse wholly on a plateau at its edge: she steps off no cliff at its side, as a token there on its own does not", () => {
    for (const riding of [true, false]) {
      const horse = token("horse", { name: "Warhorse", kind: "npc", size: "large", x: riding ? 4 : 10, y: 4, elevation: 10, actor: { inline: actor({ speeds: { walk: 60 } }) } });
      const state = onItsTurn(world({ heights: raised(4, 0, 30, 30, 10), tokens: [horse, bree(riding ? { attached: { to: "horse", kind: "ride" } } : {}), gob] }), "bree");
      assert.equal(refusal({ t: "token.move", tokenId: "bree", x: 2, y: 4 }, state), LEDGE_IN_THE_WAY, riding ? "riding" : "loose");
      const drag = dragOf(copyFor(state, P1), "player", "bree", { x: 2, y: 4 });
      assert.deepEqual([drag.op, drag.plan.stop?.blocker, drag.preview.to], [null, "ledge", { x: 4, y: 4 }], riding ? "riding" : "loose");
    }
    // East, on the plateau, she walks off as ever.
    const horse = token("horse", { name: "Warhorse", kind: "npc", size: "large", x: 4, y: 4, elevation: 10, actor: { inline: actor({ speeds: { walk: 60 } }) } });
    const state = onItsTurn(world({ heights: raised(4, 0, 30, 30, 10), tokens: [horse, bree({ attached: { to: "horse", kind: "ride" } }), gob] }), "bree");
    const east = dragOf(copyFor(state, P1), "player", "bree", { x: 8, y: 4 });
    assert.deepEqual(east.op, { t: "token.move", tokenId: "bree", x: 8, y: 4 });
    assert.equal(refusal(east.op as Op, state), null);
  });

  /**
   * A 4 by 4 cart at (4,4) at 10 ft, straddling a 10 ft step at x = 6 along its middle, P1's Bree on its west half, and walls
   * that keep her from walking east or south on it: along x = 6 north of y = 5, and along y = 5 from x = 3 on.
   */
  function cart(): RoomState {
    const edges: Record<string, EdgeFeature> = {};
    for (let y = 0; y < 5; y++) edges[`6,${y},w`] = { kind: "wall" };
    for (let x = 3; x < 30; x++) edges[`${x},5,n`] = { kind: "wall" };
    const wagon = token("cart", { name: "Cart", kind: "object", size: "gargantuan", x: 4, y: 4, elevation: 10 });
    return onItsTurn(world({ heights: raised(6, 0, 30, 30, 10), edges, tokens: [wagon, bree({ attached: { to: "cart", kind: "carry" } }), gob] }), "bree");
  }

  test("a walk that clears the cart and comes back over it crosses the step under it on the ground's rule: the search finds no such way and the server refuses one", () => {
    const state = cart();
    const drag = dragOf(copyFor(state, P1), "player", "bree", { x: 9, y: 6 });
    assert.equal(drag.answer.kind, "none");
    assert.equal(drag.op && "route" in drag.op ? drag.op.route : undefined, undefined);
    const back: [number, number, number, 0 | 1][] = [[2, 4, 0, 0], [2, 5, 0, 0], [3, 6, 0, 0], [5, 6, 0, 0]];
    assert.equal(refusal({ t: "token.move", tokenId: "bree", x: 9, y: 6, elevation: 10, route: [...back, [6, 6, 0, 0], [9, 6, 0, 0]] }, state), LEDGE_IN_THE_WAY);
    // Back on the cart short of the step is a walk like any other.
    const short = dragOf(copyFor(state, P1), "player", "bree", { x: 5, y: 6 });
    assert.deepEqual(short.op, { t: "token.move", tokenId: "bree", x: 5, y: 6, route: back });
    assert.equal(refusal(short.op as Op, state), null);
    // A redo's routes carry it too: a first route that ends back on the cart, a second over the step.
    const value = { ...state.tokens.bree!, x: 9, y: 6, elevation: 10 };
    const redo: Op = { t: "sys.restore", entries: [{ key: "token:bree", value }], from: "redo", deps: true, routes: { bree: [back, [[9, 6, 0, 0]]] } };
    assert.equal(refusal(redo, state), LEDGE_IN_THE_WAY_BACK);
  });

  test("a spot on the holder that a walk reaches after clearing it is judged on the ground's rule", () => {
    // A Large ogre on the cart's west half, its core over the step under the cart, which rises only there.
    const wagon = token("cart", { name: "Cart", kind: "object", size: "gargantuan", x: 4, y: 4, elevation: 10 });
    const ogre = token("ogre", { name: "Ogre", kind: "npc", size: "large", x: 5, y: 4, elevation: 10, attached: { to: "cart", kind: "carry" } });
    const state = world({ heights: raised(6, 4, 8, 8, 10), tokens: [wagon, ogre] });
    const walker = walkerFor(state, state.tokens.ogre!, () => true);
    assert.equal(coreBlocked(state, walkEnd(state, walker, { x: 5, y: 4 })), false);
    // Off the cart to the west and back onto it.
    const back = [
      { x: 2, y: 4, elevation: 0 },
      { x: 4, y: 4, elevation: 0 },
    ];
    assert.equal(coreBlocked(state, walkEnd(state, walker, { x: 5, y: 4 }, back)), true);
  });

  test("a group drag that is no axis's tests the straight leg, so it never bends round a wall or a ledge beside the horse", () => {
    for (const ledge of [false, true]) {
      // Flat ground, and beside the horse a wall from (4,6) to (4,7), or a 10 ft square at (4,6), outside its footprint.
      const horse = token("horse", { name: "Warhorse", kind: "npc", size: "large", ownerIds: ["p1"], x: 4, y: 4, elevation: 0, actor: { inline: actor({ speeds: { walk: 60 } }) } });
      const mate = token("mate", { name: "Mate", kind: "pc", ownerIds: ["p1"], disposition: "ally", x: 12, y: 2 });
      const room = ledge ? { heights: raised(4, 6, 5, 7, 10) } : { edges: { "4,6,w": { kind: "wall" } as EdgeFeature } };
      const state = onItsTurn(world({ ...room, tokens: [horse, bree({ elevation: 0, attached: { to: "horse", kind: "ride" } }), mate, gob] }), "bree");
      const words = ledge ? LEDGE_IN_THE_WAY : WALL_IN_THE_WAY;
      const both: Op = { t: "token.moveMany", moves: [{ tokenId: "bree", x: 1, y: 14 }, { tokenId: "mate", x: 9, y: 12 }] };
      assert.equal(refusal(both, state), words);
      const loose = { ...state, tokens: { ...state.tokens, bree: { ...state.tokens.bree!, attached: undefined } } };
      assert.equal(refusal(both, loose), words, "as for a token on its own");
      const drag = groupDragOf(copyFor(state, P1), "player", ["bree", "mate"], { x: 1, y: 14 });
      assert.deepEqual(drag.plan.held.map((h) => [h.token.id, h.blocker]), [["bree", ledge ? "ledge" : "wall"]]);
      assert.deepEqual(drag.op, { t: "token.move", tokenId: "mate", x: 9, y: 12 });
    }
  });

  test("under a holder off the whole squares, a grid edge only partly inside it is a ledge: she crosses the step only where its whole edge lies under the cart", () => {
    // A 2.5 by 2 cart at (4,4) at 10 ft over a 10 ft step along y = 5: its edge from x = 6 to 7 lies half under the cart.
    for (const [x, words] of [
      [5, null],
      [6, LEDGE_IN_THE_WAY],
    ] as const) {
      const wagon = token("cart", { name: "Cart", kind: "object", size: "custom", w: 2.5, h: 2, x: 4, y: 4, elevation: 10 });
      const state = onItsTurn(world({ heights: raised(0, 5, 30, 30, 10), tokens: [wagon, bree({ x, attached: { to: "cart", kind: "carry" } }), gob] }), "bree");
      assert.equal(refusal({ t: "token.move", tokenId: "bree", x, y: 7, elevation: 10 }, state), words, `from x ${x}`);
    }
  });
});

describe("a squeeze at the end of a walk off a holder is judged as the walk reads it, on the device and the server (review AT-ASTRA-19)", () => {
  /**
   * A 4 by 4 cart at (9,6) at 10 ft carrying P1's Large ogre, on its turn. The ground is 10 ft over x 11 to 13 by y 6
   * to 10 and over x 11 to 15 by y 10 to 20, with a wall along x = 10 from y = 10 down. Below the cart, the 5 ft gap
   * between the wall and the raised ground is too narrow for the ogre, which squeezes through it on the ground.
   */
  function gap(): RoomState {
    const edges: Record<string, EdgeFeature> = {};
    for (let y = 10; y < 20; y++) edges[`10,${y},w`] = { kind: "wall" };
    const wagon = token("cart", { name: "Cart", kind: "object", size: "gargantuan", x: 9, y: 6, elevation: 10 });
    const ogre = token("ogre", { name: "Ogre", kind: "pc", size: "large", ownerIds: ["p1"], x: 9, y: 6, elevation: 10, attached: { to: "cart", kind: "carry" }, actor: { inline: actor({ speeds: { walk: 40 } }) } });
    let state = world({ heights: { ...raised(11, 6, 13, 10, 10), ...raised(11, 10, 15, 20, 10) }, edges, tokens: [wagon, ogre, token("gob", { name: "Goblin", x: 25, y: 25 })] });
    for (const [i, op] of ([{ t: "encounter.start", entries: [{ id: "e1", tokenId: "ogre", value: 20 }, { id: "e2", tokenId: "gob", value: 5 }] }, { t: "encounter.next" }] as Op[]).entries()) {
      const r = applyOp(state, op, DM, env(i + 1));
      assert.ok(r.ok);
      state = r.state;
    }
    return state;
  }

  test("a drag into the gap sends the squeezed drop its route walks to, which the server takes and stores as the label read", () => {
    const state = gap();
    const drag = dragOf(copyFor(state, P1), "player", "ogre", { x: 9.2, y: 13.3 });
    assert.deepEqual(drag.op, { t: "token.move", tokenId: "ogre", x: 9.5, y: 13.5, elevation: 0, squeeze: true, route: [[9.5, 6.5, 0, 0], [9.5, 8, 0, 0], [9.5, 13.5, 1, 0]] });
    assert.equal(canApply(drag.op as Op, P1, state, { canUseAsset: () => true }).ok, true);
    const r = applyOp(state, drag.op as Op, P1, env(9));
    assert.ok(r.ok);
    assert.equal(r.state.tokens.ogre!.squeeze, true);
    assert.equal(drag.preview.read.dragFt, r.state.tokens.ogre!.path!.stops.slice(1).reduce((sum, st) => sum + (st.cost ?? 0), 0));
  });

  test("the squeezed drop lands on the gap's floor under its squeezed footprint, so the ledge beside it stops the next drag (review AT-ASTRA-20)", () => {
    const state = gap();
    const r = applyOp(state, dragOf(copyFor(state, P1), "player", "ogre", { x: 9.2, y: 13.3 }).op as Op, P1, env(9));
    assert.ok(r.ok);
    assert.deepEqual([r.state.tokens.ogre!.elevation, r.state.tokens.ogre!.attached], [0, undefined]);
    const next = dragOf(copyFor(r.state, P1), "player", "ogre", { x: 11.2, y: 13.3 });
    assert.equal(next.plan.stop?.blocker, "ledge");
    const over = canApply({ t: "token.move", tokenId: "ogre", x: 11.5, y: 13.5 }, P1, r.state, { canUseAsset: () => true });
    assert.deepEqual(over.ok ? null : over.message, LEDGE_IN_THE_WAY);
    // The server's test that a player's set down of a creature lands as a walk lands reads the same squeezed footprint.
    const ogre = state.tokens.ogre!;
    assert.deepEqual([landsAt(state.buildChunks, ogre, { x: 9.5, y: 13.5, elevation: 0, squeeze: true }), landsAt(state.buildChunks, ogre, { x: 9.5, y: 13.5, elevation: 0 })], [true, false]);
  });

  test("a walk that starts squeezed is full size from its first corner, so the route down the gap through water is the one it sends (review AT-ASTRA-22)", () => {
    const state = gap();
    const r = applyOp(state, dragOf(copyFor(state, P1), "player", "ogre", { x: 9.2, y: 13.3 }).op as Op, P1, env(9));
    assert.ok(r.ok);
    // Water in the gap below the ogre, which it walks round or through, squeezed at the start only.
    const chunks = { ...r.state.buildChunks };
    const [key, chunk] = Object.entries(chunks).find(([, c]) => c.cx === 0 && c.cy === 0)!;
    chunks[key] = { ...chunk, rev: chunk.rev + 1, cells: { ...chunk.cells, "10,15": "water" } };
    const wet = { ...r.state, buildChunks: chunks };
    const drag = dragOf(copyFor(wet, P1), "player", "ogre", { x: 9.2, y: 16.3 });
    const op = drag.op as Op & { t: "token.move" };
    assert.deepEqual([op.x, op.y, op.squeeze, op.route !== undefined], [9.5, 16.5, true, true], JSON.stringify(op));
    const answer = canApply(op, P1, wet, { canUseAsset: () => true });
    assert.ok(answer.ok, answer.ok ? "" : answer.message);
    const after = applyOp(wet, op, P1, env(10));
    assert.ok(after.ok);
    // Squeezed down the gap it pays the squeeze on every foot, the water's too on its first 5 ft, and from its first corner on
    // it stands at the height of the ground under its full footprint (review AT-ASTRA-24): 30 ft, then 20 ft.
    const stops = after.state.tokens.ogre!.path!.stops;
    assert.deepEqual([op.route, drag.preview.read.dragFt, stops[stops.length - 1]!.cost], [[[9.5, 14.5, 2, 1], [9.5, 16.5, 1, 0]], 50, 50]);
  });

  test("a walk that squeezes only where it ends is reminded of an area it passes with its full footprint (review AT-SOL-2)", () => {
    // A 5 ft sphere at 10 ft by the cart's south east corner, which the ogre's full footprint covers on its way down the gap.
    const state = gap();
    state.templates.orb = template("orb", { shape: "sphere", size: 5, origin: { x: 11.5, y: 8.5, z: 10 }, triggers: ["enter"] });
    const route: [number, number, number, 0 | 1][] = [[9.5, 6.5, 0, 0], [9.5, 8, 0, 0], [9.5, 13.5, 1, 0]];
    const entered = (squeeze: boolean) => {
      const r = applyOp(state, { t: "token.move", tokenId: "ogre", x: 9.5, y: 13.5, elevation: 0, ...(squeeze ? { squeeze: true } : {}), route }, DM, env(9));
      assert.ok(r.ok, r.ok ? "" : r.message);
      return r.log.flatMap((e) => (e.data?.type === "area" ? [[e.data.tokenId, e.data.trigger]] : []));
    };
    assert.deepEqual(entered(false), [["ogre", "enter"]]);
    assert.deepEqual(entered(true), [["ogre", "enter"]], "squeezed only in the gap, it passes the sphere full size");
  });

  test("a walking ruler off the cart to the ground and back walks its later legs as the token would once off it (review AT-SOL-1)", () => {
    // An imp on the cart's west half, which stands over the low ground at 10 ft, steps west onto the ground and back.
    const state = gap();
    state.tokens.imp = token("imp", { name: "Imp", kind: "pc", ownerIds: ["p1"], x: 9, y: 6, elevation: 10, attached: { to: "cart", kind: "carry" } });
    const view = copyFor(state, P1);
    const ruler = measureWalk({ view, sceneId: "s1", stops: [tokenStop(SQUARES, view.tokens.imp!), { x: 8.5, y: 6.5 }, { x: 9.5, y: 6.5 }], viewer: { role: "player" }, everything: false })!;
    // The same two drags, made one after the other: the first leaves the cart, so the second walks on the ground.
    const off = dragOf(view, "player", "imp", { x: 8, y: 6 });
    const r = applyOp(state, off.op as Op, P1, env(9));
    assert.ok(r.ok);
    const back = dragOf(copyFor(r.state, P1), "player", "imp", { x: 9, y: 6 });
    const r2 = applyOp(r.state, back.op as Op, P1, env(10));
    assert.ok(r2.ok);
    assert.deepEqual([r2.state.tokens.imp!.elevation, r2.state.tokens.imp!.attached], [0, undefined]);
    assert.deepEqual(ruler.legs.map((leg) => leg.ft), [off.preview.read.dragFt, back.preview.read.dragFt]);
    // The walk off the cart starts on the ground under the imp, so its seat's 10 ft above it is no distance (review LP12-AT-4).
    assert.deepEqual(ruler.legs.map((leg) => leg.ft), [5, 5]);
  });

  /**
   * The gap's cart with fog lifted only over its north east corner, where an imp rides it, and the ogre out of the way: a
   * ruler leaves out other creatures' spaces, which a drag does not.
   */
  function fogged(): RoomState {
    const state = gap();
    state.scenes.s1 = { ...state.scenes.s1!, fogEnabled: true };
    reveal(state, "s1", { x: 11, y: 6, w: 2, h: 2 });
    state.tokens.imp = token("imp", { name: "Imp", x: 11, y: 6, elevation: 10, attached: { to: "cart", kind: "carry" } });
    const { attached: _link, ...ogre } = state.tokens.ogre!;
    state.tokens.ogre = { ...ogre, x: 20, y: 20, elevation: 0 };
    return state;
  }

  /** The DM's drags of the imp to each spot in turn, each from where the one before left it: what each label read. */
  function dragsOf(state: RoomState, spots: readonly { x: number; y: number }[]): number[] {
    let room = state;
    return spots.map((spot, i) => {
      const drag = dragOf(room, "dm", "imp", spot);
      const r = applyOp(room, drag.op as Op, DM, env(9 + i));
      assert.ok(r.ok, r.ok ? "" : r.message);
      room = r.state;
      return drag.preview.read.dragFt;
    });
  }

  test("a walking ruler's legs read as the drags they stand for when one leaves its passenger hidden off its holder (review AT-ASTRA-25)", () => {
    // On the cart into the fog, off it west, back onto its revealed corner, which no seat there holds, and one more step.
    const state = fogged();
    const spots = [{ x: 9, y: 8 }, { x: 8, y: 8 }, { x: 11, y: 6 }, { x: 10, y: 6 }];
    const ruler = measureWalk({ view: state, sceneId: "s1", stops: [tokenStop(SQUARES, state.tokens.imp!), ...spots.map((p) => ({ x: p.x + 0.5, y: p.y + 0.5 }))], viewer: { role: "dm" }, everything: true })!;
    assert.deepEqual(ruler.legs.map((leg) => leg.ft), dragsOf(state, spots));
  });

  test("a shared walking ruler reads the same on a player's copy as on the DM's, a token it moves into the fog seen by neither (review AT-SOL-5)", () => {
    const state = fogged();
    const stops = [tokenStop(SQUARES, state.tokens.imp!), { x: 9.5, y: 8.5 }, { x: 8.5, y: 8.5 }];
    const dm = measureWalk({ view: state, sceneId: "s1", stops, viewer: { role: "dm" }, everything: false })!;
    const player = measureWalk({ view: copyFor(state, P1), sceneId: "s1", stops, viewer: { role: "player" }, everything: false })!;
    assert.deepEqual(player.legs.map((leg) => leg.ft), dm.legs.map((leg) => leg.ft));
    assert.equal(dm.legs[1]!.ft, 5);
  });

  test("a walking ruler's later legs judge who sees the token where its earlier legs left it (review AT-SOL-3)", () => {
    // Its first leg keeps the imp on the cart, in the fog, where no player sees it, so its next leg west off the cart walks as a
    // token with no holder: 10 ft up, over low ground. The DM's own ruler reads the fogged ground, as the DM's drag does.
    const state = fogged();
    const ruler = measureWalk({ view: state, sceneId: "s1", stops: [tokenStop(SQUARES, state.tokens.imp!), { x: 9.5, y: 8.5 }, { x: 8.5, y: 8.5 }], viewer: { role: "dm" }, everything: true })!;
    const along = dragOf(state, "dm", "imp", { x: 9, y: 8 });
    const r = applyOp(state, along.op as Op, DM, env(9));
    assert.ok(r.ok);
    assert.deepEqual([r.state.tokens.imp!.attached?.to, r.state.tokens.imp!.elevation], ["cart", 10]);
    const off = dragOf(r.state, "dm", "imp", { x: 8, y: 8 });
    const r2 = applyOp(r.state, off.op as Op, DM, env(10));
    assert.ok(r2.ok);
    assert.equal(r2.state.tokens.imp!.elevation, 10);
    assert.deepEqual(ruler.legs.map((leg) => leg.ft), [along.preview.read.dragFt, off.preview.read.dragFt]);
    assert.equal(ruler.legs[1]!.ft, 5);
  });

  test("after the squeezed drop into the gap, a drag east finds a way the server takes: the search reads it full size at the ground's height past its start (review AT-ASTRA-24)", () => {
    const state = gap();
    const r = applyOp(state, dragOf(copyFor(state, P1), "player", "ogre", { x: 9.2, y: 13.3 }).op as Op, P1, env(9));
    assert.ok(r.ok);
    const drag = dragOf(copyFor(r.state, P1), "player", "ogre", { x: 16, y: 13.5 });
    const op = drag.op as Op & { t: "token.move" };
    assert.ok(op && (op.x !== 9.5 || op.y !== 13.5), `held where it stands: ${JSON.stringify(drag.op)}`);
    const answer = canApply(op, P1, r.state, { canUseAsset: () => true });
    assert.ok(answer.ok, answer.ok ? "" : answer.message);
  });

  test("a walk past 64 pieces cut where it squeezes in the gap sends a squeezed drop the server takes", () => {
    const state = gap();
    // Down into the gap, then back and forth in it, past 64 pieces.
    const pieces: [number, number, number, 0 | 1][] = [
      [9.5, 6.5, 0, 0],
      [9.5, 8, 0, 0],
      ...Array.from({ length: 68 }, (_, i): [number, number, number, 0 | 1] => [9.5, i % 2 === 0 ? 10.5 : 11.5, 1, 0]),
    ];
    const plan = planWalk(dropView(copyFor(state, P1), "player"), copyFor(state, P1).tokens.ogre!, { x: 9.2, y: 11.3 }, "walk", { kind: "route", route: { pieces } }, 5);
    const move = plan.moves[0]!;
    assert.deepEqual([plan.cut, move.route!.length, move.x, move.y, move.squeeze], [true, 64, 9.5, 11.5, true]);
    const op = moveOpsOf(plan.moves)[0]!;
    const answer = canApply(op, P1, state, { canUseAsset: () => true });
    assert.ok(answer.ok, answer.ok ? "" : answer.message);
    const r = applyOp(state, op, P1, env(9));
    assert.ok(r.ok);
    assert.equal(r.state.tokens.ogre!.squeeze, true);
  });
});

describe("every reader of a walk reads its walker from the walk's trace (reviews AT-SOL-4, AT-ASTRA-23 and AT-O-29)", () => {
  /** A 5 ft corridor between walls along x = 10 and x = 11, on the PC's turn of a fight. */
  function corridor(tokens: Token[], edges: Record<string, EdgeFeature> = {}, heights: Record<string, number> = {}): RoomState {
    let state = world({ edges: { ...line("w", 10, 0, 30), ...line("w", 11, 0, 30), ...edges }, heights, tokens: [token("pc", { name: "Pc", kind: "pc", x: 20, y: 20 }), ...tokens] });
    for (const [i, op] of ([{ t: "encounter.start", entries: [{ id: "e1", tokenId: "pc", value: 20 }] }, { t: "encounter.next" }] as Op[]).entries()) {
      const r = applyOp(state, op, DM, env(i + 1));
      assert.ok(r.ok);
      state = r.state;
    }
    return state;
  }

  const entered = (r: ReturnType<typeof applyOp>) => (r.ok ? r.log.flatMap((e) => (e.data?.type === "area" ? [[e.data.tokenId, e.data.trigger]] : [])) : null);

  test("a creature that starts squeezed is full size from its walk's first corner, so an area it touches only there reminds it (AT-SOL-4)", () => {
    // Squeezed in the corridor on its first piece, a Large brute stands full size at the corner, its east column past the
    // corridor's east wall, where a 5 ft sphere just reaches it. Before the corner and after it, it is clear of the sphere.
    const state = corridor([token("brute", { name: "Brute", size: "large", x: 9.5, y: 12.5, squeeze: true })]);
    state.templates.orb = template("orb", { shape: "sphere", size: 5, origin: { x: 11.8, y: 10.9, z: 0 }, triggers: ["enter"] });
    const op: Op = { t: "token.move", tokenId: "brute", x: 9.5, y: 4.5, squeeze: true, route: [[9.5, 8.5, 0, 0], [9.5, 4.5, 0, 0]] };
    assert.equal(canApply(op, DM, state, { canUseAsset: () => true }).ok, true);
    assert.deepEqual(entered(applyOp(state, op, DM, env(9))), [["brute", "enter"]]);
  });

  test("a creature a holder drags walks full size from where it starts, squeezed or not, so it passes an area with its full footprint (AT-ASTRA-23, AT-O-29)", () => {
    // A Large brute in the corridor, dragged north by a PC, passes a 5 ft sphere east of the corridor's east wall with its full
    // footprint midway, never where it starts or ends.
    for (const squeezed of [false, true]) {
      const state = corridor([token("pc2", { name: "Pc2", kind: "pc", x: 10, y: 8 }), token("brute", { name: "Brute", size: "large", x: 9.5, y: 10.5, ...(squeezed ? { squeeze: true as const } : {}), attached: { to: "pc2", kind: "drag" } })]);
      state.templates.orb = template("orb", { shape: "sphere", size: 5, origin: { x: 12.2, y: 9.5, z: 0 }, triggers: ["enter"] });
      for (const routed of [false, true]) {
        const op: Op = { t: "token.move", tokenId: "pc2", x: 10, y: 4, ...(routed ? { route: [[10, 6, 0, 0], [10, 4, 0, 0]] } : {}) };
        const r = applyOp(state, op, DM, env(9));
        assert.deepEqual(entered(r), [["brute", "enter"]], `squeezed ${squeezed}, routed ${routed}`);
        assert.equal(r.ok && r.state.tokens.brute!.squeeze, undefined, `squeezed ${squeezed}, routed ${routed}`);
      }
    }
  });

  test("a squeezed holder's walk is cut where a creature it drags is stopped, its own leg there judged squeezed as its first piece is", () => {
    // A Large brute squeezed in the corridor drags a goblin in the open west of it, whose lane a wall crosses at y = 8. Its full
    // footprint where it starts reaches a 10 ft block east of the corridor, so full size it would stand inside the ground,
    // where no ledge stops it. Squeezed it stands on the ground, so the step up 1 ft across the corridor at y = 7 stops it,
    // and its walk is cut short of that ledge, before the goblin's wall.
    const state = corridor([token("brute", { name: "Brute", size: "large", x: 9.5, y: 4.5, squeeze: true }), token("gob", { name: "Goblin", x: 8, y: 4.5 })], line("n", 8, 8, 9), { ...raised(11, 4, 12, 7, 10), ...raised(10, 7, 11, 30, 1) });
    const view = dropView(state, "dm");
    const lead = ownWalk(view.tokens.brute!);
    const cut = walkersStop(view, lead, [{ x: 9.5, y: 4.5, elevation: 0 }, { x: 9.5, y: 10.5, elevation: 0 }], [view.tokens.gob!]);
    assert.ok(cut);
    assert.deepEqual([cut.at.x, cut.at.y, cut.pieces, cut.blocker], [9.5, 5.5, 0, "wall"]);
    assert.equal(legBlocker(view, lead, cut.at), null);
  });
});

describe("a walking ruler's later legs search the room its earlier legs leave (reviews AT-ASTRA-26 and AT-SOL-6)", () => {
  /** The DM's drags of `id` to each spot in turn, each from where the one before left it: what each label read. */
  function dragsFrom(state: RoomState, id: string, spots: readonly { x: number; y: number }[]): number[] {
    let room = state;
    return spots.map((spot, i) => {
      const drag = dragOf(room, "dm", id, spot);
      const r = applyOp(room, drag.op as Op, DM, env(9 + i));
      assert.ok(r.ok, r.ok ? "" : r.message);
      room = r.state;
      return drag.preview.read.dragFt;
    });
  }

  test("an area on a creature the walker drags goes with it, so a later leg pays for it where the leg before left it", () => {
    // A goblin the PC drags holds a 15 ft emanation of overgrowth, 4 ft a foot. Each leg starts inside it, where the leg before
    // left the goblin, a step behind the PC.
    const state = world({ tokens: [token("pc", { name: "Pc", kind: "pc", x: 3, y: 3 }), token("gob", { name: "Gob", size: "small", disposition: "ally", x: 2, y: 3, attached: { to: "pc", kind: "drag" } })] });
    state.templates.pg = template("pg", { shape: "emanation", size: 15, attachedTo: "gob", includeOrigin: true, slows: { kind: "quarter" } });
    const spots = [{ x: 8, y: 3 }, { x: 13, y: 3 }];
    const ruler = measureWalk({ view: state, sceneId: "s1", stops: [tokenStop(SQUARES, state.tokens.pc!), ...spots.map((p) => ({ x: p.x + 0.5, y: p.y + 0.5 }))], viewer: { role: "dm" }, everything: false })!;
    const drags = dragsFrom(state, "pc", spots);
    assert.equal(drags[0], drags[1]);
    assert.ok(drags[0]! > 25, `the area costs: ${drags}`);
    assert.deepEqual(ruler.legs.map((leg) => leg.ft), drags);
  });

  test("an area on what a creature the holder drags carries goes with the holder, so its later leg pays for the area where it now stands", () => {
    // A horse drags a goblin that carries a lamp with a 10 ft emanation of difficult terrain. It walks east, then north, its
    // first steps north in the area it towed east, far from where the area started.
    const state = world({
      tokens: [
        token("horse", { name: "Horse", size: "large", x: 4, y: 10 }),
        token("gob", { name: "Gob", size: "small", x: 3, y: 10, attached: { to: "horse", kind: "drag" } }),
        token("lamp", { name: "Lamp", kind: "object", size: "tiny", x: 3, y: 10, attached: { to: "gob", kind: "carry" } }),
      ],
    });
    state.templates.dt = template("dt", { shape: "emanation", size: 10, attachedTo: "lamp", includeOrigin: true, slows: { kind: "difficult" } });
    const spots = [{ x: 12, y: 10 }, { x: 12, y: 4 }];
    const ruler = measureWalk({ view: state, sceneId: "s1", stops: [tokenStop(SQUARES, state.tokens.horse!), ...spots.map((p) => ({ x: p.x + 1, y: p.y + 1 }))], viewer: { role: "dm" }, everything: true })!;
    const drags = dragsFrom(state, "horse", spots);
    assert.deepEqual(drags, [40, 35], "the first step north is in the area, 5 ft more than its distance");
    assert.deepEqual(ruler.legs.map((leg) => leg.ft), drags);
  });
});

describe("a walking ruler sees a party member its legs move where every player sees it, on any copy (review AT-SOL-7)", () => {
  test("another player's PC the walker drags into the fog stays seen, so the ruler's later leg tows it and is cut where it meets a wall, as the drag is", () => {
    // Hero, p1's, drags Ally, p2's PC, east out of the revealed ground, then north. Players always see a party member, under the
    // fog too, so each drag pays 1 extra foot a foot, and a wall across Ally's lane north stops it, and Hero with it. A player's
    // copy holds no owners of another player's token, so read by the owners there, Ally walked into the fog hidden: the ruler's
    // second leg towed nothing, 20 ft where the drag reads 40, and went on past the wall where the drag is cut.
    for (const wall of [false, true]) {
      const state = world({
        edges: wall ? line("n", 3, 9, 10) : {},
        tokens: [
          token("hero", { name: "Hero", kind: "pc", ownerIds: ["p1"], x: 5, y: 5 }),
          token("ally", { name: "Ally", kind: "pc", ownerIds: ["p2"], x: 4, y: 5, attached: { to: "hero", kind: "drag" } }),
        ],
      });
      state.scenes.s1 = { ...state.scenes.s1!, fogEnabled: true };
      reveal(state, "s1", { x: 0, y: 0, w: 8, h: 12 });
      // Players hold a wall only where they hold a cell beside it (docs/design-v1-map-discovery.md 5.2): the patch of ground about it is lifted too.
      reveal(state, "s1", { x: 9, y: 2, w: 1, h: 2 });
      const spots = [{ x: 10, y: 5 }, { x: 10, y: 1 }];
      let room = state;
      const read: number[] = [];
      for (const [i, spot] of spots.entries()) {
        const drag = dragOf(copyFor(room, P1), "player", "hero", spot);
        const r = applyOp(room, drag.op as Op, P1, env(9 + i));
        assert.ok(r.ok, r.ok ? "" : r.message);
        room = r.state;
        read.push(drag.preview.read.dragFt);
      }
      assert.deepEqual([read, room.tokens.hero!.y], wall ? [[50, 20], 3] : [[50, 40], 1], `wall ${wall}`);
      const stops = [tokenStop(SQUARES, state.tokens.hero!), ...spots.map((p) => ({ x: p.x + 0.5, y: p.y + 0.5 }))];
      const theirs = measureWalk({ view: copyFor(state, P1), sceneId: "s1", stops, viewer: { role: "player" }, everything: false })!;
      assert.deepEqual(theirs.legs.map((leg) => leg.ft), read, `wall ${wall}, p1's ruler`);
      const shared = measureWalk({ view: state, sceneId: "s1", stops, viewer: { role: "dm" }, everything: false })!;
      assert.deepEqual(shared.legs.map((leg) => leg.ft), read, `wall ${wall}, the DM's shared ruler`);
    }
  });
});

describe("an area on a token carried rigidly with the mover never costs it (review AT-ASTRA-28)", () => {
  /** The drags of `id` by `who` on their copy to each spot in turn, each from where the one before left it: what each label read. */
  function dragsBy(state: RoomState, who: typeof DM, id: string, spots: readonly { x: number; y: number }[]): number[] {
    let room = state;
    return spots.map((spot, i) => {
      const drag = dragOf(who.role === "dm" ? room : copyFor(room, who), who.role, id, spot);
      const r = applyOp(room, drag.op as Op, who, env(9 + i));
      assert.ok(r.ok, r.ok ? "" : r.message);
      room = r.state;
      return drag.preview.read.dragFt;
    });
  }

  const lit = (kind: "quarter" | "halfSpeed", speeds?: { walk: number }) => {
    const state = world({ tokens: [token("pc", { name: "Pc", kind: "pc", ownerIds: ["p1"], x: 3, y: 3, ...(speeds ? { actor: { inline: actor({ speeds }) } } : {}) }), token("lamp", { name: "Lamp", kind: "object", size: "tiny", x: 3, y: 3, attached: { to: "pc", kind: "carry" } })] });
    state.templates.glow = template("glow", { shape: "emanation", size: 15, attachedTo: "lamp", includeOrigin: true, ownerId: "dm1", slows: { kind } });
    return state;
  };

  test("a straight walk cut into 1, 2 or 10 stops past a lamp the walker carries costs its 50 ft, on the DM's drags and its owner's, and on their rulers", () => {
    // A PC carries a Tiny lamp holding a 15 ft emanation of overgrowth, 4 ft a foot, which goes where the PC goes. Read where
    // the lamp stood when each drag began, a walk cut into more stops paid more: 80, 110 and 200 ft.
    const state = lit("quarter");
    for (const cuts of [1, 2, 10]) {
      const spots = Array.from({ length: cuts }, (_, i) => ({ x: 3 + ((i + 1) * 10) / cuts, y: 3 }));
      for (const who of [DM, P1]) {
        const read = dragsBy(state, who, "pc", spots);
        assert.equal(read.reduce((a, b) => a + b, 0), 50, `${cuts} stops, ${who.memberId}'s drags read ${read}`);
        const view = who.role === "dm" ? state : copyFor(state, who);
        const ruler = measureWalk({ view, sceneId: "s1", stops: [tokenStop(SQUARES, view.tokens.pc!), ...spots.map((p) => ({ x: p.x + 0.5, y: p.y + 0.5 }))], viewer: { role: who.role }, everything: who.role === "dm" })!;
        assert.deepEqual(ruler.legs.map((leg) => leg.ft), read, `${cuts} stops, ${who.memberId}'s ruler`);
      }
    }
  });

  test("a Half Speed area on a lamp the walker carries never halves its Speed, on its drag or the turn's marker", () => {
    const state = onTurn(lit("halfSpeed", { walk: 30 }), "pc");
    for (const who of [DM, P1]) {
      const view = who.role === "dm" ? state : copyFor(state, who);
      const drag = dragOf(view, who.role, "pc", { x: 5, y: 3 });
      assert.deepEqual(drag.preview.read.left, { kind: "walk", speed: 30, leftFt: 20, band: "walk" }, `${who.memberId}'s drag`);
      assert.equal(halvedAt(speedAreas(view, view.tokens.pc!, { role: who.role }), view.tokens.pc!), null, `${who.memberId}'s marker`);
    }
  });

  test("an area on the mover's holder, on a creature it drags or on what that creature carries still costs it, and so does one past a link players do not see", () => {
    const glow = (on: string): RoomState["templates"] => ({ glow: template("glow", { shape: "emanation", size: 10, attachedTo: on, includeOrigin: true, ownerId: "dm1", slows: { kind: "difficult" } }) });
    const pc = token("pc", { name: "Pc", kind: "pc", ownerIds: ["p1"], x: 5, y: 5 });
    const lamp = (to: string, kind: "carry" | "drag" = "carry") => token("lamp", { name: "Lamp", kind: "object", size: "tiny", x: 5, y: 5, attached: { to, kind } });
    const imp = (over: Partial<Token> = {}) => token("imp", { name: "Imp", size: "tiny", x: 5, y: 5, attached: { to: "pc", kind: "perch" }, ...over });
    const cases: [string, Token[], string, number][] = [
      ["a lamp it carries", [pc, lamp("pc")], "lamp", 0],
      ["a lamp on an imp perched on it", [pc, imp(), lamp("imp")], "lamp", 0],
      ["its own area", [pc], "pc", 0],
      ["its mount", [token("horse", { name: "Horse", size: "large", x: 5, y: 5 }), { ...pc, attached: { to: "horse", kind: "ride" } }], "horse", 1],
      ["a goblin it drags", [pc, token("gob", { name: "Gob", size: "small", x: 4, y: 5, attached: { to: "pc", kind: "drag" } })], "gob", 1],
      ["a lamp on a goblin it drags", [pc, token("gob", { name: "Gob", size: "small", x: 4, y: 5, attached: { to: "pc", kind: "drag" } }), lamp("gob")], "lamp", 1],
      ["a lamp on a hidden imp perched on it", [pc, imp({ visibility: "dm" }), lamp("imp")], "lamp", 1],
    ];
    for (const [name, tokens, on, areas] of cases) {
      const state = world({ tokens });
      state.templates = glow(on);
      for (const who of [DM, P1]) {
        const view = who.role === "dm" ? state : copyFor(state, who);
        const mover = view.tokens.pc!;
        assert.equal(groupWalkWorld(view, walkerFor(view, mover, () => true), { role: who.role }).input.areas.length, areas, `${name}, ${who.memberId}'s world`);
      }
    }
  });
});

describe("a walking ruler counts the extra foot a drag pays for what the walker tows (review AT-O-31)", () => {
  test("a PC who drags or carries a Medium goblin pays 1 extra foot a foot on its ruler's legs while it tows, as on its drags, on the DM's room and a player's copy", () => {
    for (const kind of ["drag", "carry", "none"] as const) {
      for (const who of [DM, P1]) {
        const state = world({
          tokens: [
            token("hero", { name: "Hero", kind: "pc", ownerIds: ["p1"], x: 5, y: 5 }),
            token("gob", { name: "Gob", kind: "npc", x: kind === "drag" ? 4 : 5, y: 5, ...(kind !== "none" ? { attached: { to: "hero", kind } } : {}) }),
          ],
        });
        const copy = (room: RoomState) => (who.role === "dm" ? room : copyFor(room, who));
        let room = state;
        const stops: RulerStop[] = [tokenStop(SQUARES, copy(state).tokens.hero!)];
        const read: number[] = [];
        for (const [i, to] of [{ x: 8, y: 5 }, { x: 8, y: 8 }].entries()) {
          const drag = dragOf(copy(room), who.role, "hero", to);
          const r = applyOp(room, drag.op as Op, who, env(5 + i));
          assert.ok(r.ok, r.ok ? "" : r.message);
          room = r.state;
          const { x, y } = tokenStop(SQUARES, room.tokens.hero!);
          stops.push({ x, y });
          read.push(drag.preview.read.dragFt);
        }
        // A Medium goblin carried by a Medium PC comes loose by the link pass once the PC has moved, so only its first leg tows it.
        assert.deepEqual(read, { drag: [30, 30], carry: [30, 15], none: [15, 15] }[kind], `${kind}, ${who.memberId}'s drags`);
        const ruler = measureWalk({ view: copy(state), sceneId: "s1", stops, viewer: { role: who.role }, everything: who.role === "dm" })!;
        assert.deepEqual(ruler.legs.map((leg) => leg.ft), read, `${kind}, ${who.memberId}'s ruler`);
      }
    }
  });
});

describe("every sample of a walk reads the walk's trace (review AT-ASTRA-27)", () => {
  test("a squeezed walk down a corridor reads a Half Speed area on its floor at the floor's height, not the ground under its full footprint", () => {
    // A Large brute squeezed in a one-cell corridor, with 10 ft raised ground beside it under the full footprint it does not
    // use, walks to the corridor's far end past a 5 ft high Half Speed cylinder on the corridor floor. Squeezed all the way, it
    // stands on the floor, inside the cylinder short of the end: 45 ft there against its halved Speed is 15 ft past Dash. Read
    // on the ground under its full footprint, 10 ft up, it would pass over the cylinder and end in Dash with nothing left.
    let state = world({ edges: { ...line("w", 10, 0, 30), ...line("w", 11, 0, 30) }, heights: raised(11, 0, 12, 30, 10), tokens: [token("brute", { name: "Brute", size: "large", x: 9.5, y: 4.5, squeeze: true, actor: { inline: actor({ speeds: { walk: 30 } }) } })] });
    state = onTurn(state, "brute");
    state.templates.sg = template("sg", { shape: "cylinder", size: 5, height: 5, origin: { x: 10.5, y: 9.5, z: 0 }, slows: { kind: "halfSpeed" } });
    const drag = dragOf(state, "dm", "brute", { x: 9.7, y: 10.8 });
    const op = drag.op as Op & { t: "token.move" };
    assert.deepEqual([op.x, op.y, op.squeeze], [9.5, 10.5, true]);
    const r = applyOp(state, op, DM, env(9));
    assert.ok(r.ok);
    assert.equal(r.state.tokens.brute!.path!.stops.at(-1)!.cost, 60);
    assert.deepEqual(drag.preview.read.left, { kind: "walk", speed: 15, leftFt: 15, band: "over" });
  });
});

describe("a walking ruler from a rider of a controlled mount walks the mount, as a drag from the rider moves it (4.2)", () => {
  // Bree rides a Large horse at its top-right cell, both her player's, with a 5 ft emanation of difficult dust on the horse.
  // A drag of Bree moves the horse, whose own dust goes with it and costs nothing. Walked as Bree on her own, the ruler would
  // step her off the horse through its dust and leave her behind it for the next leg.
  const riding = (over: Partial<Token> = {}): RoomState => {
    const state = world({
      tokens: [
        token("horse", { name: "Horse", kind: "npc", size: "large", ownerIds: ["p1"], x: 2, y: 2, actor: { inline: actor({ speeds: { walk: 60 } }) } }),
        token("bree", { name: "Bree", kind: "pc", ownerIds: ["p1"], x: 3, y: 2, attached: { to: "horse", kind: "ride", steer: true }, ...over }),
      ],
    });
    state.templates.dust = template("dust", { shape: "emanation", size: 5, attachedTo: "horse", includeOrigin: false, ownerId: "dm1", slows: { kind: "difficult" } });
    return state;
  };

  test("each leg reads the horse's drag, drawn from Bree's seat, on the DM's room and her player's copy", () => {
    for (const who of [DM, P1]) {
      const state = riding();
      const copy = (room: RoomState) => (who.role === "dm" ? room : copyFor(room, who));
      let room = state;
      const read: number[] = [];
      const stops: RulerStop[] = [tokenStop(SQUARES, copy(state).tokens.bree!)];
      for (const [i, to] of [{ x: 7, y: 2 }, { x: 7, y: 6 }].entries()) {
        const drag = dragOf(copy(room), who.role, "horse", to);
        const r = applyOp(room, drag.op as Op, who, env(5 + i));
        assert.ok(r.ok, r.ok ? "" : r.message);
        room = r.state;
        assert.equal(room.tokens.bree!.attached?.to, "horse", "Bree rides on");
        const { x, y } = tokenStop(SQUARES, room.tokens.bree!);
        stops.push({ x, y });
        read.push(drag.preview.read.dragFt);
      }
      assert.deepEqual(read, [25, 20], `${who.memberId}'s drags of the horse`);
      const ruler = measureWalk({ view: copy(state), sceneId: "s1", stops, viewer: { role: who.role }, everything: who.role === "dm" })!;
      assert.deepEqual(ruler.legs.map((leg) => leg.ft), read, `${who.memberId}'s ruler`);
      assert.deepEqual(ruler.legs.map((leg) => [leg.from, leg.to]), [[{ x: 3, y: 2 }, { x: 8, y: 2 }], [{ x: 8, y: 2 }, { x: 8, y: 6 }]], `${who.memberId}'s legs drawn from Bree's seat`);
      assert.deepEqual(ruler.size, { w: 1, h: 1 });
    }
  });

  test("a horse's leg that bends round a wall draws its corners at Bree's seat on the horse, on the DM's room and her player's copy (review HF20-O-2)", () => {
    for (const who of [DM, P1]) {
      const state = riding();
      // A wall east of the horse, from the top of the scene down to row 4, so the horse goes round its south end.
      state.buildChunks = world({ edges: line("w", 6, 0, 5) }).buildChunks;
      const copy = who.role === "dm" ? state : copyFor(state, who);
      const drag = dragOf(copy, who.role, "horse", { x: 7, y: 2 });
      const op = drag.op as Op & { t: "token.move" };
      assert.ok(op.route && op.route.length > 1, `${who.memberId}'s drag bends round the wall: ${JSON.stringify(op)}`);
      const r = applyOp(state, op, who, env(5));
      assert.ok(r.ok, r.ok ? "" : r.message);
      const { x, y } = tokenStop(SQUARES, r.state.tokens.bree!);
      const ruler = measureWalk({ view: copy, sceneId: "s1", stops: [tokenStop(SQUARES, copy.tokens.bree!), { x, y }], viewer: { role: who.role }, everything: who.role === "dm" })!;
      // Bree sits one square east of the horse's corner, so each of the horse's corners is drawn one square east of it.
      const seat = { x: 1, y: 0 };
      assert.deepEqual(ruler.legs[0]!.corners, op.route.slice(0, -1).map(([cx, cy]) => ({ x: cx + seat.x, y: cy + seat.y })), `${who.memberId}'s corners`);
      assert.deepEqual([ruler.legs[0]!.from, ruler.legs[0]!.to, ruler.legs[0]!.ft], [{ x: 3, y: 2 }, { x: 8, y: 2 }, drag.preview.read.dragFt]);
    }
  });

  test("with the frame's budget spent, a leg still searching is drawn from Bree's place, and so is the one after it (review HF20-O-2)", () => {
    const state = riding();
    const stops: RulerStop[] = [tokenStop(SQUARES, state.tokens.bree!), { x: 8.5, y: 2.5 }, { x: 8.5, y: 6.5 }];
    const ruler = measureWalk({ view: state, sceneId: "s1", stops, viewer: { role: "dm" }, everything: true, budget: WorkBudget.none() })!;
    assert.equal(ruler.searching, true);
    assert.deepEqual(
      ruler.legs.map((leg) => [leg.from, leg.to, leg.searching]),
      [
        [{ x: 3, y: 2 }, { x: 8, y: 2 }, true],
        [{ x: 8, y: 2 }, { x: 8, y: 6 }, true],
      ],
    );
  });

  test("a shared ruler from a rider on a mount players do not see walks the rider on every copy, and only the DM's own ruler walks the mount", () => {
    const state = riding();
    state.tokens.horse = { ...state.tokens.horse!, visibility: "dm" };
    const stops: RulerStop[] = [tokenStop(SQUARES, state.tokens.bree!), { x: 8.5, y: 2.5 }];
    const shared = measureWalk({ view: state, sceneId: "s1", stops, viewer: { role: "dm" }, everything: false })!;
    const theirs = measureWalk({ view: copyFor(state, P1), sceneId: "s1", stops, viewer: { role: "player" }, everything: false })!;
    assert.deepEqual(shared.legs.map((leg) => [leg.from, leg.to, leg.ft]), theirs.legs.map((leg) => [leg.from, leg.to, leg.ft]));
    assert.equal(theirs.totalFt, 25, "Bree's own walk, 5 squares, the hidden horse's dust unseen");
    const mine = measureWalk({ view: state, sceneId: "s1", stops, viewer: { role: "dm" }, everything: true })!;
    assert.equal(mine.totalFt, 25, "the horse's own walk, its dust going with it");
    assert.deepEqual(mine.legs[0]!.from, { x: 3, y: 2 });
  });

  test("a ruler from a rider on an independent ride still walks her off on her own", () => {
    const state = riding({ attached: { to: "horse", kind: "ride" } });
    const drag = dragOf(state, "dm", "bree", { x: 8, y: 2 });
    const ruler = measureWalk({ view: state, sceneId: "s1", stops: [tokenStop(SQUARES, state.tokens.bree!), { x: 8.5, y: 2.5 }], viewer: { role: "dm" }, everything: true })!;
    assert.deepEqual(ruler.legs.map((leg) => leg.ft), [drag.preview.read.dragFt]);
    assert.equal(ruler.legs[0]!.ft, 30, "her own 25 ft and 5 ft for the dust on the horse she walks off");
  });
});
