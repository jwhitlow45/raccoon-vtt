import { FREE_WALL_LATTICE, type AutoWalls, type BuildChunk, type LightLevel, type Light, type Scene, type WallFeature } from "#shared/model.ts";
import { isHex, sceneGrid } from "#shared/rules/grid.ts";
import { effectiveEdges, indexBuild, PILLAR_INSET } from "#shared/rules/walls.ts";
import { clipSegment } from "./simplify.ts";

/**
 * A scene written as a Universal VTT file (docs/design/design-v1-uvtt-export.md):
 * the file's keys but its image, in Dungeondraft's order, and the counts the
 * export's notes read. Pure, so the tests run it through this app's own
 * import (roundtrip.prop.test.ts).
 *
 * Every coordinate is a cell on the 1/64 lattice, which JSON writes
 * exactly, with `map_origin` at 0, so file squares are scene cells. Pieces
 * work here in lattice units, whole numbers, so "on the grid" and "on the
 * scene's edge" are exact comparisons.
 */

const L = FREE_WALL_LATTICE;

export type UvttSource = {
  scene: Pick<Scene, "bounds" | "gridShape" | "autoWalls" | "vision">;
  chunks: readonly BuildChunk[];
  rule: AutoWalls;
  lights: readonly Light[];
  feetPerCell: number;
  pxPerCell: number;
};

export type UvttCounts = {
  /** DM view: secret doors written as plain doors. */
  secretAsDoors: number;
  /** DM view: lights switched off, left out. */
  lightsOff: number;
  /** Walls, doors and lights past the scene's edge, cut or left out. */
  clipped: number;
  /** A wall, door or window under SHORT_LATTICE long is written, which the import may collapse. */
  short: boolean;
  walls: number;
  doors: number;
  windows: number;
  lights: number;
};

export type UvttHead = { json: Record<string, unknown>; counts: UvttCounts };

/**
 * The import drops a line under a tenth of a square and welds ends within a
 * tenth (simplify.ts mergeClose, snap.ts), so a piece shorter than 7/64 is
 * written lengthened to 7/64, and one under 14/64 is disclosed, since two
 * welds can still close it up.
 */
export const MIN_LATTICE = 7;
export const SHORT_LATTICE = 14;

/** Dungeondraft's ambient light for each level: white, mid grey and black, read back by vision/uvttLight.ts as the same level. */
export const AMBIENT: Record<LightLevel, string> = { bright: "ffffffff", dim: "ff808080", dark: "ff000000" };

type Kind = "wall" | "door" | "window";
/** A piece in lattice units. */
type Piece = { ax: number; ay: number; bx: number; by: number };

export function uvttGeometry(src: UvttSource, view: "player" | "dm"): UvttHead {
  const { w, h } = src.scene.bounds;
  const W = w * L;
  const H = h * L;
  const build = indexBuild(src.chunks);
  const counts: UvttCounts = { secretAsDoors: 0, lightsOff: 0, clipped: 0, short: false, walls: 0, doors: 0, windows: 0, lights: 0 };
  const lines: Piece[] = [];
  const objects: Piece[][] = [];
  const portals: { p: Piece; kind: Kind }[] = [];

  const kindOf = (f: WallFeature): Kind => {
    if (f.kind !== "door") return f.kind;
    // The writer's own rule as well as the projection's: a player view file never holds a door players have not found.
    if (view === "player" && f.secret && !f.discovered) return "wall";
    return "door";
  };
  /** A DM view's secret door, counted once it is written, so one past the scene's edge counts as cut and not as a door too. */
  const secretDoor = (f: WallFeature) => view === "dm" && f.kind === "door" && f.secret;
  /** One piece clipped to the scene and lengthened, or null where nothing of it is inside. */
  const fit = (p: Piece): Piece | null => {
    const cut = clipSegment({ x: p.ax, y: p.ay }, { x: p.bx, y: p.by }, W, H);
    if (!cut || cut[2] || cut[3]) counts.clipped++;
    if (!cut) return null;
    const q = lengthened({ ax: Math.round(cut[0].x), ay: Math.round(cut[0].y), bx: Math.round(cut[1].x), by: Math.round(cut[1].y) }, W, H);
    if (!q) return null;
    if (lengthOf(q) < SHORT_LATTICE) counts.short = true;
    return q;
  };
  const put = (p: Piece, kind: Kind, secret = false) => {
    const q = fit(p);
    if (!q) return;
    if (secret) counts.secretAsDoors++;
    if (kind === "wall") lines.push(q);
    else portals.push({ p: q, kind });
  };

  // A hex scene has no walls on grid lines (docs/design/design-v1-hex-grids.md HX-D7), and effectiveEdges reads squares.
  if (!isHex(sceneGrid(src.scene))) {
    const runs = new Map<string, number[]>();
    for (const e of effectiveEdges(build, src.rule)) {
      const kind = kindOf(e.feature);
      if (kind !== "wall") {
        put(e.side === "n" ? { ax: e.x * L, ay: e.y * L, bx: (e.x + 1) * L, by: e.y * L } : { ax: e.x * L, ay: e.y * L, bx: e.x * L, by: (e.y + 1) * L }, kind, secretDoor(e.feature));
        continue;
      }
      // Walls merge into runs along each grid line: a north edge runs along its row, a west edge down its column.
      const line = e.side === "n" ? `n${e.y}` : `w${e.x}`;
      const at = runs.get(line);
      if (at) at.push(e.side === "n" ? e.x : e.y);
      else runs.set(line, [e.side === "n" ? e.x : e.y]);
    }
    for (const [line, steps] of runs) {
      const fixed = Number(line.slice(1)) * L;
      steps.sort((a, b) => a - b);
      let start = steps[0]!;
      for (let i = 1; i <= steps.length; i++) {
        if (i < steps.length && steps[i] === steps[i - 1]! + 1) continue;
        const end = steps[i - 1]! + 1;
        put(line[0] === "n" ? { ax: start * L, ay: fixed, bx: end * L, by: fixed } : { ax: fixed, ay: start * L, bx: fixed, by: end * L }, "wall");
        if (i < steps.length) start = steps[i]!;
      }
    }
  }
  for (const { wall } of build.free) {
    put({ ax: Math.round(wall.a[0] * L), ay: Math.round(wall.a[1] * L), bx: Math.round(wall.b[0] * L), by: Math.round(wall.b[1] * L) }, kindOf(wall.f), secretDoor(wall.f));
  }

  // A pillar is its cell's square at PILLAR_INSET, as walls.ts blocks it: one closed line, or its sides one by one where the edge cuts it.
  const lo = PILLAR_INSET * L;
  const hi = L - lo;
  for (const [id, terrain] of build.cells) {
    if (terrain !== "pillar") continue;
    const x = (id % 2048) * L;
    const y = Math.floor(id / 2048) * L;
    const ring: Piece[] = [
      { ax: x + lo, ay: y + lo, bx: x + hi, by: y + lo },
      { ax: x + hi, ay: y + lo, bx: x + hi, by: y + hi },
      { ax: x + hi, ay: y + hi, bx: x + lo, by: y + hi },
      { ax: x + lo, ay: y + hi, bx: x + lo, by: y + lo },
    ];
    if (x + lo >= 0 && y + lo >= 0 && x + hi <= W && y + hi <= H) {
      objects.push(ring);
      continue;
    }
    const before = counts.clipped;
    for (const side of ring) {
      const q = fit(side);
      if (q) objects.push([q]);
    }
    // One pillar cut is one thing past the edge, not four.
    counts.clipped = Math.min(counts.clipped, before + 1);
  }

  const lights: Record<string, unknown>[] = [];
  if (view === "dm") {
    for (const light of src.lights) {
      if (!light.on) {
        counts.lightsOff++;
        continue;
      }
      if (light.x < 0 || light.y < 0 || light.x > w || light.y > h) {
        counts.clipped++;
        continue;
      }
      lights.push({ position: { x: light.x, y: light.y }, range: (light.bright + light.dim) / src.feetPerCell, intensity: 1, color: fileColor(light.color), shadows: light.walls });
    }
  }

  counts.walls = lines.length + objects.length;
  counts.doors = portals.filter((p) => p.kind === "door").length;
  counts.windows = portals.length - counts.doors;
  counts.lights = lights.length;
  const point = (x: number, y: number) => ({ x: x / L, y: y / L });
  const json: Record<string, unknown> = {
    format: 0.3,
    software: "Raccoon VTT",
    resolution: { map_origin: { x: 0, y: 0 }, map_size: { x: w, y: h }, pixels_per_grid: src.pxPerCell },
    line_of_sight: lines.map((p) => [point(p.ax, p.ay), point(p.bx, p.by)]),
    objects_line_of_sight: objects.map((ring) => [point(ring[0]!.ax, ring[0]!.ay), ...ring.map((p) => point(p.bx, p.by))]),
    portals: portals.map(({ p, kind }) => ({
      position: point((p.ax + p.bx) / 2, (p.ay + p.by) / 2),
      bounds: [point(p.ax, p.ay), point(p.bx, p.by)],
      rotation: Math.atan2(p.by - p.ay, p.bx - p.ax),
      // The import reads an open portal as a window, window first, so every door is written closed, an open one included.
      closed: kind === "door",
      freestanding: false,
    })),
    environment: { baked_lighting: false, ambient_light: AMBIENT[src.scene.vision?.light ?? "bright"] },
    lights,
  };
  return { json, counts };
}

/** Dungeondraft's ARGB: `ff` and the first six hex digits of the light's color, a stored alpha dropped, else white. */
export function fileColor(color: string | undefined): string {
  const hex = /^#?([0-9a-f]{6})/i.exec(color?.trim() ?? "")?.[1];
  return hex ? `ff${hex.toLowerCase()}` : "ffffffff";
}

function lengthOf(p: Piece): number {
  return Math.hypot(p.bx - p.ax, p.by - p.ay);
}

/**
 * A piece at least MIN_LATTICE long, grown along its own line about its
 * midpoint, as far as the scene allows on each side: an end on the edge
 * stays there and the other end takes the whole growth, so the import's
 * clip cannot cut it short again. Each moved end rounds outward onto the
 * lattice, away from the midpoint, which never shortens it and never
 * leaves the scene, whose edges are whole numbers. A piece the scene has
 * no room to grow keeps what it can. Null for a piece of no length.
 */
export function lengthened(p: Piece, W: number, H: number): Piece | null {
  const len = lengthOf(p);
  if (len === 0) return null;
  if (len >= MIN_LATTICE) return p;
  const ux = (p.bx - p.ax) / len;
  const uy = (p.by - p.ay) / len;
  // How far each end may move outward before it leaves the scene.
  const room = (x: number, y: number, dx: number, dy: number) => {
    let t = Infinity;
    if (dx > 0) t = Math.min(t, (W - x) / dx);
    if (dx < 0) t = Math.min(t, -x / dx);
    if (dy > 0) t = Math.min(t, (H - y) / dy);
    if (dy < 0) t = Math.min(t, -y / dy);
    return Math.max(0, t);
  };
  const roomA = room(p.ax, p.ay, -ux, -uy);
  const roomB = room(p.bx, p.by, ux, uy);
  const need = MIN_LATTICE - len;
  let growA = Math.min(need / 2, roomA);
  const growB = Math.min(need - growA, roomB);
  growA = Math.min(need - growB, roomA);
  const out = (v: number, dir: number) => (dir > 0 ? Math.ceil(v - 1e-9) : dir < 0 ? Math.floor(v + 1e-9) : v);
  return {
    ax: growA > 0 ? out(p.ax - ux * growA, -ux) : p.ax,
    ay: growA > 0 ? out(p.ay - uy * growA, -uy) : p.ay,
    bx: growB > 0 ? out(p.bx + ux * growB, ux) : p.bx,
    by: growB > 0 ? out(p.by + uy * growB, uy) : p.by,
  };
}
