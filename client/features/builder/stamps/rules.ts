import { STAMP_MAX_CELLS, STAMP_MIN_CELLS, type Scene, type Stamp, type StampArt } from "#shared/model.ts";
import type { StampInput } from "#shared/protocol.ts";
import type { StarterStamp, StarterWork } from "#shared/starter.ts";
import { STARTER_STAMPS } from "#shared/starterStamps.ts";
import { STAMP_ART, type ShippedStamp } from "#shared/stamps.ts";

/**
 * The rules of the builder's Stamp mode (docs/design-v1-maps-vision.md
 * section 3.5): where a tap places a stamp, which stamp a tap hits, how the
 * handles turn and resize one, and what an op carries. Plain functions, so
 * they run under node --test. pointer.ts feeds them the DM's gestures, and
 * StampHandles.tsx and draw.ts draw what they decide.
 */

export type Point = { x: number; y: number };

type SceneBounds = Scene["bounds"];

/** Where a stamp stands: its center and size in cells, and its turn in degrees clockwise from east. */
export type StampPose = Pick<Stamp, "x" | "y" | "w" | "h" | "rotation">;

/** The rotate handle snaps to this many degrees unless the DM turns Snap off. */
export const ROTATE_SNAP_DEG = 15;

/** A handle's target is 44 px across, so a thumb finds it at any zoom. */
export const HANDLE_HIT_PX = 22;

/** The rotate handle stands this far beyond the stamp's top edge, so it never covers the art. */
export const ROTATE_HANDLE_PX = 36;

/**
 * The resize handle sits this far out from the stamp's corner, along both
 * sides. At 16 its 22 px reach (HANDLE_HIT_PX) stops short of the corner,
 * since 16 times the square root of 2 is about 22.6, so on a stamp a few
 * pixels across a press on the art still moves it.
 */
export const RESIZE_HANDLE_PX = 16;

/** A finger's slop around a stamp, in screen pixels. */
export const STAMP_SLOP_PX = 6;

/** A duplicate lands this far right and down of its original, in cells, so both stay in view. */
export const DUPLICATE_OFFSET = 0.5;

/** The highest z the protocol takes. Bringing to front past it keeps the top place instead. */
const MAX_Z = 1_000_000;

/** The 8 tints of the options bar, plus None. Each is multiplied into the art as a cast (design 3.5). */
export const TINTS: readonly { color: string; name: string }[] = [
  { color: "#e8a048", name: "Autumn" },
  { color: "#d0583a", name: "Rust" },
  { color: "#f2d35c", name: "Gold" },
  { color: "#86c06a", name: "Spring green" },
  { color: "#78a6e0", name: "Frost" },
  { color: "#a98ad8", name: "Arcane" },
  { color: "#9a958e", name: "Ash" },
  { color: "#5a4636", name: "Burnt" },
];

export function snapHalf(v: number): number {
  return Math.round(v * 2) / 2;
}

const round3 = (v: number) => Math.round(v * 1000) / 1000;

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

/** Keeps a stamp's center on the scene, so a stamp can never be dragged out of reach. */
export function onScene(p: Point, bounds: SceneBounds): Point {
  return { x: clamp(p.x, 0, bounds.w), y: clamp(p.y, 0, bounds.h) };
}

/** A world point in the stamp's own frame: from its center, along its width and height, before its turn. */
export function toLocal(pose: StampPose, p: Point): Point {
  const r = (pose.rotation * Math.PI) / 180;
  const c = Math.cos(r);
  const s = Math.sin(r);
  const dx = p.x - pose.x;
  const dy = p.y - pose.y;
  return { x: dx * c + dy * s, y: -dx * s + dy * c };
}

/** A point in the stamp's own frame, back in world cells. y points down, so a positive turn is clockwise. */
export function toWorld(pose: StampPose, l: Point): Point {
  const r = (pose.rotation * Math.PI) / 180;
  const c = Math.cos(r);
  const s = Math.sin(r);
  return { x: pose.x + l.x * c - l.y * s, y: pose.y + l.x * s + l.y * c };
}

/** Which of two stamps draws on top: the higher z, and between equal z the later id, as the board draws them. */
export function drawOrder(a: Pick<Stamp, "z" | "id">, b: Pick<Stamp, "z" | "id">): number {
  return a.z - b.z || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

/** A scene's stamps, bottom first, as the board draws them. */
export function sceneStamps(stamps: Readonly<Record<string, Stamp | undefined>> | undefined, sceneId: string): Stamp[] {
  const out: Stamp[] = [];
  for (const stamp of Object.values(stamps ?? {})) if (stamp && stamp.sceneId === sceneId) out.push(stamp);
  return out.sort(drawOrder);
}

/** The topmost stamp whose box holds the point, give or take `slop` cells. */
export function stampAt<T extends StampPose & Pick<Stamp, "z" | "id">>(stamps: readonly T[], p: Point, slop: number): T | null {
  let top: T | null = null;
  for (const stamp of stamps) {
    const l = toLocal(stamp, p);
    if (Math.abs(l.x) > stamp.w / 2 + slop || Math.abs(l.y) > stamp.h / 2 + slop) continue;
    if (!top || drawOrder(stamp, top) > 0) top = stamp;
  }
  return top;
}

/** Where the handles of a selected stamp stand, in world cells, at `scale` screen pixels per cell. */
export function handlePositions(pose: StampPose, scale: number): { rotate: Point; resize: Point; top: Point } {
  return {
    top: toWorld(pose, { x: 0, y: -pose.h / 2 }),
    rotate: toWorld(pose, { x: 0, y: -pose.h / 2 - ROTATE_HANDLE_PX / scale }),
    resize: toWorld(pose, { x: pose.w / 2 + RESIZE_HANDLE_PX / scale, y: pose.h / 2 + RESIZE_HANDLE_PX / scale }),
  };
}

/**
 * The handle under a point, the nearer when both are in reach. A handle
 * wins over another stamp's art under it, but never over the selected
 * stamp's own box, so a drag on the art always moves it.
 */
export function handleAt(pose: StampPose, p: Point, scale: number): "rotate" | "resize" | null {
  const l = toLocal(pose, p);
  if (Math.abs(l.x) <= pose.w / 2 && Math.abs(l.y) <= pose.h / 2) return null;
  const reach = HANDLE_HIT_PX / scale;
  const h = handlePositions(pose, scale);
  const toRotate = Math.hypot(p.x - h.rotate.x, p.y - h.rotate.y);
  const toResize = Math.hypot(p.x - h.resize.x, p.y - h.resize.y);
  if (toRotate <= reach && toRotate <= toResize) return "rotate";
  if (toResize <= reach) return "resize";
  return null;
}

/** An angle in degrees, from 0 up to but not including 360. */
export function normalizeDegrees(deg: number): number {
  const d = deg % 360;
  return d < 0 ? d + 360 : d === 0 ? 0 : d;
}

/**
 * The turn that puts the rotate handle under the pointer. The handle stands
 * above the stamp, a quarter turn back from east, so the turn is the
 * pointer's bearing from the center plus 90 degrees.
 */
export function rotationFrom(center: Point, p: Point, snap: boolean): number {
  const bearing = (Math.atan2(p.y - center.y, p.x - center.x) * 180) / Math.PI;
  const deg = normalizeDegrees(bearing + 90);
  return snap ? normalizeDegrees(Math.round(deg / ROTATE_SNAP_DEG) * ROTATE_SNAP_DEG) : round3(deg);
}

/**
 * The size after dragging the corner handle from `grab` to `p` (both in the
 * stamp's own frame at the start of the drag), keeping the stamp's shape
 * and its center. The drag is measured along the corner's diagonal, so a
 * sideways wobble does nothing, and the factor is held where either side
 * would leave the protocol's 0.25 to 20 cells.
 */
export function resizeFrom(start: Pick<StampPose, "w" | "h">, grab: Point, p: Point): { w: number; h: number } {
  const dx = start.w / 2;
  const dy = start.h / 2;
  const along = (q: Point) => (q.x * dx + q.y * dy) / (dx * dx + dy * dy);
  const from = along(grab);
  if (!(from > 0)) return { w: start.w, h: start.h };
  const lo = STAMP_MIN_CELLS / Math.min(start.w, start.h);
  const hi = STAMP_MAX_CELLS / Math.max(start.w, start.h);
  const k = clamp(along(p) / from, Math.min(lo, 1), Math.max(hi, 1));
  return { w: clamp(round3(start.w * k), STAMP_MIN_CELLS, STAMP_MAX_CELLS), h: clamp(round3(start.h * k), STAMP_MIN_CELLS, STAMP_MAX_CELLS) };
}

/** The z that draws over every stamp on the scene. */
export function topZ(stamps: readonly Pick<Stamp, "z">[]): number {
  let max = -Infinity;
  for (const s of stamps) max = Math.max(max, s.z);
  return max === -Infinity ? 0 : Math.min(MAX_Z, max + 1);
}

/** A room image stamps one cell across on its long side, keeping its shape (design 3.5). */
export function libraryFootprint(width: number | undefined, height: number | undefined): { w: number; h: number } {
  if (!width || !height) return { w: 1, h: 1 };
  if (width >= height) return { w: 1, h: Math.max(STAMP_MIN_CELLS, round3(height / width)) };
  return { w: Math.max(STAMP_MIN_CELLS, round3(width / height)), h: 1 };
}

/** What the next tap places: the art and the size it takes. */
export type ChosenArt = { art: StampArt; w: number; h: number; name: string };

/** A shipped stamp as the picker hands it over, at its catalog footprint. */
export function shippedChoice(stamp: ShippedStamp): ChosenArt {
  return { art: { key: stamp.key }, w: stamp.w, h: stamp.h, name: stamp.name };
}

/** A new stamp centered on the tap, snapped to half cells, on top of the others. */
export function placement(chosen: ChosenArt, at: Point, input: { id: string; z: number; bounds: SceneBounds }): StampInput {
  const center = onScene({ x: snapHalf(at.x), y: snapHalf(at.y) }, input.bounds);
  return { id: input.id, art: chosen.art, x: center.x, y: center.y, w: chosen.w, h: chosen.h, rotation: 0, z: input.z, visibility: "all" };
}

/** A stamp as an op puts it: everything but the server's own fields, optional fields only when set. */
export function toInput(stamp: Omit<Stamp, "rev" | "sceneId"> & Partial<Pick<Stamp, "rev" | "sceneId">>): StampInput {
  const { id, art, x, y, w, h, rotation, z, visibility } = stamp;
  return {
    id,
    art: "key" in art ? { key: art.key } : { assetId: art.assetId },
    x,
    y,
    w,
    h,
    rotation,
    z,
    visibility,
    ...(stamp.tint ? { tint: stamp.tint } : {}),
    ...(stamp.flip ? { flip: true } : {}),
  };
}

/** A copy a little right and down of the original, on top of everything. */
export function duplicateOf(stamp: Stamp, id: string, z: number, bounds: SceneBounds): StampInput {
  const center = onScene({ x: stamp.x + DUPLICATE_OFFSET, y: stamp.y + DUPLICATE_OFFSET }, bounds);
  return toInput({ ...stamp, id, z, x: center.x, y: center.y });
}

/**
 * A starter pack's prop as the next tap places it (docs/design-v1-starter-art.md
 * 5): by the stamp key the catalog gives it, at its footprint, or null for a
 * work that is no stamp.
 */
export function starterChoice(work: Pick<StarterWork, "name" | "stamp">): ChosenArt | null {
  return work.stamp ? { art: { key: work.stamp.key }, w: work.stamp.w, h: work.stamp.h, name: work.name } : null;
}

/** The shipped stamps whose name holds every word typed, in catalog order. */
export function matchStamps(query: string, catalog: readonly ShippedStamp[] = STAMP_ART): ShippedStamp[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return [...catalog];
  return catalog.filter((s) => {
    const name = s.name.toLowerCase();
    return words.every((w) => name.includes(w));
  });
}

/** A stamp the board can draw from `/stamps/<key>.webp`: a shipped one or a starter pack's. */
export type KnownStamp = Pick<ShippedStamp, "key" | "name" | "w" | "h">;

/**
 * Every stamp the client ships by key: the shipped set and the starter
 * packs' props, which share the folder under pack-prefixed keys. A shipped
 * key wins should a starter key ever repeat one, so a placed stamp never
 * changes what it draws.
 */
export function knownStamps(shipped: readonly KnownStamp[], starter: readonly StarterStamp[]): ReadonlyMap<string, KnownStamp> {
  const known = new Map<string, KnownStamp>();
  for (const s of starter) known.set(s.key, { key: s.key, name: s.name, w: s.w, h: s.h });
  for (const s of shipped) known.set(s.key, s);
  return known;
}

const BY_KEY = knownStamps(STAMP_ART, STARTER_STAMPS);

/** The entry for a key, or null for a key this client does not ship, which draws as a dashed box. */
export function shippedStamp(key: string): KnownStamp | null {
  return BY_KEY.get(key) ?? null;
}

/**
 * The pixel size of the cached copy of an art (draw.ts). A stamp `screenPx`
 * device pixels across on its long side gets the next power of two, at
 * least 16 and never more than the image has, so zooming redraws a copy
 * only when it crosses a power of two, and one copy serves every stamp of
 * that art, tint and bucket.
 */
export function sizeBucket(screenPx: number, naturalPx: number): number {
  const wanted = 2 ** Math.ceil(Math.log2(Math.max(16, screenPx)));
  return Math.max(1, Math.min(wanted, Math.round(naturalPx)));
}
