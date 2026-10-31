import { CHUNK_CELLS, type FogTile } from "#shared/model.ts";
import type { Grid } from "#shared/rules/grid.ts";
import { TILE_CELLS } from "#shared/rules/fog.ts";
import type { AreaContext, AreaTemplateInput } from "#shared/rules/aoe.ts";
import { bandKey, VolumeCache, type BandDraw, type Volume, type WorldBox } from "../../features/areas/volume.ts";
import { cellAtPoint, cellId, neighborsOf, type GroundCell } from "../../lib/groundCells.ts";
import { K, turnAxes, type DrawnHeights, type Turn } from "../../lib/view.ts";
import { meets, type VolumePiece } from "./buckets.ts";
import { NO_AREA_PITS, type AreaPits, type VolumeLook } from "./drawRelief.ts";
import type { FogView } from "./fogView.ts";
import type { VBox } from "./pieces.ts";
import { VolumeStand, type LiveSub } from "./stand.ts";

/**
 * The areas the isometric board stands as their real shapes
 * (docs/design-v1-iso-area-shapes.md 4.4 and 6). Each is built lazily, in
 * slices of a frame, nearest the middle of the view first: its mesh, the
 * stand rule's test on its footprint, then each of its buckets in view cut
 * and drawn at the turn. Until all of that is done an area lies flat, as
 * it draws today. Once one stands it keeps standing while a new volume for
 * it builds (a fog reveal or a door makes one), but only while its own
 * stand test passes on the viewer's ground as it is now, so a player never
 * sees one over ground that is no longer theirs to see. A turn's drawings
 * are kept, so a later visit to a turn stands at once.
 */

/** An area to stand: its template as this device holds it, the context its coverage reads, and its look. */
export type VolumeEntry = { id: string; template: AreaTemplateInput; ctx: AreaContext; look: VolumeLook };

/** What every volume on a board reads besides its area: the viewer's drawn heights and fog tiles, by identity, the zoom, and the viewer's fog and live ground for the stand rule. */
export type VolumeWorld = { heights: DrawnHeights; tiles: unknown; px: number; fog: FogView; live: LiveSub | null };

/** Footprints this small are tested at once, in a render: about a twentieth of a millisecond. */
const SMALL_FOOTPRINT = 4096;

/** A volume's stand test, kept while the viewer's fog and live ground stay the same objects. */
const stands = new WeakMap<Volume, VolumeStand>();

/** The stand test of a built volume on this ground: begun once, carried on by `step`. */
export function standOf(vol: Volume, fog: FogView, live: LiveSub | null): VolumeStand {
  let test = stands.get(vol);
  if (!test || test.fog !== fog || test.live !== live) stands.set(vol, (test = new VolumeStand(fog, live, vol.footprint)));
  return test;
}

/** The stand rule's answer for a built volume now, null while a large footprint is still being read. */
function standsNow(vol: Volume, fog: FogView, live: LiveSub | null): boolean | null {
  const test = standOf(vol, fog, live);
  if (test.result === null && vol.footprint.count <= SMALL_FOOTPRINT) test.run();
  return test.result;
}

/** A world box's projection at a turn, in view units. */
export function viewBoxOf(box: WorldBox, turn: Turn): VBox {
  const { c, s } = turnAxes(turn);
  const out: VBox = { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity };
  for (const x of [box.x0, box.x1]) {
    for (const y of [box.y0, box.y1]) {
      const u = c * x - s * y;
      const v = (s * x + c * y) / 2;
      out.x0 = Math.min(out.x0, u);
      out.x1 = Math.max(out.x1, u);
      out.y0 = Math.min(out.y0, v - K * box.z1);
      out.y1 = Math.max(out.y1, v - K * box.z0);
    }
  }
  return out;
}

/** The buckets of a built volume whose part of its box meets the view at a turn, nearest the view's middle first. */
export function viewKeys(vol: Volume, turn: Turn, view: VBox): string[] {
  const box = vol.box;
  if (!box) return [];
  const mid = { x: (view.x0 + view.x1) / 2, y: (view.y0 + view.y1) / 2 };
  const out: { key: string; d: number }[] = [];
  for (const key of vol.keys) {
    const comma = key.indexOf(",");
    const bx = Number(key.slice(0, comma));
    const by = Number(key.slice(comma + 1));
    const part = { x0: Math.max(box.x0, bx * CHUNK_CELLS), y0: Math.max(box.y0, by * CHUNK_CELLS), z0: box.z0, x1: Math.min(box.x1, (bx + 1) * CHUNK_CELLS), y1: Math.min(box.y1, (by + 1) * CHUNK_CELLS), z1: box.z1 };
    if (part.x0 > part.x1 || part.y0 > part.y1) continue;
    const v = viewBoxOf(part, turn);
    if (meets(v, view)) out.push({ key, d: Math.hypot((v.x0 + v.x1) / 2 - mid.x, (v.y0 + v.y1) / 2 - mid.y) });
  }
  return out.sort((a, b) => a.d - b.d).map((k) => k.key);
}

/** Whether every bucket of a built volume in view is drawn at a turn: only then does it stand whole there. */
function drawnInView(vol: Volume, turn: Turn, view: VBox): boolean {
  return viewKeys(vol, turn, view).every((key) => vol.drawnNow(key, turn) !== null);
}

/**
 * How far past its box, in cells, the ground can show a volume whose
 * lowest point is `z0`, on drawn ground whose deepest pit is `low`: a part
 * below 0 shows through a pit's opening as far down the screen as it lies
 * deep, and no part lies below the deepest pit's floor. A volume wholly
 * above 0 shows through none (review HXR1-ASTRA-7).
 */
function pitReach(z0: number, low: number): number {
  return z0 < 0 ? 2 * K * Math.max(0, -Math.max(z0, low)) + 1 : 0;
}

/** A hair each way from a point, for a part whose middle lies on a pit's wall. */
const NUDGES = [0, 0, 1e-6, 0, -1e-6, 0, 0, 1e-6, 0, -1e-6, 1e-6, 1e-6, 1e-6, -1e-6, -1e-6, 1e-6, -1e-6, -1e-6];

/**
 * The pit regions under a built volume (design 4.3): the pits its box
 * meets and every pit joined to them side by side (the index's regions,
 * buckets.ts), as far as its reach down the screen past its box, each
 * region with its openings at 0, world polygons, which clip the parts that
 * lie over that region and no others (drawRelief.ts drawVolume). So a part
 * below 0 shows through a neighbor's opening in its region as well as its
 * own (docs/design-v1-iso-hex-relief.md 5.2), and never through another
 * region's, whose opening swept up would show it over the flat ground
 * between. A region with no part over it, such as a pit in a sphere's box
 * corner past its round plan, clips nothing (reviews HXR1-ASTRA-1,
 * HXREL1-OPUS-10). Kept per volume: its drawn heights are part of its key.
 */
const pitsOf = new WeakMap<Volume, AreaPits>();

export function pitsUnder(vol: Volume, heights: Pick<DrawnHeights, "grid" | "low" | "cellsIn" | "atCell" | "polygon">): AreaPits {
  let pits = pitsOf.get(vol);
  if (pits) return pits;
  pits = NO_AREA_PITS;
  const box = vol.box;
  // Only a solid reaching below the ground at 0 can lie in a pit.
  if (box && box.z0 < 0) {
    const reach = pitReach(box.z0, heights.low);
    const near = new Map<number, GroundCell>();
    for (const c of heights.cellsIn({ x0: box.x0 - reach, y0: box.y0 - reach, x1: box.x1 + reach, y1: box.y1 + reach })) if (heights.atCell(c) < 0) near.set(cellId(c), c);
    // From each pit under the box, through pits side by side, as the index joins its regions.
    const regionOf = new Map<number, number>();
    const regions: (readonly { x: number; y: number }[])[][] = [];
    for (const seed of heights.cellsIn(box)) {
      const id = cellId(seed);
      if (!near.has(id) || regionOf.has(id)) continue;
      const r = regions.length;
      const openings: (readonly { x: number; y: number }[])[] = [];
      regions.push(openings);
      regionOf.set(id, r);
      const queue = [near.get(id)!];
      while (queue.length > 0) {
        const c = queue.pop()!;
        openings.push(heights.polygon(c));
        for (const n of neighborsOf(heights.grid, c)) {
          const nid = cellId(n);
          if (near.has(nid) && !regionOf.has(nid)) {
            regionOf.set(nid, r);
            queue.push(near.get(nid)!);
          }
        }
      }
    }
    if (regions.length > 0) {
      const grid = heights.grid;
      const at = (x: number, y: number) => {
        for (let i = 0; i < NUDGES.length; i += 2) {
          const r = regionOf.get(cellId(cellAtPoint(grid, { x: x + NUDGES[i]!, y: y + NUDGES[i + 1]! })));
          if (r !== undefined) return r;
        }
        return -1;
      };
      pits = { regions, at };
    }
  }
  pitsOf.set(vol, pits);
  return pits;
}

/**
 * A volume's bands for the depth list at a turn, from what its buckets in
 * `keys` have drawn so far: each band once, with every bucket's part of it
 * and their box (buckets.ts VolumePiece).
 */
export function bandPieces(vol: Volume, turn: Turn, keys: readonly string[], id: string, look: VolumeLook, pits: AreaPits): VolumePiece[] {
  const byBand = new Map<number, { draws: BandDraw[]; box: VBox }>();
  for (const key of keys) {
    const d = vol.drawnNow(key, turn);
    if (!d) continue;
    for (const band of d.bands) {
      const have = byBand.get(band.band);
      if (have) {
        have.draws.push(band);
        have.box = { x0: Math.min(have.box.x0, band.box.x0), y0: Math.min(have.box.y0, band.box.y0), x1: Math.max(have.box.x1, band.box.x1), y1: Math.max(have.box.y1, band.box.y1) };
      } else byBand.set(band.band, { draws: [band], box: band.box });
    }
  }
  const out: VolumePiece[] = [];
  for (const [band, { draws, box }] of byBand) out.push({ kind: "volume", id: `v${id}:${band}`, area: id, band, key: bandKey(band), draws, bounds: box, look, pits });
  return out.sort((a, b) => a.band - b.band);
}

/** The drawn heights each volume was built on. */
const builtOn = new WeakMap<Volume, DrawnHeights>();

/**
 * The boxes of the cells whose drawn ground differs between two snapshots
 * of one grid and bounds, or null when the grid or bounds differ: found
 * once a sync, by one pass over the scene, and shared by every area it
 * compares, so a fog change, which makes new heights with the same ground,
 * costs the scene's cells and not the scene's cells for every area
 * (review HXR1-ASTRA-7).
 */
export function groundChanges(was: DrawnHeights, now: DrawnHeights): VBox[] | null {
  const a = was.grid;
  const b = now.grid;
  if (a.shape !== b.shape || (a.shape === "hex" && b.shape === "hex" && a.orient !== b.orient)) return null;
  if (was.bounds.w !== now.bounds.w || was.bounds.h !== now.bounds.h) return null;
  const out: VBox[] = [];
  const seen = new Set<string>();
  for (const area of changedAreas(was, now)) {
    for (const c of now.cellsIn(area)) {
      const key = `${c.col},${c.row}`;
      if (seen.has(key)) continue;
      seen.add(key);
      if (was.atCell(c) === now.atCell(c)) continue;
      const poly = now.polygon(c);
      out.push({ x0: Math.min(...poly.map((p) => p.x)), y0: Math.min(...poly.map((p) => p.y)), x1: Math.max(...poly.map((p) => p.x)), y1: Math.max(...poly.map((p) => p.y)) });
    }
  }
  return out;
}

/**
 * Where two snapshots' drawn ground can differ, in world cells. When both
 * come from one scene's chunks, grid, bounds, feet and stand rule, only
 * their fog can part them, and only under the tiles whose bits differ or
 * that one side lacks, each grown by a cell, since a hex's sub-cells reach
 * into the next tile (docs/design-v1-relief-pan.md 8). Otherwise the whole
 * scene: on a player's board every fog change makes new heights, and a
 * pass over a 200 by 200 scene costs a phone's frames.
 */
function changedAreas(was: DrawnHeights, now: DrawnHeights): VBox[] {
  const whole = [{ x0: 0, y0: 0, x1: now.bounds.w, y1: now.bounds.h }];
  const p = was.source;
  const q = now.source;
  if (!p || !q || p.sceneId !== q.sceneId || p.chunks !== q.chunks || p.feet !== q.feet || p.stand !== q.stand) return whole;
  if (p.bounds.w !== q.bounds.w || p.bounds.h !== q.bounds.h || !sameGrid(p.grid, q.grid)) return whole;
  if (p.fog === q.fog) return [];
  if (!p.fog || !q.fog) return whole;
  const prefix = `${q.sceneId}:`;
  const out: VBox[] = [];
  const differs = (key: string, tile: FogTile | undefined, other: FogTile | undefined) => {
    if (!key.startsWith(prefix) || (tile && other && tile.bits === other.bits)) return;
    const t = (tile ?? other)!;
    out.push({ x0: t.tx * TILE_CELLS - 1, y0: t.ty * TILE_CELLS - 1, x1: (t.tx + 1) * TILE_CELLS + 1, y1: (t.ty + 1) * TILE_CELLS + 1 });
  };
  for (const [key, tile] of Object.entries(q.fog)) differs(key, tile, p.fog[key]);
  for (const [key, tile] of Object.entries(p.fog)) if (!(key in q.fog)) differs(key, tile, undefined);
  return out;
}

function sameGrid(a: Grid, b: Grid): boolean {
  return a.shape === b.shape && (a.shape !== "hex" || b.shape !== "hex" || a.orient === b.orient);
}

/**
 * Whether the drawn ground a volume stands on reads the same in `now` as
 * it did in `was`: the grid, the bounds, and every cell under its box and,
 * for a volume reaching below 0, as far around as a pit's opening can show
 * it, by content, since heights are made anew on every fog change.
 * `changes` gives the cells that differ, shared across a sync's areas.
 */
export function sameGroundUnder(vol: Volume, was: DrawnHeights | undefined, now: DrawnHeights, changes: (was: DrawnHeights) => readonly VBox[] | null = (w) => groundChanges(w, now)): boolean {
  if (!was) return false;
  if (was === now) return true;
  const changed = changes(was);
  if (!changed) return false;
  if (changed.length === 0) return true;
  const box = vol.box ?? vol.reach;
  const reach = pitReach(box.z0, Math.min(was.low, now.low));
  const [x0, y0, x1, y1] = [box.x0 - reach, box.y0 - reach, box.x1 + reach, box.y1 + reach];
  return !changed.some((c) => c.x0 <= x1 && c.x1 >= x0 && c.y0 <= y1 && c.y1 >= y0);
}

type Slot = {
  entry: VolumeEntry;
  /** The volume its inputs ask for now, maybe still building, or null when the area resolves to nothing. */
  next: Volume | null;
  /** The last volume that stood, and the turns it has stood at whole, kept while `next` builds. */
  shown: Volume | null;
  turns: Set<Turn>;
  /**
   * The latest drawn heights `shown` is known to fit: those it was built
   * on, moved on to each sync's own once the ground under it reads the
   * same. So every area kept standing compares from the last sync's
   * heights, and a fog change compares two snapshots once for all of them,
   * however many fog changes ago each was built (review HXR1-ASTRA-7).
   */
  seen: DrawnHeights | null;
};

/** What the board lays out: the bands of every area that stands now, which areas those are, and whether one in view still waits to stand. */
export type VolumesNow = { pieces: VolumePiece[]; standing: ReadonlySet<string>; waiting: boolean };

export class BoardVolumes {
  readonly #cache = new VolumeCache(512);
  #slots = new Map<string, Slot>();

  /** The volume an area's inputs ask for now, for the tests. */
  volumeOf(id: string): Volume | null {
    return this.#slots.get(id)?.next ?? null;
  }

  /**
   * The areas to stand, each volume got from the cache, which builds
   * nothing until asked. A volume that stood keeps standing while the next
   * builds only over the drawn ground it was built on: where that ground
   * changed under it, it lies flat until the next stands (design 8), and
   * a change of fog alone, which makes new heights with the same ground,
   * keeps it (on the stand test as ever).
   */
  sync(entries: readonly VolumeEntry[], world: VolumeWorld): void {
    const next = new Map<string, Slot>();
    const changes = new Map<DrawnHeights, readonly VBox[] | null>();
    const changesFrom = (was: DrawnHeights) => {
      if (!changes.has(was)) changes.set(was, groundChanges(was, world.heights));
      return changes.get(was)!;
    };
    for (const entry of entries) {
      const old = this.#slots.get(entry.id);
      const vol = this.#cache.get({ template: entry.template, ctx: entry.ctx, heights: world.heights, tiles: world.tiles, px: world.px, coarse: false });
      if (vol && !builtOn.has(vol)) builtOn.set(vol, world.heights);
      let shown = old?.shown ?? null;
      let seen = old?.seen ?? null;
      if (shown && (shown === vol || sameGroundUnder(shown, seen ?? builtOn.get(shown), world.heights, changesFrom))) seen = world.heights;
      else {
        shown = null;
        seen = null;
      }
      next.set(entry.id, { entry, next: vol, shown, turns: shown ? (old?.turns ?? new Set()) : new Set(), seen });
    }
    this.#slots = next;
  }

  /** The slots by how near `mid` (the view's middle unless given) their volumes lie, those meeting the view only. */
  #byNearness(turn: Turn, view: VBox, mid: { x: number; y: number } = { x: (view.x0 + view.x1) / 2, y: (view.y0 + view.y1) / 2 }): Slot[] {
    const scored: { slot: Slot; d: number }[] = [];
    for (const slot of this.#slots.values()) {
      const vol = slot.next;
      if (!vol) continue;
      const v = viewBoxOf(vol.built && vol.box ? vol.box : vol.reach, turn);
      if (!meets(v, view)) continue;
      scored.push({ slot, d: Math.hypot((v.x0 + v.x1) / 2 - mid.x, (v.y0 + v.y1) / 2 - mid.y) });
    }
    return scored.sort((a, b) => a.d - b.d).map((s) => s.slot);
  }

  /**
   * Builds toward standing every area in view until `deadline` (a
   * `performance.now()` time), nearest the middle first: true when there
   * is more to do. `changed` says what `now` gives has changed: an area
   * whose every bucket in view is now drawn, or whose stand test passes
   * with them drawn, one decided flat, or one whose old volume's test
   * passes so it stands again while the next builds. Work part of the way through an area changes nothing, so the board lays out
   * again once an area, not once a bucket. `mid` is the middle of what the
   * viewer sees, past any panel over the board, in view units.
   */
  step(turn: Turn, view: VBox, world: VolumeWorld, deadline: number, mid?: { x: number; y: number }): { more: boolean; changed: boolean } {
    let changed = false;
    for (const slot of this.#byNearness(turn, view, mid)) {
      // A volume that stood is tested on the ground as it is now before the next one is built, so it can stand meanwhile.
      const old = slot.shown;
      if (old && old !== slot.next && old.built) {
        const test = standOf(old, world.fog, world.live);
        if (test.result === null) {
          if (test.run(deadline) === null) return { more: true, changed };
          // Either answer can change what shows: the old volume decided flat, or standing again while the next builds.
          if (!test.result || (slot.turns.has(turn) && drawnInView(old, turn, view))) changed = true;
        }
      }
      const vol = slot.next!;
      if (!vol.built && !vol.prepare(deadline)) return { more: true, changed };
      const test = standOf(vol, world.fog, world.live);
      // A test that passes changes what shows once every bucket in view is drawn, which they may be already: a sight change keeps the volume and its drawings.
      let passed = false;
      if (test.result === null) {
        if (test.run(deadline) === null) return { more: true, changed };
        if (!test.result) changed = true;
        passed = test.result === true;
      }
      if (!test.result) continue;
      const keys = viewKeys(vol, turn, view);
      for (const key of keys) {
        if (vol.ready(key)) continue;
        if (!vol.ensure(key, deadline)) return { more: true, changed };
      }
      let drew = false;
      for (const key of keys) {
        if (vol.drawnNow(key, turn)) continue;
        if (!vol.drawn(key, turn, deadline)) return { more: true, changed };
        drew = true;
      }
      if (drew || passed) changed = true;
    }
    return { more: false, changed };
  }

  /**
   * What stands now, doing no work but the stand test of a small
   * footprint: an area whose volume has every bucket in view drawn at this
   * turn, else the one that stood before while its own test passes and it
   * too has every bucket in view drawn.
   */
  now(turn: Turn, view: VBox, world: VolumeWorld): VolumesNow {
    const pieces: VolumePiece[] = [];
    const standing = new Set<string>();
    let waiting = false;
    for (const slot of this.#slots.values()) {
      const vol = slot.next;
      if (!vol) continue;
      const inView = meets(viewBoxOf(vol.built && vol.box ? vol.box : vol.reach, turn), view);
      let use: Volume | null = null;
      let keys: string[] = [];
      const verdict = vol.built ? standsNow(vol, world.fog, world.live) : null;
      if (verdict === false) {
        // Decided flat: it lies on the ground, and so does whatever stood before it.
        slot.shown = null;
        continue;
      }
      if (verdict === true) {
        keys = viewKeys(vol, turn, view);
        if (drawnInView(vol, turn, view)) {
          if (slot.shown !== vol) {
            slot.shown = vol;
            slot.turns = new Set();
          }
          slot.turns.add(turn);
          use = vol;
        }
      }
      // A pan can bring buckets into view that the old volume never drew: it stands only whole, else the area lies flat and waits.
      const old = slot.shown;
      if (!use && old && slot.turns.has(turn) && old.built && standsNow(old, world.fog, world.live) === true && drawnInView(old, turn, view)) {
        use = old;
        keys = viewKeys(old, turn, view);
      }
      if (!use) {
        if (inView) waiting = true;
        continue;
      }
      const got = bandPieces(use, turn, keys, slot.entry.id, slot.entry.look, pitsUnder(use, world.heights));
      if (got.length > 0) standing.add(slot.entry.id);
      pieces.push(...got);
    }
    return { pieces, standing, waiting };
  }
}

/**
 * The bands an aura dragged here draws on one side of its standee's
 * natural key (design 4.5): those behind it under the standee, those at or
 * in front of it over, so the creature reads inside its own aura.
 */
export function sideOf(pieces: readonly VolumePiece[], key: number, part: "behind" | "front"): VolumePiece[] {
  return pieces.filter((p) => (p.key < key) === (part === "behind"));
}

/** Coarse volumes drawn whole in the drag layer, kept by their inputs as the board's are (design 4.5). */
const whole = new VolumeCache(64);

/** What a volume drawn whole in the drag layer reads. */
export type WholeRequest = { template: AreaTemplateInput; ctx: AreaContext; banded: boolean };

/**
 * A coarse volume for the drag layer (design 4.5: an area being aimed, an
 * aura moving with its token, another member's preview), built and drawn
 * at a turn until `deadline`: its pieces once it is all built and stands
 * by the stand rule, else null, with `more` saying whether a later call
 * would carry on, as a flat mark shows meanwhile.
 */
export function wholeVolume(req: WholeRequest, id: string, look: VolumeLook, turn: Turn, world: VolumeWorld, deadline: number): { pieces: VolumePiece[] | null; more: boolean } {
  const vol = whole.get({ template: req.template, ctx: req.ctx, heights: world.heights, tiles: world.tiles, px: world.px, coarse: true, banded: req.banded });
  if (!vol) return { pieces: null, more: false };
  if (!vol.prepare(deadline)) return { pieces: null, more: true };
  const test = standOf(vol, world.fog, world.live);
  if (test.run(deadline) === null) return { pieces: null, more: true };
  if (!test.result) return { pieces: null, more: false };
  for (const key of vol.keys) if (!vol.ensure(key, deadline)) return { pieces: null, more: true };
  for (const key of vol.keys) if (!vol.drawn(key, turn, deadline)) return { pieces: null, more: true };
  return { pieces: bandPieces(vol, turn, vol.keys, id, look, pitsUnder(vol, world.heights)), more: false };
}
