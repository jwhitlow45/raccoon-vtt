import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { MODEL_LIMITS } from "#shared/limits.ts";
import { CLUSTER_LIMITS } from "./cluster.ts";
import { box, obj, zUp } from "./fixtures.testutil.ts";
import { MODEL_WORDS } from "./mesh.ts";
import { readObj } from "./obj.ts";

/** OBJ, geometry only, with its table of positions capped (docs/design/design-v1-token-models.md 5, section 9's OBJ row). */

const blob = (s: string) => new Blob([new TextEncoder().encode(s)]);
const cube = zUp(box([-0.5, 0, -0.5], [0.5, 1, 0.5]));

function vertexSet(positions: Float32Array): string[] {
  const out = new Set<string>();
  for (let i = 0; i < positions.length; i += 3) out.add(`${positions[i]!.toFixed(4)} ${positions[i + 1]!.toFixed(4)} ${positions[i + 2]!.toFixed(4)}`);
  return [...out].sort();
}

/** A text file of `lines` copies of one line, made a slice at a time as it is read. */
function repeated(line: string, lines: number, tail = ""): Blob {
  const bytes = new TextEncoder().encode(line);
  const tailBytes = new TextEncoder().encode(tail);
  const size = bytes.length * lines + tailBytes.length;
  return {
    size,
    slice(a: number, b: number) {
      const end = Math.min(b, size);
      return {
        arrayBuffer: async () => {
          const out = new Uint8Array(end - a);
          for (let i = a; i < end; i++) out[i - a] = i < bytes.length * lines ? bytes[i % bytes.length]! : tailBytes[i - bytes.length * lines]!;
          return out.buffer;
        },
      };
    },
  } as unknown as Blob;
}

describe("OBJ", () => {
  test("reads a cube's faces over its table of positions", async () => {
    const mesh = await readObj(blob(obj(cube)));
    assert.equal(mesh.axes, "zUp");
    assert.equal(mesh.triangles, 12);
    assert.deepEqual(vertexSet(mesh.parts[0]!.positions), vertexSet(new Float32Array(cube)));
    assert.ok(mesh.parts[0]!.material.plain && mesh.parts[0]!.material.doubleSided, "an OBJ draws from both sides");
  });

  test("reads corners with texture and normal indices, negative indices, quads fanned, comments and other lines skipped", async () => {
    const text = [
      "# a quad and a triangle",
      "mtllib nothing.mtl",
      "o square",
      "v 0 0 0",
      "v 1 0 0",
      "vt 0 0",
      "vn 0 0 1",
      "v 1 1 0 1.0",
      "v 0 1 0",
      "usemtl none",
      "s off",
      "f 1/1/1 2/1/1 3//1 4 # a quad",
      "v 0 0 1",
      "f -1 -4 -5",
      "l 1 2",
      "f 1 2",
    ].join("\n");
    const mesh = await readObj(blob(text));
    assert.equal(mesh.triangles, 3);
    assert.equal(mesh.parts[0]!.positions.length / 3, 5);
  });

  test("refuses a corner past the table, a zero index and a fractional one", async () => {
    // Each beside a good face, so a reader that skipped the bad one would draw instead of refusing.
    for (const face of ["f 1 2 9", "f 0 1 2", "f 1 2 -9", "f 1 2 2.5"]) {
      await assert.rejects(readObj(blob(`v 0 0 0\nv 1 0 0\nv 0 1 0\nf 1 2 3\n${face}\n`)), { message: MODEL_WORDS.notModel }, face);
    }
  });

  test("refuses a position that is not a number, and a file with no faces", async () => {
    await assert.rejects(readObj(blob("v 0 0 0\nv 1 nan 0\nv 0 1 0\nf 1 2 3\n")), { message: MODEL_WORDS.notModel });
    await assert.rejects(readObj(blob("v 0 0 0\nv 1 0 0\nv 0 1 0\n")), { message: MODEL_WORDS.notModel });
  });

  test("refuses past 4,000,000 positions in the design's words, and keeps exactly 4,000,000", async () => {
    const face = "f -3 -2 -1\n";
    // Copies of one point, then two more apart, so the table fills without the file's bytes ever existing whole.
    const atCap = repeated("v 0 0 0\n", MODEL_LIMITS.objVertices - 2, `v 1 0 0\nv 0 1 0\n${face}`);
    const mesh = await readObj(atCap);
    assert.equal(mesh.triangles, 1);
    const past = repeated("v 0 0 0\n", MODEL_LIMITS.objVertices + 1, face);
    await assert.rejects(readObj(past), { message: MODEL_WORDS.tooComplex });
    assert.equal(MODEL_WORDS.tooComplex, "This model is too complex to draw here. Try a simpler file.");
  });

  test("holds the cap the limits give it", async () => {
    await assert.rejects(readObj(blob("v 0 0 0\nv 1 0 0\nv 0 1 0\nv 0 0 1\nf 1 2 3\n"), { ...CLUSTER_LIMITS, vertices: 3 }), { message: MODEL_WORDS.tooComplex });
  });
});
