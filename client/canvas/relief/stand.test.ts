import assert from "node:assert/strict";
import { flatHeights } from "../../lib/view.ts";
import { describe, test } from "node:test";
import { FOG_SUBCELLS, type FogTile, type SightTile, type Token } from "#shared/model.ts";
import { tileKey } from "#shared/keys.ts";
import { encodeTile, TILE_BYTES, TILE_SUB } from "#shared/rules/fog.ts";
import { footprintRect } from "#shared/rules/footprint.ts";
import { rng, token as makeToken } from "#shared/testutil.ts";
import { revealedMask } from "../../lib/fogTiles.ts";
import { footprint, type ViewToken } from "../../lib/scene.ts";
import { FogView, type CellBox } from "./fogView.ts";
import { pillReach } from "../../features/measure/pillPlace.ts";
import { dragTagPill } from "../dragTag.ts";
import { boxStands, creatureStands, dimmedForDm, ghostStands, ghostTagStands, lineStands, splitTokens, strokeSubcells, tokenBox, tokenBoxes } from "./stand.ts";
import { withExplored } from "../../features/vision/exploredFog.ts";
import { SQUARES } from "#shared/rules/grid.ts";
import { readFileSync } from "node:fs";
import { footprintSubcells, hexAnchor, occupiedHexes, placedOnHex } from "#shared/rules/footprint.ts";
import { hexAt, hexCenter, type Hex, type HexGrid } from "#shared/rules/hex.ts";
import { snapPosition } from "../../lib/scene.ts";
import { isometric, toView } from "../../lib/view.ts";
import { standeeShape } from "./standee.ts";

/**
 * The stand rule is the isometric view's security rule
 * (docs/design-v1-isometric-view.md 5.2 and 12): whatever stands up stands
 * only where every fog sub-cell under it is revealed to that viewer, and
 * anything else lies flat under the fog. These tests check it as a
 * property over random fogged scenes, against an oracle that reads the fog
 * through the fog image's own decoding (lib/fogTiles.ts revealedMask).
 */

type Scene = { id: string; bounds: { w: number; h: number }; tiles: Record<string, FogTile> };

/** A random fogged scene: revealed rectangles, some sub-cell aligned and some ragged, and a few tiles left out or broken. */
function randomScene(random: () => number, size?: { w: number; h: number }): Scene {
  const w = size?.w ?? 4 + Math.floor(random() * 40);
  const h = size?.h ?? 4 + Math.floor(random() * 40);
  const sw = w * FOG_SUBCELLS;
  const sh = h * FOG_SUBCELLS;
  const open = new Uint8Array(sw * sh);
  const rects = Math.floor(random() * 8);
  for (let i = 0; i < rects; i++) {
    const x0 = Math.floor(random() * sw);
    const y0 = Math.floor(random() * sh);
    const x1 = Math.min(sw, x0 + 1 + Math.floor(random() * 30));
    const y1 = Math.min(sh, y0 + 1 + Math.floor(random() * 30));
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) open[y * sw + x] = 1;
  }
  // Ragged edges: single sub-cells flipped, so boxes often miss by one.
  for (let i = 0; i < 40; i++) {
    const x = Math.floor(random() * sw);
    const y = Math.floor(random() * sh);
    open[y * sw + x] = random() < 0.5 ? 1 : 0;
  }
  const tiles: Record<string, FogTile> = {};
  const id = "s1";
  for (let ty = 0; ty * TILE_SUB < sh; ty++) {
    for (let tx = 0; tx * TILE_SUB < sw; tx++) {
      const bits = new Uint8Array(TILE_BYTES);
      let any = false;
      for (let y = 0; y < TILE_SUB; y++) {
        for (let x = 0; x < TILE_SUB; x++) {
          const gx = tx * TILE_SUB + x;
          const gy = ty * TILE_SUB + y;
          // Bits past the scene's edge are set at random: the edge fogs them whatever they say.
          const on = gx < sw && gy < sh ? open[gy * sw + gx] === 1 : random() < 0.5;
          if (!on) continue;
          any = true;
          const i = y * TILE_SUB + x;
          bits[i >> 3] = bits[i >> 3]! | (1 << (i & 7));
        }
      }
      if (!any || random() < 0.05) continue;
      const tile: FogTile = { sceneId: id, tx, ty, rev: 1, bits: random() < 0.03 ? "not base64!" : encodeTile(bits) };
      tiles[tileKey(id, tx, ty)] = tile;
    }
  }
  return { id, bounds: { w, h }, tiles };
}

type Mask = ReturnType<typeof revealedMask>;

/** Whether one axis of a box touches the sub-cell span from i / k: by area, or by the point when the box has no length on it. */
function axisTouches(a: number, b: number, i: number): boolean {
  const k = FOG_SUBCELLS;
  return b > a ? a < (i + 1) / k && b > i / k : a >= i / k && a < (i + 1) / k;
}

/** The oracle: whether every sub-cell the box touches, by area or by its corner where it has no area, is revealed and on the scene. */
function oracleClear(mask: Mask, box: CellBox): boolean {
  const k = FOG_SUBCELLS;
  for (let sy = Math.floor(box.y0 * k) - 1; sy <= Math.ceil(box.y1 * k) + 1; sy++) {
    if (!axisTouches(box.y0, box.y1, sy)) continue;
    for (let sx = Math.floor(box.x0 * k) - 1; sx <= Math.ceil(box.x1 * k) + 1; sx++) {
      if (!axisTouches(box.x0, box.x1, sx)) continue;
      const inside = sx >= 0 && sy >= 0 && sx < mask.width && sy < mask.height;
      if (!inside || mask.revealed[sy * mask.width + sx] !== 1) return false;
    }
  }
  return true;
}

function randomToken(random: () => number, scene: Scene, i: number): ViewToken {
  const sizes: Token["size"][] = ["tiny", "small", "medium", "large", "huge", "gargantuan", "custom"];
  const size = sizes[Math.floor(random() * sizes.length)]!;
  const step = random() < 0.3 ? 0.25 : random() < 0.5 ? 0.5 : 1;
  const x = Math.round((random() * (scene.bounds.w + 4) - 2) / step) * step;
  const y = Math.round((random() * (scene.bounds.h + 4) - 2) / step) * step;
  const t = makeToken(`t${i}`, { size, x, y, w: 0.5 + random() * 3, h: 0.5 + random() * 3, squeeze: random() < 0.2 ? true : undefined });
  return t as ViewToken;
}

/** Both boxes a token covers in Top-down, the oracle's own way: the drawn body and the rules' footprint. */
function oracleToken(mask: Mask, t: ViewToken, at: { x: number; y: number } = t): boolean {
  const fp = footprint(t);
  const rule = footprintRect(SQUARES, { ...t, x: at.x, y: at.y });
  return oracleClear(mask, { x0: at.x, y0: at.y, x1: at.x + fp.w, y1: at.y + fp.h }) && oracleClear(mask, { x0: rule.x, y0: rule.y, x1: rule.x + rule.w, y1: rule.y + rule.h });
}

/** The rules' footprint of a token, as a box. */
function footprintBox(t: ViewToken): CellBox {
  const rule = footprintRect(SQUARES, t);
  return { x0: rule.x, y0: rule.y, x1: rule.x + rule.w, y1: rule.y + rule.h };
}

/**
 * The sub-cells Top-down's turned art covers, found by its own drawing's
 * geometry rather than by stand.ts: points across the body in its own
 * frame (a rectangle for an object, an ellipse otherwise), turned about its
 * middle as Konva turns a group, clockwise with y down.
 */
function drawnSubcells(t: ViewToken): [number, number][] {
  const fp = footprint(t);
  const a = fp.w / 2;
  const b = fp.h / 2;
  const cx = t.x + a;
  const cy = t.y + b;
  const rad = (t.rotation * Math.PI) / 180;
  const out = new Map<string, [number, number]>();
  const n = 60;
  for (let i = 0; i <= n; i++) {
    for (let j = 0; j <= n; j++) {
      const u = -a + (2 * a * i) / n;
      const v = -b + (2 * b * j) / n;
      if (t.kind !== "object" && (u / a) ** 2 + (v / b) ** 2 > 1) continue;
      // Points a hair inside the outline, so one lying on a sub-cell line is not counted on the far side.
      const x = cx + 0.999 * (u * Math.cos(rad) - v * Math.sin(rad));
      const y = cy + 0.999 * (u * Math.sin(rad) + v * Math.cos(rad));
      const sx = Math.floor(x * FOG_SUBCELLS);
      const sy = Math.floor(y * FOG_SUBCELLS);
      out.set(`${sx},${sy}`, [sx, sy]);
    }
  }
  return [...out.values()];
}

/** Fog with these cell rectangles [x0, y0, x1, y1) revealed, on a 16 by 16 scene. */
function fogOf(rects: readonly (readonly [number, number, number, number])[]): FogView {
  const bits = new Uint8Array(TILE_BYTES);
  for (const [x0, y0, x1, y1] of rects) {
    for (let sy = y0 * FOG_SUBCELLS; sy < y1 * FOG_SUBCELLS; sy++) {
      for (let sx = x0 * FOG_SUBCELLS; sx < x1 * FOG_SUBCELLS; sx++) {
        const i = sy * TILE_SUB + sx;
        bits[i >> 3] = bits[i >> 3]! | (1 << (i & 7));
      }
    }
  }
  return new FogView({ [tileKey("s1", 0, 0)]: { sceneId: "s1", tx: 0, ty: 0, rev: 1, bits: encodeTile(bits) } }, "s1", { w: 16, h: 16 });
}

/** The 3 by 3 cells around one cell revealed. */
const fog3x3 = (x: number, y: number) => fogOf([[x - 1, y - 1, x + 2, y + 2]]);

describe("the stand rule", () => {
  test("property: a creature stands only where every sub-cell under it is revealed, and every other one lies flat", () => {
    const random = rng(26105);
    let stood = 0;
    let lay = 0;
    for (let round = 0; round < 120; round++) {
      const scene = randomScene(random);
      const fog = new FogView(scene.tiles, scene.id, scene.bounds);
      const mask = revealedMask(scene.bounds, scene.id, scene.tiles);
      const tokens = Array.from({ length: 12 }, (_, i) => randomToken(random, scene, i));
      const above = new Set(tokens.filter(() => random() < 0.15).map((t) => t.id));
      const { standing, flat } = splitTokens(fog, SQUARES, tokens, (t) => above.has(t.id));
      assert.equal(standing.length + flat.length, tokens.length);
      for (const t of standing) {
        stood++;
        assert.ok(above.has(t.id) || oracleToken(mask, t), `round ${round}: ${t.id} at ${t.x}, ${t.y} (${t.size}) stood over fog`);
      }
      for (const t of flat) {
        lay++;
        assert.ok(!above.has(t.id) && !oracleToken(mask, t), `round ${round}: ${t.id} lay flat with every sub-cell revealed`);
      }
    }
    // The scenes must exercise both outcomes, or the property says nothing.
    assert.ok(stood > 100 && lay > 100, `${stood} stood and ${lay} lay flat`);
  });

  test("property: a box (a label, a pill, a name tag) stands exactly when the oracle says every sub-cell is revealed", () => {
    const random = rng(26106);
    let stood = 0;
    for (let round = 0; round < 80; round++) {
      const scene = randomScene(random);
      const fog = new FogView(scene.tiles, scene.id, scene.bounds);
      const mask = revealedMask(scene.bounds, scene.id, scene.tiles);
      for (let i = 0; i < 20; i++) {
        const x0 = random() * (scene.bounds.w + 2) - 1;
        const y0 = random() * (scene.bounds.h + 2) - 1;
        const box = { x0, y0, x1: x0 + (random() < 0.1 ? 0 : random() * 4), y1: y0 + (random() < 0.1 ? 0 : random() * 2) };
        const stands = boxStands(fog, box);
        if (stands) stood++;
        assert.equal(stands, oracleClear(mask, box), `round ${round}: ${JSON.stringify(box)}`);
      }
    }
    assert.ok(stood > 50, `${stood} boxes stood`);
  });

  test("property: a ghost stands at an eased frame only where that frame's footprint is clear, so a path across fog lies flat on its fogged frames", () => {
    const random = rng(26107);
    let flatFrames = 0;
    for (let round = 0; round < 60; round++) {
      const scene = randomScene(random);
      const fog = new FogView(scene.tiles, scene.id, scene.bounds);
      const mask = revealedMask(scene.bounds, scene.id, scene.tiles);
      const t = randomToken(random, scene, 0);
      const to = { x: random() * scene.bounds.w, y: random() * scene.bounds.h };
      for (let f = 0; f <= 20; f++) {
        const at = { x: t.x + ((to.x - t.x) * f) / 20, y: t.y + ((to.y - t.y) * f) / 20 };
        const stands = ghostStands(fog, SQUARES, t, at);
        if (!stands) flatFrames++;
        assert.equal(stands, oracleToken(mask, t, at), `round ${round} frame ${f}`);
      }
    }
    assert.ok(flatFrames > 100);
  });

  test("property: a tether's line stands only when every sub-cell it touches is revealed", () => {
    const random = rng(26108);
    let stood = 0;
    for (let round = 0; round < 80; round++) {
      const scene = randomScene(random);
      const fog = new FogView(scene.tiles, scene.id, scene.bounds);
      const mask = revealedMask(scene.bounds, scene.id, scene.tiles);
      const open = (sx: number, sy: number) => sx >= 0 && sy >= 0 && sx < mask.width && sy < mask.height && mask.revealed[sy * mask.width + sx] === 1;
      for (let i = 0; i < 10; i++) {
        // Some lines lie along sub-cell lines or pass through corners, the cases a walk can skip.
        const snapTo = random() < 0.3 ? 1 / FOG_SUBCELLS : 0;
        const pick = (v: number) => (snapTo ? Math.round(v / snapTo) * snapTo : v);
        const a = { x: pick(random() * scene.bounds.w), y: pick(random() * scene.bounds.h) };
        const b = random() < 0.2 ? { x: a.x, y: pick(random() * scene.bounds.h) } : { x: pick(a.x + random() * 6 - 3), y: pick(a.y + random() * 6 - 3) };
        if (!lineStands(fog, a, b)) continue;
        stood++;
        // Every sub-cell holding a point of the line, on its closed square, must be revealed.
        for (let s = 0; s <= 400; s++) {
          const px = (a.x + ((b.x - a.x) * s) / 400) * FOG_SUBCELLS;
          const py = (a.y + ((b.y - a.y) * s) / 400) * FOG_SUBCELLS;
          const xs = Number.isInteger(px) ? [px - 1, px] : [Math.floor(px)];
          const ys = Number.isInteger(py) ? [py - 1, py] : [Math.floor(py)];
          for (const sx of xs) for (const sy of ys) assert.ok(open(sx, sy), `round ${round}: line ${JSON.stringify([a, b])} stood over ${sx}, ${sy}`);
        }
      }
    }
    assert.ok(stood > 20, `${stood} lines stood`);
  });

  test("property: a turned token stands only where every sub-cell under its turned art is revealed", () => {
    const random = rng(26110);
    let stood = 0;
    let lay = 0;
    // Turned art reaches further, so fewer stand: more rounds give both outcomes enough cases.
    for (let round = 0; round < 500; round++) {
      const scene = randomScene(random);
      const fog = new FogView(scene.tiles, scene.id, scene.bounds);
      const mask = revealedMask(scene.bounds, scene.id, scene.tiles);
      for (let i = 0; i < 12; i++) {
        const angles = [45, 90, 135, 180, 270, 30, -60, random() * 360];
        const t = { ...randomToken(random, scene, i), rotation: angles[Math.floor(random() * angles.length)]!, kind: random() < 0.5 ? "object" : "monster" } as ViewToken;
        const stands = creatureStands(fog, SQUARES, t, false);
        if (!stands) {
          lay++;
          continue;
        }
        stood++;
        for (const [sx, sy] of drawnSubcells(t)) {
          const open = sx >= 0 && sy >= 0 && sx < mask.width && sy < mask.height && mask.revealed[sy * mask.width + sx] === 1;
          assert.ok(open, `round ${round}: ${t.id} (${t.kind}, ${t.size} ${footprint(t).w}x${footprint(t).h}, turned ${t.rotation}) stood with its art over fogged ${sx}, ${sy}`);
        }
        assert.ok(oracleClear(mask, footprintBox(t)), `round ${round}: ${t.id} stood with its footprint over fog`);
      }
    }
    assert.ok(stood > 100 && lay > 100, `${stood} stood and ${lay} lay flat`);
  });

  test("a square turned 45 degrees reaches past its cell, and a 4 by 1 turned 90 degrees stands across, not along", () => {
    const crate = makeToken("crate", { kind: "object", x: 4, y: 4, rotation: 45 }) as ViewToken;
    const cellOnly = fogOf([[4, 4, 5, 5]]);
    assert.equal(creatureStands(fog3x3(4, 4), SQUARES, crate, false), true, "with the cells around it revealed");
    assert.equal(creatureStands(cellOnly, SQUARES, crate, false), false, "its corners lie over the fogged cells around it");
    assert.equal(creatureStands(cellOnly, SQUARES, { ...crate, rotation: 0 } as ViewToken, false), true, "unturned, it fits its cell");
    // A round creature looks the same at any turn, so it still fits its cell.
    assert.equal(creatureStands(cellOnly, SQUARES, { ...crate, kind: "monster" } as ViewToken, false), true);

    const plank = makeToken("plank", { kind: "object", size: "custom", w: 4, h: 1, x: 4, y: 4, rotation: 90 }) as ViewToken;
    const along = fogOf([[4, 4, 8, 5]]);
    assert.equal(creatureStands(along, SQUARES, plank, false), false, "Top-down draws it across [5.5, 6.5] by [2.5, 6.5], mostly under fog");
    assert.equal(creatureStands(along, SQUARES, { ...plank, rotation: 0 } as ViewToken, false), true);
    const both = fogOf([[4, 4, 8, 5], [5, 2, 7, 7]]);
    assert.equal(creatureStands(both, SQUARES, plank, false), true, "with its turned art and its footprint revealed");
    assert.equal(creatureStands(fogOf([[4, 2, 8, 7]]), SQUARES, plank, false), true);
    assert.deepEqual(tokenBox(SQUARES, plank), { x0: 4, y0: 2.5, x1: 8, y1: 6.5 }, "one box around the turned art and the rules' footprint, for a flat ghost's clip");
    // A ghost turns the same way.
    assert.equal(ghostStands(along, SQUARES, plank, { x: 4, y: 4 }), false);
  });

  test("a turned rectangle's box is its turned corners', and a turned ellipse's is no wider than its art", () => {
    for (const rotation of [30, 60, 120, 200, -15]) {
      const slab = makeToken("slab", { kind: "object", size: "custom", w: 3, h: 1, x: 2, y: 5, rotation }) as ViewToken;
      const rad = (rotation * Math.PI) / 180;
      const corners = [
        [-1.5, -0.5],
        [1.5, -0.5],
        [1.5, 0.5],
        [-1.5, 0.5],
      ].map(([u, v]) => ({ x: 3.5 + u! * Math.cos(rad) - v! * Math.sin(rad), y: 5.5 + u! * Math.sin(rad) + v! * Math.cos(rad) }));
      const [body] = tokenBoxes(SQUARES, slab);
      const near = (a: number, b: number) => Math.abs(a - b) < 1e-9;
      assert.ok(near(body.x0, Math.min(...corners.map((c) => c.x))) && near(body.x1, Math.max(...corners.map((c) => c.x))), `x at ${rotation}`);
      assert.ok(near(body.y0, Math.min(...corners.map((c) => c.y))) && near(body.y1, Math.max(...corners.map((c) => c.y))), `y at ${rotation}`);
      // The same footprint as a creature draws an ellipse, inside the rectangle's box and touching it nowhere wider.
      const [oval] = tokenBoxes(SQUARES, { ...slab, kind: "monster" } as ViewToken);
      const points = Array.from({ length: 3600 }, (_, i) => {
        const t = (i / 3600) * 2 * Math.PI;
        const u = 1.5 * Math.cos(t);
        const v = 0.5 * Math.sin(t);
        return { x: 3.5 + u * Math.cos(rad) - v * Math.sin(rad), y: 5.5 + u * Math.sin(rad) + v * Math.cos(rad) };
      });
      assert.ok(Math.abs(oval.x1 - Math.max(...points.map((p) => p.x))) < 1e-5 && Math.abs(oval.y1 - Math.max(...points.map((p) => p.y))) < 1e-5, `ellipse at ${rotation}`);
    }
  });

  test("security: at low zoom a ghost's tag is judged by the whole pill Top-down draws, not by a box of two cells", () => {
    const ghost = makeToken("g", { x: 10, y: 4 }) as ViewToken;
    const at = { x: 10, y: 4 };
    // Its body and the two cells over its middle revealed, and nothing higher.
    const near = fogOf([[9, 3, 12, 5]]);
    assert.equal(ghostStands(near, SQUARES, ghost, at), true);
    const pill = pillReach(dragTagPill(ghost, at, "Dana", 12));
    assert.ok(pill.y0 < 3 && pill.y1 - pill.y0 > 1, `at 12 px a cell the pill reaches past two cells: ${JSON.stringify(pill)}`);
    assert.equal(ghostTagStands(near, ghost, at, "Dana", 12), false, "the pill's top lies over fog");
    assert.equal(ghostTagStands(fogOf([[0, 0, 16, 5]]), ghost, at, "Dana", 12), true, "with every cell it covers revealed");
    // A long name makes a wider pill, which must be clear across its whole width.
    const wide = pillReach(dragTagPill(ghost, at, "Bartholomew the Unready", 12));
    assert.ok(wide.x1 - wide.x0 > pill.x1 - pill.x0);
    assert.equal(ghostTagStands(fogOf([[Math.floor(pill.x0), 0, Math.ceil(pill.x1), 5]]), ghost, at, "Bartholomew the Unready", 12), false);
    // At a close zoom the same pill covers less of the map.
    const close = pillReach(dragTagPill(ghost, at, "Dana", 80));
    assert.ok(close.y1 - close.y0 < pill.y1 - pill.y0);
  });

  test("a turn that is not finite draws, and is judged, unturned", () => {
    const plank = makeToken("plank", { kind: "object", size: "custom", w: 4, h: 1, x: 4, y: 4, rotation: Number.NaN }) as ViewToken;
    assert.deepEqual(tokenBox(SQUARES, plank), { x0: 4, y0: 4, x1: 8, y1: 5 });
  });

  test("everything stands for a viewer who sees all the ground: the DM, or a scene without fog", () => {
    const fog = new FogView(null, "s1", { w: 10, h: 10 });
    const t = makeToken("t", { x: 3, y: 3 }) as ViewToken;
    assert.equal(creatureStands(fog, SQUARES, t, false), true);
    assert.equal(boxStands(fog, { x0: -5, y0: -5, x1: 50, y1: 50 }), true);
    assert.equal(lineStands(fog, { x: 0, y: 0 }, { x: 9, y: 9 }), true);
  });

  test("a creature with one fogged sub-cell under it lies flat, and the same creature above the fog stands", () => {
    const scene: Scene = { id: "s1", bounds: { w: 16, h: 16 }, tiles: {} };
    const bits = new Uint8Array(TILE_BYTES).fill(0xff);
    // The sub-cell at the bottom right of cell 3, 3.
    const i = (3 * FOG_SUBCELLS + 3) * TILE_SUB + (3 * FOG_SUBCELLS + 3);
    bits[i >> 3] = bits[i >> 3]! & ~(1 << (i & 7));
    scene.tiles[tileKey("s1", 0, 0)] = { sceneId: "s1", tx: 0, ty: 0, rev: 1, bits: encodeTile(bits) };
    const fog = new FogView(scene.tiles, scene.id, scene.bounds);
    const goblin = makeToken("g", { x: 3, y: 3 }) as ViewToken;
    assert.equal(creatureStands(fog, SQUARES, goblin, false), false);
    assert.equal(creatureStands(fog, SQUARES, goblin, true), true);
    assert.equal(creatureStands(fog, SQUARES, { ...goblin, x: 4 }, false), true);
    // A Large one beside it touches that sub-cell too.
    assert.equal(creatureStands(fog, SQUARES, makeToken("l", { x: 2, y: 2, size: "large" }) as ViewToken, false), false);
  });

  test("a line along a sub-cell line, a line through a corner and a box with no area each count the sub-cells on both sides", () => {
    // Revealed everywhere but the column of sub-cells just left of x = 3, and the single sub-cell left of and above 5, 5.
    const bits = new Uint8Array(TILE_BYTES).fill(0xff);
    const fogOff = (sx: number, sy: number) => {
      const i = sy * TILE_SUB + sx;
      bits[i >> 3] = bits[i >> 3]! & ~(1 << (i & 7));
    };
    for (let sy = 0; sy < TILE_SUB; sy++) fogOff(3 * FOG_SUBCELLS - 1, sy);
    fogOff(5 * FOG_SUBCELLS - 1, 5 * FOG_SUBCELLS - 1);
    const fog = new FogView({ [tileKey("s1", 0, 0)]: { sceneId: "s1", tx: 0, ty: 0, rev: 1, bits: encodeTile(bits) } }, "s1", { w: 16, h: 16 });
    assert.equal(lineStands(fog, { x: 3, y: 1 }, { x: 3, y: 4 }), false, "along the line beside the fogged column");
    assert.equal(lineStands(fog, { x: 3.25, y: 1 }, { x: 3.25, y: 4 }), true, "one sub-cell clear of it");
    assert.equal(lineStands(fog, { x: 4.5, y: 5.5 }, { x: 5.5, y: 4.5 }), false, "through the corner of the fogged sub-cell");
    assert.equal(lineStands(fog, { x: 5.5, y: 5.5 }, { x: 6.5, y: 6.5 }), true, "a line clear of both");
    assert.equal(boxStands(fog, { x0: 3, y0: 1, x1: 3, y1: 2 }), true, "a box with no width on the line counts the sub-cell its corner lies in, right of it");
    assert.equal(boxStands(fog, { x0: 2.75, y0: 1, x1: 2.75, y1: 2 }), false, "a box with no width at the fogged column's left edge");
    assert.equal(boxStands(fog, { x0: 3.5, y0: 1, x1: 3.5, y1: 2 }), true);
  });

  test("property: the DM's drawn fog, the DM's layer with the party's explored one beside it, reveals exactly what the fog image draws (D-261026-18)", () => {
    const random = rng(26118);
    for (let run = 0; run < 120; run++) {
      const dm = randomScene(random);
      const explored = randomScene(random, dm.bounds).tiles;
      const drawn = withExplored(dm.tiles, random() < 0.1 ? {} : explored) as Record<string, FogTile>;
      const fog = new FogView(drawn, dm.id, dm.bounds);
      const mask = revealedMask(dm.bounds, dm.id, drawn);
      for (let sy = 0; sy < mask.height; sy++) {
        for (let sx = 0; sx < mask.width; sx++) assert.equal(fog.revealed(sx, sy), mask.revealed[sy * mask.width + sx] === 1, `run ${run} at ${sx},${sy}`);
      }
    }
  });

  test("a view looks each tile up once, both layers, however many of its sub-cells it reads (ISO5P2-FV-3)", () => {
    const random = rng(26119);
    const dm = randomScene(random);
    const drawn = withExplored(dm.tiles, randomScene(random, dm.bounds).tiles) as Record<string, FogTile>;
    let lookups = 0;
    const counted = new Proxy(drawn, {
      get(target, key, receiver) {
        if (typeof key === "string") lookups++;
        return Reflect.get(target, key, receiver);
      },
    });
    const fog = new FogView(counted, dm.id, dm.bounds);
    const mask = revealedMask(dm.bounds, dm.id, drawn);
    for (let sy = 0; sy < mask.height; sy++) for (let sx = 0; sx < mask.width; sx++) assert.equal(fog.revealed(sx, sy), mask.revealed[sy * mask.width + sx] === 1, `at ${sx},${sy}`);
    // The tile's own layer and its explored layer, each read once.
    const tiles = Math.ceil(mask.width / TILE_SUB) * Math.ceil(mask.height / TILE_SUB);
    assert.ok(lookups <= 2 * tiles, `${lookups} lookups for ${tiles} tiles`);
  });

  test("on a per-player scene the DM's standee on ground only a player explored is not dimmed, and one on ground nobody revealed is (D-261026-18)", () => {
    const id = "s1";
    const bounds = { w: 8, h: 8 };
    const reveal = (x0: number, y0: number, x1: number, y1: number): FogTile => {
      const bits = new Uint8Array(TILE_BYTES);
      for (let y = y0 * FOG_SUBCELLS; y < y1 * FOG_SUBCELLS; y++) {
        for (let x = x0 * FOG_SUBCELLS; x < x1 * FOG_SUBCELLS; x++) {
          const i = y * TILE_SUB + x;
          bits[i >> 3] = bits[i >> 3]! | (1 << (i & 7));
        }
      }
      return { sceneId: id, tx: 0, ty: 0, rev: 1, bits: encodeTile(bits) };
    };
    // The DM revealed the room at the top left, and a player's light explored the corridor at the right, which the shared fog still hides.
    const dmLayer = { [tileKey(id, 0, 0)]: reveal(0, 0, 3, 3) };
    const explored = { [tileKey(id, 0, 0)]: reveal(5, 0, 8, 8) };
    const drawn = new FogView(withExplored(dmLayer, explored), id, bounds);
    const goblin = makeToken("g", { x: 6, y: 4 }) as ViewToken;
    const imp = makeToken("i", { x: 1, y: 1 }) as ViewToken;
    const ghoul = makeToken("h", { x: 3, y: 6 }) as ViewToken;
    assert.equal(dimmedForDm(drawn, SQUARES, goblin), false, "on explored ground: bright, as the DM's map shows it");
    assert.equal(dimmedForDm(drawn, SQUARES, imp), false, "on ground the DM revealed");
    assert.equal(dimmedForDm(drawn, SQUARES, ghoul), true, "on ground nobody revealed: dimmed");
    assert.equal(dimmedForDm(new FogView(dmLayer, id, bounds), SQUARES, goblin), true, "the shared fog alone would dim it");
    assert.equal(dimmedForDm(null, SQUARES, ghoul), false, "a scene without fog dims nothing");
  });

  test("a tile filed under another tile's key reveals nothing", () => {
    const bits = encodeTile(new Uint8Array(TILE_BYTES).fill(0xff));
    const tiles = { [tileKey("s1", 0, 0)]: { sceneId: "s1", tx: 1, ty: 0, rev: 1, bits } };
    const fog = new FogView(tiles, "s1", { w: 40, h: 40 });
    assert.equal(fog.cellSeen(2, 2), false);
    assert.equal(fog.cellSeen(18, 2), false);
  });

  test("revealedRects covers exactly the revealed sub-cells a box touches", () => {
    const random = rng(26109);
    for (let round = 0; round < 40; round++) {
      const scene = randomScene(random);
      const fog = new FogView(scene.tiles, scene.id, scene.bounds);
      const mask = revealedMask(scene.bounds, scene.id, scene.tiles);
      const x0 = random() * scene.bounds.w;
      const y0 = random() * scene.bounds.h;
      const box = { x0, y0, x1: x0 + random() * 5, y1: y0 + random() * 3 };
      const covered = new Set<string>();
      for (const r of fog.revealedRects(box)) {
        for (let sy = Math.round(r.y * FOG_SUBCELLS); sy < Math.round((r.y + r.h) * FOG_SUBCELLS); sy++) {
          for (let sx = Math.round(r.x * FOG_SUBCELLS); sx < Math.round((r.x + r.w) * FOG_SUBCELLS); sx++) {
            assert.equal(mask.revealed[sy * mask.width + sx], 1, `round ${round}: a rect over fogged ${sx}, ${sy}`);
            covered.add(`${sx},${sy}`);
          }
        }
      }
      for (let sy = Math.floor(box.y0 * FOG_SUBCELLS); sy < Math.ceil(box.y1 * FOG_SUBCELLS); sy++) {
        for (let sx = Math.floor(box.x0 * FOG_SUBCELLS); sx < Math.ceil(box.x1 * FOG_SUBCELLS); sx++) {
          if (sx < mask.width && sy < mask.height && mask.revealed[sy * mask.width + sx] === 1) assert.ok(covered.has(`${sx},${sy}`), `round ${round}: revealed ${sx}, ${sy} left out`);
        }
      }
    }
  });
});

describe("the stand rule on a hex scene (hex grids 4.2, ISOREB-OPUS-01)", () => {
  /** The sub-cells a hex holds, found from nothing: every sub-cell whose center hexAt puts in it, in a window round its center. */
  function subcellsOf(g: HexGrid, h: Hex): [number, number][] {
    const c = hexCenter(g, h);
    const k = FOG_SUBCELLS;
    const out: [number, number][] = [];
    for (let sy = Math.floor((c.y - 1) * k); sy <= Math.ceil((c.y + 1) * k); sy++) {
      for (let sx = Math.floor((c.x - 1) * k); sx <= Math.ceil((c.x + 1) * k); sx++) {
        const at = hexAt(g, { x: (sx + 0.5) / k, y: (sy + 0.5) / k });
        if (at.col === h.col && at.row === h.row) out.push([sx, sy]);
      }
    }
    return out;
  }

  /** A creature on a hex scene: of any size, snapped to its anchor as the board drops it, or left where a shape switch left it. */
  function hexToken(random: () => number, g: HexGrid, scene: Scene, i: number): ViewToken {
    const sizes = ["tiny", "small", "medium", "large", "huge", "gargantuan", "custom"] as const;
    const size = sizes[Math.floor(random() * sizes.length)]!;
    const t = makeToken(`h${i}`, { size, x: random() * (scene.bounds.w + 2) - 1, y: random() * (scene.bounds.h + 2) - 1, w: 0.5 + random() * 3, h: 0.5 + random() * 3 }) as ViewToken;
    if (random() < 0.7) Object.assign(t, snapPosition(g, t.x, t.y, footprint(t)));
    return t;
  }

  /** A scene mostly revealed, with fogged rectangles and single sub-cells flipped, so creatures stand often and miss by one sub-cell often. */
  function openScene(random: () => number, bounds: { w: number; h: number }): Scene {
    const sw = bounds.w * FOG_SUBCELLS;
    const sh = bounds.h * FOG_SUBCELLS;
    const open = new Uint8Array(sw * sh).fill(1);
    for (let i = Math.floor(random() * 10); i > 0; i--) {
      const x0 = Math.floor(random() * sw);
      const y0 = Math.floor(random() * sh);
      const x1 = Math.min(sw, x0 + 1 + Math.floor(random() * 16));
      const y1 = Math.min(sh, y0 + 1 + Math.floor(random() * 16));
      for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) open[y * sw + x] = 0;
    }
    for (let i = 0; i < 60; i++) open[Math.floor(random() * sh) * sw + Math.floor(random() * sw)] = 0;
    const tiles: Record<string, FogTile> = {};
    for (let ty = 0; ty * TILE_SUB < sh; ty++) {
      for (let tx = 0; tx * TILE_SUB < sw; tx++) {
        const bits = new Uint8Array(TILE_BYTES);
        for (let y = 0; y < TILE_SUB; y++) {
          for (let x = 0; x < TILE_SUB; x++) {
            const gx = tx * TILE_SUB + x;
            const gy = ty * TILE_SUB + y;
            if (gx >= sw || gy >= sh || open[gy * sw + gx] !== 1) continue;
            const i = y * TILE_SUB + x;
            bits[i >> 3] = bits[i >> 3]! | (1 << (i & 7));
          }
        }
        tiles[tileKey("s1", tx, ty)] = { sceneId: "s1", tx, ty, rev: 1, bits: encodeTile(bits) };
      }
    }
    return { id: "s1", bounds, tiles };
  }

  test("a standee stands only where every sub-cell of the hexes Top-down outlines, and of its drawn box, is revealed: the party's fog and a player's own alike", () => {
    const random = rng(26116);
    let stood = 0;
    let lay = 0;
    let pointsOnly = 0;
    for (const orient of ["rows", "columns"] as const) {
      const g: HexGrid = { shape: "hex", orient };
      for (let round = 0; round < 60; round++) {
        const bounds = { w: 6 + Math.floor(random() * 20), h: 6 + Math.floor(random() * 20) };
        const party = openScene(random, bounds);
        // Per-player vision: the same scene under one player's own fog, which reveals other ground.
        const own = openScene(random, bounds);
        for (const scene of [party, own]) {
          const fog = new FogView(scene.tiles, scene.id, scene.bounds);
          const mask = revealedMask(scene.bounds, scene.id, scene.tiles);
          const open = ([sx, sy]: [number, number]) => sx >= 0 && sy >= 0 && sx < mask.width && sy < mask.height && mask.revealed[sy * mask.width + sx] === 1;
          const tokens = Array.from({ length: 10 }, (_, i) => hexToken(random, g, scene, i));
          const { standing } = splitTokens(fog, g, tokens, () => false);
          for (const t of tokens) {
            const fp = footprint(t);
            // The hexes Top-down outlines and the server's footprint test reads (footprint.ts occupiedHexes).
            const hexes = occupiedHexes(g, t).flatMap((h) => subcellsOf(g, h));
            const body = oracleClear(mask, { x0: t.x, y0: t.y, x1: t.x + fp.w, y1: t.y + fp.h });
            const expected = body && hexes.every(open);
            if (body && !expected) pointsOnly++;
            assert.equal(creatureStands(fog, g, t, false), expected, `${orient} round ${round}: ${t.id} ${t.size} at ${t.x},${t.y}`);
            assert.equal(standing.includes(t), expected);
            if (expected) stood++;
            else lay++;
            // A ghost of it, anywhere a drag eases it, by the same reading.
            const at = { x: random() * scene.bounds.w, y: random() * scene.bounds.h };
            const ghostHexes = occupiedHexes(g, { ...t, x: at.x, y: at.y }).flatMap((h) => subcellsOf(g, h));
            assert.equal(ghostStands(fog, g, t, at), oracleClear(mask, { x0: at.x, y0: at.y, x1: at.x + fp.w, y1: at.y + fp.h }) && ghostHexes.every(open));
            // A standee's ring stands where Top-down's hexes are: on the anchor, its box's middle.
            if (t.size !== "custom") {
              const shape = standeeShape(0, { x: t.x, y: t.y, w: fp.w, h: fp.h }, 0, 0, 40, 900);
              const ring = toView(isometric(0), hexAnchor(g, t), 0);
              const snapped = snapPosition(g, t.x, t.y, fp);
              if (snapped.x === t.x && snapped.y === t.y) assert.ok(Math.abs(shape.base.x - ring.x) < 1e-9 && Math.abs(shape.base.y - ring.y) < 1e-9, `${t.id}'s ring on its anchor`);
            }
          }
        }
      }
    }
    assert.ok(stood > 100 && lay > 100, `${stood} stood and ${lay} lay flat`);
    // Creatures whose drawn box is clear but a point of a hex is fogged: a box alone would have stood them.
    assert.ok(pointsOnly > 10, `${pointsOnly} lay flat by a hex's point alone`);
  });

  test("the DM's dimming and a flat ghost's clip read the hexes too", () => {
    const g: HexGrid = { shape: "hex", orient: "rows" };
    // A Tiny creature takes a whole hex, which reaches past its half-cell box.
    const goblin = makeToken("g", { size: "tiny", ...placedOnHex(g, { size: "tiny", x: 0, y: 0 }, { col: 5, row: 5 }) }) as ViewToken;
    const mid = hexCenter(g, { col: 5, row: 5 });
    // Only a sub-cell at the hex's west side revealed, outside the drawn box.
    const sub: [number, number] = [Math.floor((mid.x - 0.375) * FOG_SUBCELLS), Math.floor(mid.y * FOG_SUBCELLS)];
    const bits = new Uint8Array(TILE_BYTES);
    const i = sub[1] * TILE_SUB + sub[0];
    bits[i >> 3] = bits[i >> 3]! | (1 << (i & 7));
    const fog = new FogView({ [tileKey("s1", 0, 0)]: { sceneId: "s1", tx: 0, ty: 0, rev: 1, bits: encodeTile(bits) } }, "s1", { w: 16, h: 16 });
    assert.ok(footprintSubcells(g, goblin).some(([sx, sy]) => sx === sub[0] && sy === sub[1]), "the point is the goblin's");
    assert.equal(dimmedForDm(fog, g, goblin), false, "a revealed point of its hex keeps it bright");
    assert.equal(dimmedForDm(fog, SQUARES, goblin), true, "on squares nothing under it is revealed");
    const box = tokenBox(g, goblin);
    assert.ok(box.x0 <= sub[0] / FOG_SUBCELLS && box.x0 < goblin.x, "the clip's box reaches the hex's sub-cells past the drawn box");
    // A sub-cell in the box round its hex but outside the hex and its drawn body: the server withholds the goblin, so the DM's standee dims.
    const own = new Set(footprintSubcells(g, goblin).map(([sx, sy]) => `${sx},${sy}`));
    const [body] = tokenBoxes(g, goblin);
    let corner: [number, number] | null = null;
    for (let sy = Math.round(box.y0 * FOG_SUBCELLS); sy < Math.round(box.y1 * FOG_SUBCELLS) && !corner; sy++) {
      for (let sx = Math.round(box.x0 * FOG_SUBCELLS); sx < Math.round(box.x1 * FOG_SUBCELLS) && !corner; sx++) {
        const inBody = (sx + 0.5) / FOG_SUBCELLS > body.x0 && (sx + 0.5) / FOG_SUBCELLS < body.x1 && (sy + 0.5) / FOG_SUBCELLS > body.y0 && (sy + 0.5) / FOG_SUBCELLS < body.y1;
        if (!own.has(`${sx},${sy}`) && !inBody) corner = [sx, sy];
      }
    }
    assert.ok(corner, "the box round a hex holds sub-cells of its neighbors");
    const near = new Uint8Array(TILE_BYTES);
    const j = corner[1] * TILE_SUB + corner[0];
    near[j >> 3] = near[j >> 3]! | (1 << (j & 7));
    const outside = new FogView({ [tileKey("s1", 0, 0)]: { sceneId: "s1", tx: 0, ty: 0, rev: 1, bits: encodeTile(near) } }, "s1", { w: 16, h: 16 });
    assert.ok(!footprintSubcells(g, goblin).some(([sx, sy]) => sx === corner[0] && sy === corner[1]), "the point is not the goblin's");
    assert.ok(outside.boxAny(box), "and lies in the box round its hex");
    assert.equal(dimmedForDm(outside, g, goblin), true, "a revealed point beside its hex keeps it dimmed");
    // A snapped Medium's drawn body reaches past its hex at the corners: a sub-cell revealed there alone, the server withholds it, so it dims (HX3-VIEW-01).
    const medium = makeToken("m", { size: "medium", ...placedOnHex(g, { size: "medium", x: 0, y: 0 }, { col: 8, row: 8 }) }) as ViewToken;
    const mine = new Set(footprintSubcells(g, medium).map(([sx, sy]) => `${sx},${sy}`));
    const nook: [number, number] = [Math.floor(medium.x * FOG_SUBCELLS), Math.floor(medium.y * FOG_SUBCELLS)];
    assert.ok(!mine.has(`${nook[0]},${nook[1]}`), "the body's corner sub-cell is not its hex's");
    const corner2 = new Uint8Array(TILE_BYTES);
    const k = nook[1] * TILE_SUB + nook[0];
    corner2[k >> 3] = corner2[k >> 3]! | (1 << (k & 7));
    const bodyCorner = new FogView({ [tileKey("s1", 0, 0)]: { sceneId: "s1", tx: 0, ty: 0, rev: 1, bits: encodeTile(corner2) } }, "s1", { w: 16, h: 16 });
    assert.ok(bodyCorner.boxAny(tokenBoxes(g, medium)[0]), "the body holds the revealed sub-cell");
    assert.equal(dimmedForDm(bodyCorner, g, medium), true, "dimmed, as players are withheld it");
  });

  test("no footprint read of the isometric view passes squares (ISOREB-OPUS-01)", () => {
    for (const file of ["../DragMarks.tsx", "../boardPick.ts", "../isoDrag.ts", "./IsoBoard.tsx", "./stand.ts"]) {
      const src = readFileSync(new URL(file, import.meta.url), "utf8");
      assert.doesNotMatch(src, /\bSQUARES\b/, `${file} reads every footprint on the scene's grid`);
    }
  });
});

// ---------------------------------------------------------------- areas standing as their real shapes

const { resolveArea } = await import("#shared/rules/aoe.ts");
const { buildVolume } = await import("../../features/areas/volume.ts");
const { ctxOf } = await import("../../features/areas/volumeTesting.ts");
const { deviceGround } = await import("#shared/rules/held.ts");
const { fogRoom, lift } = await import("#shared/discoveryTestutil.ts");
const { ringsAtBase, VolumeStand, volumeStands } = await import("./stand.ts");
const { wholeVolume } = await import("./volumes.ts");

/** A player's fog over a 32 cell scene: these cell rectangles [x0, y0, x1, y1) revealed, and these sub-cells [sx, sy] fogged again. */
function areaFog(rects: readonly (readonly [number, number, number, number])[], fogged: readonly (readonly [number, number])[] = []): { tiles: Record<string, FogTile>; view: FogView } {
  const bounds = { w: 32, h: 32 };
  const tiles: Record<string, FogTile> = {};
  for (let ty = 0; ty * 16 < bounds.h; ty++) {
    for (let tx = 0; tx * 16 < bounds.w; tx++) {
      const bits = new Uint8Array(TILE_BYTES);
      const set = (sx: number, sy: number, on: boolean) => {
        if (sx < tx * TILE_SUB || sy < ty * TILE_SUB || sx >= (tx + 1) * TILE_SUB || sy >= (ty + 1) * TILE_SUB) return;
        const i = (sy - ty * TILE_SUB) * TILE_SUB + (sx - tx * TILE_SUB);
        bits[i >> 3] = on ? bits[i >> 3]! | (1 << (i & 7)) : bits[i >> 3]! & ~(1 << (i & 7));
      };
      for (const [x0, y0, x1, y1] of rects) for (let sy = y0 * FOG_SUBCELLS; sy < y1 * FOG_SUBCELLS; sy++) for (let sx = x0 * FOG_SUBCELLS; sx < x1 * FOG_SUBCELLS; sx++) set(sx, sy, true);
      for (const [sx, sy] of fogged) set(sx, sy, false);
      tiles[tileKey("s1", tx, ty)] = { sceneId: "s1", tx, ty, rev: 1, bits: encodeTile(bits) };
    }
  }
  return { tiles, view: new FogView(tiles, "s1", bounds) };
}

/** A 20 ft sphere at 10, 10, 10 ft up, over this drawn ground. */
function sphereAt(ground: (x: number, y: number) => number = () => 0, x = 10, y = 10) {
  const bounds = { w: 32, h: 32 };
  const area = resolveArea({ id: "s", rev: 1, shape: "sphere", size: 20, origin: { x, y, z: 10 }, yaw: 0, includeOrigin: true }, ctxOf(bounds, null));
  assert.ok(area);
  return buildVolume({ area, bounds, ground, px: 40 });
}

describe("an area stands as its real shape only over a player's live ground (docs/design-v1-iso-area-shapes.md 4.4 and 9, D-261027-06)", () => {
  test("everything stands for a viewer who sees all the ground, and over wholly revealed live ground", () => {
    const vol = sphereAt();
    assert.ok(volumeStands(new FogView(null, "s1", { w: 32, h: 32 }), null, vol.footprint));
    assert.ok(volumeStands(areaFog([[0, 0, 32, 32]]).view, null, vol.footprint));
    assert.ok(vol.footprint.count > 500);
  });

  test("security: one fogged sub-cell under its plan lays it flat, wherever that is, under a column that hides the solid too", () => {
    // A column 30 ft tall at 12, 10, inside the plan, hiding the sphere's part over it.
    const column = (x: number, y: number) => (x === 12 && y === 10 ? 6 : 0);
    const vol = sphereAt(column);
    const runs = vol.footprint.runs;
    let tried = 0;
    for (let r = 0; r < runs.length; r += 3 * 3) {
      for (const sx of [runs[r + 1]!, runs[r + 2]! - 1]) {
        assert.equal(volumeStands(areaFog([[0, 0, 32, 32]], [[sx, runs[r]!]]).view, null, vol.footprint), false, `sub-cell ${sx}, ${runs[r]}`);
        tried++;
      }
    }
    assert.ok(tried > 10);
    assert.equal(volumeStands(areaFog([[0, 0, 32, 32]], [[12 * 4 + 1, 10 * 4 + 2]]).view, null, vol.footprint), false, "under the column");
    // One fogged just past its plan leaves it standing.
    assert.ok(volumeStands(areaFog([[0, 0, 32, 32]], [[0, 0]]).view, null, vol.footprint));
  });

  /** A player's device on an Explore scene: the DM revealed `held`, and the party sees `seen` now, cell rectangles. */
  function device(held: readonly [number, number, number, number][], seen: readonly [number, number, number, number][]) {
    const state = fogRoom({ vision: true, bounds: { w: 32, h: 32 } });
    for (const [x0, y0, x1, y1] of held) lift(state, "dm", { x: x0, y: y0, w: x1 - x0, h: y1 - y0 });
    const sight: Record<string, SightTile> = {};
    for (let ty = 0; ty < 2; ty++) {
      for (let tx = 0; tx < 2; tx++) {
        const packed = new Uint8Array((TILE_SUB * TILE_SUB) / 4);
        for (const [x0, y0, x1, y1] of seen) {
          for (let sy = Math.max(y0 * FOG_SUBCELLS, ty * TILE_SUB); sy < Math.min(y1 * FOG_SUBCELLS, (ty + 1) * TILE_SUB); sy++) {
            for (let sx = Math.max(x0 * FOG_SUBCELLS, tx * TILE_SUB); sx < Math.min(x1 * FOG_SUBCELLS, (tx + 1) * TILE_SUB); sx++) {
              const i = (sy - ty * TILE_SUB) * TILE_SUB + (sx - tx * TILE_SUB);
              packed[i >> 2] = packed[i >> 2]! | (1 << ((i & 3) << 1));
            }
          }
        }
        sight[tileKey("s1", tx, ty)] = { b: Buffer.from(packed).toString("base64") };
      }
    }
    const live = deviceGround({ ...state, sight } as never, "s1");
    assert.ok(live);
    return { fog: new FogView(state.fogTiles, "s1", { w: 32, h: 32 }), live };
  }

  test("security: over ground the player only remembers, revealed but out of sight, it lies flat; in sight it stands", () => {
    const vol = sphereAt();
    const remembered = device([[0, 0, 32, 32]], [[0, 0, 8, 32]]);
    assert.equal(volumeStands(remembered.fog, remembered.live, vol.footprint), false);
    const seen = device([[0, 0, 32, 32]], [[0, 0, 20, 20]]);
    assert.equal(volumeStands(seen.fog, seen.live, vol.footprint), true);
  });

  test("security: the same rooms differing only in remembered ground give the same stand decision", () => {
    const random = rng(71);
    let stood = 0;
    let flat = 0;
    for (let i = 0; i < 60; i++) {
      const r = () => Math.floor(random() * 24);
      const seen: [number, number, number, number][] = Array.from({ length: 1 + Math.floor(random() * 2) }, () => {
        const [x, y] = [r(), r()];
        return [x, y, Math.min(32, x + 6 + r()), Math.min(32, y + 6 + r())];
      });
      // The seen ground is held in both rooms. Past it, one room remembers more than the other.
      const more: [number, number, number, number] = [r(), r(), 32, 32];
      const a = device(seen, seen);
      const b = device([...seen, more], seen);
      const vol = sphereAt(() => 0, 4 + random() * 24, 4 + random() * 24);
      const sa = volumeStands(a.fog, a.live, vol.footprint);
      assert.equal(volumeStands(b.fog, b.live, vol.footprint), sa, `#${i}`);
      if (sa) stood++;
      else flat++;
    }
    assert.ok(stood > 3 && flat > 3, `${stood} stood, ${flat} flat`);
  });

  test("the test runs in slices on a large footprint, and ends as it does at once", () => {
    const bounds = { w: 32, h: 32 };
    const area = resolveArea({ id: "s", rev: 1, shape: "sphere", size: 75, origin: { x: 16, y: 16, z: 0 }, yaw: 0, includeOrigin: true }, ctxOf(bounds, null));
    assert.ok(area);
    const vol = buildVolume({ area, bounds, ground: () => 0, px: 40 });
    // The last sub-cell it reads, so a stop that lost its place would miss it.
    const runs = vol.footprint.runs;
    const last: [number, number] = [runs[runs.length - 1]! - 1, runs[runs.length - 3]!];
    assert.ok(vol.footprint.count > 2 * 4096, `${vol.footprint.count} sub-cells`);
    for (const [fog, want] of [
      [areaFog([[0, 0, 32, 32]]).view, true],
      [areaFog([[0, 0, 32, 32]], [last]).view, false],
    ] as const) {
      const test = new VolumeStand(fog, null, vol.footprint);
      let calls = 0;
      while (test.run(-Infinity) === null) calls++;
      assert.equal(test.result, want);
      assert.ok(calls >= 2, `${calls} slices`);
    }
  });

  test("security: a moving aura entering fog is today's flat mark: its volume does not stand", () => {
    const tokens = { t: { id: "t", sceneId: "s1", x: 6, y: 6, size: "medium", elevation: 0 } };
    const bounds = { w: 32, h: 32 };
    const aura = { id: "a", rev: 1, shape: "emanation" as const, size: 10, origin: { x: 6.5, y: 6.5, z: 0 }, yaw: 0, includeOrigin: false, attachedTo: "t" };
    const ctx = ctxOf(bounds, null, tokens as never);
    const look = { color: "#e5484d", dm: false, selected: false, preview: false };
    const clear = areaFog([[0, 0, 32, 32]]);
    const world = (fog: FogView, tiles: unknown) => ({ heights: flatHeights(bounds), tiles, px: 40, fog, live: null });
    assert.ok(wholeVolume({ template: aura, ctx, banded: true }, "a", look, 0, world(clear.view, clear.tiles), Infinity).pieces?.length, "over revealed ground it stands");
    const edge = areaFog([[0, 0, 32, 32]], [[4 * 4, 6 * 4]]);
    assert.deepEqual(wholeVolume({ template: aura, ctx, banded: true }, "a", look, 0, world(edge.view, edge.tiles), Infinity), { pieces: null, more: false });
  });
});

describe("a caught creature's ring at its standee's base (D-261026-31, design 4.4)", () => {
  const grid = SQUARES;
  const flier = (id: string, x: number, y: number) => makeToken(id, { kind: "monster", x, y, elevation: 20, sceneId: "s1" }) as ViewToken;

  test("a standing flier's ring goes to its base, a flat creature's and every ring of an area lying flat stay on the ground", () => {
    const fog = areaFog([[0, 0, 16, 32]]).view;
    const tokens = new Map([
      ["up", flier("up", 4, 4)],
      ["fogged", flier("fogged", 20, 4)],
    ]);
    const { byToken, pairs } = ringsAtBase([{ id: "sphere", color: "#3fa7ff", caught: ["up", "fogged"] }], tokens, fog, grid);
    assert.deepEqual([...byToken], [["up", ["#3fa7ff"]]]);
    assert.deepEqual([...pairs], ["sphere|up"]);
    // An area lying flat is not among those passed: none of its rings leave the ground.
    assert.equal(ringsAtBase([], tokens, fog, grid).pairs.size, 0);
  });

  test("security: a flier partly over fog, standing only by drawsAboveFog, keeps its ring on the ground under the fog, as Top-down", () => {
    // Its footprint crosses the fog's edge at x = 16.
    const fog = areaFog([[0, 0, 16, 32]]).view;
    const party = flier("party", 15.5, 4);
    assert.ok(creatureStands(fog, grid, party, true), "a party member stands above the fog");
    assert.equal(creatureStands(fog, grid, party, false), false);
    const { pairs } = ringsAtBase([{ id: "sphere", color: "#3fa7ff", caught: ["party"] }], new Map([["party", party]]), fog, grid);
    assert.equal(pairs.size, 0);
  });

  test("one creature in two standing areas wears both rings, in the areas' order", () => {
    const fog = new FogView(null, "s1", { w: 32, h: 32 });
    const { byToken } = ringsAtBase(
      [
        { id: "a", color: "#111111", caught: ["x"] },
        { id: "b", color: "#222222", caught: ["x"] },
      ],
      new Map([["x", flier("x", 2, 2)]]),
      fog,
      grid,
    );
    assert.deepEqual(byToken.get("x"), ["#111111", "#222222"]);
  });
});


test("ISO34-TETHER-COST: a long thin diagonal checks a stroke band, not its bounding rectangle", () => {
  for (const length of [50, 100, 200]) {
    let visits = 0;
    const checked = strokeSubcells({ x: -length / 2, y: -length / 2 }, { x: length / 2, y: length / 2 }, 0.08, () => { visits++; return true; });
    assert.ok(checked <= 32 * length + 32, `${length} cells: ${checked} candidates exceeds the stroke-band bound`);
    assert.ok(visits > 4 * length, "the full diagonal must be visited");
  }
});


type StrokePoint = { x: number; y: number };

// The original exhaustive scan is the oracle for the row-band optimization.
function exhaustiveStroke(a: StrokePoint, b: StrokePoint, r: number, visit: (sx: number, sy: number) => boolean): void {
  const k = FOG_SUBCELLS;
  const s = 1 / k;
  // Float slack, so a square the stroke's edge touches is never missed.
  const near = Math.max(0, r) + 1e-9;
  const x0 = Math.floor((Math.min(a.x, b.x) - near) * k) - 1;
  const x1 = Math.floor((Math.max(a.x, b.x) + near) * k);
  const y0 = Math.floor((Math.min(a.y, b.y) - near) * k) - 1;
  const y1 = Math.floor((Math.max(a.y, b.y) + near) * k);
  for (let sy = y0; sy <= y1; sy++) {
    for (let sx = x0; sx <= x1; sx++) if (squareGap(a, b, sx * s, sy * s, s) <= near && !visit(sx, sy)) return;
  }
}

/** The distance from the segment a to b to the closed square at x, y of side s: 0 where they meet. */
function squareGap(a: StrokePoint, b: StrokePoint, x: number, y: number, s: number): number {
  if (segmentMeetsBox(a, b, x, y, x + s, y + s)) return 0;
  let d = Math.min(boxGap(a, x, y, s), boxGap(b, x, y, s));
  for (const c of [{ x, y }, { x: x + s, y }, { x, y: y + s }, { x: x + s, y: y + s }]) d = Math.min(d, segmentGap(c, a, b));
  return d;
}

/** Whether the segment meets the closed box: Liang and Barsky's clip, which keeps a part of it. */
function segmentMeetsBox(a: StrokePoint, b: StrokePoint, x0: number, y0: number, x1: number, y1: number): boolean {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  let lo = 0;
  let hi = 1;
  for (const [p, q] of [[-dx, a.x - x0], [dx, x1 - a.x], [-dy, a.y - y0], [dy, y1 - a.y]] as const) {
    if (p === 0) {
      if (q < 0) return false;
      continue;
    }
    const t = q / p;
    if (p < 0) lo = Math.max(lo, t);
    else hi = Math.min(hi, t);
    if (lo > hi) return false;
  }
  return true;
}

function boxGap(p: StrokePoint, x: number, y: number, s: number): number {
  return Math.hypot(Math.max(x - p.x, 0, p.x - x - s), Math.max(y - p.y, 0, p.y - y - s));
}

function segmentGap(p: StrokePoint, a: StrokePoint, b: StrokePoint): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2));
  return Math.hypot(p.x - a.x - t * dx, p.y - a.y - t * dy);
}

test("ISO34-TETHER-COST: band enumeration matches exhaustive closed-square coverage and early exits", () => {
  const random = rng(4034);
  const cases: [StrokePoint, StrokePoint, number][] = [
    [{ x: 0, y: 0 }, { x: 3, y: 3 }, 0],
    [{ x: -1, y: 0.25 }, { x: 2, y: 0.25 }, 0],
    [{ x: 0, y: -3 }, { x: 0, y: 2 }, 0.25],
    [{ x: -0.25, y: -0.25 }, { x: -0.25, y: -0.25 }, 0],
    [{ x: -0.25, y: -0.25 }, { x: -0.25, y: -0.25 }, 0.5],
  ];
  for (let i = 0; i < 300; i++) cases.push([
    { x: random() * 12 - 6, y: random() * 12 - 6 },
    { x: random() * 12 - 6, y: random() * 12 - 6 },
    i % 3 === 0 ? 0 : random(),
  ]);
  for (const [a, b, r] of cases) {
    const want: string[] = [];
    exhaustiveStroke(a, b, r, (x, y) => { want.push(`${x},${y}`); return true; });
    const got: string[] = [];
    const checked = strokeSubcells(a, b, r, (x, y) => { got.push(`${x},${y}`); return true; });
    assert.deepEqual(got, want, JSON.stringify([a, b, r]));
    const stop = Math.min(3, want.length);
    const first: string[] = [];
    const early = strokeSubcells(a, b, r, (x, y) => { first.push(`${x},${y}`); return first.length < stop; });
    assert.deepEqual(first, want.slice(0, stop));
    assert.ok(early <= checked);
  }
});
