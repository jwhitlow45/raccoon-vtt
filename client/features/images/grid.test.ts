import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { gridWindow, tilePosition } from "./grid.ts";

describe("windowed tile grid", () => {
  const base = { count: 4180, tile: 56, gap: 4, width: 358, viewHeight: 300, scrollTop: 0 };

  test("columns fit the width, and the content is as tall as every row", () => {
    const w = gridWindow(base);
    assert.equal(w.columns, 6); // 6 tiles and 5 gaps are 356 px
    assert.equal(w.rows, Math.ceil(4180 / 6));
    assert.equal(w.height, w.rows * 60 - 4);
  });

  test("at the top it mounts the rows in view and two more", () => {
    const w = gridWindow(base);
    assert.equal(w.start, 0);
    assert.equal(w.end, (5 + 2) * 6);
  });

  test("scrolled, it mounts the rows in view with two either side", () => {
    const w = gridWindow({ ...base, scrollTop: 600 });
    assert.equal(w.start, (10 - 2) * 6);
    assert.equal(w.end, (15 + 2) * 6);
  });

  test("never past the last tile, and empty for no tiles", () => {
    const end = gridWindow({ ...base, count: 20, scrollTop: 10_000 });
    assert.equal(end.end, 20);
    assert.ok(end.start <= end.end);
    assert.deepEqual(gridWindow({ ...base, count: 0 }), { columns: 6, rows: 0, height: 0, start: 0, end: 0 });
  });

  test("a narrow box still has one column", () => {
    assert.equal(gridWindow({ ...base, width: 20 }).columns, 1);
    assert.equal(gridWindow({ ...base, width: 0 }).columns, 1);
  });

  test("a tile's place", () => {
    assert.deepEqual(tilePosition(0, 6, 56, 4), { left: 0, top: 0 });
    assert.deepEqual(tilePosition(7, 6, 56, 4), { left: 60, top: 60 });
  });
});
