import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { RoomScope } from "../state/scope.ts";
import {
  BAR_WIDTH,
  laneChoice,
  paneLane,
  paneLaneBox,
  SUMMARY_ROW,
  barCover,
  barMode,
  BESIDE_MIN,
  columnCards,
  columnEdges,
  DEFAULT_CHROME,
  EDGE,
  FLIP_CLEARANCE,
  LANE_WIDTH,
  carriedMove,
  clampBox,
  clearAnchor,
  columnFacts,
  columnRoom,
  columnTop,
  anchoredSpot,
  clampMove,
  compactHang,
  DEFAULT_SPOT,
  defaultBarWidth,
  handleCorner,
  heldPlace,
  keySize,
  LARGER_KEY,
  LARGER_LEAVES,
  largerRoom,
  largerShift,
  limitMet,
  moveRoom,
  NO_SIZE,
  parseSize,
  pixels,
  readSize,
  releaseSize,
  resizeBox,
  resizeLimits,
  SIZE_KEY,
  sizeText,
  sizeWords,
  writeSize,
  type BarSize,
  type Corner,
  type ResizePart,
  freeArea,
  hangBox,
  isDefaultSpot,
  laneLeft,
  arrowStep,
  headerLayout,
  headerRowMin,
  keySpot,
  spotWords,
  WINDOW_FOLD_BELOW,
  noticePlace,
  OFFSET_Y,
  overlapsLane,
  parseSpot,
  placeBar,
  pastBars,
  raisedRow,
  askedAlerts,
  barDockSlot,
  closeAlertsOverlay,
  TOAST_MIN,
  toastTop,
  paneToastTop,
  barToastTop,
  toastsOverHead,
  fitToasts,
  inToastLayer,
  nextToastPlaces,
  NO_TOAST_PLACES,
  toastLayerPlace,
  type ToastPlace,
  type ToastPlaces,
  readLarger,
  readSpot,
  releaseSpot,
  restingBar,
  shareLane,
  SPOT_KEY,
  spotHang,
  smallerShift,
  spotText,
  writeLarger,
  writeSpot,
  type Box,
  type Chrome,
  type Hang,
} from "./barDock.ts";

const NONE = { top: 0, right: 0, bottom: 0, left: 0 };
/** Multi-select's row standing on the toolbar: 44 px controls, 4 px padding and a 1 px top edge (docs/design-v1-tool-options.md 4.2). */
const OPTIONS = 53;

/**
 * A phone's chrome at full size: the top bar, an optional turn band, the
 * toolbar, Multi-select's row and the safe areas. The row stacks on the
 * toolbar (`true`), or stands in the toolbar's own row on a short
 * sideways screen ("merged"), where it takes no height.
 */
function phone(input: { band: boolean; options: boolean | "merged"; safe: { top: number; side: number; bottom: number } }): Chrome {
  const toolbar = 60 + input.safe.bottom;
  const row = input.options === true ? OPTIONS : 0;
  return {
    top: 52 + input.safe.top + (input.band ? 48 : 0),
    bottom: toolbar + row,
    controls: toolbar + row,
    toolbar,
    safe: { top: input.safe.top, right: input.safe.side, bottom: input.safe.bottom, left: input.safe.side },
    sheet: 0,
  };
}

describe("span, dock or compact", () => {
  test("a layout under 600 px and no wider than tall spans, and 600 px or wider, or wider than tall, docks", () => {
    assert.equal(barMode({ width: 599, height: 800 }, 148), "span");
    assert.equal(barMode({ width: 600, height: 800 }, 148), "dock");
    assert.equal(barMode({ width: 599, height: 599 }, 300), "span", "a square layout counts as upright");
    assert.equal(barMode({ width: 599, height: 400 }, 148), "dock", "a phone on its side docks");
    assert.equal(barMode({ width: 1280, height: 800 }, 600), "dock");
  });

  test("the interface size moves the cut: an upright tablet at 130% lays out under 600 px and spans", () => {
    assert.equal(barMode({ width: 780 / 1.3, height: 1024 / 1.3 }, 300), "dock");
    assert.equal(barMode({ width: 768 / 1.3, height: 1024 / 1.3 }, 300), "span");
    assert.equal(barMode({ width: 768, height: 1024 }, 300), "dock", "the same tablet at 100%");
  });

  test("a free area under 148 px opens compact, upright or not, down to 0 and below", () => {
    for (const layout of [
      { width: 390, height: 844 },
      { width: 844, height: 390 },
    ]) {
      assert.equal(barMode(layout, 147), "compact");
      assert.equal(barMode(layout, 0), "compact");
      assert.equal(barMode(layout, -20), "compact");
      assert.notEqual(barMode(layout, 148), "compact");
    }
  });
});

describe("the free area", () => {
  test("is the map less the bars, the safe areas and an 8 px margin", () => {
    const free = freeArea({ width: 920, height: 800 }, { top: 52, bottom: 60, controls: 60, toolbar: 60, safe: NONE, sheet: 0 });
    assert.deepEqual(free, { left: 8, top: 60, width: 904, height: 672 });
  });

  test("the turn band, the options row and the safe areas each take their share", () => {
    const plain = freeArea({ width: 649, height: 300 }, phone({ band: false, options: false, safe: { top: 0, side: 47, bottom: 21 } }));
    assert.deepEqual(plain, { left: 55, top: 60, width: 539, height: 151 });
    const busy = freeArea({ width: 649, height: 300 }, phone({ band: true, options: true, safe: { top: 0, side: 47, bottom: 21 } }));
    assert.deepEqual(busy, { left: 55, top: 108, width: 539, height: 50 });
    const merged = freeArea({ width: 649, height: 300 }, phone({ band: false, options: "merged", safe: { top: 0, side: 47, bottom: 21 } }));
    assert.deepEqual(merged, plain, "a row in the toolbar's own row takes no height");
  });

  test("the right safe area is off while the side panel shows, so the free area reaches 8 px from the map's edge", () => {
    const shown = { ...phone({ band: false, options: false, safe: { top: 0, side: 59, bottom: 21 } }), safe: { top: 0, right: 0, bottom: 21, left: 59 } };
    const free = freeArea({ width: 932 - 360, height: 430 }, shown);
    assert.equal(free.left + free.width, 572 - EDGE);
  });

  test("a roll card standing on a narrow screen's toolbar and options bar takes the bottom above them", () => {
    const chrome: Chrome = { top: 52, bottom: 60 + 53, controls: 60 + 53, toolbar: 60, safe: NONE, sheet: 0 };
    const viewport = { width: 390, height: 844 };
    assert.equal(freeArea(viewport, chrome, 250).height, 844 - 113 - 250 - 8 - 60);
    assert.equal(freeArea(viewport, chrome, 30).height, freeArea(viewport, chrome).height - 30);
    assert.equal(barMode(viewport, freeArea({ width: 390, height: 400 }, chrome, 250).height), "compact", "a card that leaves too little opens the bar compact");
  });

  test("a landscape sheet takes the right, over the right safe area", () => {
    const chrome = { ...phone({ band: false, options: false, safe: { top: 0, side: 47, bottom: 21 } }), sheet: 340 };
    const free = freeArea({ width: 844, height: 390 }, chrome);
    assert.equal(free.left + free.width, 844 - 340 - 8);
  });
});

describe("compact", () => {
  test("covers only the Multi-select bar when 148 px reach the toolbar, and the toolbar too when they do not", () => {
    const viewport = { width: 649, height: 300 };
    const short = compactHang(viewport, viewport, phone({ band: false, options: true, safe: { top: 0, side: 47, bottom: 21 } }));
    assert.equal(short.coversToolbar, false);
    assert.equal(short.at, 300 - 81 - 8);
    const shorter = compactHang(viewport, viewport, phone({ band: true, options: true, safe: { top: 0, side: 47, bottom: 21 } }));
    assert.equal(shorter.coversToolbar, true);
    assert.equal(shorter.at, 300 - 21 - 8);
  });

  // The worked examples of design 1.4, Multi-select on, insets at full size: the overlay's height, then what the summary row leaves the bar.
  const summary = (chrome: Chrome, viewport: { width: number; height: number }) => {
    const hang = compactHang(viewport, viewport, chrome);
    const free = freeArea(viewport, chrome);
    const shared = shareLane({ hang, laneTop: free.top, laneHeight: hang.room, column: { top: free.top, content: 200, first: 120 }, laneLeft: laneLeft(free), besideRoom: free.width - 312, content: 900 });
    return { overlay: hang.room, lane: shared.lane, bar: shared.hang.room, width: hang.width };
  };

  test("480 x 320 at 130%, 47 px at the sides and 21 at the bottom", () => {
    const viewport = { width: 369, height: 246 };
    const safe = { top: 0, side: 47, bottom: 21 };
    assert.equal(freeArea(viewport, phone({ band: false, options: true, safe })).height, 44);
    assert.equal(freeArea(viewport, phone({ band: true, options: true, safe })).height, -4);
    assert.deepEqual(summary(phone({ band: false, options: true, safe }), viewport), { overlay: 157, lane: "summary", bar: 105, width: 259 });
    assert.deepEqual(summary(phone({ band: true, options: true, safe }), viewport), { overlay: 109, lane: "summary", bar: 57, width: 259 });
  });

  test("844 x 390 at 130%, the same insets: Multi-select's row stands in the toolbar's own row, so the bar docks", () => {
    const viewport = { width: 649, height: 300 };
    const safe = { top: 0, side: 47, bottom: 21 };
    const free = freeArea(viewport, phone({ band: false, options: "merged", safe }));
    assert.equal(free.height, 151);
    assert.equal(barMode(viewport, free.height), "dock");
    assert.deepEqual(summary(phone({ band: true, options: "merged", safe }), viewport), { overlay: 163, lane: "summary", bar: 111, width: 304 });
    // Docked, an alert's summary row leaves it the header and a row.
    const docked = shareLane({
      hang: spotHang(DEFAULT_SPOT, free, { width: 304, height: 400 }),
      laneTop: free.top,
      laneHeight: free.height,
      column: { top: free.top, content: 200, first: 120 },
      laneLeft: laneLeft(free),
      besideRoom: free.width - 312,
      content: 400,
    });
    assert.equal(docked.lane, "summary");
    assert.equal(docked.hang.room, 99);
  });

  test("320 x 480 at 130%, upright, 44 px at the top and 34 at the bottom", () => {
    const viewport = { width: 246, height: 369 };
    const safe = { top: 44, side: 0, bottom: 34 };
    assert.equal(freeArea(viewport, phone({ band: true, options: true, safe })).height, 62);
    assert.deepEqual(summary(phone({ band: true, options: true, safe }), viewport), { overlay: 175, lane: "summary", bar: 123, width: 230 });
    assert.equal(freeArea(viewport, phone({ band: false, options: true, safe })).height, 110);
    assert.deepEqual(summary(phone({ band: false, options: true, safe }), viewport), { overlay: 163, lane: "summary", bar: 111, width: 230 });
    assert.equal(compactHang(viewport, viewport, phone({ band: false, options: true, safe })).coversToolbar, false);
  });
});

describe("the default width (docs/design-v1-token-window.md 3.3)", () => {
  test("the narrowest that holds the three buttons on one line, rounded up plus a pixel, never under 304", () => {
    // Narrow buttons, as a small font draws them.
    assert.equal(defaultBarWidth([80, 60, 90]), BAR_WIDTH);
    // The system font on macOS: 26 + 99.1 + 74.1 + 107.4 + 8 = 314.6, up to 315, plus one.
    assert.equal(defaultBarWidth([99.1, 74.1, 107.4]), 316);
    assert.equal(defaultBarWidth([99.4, 74.3, 107.6]), 317);
    // Tahoma: 294 for the three and their gaps.
    assert.equal(defaultBarWidth([102, 77, 107]), 321);
    // A whole sum still gains its pixel, so sub-pixel rounding never wraps the row.
    assert.equal(defaultBarWidth([100, 75, 108]), 318);
  });

  test("every bar that does not span takes it: docked, compact and beside the lane", () => {
    const desk = { width: 1280, height: 800 };
    const chrome: Chrome = { ...DEFAULT_CHROME, top: 52, bottom: 60 };
    const docked = placeBar({ layout: desk, viewport: { width: 920, height: 800 }, chrome, foot: 0, anchor: null, spot: DEFAULT_SPOT, height: 300, column: null, width: 316 });
    assert.equal(docked?.mode, "dock");
    assert.equal(docked?.hang.width, 316);
    assert.equal(docked!.hang.left + 316, freeArea({ width: 920, height: 800 }, chrome).left + freeArea({ width: 920, height: 800 }, chrome).width);
    const short = { width: 844, height: 200 };
    const compact = placeBar({ layout: short, viewport: short, chrome, foot: 0, anchor: null, spot: DEFAULT_SPOT, height: 300, column: null, width: 316 });
    assert.equal(compact?.mode, "compact");
    assert.equal(compact?.hang.width, 316);
    assert.equal(compactHang(short, short, chrome, 316).width, 316);
    // Beside the lane, at most the room left of it.
    const column = { top: 60, content: 700, first: 700 };
    const beside = placeBar({ layout: desk, viewport: { width: 920, height: 800 }, chrome, foot: 0, anchor: null, spot: DEFAULT_SPOT, height: 300, column, width: 316 });
    assert.equal(beside?.lane, "beside");
    assert.equal(beside?.hang.width, 316);
    const narrow = { width: 600, height: 800 };
    const squeezed = placeBar({ layout: desk, viewport: narrow, chrome, foot: 0, anchor: null, spot: DEFAULT_SPOT, height: 300, column, width: 316 });
    assert.equal(squeezed?.lane, "beside");
    assert.equal(squeezed?.hang.width, freeArea(narrow, chrome).width - LANE_WIDTH);
    // Without a measure yet, 304.
    assert.equal(placeBar({ layout: desk, viewport: { width: 920, height: 800 }, chrome, foot: 0, anchor: null, spot: DEFAULT_SPOT, height: 300, column: null })?.hang.width, BAR_WIDTH);
    assert.equal(restingBar({ layout: desk, viewport: { width: 920, height: 800 }, chrome, spot: DEFAULT_SPOT, height: 300, column: null, width: 316 })?.box.width, 316);
  });
});

describe("the stored spot", () => {
  test("reads a valid spot, and anything else as the default", () => {
    assert.deepEqual(parseSpot('{"corner":"tl","x":120,"y":40}'), { corner: "tl", x: 120, y: 40 });
    assert.deepEqual(parseSpot('{"corner":"bl","x":0,"y":4096}'), { corner: "bl", x: 0, y: 4096 });
    for (const bad of [null, "", "{", "[]", "null", '"br"', '{"corner":"middle","x":0,"y":0}', '{"corner":"tr","x":1.5,"y":0}', '{"corner":"tr","x":-1,"y":0}', '{"corner":"tr","x":0,"y":4097}', '{"corner":"tr","x":"3","y":0}', '{"corner":"tr"}']) {
      assert.deepEqual(parseSpot(bad), DEFAULT_SPOT, String(bad));
    }
  });

  test("the default is stored as no key, and storage that throws reads as the default", () => {
    assert.equal(spotText(DEFAULT_SPOT), null);
    assert.equal(spotText({ corner: "br", x: 0, y: 1 }), '{"corner":"br","x":0,"y":1}');
    const kept = new Map<string, string>();
    const storage = { getItem: (k: string) => kept.get(k) ?? null, setItem: (k: string, v: string) => void kept.set(k, v), removeItem: (k: string) => void kept.delete(k) };
    writeSpot({ corner: "tl", x: 3, y: 4 }, storage);
    assert.equal(kept.get(SPOT_KEY), '{"corner":"tl","x":3,"y":4}');
    assert.deepEqual(readSpot(storage), { corner: "tl", x: 3, y: 4 });
    writeSpot(DEFAULT_SPOT, storage);
    assert.equal(kept.has(SPOT_KEY), false);
    const blocked = {
      getItem: (): string | null => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
      removeItem: () => {
        throw new Error("blocked");
      },
    };
    assert.deepEqual(readSpot(blocked), DEFAULT_SPOT);
    assert.doesNotThrow(() => writeSpot({ corner: "tl", x: 1, y: 1 }, blocked));
  });

  const free: Box = { left: 8, top: 60, width: 900, height: 600 };
  const bar = (left: number, top: number): Box => ({ left, top, width: 304, height: 200 });

  test("a drop takes the corner nearest the bar's center, and its gaps from that corner", () => {
    assert.deepEqual(releaseSpot(bar(8 + 120, 60 + 40), free), { corner: "tl", x: 120, y: 40 });
    assert.deepEqual(releaseSpot(bar(908 - 304 - 50, 60 + 40), free), { corner: "tr", x: 50, y: 40 });
    assert.deepEqual(releaseSpot(bar(8 + 70, 660 - 200 - 33.4), free), { corner: "bl", x: 70, y: 33 });
    assert.deepEqual(releaseSpot(bar(908 - 304 - 100, 660 - 200 - 100), free), { corner: "br", x: 100, y: 100 });
  });

  test("an edge within 24 px snaps to the free area's edge, so near the bottom right is the default again", () => {
    assert.deepEqual(releaseSpot(bar(8 + 24, 60 + 25), free), { corner: "tl", x: 0, y: 25 });
    const home = releaseSpot(bar(908 - 304 - 20, 660 - 200 - 10), free);
    assert.ok(isDefaultSpot(home));
    assert.equal(spotText(home), null);
  });

  test("a spot is clamped into a smaller area and comes back out when the room does, the stored spot untouched", () => {
    const spot = { corner: "tl" as const, x: 500, y: 300 };
    const size = { width: 304, height: 200 };
    assert.deepEqual(spotHang(spot, free, size), { left: 508, width: 304, anchor: "top", at: 360, room: 300 });
    const small: Box = { left: 8, top: 60, width: 600, height: 300 };
    const squeezed = spotHang(spot, small, size);
    assert.equal(squeezed.left, 8 + 296);
    assert.equal(squeezed.at, 60 + 100);
    assert.deepEqual(spotHang(spot, free, size), { left: 508, width: 304, anchor: "top", at: 360, room: 300 });
  });

  test("a bar in a bottom corner hangs by its bottom and grows upward, and one in a right corner follows the right edge", () => {
    const hang = spotHang({ corner: "br", x: 10, y: 20 }, free, { width: 304, height: 200 });
    assert.deepEqual(hang, { left: 908 - 10 - 304, width: 304, anchor: "bottom", at: 660 - 20, room: 580 });
    assert.deepEqual(hangBox(hang, 150), { left: 594, top: 490, width: 304, height: 150 });
    const narrower = spotHang({ corner: "br", x: 10, y: 20 }, { ...free, width: 560 }, { width: 304, height: 200 });
    assert.equal(narrower.left + narrower.width, 8 + 560 - 10);
  });

  test("a drag past every edge stays inside the free area", () => {
    assert.deepEqual(clampBox(bar(-500, -500), free), bar(8, 60));
    assert.deepEqual(clampBox(bar(5000, 5000), free), bar(908 - 304, 660 - 200));
  });

  test("a step of the grip's keys stores the nearest corner's spot, unsnapped, and clamped into the free area", () => {
    // The default spot's box, then three steps left: 24 px from the right, still the bottom right corner.
    const home = bar(908 - 304, 660 - 200);
    assert.deepEqual(keySpot(home, free), DEFAULT_SPOT);
    assert.deepEqual(keySpot({ ...home, left: home.left - 24 }, free), { corner: "br", x: 24, y: 0 });
    // An 8 px step off an edge stays off it: no 24 px snap.
    assert.deepEqual(keySpot({ ...home, top: home.top - 8 }, free), { corner: "br", x: 0, y: 8 });
    // Past the middle, the nearest corner changes, keeping the box where it is.
    assert.deepEqual(keySpot(bar(8 + 40, 60 + 30), free), { corner: "tl", x: 40, y: 30 });
    // A held key ends at the edge, never past it.
    assert.deepEqual(keySpot(clampBox({ ...home, left: home.left + 64 }, free), free), DEFAULT_SPOT);
    assert.deepEqual(arrowStep("ArrowLeft", false), { dx: -8, dy: 0 });
    assert.deepEqual(arrowStep("ArrowUp", true), { dx: 0, dy: -64 });
    assert.deepEqual(arrowStep("ArrowDown", false), { dx: 0, dy: 8 });
    assert.deepEqual(arrowStep("ArrowRight", true), { dx: 64, dy: 0 });
    assert.equal(arrowStep("Enter", false), null);
    // A drop still snaps within 24 px.
    assert.deepEqual(releaseSpot({ ...home, left: home.left - 24 }, free), DEFAULT_SPOT);
  });

  test("the status names a corner, an edge and the gap along it, or both gaps", () => {
    assert.equal(spotWords(DEFAULT_SPOT), "Window at bottom right");
    assert.equal(spotWords({ corner: "tl", x: 0, y: 0 }), "Window at top left");
    assert.equal(spotWords({ corner: "br", x: 24, y: 0 }), "Window at the bottom edge, 24 pixels from the right");
    assert.equal(spotWords({ corner: "tl", x: 0, y: 40 }), "Window at the left edge, 40 pixels from the top");
    assert.equal(spotWords({ corner: "br", x: 120, y: 40 }), "Window 120 pixels from the right and 40 pixels from the bottom");
  });

  test("a narrow window's header keeps one row: the badge moves to the vitals line first, then a touch device's grip becomes its dots, and narrower it folds (W5B-P-3)", () => {
    assert.equal(headerRowMin("button", true), 265);
    assert.equal(headerRowMin("button", false), 210);
    assert.equal(headerRowMin("dots", false), 182);
    assert.equal(WINDOW_FOLD_BELOW, 182);
    const touch = (width: number) => headerLayout(width, false);
    assert.deepEqual(touch(316), { grip: "button", badgeInHeader: true });
    assert.deepEqual(touch(265), { grip: "button", badgeInHeader: true });
    // 844 x 390 at 130% beside a sheet: 246 px. The grip stays a button, a badge goes under the name.
    assert.deepEqual(touch(264), { grip: "button", badgeInHeader: false });
    assert.deepEqual(touch(246), { grip: "button", badgeInHeader: false });
    assert.deepEqual(touch(210), { grip: "button", badgeInHeader: false });
    // 667 x 375 at 130%: 189 px. The dots, down to the fold.
    assert.deepEqual(touch(209), { grip: "dots", badgeInHeader: false });
    assert.deepEqual(touch(189), { grip: "dots", badgeInHeader: false });
    assert.deepEqual(touch(182), { grip: "dots", badgeInHeader: false });
    // A computer keeps the grip a button, the keys' control.
    assert.deepEqual(headerLayout(189, true), { grip: "button", badgeInHeader: false });
  });
});

describe("the window's size on a computer (docs/design-v1-token-window.md 5 and 6)", () => {
  test("held by a drag or a resize, a window keeps the edge its corner anchors, so content that shrinks moves only its far edge (W5-ASTRA-05)", () => {
    const viewport = { width: 920, height: 800 };
    const box = { left: 400, top: 300, width: 500, height: 432 };
    for (const corner of ["br", "bl"] as const) assert.deepEqual(heldPlace(box, corner, viewport), { left: 400, width: 500, maxHeight: 432, bottom: 800 - 732 });
    for (const corner of ["tr", "tl"] as const) assert.deepEqual(heldPlace(box, corner, viewport), { left: 400, width: 500, maxHeight: 432, top: 300 });
  });

  test("the size key reads a width, a height or both, and anything else as the default, stored as no key", () => {
    assert.deepEqual(parseSize('{"w":400,"h":300}'), { w: 400, h: 300 });
    assert.deepEqual(parseSize('{"w":400}'), { w: 400 });
    assert.deepEqual(parseSize('{"h":300}'), { h: 300 });
    assert.deepEqual(parseSize('{"w":1,"h":4096}'), { w: 1, h: 4096 });
    for (const bad of [null, "", "{", "[]", "null", "{}", '"400"', '{"w":1.5}', '{"w":-1}', '{"w":0}', '{"w":4097}', '{"w":"400"}', '{"w":400,"h":0}', '{"x":3}']) {
      assert.deepEqual(parseSize(bad), NO_SIZE, String(bad));
    }
    assert.equal(sizeText(NO_SIZE), null);
    assert.equal(sizeText({ w: 400 }), '{"w":400}');
    assert.equal(sizeText({ w: 400, h: 300 }), '{"w":400,"h":300}');
    const kept = new Map<string, string>();
    const storage = { getItem: (k: string) => kept.get(k) ?? null, setItem: (k: string, v: string) => void kept.set(k, v), removeItem: (k: string) => void kept.delete(k) };
    writeSize({ h: 300 }, storage);
    assert.equal(kept.get(SIZE_KEY), '{"h":300}');
    assert.deepEqual(readSize(storage), { h: 300 });
    writeSize(NO_SIZE, storage);
    assert.equal(kept.has(SIZE_KEY), false);
    const blocked = {
      getItem: (): string | null => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
      removeItem: () => {
        throw new Error("blocked");
      },
    };
    assert.deepEqual(readSize(blocked), NO_SIZE);
    assert.doesNotThrow(() => writeSize({ w: 1 }, blocked));
  });

  // 1280 x 800 with the side panel shown: a 920 px map, its free area 904 x 672 from (8, 60).
  const chrome: Chrome = { ...DEFAULT_CHROME, top: 52, bottom: 60 };
  const base = { layout: { width: 1280, height: 800 }, viewport: { width: 920, height: 800 }, chrome, foot: 0, anchor: null, spot: DEFAULT_SPOT, column: null, width: 316 };
  const boxOf = (placed: ReturnType<typeof placeBar>, height: number) => hangBox(placed!.hang, height);

  test("the width is the stored one, never under the default, at most the room, and the height a cap after everything else", () => {
    const plain = placeBar({ ...base, height: 548, resizable: true });
    assert.deepEqual(boxOf(plain, 548), { left: 912 - 316, top: 732 - 548, width: 316, height: 548 });
    // The free sides of a resizable window keep 12 px for its handle: its room is 4 px less at the top.
    assert.equal(plain!.hang.room, 668);
    assert.deepEqual(plain!.room, { left: 12, top: 64, width: 900, height: 668 });
    const sized = placeBar({ ...base, height: 548, resizable: true, size: { w: 600, h: 400 } });
    assert.deepEqual(boxOf(sized, 548), { left: 912 - 600, top: 732 - 400, width: 600, height: 400 });
    // The largest: the room, 12 px from the free area's far edges and 8 from its anchored ones.
    const largest = placeBar({ ...base, height: 2000, resizable: true, size: { w: 4096, h: 4096 } });
    assert.deepEqual(boxOf(largest, 2000), { left: 12, top: 64, width: 900, height: 668 });
    assert.equal(placeBar({ ...base, height: 548, resizable: true, size: { w: 200 } })!.hang.width, 316, "never under the default width");
    assert.deepEqual(boxOf(placeBar({ ...base, height: 548, resizable: true, size: { w: 1, h: 1 } }), 548), { left: 912 - 316, top: 732 - 152, width: 316, height: 152 }, "the smallest: the default width by 152");
    // At the top left, the far sides are the right and the bottom.
    const topLeft = placeBar({ ...base, spot: { corner: "tl", x: 0, y: 0 }, height: 2000, resizable: true, size: { w: 4096, h: 4096 } });
    assert.deepEqual(boxOf(topLeft, 2000), { left: 8, top: 60, width: 900, height: 668 });
    // A touch device keeps today's sizes, and the stored size stays stored.
    const touch = placeBar({ ...base, height: 548, resizable: false, size: { w: 600, h: 200 } });
    assert.deepEqual(boxOf(touch, 548), { left: 912 - 316, top: 732 - 548, width: 316, height: 548 });
    assert.equal(touch!.hang.room, 672);
    // Compact ignores it too.
    const short = { width: 844, height: 200 };
    const compact = placeBar({ ...base, layout: short, viewport: short, height: 300, resizable: true, size: { w: 600, h: 100 } });
    assert.equal(compact!.mode, "compact");
    assert.equal(compact!.hang.width, 316);
    assert.equal(compact!.resizable, false);
    assert.equal(compact!.hang.room, compactHang(short, short, chrome, 316).room);
  });

  test("the cap applies after the lane, stacked, beside and summarized, and a window the lane moves down keeps min(content, cap)", () => {
    // Stacked under a 150 px first card: 12 px below it for a resizable window whose top is free, 8 for a touch one.
    const column = { top: 60, content: 300, first: 150 };
    const stacked = placeBar({ ...base, column, height: 548, resizable: true, size: { h: 400 } });
    assert.equal(stacked!.lane, "stacked");
    assert.deepEqual(boxOf(stacked, 548), { left: 912 - 316, top: 732 - 400, width: 316, height: 400 });
    const tall = placeBar({ ...base, column, height: 2000, resizable: true });
    assert.equal(boxOf(tall, 2000).top, 60 + 150 + 12);
    assert.equal(boxOf(placeBar({ ...base, column, height: 2000, resizable: false }), 2000).top, 60 + 150 + 8);
    // Raised 200 px in its corner, the lane moves it down: it keeps min(content, cap) of height.
    const raised = placeBar({ ...base, spot: { corner: "br", x: 0, y: 200 }, column, height: 548, resizable: true, size: { h: 400 } });
    assert.equal(boxOf(raised, 548).height, 400);
    assert.ok(boxOf(raised, 548).top >= 60 + 150 + 12);
    // Beside the lane, at most the room left of it, 12 px from the free area's left edge.
    const deep = { top: 60, content: 700, first: 700 };
    const beside = placeBar({ ...base, column: deep, height: 548, resizable: true, size: { w: 600, h: 300 } });
    assert.equal(beside!.lane, "beside");
    assert.deepEqual(boxOf(beside, 548), { left: 12, top: 732 - 300, width: 600 - 12, height: 300 });
    // Summarized on a narrow map, the cap still applies.
    const narrow = { width: 540, height: 800 };
    const summary = placeBar({ ...base, viewport: narrow, column: deep, height: 548, resizable: true, size: { h: 200 } });
    assert.equal(summary!.lane, "summary");
    assert.equal(boxOf(summary, 548).height, 200);
    // Where a pan expects it: the same box.
    const rest = restingBar({ ...base, column, height: 548, resizable: true, size: { h: 400 } });
    assert.deepEqual(rest!.box, boxOf(stacked, 548));
  });

  test("a resize keeps the edges at the spot's corner and moves the far ones, within its limits, from every corner", () => {
    const room = { left: 12, top: 64, width: 900, height: 668 };
    const start = { left: 596, top: 184, width: 316, height: 548 };
    const limits = resizeLimits({ box: start, corner: "br", room, defaultWidth: 316, content: 548 });
    assert.deepEqual(limits, { minWidth: 316, maxWidth: 900, minHeight: 152, maxHeight: 548 });
    const at = (corner: Corner, part: ResizePart, dx: number, dy: number, box = start, l = limits) => resizeBox({ start: box, corner, part, dx, dy, limits: l });
    assert.deepEqual(at("br", "corner", -100, 200), { left: 496, top: 384, width: 416, height: 348 });
    assert.deepEqual(at("br", "corner", 100, -50), start, "no narrower than the default, no taller than the content");
    assert.deepEqual(at("br", "width", -100, 200), { ...start, left: 496, width: 416 }, "a band changes one dimension");
    assert.deepEqual(at("br", "height", -100, 200), { ...start, top: 384, height: 348 });
    assert.deepEqual(at("br", "corner", -5000, 5000), { left: 12, top: 732 - 152, width: 900, height: 152 }, "the room and the shortest");
    const corner = { left: 100, top: 100, width: 316, height: 300 };
    const loose = { minWidth: 316, maxWidth: 800, minHeight: 148, maxHeight: 500 };
    assert.deepEqual(at("tl", "corner", 100, 100, corner, loose), { left: 100, top: 100, width: 416, height: 400 });
    assert.deepEqual(at("tr", "corner", -100, 100, corner, loose), { left: 0, top: 100, width: 416, height: 400 });
    assert.deepEqual(at("bl", "corner", 100, -100, corner, loose), { left: 100, top: 0, width: 416, height: 400 });
    assert.equal(handleCorner("br"), "tl");
    assert.equal(handleCorner("tl"), "br");
    assert.equal(handleCorner("tr"), "bl");
    assert.equal(handleCorner("bl"), "tr");
    // A room narrower than the default leaves the room as the narrowest, and content under 152 px the shortest.
    assert.equal(resizeLimits({ box: start, corner: "br", room: { ...room, left: 912 - 250, width: 250 }, defaultWidth: 316, content: 548 }).minWidth, 250);
    assert.equal(resizeLimits({ box: start, corner: "br", room, defaultWidth: 316, content: 120 }).minHeight, 120);
  });

  test("on release, a dimension changed by no more than the slop keeps its stored value, near-defaults store none, and the spot comes from the drawn box", () => {
    const start = { left: 12, top: 184, width: 900, height: 548 };
    const release = (box: Partial<Box>, stored: BarSize = NO_SIZE) => releaseSize({ stored, start, box: { ...start, ...box }, defaultWidth: 316, tallest: 548 });
    // A stored width clamped to 900 is never written down as 900.
    assert.deepEqual(release({ height: 400 }, { w: 1100 }), { w: 1100, h: 400 });
    assert.deepEqual(release({ width: 905 }, { w: 1100 }), { w: 1100 });
    assert.deepEqual(release({ width: 340 }), {}, "24 px from the default stores none");
    assert.deepEqual(release({ width: 341 }), { w: 341 }, "25 px stores the width");
    assert.deepEqual(release({ width: 400.4, height: 524 }), { w: 400 }, "24 px from the most it may take stores no height");
    assert.deepEqual(release({ width: 400, height: 523 }), { w: 400, h: 523 });
    assert.equal(sizeText(release({ width: 320, height: 540 })), null, "both at their defaults: no key");
    const free = { left: 8, top: 60, width: 904, height: 672 };
    assert.deepEqual(anchoredSpot({ left: 596, top: 384, width: 316, height: 348 }, free, "br"), DEFAULT_SPOT);
    assert.deepEqual(anchoredSpot({ left: 400.4, top: 300, width: 316, height: 348 }, free, "br"), { corner: "br", x: 196, y: 84 }, "no snap");
    assert.deepEqual(anchoredSpot({ left: 20, top: 70, width: 316, height: 348 }, free, "tl"), { corner: "tl", x: 12, y: 10 });
  });

  test("a key step of the handle stores what it changed, unsnapped, and the status names the size and any limit met", () => {
    const start = { left: 596, top: 184, width: 316, height: 548 };
    const keys = (box: Partial<Box>, stored: BarSize = NO_SIZE) => keySize({ stored, start, box: { ...start, ...box }, defaultWidth: 316, tallest: 548 });
    assert.deepEqual(keys({ left: 588, width: 324 }), { w: 324 });
    assert.deepEqual(keys({ left: 588, width: 324 }, { h: 300 }), { w: 324, h: 300 }, "the other dimension keeps its value");
    assert.deepEqual(keys({ top: 192, height: 540 }), { h: 540 }, "8 px stores the height, no snap");
    const wide = { ...start, left: 588, width: 324 };
    assert.deepEqual(keySize({ stored: { w: 324 }, start: wide, box: start, defaultWidth: 316, tallest: 548 }), {}, "back exactly at the default stores none");
    const shorter = { ...start, top: 192, height: 540 };
    assert.deepEqual(keySize({ stored: { h: 540 }, start: shorter, box: start, defaultWidth: 316, tallest: 548 }), {}, "back at the tallest stores none");
    const limits = { minWidth: 316, maxWidth: 900, minHeight: 148, maxHeight: 548 };
    const met = (dx: number, dy: number, box = start) => limitMet({ start: box, box, dx, dy, corner: "br", limits });
    assert.equal(met(8, 0), "narrowest");
    assert.equal(met(0, -8), "tallest");
    assert.equal(met(-8, 0, { ...start, width: 900 }), "widest");
    assert.equal(met(0, 8, { ...start, height: 148 }), "shortest");
    assert.equal(met(-8, 0, { ...start, width: 400 }), null);
    assert.equal(sizeWords({ width: 316, height: 400 }, null), "Window 316 by 400 pixels");
    assert.equal(sizeWords({ width: 316, height: 400 }, "narrowest"), "Window 316 by 400 pixels, narrowest it can be here");
    assert.equal(sizeWords({ width: 900.2, height: 668 }, "tallest"), "Window 900 by 668 pixels, tallest it can be here");
    // Spoken in full: "px" reads as two letters on several screen readers.
    assert.equal(pixels(1), "1 pixel");
    assert.equal(pixels(24.4), "24 pixels");
  });

  test("a move by pointer or key is clamped into the room, the handle's reach on its free sides", () => {
    const free = { left: 8, top: 60, width: 904, height: 672 };
    // Nearest the bottom right: the free sides are the top and the left.
    assert.deepEqual(moveRoom({ left: 590, top: 300, width: 316, height: 400 }, free, true), { left: 12, top: 64, width: 900, height: 668 });
    assert.deepEqual(moveRoom({ left: 20, top: 70, width: 316, height: 200 }, free, true), { left: 8, top: 60, width: 900, height: 668 });
    assert.deepEqual(moveRoom({ left: 20, top: 70, width: 316, height: 200 }, free, false), free, "a touch device keeps 8 all round");
    // A wide window nearest the bottom right, pushed toward its free left side: 12 px from the free area's edge, and its anchored sides at 8.
    assert.deepEqual(clampMove({ left: 11, top: 300, width: 900, height: 400 }, free, true), { left: 12, top: 300, width: 900, height: 400 });
    assert.deepEqual(clampMove({ left: 11, top: 300, width: 900, height: 400 }, free, false), { left: 11, top: 300, width: 900, height: 400 });
    // Pushed up past the middle, its top becomes an anchored side: 8 px, as a window at a top corner keeps.
    assert.equal(clampMove({ left: 590, top: 0, width: 316, height: 400 }, free, true).top, 60);
  });
});

describe("the right lane", () => {
  const free: Box = { left: 8, top: 60, width: 904, height: 672 };
  const laneTop = free.top;
  const lane = { laneTop, laneHeight: free.height, laneLeft: laneLeft(free), besideRoom: free.width - 312, content: 900 };
  const home: Hang = spotHang(DEFAULT_SPOT, free, { width: 304, height: 900 });

  test("with no column there is no gap, and the bar takes the whole lane", () => {
    assert.deepEqual(shareLane({ ...lane, hang: home, column: null }), { lane: "none", hang: home });
    assert.deepEqual(shareLane({ ...lane, hang: home, column: { top: laneTop, content: 0, first: 0 } }), { lane: "none", hang: home });
    assert.equal(home.room, 672);
  });

  test("stacked: the column keeps its first card and the bar sits 8 px under it, down to its floor", () => {
    const column = { top: laneTop, content: 900, first: 140 };
    const shared = shareLane({ ...lane, hang: home, column });
    assert.equal(shared.lane, "stacked");
    assert.equal(shared.hang.room, 672 - 148);
    assert.equal(hangBox(shared.hang, 2000).top, laneTop + 148);
    assert.equal(columnRoom({ lane: "stacked", columnTop: laneTop, bar: hangBox(shared.hang, 2000) }), 140);
    // A short bar leaves the column more of the lane.
    const short = hangBox(shareLane({ ...lane, hang: home, column }).hang, 200);
    assert.equal(columnRoom({ lane: "stacked", columnTop: laneTop, bar: short }), 672 - 200 - 8);
    // The first card may take all but the floor.
    const tall = shareLane({ ...lane, hang: home, column: { ...column, first: 672 - 8 - 120 } });
    assert.equal(tall.lane, "stacked");
    assert.equal(tall.hang.room, 120);
  });

  test("a bar dropped on the column is pushed under its first card", () => {
    const dropped = spotHang({ corner: "tr", x: 0, y: 10 }, free, { width: 304, height: 200 });
    const shared = shareLane({ ...lane, hang: dropped, column: { top: laneTop, content: 300, first: 150 } });
    assert.equal(shared.lane, "stacked");
    assert.equal(shared.hang.at, laneTop + 158);
    assert.equal(shared.hang.room, 672 - 158);
  });

  test("a bar hung by its bottom moves down under a tall first card instead of shrinking, as far as the lane's bottom", () => {
    const short: Box = { left: 8, top: 60, width: 904, height: 400 };
    const column = { top: 60, content: 300, first: 272 };
    const at = { laneTop: 60, laneHeight: 400, column, laneLeft: laneLeft(short), besideRoom: short.width - 312 };
    // A bottom right spot 80 px up: the first card ends at 340, and the lane at 460.
    const raised = spotHang({ corner: "br", x: 0, y: 80 }, short, { width: 304, height: 300 });
    assert.equal(raised.at, 380);
    const tall = shareLane({ ...at, hang: raised, content: 300 });
    assert.equal(tall.lane, "stacked");
    assert.deepEqual({ at: tall.hang.at, room: tall.hang.room }, { at: 460, room: 120 }, "the bar keeps its floor at the lane's bottom");
    const shorter = shareLane({ ...at, hang: raised, content: 100 });
    assert.deepEqual({ at: shorter.hang.at, room: shorter.hang.room }, { at: 440, room: 100 }, "a short bar moves down only as far as it needs");
    const clear = shareLane({ ...at, hang: raised, content: 30 });
    assert.deepEqual({ at: clear.hang.at, room: clear.hang.room }, { at: 380, room: 40 }, "a bar already clear of the card stays where it is");
  });

  test("an upright span keeps below the column's first card and never covers its token, above it or below it", () => {
    // The DM at 390 x 844 with one 122 px check: the bar may reach up to 190, and the token sits low on the screen.
    const chrome: Chrome = { top: 52, bottom: 60, controls: 60, toolbar: 60, safe: NONE, sheet: 0 };
    const phoneView = { width: 390, height: 844 };
    const column = { top: 60, content: 122, first: 122 };
    for (const y of [300, 440, 480, 520, 560, 700]) {
      for (const height of [200, 418, 900]) {
        const placed = placeBar({ layout: phoneView, viewport: phoneView, chrome, foot: 0, anchor: { x: 200, y }, spot: DEFAULT_SPOT, height, column });
        assert.ok(placed && placed.mode === "span");
        const box = hangBox(placed.hang, height);
        // The token stands in the 74 px above the anchor (FLIP_CLEARANCE and OFFSET_Y), its label in the 34 below.
        const clear = box.top + box.height <= y - 74 + 0.5 || box.top >= y + 34 - 0.5;
        assert.ok(clear, `a ${height} px bar over a token at ${y}: ${JSON.stringify(box)}`);
        assert.ok(box.top >= 190 - 0.5, `the bar reaches over the check: ${JSON.stringify(box)}`);
        assert.ok(box.top + box.height <= 844 - 60 - 8 + 0.5, "the bar runs under the toolbar");
      }
    }
    // With room on both sides it takes the side with more of it, and with no card it may reach to the top bars again.
    const low = placeBar({ layout: phoneView, viewport: phoneView, chrome, foot: 0, anchor: { x: 200, y: 560 }, spot: DEFAULT_SPOT, height: 418, column });
    assert.equal(low?.hang.anchor, "bottom");
    assert.equal(hangBox(low!.hang, 418).top, 190);
    const bare = placeBar({ layout: phoneView, viewport: phoneView, chrome, foot: 0, anchor: { x: 200, y: 560 }, spot: DEFAULT_SPOT, height: 418, column: null });
    assert.equal(hangBox(bare!.hang, 418).top, 560 - 74 - 418);
    // Where neither side leaves its floor, as at 320 x 480 at 130% under a check's summary row, it keeps the floor rather than shrink to nothing.
    const tiny = { width: 246, height: 369 };
    const cramped = placeBar({ layout: tiny, viewport: tiny, chrome: phone({ band: false, options: false, safe: { top: 44, side: 0, bottom: 34 } }), foot: 0, anchor: { x: 60, y: 230 }, spot: DEFAULT_SPOT, height: 400, column: { top: 104, content: 140, first: 140 } });
    assert.equal(cramped?.lane, "summary");
    assert.equal(cramped?.hang.room, 111, "the floor, all the lane under the summary row");
  });

  test("beside at exactly 230 px left of the lane, and the summary row at 229", () => {
    const short: Box = { left: 8, top: 60, width: 312 + BESIDE_MIN, height: 200 };
    const hang = spotHang(DEFAULT_SPOT, short, { width: 304, height: 400 });
    const column = { top: 60, content: 200, first: 150 };
    const beside = shareLane({ hang, laneTop: 60, laneHeight: 200, column, laneLeft: laneLeft(short), besideRoom: BESIDE_MIN, content: 400 });
    assert.equal(beside.lane, "beside");
    assert.deepEqual({ left: beside.hang.left, width: beside.hang.width, room: beside.hang.room }, { left: 8, width: 230, room: 200 });
    assert.equal(overlapsLane(beside.hang, short), false, "a bar beside the lane leaves the column the lane whole");
    const narrower: Box = { ...short, width: 312 + BESIDE_MIN - 1 };
    const summary = shareLane({ hang: spotHang(DEFAULT_SPOT, narrower, { width: 304, height: 400 }), laneTop: 60, laneHeight: 200, column, laneLeft: laneLeft(narrower), besideRoom: BESIDE_MIN - 1, content: 400 });
    assert.equal(summary.lane, "summary");
    assert.equal(summary.hang.room, 200 - 52);
    assert.equal(columnRoom({ lane: "summary", columnTop: 60, bar: hangBox(summary.hang, 400) }), 44);
  });

  test("a lane of 0 or less gives a defined, empty result", () => {
    for (const height of [0, -20]) {
      const hang: Hang = { left: 0, width: 230, anchor: "bottom", at: 60 + height, room: 0 };
      const shared = shareLane({ hang, laneTop: 60, laneHeight: height, column: { top: 60, content: 100, first: 80 }, laneLeft: -82, besideRoom: -82, content: 300 });
      assert.equal(shared.lane, "summary");
      assert.equal(shared.hang.room, 0);
      assert.equal(hangBox(shared.hang, 300).height, 0);
    }
  });

  test("a bar that does not overlap the lane across changes nothing", () => {
    const left = spotHang({ corner: "bl", x: 0, y: 0 }, free, { width: 304, height: 300 });
    assert.equal(overlapsLane(left, free), false);
    assert.equal(overlapsLane(home, free), true);
  });

  test("hidden cards keep their heights at the column's new top, so a band or a notice that moves the summary row moves the bar too", () => {
    const shown = columnFacts(null, { top: 60, measured: { content: 300, first: 150 } });
    assert.deepEqual(shown, { top: 60, content: 300, first: 150 });
    assert.equal(columnFacts(shown, { top: 60, measured: { content: 300, first: 150 } }), shown, "nothing changed, the same object");
    // Summarized: the cards are hidden, and the band arrives, 48 px down.
    const moved = columnFacts(shown, { top: 108, measured: null });
    assert.deepEqual(moved, { top: 108, content: 300, first: 150 });
    assert.equal(columnFacts(moved, { top: 108, measured: null }), moved);
    assert.equal(columnFacts(null, { top: 108, measured: null }), null, "nothing measured yet stays nothing");
    assert.equal(columnFacts(moved, { top: 108, measured: { content: 0, first: 0 } }), null, "a drawn column with no card publishes none");
    // A summary row beside a compact bar: the row moves with the top, and the bar keeps below it.
    const free: Box = { left: 55, top: 60, width: 259, height: 157 };
    const hang = compactHang({ width: 369, height: 246 }, { width: 369, height: 246 }, phone({ band: false, options: true, safe: { top: 0, side: 47, bottom: 21 } }));
    const at = (column: { top: number; content: number; first: number }) =>
      hangBox(shareLane({ hang, laneTop: free.top, laneHeight: hang.room, column, laneLeft: laneLeft(free), besideRoom: free.width - 312, content: 300 }).hang, 300).top;
    assert.equal(at(moved), 108 + 52, "the bar starts under the row where it is now");
  });

  test("the column starts below lasting notices only, and toasts never move it", () => {
    assert.equal(columnTop(60, null), 60);
    assert.equal(columnTop(60, 40), 60);
    assert.equal(columnTop(60, 120), 128);
  });

  test("notices center left of the lane from 320 px, and span below that", () => {
    assert.deepEqual(noticePlace({ left: 8, top: 60, width: 312 + 320, height: 400 }), { left: 8, width: 320 });
    assert.equal(noticePlace({ left: 8, top: 60, width: 312 + 319, height: 400 }), null);
  });
});

describe("a map pane drawn as a card and the lane (docs/design-v1-look-pass-2.md 2.8)", () => {
  const chrome: Chrome = { top: 52, bottom: 60, controls: 60, toolbar: 60, safe: NONE, sheet: 0 };
  const column = { top: 60, content: 300, first: 160 };

  test("beside where the room left of the lane holds the pane and both its margins, else the summary row", () => {
    assert.equal(paneLane({ laneLeft: 296 + 16, roomLeft: 0, width: 296 }), "beside");
    assert.equal(paneLane({ laneLeft: 296 + 15, roomLeft: 0, width: 296 }), "summary");
    assert.equal(paneLane({ laneLeft: 296 + 16 + 40, roomLeft: 40, width: 296 }), "beside", "from the room's own left edge");
  });

  test("the lane is the token window's, and its top where the column's row stands", () => {
    assert.deepEqual(paneLaneBox({ viewport: { width: 1440, height: 900 }, chrome, column, folded: false }), { left: 1440 - EDGE - LANE_WIDTH, top: 60 });
    assert.deepEqual(paneLaneBox({ viewport: { width: 1440, height: 900 }, chrome, column: { ...column, row: 12 }, folded: false }), { left: 1440 - EDGE - LANE_WIDTH, top: 12 }, "a row risen over the bars");
    // A phone's sheet on the right in landscape: the column steps left of it, and the lane with it.
    assert.deepEqual(paneLaneBox({ viewport: { width: 844, height: 390 }, chrome: { ...chrome, sheet: 340 }, column, folded: false }), { left: 844 - 340 - EDGE - LANE_WIDTH, top: 60 });
    // The right safe area takes its share.
    assert.equal(paneLaneBox({ viewport: { width: 844, height: 390 }, chrome: { ...chrome, safe: { ...NONE, right: 47 } }, column, folded: false })?.left, 844 - 47 - EDGE - LANE_WIDTH);
  });

  test("no lane with no card, before the chrome is measured, or with the column folded under a sheet", () => {
    const viewport = { width: 1440, height: 900 };
    assert.equal(paneLaneBox({ viewport, chrome, column: null, folded: false }), null);
    assert.equal(paneLaneBox({ viewport, chrome: null, column, folded: false }), null);
    assert.equal(paneLaneBox({ viewport, chrome, column, folded: true }), null);
  });
});

describe("fit and find keep clear of the bar", () => {
  const viewport = { width: 920, height: 800 };
  const bars = { top: 52, right: 0, bottom: 60, left: 0 };
  const lane = 920 - 8 - 312;

  test("a bar in the lane covers the lane's side, whatever its height", () => {
    for (const height of [120, 300, 600]) {
      const cover = barCover(viewport, bars, { box: { left: lane + 8, top: 732 - height, width: 304, height }, laneLeft: lane, freeRight: 912 });
      assert.deepEqual(cover, { top: 0, right: 320, bottom: 0, left: 0 });
    }
  });

  test("a bar elsewhere covers the side that leaves the largest clear rectangle", () => {
    const at = (left: number, top: number, width = 304, height = 200) => barCover(viewport, bars, { box: { left, top, width, height }, laneLeft: lane, freeRight: 912 });
    assert.deepEqual(at(8, 300), { top: 0, right: 0, bottom: 0, left: 312 });
    assert.deepEqual(at(400, 300, 304, 200).right, 520);
    assert.deepEqual(at(8, 60, 900, 150), { top: 210, right: 0, bottom: 0, left: 0 });
    assert.deepEqual(at(8, 580, 900, 150), { top: 0, right: 0, bottom: 220, left: 0 });
  });

  test("a window against the free area's right edge covers the right side from its own left edge when wider than the lane, and the lane when narrower, whatever its height (docs/design-v1-token-window.md 9.1)", () => {
    const right = (width: number, top: number, height: number) => barCover(viewport, bars, { box: { left: 912 - width, top, width, height }, laneLeft: lane, freeRight: 912 });
    for (const [top, height] of [[60, 120], [400, 332], [60, 672]] as const) {
      assert.deepEqual(right(316, top, height), { top: 0, right: 920 - (912 - 316), bottom: 0, left: 0 });
      assert.deepEqual(right(600, top, height), { top: 0, right: 920 - (912 - 600), bottom: 0, left: 0 });
      assert.deepEqual(right(300, top, height), { top: 0, right: 320, bottom: 0, left: 0 });
    }
    // Off the right edge and out of the lane, as before: the largest clear rectangle.
    assert.deepEqual(barCover(viewport, bars, { box: { left: 400, top: 300, width: 316, height: 200 }, laneLeft: lane, freeRight: 912 }).right, 520);
  });

  test("no box covers nothing", () => {
    assert.deepEqual(barCover(viewport, bars, null), NONE);
  });

  test("a cover counts past the bars, and a pan lands in what it leaves", () => {
    assert.deepEqual(pastBars({ top: 30, right: 320, bottom: 100, left: 0 }, bars), { top: 0, right: 320, bottom: 40, left: 0 });
    const cover = { ...NONE, right: 320 };
    assert.deepEqual(clearAnchor({ x: 460, y: 400 }, viewport, bars, cover), { x: 300, y: 400 });
    assert.deepEqual(clearAnchor({ x: 460, y: 400 }, viewport, bars, NONE), { x: 460, y: 400 });
  });

  test("a bar about to open rests at its spot with the height it last had, and a spanning one has no place yet", () => {
    const chrome: Chrome = { top: 52, bottom: 60, controls: 60, toolbar: 60, safe: NONE, sheet: 0 };
    const rest = restingBar({ layout: { width: 1280, height: 800 }, viewport, chrome, spot: DEFAULT_SPOT, height: 250, column: null });
    assert.deepEqual(rest, { box: { left: 920 - 8 - 304, top: 800 - 60 - 8 - 250, width: 304, height: 250 }, laneLeft: lane, freeRight: 912 });
    assert.equal(restingBar({ layout: { width: 390, height: 844 }, viewport: { width: 390, height: 844 }, chrome, spot: DEFAULT_SPOT, height: 250, column: null }), null);
  });

  test("a bar about to open shares the lane with the column as the drawn bar will, so a pan never lands a token under it", () => {
    // 1180 x 390: an 820 px map, and a 150 px first card leaves the bar too little under it, so it moves beside the lane.
    const chrome: Chrome = { top: 52, bottom: 60, controls: 60, toolbar: 60, safe: NONE, sheet: 0 };
    const map = { width: 820, height: 390 };
    const column = { top: 60, content: 150, first: 150 };
    const input = { layout: { width: 1180, height: 390 }, viewport: map, chrome, spot: DEFAULT_SPOT, height: 300, foot: 0, column };
    const rest = restingBar(input);
    const drawn = placeBar({ ...input, anchor: { x: 400, y: 200 } });
    assert.ok(rest && drawn);
    assert.equal(drawn.lane, "beside");
    assert.deepEqual(rest.box, hangBox(drawn.hang, 300));
    assert.equal(rest.box.left + rest.box.width, 820 - 8 - 312, "the resting bar sits left of the lane, where the drawn one will");
  });
});

describe("the alerts column's summary row on a short screen", () => {
  // 480 x 320 at 130% as layout px: the row's usual place is 60 to 104, under a 52 px top bar.
  const row = { left: 55, right: 314, top: 60, height: 44 };
  const base = { minLeft: 20, ceiling: 0, taken: [], controls: [], gap: 8, minWidth: 44 };

  test("keeps its place while the tool's buttons stand below it", () => {
    assert.deepEqual(raisedRow({ ...base, row, floor: 140 }), { top: 60, left: 55, right: 314 });
  });

  test("rises just above the tool's buttons, stopping 8 px left of End turn in the band and sliding left over the band's name", () => {
    const endTurn = { left: 220, top: 58, right: 300, bottom: 102 };
    assert.deepEqual(raisedRow({ ...base, row: { ...row, top: 108 }, floor: 132, controls: [endTurn] }), { top: 88, left: 20, right: 212 });
  });

  test("never meets a lasting notice, and rises over the top bar's row past it, short of its buttons", () => {
    const notice = { top: 52, bottom: 126 };
    const find = { left: 280, top: 4, right: 324, bottom: 48 };
    assert.deepEqual(raisedRow({ ...base, row: { ...row, top: 134 }, floor: 113, taken: [notice], controls: [find] }), { top: 8, left: 20, right: 272 });
  });

  test("its tap shows the cards in the column where the first fits whole down to the toolbar, and over the screen otherwise", () => {
    // The column's room from its usual top, its 8 px top padding included, and the room in the alerts' body over the screen down to the toolbar.
    assert.equal(askedAlerts({ first: 80, column: 113, overlay: 100 }), "column");
    assert.equal(askedAlerts({ first: 105, column: 113, overlay: 100 }), "column");
    assert.equal(askedAlerts({ first: 100, column: 98, overlay: 100 }), "overlay");
    assert.equal(askedAlerts({ first: 121, column: 113, overlay: 100 }), "fullScreen", "a check at 480 x 320 at 130% with the Ruler");
    assert.equal(askedAlerts({ first: 121, column: -12, overlay: 100 }), "fullScreen", "under the Starting view notice, which reaches past the toolbar's top");
  });

  test("with no spot above the tool's buttons, as when capped options scroll, the caller lets the floor go and takes the highest spot left of the top bar's buttons", () => {
    const find = { left: 280, top: 4, right: 324, bottom: 48 };
    const input = { ...base, row, floor: 38, controls: [find] };
    assert.equal(raisedRow(input), null);
    assert.deepEqual(raisedRow({ ...input, floor: Infinity, highest: true }), { top: 0, left: 20, right: 272 });
  });

  test("takes the rightmost gap between the top bar's buttons wide enough, over the room's name or a chip that is not a button, and is null with none", () => {
    const notice = { top: 52, bottom: 126 };
    const atItsLeft = { left: 60, top: 0, right: 104, bottom: 52 };
    assert.deepEqual(raisedRow({ ...base, row: { ...row, top: 134 }, floor: 113, taken: [notice], controls: [atItsLeft] }), { top: 8, left: 112, right: 314 });
    // A DM's top bar on a wide phone: the turn strip spans the row's own place, so it moves left to the gap between the DM chip and the strip.
    const wide = { left: 300, right: 600, top: 60, height: 44 };
    const chip = { left: 180, top: 4, right: 230, bottom: 48 };
    const strip = { left: 320, top: 4, right: 620, bottom: 48 };
    assert.deepEqual(raisedRow({ ...base, row: wide, floor: 50, controls: [chip, strip], highest: true }), { top: 0, left: 238, right: 312 });
    const wall = { left: 0, top: 0, right: 700, bottom: 52 };
    assert.equal(raisedRow({ ...base, row: { ...row, top: 134 }, floor: 113, taken: [notice], controls: [wall] }), null);
  });
});

describe("the alerts column's cards", () => {
  test("take the map less the safe areas and a sheet, up to 300 px, with room for their shadow", () => {
    assert.deepEqual(columnCards({ mapWidth: 844, sheet: 0, safe: { left: 47, right: 47 } }), { card: 300, shadowLeft: 20 });
    assert.deepEqual(columnCards({ mapWidth: 369, sheet: 0, safe: { left: 47, right: 47 } }), { card: 259, shadowLeft: 20 });
    assert.deepEqual(columnCards({ mapWidth: 649, sheet: 340, safe: { left: 47, right: 47 } }), { card: 246, shadowLeft: 20 });
  });

  test("spanning notices center beside the lane where 320 px are left there, else span the map", () => {
    const narrow = freeArea({ width: 649, height: 300 }, phone({ band: false, options: "merged", safe: { top: 0, side: 47, bottom: 21 } }));
    assert.equal(noticePlace(narrow), null);
    const sideways = freeArea({ width: 844, height: 390 }, phone({ band: false, options: "merged", safe: { top: 0, side: 47, bottom: 21 } }));
    assert.deepEqual(noticePlace(sideways), { left: 55, width: 422 }, "with no rail, 844 x 390 leaves 422 px beside the lane");
    const wide = freeArea({ width: 1032, height: 480 }, DEFAULT_CHROME);
    assert.deepEqual(noticePlace(wide), { left: wide.left, width: wide.width - LANE_WIDTH });
  });
});

describe("a summary row risen over the bars (follow-up to docs/design-v1-bar-dock.md 1.3)", () => {
  test("the bar under a summary row that rose leaves its old place to the bar, never past the lane's top", () => {
    const lane = { laneTop: 122, laneHeight: 95, besideRoom: 0 };
    assert.deepEqual(laneChoice({ ...lane, column: { top: 122, content: 110, first: 110 } }), { lane: "summary", floor: 122 + SUMMARY_ROW + EDGE }, "the row at its place");
    assert.deepEqual(laneChoice({ ...lane, column: { top: 122, content: 110, first: 110, row: 8 } }), { lane: "summary", floor: 122 }, "the row in the top bar's row");
    assert.deepEqual(laneChoice({ ...lane, column: { top: 100, content: 44, first: 44 } }), { lane: "summary", floor: 152 }, "a row at its place above the lane keeps the bar under it");
    assert.deepEqual(laneChoice({ ...lane, column: { top: 8, content: 44, first: 44 } }), { lane: "stacked", floor: 122 }, "a row standing for the cards, risen above the lane");
  });

  test("the column's facts keep the row's place, and the same object when nothing changed", () => {
    const facts = columnFacts(null, { top: 122, measured: { content: 110, first: 110 } })!;
    assert.equal(facts.row, undefined);
    const raised = columnFacts(facts, { top: 122, measured: null, row: 8 })!;
    assert.equal(raised.row, 8);
    assert.equal(columnFacts(raised, { top: 122, measured: null, row: 8 }), raised);
    assert.equal(columnFacts(raised, { top: 122, measured: null })!.row, undefined, "back at its place");
  });
});

describe("a card's action that opens a panel (LP13-TR-3)", () => {
  test("asks the alerts over the screen to close, each time, and asks nothing while they are where they are", () => {
    const scope = new RoomScope();
    const dock = scope.get(barDockSlot);
    closeAlertsOverlay(scope, "dice");
    assert.equal(dock.getState().alertsClose, 0, "no alerts over the screen: nothing to close");
    dock.setState({ alertsOverlay: true });
    closeAlertsOverlay(scope, "dice");
    closeAlertsOverlay(scope, "areas");
    assert.equal(dock.getState().alertsClose, 2, "each ask is a new one, so the column hears both");
    assert.equal(dock.getState().alertsClosePanel, "areas", "the panel the last ask opened, which takes focus");
  });
});

describe("a toast on a phone whose alerts column shows a card (fu16 item 8)", () => {
  const column = { top: 122, content: 260, first: 120 };
  const phone = { spanning: true, column, cards: true, optionsTop: 700 };
  const upright = { mapWidth: 390, sheet: 0, safe: { left: 0, right: 0 } };

  test("starts 8 px under the first card while the notices span the map", () => {
    assert.equal(toastTop(phone), 122 + 120 + EDGE);
  });

  test("keeps the top of the notices beside the lane, with no card, with the cards folded or summarized, or with no room left for it", () => {
    assert.equal(toastTop({ ...phone, spanning: false }), null);
    assert.equal(toastTop({ ...phone, column: null }), null);
    assert.equal(toastTop({ ...phone, column: { ...column, first: 0 } }), null);
    assert.equal(toastTop({ ...phone, cards: false }), null);
    const top = 122 + 120 + EDGE;
    assert.equal(toastTop({ ...phone, optionsTop: top + TOAST_MIN }), top, "44 px left is enough");
    assert.equal(toastTop({ ...phone, optionsTop: top + TOAST_MIN - 1 }), null, "under 44 px it falls back to the top");
  });

  // The cards as the column draws them (InitiativeStrip.tsx): 300 px wide, 8 px in from the map's right. The map less 12 px each side put a toast 70 px left of them at 390 and 4 px short of their right.
  for (const [mapWidth, left] of [
    [390, 82],
    [360, 52],
    [320, 12],
  ] as const) {
    test(`stands at the first card's left and right edges at ${mapWidth} px, not the map's (docs/design-v1-polish.md R9)`, () => {
      assert.deepEqual(columnEdges({ ...upright, mapWidth }), { left, right: EDGE });
      assert.equal(mapWidth - left - EDGE, columnCards({ ...upright, mapWidth }).card, "as wide as the card");
    });
  }

  test("beside a sideways sheet and inside the safe areas it keeps to the card too", () => {
    const sideways = { mapWidth: 844, sheet: 340, safe: { left: 47, right: 47 } };
    assert.deepEqual(columnEdges(sideways), { left: 844 - 340 - EDGE - columnCards(sideways).card, right: 340 + EDGE }, "left of the sheet, which takes the right safe area's place");
    const notched = { mapWidth: 649, sheet: 0, safe: { left: 47, right: 47 } };
    assert.deepEqual(columnEdges(notched), { left: 649 - 47 - EDGE - 300, right: 47 + EDGE });
  });
});

describe("a toast while a map pane stands as a bottom sheet (LP15-FU-8)", () => {
  test("starts 8 px under the pane's header, over the pane's body", () => {
    assert.equal(paneToastTop({ head: 300, optionsTop: 700 }), 300 + EDGE);
  });

  test("keeps the top of the notices before the header is measured, or with no room left for it", () => {
    assert.equal(paneToastTop({ head: null, optionsTop: 700 }), null);
    const top = 300 + EDGE;
    assert.equal(paneToastTop({ head: 300, optionsTop: top + TOAST_MIN }), top, "44 px left is enough");
    assert.equal(paneToastTop({ head: 300, optionsTop: top + TOAST_MIN - 1 }), null, "under 44 px it falls back to the top");
  });
});

describe("a stack of toasts that runs past its room (review LP16-PT-2)", () => {
  const whisper = (id: number, height = 44) => ({ id, height, action: false, logged: true });
  const trap = (id: number, height = 100) => ({ id, height, action: true, logged: true });
  /** A refusal the log never sees, as "That change could not be sent.". */
  const refusal = (id: number, height = 44) => ({ id, height, action: false, logged: false });

  test("a stack that fits keeps every toast and does not scroll", () => {
    assert.deepEqual(fitToasts([whisper(1), trap(2)], 8, 152), { drop: [], scrolls: false });
    assert.deepEqual(fitToasts([whisper(1), trap(2)], 8, 151.5), { drop: [], scrolls: false }, "half a pixel of rounding still fits");
  });

  test("the oldest toasts with no button go first, only as many as it takes, so a trap's Save and damage shows", () => {
    // 480 x 320 at 130% with a label pane: a whisper, another, then the trap's toast, in 160 px.
    assert.deepEqual(fitToasts([whisper(1), whisper(2), trap(3)], 8, 160), { drop: [1], scrolls: false });
    assert.deepEqual(fitToasts([whisper(1), whisper(2), trap(3)], 8, 100), { drop: [1, 2], scrolls: false });
  });

  test("toasts with a button stay, and what still runs past scrolls", () => {
    assert.deepEqual(fitToasts([trap(1), whisper(2), trap(3)], 8, 150), { drop: [2], scrolls: true });
    assert.deepEqual(fitToasts([trap(1, 130)], 8, 120), { drop: [], scrolls: true }, "one toast taller than its room scrolls");
  });

  test("an error the log never sees is never dropped, and what still runs past scrolls (review FU22B-OP-4)", () => {
    assert.deepEqual(fitToasts([refusal(1), whisper(2), trap(3)], 8, 150), { drop: [2], scrolls: true });
    assert.deepEqual(fitToasts([refusal(1), refusal(2), trap(3)], 8, 60), { drop: [], scrolls: true });
  });

  test("the newest never goes, though it has no button", () => {
    assert.deepEqual(fitToasts([trap(1), whisper(2)], 8, 100), { drop: [], scrolls: true });
    assert.deepEqual(fitToasts([whisper(1), whisper(2)], 8, 50), { drop: [1], scrolls: false });
  });

  test("random stacks keep every toast with a button and the newest, drop only the oldest with none, and fit or scroll", () => {
    let seed = 11;
    const random = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
    for (let run = 0; run < 2000; run++) {
      const stack = Array.from({ length: 1 + Math.floor(random() * 3) }, (_, i) => {
        const kind = random();
        return kind < 0.4 ? whisper(i, 44 + Math.floor(random() * 60)) : kind < 0.7 ? refusal(i, 44 + Math.floor(random() * 60)) : trap(i, 60 + Math.floor(random() * 80));
      });
      const room = 40 + Math.floor(random() * 300);
      const { drop, scrolls } = fitToasts(stack, 8, room);
      const kept = stack.filter((t) => !drop.includes(t.id));
      const total = kept.reduce((n, t) => n + t.height, 0) + 8 * (kept.length - 1);
      const label = `run ${run}: ${JSON.stringify(stack)} in ${room}`;
      // Invariants: no toast with a button, no toast the log never sees and never the newest goes, what goes is the oldest of the rest, and the rest fits exactly when it does not scroll.
      assert.ok(drop.every((id) => !stack.find((t) => t.id === id)!.action), `${label}: a toast with a button went`);
      assert.ok(drop.every((id) => stack.find((t) => t.id === id)!.logged), `${label}: a toast the log never sees went`);
      assert.ok(!drop.includes(stack.at(-1)!.id), `${label}: the newest went`);
      const plain = stack.slice(0, -1).filter((t) => !t.action && t.logged).map((t) => t.id);
      assert.deepEqual(drop, plain.slice(0, drop.length), `${label}: a newer toast went before an older one`);
      assert.equal(scrolls, total > room + 0.5, `${label}: scrolls ${scrolls} with ${total} px`);
      if (drop.length > 0) {
        const one = drop.at(-1)!;
        const back = stack.find((t) => t.id === one)!;
        assert.ok(total + back.height + 8 > room + 0.5, `${label}: it dropped more than it took to fit`);
      }
    }
  });
});

describe("the toasts' places in the layer, around a map pane (LP15-FU-8, FU21B-ASTRA-1 and 2, FU21B-OP-4)", () => {
  type Now = Parameters<typeof nextToastPlaces>[1];
  const phone: Omit<Now, "ids"> = { pane: null, paneStands: false, low: null, layer: true, slot: false };
  const step = (was: ToastPlaces, ids: readonly number[], now: Partial<Now> = {}) => nextToastPlaces(was, { ...phone, ids, ...now });
  /** The column's cards' edges upright at 390 px, and held sideways at 844 px beside a 340 px sheet. */
  const upright = columnEdges({ mapWidth: 390, sheet: 0, safe: { left: 0, right: 0 } });
  const sideways = columnEdges({ mapWidth: 844, sheet: 340, safe: { left: 0, right: 0 } });
  const top = (state: ToastPlaces, ids: readonly number[]) => toastLayerPlace(state, ids, upright)?.top ?? null;

  test("a column stack keeps the top its first toast took, and one that joins it takes it too", () => {
    let s = step(NO_TOAST_PLACES, [1], { low: 250 });
    assert.deepEqual(toastLayerPlace(s, [1], upright), { top: 250, edges: upright });
    s = step(s, [1, 2], { low: 300 });
    assert.deepEqual(s.places.get(2), { low: 250, column: true }, "it joins the stack where it stands");
  });

  test("a column stack keeps its top through a turn of the screen, and takes the cards' edges as they stand now (PL2-ASTRA-02)", () => {
    let s = step(NO_TOAST_PLACES, [1], { low: 140 });
    assert.deepEqual(toastLayerPlace(s, [1], sideways), { top: 140, edges: { left: 196, right: 348 } });
    // Turned upright, the screen is 390 px wide: the edges kept from the sideways sheet would leave the stack 390 - 196 - 348 px.
    s = step(s, [1], { low: 250 });
    const now = toastLayerPlace(s, [1], upright);
    assert.deepEqual(now, { top: 140, edges: { left: 82, right: EDGE } });
    assert.ok(390 - now!.edges!.left - now!.edges!.right >= 300, "as wide as a card");
  });

  test("a column toast live as a pane opens moves under the pane's header, and the trap's toast joins it there", () => {
    let s = step(NO_TOAST_PLACES, [1], { low: 250 });
    assert.equal(top(s, [1]), 250);
    // The pane's first render has no header place yet: nothing moves.
    s = step(s, [1], { paneStands: true });
    assert.equal(top(s, [1]), 250);
    s = step(s, [1], { paneStands: true, pane: 182 });
    assert.equal(s.places.get(1), "pane");
    s = step(s, [1, 2], { paneStands: true, pane: 182 });
    assert.equal(s.places.get(2), "pane");
    assert.equal(top(s, [1, 2]), 182);
  });

  test("the stack follows the header as the pane grows or makes room for the alerts row", () => {
    let s = step(NO_TOAST_PLACES, [1], { paneStands: true, pane: 134 });
    s = step(s, [1], { paneStands: true, pane: 182 });
    assert.equal(top(s, [1]), 182);
    // A render with no header place, as with too little room for a toast, keeps it where it was.
    s = step(s, [1], { paneStands: true, pane: null });
    assert.equal(top(s, [1]), 182);
  });

  test("the pane going away freezes the stack where the header last stood, and a new toast joins it there", () => {
    let s = step(NO_TOAST_PLACES, [1], { paneStands: true, pane: 182 });
    s = step(s, [1], { paneStands: false, low: 300 });
    assert.deepEqual(s.places.get(1), { low: 182, column: false }, "across the map, as under the header");
    assert.equal(toastLayerPlace(s, [1], upright)?.edges, null);
    assert.equal(s.paneLast, null);
    s = step(s, [1, 2], { low: 300 });
    assert.deepEqual(s.places.get(2), { low: 182, column: false });
  });

  test("a stack a closed pane left joins the next pane's header once it has one", () => {
    let s = step(NO_TOAST_PLACES, [1], { paneStands: true, pane: 182 });
    s = step(s, [1]);
    s = step(s, [1], { paneStands: true });
    assert.equal(top(s, [1]), 182, "the next pane's first render moves nothing");
    s = step(s, [1], { paneStands: true, pane: 420 });
    assert.equal(top(s, [1]), 420);
  });

  test("a toast that shows on a pane's first render, before its header has a place, joins the stack already there and does not jump", () => {
    let s = step(NO_TOAST_PLACES, [1], { paneStands: true, pane: 182 });
    s = step(s, [1], { paneStands: true, pane: null });
    s = step(s, [1, 2], { paneStands: true, pane: null });
    assert.equal(s.places.get(2), "pane");
    assert.equal(top(s, [1, 2]), 182);
  });

  test("a toast at the top of the notices as a pane opens joins the stack under the pane's header, with the layer's toasts, and freezes with them (review FU21B-OP-7)", () => {
    // A whisper with no card in the column, then a trap's toast under the column's card.
    let s = step(NO_TOAST_PLACES, [1]);
    assert.equal(s.places.get(1), "map");
    s = step(s, [1, 2], { low: 250 });
    assert.deepEqual(s.places.get(2), { low: 250, column: true });
    // The pane's first render has no header place: the whisper stays at the notices' top.
    s = step(s, [1, 2], { paneStands: true });
    assert.equal(s.places.get(1), "map");
    s = step(s, [1, 2], { paneStands: true, pane: 182 });
    assert.equal(s.places.get(1), "pane");
    assert.equal(s.places.get(2), "pane");
    assert.equal(top(s, [1, 2]), 182);
    s = step(s, [1, 2]);
    assert.deepEqual(s.places.get(1), { low: 182, column: false }, "frozen where the header last stood");
  });

  test("just after the screen turns, a toast at the notices' top that now meets the column's first card takes its place under it, and joins a stack there (review LP17-AW-1)", () => {
    // Sideways, beside the lane: the toast at the notices' top.
    let s = step(NO_TOAST_PLACES, [1]);
    assert.equal(s.places.get(1), "map");
    // Turned upright, the column's card is not measured yet: it stays.
    s = step(s, [1], { turned: true });
    assert.equal(s.places.get(1), "map");
    s = step(s, [1], { turned: true, low: 250 });
    assert.deepEqual(s.places.get(1), { low: 250, column: true });
    // With a stack already under the card, it joins that stack.
    let t = step(NO_TOAST_PLACES, [1]);
    t = step(t, [1, 2], { low: 250 });
    t = step(t, [1, 2], { turned: true, low: 300 });
    assert.deepEqual(t.places.get(1), { low: 250, column: true });
  });

  test("while the turn lasts, a toast placed under the card as it stood before the turn takes the card's place again once the column measures it, and then keeps it (review LP17-AW-1)", () => {
    let s = step(NO_TOAST_PLACES, [1]);
    // The first render upright reads the card where it stood sideways.
    s = step(s, [1], { turned: true, low: 193 });
    assert.deepEqual(s.places.get(1), { low: 193, column: true });
    s = step(s, [1], { turned: true, low: 240 });
    assert.deepEqual(s.places.get(1), { low: 240, column: true });
    // A whisper under the card that was there before the turn keeps its place, and the turned toast joins it.
    let t = step(NO_TOAST_PLACES, [1]);
    t = step(t, [1, 2], { low: 250 });
    t = step(t, [1, 2], { turned: true, low: 193 });
    t = step(t, [1, 2], { turned: true, low: 240 });
    assert.deepEqual(t.places.get(1), { low: 250, column: true });
    assert.deepEqual(t.places.get(2), { low: 250, column: true });
    // The turn over, a card that moves moves the toast no more.
    s = step(s, [1], { low: 300 });
    assert.deepEqual(s.places.get(1), { low: 240, column: true });
    assert.equal(s.turning.size, 0);
  });

  test("a toast that comes while the turn lasts, between the card's stale place and its measured one, moves with the turned stack, and holds no place of its own (review FU22B-ASTRA-03)", () => {
    // astra's case: the turned toast at the stale 193, a second joins it, and then the column measures 240.
    let s = step(NO_TOAST_PLACES, [1]);
    s = step(s, [1], { turned: true, low: 193 });
    s = step(s, [1, 2], { turned: true, low: 193 });
    assert.deepEqual(s.places.get(2), { low: 193, column: true });
    s = step(s, [1, 2], { turned: true, low: 240 });
    assert.deepEqual(s.places.get(1), { low: 240, column: true });
    assert.deepEqual(s.places.get(2), { low: 240, column: true });
    // One that comes alone at the stale place moves too.
    let t = step(NO_TOAST_PLACES, []);
    t = step(t, [3], { turned: true, low: 193 });
    t = step(t, [3], { turned: true, low: 240 });
    assert.deepEqual(t.places.get(3), { low: 240, column: true });
    // The turn over, they keep it.
    s = step(s, [1, 2], { low: 300 });
    assert.deepEqual(s.places.get(2), { low: 240, column: true });
  });

  test("a pane that stops standing as the screen turns leaves its toasts to take their places anew, never the header's place read before the turn (review LP18-TO-3)", () => {
    // Upright, the trap's toast under the pane's header. The first render sideways still has the sheet, its header measured above the screen.
    let s = step(NO_TOAST_PLACES, [1], { paneStands: true, pane: 182 });
    s = step(s, [1], { paneStands: true, pane: -272, turned: true });
    // Sideways the pane is a card: the toast goes to the notices' top, as one that came now would.
    s = step(s, [1], { paneStands: false, turned: true });
    assert.equal(s.places.get(1), "map");
    assert.equal(toastLayerPlace(s, [1], sideways), null, "no stack is left above the screen");
    // Under the column's card, where one shows.
    let t = step(NO_TOAST_PLACES, [1], { paneStands: true, pane: 182 });
    t = step(t, [1], { paneStands: false, turned: true, low: 140 });
    assert.deepEqual(t.places.get(1), { low: 140, column: true });
    // With no turn, the pane going away still freezes the stack where its header stood.
    let u = step(NO_TOAST_PLACES, [1], { paneStands: true, pane: 182 });
    u = step(u, [1], { paneStands: false });
    assert.deepEqual(u.places.get(1), { low: 182, column: false });
  });

  test("a toast that would start under the column's card while a toast at the notices' top reaches down past it joins that toast below, so the two never overlap (review LP18-TO-4)", () => {
    // A trap's toast whose card the column measured too late to take it, at the notices' top, 68 to 174. The card ends at 123, so a stack under it would start at 131.
    let s = step(NO_TOAST_PLACES, [1]);
    assert.equal(s.places.get(1), "map");
    s = step(s, [1, 2], { low: 131, mapFoot: 174 });
    assert.equal(s.places.get(2), "map", "it joins the toast at the top");
    s = step(s, [1, 2, 3], { low: 131, mapFoot: 226 });
    assert.equal(s.places.get(3), "map");
    // A toast at the top that ends above the card's foot leaves room: the next starts under the card.
    let t = step(NO_TOAST_PLACES, [1]);
    t = step(t, [1, 2], { low: 131, mapFoot: 112 });
    assert.deepEqual(t.places.get(2), { low: 131, column: true });
    // With the top's toasts gone, a toast starts under the card again, whatever foot was last drawn.
    let u = step(NO_TOAST_PLACES, [1]);
    u = step(u, [2], { low: 131, mapFoot: 174 });
    assert.deepEqual(u.places.get(2), { low: 131, column: true });
  });

  test("a card that arrives with no turn moves no toast, so nothing jumps under a finger", () => {
    let s = step(NO_TOAST_PLACES, [1]);
    s = step(s, [1], { low: 250 });
    assert.equal(s.places.get(1), "map");
  });

  test("a toast that came with the column's card, before the column measured it, takes its place under the card once the column does, and then keeps it (review LP18-TO-5)", () => {
    const fresh = new Set([1, 2]);
    // The trap's toast and its card in one render: no place under the card yet.
    let s = step(NO_TOAST_PLACES, [1], { recent: fresh });
    assert.equal(s.places.get(1), "map");
    assert.deepEqual([...s.awaitCard], [1]);
    s = step(s, [1], { recent: fresh, low: 131 });
    assert.deepEqual(s.places.get(1), { low: 131, column: true });
    assert.equal(s.awaitCard.size, 0);
    // Placed, a card that moves moves it no more, and a whisper after it joins it below.
    s = step(s, [1], { recent: fresh, low: 160 });
    assert.deepEqual(s.places.get(1), { low: 131, column: true });
    s = step(s, [1, 2], { recent: fresh, low: 160 });
    assert.deepEqual(s.places.get(2), { low: 131, column: true });
    // Two that came before the card was measured go under it together, in order.
    let t = step(NO_TOAST_PLACES, [1], { recent: fresh });
    t = step(t, [1, 2], { recent: fresh });
    t = step(t, [1, 2], { recent: fresh, low: 131 });
    assert.deepEqual(t.places.get(1), { low: 131, column: true });
    assert.deepEqual(t.places.get(2), { low: 131, column: true });
  });

  test("a card measured once the toast is no longer new moves it no more, nor one where no card can take it", () => {
    const fresh = new Set([1]);
    let s = step(NO_TOAST_PLACES, [1], { recent: fresh });
    s = step(s, [1], { recent: new Set(), low: 131 });
    assert.equal(s.places.get(1), "map");
    s = step(s, [1], { recent: fresh, low: 131 });
    assert.equal(s.places.get(1), "map", "it waits for a card only from when it came");
    // A toast that came while a pane stood, in the very short sheet or with no layer never waits for a card.
    for (const at of [{ paneStands: true }, { slot: true }, { layer: false }] as const) {
      let t = step(NO_TOAST_PLACES, [1], { recent: fresh, ...at });
      assert.equal(t.awaitCard.size, 0, JSON.stringify(at));
      t = step(t, [1], { recent: fresh, low: 131, ...("slot" in at ? at : {}), ...("layer" in at ? at : {}) });
      assert.equal(inToastLayer(t.places.get(1)), false, JSON.stringify(at));
    }
    // A toast at the notices' top that came before and reaches past the card keeps the new one with it there (review LP18-TO-4).
    let u = step(NO_TOAST_PLACES, [1]);
    u = step(u, [1, 2], { recent: new Set([2]) });
    u = step(u, [1, 2], { recent: new Set([2]), low: 131, mapFoot: 226 });
    assert.equal(u.places.get(2), "map");
  });

  test("random renders move a toast from the notices' top to the layer only for a pane's header, or once, while new, for a card measured after it came with none", () => {
    let seed = 23;
    const random = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
    for (let run = 0; run < 400; run++) {
      let s = NO_TOAST_PLACES;
      let ids: number[] = [];
      let next = 1;
      let paneStands = false;
      // Each toast's renders left while new, and whether it came where a card could take it with none measured.
      const left = new Map<number, number>();
      const cameBare = new Set<number>();
      const moved = new Set<number>();
      for (let render = 0; render < 40; render++) {
        const roll = random();
        if (roll < 0.3) {
          ids = [...ids, next];
          left.set(next, 1 + Math.floor(random() * 4));
          next++;
        } else if (roll < 0.4 && ids.length > 0) {
          const gone = ids[Math.floor(random() * ids.length)]!;
          ids = ids.filter((id) => id !== gone);
        } else if (roll < 0.47) paneStands = !paneStands;
        const pane = paneStands && random() < 0.6 ? 100 + Math.floor(random() * 400) : null;
        const slot = random() < 0.08;
        const layer = random() < 0.95;
        const low = paneStands || random() < 0.5 ? null : 120 + Math.floor(random() * 100);
        const recent = new Set(ids.filter((id) => (left.get(id) ?? 0) > 0));
        const now: Now = { ids, pane, paneStands, low, layer, slot, recent, ...(random() < 0.3 ? { mapFoot: 60 + Math.floor(random() * 200) } : {}) };
        const was = s;
        s = nextToastPlaces(was, now);
        const label = `run ${run}, render ${render}`;
        for (const id of ids) {
          assert.ok(s.places.has(id), `${label}: toast ${id} has no place`);
          const from = was.places.get(id);
          const to = s.places.get(id);
          if (from === undefined) {
            if (to === "map" && low === null && layer && !slot && !paneStands) cameBare.add(id);
            continue;
          }
          if (inToastLayer(from)) assert.ok(inToastLayer(to), `${label}: toast ${id} left the layer`);
          if (from === "map" && inToastLayer(to) && pane === null) {
            assert.ok(cameBare.has(id) && recent.has(id), `${label}: toast ${id} moved under a card it did not come with`);
            assert.ok(!moved.has(id), `${label}: toast ${id} moved under a card twice`);
            assert.ok(low !== null && layer && !slot && !paneStands, `${label}: toast ${id} moved with no card to go under`);
            moved.add(id);
          }
        }
        const tops = new Set(ids.filter((id) => inToastLayer(s.places.get(id))).map((id) => JSON.stringify(s.places.get(id))));
        assert.ok(tops.size <= 1, `${label}: ${tops.size} stacks in the layer`);
        for (const id of s.awaitCard) assert.ok(recent.has(id) && s.places.get(id) === "map", `${label}: toast ${id} waits for a card while old or off the notices' top`);
        for (const [id, n] of left) left.set(id, n - 1);
      }
    }
  });

  test("with no layer to go to, a toast at the notices' top stays there under a pane", () => {
    let s = step(NO_TOAST_PLACES, [1], { layer: false });
    s = step(s, [1], { layer: false, paneStands: true, pane: 182 });
    assert.equal(s.places.get(1), "map");
  });

  test("random renders keep one stack in the layer, keep each toast where it was announced, and move the stack only to a header", () => {
    let seed = 7;
    const random = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
    const pick = <T,>(xs: readonly T[]): T => xs[Math.floor(random() * xs.length)]!;
    const where = (p: ToastPlace | undefined) => (p === undefined ? undefined : inToastLayer(p) ? "layer" : p);
    for (let run = 0; run < 400; run++) {
      let s = NO_TOAST_PLACES;
      let ids: number[] = [];
      let next = 1;
      let paneStands = false;
      for (let render = 0; render < 40; render++) {
        const event = pick(["toast", "toast", "end", "open", "close", "move", "blank", "slot", "none"] as const);
        if (event === "toast") ids = [...ids, next++];
        if (event === "end" && ids.length > 0) {
          const gone = pick(ids);
          ids = ids.filter((id) => id !== gone);
        }
        if (event === "open") paneStands = true;
        if (event === "close") paneStands = false;
        const pane = paneStands && event !== "blank" && random() < 0.8 ? 100 + Math.floor(random() * 400) : null;
        const now: Now = { ids, pane, paneStands, low: paneStands || random() < 0.3 ? null : 200 + Math.floor(random() * 100), layer: true, slot: event === "slot" };
        const was = s;
        s = nextToastPlaces(was, now);
        const label = `run ${run}, render ${render}`;
        // Every toast showing has a place, in the same part of the page as before, but for one at the notices' top that a pane's header takes into the layer.
        for (const id of ids) {
          assert.ok(s.places.has(id), `${label}: toast ${id} has no place`);
          const from = where(was.places.get(id));
          const to = where(s.places.get(id));
          if (was.places.has(id) && !(from === "map" && to === "layer" && pane !== null)) assert.equal(to, from, `${label}: toast ${id} moved between the notices, the layer and the sheet`);
        }
        // One stack in the layer.
        const tops = new Set(ids.filter((id) => inToastLayer(s.places.get(id))).map((id) => JSON.stringify(s.places.get(id))));
        assert.ok(tops.size <= 1, `${label}: ${tops.size} stacks in the layer`);
        // While the header has a place, the stack is under it. With no pane standing, it never follows one.
        if (pane !== null) for (const id of ids) if (s.places.get(id) !== "sheet") assert.equal(s.places.get(id), "pane", `${label}: toast ${id} is not under the header`);
        if (!paneStands) for (const id of ids) assert.notEqual(s.places.get(id), "pane", `${label}: toast ${id} follows a pane that went away`);
        // The stack moves only on a render that has the header's place.
        const before = toastLayerPlace(was, ids.filter((id) => was.places.has(id)), upright);
        const after = toastLayerPlace(s, ids.filter((id) => was.places.has(id)), upright);
        if (before !== null && pane === null) assert.deepEqual(after, before, `${label}: the stack moved with no header to go to`);
      }
    }
  });
});

describe("a toast over a spanning token bar's header (review LP19-BS-2)", () => {
  type Now = Parameters<typeof nextToastPlaces>[1];
  const phone: Omit<Now, "ids"> = { pane: null, paneStands: false, low: null, layer: true, slot: false };
  const step = (was: ToastPlaces, ids: readonly number[], now: Partial<Now> = {}) => nextToastPlaces(was, { ...phone, ids, ...now });
  const upright = columnEdges({ mapWidth: 390, sheet: 0, safe: { left: 0, right: 0 } });
  // The DM's bar at 390 x 844 hanging over its token to the free area's top: its header from 61 to 113.
  const head = { top: 61, bottom: 113 };

  test("a toast moves 8 px under the header, unless that leaves it under 44 px above the tool's options", () => {
    assert.equal(barToastTop({ head, optionsTop: 776 }), 113 + EDGE);
    assert.equal(barToastTop({ head: null, optionsTop: 776 }), null);
    assert.equal(barToastTop({ head, optionsTop: 113 + EDGE + TOAST_MIN }), 113 + EDGE, "44 px left is enough");
    assert.equal(barToastTop({ head, optionsTop: 113 + EDGE + TOAST_MIN - 1 }), null);
  });

  test("only the toasts whose boxes meet the header are over it", () => {
    const boxes = [
      { id: 1, top: 68, bottom: 125 },
      { id: 2, top: 133, bottom: 190 },
      { id: 3, top: 112.6, bottom: 150 },
      { id: 4, top: 20, bottom: 61.4 },
    ];
    assert.deepEqual([...toastsOverHead(boxes, head)], [1]);
    assert.equal(toastsOverHead(boxes, null).size, 0);
  });

  test("a toast that showed over the header, at the notices' top or under the column's card, takes its place under it, across the map, and stays there", () => {
    // At the notices' top.
    let s = step(NO_TOAST_PLACES, [1]);
    assert.equal(s.places.get(1), "map");
    s = step(s, [1], { overBar: { ids: new Set([1]), at: 121 } });
    assert.deepEqual(s.places.get(1), { low: 121, column: false, bar: true });
    assert.deepEqual(toastLayerPlace(s, [1], upright), { top: 121, edges: null });
    // Clear of the header now, it stays, and the next toast that comes over the header joins it below.
    s = step(s, [1]);
    s = step(s, [1, 2]);
    assert.equal(s.places.get(2), "map");
    s = step(s, [1, 2], { overBar: { ids: new Set([2]), at: 121 } });
    assert.deepEqual(s.places.get(2), s.places.get(1));
    // Under the column's card, where the bar's top also stands.
    let c = step(NO_TOAST_PLACES, [5], { low: 130 });
    assert.deepEqual(c.places.get(5), { low: 130, column: true });
    c = step(c, [5], { low: 130, overBar: { ids: new Set([5]), at: 190 } });
    assert.deepEqual(c.places.get(5), { low: 190, column: false, bar: true });
    // The bar moves down under a card that came, its header now 131 to 183: a whisper that joins the stack over it takes the whole stack under it.
    let m = step(step(NO_TOAST_PLACES, [1]), [1], { overBar: { ids: new Set([1]), at: 121 } });
    m = step(m, [1, 2], { low: 130 });
    assert.deepEqual(m.places.get(2), m.places.get(1), "it joins the stack");
    m = step(m, [1, 2], { low: 130, overBar: { ids: new Set([2]), at: 191 } });
    assert.deepEqual(toastLayerPlace(m, [1, 2], upright), { top: 191, edges: null });
    assert.deepEqual(m.places.get(1), m.places.get(2));
    // So does a stack under the column's card, while the toasts at the notices' top stay.
    let k2 = step(NO_TOAST_PLACES, [3], { low: 130 });
    k2 = step(k2, [3, 4], { layer: false });
    k2 = step(k2, [3, 4, 5], { low: 130 });
    k2 = step(k2, [3, 4, 5], { low: 130, overBar: { ids: new Set([5]), at: 191 } });
    assert.deepEqual(k2.places.get(3), { low: 191, column: false, bar: true });
    assert.equal(k2.places.get(4), "map");
    // A toast not over the header keeps its place.
    const k = step(step(NO_TOAST_PLACES, [7]), [7], { overBar: { ids: new Set([8]), at: 121 } });
    assert.equal(k.places.get(7), "map");
  });

  test("a pane's header, the very short sheet and a page with no layer keep their rules", () => {
    let p = step(NO_TOAST_PLACES, [1], { paneStands: true, pane: 300 });
    p = step(p, [1], { paneStands: true, pane: 300, overBar: { ids: new Set([1]), at: 121 } });
    assert.equal(p.places.get(1), "pane");
    let n = step(NO_TOAST_PLACES, [1], { layer: false });
    n = step(n, [1], { layer: false, overBar: { ids: new Set([1]), at: 121 } });
    assert.equal(n.places.get(1), "map");
    let q = step(NO_TOAST_PLACES, [1], { slot: true });
    q = step(q, [1], { slot: true, overBar: { ids: new Set([1]), at: 121 } });
    assert.equal(q.places.get(1), "sheet");
  });

  test("as the screen turns, a toast under the bar's header takes its place anew, since the bar docks and its header's place was read upright", () => {
    let s = step(step(NO_TOAST_PLACES, [1]), [1], { overBar: { ids: new Set([1]), at: 121 } });
    s = step(s, [1], { turned: true });
    assert.equal(s.places.get(1), "map");
    let c = step(step(NO_TOAST_PLACES, [1]), [1], { overBar: { ids: new Set([1]), at: 121 } });
    c = step(c, [1], { turned: true, low: 130 });
    assert.deepEqual(c.places.get(1), { low: 130, column: true });
  });
});

describe("an upright phone's Larger and Smaller (docs/design-v1-bar-dock.md 1.5)", () => {
  // The DM at 390 x 844 in a fight: the top bar and the turn band take 100 px, the toolbar 60, so the free area runs from 108 to 776.
  const view = { width: 390, height: 844 };
  const chrome = phone({ band: true, options: false, safe: { top: 0, side: 0, bottom: 0 } });
  const free = freeArea(view, chrome);
  const room = (y: number, height: number, column: { top: number; content: number; first: number } | null = null, tokenHeight = FLIP_CLEARANCE) => ({ layout: view, viewport: view, chrome, foot: 0, anchor: { x: 200, y }, column, height, tokenHeight });
  /**
   * Where the bar hangs once the map has moved by `dy`, and whether the
   * token, `tokenHeight` tall above the anchor, and its label in the
   * OFFSET_Y below, stay clear of it and inside the free area.
   */
  const after = (y: number, height: number, dy: number, column: { top: number; content: number; first: number } | null = null, tokenHeight = FLIP_CLEARANCE) => {
    const placed = placeBar({ ...room(y + dy, height, column, tokenHeight), spot: DEFAULT_SPOT });
    assert.ok(placed && placed.mode === "span");
    const box = hangBox(placed.hang, height);
    const token = { top: y + dy - tokenHeight, bottom: y + dy + OFFSET_Y };
    const clear = box.top + box.height <= token.top + 0.5 || box.top >= token.bottom - 0.5;
    const inside = token.top >= free.top - 0.5 && token.bottom <= free.top + free.height + 0.5;
    return { box, room: placed.hang.room, clear, inside };
  };

  test("the choice is stored as 1 for Larger and as no key for Smaller, and storage that throws reads as Smaller", () => {
    const kept = new Map<string, string>();
    const storage = { getItem: (k: string) => kept.get(k) ?? null, setItem: (k: string, v: string) => void kept.set(k, v), removeItem: (k: string) => void kept.delete(k) };
    assert.equal(readLarger(storage), false);
    writeLarger(true, storage);
    assert.equal(kept.get(LARGER_KEY), "1");
    assert.equal(readLarger(storage), true);
    writeLarger(false, storage);
    assert.equal(kept.has(LARGER_KEY), false);
    for (const odd of ["0", "true", "larger", ""]) {
      kept.set(LARGER_KEY, odd);
      assert.equal(readLarger(storage), false, odd);
    }
    const blocked = {
      getItem: (): string | null => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
      removeItem: () => {
        throw new Error("blocked");
      },
    };
    assert.equal(readLarger(blocked), false);
    assert.doesNotThrow(() => writeLarger(true, blocked));
  });

  test("Larger asks for two thirds of the screen, and leaves its token 120 px of the free area under the column's first card", () => {
    assert.deepEqual(free, { left: 8, top: 108, width: 374, height: 668 });
    // Two thirds of 844 is 563, but the band leaves 668, so 548 keeps the token's 120.
    assert.equal(largerRoom(view, free, free.top, FLIP_CLEARANCE), 668 - LARGER_LEAVES);
    // With no band, two thirds.
    const bare = freeArea(view, phone({ band: false, options: false, safe: { top: 0, side: 0, bottom: 0 } }));
    assert.equal(largerRoom(view, bare, bare.top, FLIP_CLEARANCE), 563);
    // A 440 x 956 phone.
    const big = { width: 440, height: 956 };
    assert.equal(largerRoom(big, freeArea(big, chrome), 108, FLIP_CLEARANCE), 637);
    // Under a check's card, which ends at 230, the bar may reach 238 at the highest.
    assert.equal(largerRoom(view, free, 238, FLIP_CLEARANCE), 776 - 238 - LARGER_LEAVES);
    assert.equal(largerRoom(view, free, 900, FLIP_CLEARANCE), 0);
  });

  test("a bar under its token moves the map up by what its side lacks, and then has that room with its token clear and in view", () => {
    // Thorn's anchor at 391: 351 px below him, and the DM's 586 px of content.
    const dy = largerShift(room(391, 586));
    assert.equal(dy, -(548 - 351));
    const moved = after(391, 586, dy);
    assert.equal(moved.room, 548);
    assert.equal(moved.box.top, 776 - 548);
    assert.ok(moved.clear && moved.inside, JSON.stringify(moved));
    // Content shorter than the larger room asks only for itself: at 460 there are 282 px below and 278 above.
    const short = largerShift(room(460, 400));
    assert.equal(short, -(400 - 282));
    assert.equal(after(460, 400, short).box.height, 400);
  });

  test("a bar over its token moves the map down, and keeps over it", () => {
    // Low on the screen: 102 px below, 458 above.
    const dy = largerShift(room(640, 586));
    assert.equal(dy, 548 - 458);
    const moved = after(640, 586, dy);
    assert.equal(moved.room, 548);
    assert.equal(moved.box.top, free.top);
    assert.ok(moved.clear && moved.inside, JSON.stringify(moved));
  });

  test("under the column's first card the bar asks for less, and its token stays below the card", () => {
    const column = { top: 108, content: 122, first: 122 };
    const dy = largerShift(room(391, 586, column));
    assert.equal(dy, -(418 - 351));
    const moved = after(391, 586, dy, column);
    assert.equal(moved.room, 418);
    assert.ok(moved.clear && moved.inside, JSON.stringify(moved));
    assert.ok(391 + dy - 74 >= 238, "the token went under the card");
  });

  test("the map stays where the side already has the room, the content fits, or the bar does not span", () => {
    // High on the screen, 592 px below.
    assert.equal(largerShift(room(150, 586)), 0);
    // 300 px of content fit the 351 below.
    assert.equal(largerShift(room(391, 300)), 0);
    // Docked on its side, and compact on a screen too short to span.
    const side = { width: 844, height: 390 };
    assert.equal(largerShift({ layout: side, viewport: side, chrome, foot: 0, anchor: { x: 200, y: 200 }, column: null, height: 586, tokenHeight: FLIP_CLEARANCE }), 0);
    const tiny = { width: 246, height: 300 };
    assert.equal(largerShift({ layout: tiny, viewport: tiny, chrome, foot: 0, anchor: { x: 100, y: 150 }, column: null, height: 586, tokenHeight: FLIP_CLEARANCE }), 0);
  });

  test("Smaller moves the map back by what Larger moved it, never so far that the token leaves the free area", () => {
    const base = { layout: view, viewport: view, chrome, foot: 0, column: null, tokenHeight: FLIP_CLEARANCE };
    // Back down from a shift up, and back up from a shift down.
    assert.equal(smallerShift({ ...base, anchor: { x: 200, y: 194 }, moved: -197 }), 197);
    assert.equal(smallerShift({ ...base, anchor: { x: 200, y: 730 }, moved: 90 }), -90);
    // The viewer panned meanwhile: the token's label keeps above the free area's foot, and the token below its top.
    assert.equal(smallerShift({ ...base, anchor: { x: 200, y: 700 }, moved: -197 }), 776 - 34 - 700);
    assert.equal(smallerShift({ ...base, anchor: { x: 200, y: 150 }, moved: 90 }), -(150 - 40 - 108));
    assert.equal(smallerShift({ ...base, anchor: { x: 200, y: 100 }, moved: 90 }), 0);
    assert.equal(smallerShift({ ...base, anchor: { x: 200, y: 400 }, moved: 0 }), 0);
    // Larger then Smaller puts the bar back as it was.
    const dy = largerShift(room(391, 586));
    const back = smallerShift({ ...base, anchor: { x: 200, y: 391 + dy }, moved: dy });
    assert.equal(back, -dy);
    assert.deepEqual(after(391, 586, dy + back).box, after(391, 586, 0).box);
  });

  test("a bar that opens while another is still open keeps that one's move on its side, so Smaller puts the map back past both, and a move for the other side stays (review LP19-BS-1)", () => {
    const base = { layout: view, viewport: view, chrome, foot: 0, column: null, tokenHeight: FLIP_CLEARANCE };
    // Thorn's bar under him moved the map up 197. Kira, a cell below him, then opens under her with 520 px below: her own move is 28.
    const first = largerShift(room(391, 586));
    const kira = 391 + first + 28;
    const own = largerShift(room(kira, 586));
    assert.equal(own, -(548 - 520));
    const carried = carriedMove(room(kira, 586), first);
    assert.equal(carried, first);
    // Smaller on her bar moves the map back by both, to where it stood before Thorn's Larger.
    const back = smallerShift({ ...base, anchor: { x: 200, y: kira + own }, moved: carried + own });
    assert.equal(kira + own + back, 391 + 28);
    assert.deepEqual(after(391 + 28, 586, own + first + back).box, after(391 + 28, 586, 0).box);
    // The same token's bar over it, as the group's takes over from the single bar, keeps the move down.
    const down = largerShift(room(640, 586));
    assert.equal(carriedMove(room(640 + down, 586), down), down);
    // A bar over its token keeps none of a move up, which undone would grow it, nor a bar that docks, nor a closed bar's.
    assert.equal(carriedMove(room(700, 586), first), 0);
    const side = { width: 844, height: 390 };
    assert.equal(carriedMove({ ...room(200, 586), layout: side, viewport: side }, first), 0);
    assert.equal(carriedMove(room(kira, 586), 0), 0);
  });

  test("a tall or zoomed token keeps its top in the free area: Larger asks for less under a 128 px token, Smaller moves back less over a 64 px one, and a token too tall for more room moves nothing (review BS-ASTRA-01)", () => {
    // Under a 128 px token Larger leaves its label gap, its height and 12 px: 668 - 174 = 494, so the map moves up 143, not 197.
    const tall = 128;
    assert.equal(largerRoom(view, free, free.top, tall), 668 - (OFFSET_Y + tall + 12));
    const dy = largerShift(room(391, 586, null, tall));
    assert.equal(dy, -(494 - 351));
    assert.ok(391 + dy - tall >= free.top, `the token's top went to ${391 + dy - tall}, over the free area's top at ${free.top}`);
    const moved = after(391, 586, dy, null, tall);
    assert.equal(moved.room, 494);
    assert.ok(moved.clear && moved.inside, JSON.stringify(moved));
    // Smaller after the viewer panned Thorn up to 200: a 64 px token's top stops at the free area's top, 28 px back rather than 52.
    const back = smallerShift({ layout: view, viewport: view, chrome, foot: 0, column: null, anchor: { x: 200, y: 200 }, moved: 90, tokenHeight: 64 });
    assert.equal(back, -(200 - 64 - free.top));
    assert.ok(200 + back - 64 >= free.top, `the token's top went to ${200 + back - 64}`);
    // A token taller than the free area leaves room for leaves the bar as it is.
    assert.equal(largerRoom(view, free, free.top, 640), 0);
    assert.equal(largerShift(room(391, 586, null, 640)), 0);
  });
});
