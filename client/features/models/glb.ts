import { MODEL_LIMITS } from "#shared/limits.ts";
import { CLUSTER_LIMITS, faceNormal, weldNormals, type ClusterLimits, type NormalSpan } from "./cluster.ts";
import { jsonCaps, prescanJson } from "./glbJson.ts";
import { imageHeader } from "./glbImages.ts";
import { MODEL_WORDS, ModelRefusal, trianglesWords, type ModelDevice, type ModelMesh, type ModelPart, type ModelTexture, type PartMaterial } from "./mesh.ts";

/**
 * The app's own GLB reader (docs/design/design-v1-token-models.md 5,
 * D-261127-429, 470 to 478, 510 to 526). A GLB is untrusted bytes that name
 * counts, offsets and objects, and a loader that believes them can be made
 * to allocate without bound. So this reads the way stl.ts and obj.ts do:
 * every array it makes is sized from a number it has counted and checked
 * against a cap first, and three.js only ever gets the at most 64 buffers
 * it fills.
 *
 * In order: the header and chunks, the JSON's pre-scan and parse, the
 * extensions refused by name, the default scene's node tree walked once
 * with an explicit stack (its world matrices kept), the primitive
 * references and drawn triangles counted, every accessor used checked,
 * skins and groups counted, textures kept or left out by their headers,
 * and only then the output, pre-sized per group and filled from the same
 * list of references the counting made.
 */

type Json = { [key: string]: unknown };

const GLB_MAGIC = 0x46546c67;
const JSON_CHUNK = 0x4e4f534a;
const BIN_CHUNK = 0x004e4942;

const TRIANGLES = 4;
const STRIP = 5;
const FAN = 6;

const BYTE = 5120;
const UBYTE = 5121;
const SHORT = 5122;
const USHORT = 5123;
const UINT = 5125;
const FLOAT = 5126;

const COMPONENT_BYTES: Record<number, number> = { [BYTE]: 1, [UBYTE]: 1, [SHORT]: 2, [USHORT]: 2, [UINT]: 4, [FLOAT]: 4 };
const TYPE_COMPONENTS: Record<string, number> = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT4: 16 };

const REPEAT = 10497;
const WRAPS = new Set([REPEAT, 33071, 33648]);

const refuse = (words: string): never => {
  throw new ModelRefusal(words);
};
const notModel = (): never => refuse(MODEL_WORDS.notModel);

const isObject = (v: unknown): v is Json => typeof v === "object" && v !== null && !Array.isArray(v);

/** A top-level array, or none. Anything else is no glTF. */
function listOf(json: Json, key: string): unknown[] {
  const v = json[key];
  if (v === undefined) return [];
  return Array.isArray(v) ? v : notModel();
}

function indexOf(v: unknown, length: number): number {
  return typeof v === "number" && Number.isSafeInteger(v) && v >= 0 && v < length ? v : notModel();
}

function item(list: readonly unknown[], v: unknown): Json {
  const found = list[indexOf(v, list.length)];
  return isObject(found) ? found : notModel();
}

function whole(v: unknown, fallback?: number): number {
  if (v === undefined && fallback !== undefined) return fallback;
  return typeof v === "number" && Number.isSafeInteger(v) && v >= 0 ? v : notModel();
}

function numbers(v: unknown, n: number, fallback: readonly number[]): number[] {
  if (v === undefined) return [...fallback];
  if (!Array.isArray(v) || v.length !== n) return notModel();
  return v.map((x) => (typeof x === "number" && Number.isFinite(x) ? x : notModel()));
}

function finiteOr(v: unknown, fallback: number): number {
  if (v === undefined) return fallback;
  return typeof v === "number" && Number.isFinite(v) ? v : notModel();
}

/** Draco, meshopt and instancing, refused by name wherever the JSON lists them (D-261127-478). */
const REFUSED_EXTENSIONS: Record<string, string> = {
  KHR_draco_mesh_compression: MODEL_WORDS.draco,
  EXT_meshopt_compression: MODEL_WORDS.meshopt,
  KHR_meshopt_compression: MODEL_WORDS.meshopt,
  EXT_mesh_gpu_instancing: MODEL_WORDS.instancing,
};

function refuseExtensionsIn(holder: unknown): void {
  if (!isObject(holder) || !isObject(holder.extensions)) return;
  for (const name of Object.keys(holder.extensions)) if (Object.hasOwn(REFUSED_EXTENSIONS, name)) refuse(REFUSED_EXTENSIONS[name]!);
}

// Column-major 4 by 4 matrices, as glTF writes them.

function identity(): Float64Array {
  const m = new Float64Array(16);
  m[0] = m[5] = m[10] = m[15] = 1;
  return m;
}

function multiply(a: ArrayLike<number>, b: ArrayLike<number>, out: Float64Array): Float64Array {
  for (let c = 0; c < 4; c++) {
    for (let r = 0; r < 4; r++) {
      out[c * 4 + r] = a[r]! * b[c * 4]! + a[4 + r]! * b[c * 4 + 1]! + a[8 + r]! * b[c * 4 + 2]! + a[12 + r]! * b[c * 4 + 3]!;
    }
  }
  return out;
}

/** A node's own transform: its matrix, or its translation, rotation and scale composed as T × R × S. */
function localMatrix(node: Json): Float64Array {
  if (node.matrix !== undefined) return Float64Array.from(numbers(node.matrix, 16, []));
  const [tx, ty, tz] = numbers(node.translation, 3, [0, 0, 0]) as [number, number, number];
  const [x, y, z, w] = numbers(node.rotation, 4, [0, 0, 0, 1]) as [number, number, number, number];
  const [sx, sy, sz] = numbers(node.scale, 3, [1, 1, 1]) as [number, number, number];
  const m = new Float64Array(16);
  const x2 = x + x;
  const y2 = y + y;
  const z2 = z + z;
  const xx = x * x2;
  const xy = x * y2;
  const xz = x * z2;
  const yy = y * y2;
  const yz = y * z2;
  const zz = z * z2;
  const wx = w * x2;
  const wy = w * y2;
  const wz = w * z2;
  m[0] = (1 - (yy + zz)) * sx;
  m[1] = (xy + wz) * sx;
  m[2] = (xz - wy) * sx;
  m[4] = (xy - wz) * sy;
  m[5] = (1 - (xx + zz)) * sy;
  m[6] = (yz + wx) * sy;
  m[8] = (xz + wy) * sz;
  m[9] = (yz - wx) * sz;
  m[10] = (1 - (xx + yy)) * sz;
  m[12] = tx;
  m[13] = ty;
  m[14] = tz;
  m[15] = 1;
  return m;
}

function checkFinite(m: ArrayLike<number>): void {
  for (let i = 0; i < m.length; i++) if (!Number.isFinite(m[i]!)) notModel();
}

/** A normal shorter than this share of its matrix's scale squared is noise from a matrix that flattens it, and takes its face's normal. */
const FLAT_NORMAL = 1e-12;

/**
 * The normal matrix of a matrix's upper 3 by 3, row-major into `out[0..8]`:
 * its inverse transpose, which is the cofactor matrix over the determinant,
 * or the cofactor matrix alone where the determinant is 0 (D-261127-511).
 * Normals are renormalized after, so only the determinant's sign is kept:
 * dividing by a determinant near 0 would blow float noise up into a
 * direction. `out[9]` is the length under which a turned unit normal
 * counts as flattened. Returns the determinant, whose sign says whether the
 * matrix mirrors.
 */
export function normalMatrix(m: ArrayLike<number>, out: Float64Array): number {
  const a00 = m[0]!;
  const a10 = m[1]!;
  const a20 = m[2]!;
  const a01 = m[4]!;
  const a11 = m[5]!;
  const a21 = m[6]!;
  const a02 = m[8]!;
  const a12 = m[9]!;
  const a22 = m[10]!;
  const c00 = a11 * a22 - a12 * a21;
  const c01 = a12 * a20 - a10 * a22;
  const c02 = a10 * a21 - a11 * a20;
  const c10 = a02 * a21 - a01 * a22;
  const c11 = a00 * a22 - a02 * a20;
  const c12 = a01 * a20 - a00 * a21;
  const c20 = a01 * a12 - a02 * a11;
  const c21 = a02 * a10 - a00 * a12;
  const c22 = a00 * a11 - a01 * a10;
  const det = a00 * c00 + a01 * c01 + a02 * c02;
  const k = det < 0 ? -1 : 1;
  out[0] = c00 * k;
  out[1] = c01 * k;
  out[2] = c02 * k;
  out[3] = c10 * k;
  out[4] = c11 * k;
  out[5] = c12 * k;
  out[6] = c20 * k;
  out[7] = c21 * k;
  out[8] = c22 * k;
  const scale = Math.max(Math.abs(a00), Math.abs(a10), Math.abs(a20), Math.abs(a01), Math.abs(a11), Math.abs(a21), Math.abs(a02), Math.abs(a12), Math.abs(a22));
  out[9] = FLAT_NORMAL * scale * scale;
  return det;
}

/** A checked accessor: where its elements sit in the file, and how to read them. */
type Accessor = { base: number; stride: number; count: number; component: number; components: number; normalized: boolean };

type Usage = { types: readonly string[]; float: boolean; normalized: readonly number[]; integer: readonly number[]; stride: boolean };

/** What each attribute may be (glTF 2.0, with KHR_mesh_quantization's packed positions, normals and coordinates, D-261127-515). */
const USAGE = {
  position: { types: ["VEC3"], float: true, normalized: [BYTE, UBYTE, SHORT, USHORT], integer: [BYTE, UBYTE, SHORT, USHORT], stride: true },
  normal: { types: ["VEC3"], float: true, normalized: [BYTE, SHORT], integer: [], stride: true },
  texcoord: { types: ["VEC2"], float: true, normalized: [BYTE, UBYTE, SHORT, USHORT], integer: [BYTE, UBYTE, SHORT, USHORT], stride: true },
  color: { types: ["VEC3", "VEC4"], float: true, normalized: [UBYTE, USHORT], integer: [], stride: true },
  joints: { types: ["VEC4"], float: false, normalized: [], integer: [UBYTE, USHORT], stride: true },
  weights: { types: ["VEC4"], float: true, normalized: [UBYTE, USHORT], integer: [], stride: true },
  indices: { types: ["SCALAR"], float: false, normalized: [], integer: [UBYTE, USHORT, UINT], stride: false },
  inverseBind: { types: ["MAT4"], float: true, normalized: [], integer: [], stride: true },
} as const satisfies Record<string, Usage>;

/** A function reading component `k` of element `i`, as a float, normalized where the accessor says. */
type Read = (i: number, k: number) => number;

function readerOf(dv: DataView, a: Accessor): Read {
  const { base, stride } = a;
  const size = COMPONENT_BYTES[a.component]!;
  const at = (i: number, k: number) => base + i * stride + k * size;
  switch (a.component) {
    case FLOAT:
      return (i, k) => dv.getFloat32(at(i, k), true);
    case UBYTE:
      return a.normalized ? (i, k) => dv.getUint8(at(i, k)) / 255 : (i, k) => dv.getUint8(at(i, k));
    case BYTE:
      return a.normalized ? (i, k) => Math.max(dv.getInt8(at(i, k)) / 127, -1) : (i, k) => dv.getInt8(at(i, k));
    case USHORT:
      return a.normalized ? (i, k) => dv.getUint16(at(i, k), true) / 65535 : (i, k) => dv.getUint16(at(i, k), true);
    case SHORT:
      return a.normalized ? (i, k) => Math.max(dv.getInt16(at(i, k), true) / 32767, -1) : (i, k) => dv.getInt16(at(i, k), true);
    default:
      return (i, k) => dv.getUint32(at(i, k), true);
  }
}

/** How a primitive draws: its group's key and what of its material the group keeps. */
type Look = { key: string; material: PartMaterial; texCoord: number; transform: [number, number, number, number, number, number] | null };

type Group = { part: Omit<ModelPart, "positions" | "normals" | "uvs" | "colors">; triangles: number; textured: boolean; colored: boolean; filled: number; transform: Look["transform"]; texCoord: number };

/** One primitive drawn by one node, in the walk's order: what the counting found, and the fill reads. */
type Ref = {
  slot: number;
  mode: number;
  triangles: number;
  group: Group;
  position: Accessor;
  normal: Accessor | null;
  uv: Accessor | null;
  color: Accessor | null;
  indices: Accessor | null;
  skin: Skin | null;
  joints: Accessor | null;
  weights: Accessor | null;
};

/** A drawn skin: each joint's world matrix times its inverse bind matrix, 16 floats a joint. */
type Skin = { matrices: Float32Array; joints: number };

export type GlbLimits = { cluster: ClusterLimits };

export function readGlb(file: Uint8Array, device: ModelDevice, limits: GlbLimits = { cluster: CLUSTER_LIMITS }): ModelMesh {
  const L = MODEL_LIMITS;
  const view = new DataView(file.buffer, file.byteOffset, file.byteLength);
  if (file.length < 20 || view.getUint32(0, true) !== GLB_MAGIC || view.getUint32(4, true) !== 2) notModel();
  const length = view.getUint32(8, true);
  if (length > file.length || length < 20) notModel();
  const jsonLength = view.getUint32(12, true);
  if (view.getUint32(16, true) !== JSON_CHUNK || 20 + jsonLength > length) notModel();
  const caps = jsonCaps(device);
  const jsonBytes = file.subarray(20, 20 + jsonLength);
  if (prescanJson(jsonBytes, caps) !== null) refuse(MODEL_WORDS.extraData);

  // The BIN chunk, when there is one, must come straight after the JSON.
  let bin: DataView | null = null;
  let binLength = 0;
  const binAt = 20 + jsonLength + ((4 - (jsonLength % 4)) % 4);
  if (binAt + 8 <= length && view.getUint32(binAt + 4, true) === BIN_CHUNK) {
    binLength = view.getUint32(binAt, true);
    if (binAt + 8 + binLength > length) notModel();
    bin = new DataView(file.buffer, file.byteOffset + binAt + 8, binLength);
  }

  let json: unknown;
  try {
    json = JSON.parse(new TextDecoder().decode(jsonBytes));
  } catch {
    notModel();
  }
  if (!isObject(json)) return notModel();

  for (const key of ["extensionsUsed", "extensionsRequired"]) {
    for (const name of listOf(json, key)) if (typeof name === "string" && Object.hasOwn(REFUSED_EXTENSIONS, name)) refuse(REFUSED_EXTENSIONS[name]!);
  }

  const nodes = listOf(json, "nodes");
  const meshes = listOf(json, "meshes");
  const accessors = listOf(json, "accessors");
  const views = listOf(json, "bufferViews");
  const buffers = listOf(json, "buffers");
  const materials = listOf(json, "materials");
  const textures = listOf(json, "textures");
  const images = listOf(json, "images");
  const samplers = listOf(json, "samplers");
  const skins = listOf(json, "skins");
  const scenes = listOf(json, "scenes");

  // The one buffer is the BIN chunk. Any other would name a file (D-261127-516).
  if (buffers.length > 1) refuse(MODEL_WORDS.outsideFiles);
  if (buffers.length === 1 && (!isObject(buffers[0]) || buffers[0].uri !== undefined)) refuse(MODEL_WORDS.outsideFiles);
  for (const v of views) refuseExtensionsIn(v);

  // The default scene's node tree, walked once (D-261127-471, 516).
  const scene = item(scenes, json.scene ?? 0);
  const roots = scene.nodes === undefined ? [] : Array.isArray(scene.nodes) ? scene.nodes : notModel();
  const visited = new Uint8Array(nodes.length);
  const slotOf = new Int32Array(nodes.length).fill(-1);
  const worlds: Float64Array[] = [];
  const walked: number[] = [];
  let visits = 0;
  const stack: { node: number; parent: number }[] = [];
  // Every node pushed is visited or refused, so the stack is held to the visits left: a list of two million children never builds.
  if (roots.length > L.glbNodeVisits) refuse(MODEL_WORDS.tooComplex);
  for (let r = roots.length - 1; r >= 0; r--) stack.push({ node: indexOf(roots[r], nodes.length), parent: -1 });
  while (stack.length > 0) {
    const { node: n, parent } = stack.pop()!;
    if (visited[n]) notModel();
    visited[n] = 1;
    if (++visits > L.glbNodeVisits) refuse(MODEL_WORDS.tooComplex);
    const node = item(nodes, n);
    refuseExtensionsIn(node);
    const local = localMatrix(node);
    const world = parent < 0 ? local : multiply(worlds[parent]!, local, new Float64Array(16));
    checkFinite(world);
    slotOf[n] = worlds.length;
    worlds.push(world);
    walked.push(n);
    const children = node.children === undefined ? [] : Array.isArray(node.children) ? node.children : notModel();
    if (visits + stack.length + children.length > L.glbNodeVisits) refuse(MODEL_WORDS.tooComplex);
    for (let c = children.length - 1; c >= 0; c--) stack.push({ node: indexOf(children[c], nodes.length), parent: slotOf[n]! });
  }

  // Primitive references and drawn triangles, counted before any accessor is read (D-261127-473).
  let refs = 0;
  let drawn = 0;
  const triangleCap = device === "touch" ? L.glbTouchTriangles : L.glbComputerTriangles;
  const meshOf = (n: number): Json | null => {
    const node = nodes[n] as Json;
    return node.mesh === undefined ? null : item(meshes, node.mesh);
  };
  for (const n of walked) {
    const mesh = meshOf(n);
    if (!mesh) continue;
    const primitives = Array.isArray(mesh.primitives) ? mesh.primitives : notModel();
    for (const p of primitives) {
      if (++refs > L.glbPrimitiveRefs) refuse(MODEL_WORDS.tooComplex);
      if (!isObject(p)) notModel();
      refuseExtensionsIn(p);
      drawn += trianglesOf(p);
    }
  }
  if (drawn > triangleCap) refuse(trianglesWords(drawn, device));

  function trianglesOf(p: Json): number {
    const mode = whole(p.mode, TRIANGLES);
    if (mode > 6) notModel();
    if (mode < TRIANGLES || !isObject(p.attributes) || p.attributes.POSITION === undefined) return 0;
    const vertices = whole(item(accessors, p.indices ?? p.attributes.POSITION).count);
    if (mode === TRIANGLES) return vertices % 3 === 0 ? vertices / 3 : notModel();
    return vertices >= 3 ? vertices - 2 : notModel();
  }

  /** An accessor checked for its use: in the BIN chunk, its elements inside its view, its view inside the chunk (D-261127-516). */
  const checked = new Map<string, Accessor>();
  function accessor(index: unknown, use: Usage, name: string): Accessor {
    const acc = item(accessors, index);
    const memo = `${String(index)}:${name}`;
    const known = checked.get(memo);
    if (known) return known;
    if (acc.sparse !== undefined) refuse(MODEL_WORDS.sparse);
    if (acc.bufferView === undefined) notModel();
    const v = item(views, acc.bufferView);
    if (whole(v.buffer) !== 0 || !bin) notModel();
    const component = whole(acc.componentType);
    const type = acc.type;
    if (typeof type !== "string" || !use.types.includes(type)) notModel();
    const normalized = acc.normalized === true;
    const allowed = component === FLOAT ? use.float && !normalized : normalized ? use.normalized.includes(component as never) : use.integer.includes(component as never);
    if (!allowed) notModel();
    const components = TYPE_COMPONENTS[type as string]!;
    const elementBytes = components * COMPONENT_BYTES[component]!;
    const count = whole(acc.count);
    if (count < 1) notModel();
    const offset = whole(acc.byteOffset, 0);
    const viewOffset = whole(v.byteOffset, 0);
    const viewLength = whole(v.byteLength);
    let stride = elementBytes;
    if (v.byteStride !== undefined) {
      if (!use.stride) notModel();
      stride = whole(v.byteStride);
      if (stride < elementBytes || stride > L.glbStrideMax) notModel();
    }
    if (offset + stride * (count - 1) + elementBytes > viewLength || viewOffset + viewLength > binLength) notModel();
    const out = { base: viewOffset + offset, stride, count, component, components, normalized };
    checked.set(memo, out);
    return out;
  }

  // Skins: distinct joints, counted before any matrix is kept (D-261127-521, 525, 526).
  const skinOf = new Map<number, Skin>();
  let parentOf: Int32Array | null = null;
  let twoParents: Uint8Array | null = null;
  const outside = new Map<number, Float64Array>();
  let drawnJoints = 0;
  function parents(): void {
    if (parentOf) return;
    parentOf = new Int32Array(nodes.length).fill(-1);
    twoParents = new Uint8Array(nodes.length);
    for (let n = 0; n < nodes.length; n++) {
      const node = nodes[n];
      if (!isObject(node) || node.children === undefined) continue;
      if (!Array.isArray(node.children)) notModel();
      for (const c of node.children as unknown[]) {
        const child = indexOf(c, nodes.length);
        if (parentOf[child] !== -1) twoParents[child] = 1;
        else parentOf[child] = n;
      }
    }
  }
  /** A joint's world matrix: from the walk, or composed down from its own root, those steps counted in the walk's visits. */
  function jointWorld(j: number): Float64Array {
    const slot = slotOf[j]!;
    if (slot >= 0) return worlds[slot]!;
    const known = outside.get(j);
    if (known) return known;
    parents();
    const chain: number[] = [];
    const seen = new Set<number>();
    for (let n = j; n !== -1; n = parentOf![n]!) {
      if (twoParents![n] || seen.has(n) || slotOf[n]! >= 0) refuse(MODEL_WORDS.brokenSkeleton);
      if (outside.has(n)) break;
      seen.add(n);
      chain.push(n);
      if (++visits > L.glbNodeVisits) refuse(MODEL_WORDS.tooComplex);
    }
    for (let c = chain.length - 1; c >= 0; c--) {
      const n = chain[c]!;
      const p = parentOf![n]!;
      const local = localMatrix(item(nodes, n));
      const world = p === -1 ? local : multiply(outside.get(p)!, local, new Float64Array(16));
      checkFinite(world);
      outside.set(n, world);
    }
    return outside.get(j)!;
  }
  function skin(index: unknown): Skin {
    const s = indexOf(index, skins.length);
    const known = skinOf.get(s);
    if (known) return known;
    const def = item(skins, s);
    const joints = Array.isArray(def.joints) ? def.joints : notModel();
    if (joints.length === 0) notModel();
    if (joints.length > L.skinJoints) refuse(MODEL_WORDS.skinJoints);
    if ((drawnJoints += joints.length) > L.drawnJoints) refuse(MODEL_WORDS.drawnJoints);
    const ids = joints.map((j) => indexOf(j, nodes.length));
    if (new Set(ids).size !== ids.length) refuse(MODEL_WORDS.duplicateJoints);
    const inverse = def.inverseBindMatrices === undefined ? null : accessor(def.inverseBindMatrices, USAGE.inverseBind, "inverseBind");
    if (inverse && inverse.count < ids.length) notModel();
    const read = inverse ? readerOf(bin!, inverse) : null;
    const matrices = new Float32Array(ids.length * 16);
    const ibm = new Float64Array(16);
    const out = new Float64Array(16);
    for (let k = 0; k < ids.length; k++) {
      if (read) for (let e = 0; e < 16; e++) ibm[e] = read(k, e);
      else ibm.set(identity());
      checkFinite(ibm);
      multiply(jointWorld(ids[k]!), ibm, out);
      checkFinite(out);
      matrices.set(out, k * 16);
    }
    const made = { matrices, joints: ids.length };
    skinOf.set(s, made);
    return made;
  }

  // Textures: only images a drawn group's base color names, in reading order, kept by their headers (D-261127-476, 514, 524).
  const notes = new Set<string>();
  const imageKept = new Map<number, number>();
  const kept: ModelTexture[] = [];
  let keptPixels = 0;
  function keptImage(textureIndex: unknown): number {
    const texture = item(textures, textureIndex);
    const ext = isObject(texture.extensions) ? texture.extensions : {};
    const sourceOf = (e: unknown) => (isObject(e) ? e.source : undefined);
    const source = sourceOf(ext.EXT_texture_webp) ?? sourceOf(ext.EXT_texture_avif) ?? texture.source;
    if (source === undefined) {
      if (sourceOf(ext.KHR_texture_basisu) !== undefined) notes.add(MODEL_WORDS.ktx2Note);
      return -1;
    }
    const i = indexOf(source, images.length);
    const known = imageKept.get(i);
    if (known !== undefined) return known;
    let at = -1;
    const image = item(images, i);
    if (image.uri !== undefined) notes.add(MODEL_WORDS.uriNote);
    else if (image.mimeType === "image/ktx2") notes.add(MODEL_WORDS.ktx2Note);
    else if (image.bufferView !== undefined) {
      const v = item(views, image.bufferView);
      const offset = whole(v.byteOffset, 0);
      const bytes = whole(v.byteLength);
      if (whole(v.buffer) !== 0 || !bin || offset + bytes > binLength) notModel();
      const data = new Uint8Array(bin!.buffer, bin!.byteOffset + offset, bytes);
      const header = imageHeader(data);
      const pixels = header ? header.width * header.height : Infinity;
      if (header && pixels <= L.texturePixels && kept.length < L.textures && keptPixels + pixels <= L.texturesPixels) {
        keptPixels += pixels;
        at = kept.length;
        kept.push({ bytes: data, mime: header.mime, width: header.width, height: header.height });
      }
    }
    imageKept.set(i, at);
    return at;
  }

  /** A primitive's look: its group key and material, the coordinate set its texture reads and that texture's transform (D-261127-512, 522, 523). */
  function lookOf(p: Json, attributes: Json): Look {
    if (p.material === undefined) return { key: "plain", material: { plain: true, color: [1, 1, 1, 1], texture: -1, wrapS: REPEAT, wrapT: REPEAT, alpha: "opaque", alphaCutoff: 0.5, doubleSided: false }, texCoord: 0, transform: null };
    const m = item(materials, p.material);
    const pbr = m.pbrMetallicRoughness === undefined ? {} : isObject(m.pbrMetallicRoughness) ? m.pbrMetallicRoughness : notModel();
    const color = numbers(pbr.baseColorFactor, 4, [1, 1, 1, 1]) as [number, number, number, number];
    const alphaMode = m.alphaMode ?? "OPAQUE";
    const alpha = alphaMode === "MASK" ? "mask" : alphaMode === "BLEND" ? "blend" : alphaMode === "OPAQUE" ? "opaque" : notModel();
    const alphaCutoff = alpha === "mask" ? finiteOr(m.alphaCutoff, 0.5) : 0.5;
    const doubleSided = m.doubleSided === true;
    let texture = -1;
    let wrapS = REPEAT;
    let wrapT = REPEAT;
    let texCoord = 0;
    let transform: Look["transform"] = null;
    const info = pbr.baseColorTexture;
    if (info !== undefined) {
      if (!isObject(info)) notModel();
      const t = info as Json;
      const ext = isObject(t.extensions) && isObject(t.extensions.KHR_texture_transform) ? t.extensions.KHR_texture_transform : null;
      texCoord = whole(ext?.texCoord ?? t.texCoord, 0);
      // A primitive without the coordinate set its texture names draws untextured, and its image takes no place among the kept.
      const image = attributes[`TEXCOORD_${texCoord}`] !== undefined ? keptImage(t.index) : -1;
      if (image >= 0) {
        texture = image;
        const def = item(textures, t.index);
        if (def.sampler !== undefined) {
          const s = item(samplers, def.sampler);
          wrapS = WRAPS.has(s.wrapS as number) ? (s.wrapS as number) : REPEAT;
          wrapT = WRAPS.has(s.wrapT as number) ? (s.wrapT as number) : REPEAT;
        }
        if (ext) {
          const [ox, oy] = numbers(ext.offset, 2, [0, 0]) as [number, number];
          const r = finiteOr(ext.rotation, 0);
          const [sx, sy] = numbers(ext.scale, 2, [1, 1]) as [number, number];
          // glTF's T × R × S, row by row: u' = a u + b v + c, v' = d u + e v + f.
          const cos = Math.cos(r);
          const sin = Math.sin(r);
          transform = [cos * sx, sin * sy, ox, -sin * sx, cos * sy, oy];
        }
      }
    }
    const material: PartMaterial = { plain: false, color, texture, wrapS, wrapT, alpha, alphaCutoff, doubleSided };
    const key = JSON.stringify([texture >= 0 ? [texture, wrapS, wrapT, texCoord, transform] : null, color, alpha, alphaCutoff, doubleSided]);
    return { key, material, texCoord, transform };
  }

  // Every reference checked and grouped, still before any output exists.
  const groups = new Map<string, Group>();
  const skinChecked = new Set<string>();
  const list: Ref[] = [];
  for (const n of walked) {
    const mesh = meshOf(n);
    if (!mesh) continue;
    const node = nodes[n] as Json;
    const skinned = node.skin !== undefined ? skin(node.skin) : null;
    for (const p of mesh.primitives as Json[]) {
      const triangles = trianglesOf(p);
      if (triangles === 0) continue;
      const attributes = p.attributes as Json;
      const position = accessor(attributes.POSITION, USAGE.position, "position");
      const vertices = position.count;
      const same = (a: Accessor) => (a.count === vertices ? a : notModel());
      const normal = attributes.NORMAL === undefined ? null : same(accessor(attributes.NORMAL, USAGE.normal, "normal"));
      const color = attributes.COLOR_0 === undefined ? null : same(accessor(attributes.COLOR_0, USAGE.color, "color"));
      const indices = p.indices === undefined ? null : accessor(p.indices, USAGE.indices, "indices");
      if (indices) {
        const read = readerOf(bin!, indices);
        for (let i = 0; i < indices.count; i++) if (read(i, 0) >= vertices) notModel();
      }
      const look = lookOf(p, attributes);
      const uv = look.material.texture >= 0 ? same(accessor(attributes[`TEXCOORD_${look.texCoord}`], USAGE.texcoord, "texcoord")) : null;
      let joints: Accessor | null = null;
      let weights: Accessor | null = null;
      if (skinned && attributes.JOINTS_0 !== undefined && attributes.WEIGHTS_0 !== undefined) {
        joints = same(accessor(attributes.JOINTS_0, USAGE.joints, "joints"));
        weights = same(accessor(attributes.WEIGHTS_0, USAGE.weights, "weights"));
        // Only the corners drawn, once per accessor set and skin: the work is bounded by the triangles counted, not by POSITION's count for each reference.
        const key = `${String(attributes.JOINTS_0)}:${String(attributes.WEIGHTS_0)}:${String(p.indices)}:${skinned.joints}`;
        if (!skinChecked.has(key)) {
          skinChecked.add(key);
          const readJ = readerOf(bin!, joints);
          const readW = readerOf(bin!, weights);
          const readC = indices ? readerOf(bin!, indices) : null;
          const corners = indices ? indices.count : vertices;
          for (let c = 0; c < corners; c++) {
            const i = readC ? readC(c, 0) : c;
            for (let k = 0; k < 4; k++) {
              const w = readW(i, k);
              if (!Number.isFinite(w) || w < 0 || readJ(i, k) >= skinned.joints) notModel();
            }
          }
        }
      }
      let group = groups.get(look.key);
      if (!group) {
        if (groups.size >= L.glbGroups) refuse(MODEL_WORDS.groups);
        group = { part: { index: null, material: look.material }, triangles: 0, textured: look.material.texture >= 0, colored: false, filled: 0, transform: look.transform, texCoord: look.texCoord };
        groups.set(look.key, group);
      }
      group.triangles += triangles;
      if (color) group.colored = true;
      list.push({ slot: slotOf[n]!, mode: whole(p.mode, TRIANGLES), triangles, group, position, normal, uv, color, indices, skin: joints ? skinned : null, joints, weights });
    }
  }
  if (list.length === 0) notModel();

  // The output, pre-sized from the counts (D-261127-474).
  const filled = new Map<Group, ModelPart>();
  for (const g of groups.values()) {
    filled.set(g, {
      ...g.part,
      positions: new Float32Array(g.triangles * 9),
      normals: new Float32Array(g.triangles * 9),
      uvs: g.textured ? new Float32Array(g.triangles * 6) : null,
      colors: g.colored ? new Uint8Array(g.triangles * 12).fill(255) : null,
    });
  }
  const unnormaled: NormalSpan[] = [];
  const nm = new Float64Array(10);
  const corner = new Int32Array(3);
  const face = [0, 0, 0];
  /** Each corner's matrix, its normal matrix and its determinant, made afresh per corner only for a skin. */
  type CornerMatrix = { m: Float64Array; normals: Float64Array; det: number };
  const blended: CornerMatrix[] = [0, 1, 2].map(() => ({ m: new Float64Array(16), normals: new Float64Array(10), det: 1 }));
  for (const ref of list) {
    const part = filled.get(ref.group)!;
    const from = ref.group.filled;
    const dv = bin!;
    const readP = readerOf(dv, ref.position);
    const readN = ref.normal ? readerOf(dv, ref.normal) : null;
    const readT = ref.uv ? readerOf(dv, ref.uv) : null;
    const readC = ref.color ? readerOf(dv, ref.color) : null;
    const readI = ref.indices ? readerOf(dv, ref.indices) : null;
    const readJ = ref.joints ? readerOf(dv, ref.joints) : null;
    const readW = ref.weights ? readerOf(dv, ref.weights) : null;
    const world = worlds[ref.slot]!;
    const det = normalMatrix(world, nm);
    const skinMatrices = ref.skin?.matrices ?? null;
    const t6 = ref.group.transform;
    const colorComponents = ref.color?.components ?? 3;
    const P = part.positions;
    const N = part.normals;
    const vertex = (i: number) => (readI ? readI(i, 0) : i);
    const fixed: CornerMatrix = { m: world, normals: nm, det };
    /** Corner `c`'s matrix: the node's world matrix, or its joints' blend at rest (D-261127-521). */
    const matrixOf = (v: number, c: number): CornerMatrix => {
      if (!skinMatrices || !readJ || !readW) return fixed;
      const out = blended[c]!;
      const blend = out.m;
      let sum = 0;
      for (let k = 0; k < 4; k++) sum += readW(v, k);
      blend.fill(0);
      if (sum === 0) {
        // No weight at all: the vertex stays at its bind position (D-261127-526). This differs from three's loader on purpose, which gives such a vertex all of joint 0's weight.
        blend[0] = blend[5] = blend[10] = blend[15] = 1;
      } else {
        for (let k = 0; k < 4; k++) {
          const w = readW(v, k) / sum;
          if (w === 0) continue;
          const at = readJ(v, k) * 16;
          for (let e = 0; e < 16; e++) blend[e]! += w * skinMatrices[at + e]!;
        }
      }
      out.det = normalMatrix(blend, out.normals);
      return out;
    };
    const mats: CornerMatrix[] = [fixed, fixed, fixed];
    let missingFrom = -1;
    for (let t = 0; t < ref.triangles; t++) {
      if (ref.mode === TRIANGLES) {
        corner[0] = vertex(3 * t);
        corner[1] = vertex(3 * t + 1);
        corner[2] = vertex(3 * t + 2);
      } else if (ref.mode === STRIP) {
        corner[0] = vertex(t);
        corner[1] = vertex(t % 2 === 0 ? t + 1 : t + 2);
        corner[2] = vertex(t % 2 === 0 ? t + 2 : t + 1);
      } else {
        corner[0] = vertex(t + 1);
        corner[1] = vertex(t + 2);
        corner[2] = vertex(0);
      }
      for (let c = 0; c < 3; c++) mats[c] = matrixOf(corner[c]!, c);
      // A mirroring matrix turns the triangle inside out, and the merged buffer no longer carries the reflection, so its winding is reversed (D-261127-511).
      const flip = mats[0]!.det + mats[1]!.det + mats[2]!.det < 0;
      const tri = from + t;
      let zeroNormal = false;
      for (let c = 0; c < 3; c++) {
        const k = flip && c > 0 ? 3 - c : c;
        const v = corner[k]!;
        const { m, normals } = mats[k]!;
        const x = readP(v, 0);
        const y = readP(v, 1);
        const z = readP(v, 2);
        const o = tri * 9 + c * 3;
        P[o] = m[0]! * x + m[4]! * y + m[8]! * z + m[12]!;
        P[o + 1] = m[1]! * x + m[5]! * y + m[9]! * z + m[13]!;
        P[o + 2] = m[2]! * x + m[6]! * y + m[10]! * z + m[14]!;
        if (!(Number.isFinite(P[o]!) && Number.isFinite(P[o + 1]!) && Number.isFinite(P[o + 2]!))) notModel();
        if (readN) {
          const a = readN(v, 0);
          const b = readN(v, 1);
          const d = readN(v, 2);
          const nx = normals[0]! * a + normals[1]! * b + normals[2]! * d;
          const ny = normals[3]! * a + normals[4]! * b + normals[5]! * d;
          const nz = normals[6]! * a + normals[7]! * b + normals[8]! * d;
          const len = Math.hypot(nx, ny, nz);
          if (!Number.isFinite(len)) notModel();
          if (len > normals[9]! * Math.hypot(a, b, d)) {
            N[o] = nx / len;
            N[o + 1] = ny / len;
            N[o + 2] = nz / len;
          } else zeroNormal = true;
        }
        if (readT && part.uvs) {
          const u = readT(v, 0);
          const w = readT(v, 1);
          const uo = tri * 6 + c * 2;
          part.uvs[uo] = t6 ? t6[0] * u + t6[1] * w + t6[2] : u;
          part.uvs[uo + 1] = t6 ? t6[3] * u + t6[4] * w + t6[5] : w;
          if (!(Number.isFinite(part.uvs[uo]!) && Number.isFinite(part.uvs[uo + 1]!))) notModel();
        }
        if (readC && part.colors) {
          const co = tri * 12 + c * 4;
          for (let e = 0; e < colorComponents; e++) {
            const value = readC(v, e);
            if (!Number.isFinite(value)) notModel();
            part.colors[co + e] = Math.round(Math.min(1, Math.max(0, value)) * 255);
          }
        }
      }
      if (readN && zeroNormal) {
        // A normal a matrix flattened to nothing, from a skin or a node, takes its face's (DMODEL-R7-02).
        faceNormal(P, tri * 9, face, true);
        for (let c = 0; c < 3; c++) {
          const o = tri * 9 + c * 3;
          if (N[o] === 0 && N[o + 1] === 0 && N[o + 2] === 0) {
            N[o] = face[0]!;
            N[o + 1] = face[1]!;
            N[o + 2] = face[2]!;
          }
        }
      }
      if (!readN && missingFrom < 0) missingFrom = tri;
    }
    if (!readN) unnormaled.push({ positions: P, normals: N, from: missingFrom, to: from + ref.triangles });
    ref.group.filled += ref.triangles;
  }
  weldNormals(unnormaled, limits.cluster);

  const parts = [...filled.values()];
  return { axes: "yUp", parts, textures: kept, colorable: parts.some((p) => p.material.plain), notes: [...notes], triangles: drawn };
}
