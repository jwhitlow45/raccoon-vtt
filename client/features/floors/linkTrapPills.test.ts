import "../../components/testing/register.ts";
import assert from "node:assert/strict";
import { before, test } from "node:test";
import { SQUARES } from "#shared/rules/grid.ts";
import { trap as makeTrap } from "#shared/testutil.ts";
import type { PillSpec } from "../../canvas/boardView.ts";
import { isometric } from "../../lib/view.ts";
import { pillPlace } from "../measure/pillPlace.ts";
import { boxCoversOutline, cornersOf, drawnBox, nameAnchor, outlineOf, placeEnds, type EndPills, type Outline } from "./linkMarks.ts";

const { isoTrapNameMarkers, isoTrapNamePill, linkFrames, trapNameMarkers, trapNamePill, trapSquares } = await import("../traps/TrapLayer.tsx");

before(() => {
  const context = { font: "", measureText: (text: string) => ({ width: text.length * 7 }) };
  (globalThis as { document?: unknown }).document = { createElement: () => ({ getContext: () => context }) };
});

/*
 * A trap beside a floor link's ends on a phone: a hole to its left and
 * stairs to its right. The trap's name keeps off the ends' frames, and the
 * stairs' name off the trap's squares, each placed from the other's things
 * alone, never from its pills.
 */

const SCALE = 30;

function covers(p: PillSpec, outlines: readonly Outline[]): boolean {
  const box = pillPlace({ ...p, scale: SCALE }, null).box;
  return outlines.some((o) => boxCoversOutline(box, cornersOf(o), null));
}

function stairsEnd(rect: { x: number; y: number; w: number; h: number }): EndPills {
  const o = outlineOf(SQUARES, rect);
  const at = nameAnchor(o, "top");
  return { id: "s", o, hole: false, first: { name: "Up to Belfry", value: "Not reached yet", x: at.x, y: at.y, above: true, size: "map", small: true, maxLines: 1, stack: true }, dropPill: null };
}

test("a trap's name keeps off the frames of the hole and the stairs beside it, where its top edge would cover the stairs", () => {
  const trap = makeTrap("t", { zone: { cells: [{ x: 3, y: 2, w: 2, h: 1 }] } });
  const links = {
    h: { id: "h", sceneId: "s1", rect: { x: 1, y: 2, w: 2, h: 1 } },
    s: { id: "s", sceneId: "s1", rect: { x: 5, y: 1, w: 2, h: 2 } },
  };
  const frames = linkFrames(SQUARES, "s1", links);
  assert.ok(covers(trapNamePill(SQUARES, trap, {}, SCALE, true)!, frames), "over the middle of its top edge the name covers the stairs");
  const name = trapNamePill(SQUARES, trap, {}, SCALE, true, frames)!;
  assert.ok(!covers(name, frames), `the name at ${JSON.stringify(name)} covers a frame`);
  assert.deepEqual(trapNameMarkers(SQUARES, "s1", { t: trap }, {}, SCALE, true, frames), [name], "the link layer keeps off the name where it is drawn");
});

test("a stairs' name over its top edge moves under its bottom edge where it would cover a trap's squares", () => {
  const trap = makeTrap("t", { zone: { cells: [{ x: 3, y: 3, w: 3, h: 1 }] } });
  const squares = trapSquares(SQUARES, "s1", { t: trap });
  const stairs = stairsEnd({ x: 6, y: 4, w: 2, h: 2 });
  assert.ok(covers(placeEnds([stairs], [], SCALE, null, () => true).get("s")!.pill!, squares), "with no squares to keep off, the name covers the trap");
  const pill = placeEnds([stairs], [], SCALE, null, () => true, [], { traps: squares }).get("s")!.pill!;
  assert.ok(!covers(pill, squares), `the name at ${JSON.stringify(pill)} covers the trap`);
  assert.deepEqual([pill.below, pill.y], [true, 6], "under the bottom edge");
});

test("a hole's name pays for covering a trap's squares as for another end's, so it takes the side clear of them", () => {
  const o = outlineOf(SQUARES, { x: 4, y: 4, w: 1, h: 1 });
  const at = nameAnchor(o, "bottom");
  const hole: EndPills = { id: "h", o, hole: true, first: { name: "Down to Undercroft", value: "Not reached yet", x: at.x, y: at.y, below: true, size: "map", small: true, maxLines: 1, stack: true }, dropPill: null };
  const trap = makeTrap("t", { zone: { cells: [{ x: 1, y: 5, w: 3, h: 1 }] } });
  const squares = trapSquares(SQUARES, "s1", { t: trap });
  const pill = placeEnds([hole], [], SCALE, null, () => true, [], { traps: squares }).get("h")!.pill!;
  assert.ok(!covers(pill, squares), `the name at ${JSON.stringify(pill)} covers the trap`);
});

test("a trap's name is judged where the screen's edge slides it, so it takes the clear spot when its first one slides onto a frame (FUUI-SOL-01)", () => {
  const scale = 40;
  const trap = makeTrap("t", { zone: { cells: [{ x: 6, y: 6, w: 2, h: 1 }] } });
  const alone = trapNamePill(SQUARES, trap, {}, scale, true)!;
  const rest = pillPlace({ ...alone, scale }, null).box;
  // A frame just right of the top name, level with its row only: clear until the left edge of the view pushes the name right onto it.
  const links = { f: { id: "f", sceneId: "s1", rect: { x: Math.ceil(rest.x1 * 10) / 10 + 0.1, y: rest.y0, w: 2, h: rest.y1 - rest.y0 } } };
  const frames = linkFrames(SQUARES, "s1", links);
  const view = { x0: rest.x0 + 1, y0: 0, x1: 40, y1: 40 };
  const off = (p: PillSpec, v: typeof view | null) => !boxCoversOutline(pillPlace({ ...p, scale }, v).box, cornersOf(frames[0]!), null);
  assert.ok(off(alone, null), "with no edge near, the name over the top edge is clear");
  assert.ok(!off(alone, view), "slid by the view's edge it covers the frame");
  const blind = trapNamePill(SQUARES, trap, {}, scale, true, frames)!;
  assert.deepEqual(blind, alone, "judged where it stands, the first spot is kept");
  const seen = trapNamePill(SQUARES, trap, {}, scale, true, frames, view)!;
  assert.ok(off(seen, view), `the name at ${JSON.stringify(seen)} covers the frame once slid`);
  assert.deepEqual(trapNameMarkers(SQUARES, "s1", { t: trap }, {}, scale, true, frames, view), [seen], "the link layer keeps off the name where it is drawn");
});

test("in Isometric a hole's pills keep off the trap name as isoTrapNamePill stands it with no token text (F11-6)", () => {
  const trap = makeTrap("t", { zone: { cells: [{ x: 3, y: 2, w: 2, h: 1 }] } });
  const links = {
    h: { id: "h", sceneId: "s1", rect: { x: 1, y: 2, w: 2, h: 1 } },
    s: { id: "s", sceneId: "s1", rect: { x: 5, y: 1, w: 2, h: 2 } },
  };
  const frames = linkFrames(SQUARES, "s1", links);
  const iso = { turn: 0 as const, ground: () => 0, fog: { all: true } } as unknown as Parameters<typeof isoTrapNameMarkers>[7];
  const marks = isoTrapNameMarkers(SQUARES, "s1", { t: trap }, {}, SCALE, true, frames, iso, null);
  assert.equal(marks.length, 1);
  const original = trapNamePill(SQUARES, trap, {}, SCALE, true, frames)!;
  const standing = isoTrapNamePill(original, SQUARES, trap, {}, { view: isometric(0), ground: () => 0, boxes: [] }, SCALE, () => true, frames, iso);
  assert.deepEqual(marks[0], standing, "the marker is the pick with no token text");
  const space = { turn: 0 as const, ground: () => 0 };
  const covered = (p: PillSpec) => frames.filter((o) => boxCoversOutline(drawnBox(p, SCALE, space, true, true), cornersOf(o), space)).length;
  assert.equal(covered(original), 1, "Top-down's pick covers a frame on the turned ground");
  assert.equal(covered(marks[0]!), 0, "the marker is clear of every frame where it stands");
});

test("a trap's name between a hole and stairs hangs over its own squares where no spot on its edges is clear, so it covers no frame at any turn (ISO-1-MORE-SPOTS)", () => {
  const trap = makeTrap("t", { zone: { cells: [{ x: 3, y: 2, w: 2, h: 1 }] } });
  const frames = linkFrames(SQUARES, "s1", { h: { id: "h", sceneId: "s1", rect: { x: 1, y: 2, w: 2, h: 1 } }, s: { id: "s", sceneId: "s1", rect: { x: 5, y: 1, w: 2, h: 2 } } });
  for (const scale of [36, 48]) for (const turn of [0, 1, 2, 3] as const) {
    const space = { turn, ground: () => 0 };
    const original = trapNamePill(SQUARES, trap, {}, scale, true)!;
    const chosen = isoTrapNamePill(original, SQUARES, trap, {}, { view: isometric(turn), ground: () => 0, boxes: [] }, scale, () => true, frames, space);
    const drawn = drawnBox(chosen, scale, space, true, true);
    assert.deepEqual(frames.filter((o) => boxCoversOutline(drawn, cornersOf(o), space)).length, 0, `scale ${scale} turn ${turn}: the name at ${JSON.stringify(chosen)} covers a frame`);
  }
});
