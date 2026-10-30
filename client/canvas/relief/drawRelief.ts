import type { TexturedTerrain } from "../../features/builder/geometry.ts";
import { TERRAIN_COLORS, TERRAIN_SWATCHES, TEXTURE_CELLS } from "../../features/builder/textures.ts";
import { viewToScreen, type Camera } from "../../lib/camera.ts";
import { theme } from "../../lib/theme.ts";
import { isometric, K, toView, turnAxes, type Turn, type ViewPoint } from "../../lib/view.ts";
import type { BandPart } from "../../features/areas/volume.ts";
import { meets, type DrawPiece, type VolumePiece } from "./buckets.ts";
import { patternOf } from "./looks.ts";
import { boundsOf, facesOf, type CellPiece, type Face, type PitRegion, type SideLook, type StaticPiece, type VBox, type WallItem } from "./pieces.ts";

/**
 * Drawing a run of relief pieces (docs/design-v1-isometric-view.md 5.5):
 * one Konva shape that does not listen draws every piece between two
 * standees, in depth order. A column draws its sides, then its top: the
 * ground stage's pixels under the cell, copied up by the lift into the
 * lifted polygon (a square's diamond, a hex's six corners) as a fill with
 * a pattern of the ground, one pattern for each ground drawn. Neighboring
 * tops at one lift share a fill. A pit draws its floor, the ground's pixels copied down and
 * clipped to its own floor polygon, then its far sides, all inside the
 * openings of its connected region, so a floor seen through a neighbor's
 * opening shows its own pixels and its own shade
 * (docs/design-v1-iso-hex-relief.md 5.2). Consecutive
 * bands of one area standing as its real shape draw as one
 * (docs/design-v1-iso-area-shapes.md 4.3 and 5).
 */

export type DrawContext = {
  turn: Turn;
  camera: Camera;
  /** Device pixels per CSS pixel, the same on both stages. */
  pixelRatio: number;
  /** The ground stage's canvas, the same size as the board's and taller by the lift margin, or null before it exists. */
  ground: HTMLCanvasElement | null;
  textures: Partial<Record<TexturedTerrain, HTMLImageElement>>;
  /** The canvas's view box, so a piece off screen costs a box test. */
  view: VBox;
  /** The cells of a pit region whose openings meet a view box (buckets.ts openingsMeeting). Absent, every cell of the region. */
  openings?: (region: PitRegion, box: VBox, asker: object) => readonly CellPiece[];
  /** The ground's pixels as one pattern for every top a relief draw copies, made again once the ground has drawn since. Absent, each copy makes its own. */
  groundCopy?: GroundCopy;
};

/** A pattern of the ground stage's pixels, and which of its draws it holds (`version` counts them, IsoBoard.tsx). */
export type GroundCopy = { version: number; made: number; canvas: HTMLCanvasElement | null; pattern: CanvasPattern | null };

type Pt = { x: number; y: number };

/** Sets the context to draw in view units, the camera on top of the device pixels. */
function viewSpace(g: CanvasRenderingContext2D, dc: Pick<DrawContext, "camera" | "pixelRatio">): void {
  const k = dc.pixelRatio * dc.camera.scale;
  g.setTransform(k, 0, 0, k, dc.pixelRatio * dc.camera.x, dc.pixelRatio * dc.camera.y);
}

/** `viewSpace` for a shape drawn outside the relief's runs, from its own stage's camera: in view units whatever group holds it. */
export function viewSpaceOf(g: CanvasRenderingContext2D, camera: Camera, pixelRatio: number): void {
  viewSpace(g, { camera, pixelRatio });
}

/** A view point in device pixels. */
function device(dc: DrawContext, v: Pt): Pt {
  const p = viewToScreen(dc.camera, v as ViewPoint);
  return { x: p.x * dc.pixelRatio, y: p.y * dc.pixelRatio };
}

/** A cell's polygon at height z, in view units, corner by corner. */
function lifted(turn: Turn, poly: readonly Pt[], z: number): Pt[] {
  const view = isometric(turn);
  return poly.map((p) => toView(view, p, z));
}

/** Adds a closed polygon to the path. */
function addPoly(g: CanvasRenderingContext2D, pts: readonly Pt[]): void {
  g.moveTo(pts[0]!.x, pts[0]!.y);
  for (let i = 1; i < pts.length; i++) g.lineTo(pts[i]!.x, pts[i]!.y);
  g.closePath();
}

/** A side as it draws: the parallelogram from `a` to `b` and `h` view units down. */
type SideShape = { a: Pt; b: Pt; h: number; left: boolean; path: Path2D | null };

/** A cell piece's drawing at a turn, in view units: its bounds, its sides, and its polygon at its own height and at 0. */
type CellShape = {
  bounds: VBox;
  sides: readonly SideShape[];
  top: readonly Pt[];
  atZero: readonly Pt[];
  /** The box of its polygon at 0, where a copy of its top reads the ground. */
  source: VBox;
  /** Its top, and every side's outline together, as paths made once, where the canvas has them (tests' fakes may not). */
  topPath: Path2D | null;
  outline: Path2D | null;
};

/*
 * Kept with each piece, turn by turn. A piece's geometry never changes once
 * built (buckets.ts makes new pieces when their cells or neighbors change),
 * so a pan reads these back instead of projecting every corner again each
 * frame (docs/design-v1-iso-hex-relief.md 9).
 */
const cellShapes = new WeakMap<CellPiece, (CellShape | undefined)[]>();
const wallBounds = new WeakMap<WallItem, (VBox | undefined)[]>();

function shapeOf(p: CellPiece, turn: Turn): CellShape {
  let byTurn = cellShapes.get(p);
  if (!byTurn) cellShapes.set(p, (byTurn = []));
  const kept = byTurn[turn];
  if (kept) return kept;
  const view = isometric(turn);
  const paths = typeof Path2D === "function";
  const sides = facesOf(p, turn).map((f: Face): SideShape => {
    const a = toView(view, { x: f.ax, y: f.ay }, f.z1);
    const b = toView(view, { x: f.bx, y: f.by }, f.z1);
    const h = K * (f.z1 - f.z0);
    return { a, b, h, left: f.left, path: paths ? sidePath(new Path2D(), a, b, h) : null };
  });
  const top = lifted(turn, p.poly, p.z);
  const atZero = lifted(turn, p.poly, 0);
  const source: VBox = { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity };
  for (const q of atZero) {
    source.x0 = Math.min(source.x0, q.x);
    source.y0 = Math.min(source.y0, q.y);
    source.x1 = Math.max(source.x1, q.x);
    source.y1 = Math.max(source.y1, q.y);
  }
  let outline: Path2D | null = null;
  if (paths && sides.length > 0) {
    outline = new Path2D();
    for (const f of sides) sidePath(outline, f.a, f.b, f.h);
  }
  const shape = { bounds: boundsOf(p, turn), sides, top, atZero, source, topPath: paths ? polyPath(new Path2D(), top) : null, outline };
  byTurn[turn] = shape;
  return shape;
}

/** Adds the parallelogram from `a` to `b` and `h` view units down to a path. */
function sidePath<P extends Path2D>(path: P, a: Pt, b: Pt, h: number): P {
  path.moveTo(a.x, a.y);
  path.lineTo(b.x, b.y);
  path.lineTo(b.x, b.y + h);
  path.lineTo(a.x, a.y + h);
  path.closePath();
  return path;
}

/** Adds a closed polygon to a path. */
function polyPath<P extends Path2D>(path: P, pts: readonly Pt[]): P {
  path.moveTo(pts[0]!.x, pts[0]!.y);
  for (let i = 1; i < pts.length; i++) path.lineTo(pts[i]!.x, pts[i]!.y);
  path.closePath();
  return path;
}

/** Fills `path`, or the context's own path when there is none. */
function fillWith(g: CanvasRenderingContext2D, path: Path2D | null): void {
  if (path) g.fill(path);
  else g.fill();
}

/** Strokes `path`, or the context's own path when there is none. */
function strokeWith(g: CanvasRenderingContext2D, path: Path2D | null): void {
  if (path) g.stroke(path);
  else g.stroke();
}

function boundsAt(p: StaticPiece, turn: Turn): VBox {
  if (p.kind !== "wall") return shapeOf(p, turn).bounds;
  let byTurn = wallBounds.get(p);
  if (!byTurn) wallBounds.set(p, (byTurn = []));
  return (byTurn[turn] ??= boundsOf(p, turn));
}

/** The openings at 0 a pit piece draws inside: its region's that meet its bounds, or its own. */
function openingsOf(p: CellPiece | WallItem, dc: DrawContext): readonly CellPiece[] {
  if (!p.region) return p.kind === "wall" ? [] : [p];
  return dc.openings ? dc.openings(p.region, boundsAt(p, dc.turn), p) : p.region.cells;
}

/** Adds the parallelogram from `a` to `b` and `h` view units down to the path. */
function addSide(g: CanvasRenderingContext2D, a: Pt, b: Pt, h: number): void {
  g.moveTo(a.x, a.y);
  g.lineTo(b.x, b.y);
  g.lineTo(b.x, b.y + h);
  g.lineTo(a.x, a.y + h);
  g.closePath();
}

/** A color as red, green, blue (0 to 255) and alpha (0 to 1), from `#rgb`, `#rrggbb`, `rgb()` or `rgba()`, else null. */
function parseColor(c: string): [number, number, number, number] | null {
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(c);
  if (hex) {
    const v = hex[1]!.length === 3 ? [...hex[1]!].map((d) => d + d).join("") : hex[1]!;
    return [parseInt(v.slice(0, 2), 16), parseInt(v.slice(2, 4), 16), parseInt(v.slice(4, 6), 16), 1];
  }
  const fn = /^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*(?:,\s*([\d.]+)\s*)?\)$/i.exec(c);
  return fn ? [Number(fn[1]), Number(fn[2]), Number(fn[3]), fn[4] === undefined ? 1 : Number(fn[4])] : null;
}

/** Opaque colors with a translucent one laid over them, by `base|over`: a side's tone and the light from the left as one fill. */
const blends = new Map<string, string | null>();
const BLENDS_KEPT = 4096;

/** `over` laid on an opaque `base`, as the canvas composites it, or null when either is not a color read here or `base` is not opaque. */
export function blended(base: string, over: string): string | null {
  const key = `${base}|${over}`;
  const kept = blends.get(key);
  if (kept !== undefined) return kept;
  const b = parseColor(base);
  const o = parseColor(over);
  let out: string | null = null;
  if (b && o && b[3] === 1) {
    const mix = (i: number) => Math.round(b[i]! * (1 - o[3]) + o[i]! * o[3]);
    out = `rgb(${mix(0)}, ${mix(1)}, ${mix(2)})`;
  }
  if (blends.size >= BLENDS_KEPT) blends.clear();
  blends.set(key, out);
  return out;
}

/**
 * Fills the parallelogram from `a` to `b` and `h` view units down with a
 * look: its texture laid along the edge one tile per TEXTURE_CELLS cells of
 * length and of height, else its tone, then the light from the left. A
 * plain tone and its light fill once, mixed. Its outline follows unless the
 * caller strokes it with others (`stroke` false).
 */
function fillSide(g: CanvasRenderingContext2D, a: Pt, b: Pt, h: number, look: SideLook, left: boolean | null, dc: DrawContext, tint: string | null = null, stroke = true, path: Path2D | null = null): void {
  if (!path) {
    g.beginPath();
    addSide(g, a, b, h);
  }
  const light = left === null ? null : left ? theme.relief.lit : theme.relief.shaded;
  const img = look.texture && look.texture !== "pit" && look.texture !== "pillar" && look.texture !== "stairs" ? dc.textures[look.texture as TexturedTerrain] : undefined;
  const pattern = img ? patternOf(g, img) : null;
  if (pattern && img && img.naturalWidth > 0) {
    // Pattern pixels to view units: along the edge per cell of its length, and K view units down per cell of height.
    const length = Math.hypot(b.x - a.x, (b.y - a.y) * 2) || 1;
    const k = TEXTURE_CELLS / img.naturalWidth;
    pattern.setTransform(new DOMMatrix([((b.x - a.x) / length) * k, ((b.y - a.y) / length) * k, 0, K * k, a.x, a.y]));
    g.fillStyle = pattern;
    fillWith(g, path);
  } else {
    const tone = look.texture && !img ? (TERRAIN_COLORS[look.texture as TexturedTerrain] ?? look.color) : look.color;
    const mixed = !tint && light ? blended(tone, light) : null;
    g.fillStyle = mixed ?? tone;
    fillWith(g, path);
    if (mixed) return outline(g, dc, stroke, path);
  }
  if (tint) {
    g.fillStyle = tint;
    fillWith(g, path);
  }
  if (light) {
    g.fillStyle = light;
    fillWith(g, path);
  }
  outline(g, dc, stroke, path);
}

/** Strokes the path as the thin line round sides and walls, when `stroke`. */
function outline(g: CanvasRenderingContext2D, dc: DrawContext, stroke: boolean, path: Path2D | null = null): void {
  if (!stroke) return;
  g.strokeStyle = theme.relief.edge;
  g.lineWidth = 1 / (dc.camera.scale * dc.pixelRatio);
  strokeWith(g, path);
}

/** A piece's sides, each filled, then their outlines in one stroke: they meet only along their shared edges. */
function drawSides(g: CanvasRenderingContext2D, p: CellPiece, dc: DrawContext): void {
  const shape = shapeOf(p, dc.turn);
  if (shape.sides.length === 0) return;
  for (const f of shape.sides) fillSide(g, f.a, f.b, f.h, p.look, f.left, dc, null, false, f.path);
  if (!shape.outline) {
    g.beginPath();
    for (const f of shape.sides) addSide(g, f.a, f.b, f.h);
  }
  outline(g, dc, true, shape.outline);
}

/** The path of cells' tops: the one piece's own when it is alone, else the context's path, built here. */
function topsPath(g: CanvasRenderingContext2D, cells: readonly CellPiece[], turn: Turn): Path2D | null {
  if (cells.length === 1) {
    const own = shapeOf(cells[0]!, turn).topPath;
    if (own) return own;
  }
  g.beginPath();
  for (const c of cells) addPoly(g, shapeOf(c, turn).top);
  return null;
}

/**
 * Copies the ground under cells of one height, moved by that height up (a
 * top) or down (a pit's floor, negative), inside their polygons at it: one
 * path of those polygons in view units, filled with the ground's pixels
 * shifted by the lift.
 */
function copyGround(g: CanvasRenderingContext2D, cells: readonly CellPiece[], dc: DrawContext, tone: string): void {
  const shift = K * cells[0]!.z * dc.camera.scale * dc.pixelRatio;
  const path = topsPath(g, cells, dc.turn);
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const c of cells) {
    // The source box from the clip's own polygon at 0, before the copy's lift, so a pit's floor reads exactly the pixels it shows.
    const box = shapeOf(c, dc.turn).source;
    x0 = Math.min(x0, box.x0);
    y0 = Math.min(y0, box.y0);
    x1 = Math.max(x1, box.x1);
    y1 = Math.max(y1, box.y1);
  }
  // The view box in device pixels: the camera only scales and moves, so its corners map to corners.
  ({ x: x0, y: y0 } = device(dc, { x: x0, y: y0 }));
  ({ x: x1, y: y1 } = device(dc, { x: x1, y: y1 }));
  const ground = dc.ground;
  // Past the ground stage's margin there is nothing to copy: the face tone fills the rest until the map pans up.
  if (!ground || y1 > ground.height || y0 < 0 || x0 < 0 || x1 > ground.width) {
    g.fillStyle = tone;
    fillWith(g, path);
  }
  const pattern = groundPattern(g, dc);
  if (!pattern) return;
  // Pattern space is the ground's device pixels, moved up by the lift: undo the run's view transform, then shift.
  const k = dc.pixelRatio * dc.camera.scale;
  const ex = dc.pixelRatio * dc.camera.x;
  const ey = dc.pixelRatio * dc.camera.y;
  pattern.setTransform({ a: 1 / k, b: 0, c: 0, d: 1 / k, e: -ex / k, f: -(ey + shift) / k });
  g.fillStyle = pattern;
  fillWith(g, path);
}

/**
 * The ground's pixels as a pattern. A pattern holds the canvas as it was
 * when made, so one made once for each ground draw serves every top the
 * relief copies after it, where a clip and an image copy for each top
 * cost a phone's frame on alternating heights (docs/design-v1-iso-hex-relief.md 9).
 */
function groundPattern(g: CanvasRenderingContext2D, dc: DrawContext): CanvasPattern | null {
  const ground = dc.ground;
  if (!ground || ground.width === 0 || ground.height === 0) return null;
  const copy = dc.groundCopy;
  if (!copy) return g.createPattern(ground, "no-repeat");
  if (copy.pattern && copy.made === copy.version && copy.canvas === ground) return copy.pattern;
  copy.pattern = g.createPattern(ground, "no-repeat");
  copy.made = copy.version;
  copy.canvas = ground;
  return copy.pattern;
}

/** The outline of tops at one height, so a platform's edge reads on flat art. */
function outlineTops(g: CanvasRenderingContext2D, cells: readonly CellPiece[], dc: DrawContext): void {
  const path = topsPath(g, cells, dc.turn);
  g.strokeStyle = theme.relief.edge;
  g.lineWidth = 1 / (dc.camera.scale * dc.pixelRatio);
  strokeWith(g, path);
}

/**
 * A pit (5.2): inside the openings at 0 of its connected region, its floor,
 * the ground under it copied down by its depth and clipped to its own floor
 * polygon, then darkened inside that polygon alone, then its far sides. A
 * nearer pit of the region draws later, so where two floors meet on screen
 * the nearer one shows, each with its own pixels and one shade.
 */
function drawPit(g: CanvasRenderingContext2D, p: CellPiece, dc: DrawContext): void {
  g.save();
  g.beginPath();
  for (const o of openingsOf(p, dc)) addPoly(g, shapeOf(o, dc.turn).atZero);
  g.clip("nonzero");
  copyGround(g, [p], dc, theme.relief.side);
  const floor = topsPath(g, [p], dc.turn);
  g.fillStyle = theme.relief.pitShade;
  fillWith(g, floor);
  drawSides(g, p, dc);
  g.restore();
}

/** A pillar's radius in cells, as the builder draws its disc (builder/draw.ts pillarPaths). */
const PILLAR_RADIUS = 0.36;

/** A standing pillar: a stone drum on its cell, its side lit from the left, its top in the pillar's swatch. */
function drawPillar(g: CanvasRenderingContext2D, w: WallItem, dc: DrawContext): void {
  const view = isometric(dc.turn);
  const center = { x: w.piece.ax + 0.5, y: w.piece.ay + 0.5 };
  const base = toView(view, center, w.base);
  const top = toView(view, center, w.base + w.rise);
  // A circle on the ground shows as an ellipse twice as wide as it is tall, at every turn.
  const rx = PILLAR_RADIUS;
  const ry = PILLAR_RADIUS / 2;
  g.beginPath();
  g.moveTo(top.x - rx, top.y);
  g.lineTo(base.x - rx, base.y);
  g.ellipse(base.x, base.y, rx, ry, 0, Math.PI, 0, true);
  g.lineTo(top.x + rx, top.y);
  g.ellipse(top.x, top.y, rx, ry, 0, 0, Math.PI, false);
  g.closePath();
  const img = dc.textures.stone;
  const pattern = img ? patternOf(g, img) : null;
  if (pattern && img && img.naturalWidth > 0) {
    const k = TEXTURE_CELLS / img.naturalWidth;
    pattern.setTransform(new DOMMatrix([k, 0, 0, K * k, top.x - rx, top.y]));
    g.fillStyle = pattern;
  } else {
    g.fillStyle = TERRAIN_COLORS.stone;
  }
  g.fill();
  g.fillStyle = theme.relief.pillarTint;
  g.fill();
  g.strokeStyle = theme.relief.edge;
  g.lineWidth = 1 / (dc.camera.scale * dc.pixelRatio);
  g.stroke();
  g.beginPath();
  g.ellipse(top.x, top.y, rx, ry, 0, 0, Math.PI * 2);
  g.fillStyle = TERRAIN_SWATCHES.pillar;
  g.fill();
  g.stroke();
}

/** A wall piece, inside the openings of its pit region, swept up, when it stands below 0: the near rim hides its foot (5.2). */
function drawWall(g: CanvasRenderingContext2D, w: WallItem, dc: DrawContext): void {
  if (!w.region) return drawStanding(g, w, dc);
  g.save();
  clipToPits(g, openingsOf(w, dc).map((c) => c.poly), dc.turn);
  drawStanding(g, w, dc);
  g.restore();
}

function drawStanding(g: CanvasRenderingContext2D, w: WallItem, dc: DrawContext): void {
  if (w.piece.kind === "pillar") return drawPillar(g, w, dc);
  const view = isometric(dc.turn);
  const top = w.base + w.rise;
  const a = toView(view, { x: w.piece.ax, y: w.piece.ay }, top);
  const b = toView(view, { x: w.piece.bx, y: w.piece.by }, top);
  const h = K * w.rise;
  if (w.piece.kind === "window") {
    fillSide(g, a, b, h, { texture: null, color: theme.relief.pane }, null, dc);
    return;
  }
  const look: SideLook = w.piece.kind === "door" ? { texture: "wood", color: TERRAIN_COLORS.wood } : { texture: "stone", color: TERRAIN_COLORS.stone };
  // A wall facing the viewer's left reads lighter, as a column's left side does.
  fillSide(g, a, b, h, look, a.x < b.x === a.y > b.y, dc, w.piece.kind === "wall" ? theme.relief.wallTint : null);
}

/** Draws one run of pieces, in the order given. */
export function drawRun(g: CanvasRenderingContext2D, pieces: readonly DrawPiece[], dc: DrawContext): void {
  g.save();
  viewSpace(g, dc);
  let batch: CellPiece[] = [];
  const flush = () => {
    if (batch.length === 0) return;
    copyGround(g, batch, dc, batch[0]!.look.color);
    outlineTops(g, batch, dc);
    batch = [];
  };
  for (let i = 0; i < pieces.length; i++) {
    const p = pieces[i]!;
    if (p.kind === "volume") {
      // An area's bands with only other areas' bands between them draw as one: one fill for their far faces and one for their near ones (ISOA-D3).
      // Two areas' tints blend in either order (design 4.3), so only a column, wall, pit or standee parts an area's run. At the cap that is a call an area, not one a band.
      let end = i + 1;
      while (end < pieces.length && pieces[end]!.kind === "volume") end++;
      const byArea = new Map<string, VolumePiece[]>();
      for (let k = i; k < end; k++) {
        const v = pieces[k] as VolumePiece;
        const list = byArea.get(v.area);
        if (list) list.push(v);
        else byArea.set(v.area, [v]);
      }
      i = end - 1;
      flush();
      for (const run of byArea.values()) {
        if (!run.some((v) => meets(v.bounds, dc.view))) continue;
        const high: BandPart[] = [];
        const low: BandPart[] = [];
        for (const v of run) {
          for (const d of v.draws) {
            high.push(d.high);
            low.push(d.low);
          }
        }
        drawVolume(g, high, low, run[0]!.pits, run[0]!.look, dc.turn, 1 / dc.camera.scale);
      }
      continue;
    }
    if (!meets(boundsAt(p, dc.turn), dc.view)) continue;
    if (p.kind === "column") {
      // Sides of later columns at one lift never overlap earlier tops at that lift, so the tops can wait for one copy.
      if (batch.length > 0 && batch[0]!.z !== p.z) flush();
      drawSides(g, p, dc);
      batch.push(p);
      continue;
    }
    flush();
    if (p.kind === "wall") drawWall(g, p, dc);
    else drawPit(g, p, dc);
  }
  flush();
  g.restore();
}

/** How an area standing as its real shape draws (docs/design-v1-iso-area-shapes.md 5). */
export type VolumeLook = {
  color: string;
  /** A DM-only area on the DM's device: all of it at 60%, its outline dashed 6 4. */
  dm: boolean;
  /** Selected with the Area tool, or being aimed: its outline 2.5 px. */
  selected: boolean;
  /** Another member's preview: its fill 10%, its outline dashed 8 5. */
  preview: boolean;
};

type Pts = ArrayLike<number>;

/** Adds closed loops `[x, y, z, ...]` in world cells to the path, in view units at a turn. */
function addLoops(g: CanvasRenderingContext2D, loops: readonly Pts[], c: number, s: number): void {
  for (const q of loops) {
    g.moveTo(c * q[0]! - s * q[1]!, (s * q[0]! + c * q[1]!) / 2 - K * q[2]!);
    for (let i = 3; i + 2 < q.length; i += 3) g.lineTo(c * q[i]! - s * q[i + 1]!, (s * q[i]! + c * q[i + 1]!) / 2 - K * q[i + 2]!);
    g.closePath();
  }
}

/** Adds polylines `[x, y, z, ...]`, a NaN between one and the next, to the path, in view units at a turn. */
function addLines(g: CanvasRenderingContext2D, q: Pts, c: number, s: number): void {
  let start = true;
  for (let i = 0; i + 2 < q.length; i += 3) {
    const x = q[i]!;
    if (Number.isNaN(x)) {
      start = true;
      continue;
    }
    const u = c * x - s * q[i + 1]!;
    const v = (s * x + c * q[i + 1]!) / 2 - K * q[i + 2]!;
    if (start) g.moveTo(u, v);
    else g.lineTo(u, v);
    start = false;
  }
}

/**
 * An opening at 0 swept up past the canvas's top, in view units: its lower
 * edge from its leftmost corner to its rightmost, then straight up. Every
 * sweep winds the same way, so a union of them clips as one.
 */
export function pitSweep(turn: Turn, poly: readonly Pt[]): Pt[] {
  const pts = lifted(turn, poly, 0);
  const n = pts.length;
  let l = 0;
  let r = 0;
  for (let i = 1; i < n; i++) {
    if (pts[i]!.x < pts[l]!.x) l = i;
    if (pts[i]!.x > pts[r]!.x) r = i;
  }
  // Of the two chains from the leftmost corner to the rightmost, the lower one on screen.
  const chain = (step: 1 | -1): Pt[] => {
    const out: Pt[] = [pts[l]!];
    for (let i = (l + step + n) % n; i !== r; i = (i + step + n) % n) out.push(pts[i]!);
    out.push(pts[r]!);
    return out;
  };
  const a = chain(1);
  const b = chain(-1);
  const low = (c: Pt[]) => c.slice(1, -1).reduce((m, p) => Math.max(m, p.y), -Infinity);
  const lower = low(a) >= low(b) ? a : b;
  const sky = Math.min(pts[l]!.y, pts[r]!.y) - 1e5;
  return [...lower, { x: pts[r]!.x, y: sky }, { x: pts[l]!.x, y: sky }];
}

/**
 * Clips to pit openings swept up past the canvas's top, in view units, so
 * the near rim hides what lies below it, as it hides a standee there
 * (docs/design-v1-isometric-view.md 5.5). `pits` are the openings' world
 * polygons, the connected region's that meet what is clipped.
 */
export function clipToPits(g: CanvasRenderingContext2D, pits: readonly (readonly Pt[])[], turn: Turn): void {
  g.beginPath();
  for (const poly of pits) addPoly(g, pitSweep(turn, poly));
  g.clip("nonzero");
}

/**
 * Draws bands of one area as one run (docs/design-v1-iso-area-shapes.md
 * 4.3 and 5): its far loops filled, its near loops filled, its hidden
 * lines, then its outline and guides, in view units with `unit` view
 * units to a screen pixel. The parts inside a pit's opening draw clipped
 * to the openings of `pits`.
 */
export function drawVolume(g: CanvasRenderingContext2D, high: readonly BandPart[], low: readonly BandPart[], pits: readonly (readonly { x: number; y: number }[])[], look: VolumeLook, turn: Turn, unit: number): void {
  const { c, s } = turnAxes(turn);
  const a = theme.area;
  const dim = look.dm ? a.dmOpacity : 1;
  const fill = (look.preview ? a.previewFill : a.volumeFill) * dim;
  g.save();
  g.fillStyle = look.color;
  g.strokeStyle = look.color;
  g.lineJoin = "round";
  const fills = (parts: readonly BandPart[]) => {
    for (const which of ["far", "near"] as const) {
      g.beginPath();
      let any = false;
      for (const p of parts) {
        if (p[which].length === 0) continue;
        any = true;
        addLoops(g, p[which], c, s);
      }
      if (!any) continue;
      g.globalAlpha = fill;
      g.fill();
    }
  };
  const strokes = (parts: readonly BandPart[]) => {
    const stroke = (which: readonly ("hidden" | "guideHidden" | "outline" | "guide")[], alpha: number, widthPx: number, dash: readonly number[] | null) => {
      g.beginPath();
      let any = false;
      for (const p of parts) {
        for (const w of which) {
          if (p[w].length === 0) continue;
          any = true;
          addLines(g, p[w], c, s);
        }
      }
      if (!any) return;
      g.globalAlpha = alpha * dim;
      g.lineWidth = widthPx * unit;
      g.setLineDash(dash ? dash.map((d) => d * unit) : []);
      g.lineCap = dash ? "butt" : "round";
      g.stroke();
    };
    // Hidden creases and far guides look alike, so they take one dashed stroke.
    stroke(["hidden", "guideHidden"], a.volumeHidden, a.thinWidthPx, a.hiddenDash);
    stroke(["outline"], a.volumeLine, look.selected ? a.selectedWidthPx : a.lineWidthPx, look.dm ? a.dmDash : look.preview ? a.previewDash : null);
    stroke(["guide"], a.volumeGuide, a.thinWidthPx, null);
  };
  fills(high);
  if (pits.length > 0 && low.some((p) => p.far.length + p.near.length + p.outline.length + p.hidden.length + p.guide.length + p.guideHidden.length > 0)) {
    g.save();
    clipToPits(g, pits, turn);
    fills(low);
    strokes(low);
    g.restore();
  }
  strokes(high);
  g.restore();
}
