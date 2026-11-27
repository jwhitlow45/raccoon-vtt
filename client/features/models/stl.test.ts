import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { MODEL_LIMITS } from "#shared/limits.ts";
import { asciiStl, binaryStl, box, zUp } from "./fixtures.testutil.ts";
import { eachLine, MODEL_WORDS, numberAt } from "./mesh.ts";
import { readModel } from "./read.ts";
import { readStl } from "./stl.ts";

/** STL, binary and ASCII, streamed in slices (docs/design/design-v1-token-models.md 5, section 9's STL rows). */

const enc = (s: string) => new TextEncoder().encode(s);
const blob = (bytes: Uint8Array | string) => new Blob([typeof bytes === "string" ? enc(bytes) : (bytes as Uint8Array<ArrayBuffer>)]);
const cube = zUp(box([-0.5, 0, -0.5], [0.5, 1, 0.5]));

/** Every vertex of a mesh, as "x y z" rounded, sorted. */
function vertexSet(positions: Float32Array): string[] {
  const out = new Set<string>();
  for (let i = 0; i < positions.length; i += 3) out.add(`${positions[i]!.toFixed(4)} ${positions[i + 1]!.toFixed(4)} ${positions[i + 2]!.toFixed(4)}`);
  return [...out].sort();
}

/**
 * A binary STL of a torus made a record at a time as each slice is read,
 * so a test can stream a file far larger than it would want to hold, and
 * see every slice the reader asked for.
 */
function torusStl(seg: number, rings: number): { file: Blob; slices: number[]; triangles: number } {
  const triangles = 2 * seg * rings;
  const size = 84 + 50 * triangles;
  const slices: number[] = [];
  const cosS = Float64Array.from({ length: seg + 1 }, (_, s) => Math.cos((2 * Math.PI * s) / seg));
  const sinS = Float64Array.from({ length: seg + 1 }, (_, s) => Math.sin((2 * Math.PI * s) / seg));
  const cosT = Float64Array.from({ length: rings + 1 }, (_, t) => Math.cos((2 * Math.PI * t) / rings));
  const sinT = Float64Array.from({ length: rings + 1 }, (_, t) => Math.sin((2 * Math.PI * t) / rings));
  const record = new Uint8Array(50);
  const dv = new DataView(record.buffer);
  const point = (s: number, t: number, k: number) => {
    const w = 0.35 + 0.15 * cosT[t]!;
    dv.setFloat32(12 + k * 12, w * cosS[s]!, true);
    dv.setFloat32(16 + k * 12, w * sinS[s]!, true);
    dv.setFloat32(20 + k * 12, 0.15 + 0.15 * sinT[t]!, true);
  };
  const fill = (out: Uint8Array, at: number) => {
    const header = new Uint8Array(84);
    header.set(enc("solid torus, written as binary"));
    new DataView(header.buffer).setUint32(80, triangles, true);
    for (let i = at; i < Math.min(84, at + out.length); i++) out[i - at] = header[i]!;
    const first = Math.max(0, Math.floor((at - 84) / 50));
    for (let r = first; r < triangles && 84 + 50 * r < at + out.length; r++) {
      const q = r >> 1;
      const s = q % seg;
      const t = Math.floor(q / seg);
      if (r & 1) {
        point(s, t, 0);
        point(s + 1, t + 1, 1);
        point(s, t + 1, 2);
      } else {
        point(s, t, 0);
        point(s + 1, t, 1);
        point(s + 1, t + 1, 2);
      }
      const from = 84 + 50 * r;
      for (let b = Math.max(from, at); b < Math.min(from + 50, at + out.length); b++) out[b - at] = record[b - from]!;
    }
  };
  const file = {
    size,
    slice(a: number, b: number) {
      const len = Math.max(0, Math.min(b, size) - a);
      slices.push(len);
      return {
        arrayBuffer: async () => {
          const out = new Uint8Array(len);
          fill(out, a);
          return out.buffer;
        },
      };
    },
  } as unknown as Blob;
  return { file, slices, triangles };
}

describe("binary STL", () => {
  test("welds a cube's 36 corners into its 8 vertices, with unit normals and 12 triangles", async () => {
    const mesh = await readStl(blob(binaryStl(cube)), true);
    const part = mesh.parts[0]!;
    assert.equal(mesh.axes, "zUp");
    assert.equal(part.index!.length, 36);
    assert.equal(part.positions.length, 8 * 3);
    for (let i = 0; i < part.normals.length; i += 3) assert.ok(Math.abs(Math.hypot(part.normals[i]!, part.normals[i + 1]!, part.normals[i + 2]!) - 1) < 1e-6);
    assert.deepEqual(vertexSet(part.positions), vertexSet(new Float32Array(cube)));
    assert.ok(mesh.colorable);
  });

  test("keeps each triangle's winding, so its faces still face out", async () => {
    const mesh = await readStl(blob(binaryStl(cube)), true);
    const { positions: p, index } = mesh.parts[0]!;
    for (let t = 0; t < index!.length; t += 3) {
      const [a, b, c] = [index![t]! * 3, index![t + 1]! * 3, index![t + 2]! * 3];
      const u = [p[b]! - p[a]!, p[b + 1]! - p[a + 1]!, p[b + 2]! - p[a + 2]!];
      const v = [p[c]! - p[a]!, p[c + 1]! - p[a + 1]!, p[c + 2]! - p[a + 2]!];
      const n = [u[1]! * v[2]! - u[2]! * v[1]!, u[2]! * v[0]! - u[0]! * v[2]!, u[0]! * v[1]! - u[1]! * v[0]!];
      const centroid = [(p[a]! + p[b]! + p[c]!) / 3, (p[a + 1]! + p[b + 1]! + p[c + 1]!) / 3, (p[a + 2]! + p[b + 2]! + p[c + 2]!) / 3 - 0.5];
      assert.ok(n[0]! * centroid[0]! + n[1]! * centroid[1]! + n[2]! * centroid[2]! > 0, "a face points out of the cube");
    }
  });

  test("refuses a coordinate that is not finite, and a file of no triangles", async () => {
    const bad = binaryStl(cube);
    new DataView(bad.buffer).setFloat32(84 + 12, NaN, true);
    await assert.rejects(readStl(blob(bad), true), { message: MODEL_WORDS.notModel });
    const inf = binaryStl(cube);
    new DataView(inf.buffer).setFloat32(84 + 50 * 5 + 40, Infinity, true);
    await assert.rejects(readStl(blob(inf), true), { message: MODEL_WORDS.notModel });
    await assert.rejects(readStl(blob(binaryStl([])), true), { message: MODEL_WORDS.notModel });
  });

  test("refuses a binary file whose count does not match its size, and one that shrinks while it is read", async () => {
    const bytes = binaryStl(cube);
    await assert.rejects(readStl(blob(new Uint8Array([...bytes, 0])), true), { message: MODEL_WORDS.notModel });
    const shrinking = { size: bytes.length, slice: (a: number, b: number) => ({ arrayBuffer: async () => bytes.slice(a, Math.min(b, a + 100)).buffer }) } as unknown as Blob;
    await assert.rejects(readStl(shrinking, true), { message: MODEL_WORDS.changed });
  });

  test("refuses a model with no size: every corner one point", async () => {
    await assert.rejects(readStl(blob(binaryStl(Array.from({ length: 27 }, () => 3))), true), { message: MODEL_WORDS.notModel });
  });

  test("streams a 153 MB file on a touch device in 8 MiB slices to at most 250,000 triangles", async () => {
    const { file, slices, triangles } = torusStl(1750, 874);
    assert.ok(file.size > 152_000_000 && file.size < 154_000_000);
    const mesh = await readModel(file, "touch");
    assert.ok(mesh.triangles <= MODEL_LIMITS.clusterTriangles, `${mesh.triangles} triangles`);
    assert.ok(mesh.triangles > 0.4 * MODEL_LIMITS.clusterTriangles, `${mesh.triangles} triangles, too coarse`);
    assert.ok(Math.max(...slices) <= MODEL_LIMITS.sliceBytes, "no slice past 8 MiB");
    // The box's pass and at least one clustering pass, each reading every byte, and at most the four passes.
    const read = slices.reduce((a, b) => a + b, 0);
    assert.ok(read >= 2 * (file.size - 84) && read <= 6 * file.size, `${read} bytes read`);
    assert.ok(triangles > 3_000_000);
  });
});

describe("ASCII STL", () => {
  test("reads the same cube as the binary file", async () => {
    const a = await readStl(blob(asciiStl(cube)), false);
    const b = await readStl(blob(binaryStl(cube)), true);
    assert.deepEqual(vertexSet(a.parts[0]!.positions), vertexSet(b.parts[0]!.positions));
    assert.equal(a.parts[0]!.index!.length, b.parts[0]!.index!.length);
  });

  test("reads upper case, Windows line ends, signs and exponents, fans a loop of four and skips a loop of two", async () => {
    const text = [
      "SOLID shouty",
      "FACET NORMAL 0 0 1",
      "OUTER LOOP",
      "VERTEX 0 0 0",
      "VERTEX +1.0E+0 0 0",
      "VERTEX 1 1e0 0",
      "VERTEX -0 .1E1 -0.0",
      "ENDLOOP",
      "ENDFACET",
      "facet normal 0 0 1",
      "outer loop",
      "vertex 0 0 1",
      "vertex 1 0 1",
      "endloop",
      "endfacet",
      "endsolid",
    ].join("\r\n");
    const mesh = await readStl(blob(text), false);
    assert.equal(mesh.triangles, 2);
    assert.deepEqual(vertexSet(mesh.parts[0]!.positions), ["0.0000 0.0000 0.0000", "0.0000 1.0000 0.0000", "1.0000 0.0000 0.0000", "1.0000 1.0000 0.0000"]);
  });

  test("refuses a vertex that is not a number", async () => {
    await assert.rejects(readStl(blob("solid x\nfacet normal 0 0 0\nouter loop\nvertex 0 0 0\nvertex 1 0 0\nvertex nan 1 0\nendloop\nendfacet\n"), false), { message: MODEL_WORDS.notModel });
    await assert.rejects(readStl(blob("solid x\nfacet normal 0 0 0\nouter loop\nvertex 0 0 0\nvertex 1 0 0\nvertex 1e999 1 0\nendloop\nendfacet\n"), false), { message: MODEL_WORDS.notModel });
  });

  test("refuses a line longer than any model's, across slices, at a slice's end or whole inside one", async () => {
    const long = `solid x\nfacet normal 0 0 0\n${"x".repeat(MODEL_LIMITS.lineBytes + 10)}`;
    // Carried slice after slice, and left over at the end of one large slice.
    await assert.rejects(eachLine(blob(long), () => {}, 1024), { message: MODEL_WORDS.notModel });
    await assert.rejects(eachLine(blob(long), () => {}), { message: MODEL_WORDS.notModel });
    // Whole inside one slice, ended by its newline.
    await assert.rejects(eachLine(blob(`${long}\nendsolid\n`), () => {}), { message: MODEL_WORDS.notModel });
    // At the cap, a line still reads.
    const lines: number[] = [];
    await eachLine(blob(`a\n${"x".repeat(MODEL_LIMITS.lineBytes)}`), (_b, start, end) => lines.push(end - start), 1024);
    assert.deepEqual(lines, [1, MODEL_LIMITS.lineBytes]);
  });
});

describe("the slice and line readers", () => {
  test("hand back every line whole whatever the slice size, a last line without its end too", async () => {
    const text = "first line\n\nthird, longer than a slice\r\nlast";
    for (const size of [1, 2, 3, 7, 64]) {
      const lines: string[] = [];
      await eachLine(blob(text), (bytes, start, end) => lines.push(new TextDecoder().decode(bytes.subarray(start, end))), size);
      assert.deepEqual(lines, ["first line", "", "third, longer than a slice\r", "last"], `slices of ${size}`);
    }
  });

  test("parse numbers as Number does, near enough for a model", () => {
    const next = new Int32Array(1);
    for (const s of ["0", "-0", "1", "-12.5", "+3", ".5", "5.", "1e3", "1E-3", "-2.5e+2", "123456789.123456789", "0.000001", "3.4028235e38", "1e-30", "007"]) {
      const bytes = enc(` ${s} `);
      const v = numberAt(bytes, 1, bytes.length, next);
      assert.ok(Math.abs(v - Number(s)) <= Math.abs(Number(s)) * 1e-15, `${s}: ${v}`);
      assert.equal(next[0], 1 + s.length, s);
    }
    for (const s of ["", "-", ".", "e5", "x1"]) assert.ok(Number.isNaN(numberAt(enc(s), 0, s.length, next)), s);
  });
});
