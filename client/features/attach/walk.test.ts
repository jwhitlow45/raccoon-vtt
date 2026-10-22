import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { RoomState, Token } from "#shared/model.ts";
import type { Op } from "#shared/protocol.ts";
import { applyOp } from "#shared/reducer.ts";
import { findRoute } from "#shared/rules/walk.ts";
import { groupWalkWorld, publicWorld } from "#shared/rules/walkWorld.ts";
import { canApply } from "#shared/permissions.ts";
import type { RoutePiece } from "#shared/rules/route.ts";
import { dropView, moveOpsOf, planGroup, planOne, routeLanding, type Landed } from "../movement/drop.ts";
import { DM, P1, actor, effect, env, token } from "#shared/testutil.ts";
import { dragOf, groupDragOf } from "../movement/dragTesting.ts";
import { copyFor } from "./testing.ts";
import { line, onTurn, raised, thorn, world } from "../movement/testing.ts";
import { extraWords } from "../measure/movement.ts";
import { towingWord, walkersFor, walkersOfGroup } from "./walk.ts";
import { detachOp, getOffPlace } from "./detach.ts";
import { LEDGE_IN_THE_WAY, legBlocker } from "#shared/rules/movement.ts";
import { walkerFor } from "#shared/rules/attach.ts";

const goblin = (over: Partial<Token> = {}) => token("goblin", { name: "Goblin", x: 3, y: 5, attached: { to: "thorn", kind: "drag" }, ...over });

describe("a holder's walk", () => {
  test("dragging a creature costs every foot one more, on every piece of the route, and the creature never stands in the way", () => {
    const state = world({ blockMovement: false, tokens: [thorn({ x: 2, y: 5 }), goblin()] });
    const mover = state.tokens.thorn!;
    const plain = publicWorld(state, mover, { role: "player" });
    assert.equal(plain.spaces.some((s) => s.id === "goblin"), true);
    const grouped = groupWalkWorld(state, mover, { role: "player" });
    assert.equal(grouped.input.drag, 1);
    assert.equal(grouped.spaces.some((s) => s.id === "goblin"), false);
    assert.equal(grouped.input.creatures.length, grouped.spaces.length);
    const route = findRoute(grouped.input, { x: 6, y: 5 });
    assert.ok(route && route !== "none", "an open leg that costs extra is searched as a route");
    assert.ok(route.pieces.every((p) => p[2] === 1), "each piece carries the dragging foot");
  });

  test("a Tiny creature, one two sizes smaller and one players cannot see cost nothing, and a lone token's world is as it was", () => {
    const tiny = world({ tokens: [thorn({ x: 2, y: 5 }), goblin({ size: "tiny" })] });
    assert.equal(groupWalkWorld(tiny, tiny.tokens.thorn!, { role: "player" }).input.drag ?? 0, 0);
    const hidden = world({ tokens: [thorn({ x: 2, y: 5 }), goblin({ visibility: "dm" })] });
    assert.equal(groupWalkWorld(hidden, hidden.tokens.thorn!, { role: "dm" }).input.drag ?? 0, 0);
    const alone = world({ tokens: [thorn({ x: 2, y: 5 })] });
    assert.deepEqual(groupWalkWorld(alone, alone.tokens.thorn!, { role: "player" }).input.creatures, publicWorld(alone, alone.tokens.thorn!, { role: "player" }).input.creatures);
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

describe("every check of a walk off a holder on the ground walks it as its rider until clear of the holder, then on the ground (reviews AT-ASTRA-13 and AT-O-25)", () => {
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

  test("a drag east crosses the step under the horse, as its rider, onto the high ground, and routes round a wall from there", () => {
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

  test("off a 10 ft horse she climbs no 20 ft ground: the step onto the first square clear of it is judged from her height", () => {
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
