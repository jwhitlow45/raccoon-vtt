import { CHUNK_CELLS } from "#shared/model.ts";
import type { AreaContext, AreaTemplateInput } from "#shared/rules/aoe.ts";
import { bandKey, VolumeCache, type BandDraw, type Volume, type WorldBox } from "../../features/areas/volume.ts";
import { K, turnAxes, type Turn } from "../../lib/view.ts";
import { meets, type VolumePiece } from "./buckets.ts";
import type { VolumeLook } from "./drawRelief.ts";
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
export type VolumeWorld = { heights: { at(x: number, y: number): number }; tiles: unknown; px: number; fog: FogView; live: LiveSub | null };

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

/** The pit cells under a built volume's plan, whose openings clip what lies inside them (design 4.3), kept per volume: its drawn heights are part of its key. */
const pitsOf = new WeakMap<Volume, readonly { x: number; y: number }[]>();

export function pitsUnder(vol: Volume, heights: { at(x: number, y: number): number }): readonly { x: number; y: number }[] {
  let pits = pitsOf.get(vol);
  if (pits) return pits;
  const box = vol.box;
  const out: { x: number; y: number }[] = [];
  // Only a solid reaching below the ground at 0 can lie in a pit.
  if (box && box.z0 < 0) {
    for (let y = Math.floor(box.y0); y < Math.ceil(box.y1); y++) for (let x = Math.floor(box.x0); x < Math.ceil(box.x1); x++) if (heights.at(x, y) < 0) out.push({ x, y });
  }
  pitsOf.set(vol, (pits = out));
  return pits;
}

/**
 * A volume's bands for the depth list at a turn, from what its buckets in
 * `keys` have drawn so far: each band once, with every bucket's part of it
 * and their box (buckets.ts VolumePiece).
 */
export function bandPieces(vol: Volume, turn: Turn, keys: readonly string[], id: string, look: VolumeLook, pits: readonly { x: number; y: number }[]): VolumePiece[] {
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

type Slot = {
  entry: VolumeEntry;
  /** The volume its inputs ask for now, maybe still building, or null when the area resolves to nothing. */
  next: Volume | null;
  /** The last volume that stood, and the turns it has stood at whole, kept while `next` builds. */
  shown: Volume | null;
  turns: Set<Turn>;
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

  /** The areas to stand, each volume got from the cache, which builds nothing until asked. */
  sync(entries: readonly VolumeEntry[], world: VolumeWorld): void {
    const next = new Map<string, Slot>();
    for (const entry of entries) {
      const old = this.#slots.get(entry.id);
      const vol = this.#cache.get({ template: entry.template, ctx: entry.ctx, heights: world.heights, tiles: world.tiles, px: world.px, coarse: false });
      next.set(entry.id, { entry, next: vol, shown: old?.shown ?? null, turns: old?.turns ?? new Set() });
    }
    this.#slots = next;
  }

  /** The slots by how near the view's middle their volumes lie. */
  #byNearness(turn: Turn, view: VBox): Slot[] {
    const mid = { x: (view.x0 + view.x1) / 2, y: (view.y0 + view.y1) / 2 };
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
   * is more to do. `changed` says something new can draw.
   */
  step(turn: Turn, view: VBox, world: VolumeWorld, deadline: number): { more: boolean; changed: boolean } {
    let changed = false;
    for (const slot of this.#byNearness(turn, view)) {
      // A volume that stood is tested on the ground as it is now before the next one is built, so it can stand meanwhile.
      const old = slot.shown;
      if (old && old !== slot.next && old.built) {
        const test = standOf(old, world.fog, world.live);
        if (test.result === null) {
          if (test.run(deadline) === null) return { more: true, changed };
          changed = true;
        }
      }
      const vol = slot.next!;
      if (!vol.built) {
        if (!vol.prepare(deadline)) return { more: true, changed };
        changed = true;
      }
      const test = standOf(vol, world.fog, world.live);
      if (test.result === null) {
        if (test.run(deadline) === null) return { more: true, changed };
        changed = true;
      }
      if (!test.result) continue;
      const keys = viewKeys(vol, turn, view);
      for (const key of keys) {
        if (vol.ready(key)) continue;
        if (!vol.ensure(key, deadline)) return { more: true, changed };
      }
      for (const key of keys) {
        if (vol.drawnNow(key, turn)) continue;
        if (!vol.drawn(key, turn, deadline)) return { more: true, changed };
        changed = true;
      }
    }
    return { more: false, changed };
  }

  /**
   * What stands now, doing no work but the stand test of a small
   * footprint: an area whose volume has every bucket in view drawn at this
   * turn, else the one that stood before while its own test passes.
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
        if (keys.every((key) => vol.drawnNow(key, turn) !== null)) {
          if (slot.shown !== vol) {
            slot.shown = vol;
            slot.turns = new Set();
          }
          slot.turns.add(turn);
          use = vol;
        }
      }
      const old = slot.shown;
      if (!use && old && slot.turns.has(turn) && old.built && standsNow(old, world.fog, world.live) === true) {
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
