import type { TexturedTerrain } from "../../features/builder/geometry.ts";
import { TERRAIN_COLORS, TERRAIN_SWATCHES, TEXTURE_CELLS } from "../../features/builder/textures.ts";
import { viewToScreen, type Camera } from "../../lib/camera.ts";
import { theme } from "../../lib/theme.ts";
import { isometric, K, toView, type Turn, type ViewPoint } from "../../lib/view.ts";
import { meets } from "./buckets.ts";
import { patternOf } from "./looks.ts";
import { boundsOf, facesOf, WALL_RISE, type CellPiece, type Face, type SideLook, type StaticPiece, type VBox, type WallItem } from "./pieces.ts";

/**
 * Drawing a run of relief pieces (docs/design-v1-isometric-view.md 5.5):
 * one Konva shape that does not listen draws every piece between two
 * standees, in depth order. A column draws its sides, then its top: the
 * ground stage's pixels under the cell, copied up by the lift and clipped
 * to the lifted diamond, read only from the source box. Neighboring tops at
 * one lift share a clip and a copy. A pit draws its floor, the ground's
 * pixels copied down, and its far sides, inside its opening.
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
};

type Pt = { x: number; y: number };

/** Sets the context to draw in view units, the camera on top of the device pixels. */
function viewSpace(g: CanvasRenderingContext2D, dc: DrawContext): void {
  const k = dc.pixelRatio * dc.camera.scale;
  g.setTransform(k, 0, 0, k, dc.pixelRatio * dc.camera.x, dc.pixelRatio * dc.camera.y);
}

/** A view point in device pixels. */
function device(dc: DrawContext, v: Pt): Pt {
  const p = viewToScreen(dc.camera, v as ViewPoint);
  return { x: p.x * dc.pixelRatio, y: p.y * dc.pixelRatio };
}

/** The cell's diamond at height z, in view units, corner by corner. */
function diamond(turn: Turn, x: number, y: number, z: number): Pt[] {
  const view = isometric(turn);
  return [toView(view, { x, y }, z), toView(view, { x: x + 1, y }, z), toView(view, { x: x + 1, y: y + 1 }, z), toView(view, { x, y: y + 1 }, z)];
}

/**
 * Fills the parallelogram from `a` to `b` and `h` view units down with a
 * look: its texture laid along the edge one tile per TEXTURE_CELLS cells of
 * length and of height, else its tone, then the light from the left.
 */
function fillSide(g: CanvasRenderingContext2D, a: Pt, b: Pt, h: number, look: SideLook, left: boolean | null, dc: DrawContext, tint: string | null = null): void {
  g.beginPath();
  g.moveTo(a.x, a.y);
  g.lineTo(b.x, b.y);
  g.lineTo(b.x, b.y + h);
  g.lineTo(a.x, a.y + h);
  g.closePath();
  const img = look.texture && look.texture !== "pit" && look.texture !== "pillar" && look.texture !== "stairs" ? dc.textures[look.texture as TexturedTerrain] : undefined;
  const pattern = img ? patternOf(g, img) : null;
  if (pattern && img && img.naturalWidth > 0) {
    // Pattern pixels to view units: along the edge per cell of its length, and K view units down per cell of height.
    const length = Math.hypot(b.x - a.x, (b.y - a.y) * 2) || 1;
    const k = TEXTURE_CELLS / img.naturalWidth;
    pattern.setTransform(new DOMMatrix([((b.x - a.x) / length) * k, ((b.y - a.y) / length) * k, 0, K * k, a.x, a.y]));
    g.fillStyle = pattern;
  } else {
    g.fillStyle = look.texture && !img ? (TERRAIN_COLORS[look.texture as TexturedTerrain] ?? look.color) : look.color;
  }
  g.fill();
  if (tint) {
    g.fillStyle = tint;
    g.fill();
  }
  if (left !== null) {
    g.fillStyle = left ? theme.relief.lit : theme.relief.shaded;
    g.fill();
  }
  g.strokeStyle = theme.relief.edge;
  g.lineWidth = 1 / (dc.camera.scale * dc.pixelRatio);
  g.stroke();
}

function drawFace(g: CanvasRenderingContext2D, f: Face, look: SideLook, dc: DrawContext): void {
  const view = isometric(dc.turn);
  const a = toView(view, { x: f.ax, y: f.ay }, f.z1);
  const b = toView(view, { x: f.bx, y: f.by }, f.z1);
  fillSide(g, a, b, K * (f.z1 - f.z0), look, f.left, dc);
}

/** Copies the ground under a set of cells, moved by `shift` device pixels up (a top) or down (a pit's floor, negative), inside `clip`. */
function copyGround(g: CanvasRenderingContext2D, cells: readonly CellPiece[], clipZ: number, sourceZ: number, shiftZ: number, dc: DrawContext, tone: string): void {
  const shift = K * shiftZ * dc.camera.scale * dc.pixelRatio;
  g.save();
  g.setTransform(1, 0, 0, 1, 0, 0);
  g.beginPath();
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const c of cells) {
    const clip = diamond(dc.turn, c.x, c.y, clipZ).map((p) => device(dc, p));
    g.moveTo(clip[0]!.x, clip[0]!.y);
    for (let i = 1; i < 4; i++) g.lineTo(clip[i]!.x, clip[i]!.y);
    g.closePath();
    for (const p of diamond(dc.turn, c.x, c.y, sourceZ).map((q) => device(dc, q))) {
      x0 = Math.min(x0, p.x);
      y0 = Math.min(y0, p.y);
      x1 = Math.max(x1, p.x);
      y1 = Math.max(y1, p.y);
    }
  }
  g.clip();
  const ground = dc.ground;
  // Past the ground stage's margin there is nothing to copy: the face tone fills the rest until the map pans up.
  if (!ground || y1 > ground.height || y0 < 0 || x0 < 0 || x1 > ground.width) {
    g.fillStyle = tone;
    g.fillRect(x0, y0 - shift, x1 - x0, y1 - y0);
  }
  if (ground && ground.width > 0 && ground.height > 0) {
    const sx = Math.max(0, Math.floor(x0));
    const sy = Math.max(0, Math.floor(y0));
    const sw = Math.min(ground.width, Math.ceil(x1)) - sx;
    const sh = Math.min(ground.height, Math.ceil(y1)) - sy;
    if (sw > 0 && sh > 0) g.drawImage(ground, sx, sy, sw, sh, sx, sy - shift, sw, sh);
  }
  g.restore();
}

/** The outline of tops at one height, so a platform's edge reads on flat art. */
function outlineTops(g: CanvasRenderingContext2D, cells: readonly CellPiece[], dc: DrawContext): void {
  g.beginPath();
  for (const c of cells) {
    const d = diamond(dc.turn, c.x, c.y, c.z);
    g.moveTo(d[0]!.x, d[0]!.y);
    for (let i = 1; i < 4; i++) g.lineTo(d[i]!.x, d[i]!.y);
    g.closePath();
  }
  g.strokeStyle = theme.relief.edge;
  g.lineWidth = 1 / (dc.camera.scale * dc.pixelRatio);
  g.stroke();
}

function drawPit(g: CanvasRenderingContext2D, p: CellPiece, dc: DrawContext): void {
  g.save();
  const opening = diamond(dc.turn, p.x, p.y, 0);
  g.beginPath();
  g.moveTo(opening[0]!.x, opening[0]!.y);
  for (let i = 1; i < 4; i++) g.lineTo(opening[i]!.x, opening[i]!.y);
  g.closePath();
  g.clip();
  // The floor is the cell's ground moved down by the depth, then darkened by it.
  copyGround(g, [p], 0, 0, p.z, dc, theme.relief.side);
  g.fillStyle = theme.relief.pitShade;
  g.fill();
  for (const f of facesOf(p, dc.turn)) drawFace(g, f, p.look, dc);
  g.restore();
}

/** A pillar's radius in cells, as the builder draws its disc (builder/draw.ts pillarPaths). */
const PILLAR_RADIUS = 0.36;

/** A standing pillar: a stone drum on its cell, its side lit from the left, its top in the pillar's swatch. */
function drawPillar(g: CanvasRenderingContext2D, w: WallItem, dc: DrawContext): void {
  const view = isometric(dc.turn);
  const center = { x: w.piece.ax + 0.5, y: w.piece.ay + 0.5 };
  const base = toView(view, center, w.base);
  const top = toView(view, center, w.base + WALL_RISE);
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

function drawWall(g: CanvasRenderingContext2D, w: WallItem, dc: DrawContext): void {
  if (w.piece.kind === "pillar") return drawPillar(g, w, dc);
  const view = isometric(dc.turn);
  const top = w.base + WALL_RISE;
  const a = toView(view, { x: w.piece.ax, y: w.piece.ay }, top);
  const b = toView(view, { x: w.piece.bx, y: w.piece.by }, top);
  const h = K * WALL_RISE;
  if (w.piece.kind === "window") {
    fillSide(g, a, b, h, { texture: null, color: theme.relief.pane }, null, dc);
    return;
  }
  const look: SideLook = w.piece.kind === "door" ? { texture: "wood", color: TERRAIN_COLORS.wood } : { texture: "stone", color: TERRAIN_COLORS.stone };
  // A wall facing the viewer's left reads lighter, as a column's left side does.
  fillSide(g, a, b, h, look, a.x < b.x === a.y > b.y, dc, w.piece.kind === "wall" ? theme.relief.wallTint : null);
}

/** Draws one run of pieces, in the order given. */
export function drawRun(g: CanvasRenderingContext2D, pieces: readonly StaticPiece[], dc: DrawContext): void {
  g.save();
  viewSpace(g, dc);
  let batch: CellPiece[] = [];
  const flush = () => {
    if (batch.length === 0) return;
    copyGround(g, batch, batch[0]!.z, 0, batch[0]!.z, dc, batch[0]!.look.color);
    outlineTops(g, batch, dc);
    batch = [];
  };
  for (const p of pieces) {
    if (!meets(boundsOf(p, dc.turn), dc.view)) continue;
    if (p.kind === "column") {
      // Sides of later columns at one lift never overlap earlier tops at that lift, so the tops can wait for one copy.
      if (batch.length > 0 && batch[0]!.z !== p.z) flush();
      for (const f of facesOf(p, dc.turn)) drawFace(g, f, p.look, dc);
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
