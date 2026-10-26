import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { FOG_SUBCELLS, type FogTile } from "#shared/model.ts";
import { tileKey } from "#shared/keys.ts";
import { encodeTile, TILE_BYTES, TILE_SUB } from "#shared/rules/fog.ts";
import { rng } from "#shared/testutil.ts";
import { pillPlace, pillReach, type PillProps } from "../features/measure/pillPlace.ts";
import { dragTagPill } from "./dragTag.ts";
import { ghostTagStands } from "./relief/stand.ts";
import { textDrawingBox } from "../features/drawings/textBox.ts";
import { textCells } from "../features/drawings/geometry.ts";
import { revealedMask } from "../lib/fogTiles.ts";
import { auraClip, liftedClip, markStands, pillStands, tetherShows } from "./markStand.ts";
import { liftInPlane } from "./isoPlace.ts";
import type { Turn } from "../lib/view.ts";
import { FogView } from "./relief/fogView.ts";

/**
 * The stand rule for the board's marks (markStand.ts) is security
 * (docs/design-v1-isometric-view.md 5.2 and 12): a player never sees more
 * in Isometric than Top-down shows. Each test is a property over random
 * fogged scenes, against an oracle that reads the fog through the fog
 * image's own decoding (lib/fogTiles.ts revealedMask) and the mark's own
 * drawn geometry, never through the rule under test.
 */

type Scene = { id: string; bounds: { w: number; h: number }; tiles: Record<string, FogTile> };
type Mask = ReturnType<typeof revealedMask>;

/** A random fogged scene: revealed rectangles with ragged sub-cells, and a few tiles left out. */
function randomScene(random: () => number): Scene {
  const w = 4 + Math.floor(random() * 36);
  const h = 4 + Math.floor(random() * 36);
  const sw = w * FOG_SUBCELLS;
  const sh = h * FOG_SUBCELLS;
  const open = new Uint8Array(sw * sh);
  for (let i = Math.floor(random() * 8); i > 0; i--) {
    const x0 = Math.floor(random() * sw);
    const y0 = Math.floor(random() * sh);
    const x1 = Math.min(sw, x0 + 1 + Math.floor(random() * 40));
    const y1 = Math.min(sh, y0 + 1 + Math.floor(random() * 40));
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) open[y * sw + x] = 1;
  }
  for (let i = 0; i < 40; i++) open[Math.floor(random() * sh) * sw + Math.floor(random() * sw)] = random() < 0.5 ? 1 : 0;
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
      if (random() < 0.05) continue;
      tiles[tileKey("s1", tx, ty)] = { sceneId: "s1", tx, ty, rev: 1, bits: encodeTile(bits) };
    }
  }
  return { id: "s1", bounds: { w, h }, tiles };
}

function revealedAt(mask: Mask, sx: number, sy: number): boolean {
  return sx >= 0 && sy >= 0 && sx < mask.width && sy < mask.height && mask.revealed[sy * mask.width + sx] === 1;
}

/** The oracle: every sub-cell a point of the area `inside` covers, sampled densely over its box, is revealed. */
function oracleCovers(mask: Mask, box: { x0: number; y0: number; x1: number; y1: number }, inside: (x: number, y: number) => boolean = () => true): boolean {
  const n = 48;
  for (let i = 0; i <= n; i++) {
    for (let j = 0; j <= n; j++) {
      // A hair inside the box, so a point on a sub-cell line is not read on the far side.
      const x = box.x0 + (box.x1 - box.x0) * (0.0005 + (0.999 * i) / n);
      const y = box.y0 + (box.y1 - box.y0) * (0.0005 + (0.999 * j) / n);
      if (inside(x, y) && !revealedAt(mask, Math.floor(x * FOG_SUBCELLS), Math.floor(y * FOG_SUBCELLS))) return false;
    }
  }
  return true;
}

/** Fog with these cell rectangles [x0, y0, x1, y1) revealed, on a 16 by 16 scene. */
function fogOf(rects: readonly (readonly [number, number, number, number])[], sub: readonly (readonly [number, number])[] = []): FogView {
  const bits = new Uint8Array(TILE_BYTES);
  const set = (sx: number, sy: number) => {
    const i = sy * TILE_SUB + sx;
    bits[i >> 3] = bits[i >> 3]! | (1 << (i & 7));
  };
  for (const [x0, y0, x1, y1] of rects) for (let sy = y0 * FOG_SUBCELLS; sy < y1 * FOG_SUBCELLS; sy++) for (let sx = x0 * FOG_SUBCELLS; sx < x1 * FOG_SUBCELLS; sx++) set(sx, sy);
  for (const [sx, sy] of sub) set(sx, sy);
  return new FogView({ [tileKey("s1", 0, 0)]: { sceneId: "s1", tx: 0, ty: 0, rev: 1, bits: encodeTile(bits) } }, "s1", { w: 16, h: 16 });
}

/** Text widths as the node build measures them: 0.6 em a character. */
const em = (line: string) => line.length * 0.6;

describe("the stand rule for the board's marks", () => {
  test("property: an area's or a trap's name stands only where its pill, wherever the view slides it, covers revealed sub-cells alone", () => {
    const random = rng(33001);
    let stood = 0;
    let lay = 0;
    for (let round = 0; round < 60; round++) {
      const scene = randomScene(random);
      const fog = new FogView(scene.tiles, scene.id, scene.bounds);
      const mask = revealedMask(scene.bounds, scene.id, scene.tiles);
      for (let i = 0; i < 15; i++) {
        const scale = 8 + random() * 80;
        const pointed = random();
        const spec: Omit<PillProps, "color"> = {
          x: random() * scene.bounds.w,
          y: random() * scene.bounds.h,
          scale,
          name: ["Fog Cloud", "Spike Growth", "Pit", "Darkness of the Deep Hall"][i % 4]!,
          size: "map" as const,
          small: true,
          ...(pointed < 0.4 ? { above: true } : pointed < 0.8 ? { below: true, offsetPx: 12 } : {}),
        };
        if (pillStands(fog, spec)) {
          stood++;
          assert.ok(spec.above || spec.below, "a plain pill, which slides anywhere, never stands over fog");
          // Wherever the view's edge slides it, the drawn box is clear.
          for (let k = 0; k < 6; k++) {
            const vx = spec.x + (random() - 0.5) * 6;
            const vy = spec.y + (random() - 0.5) * 6;
            const view = { x0: vx - random() * 4, y0: vy - random() * 4, x1: vx + random() * 4, y1: vy + random() * 4 };
            const { box } = pillPlace(spec, k === 0 ? null : view);
            // Its outline, 1.5 px wide and centered on the edge, counts too.
            const edge = 0.75 / scale;
            assert.ok(oracleCovers(mask, { x0: box.x0 - edge, y0: box.y0 - edge, x1: box.x1 + edge, y1: box.y1 + edge }), `round ${round}: a name stood over fog`);
          }
        } else lay++;
      }
    }
    assert.ok(stood > 20 && lay > 40, `${stood} stood and ${lay} lay flat`);
  });

  test("property: a box stands exactly when every sub-cell it covers is revealed (a badge's, a text drawing's)", () => {
    const random = rng(33002);
    let stood = 0;
    let lay = 0;
    for (let round = 0; round < 60; round++) {
      const scene = randomScene(random);
      const fog = new FogView(scene.tiles, scene.id, scene.bounds);
      const mask = revealedMask(scene.bounds, scene.id, scene.tiles);
      for (let i = 0; i < 20; i++) {
        const x0 = random() * scene.bounds.w;
        const y0 = random() * scene.bounds.h;
        const box = { x0, y0, x1: x0 + 0.1 + random() * 3, y1: y0 + 0.1 + random() * 2 };
        const stands = markStands(fog, box);
        if (stands) stood++;
        else lay++;
        assert.equal(stands, oracleCovers(mask, box), `round ${round}: box ${JSON.stringify(box)}`);
      }
    }
    assert.ok(stood > 40 && lay > 40, `${stood} stood and ${lay} lay flat`);
  });

  test("property: a text drawing stands only where its lines and halo, as Top-down sets them, cover revealed sub-cells alone", () => {
    const random = rng(33003);
    let stood = 0;
    for (let round = 0; round < 60; round++) {
      const scene = randomScene(random);
      const fog = new FogView(scene.tiles, scene.id, scene.bounds);
      const mask = revealedMask(scene.bounds, scene.id, scene.tiles);
      for (let i = 0; i < 15; i++) {
        const width = 1 + Math.floor(random() * 6);
        const text = ["Door", "Gate\nNorth", "Here be gryphons", "jig"][i % 4]!;
        const d = { points: [random() * scene.bounds.w, random() * scene.bounds.h], text, style: { stroke: "#fff", width, opacity: 1 } };
        if (!markStands(fog, textDrawingBox(d, em))) continue;
        stood++;
        const size = textCells(width);
        const lines = text.split("\n");
        const w = Math.max(...lines.map(em)) * size;
        const halo = size / 28;
        const drawn = { x0: d.points[0]! - halo, y0: d.points[1]! - halo, x1: d.points[0]! + w + halo, y1: d.points[1]! + lines.length * size + halo };
        assert.ok(oracleCovers(mask, drawn), `round ${round}: a text drawing stood over fog`);
      }
    }
    assert.ok(stood > 10, `${stood} stood`);
  });

  test("security: a text drawing whose descenders reach a fogged row just under its lines lies flat", () => {
    // Revealed: cells 0 to 9 on rows 0 to 4, and nothing on row 5.
    const fog = fogOf([[0, 0, 10, 5]]);
    // Width 5 is a font 1 cell tall, set from y 3.9: its line's box ends at 4.9, inside the revealed rows, and a "g" or a "j" reaches below 5.
    const d = { points: [2, 3.9], text: "jig", style: { stroke: "#fff", width: 5, opacity: 1 } };
    assert.equal(markStands(fog, { x0: 2, y0: 3.9, x1: 2 + em("jig"), y1: 4.9 }), true, "the line's own box alone would stand");
    assert.equal(markStands(fog, textDrawingBox(d, em)), false);
    // A second line over the fogged row lies flat too, while one line alone set higher stands.
    assert.equal(markStands(fog, textDrawingBox({ ...d, points: [2, 3], text: "Gate\nNorth" }, em)), false);
    assert.equal(markStands(fog, textDrawingBox({ ...d, points: [2, 3], text: "Gate" }, em)), true);
  });

  test("property: a moving tether shows whole only over revealed sub-cells, and clipped it shows nothing over a fogged one", () => {
    const random = rng(33004);
    let whole = 0;
    let clipped = 0;
    for (let round = 0; round < 60; round++) {
      const scene = randomScene(random);
      const fog = new FogView(scene.tiles, scene.id, scene.bounds);
      const mask = revealedMask(scene.bounds, scene.id, scene.tiles);
      for (let i = 0; i < 12; i++) {
        const a = { x: random() * scene.bounds.w, y: random() * scene.bounds.h };
        const b = random() < 0.2 ? { x: a.x, y: a.y + random() * 4 } : { x: a.x + (random() - 0.5) * 10, y: a.y + (random() - 0.5) * 10 };
        const show = tetherShows(fog, a, b);
        if (show.whole) {
          whole++;
          for (let k = 0; k <= 400; k++) {
            const t = k / 400;
            const x = a.x + (b.x - a.x) * t;
            const y = a.y + (b.y - a.y) * t;
            assert.ok(revealedAt(mask, Math.floor(x * FOG_SUBCELLS), Math.floor(y * FOG_SUBCELLS)), `round ${round}: a whole tether crossed fog`);
          }
        } else {
          clipped++;
          for (const r of show.clip) assert.ok(revealedAt(mask, Math.round(r.x * FOG_SUBCELLS), Math.round(r.y * FOG_SUBCELLS)) && Math.abs(r.w * FOG_SUBCELLS - 1) < 1e-9, `round ${round}: a clip took in a fogged sub-cell`);
        }
      }
    }
    assert.ok(whole > 20 && clipped > 20, `${whole} whole and ${clipped} clipped`);
  });

  test("property: a moving aura shows whole only over revealed sub-cells, and clipped only inside revealed ones", () => {
    const random = rng(33005);
    let whole = 0;
    let clipped = 0;
    for (let round = 0; round < 60; round++) {
      const scene = randomScene(random);
      const fog = new FogView(scene.tiles, scene.id, scene.bounds);
      const mask = revealedMask(scene.bounds, scene.id, scene.tiles);
      for (let i = 0; i < 10; i++) {
        const x0 = random() * scene.bounds.w - 2;
        const y0 = random() * scene.bounds.h - 2;
        const box = { x0, y0, x1: x0 + 0.25 + random() * (random() < 0.5 ? 1 : 8), y1: y0 + 0.25 + random() * (random() < 0.5 ? 1 : 8) };
        const clip = auraClip(fog, box);
        if (clip === null) {
          whole++;
          assert.ok(oracleCovers(mask, box), `round ${round}: a whole aura covered fog`);
        } else {
          clipped++;
          for (const r of clip) assert.ok(oracleCovers(mask, { x0: r.x, y0: r.y, x1: r.x + r.w, y1: r.y + r.h }), `round ${round}: a clip took in a fogged sub-cell`);
        }
      }
    }
    assert.ok(whole > 10 && clipped > 50, `${whole} whole and ${clipped} clipped`);
  });

  test("security: a pill whose outline alone reaches a fogged sub-cell lies flat: an area's name, and a drag ghost's tag (stand.ts)", () => {
    // Revealed: columns 0 to 9 on rows 0 to 9. Column 10 is fogged.
    const fog = fogOf([[0, 0, 10, 10]]);
    const scale = 40;
    const name = { scale, name: "Spike Growth", size: "map" as const, small: true, above: true };
    // Slid so its box ends half a pixel short of column 10: the box clears, the outline's outer half does not.
    const reach = pillReach({ ...name, x: 5, y: 5 });
    const x = 5 + (10 - 0.5 / scale - reach.x1);
    assert.ok(pillReach({ ...name, x, y: 5 }).x1 < 10);
    assert.equal(pillStands(fog, { ...name, x, y: 5 }), false);
    assert.equal(pillStands(fog, { ...name, x: x - 2 / scale, y: 5 }), true);
    const ghost = { size: "medium" as const, w: 1, h: 1 };
    const tag = pillReach(dragTagPill(ghost, { x: 5, y: 5 }, "Pat", scale));
    const gx = 5 + (10 - 0.5 / scale - tag.x1);
    assert.equal(ghostTagStands(fog, ghost, { x: gx, y: 5 }, "Pat", scale), false);
    assert.equal(ghostTagStands(fog, ghost, { x: gx - 2 / scale, y: 5 }, "Pat", scale), true);
  });

  test("the DM, or a scene without fog, sees every mark whole", () => {
    const all = new FogView(null, "s1", { w: 16, h: 16 });
    assert.equal(pillStands(all, { x: 3, y: 3, scale: 40, name: "Pit", size: "map", small: true, above: true }), true);
    assert.deepEqual(tetherShows(all, { x: 1, y: 1 }, { x: 9, y: 4 }), { whole: true });
    assert.equal(auraClip(all, { x0: 0, y0: 0, x1: 20, y1: 20 }), null);
  });

  test("a tether over one fogged sub-cell clips round it, and an aura beside fog keeps only its revealed part", () => {
    // Every sub-cell of cells 0 to 9 on rows 0 to 9 but sub-cell (12, 8), inside cell 3, 2.
    const fog = fogOf([[0, 0, 3, 10], [4, 0, 10, 10], [3, 0, 4, 2], [3, 3, 4, 10]], [
      [12, 9], [13, 9], [14, 9], [15, 9], [13, 8], [14, 8], [15, 8], [12, 10], [13, 10], [14, 10], [15, 10], [12, 11], [13, 11], [14, 11], [15, 11],
    ]);
    const show = tetherShows(fog, { x: 1, y: 2.1 }, { x: 6, y: 2.1 });
    assert.equal(show.whole, false);
    assert.ok(!show.whole && show.clip.length > 0 && show.clip.every((r) => !(r.x === 3 && r.y === 2)));
    const clip = auraClip(fog, { x0: 2, y0: 1, x1: 5, y1: 4 });
    assert.ok(clip !== null && clip.every((r) => !(r.y === 2 && r.x <= 3 && r.x + r.w > 3)));
  });

  test("property: a mark drawn point by point at its drawn height (a stroke being drawn) shows whole only over revealed sub-cells on one ground, and clipped only on revealed tops, each lifted by its own ground", () => {
    const random = rng(33006);
    let whole = 0;
    let clipped = 0;
    for (let round = 0; round < 60; round++) {
      const scene = randomScene(random);
      const fog = new FogView(scene.tiles, scene.id, scene.bounds);
      const mask = revealedMask(scene.bounds, scene.id, scene.tiles);
      const turn = Math.floor(random() * 4) as Turn;
      // A raised block and a pit somewhere, so boxes cross ledges.
      const bx = Math.floor(random() * scene.bounds.w);
      const by = Math.floor(random() * scene.bounds.h);
      const ground = (x: number, y: number) => {
        const cx = Math.floor(x);
        const cy = Math.floor(y);
        return cx >= bx && cx < bx + 4 && cy >= by && cy < by + 3 ? 3 : cx === bx - 1 ? -1 : 0;
      };
      const iso = { fog, turn, ground };
      /** Every point of a box, sampled as the oracle samples, on ground `g`. */
      const onGround = (u: { x0: number; y0: number; x1: number; y1: number }, g: number) => {
        for (let k = 0; k <= 48; k++) {
          for (let j = 0; j <= 48; j++) if (ground(u.x0 + (u.x1 - u.x0) * (0.0005 + (0.999 * k) / 48), u.y0 + (u.y1 - u.y0) * (0.0005 + (0.999 * j) / 48)) !== g) return false;
        }
        return true;
      };
      for (let i = 0; i < 10; i++) {
        const x0 = random() * scene.bounds.w - 2;
        const y0 = random() * scene.bounds.h - 2;
        const box = { x0, y0, x1: x0 + 0.25 + random() * (random() < 0.5 ? 1 : 8), y1: y0 + 0.25 + random() * (random() < 0.5 ? 1 : 8) };
        const clip = liftedClip(iso, box);
        if (clip === null) {
          whole++;
          assert.ok(oracleCovers(mask, box), `round ${round}: a whole mark covered fog`);
          assert.ok(onGround(box, ground(box.x0 + 0.0005, box.y0 + 0.0005)), `round ${round}: a whole mark crossed a ledge`);
          continue;
        }
        clipped++;
        let area = 0;
        for (const r of clip) {
          area += r.w * r.h;
          // Some ground lifts it back onto cells of that ground, every sub-cell of them revealed.
          const fits = [-1, 0, 3].some((g) => {
            const d = liftInPlane(turn, g);
            const u = { x0: r.x - d.x, y0: r.y - d.y, x1: r.x - d.x + r.w, y1: r.y - d.y + r.h };
            return oracleCovers(mask, u) && onGround(u, g);
          });
          assert.ok(fits, `round ${round}: a clip piece lies on fog or on another ground: ${JSON.stringify(r)}`);
        }
        // And it keeps every revealed sub-cell the box touches.
        let open = 0;
        for (let sy = Math.floor(box.y0 * FOG_SUBCELLS); sy < Math.ceil(box.y1 * FOG_SUBCELLS); sy++) for (let sx = Math.floor(box.x0 * FOG_SUBCELLS); sx < Math.ceil(box.x1 * FOG_SUBCELLS); sx++) if (revealedAt(mask, sx, sy)) open++;
        assert.ok(Math.abs(area - open / FOG_SUBCELLS ** 2) < 1e-9, `round ${round}: ${area} of ${open} sub-cells kept`);
      }
    }
    assert.ok(whole > 10 && clipped > 50, `${whole} whole and ${clipped} clipped`);
  });

  test("a revealed box across a ledge clips anyway, each piece lifted by its own ground, and the DM's never clips", () => {
    const fog = fogOf([[0, 0, 10, 10]]);
    const ground = (x: number) => (x < 5 ? 2 : 0);
    for (const turn of [0, 1, 2, 3] as Turn[]) {
      assert.equal(liftedClip({ fog, turn, ground }, { x0: 5, y0: 1, x1: 8, y1: 3 }), null, "on one ground, it draws whole");
      const clip = liftedClip({ fog, turn, ground }, { x0: 3, y0: 1, x1: 7, y1: 2 })!;
      const up = liftInPlane(turn, 2);
      assert.deepEqual(
        clip.slice(0, 2),
        [
          { x: 3 + up.x, y: 1 + up.y, w: 2, h: 0.25 },
          { x: 5, y: 1, w: 2, h: 0.25 },
        ],
        `turn ${turn}`,
      );
      assert.equal(clip.length, 8, "two pieces on each of the four sub-rows");
      assert.equal(liftedClip({ fog: new FogView(null, "s1", { w: 16, h: 16 }), turn, ground }, { x0: 3, y0: 1, x1: 7, y1: 2 }), null);
    }
  });
});
