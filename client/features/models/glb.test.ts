import assert from "node:assert/strict";
import { describe, test } from "node:test";
import sharp from "sharp";
import { Bone, BufferAttribute, BufferGeometry, Matrix3, Matrix4, MeshBasicMaterial, Quaternion, Skeleton, SkinnedMesh, Vector3 } from "three";
import { MODEL_LIMITS } from "#shared/limits.ts";
import { CLUSTER_LIMITS } from "./cluster.ts";
import { allocations, box, Glb } from "./fixtures.testutil.ts";
import { readGlb } from "./glb.ts";
import { MODEL_WORDS, type ModelMesh, type ModelPart } from "./mesh.ts";

/**
 * The app's own GLB reader on hand-written files (docs/design/design-v1-token-models.md
 * 5 and section 9's GLB rows): groups, normals and winding, skins checked
 * against three's own SkinnedMesh, texture transforms against glTF's
 * T × R × S written out here, and the textures it keeps or leaves out.
 * Textures are flat colors and checkers sharp makes. The refusals are in
 * glb.bombs.test.ts.
 */

type Json = { [key: string]: unknown };
const cube = box([-0.5, 0, -0.5], [0.5, 1, 0.5]);
const read = (g: Glb, device: "touch" | "computer" = "computer") => readGlb(g.build(), device);
const png = async (w: number, h: number) => new Uint8Array(await sharp({ create: { width: w, height: h, channels: 3, background: { r: 200, g: 40, b: 40 } } }).png().toBuffer());
const webp = async (w: number, h: number) => new Uint8Array(await sharp({ create: { width: w, height: h, channels: 3, background: { r: 40, g: 200, b: 40 } } }).webp().toBuffer());
const near = (a: number, b: number, eps = 1e-5) => Math.abs(a - b) <= eps * Math.max(1, Math.abs(b));

/** A part's triangles' corners as [x, y, z] triples. */
function corners(part: ModelPart): [number, number, number][] {
  const out: [number, number, number][] = [];
  for (let i = 0; i < part.positions.length; i += 3) out.push([part.positions[i]!, part.positions[i + 1]!, part.positions[i + 2]!]);
  return out;
}

/** Every triangle's face normal, from its winding, points away from `center`. */
function facesOut(part: ModelPart, center: [number, number, number]): boolean {
  const p = part.positions;
  for (let o = 0; o < p.length; o += 9) {
    const u = [p[o + 3]! - p[o]!, p[o + 4]! - p[o + 1]!, p[o + 5]! - p[o + 2]!];
    const v = [p[o + 6]! - p[o]!, p[o + 7]! - p[o + 1]!, p[o + 8]! - p[o + 2]!];
    const n = [u[1]! * v[2]! - u[2]! * v[1]!, u[2]! * v[0]! - u[0]! * v[2]!, u[0]! * v[1]! - u[1]! * v[0]!];
    const c = [(p[o]! + p[o + 3]! + p[o + 6]!) / 3 - center[0], (p[o + 1]! + p[o + 4]! + p[o + 7]!) / 3 - center[1], (p[o + 2]! + p[o + 5]! + p[o + 8]!) / 3 - center[2]];
    if (n[0]! * c[0]! + n[1]! * c[1]! + n[2]! * c[2]! <= 0) return false;
  }
  return true;
}

/** Unit normals pointing away from `center`, each corner's. */
function normalsOut(part: ModelPart, center: [number, number, number]): boolean {
  const { positions: p, normals: n } = part;
  for (let i = 0; i < p.length; i += 3) {
    if (!near(Math.hypot(n[i]!, n[i + 1]!, n[i + 2]!), 1)) return false;
    if (n[i]! * (p[i]! - center[0]) + n[i + 1]! * (p[i + 1]! - center[1]) + n[i + 2]! * (p[i + 2]! - center[2]) <= 0) return false;
  }
  return true;
}

/** The cube's flat normals, 36 corners. */
function cubeNormals(): number[] {
  const out: number[] = [];
  for (let o = 0; o < cube.length; o += 9) {
    const u = [cube[o + 3]! - cube[o]!, cube[o + 4]! - cube[o + 1]!, cube[o + 5]! - cube[o + 2]!];
    const v = [cube[o + 6]! - cube[o]!, cube[o + 7]! - cube[o + 1]!, cube[o + 8]! - cube[o + 2]!];
    const n = [u[1]! * v[2]! - u[2]! * v[1]!, u[2]! * v[0]! - u[0]! * v[2]!, u[0]! * v[1]! - u[1]! * v[0]!];
    const len = Math.hypot(n[0]!, n[1]!, n[2]!);
    for (let k = 0; k < 3; k++) out.push(n[0]! / len, n[1]! / len, n[2]! / len);
  }
  return out;
}

describe("the GLB reader's output", () => {
  test("reads a cube as one plain part of 12 triangles, offering Color", () => {
    const g = new Glb();
    g.node({ mesh: g.meshOf(cube, {}, cubeNormals()) });
    const mesh = read(g);
    assert.equal(mesh.axes, "yUp");
    assert.equal(mesh.triangles, 12);
    assert.equal(mesh.parts.length, 1);
    assert.ok(mesh.parts[0]!.material.plain && mesh.colorable);
    assert.deepEqual(corners(mesh.parts[0]!).flat(), cube);
    assert.ok(normalsOut(mesh.parts[0]!, [0, 0.5, 0]));
  });

  test("composes node transforms down the tree, matrix or TRS, as three does", () => {
    const g = new Glb();
    const mesh = g.meshOf(cube, {}, cubeNormals());
    const leaf = g.node({ mesh, translation: [1, 2, 3], rotation: [0, Math.sin(Math.PI / 6), 0, Math.cos(Math.PI / 6)], scale: [2, 2, 2] }, false);
    const parent = new Matrix4().makeRotationX(0.7).setPosition(-1, 0, 4);
    g.node({ matrix: parent.toArray(), children: [leaf] });
    const out = read(g).parts[0]!;
    const local = new Matrix4().compose(new Vector3(1, 2, 3), new Quaternion(0, Math.sin(Math.PI / 6), 0, Math.cos(Math.PI / 6)), new Vector3(2, 2, 2));
    const world = parent.clone().multiply(local);
    corners(out).forEach(([x, y, z], i) => {
      const want = new Vector3(cube[i * 3]!, cube[i * 3 + 1]!, cube[i * 3 + 2]!).applyMatrix4(world);
      assert.ok(near(x, want.x) && near(y, want.y) && near(z, want.z), `corner ${i}`);
    });
    const center = new Vector3(0, 0.5, 0).applyMatrix4(world);
    assert.ok(facesOut(out, [center.x, center.y, center.z]) && normalsOut(out, [center.x, center.y, center.z]));
  });

  test("a node at scale -1 keeps its faces out by reversing their winding, and its normals out", () => {
    for (const scale of [[-1, 1, 1], [1, -1, 1], [-1, -1, -1], [-2, 0.5, 3]] as const) {
      const g = new Glb();
      g.node({ mesh: g.meshOf(cube, {}, cubeNormals()), scale: [...scale] });
      const part = read(g).parts[0]!;
      const center: [number, number, number] = [0, 0.5 * scale[1], 0];
      assert.ok(facesOut(part, center), `faces at scale ${scale}`);
      assert.ok(normalsOut(part, center), `normals at scale ${scale}`);
    }
  });

  test("a node at non-uniform scale turns its normals by the inverse transpose, not the matrix", () => {
    // A slanted face's normal skews the other way from its positions under a stretch.
    const tri = [0, 0, 0, 1, 0, 0, 0, 1, 0];
    const n = [1 / Math.SQRT2, 0, 1 / Math.SQRT2];
    const g = new Glb();
    g.node({ mesh: g.meshOf(tri, {}, [...n, ...n, ...n]), scale: [4, 1, 1] });
    const part = read(g).parts[0]!;
    const want = new Vector3(...n).applyMatrix3(new Matrix3().getNormalMatrix(new Matrix4().makeScale(4, 1, 1))).normalize();
    assert.ok(near(part.normals[0]!, want.x) && near(part.normals[2]!, want.z));
    assert.ok(part.normals[0]! < part.normals[2]!, "the stretch along x leans the normal toward z");
  });

  test("a strip alternates its winding as glTF says, and a fan turns about its first vertex", () => {
    // A quad as a strip of 4 and as a fan of 4: both are two triangles facing +Z.
    const quad = [0, 0, 0, 1, 0, 0, 0, 1, 0, 1, 1, 0];
    const fan = [0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0];
    for (const [positions, mode] of [[quad, 5], [fan, 6]] as const) {
      const g = new Glb();
      (g.json.meshes as Json[]).push({ primitives: [{ attributes: { POSITION: g.floats(positions, "VEC3") }, mode }] });
      g.node({ mesh: 0 });
      const part = read(g).parts[0]!;
      assert.equal(part.positions.length, 18);
      assert.ok(facesOut(part, [0.5, 0.5, -1]), `mode ${mode} faces +Z`);
    }
  });

  test("makes smooth normals by weld where a primitive has none, and face normals past the weld table", () => {
    const g = new Glb();
    g.node({ mesh: g.meshOf(cube) });
    const smooth = read(g).parts[0]!;
    // Each corner sums the faces it touches, so it leans into all three axes, and still points out.
    for (let i = 0; i < smooth.normals.length; i++) assert.ok(Math.abs(smooth.normals[i]!) > 0.2, "a corner's normal leans into every face it touches");
    assert.ok(normalsOut(smooth, [0, 0.5, 0]));
    const flat = readGlb(g.build(), "computer", { cluster: { ...CLUSTER_LIMITS, slots: 8, cells: 4 } }).parts[0]!;
    assert.deepEqual([...flat.normals].map((v) => Math.round(v * 1e6) / 1e6), cubeNormals().map((v) => Math.round(v * 1e6) / 1e6));
  });

  test("reads 64 views over the whole BIN in place, with nothing copied past the output", async () => {
    // Each view is the whole 4 MB BIN, so a reader that copied views would make 256 MB.
    const g = new Glb();
    const bin = new Uint8Array(4 * 1024 * 1024);
    bin.set(new Uint8Array(new Float32Array(cube).buffer), 0);
    bin.set(new Uint8Array(new Float32Array(cubeNormals()).buffer), 432);
    const shared = g.view(bin);
    for (let i = 0; i < 63; i++) g.views.push({ ...g.views[shared]! });
    const primitives = Array.from({ length: 64 }, (_, i) => ({
      attributes: {
        POSITION: g.accessor({ bufferView: i, componentType: 5126, type: "VEC3", count: 36 }),
        NORMAL: g.accessor({ bufferView: i, byteOffset: 432, componentType: 5126, type: "VEC3", count: 36 }),
      },
    }));
    (g.json.meshes as Json[]).push({ primitives });
    g.node({ mesh: 0 });
    const file = g.build();
    const { result, total } = await allocations(() => readGlb(file, "computer"));
    assert.ok(!(result instanceof Error), String(result));
    const mesh = result as ModelMesh;
    assert.equal(mesh.triangles, 64 * 12);
    const output = mesh.parts.reduce((n, p) => n + p.positions.byteLength + p.normals.byteLength, 0);
    assert.ok(total - output < 64 * 1024, `${total - output} bytes past the output`);
  });

  test("reads quantized positions and normals as floats (KHR_mesh_quantization)", () => {
    const g = new Glb();
    const shorts = new Int16Array([0, 0, 0, 32767, 0, 0, 0, 32767, 0]);
    const bytes = new Int8Array([0, 0, 127, 0, 0, 127, 0, 0, 127]);
    const ubytes = new Uint8Array([0, 0, 0, 2, 0, 0, 0, 2, 0]);
    const pos = g.accessor({ bufferView: g.view(new Uint8Array(shorts.buffer)), componentType: 5122, normalized: true, type: "VEC3", count: 3 });
    const nor = g.accessor({ bufferView: g.view(new Uint8Array(bytes.buffer)), componentType: 5120, normalized: true, type: "VEC3", count: 3 });
    const raw = g.accessor({ bufferView: g.view(ubytes), componentType: 5121, type: "VEC3", count: 3 });
    g.json.extensionsUsed = ["KHR_mesh_quantization"];
    (g.json.meshes as Json[]).push({ primitives: [{ attributes: { POSITION: pos, NORMAL: nor } }, { attributes: { POSITION: raw } }] });
    g.node({ mesh: 0 });
    const part = read(g).parts[0]!;
    assert.deepEqual([...part.positions.slice(0, 9)], [0, 0, 0, 1, 0, 0, 0, 1, 0]);
    assert.deepEqual([...part.normals.slice(0, 3)], [0, 0, 1]);
    assert.deepEqual([...part.positions.slice(9, 18)], [0, 0, 0, 2, 0, 0, 0, 2, 0]);
  });

  test("draws a primitive with no material in the Color option's choice, and never reads a second scene", () => {
    const g = new Glb();
    g.node({ mesh: g.meshOf(cube) });
    // A second scene of bombs: a cycle, a node under two parents, and a mesh naming 10 million triangles.
    const nodes = g.json.nodes as Json[];
    nodes.push({ children: [2] }, { children: [1] }, { children: [1], mesh: 1 });
    (g.json.meshes as Json[]).push({ primitives: [{ attributes: { POSITION: g.accessor({ componentType: 5126, type: "VEC3", count: 30_000_000 }) } }] });
    (g.json.scenes as Json[]).push({ nodes: [1, 2, 3, 3] });
    const mesh = read(g);
    assert.equal(mesh.triangles, 12);
    assert.ok(mesh.colorable && mesh.parts[0]!.material.plain);
  });
});

describe("the GLB reader's groups", () => {
  test("keys a group by texture, base color, alpha mode and cutoff and sides: masked, blended and double-sided parts stay apart", () => {
    const g = new Glb();
    g.json.materials = [
      { pbrMetallicRoughness: { baseColorFactor: [1, 0, 0, 1] } },
      { pbrMetallicRoughness: { baseColorFactor: [1, 0, 0, 1] }, alphaMode: "MASK", alphaCutoff: 0.3 },
      { pbrMetallicRoughness: { baseColorFactor: [1, 0, 0, 0.5] }, alphaMode: "BLEND" },
      { pbrMetallicRoughness: { baseColorFactor: [1, 0, 0, 1] }, doubleSided: true },
      { pbrMetallicRoughness: { baseColorFactor: [1, 0, 0, 1] }, name: "the same look as the first" },
    ];
    for (let m = 0; m < 5; m++) g.node({ mesh: g.meshOf(cube, { material: m }) });
    const mesh = read(g);
    assert.equal(mesh.parts.length, 4);
    const [opaque, mask, blend, sides] = mesh.parts.map((p) => p.material);
    assert.deepEqual([opaque!.alpha, mask!.alpha, mask!.alphaCutoff, blend!.alpha, blend!.color[3], sides!.doubleSided], ["opaque", "mask", 0.3, "blend", 0.5, true]);
    assert.equal(mesh.parts[0]!.positions.length, 2 * 36 * 3, "the first and the fifth material share a group");
    assert.ok(!mesh.colorable);
  });

  test("reads COLOR_0 as bytes, RGB or RGBA, float or normalized, and fills white where a part of its group has none", () => {
    const g = new Glb();
    g.json.materials = [{}];
    const n = 36;
    const rgb = g.floats(Array.from({ length: n }, () => [0.5, 0, 1]).flat(), "VEC3");
    const rgba = g.accessor({ bufferView: g.view(new Uint8Array(Array.from({ length: n }, () => [255, 128, 0, 64]).flat())), componentType: 5121, normalized: true, type: "VEC4", count: n });
    g.node({ mesh: g.meshOf(cube, { material: 0, attributes: { COLOR_0: rgb } }) });
    g.node({ mesh: g.meshOf(cube, { material: 0, attributes: { COLOR_0: rgba } }) });
    g.node({ mesh: g.meshOf(cube, { material: 0 }) });
    const part = read(g).parts[0]!;
    assert.equal(part.colors!.length, 3 * n * 4);
    assert.deepEqual([...part.colors!.slice(0, 4)], [128, 0, 255, 255]);
    assert.deepEqual([...part.colors!.slice(n * 4, n * 4 + 4)], [255, 128, 0, 64]);
    assert.deepEqual([...part.colors!.slice(2 * n * 4, 2 * n * 4 + 4)], [255, 255, 255, 255]);
  });

  test("reads the texture's own coordinate set, a second one too, and keeps its sampler's wrap, repeat by default", async () => {
    const g = new Glb();
    g.json.images = [{ bufferView: g.view(await png(8, 8)), mimeType: "image/png" }];
    g.json.samplers = [{ wrapS: 33648, wrapT: 33071 }];
    g.json.textures = [{ source: 0, sampler: 0 }, { source: 0 }];
    g.json.materials = [{ pbrMetallicRoughness: { baseColorTexture: { index: 0, texCoord: 1 } } }, { pbrMetallicRoughness: { baseColorTexture: { index: 1 } } }];
    const uv0 = g.floats(Array.from({ length: 36 }, () => [0.25, 0.25]).flat(), "VEC2");
    const uv1 = g.floats(Array.from({ length: 36 }, (_, i) => [i, 3]).flat(), "VEC2");
    g.node({ mesh: g.meshOf(cube, { material: 0, attributes: { TEXCOORD_0: uv0, TEXCOORD_1: uv1 } }) });
    g.node({ mesh: g.meshOf(cube, { material: 1, attributes: { TEXCOORD_0: uv1 } }) });
    const mesh = read(g);
    assert.equal(mesh.textures.length, 1, "one image, kept once");
    const [second, repeat] = mesh.parts;
    assert.deepEqual([second!.material.wrapS, second!.material.wrapT, repeat!.material.wrapS, repeat!.material.wrapT], [33648, 33071, 10497, 10497]);
    assert.deepEqual([...second!.uvs!.slice(0, 4)], [0, 3, 1, 3], "the second set, tiled past 1");
  });

  test("puts a primitive that lacks its texture's coordinate set in the untextured group", async () => {
    const g = new Glb();
    g.json.images = [{ bufferView: g.view(await png(8, 8)), mimeType: "image/png" }];
    g.json.textures = [{ source: 0 }];
    g.json.materials = [{ pbrMetallicRoughness: { baseColorTexture: { index: 0 } } }];
    g.node({ mesh: g.meshOf(cube, { material: 0, attributes: { TEXCOORD_0: g.floats(new Array(72).fill(0.5), "VEC2") } }) });
    g.node({ mesh: g.meshOf(cube, { material: 0 }) });
    const mesh = read(g);
    assert.equal(mesh.parts.length, 2);
    assert.ok(mesh.parts[0]!.uvs && mesh.parts[0]!.material.texture === 0);
    assert.ok(mesh.parts[1]!.uvs === null && mesh.parts[1]!.material.texture === -1);
  });

  test("applies KHR_texture_transform as glTF's T × R × S, with a rotation and unequal scales, and its own texCoord", async () => {
    const offset = [0.25, -0.5];
    const rotation = 0.6;
    const scale = [2, 0.5];
    const g = new Glb();
    g.json.images = [{ bufferView: g.view(await png(4, 4)), mimeType: "image/png" }];
    g.json.textures = [{ source: 0 }];
    g.json.extensionsUsed = ["KHR_texture_transform"];
    g.json.materials = [{ pbrMetallicRoughness: { baseColorTexture: { index: 0, texCoord: 0, extensions: { KHR_texture_transform: { offset, rotation, scale, texCoord: 1 } } } } }];
    const uvs = Array.from({ length: 36 }, (_, i) => [(i % 7) / 7, (i % 5) / 5]);
    const uv1 = g.floats(uvs.flat(), "VEC2");
    g.node({ mesh: g.meshOf(cube, { material: 0, attributes: { TEXCOORD_0: g.floats(new Array(72).fill(9), "VEC2"), TEXCOORD_1: uv1 } }) });
    const part = read(g).parts[0]!;
    // glTF's matrices, row-major, multiplied out here rather than through three's setUvTransform (T × S × R).
    const T = [1, 0, offset[0]!, 0, 1, offset[1]!, 0, 0, 1];
    const R = [Math.cos(rotation), Math.sin(rotation), 0, -Math.sin(rotation), Math.cos(rotation), 0, 0, 0, 1];
    const S = [scale[0]!, 0, 0, 0, scale[1]!, 0, 0, 0, 1];
    const mul = (a: number[], b: number[]) => Array.from({ length: 9 }, (_, i) => a[Math.floor(i / 3) * 3]! * b[i % 3]! + a[Math.floor(i / 3) * 3 + 1]! * b[3 + (i % 3)]! + a[Math.floor(i / 3) * 3 + 2]! * b[6 + (i % 3)]!);
    const M = mul(mul(T, R), S);
    uvs.forEach(([u, v], i) => {
      const want = [M[0]! * u! + M[1]! * v! + M[2]!, M[3]! * u! + M[4]! * v! + M[5]!];
      assert.ok(near(part.uvs![i * 2]!, want[0]!) && near(part.uvs![i * 2 + 1]!, want[1]!), `corner ${i}`);
    });
  });
});

describe("the GLB reader's textures", () => {
  /** A GLB of one textured cube per image, the images as given. */
  async function textured(images: Json[], textures: Json[] = images.map((_, i) => ({ source: i }))): Promise<ModelMesh> {
    const g = new Glb();
    g.json.images = images.map((im) => (im.bytes ? { bufferView: g.view(im.bytes as Uint8Array), mimeType: im.mimeType ?? "image/png" } : im));
    g.json.textures = textures;
    g.json.materials = textures.map((_, i) => ({ pbrMetallicRoughness: { baseColorTexture: { index: i } } }));
    const uv = g.floats(new Array(72).fill(0.5), "VEC2");
    textures.forEach((_, i) => g.node({ mesh: g.meshOf(cube, { material: i, attributes: { TEXCOORD_0: uv } }) }));
    return read(g);
  }

  test("keeps a WebP texture, named by EXT_texture_webp or by its source, and an AVIF one, each from its header", async () => {
    const mesh = await textured([{ bytes: await webp(16, 8), mimeType: "image/webp" }, { bytes: await png(4, 4) }], [{ source: 1, extensions: { EXT_texture_webp: { source: 0 } } }]);
    assert.deepEqual(mesh.textures.map((t) => [t.mime, t.width, t.height]), [["image/webp", 16, 8]]);
    assert.deepEqual(mesh.notes, []);
  });

  test("draws a KTX2 texture's PNG fallback, and leaves a KTX2-only one out with the note", async () => {
    const fallback = await textured([{ bytes: await png(4, 4) }], [{ source: 0, extensions: { KHR_texture_basisu: { source: 0 } } }]);
    assert.equal(fallback.textures.length, 1);
    assert.deepEqual(fallback.notes, []);
    const only = await textured([{ bytes: new Uint8Array([0xab, 0x4b, 0x54, 0x58, 0x20, 0x32, 0x30, 0xbb]), mimeType: "image/ktx2" }], [{ extensions: { KHR_texture_basisu: { source: 0 } } }]);
    assert.equal(only.textures.length, 0);
    assert.equal(only.parts[0]!.material.texture, -1);
    assert.deepEqual(only.notes, [MODEL_WORDS.ktx2Note]);
  });

  test("leaves out an image named by uri with the note, and never fetches it", async () => {
    const mesh = await textured([{ uri: "https://example.invalid/skin.png" }]);
    assert.equal(mesh.textures.length, 0);
    assert.deepEqual(mesh.notes, [MODEL_WORDS.uriNote]);
    assert.equal(MODEL_WORDS.uriNote, "Its textures are separate files, so it draws without them. Export one GLB to keep them.");
  });

  test("leaves out a 20,000 px header and an unreadable one, its group in its base color", async () => {
    const huge = await png(4, 4);
    new DataView(huge.buffer, huge.byteOffset).setUint32(16, 20_000);
    new DataView(huge.buffer, huge.byteOffset).setUint32(20, 20_000);
    const mesh = await textured([{ bytes: huge }, { bytes: new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]) }]);
    assert.equal(mesh.textures.length, 0);
    // One pixel row past 4096 by 4096 is past the one image's cap though far inside the 64 MP of all.
    const over = await png(4, 4);
    new DataView(over.buffer, over.byteOffset).setUint32(16, 4096);
    new DataView(over.buffer, over.byteOffset).setUint32(20, 4097);
    assert.equal((await textured([{ bytes: over }])).textures.length, 0);
    const at = over.slice();
    new DataView(at.buffer, at.byteOffset).setUint32(20, 4096);
    assert.equal((await textured([{ bytes: at }])).textures.length, 1);
    assert.ok(mesh.parts.every((p) => p.material.texture === -1 && p.uvs === null));
  });

  test("keeps 16 textures in reading order and leaves out the 17th, and holds 64 MP together", async () => {
    const images = await Promise.all(Array.from({ length: 17 }, async () => ({ bytes: await png(2, 2) })));
    const mesh = await textured(images);
    assert.equal(mesh.textures.length, MODEL_LIMITS.textures);
    assert.equal(mesh.parts.filter((p) => p.material.texture >= 0).length, 16);
    assert.equal(mesh.parts[16]!.material.texture, -1, "the 17th in reading order is the one left out");
    // Four 4096 by 4096 headers fill the 64 MP. The fifth is left out, though fewer than 16 are kept.
    const big = await png(2, 2);
    new DataView(big.buffer, big.byteOffset).setUint32(16, 4096);
    new DataView(big.buffer, big.byteOffset).setUint32(20, 4096);
    const five = await textured(Array.from({ length: 5 }, () => ({ bytes: big.slice() })));
    assert.equal(five.textures.length, 4);
  });
});

describe("the GLB reader's skins", () => {
  /**
   * A skinned strip of triangles over two joints, a parent turned 30
   * degrees about Z and a child moved and turned 90 about X, with weights
   * that blend them. Checked vertex by vertex against three's SkinnedMesh at
   * rest, and its normals against the blended matrix's inverse transpose.
   */
  function skinned(options: { reorder?: boolean; inverse?: boolean; outside?: boolean; weights?: number[][] } = {}) {
    const g = new Glb();
    const positions = [0, 0, 0, 1, 0, 0, 0, 1, 0, 1, 1, 0, 0, 2, 0, 1, 2, 0];
    const normals = [0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1].map((v, i) => (i % 3 === 0 ? 0.3 : v));
    const tris = [0, 1, 2, 1, 3, 2, 2, 3, 4, 3, 5, 4].flatMap((v) => [positions[v * 3]!, positions[v * 3 + 1]!, positions[v * 3 + 2]!]);
    const trisN = [0, 1, 2, 1, 3, 2, 2, 3, 4, 3, 5, 4].flatMap((v) => [normals[v * 3]!, normals[v * 3 + 1]!, normals[v * 3 + 2]!]);
    const weights = options.weights ?? [[1, 0], [0.75, 0.25], [0.5, 0.5], [0.25, 0.75], [0, 1], [0.1, 0.9]];
    const perCorner = [0, 1, 2, 1, 3, 2, 2, 3, 4, 3, 5, 4].map((v) => weights[v]!);
    const parentLocal = new Matrix4().compose(new Vector3(0.2, 0, 0), new Quaternion().setFromAxisAngle(new Vector3(0, 0, 1), Math.PI / 6), new Vector3(1, 1, 1));
    const childLocal = new Matrix4().compose(new Vector3(0, 1, 0), new Quaternion().setFromAxisAngle(new Vector3(1, 0, 0), Math.PI / 2), new Vector3(1, 2, 1));
    const meshNode = g.node({ mesh: 0, skin: 0, translation: [50, 50, 50] });
    const child = g.node({ matrix: childLocal.toArray() }, false);
    const parent = g.node({ matrix: parentLocal.toArray(), children: [child] }, !options.outside);
    // glTF orders the joints as it likes, and JOINTS_0 indexes that list.
    const jointList = options.reorder ? [child, parent] : [parent, child];
    const slotOfParent = jointList.indexOf(parent);
    const binds = [new Matrix4().makeTranslation(0.1, 0, 0), new Matrix4().makeTranslation(0, -1, 0)];
    const inverse = jointList.map((j) => (j === parent ? binds[0]! : binds[1]!));
    const joints = new Uint8Array(perCorner.flatMap(() => (slotOfParent === 0 ? [0, 1, 0, 0] : [1, 0, 0, 0])));
    g.json.skins = [{ joints: jointList, ...(options.inverse === false ? {} : { inverseBindMatrices: g.floats(inverse.flatMap((m) => m.toArray()), "MAT4") }) }];
    (g.json.meshes as Json[]).push({
      primitives: [
        {
          attributes: {
            POSITION: g.floats(tris, "VEC3"),
            NORMAL: g.floats(trisN, "VEC3"),
            JOINTS_0: g.accessor({ bufferView: g.view(joints), componentType: 5121, type: "VEC4", count: perCorner.length }),
            WEIGHTS_0: g.floats(perCorner.flatMap(([a, b]) => [a!, b!, 0, 0]), "VEC4"),
          },
        },
      ],
    });
    void meshNode;
    // three's oracle: the same bones, bound at identity as GLTFLoader binds them.
    const boneParent = new Bone();
    const boneChild = new Bone();
    boneParent.matrixAutoUpdate = boneChild.matrixAutoUpdate = false;
    boneParent.matrix.copy(parentLocal);
    boneChild.matrix.copy(childLocal);
    boneParent.add(boneChild);
    boneParent.updateMatrixWorld(true);
    const bones = [boneParent, boneChild];
    const boneInverses = options.inverse === false ? [new Matrix4(), new Matrix4()] : binds;
    const geometry = new BufferGeometry();
    geometry.setAttribute("position", new BufferAttribute(new Float32Array(tris), 3));
    geometry.setAttribute("skinIndex", new BufferAttribute(new Uint16Array(perCorner.flatMap(() => [0, 1, 0, 0])), 4));
    const sum = (w: number[]) => w[0]! + w[1]!;
    geometry.setAttribute("skinWeight", new BufferAttribute(new Float32Array(perCorner.flatMap((w) => (sum(w) > 0 ? [w[0]! / sum(w), w[1]! / sum(w), 0, 0] : [0, 0, 0, 0]))), 4));
    const three = new SkinnedMesh(geometry, new MeshBasicMaterial());
    three.bind(new Skeleton(bones, boneInverses), new Matrix4());
    const jointMatrix = (k: number) => bones[k]!.matrixWorld.clone().multiply(boneInverses[k]!);
    return { g, tris, trisN, perCorner, three, jointMatrix };
  }

  function check(options: Parameters<typeof skinned>[0]): void {
    const { g, tris, trisN, perCorner, three, jointMatrix } = skinned(options);
    const part = read(g).parts[0]!;
    perCorner.forEach((w, i) => {
      const at = new Vector3(tris[i * 3]!, tris[i * 3 + 1]!, tris[i * 3 + 2]!);
      const total = w[0]! + w[1]!;
      const want = total === 0 ? at.clone() : three.applyBoneTransform(i, at.clone());
      const got = [part.positions[i * 3]!, part.positions[i * 3 + 1]!, part.positions[i * 3 + 2]!];
      assert.ok(near(got[0]!, want.x, 1e-5) && near(got[1]!, want.y, 1e-5) && near(got[2]!, want.z, 1e-5), `vertex ${i}: ${got} against three's ${want.toArray()}`);
      // The normal's expectation: the blend of the joint matrices, its inverse transpose, renormalized.
      const blend = new Matrix4().makeScale(0, 0, 0);
      if (total === 0) blend.identity();
      else for (const k of [0, 1]) blend.elements.forEach((_, e) => (blend.elements[e]! += (w[k]! / total) * jointMatrix(k).elements[e]!));
      const n = new Vector3(trisN[i * 3]!, trisN[i * 3 + 1]!, trisN[i * 3 + 2]!).applyMatrix3(new Matrix3().getNormalMatrix(blend)).normalize();
      assert.ok(near(part.normals[i * 3]!, n.x, 1e-5) && near(part.normals[i * 3 + 1]!, n.y, 1e-5) && near(part.normals[i * 3 + 2]!, n.z, 1e-5), `normal ${i}`);
    });
  }

  test("puts every vertex where three's SkinnedMesh puts it at rest, two joints turned differently, the mesh node's own transform ignored", () => check({}));
  test("reads a reordered joint list", () => check({ reorder: true }));
  test("normalizes weights that do not sum to 1", () => check({ weights: [[2, 0], [0.5, 0.25], [0.3, 0.3], [0.1, 0.7], [0, 3], [0.2, 0.9]] }));
  test("takes identity where inverseBindMatrices is absent", () => check({ inverse: false }));
  test("composes a joint outside the scene from its own root", () => check({ outside: true }));
  test("draws a vertex whose weights sum to 0 at its bind position, an intended difference from three's loader", () => check({ weights: [[0, 0], [0.75, 0.25], [0, 0], [0.25, 0.75], [0, 1], [0.1, 0.9]] }));

  test("refuses a joint with two parents in the skeleton's words, and a weight past the joint list as no model", () => {
    const broken = skinned({ outside: true }).g;
    const nodes = broken.json.nodes as Json[];
    nodes.push({ children: [1] });
    assert.throws(() => readGlb(broken.build(), "computer"), { message: MODEL_WORDS.brokenSkeleton });
    // Every weight on the first joint, so the second index past the list has weight 0: refused all the same.
    const past = skinned({ weights: [[1, 0], [1, 0], [1, 0], [1, 0], [1, 0], [1, 0]] }).g;
    (past.json.skins as Json[])[0]!.joints = [2];
    (past.json.skins as Json[])[0]!.inverseBindMatrices = undefined;
    assert.throws(() => readGlb(past.build(), "computer"), { message: MODEL_WORDS.notModel });
  });

  test("falls back to the face normal where a blend flattens a normal to nothing", () => {
    // Joints 180 degrees apart at half each: the blend's upper 3 by 3 is rank 1, its cofactor 0, and the normal would be NaN.
    const { g } = skinned({ inverse: false, weights: [[0.5, 0.5], [1, 0], [1, 0], [1, 0], [1, 0], [1, 0]] });
    const nodes = g.json.nodes as Json[];
    nodes[2] = { children: [1] };
    nodes[1] = { matrix: new Matrix4().makeRotationZ(Math.PI).toArray() };
    const part = read(g).parts[0]!;
    for (let i = 0; i < part.normals.length; i += 3) assert.ok(near(Math.hypot(part.normals[i]!, part.normals[i + 1]!, part.normals[i + 2]!), 1), "a unit normal, never NaN");
    // The first triangle is (0, 0, 0), (1, 0, 0), (0, 1, 0) once vertex 0 collapses: its face faces +Z.
    assert.deepEqual([...part.positions.slice(0, 3)].map((v) => Math.round(v * 1e6) / 1e6), [0, 0, 0]);
    assert.deepEqual([...part.normals.slice(0, 3)].map((v) => Math.round(v * 1e6) / 1e6), [0, 0, 1]);
  });
});
