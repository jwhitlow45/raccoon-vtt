import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { BandPart } from "../../features/areas/volume.ts";
import { theme } from "../../lib/theme.ts";
import type { VolumePiece } from "./buckets.ts";
import { drawRun, drawVolume, type DrawContext } from "./drawRelief.ts";

/*
 * How an area standing as its real shape draws (docs/design-v1-iso-area-shapes.md
 * 4.3 and 5), read off a canvas that writes down what it is told: far
 * loops filled, near loops filled, hidden lines, then the outline, and what
 * lies inside a pit's opening only inside the openings' clip.
 */

type Call = { name: string; alpha: number; width: number; dash: number[]; clipped: boolean; color: string };

function canvas(): { g: CanvasRenderingContext2D; calls: Call[] } {
  const calls: Call[] = [];
  const state = { globalAlpha: 1, lineWidth: 1, dash: [] as number[], clips: 0, color: "" };
  const stack: (typeof state)[] = [];
  const g = {
    set globalAlpha(v: number) {
      state.globalAlpha = v;
    },
    set lineWidth(v: number) {
      state.lineWidth = v;
    },
    set fillStyle(v: string) {
      state.color = v;
    },
    set strokeStyle(_: string) {},
    set lineJoin(_: string) {},
    set lineCap(_: string) {},
    setLineDash: (d: number[]) => {
      state.dash = d;
    },
    save: () => stack.push({ ...state }),
    restore: () => Object.assign(state, stack.pop()),
    clip: () => {
      state.clips++;
      calls.push({ name: "clip", alpha: state.globalAlpha, width: state.lineWidth, dash: state.dash, clipped: true, color: state.color });
    },
    fill: () => calls.push({ name: "fill", alpha: state.globalAlpha, width: state.lineWidth, dash: state.dash, clipped: state.clips > 0, color: state.color }),
    stroke: () => calls.push({ name: "stroke", alpha: state.globalAlpha, width: state.lineWidth, dash: state.dash, clipped: state.clips > 0, color: state.color }),
    setTransform: () => {},
    beginPath: () => {},
    closePath: () => {},
    moveTo: () => {},
    lineTo: () => {},
  };
  return { g: g as unknown as CanvasRenderingContext2D, calls };
}

const loop = Float64Array.of(0, 0, 1, 1, 0, 1, 1, 1, 1);
const line = Float64Array.of(0, 0, 1, 1, 1, 1);
const none = new Float64Array(0);

function part(fill: boolean): BandPart {
  return { far: fill ? [loop] : [], near: fill ? [loop] : [], outline: fill ? line : none, hidden: fill ? line : none, guide: fill ? line : none, guideHidden: fill ? line : none };
}

describe("an area's run of bands drawn as one", () => {
  test("far faces filled, near faces filled, the hidden lines dashed, then the outline and guides, in the area's color at the design's strengths", () => {
    const { g, calls } = canvas();
    drawVolume(g, [part(true), part(true)], [part(false)], [], { color: "#3fa7ff", dm: false, selected: false, preview: false }, 0, 0.5);
    assert.deepEqual(
      calls.map((c) => c.name),
      ["fill", "fill", "stroke", "stroke", "stroke", "stroke"],
      "one fill each for the far and near faces of the whole run, whatever bands it holds",
    );
    const [far, near, hidden, guideHidden, outline, guide] = calls as [Call, Call, Call, Call, Call, Call];
    assert.equal(far.alpha, theme.area.volumeFill);
    assert.equal(near.alpha, theme.area.volumeFill);
    for (const h of [hidden, guideHidden]) {
      assert.equal(h.alpha, theme.area.volumeHidden);
      assert.equal(h.width, 0.5);
      assert.deepEqual(h.dash, [2, 2], "4 4 screen pixels at half a view unit to a pixel");
    }
    assert.equal(outline.alpha, theme.area.volumeLine);
    assert.equal(outline.width, 1, "2 screen pixels");
    assert.deepEqual(outline.dash, []);
    assert.equal(guide.alpha, theme.area.volumeGuide);
  });

  test("a DM-only area at 60% with its outline dashed 6 4, a selected one's outline 2.5 px, another member's preview at 10% dashed 8 5", () => {
    const run = (look: { dm: boolean; selected: boolean; preview: boolean }) => {
      const { g, calls } = canvas();
      drawVolume(g, [part(true)], [part(false)], [], { color: "#e5484d", ...look }, 0, 1);
      return { fill: calls[0]!, outline: calls[4]! };
    };
    const dm = run({ dm: true, selected: false, preview: false });
    assert.ok(Math.abs(dm.fill.alpha - theme.area.volumeFill * 0.6) < 1e-12);
    assert.ok(Math.abs(dm.outline.alpha - theme.area.volumeLine * 0.6) < 1e-12);
    assert.deepEqual(dm.outline.dash, [6, 4]);
    assert.equal(run({ dm: false, selected: true, preview: false }).outline.width, 2.5);
    const preview = run({ dm: false, selected: false, preview: true });
    assert.equal(preview.fill.alpha, theme.area.previewFill);
    assert.deepEqual(preview.outline.dash, [8, 5]);
  });

  test("what lies inside a pit's opening draws only inside the openings' clip, and with no pit to clip by, not at all", () => {
    const pits = [{ x: 3, y: 3 }];
    const { g, calls } = canvas();
    drawVolume(g, [part(true)], [part(true)], pits, { color: "#3fa7ff", dm: false, selected: false, preview: false }, 1, 1);
    const clip = calls.findIndex((c) => c.name === "clip");
    assert.ok(clip > 0, "the pit's part is clipped");
    assert.deepEqual(
      calls.slice(0, clip).map((c) => c.clipped),
      [false, false],
      "the part above the ground fills unclipped first",
    );
    const inside = calls.filter((c) => c.clipped && c.name !== "clip");
    assert.equal(inside.length, 6, "the pit's fills and strokes, each inside the clip");
    assert.ok(calls.slice(clip + 7).every((c) => !c.clipped), "the clip ends before the outline above the ground");
    const bare = canvas();
    drawVolume(bare.g, [part(false)], [part(true)], [], { color: "#3fa7ff", dm: false, selected: false, preview: false }, 1, 1);
    assert.equal(bare.calls.length, 0, "nothing inside an opening shows without its clip");
  });

  test("bands of two areas in a row draw as one run each, the farther area first: their tints blend in either order (design 4.3)", () => {
    const { g, calls } = canvas();
    const piece = (area: string, color: string, band: number): VolumePiece => ({
      kind: "volume",
      id: `v${area}:${band}`,
      area,
      band,
      key: band + 0.5,
      draws: [{ band, high: part(true), low: part(false), box: { x0: 0, y0: 0, x1: 1, y1: 1 } }],
      bounds: { x0: 0, y0: 0, x1: 1, y1: 1 },
      look: { color, dm: false, selected: false, preview: false },
      pits: [],
    });
    const dc: DrawContext = { turn: 0, camera: { x: 0, y: 0, scale: 1 } as DrawContext["camera"], pixelRatio: 1, ground: null, textures: {}, view: { x0: -10, y0: -10, x1: 10, y1: 10 } };
    drawRun(g, [piece("a", "#aaaaaa", 3), piece("b", "#bbbbbb", 3), piece("a", "#aaaaaa", 4), piece("b", "#bbbbbb", 4), piece("a", "#aaaaaa", 5)], dc);
    const fills = calls.filter((c) => c.name === "fill");
    assert.deepEqual(
      fills.map((c) => c.color),
      ["#aaaaaa", "#aaaaaa", "#bbbbbb", "#bbbbbb"],
      "a far and a near fill for each area, not for each band",
    );
  });
});
