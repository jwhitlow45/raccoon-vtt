import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { FOG_SUBCELLS, type FogTile, type Token } from "#shared/model.ts";
import { tileKey } from "#shared/keys.ts";
import { encodeTile, TILE_BYTES, TILE_SUB } from "#shared/rules/fog.ts";
import { footprintRect } from "#shared/rules/footprint.ts";
import { rng, token as makeToken } from "#shared/testutil.ts";
import { revealedMask } from "../../lib/fogTiles.ts";
import { footprint, type ViewToken } from "../../lib/scene.ts";
import { FogView, type CellBox } from "./fogView.ts";
import { boxStands, creatureStands, ghostStands, lineStands, splitTokens } from "./stand.ts";

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
function randomScene(random: () => number): Scene {
  const w = 4 + Math.floor(random() * 40);
  const h = 4 + Math.floor(random() * 40);
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
  const rule = footprintRect({ ...t, x: at.x, y: at.y });
  return oracleClear(mask, { x0: at.x, y0: at.y, x1: at.x + fp.w, y1: at.y + fp.h }) && oracleClear(mask, { x0: rule.x, y0: rule.y, x1: rule.x + rule.w, y1: rule.y + rule.h });
}

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
      const { standing, flat } = splitTokens(fog, tokens, (t) => above.has(t.id));
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
        const stands = ghostStands(fog, t, at);
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

  test("everything stands for a viewer who sees all the ground: the DM, or a scene without fog", () => {
    const fog = new FogView(null, "s1", { w: 10, h: 10 });
    const t = makeToken("t", { x: 3, y: 3 }) as ViewToken;
    assert.equal(creatureStands(fog, t, false), true);
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
    assert.equal(creatureStands(fog, goblin, false), false);
    assert.equal(creatureStands(fog, goblin, true), true);
    assert.equal(creatureStands(fog, { ...goblin, x: 4 }, false), true);
    // A Large one beside it touches that sub-cell too.
    assert.equal(creatureStands(fog, makeToken("l", { x: 2, y: 2, size: "large" }) as ViewToken, false), false);
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
