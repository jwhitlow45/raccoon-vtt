import { useCallback, useMemo, useRef, useSyncExternalStore } from "react";
import type { AssetSource } from "../../state/view.ts";
import { ISO_TEST_FLAG } from "../view/choice.ts";

/**
 * The decoded model sheets a device holds (docs/design/design-v1-token-models.md
 * 6, D-261127-178, 387). A sheet decodes once into an ImageBitmap that every
 * token wearing it draws from. The phone copy (1024 by 512, 2 MiB decoded)
 * is the one on Phone size map detail or in Low power, else the full one
 * (2048 by 1024, 8 MiB). At most 16 full or 24 phone copies are held, 128
 * or 48 MiB: the budget below weighs a full copy 3 and a phone copy 2 of 48,
 * so a change of copy mid-play stays inside the larger of the two.
 *
 * Each board's layout asks for the sheets of the creatures it stands, nearest
 * the canvas's middle first, after each commit. A sheet held or loading
 * keeps its place while any board asks for it, and the asks not held take
 * what room is left in turn from every board, nearest first. So a pan that
 * reorders more asks than fit never evicts a sheet a board may draw: the
 * ones past the budget stand as pictures until a held one leaves every
 * board's cull box (D-261127-704). To make room a sheet no board asks for
 * goes first. One board asking for the same sheet for several creatures
 * holds it once.
 *
 * What the boards draw changes only when their news is told, at most once
 * a frame: a sheet that arrives or goes joins the next snapshot then, so a
 * board never lays out mid-render. A sheet that arrives while others still
 * load waits for them, up to ARRIVAL_HOLD_MS, so a burst of arrivals lays
 * the board out and repaints it once rather than once a frame as each
 * lands (D-261127-705).
 *
 * A sheet that goes is freed only once every board has committed a render
 * that no longer draws it, so Konva never draws a closed bitmap, and it
 * counts against the budget until then: the sheets that replace it start
 * only once it is closed, so what is decoded never passes the budget, a
 * change of copy or a board slow to commit included. A sheet that arrives
 * late, after its board stopped asking, is freed at once and never shown.
 * A sheet that fails, such as one a viewer may no longer read, stays a
 * picture until no board asks for it, and a later ask tries again. It keeps
 * its place in the order but weighs nothing, as it holds no bitmap.
 */

/** A decoded sheet a canvas draws: a bitmap where the browser makes them, an image element elsewhere. */
export type SheetImage = ImageBitmap | HTMLImageElement;

/** Which copy a board draws: the phone copy on Phone size map detail or in Low power, else the full one. */
export type SheetCopy = "full" | "mobile";

/** What a board reads of the sheets, by a model's asset id: a new object whenever one comes or goes. */
export type Sheets = { readonly version: number; image(assetId: string): SheetImage | null };

/** The sheets held at one version, by URL. Never changed once made. */
export type SheetSnapshot = { readonly version: number; get(url: string): SheetImage | null };

/** How the cache loads, frees and schedules its news, so a test can drive every order of events. */
export type SheetIo = {
  load(url: string, signal: AbortSignal): Promise<SheetImage>;
  release(image: SheetImage): void;
  /** Runs the listeners' news once, soon: a burst of arrivals lays out once. */
  schedule(run: () => void): void;
  /** Runs `run` after `ms`, unless the returned function cancels it first. */
  later(run: () => void, ms: number): () => void;
};

/** How long a sheet that arrived waits for the others still loading before the boards are told. */
export const ARRIVAL_HOLD_MS = 300;

/** A full copy weighs 3 and a phone copy 2 of 48: 16 full or 24 phone copies. */
export const SHEET_BUDGET = 48;
export const SHEET_WEIGHT: Readonly<Record<SheetCopy, number>> = { full: 3, mobile: 2 };

/** What a cache has done since it was made: loads begun, sheets evicted, sheets arrived, and news told its boards. For the bench and the tests. */
export type SheetCounts = { loads: number; evictions: number; arrivals: number; news: number };

type Entry = { url: string; copy: SheetCopy; state: "loading" | "ready" | "failed"; image: SheetImage | null; abort: AbortController | null };
type Layout = { copy: SheetCopy; urls: readonly string[]; settled: number };

export class SheetCache {
  readonly #io: SheetIo;
  readonly #entries = new Map<string, Entry>();
  readonly #layouts = new Map<object, Layout>();
  /** Sheets gone from the snapshot since `at`, waiting for every board to commit a render of `at` or later, and weighing on the budget until then. */
  #retired: { image: SheetImage; copy: SheetCopy; at: number }[] = [];
  #snapshot: SheetSnapshot = { version: 0, get: () => null };
  readonly #listeners = new Set<() => void>();
  /** News is scheduled and not yet told. */
  #pending = false;
  /** The held or gone sheets differ from the snapshot. */
  #dirty = false;
  /** Cancels the wait of sheets that arrived for the ones still loading. */
  #hold: (() => void) | null = null;
  readonly #counts: SheetCounts = { loads: 0, evictions: 0, arrivals: 0, news: 0 };

  constructor(io: SheetIo = BROWSER_IO) {
    this.#io = io;
  }

  readonly snapshot = (): SheetSnapshot => this.#snapshot;

  readonly subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => void this.#listeners.delete(listener);
  };

  /**
   * A board committed a render of snapshot `version` and asks for `urls`,
   * nearest the canvas's middle first, in place of what it asked before.
   */
  layout(board: object, copy: SheetCopy, urls: readonly string[], version: number): void {
    this.#layouts.set(board, { copy, urls, settled: version });
    this.#reconcile();
  }

  /** A board hidden or gone: it asks for nothing, and holds nothing back from being freed. */
  forget(board: object): void {
    if (!this.#layouts.delete(board)) return;
    this.#reconcile();
  }

  /** The sheets admitted now, in order: what the boards' asks hold. For tests and the report. */
  admitted(): string[] {
    return [...this.#admission().admitted.keys()];
  }

  /** What weighs on the budget: the sheets loading or held, and those gone but not yet closed. For tests. */
  weight(): { held: number; closing: number } {
    return { held: this.#held(), closing: this.#closing() };
  }

  /** What the cache has done so far. */
  counts(): SheetCounts {
    return { ...this.#counts };
  }

  /** Every sheet loading or held, with its state. For tests. */
  states(): ReadonlyMap<string, "loading" | "ready" | "failed"> {
    return new Map([...this.#entries].map(([url, e]) => [url, e.state]));
  }

  /** Frees everything, for a test's end. */
  dispose(): void {
    this.#hold?.();
    this.#hold = null;
    for (const e of this.#entries.values()) {
      e.abort?.abort();
      if (e.image) this.#io.release(e.image);
    }
    this.#entries.clear();
    for (const r of this.#retired) this.#io.release(r.image);
    this.#retired = [];
    this.#layouts.clear();
  }

  /**
   * Every board's asks taken in turn, rank by rank, each sheet once. Those
   * held or loading are admitted first, as they fit in what the cache holds
   * now, and the others take the room left in that order, a failed one
   * weighing nothing. The admitted come back in the asks' order, which is
   * also how late an asked sheet goes when room is needed.
   */
  #admission(): { admitted: Map<string, SheetCopy>; order: Map<string, number> } {
    const order = new Map<string, number>();
    const copies = new Map<string, SheetCopy>();
    const lists = [...this.#layouts.values()];
    const longest = Math.max(0, ...lists.map((l) => l.urls.length));
    for (let rank = 0; rank < longest; rank++) {
      for (const l of lists) {
        const url = l.urls[rank];
        if (url === undefined || order.has(url)) continue;
        order.set(url, order.size);
        copies.set(url, l.copy);
      }
    }
    const held = (url: string) => {
      const state = this.#entries.get(url)?.state;
      return state === "loading" || state === "ready";
    };
    const taken = new Set<string>();
    let weight = 0;
    for (const [url, copy] of copies) {
      if (!held(url)) continue;
      weight += SHEET_WEIGHT[copy];
      taken.add(url);
    }
    for (const [url, copy] of copies) {
      if (held(url)) continue;
      weight += this.#entries.get(url)?.state === "failed" ? 0 : SHEET_WEIGHT[copy];
      if (weight > SHEET_BUDGET) break;
      taken.add(url);
    }
    const admitted = new Map<string, SheetCopy>();
    for (const [url, copy] of copies) if (taken.has(url)) admitted.set(url, copy);
    return { admitted, order };
  }

  /** The weight of the sheets loading or held. */
  #held(): number {
    let w = 0;
    for (const e of this.#entries.values()) if (e.state !== "failed") w += SHEET_WEIGHT[e.copy];
    return w;
  }

  /** The weight of the sheets gone from the snapshot and not yet closed. */
  #closing(): number {
    let w = 0;
    for (const r of this.#retired) w += SHEET_WEIGHT[r.copy];
    return w;
  }

  #reconcile(): void {
    this.#freeSettled();
    const { admitted, order } = this.#admission();
    for (const [url, e] of [...this.#entries]) {
      // A load no board's admission holds stops, and a failure no board asks for is forgotten, so a later ask tries again.
      if ((e.state === "loading" && !admitted.has(url)) || (e.state === "failed" && !order.has(url))) {
        e.abort?.abort();
        this.#entries.delete(url);
      }
    }
    const missing = [...admitted].filter(([url]) => !this.#entries.has(url));
    const need = missing.reduce((w, [, copy]) => w + SHEET_WEIGHT[copy], 0);
    // Room for every admitted sheet once the sheets now going are closed.
    let changed = false;
    while (this.#held() + need > SHEET_BUDGET) {
      const out = this.#evictable(admitted, order);
      if (!out) break;
      this.#entries.delete(out.url);
      this.#retired.push({ image: out.image!, copy: out.copy, at: this.#snapshot.version + 1 });
      this.#counts.evictions++;
      changed = true;
    }
    if (changed) this.#publish();
    // Nearest first, each only once the bitmaps it replaces are closed: a later commit's reconcile starts the rest.
    for (const [url, copy] of missing) {
      if (this.#held() + this.#closing() + SHEET_WEIGHT[copy] > SHEET_BUDGET) break;
      this.#start(url, copy);
    }
  }

  /** The held sheet to free for room: one no board asks for, else the one asked for last. Never an admitted one. */
  #evictable(admitted: ReadonlyMap<string, SheetCopy>, order: ReadonlyMap<string, number>): Entry | null {
    let best: Entry | null = null;
    let bestRank = -1;
    for (const e of this.#entries.values()) {
      if (e.state !== "ready" || admitted.has(e.url)) continue;
      const rank = order.get(e.url) ?? Infinity;
      if (rank > bestRank) {
        best = e;
        bestRank = rank;
      }
    }
    return best;
  }

  #start(url: string, copy: SheetCopy): void {
    const abort = new AbortController();
    const entry: Entry = { url, copy, state: "loading", image: null, abort };
    this.#entries.set(url, entry);
    this.#counts.loads++;
    this.#io.load(url, abort.signal).then(
      (image) => {
        if (this.#entries.get(url) !== entry) {
          this.#io.release(image);
          return;
        }
        entry.state = "ready";
        entry.image = image;
        entry.abort = null;
        this.#counts.arrivals++;
        this.#arrived();
      },
      () => {
        if (this.#entries.get(url) !== entry) return;
        entry.state = "failed";
        entry.abort = null;
        if (this.#hold && !this.#loading()) this.#arrived();
      },
    );
  }

  #loading(): boolean {
    for (const e of this.#entries.values()) if (e.state === "loading") return true;
    return false;
  }

  /** A sheet arrived: told with the others once none still loads, or once the first of them has waited ARRIVAL_HOLD_MS. */
  #arrived(): void {
    if (this.#loading()) {
      this.#dirty = true;
      this.#hold ??= this.#io.later(() => {
        this.#hold = null;
        this.#publish();
      }, ARRIVAL_HOLD_MS);
      return;
    }
    this.#hold?.();
    this.#hold = null;
    this.#publish();
  }

  /** The sheets held now join the snapshot with the next news, which tells every board once. */
  #publish(): void {
    this.#dirty = true;
    if (this.#pending) return;
    this.#pending = true;
    this.#io.schedule(() => {
      this.#pending = false;
      if (!this.#dirty) return;
      this.#dirty = false;
      const held = new Map<string, SheetImage>();
      for (const e of this.#entries.values()) if (e.state === "ready" && e.image) held.set(e.url, e.image);
      this.#snapshot = { version: this.#snapshot.version + 1, get: (url) => held.get(url) ?? null };
      this.#freeSettled();
      this.#counts.news++;
      for (const listener of [...this.#listeners]) listener();
    });
  }

  /**
   * Frees the sheets that left the snapshot at or before the oldest version
   * every board has committed, once the snapshot has left them too, so a
   * board shown again never reads a closed bitmap.
   */
  #freeSettled(): void {
    let oldest = this.#snapshot.version;
    for (const l of this.#layouts.values()) oldest = Math.min(oldest, l.settled);
    const keep: { image: SheetImage; copy: SheetCopy; at: number }[] = [];
    for (const r of this.#retired) {
      if (r.at <= oldest) this.#io.release(r.image);
      else keep.push(r);
    }
    this.#retired = keep;
  }
}

/*
 * A sheet decodes into an ImageBitmap off the main thread, as a map does
 * (canvas/useImage.ts loadMap): an image element's first draw would decode
 * it again on the main thread, mid-pan. A browser without createImageBitmap
 * keeps the element.
 *
 * A bitmap's first draw still costs the frame that draws it: on the bench's
 * phone page, 24 sheets drawn first in one repaint of the relief took 65 ms
 * of its canvas's `restore`. So each sheet draws a 4 px corner onto a small
 * canvas of its own as it arrives, and the board's repaint finds it ready
 * (D-261127-706). The canvas is 256 px a side: on a 1 px OffscreenCanvas
 * the bench's worst arrival frame stayed where it was.
 */
let warmCanvas: CanvasRenderingContext2D | null | undefined;
const BROWSER_IO: SheetIo = {
  async load(url, signal) {
    if (typeof createImageBitmap !== "function") {
      const img = new Image();
      img.decoding = "async";
      img.src = url;
      await img.decode();
      return img;
    }
    const res = await fetch(url, { signal, credentials: "same-origin" });
    if (!res.ok) throw new Error(`The model sheet answered ${res.status}`);
    const bitmap = await createImageBitmap(await res.blob());
    warmCanvas ??= Object.assign(document.createElement("canvas"), { width: 256, height: 256 }).getContext("2d");
    warmCanvas?.drawImage(bitmap, 0, 0, 4, 4, 0, 0, 4, 4);
    return bitmap;
  },
  release(image) {
    if ("close" in image) image.close();
  },
  schedule(run) {
    if (typeof requestAnimationFrame === "function") requestAnimationFrame(() => run());
    else setTimeout(run, 0);
  },
  later(run, ms) {
    const timer = setTimeout(run, ms);
    return () => clearTimeout(timer);
  },
};

/** A standing creature as a board's asks read it: the model sheet it waits for or stands as, its ring's middle, and its bounds as its model, in view units. */
export type SheetWant = { sheet: string | null; at: { x: number; y: number }; wanted: { x0: number; y0: number; x1: number; y1: number }; keep?: boolean };

/**
 * The sheets a layout asks for (D-261127-387): those of the creatures whose
 * bounds as their models meet its cull box, or that it keeps whatever the
 * culling, nearest `mid` first, each once, as `url` names them.
 */
export function sheetsNearest(standing: readonly SheetWant[], cull: { x0: number; y0: number; x1: number; y1: number }, mid: { x: number; y: number }, url: (assetId: string) => string): string[] {
  const near: { url: string; d: number }[] = [];
  for (const s of standing) {
    const b = s.wanted;
    if (s.sheet === null || !(s.keep || (b.x0 <= cull.x1 && b.x1 >= cull.x0 && b.y0 <= cull.y1 && b.y1 >= cull.y0))) continue;
    near.push({ url: url(s.sheet), d: (s.at.x - mid.x) ** 2 + (s.at.y - mid.y) ** 2 });
  }
  near.sort((a, b) => a.d - b.d);
  return [...new Set(near.map((n) => n.url))];
}

/** The device's one cache: every board shares the budget, a player preview's included. */
export const sheetCache = new SheetCache();
// With the test flag only, which nothing a user does sets (canvas/relief/isoTest.ts), the bench reads the cache's counts.
if ((globalThis as Record<string, unknown>)[ISO_TEST_FLAG] === true) (globalThis as Record<string, unknown>).__rvttSheets = sheetCache;

/**
 * The sheets a board draws from at its copy, held while the board is
 * hidden, as its other reads are (canvas/relief/context.ts useShownView):
 * a sheet's arrival lays out nothing in a hidden tree.
 */
export function useSheets(shown: boolean, copy: SheetCopy, assets: AssetSource, cache: SheetCache = sheetCache): Sheets {
  const subscribe = useCallback((listener: () => void) => (shown ? cache.subscribe(listener) : () => {}), [shown, cache]);
  const last = useRef<SheetSnapshot | null>(null);
  const snapshot = useSyncExternalStore(subscribe, () => (shown || !last.current ? cache.snapshot() : last.current));
  last.current = snapshot;
  return useMemo(() => ({ version: snapshot.version, image: (assetId: string) => snapshot.get(assets.url(assetId, copy)) }), [snapshot, assets, copy]);
}
