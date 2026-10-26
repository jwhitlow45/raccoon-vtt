import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { GridShape, Token } from "../model.ts";
import { int, rng, scene, token } from "../testutil.ts";
import { hexAnchor, occupiedHexes, placedOnHex, tokenRefHex, type SizeCategory } from "./footprint.ts";
import { gridOfShape } from "./grid.ts";
import { hexInScene, hexKey, sameHex, sceneHexSpan, type Hex, type HexGrid } from "./hex.ts";
import { NO_ROOM_TO_GROW, RESIZE_KEEPS_PLACE, resizeCandidates, resizeRefusal, resizeSpot } from "./resize.ts";

/**
 * A resize on hexes keeps the reference hex where it was
 * (docs/design-v1-hex-grids.md 4.2): a Medium growing Large keeps its hex
 * as the top one, and a Large shrinking Medium keeps its top hex.
 */

function world(shape: GridShape, t: Token) {
  return { scenes: { s1: scene("s1", { gridShape: shape, bounds: { w: 30, h: 20 } }) }, buildChunks: {}, tokens: { [t.id]: t } };
}

function on(g: HexGrid, size: SizeCategory, hex: Hex): Token {
  return token("t", { size, ...placedOnHex(g, { size, x: 0, y: 0 }, hex) });
}

for (const shape of ["hexRows", "hexColumns"] as const) {
  const g = gridOfShape(shape) as HexGrid;
  describe(`${shape}: a resize keeps the reference hex`, () => {
    test("a Medium grows Large with its hex as the top one, and shrinks back onto it, through each size", () => {
      const r = rng(71);
      for (let i = 0; i < 300; i++) {
        const hex = { col: int(r, 3, 20), row: int(r, 3, 12) };
        let t = on(g, "medium", hex);
        for (const size of ["large", "huge", "gargantuan", "huge", "large", "medium", "tiny", "medium"] as const) {
          const spot = resizeSpot(world(shape, t), t, { size }, { checked: true });
          assert.ok(!("refused" in spot), `${size} at ${hexKey(hex)}`);
          const next = { ...t, size, x: spot.x, y: spot.y };
          assert.ok(sameHex(tokenRefHex(g, next), hex), `${size} keeps ${hexKey(hex)} as its reference`);
          assert.equal(spot.shifted, false);
          assert.equal(resizeRefusal(world(shape, t), t, { size, x: spot.x, y: spot.y }), null, "the server takes the spot");
          t = next;
        }
      }
    });

    test("a growth that would leave the scene takes another footprint covering the old hex, the DM's moved the least to lie inside, as on squares (D-261026-17)", () => {
      // The last row: a Large's two lower hexes would lie below the scene.
      const span = sceneHexSpan(g, { w: 30, h: 20 });
      const hex: Hex = shape === "hexRows" ? { col: 10, row: span.rows - 1 } : { col: span.cols - 1, row: 10 };
      const t = on(g, "medium", hex);
      const kept = hexAnchor(g, { size: "large", ...placedOnHex(g, { size: "large", x: 0, y: 0 }, hex) });
      for (const checked of [true, false]) {
        const spot = resizeSpot(world(shape, t), t, { size: "large" }, { checked });
        assert.ok(!("refused" in spot));
        const grown = { ...t, size: "large" as const, x: spot.x, y: spot.y };
        const hexes = occupiedHexes(g, grown);
        assert.ok(hexes.some((h) => sameHex(h, hex)), "it covers the old hex");
        assert.ok(hexes.every((h) => hexInScene(g, { w: 30, h: 20 }, h)), "inside the scene");
        // One step up, the least a footprint can move: its anchor one cell from the kept one's, both on the 1/64 lattice.
        const a = hexAnchor(g, grown);
        assert.ok(Math.abs(Math.hypot(a.x - kept.x, a.y - kept.y) - 1) < 1 / 32, `${checked ? "owner" : "DM"}: moved ${Math.hypot(a.x - kept.x, a.y - kept.y)}`);
      }
    });

    test("a DM's Gargantuan grown in a scene's corner lies wholly inside it, moved the least of every footprint that does", () => {
      const bounds = { w: 30, h: 20 };
      const t = on(g, "medium", { col: 0, row: 0 });
      const spot = resizeSpot(world(shape, t), t, { size: "gargantuan" }, { checked: false });
      assert.ok(!("refused" in spot));
      const grown = { size: "gargantuan" as const, x: spot.x, y: spot.y };
      assert.ok(occupiedHexes(g, grown).every((h) => hexInScene(g, bounds, h)));
      const kept = hexAnchor(g, { size: "gargantuan", ...placedOnHex(g, { size: "gargantuan", x: 0, y: 0 }, { col: 0, row: 0 }) });
      const moved = (p: { x: number; y: number }) => Math.hypot(hexAnchor(g, { size: "gargantuan", ...p }).x - kept.x, hexAnchor(g, { size: "gargantuan", ...p }).y - kept.y);
      for (let row = -2; row <= 6; row++) {
        for (let col = -2; col <= 6; col++) {
          const at = placedOnHex(g, { size: "gargantuan", x: 0, y: 0 }, { col, row });
          if (occupiedHexes(g, { size: "gargantuan", ...at }).every((h) => hexInScene(g, bounds, h))) assert.ok(moved(spot) <= moved(at) + 1e-9, `${col},${row} moves less`);
        }
      }
    });

    test("candidates that tie fall in lattice order: the smaller row, then column, on hex rows, mirrored on hex columns (review HX2-OPUS-06)", () => {
      const lattice = (h: Hex) => (shape === "hexRows" ? [h.row, h.col] : [h.col, h.row]);
      let ties = 0;
      const sizes = ["tiny", "medium", "large", "huge", "gargantuan"] as const;
      for (const from of sizes) {
        for (const to of sizes) {
          if (from === to || (from === "tiny" && to === "medium") || (from === "medium" && to === "tiny")) continue;
          for (const hex of [{ col: 10, row: 8 }, { col: 11, row: 9 }]) {
            const t = on(g, from, hex);
            const ref = tokenRefHex(g, t);
            const from0 = hexAnchor(g, t);
            const refs = resizeCandidates(t, { size: to }, world(shape, t).scenes.s1).map((p) => tokenRefHex(g, { size: to, ...p }));
            const d = (r: Hex) => {
              const a = hexAnchor(g, { size: to, ...placedOnHex(g, { size: to, x: 0, y: 0 }, r) });
              return (a.x - from0.x) ** 2 + (a.y - from0.y) ** 2;
            };
            const want = [...refs].sort((a, b) => {
              if (sameHex(a, ref)) return -1;
              if (sameHex(b, ref)) return 1;
              const [ar, ac] = lattice(a);
              const [br, bc] = lattice(b);
              return d(a) - d(b) || ar! - br! || ac! - bc!;
            });
            assert.deepEqual(refs.map(hexKey), want.map(hexKey), `${from} to ${to} at ${hexKey(hex)}`);
            for (let i = 1; i < refs.length; i++) if (Math.abs(d(refs[i]!) - d(refs[i - 1]!)) < 1e-9 && !sameHex(refs[i - 1]!, ref)) ties++;
          }
        }
      }
      assert.ok(ties > 10, `${ties} ties`);
    });

    test("of the footprints that fit, an owner's growth takes the one whose anchor is nearest, ties to the smaller row, then column", () => {
      const span = sceneHexSpan(g, { w: 30, h: 20 });
      const last: Hex = shape === "hexRows" ? { col: 12, row: span.rows - 1 } : { col: span.cols - 1, row: 9 };
      const t = on(g, "medium", last);
      const spot = resizeSpot(world(shape, t), t, { size: "gargantuan" }, { checked: true });
      assert.ok(!("refused" in spot));
      // Every Gargantuan covering the Large's hexes inside the scene, found from nothing.
      const old = occupiedHexes(g, t).map(hexKey);
      const from = hexAnchor(g, t);
      const fits: { ref: Hex; d: number }[] = [];
      for (let row = last.row - 4; row <= last.row + 4; row++) {
        for (let col = last.col - 4; col <= last.col + 4; col++) {
          const at = placedOnHex(g, { size: "gargantuan", x: 0, y: 0 }, { col, row });
          const hexes = occupiedHexes(g, { size: "gargantuan", ...at });
          if (!old.every((k) => hexes.some((h) => hexKey(h) === k)) || !hexes.every((h) => hexInScene(g, { w: 30, h: 20 }, h))) continue;
          const a = hexAnchor(g, { size: "gargantuan", ...at });
          fits.push({ ref: { col, row }, d: (a.x - from.x) ** 2 + (a.y - from.y) ** 2 });
        }
      }
      fits.sort((a, b) => a.d - b.d || (shape === "hexRows" ? a.ref.row - b.ref.row || a.ref.col - b.ref.col : a.ref.col - b.ref.col || a.ref.row - b.ref.row));
      assert.ok(new Set(fits.map((f) => f.d.toFixed(6))).size > 1, "the candidates lie at different distances");
      assert.ok(sameHex(tokenRefHex(g, { size: "gargantuan", x: spot.x, y: spot.y }), fits[0]!.ref));
    });

    test("a Gargantuan with no room anywhere is refused for an owner", () => {
      const tiny = { ...world(shape, on(g, "medium", { col: 0, row: 0 })), scenes: { s1: scene("s1", { gridShape: shape, bounds: { w: 3, h: 3 } }) } };
      const t = tiny.tokens.t!;
      assert.deepEqual(resizeSpot(tiny, t, { size: "gargantuan" }, { checked: true }), { refused: NO_ROOM_TO_GROW });
    });

    test("the server takes a spot off its anchor that stands on a candidate's hexes, and refuses one that does not cover the creature", () => {
      const hex = { col: 8, row: 8 };
      const t = on(g, "medium", hex);
      const base = placedOnHex(g, { size: "large", x: 0, y: 0 }, hex);
      assert.equal(resizeRefusal(world(shape, t), t, { size: "large", x: base.x + 0.05, y: base.y - 0.05 }), null);
      const far = placedOnHex(g, { size: "large", x: 0, y: 0 }, { col: 12, row: 8 });
      assert.equal(resizeRefusal(world(shape, t), t, { size: "large", ...far }), RESIZE_KEEPS_PLACE);
      // A shrink lands inside the old footprint only.
      const large = on(g, "large", hex);
      const out = placedOnHex(g, { size: "medium", x: 0, y: 0 }, { col: 2, row: 2 });
      assert.equal(resizeRefusal(world(shape, large), large, { size: "medium", ...out }), RESIZE_KEEPS_PLACE);
      for (const h of occupiedHexes(g, large)) assert.equal(resizeRefusal(world(shape, large), large, { size: "medium", ...placedOnHex(g, { size: "medium", x: 0, y: 0 }, h) }), null);
    });
  });
}
