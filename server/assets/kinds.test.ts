import assert from "node:assert/strict";
import { test } from "node:test";
import { SOUND_LIMITS, VIDEO_LIMITS } from "#shared/limits.ts";
import { ASSET_KINDS, KINDS, PLAYER_UPLOAD_KINDS, SOUND_PIPELINE, VIDEO_PIPELINE, cellPxHint, isAssetKind, nameGrid } from "./kinds.ts";

test("a cols x rows name suggests the cell size when both axes agree", () => {
  assert.equal(cellPxHint("crypt_30x20.jpg", 3000, 2000), 100);
  assert.equal(cellPxHint("Crypt 30 X 20 final.png", 2100, 1400), 70);
  assert.equal(cellPxHint("road-24×18.webp", 1680, 1260), 70);
  assert.equal(cellPxHint("odd_7x5.png", 1000, 714), 142.86);
});

test("no suggestion when the name has no hint or the axes disagree", () => {
  assert.equal(cellPxHint(undefined, 3000, 2000), undefined);
  assert.equal(cellPxHint("tavern.jpg", 3000, 2000), undefined);
  assert.equal(cellPxHint("crypt_30x20.jpg", 3000, 3000), undefined);
});

test("pixel sizes and out-of-range counts are not cell counts", () => {
  assert.equal(cellPxHint("wallpaper_1920x1080.jpg", 1920, 1080), undefined);
  assert.equal(cellPxHint("big_300x200.jpg", 6000, 4000), undefined);
  assert.equal(cellPxHint("zero_0x10.jpg", 100, 100), undefined);
});

/** A name's hex reading in whole px, since the art's edge is a whole px and the cell size comes out a hundredth off. */
function hexPx(name: string, width: number, height: number) {
  const { hexes } = nameGrid(name, width, height);
  return hexes && { ...(hexes.rows === undefined ? {} : { rows: Math.round(hexes.rows) }), ...(hexes.columns === undefined ? {} : { columns: Math.round(hexes.columns) }) };
}

test("a name's counts are also read as hex rows and hex columns, each by its own lattice (D-261101-190)", () => {
  // 20 x 14 hexes of 70 px: rows are 20.5 hexes wide and 12.41 hexes tall, columns the other way about.
  assert.deepEqual(hexPx("crypt_20x14.jpg", 1435, 869), { rows: 70 });
  assert.deepEqual(hexPx("crypt_20x14.jpg", 1233, 1015), { columns: 70 });
  assert.deepEqual(hexPx("Crypt 30 X 20.png", 2135, 1233), { rows: 70 });
  assert.deepEqual(nameGrid("crypt_20x14.jpg", 1400, 980), { squares: 70 });
  assert.equal(nameGrid("crypt_20x14.jpg", 1435, 869).squares, undefined);
});

test("a hex reading needs both axes within 2%, and the art's exact edge", () => {
  assert.deepEqual(nameGrid("crypt_20x14.jpg", 1435, 900), {});
  assert.deepEqual(nameGrid("crypt_20x14.jpg", 1400, 869), {}, "20 hexes with no half hex for the odd rows is not rows' span");
  assert.deepEqual(hexPx("crypt_20x14.jpg", 1435, Math.round(869 * 1.019)), { rows: 70 });
  assert.deepEqual(nameGrid("big_300x200.jpg", 21000, 12500), {});
  assert.deepEqual(nameGrid("tavern.jpg", 1435, 869), {});
  assert.deepEqual(nameGrid(undefined, 1435, 869), {});
});

test("a single hex row or column has no odd row to stand out by half a hex", () => {
  // 30 x 1 hexes of 70 px on rows: 2100 wide, one hex (2 x 40.41) tall. Columns the other way about.
  assert.deepEqual(hexPx("row_30x1.png", 2100, 81), { rows: 70 });
  assert.deepEqual(hexPx("row_20x1.png", 1400, 81), { rows: 70 });
  assert.deepEqual(hexPx("column_1x30.png", 81, 2100), { columns: 70 });
  assert.deepEqual(hexPx("column_1x20.png", 81, 1400), { columns: 70 });
  // One hex is 70 across its flats and 80.83 across its corners, either way up.
  assert.deepEqual(hexPx("one_1x1.png", 70, 81), { rows: 70 });
  assert.deepEqual(hexPx("one_1x1.png", 81, 70), { columns: 70 });
  assert.deepEqual(nameGrid("row_20x1.png", 1435, 81), {}, "a single row with an odd row's half hex is not its span");
});

test("a video is a kind of its own: the DM's alone to add, players read it when shown, one file at the video cap (docs/design/design-v1-animated-maps.md 9.1)", () => {
  assert.ok(ASSET_KINDS.includes("video"));
  assert.equal(isAssetKind("video"), true);
  assert.deepEqual(KINDS.video, {
    maxUploadBytes: VIDEO_LIMITS.fileBytes,
    deadlineMs: VIDEO_LIMITS.uploadDeadlineMs,
    variants: [{ name: "full", maxSide: VIDEO_LIMITS.maxSidePx }],
    dmOnly: true,
    playersRead: true,
  });
  assert.ok(!PLAYER_UPLOAD_KINDS.includes("video"));
  assert.ok(Number.isInteger(VIDEO_PIPELINE) && VIDEO_PIPELINE >= 1);
});

test("a sound is a kind of its own: the DM's alone to add, players read it while it plays, one file at the sound cap (docs/design/design-v1-sound.md 7.2)", () => {
  assert.equal(isAssetKind("sound"), true);
  assert.deepEqual(KINDS.sound, {
    maxUploadBytes: SOUND_LIMITS.fileBytes,
    deadlineMs: SOUND_LIMITS.uploadDeadlineMs,
    variants: [{ name: "full", maxSide: 0 }],
    dmOnly: true,
    playersRead: true,
  });
  assert.ok(!PLAYER_UPLOAD_KINDS.includes("sound"));
  assert.ok(Number.isInteger(SOUND_PIPELINE) && SOUND_PIPELINE >= 1);
});
