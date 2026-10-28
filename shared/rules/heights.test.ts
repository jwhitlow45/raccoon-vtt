import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import { HEIGHTS_CHARS, type BuildChunk, type StairMark } from "../model.ts";
import {
  chunkHeights,
  chunkMarks,
  compassOf,
  decodeHeights,
  encodeHeights,
  footprintGround,
  groundAt,
  markIn,
  stairDirections,
  standing,
  type StairGrid,
} from "./heights.ts";
import { SQUARES } from "./grid.ts";

/** A chunk at (cx, cy) of scene "s" with heights and marks given per cell as "x,y". */
function reliefChunk(heights: Record<string, number>, marks: Record<string, StairMark> = {}, at = { cx: 0, cy: 0 }): BuildChunk {
  const feet = new Array<number>(256).fill(0);
  const up = new Array<string>(256).fill(".");
  for (const [key, v] of Object.entries(heights)) {
    const [x, y] = key.split(",").map(Number) as [number, number];
    feet[(y - at.cy * 16) * 16 + (x - at.cx * 16)] = v;
  }
  for (const [key, m] of Object.entries(marks)) {
    const [x, y] = key.split(",").map(Number) as [number, number];
    up[(y - at.cy * 16) * 16 + (x - at.cx * 16)] = m;
  }
  const encoded = encodeHeights(feet);
  const marked = up.join("");
  return { sceneId: "s", cx: at.cx, cy: at.cy, rev: 1, cells: {}, edges: {}, ...(encoded ? { heights: encoded } : {}), ...(marked !== ".".repeat(256) ? { up: marked } : {}) };
}

describe("the stored heights string", () => {
  test("encodes 256 little-endian 16-bit values as base64 and reads them back", () => {
    const feet: number[] = Array.from({ length: 256 }, (_, k) => (k % 7 === 0 ? -100 : k % 5 === 0 ? 200 : k % 3 === 0 ? 5 : 0));
    feet[255] = -32768;
    feet[254] = 32767;
    const s = encodeHeights(feet)!;
    assert.equal(s.length, HEIGHTS_CHARS);
    assert.match(s, /^[A-Za-z0-9+/]{683}=$/);
    assert.deepEqual(Array.from(decodeHeights(s)!), feet);
  });

  test("matches the platform's own base64 of the little-endian bytes", () => {
    const feet = Array.from({ length: 256 }, (_, k) => ((k * 37) % 301) - 100);
    const bytes = Buffer.alloc(512);
    feet.forEach((v, k) => bytes.writeInt16LE(v, 2 * k));
    assert.equal(encodeHeights(feet), bytes.toString("base64"));
    assert.deepEqual(Array.from(decodeHeights(bytes.toString("base64"))!), feet);
  });

  test("all zero is absent, and a malformed string reads as no heights", () => {
    assert.equal(encodeHeights(new Array(256).fill(0)), undefined);
    assert.equal(decodeHeights(undefined), null);
    assert.equal(decodeHeights(Buffer.alloc(512).toString("base64")), null);
    const good = encodeHeights(Array.from({ length: 256 }, (_, k) => k))!;
    for (const bad of [good.slice(1), good + "A", good.replace(/.$/, "A"), "!" + good.slice(1), good.slice(0, 10) + "é" + good.slice(11)]) assert.equal(decodeHeights(bad), null, bad.slice(0, 12));
  });

  test("a chunk's heights and marks are read once per chunk object, and bad marks read as none", () => {
    const chunk = reliefChunk({ "3,4": 10 }, { "1,1": "n" });
    assert.equal(chunkHeights(chunk), chunkHeights(chunk));
    assert.equal(chunkHeights(chunk)![4 * 16 + 3], 10);
    assert.equal(markIn(chunk, 1, 1), "n");
    assert.equal(markIn(chunk, 2, 1), ".");
    assert.equal(chunkMarks({ up: "x".repeat(256) }), null);
    assert.equal(chunkMarks({ up: ".".repeat(255) }), null);
    assert.equal(markIn({ ...chunk, up: "n".repeat(10) }, 1, 1), ".");
  });
});

describe("ground", () => {
  const chunks = {
    "s:0,0": reliefChunk({ "2,2": 10, "3,2": 5, "15,15": -10 }),
    "s:1,0": reliefChunk({ "16,0": 20 }, {}, { cx: 1, cy: 0 }),
  };

  test("a cell's ground is its painted height, 0 where none is painted or no chunk is", () => {
    assert.equal(groundAt(chunks, "s", 2, 2), 10);
    assert.equal(groundAt(chunks, "s", 15, 15), -10);
    assert.equal(groundAt(chunks, "s", 16, 0), 20);
    assert.equal(groundAt(chunks, "s", 4, 4), 0);
    assert.equal(groundAt(chunks, "s", 40, 40), 0);
    assert.equal(groundAt(chunks, "other", 2, 2), 0);
  });

  test("a footprint's ground is the highest ground under it, the squeezed footprint's while it squeezes", () => {
    assert.equal(footprintGround(chunks, { sceneId: "s", size: "medium", x: 3, y: 2 }), 5);
    assert.equal(footprintGround(chunks, { sceneId: "s", size: "large", x: 2, y: 1 }), 10);
    assert.equal(footprintGround(chunks, { sceneId: "s", size: "medium", x: 15, y: 15 }), -10);
    // A Large creature centered at (3.5, 2.5) squeezes to the one cell (3, 2).
    assert.equal(footprintGround(chunks, { sceneId: "s", size: "large", x: 2.5, y: 1.5, squeeze: true }), 5);
  });

  test("a token stands on the ground, flies above it or is inside it", () => {
    assert.equal(standing(10, 10), "ground");
    assert.equal(standing(15, 10), "flying");
    assert.equal(standing(-5, 0), "inside");
  });
});

/** Stair directions on a small window whose rows give each cell's ground in 5 ft steps ("." for 0), with stairs marked by cell. */
function stairs(rows: string[], marks: Record<string, StairMark>, ground: Record<string, number> = {}, outside: Set<string> = new Set()): Record<string, string> {
  const h = rows.length;
  const w = rows[0]!.length;
  const at = (k: number) => `${k % w},${Math.floor(k / w)}`;
  const g: StairGrid = {
    x0: 0,
    y0: 0,
    w,
    h,
    mark: (k) => marks[at(k)] ?? ".",
    ground: (k) => ground[at(k)] ?? Number(rows[Math.floor(k / w)]![k % w] === "." ? 0 : rows[Math.floor(k / w)]![k % w]) * 5,
    inScene: (k) => !outside.has(at(k)),
  };
  const list = Object.keys(marks)
    .map((key) => {
      const [x, y] = key.split(",").map(Number) as [number, number];
      return y * w + x;
    })
    .sort((a, b) => a - b);
  const dir = stairDirections(SQUARES, g, list);
  return Object.fromEntries(list.map((k) => [at(k), compassOf(dir[k]!) ?? "?"]));
}

describe("stair directions", () => {
  test("an explicit direction wins over everything", () => {
    assert.deepEqual(stairs(["...", "222", "..."], { "1,0": "e" }), { "1,0": "e" });
  });

  test("a stair points to its one higher neighbor", () => {
    assert.deepEqual(stairs(["222", "...", "..."], { "1,1": "a" }), { "1,1": "n" });
    assert.deepEqual(stairs(["...", "..2", "..."], { "1,1": "a" }), { "1,1": "e" });
    // Two higher neighbors and nothing else: no direction.
    assert.deepEqual(stairs(["222", "..2", "..."], { "1,1": "a" }), { "1,1": "?" });
    // No higher neighbor: no direction.
    assert.deepEqual(stairs(["...", "...", "..."], { "1,1": "a" }), { "1,1": "?" });
  });

  test("a stair run passes its direction down to the cells below it", () => {
    // A platform at row 0, and a three-cell stair run below it in column 1.
    assert.deepEqual(stairs(["222", "...", "...", "...", "..."], { "1,1": "a", "1,2": "a", "1,3": "a" }), { "1,1": "n", "1,2": "n", "1,3": "n" });
    // The run's top was set by hand, and the rest follows it.
    assert.deepEqual(stairs(["....", "....", "...."], { "0,1": "e", "1,1": "a", "2,1": "a", "3,1": "a" }), { "0,1": "e", "1,1": "e", "2,1": "e", "3,1": "e" });
  });

  test("a stair beside a run, not on its line, takes nothing from it", () => {
    assert.deepEqual(stairs(["222", "...", "..."], { "1,1": "a", "2,1": "a" }), { "1,1": "n", "2,1": "n" });
    // (1,2) is beside (0,2), which points north, so it is not on that stair's line.
    assert.deepEqual(stairs(["2..", "...", "..."], { "0,1": "a", "0,2": "a", "1,2": "a" }), { "0,1": "n", "0,2": "n", "1,2": "?" });
  });

  test("a stair between runs pointing different ways has no direction", () => {
    assert.deepEqual(stairs(["...", "...", "..."], { "1,0": "n", "1,1": "a", "1,2": "s" }), { "1,0": "n", "1,1": "?", "1,2": "s" });
    assert.deepEqual(stairs(["...", "...", "..."], { "0,1": "e", "1,1": "a", "1,2": "s" }), { "0,1": "e", "1,1": "?", "1,2": "s" });
    // Agreeing runs on both sides are no conflict.
    assert.deepEqual(stairs(["...", "...", "..."], { "1,0": "n", "1,1": "a", "1,2": "n" }), { "1,0": "n", "1,1": "n", "1,2": "n" });
  });

  test("a neighbor outside the scene is never the higher one", () => {
    assert.deepEqual(stairs(["222", "...", "..."], { "1,1": "a" }, {}, new Set(["1,0"])), { "1,1": "?" });
  });

  test("the answer does not depend on the order stairs are listed in", () => {
    const marks: Record<string, StairMark> = {};
    for (let y = 1; y < 5; y++) for (let x = 0; x < 7; x++) if ((x * 7 + y * 3) % 4 !== 0) marks[`${x},${y}`] = "a";
    marks["6,4"] = "w";
    const w = 7;
    const g: StairGrid = { x0: 0, y0: 0, w, h: 5, mark: (k) => marks[`${k % w},${Math.floor(k / w)}`] ?? ".", ground: (k) => (k < w ? 15 : 0), inScene: () => true };
    const list = Object.keys(marks).map((key) => {
      const [x, y] = key.split(",").map(Number) as [number, number];
      return y * w + x;
    });
    const sorted = stairDirections(SQUARES, g, [...list].sort((a, b) => a - b));
    const reversed = stairDirections(SQUARES, g, [...list].sort((a, b) => b - a));
    assert.deepEqual(Array.from(reversed), Array.from(sorted));
    assert.ok(list.some((k) => sorted[k] !== 0) && list.some((k) => sorted[k] === 0));
  });
});

describe("determinism", () => {
  /*
   * Sight reads ground heights, and its "seen" marks are stored facts, so
   * heights.ts and everything it imports, other than types, keep to the
   * arithmetic every engine rounds alike (section 4.3.4), as segments.ts does
   * (segments.test.ts).
   */
  const banned = /Math\.(atan2|sin|cos|sqrt|hypot|pow|exp)\b|\*\*/;

  function closure(entry: string): string[] {
    const seen = new Set<string>();
    const queue = [entry];
    while (queue.length > 0) {
      const file = queue.pop()!;
      if (seen.has(file)) continue;
      seen.add(file);
      const source = readFileSync(file, "utf8");
      for (const m of source.matchAll(/(?:^|\n)\s*(?:import|export)\s+(type\s+)?[^;]*?from\s+["']([^"']+)["']/g)) {
        if (m[1]) continue;
        assert.ok(m[2]!.startsWith("."), `${file} imports ${m[2]}`);
        queue.push(resolve(dirname(file), m[2]!));
      }
    }
    return [...seen];
  }

  test("heights.ts and its imports call no function engines may round differently", () => {
    const files = closure(fileURLToPath(new URL("./heights.ts", import.meta.url)));
    assert.ok(files.some((f) => f.endsWith("footprint.ts")));
    assert.ok(!files.some((f) => f.endsWith("geom.ts")), "footprint.ts imports only types from geom.ts");
    for (const file of files) {
      const source = readFileSync(file, "utf8").replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, "");
      const hit = source.match(banned);
      assert.equal(hit, null, `${file} uses ${hit?.[0]}`);
    }
  });
});
