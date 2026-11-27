import { clusterMesh, CLUSTER_LIMITS, type Bounds, type ClusterLimits, type TriangleSink, type TriangleSource } from "./cluster.ts";
import { eachLine, eachSlice, finite, ModelRefusal, MODEL_WORDS, numberAt, PLAIN, skipSpace, wordAt, type ModelMesh } from "./mesh.ts";

/**
 * STL, binary and ASCII (docs/design/design-v1-token-models.md 5). The file
 * streams from disk in slices, once for its box and once a clustering pass,
 * so a 512 MB file never sits in memory whole. The facet normals are
 * ignored: clustering moves the corners, so the normals are made afresh.
 */

/** A binary STL's triangle: a normal, three corners and a two-byte attribute. */
const RECORD = 50;
const HEADER = 84;

/** A binary STL's triangles, in slices of whole records. */
function binarySource(file: Blob, triangles: number): TriangleSource {
  return (sink) =>
    eachSlice(
      file,
      HEADER,
      HEADER + triangles * RECORD,
      (bytes) => {
        const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
        for (let o = 0; o + RECORD <= bytes.length; o += RECORD) {
          sink(
            dv.getFloat32(o + 12, true),
            dv.getFloat32(o + 16, true),
            dv.getFloat32(o + 20, true),
            dv.getFloat32(o + 24, true),
            dv.getFloat32(o + 28, true),
            dv.getFloat32(o + 32, true),
            dv.getFloat32(o + 36, true),
            dv.getFloat32(o + 40, true),
            dv.getFloat32(o + 44, true),
          );
        }
      },
      RECORD,
    );
}

/**
 * An ASCII STL's triangles: each `outer loop`'s vertices, fanned from the
 * first so a loop of more than three still draws (STL means three, but a
 * fan costs nothing to allow). A loop of fewer is skipped.
 */
function asciiSource(file: Blob): TriangleSource {
  return async (sink) => {
    const next = new Int32Array(1);
    const loop = new Float64Array(6);
    let corners = 0;
    await eachLine(file, (bytes, start, end) => {
      let i = skipSpace(bytes, start, end);
      if (wordAt(bytes, i, end, "outer") || wordAt(bytes, i, end, "endloop")) {
        corners = 0;
        return;
      }
      if (!wordAt(bytes, i, end, "vertex")) return;
      i = skipSpace(bytes, i + 6, end);
      const x = finite(numberAt(bytes, i, end, next));
      i = skipSpace(bytes, next[0]!, end);
      const y = finite(numberAt(bytes, i, end, next));
      i = skipSpace(bytes, next[0]!, end);
      const z = finite(numberAt(bytes, i, end, next));
      // loop[0..2] holds the loop's first corner and loop[3..5] the one before this.
      if (corners >= 2) sink(loop[0]!, loop[1]!, loop[2]!, loop[3]!, loop[4]!, loop[5]!, x, y, z);
      if (corners === 0) {
        loop[0] = x;
        loop[1] = y;
        loop[2] = z;
      }
      loop[3] = x;
      loop[4] = y;
      loop[5] = z;
      corners++;
    });
  };
}

/** The box and triangle count of a source's triangles, every corner checked finite. */
export async function boundsOf(source: TriangleSource): Promise<{ bounds: Bounds; triangles: number }> {
  const min: [number, number, number] = [Infinity, Infinity, Infinity];
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  let triangles = 0;
  const corner = (x: number, y: number, z: number) => {
    if (!(Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(z))) throw new ModelRefusal(MODEL_WORDS.notModel);
    if (x < min[0]) min[0] = x;
    if (x > max[0]) max[0] = x;
    if (y < min[1]) min[1] = y;
    if (y > max[1]) max[1] = y;
    if (z < min[2]) min[2] = z;
    if (z > max[2]) max[2] = z;
  };
  const sink: TriangleSink = (ax, ay, az, bx, by, bz, cx, cy, cz) => {
    corner(ax, ay, az);
    corner(bx, by, bz);
    corner(cx, cy, cz);
    triangles++;
  };
  await source(sink);
  if (triangles === 0) throw new ModelRefusal(MODEL_WORDS.notModel);
  return { bounds: { min, max }, triangles };
}

/** Reads an STL the sniffer named, clustered to at most 250,000 triangles. */
export async function readStl(file: Blob, binary: boolean, limits: ClusterLimits = CLUSTER_LIMITS): Promise<ModelMesh> {
  let source: TriangleSource;
  if (binary) {
    const head = new DataView(await file.slice(80, HEADER).arrayBuffer());
    const count = head.byteLength === 4 ? head.getUint32(0, true) : 0;
    if (HEADER + count * RECORD !== file.size) throw new ModelRefusal(MODEL_WORDS.notModel);
    source = binarySource(file, count);
  } else source = asciiSource(file);
  const { bounds, triangles } = await boundsOf(source);
  const mesh = await clusterMesh(source, bounds, triangles, limits);
  return {
    axes: "zUp",
    parts: [{ positions: mesh.positions, normals: mesh.normals, index: mesh.index, uvs: null, colors: null, material: PLAIN }],
    textures: [],
    colorable: true,
    notes: [],
    triangles: mesh.index.length / 3,
  };
}
