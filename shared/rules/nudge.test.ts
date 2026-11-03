import assert from "node:assert/strict";
import { describe, test } from "node:test";
import fc from "fast-check";
import { holds } from "../propertyTestutil.ts";
import { room, scene, token } from "../testutil.ts";
import { footprintRect, placedOnHex, snapStep, type PlacedToken } from "./footprint.ts";
import type { HexGrid } from "./hex.ts";
import { SQUARES, gridOfShape, type Grid } from "./grid.ts";
import { drawnSpot, freeDrawnAt, nudgeAt, nudgeBound, nudgeable, nudgesToJudge, nudgeValid } from "./nudge.ts";

const HEX: Grid = gridOfShape("hexRows");

function placed(over: Partial<PlacedToken> & { nudge?: { x: number; y: number } } = {}): PlacedToken & { nudge?: { x: number; y: number } } {
  return { size: "medium", x: 3, y: 3, ...over };
}

describe("a drop between squares (docs/design/design-v1-snap-off.md 5.1, 6.4 and section 10)", () => {
  test("an Alt-drop of a Medium token let go at (3.43, 2.6) lands on (3, 3) drawn 3/8 right and 3/8 up", () => {
    const release = { x: 3.43, y: 2.6 };
    const landed = placed({ ...footprintRect(SQUARES, placed(release)) });
    assert.deepEqual({ x: landed.x, y: landed.y }, { x: 3, y: 3 });
    const at = freeDrawnAt(landed, release);
    assert.deepEqual(at, { x: 3.375, y: 2.625 });
    assert.deepEqual(nudgeAt(SQUARES, landed, at), { x: 3, y: -3 });
  });

  test("a release past the bound is held at it: (3.49, 2) is drawn 3/8 right, and no nudge on the other axis", () => {
    const landed = placed({ x: 3, y: 2 });
    const at = freeDrawnAt(landed, { x: 3.49, y: 2 });
    assert.deepEqual(at, { x: 3.375, y: 2 });
    assert.deepEqual(nudgeAt(SQUARES, landed, at), { x: 3, y: 0 });
    assert.deepEqual(freeDrawnAt(landed, { x: 2.51, y: 1.51 }), { x: 2.625, y: 1.625 }, "and on the other side");
  });

  test("a Tiny token, which snaps to half squares, keeps within 1/8", () => {
    const tiny = placed({ size: "tiny", x: 1.5, y: 2 });
    assert.equal(nudgeBound(tiny), 1);
    assert.deepEqual(freeDrawnAt(tiny, { x: 1.74, y: 1.76 }), { x: 1.625, y: 1.875 });
    assert.deepEqual(nudgeAt(SQUARES, tiny, { x: 1.625, y: 2 }), { x: 1, y: 0 });
    assert.equal(nudgeAt(SQUARES, tiny, { x: 1.75, y: 2 }), undefined, "2/8 is half its step, past the bound");
    assert.equal(nudgeValid(SQUARES, { ...tiny, nudge: { x: 2, y: 0 } }), false);
    assert.equal(nudgeValid(SQUARES, { ...tiny, nudge: { x: -1, y: 1 } }), true);
    const small = placed({ size: "custom", w: 0.75, h: 2, x: 1.5, y: 2 });
    assert.equal(snapStep(small), 0.5);
    assert.equal(nudgeBound(small), 1, "a custom side under a square snaps to halves too");
  });

  test("no nudge without a drawn point, on the landing itself, or past the bound", () => {
    const t = placed();
    assert.equal(nudgeAt(SQUARES, t, undefined), undefined);
    assert.equal(nudgeAt(SQUARES, t, null), undefined);
    assert.equal(nudgeAt(SQUARES, t, { x: 3, y: 3 }), undefined);
    assert.equal(nudgeAt(SQUARES, t, { x: 3.5, y: 3 }), undefined);
    assert.equal(nudgeAt(SQUARES, t, { x: 3, y: 2.5 }), undefined);
    assert.equal(nudgeAt(SQUARES, t, { x: 4, y: 3 }), undefined);
    assert.equal(nudgeAt(SQUARES, t, { x: 3.3, y: 3 }), undefined, "off the 1/8 lattice");
    assert.deepEqual(nudgeAt(SQUARES, t, { x: 2.625, y: 3.375 }), { x: -3, y: 3 });
  });

  test("only on squares, unsqueezed, on the token's own snapped spot", () => {
    const at = { x: 3.25, y: 3 };
    assert.equal(nudgeAt(HEX, placed(), at), undefined, "a hex scene keeps creatures on a hex");
    // One standing on its hex, where a hex scene's box is its stored box, still takes none.
    const onHex = placed({ ...placedOnHex(HEX as HexGrid, placed(), { col: 3, row: 2 }) });
    assert.deepEqual([footprintRect(HEX, onHex).x, footprintRect(HEX, onHex).y], [onHex.x, onHex.y]);
    assert.equal(nudgeable(HEX, onHex), false);
    assert.equal(nudgeAt(HEX, onHex, { x: onHex.x + 0.125, y: onHex.y }), undefined);
    assert.equal(nudgeValid(HEX, { ...onHex, nudge: { x: 1, y: 0 } }), false);
    assert.equal(nudgeAt(SQUARES, placed({ x: 3.5 }), { x: 3.625, y: 3 }), undefined, "a Medium creature held half off its square");
    assert.equal(nudgeAt(SQUARES, placed({ size: "large", squeeze: true }), at), undefined, "squeezed");
    assert.deepEqual(nudgeAt(SQUARES, placed({ size: "medium", squeeze: true }), at), { x: 2, y: 0 }, "a flag a Medium creature cannot squeeze by is no squeeze");
    assert.equal(nudgeable(SQUARES, placed({ size: "large", x: 2, y: 5 })), true);
    assert.equal(nudgeable(SQUARES, placed({ size: "tiny", x: 2.5, y: 5 })), true);
    assert.equal(nudgeable(SQUARES, placed({ size: "tiny", x: 2.25, y: 5 })), false);
    assert.equal(nudgeValid(SQUARES, placed({ nudge: { x: 0, y: 0 } })), false, "never both 0");
    assert.equal(nudgeValid(SQUARES, placed({ nudge: { x: 4, y: 0 } })), false);
    assert.equal(nudgeValid(SQUARES, placed({ nudge: { x: 0.5, y: 1 } })), false);
    assert.equal(nudgeValid(HEX, placed({ nudge: { x: 1, y: 0 } })), false);
    assert.equal(nudgeValid(HEX, placed()), true, "no nudge holds anywhere");
    assert.deepEqual(drawnSpot(SQUARES, placed({ nudge: { x: 3, y: -1 } })), { x: 3.375, y: 2.875 });
    assert.deepEqual(drawnSpot(HEX, placed({ nudge: { x: 3, y: -1 } })), { x: 3, y: 3 });
  });

  test("a custom token 1.75 wide nudged 3/8 snaps back to its own box from where it is drawn", () => {
    const t = placed({ size: "custom", w: 1.75, h: 1.75, x: 2, y: 2, nudge: { x: 3, y: -3 } });
    assert.equal(nudgeValid(SQUARES, t), true);
    const drawn = drawnSpot(SQUARES, t);
    assert.deepEqual(footprintRect(SQUARES, { ...t, ...drawn }), footprintRect(SQUARES, t));
  });

  const sizes = fc.oneof(
    fc.constantFrom("tiny", "small", "medium", "large", "huge", "gargantuan").map((size) => ({ size }) as Pick<PlacedToken, "size" | "w" | "h">),
    fc.record({ size: fc.constant("custom" as const), w: fc.integer({ min: 2, max: 80 }).map((n) => n / 4), h: fc.integer({ min: 2, max: 80 }).map((n) => n / 4) }),
  );
  const spot = (step: number) => fc.integer({ min: -400, max: 400 }).map((n) => n * step);

  test("the invariant: every valid nudge, every size, is drawn in a spot that snaps back to the rules box", () => {
    holds(
      fc.property(sizes, fc.integer({ min: -3, max: 3 }), fc.integer({ min: -3, max: 3 }), fc.integer({ min: -400, max: 400 }), fc.integer({ min: -400, max: 400 }), (size, nx, ny, cx, cy) => {
        const step = snapStep(size as PlacedToken);
        const t = { ...size, x: cx * step, y: cy * step, nudge: { x: nx, y: ny } } as PlacedToken & { nudge: { x: number; y: number } };
        if (!nudgeValid(SQUARES, t)) return Math.abs(nx) > nudgeBound(t) || Math.abs(ny) > nudgeBound(t) || (nx === 0 && ny === 0);
        return JSON.stringify(footprintRect(SQUARES, { ...t, ...drawnSpot(SQUARES, t) })) === JSON.stringify(footprintRect(SQUARES, t));
      }),
      2_000,
    );
  });

  test("within the bound means landed where aimed: a free drop kept only on its aim, and every other snapped landing loses it", () => {
    holds(
      fc.property(sizes, fc.double({ min: -50, max: 50, noNaN: true }), fc.double({ min: -50, max: 50, noNaN: true }), fc.integer({ min: -3, max: 3 }), fc.integer({ min: -3, max: 3 }), (size, rx, ry, ox, oy) => {
        const release = { x: rx, y: ry };
        const aim = footprintRect(SQUARES, { ...size, ...release } as PlacedToken);
        const aimed = { ...size, x: aim.x, y: aim.y } as PlacedToken;
        const drawnAt = freeDrawnAt(aimed, release);
        const kept = nudgeAt(SQUARES, aimed, drawnAt);
        // The drawn spot is on the lattice and in the box, and it snaps back to the aim.
        if (!Number.isInteger(drawnAt.x * 8) || !Number.isInteger(drawnAt.y * 8)) return false;
        const back = footprintRect(SQUARES, { ...size, ...drawnAt } as PlacedToken);
        if (back.x !== aim.x || back.y !== aim.y) return false;
        if (kept && !nudgeValid(SQUARES, { ...aimed, nudge: kept })) return false;
        // Any other landing a wall, a touch or a trap could give: a snapped spot steps away, or a spot off the grid.
        const step = snapStep(aimed);
        const other = { ...aimed, x: aim.x + ox * step, y: aim.y + oy * step };
        if ((ox !== 0 || oy !== 0) && nudgeAt(SQUARES, other, drawnAt) !== undefined) return false;
        const offGrid = { ...aimed, x: aim.x + (ox + 0.5) * step };
        return nudgeAt(SQUARES, offGrid, drawnAt) === undefined;
      }),
      2_000,
    );
  });

  test("the pass judges every token the op wrote and every nudged token of a scene whose grid shape changed", () => {
    const before = room({ scenes: { s1: scene("s1"), s2: scene("s2") } });
    const after = room({
      scenes: { s1: scene("s1", { gridShape: "hexRows" }), s2: scene("s2") },
      tokens: {
        a: token("a", { sceneId: "s1", nudge: { x: 1, y: 0 } }),
        b: token("b", { sceneId: "s1" }),
        c: token("c", { sceneId: "s2", nudge: { x: 1, y: 0 } }),
        d: token("d", { sceneId: "s2", nudge: { x: 1, y: 0 } }),
      },
    });
    assert.deepEqual(nudgesToJudge(before, after, ["scene:s1", "token:d", "token:gone", "fogTile:s2:0:0"]), ["a", "d"]);
    assert.deepEqual(nudgesToJudge(before, after, ["scene:s2"]), [], "a scene whose shape stays");
    assert.deepEqual(nudgesToJudge(before, after, ["token:b"]), [], "a token with no nudge");
  });
});
