import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { ImportPlan, Summary } from "./convert.ts";
import { foundLine, imageNote, notes, shapeNote, sizeText, summaryLight } from "./summary.ts";
import { lightsLead, startingLight } from "../vision/uvttLight.ts";
import { readUvtt } from "./schema.ts";
import { planScene } from "./steps.ts";
import { uvttFile } from "./synthetic.ts";
import type { ReadInfo } from "./messages.ts";

const NONE: Summary = { gridWalls: 0, freeWalls: 0, doors: 0, windows: 0, lights: 0, lightsLeftOut: 0, lightsFarOutside: 0, lightsMoved: 0, welded: 0, clipped: 0, tolerance: 0.05 };

describe("the summary sheet", () => {
  test("FU38-B: lights follow the successful retry after object walls refused the first conversion", () => {
    const objects = Array.from({ length: 4001 }, (_, i) => {
      const x = (i % 100) * 1.5;
      const y = Math.floor(i / 100) * 1.5;
      return [{ x: x + 0.2, y: y + 0.2 }, { x: x + 0.7, y: y + 0.7 }];
    });
    const checked = readUvtt({ ...uvttFile({ size: { x: 160, y: 70 }, objects, lights: [{ at: { x: 5, y: 5 }, range: 4 }] }), environment: { baked_lighting: false, ambient_light: "ff202020" } });
    assert.ok(checked.ok);
    const image = { width: 11200, height: 4900, plan: { kind: "as-is" as const } };
    const options = { objects: true, portals: "window" as const, feetPerCell: 5 };
    const first = planScene(checked.map, options, image);
    assert.equal(first.plan, null);
    assert.match(first.problem!, /more than a scene holds/);
    const info: ReadInfo = {
      image: { type: "image/png", width: image.width, height: image.height, bytes: 33, blob: new Blob() },
      resize: false, hasObjects: true, lightPortals: 0,
      environment: checked.map.environment ?? null,
    };
    assert.equal(lightsLead(summaryLight({ info, plan: first.plan }), { seen: "reveal", light: "bright" }, "reveal"), null);
    const retry = planScene(checked.map, { ...options, objects: false }, image);
    assert.equal(retry.problem, null);
    assert.equal(retry.plan?.lights.length, 1);
    const proposal = summaryLight({ info, plan: retry.plan });
    assert.deepEqual(startingLight(proposal, "reveal"), { seen: "explore", light: "dark" });
    assert.match(lightsLead(proposal, { seen: "explore", light: "dark" }, "reveal")!.text, /^This map brings 1 light\./);
    assert.equal(lightsLead(proposal, { seen: "all", light: "bright" }, "reveal")?.action, "Start it dark", "an explicit pick still wins");
    assert.equal(summaryLight(null), null);
  });

  test("FU38-B: random file changes and conversion retries never retain a previous plan's lights", () => {
    for (let seed = 1; seed <= 30; seed++) {
      let state = seed;
      const next = () => (state = (Math.imul(state, 1664525) + 1013904223) >>> 0);
      let read: Parameters<typeof summaryLight>[0] = null;
      for (let step = 0; step < 80; step++) {
        const event = (next() >>> 16) % 4;
        if (event === 0) read = null;
        else {
          const bright = (next() >>> 16) % 3 === 0;
          const lights = (next() >>> 16) % 6;
          const info: ReadInfo = {
            image: { type: "image/png", width: 700, height: 700, bytes: 33, blob: new Blob() },
            resize: false, hasObjects: true, lightPortals: 0,
            environment: bright ? { baked: false, ambient: "ffffffff" } : null,
          };
          const plan: Pick<ImportPlan, "lights"> | null = event === 1 ? null : {
            lights: Array.from({ length: lights }, () => ({ x: 5, y: 5, bright: 10, dim: 10, on: true, walls: true })),
          };
          read = { info, plan };
        }
        const proposal = summaryLight(read);
        const expected = read?.info.environment ? 0 : read?.plan?.lights.length ?? 0;
        assert.equal(proposal?.lights ?? 0, expected, `current plan only, seed ${seed}, step ${step}`);
        const lead = lightsLead(proposal, { seen: "all", light: "bright" }, "reveal");
        assert.equal(lead !== null, expected > 0, "failed plans, phases and cleared files offer no lights");
        if (lead) assert.match(lead.text, new RegExp(`^This map brings ${expected} lights?\\.`));
      }
    }
  });

  test("says what the file holds, as the design words it", () => {
    assert.equal(foundLine({ ...NONE, gridWalls: 380, freeWalls: 32, doors: 14, windows: 3, lights: 9 }), "412 walls (380 on the grid, 32 free), 14 doors, 3 windows, 9 lights.");
    assert.equal(foundLine({ ...NONE, gridWalls: 1, doors: 1, windows: 1, lights: 1 }), "1 wall, 1 door, 1 window, 1 light.");
    assert.equal(foundLine({ ...NONE, freeWalls: 4000 }), "4,000 walls, 0 doors, 0 windows, 0 lights.");
  });

  test("notes what the import changed, and nothing when it changed nothing", () => {
    assert.deepEqual(notes(NONE), []);
    const all = notes({ ...NONE, welded: 12, clipped: 1, lightsLeftOut: 20, lightsMoved: 1, tolerance: 0.2 });
    assert.equal(all.length, 5);
    assert.match(all[0]!, /^Joined 12 wall ends/);
    assert.match(all[2]!, /20 smallest lights: a scene holds 100/);
  });

  test("says which lights were left out for sitting far outside the map, apart from those over a scene's 100", () => {
    assert.deepEqual(notes({ ...NONE, lightsLeftOut: 1, lightsFarOutside: 1 }), ["Left out 1 light that sat far outside the map."]);
    assert.deepEqual(notes({ ...NONE, lightsLeftOut: 23, lightsFarOutside: 3 }), [
      "Left out the 20 smallest lights: a scene holds 100.",
      "Left out 3 lights that sat far outside the map.",
    ]);
  });

  test("says an image is drawn down only when it is over 8,192 px, and encoded again when only its file is too big", () => {
    assert.equal(imageNote({ width: 4000, height: 2800 }, false), "");
    assert.equal(imageNote({ width: 9000, height: 6300 }, true), ", drawn down to 8,192 pixels on its long side before it uploads");
    assert.equal(imageNote({ width: 4000, height: 2800 }, true), ", encoded again at this size before it uploads, since the image is over 32 MB");
  });

  test("sizes read in KB and MB", () => {
    assert.equal(sizeText(800 * 1024), "800 KB");
    assert.equal(sizeText(24 * 1024 * 1024), "24 MB");
  });

  test("a room whose new scenes start on hexes is told the import makes squares, a square room nothing", () => {
    assert.equal(shapeNote("hexRows"), "Universal VTT files make square scenes.");
    assert.equal(shapeNote("hexColumns"), "Universal VTT files make square scenes.");
    assert.equal(shapeNote(undefined), null);
  });
});
