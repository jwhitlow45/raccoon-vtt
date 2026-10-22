import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { RoomState, Token } from "#shared/model.ts";
import type { Op } from "#shared/protocol.ts";
import { applyOp } from "#shared/reducer.ts";
import { findRoute } from "#shared/rules/walk.ts";
import { groupWalkWorld, publicWorld } from "#shared/rules/walkWorld.ts";
import { canApply } from "#shared/permissions.ts";
import { dropView, moveOpsOf, planOne, type Landed } from "../movement/drop.ts";
import { DM, P1, actor, effect, env, token } from "#shared/testutil.ts";
import { dragOf } from "../movement/dragTesting.ts";
import { copyFor } from "./testing.ts";
import { line, raised, thorn, world } from "../movement/testing.ts";
import { extraWords } from "../measure/movement.ts";
import { towingWord, walkersFor } from "./walk.ts";

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
