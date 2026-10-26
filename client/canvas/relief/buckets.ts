import { CHUNK_CELLS, type BuildChunk, type FogTile } from "#shared/model.ts";
import type { CellRange } from "#shared/rules/footprint.ts";
import type { Turn } from "../../lib/view.ts";
import { boundsOf, cellPieces, keyOf, RANK, sortKey, wallItems, type CellPiece, type PieceSource, type StaticPiece, type VBox } from "./pieces.ts";
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
 * then walls, then standees, then by id.
 */

/** A standee as the layout reads it. */
export type StandeeIn = {
  id: string;
  /** Its footprint's center on the ground, in cells: its depth key. */
  x: number;
  y: number;
  /** The cells of its footprint, for the own-cells rule. */
  range: CellRange;
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

/** One entry of the drawing order: a run of pieces drawn by one shape, or a standee. */
export type Item =
  | { kind: "run"; pieces: StaticPiece[] }
  | {
      kind: "standee";
      id: string;
      /** A later piece covers its art, so the overlay draws its outline (5.6). */
      silhouette: boolean;
      /** Pit openings it stands in, which clip it so the near rim hides what is below (5.5). */
      pits: CellPiece[];
    };

type TurnData = { order: StaticPiece[]; keys: number[]; bounds: VBox[]; union: VBox };

type Bucket = {
  key: string;
  pieces: StaticPiece[];
  sig: readonly unknown[];
  cells: Map<number, CellPiece>;
  turns: Map<Turn, TurnData>;
};

const EMPTY_BOX: VBox = { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity };

export function meets(a: VBox, b: VBox): boolean {
  return a.x0 <= b.x1 && a.x1 >= b.x0 && a.y0 <= b.y1 && a.y1 >= b.y0;
}

function sameSig(a: readonly unknown[], b: readonly unknown[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/** Compares two entries of the drawing order: depth, then kind, then id. */
function before(ka: number, ra: number, ia: string, kb: number, rb: number, ib: string): boolean {
  if (ka !== kb) return ka < kb;
  if (ra !== rb) return ra < rb;
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
};

export class ReliefIndex {
  readonly #buckets = new Map<string, Bucket>();
  #across = 0;
  /** How many buckets the last sync rebuilt, for the tests and the bench. */
  rebuilt = 0;

  /** Rebuilds every bucket whose inputs changed, and drops buckets past the scene's edge. */
  sync(input: SyncInput): void {
    const { sceneId, chunks, tiles } = input;
    const across = Math.max(1, Math.ceil(input.bounds.w / CHUNK_CELLS));
    const down = Math.max(1, Math.ceil(input.bounds.h / CHUNK_CELLS));
    this.#across = across;
    this.rebuilt = 0;
    const seen = new Set<string>();
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
          input.walls.get(key),
          ...[
            [0, 0],
            [0, -1],
            [1, 0],
            [0, 1],
            [-1, 0],
          ].flatMap(([dx, dy]) => [chunks[at(dx!, dy!)], tiles ? tiles[at(dx!, dy!)] : null]),
        ];
        const old = this.#buckets.get(key);
        if (old && sameSig(old.sig, sig)) continue;
        this.rebuilt++;
        const cellList = cellPieces(input.src, cx, cy, chunks[at(0, 0)]);
        const cells = new Map<number, CellPiece>();
        for (const c of cellList) cells.set(c.y * 1_000_000 + c.x, c);
        const pieces: StaticPiece[] = [...cellList, ...wallItems(input.src, input.walls.get(key) ?? [])];
        this.#buckets.set(key, { key, pieces, sig, cells, turns: new Map() });
      }
    }
    for (const key of this.#buckets.keys()) if (!seen.has(key)) this.#buckets.delete(key);
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
    const keyed = b.pieces.map((p) => ({ p, key: keyOf(p, turn), rank: RANK[p.kind] }));
    keyed.sort((a, c) => (before(a.key, a.rank, a.p.id, c.key, c.rank, c.p.id) ? -1 : 1));
    const bounds = keyed.map((k) => boundsOf(k.p, turn));
    const union = bounds.reduce((u, v) => ({ x0: Math.min(u.x0, v.x0), y0: Math.min(u.y0, v.y0), x1: Math.max(u.x1, v.x1), y1: Math.max(u.y1, v.y1) }), EMPTY_BOX);
    t = { order: keyed.map((k) => k.p), keys: keyed.map((k) => k.key), bounds, union };
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
  layout(turn: Turn, view: VBox, standees: readonly StandeeIn[]): Item[] {
    const lists = this.visible(turn, view);
    // A k-way merge of the sorted buckets, by a small heap of each list's next piece.
    type Next = { list: TurnData; i: number };
    const heap: Next[] = [];
    const less = (a: Next, b: Next) => before(a.list.keys[a.i]!, RANK[a.list.order[a.i]!.kind], a.list.order[a.i]!.id, b.list.keys[b.i]!, RANK[b.list.order[b.i]!.kind], b.list.order[b.i]!.id);
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
    const items: (Item & { bounds: VBox; art?: VBox; key: number })[] = [];
    let run: StaticPiece[] = [];
    let runBounds: VBox[] = [];
    const flush = () => {
      if (run.length === 0) return;
      // A run keeps its pieces' bounds for the silhouettes below.
      for (let i = 0; i < run.length; i++) items.push({ kind: "run", pieces: [run[i]!], bounds: runBounds[i]!, key: 0 });
      run = [];
      runBounds = [];
    };
    let i = 0;
    for (const s of placed) {
      while (i < statics.length && before(statics[i]!.key, RANK[statics[i]!.p.kind], statics[i]!.p.id, s.key, RANK.standee, s.order)) {
        run.push(statics[i]!.p);
        runBounds.push(statics[i]!.bounds);
        i++;
      }
      flush();
      items.push({ kind: "standee", id: s.standee.id, silhouette: false, pits: s.pits, bounds: s.standee.bounds, art: s.standee.art, key: s.key });
      // Its own cells above its base draw over it, wherever they sorted.
      for (const c of s.over) {
        run.push(c);
        runBounds.push(boundsOf(c, turn));
      }
    }
    while (i < statics.length) {
      run.push(statics[i]!.p);
      runBounds.push(statics[i]!.bounds);
      i++;
    }
    flush();

    // Silhouettes: a standee whose art meets anything drawn after it.
    for (let k = 0; k < items.length; k++) {
      const item = items[k]!;
      if (item.kind !== "standee") continue;
      for (let m = k + 1; m < items.length; m++) {
        if (meets(item.art!, items[m]!.bounds)) {
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
      const pits: CellPiece[] = [];
      for (let y = s.range.y0; y < s.range.y1; y++) {
        for (let x = s.range.x0; x < s.range.x1; x++) {
          const c = this.cellAt(x, y);
          if (!c) continue;
          if (c.z <= s.base) key = Math.max(key, keyOf(c, turn));
          else over.push(c);
          if (c.kind === "pit" && s.base < 0) pits.push(c);
        }
      }
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
 * Standing wall pieces grouped by bucket key, each group kept as the same
 * array while its pieces are the same, so unchanged buckets keep their
 * sort. A piece on the scene's east or south edge has its middle on the
 * cell past the edge, which at a multiple of 16 cells is a bucket `sync`
 * never makes, so it goes to the bucket inside the scene beside it.
 */
export function groupWalls(pieces: readonly WallPiece[], prev: ReadonlyMap<string, readonly WallPiece[]> | null, bounds: { w: number; h: number }): Map<string, readonly WallPiece[]> {
  const across = Math.max(1, Math.ceil(bounds.w / CHUNK_CELLS));
  const down = Math.max(1, Math.ceil(bounds.h / CHUNK_CELLS));
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
