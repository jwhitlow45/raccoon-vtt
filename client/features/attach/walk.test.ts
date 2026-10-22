import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { Token } from "#shared/model.ts";
import { findRoute } from "#shared/rules/walk.ts";
import { groupWalkWorld, publicWorld } from "#shared/rules/walkWorld.ts";
import { canApply } from "#shared/permissions.ts";
import { moveOpsOf, planOne } from "../movement/drop.ts";
import { P1, actor, effect, token } from "#shared/testutil.ts";
import { line, raised, thorn, world } from "../movement/testing.ts";
import { extraWords } from "../measure/movement.ts";
import { onSeats, towingWord, walkersFor } from "./walk.ts";

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
  test("is sent at the holder's elevation, which the server takes from a player who may only re-seat the token", () => {
    // P1's warhorse straddles a 10 ft step, standing at 10 ft, and carries the DM's grappled kobold on its high half.
    const horse = token("horse", { name: "Warhorse", kind: "npc", size: "large", x: 4, y: 4, elevation: 10, ownerIds: ["p1"] });
    const kobold = token("kobold", { name: "Kobold", size: "small", x: 5, y: 4, elevation: 10, attached: { to: "horse", kind: "carry" }, actor: { inline: actor({ effects: [effect("g", { key: "grappled" })] }) } });
    const state = world({ blockMovement: false, heights: raised(5, 4, 6, 6, 10), tokens: [horse, kobold] });
    const plan = planOne(state, state.tokens.kobold!, { x: 4, y: 4 }, "free");
    assert.equal(plan.moves[0]?.elevation, 0, "the drop alone would land it on the low ground under its new seat");
    const answer = (moves: typeof plan.moves) => canApply(moveOpsOf(moves)[0]!, P1, state, { canUseAsset: () => true }).ok;
    assert.equal(answer(plan.moves), false);
    const seated = onSeats(state, plan.moves);
    assert.deepEqual(seated, [{ tokenId: "kobold", x: 4, y: 4 }], "at the holder's 10 ft, its own height");
    assert.equal(answer(seated), true);
    // Off its holder, a drop lands on the ground as a Get off does, judged from the horse on the ground.
    const off = planOne(state, state.tokens.kobold!, { x: 9, y: 9 }, "free").moves;
    assert.deepEqual(onSeats(state, off), [{ tokenId: "kobold", x: 9, y: 9, elevation: 0 }]);
    // Kept on the low half's seat, a drag off it by the drop's own rule would stay at 10 ft over 0 ft ground.
    const low = world({ blockMovement: false, heights: raised(5, 4, 6, 6, 10), tokens: [horse, { ...kobold, x: 4, y: 4 }] });
    const offLow = planOne(low, low.tokens.kobold!, { x: 2, y: 4 }, "free").moves;
    assert.equal(offLow[0]?.elevation, undefined, "the drop alone keeps it at 10 ft, flying");
    assert.deepEqual(onSeats(low, offLow), [{ tokenId: "kobold", x: 2, y: 4, elevation: 0 }]);
  });
});
