import type { AutoWalls, BuildChunk, EdgeFeature, FreeWall, Label, Light, Scene, WallFeature } from "#shared/model.ts";
import { cellId, deriveWalls, indexBuild, type WallEdge } from "#shared/rules/walls.ts";
import { theme } from "../../lib/theme.ts";
import { buildDrawing, swingSide, wallRuns, type BuildDrawing, type CellRect, type TexturedTerrain } from "./geometry.ts";
import { reliefPaths, stairCells, stairPaths, TREADS, type ReliefPaths, type StairPaths } from "./heights/relief.ts";
import { TERRAIN_COLORS, TEXTURE_CELLS } from "./textures.ts";

/**
 * How a build draws on a plain 2D canvas whose transform is already in world
 * cells. The board layer calls it from a Konva shape, and the map export
 * calls it on an offscreen canvas, so the exported image matches the board
 * stroke for stroke.
 *
 * Players see what their projection holds: an undiscovered secret door
 * arrives as the wall players see there (shared/project.ts), so it draws as
 * one.
 *
 * Free walls (docs/design-v1-maps-vision.md section 2.2) draw with the edge
 * walls, in the same colors and the same pass, and their doors and windows
 * draw the edge symbols turned to the segment. They are drawn from the
 * stored walls in the chunks, not from the derived set split at crossings:
 * a split changes nothing that shows.
 *
 * Raised areas and stairs (docs/design-v1-maps-vision.md section 4.2) draw
 * over the floor and the map image alike, under the stamps and walls: the
 * shading of heights/relief.ts, then stairs pointing their way up. Stairs
 * over floor sit on the Stairs terrain's pale slab. Stairs over the map
 * image draw only their treads, translucent, so the art shows through.
 */

const WALL_COLOR = "#15120f";
/*
 * A pale rim around every wall. The walls are near black so they read on
 * the floor textures, which left a wall standing in the rock invisible on a
 * dark scene background. The rim shows the wall on any background.
 */
const WALL_RIM = "rgba(214, 204, 188, 0.6)";
const BASE_FLOOR = "#2c2a27";
const DOOR_FILL = "#9a6a3a";
const WINDOW_FILL = "rgba(160, 210, 245, 0.75)";

type DoorFeature = Extract<EdgeFeature, { kind: "door" }>;

/** The subset of Path2D the build's shapes use, so tests can record them without a canvas. */
export type PathSink = Pick<Path2D, "moveTo" | "lineTo" | "closePath" | "arc" | "rect">;

/** Everything a build draws, as Path2D objects ready to fill or stroke. */
export type BoardPaths<P = Path2D> = {
  drawing: BuildDrawing;
  floors: [TexturedTerrain, P][];
  all: P;
  box: { x0: number; y0: number; x1: number; y1: number } | null;
  pits: P;
  pitRims: P;
  pillars: P;
  pillarShine: P;
  /** The pale slab under every stair over floor: Stairs terrain, and stair marks on painted cells. */
  stairs: P;
  /** Stairs over floor: treads toward their direction, or five lines when they have none. */
  floorStairs: StairPaths<P>;
  /** Stair marks over the map image, where no floor is painted: the same shapes, drawn translucent. */
  artStairs: StairPaths<P>;
  /** Heights: the tints, shadows, rims and lines of the relief. */
  relief: ReliefPaths<P>;
  walls: P;
  /**
   * Free walls, and the stubs beside their doors and windows. Stroked with
   * the edge walls, in the same pass, but with round ends, so the pieces of
   * an imported wall that meet at an angle join without a notch.
   */
  freeWalls: P;
  leaves: P;
  openLeaves: P;
  swings: P;
  panes: P;
  /** DM only: lock marks on locked doors. */
  locks: P;
  /** DM only: the outline of each secret door, dashed over its wall. */
  secrets: P;
  /** DM only: where an "S" marks a secret door. */
  secretMarks: { x: number; y: number }[];
  /** DM only: edges marked "No wall", where an automatic wall was taken away. */
  noWalls: P;
};

function rectsPath<P extends PathSink>(make: () => P, rects: readonly CellRect[], inset = 0): P {
  const p = make();
  for (const r of rects) p.rect(r.x + inset, r.y + inset, r.w - inset * 2, r.h - inset * 2);
  return p;
}

/**
 * A straight piece of wall that a door or window sits in: where it starts,
 * the unit vector along it, its length, and the unit vector across it that
 * points south, or east for a piece running north and south, the side an
 * open door swings to when both sides are alike.
 */
type Frame = { ax: number; ay: number; ux: number; uy: number; nx: number; ny: number; len: number };

/** A cell edge's frame. */
function edgeFrame(e: WallEdge): Frame {
  return e.side === "n"
    ? { ax: e.x, ay: e.y, ux: 1, uy: 0, nx: 0, ny: 1, len: 1 }
    : { ax: e.x, ay: e.y, ux: 0, uy: 1, nx: 1, ny: 0, len: 1 };
}

/** A free wall's frame, or null for a wall with no length, which draws nothing. */
export function freeFrame(wall: Pick<FreeWall, "a" | "b">): Frame | null {
  const dx = wall.b[0] - wall.a[0];
  const dy = wall.b[1] - wall.a[1];
  const len = Math.hypot(dx, dy);
  if (!(len > 0) || !Number.isFinite(len)) return null;
  const ux = dx / len;
  const uy = dy / len;
  // Of the two normals, the one toward the south, or the east when the wall runs north and south, as an edge's.
  const flip = ux < 0 || (ux === 0 && uy > 0);
  return { ax: wall.a[0], ay: wall.a[1], ux, uy, nx: flip ? uy : -uy, ny: flip ? -ux : ux, len };
}

/**
 * The wall left at each end of a door or window, its frame: 0.15 cell, the
 * edge symbols' own, or less on a piece shorter than a cell.
 */
function stubOf(f: Frame): number {
  return 0.15 * Math.min(1, f.len);
}

/** Short wall pieces at both ends of a door or window, so the opening sits in the wall. */
function stubs(path: PathSink, f: Frame): void {
  const { ax, ay, ux, uy, len } = f;
  const s = stubOf(f);
  path.moveTo(ax, ay);
  path.lineTo(ax + ux * s, ay + uy * s);
  path.moveTo(ax + ux * (len - s), ay + uy * (len - s));
  path.lineTo(ax + ux * len, ay + uy * len);
}

/** A slab across the opening, `thick` wide, as a closed polygon. */
function slab(path: PathSink, f: Frame, thick: number): void {
  const { ax, ay, ux, uy, nx, ny, len } = f;
  const h = thick / 2;
  const s = stubOf(f);
  const t = len - s;
  path.moveTo(ax + ux * s - nx * h, ay + uy * s - ny * h);
  path.lineTo(ax + ux * t - nx * h, ay + uy * t - ny * h);
  path.lineTo(ax + ux * t + nx * h, ay + uy * t + ny * h);
  path.lineTo(ax + ux * s + nx * h, ay + uy * s + ny * h);
  path.closePath();
}

function openDoor(leaf: PathSink, swing: PathSink, f: Frame, side: 1 | -1): void {
  const { ax, ay, ux, uy } = f;
  const nx = f.nx * side;
  const ny = f.ny * side;
  const s = stubOf(f);
  const hx = ax + ux * s;
  const hy = ay + uy * s;
  const len = f.len - 2 * s;
  const w = 0.08;
  leaf.moveTo(hx, hy);
  leaf.lineTo(hx + ux * w, hy + uy * w);
  leaf.lineTo(hx + ux * w + nx * len, hy + uy * w + ny * len);
  leaf.lineTo(hx + nx * len, hy + ny * len);
  leaf.closePath();
  const from = Math.atan2(ny, nx);
  const to = Math.atan2(uy, ux);
  swing.moveTo(hx + nx * len, hy + ny * len);
  swing.arc(hx, hy, len, from, to, nx * uy - ny * ux < 0);
}

function midpoint(f: Frame): { x: number; y: number } {
  return { x: f.ax + (f.ux * f.len) / 2, y: f.ay + (f.uy * f.len) / 2 };
}

/**
 * The side of a free door an open leaf swings to, as swingSide picks for an
 * edge: into floor, never into rock, and to the frame's normal when both
 * sides are alike. The cells tested are a quarter cell to each side of the
 * door's middle, which for a door on a grid line are the two cells beside it.
 */
export function freeSwingSide(f: Frame, isFloor: (x: number, y: number) => boolean): 1 | -1 {
  const m = midpoint(f);
  const ahead = isFloor(Math.floor(m.x + f.nx * 0.25), Math.floor(m.y + f.ny * 0.25));
  const behind = isFloor(Math.floor(m.x - f.nx * 0.25), Math.floor(m.y - f.ny * 0.25));
  return !ahead && behind ? -1 : 1;
}

/** What the paths read of the scene: its automatic walls rule (absent for "all") and its size, which stairs and raised edges stop at. */
export type BuildPathScene = { autoWalls?: AutoWalls; bounds?: { w: number; h: number } };

/**
 * The paths for a scene's chunks, with the automatic walls of the scene's
 * rule. `makePath` makes each path, a Path2D unless a test records them
 * instead.
 */
export function buildPaths(chunks: readonly BuildChunk[], role: "dm" | "player", scene?: BuildPathScene): BoardPaths;
export function buildPaths<P extends PathSink>(chunks: readonly BuildChunk[], role: "dm" | "player", scene: BuildPathScene | undefined, makePath: () => P): BoardPaths<P>;
export function buildPaths(
  chunks: readonly BuildChunk[],
  role: "dm" | "player",
  scene: BuildPathScene = {},
  makePath: () => PathSink = () => new Path2D(),
): BoardPaths<PathSink> {
  const drawing = buildDrawing(chunks);
  const build = indexBuild(chunks);
  // Derived under the scene's rule and within its bounds, so the board draws exactly the walls that block and stairs point as movement reads them.
  const derived = deriveWalls(build, "board", { rule: scene.autoWalls ?? "all", bounds: scene.bounds });
  const edges = derived.edges;
  const isFloor = (x: number, y: number) => x >= 0 && y >= 0 && build.cells.has(cellId(x, y));
  const dm = role === "dm";
  const hiddenSecret = (f: EdgeFeature) => f.kind === "door" && f.secret && !f.discovered;

  let box: BoardPaths["box"] = null;
  for (const r of drawing.all) {
    box = box
      ? { x0: Math.min(box.x0, r.x), y0: Math.min(box.y0, r.y), x1: Math.max(box.x1, r.x + r.w), y1: Math.max(box.y1, r.y + r.h) }
      : { x0: r.x, y0: r.y, x1: r.x + r.w, y1: r.y + r.h };
  }

  const pits = makePath();
  const pitRims = makePath();
  for (const c of drawing.symbols.pit) {
    pits.rect(c.x + 0.08, c.y + 0.08, 0.84, 0.84);
    pitRims.rect(c.x + 0.2, c.y + 0.2, 0.6, 0.6);
  }
  const pillars = makePath();
  const pillarShine = makePath();
  for (const c of drawing.symbols.pillar) {
    pillars.moveTo(c.x + 0.86, c.y + 0.5);
    pillars.arc(c.x + 0.5, c.y + 0.5, 0.36, 0, Math.PI * 2);
    pillarShine.moveTo(c.x + 0.56, c.y + 0.4);
    pillarShine.arc(c.x + 0.4, c.y + 0.4, 0.16, 0, Math.PI * 2);
  }
  const stairList = stairCells(chunks, derived);
  const stairs = makePath();
  for (const c of stairList) if (c.floor) stairs.rect(c.x + 0.08, c.y + 0.08, 0.84, 0.84);
  const floorStairs = stairPaths(stairList.filter((c) => c.floor), makePath);
  const artStairs = stairPaths(stairList.filter((c) => !c.floor), makePath);
  const relief = reliefPaths(chunks, derived, scene.bounds ?? null, makePath);

  const runs = wallRuns(edges, (e) => e.feature.kind === "wall" || (dm && hiddenSecret(e.feature)));
  const walls = makePath();
  for (let i = 0; i < runs.length; i += 4) {
    walls.moveTo(runs[i]!, runs[i + 1]!);
    walls.lineTo(runs[i + 2]!, runs[i + 3]!);
  }
  const freeWalls = makePath();
  const leaves = makePath();
  const openLeaves = makePath();
  const swings = makePath();
  const panes = makePath();
  const locks = makePath();
  const secrets = makePath();
  const secretMarks: { x: number; y: number }[] = [];

  /** A door or window in a frame, its wall pieces going to `wall`. */
  const opening = (feature: WallFeature, frame: Frame, wall: PathSink, swingTo: () => 1 | -1) => {
    if (feature.kind === "window") {
      stubs(wall, frame);
      slab(panes, frame, 0.12);
      return;
    }
    if (feature.kind !== "door") return;
    const door: DoorFeature = feature;
    const mid = midpoint(frame);
    if (hiddenSecret(door)) {
      // Players got this as a wall. The DM sees the wall, with the door marked in it.
      slab(secrets, frame, 0.22);
      secretMarks.push(mid);
      return;
    }
    stubs(wall, frame);
    if (door.state === "open") openDoor(openLeaves, swings, frame, swingTo());
    else slab(leaves, frame, 0.2);
    if (dm && door.state === "locked") locks.rect(mid.x - 0.07, mid.y - 0.07, 0.14, 0.14);
    if (dm && door.secret) secretMarks.push(mid);
  };

  for (const e of edges) opening(e.feature, edgeFrame(e), walls, () => swingSide(e, isFloor));

  for (const chunk of chunks) {
    for (const wall of chunk.walls ?? []) {
      const frame = freeFrame(wall);
      if (!frame) continue;
      /*
       * A free wall is never automatic, so a hidden secret free door is a
       * plain wall to players wherever it stands (shared/project.ts), and
       * the DM sees the wall too, with the door marked over it.
       */
      if (wall.f.kind === "wall" || hiddenSecret(wall.f)) {
        freeWalls.moveTo(wall.a[0], wall.a[1]);
        freeWalls.lineTo(wall.b[0], wall.b[1]);
      }
      opening(wall.f, frame, freeWalls, () => freeSwingSide(frame, isFloor));
    }
  }

  const noWalls = makePath();
  if (dm) {
    for (const chunk of chunks) {
      for (const [key, f] of Object.entries(chunk.edges)) {
        if (f.kind !== "none") continue;
        const [xs, ys, side] = key.split(",");
        const x = Number(xs);
        const y = Number(ys);
        noWalls.moveTo(x, y);
        noWalls.lineTo(side === "n" ? x + 1 : x, side === "n" ? y : y + 1);
      }
    }
  }

  const floors: [TexturedTerrain, PathSink][] = [...drawing.floors].map(([t, rects]) => [t, rectsPath(makePath, rects)]);
  return {
    drawing,
    floors,
    all: rectsPath(makePath, drawing.all),
    box,
    pits,
    pitRims,
    pillars,
    pillarShine,
    stairs,
    floorStairs,
    artStairs,
    relief,
    walls,
    freeWalls,
    leaves,
    openLeaves,
    swings,
    panes,
    locks,
    secrets,
    secretMarks,
    noWalls,
  };
}

const LABEL_FONT = `700 100px ${theme.font.body}`;
let measureContext: CanvasRenderingContext2D | null = null;

/** A label's width in ems, measured in the font drawLabel uses. */
export function measureLabel(text: string): number {
  measureContext ??= document.createElement("canvas").getContext("2d");
  if (!measureContext) return text.length * 0.6;
  measureContext.font = LABEL_FONT;
  return measureContext.measureText(text).width / 100;
}

export function drawLabel(g: CanvasRenderingContext2D, label: Pick<Label, "x" | "y" | "text" | "size">): void {
  // Canvas text is laid out at 100 px and scaled down to the label's size
  // in cells, since a font a fraction of a pixel tall renders badly.
  g.save();
  g.translate(label.x, label.y);
  const k = label.size / 100;
  g.scale(k, k);
  g.font = LABEL_FONT;
  g.textAlign = "center";
  g.textBaseline = "middle";
  g.lineJoin = "round";
  g.lineWidth = 16;
  g.strokeStyle = theme.color.textHalo;
  g.strokeText(label.text, 0, 0);
  g.fillStyle = theme.color.text;
  g.fillText(label.text, 0, 0);
  g.restore();
}

const STAIR_SLAB = "rgba(214, 204, 188, 0.45)";
/** A shadow band's fill. Bands overlap toward the edge, so the shadow is darkest there. */
const SHADOW_FILL = "rgba(0, 0, 0, 0.16)";
const RIM = "rgba(255, 248, 232, 0.6)";
const LEDGE = "rgba(12, 10, 8, 0.75)";

/** How a set of stairs is colored: over floor on its slab, or over the map image with nothing under it. */
type StairStyle = { tread(k: number): string; line: string; halo: string | null };

/** Treads lighten toward the high end. */
const FLOOR_STAIRS: StairStyle = { tread: (k) => `rgba(255, 255, 255, ${(0.02 + 0.1 * k).toFixed(2)})`, line: "#2a2723", halo: null };
/** Over art the treads are pale and translucent, and every line gets a pale halo, so the stair reads on dark and light art alike. */
const ART_STAIRS: StairStyle = { tread: (k) => `rgba(232, 222, 202, ${(0.14 + 0.13 * k).toFixed(2)})`, line: "rgba(20, 16, 12, 0.8)", halo: "rgba(232, 222, 202, 0.55)" };

/** The relief of raised areas (heights/relief.ts): tints, then shadows, then the edges. */
function drawRelief(g: CanvasRenderingContext2D, relief: ReliefPaths<Path2D>, scale: number): void {
  for (const tint of relief.tints) {
    g.fillStyle = tint.color;
    g.fill(tint.path);
  }
  g.fillStyle = SHADOW_FILL;
  for (const band of relief.shadows) g.fill(band);
  // At least a pixel and a half on screen, so a raised edge shows on a phone at the fitted zoom.
  g.lineWidth = Math.max(0.04, 1.5 / scale);
  g.lineCap = "round";
  g.strokeStyle = RIM;
  g.stroke(relief.rims);
  g.strokeStyle = LEDGE;
  g.stroke(relief.ledges);
  g.lineCap = "butt";
}

function drawStairs(g: CanvasRenderingContext2D, stairs: StairPaths<Path2D>, style: StairStyle): void {
  for (let k = 0; k < TREADS; k++) {
    g.fillStyle = style.tread(k);
    g.fill(stairs.treads[k]!);
  }
  g.lineCap = "round";
  g.lineJoin = "round";
  for (const [path, width] of [
    [stairs.risers, 0.035],
    [stairs.steps, 0.05],
    [stairs.chevrons, 0.08],
  ] as const) {
    if (style.halo) {
      g.strokeStyle = style.halo;
      g.lineWidth = width + 0.05;
      g.stroke(path);
    }
    g.strokeStyle = style.line;
    g.lineWidth = width;
    g.stroke(path);
  }
  g.lineCap = "butt";
  g.lineJoin = "miter";
}

export type DrawBuildOptions = {
  role: "dm" | "player";
  /** Output pixels per cell, for strokes that keep a minimum width on screen. */
  scale: number;
  /** The scene's grid style. Its lines are drawn again over the floor when `show` is on. */
  grid: Scene["grid"];
  textures: Partial<Record<TexturedTerrain, HTMLImageElement>>;
  labels: readonly Label[];
  /** Drawn over the floor and under the walls, doors and labels: the scene's stamps (builder/stamps/draw.ts). */
  underWalls?: (g: CanvasRenderingContext2D) => void;
};

/** Draws the build onto `g`, whose current transform maps world cells to pixels. */
export function drawBuild(g: CanvasRenderingContext2D, paths: BoardPaths, opts: DrawBuildOptions): void {
  const { role, scale, grid, textures, labels } = opts;
  const wallWidth = Math.max(0.14, 2.5 / scale);
  const hairline = 1 / scale;
  g.save();
  if (paths.drawing.count > 0) {
    g.fillStyle = BASE_FLOOR;
    g.fill(paths.all);
    for (const [terrain, path] of paths.floors) {
      const img = textures[terrain];
      const pattern = img ? g.createPattern(img, "repeat") : null;
      if (pattern && img) {
        const k = TEXTURE_CELLS / img.naturalWidth;
        pattern.setTransform(new DOMMatrix([k, 0, 0, k, 0, 0]));
        g.fillStyle = pattern;
      } else {
        g.fillStyle = TERRAIN_COLORS[terrain];
      }
      g.fill(path);
    }
    // Pits, pillars and stairs, over their stone floor.
    g.fillStyle = "rgba(6, 6, 8, 0.92)";
    g.fill(paths.pits);
    g.strokeStyle = "rgba(255, 255, 255, 0.10)";
    g.lineWidth = 0.05;
    g.stroke(paths.pitRims);
    g.fillStyle = "#8f897e";
    g.fill(paths.pillars);
    g.strokeStyle = "#2a2723";
    g.lineWidth = 0.06;
    g.stroke(paths.pillars);
    g.fillStyle = "rgba(255, 255, 255, 0.16)";
    g.fill(paths.pillarShine);
    g.fillStyle = STAIR_SLAB;
    g.fill(paths.stairs);
    // The floor covers the map layer's grid, so the grid is drawn again on the floor.
    if (grid.show && paths.box) {
      g.save();
      g.clip(paths.all);
      g.globalAlpha = Number.isFinite(grid.opacity) ? grid.opacity : 0.25;
      g.strokeStyle = grid.color || "#ffffff";
      g.lineWidth = (grid.lineWidth > 0 ? grid.lineWidth : 1) / scale;
      g.beginPath();
      const { x0, y0, x1, y1 } = paths.box;
      for (let x = x0; x <= x1; x++) {
        g.moveTo(x, y0);
        g.lineTo(x, y1);
      }
      for (let y = y0; y <= y1; y++) {
        g.moveTo(x0, y);
        g.lineTo(x1, y);
      }
      g.stroke();
      g.restore();
    }
  }
  drawRelief(g, paths.relief, scale);
  drawStairs(g, paths.floorStairs, FLOOR_STAIRS);
  drawStairs(g, paths.artStairs, ART_STAIRS);
  opts.underWalls?.(g);
  // Every rim first, then every wall, so a rim never shows across a wall that meets it.
  for (const [color, width] of [
    [WALL_RIM, wallWidth + 3 / scale],
    [WALL_COLOR, wallWidth],
  ] as const) {
    g.strokeStyle = color;
    g.lineWidth = width;
    g.lineCap = "square";
    g.stroke(paths.walls);
    g.lineCap = "round";
    g.stroke(paths.freeWalls);
  }
  g.lineCap = "butt";
  g.fillStyle = WINDOW_FILL;
  g.fill(paths.panes);
  g.fillStyle = DOOR_FILL;
  g.fill(paths.leaves);
  g.fill(paths.openLeaves);
  g.strokeStyle = WALL_COLOR;
  g.lineWidth = Math.max(0.03, hairline);
  g.stroke(paths.panes);
  g.stroke(paths.leaves);
  g.stroke(paths.openLeaves);
  g.setLineDash([0.08, 0.08]);
  g.strokeStyle = "rgba(21, 18, 15, 0.7)";
  g.stroke(paths.swings);
  if (role === "dm") {
    g.save();
    g.lineCap = "round";
    g.setLineDash([0.12, 0.14]);
    g.strokeStyle = theme.color.accentSoft;
    g.lineWidth = Math.max(0.05, 2 / scale);
    g.stroke(paths.noWalls);
    g.restore();
    g.fillStyle = theme.color.accentSoft;
    g.fill(paths.locks);
    g.strokeStyle = theme.color.accentSoft;
    g.lineWidth = Math.max(0.04, 1.5 / scale);
    g.stroke(paths.secrets);
    g.setLineDash([]);
    for (const m of paths.secretMarks) drawLabel(g, { x: m.x, y: m.y, text: "S", size: 0.32 });
  }
  g.setLineDash([]);
  for (const label of labels) drawLabel(g, label);
  g.restore();
}

const SUN = "#ffd34d";
const SUN_OFF = "#8d8a84";
const SUN_EDGE = "#2a1f00";
const REACH_FILL = "rgba(255, 211, 77, 0.08)";
const REACH_LINE = "rgba(255, 211, 77, 0.6)";

/**
 * A scene's lights as the DM sees them in wave 3 (docs/design-v1-maps-vision.md
 * section 3.6): a small sun at each, the same size on screen at any zoom,
 * grey while the light is off. Never part of the map export: lights are
 * the DM's, and the export draws the map.
 */
export function drawSuns(g: CanvasRenderingContext2D, lights: readonly Light[], scale: number): void {
  const px = 1 / scale;
  g.save();
  g.lineCap = "round";
  for (const light of lights) {
    const color = light.on ? SUN : SUN_OFF;
    g.beginPath();
    for (let k = 0; k < 8; k++) {
      const c = Math.cos((k * Math.PI) / 4);
      const s = Math.sin((k * Math.PI) / 4);
      g.moveTo(light.x + c * 9 * px, light.y + s * 9 * px);
      g.lineTo(light.x + c * 13 * px, light.y + s * 13 * px);
    }
    g.strokeStyle = SUN_EDGE;
    g.lineWidth = 4.5 * px;
    g.stroke();
    g.strokeStyle = color;
    g.lineWidth = 2 * px;
    g.stroke();
    g.beginPath();
    g.arc(light.x, light.y, 6 * px, 0, Math.PI * 2);
    g.fillStyle = color;
    g.fill();
    g.strokeStyle = SUN_EDGE;
    g.lineWidth = 1.5 * px;
    g.stroke();
  }
  g.restore();
}

/**
 * The reach of the light picked in the builder, as faint rings: bright
 * light inside the solid ring, dim light out to the dashed one, in cells.
 * Its sun is ringed and its radii written under it.
 */
export function drawLightReach(
  g: CanvasRenderingContext2D,
  light: Pick<Light, "x" | "y">,
  reach: { bright: number; dim: number },
  caption: string,
  scale: number,
  /** The viewer's accent (state/accent.ts), around the light's sun. */
  ring: string,
): void {
  const px = 1 / scale;
  g.save();
  g.fillStyle = REACH_FILL;
  g.strokeStyle = REACH_LINE;
  g.lineWidth = 1.5 * px;
  if (reach.dim > reach.bright) {
    g.beginPath();
    g.arc(light.x, light.y, reach.dim, 0, Math.PI * 2);
    g.fill();
    g.setLineDash([6 * px, 5 * px]);
    g.stroke();
    g.setLineDash([]);
  }
  if (reach.bright > 0) {
    g.beginPath();
    g.arc(light.x, light.y, reach.bright, 0, Math.PI * 2);
    g.fill();
    g.stroke();
  }
  g.beginPath();
  g.arc(light.x, light.y, 17 * px, 0, Math.PI * 2);
  g.strokeStyle = ring;
  g.lineWidth = 2 * px;
  g.stroke();
  drawLabel(g, { x: light.x, y: light.y + 28 * px, text: caption, size: 13 * px });
  g.restore();
}
