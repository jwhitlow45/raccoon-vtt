import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { MODEL_LIMITS } from "#shared/limits.ts";
import { allocations, box, Glb, glbFile } from "./fixtures.testutil.ts";
import { readGlb } from "./glb.ts";
import { MODEL_WORDS, ModelRefusal, trianglesWords } from "./mesh.ts";

/**
 * Crafted GLBs against every cap and refusal of the reader
 * (docs/design/design-v1-token-models.md 5 and section 9's GLB rows). Each
 * file is built here, by hand, and each is refused in its words before any
 * output exists: the largest array the reader makes on the way is a few
 * bytes a node, never anything sized from the file's claims.
 */

type Json = { [key: string]: unknown };
const cube = box([-0.5, 0, -0.5], [0.5, 1, 0.5]);
const L = MODEL_LIMITS;

/** Reads the file and expects a refusal in `words`, with no array past `largest` bytes made on the way. */
async function refused(file: Uint8Array, words: string, device: "touch" | "computer" = "computer", largest = 1024 * 1024): Promise<void> {
  const run = await allocations(() => readGlb(file, device));
  assert.ok(run.result instanceof ModelRefusal, `expected a refusal, got ${String(run.result)}`);
  assert.equal(run.result.message, words);
  assert.ok(run.largest <= largest, `an array of ${run.largest} bytes`);
}

/** A cube GLB to break: the builder, so a test edits its JSON before building. */
function cubeGlb(): Glb {
  const g = new Glb();
  g.node({ mesh: g.meshOf(cube) });
  return g;
}

/** A GLB of just this JSON, and no BIN chunk. */
const jsonOnly = (text: string) => glbFile(new TextEncoder().encode(text), null);

describe("GLB bombs: counts before allocation", () => {
  test("a 50 million element accessor with no view is refused, by its triangles or as no model", async () => {
    const g = new Glb();
    (g.json.meshes as Json[]).push({ primitives: [{ attributes: { POSITION: g.accessor({ componentType: 5126, type: "VEC3", count: 49_999_998 }) } }] });
    g.node({ mesh: 0 });
    await refused(g.build(), trianglesWords(16_666_666, "computer"));
    // Inside the triangle cap, a zero-filled accessor is still no model: it names no bytes to read.
    const small = new Glb();
    (small.json.meshes as Json[]).push({ primitives: [{ attributes: { POSITION: small.accessor({ componentType: 5126, type: "VEC3", count: 3_000 }) } }] });
    small.node({ mesh: 0 });
    await refused(small.build(), MODEL_WORDS.notModel);
  });

  test("10,000 nodes naming one million-triangle mesh draw 10,000,000,000 triangles, refused in words", async () => {
    const g = new Glb();
    (g.json.meshes as Json[]).push({ primitives: [{ attributes: { POSITION: g.accessor({ componentType: 5126, type: "VEC3", count: 3_000_000 }) } }] });
    for (let i = 0; i < L.glbNodeVisits; i++) g.node({ mesh: 0 });
    const words = trianglesWords(10_000_000_000, "computer");
    assert.equal(words, "This model draws 10,000,000,000 triangles. A computer can take up to 1,000,000. Export a lighter one.");
    await refused(g.build(), words);
  });

  test("on touch, past 500,000 triangles, the words say a computer takes 1,000,000; at 500,000 it reads", async () => {
    const at = (triangles: number) => {
      const g = new Glb();
      const corners = g.floats([0, 0, 0, 1, 0, 0, 0, 1, 0], "VEC3");
      (g.json.meshes as Json[]).push({ primitives: [{ attributes: { POSITION: corners }, indices: g.indices(new Uint32Array(triangles * 3).map((_, i) => i % 3)) }] });
      g.node({ mesh: 0 });
      return g.build();
    };
    const words = trianglesWords(L.glbTouchTriangles + 1, "touch");
    assert.equal(words, "This model draws 500,001 triangles. A phone or tablet can take up to 500,000, and a computer up to 1,000,000. Add it from a computer, or export a lighter one.");
    await refused(at(L.glbTouchTriangles + 1), words, "touch", 7 * 1024 * 1024);
    assert.equal(readGlb(at(L.glbTouchTriangles), "touch").triangles, L.glbTouchTriangles);
    assert.equal(readGlb(at(L.glbTouchTriangles + 1), "computer").triangles, L.glbTouchTriangles + 1);
  });

  test("9,999 nodes naming a mesh of 4,096 points primitives are refused at 16,385 references; 16,384 read, the points skipped", async () => {
    const g = new Glb();
    const point = g.floats([0, 0, 0], "VEC3");
    (g.json.meshes as Json[]).push({ primitives: Array.from({ length: 4096 }, () => ({ attributes: { POSITION: point }, mode: 0 })) });
    for (let i = 0; i < 9_999; i++) g.node({ mesh: 0 });
    await refused(g.build(), MODEL_WORDS.tooComplex);
    // Four nodes of 4,095 points and one triangle each: 16,384 references, at the cap.
    const ok = new Glb();
    const p = ok.floats([0, 0, 0], "VEC3");
    const tri = ok.floats([0, 0, 0, 1, 0, 0, 0, 1, 0], "VEC3");
    (ok.json.meshes as Json[]).push({ primitives: [...Array.from({ length: 4095 }, () => ({ attributes: { POSITION: p }, mode: 0 })), { attributes: { POSITION: tri } }] });
    for (let i = 0; i < 4; i++) ok.node({ mesh: 0 });
    assert.equal(readGlb(ok.build(), "computer").triangles, 4);
    (ok.json.nodes as Json[]).push({ mesh: 0 });
    ((ok.json.scenes as Json[])[0]!.nodes as number[]).push(4);
    await refused(ok.build(), MODEL_WORDS.tooComplex);
  });

  test("past 10,000 node visits is refused, and 10,000 read", async () => {
    const chain = (n: number) => {
      const g = cubeGlb();
      // A chain n deep under the cube's node: deep enough to overflow a recursive walk on WebKit, which this one is not.
      const nodes = g.json.nodes as Json[];
      for (let i = 1; i < n; i++) nodes.push({});
      for (let i = 0; i < n - 1; i++) nodes[i]!.children = [i + 1];
      return g.build();
    };
    assert.equal(readGlb(chain(L.glbNodeVisits), "computer").triangles, 12);
    await refused(chain(L.glbNodeVisits + 1), MODEL_WORDS.tooComplex);
  });

  test("a node under two parents, a cycle and a node named twice as a root are no tree, refused as no model", async () => {
    const two = cubeGlb();
    (two.json.nodes as Json[]).push({ children: [0] });
    ((two.json.scenes as Json[])[0]!.nodes as number[]).push(1);
    await refused(two.build(), MODEL_WORDS.notModel);
    const cycle = cubeGlb();
    (cycle.json.nodes as Json[])[0]!.children = [1];
    (cycle.json.nodes as Json[]).push({ children: [0] });
    await refused(cycle.build(), MODEL_WORDS.notModel);
    const twice = cubeGlb();
    ((twice.json.scenes as Json[])[0]!.nodes as number[]).push(0);
    await refused(twice.build(), MODEL_WORDS.notModel);
  });

  test("65 drawn groups are refused in words, and 64 read", async () => {
    const groups = (n: number) => {
      const g = new Glb();
      g.json.materials = Array.from({ length: n }, (_, i) => ({ pbrMetallicRoughness: { baseColorFactor: [i / n, 0, 0, 1] } }));
      const corners = g.floats([0, 0, 0, 1, 0, 0, 0, 1, 0], "VEC3");
      (g.json.meshes as Json[]).push({ primitives: Array.from({ length: n }, (_, i) => ({ attributes: { POSITION: corners }, material: i })) });
      g.node({ mesh: 0 });
      return g.build();
    };
    assert.equal(readGlb(groups(L.glbGroups), "computer").parts.length, 64);
    await refused(groups(L.glbGroups + 1), MODEL_WORDS.groups);
    assert.equal(MODEL_WORDS.groups, "This model has more than 64 materials. Merge some and export it again.");
  });
});

describe("GLB bombs: the JSON, refused before JSON.parse", () => {
  /** Expects the pre-scan to refuse, JSON.parse never called. */
  async function preScanned(file: Uint8Array, device: "touch" | "computer" = "computer"): Promise<void> {
    const parse = JSON.parse;
    let parsed = 0;
    JSON.parse = ((...args: Parameters<typeof parse>) => {
      parsed++;
      return parse(...args);
    }) as typeof JSON.parse;
    try {
      await refused(file, MODEL_WORDS.extraData, device);
    } finally {
      JSON.parse = parse;
    }
    assert.equal(parsed, 0, "JSON.parse never ran");
  }

  test("a JSON 65 deep", async () => {
    await preScanned(jsonOnly(`{"asset":{"version":"2.0"},"extras":${"[".repeat(64)}${"]".repeat(64)}}`));
  });

  test("200,001 empty objects on a computer, and 50,001 on touch", async () => {
    await preScanned(jsonOnly(`{"asset":{"version":"2.0"},"extras":[${"{},".repeat(L.glbJsonComputerContainers)}{}]}`));
    await preScanned(jsonOnly(`{"asset":{"version":"2.0"},"extras":[${"{},".repeat(L.glbJsonTouchContainers)}{}]}`), "touch");
  });

  test("an extras subtree past the value counts, and a chunk past 4 MB on touch", async () => {
    await preScanned(jsonOnly(`{"asset":{"version":"2.0"},"extras":[${"0,".repeat(L.glbJsonComputerValues)}0]}`));
    await preScanned(jsonOnly(`{"asset":{"version":"2.0"},"extras":"${"x".repeat(L.glbJsonTouchBytes)}"}`), "touch");
  });

  test("JSON that does not parse is no model", async () => {
    await refused(jsonOnly('{"asset":'), MODEL_WORDS.notModel);
    await refused(jsonOnly("[1, 2, 3]"), MODEL_WORDS.notModel);
  });
});

describe("GLB bombs: accessors", () => {
  /** The cube with its POSITION accessor or view edited. */
  function edited(edit: (g: Glb, position: Json, view: Json) => void): Uint8Array {
    const g = cubeGlb();
    const position = g.accessors[0]!;
    edit(g, position, g.views[position.bufferView as number]!);
    return g.build();
  }

  test("refuses a negative offset, a stride under its element or past 252, an element past its view, and a view past the chunk", async () => {
    for (const [name, edit] of [
      ["negative accessor offset", (_g: Glb, p: Json) => (p.byteOffset = -4)],
      ["negative view offset", (_g: Glb, _p: Json, v: Json) => (v.byteOffset = -4)],
      ["fractional count", (_g: Glb, p: Json) => (p.count = 35.5)],
      ["count 0", (_g: Glb, p: Json) => (p.count = 0)],
      ["stride under its element", (_g: Glb, _p: Json, v: Json) => (v.byteStride = 8)],
      ["stride past 252", (_g: Glb, _p: Json, v: Json) => (v.byteStride = 256)],
      ["an element past its view", (_g: Glb, p: Json) => (p.byteOffset = 4)],
      ["a view past the chunk", (_g: Glb, _p: Json, v: Json) => (v.byteLength = 1_000_000)],
      ["a view in another buffer", (_g: Glb, _p: Json, v: Json) => (v.buffer = 1)],
      ["POSITION as integers 32 bits wide", (_g: Glb, p: Json) => (p.componentType = 5125)],
      ["POSITION as a VEC2", (_g: Glb, p: Json) => (p.type = "VEC2")],
    ] as const) {
      await refused(edited(edit), MODEL_WORDS.notModel).catch((err: Error) => assert.fail(`${name}: ${err.message}`));
    }
  });

  test("refuses a stride on indices, an index past POSITION's count, an attribute short of it, a strip of 2 and a triangle list of 4", async () => {
    // Each beside a good primitive, so a reader that dropped the bad one would draw instead of refusing.
    const indexed = (indices: number[], extra: Json = {}, mode = 4) => {
      const g = new Glb();
      const position = g.floats(cube, "VEC3");
      const idx = g.indices(indices);
      Object.assign(g.views[g.accessors[idx]!.bufferView as number]!, extra);
      (g.json.meshes as Json[]).push({ primitives: [{ attributes: { POSITION: position } }, { attributes: { POSITION: position }, indices: idx, mode }] });
      g.node({ mesh: 0 });
      return g.build();
    };
    // A view long enough for the stride, so only the rule that indices take none refuses it.
    const strided = new Glb();
    const pos = strided.floats(cube, "VEC3");
    const idx = strided.indices([0, 1, 2, 3, 4, 5]);
    strided.accessors[idx]!.count = 3;
    strided.views[strided.accessors[idx]!.bufferView as number]!.byteStride = 4;
    (strided.json.meshes as Json[]).push({ primitives: [{ attributes: { POSITION: pos }, indices: idx }] });
    strided.node({ mesh: 0 });
    await refused(strided.build(), MODEL_WORDS.notModel);
    await refused(indexed([0, 1, 36]), MODEL_WORDS.notModel);
    await refused(indexed([0, 1], {}, 5), MODEL_WORDS.notModel);
    await refused(indexed([0, 1, 2, 3], {}, 4), MODEL_WORDS.notModel);
    const short = new Glb();
    short.node({ mesh: short.meshOf(cube, {}, new Array(35 * 3).fill(0)) });
    await refused(short.build(), MODEL_WORDS.notModel);
  });

  test("refuses a coordinate that is not finite, read or composed", async () => {
    const nan = new Glb();
    nan.node({ mesh: nan.meshOf([0, 0, 0, NaN, 0, 0, 0, 1, 0]) });
    await refused(nan.build(), MODEL_WORDS.notModel);
    const huge = cubeGlb();
    // Each value finite, their product not.
    (huge.json.nodes as Json[])[0]!.scale = [1e200, 1e200, 1e200];
    (huge.json.nodes as Json[]).push({ scale: [1e200, 1e200, 1e200], children: [0] });
    (huge.json.scenes as Json[])[0]!.nodes = [1];
    await refused(huge.build(), MODEL_WORDS.notModel);
  });

  test("refuses a sparse POSITION in words", async () => {
    const sparse = cubeGlb();
    sparse.accessors[0]!.sparse = { count: 1, indices: { bufferView: 0, componentType: 5123 }, values: { bufferView: 0 } };
    await refused(sparse.build(), MODEL_WORDS.sparse);
    assert.equal(MODEL_WORDS.sparse, "This model stores part of its shape as sparse data, which the app can't read. Export it again without it.");
  });
});

describe("GLB bombs: extensions and buffers", () => {
  test("refuses Draco, meshopt and instancing by name, from extensionsUsed alone, extensionsRequired, or where they sit", async () => {
    const used = (name: string) => {
      const g = cubeGlb();
      g.json.extensionsUsed = [name];
      return g.build();
    };
    await refused(used("KHR_draco_mesh_compression"), MODEL_WORDS.draco);
    await refused(used("EXT_meshopt_compression"), MODEL_WORDS.meshopt);
    await refused(used("EXT_mesh_gpu_instancing"), MODEL_WORDS.instancing);
    assert.equal(MODEL_WORDS.instancing, "This model uses instancing, which the app can't read. Export it with the instances applied.");
    const required = cubeGlb();
    required.json.extensionsRequired = ["KHR_draco_mesh_compression"];
    await refused(required.build(), MODEL_WORDS.draco);
    const onNode = cubeGlb();
    (onNode.json.nodes as Json[])[0]!.extensions = { EXT_mesh_gpu_instancing: { attributes: {} } };
    await refused(onNode.build(), MODEL_WORDS.instancing);
    const onView = cubeGlb();
    onView.views[0]!.extensions = { EXT_meshopt_compression: {} };
    await refused(onView.build(), MODEL_WORDS.meshopt);
    const onPrimitive = cubeGlb();
    ((onPrimitive.json.meshes as Json[])[0]!.primitives as Json[])[0]!.extensions = { KHR_draco_mesh_compression: {} };
    await refused(onPrimitive.build(), MODEL_WORDS.draco);
  });

  test("ignores every other extension, listed or required", () => {
    const g = cubeGlb();
    g.json.extensionsUsed = ["KHR_materials_emissive_strength", "KHR_lights_punctual", "MADE_UP_extension"];
    g.json.extensionsRequired = ["MADE_UP_extension"];
    assert.equal(readGlb(g.build(), "computer").triangles, 12);
  });

  test("refuses a buffer that names a file, and a second buffer", async () => {
    const uri = cubeGlb();
    (uri.json.buffers as Json[])[0]!.uri = "model.bin";
    await refused(uri.build(), MODEL_WORDS.outsideFiles);
    const second = cubeGlb();
    (second.json.buffers as Json[]).push({ byteLength: 12, uri: "data:application/octet-stream;base64,AAAAAAAAAAAAAAAA" });
    await refused(second.build(), MODEL_WORDS.outsideFiles);
    assert.equal(MODEL_WORDS.outsideFiles, "This GLB names files outside it. Save it as one GLB and pick that.");
  });

  test("refuses a header that lies: a wrong magic, a version 1, a length past the file, a JSON chunk past it", async () => {
    const good = cubeGlb().build();
    for (const [at, value] of [[0, 0x46546c68], [4, 1], [8, good.length + 1], [12, good.length]] as const) {
      const bad = good.slice();
      new DataView(bad.buffer).setUint32(at, value, true);
      await refused(bad, MODEL_WORDS.notModel);
    }
  });
});

describe("GLB bombs: skins", () => {
  /** The cube skinned to `joints` joint nodes, each skin naming its list, outside the scene. */
  function skinnedCube(skins: number[][], jointNodes: number): Uint8Array {
    const g = new Glb();
    const n = 36;
    const position = g.floats(cube, "VEC3");
    const joints = g.accessor({ bufferView: g.view(new Uint8Array(n * 4)), componentType: 5121, type: "VEC4", count: n });
    const weights = g.floats(Array.from({ length: n }, () => [1, 0, 0, 0]).flat(), "VEC4");
    (g.json.meshes as Json[]).push({ primitives: [{ attributes: { POSITION: position, JOINTS_0: joints, WEIGHTS_0: weights } }] });
    g.json.skins = skins.map((list) => ({ joints: list }));
    skins.forEach((_, s) => g.node({ mesh: 0, skin: s }));
    for (let j = 0; j < jointNodes; j++) g.node({}, false);
    return g.build();
  }
  const first = (n: number, count: number) => Array.from({ length: count }, (_, i) => n + i);

  test("refuses duplicate joints in words", async () => {
    await refused(skinnedCube([[1, 2, 1]], 2), MODEL_WORDS.duplicateJoints);
    assert.equal(MODEL_WORDS.duplicateJoints, "This model's skeleton names one bone twice. Export it again with the skin applied.");
  });

  test("refuses 1,025 joints in one skin in words, and reads 1,024", async () => {
    assert.equal(readGlb(skinnedCube([first(1, 1024)], 1024), "computer").triangles, 12);
    await refused(skinnedCube([first(1, 1025)], 1025), MODEL_WORDS.skinJoints);
    assert.equal(MODEL_WORDS.skinJoints, "This model's skeleton has more than 1,024 bones. Export it again with the skin applied.");
  });

  test("refuses more than 16,384 joints over the drawn skins before any matrix is kept", async () => {
    // 17 skins of 1,000 joints over the same 1,000 nodes: 17,000 joints drawn. 16 skins of 1,024 are 16,384 and read.
    const skins = Array.from({ length: 17 }, (_, s) => first(17, 1000).map((j) => j + (s % 2)));
    await refused(skinnedCube(skins, 1001), MODEL_WORDS.drawnJoints, "computer", 64 * 1024);
    const atCap = Array.from({ length: 16 }, () => first(16, 1024));
    assert.equal(readGlb(skinnedCube(atCap, 1024), "computer").triangles, 16 * 12);
  });
});
