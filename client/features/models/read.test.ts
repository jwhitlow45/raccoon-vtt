import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { MODEL_LIMITS } from "#shared/limits.ts";
import { asciiStl, binaryStl, box, Glb, obj } from "./fixtures.testutil.ts";
import { MODEL_WORDS, ModelRefusal } from "./mesh.ts";
import { readModel, sniffModel, SNIFF_BYTES } from "./read.ts";

/** Which reader a file goes to, from its bytes (docs/design/design-v1-token-models.md 5, D-261127-171, 372). */

const enc = (s: string) => new TextEncoder().encode(s);
const sniff = (bytes: Uint8Array) => sniffModel(bytes.subarray(0, SNIFF_BYTES), bytes.length);
const cube = box([0, 0, 0], [1, 1, 1]);

/** A file whose bytes are never made: only its size and its first bytes are read before the size check refuses it. */
function sized(head: Uint8Array, size: number): Blob {
  return {
    size,
    slice: (a: number, b: number) => ({ arrayBuffer: async () => head.slice(a, Math.min(b, head.length)).buffer }),
  } as unknown as Blob;
}

describe("sniffing a model file", () => {
  test("names each format from its bytes, never the name", () => {
    assert.equal(sniff(binaryStl(cube)), "stl-binary");
    assert.equal(sniff(enc(asciiStl(cube))), "stl-ascii");
    assert.equal(sniff(enc(obj(cube))), "obj");
    const g = new Glb();
    g.node({ mesh: g.meshOf(cube) });
    assert.equal(sniff(g.build()), "glb");
  });

  test("takes a binary STL whose header begins with solid as binary, since its count matches its size", () => {
    assert.equal(sniff(binaryStl(cube, "solid exported by a slicer, facet count follows")), "stl-binary");
  });

  test("calls a binary STL whose count does not match its size no model", () => {
    const bytes = binaryStl(cube);
    assert.equal(sniffModel(bytes, bytes.length + 1), null);
  });

  test("knows a glTF JSON file, with or without a byte order mark", () => {
    assert.equal(sniff(enc(' {\n  "asset": { "version": "2.0" }, "meshes": [] }')), "gltf");
    assert.equal(sniff(enc('﻿{"asset":{"version":"2.0"}}')), "gltf");
  });

  test("refuses anything else: a picture, text, an empty file, a solid with no facet", () => {
    assert.equal(sniff(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13])), null);
    assert.equal(sniff(enc("Dear diary, today I made a model.")), null);
    assert.equal(sniff(new Uint8Array(0)), null);
    assert.equal(sniff(enc("solid nothing\nendsolid nothing\n")), null);
    assert.equal(sniff(enc('{"name": "not a gltf"}')), null);
  });
});

describe("reading a model file", () => {
  test("refuses a .gltf with the words to save it as GLB", async () => {
    await assert.rejects(readModel(new Blob([enc('{"asset":{"version":"2.0"}}')]), "computer"), { message: MODEL_WORDS.gltf });
    assert.equal(MODEL_WORDS.gltf, "Save it as GLB (one file) and pick that.");
  });

  test("refuses a file no reader reads in the design's words", async () => {
    await assert.rejects(readModel(new Blob([enc("hello")]), "computer"), { message: "That file is not a 3D model this app reads. Use STL, OBJ or GLB." });
  });

  test("refuses each format past its size on this device before reading it", async () => {
    const L = MODEL_LIMITS;
    const g = new Glb();
    g.node({ mesh: g.meshOf(cube) });
    const glb = g.build();
    const stl = binaryStl(cube);
    // A size check that read the file first would fail on these files, whose bytes past the head do not exist.
    const stlHead = stl.slice(0, 84);
    const records = Math.floor((L.stlBytes - 84) / 50) + 1;
    new DataView(stlHead.buffer).setUint32(80, records, true);
    await assert.rejects(readModel(sized(stlHead, 84 + 50 * records), "computer"), (e: Error) => e instanceof ModelRefusal && /over 512 MB/.test(e.message));
    await assert.rejects(readModel(sized(glb, L.glbTouchBytes + 1), "touch"), (e: Error) => e instanceof ModelRefusal && /over 64 MB, the largest a phone or tablet reads. Add it from a computer/.test(e.message));
    await assert.rejects(readModel(sized(glb, L.glbComputerBytes + 1), "computer"), (e: Error) => e instanceof ModelRefusal && /over 256 MB/.test(e.message));
    await assert.rejects(readModel(sized(enc("v 0 0 0\n"), L.objBytes + 1), "computer"), (e: Error) => e instanceof ModelRefusal && /OBJ is over 256 MB/.test(e.message));
  });

  test("reads each format into one mesh, STL and OBJ standing Z up and GLB Y up", async () => {
    const g = new Glb();
    g.node({ mesh: g.meshOf(cube) });
    for (const [bytes, axes] of [[binaryStl(cube), "zUp"], [enc(asciiStl(cube)), "zUp"], [enc(obj(cube)), "zUp"], [g.build(), "yUp"]] as const) {
      const mesh = await readModel(new Blob([bytes as Uint8Array<ArrayBuffer>]), "computer");
      assert.equal(mesh.axes, axes);
      assert.equal(mesh.triangles, 12);
    }
  });
});
