import assert from "node:assert/strict";
import { describe, test } from "node:test";
import fc from "fast-check";
import type { Token } from "#shared/model.ts";
import { footprintRect } from "#shared/rules/footprint.ts";
import { SQUARES, sceneGrid } from "#shared/rules/grid.ts";
import { freeDrawnAt, nudgeAt, nudgeBound } from "#shared/rules/nudge.ts";
import { holds } from "#shared/propertyTestutil.ts";
import { token } from "#shared/testutil.ts";
import { moveOpsOf, type DropPlan, type Landed, type Stop } from "./drop.ts";
import { ALT_AFTER_DRAG_MS, altKeyups, freeDrop, keepPlacements, leadNode, placement, type FreeInput } from "./free.ts";
import { teleportMove } from "./teleport.ts";
import { seenRoom, thorn, world } from "./testing.ts";

/*
 * Snap off for a drag (docs/design/design-v1-snap-off.md 6.4, section 10):
 * what a drop adds to its plan so the token stays drawn where it was let go.
 */

const HEX = sceneGrid({ gridShape: "hexColumns" });

const plan = (...moves: Landed[]): DropPlan => ({ moves, stop: null, held: [] });
const move = (t: Pick<Token, "id">, x: number, y: number): Landed => ({ tokenId: t.id, x, y });

function drop(over: Partial<FreeInput> & Pick<FreeInput, "lead" | "plan" | "release">): ReturnType<typeof freeDrop> {
  return freeDrop({ grid: SQUARES, pressedId: over.lead.id, named: [over.lead], free: false, inPlace: true, ...over });
}

describe("placement", () => {
  test("rounds the release to 1/8 and holds it within 3/8 of the landing", () => {
    const medium = token("m");
    // Section 10: released at (3.43, 2.6), it lands on (3, 3) drawn 3/8 right and 3/8 up.
    assert.deepEqual(placement(medium, { x: 3, y: 3 }, { x: 3.43, y: 2.6 }), { x: 3.375, y: 2.625 });
    // Released at (3.49, 2): 3.5 is past the bound, so it holds at 3/8.
    assert.deepEqual(placement(medium, { x: 3, y: 2 }, { x: 3.49, y: 2 }), { x: 3.375, y: 2 });
    assert.equal(placement(medium, { x: 3, y: 2 }, { x: 3.04, y: 1.97 }), null, "a release within 1/16 of the landing is the landing");
  });

  test("a token that snaps to half squares is held within 1/8", () => {
    const tiny = token("t", { size: "tiny" });
    assert.equal(nudgeBound(tiny), 1, "one eighth, counted in eighths");
    assert.deepEqual(placement(tiny, { x: 3.5, y: 3 }, { x: 3.8, y: 2.7 }), { x: 3.625, y: 2.875 });
  });

  test("every bound is under half a snap step, so the drawn box snaps back to its own", () => {
    for (const size of ["tiny", "small", "medium", "large", "huge", "gargantuan"] as const) {
      const t = token("t", { size });
      assert.ok(nudgeBound(t) / 8 < (size === "tiny" ? 0.25 : 0.5), size);
    }
    assert.equal(nudgeBound(token("c", { size: "custom", w: 1.75, h: 1.75 })), 3);
  });

  // The client aims and the reducer judges. One rounding and clamp, shared, means a
  // release the client sends is a release the reducer keeps.
  test("the client's placement and the server's nudge agree on random releases", () => {
    const sizes = fc.oneof(
      fc.constantFrom("tiny", "small", "medium", "large", "huge", "gargantuan").map((size) => ({ size }) as Pick<Token, "size" | "w" | "h">),
      fc.record({ size: fc.constant("custom" as const), w: fc.integer({ min: 2, max: 40 }).map((n) => n / 4), h: fc.integer({ min: 2, max: 40 }).map((n) => n / 4) }),
    );
    const coord = fc.double({ min: -50, max: 50, noNaN: true });
    holds(
      fc.property(sizes, coord, coord, (size, rx, ry) => {
        const release = { x: rx, y: ry };
        const lead = token("m", { ...size, x: 1, y: 1 });
        const box = footprintRect(SQUARES, { ...lead, ...release });
        const landing = { x: box.x, y: box.y };
        const at = placement(lead, landing, release);
        const landed = { ...lead, ...landing };
        const shared = freeDrawnAt(landed, release);
        if (!at) return shared.x === landing.x && shared.y === landing.y && nudgeAt(SQUARES, landed, shared) === undefined;
        if (at.x !== shared.x || at.y !== shared.y) return false;
        const nudge = nudgeAt(SQUARES, landed, at);
        // The reducer keeps exactly the nudge the client drew, and the drawn box snaps back to the landing.
        const back = footprintRect(SQUARES, { ...lead, ...at });
        return nudge !== undefined && nudge.x === (at.x - landing.x) * 8 && nudge.y === (at.y - landing.y) * 8 && back.x === landing.x && back.y === landing.y;
      }),
      2_000,
    );
  });
});

describe("freeDrop", () => {
  const medium = token("m", { x: 3, y: 3 });

  test("a free drop that lands on the box under the release draws the token where it was let go", () => {
    const out = drop({ lead: medium, plan: plan(move(medium, 5, 4)), release: { x: 5.3, y: 3.9 }, free: true });
    assert.deepEqual(out.plan.moves, [{ tokenId: "m", x: 5, y: 4, drawnAt: { x: 5.25, y: 3.875 } }]);
    assert.equal(out.placed, true);
    assert.deepEqual(moveOpsOf(out.plan.moves), [{ t: "token.move", tokenId: "m", x: 5, y: 4, drawnAt: { x: 5.25, y: 3.875 } }]);
  });

  test("Alt let go before the drop sends no drawnAt", () => {
    const out = drop({ lead: medium, plan: plan(move(medium, 5, 4)), release: { x: 5.3, y: 3.9 }, free: false });
    assert.deepEqual(out.plan.moves, [{ tokenId: "m", x: 5, y: 4 }]);
    assert.equal(out.place, null);
  });

  test("a free drop held short of its box sends none, and its note keeps the release for Teleport here", () => {
    const stop: Stop = { tokenId: "m", sceneId: "s1", blocker: "wall", door: null, ghost: { x: 6, y: 3 }, aim: { x: 6.3, y: 3 }, at: { x: 4, y: 3 } };
    const out = drop({ lead: medium, plan: { moves: [move(medium, 4, 3)], stop, held: [] }, release: { x: 6.3, y: 3 }, free: true });
    assert.deepEqual(out.plan.moves, [{ tokenId: "m", x: 4, y: 3 }]);
    assert.deepEqual(out.plan.stop?.drawnAt, { x: 6.25, y: 3 });
    const hero = thorn({ x: 3, y: 3 });
    const room = seenRoom(world({ tokens: [hero] }));
    assert.deepEqual(teleportMove(room, hero, { ...stop, drawnAt: { x: 6.25, y: 3 } }).drawnAt, { x: 6.25, y: 3 }, "Teleport here lands it placed");
  });

  test("a free drop on its own box places it in place for the DM or an owner, and sends nothing for anyone else", () => {
    const out = drop({ lead: medium, plan: plan(), release: { x: 3.3, y: 2.8 }, free: true });
    assert.deepEqual(out.place, { t: "token.update", tokenId: "m", patch: { drawnAt: { x: 3.25, y: 2.75 } } });
    assert.equal(out.placed, true);
    const mover = drop({ lead: medium, plan: plan(), release: { x: 3.3, y: 2.8 }, free: true, inPlace: false });
    assert.equal(mover.place, null, "a player who moves others' tokens but owns none of this one");
    const same = drop({ lead: { ...medium, nudge: { x: 2, y: -2 } }, plan: plan(), release: { x: 3.25, y: 2.75 }, free: true });
    assert.equal(same.place, null, "let go where it is already drawn");
  });

  test("an ordinary drop on its own box puts a placed token back on the grid only past 1/8 square", () => {
    const placed = { ...medium, nudge: { x: 3, y: 0 } };
    assert.equal(drop({ lead: placed, plan: plan(), release: { x: 3.375 + 0.1, y: 3.05 } }).place, null, "jitter under 1/8 sends nothing");
    assert.deepEqual(drop({ lead: placed, plan: plan(), release: { x: 3.25, y: 3 } }).place, { t: "token.update", tokenId: "m", patch: { drawnAt: null } });
    assert.equal(drop({ lead: placed, plan: plan(), release: { x: 3.25, y: 3 }, inPlace: false }).place, null, "nothing sent for a non-owner");
    assert.equal(drop({ lead: medium, plan: plan(), release: { x: 3.25, y: 3 } }).place, null, "nothing to put back");
  });

  test("an ordinary lone drag of a placed token to another box sends no drawnAt, so the placement goes", () => {
    const placed = { ...medium, nudge: { x: 3, y: 0 } };
    assert.deepEqual(drop({ lead: placed, plan: plan(move(placed, 6, 3)), release: { x: 6.375, y: 3 } }).plan.moves, [{ tokenId: "m", x: 6, y: 3 }]);
  });

  test("a group keeps each placement, its one survivor sent as token.move included", () => {
    const a = { ...token("a", { x: 3, y: 3 }), nudge: { x: 2, y: 1 } };
    const b = token("b", { x: 5, y: 3 });
    const out = freeDrop({ grid: SQUARES, lead: a, pressedId: a.id, named: [a, b], plan: plan(move(a, 4, 3)), release: { x: 4.25, y: 3.125 }, free: true, inPlace: true });
    assert.deepEqual(out.plan.moves, [{ tokenId: "a", x: 4, y: 3, drawnAt: { x: 4.25, y: 3.125 } }]);
    assert.deepEqual(moveOpsOf(out.plan.moves), [{ t: "token.move", tokenId: "a", x: 4, y: 3, drawnAt: { x: 4.25, y: 3.125 } }]);
    const both = freeDrop({ grid: SQUARES, lead: a, pressedId: a.id, named: [a, b], plan: plan(move(a, 4, 3), move(b, 6, 3)), release: { x: 4.25, y: 3.125 }, free: false, inPlace: true });
    assert.deepEqual(moveOpsOf(both.plan.moves), [{ t: "token.moveMany", moves: [{ tokenId: "a", x: 4, y: 3, drawnAt: { x: 4.25, y: 3.125 } }, { tokenId: "b", x: 6, y: 3 }] }]);
  });

  test("a mount moved by its rider's drag keeps its placement", () => {
    const mount = { ...token("mount", { size: "large", x: 2, y: 2 }), nudge: { x: -1, y: 2 } };
    const out = freeDrop({ grid: SQUARES, lead: mount, pressedId: "rider", named: [mount], plan: plan(move(mount, 5, 2)), release: { x: 4.875, y: 2.25 }, free: true, inPlace: true });
    assert.deepEqual(out.plan.moves, [{ tokenId: "mount", x: 5, y: 2, drawnAt: { x: 4.875, y: 2.25 } }]);
  });

  test("a squeezed landing and a hex scene keep no placement", () => {
    const placed = { ...medium, nudge: { x: 1, y: 1 } };
    assert.deepEqual(keepPlacements(SQUARES, plan({ ...move(placed, 4, 3), squeeze: true }), [placed]).moves, [{ tokenId: "m", x: 4, y: 3, squeeze: true }]);
    assert.deepEqual(drop({ grid: HEX, lead: medium, plan: plan(move(medium, 5, 4)), release: { x: 5.3, y: 3.9 }, free: true }).plan.moves, [{ tokenId: "m", x: 5, y: 4 }]);
  });
});

describe("leadNode", () => {
  test("held and put back, the pressed node and the lead's each sit at their own drawn spot", () => {
    const mount = { ...token("mount", { size: "large", x: 2, y: 2 }), nudge: { x: -2, y: 0 } };
    const rider = { ...token("rider", { x: 3, y: 2 }), nudge: { x: 3, y: 1 } };
    let at = { x: 3.375, y: 2.125 };
    const pressed = { x: () => at.x, y: () => at.y, position: (p: { x: number; y: number }) => (at = p) };
    const lead = leadNode(pressed, rider, mount);
    assert.deepEqual({ x: lead.x(), y: lead.y() }, { x: 1.75, y: 2 }, "the mount's node reads where the mount is drawn");
    // A hold writes the mount at a rules spot plus its own nudge: the rider's node keeps the rider's drawn offset.
    lead.position({ x: 4 - 0.25, y: 2 });
    assert.deepEqual(at, { x: 5.375, y: 2.125 });
  });
});

describe("Alt's keyup around a drag (D-261102-537)", () => {
  const clock = () => {
    let t = 0;
    return { now: () => t, wait: (ms: number) => (t += ms) };
  };

  test("prevented while a drag is live, and only Alt", () => {
    const keys = altKeyups(clock().now);
    assert.equal(keys.swallows("Alt", true), true);
    assert.equal(keys.swallows("Shift", true), false);
    assert.equal(keys.swallows("Alt", false), false, "no drag, no drag just ended");
  });

  test("the first Alt keyup within 1 s after a drag let go with Alt held, and not the next one", () => {
    const c = clock();
    const keys = altKeyups(c.now);
    keys.dragEnded(true);
    c.wait(ALT_AFTER_DRAG_MS);
    assert.equal(keys.swallows("Shift", false), false, "another key passes and spends nothing");
    assert.equal(keys.swallows("Alt", false), true, "the Alt let go just after the drop");
    assert.equal(keys.swallows("Alt", false), false, "a later Alt is the page's");
  });

  test("not past 1 s, and not after a drag let go without Alt", () => {
    const c = clock();
    const keys = altKeyups(c.now);
    keys.dragEnded(true);
    c.wait(ALT_AFTER_DRAG_MS + 1);
    assert.equal(keys.swallows("Alt", false), false, "too late");
    keys.dragEnded(false);
    assert.equal(keys.swallows("Alt", false), false, "no Alt at the drop");
    keys.dragEnded(true);
    keys.dragEnded(false);
    assert.equal(keys.swallows("Alt", false), false, "a later drag without Alt clears it");
  });
});
