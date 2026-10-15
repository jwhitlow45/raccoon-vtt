import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  barCover,
  barMode,
  BESIDE_MIN,
  clampBox,
  clearAnchor,
  columnFacts,
  columnRoom,
  columnTop,
  compactHang,
  DEFAULT_SPOT,
  freeArea,
  hangBox,
  hintRoom,
  isDefaultSpot,
  laneLeft,
  nextCorner,
  noticePlace,
  overlapsLane,
  parseSpot,
  placeBar,
  pastBars,
  readSpot,
  releaseSpot,
  restingBar,
  shareLane,
  shortHint,
  SPOT_KEY,
  spotHang,
  spotText,
  writeSpot,
  type Box,
  type Chrome,
  type Hang,
} from "./barDock.ts";

const NONE = { top: 0, right: 0, bottom: 0, left: 0 };
/** Select several's bar: one 52 px row (docs/design-v1-bar-dock.md section 3). */
const OPTIONS = 52;

/** A phone's chrome at full size: the top bar, an optional turn band, the toolbar, Select several's bar and the safe areas. */
function phone(input: { band: boolean; options: boolean; safe: { top: number; side: number; bottom: number } }): Chrome {
  const toolbar = 60 + input.safe.bottom;
  return {
    top: 52 + input.safe.top + (input.band ? 48 : 0),
    bottom: toolbar + (input.options ? OPTIONS : 0),
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
    const free = freeArea({ width: 920, height: 800 }, { top: 52, bottom: 60, toolbar: 60, safe: NONE, sheet: 0 });
    assert.deepEqual(free, { left: 8, top: 60, width: 904, height: 672 });
  });

  test("the turn band, the options bar and the safe areas each take their share", () => {
    const plain = freeArea({ width: 649, height: 300 }, phone({ band: false, options: false, safe: { top: 0, side: 47, bottom: 21 } }));
    assert.deepEqual(plain, { left: 55, top: 60, width: 539, height: 151 });
    const busy = freeArea({ width: 649, height: 300 }, phone({ band: true, options: true, safe: { top: 0, side: 47, bottom: 21 } }));
    assert.deepEqual(busy, { left: 55, top: 108, width: 539, height: 51 });
  });

  test("a roll card standing on a narrow screen's toolbar and options bar takes the bottom above them", () => {
    const chrome: Chrome = { top: 52, bottom: 60 + 52, toolbar: 60, safe: NONE, sheet: 0 };
    const viewport = { width: 390, height: 844 };
    assert.equal(freeArea(viewport, chrome, 250).height, 844 - 112 - 250 - 8 - 60);
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
  test("covers only the Select several bar when 148 px reach the toolbar, and the toolbar too when they do not", () => {
    const viewport = { width: 649, height: 300 };
    const short = compactHang(viewport, viewport, phone({ band: false, options: true, safe: { top: 0, side: 47, bottom: 21 } }));
    assert.equal(short.coversToolbar, false);
    assert.equal(short.at, 300 - 81 - 8);
    const shorter = compactHang(viewport, viewport, phone({ band: true, options: true, safe: { top: 0, side: 47, bottom: 21 } }));
    assert.equal(shorter.coversToolbar, true);
    assert.equal(shorter.at, 300 - 21 - 8);
  });

  // The worked examples of design 1.4, Select several on, insets at full size: the overlay's height, then what the summary row leaves the bar.
  const summary = (chrome: Chrome, viewport: { width: number; height: number }) => {
    const hang = compactHang(viewport, viewport, chrome);
    const free = freeArea(viewport, chrome);
    const shared = shareLane({ hang, laneTop: free.top, laneHeight: hang.room, column: { top: free.top, content: 200, first: 120 }, laneLeft: laneLeft(free), besideRoom: free.width - 312, content: 900 });
    return { overlay: hang.room, lane: shared.lane, bar: shared.hang.room, width: hang.width };
  };

  test("480 x 320 at 130%, 47 px at the sides and 21 at the bottom", () => {
    const viewport = { width: 369, height: 246 };
    const safe = { top: 0, side: 47, bottom: 21 };
    assert.equal(freeArea(viewport, phone({ band: false, options: true, safe })).height, 45);
    assert.equal(freeArea(viewport, phone({ band: true, options: true, safe })).height, -3);
    assert.deepEqual(summary(phone({ band: false, options: true, safe }), viewport), { overlay: 157, lane: "summary", bar: 105, width: 259 });
    assert.deepEqual(summary(phone({ band: true, options: true, safe }), viewport), { overlay: 109, lane: "summary", bar: 57, width: 259 });
  });

  test("844 x 390 at 130%, the same insets", () => {
    const viewport = { width: 649, height: 300 };
    const safe = { top: 0, side: 47, bottom: 21 };
    assert.equal(freeArea(viewport, phone({ band: false, options: true, safe })).height, 99);
    assert.deepEqual(summary(phone({ band: false, options: true, safe }), viewport), { overlay: 151, lane: "summary", bar: 99, width: 304 });
    assert.deepEqual(summary(phone({ band: true, options: true, safe }), viewport), { overlay: 163, lane: "summary", bar: 111, width: 304 });
    // Without Select several the bar docks, and an alert's summary row leaves it the header and a row.
    const chrome = phone({ band: false, options: false, safe });
    const free = freeArea(viewport, chrome);
    assert.equal(barMode(viewport, free.height), "dock");
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
    assert.equal(freeArea(viewport, phone({ band: true, options: true, safe })).height, 63);
    assert.deepEqual(summary(phone({ band: true, options: true, safe }), viewport), { overlay: 175, lane: "summary", bar: 123, width: 230 });
    assert.equal(freeArea(viewport, phone({ band: false, options: true, safe })).height, 111);
    assert.deepEqual(summary(phone({ band: false, options: true, safe }), viewport), { overlay: 163, lane: "summary", bar: 111, width: 230 });
    assert.equal(compactHang(viewport, viewport, phone({ band: false, options: true, safe })).coversToolbar, false);
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

  test("Move bar goes clockwise from the bottom right, flush with each corner, and says where", () => {
    let spot = DEFAULT_SPOT;
    const said: string[] = [];
    for (let i = 0; i < 4; i++) {
      const next = nextCorner(spot);
      said.push(next.status);
      spot = next.spot;
      assert.equal(spot.x, 0);
      assert.equal(spot.y, 0);
    }
    assert.deepEqual(said, ["Bar at bottom left", "Bar at top left", "Bar at top right", "Bar at bottom right"]);
    assert.ok(isDefaultSpot(spot), "the fourth press is the default spot, stored as no key");
    assert.equal(nextCorner({ corner: "tl", x: 120, y: 40 }).spot.corner, "tr");
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
    const chrome: Chrome = { top: 52, bottom: 60, toolbar: 60, safe: NONE, sheet: 0 };
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

describe("fit and find keep clear of the bar", () => {
  const viewport = { width: 920, height: 800 };
  const bars = { top: 52, right: 0, bottom: 60, left: 0 };
  const lane = 920 - 8 - 312;

  test("a bar in the lane covers the lane's side, whatever its height", () => {
    for (const height of [120, 300, 600]) {
      const cover = barCover(viewport, bars, { box: { left: lane + 8, top: 732 - height, width: 304, height }, laneLeft: lane });
      assert.deepEqual(cover, { top: 0, right: 320, bottom: 0, left: 0 });
    }
  });

  test("a bar elsewhere covers the side that leaves the largest clear rectangle", () => {
    const at = (left: number, top: number, width = 304, height = 200) => barCover(viewport, bars, { box: { left, top, width, height }, laneLeft: lane });
    assert.deepEqual(at(8, 300), { top: 0, right: 0, bottom: 0, left: 312 });
    assert.deepEqual(at(400, 300, 304, 200).right, 520);
    assert.deepEqual(at(8, 60, 900, 150), { top: 210, right: 0, bottom: 0, left: 0 });
    assert.deepEqual(at(8, 580, 900, 150), { top: 0, right: 0, bottom: 220, left: 0 });
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
    const chrome: Chrome = { top: 52, bottom: 60, toolbar: 60, safe: NONE, sheet: 0 };
    const rest = restingBar({ layout: { width: 1280, height: 800 }, viewport, chrome, spot: DEFAULT_SPOT, height: 250, column: null });
    assert.deepEqual(rest, { box: { left: 920 - 8 - 304, top: 800 - 60 - 8 - 250, width: 304, height: 250 }, laneLeft: lane });
    assert.equal(restingBar({ layout: { width: 390, height: 844 }, viewport: { width: 390, height: 844 }, chrome, spot: DEFAULT_SPOT, height: 250, column: null }), null);
  });

  test("a bar about to open shares the lane with the column as the drawn bar will, so a pan never lands a token under it", () => {
    // 1180 x 390: an 820 px map, and a 150 px first card leaves the bar too little under it, so it moves beside the lane.
    const chrome: Chrome = { top: 52, bottom: 60, toolbar: 60, safe: NONE, sheet: 0 };
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

describe("the Select several hint", () => {
  test("from 900 px up the room comes from the map's width, whichever hint shows", () => {
    // 1280 x 800: the map is 920 wide, and the bar's padding and edges take 18.
    assert.equal(hintRoom({ wide: true, mapWidth: 920, padding: 18, inner: 120 }), 622);
    assert.equal(shortHint(hintRoom({ wide: true, mapWidth: 920, padding: 18, inner: 120 })), false);
    assert.equal(hintRoom({ wide: true, mapWidth: 920, padding: 18, inner: 900 }), 622, "the bar's own width never decides");
    assert.equal(shortHint(hintRoom({ wide: true, mapWidth: 540, padding: 18, inner: 900 })), true);
  });

  test("on a phone the bar's own inner width is the room", () => {
    assert.equal(shortHint(hintRoom({ wide: false, mapWidth: 649, padding: 110, inner: 539 })), true);
    assert.equal(shortHint(hintRoom({ wide: false, mapWidth: 820, padding: 18, inner: 802 })), false);
  });
});
