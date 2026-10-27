import type { TexturedTerrain } from "../../features/builder/geometry.ts";
import { TERRAIN_COLORS, TERRAIN_SWATCHES, TEXTURE_CELLS } from "../../features/builder/textures.ts";
import { viewToScreen, type Camera } from "../../lib/camera.ts";
import { theme } from "../../lib/theme.ts";
import { isometric, K, toView, turnAxes, type Turn, type ViewPoint } from "../../lib/view.ts";
import type { BandPart } from "../../features/areas/volume.ts";
import { meets, type DrawPiece, type VolumePiece } from "./buckets.ts";
import { patternOf } from "./looks.ts";
import { boundsOf, facesOf, type CellPiece, type Face, type SideLook, type StaticPiece, type VBox, type WallItem } from "./pieces.ts";

/**
 * Drawing a run of relief pieces (docs/design-v1-isometric-view.md 5.5):
 * one Konva shape that does not listen draws every piece between two
 * standees, in depth order. A column draws its sides, then its top: the
 * ground stage's pixels under the cell, copied up by the lift and clipped
 * to the lifted diamond, read only from the source box. Neighboring tops at
 * one lift share a clip and a copy. A pit draws its floor, the ground's
 * pixels copied down, and its far sides, inside its opening. Consecutive
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
};

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

function drawWall(g: CanvasRenderingContext2D, w: WallItem, dc: DrawContext): void {
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
    copyGround(g, batch, batch[0]!.z, 0, batch[0]!.z, dc, batch[0]!.look.color);
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
 * Clips to the openings of pit cells swept up past the canvas's top, in
 * view units, so the near rim hides what lies below it, as it hides a
 * standee there (docs/design-v1-isometric-view.md 5.5).
 */
export function clipToPits(g: CanvasRenderingContext2D, pits: readonly { x: number; y: number }[], turn: Turn): void {
  const view = isometric(turn);
  g.beginPath();
  for (const cell of pits) {
    const corners = [toView(view, cell), toView(view, { x: cell.x + 1, y: cell.y }), toView(view, { x: cell.x + 1, y: cell.y + 1 }), toView(view, { x: cell.x, y: cell.y + 1 })];
    const left = corners.reduce((a, b) => (b.x < a.x ? b : a));
    const right = corners.reduce((a, b) => (b.x > a.x ? b : a));
    const bottom = corners.reduce((a, b) => (b.y > a.y ? b : a));
    const sky = Math.min(left.y, right.y) - 1e5;
    g.moveTo(left.x, left.y);
    g.lineTo(bottom.x, bottom.y);
    g.lineTo(right.x, right.y);
    g.lineTo(right.x, sky);
    g.lineTo(left.x, sky);
    g.closePath();
  }
  g.clip();
}

/**
 * Draws bands of one area as one run (docs/design-v1-iso-area-shapes.md
 * 4.3 and 5): its far loops filled, its near loops filled, its hidden
 * lines, then its outline and guides, in view units with `unit` view
 * units to a screen pixel. The parts inside a pit's opening draw clipped
 * to the openings of `pits`.
 */
export function drawVolume(g: CanvasRenderingContext2D, high: readonly BandPart[], low: readonly BandPart[], pits: readonly { x: number; y: number }[], look: VolumeLook, turn: Turn, unit: number): void {
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
    const stroke = (which: "hidden" | "guideHidden" | "outline" | "guide", alpha: number, widthPx: number, dash: readonly number[] | null) => {
      g.beginPath();
      let any = false;
      for (const p of parts) {
        if (p[which].length === 0) continue;
        any = true;
        addLines(g, p[which], c, s);
      }
      if (!any) return;
      g.globalAlpha = alpha * dim;
      g.lineWidth = widthPx * unit;
      g.setLineDash(dash ? dash.map((d) => d * unit) : []);
      g.lineCap = dash ? "butt" : "round";
      g.stroke();
    };
    stroke("hidden", a.volumeHidden, a.thinWidthPx, a.hiddenDash);
    stroke("guideHidden", a.volumeHidden, a.thinWidthPx, a.hiddenDash);
    stroke("outline", a.volumeLine, look.selected ? a.selectedWidthPx : a.lineWidthPx, look.dm ? a.dmDash : look.preview ? a.previewDash : null);
    stroke("guide", a.volumeGuide, a.thinWidthPx, null);
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
