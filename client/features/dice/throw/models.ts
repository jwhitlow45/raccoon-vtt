import { BoxGeometry, BufferAttribute, BufferGeometry, CylinderGeometry, DodecahedronGeometry, Float32BufferAttribute, IcosahedronGeometry, OctahedronGeometry, Quaternion, TetrahedronGeometry, Vector3 } from "three";
import type { DieKind } from "./layout.ts";

/**
 * The dice as solids (docs/design-v1-roll-animation.md 3.2): each kind's
 * triangles grouped into faces by their normals, each face numbered, with
 * its center, its normal and the way its number reads upward, and the
 * orientation that lands a given number facing the viewer, upright. Only
 * the lazy stage imports this module, since it needs three.
 *
 * Opposite faces add to n + 1 on the d6 to the d20, as on real dice. A d4
 * numbers its corners instead: each corner's number is printed at that
 * corner of its three faces, and the corner at the top is the result.
 */

/** One number printed on a face: where, which way is up, and how big, in the face's own units. */
export type FaceLabel = { value: number; at: Vector3; up: Vector3; size: number };

export type Face = {
  normal: Vector3;
  center: Vector3;
  up: Vector3;
  right: Vector3;
  /** From the center to the farthest corner. Labels and the texture cell are measured in it. */
  size: number;
  corners: Vector3[];
  /** The first vertex of each of the face's triangles in the geometry. */
  triangles: number[];
  /** The face's number, or -1 where it has none of its own (a d4, the coin's rim). */
  value: number;
  labels: FaceLabel[];
};

export type DieModel = {
  kind: DieKind;
  /** Non-indexed, with a `uv` into the kind's texture: one cell per labeled face. */
  geometry: BufferGeometry;
  faces: Face[];
  /** The faces with a texture cell of their own, in cell order. */
  labeled: Face[];
  /** What each value reads. */
  labels: string[];
  /** A d4's corners, by value. */
  corners: Vector3[];
  /** The texture's grid of cells, `cell` px square. */
  atlas: { cols: number; rows: number; cell: number };
};

const Z = new Vector3(0, 0, 1);
const SAME = 0.999;
const NEAR = 1e-4;

/** What each value of a kind reads. A d10 reads "10", not "0", to match its chip. */
export function labelsOf(kind: DieKind): string[] {
  if (kind === "tens") return Array.from({ length: 10 }, (_, i) => String(i * 10).padStart(2, "0"));
  if (kind === "units") return Array.from({ length: 10 }, (_, i) => String(i));
  if (kind === "coin") return [""];
  const sides = Number(kind.slice(1));
  return Array.from({ length: sides }, (_, i) => String(i + 1));
}

/**
 * A pentagonal trapezohedron: two apexes and a zigzag ring of ten points.
 * The ring's height `a` puts each kite's four corners in one plane, so it
 * shades as one flat face and its number lies flat on it.
 */
function d10Geometry(): BufferGeometry {
  const h = 1;
  const a = (h * (1 - Math.cos(Math.PI / 5))) / (1 + Math.cos(Math.PI / 5));
  const ring = Array.from({ length: 10 }, (_, k) => new Vector3(Math.cos((k * Math.PI) / 5), Math.sin((k * Math.PI) / 5), k % 2 ? a : -a));
  const v = (k: number) => ring[((k % 10) + 10) % 10]!;
  const top = new Vector3(0, 0, h);
  const bottom = new Vector3(0, 0, -h);
  const triangles: [Vector3, Vector3, Vector3][] = [];
  for (let j = 0; j < 5; j++) {
    triangles.push([top, v(2 * j - 1), v(2 * j)], [top, v(2 * j), v(2 * j + 1)]);
    triangles.push([bottom, v(2 * j), v(2 * j + 1)], [bottom, v(2 * j + 1), v(2 * j + 2)]);
  }
  const positions: number[] = [];
  for (const [p, q0, r0] of triangles) {
    let q = q0;
    let r = r0;
    // Wound outward, so the front face is the one the camera sees.
    const n = q.clone().sub(p).cross(r.clone().sub(p));
    if (n.dot(p.clone().add(q).add(r)) < 0) [q, r] = [r, q];
    positions.push(p.x, p.y, p.z, q.x, q.y, q.z, r.x, r.y, r.z);
  }
  const g = new BufferGeometry();
  g.setAttribute("position", new Float32BufferAttribute(positions, 3));
  return g;
}

function baseGeometry(kind: DieKind): BufferGeometry {
  switch (kind) {
    case "d4":
      return new TetrahedronGeometry(1);
    case "d6":
      return new BoxGeometry(1.3, 1.3, 1.3);
    case "d8":
      return new OctahedronGeometry(1.05);
    case "d10":
    case "tens":
    case "units":
      return d10Geometry();
    case "d12":
      return new DodecahedronGeometry(1.05);
    case "d20":
      return new IcosahedronGeometry(1.08);
    case "coin":
      return new CylinderGeometry(1, 1, 0.32, 40).rotateX(Math.PI / 2);
  }
}

/** A label's size, as a share of its face's size, picked by eye for each kind in the prototype. */
const LABEL_SIZE: Record<DieKind, number> = { d4: 0.5, d6: 0.95, d8: 0.85, d10: 0.7, d12: 0.8, d20: 0.8, tens: 0.7, units: 0.7, coin: 0 };

/** Builds a kind's solid, its numbering and its texture coordinates. Pure geometry: the stage draws the texture. */
export function buildModel(kind: DieKind): DieModel {
  let geometry = baseGeometry(kind);
  if (geometry.index) geometry = geometry.toNonIndexed();
  const position = geometry.getAttribute("position");
  const faces: Face[] = [];
  for (let i = 0; i < position.count; i += 3) {
    const a = new Vector3().fromBufferAttribute(position, i);
    const b = new Vector3().fromBufferAttribute(position, i + 1);
    const c = new Vector3().fromBufferAttribute(position, i + 2);
    const normal = new Vector3().subVectors(b, a).cross(new Vector3().subVectors(c, a)).normalize();
    let face = faces.find((f) => f.normal.dot(normal) > SAME);
    if (!face) {
      face = { normal, center: new Vector3(), up: new Vector3(), right: new Vector3(), size: 0, corners: [], triangles: [], value: -1, labels: [] };
      faces.push(face);
    }
    face.triangles.push(i);
    for (const p of [a, b, c]) if (!face.corners.some((q) => q.distanceTo(p) < NEAR)) face.corners.push(p);
  }
  const coin = kind === "coin";
  const tenSided = kind === "d10" || kind === "tens" || kind === "units";
  const labeled = coin ? faces.filter((f) => Math.abs(f.normal.z) > 0.99) : faces;
  for (const f of labeled) {
    f.center = f.corners.reduce((s, p) => s.add(p), new Vector3()).multiplyScalar(1 / f.corners.length);
    if (tenSided) {
      // A kite's number reads toward its own apex.
      const apex = new Vector3(0, 0, f.normal.z > 0 ? 1 : -1);
      f.up = apex.sub(f.center).projectOnPlane(f.normal).normalize();
    } else if (kind === "d6" || coin) {
      const toward = Math.abs(f.normal.z) > 0.9 ? new Vector3(0, 1, 0) : new Vector3(0, 0, 1);
      f.up = toward.projectOnPlane(f.normal).normalize();
    } else f.up = f.corners[0]!.clone().sub(f.center).projectOnPlane(f.normal).normalize();
    f.right = new Vector3().crossVectors(f.up, f.normal).normalize();
    f.size = Math.max(...f.corners.map((p) => p.distanceTo(f.center)));
  }

  const labels = labelsOf(kind);
  const corners: Vector3[] = [];
  if (kind === "d4") {
    for (const f of faces) for (const p of f.corners) if (!corners.some((q) => q.distanceTo(p) < NEAR)) corners.push(p.clone());
    for (const f of faces) {
      f.labels = f.corners.map((p) => {
        const toward = p.clone().sub(f.center);
        return { value: corners.findIndex((q) => q.distanceTo(p) < NEAR), at: f.center.clone().addScaledVector(toward, 0.5), up: toward.normalize(), size: LABEL_SIZE.d4 };
      });
    }
  } else if (!coin) {
    let next = 0;
    for (const f of faces) {
      if (f.value >= 0) continue;
      const opposite = faces.find((q) => q !== f && q.value < 0 && q.normal.dot(f.normal) < -SAME);
      f.value = next;
      if (opposite) opposite.value = faces.length - 1 - next;
      next++;
    }
    for (const f of faces) f.labels = [{ value: f.value, at: f.center.clone(), up: f.up.clone(), size: LABEL_SIZE[kind] }];
  }

  // One texture cell a labeled face, and every other triangle sampling the body color at the texture's corner.
  const cell = 160;
  const cols = Math.ceil(Math.sqrt(labeled.length));
  const rows = Math.ceil(labeled.length / cols);
  const uv = new Float32Array(position.count * 2).fill(0.001);
  labeled.forEach((f, k) => {
    const { cx, cy, half } = cellOf(k, cols, cell);
    for (const t of f.triangles) {
      for (let j = 0; j < 3; j++) {
        const p = new Vector3().fromBufferAttribute(position, t + j);
        const [x, y] = faceLocal(f, p);
        uv[(t + j) * 2] = (cx + x * half) / (cols * cell);
        uv[(t + j) * 2 + 1] = 1 - (cy - y * half) / (rows * cell);
      }
    }
  });
  geometry.setAttribute("uv", new BufferAttribute(uv, 2));
  geometry.computeVertexNormals();
  return { kind, geometry, faces, labeled, labels, corners, atlas: { cols, rows, cell } };
}

/** A labeled face's texture cell: its middle and the half width its face's size maps to. */
export function cellOf(k: number, cols: number, cell: number): { cx: number; cy: number; half: number } {
  return { cx: ((k % cols) + 0.5) * cell, cy: (Math.floor(k / cols) + 0.5) * cell, half: cell * 0.48 };
}

/** A point on a face in the face's own frame: right and up, in face sizes. */
export function faceLocal(f: Face, p: Vector3): [number, number] {
  const d = p.clone().sub(f.center);
  return [d.dot(f.right) / f.size, d.dot(f.up) / f.size];
}

/**
 * The face that shows `value` to the viewer, and the way its number reads
 * up: the face of that number, or for a d4 a face at that corner, read
 * with the corner at the top. The coin shows its top.
 */
export function shownFace(model: DieModel, value: number): { face: Face; up: Vector3; label: FaceLabel | null } {
  if (model.kind === "d4") {
    const corner = model.corners[value]!;
    const face = model.faces.find((f) => f.corners.some((p) => p.distanceTo(corner) < NEAR))!;
    const label = face.labels.find((l) => l.value === value)!;
    return { face, up: corner.clone().sub(face.center).projectOnPlane(face.normal).normalize(), label };
  }
  if (model.kind === "coin") {
    const face = model.labeled.find((f) => f.normal.z > 0)!;
    return { face, up: face.up, label: null };
  }
  const face = model.faces.find((f) => f.value === value)!;
  return { face, up: face.up, label: face.labels[0]! };
}

/**
 * The landed orientation, solved rather than simulated (3.2): turn the
 * value's face toward the viewer, then about the line of sight until its
 * number stands upright, then by `tilt` radians, so a row of dice never
 * looks ruled. The design keeps the tilt within 9 degrees.
 */
export function landing(model: DieModel, value: number, tilt: number): Quaternion {
  const { face, up } = shownFace(model, value);
  const toViewer = new Quaternion().setFromUnitVectors(face.normal, Z);
  const u = up.clone().applyQuaternion(toViewer);
  const upright = new Quaternion().setFromAxisAngle(Z, -Math.atan2(-u.x, u.y) + tilt);
  return upright.multiply(toViewer);
}

/** The most a landed die leans off upright, in radians: 9 degrees. */
export const MAX_TILT = (9 * Math.PI) / 180;
