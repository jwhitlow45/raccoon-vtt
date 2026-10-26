import "../components/testing/register.ts";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { FOG_SUBCELLS } from "#shared/model.ts";
import { tileKey } from "#shared/keys.ts";
import { footprintRect } from "#shared/rules/footprint.ts";
import { encodeTile, TILE_BYTES, TILE_SUB } from "#shared/rules/fog.ts";
import { room, scene, template, token } from "#shared/testutil.ts";
import { areaContext, cachedCoverage, caughtTokens } from "../features/areas/coverage.ts";
import { boardSizes } from "../lib/boardScale.ts";
import { auraClip } from "./markStand.ts";
import { FogView } from "./relief/fogView.ts";

const { auraBox } = await import("./DragMarks.tsx");
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
  const dragon = footprintRect(state.tokens.dragon!);
  assert.equal(dragon.x + dragon.w, cov.x0 + cov.w + 2, "the footprint reaches the margin's edge, so its ring's gap and stroke go past it");
  // Revealed to the margin's edge: the old box, the window and its margin, was clear.
  const fog = fogWestOf(9);
  assert.equal(auraClip(fog, { x0: cov.x0 - 2, y0: cov.y0 - 2, x1: cov.x0 + cov.w + 2, y1: cov.y0 + cov.h + 2 }), null);
  for (const scale of [12, 40, 120]) {
    const box = auraBox(cov, caught.map((id) => state.tokens[id]!), scale);
    // The ring as TokenRing draws it: its gap and its stroke's outer half, which grow with the token's ring.
    const k = boardSizes(scale).ringPx / 3;
    const outer = ((CAUGHT_RING.gapPx + CAUGHT_RING.widthPx / 2) * k) / scale;
    assert.ok(box.x1 >= dragon.x + dragon.w + outer - 1e-9 && box.y0 <= dragon.y - outer + 1e-9 && box.y1 >= dragon.y + dragon.h + outer - 1e-9, `scale ${scale}: ${JSON.stringify(box)}`);
    const clip = auraClip(fog, box);
    assert.ok(clip !== null && clip.every((r) => r.x + r.w <= 9 + 1e-9), `scale ${scale}: it clips at the fog's edge`);
  }
  // With the dragon wholly revealed, it shows whole.
  assert.equal(auraClip(fogWestOf(16), auraBox(cov, caught.map((id) => state.tokens[id]!), 40)), null);
});

test("a moving aura that catches nobody keeps its window and margin", () => {
  assert.deepEqual(auraBox({ x0: 3, y0: 4, w: 5, h: 2 }, [], 40), { x0: 1, y0: 2, x1: 10, y1: 8 });
});

test("the drag layer clips each moving aura by that box, with the creatures PlacedArea rings", () => {
  const src = readFileSync(new URL("./DragMarks.tsx", import.meta.url), "utf8");
  assert.match(src, /const caught = caughtTokens\(a, areas\.ctx, layer\.scene\.id\)\.flatMap\(\(id\) => areas\.ctx\.tokens\?\.\[id\] \?\? \[\]\);\n\s*const box = auraBox\(cachedCoverage\(a, areas\.ctx\), caught, layer\.scale\);/);
  assert.match(src, /moving=\{\{ z, clip: auraClip\(iso\.fog, box\) \}\}/);
  const layer = readFileSync(new URL("../features/areas/TemplateLayer.tsx", import.meta.url), "utf8");
  assert.match(layer, /const caught = caughtTokens\(t, ctx, props\.sceneId\);/);
  assert.match(layer, /<TokenRing key=\{id\} token=\{token\} color=\{t\.color\} scale=\{scale\} \{\.\.\.CAUGHT_RING\} \/>/);
});

