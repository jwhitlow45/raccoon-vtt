/**
 * Test models built from primitives and flat colors, never art
 * (docs/design/design-v1-token-models.md 10): triangle lists, written as
 * binary STL, ASCII STL, OBJ or GLB. The GLB builder writes whatever JSON a
 * test hands it, so a test can craft each bomb and each odd file by hand.
 */

/** Triangles as 9 floats each, wound counterclockwise seen from outside, Y up. */
export type Triangles = number[];

/** A box's 12 triangles, Y up. */
export function box(min: [number, number, number], max: [number, number, number]): Triangles {
  const [x0, y0, z0] = min;
  const [x1, y1, z1] = max;
  const quads: [number, number, number][][] = [
    [[x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]],
    [[x1, y0, z0], [x0, y0, z0], [x0, y1, z0], [x1, y1, z0]],
    [[x1, y0, z1], [x1, y0, z0], [x1, y1, z0], [x1, y1, z1]],
    [[x0, y0, z0], [x0, y0, z1], [x0, y1, z1], [x0, y1, z0]],
    [[x0, y1, z1], [x1, y1, z1], [x1, y1, z0], [x0, y1, z0]],
    [[x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1]],
  ];
  const out: Triangles = [];
  for (const [a, b, c, d] of quads) out.push(...a!, ...b!, ...c!, ...a!, ...c!, ...d!);
  return out;
}

/** A closed cylinder standing on y0, Y up. */
export function cylinder(center: [number, number], radius: number, y0: number, y1: number, segments: number): Triangles {
  const out: Triangles = [];
  const [cx, cz] = center;
  for (let s = 0; s < segments; s++) {
    const a = (2 * Math.PI * s) / segments;
    const b = (2 * Math.PI * (s + 1)) / segments;
    const ax = cx + radius * Math.cos(a);
    const az = cz - radius * Math.sin(a);
    const bx = cx + radius * Math.cos(b);
    const bz = cz - radius * Math.sin(b);
    out.push(ax, y0, az, bx, y0, bz, bx, y1, bz, ax, y0, az, bx, y1, bz, ax, y1, az);
    out.push(cx, y1, cz, ax, y1, az, bx, y1, bz);
    out.push(cx, y0, cz, bx, y0, bz, ax, y0, az);
  }
  return out;
}

/** A UV sphere of `2 × segments × (rings - 1)` triangles, Y up. */
export function sphere(center: [number, number, number], radius: number, segments: number, rings: number): Triangles {
  const [cx, cy, cz] = center;
  const at = (s: number, r: number): [number, number, number] => {
    const theta = (Math.PI * r) / rings;
    const phi = (2 * Math.PI * s) / segments;
    return [cx + radius * Math.sin(theta) * Math.cos(phi), cy + radius * Math.cos(theta), cz - radius * Math.sin(theta) * Math.sin(phi)];
  };
  const out: Triangles = [];
  for (let r = 0; r < rings; r++) {
    for (let s = 0; s < segments; s++) {
      const a = at(s, r);
      const b = at(s, r + 1);
      const c = at(s + 1, r + 1);
      const d = at(s + 1, r);
      if (r > 0) out.push(...a, ...b, ...d);
      if (r < rings - 1) out.push(...b, ...c, ...d);
    }
  }
  return out;
}

/** A mini on a round base: a base 1 wide, a body and a head, about 1.6 tall, its front toward +Z (a nose). */
export function figure(segments = 48): Triangles {
  return [
    ...cylinder([0, 0], 0.5, 0, 0.08, segments),
    ...box([-0.18, 0.08, -0.1], [0.18, 1.1, 0.1]),
    ...sphere([0, 1.32, 0], 0.22, segments, segments / 2),
    ...box([-0.04, 1.28, 0.2], [0.04, 1.36, 0.32]),
  ];
}

/** Y up to the Z up STL and OBJ files stand in: drawing (x, y, z) is file (x, -z, y). */
export function zUp(t: Triangles): Triangles {
  const out = t.slice();
  for (let i = 0; i < out.length; i += 3) {
    out[i + 1] = -t[i + 2]!;
    out[i + 2] = t[i + 1]!;
  }
  return out;
}

export function binaryStl(t: Triangles, header = "binary"): Uint8Array {
  const n = t.length / 9;
  const bytes = new Uint8Array(84 + 50 * n);
  bytes.set(new TextEncoder().encode(header.slice(0, 80)));
  const dv = new DataView(bytes.buffer);
  dv.setUint32(80, n, true);
  for (let i = 0; i < n; i++) for (let k = 0; k < 9; k++) dv.setFloat32(84 + 50 * i + 12 + 4 * k, t[i * 9 + k]!, true);
  return bytes;
}

export function asciiStl(t: Triangles): string {
  const lines = ["solid test"];
  for (let i = 0; i < t.length; i += 9) {
    lines.push("  facet normal 0 0 0", "    outer loop");
    for (let k = 0; k < 9; k += 3) lines.push(`      vertex ${t[i + k]} ${t[i + k + 1]} ${t[i + k + 2]}`);
    lines.push("    endloop", "  endfacet");
  }
  lines.push("endsolid test");
  return `${lines.join("\n")}\n`;
}

/** An OBJ with each distinct corner written once, faces naming them 1-based. */
export function obj(t: Triangles): string {
  const ids = new Map<string, number>();
  const v: string[] = [];
  const f: string[] = [];
  for (let i = 0; i < t.length; i += 9) {
    const face: number[] = [];
    for (let k = 0; k < 9; k += 3) {
      const key = `${t[i + k]} ${t[i + k + 1]} ${t[i + k + 2]}`;
      let id = ids.get(key);
      if (id === undefined) {
        id = ids.size + 1;
        ids.set(key, id);
        v.push(`v ${key}`);
      }
      face.push(id);
    }
    f.push(`f ${face.join(" ")}`);
  }
  return `# test\n${v.join("\n")}\n${f.join("\n")}\n`;
}

type Json = { [key: string]: unknown };

/**
 * A GLB written from parts: `view` adds bytes to the one BIN buffer and
 * returns its view, `accessor` an accessor on a view, and `build` writes
 * the file with whatever JSON the test made.
 */
export class Glb {
  json: Json = { asset: { version: "2.0" }, buffers: [{ byteLength: 0 }], bufferViews: [], accessors: [], meshes: [], nodes: [], scenes: [{ nodes: [] }], scene: 0 };
  #bin: Uint8Array[] = [];
  #length = 0;

  get views(): Json[] {
    return this.json.bufferViews as Json[];
  }
  get accessors(): Json[] {
    return this.json.accessors as Json[];
  }

  view(bytes: Uint8Array, extra: Json = {}): number {
    const pad = (4 - (this.#length % 4)) % 4;
    if (pad) {
      this.#bin.push(new Uint8Array(pad));
      this.#length += pad;
    }
    this.views.push({ buffer: 0, byteOffset: this.#length, byteLength: bytes.length, ...extra });
    this.#bin.push(bytes);
    this.#length += bytes.length;
    return this.views.length - 1;
  }

  accessor(def: Json): number {
    this.accessors.push(def);
    return this.accessors.length - 1;
  }

  /** Floats as an accessor of `type`, on a view of their own. */
  floats(values: ArrayLike<number>, type: string, extra: Json = {}): number {
    const components = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT4: 16 }[type]!;
    const bytes = new Uint8Array(new Float32Array(Array.from(values)).buffer);
    return this.accessor({ bufferView: this.view(bytes), componentType: 5126, type, count: values.length / components, ...extra });
  }

  /** Indices as an accessor, unsigned 32-bit unless they fit 16. */
  indices(values: ArrayLike<number>): number {
    let max = 0;
    for (let i = 0; i < values.length; i++) max = Math.max(max, values[i]!);
    const array = max < 65536 ? new Uint16Array(Array.from(values)) : new Uint32Array(Array.from(values));
    return this.accessor({ bufferView: this.view(new Uint8Array(array.buffer)), componentType: max < 65536 ? 5123 : 5125, type: "SCALAR", count: values.length });
  }

  /** A mesh of one primitive over non-indexed triangles, its POSITION (and NORMAL, when given) made here. Returns the mesh index. */
  meshOf(t: Triangles, primitive: Json = {}, normals?: ArrayLike<number>): number {
    const attributes: Json = { POSITION: this.floats(t, "VEC3"), ...((primitive.attributes as Json) ?? {}) };
    if (normals) attributes.NORMAL = this.floats(normals, "VEC3");
    (this.json.meshes as Json[]).push({ primitives: [{ ...primitive, attributes }] });
    return (this.json.meshes as Json[]).length - 1;
  }

  /** A node, a root of the default scene unless `root` is false. Returns its index. */
  node(def: Json, root = true): number {
    const nodes = this.json.nodes as Json[];
    nodes.push(def);
    if (root) ((this.json.scenes as Json[])[0]!.nodes as number[]).push(nodes.length - 1);
    return nodes.length - 1;
  }

  build(json: Json = this.json): Uint8Array {
    const total = this.#length + ((4 - (this.#length % 4)) % 4);
    if (Array.isArray(json.buffers) && isJson(json.buffers[0]) && json.buffers[0].byteLength === 0) json.buffers[0].byteLength = total;
    const bin = new Uint8Array(total);
    let at = 0;
    for (const part of this.#bin) {
      bin.set(part, at);
      at += part.length;
    }
    return glbFile(new TextEncoder().encode(JSON.stringify(json)), bin);
  }
}

const isJson = (v: unknown): v is Json => typeof v === "object" && v !== null;

/** A GLB file from a JSON chunk's bytes and a BIN chunk's, padded as the format asks. */
export function glbFile(json: Uint8Array, bin: Uint8Array | null): Uint8Array {
  const jsonPad = (4 - (json.length % 4)) % 4;
  const binPad = bin ? (4 - (bin.length % 4)) % 4 : 0;
  const length = 12 + 8 + json.length + jsonPad + (bin ? 8 + bin.length + binPad : 0);
  const out = new Uint8Array(length);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, 0x46546c67, true);
  dv.setUint32(4, 2, true);
  dv.setUint32(8, length, true);
  dv.setUint32(12, json.length + jsonPad, true);
  dv.setUint32(16, 0x4e4f534a, true);
  out.set(json, 20);
  out.fill(0x20, 20 + json.length, 20 + json.length + jsonPad);
  if (bin) {
    const at = 20 + json.length + jsonPad;
    dv.setUint32(at, bin.length + binPad, true);
    dv.setUint32(at + 4, 0x004e4942, true);
    out.set(bin, at + 8);
  }
  return out;
}

const TYPED = ["Float32Array", "Float64Array", "Uint8Array", "Int32Array", "Uint32Array", "Uint16Array"] as const;

/** Swaps the typed array constructors for ones that count what is allocated, and gives back the way to put them back. */
function counting(): { stop: () => { largest: number; total: number } } {
  const saved = TYPED.map((name) => globalThis[name]);
  let largest = 0;
  let total = 0;
  TYPED.forEach((name, i) => {
    const Base = saved[i] as unknown as new (...args: unknown[]) => ArrayBufferView;
    const Counted = class extends Base {
      constructor(...args: unknown[]) {
        super(...args);
        if (!(args[0] instanceof ArrayBuffer) && !(typeof SharedArrayBuffer !== "undefined" && args[0] instanceof SharedArrayBuffer)) {
          largest = Math.max(largest, this.byteLength);
          total += this.byteLength;
        }
      }
    };
    (globalThis as Record<string, unknown>)[name] = Counted;
  });
  return {
    stop: () => {
      TYPED.forEach((name, i) => ((globalThis as Record<string, unknown>)[name] = saved[i]));
      return { largest, total };
    },
  };
}

/**
 * Every typed array `run` allocates, while it runs: the largest and the
 * total bytes. A view on an existing buffer is not an allocation and is not
 * counted. The readers look their constructors up when they run, so
 * swapping the globals sees every array they make.
 */
export async function allocations<T>(run: () => T | Promise<T>): Promise<{ result: T | Error; largest: number; total: number }> {
  const count = counting();
  let result: T | Error;
  try {
    result = await run();
  } catch (err) {
    result = err as Error;
  }
  return { result, ...count.stop() };
}

/** `allocations` for work that does not wait. */
export function allocationsNow<T>(run: () => T): { result: T | Error; largest: number; total: number } {
  const count = counting();
  let result: T | Error;
  try {
    result = run();
  } catch (err) {
    result = err as Error;
  }
  return { result, ...count.stop() };
}
