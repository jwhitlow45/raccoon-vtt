import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { CHUNK_CELLS, type BuildChunk } from "#shared/model.ts";
import { encodeHeights } from "#shared/rules/heights.ts";
import { measureLabel, measurePill } from "../../../canvas/measureText.ts";
import { placedTextBoxes } from "../../../canvas/textBoxes.ts";
import type { TokenText } from "../../../canvas/useBoardText.ts";
import { boardSizes } from "../../../lib/boardScale.ts";
import { labelStyle, overlaps, placeLabels, type Box, type LabelInput, type Obstacle } from "../../../lib/boardText.ts";
import type { ViewToken } from "../../../lib/scene.ts";
import { DECOR_MIN_PX } from "../../../lib/tokenView.ts";
import { theme } from "../../../lib/theme.ts";
import { drawMark, drawPills, heightTextSizes, placeHeightPills, type MarkCanvas, type PlacedPill } from "./boardText.ts";
import { heightRegions, type HeightRegion } from "./regions.ts";

/** The pill's measure on the board (HeightLayer.tsx), which Node answers with its estimate. */
const measure = (text: string, px: number) => measurePill(text, px, theme.font.body);

/** The chunks of a scene painted with `heights`, keyed "x,y". */
function chunks(heights: ReadonlyMap<string, number>): BuildChunk[] {
  const byChunk = new Map<string, number[]>();
  for (const [key, v] of heights) {
    const [x, y] = key.split(",").map(Number) as [number, number];
    const cx = Math.floor(x / CHUNK_CELLS);
    const cy = Math.floor(y / CHUNK_CELLS);
    let feet = byChunk.get(`${cx},${cy}`);
    if (!feet) byChunk.set(`${cx},${cy}`, (feet = new Array<number>(CHUNK_CELLS * CHUNK_CELLS).fill(0)));
    feet[(y - cy * CHUNK_CELLS) * CHUNK_CELLS + (x - cx * CHUNK_CELLS)] = v;
  }
  return [...byChunk].map(([key, feet]) => {
    const [cx, cy] = key.split(",").map(Number) as [number, number];
    return { sceneId: "s1", cx, cy, rev: 1, cells: {}, edges: {}, heights: encodeHeights(feet) };
  });
}

function block(out: Map<string, number>, x0: number, y0: number, w: number, h: number, v: number): void {
  for (let y = y0; y < y0 + h; y++) for (let x = x0; x < x0 + w; x++) out.set(`${x},${y}`, v);
}

/** As HeightLayer orders them: the largest 300, the smallest of those first. */
function ordered(heights: ReadonlyMap<string, number>, bounds: { w: number; h: number }): HeightRegion[] {
  return heightRegions(chunks(heights), bounds).slice(0, 300).reverse();
}

type Goblin = { id: string; x: number; y: number; name: string };

/**
 * The label and plate boxes Stage hands the layer at `cellPx` a cell: each
 * token's label placed by the real label pass (lib/boardText.ts, with
 * useBoardText's style), turned into boxes by the function Stage uses
 * (canvas/textBoxes.ts), and a plate for the token named `plated`. Every
 * goblin tries for a name, as at any zoom from DECOR_MIN_PX a cell.
 */
function labelBoxes(goblins: readonly Goblin[], cellPx: number, plated?: string): Box[] {
  assert.ok(cellPx >= DECOR_MIN_PX, "below this zoom these goblins would show no names");
  const sizes = boardSizes(cellPx, 1);
  const obstacles: Obstacle[] = [];
  const inputs: LabelInput[] = [];
  for (const t of goblins) {
    const box = { x0: t.x * cellPx, y0: t.y * cellPx, x1: (t.x + 1) * cellPx, y1: (t.y + 1) * cellPx };
    obstacles.push({ box, owner: t.id, kind: "body" });
    const style = labelStyle(sizes, cellPx, cellPx);
    inputs.push({ id: t.id, box, belowY: box.y1 + sizes.gapPx, aboveY: box.y0 - sizes.gapPx, name: t.name, hp: "7/7", alert: false, rank: 0, sides: false, nameOnly: false, style });
  }
  const placed = placeLabels(inputs, obstacles, measureLabel);
  const text = new Map<string, TokenText>();
  for (const t of goblins) {
    const p = placed.get(t.id);
    const label = p && p.lines.length > 0 ? { lines: p.lines, x: p.box.x0 - t.x * cellPx, y: p.box.y0 - t.y * cellPx, width: p.box.x1 - p.box.x0, height: p.box.y1 - p.box.y0 } : null;
    const plate = t.id === plated ? { lines: [], x: -30, y: cellPx + 4, width: cellPx + 60, height: 40 } : null;
    text.set(t.id, { label, plate } as unknown as TokenText);
  }
  return placedTextBoxes(goblins as unknown as ViewToken[], text, cellPx);
}

/** Equal up to rounding: a drawn size comes back from a box's edges. */
function near(actual: number, expected: number): void {
  assert.ok(Math.abs(actual - expected) < 1e-9, `${actual} is not ${expected}`);
}

/** A canvas that writes down what is drawn, with the font in force when each text is drawn. */
function recorder() {
  const texts: { text: string; font: string }[] = [];
  const rects: { w: number; h: number }[] = [];
  const g: MarkCanvas = {
    font: "",
    fillStyle: "",
    strokeStyle: "",
    lineWidth: 0,
    lineJoin: "",
    textAlign: "",
    textBaseline: "",
    save() {},
    restore() {},
    scale() {},
    translate() {},
    beginPath() {},
    fill() {},
    stroke() {},
    roundRect(_x: number, _y: number, w: number, h: number) {
      rects.push({ w, h });
    },
    fillText(text: string) {
      texts.push({ text, font: g.font });
    },
    strokeText() {},
  };
  return { g, texts, rects };
}

describe("height mode's board text", () => {
  // A phone fitted to a whole scene, the zoom where every mark is its old size, and a close zoom.
  const SCALES = [13, 40, 80];

  for (const ui of [1, 1.3]) {
    test(`a pill's text is the board pill size at every zoom, at ${ui * 100}% interface size`, () => {
      const regions = ordered(new Map([["4,4", 10]]), { w: 10, h: 10 });
      for (const cellPx of SCALES) {
        const { pill } = heightTextSizes(cellPx, ui);
        assert.equal(pill.fontPx, boardSizes(cellPx, ui).pillPx, `at ${cellPx} px a cell`);
        const [placed] = placeHeightPills(regions, [], cellPx, pill, measure);
        assert.ok(placed);
        const drawn = recorder();
        drawPills(drawn.g, [placed], cellPx, null);
        assert.deepEqual(drawn.texts, [{ text: "↑10 ft", font: `700 ${boardSizes(cellPx, ui).pillPx}px ${theme.font.body}` }]);
        // The pill keeps its shape: its padding and height grow with the text.
        near(drawn.rects[0]!.h, (20 * pill.fontPx) / 12);
        near(drawn.rects[0]!.w, measurePill("↑10 ft", pill.fontPx, theme.font.body) + 2 * Math.round((6 * pill.fontPx) / 12));
      }
    });
  }

  test("the sizes follow the map between the floor and the ceiling, times the interface size", () => {
    assert.deepEqual(
      SCALES.map((s) => heightTextSizes(s, 1).pill.fontPx),
      [11, 12, 16],
    );
    assert.deepEqual(
      SCALES.map((s) => heightTextSizes(s, 1.3).pill.fontPx),
      [14.5, 15.5, 21],
    );
  });

  test("only the pills on screen are drawn", () => {
    const heights = new Map<string, number>();
    block(heights, 1, 1, 3, 3, 10);
    block(heights, 30, 1, 3, 3, -5);
    const cellPx = 40;
    const pills = placeHeightPills(ordered(heights, { w: 40, h: 10 }), [], cellPx, heightTextSizes(cellPx, 1).pill, measure);
    assert.equal(pills.length, 2);
    const drawn = recorder();
    // The left ten cells are in view: the ↑10 ft pill on the left platform, not the one 30 cells over.
    drawPills(drawn.g, pills, cellPx, { x0: 0, y0: 0, x1: 10, y1: 10 });
    assert.deepEqual(
      drawn.texts.map((t) => t.text),
      ["↑10 ft"],
    );
    const all = recorder();
    drawPills(all.g, pills, cellPx, null);
    assert.equal(all.texts.length, 2);
  });

  test("a stair's ? takes a chip's letter size", () => {
    for (const ui of [1, 1.3]) {
      for (const cellPx of SCALES) {
        const { markPx } = heightTextSizes(cellPx, ui);
        assert.equal(markPx, boardSizes(cellPx, ui).chipTextPx);
        const drawn = recorder();
        drawMark(drawn.g, "?", 1.5, 1.5, cellPx, markPx, theme.color.accentSoft);
        assert.equal(drawn.texts[0]!.font, `700 ${markPx}px ${theme.font.body}`);
      }
    }
  });

  test("in a crowded scene at a phone's fitted zoom, no drawn pill overlaps a name, a plate or another pill", () => {
    // A scene 21 cells wide fills a phone 390 px wide at about 18 px a cell.
    const bounds = { w: 21, h: 16 };
    const cellPx = 18;
    const heights = new Map<string, number>();
    // Two by two platforms a cell apart, and one wide one, at different heights.
    let n = 0;
    for (let y = 0; y + 2 <= 11; y += 3) for (let x = 0; x + 2 <= bounds.w; x += 3) block(heights, x, y, 2, 2, n++ % 2 === 0 ? 5 * (1 + (n % 6)) : -5 * (1 + (n % 4)));
    block(heights, 2, 12, 17, 4, 15);
    const regions = ordered(heights, bounds);
    const goblins: Goblin[] = [];
    for (let i = 0; i < 10; i++) goblins.push({ id: `g${i}`, x: 1 + ((i * 4) % 19), y: 1 + 3 * Math.floor(i / 3), name: `Goblin ${i + 1}` });
    const labels = labelBoxes(goblins, cellPx, "g4");
    assert.ok(labels.length >= 8, "most goblins show a label");
    const before = structuredClone(labels);

    const { pill } = heightTextSizes(cellPx, 1);
    const pills = placeHeightPills(regions, labels, cellPx, pill, measure);
    assert.ok(pills.length >= 5, `${pills.length} pills drawn`);
    for (const [i, p] of pills.entries()) {
      for (const l of labels) assert.ok(!overlaps(p.box, l), `the ${p.text} pill at ${p.box.x0},${p.box.y0} overlaps a name or plate`);
      for (const q of pills.slice(i + 1)) assert.ok(!overlaps(p.box, q.box), "two pills overlap");
    }
    assert.deepEqual(labels, before, "the names are only read");

    // The names did move pills: without them some pill would sit on a name, and the crowd leaves some region with none.
    const blind = placeHeightPills(regions, [], cellPx, pill, measure);
    assert.ok(
      blind.some((p) => labels.some((l) => overlaps(p.box, l))),
      "with no names to keep off, a pill would cover one",
    );
    assert.ok(pills.length < regions.length, "some region has no free spot at this zoom");
  });

  test("a region with no free spot is left out, and a zoom that gives it room brings it back", () => {
    // A 3 by 3 platform has one spot, its middle, right under the name of the goblin standing above it.
    const regions = ordered(block3(4, 6), { w: 12, h: 12 });
    assert.equal(regions[0]!.spots.length, 1);
    const goblin: Goblin[] = [{ id: "g", x: 5, y: 5, name: "Goblin Boss" }];
    const at = (cellPx: number): PlacedPill[] => placeHeightPills(regions, labelBoxes(goblin, cellPx), cellPx, heightTextSizes(cellPx, 1).pill, measure);
    assert.deepEqual(at(16), []);
    const close = at(40);
    assert.equal(close.length, 1);
    assert.deepEqual(
      { x: (close[0]!.box.x0 + close[0]!.box.x1) / 2, y: (close[0]!.box.y0 + close[0]!.box.y1) / 2 },
      { x: 5.5 * 40, y: 7.5 * 40 },
    );
  });

  test("a covered spot gives way to the region's next one", () => {
    // A 5 by 5 platform offers its middle first, then spots around it.
    const heights = new Map<string, number>();
    block(heights, 2, 2, 5, 5, -10);
    const regions = ordered(heights, { w: 10, h: 10 });
    const first = regions[0]!.spots[0]!;
    const cellPx = 40;
    const over = { x0: first.x * cellPx - 5, y0: first.y * cellPx - 5, x1: first.x * cellPx + 5, y1: first.y * cellPx + 5 };
    const [moved] = placeHeightPills(regions, [over], cellPx, heightTextSizes(cellPx, 1).pill, measure);
    assert.ok(moved);
    assert.equal(moved.text, "↓10 ft");
    assert.equal(moved.raised, false);
    assert.ok(!overlaps(moved.box, over));
    const second = regions[0]!.spots.find((s) => s !== first && !overlaps(over, boxAt(moved, s, cellPx)));
    assert.deepEqual({ x: (moved.box.x0 + moved.box.x1) / 2 / cellPx, y: (moved.box.y0 + moved.box.y1) / 2 / cellPx }, second);
  });
});

function block3(x0: number, y0: number): Map<string, number> {
  const out = new Map<string, number>();
  block(out, x0, y0, 3, 3, 20);
  return out;
}

/** The box `pill` would take centered on `spot`. */
function boxAt(pill: PlacedPill, spot: { x: number; y: number }, cellPx: number): Box {
  const w = pill.box.x1 - pill.box.x0;
  const h = pill.box.y1 - pill.box.y0;
  return { x0: spot.x * cellPx - w / 2, y0: spot.y * cellPx - h / 2, x1: spot.x * cellPx + w / 2, y1: spot.y * cellPx + h / 2 };
}
