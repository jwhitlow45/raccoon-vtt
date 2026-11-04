import assert from "node:assert/strict";
import { describe, test } from "node:test";
import fc from "fast-check";
import { stillFitsVideo, videoGeometryProblem, videoSizeFits } from "./limits.ts";
import type { VideoTurn } from "./model.ts";
import {
  VIDEO_MATRIX_ROWS,
  drawnSize,
  isPlainGeometry,
  matrixRow,
  mp4DrawnWidth,
  mp4Orientation,
  orientationFacts,
  orientationOf,
  parseVideoGeometry,
  rowShift,
  stretchedWidthPx,
  videoGeometryOf,
  webmDrawnWidth,
  type VideoMatrixRow,
  type VideoOrientation,
} from "./videoGeometry.ts";

/**
 * docs/design/design-v1-video-turns.md 4.1, 4.2, 6.1 and 6.2: the eight
 * orientations both ways, the drawn size, the integer pixel-shape rules,
 * and the shape and geometry rules with turned facts.
 */

const U = 0x10000;
const W_ONE = 0x40000000;

/** A display point by ISO 14496-12 8.3.2: (a·x + c·y + tx, b·x + d·y + ty). */
function apply(row: Pick<VideoMatrixRow, "a" | "b" | "c" | "d">, shift: readonly [number, number], x: number, y: number): [number, number] {
  return [row.a * x + row.c * y + shift[0], row.b * x + row.d * y + shift[1]];
}

function corners(w: number, h: number): [number, number][] {
  return [
    [0, 0],
    [w, 0],
    [0, h],
    [w, h],
  ];
}

/** A row's nine `tkhd` values in file order, with a translation, as raw 32-bit values the way a parser reads them. */
function nine(row: Pick<VideoMatrixRow, "a" | "b" | "c" | "d">, tx = 0, ty = 0): number[] {
  return [row.a * U, row.b * U, 0, row.c * U, row.d * U, 0, tx, ty, W_ONE];
}

/** The orientation read from a matrix without the table: mirrored when ad − bc is −1, and the turn from (mirrored ? −a : a, b). */
function oracleOrientation(a: number, b: number, c: number, d: number): VideoOrientation {
  const mirror = a * d - b * c === -1;
  const [x, y] = [mirror ? -a : a, b];
  const turn = x === 1 && y === 0 ? 0 : x === 0 && y === 1 ? 90 : x === -1 && y === 0 ? 180 : 270;
  return { turn, mirror };
}

describe("the eight orientations (4.1)", () => {
  test("the table holds each turn with and without a mirror once, and matrixRow finds each", () => {
    const seen = new Set(VIDEO_MATRIX_ROWS.map((r) => `${r.turn}/${r.mirror}`));
    assert.equal(seen.size, 8);
    for (const turn of [0, 90, 180, 270] as const) {
      for (const mirror of [false, true]) assert.deepEqual([matrixRow({ turn, mirror }).turn, matrixRow({ turn, mirror }).mirror], [turn, mirror]);
    }
  });

  test("each row's turn and mirror agree with the determinant and the turn read from its first column", () => {
    for (const r of VIDEO_MATRIX_ROWS) assert.deepEqual(oracleOrientation(r.a, r.b, r.c, r.d), { turn: r.turn, mirror: r.mirror }, `${r.turn} ${r.mirror}`);
  });

  test("a turn is clockwise and the mirror flips left to right after it", () => {
    // Screen y points down, so a clockwise quarter turn takes the top-left corner to the top right.
    const [w, h] = [16, 9];
    assert.deepEqual(apply(matrixRow({ turn: 90, mirror: false }), rowShift(matrixRow({ turn: 90, mirror: false }), w, h), 0, 0), [h, 0]);
    assert.deepEqual(apply(matrixRow({ turn: 270, mirror: false }), rowShift(matrixRow({ turn: 270, mirror: false }), w, h), 0, 0), [0, w]);
    for (const turn of [0, 90, 180, 270] as const) {
      const plain = matrixRow({ turn, mirror: false });
      const mirrored = matrixRow({ turn, mirror: true });
      const shownWidth = turn === 90 || turn === 270 ? h : w;
      for (const [x, y] of [...corners(w, h), [3, 5] as [number, number]]) {
        const [px, py] = apply(plain, rowShift(plain, w, h), x, y);
        assert.deepEqual(apply(mirrored, rowShift(mirrored, w, h), x, y), [shownWidth - px, py], `${turn} at ${x},${y}`);
      }
    }
  });

  test("each row with its own translation maps the picture onto the drawn box, corner to corner", () => {
    fc.assert(
      fc.property(fc.constantFrom(...VIDEO_MATRIX_ROWS), fc.integer({ min: 1, max: 5000 }), fc.integer({ min: 1, max: 5000 }), (row, w, h) => {
        const shown = drawnSize({ widthPx: w, heightPx: h, ...orientationFacts(row) });
        const mapped = corners(w, h).map(([x, y]) => apply(row, rowShift(row, w, h), x, y));
        const xs = mapped.map((p) => p[0]);
        const ys = mapped.map((p) => p[1]);
        assert.deepEqual([Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)], [0, shown.widthPx, 0, shown.heightPx]);
      }),
      { numRuns: 400 },
    );
  });

  test("orientationOf, orientationFacts and isPlainGeometry agree, and the plain parts are left out", () => {
    assert.deepEqual(orientationOf({}), { turn: 0, mirror: false });
    assert.deepEqual(orientationOf({ turn: 270, mirror: true }), { turn: 270, mirror: true });
    assert.deepEqual(orientationFacts({ turn: 0, mirror: false }), {});
    assert.deepEqual(orientationFacts({ turn: 90, mirror: true }), { turn: 90, mirror: true });
    assert.equal(isPlainGeometry({}), true);
    assert.equal(isPlainGeometry({ turn: 180 }), false);
    assert.equal(isPlainGeometry({ mirror: true }), false);
    assert.equal(isPlainGeometry({ displayWidthPx: 853 }), false);
    assert.deepEqual(Object.keys(videoGeometryOf({ displayWidthPx: 853, mirror: true, turn: 90 })), ["turn", "mirror", "displayWidthPx"]);
    assert.deepEqual(videoGeometryOf({ turn: undefined, mirror: undefined, displayWidthPx: undefined }), {});
  });
});

describe("an MP4's matrix (4.1)", () => {
  const W = 1920 * U;
  const H = 1080 * U;

  test("each row is accepted with zero translation and with its own pair, read signed or unsigned", () => {
    for (const row of VIDEO_MATRIX_ROWS) {
      const want = { turn: row.turn, mirror: row.mirror };
      assert.deepEqual(mp4Orientation(nine(row), W, H), want, `${row.turn} ${row.mirror} at zero`);
      assert.deepEqual(mp4Orientation(nine(row).map((v) => v >>> 0), W, H), want, "unsigned");
      if (row.shift) assert.deepEqual(mp4Orientation(nine(row, ...rowShift(row, W, H)), W, H), want, `${row.turn} ${row.mirror} shifted`);
    }
  });

  test("Android's portrait matrix and Apple's are a 90 turn, and Apple's 180 carries (W, H)", () => {
    assert.deepEqual(mp4Orientation([0, U, 0, -U, 0, 0, 0, 0, W_ONE], W, H), { turn: 90, mirror: false });
    assert.deepEqual(mp4Orientation([0, U, 0, -U, 0, 0, H, 0, W_ONE], W, H), { turn: 90, mirror: false });
    assert.deepEqual(mp4Orientation([-U, 0, 0, 0, -U, 0, W, H, W_ONE], W, H), { turn: 180, mirror: false });
  });

  test("a scale, a skew, 45 degrees, u, v or w off, the wrong pair and an odd translation are refused", () => {
    const r90 = matrixRow({ turn: 90, mirror: false });
    const refused: [string, number[]][] = [
      ["scale 2", [2 * U, 0, 0, 0, 2 * U, 0, 0, 0, W_ONE]],
      ["a skew", [U, U, 0, 0, U, 0, 0, 0, W_ONE]],
      ["45 degrees", [46341, 46341, 0, -46341, 46341, 0, 0, 0, W_ONE]],
      ["u", [U, 0, 1, 0, U, 0, 0, 0, W_ONE]],
      ["v", [U, 0, 0, 0, U, 1, 0, 0, W_ONE]],
      ["w", [U, 0, 0, 0, U, 0, 0, 0, U]],
      ["(W, 0) on the 90 row", nine(r90, W, 0)],
      ["(H, 0) on the 180 row", nine(matrixRow({ turn: 180, mirror: false }), H, 0)],
      ["any shift on the identity", nine(matrixRow({ turn: 0, mirror: false }), W, 0)],
      ["any shift on 90 mirrored", nine(matrixRow({ turn: 90, mirror: true }), H, W)],
      ["half the pair", nine(r90, H, 1)],
      ["eight values", nine(r90).slice(0, 8)],
      ["a value past 32 bits that wraps onto the row", [U + 2 ** 32, 0, 0, 0, U, 0, 0, 0, W_ONE]],
      ["a fraction", [U + 0.5, 0, 0, 0, U, 0, 0, 0, W_ONE]],
    ];
    for (const [why, matrix] of refused) assert.equal(mp4Orientation(matrix, W, H), undefined, why);
  });

  test("any nine values are accepted exactly when they are a signed permutation with its zero or positive-quadrant translation", () => {
    const entry = fc.oneof(fc.constantFrom(0, U, -U, 2 * U, U + 1, -U - 1), fc.integer({ min: -(2 ** 31), max: 2 ** 31 - 1 }));
    const linear = fc.oneof(
      fc.constantFrom(...VIDEO_MATRIX_ROWS).map((r) => [r.a * U, r.b * U, r.c * U, r.d * U]),
      fc.tuple(entry, entry, entry, entry),
    );
    const size = fc.oneof(
      fc.integer({ min: 1, max: 4096 }).map((n) => n * U),
      fc.integer({ min: 1, max: 2 ** 28 }),
    );
    const shift = fc.oneof(fc.constant("zero" as const), fc.constant("positive" as const), fc.tuple(fc.nat(4), fc.nat(4)));
    const corner = fc.constantFrom(0, 0, 0, 1);
    fc.assert(
      fc.property(linear, corner, corner, fc.constantFrom(W_ONE, W_ONE, W_ONE, U), size, size, shift, ([a, b, c, d], u, v, w, tw, th, how) => {
        const units = [a!, b!, c!, d!].map((n) => n / U) as [number, number, number, number];
        const signedPermutation = units.every((n) => n === -1 || n === 0 || n === 1) && units[0] ** 2 + units[1] ** 2 === 1 && units[2] ** 2 + units[3] ** 2 === 1 && units[0] * units[2] + units[1] * units[3] === 0;
        // The translation that brings the turned box back to the positive quadrant, from its corners alone.
        const mapped = corners(tw, th).map(([x, y]) => [units[0] * x + units[2] * y, units[1] * x + units[3] * y] as const);
        const positive = [0 - Math.min(...mapped.map((p) => p[0])), 0 - Math.min(...mapped.map((p) => p[1]))] as const;
        const pick = (n: number, i: 0 | 1) => [0, positive[i], tw, th, 7][n]!;
        const [tx, ty] = how === "zero" ? [0, 0] : how === "positive" ? positive : [pick(how[0], 0), pick(how[1], 1)];
        const zero = tx === 0 && ty === 0;
        const accepted = u === 0 && v === 0 && w === W_ONE && signedPermutation && (zero || (tx === positive[0] && ty === positive[1]));
        const got = mp4Orientation([a!, b!, u, c!, d!, v, tx, ty, w], tw, th);
        assert.deepEqual(got, accepted ? oracleOrientation(units[0], units[1], units[2], units[3]) : undefined);
      }),
      { numRuns: 4000 },
    );
  });
});

describe("the drawn size (6.2)", () => {
  test("is the stretched or coded width by the coded height, swapped for a quarter turn", () => {
    const facts = { widthPx: 1920, heightPx: 1080 };
    assert.deepEqual(drawnSize(facts), { widthPx: 1920, heightPx: 1080 });
    assert.deepEqual(drawnSize({ ...facts, turn: 90 }), { widthPx: 1080, heightPx: 1920 });
    assert.deepEqual(drawnSize({ ...facts, turn: 180 }), { widthPx: 1920, heightPx: 1080 });
    assert.deepEqual(drawnSize({ ...facts, turn: 270 }), { widthPx: 1080, heightPx: 1920 });
    assert.deepEqual(drawnSize({ widthPx: 640, heightPx: 360, displayWidthPx: 853 }), { widthPx: 853, heightPx: 360 });
    assert.deepEqual(drawnSize({ widthPx: 640, heightPx: 360, displayWidthPx: 853, turn: 270 }), { widthPx: 360, heightPx: 853 });
  });
});

describe("pixel shapes in integers (4.1, 4.2, D-261102-899)", () => {
  test("a stretched width rounds half up, and a shape past 1:2 or 2:1 has none", () => {
    assert.equal(stretchedWidthPx(640, 4, 3), 853);
    assert.equal(stretchedWidthPx(1440, 4, 3), 1920);
    assert.equal(stretchedWidthPx(720, 10, 11), 655);
    assert.equal(stretchedWidthPx(640, 1, 1), 640);
    assert.equal(stretchedWidthPx(3, 1, 2), 2, "1.5 rounds up");
    assert.equal(stretchedWidthPx(5, 1, 2), 3, "2.5 rounds up");
    assert.equal(stretchedWidthPx(640, 1, 2), 320, "1:2 itself");
    assert.equal(stretchedWidthPx(640, 2, 1), 1280, "2:1 itself");
    assert.equal(stretchedWidthPx(640, 65_535, 32_767), undefined, "just past 2:1");
    assert.equal(stretchedWidthPx(640, 3, 1), undefined);
    assert.equal(stretchedWidthPx(640, 1, 3), undefined);
    assert.equal(stretchedWidthPx(640, 0, 3), undefined);
    assert.equal(stretchedWidthPx(640, 4.5, 3), undefined);
    assert.equal(stretchedWidthPx(0, 4, 3), undefined);
  });

  test("any terms: in range exactly when 2·num ≥ den and num ≤ 2·den, and then the nearest width, ties up", () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 8192 }), fc.integer({ min: 1, max: 2 ** 40 }), fc.integer({ min: 1, max: 2 ** 40 }), (w, n, d) => {
        const got = stretchedWidthPx(w, n, d);
        const [W, N, D] = [BigInt(w), BigInt(n), BigInt(d)];
        if (2n * N < D || N > 2n * D) return assert.equal(got, undefined);
        assert.ok(got !== undefined);
        // r is the nearest whole width with a tie going up: −d < 2·r·d − 2·w·n ≤ d.
        const gap = 2n * BigInt(got) * D - 2n * W * N;
        assert.ok(-D < gap && gap <= D, `${w} ${n}/${d} gave ${got}`);
      }),
      { numRuns: 2000 },
    );
  });

  describe("an MP4's size (4.1)", () => {
    const plain = { codedWidthPx: 640, codedHeightPx: 360, tkhdWidth: 640 * U, tkhdHeight: 360 * U, sizeIsAspectRatio: false };
    const ffmpeg = Math.round(((640 * 4) / 3) * U);

    test("a plain track keeps its coded width", () => {
      assert.equal(mp4DrawnWidth(plain), 640);
      assert.equal(mp4DrawnWidth({ ...plain, pasp: { h: 1, v: 1 } }), 640);
      assert.equal(mp4DrawnWidth({ ...plain, pasp: { h: 0, v: 0 } }), 640, "0:0, as today");
      assert.equal(mp4DrawnWidth({ ...plain, sizeIsAspectRatio: true }), 640, "the flag without a stretch");
    });

    test("pasp 4:3 with tkhd coded or FFmpeg's rounded 16.16, and a tkhd-only stretch, draw 853 wide", () => {
      assert.equal(mp4DrawnWidth({ ...plain, pasp: { h: 4, v: 3 } }), 853);
      assert.equal(mp4DrawnWidth({ ...plain, pasp: { h: 4, v: 3 }, tkhdWidth: ffmpeg }), 853);
      assert.equal(mp4DrawnWidth({ ...plain, pasp: { h: 4, v: 3 }, tkhdWidth: ffmpeg + U }), 853, "a pixel off is within");
      assert.equal(mp4DrawnWidth({ ...plain, tkhdWidth: ffmpeg }), 853, "tkhd alone");
      assert.equal(mp4DrawnWidth({ codedWidthPx: 1440, codedHeightPx: 1080, tkhdWidth: 1920 * U, tkhdHeight: 1080 * U, pasp: { h: 4, v: 3 }, sizeIsAspectRatio: false }), 1920);
      assert.equal(mp4DrawnWidth({ codedWidthPx: 720, codedHeightPx: 480, tkhdWidth: 720 * U, tkhdHeight: 480 * U, pasp: { h: 10, v: 11 }, sizeIsAspectRatio: false }), 655);
    });

    test("a shape that rounds to the coded width is square", () => {
      assert.equal(mp4DrawnWidth({ codedWidthPx: 300, codedHeightPx: 300, tkhdWidth: 300 * U, tkhdHeight: 300 * U, pasp: { h: 1001, v: 1000 }, sizeIsAspectRatio: false }), 300);
    });

    test("pasp 3:1, 0:3 or 70000:1, tkhd 2 px off the pasp, a square pasp with a stretched tkhd, the flag with any stretch, and a turned tkhd size are refused", () => {
      const refused: [string, Parameters<typeof mp4DrawnWidth>[0]][] = [
        ["pasp 3:1", { ...plain, pasp: { h: 3, v: 1 } }],
        ["pasp 0:3", { ...plain, pasp: { h: 0, v: 3 } }],
        ["pasp 70000:1", { ...plain, pasp: { h: 70_000, v: 1 } }],
        ["pasp 70000:69999", { ...plain, pasp: { h: 70_000, v: 69_999 } }],
        ["tkhd 2 px off", { ...plain, pasp: { h: 4, v: 3 }, tkhdWidth: ffmpeg + 2 * U }],
        ["tkhd 2 px under", { ...plain, pasp: { h: 4, v: 3 }, tkhdWidth: ffmpeg - 2 * U }],
        ["a square pasp with a stretched tkhd", { ...plain, pasp: { h: 4, v: 4 }, tkhdWidth: ffmpeg }],
        ["0:0 with a stretched tkhd", { ...plain, pasp: { h: 0, v: 0 }, tkhdWidth: ffmpeg }],
        ["the flag with pasp 4:3", { ...plain, pasp: { h: 4, v: 3 }, sizeIsAspectRatio: true }],
        ["the flag with a tkhd stretch", { ...plain, tkhdWidth: ffmpeg, sizeIsAspectRatio: true }],
        ["the flag with a tkhd a fraction off", { ...plain, tkhdWidth: 640 * U + 1, sizeIsAspectRatio: true }],
        ["tkhd's height a fraction off", { ...plain, tkhdHeight: 360 * U + 1 }],
        ["tkhd holding the turned size", { ...plain, tkhdWidth: 360 * U, tkhdHeight: 640 * U }],
        ["tkhd past twice", { ...plain, tkhdWidth: 1281 * U }],
        ["tkhd zero wide", { ...plain, tkhdWidth: 0 }],
      ];
      for (const [why, fields] of refused) assert.equal(mp4DrawnWidth(fields), undefined, why);
    });
  });

  describe("a WebM's display size (4.2)", () => {
    const track = { pixelWidth: 640, pixelHeight: 360 };

    test("DisplayWidth 853 and a DisplayHeight stretch draw 853 wide, and a pure scale is square", () => {
      assert.equal(webmDrawnWidth(track), 640);
      assert.equal(webmDrawnWidth({ ...track, displayWidth: 853 }), 853);
      assert.equal(webmDrawnWidth({ ...track, displayWidth: 853, displayHeight: 360 }), 853);
      assert.equal(webmDrawnWidth({ ...track, displayHeight: 270 }), 853);
      assert.equal(webmDrawnWidth({ pixelWidth: 2560, pixelHeight: 1440, displayWidth: 5120, displayHeight: 2880 }), 2560);
      assert.equal(webmDrawnWidth({ ...track, displayWidth: 1280 }), 1280, "2:1 itself");
    });

    test("a display term outside 1 to 65535, or a shape past 2:1, is refused", () => {
      for (const fields of [{ displayWidth: 70_000 }, { displayWidth: 0 }, { displayHeight: 0 }, { displayWidth: 853.5 }, { displayWidth: 1281 }, { displayHeight: 721 }]) {
        assert.equal(webmDrawnWidth({ ...track, ...fields }), undefined, JSON.stringify(fields));
      }
    });

    test("any display size: in range by 4.2's products, square when they are equal, else DW·PH / DH rounded half up", () => {
      fc.assert(
        fc.property(fc.integer({ min: 1, max: 8192 }), fc.integer({ min: 1, max: 8192 }), fc.integer({ min: 1, max: 65_535 }), fc.integer({ min: 1, max: 65_535 }), (pw, ph, dw, dh) => {
          const got = webmDrawnWidth({ pixelWidth: pw, pixelHeight: ph, displayWidth: dw, displayHeight: dh });
          if (!(2 * dw * ph >= dh * pw && dw * ph <= 2 * dh * pw)) return assert.equal(got, undefined);
          if (dw * ph === dh * pw) return assert.equal(got, pw);
          assert.equal(got, Math.floor((2 * dw * ph + dh) / (2 * dh)));
        }),
        { numRuns: 2000 },
      );
    });
  });
});

describe("the geometry rule and the caps (4.3, 6.1)", () => {
  const facts = { widthPx: 1920, heightPx: 1080 };

  test("plain, turned, mirrored and stretched facts stand", () => {
    assert.equal(videoGeometryProblem(facts), null);
    for (const turn of [90, 180, 270] as VideoTurn[]) assert.equal(videoGeometryProblem({ ...facts, turn }), null, `turn ${turn}`);
    assert.equal(videoGeometryProblem({ ...facts, mirror: true }), null);
    assert.equal(videoGeometryProblem({ widthPx: 640, heightPx: 360, displayWidthPx: 853 }), null);
    assert.equal(videoGeometryProblem({ widthPx: 640, heightPx: 360, displayWidthPx: 320 }), null, "half itself");
    assert.equal(videoGeometryProblem({ widthPx: 640, heightPx: 360, displayWidthPx: 1280 }), null, "twice itself");
    assert.equal(videoGeometryProblem({ widthPx: 3840, heightPx: 2160, turn: 90 }), null, "a turn never changes the caps' answer");
    assert.equal(videoGeometryProblem({ widthPx: 2048, heightPx: 1080, displayWidthPx: 4096 }), null, "the side cap itself");
  });

  test("a stretched width equal to the coded one, outside half to twice, or not whole, and a drawn size past the caps, are refused", () => {
    const refused: [string, Parameters<typeof videoGeometryProblem>[0]][] = [
      ["equal", { widthPx: 640, heightPx: 360, displayWidthPx: 640 }],
      ["past twice", { widthPx: 640, heightPx: 360, displayWidthPx: 1281 }],
      ["under half", { widthPx: 640, heightPx: 360, displayWidthPx: 319 }],
      ["not whole", { widthPx: 640, heightPx: 360, displayWidthPx: 853.5 }],
      ["past the area", { widthPx: 3840, heightPx: 2160, displayWidthPx: 4000 }],
      ["past 4096", { widthPx: 2560, heightPx: 1080, displayWidthPx: 4097 }],
      ["under 256 drawn", { widthPx: 400, heightPx: 400, displayWidthPx: 255 }],
      ["a turn of 45", { ...facts, turn: 45 as VideoTurn }],
      ["a mirror of false", { ...facts, mirror: false as unknown as true }],
    ];
    for (const [why, f] of refused) assert.notEqual(videoGeometryProblem(f), null, why);
  });

  test("the caps take each side and the area", () => {
    assert.equal(videoSizeFits({ widthPx: 3840, heightPx: 2160 }), true);
    assert.equal(videoSizeFits({ widthPx: 4096, heightPx: 256 }), true);
    assert.equal(videoSizeFits({ widthPx: 4097, heightPx: 256 }), false);
    assert.equal(videoSizeFits({ widthPx: 1920, heightPx: 255 }), false);
    assert.equal(videoSizeFits({ widthPx: 3841, heightPx: 2160 }), false);
  });
});

describe("a still's shape with turned facts (6.2)", () => {
  test("a portrait still fits a quarter-turned landscape file, and a landscape still does not", () => {
    const facts = { widthPx: 1920, heightPx: 1080 };
    for (const turn of [90, 270] as const) {
      assert.equal(stillFitsVideo({ widthPx: 1080, heightPx: 1920 }, { ...facts, turn }), true);
      assert.equal(stillFitsVideo({ widthPx: 1080, heightPx: 1921 }, { ...facts, turn }), true, "a pixel off");
      assert.equal(stillFitsVideo({ widthPx: 1920, heightPx: 1080 }, { ...facts, turn }), false);
    }
    assert.equal(stillFitsVideo({ widthPx: 1920, heightPx: 1080 }, { ...facts, turn: 180 }), true);
    assert.equal(stillFitsVideo({ widthPx: 1080, heightPx: 1920 }, { ...facts, turn: 180 }), false);
  });

  test("a stretched file takes a still of its drawn shape", () => {
    const wide = { widthPx: 640, heightPx: 360, displayWidthPx: 853 };
    assert.equal(stillFitsVideo({ widthPx: 853, heightPx: 360 }, wide), true);
    assert.equal(stillFitsVideo({ widthPx: 1706, heightPx: 720 }, wide), true);
    assert.equal(stillFitsVideo({ widthPx: 640, heightPx: 360 }, wide), false);
    assert.equal(stillFitsVideo({ widthPx: 360, heightPx: 853 }, { ...wide, turn: 90 }), true);
  });
});

describe("a backup's manifest geometry (9, stage 1)", () => {
  test("only the three fields, each in its shape, pass, in a fixed order", () => {
    assert.deepEqual(parseVideoGeometry({}), {});
    assert.deepEqual(parseVideoGeometry({ turn: 90 }), { turn: 90 });
    assert.deepEqual(parseVideoGeometry({ displayWidthPx: 853, mirror: true, turn: 270 }), { turn: 270, mirror: true, displayWidthPx: 853 });
    assert.deepEqual(Object.keys(parseVideoGeometry({ displayWidthPx: 853, mirror: true, turn: 270 })!), ["turn", "mirror", "displayWidthPx"]);
    assert.deepEqual(parseVideoGeometry({ displayWidthPx: 1 }), { displayWidthPx: 1 });
    assert.deepEqual(parseVideoGeometry({ displayWidthPx: 65_535 }), { displayWidthPx: 65_535 });
  });

  test("anything else skips the entry", () => {
    for (const value of [
      null,
      "turn",
      [90],
      { turn: 45 },
      { turn: 0 },
      { turn: "90" },
      { mirror: false },
      { mirror: "true" },
      { displayWidthPx: 0 },
      { displayWidthPx: 65_536 },
      { displayWidthPx: 853.5 },
      { displayWidthPx: "853" },
      { turn: 90, crop: 8 },
    ]) {
      assert.equal(parseVideoGeometry(value), undefined, JSON.stringify(value));
    }
  });
});
