import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { fileSizeProblem, MAX_FILE_BYTES, MAX_PHONE_FILE_BYTES, MAX_POINTS, MAX_POLYLINES, NO_IMAGE, NOT_UVTT } from "./limits.ts";
import { readUvtt } from "./schema.ts";
import { uvttFile } from "./synthetic.ts";

const MiB = 1024 * 1024;

describe("the file's size, before a byte is read", () => {
  test("a phone takes up to 40 MB and says to use a computer past it", () => {
    assert.equal(fileSizeProblem(MAX_PHONE_FILE_BYTES, "phone"), null);
    assert.equal(fileSizeProblem(90 * MiB, "phone"), "This file is 90 MB. On a phone, import files up to 40 MB, or import it on a computer.");
  });

  test("a computer takes up to 150 MB", () => {
    assert.equal(fileSizeProblem(90 * MiB, "computer"), null);
    assert.equal(fileSizeProblem(MAX_FILE_BYTES, "computer"), null);
    assert.match(fileSizeProblem(MAX_FILE_BYTES + 1, "computer") ?? "", /at most 150 MB/);
    assert.equal(fileSizeProblem(0, "computer"), "This file is empty.");
  });
});

describe("reading a Universal VTT file", () => {
  test("reads the keys the import uses and ignores the rest", () => {
    const file = uvttFile({
      origin: { x: -0.5, y: 1 },
      size: { x: 12, y: 8 },
      walls: [[{ x: 0, y: 1 }, { x: 4, y: 1 }]],
      objects: [[{ x: 2, y: 3 }, { x: 3, y: 4 }]],
      portals: [{ a: { x: 1, y: 1 }, b: { x: 2, y: 1 }, closed: false }],
      lights: [{ at: { x: 5, y: 5 }, range: 6, color: "ff112233", shadows: false }],
    });
    const result = readUvtt({ ...file, software: "Dungeondraft", unknown: { deep: [1, 2] } });
    assert.ok(result.ok);
    assert.deepEqual(result.map.origin, { x: -0.5, y: 1 });
    assert.deepEqual(result.map.size, { x: 12, y: 8 });
    assert.equal(result.map.pixelsPerGrid, 70);
    assert.equal(result.map.walls.length, 1);
    assert.equal(result.map.objects.length, 1);
    assert.deepEqual(result.map.portals, [{ a: { x: 1, y: 1 }, b: { x: 2, y: 1 }, closed: false, position: { x: 1.5, y: 1 } }]);
    assert.deepEqual(result.map.lights, [{ at: { x: 5, y: 5 }, range: 6, color: "ff112233", shadows: false }]);
  });

  test("missing optional keys read as empty, and a portal without its switch is a door", () => {
    const file = uvttFile();
    delete file.line_of_sight;
    delete file.objects_line_of_sight;
    delete file.lights;
    file.portals = [{ bounds: [{ x: 1, y: 1 }, { x: 2, y: 1 }] }];
    const result = readUvtt(file);
    assert.ok(result.ok);
    assert.deepEqual(result.map.walls, []);
    assert.deepEqual(result.map.objects, []);
    assert.deepEqual(result.map.lights, []);
    assert.equal(result.map.portals[0]!.closed, true);
    assert.equal(result.map.portals[0]!.position, null);
    const noOrigin = uvttFile();
    delete (noOrigin.resolution as Record<string, unknown>).map_origin;
    const read = readUvtt(noOrigin);
    assert.ok(read.ok);
    assert.deepEqual(read.map.origin, { x: 0, y: 0 });
  });

  test("anything that is not the format says so plainly", () => {
    for (const raw of [null, 3, "text", [], {}, { image: "abc" }, { resolution: {}, image: "abc" }, { ...uvttFile(), resolution: { map_size: { x: 0, y: 5 }, pixels_per_grid: 70 } }]) {
      const result = readUvtt(raw);
      assert.equal(result.ok, false);
      if (!result.ok) assert.equal(result.error, NOT_UVTT, JSON.stringify(raw));
    }
    // A portal's `position` is only a hint, so a broken one reads as none.
    const odd = uvttFile({ portals: [{ a: { x: 1, y: 1 }, b: { x: 2, y: 1 } }] });
    (odd.portals as Record<string, unknown>[])[0]!.position = { x: "1.5", y: 1 };
    const oddRead = readUvtt(odd);
    assert.ok(oddRead.ok);
    assert.equal(oddRead.map.portals[0]!.position, null);
    const bad = uvttFile({ walls: [[{ x: 1, y: 1 }]] });
    (bad.line_of_sight as unknown[][])[0]!.push({ x: "2", y: 1 });
    assert.equal(readUvtt(bad).ok, false);
  });

  test("a file without an image says it has no map image", () => {
    const file = uvttFile();
    delete file.image;
    assert.deepEqual(readUvtt(file), { ok: false, error: NO_IMAGE });
    assert.deepEqual(readUvtt({ ...uvttFile(), image: "" }), { ok: false, error: NO_IMAGE });
  });

  test("counts are bounded before the schema walks the arrays", () => {
    const line = [
      { x: 0, y: 0 },
      { x: 1, y: 0 },
    ];
    const many = uvttFile({ walls: Array.from({ length: MAX_POLYLINES + 1 }, () => line) });
    const tooMany = readUvtt(many);
    assert.equal(tooMany.ok, false);
    if (!tooMany.ok) assert.match(tooMany.error, /20,001 wall lines/);
    const long = uvttFile({ walls: [Array.from({ length: MAX_POINTS + 1 }, (_, i) => ({ x: (i % 20) / 2, y: 1 }))] });
    const tooLong = readUvtt(long);
    assert.equal(tooLong.ok, false);
    if (!tooLong.ok) assert.match(tooLong.error, /200,001 points/);
    const portals = uvttFile({ portals: Array.from({ length: 2001 }, () => ({ a: { x: 1, y: 1 }, b: { x: 2, y: 1 } })) });
    assert.equal(readUvtt(portals).ok, false);
    const lights = uvttFile({ lights: Array.from({ length: 501 }, () => ({ at: { x: 1, y: 1 }, range: 2 })) });
    const tooBright = readUvtt(lights);
    assert.equal(tooBright.ok, false);
    if (!tooBright.ok) assert.match(tooBright.error, /501 lights/);
  });

  test("every coordinate must lie within one square of the map", () => {
    const inSlack = uvttFile({ origin: { x: 2, y: 2 }, size: { x: 10, y: 10 }, walls: [[{ x: 1, y: 1 }, { x: 13, y: 13 }]] });
    assert.ok(readUvtt(inSlack).ok);
    for (const p of [{ x: 0.99, y: 5 }, { x: 5, y: 13.01 }]) {
      const out = readUvtt(uvttFile({ origin: { x: 2, y: 2 }, size: { x: 10, y: 10 }, lights: [{ at: p, range: 1 }] }));
      assert.equal(out.ok, false);
    }
    const far = readUvtt(uvttFile({ portals: [{ a: { x: 1, y: 1 }, b: { x: 1e9, y: 1 } }] }));
    assert.equal(far.ok, false);
  });

  test("JSON's 1e999 is infinity, which no coordinate may be", () => {
    const parsed: unknown = JSON.parse('{"x": 1e999, "y": 1}');
    const file = uvttFile({ walls: [[{ x: 1, y: 1 }, parsed as { x: number; y: number }]] });
    assert.equal(readUvtt(file).ok, false);
  });
});
