import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { EdgeFeature, RoomState, Token } from "#shared/model.ts";
import type { Op } from "#shared/protocol.ts";
import { applyOp } from "#shared/reducer.ts";
import { findRoute } from "#shared/rules/walk.ts";
import { groupWalkWorld, publicWorld } from "#shared/rules/walkWorld.ts";
import { canApply } from "#shared/permissions.ts";
import type { RoutePiece } from "#shared/rules/route.ts";
import { dropView, moveOpsOf, planGroup, planOne, planWalk, routeLanding, walkersStop, type Landed } from "../movement/drop.ts";
import { DM, P1, actor, effect, env, reveal, template, token } from "#shared/testutil.ts";
import { dragOf, groupDragOf } from "../movement/dragTesting.ts";
import { copyFor } from "./testing.ts";
import { line, onTurn, raised, thorn, world } from "../movement/testing.ts";
import { extraWords } from "../measure/movement.ts";
import { tokenStop } from "../measure/ruler.ts";
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
    }
  });

  test("the walkers are the dragged creatures players see", () => {
    const state = world({ edges: line("w", 6, 0, 5), tokens: [thorn({ x: 2, y: 5 }), goblin(), token("ghost", { x: 1, y: 5, visibility: "dm", attached: { to: "thorn", kind: "drag" } })] });
    assert.deepEqual(walkersFor(state, "thorn", "dm").map((t) => t.id), ["goblin"]);
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
    assert.equal(refusal(redo, state), LEDGE_IN_THE_WAY);
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
    const ruler = measureWalk({ view, sceneId: "s1", stops: [tokenStop(view.tokens.imp!), { x: 8.5, y: 6.5 }, { x: 9.5, y: 6.5 }], viewer: { role: "player" }, everything: false })!;
    // The same two drags, made one after the other: the first leaves the cart, so the second walks on the ground.
    const off = dragOf(view, "player", "imp", { x: 8, y: 6 });
    const r = applyOp(state, off.op as Op, P1, env(9));
    assert.ok(r.ok);
    const back = dragOf(copyFor(r.state, P1), "player", "imp", { x: 9, y: 6 });
    const r2 = applyOp(r.state, back.op as Op, P1, env(10));
    assert.ok(r2.ok);
    assert.deepEqual([r2.state.tokens.imp!.elevation, r2.state.tokens.imp!.attached], [0, undefined]);
    assert.deepEqual(ruler.legs.map((leg) => leg.ft), [off.preview.read.dragFt, back.preview.read.dragFt]);
    assert.deepEqual(ruler.legs.map((leg) => leg.ft), [10, 5]);
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
    const ruler = measureWalk({ view: state, sceneId: "s1", stops: [tokenStop(state.tokens.imp!), ...spots.map((p) => ({ x: p.x + 0.5, y: p.y + 0.5 }))], viewer: { role: "dm" }, everything: true })!;
    assert.deepEqual(ruler.legs.map((leg) => leg.ft), dragsOf(state, spots));
  });

  test("a shared walking ruler reads the same on a player's copy as on the DM's, a token it moves into the fog seen by neither (review AT-SOL-5)", () => {
    const state = fogged();
    const stops = [tokenStop(state.tokens.imp!), { x: 9.5, y: 8.5 }, { x: 8.5, y: 8.5 }];
    const dm = measureWalk({ view: state, sceneId: "s1", stops, viewer: { role: "dm" }, everything: false })!;
    const player = measureWalk({ view: copyFor(state, P1), sceneId: "s1", stops, viewer: { role: "player" }, everything: false })!;
    assert.deepEqual(player.legs.map((leg) => leg.ft), dm.legs.map((leg) => leg.ft));
    assert.equal(dm.legs[1]!.ft, 5);
  });

  test("a walking ruler's later legs judge who sees the token where its earlier legs left it (review AT-SOL-3)", () => {
    // Its first leg keeps the imp on the cart, in the fog, where no player sees it, so its next leg west off the cart walks as a
    // token with no holder: 10 ft up, over low ground. The DM's own ruler reads the fogged ground, as the DM's drag does.
    const state = fogged();
    const ruler = measureWalk({ view: state, sceneId: "s1", stops: [tokenStop(state.tokens.imp!), { x: 9.5, y: 8.5 }, { x: 8.5, y: 8.5 }], viewer: { role: "dm" }, everything: true })!;
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
