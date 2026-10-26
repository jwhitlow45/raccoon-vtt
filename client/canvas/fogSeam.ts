/** A canvas transform's numbers, as CanvasRenderingContext2D.getTransform gives them: x' = a x + c y + e, y' = b x + d y + f. */
export type Affine = { a: number; b: number; c: number; d: number; e: number; f: number };

export type Box = { x: number; y: number; w: number; h: number };

/** Where the fog's two covers go, in the shape's own units (cells). */
export type FogSeam = {
  /** The hole in the frame that fogs everything past the scene. */
  hole: Box;
  /** Where the fog image is drawn. */
  image: Box;
};

/** How far off a whole canvas pixel a corner may be taken as on it: float error, far less than a level of any pixel. */
const ON_PIXEL = 1e-4;
/** How far off zero a transform's term may be taken as zero, relative to its scale. */
const FLAT = 1e-9;

/**
 * Where the fog frame's hole and the fog image go under a canvas transform,
 * for a scene `w` by `h` cells (FogShape.tsx).
 *
 * Each cover anti-aliases its own edge. Where the scene's edge falls inside
 * a canvas pixel, the frame covers part of that pixel and the image about
 * the rest, and two partial covers composite to less than a full one, so
 * the map under them showed as a hairline at some zooms.
 *
 * Where the scene's edges run along the pixel grid, as in Top-down, both
 * covers meet on the nearest whole pixel inside the scene, so neither has
 * a partial pixel and the image is drawn less than a pixel narrower each
 * side. That leaves no overlap, so the DM's translucent fog stays one even
 * tint too. Elsewhere, as on Isometric's turned ground, the edges cross the
 * pixel grid at a slant: the frame's hole shrinks by one canvas pixel
 * across each edge, so the frame wholly covers every pixel the image only
 * partly covers. A translucent fog would tint that overlap twice, so there
 * it must go down as one image. A transform with no area, as a hidden
 * stage's can be, keeps the scene's own rectangle, since it draws nothing.
 */
export function fogSeam(t: Affine, w: number, h: number): FogSeam {
  const scene = { x: 0, y: 0, w, h };
  const det = t.a * t.d - t.b * t.c;
  if (!Number.isFinite(det) || det === 0) return { hole: scene, image: scene };
  const snapped = pixelBox(t, w, h);
  if (snapped) return { hole: snapped, image: snapped };
  // Across an edge where x is constant, one canvas pixel is this many cells: the length of x's gradient over the canvas.
  const dx = Math.hypot(t.c, t.d) / Math.abs(det);
  const dy = Math.hypot(t.a, t.b) / Math.abs(det);
  return { hole: { x: dx, y: dy, w: Math.max(0, w - 2 * dx), h: Math.max(0, h - 2 * dy) }, image: scene };
}

/**
 * The rectangle of a scene `w` by `h` cells shrunk to the whole canvas
 * pixels it covers, in cells, where its edges run along the pixel grid
 * under `t`: a cover drawn to it has no partly covered pixel at its edge.
 * Empty where it covers no whole pixel. Null where the edges cross the grid
 * at a slant, or `t` has no area.
 */
export function pixelBox(t: Affine, w: number, h: number): Box | null {
  const det = t.a * t.d - t.b * t.c;
  if (!Number.isFinite(det) || det === 0) return null;
  const scale = Math.max(Math.abs(t.a), Math.abs(t.b), Math.abs(t.c), Math.abs(t.d));
  const flat = (v: number) => Math.abs(v) <= FLAT * scale;
  if (!((flat(t.b) && flat(t.c)) || (flat(t.a) && flat(t.d)))) return null;
  const xs = [t.e, t.a * w + t.c * h + t.e];
  const ys = [t.f, t.b * w + t.d * h + t.f];
  const left = Math.ceil(Math.min(...xs) - ON_PIXEL);
  const top = Math.ceil(Math.min(...ys) - ON_PIXEL);
  const right = Math.max(left, Math.floor(Math.max(...xs) + ON_PIXEL));
  const bottom = Math.max(top, Math.floor(Math.max(...ys) + ON_PIXEL));
  // Back to cells through the inverse, which for a transform along the grid maps corners to corners.
  const back = (X: number, Y: number) => ({ x: (t.d * (X - t.e) - t.c * (Y - t.f)) / det, y: (t.a * (Y - t.f) - t.b * (X - t.e)) / det });
  const p = back(left, top);
  const q = back(right, bottom);
  return { x: Math.min(p.x, q.x), y: Math.min(p.y, q.y), w: Math.abs(q.x - p.x), h: Math.abs(q.y - p.y) };
}
