import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { ImageRef, ModelRef } from "#shared/model.ts";
import { sceneGrid } from "#shared/rules/grid.ts";
import type { SheetImage, Sheets } from "../../features/models/sheets.ts";
import { installPath2D, KeptRig, type RigScene } from "./keptTesting.ts";

/*
 * Creatures standing as their 3D models on the kept picture
 * (docs/design/design-v1-token-models.md 6, docs/design/design-v1-relief-pan.md
 * 10.2): the rig asks modelShown as the board does, so a model paints only
 * its frame's drawn box, inside the bounds a scroll reads, and a sheet's
 * arrival or going lays out and repaints as any layout does.
 */

installPath2D();

const boxes = (i: number): [number, number, number, number][] => Array.from({ length: 8 }, (_, f) => [10 + f, 4 + i, 60 + 4 * f, 90]);
const model = (assetId: string, i: number): ModelRef => ({ assetId, side: 2.6, anchorY: 0.8, boxes: boxes(i) });
const wearing = (assetId: string, i: number): ImageRef => ({ icon: "lorc/wolf-head", color: "#556b2f", model: model(assetId, i) });
const SHEET = { width: 2048, height: 1024 } as unknown as SheetImage;
const decoded = (...ids: string[]): Pick<Sheets, "image"> => ({ image: (id) => (ids.includes(id) ? SHEET : null) });

function scene(): RigScene {
  const ground = new Map<string, number>();
  for (let y = 0; y < 14; y++) for (let x = 0; x < 14; x++) ground.set(`${x},${y}`, (x * 5 + y * 3) % 7 === 0 ? 1 : 0);
  return { grid: sceneGrid({}), w: 14, h: 14, ground };
}

function rig(): KeptRig {
  const r = new KeptRig(scene(), { width: 140, height: 110, ratio: 2, camera: { x: 20, y: -10, scale: 9.13 }, margin: 0 });
  for (let i = 0; i < 8; i++) {
    r.standees.push({ id: `t${i}`, x: 1 + ((i * 5) % 12), y: 1 + ((i * 3) % 12), size: i === 3 ? 2 : 1, look: i, facing: 45 * i, ...(i % 2 === 0 ? { image: wearing(`m${i % 4}`, i) } : {}) });
  }
  r.commit();
  r.frame();
  return r;
}

describe("models on the kept picture", () => {
  test("a sheet's arrival and going, and pans across cull steps either side of them, draw what a whole repaint draws", () => {
    const r = rig();
    const pan = (dx: number, dy: number, what: string) => {
      const fit = r.pan(dx, dy);
      if (fit !== "inside") r.commit();
      r.frame();
      assert.deepEqual(r.canvas.diff(r.whole()), [], what);
    };
    pan(3, 1, "pictures, a pan");
    const pictures = r.whole();
    // Two sheets arrive: their wearers stand as their models, laid out again as the board's sheet news lays it out.
    r.sheets = decoded("m0", "m2");
    r.commit();
    r.frame();
    assert.deepEqual(r.canvas.diff(r.whole()), [], "on arrival");
    assert.ok(r.canvas.diff(pictures, 1).length > 0, "the wearers draw their models");
    for (const [dx, dy] of [[0, 6], [-9, 0], [4, -12], [10, 10]] as const) pan(dx, dy, `models, a pan by ${dx},${dy}`);
    // A turn shows other frames.
    r.turn = 1;
    r.commit();
    r.frame();
    assert.deepEqual(r.canvas.diff(r.whole()), [], "a turn");
    // One sheet goes past the cache: those creatures stand as pictures again.
    r.sheets = decoded("m2");
    r.commit();
    r.frame();
    assert.deepEqual(r.canvas.diff(r.whole()), [], "on going");
    pan(-6, 4, "after going");
  });

  test("a model's paint lies inside the bounds a scroll reads, though its frame reaches past its footprint", () => {
    const r = rig();
    r.sheets = decoded("m0", "m1", "m2", "m3");
    r.commit();
    r.frame();
    // Every pixel the whole draw paints for a model lies inside its standee's painted box: a scroll that skips a model outside its strips misses nothing.
    for (let step = 0; step < 6; step++) {
      const fit = r.pan(step % 2 === 0 ? 7 : -5, step < 3 ? 5 : -8);
      if (fit !== "inside") r.commit();
      r.frame();
      assert.deepEqual(r.canvas.diff(r.whole()), [], `pan ${step}`);
    }
  });

  test("a flat model's ring top, above its drawn box and its decor's frame, repaints in the strip that brings it on screen (review MODELC-O-1)", () => {
    // A long, low figure on a Gargantuan footprint, at a close zoom: its drawn box is a thin band at the base, under its ring's top.
    const flat: ModelRef = { assetId: "m-flat", side: 1.05, anchorY: 0.55, boxes: Array.from({ length: 8 }, () => [2, 48, 98, 58] as [number, number, number, number]) };
    const r = new KeptRig({ grid: sceneGrid({}), w: 12, h: 12, ground: new Map() }, { width: 300, height: 240, ratio: 2, camera: { x: 75, y: -330.26, scale: 100 }, margin: 0 });
    r.standees.push({ id: "worm", x: 4, y: 4, size: 4, look: 0, image: { icon: "lorc/wolf-head", color: "#556b2f", model: flat } });
    r.sheets = decoded("m-flat");
    r.commit();
    r.frame();
    // The ring's top lies just above the canvas: a pan down brings it into the top strip, its drawn box still off it.
    for (const dy of [5, 4, 6, -7, 3]) {
      const fit = r.pan(0, dy);
      if (fit !== "inside") r.commit();
      r.frame();
      assert.deepEqual(r.canvas.diff(r.whole()), [], `after a pan by ${dy}`);
    }
  });
});
