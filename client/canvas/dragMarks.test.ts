import "../components/testing/register.ts";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { FOG_SUBCELLS } from "#shared/model.ts";
import { tileKey } from "#shared/keys.ts";
import { footprintRect } from "#shared/rules/footprint.ts";
import { encodeTile, TILE_BYTES, TILE_CELLS, TILE_SUB } from "#shared/rules/fog.ts";
import { placedOnHex } from "#shared/rules/footprint.ts";
import { hexCenter } from "#shared/rules/hex.ts";
import { room, scene, template, token } from "#shared/testutil.ts";
import { areaContext, cachedCoverage, caughtTokens } from "../features/areas/coverage.ts";
import { boardSizes } from "../lib/boardScale.ts";
import { auraClip } from "./markStand.ts";
import { FogView } from "./relief/fogView.ts";
import { SQUARES } from "#shared/rules/grid.ts";

const { auraBox, movingAuraBox } = await import("./DragMarks.tsx");
const { areaOutline } = await import("../features/areas/placement.ts");
const { CAUGHT_RING } = await import("../features/areas/TemplateLayer.tsx");

/** Fog on a 16 by 16 scene with every sub-cell west of `x` revealed. */
function fogWestOf(x: number): FogView {
  const bits = new Uint8Array(TILE_BYTES);
  for (let sy = 0; sy < 16 * FOG_SUBCELLS; sy++) {
    for (let sx = 0; sx < x * FOG_SUBCELLS; sx++) {
      const i = sy * TILE_SUB + sx;
      bits[i >> 3] = bits[i >> 3]! | (1 << (i & 7));
    }
  }
  return new FogView({ [tileKey("s1", 0, 0)]: { sceneId: "s1", tx: 0, ty: 0, rev: 1, bits: encodeTile(bits) } }, "s1", { w: 16, h: 16 });
}

test("a moving aura that catches a Gargantuan by one corner cell clips its ring where it reaches past the aura's window over fog (ISO34-OPUS-1, FV-1)", () => {
  const state = room();
  state.scenes.s1 = scene("s1", { bounds: { w: 16, h: 16 } });
  // A 5 ft aura round a Medium at 4, 6, and a Gargantuan whose footprint, 5 to 9, overlaps its east column alone.
  state.tokens.cleric = token("cleric", { x: 4, y: 6 });
  state.tokens.dragon = token("dragon", { size: "gargantuan", x: 5, y: 3 });
  state.templates.aura = template("aura", { shape: "emanation", size: 5, attachedTo: "cleric", origin: { x: 4.5, y: 6.5, z: 0 } });
  const ctx = areaContext(state, state.scenes.s1!);
  const aura = state.templates.aura!;
  const caught = caughtTokens(aura, ctx, "s1");
  assert.ok(caught.includes("dragon"), JSON.stringify(caught));
  const cov = cachedCoverage(aura, ctx);
  const dragon = footprintRect(SQUARES, state.tokens.dragon!);
  assert.equal(dragon.x + dragon.w, cov.x0 + cov.w + 2, "the footprint reaches the margin's edge, so its ring's gap and stroke go past it");
  // Revealed to the margin's edge: the old box, the window and its margin, was clear.
  const fog = fogWestOf(9);
  assert.equal(auraClip(fog, { x0: cov.x0 - 2, y0: cov.y0 - 2, x1: cov.x0 + cov.w + 2, y1: cov.y0 + cov.h + 2 }), null);
  for (const scale of [12, 40, 120]) {
    const box = auraBox(cov, areaOutline(aura, ctx), caught.map((id) => state.tokens[id]!), scale, SQUARES);
    // The ring as TokenRing draws it: its gap and its stroke's outer half, which grow with the token's ring.
    const k = boardSizes(scale).ringPx / 3;
    const outer = ((CAUGHT_RING.gapPx + CAUGHT_RING.widthPx / 2) * k) / scale;
    assert.ok(box.x1 >= dragon.x + dragon.w + outer - 1e-9 && box.y0 <= dragon.y - outer + 1e-9 && box.y1 >= dragon.y + dragon.h + outer - 1e-9, `scale ${scale}: ${JSON.stringify(box)}`);
    const clip = auraClip(fog, box);
    assert.ok(clip !== null && clip.every((r) => r.x + r.w <= 9 + 1e-9), `scale ${scale}: it clips at the fog's edge`);
  }
  // With the dragon wholly revealed, it shows whole.
  assert.equal(auraClip(fogWestOf(16), auraBox(cov, areaOutline(aura, ctx), caught.map((id) => state.tokens[id]!), 40, SQUARES)), null);
});

test("a moving aura that catches nobody keeps its window and margin", () => {
  assert.deepEqual(auraBox({ x0: 3, y0: 4, w: 5, h: 2 }, null, [], 40, SQUARES), { x0: 1, y0: 2, x1: 10, y1: 8 });
  // A square sphere's outline lies inside that margin, so its box is the window's and margin's as it always was.
  const state = room();
  state.scenes.s1 = scene("s1", { bounds: { w: 16, h: 16 } });
  state.templates.ball = template("ball", { shape: "sphere", size: 10, origin: { x: 8, y: 8, z: 0 } });
  const ctx = areaContext(state, state.scenes.s1!);
  const cov = cachedCoverage(state.templates.ball!, ctx);
  assert.deepEqual(auraBox(cov, areaOutline(state.templates.ball!, ctx), [], 40, SQUARES), { x0: cov.x0 - 2, y0: cov.y0 - 2, x1: cov.x0 + cov.w + 2, y1: cov.y0 + cov.h + 2 });
});

/** Fog on a `w` by `h` scene with every sub-cell whose middle `keep` takes revealed, over as many tiles as it needs. */
function fogWhere(w: number, h: number, keep: (x: number) => boolean): FogView {
  const tiles: Record<string, { sceneId: string; tx: number; ty: number; rev: number; bits: string }> = {};
  for (let ty = 0; ty * TILE_CELLS < h; ty++) {
    for (let tx = 0; tx * TILE_CELLS < w; tx++) {
      const bits = new Uint8Array(TILE_BYTES);
      for (let sy = 0; sy < TILE_SUB; sy++) {
        for (let sx = 0; sx < TILE_SUB; sx++) {
          if (!keep(tx * TILE_CELLS + (sx + 0.5) / FOG_SUBCELLS)) continue;
          const i = sy * TILE_SUB + sx;
          bits[i >> 3] = bits[i >> 3]! | (1 << (i & 7));
        }
      }
      tiles[tileKey("s1", tx, ty)] = { sceneId: "s1", tx, ty, rev: 1, bits: encodeTile(bits) };
    }
  }
  return new FogView(tiles, "s1", { w, h });
}

test("on a hex scene a moving thin line's box holds its whole outline, west and east of the few hexes it covers (HX3-ASTRA-01)", () => {
  const g = { shape: "hex", orient: "rows" } as const;
  const state = room();
  state.meta.settings = { ...state.meta.settings, feetPerCell: 100, aoeCoverage: "center" };
  state.scenes.s1 = scene("s1", { bounds: { w: 48, h: 40 }, gridShape: "hexRows" });
  state.tokens.mage = token("mage", placedOnHex(g, { size: "medium", x: 0, y: 0 }, { col: 20, row: 20 }));
  state.templates.ray = template("ray", { shape: "line", size: 1000, width: 5, yaw: 15, attachedTo: "mage", origin: { x: 21, y: 17.9, z: 0 } });
  const ctx = areaContext(state, state.scenes.s1!);
  const ray = state.templates.ray!;
  const outline = areaOutline(ray, ctx);
  assert.ok(outline && outline.kind === "poly");
  const xs = outline.points.filter((_, i) => i % 2 === 0);
  const covered = cachedCoverage(ray, ctx).hexes?.length ?? 0;
  assert.ok(covered > 0, "it covers a few hexes");
  const box = movingAuraBox(ray, ctx, state.scenes.s1!, 40);
  assert.ok(box.x0 <= Math.min(...xs) && box.x1 >= Math.max(...xs) + 2 / 40 - 1e-9, `${JSON.stringify(box)} holds the outline, ${Math.min(...xs)} to ${Math.max(...xs)}, and its stroke`);
  // Fog east of the outline's end: the line no longer shows whole.
  const east = auraClip(fogWhere(48, 40, (x) => x < Math.floor(Math.max(...xs))), box);
  assert.ok(east !== null, "clipped where its east end runs into fog");
  // Fog on a strip west of x = 25, inside its outline: clipped there, nothing drawn over it.
  const west = auraClip(fogWhere(48, 40, (x) => x >= 25), box);
  assert.ok(west !== null && west.length > 0, "clipped, and still drawn east of the strip");
  assert.ok(west.every((r) => r.x >= 25 - 1e-9), "nothing over the fogged strip");
});

test("on a hex scene an aura that covers no hex boxes its outline round its creature, not the scene's corner", () => {
  const g = { shape: "hex", orient: "rows" } as const;
  const state = room();
  state.meta.settings = { ...state.meta.settings, feetPerCell: 10 };
  state.scenes.s1 = scene("s1", { bounds: { w: 24, h: 24 }, gridShape: "hexRows" });
  state.tokens.cleric = token("cleric", placedOnHex(g, { size: "medium", x: 0, y: 0 }, { col: 10, row: 10 }));
  // Half a hex out, leaving its own hexes out: no hex at all.
  state.templates.aura = template("aura", { shape: "emanation", size: 5, attachedTo: "cleric", includeOrigin: false, origin: { x: 10.5, y: 10.5, z: 0 } });
  const ctx = areaContext(state, state.scenes.s1!);
  const aura = state.templates.aura!;
  const box = movingAuraBox(aura, ctx, state.scenes.s1!, 40);
  const mid = hexCenter(g, { col: 10, row: 10 });
  assert.ok(box.x0 < mid.x && box.x1 > mid.x && box.y0 < mid.y && box.y1 > mid.y, `${JSON.stringify(box)} stands round the cleric's hex`);
  assert.ok(box.x0 > 5 && box.y0 > 5, "nowhere near the scene's corner");
  assert.equal(cachedCoverage(aura, ctx).hexes?.length, 0, "it covers no hex");
});

test("the drag layer clips each moving aura by that box, with the creatures PlacedArea rings, and judges each tether by its stroke", () => {
  const src = readFileSync(new URL("./DragMarks.tsx", import.meta.url), "utf8");
  assert.match(src, /const box = movingAuraBox\(a, areas\.ctx, layer\.scene, layer\.scale\);/);
  assert.match(src, /const caught = caughtTokens\(a, ctx, scene\.id\)\.flatMap\(\(id\) => ctx\.tokens\?\.\[id\] \?\? \[\]\);\n\s*return auraBox\(cachedCoverage\(a, ctx\), areaOutline\(a, ctx\), caught, scale, sceneGrid\(scene\)\);/);
  assert.match(src, /moving=\{\{ z, clip: auraClip\(iso\.fog, box\) \}\}/);
  // A tether's stand test takes its stroke's half width, as TetherLine strokes it (ISO34-ASTRA-7).
  assert.match(src, /const show = tetherShows\(iso\.fog, l\.from, l\.to, tetherPx\(layer\.scale\) \/ 2 \/ layer\.scale\);/);
  assert.match(readFileSync(new URL("../features/attach/TetherLayer.tsx", import.meta.url), "utf8"), /const px = tetherPx\(scale\);[\s\S]*strokeWidth=\{px\}[\s\S]*lineCap="round"/);
  const layer = readFileSync(new URL("../features/areas/TemplateLayer.tsx", import.meta.url), "utf8");
  assert.match(layer, /const caught = caughtTokens\(t, ctx, props\.sceneId\);/);
  assert.match(layer, /<TokenRing key=\{id\} token=\{token\} grid=\{ctx\.grid\} color=\{t\.color\} scale=\{scale\} \{\.\.\.CAUGHT_RING\} \/>/);
});

