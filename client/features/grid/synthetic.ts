import type { Pixels } from "./detect.ts";

/**
 * Map images drawn by code for the grid finder's tests
 * (docs/design-v1-grid-detect.md section 4). Never third-party art: each
 * image is procedural noise, gradients and patterns, with a grid of known
 * size and offset drawn over it. Only the tests and the evaluation script
 * import this.
 */

export type SynthGrid = {
  cellPx: number;
  /** A different size down than across, for the unsquare case. */
  cellPxY?: number;
  /** Where a pair of lines cross, px. */
  origin: { x: number; y: number };
  /** Line width, px. */
  width?: number;
  /** The lines' gray level and how much they cover what is under them. */
  gray?: number;
  opacity?: number;
  /** Lines only inside this rectangle: a grid within a margin. */
  within?: { x: number; y: number; w: number; h: number };
  /** Lines only where the art is floor: a grid hidden under walls and void. */
  floorOnly?: boolean;
  /** Dashes this long with gaps as long, px. */
  dash?: number;
  /** Degrees, about the image's center. */
  rotate?: number;
};

/**
 * A hex grid drawn over the art, laid as the app lays its hexes
 * (docs/design-v1-hex-grids.md section 4.1): on hex rows the tops are
 * pointed and a row runs straight across, and hex columns are the same
 * with x and y swapped.
 */
export type SynthHexGrid = {
  orient: "rows" | "columns";
  /** The distance between neighboring hex centers, across the flats: the app's cell, px. */
  cellPx: number;
  /** One hex's center, px. */
  center: { x: number; y: number };
  /** Line width, px. */
  width?: number;
  /** The lines' gray level and how much they cover what is under them. */
  gray?: number;
  opacity?: number;
  /** Lines only where the art is floor. */
  floorOnly?: boolean;
  /** Degrees, about the image's center. */
  rotate?: number;
};

export type Art =
  | { kind: "noise"; scale: number; amp: number }
  | { kind: "gradient"; from: number; to: number }
  | { kind: "tiles"; size: number; offset?: number; grout: number; depth: number }
  | { kind: "planks"; height: number; length: number; depth: number }
  | { kind: "bricks"; width: number; height: number; depth: number }
  | { kind: "checker"; size: number; amp: number }
  | { kind: "hex"; size: number; depth: number; width: number }
  | { kind: "rooms"; count: number; wall: number };

export type SynthMap = {
  width: number;
  height: number;
  seed: number;
  /** The floor's gray level before any art. */
  base?: number;
  art: Art[];
  grid?: SynthGrid;
  hexGrid?: SynthHexGrid;
  /** Gaussian noise per pixel, gray levels. */
  noise?: number;
  /** A random offset per 8 by 8 block, like JPEG's blocking at a low quality, gray levels. */
  blocks?: number;
};

/** A small, fast, seeded generator (mulberry32). */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hash(x: number, y: number, seed: number): number {
  let h = Math.imul(x, 374761393) + Math.imul(y, 668265263) + Math.imul(seed, 2147483647);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

/** Smooth value noise in [0, 1) at lattice spacing `scale`. */
function valueNoise(x: number, y: number, scale: number, seed: number): number {
  const fx = x / scale;
  const fy = y / scale;
  const ix = Math.floor(fx);
  const iy = Math.floor(fy);
  const tx = fx - ix;
  const ty = fy - iy;
  const sx = tx * tx * (3 - 2 * tx);
  const sy = ty * ty * (3 - 2 * ty);
  const a = hash(ix, iy, seed);
  const b = hash(ix + 1, iy, seed);
  const c = hash(ix, iy + 1, seed);
  const d = hash(ix + 1, iy + 1, seed);
  return a + (b - a) * sx + (c - a) * sy + (a - b - c + d) * sx * sy;
}

function fbm(x: number, y: number, scale: number, seed: number): number {
  let sum = 0;
  let amp = 0.5;
  let s = scale;
  for (let o = 0; o < 4; o++) {
    sum += amp * (valueNoise(x, y, s, seed + o * 101) - 0.5);
    amp /= 2;
    s /= 2;
  }
  return sum;
}

function gauss(next: () => number): number {
  const u = Math.max(1e-12, next());
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * next());
}

/** How much of a pixel a line `width` wide covers, from its center's distance to the line. */
function coverage(dist: number, width: number): number {
  return Math.min(1, Math.max(0, width / 2 + 0.5 - dist));
}

function distToLines(u: number, origin: number, period: number): number {
  const t = (((u - origin) % period) + period) % period;
  return Math.min(t, period - t);
}

type Room = { x: number; y: number; w: number; h: number };

function roomsOf(width: number, height: number, count: number, next: () => number): Room[] {
  const rooms: Room[] = [];
  for (let i = 0; i < count; i++) {
    const w = width * (0.15 + 0.3 * next());
    const h = height * (0.15 + 0.3 * next());
    rooms.push({ x: next() * (width - w), y: next() * (height - h), w, h });
  }
  return rooms;
}

/** A grayscale map, one byte per pixel. */
export function drawMap(spec: SynthMap): Pixels {
  const { width: W, height: H, seed } = spec;
  const next = rng(seed);
  const out = new Uint8Array(W * H);
  const base = spec.base ?? 150;
  const rooms = spec.art.flatMap((a) => (a.kind === "rooms" ? [{ rooms: roomsOf(W, H, a.count, next), wall: a.wall }] : []));
  const floorAt = (x: number, y: number) =>
    rooms.length === 0 || rooms.some((set) => set.rooms.some((r) => x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h));
  const stagger = new Map<number, number>();
  const offsetOf = (row: number, salt: number) => {
    const key = row * 31 + salt;
    let v = stagger.get(key);
    if (v === undefined) {
      v = hash(row, salt, seed);
      stagger.set(key, v);
    }
    return v;
  };
  const g = spec.grid;
  const cos = g?.rotate ? Math.cos((g.rotate * Math.PI) / 180) : 1;
  const sin = g?.rotate ? Math.sin((g.rotate * Math.PI) / 180) : 0;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const cx = x + 0.5;
      const cy = y + 0.5;
      let v = base;
      const floor = floorAt(cx, cy);
      for (const art of spec.art) {
        switch (art.kind) {
          case "noise":
            v += art.amp * fbm(cx, cy, art.scale, seed);
            break;
          case "gradient":
            v += art.from + ((art.to - art.from) * (cx + cy)) / (W + H);
            break;
          case "tiles": {
            const o = art.offset ?? 0;
            const d = Math.min(distToLines(cx, o, art.size), distToLines(cy, o, art.size));
            v -= art.depth * coverage(d, art.grout);
            v += 12 * (hash(Math.floor((cx - o) / art.size), Math.floor((cy - o) / art.size), seed) - 0.5);
            break;
          }
          case "planks": {
            const row = Math.floor(cy / art.height);
            const joint = distToLines(cx, offsetOf(row, 1) * art.length, art.length);
            const d = Math.min(distToLines(cy, 0, art.height), joint);
            v -= art.depth * coverage(d, 1.5);
            v += 16 * (hash(row, Math.floor(cx / art.length + offsetOf(row, 1)), seed) - 0.5);
            break;
          }
          case "bricks": {
            const row = Math.floor(cy / art.height);
            const shift = row % 2 ? art.width / 2 : 0;
            const d = Math.min(distToLines(cy, 0, art.height), distToLines(cx, shift, art.width));
            v -= art.depth * coverage(d, 2);
            v += 14 * (hash(row, Math.floor((cx - shift) / art.width), seed) - 0.5);
            break;
          }
          case "checker": {
            const odd = (Math.floor(cx / art.size) + Math.floor(cy / art.size)) % 2;
            v += odd ? art.amp : -art.amp;
            break;
          }
          case "hex": {
            v -= art.depth * coverage(hexEdgeDistance(cx, cy, art.size), art.width);
            break;
          }
          case "rooms": {
            if (!floor) {
              v = 35 + 10 * fbm(cx, cy, 40, seed + 7);
            } else {
              for (const set of rooms) {
                for (const r of set.rooms) {
                  const d = Math.min(Math.abs(cx - r.x), Math.abs(cx - r.x - r.w), Math.abs(cy - r.y), Math.abs(cy - r.y - r.h));
                  if (d < set.wall) v = 40;
                }
              }
            }
            break;
          }
        }
      }
      if (g && (!g.floorOnly || floor)) {
        const inside = !g.within || (cx >= g.within.x && cx < g.within.x + g.within.w && cy >= g.within.y && cy < g.within.y + g.within.h);
        if (inside) {
          const dx = cx - W / 2;
          const dy = cy - H / 2;
          const u = W / 2 + dx * cos + dy * sin;
          const w = H / 2 - dx * sin + dy * cos;
          const lw = g.width ?? 1.5;
          let cov = Math.max(coverage(distToLines(u, g.origin.x, g.cellPx), lw), coverage(distToLines(w, g.origin.y, g.cellPxY ?? g.cellPx), lw));
          if (g.dash) {
            const along = coverage(distToLines(u, g.origin.x, g.cellPx), lw) > 0 ? w : u;
            if (Math.floor(along / g.dash) % 2) cov = 0;
          }
          const a = (g.opacity ?? 0.5) * cov;
          v = v * (1 - a) + (g.gray ?? 0) * a;
        }
      }
      const hg = spec.hexGrid;
      if (hg && (!hg.floorOnly || floor)) {
        const a = (hg.opacity ?? 0.5) * coverage(hexLineDistance(cx, cy, hg, W, H), hg.width ?? 1.5);
        v = v * (1 - a) + (hg.gray ?? 0) * a;
      }
      out[y * W + x] = Math.max(0, Math.min(255, Math.round(v)));
    }
  }
  if (spec.noise || spec.blocks) {
    for (let by = 0; by < H; by += 8) {
      for (let bx = 0; bx < W; bx += 8) {
        const shift = spec.blocks ? (next() - 0.5) * 2 * spec.blocks : 0;
        for (let y = by; y < Math.min(H, by + 8); y++) {
          for (let x = bx; x < Math.min(W, bx + 8); x++) {
            const i = y * W + x;
            out[i] = Math.max(0, Math.min(255, Math.round(out[i]! + shift + (spec.noise ? spec.noise * gauss(next) : 0))));
          }
        }
      }
    }
  }
  return { width: W, height: H, data: out, channels: 1 };
}

/** Distance from a point to the nearest edge of a pointy-top hex grid of corner radius `size`. */
function hexEdgeDistance(x: number, y: number, size: number): number {
  const apothem = (size * Math.sqrt(3)) / 2;
  const rowStep = 1.5 * size;
  const row = Math.round(y / rowStep);
  let best = Infinity;
  for (let j = row - 1; j <= row + 1; j++) {
    const shift = j % 2 ? apothem : 0;
    const col = Math.round((x - shift) / (2 * apothem));
    for (let i = col - 1; i <= col + 1; i++) {
      const dx = Math.abs(x - (shift + i * 2 * apothem));
      const dy = Math.abs(y - j * rowStep);
      const h = Math.max(dx, 0.5 * dx + (Math.sqrt(3) / 2) * dy);
      best = Math.min(best, apothem - h >= 0 ? apothem - h : Infinity);
    }
  }
  return best === Infinity ? 0 : best;
}

/**
 * Distance from a pixel to the nearest side of a drawn hex grid. The hex
 * holding a point is the one whose center is nearest by the hex's own
 * measure, the largest of its three distances along the sides' normals,
 * and the side is half a cell out from its center along one of them.
 */
function hexLineDistance(x: number, y: number, g: SynthHexGrid, W: number, H: number): number {
  const turn = ((g.rotate ?? 0) * Math.PI) / 180;
  const dx = x - W / 2;
  const dy = y - H / 2;
  const tx = W / 2 + dx * Math.cos(turn) + dy * Math.sin(turn) - g.center.x;
  const ty = H / 2 - dx * Math.sin(turn) + dy * Math.cos(turn) - g.center.y;
  const [u, v] = g.orient === "rows" ? [tx, ty] : [ty, tx];
  const c = g.cellPx;
  const rowStep = (c * Math.sqrt(3)) / 2;
  const row = Math.round(v / rowStep);
  let nearest = Infinity;
  for (let j = row - 1; j <= row + 1; j++) {
    const shift = j % 2 ? c / 2 : 0;
    const col = Math.round((u - shift) / c);
    for (let i = col - 1; i <= col + 1; i++) {
      const px = u - (shift + i * c);
      const py = v - j * rowStep;
      const along = (Math.sqrt(3) / 2) * py;
      nearest = Math.min(nearest, Math.max(Math.abs(px), Math.abs(0.5 * px + along), Math.abs(-0.5 * px + along)));
    }
  }
  return c / 2 - nearest;
}

/** The same image as RGBA, as a canvas's `getImageData` hands it over. */
export function toRgba(px: Pixels): Pixels {
  const out = new Uint8ClampedArray(px.width * px.height * 4);
  for (let i = 0; i < px.width * px.height; i++) {
    const v = px.data[i]!;
    out[i * 4] = v;
    out[i * 4 + 1] = v;
    out[i * 4 + 2] = v;
    out[i * 4 + 3] = 255;
  }
  return { width: px.width, height: px.height, data: out, channels: 4 };
}
