import { CHUNK_CELLS, type BuildChunk, type FogTile } from "#shared/model.ts";
import { isHex, SQUARES, type Grid } from "#shared/rules/grid.ts";
import { HEX_R, HEX_S } from "#shared/rules/hex.ts";
import type { GroundCell } from "../../lib/groundCells.ts";
import { keySpan, neighborOf } from "../../lib/groundCells.ts";
import type { Turn } from "../../lib/view.ts";
import type { BandDraw } from "../../features/areas/volume.ts";
import type { VolumeLook } from "./drawRelief.ts";
import { boundsOf, cellPieces, keyOf, localKeyOf, polyBox, RANK, sortKey, wallItems, type CellPiece, type PieceSource, type PitRegion, type StaticPiece, type VBox } from "./pieces.ts";
import type { WallPiece } from "./runs.ts";

/**
 * The depth list (docs/design-v1-isometric-view.md 5.6 and 5.7). Pieces
 * live in 16 by 16 buckets, one per build chunk, each sorted at a turn when
 * it first comes into view at that turn, with the union of its pieces'
 * full projected bounds for culling. A bucket is rebuilt only when what it
 * reads changes: its chunk or a neighbor's (heights, terrain, stairs), the
 * fog tiles under them (the viewer's seen ground), its wall pieces, or
 * whatever the caller passes as `global` (the stand threshold, the feet per
 * cell, the side looks). The store replaces each of those objects on every
 * change, so identity says when.
 *
 * Standees are placed among the pieces per layout by the own-cells rule:
 * a standee draws after every cell of its footprint whose drawn ground is at
 * or below its base, and before every one above it, so a Large's ring stays
 * whole on a platform and a token inside the ground is hidden by its cells.
 * A carried token draws after its holder. Ties draw columns, then pits,
 * then walls, then volumes, then standees, then by id.
 *
 * An area standing as its real shape (docs/design-v1-iso-area-shapes.md
 * 4.3) comes in as depth bands one cell deep, each keyed at its middle. A
 * band meets the statics by key. Against the standees it goes by their
 * natural keys, their footprints' middles, never the keys the own-cells
 * and holder rules raise them to: a band draws after the last placed
 * standee whose natural key is below its own, and before every one placed
 * after that. A natural key equal to the band's falls to the tie order,
 * which draws the band first. So a band never draws before a standee it
 * lies in front of, and a flier inside a sphere draws between its far
 * bands and its near ones. The error is at most that standee's raise, a
 * column, wall or standee nearer than the band taking its tint. Bands give
 * no silhouettes, being see-through.
 *
 * On hexes a bucket is 16 by 16 hex keys (docs/design-v1-iso-hex-relief.md
 * 9). It reads its own chunk and all eight around it, since a hex's six
 * neighbors reach diagonal chunks, and every fog tile its hexes and their
 * neighbors touch, found by world position, never by the chunk's index.
 * Pits side by side form connected regions across buckets, made again
 * after any bucket is rebuilt, so an edit that joins or parts two regions
 * reaches the pits of buckets that kept their pieces.
 */

/** A standee as the layout reads it. */
export type StandeeIn = {
  id: string;
  /** Its footprint's center on the ground, in cells: its depth key. */
  x: number;
  y: number;
  /** The cells it stands on, for the own-cells rule: its actual hexes on hexes (groundCells.ts footprintCells). */
  cells: readonly GroundCell[];
  /** Its drawn base, in cells (view.ts drawnBase). */
  base: number;
  /** The token it rides, when it rides one this layout holds. */
  holder: string | null;
  /** Its full projected bounds, art, ring, stem, shadow and decor, in view units: what culls it. */
  bounds: VBox;
  /** Its art box in view units: what a later piece covers to give it a silhouette. */
  art: VBox;
  /** Always laid out, culled or not: the token being dragged here or selected, whose node must not go away. */
  keep?: boolean;
};

/** One depth band of an area standing as its real shape: what each bucket in view draws of it, and its box at this turn. */
export type VolumePiece = {
  kind: "volume";
  /** `v<area>:<band>`, for the tie order. */
  id: string;
  area: string;
  band: number;
  /** Its key in the depth list: its middle (volume.ts bandKey). */
  key: number;
  draws: readonly BandDraw[];
  bounds: VBox;
  look: VolumeLook;
  /** The openings at 0 of the pit regions under the area, world polygons, which clip what lies inside them (design 4.3, Pits). */
  pits: readonly (readonly { x: number; y: number }[])[];
};

/** What a run draws: the relief's pieces and areas' bands. */
export type DrawPiece = StaticPiece | VolumePiece;

/** Between walls and standees in a tie (design 4.3). */
const VOLUME_RANK = 2.5;

/** One entry of the drawing order: a run of pieces drawn by one shape, or a standee. */
export type Item =
  | { kind: "run"; pieces: DrawPiece[] }
  | {
      kind: "standee";
      id: string;
      /** A later piece covers its art, so the overlay draws its outline (5.6). */
      silhouette: boolean;
      /** The openings of the pit regions it stands in that meet its bounds, which clip it so the near rim hides what is below (5.5). */
      pits: CellPiece[];
    };

type TurnData = { order: StaticPiece[]; keys: number[]; locals: number[]; bounds: VBox[]; union: VBox };

type Bucket = {
  key: string;
  pieces: StaticPiece[];
  sig: readonly unknown[];
  cells: Map<number, CellPiece>;
  turns: Map<Turn, TurnData>;
};

const EMPTY_BOX: VBox = { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity };

/** View units a side of the grid a region's openings are filed in: a few cells, so a box asks a handful of its squares. */
const OPENING_STEP = 2;

type OpeningGrid = { boxes: VBox[]; cells: Map<string, number[]>; asked: WeakMap<object, CellPiece[]> };

/** A region's openings at 0, boxed at a turn and filed by the squares of view space they meet. */
function openingGrid(region: PitRegion, turn: Turn): OpeningGrid {
  const boxes = region.cells.map((c) => polyBox(turn, c.poly, 0, 0));
  const cells = new Map<string, number[]>();
  boxes.forEach((b, i) => {
    for (let gy = Math.floor(b.y0 / OPENING_STEP); gy <= Math.floor(b.y1 / OPENING_STEP); gy++) {
      for (let gx = Math.floor(b.x0 / OPENING_STEP); gx <= Math.floor(b.x1 / OPENING_STEP); gx++) {
        const key = `${gx},${gy}`;
        const list = cells.get(key);
        if (list) list.push(i);
        else cells.set(key, [i]);
      }
    }
  });
  return { boxes, cells, asked: new WeakMap() };
}

/** A bucket's own chunk and the four beside it: a square's sides reach no further. */
const FIVE = [
  [0, 0],
  [0, -1],
  [1, 0],
  [0, 1],
  [-1, 0],
] as const;

/** A hex bucket's own chunk and all eight around it: a hex's neighbors reach the diagonal chunks too. */
const NINE = [
  [0, 0],
  [0, -1],
  [1, -1],
  [1, 0],
  [1, 1],
  [0, 1],
  [-1, 1],
  [-1, 0],
  [-1, -1],
] as const;

/**
 * The fog tiles a hex bucket's hexes and their neighbors touch, by world
 * position: a hex bucket's index is not a tile's, since hex rows are √3/2
 * apart and hex columns swap the axes. Each tile's own key and its
 * explored layer's.
 */
function hexTiles(grid: Grid, sceneId: string, cx: number, cy: number): string[] {
  const along = { x0: cx * CHUNK_CELLS - 1, x1: (cx + 1) * CHUNK_CELLS + 1.5 };
  const across = { y0: (cy * CHUNK_CELLS - 1) * HEX_S, y1: ((cy + 1) * CHUNK_CELLS + 1) * HEX_S + 2 * HEX_R };
  const box = isHex(grid) && grid.orient === "columns" ? { x0: (cx * CHUNK_CELLS - 1) * HEX_S, x1: ((cx + 1) * CHUNK_CELLS + 1) * HEX_S + 2 * HEX_R, y0: cy * CHUNK_CELLS - 1, y1: (cy + 1) * CHUNK_CELLS + 1.5 } : { ...along, ...across };
  const out: string[] = [];
  for (let ty = Math.max(0, Math.floor(box.y0 / CHUNK_CELLS)); ty <= Math.floor(box.y1 / CHUNK_CELLS); ty++) {
    for (let tx = Math.max(0, Math.floor(box.x0 / CHUNK_CELLS)); tx <= Math.floor(box.x1 / CHUNK_CELLS); tx++) {
      out.push(`${sceneId}:${tx},${ty}`, `explored:${sceneId}:${tx},${ty}`);
    }
  }
  return out;
}

export function meets(a: VBox, b: VBox): boolean {
  return a.x0 <= b.x1 && a.x1 >= b.x0 && a.y0 <= b.y1 && a.y1 >= b.y0;
}

function sameSig(a: readonly unknown[], b: readonly unknown[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/** Compares two entries of the drawing order: depth, then kind, then a hex wall's own depth in its host, then id. */
function before(ka: number, ra: number, ia: string, kb: number, rb: number, ib: string, la = 0, lb = 0): boolean {
  if (ka !== kb) return ka < kb;
  if (ra !== rb) return ra < rb;
  if (la !== lb) return la < lb;
  return ia < ib;
}

export type SyncInput = {
  sceneId: string;
  bounds: { w: number; h: number };
  chunks: Readonly<Record<string, BuildChunk | undefined>>;
  /** The viewer's fog tiles, or null for a viewer who sees all the ground. */
  tiles: Readonly<Record<string, FogTile | undefined>> | null;
  /** Standing wall pieces by bucket key, as groupWalls keeps them. */
  walls: ReadonlyMap<string, readonly WallPiece[]>;
  /** Whatever else every piece reads: rebuilt everywhere when it changes. */
  global: unknown;
  src: PieceSource;
  /** The scene's grid. Squares when left out. */
  grid?: Grid;
};

export class ReliefIndex {
  readonly #buckets = new Map<string, Bucket>();
  #across = 0;
  #grid: Grid = SQUARES;
  /** The pit regions, made again after any bucket is rebuilt. */
  #regions: PitRegion[] = [];
  /** Each region's openings at a turn, boxed and filed in a grid of view space, found again with the regions. */
  #openings = new Map<Turn, Map<PitRegion, OpeningGrid>>();
  /** Whether the regions have been found since the index was made. */
  #found = false;
  /** How many buckets the last sync rebuilt, for the tests and the bench. */
  rebuilt = 0;

  /** Rebuilds every bucket whose inputs changed, and drops buckets past the scene's edge. */
  sync(input: SyncInput): void {
    const { sceneId, chunks, tiles } = input;
    const grid = input.grid ?? input.src.grid ?? SQUARES;
    const src: PieceSource = input.src.grid ? input.src : { ...input.src, grid };
    const span = keySpan(grid, input.bounds);
    const across = Math.max(1, Math.ceil(span.cols / CHUNK_CELLS));
    const down = Math.max(1, Math.ceil(span.rows / CHUNK_CELLS));
    this.#across = across;
    if (this.#grid !== grid) this.#buckets.clear();
    this.#grid = grid;
    this.rebuilt = 0;
    const seen = new Set<string>();
    const hex = isHex(grid);
    const around = hex ? NINE : FIVE;
    for (let cy = 0; cy < down; cy++) {
      for (let cx = 0; cx < across; cx++) {
        const key = `${cx},${cy}`;
        seen.add(key);
        const at = (dx: number, dy: number) => `${sceneId}:${cx + dx},${cy + dy}`;
        // The scene's size decides which cells a bucket holds and what lies past its edge, so a resize rebuilds it.
        const sig = [
          input.global,
          input.bounds.w,
          input.bounds.h,
          grid,
          input.walls.get(key),
          ...around.flatMap(([dx, dy]) => [chunks[at(dx!, dy!)], !hex && tiles ? tiles[at(dx!, dy!)] : null]),
          ...(hex && tiles ? hexTiles(grid, sceneId, cx, cy).map((k) => tiles[k]) : []),
        ];
        const old = this.#buckets.get(key);
        if (old && sameSig(old.sig, sig)) continue;
        this.rebuilt++;
        const cellList = cellPieces(src, cx, cy, chunks[at(0, 0)]);
        const cells = new Map<number, CellPiece>();
        for (const c of cellList) cells.set(c.y * 1_000_000 + c.x, c);
        const pieces: StaticPiece[] = [...cellList, ...wallItems(src, input.walls.get(key) ?? [])];
        this.#buckets.set(key, { key, pieces, sig, cells, turns: new Map() });
      }
    }
    for (const key of this.#buckets.keys()) if (!seen.has(key)) this.#buckets.delete(key);
    if (this.rebuilt > 0 || !this.#found) this.#findRegions();
  }

  /**
   * Connects pits side by side into regions (D-261030-461), every pit's
   * region and every wall's under 0 set again. Read from drawn ground only,
   * so an unseen pit joins nothing.
   */
  #findRegions(): void {
    const pits: CellPiece[] = [];
    for (const b of this.#buckets.values()) for (const c of b.cells.values()) if (c.kind === "pit") pits.push(c);
    const parent = new Map<CellPiece, CellPiece>();
    const find = (c: CellPiece): CellPiece => {
      let r = c;
      while (parent.get(r) !== r) r = parent.get(r)!;
      let at = c;
      while (parent.get(at) !== r) {
        const next = parent.get(at)!;
        parent.set(at, r);
        at = next;
      }
      return r;
    };
    for (const c of pits) parent.set(c, c);
    for (const c of pits) {
      for (let i = 0; i < c.sides.length; i++) {
        if (c.around[i]! >= 0) continue;
        const n = this.#neighbor(c, i);
        if (!n || n.kind !== "pit") continue;
        const a = find(c);
        const b = find(n);
        if (a !== b) parent.set(a, b);
      }
    }
    const byRoot = new Map<CellPiece, PitRegion>();
    const regions: PitRegion[] = [];
    // Each region in the cells' own order, so its clip path comes out the same every time.
    pits.sort((a, b) => a.y - b.y || a.x - b.x);
    for (const c of pits) {
      const root = find(c);
      let r = byRoot.get(root);
      if (!r) {
        r = { id: regions.length, cells: [] };
        byRoot.set(root, r);
        regions.push(r);
      }
      r.cells.push(c);
      c.region = r;
    }
    for (const b of this.#buckets.values()) {
      for (const p of b.pieces) {
        if (p.kind !== "wall") continue;
        p.region = p.base < 0 ? this.#regionUnder(p) : undefined;
      }
    }
    this.#regions = regions;
    this.#openings = new Map();
    this.#found = true;
  }

  /** The cell across side `i` of a cell piece, if it is a column or pit. */
  #neighbor(c: CellPiece, i: number): CellPiece | undefined {
    const n = neighborOf(this.#grid, { col: c.x, row: c.y }, i);
    return this.cellAt(n.col, n.row);
  }

  /** The region a wall below 0 stands in: its host's or the cell under its middle's. */
  #regionUnder(w: Extract<StaticPiece, { kind: "wall" }>): PitRegion | undefined {
    const p = w.piece;
    if (p.hosts) {
      for (const h of p.hosts) {
        const c = this.cellAt(h.cell.col, h.cell.row);
        if (c?.region) return c.region;
      }
      return undefined;
    }
    const cells = p.beside ? [[p.beside[0], p.beside[1]], [p.beside[2], p.beside[3]]] : [[p.cx, p.cy]];
    for (const [x, y] of cells) {
      const c = this.cellAt(x!, y!);
      if (c?.region) return c.region;
    }
    return undefined;
  }

  /** The pit regions, for the tests. */
  get regions(): readonly PitRegion[] {
    return this.#regions;
  }

  /**
   * The cells of a region whose openings at 0 meet a view box at a turn:
   * what clips a piece, a standee or a band drawn below 0 there. Only those
   * can show it, so a large depression clips each piece by a few openings.
   */
  openingsMeeting(region: PitRegion, turn: Turn, box: VBox, asker?: object): CellPiece[] {
    let byRegion = this.#openings.get(turn);
    if (!byRegion) this.#openings.set(turn, (byRegion = new Map()));
    let grid = byRegion.get(region);
    if (!grid) byRegion.set(region, (grid = openingGrid(region, turn)));
    // A pit or a wall asks each frame it draws for the same box: its answer is kept for the turn.
    const kept = asker ? grid.asked.get(asker) : undefined;
    if (kept) return kept;
    const seen = new Set<number>();
    const found: number[] = [];
    for (let gy = Math.floor(box.y0 / OPENING_STEP); gy <= Math.floor(box.y1 / OPENING_STEP); gy++) {
      for (let gx = Math.floor(box.x0 / OPENING_STEP); gx <= Math.floor(box.x1 / OPENING_STEP); gx++) {
        for (const i of grid.cells.get(`${gx},${gy}`) ?? []) {
          if (seen.has(i)) continue;
          seen.add(i);
          if (meets(grid.boxes[i]!, box)) found.push(i);
        }
      }
    }
    // Their order in the region, so a clip path comes out the same whatever the grid's.
    const out = found.sort((a, b) => a - b).map((i) => region.cells[i]!);
    if (asker) grid.asked.set(asker, out);
    return out;
  }

  /** The column or pit at a cell, if it has one. */
  cellAt(x: number, y: number): CellPiece | undefined {
    const b = this.#buckets.get(`${Math.floor(x / CHUNK_CELLS)},${Math.floor(y / CHUNK_CELLS)}`);
    return b?.cells.get(y * 1_000_000 + x);
  }

  /** A bucket sorted at a turn, kept until the bucket is rebuilt. */
  #turn(b: Bucket, turn: Turn): TurnData {
    let t = b.turns.get(turn);
    if (t) return t;
    const keyed = b.pieces.map((p) => ({ p, key: keyOf(p, turn), rank: RANK[p.kind], local: localKeyOf(p, turn) }));
    keyed.sort((a, c) => (before(a.key, a.rank, a.p.id, c.key, c.rank, c.p.id, a.local, c.local) ? -1 : 1));
    const bounds = keyed.map((k) => boundsOf(k.p, turn));
    const union = bounds.reduce((u, v) => ({ x0: Math.min(u.x0, v.x0), y0: Math.min(u.y0, v.y0), x1: Math.max(u.x1, v.x1), y1: Math.max(u.y1, v.y1) }), EMPTY_BOX);
    t = { order: keyed.map((k) => k.p), keys: keyed.map((k) => k.key), locals: keyed.map((k) => k.local), bounds, union };
    b.turns.set(turn, t);
    return t;
  }

  /** The buckets whose pieces' bounds meet the view box, sorted at this turn on the way. */
  visible(turn: Turn, view: VBox): TurnData[] {
    const out: TurnData[] = [];
    for (const b of this.#buckets.values()) {
      if (b.pieces.length === 0) continue;
      const t = this.#turn(b, turn);
      if (meets(t.union, view)) out.push(t);
    }
    return out;
  }

  /** How many buckets the index holds, for the tests. */
  get size(): number {
    return this.#buckets.size;
  }

  /** The buckets per row, for the tests. */
  get across(): number {
    return this.#across;
  }

  /**
   * The drawing order for the view box at a turn: every piece of the
   * buckets in view, merged in depth order, with the standees in view placed
   * among them, runs of pieces between standees grouped for one shape each.
   */
  layout(turn: Turn, view: VBox, standees: readonly StandeeIn[], volumes: readonly VolumePiece[] = []): Item[] {
    const lists = this.visible(turn, view);
    // A k-way merge of the sorted buckets, by a small heap of each list's next piece.
    type Next = { list: TurnData; i: number };
    const heap: Next[] = [];
    const less = (a: Next, b: Next) =>
      before(a.list.keys[a.i]!, RANK[a.list.order[a.i]!.kind], a.list.order[a.i]!.id, b.list.keys[b.i]!, RANK[b.list.order[b.i]!.kind], b.list.order[b.i]!.id, a.list.locals[a.i]!, b.list.locals[b.i]!);
    const push = (n: Next) => {
      heap.push(n);
      let i = heap.length - 1;
      while (i > 0) {
        const parent = (i - 1) >> 1;
        if (!less(heap[i]!, heap[parent]!)) break;
        [heap[i], heap[parent]] = [heap[parent]!, heap[i]!];
        i = parent;
      }
    };
    const pop = (): Next => {
      const top = heap[0]!;
      const last = heap.pop()!;
      if (heap.length > 0) {
        heap[0] = last;
        let i = 0;
        for (;;) {
          const l = 2 * i + 1;
          const r = l + 1;
          let m = i;
          if (l < heap.length && less(heap[l]!, heap[m]!)) m = l;
          if (r < heap.length && less(heap[r]!, heap[m]!)) m = r;
          if (m === i) break;
          [heap[i], heap[m]] = [heap[m]!, heap[i]!];
          i = m;
        }
      }
      return top;
    };
    for (const list of lists) push({ list, i: 0 });
    const statics: { p: StaticPiece; key: number; bounds: VBox }[] = [];
    while (heap.length > 0) {
      const n = pop();
      statics.push({ p: n.list.order[n.i]!, key: n.list.keys[n.i]!, bounds: n.list.bounds[n.i]! });
      if (n.i + 1 < n.list.order.length) push({ list: n.list, i: n.i + 1 });
    }

    const placed = this.#placeStandees(turn, view, standees);
    // The bands in view, far to near, each with the stretch between standees it draws in: after the last placed standee whose natural key is below its key.
    const bands = volumes.filter((v) => meets(v.bounds, view)).sort((a, b) => (before(a.key, VOLUME_RANK, a.id, b.key, VOLUME_RANK, b.id) ? -1 : 1));
    const stretchOf = stretches(placed.map((s) => sortKey(turn, s.standee.x, s.standee.y)));
    let vi = 0;
    // A null box gives no silhouette: a band's (design 4.3).
    const items: (Item & { bounds: VBox | null; art?: VBox; key: number })[] = [];
    let run: DrawPiece[] = [];
    let runBounds: (VBox | null)[] = [];
    const flush = () => {
      if (run.length === 0) return;
      // A run keeps its pieces' bounds for the silhouettes below.
      for (let i = 0; i < run.length; i++) items.push({ kind: "run", pieces: [run[i]!], bounds: runBounds[i]!, key: 0 });
      run = [];
      runBounds = [];
    };
    /** The bands of stretch `j` that sort before a piece, or all of them left. */
    const bandsBefore = (j: number, next?: { key: number; rank: number; id: string }) => {
      while (vi < bands.length && stretchOf(bands[vi]!.key) === j && (!next || before(bands[vi]!.key, VOLUME_RANK, bands[vi]!.id, next.key, next.rank, next.id))) {
        run.push(bands[vi]!);
        runBounds.push(null);
        vi++;
      }
    };
    const pushStatic = (j: number, p: StaticPiece, key: number, bounds: VBox) => {
      bandsBefore(j, { key, rank: RANK[p.kind], id: p.id });
      run.push(p);
      runBounds.push(bounds);
    };
    let i = 0;
    for (let j = 0; j < placed.length; j++) {
      const s = placed[j]!;
      while (i < statics.length && before(statics[i]!.key, RANK[statics[i]!.p.kind], statics[i]!.p.id, s.key, RANK.standee, s.order)) {
        pushStatic(j, statics[i]!.p, statics[i]!.key, statics[i]!.bounds);
        i++;
      }
      bandsBefore(j);
      flush();
      items.push({ kind: "standee", id: s.standee.id, silhouette: false, pits: s.pits, bounds: s.standee.bounds, art: s.standee.art, key: s.key });
      // Its own cells above its base draw over it, wherever they sorted.
      for (const c of s.over) pushStatic(j + 1, c, keyOf(c, turn), boundsOf(c, turn));
    }
    while (i < statics.length) {
      pushStatic(placed.length, statics[i]!.p, statics[i]!.key, statics[i]!.bounds);
      i++;
    }
    bandsBefore(placed.length);
    flush();

    // Silhouettes: a standee whose art meets anything drawn after it but a band.
    for (let k = 0; k < items.length; k++) {
      const item = items[k]!;
      if (item.kind !== "standee") continue;
      for (let m = k + 1; m < items.length; m++) {
        const b = items[m]!.bounds;
        if (b && meets(item.art!, b)) {
          item.silhouette = true;
          break;
        }
      }
    }

    // One run per stretch between standees.
    const out: Item[] = [];
    for (const item of items) {
      if (item.kind === "run") {
        const last = out[out.length - 1];
        if (last && last.kind === "run") last.pieces.push(...item.pieces);
        else out.push({ kind: "run", pieces: [...item.pieces] });
      } else {
        out.push({ kind: "standee", id: item.id, silhouette: item.silhouette, pits: item.pits });
      }
    }
    return out;
  }

  /**
   * The standees in view in drawing order: each after its own cells at or
   * below its base (its key raised to theirs), with its own cells above its
   * base to draw again over it, and a rider after its holder.
   */
  #placeStandees(turn: Turn, view: VBox, standees: readonly StandeeIn[]): { standee: StandeeIn; key: number; order: string; over: CellPiece[]; pits: CellPiece[] }[] {
    const inView = standees.filter((s) => s.keep || meets(s.bounds, view));
    const byId = new Map(inView.map((s) => [s.id, s]));
    const own = new Map<string, { key: number; over: CellPiece[]; pits: CellPiece[] }>();
    for (const s of inView) {
      let key = sortKey(turn, s.x, s.y);
      const over: CellPiece[] = [];
      const regions = new Set<PitRegion>();
      for (const cell of s.cells) {
        const c = this.cellAt(cell.col, cell.row);
        if (!c) continue;
        if (c.z <= s.base) key = Math.max(key, keyOf(c, turn));
        else over.push(c);
        if (c.kind === "pit" && s.base < 0 && c.region) regions.add(c.region);
      }
      // Its pits' whole regions, as far as they can show it: a neighbor's opening it stands behind shows it too.
      const pits = [...regions].flatMap((r) => this.openingsMeeting(r, turn, s.bounds));
      own.set(s.id, { key, over, pits });
    }
    // A rider sorts after its holder: at least the holder's key, then by how deep it rides.
    const chain = (s: StandeeIn): { key: number; depth: number } => {
      let key = own.get(s.id)!.key;
      let d = 0;
      let at: StandeeIn | undefined = s;
      const visited = new Set<string>();
      while (at?.holder && byId.has(at.holder) && !visited.has(at.holder)) {
        visited.add(at.holder);
        at = byId.get(at.holder)!;
        key = Math.max(key, own.get(at.id)!.key);
        d++;
      }
      return { key, depth: d };
    };
    const placed = inView.map((s) => {
      const c = chain(s);
      const o = own.get(s.id)!;
      // Between standees at one key, the holder first, then by id: depth goes into the order string.
      // Own cells above the base that sort after the standee draw over it anyway, so only the ones before it draw again.
      const over = o.over.filter((cell) => keyOf(cell, turn) <= c.key);
      return { standee: s, key: c.key, order: `${String(c.depth).padStart(3, "0")}${s.id}`, over, pits: o.pits };
    });
    placed.sort((a, b) => (a.key !== b.key ? a.key - b.key : a.order < b.order ? -1 : a.order > b.order ? 1 : 0));
    return placed;
  }
}

/**
 * For standees in placed order by their natural keys, which stretch
 * between them a band at a key draws in: the count of standees up to and
 * including the last whose natural key is below it (the precedence rule,
 * design 4.3, a tie drawing the band first). The least natural key from
 * each standee on rises with the place, so a halving finds that last one.
 */
export function stretches(natural: readonly number[]): (key: number) => number {
  const n = natural.length;
  const least = new Float64Array(n + 1);
  least[n] = Infinity;
  for (let i = n - 1; i >= 0; i--) least[i] = Math.min(natural[i]!, least[i + 1]!);
  return (key) => {
    // The first place whose least natural key from there on is not below the key: the last standee below it is just before.
    let lo = 0;
    let hi = n;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (least[mid]! < key) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  };
}

/**
 * Standing wall pieces grouped by bucket key, each group kept as the same
 * array while its pieces are the same, so unchanged buckets keep their
 * sort. A piece on the scene's east or south edge has its middle on the
 * cell past the edge, which at a multiple of 16 cells is a bucket `sync`
 * never makes, so it goes to the bucket inside the scene beside it.
 */
export function groupWalls(pieces: readonly WallPiece[], prev: ReadonlyMap<string, readonly WallPiece[]> | null, bounds: { w: number; h: number }, grid: Grid = SQUARES): Map<string, readonly WallPiece[]> {
  // On hexes a piece's cell is its owner host's key, and one past the scene's edge goes to the bucket inside beside it, sorted by its own key all the same.
  const span = keySpan(grid, bounds);
  const across = Math.max(1, Math.ceil(span.cols / CHUNK_CELLS));
  const down = Math.max(1, Math.ceil(span.rows / CHUNK_CELLS));
  const clamp = (v: number, n: number) => Math.max(0, Math.min(n - 1, v));
  const groups = new Map<string, WallPiece[]>();
  for (const p of pieces) {
    const key = `${clamp(Math.floor(p.cx / CHUNK_CELLS), across)},${clamp(Math.floor(p.cy / CHUNK_CELLS), down)}`;
    const list = groups.get(key);
    if (list) list.push(p);
    else groups.set(key, [p]);
  }
  const out = new Map<string, readonly WallPiece[]>();
  for (const [key, list] of groups) {
    const old = prev?.get(key);
    const same = old && old.length === list.length && old.every((p, i) => p.id === list[i]!.id && p.ax === list[i]!.ax && p.ay === list[i]!.ay && p.bx === list[i]!.bx && p.by === list[i]!.by && p.kind === list[i]!.kind && p.auto === list[i]!.auto);
    out.set(key, same ? old : list);
  }
  return out;
}
