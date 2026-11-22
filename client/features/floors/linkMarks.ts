import type { FloorLink, RoomState, Token } from "#shared/model.ts";
import { ownEntry } from "#shared/records.ts";
import { linkDir, rectKeys, rectsOverlap, type LinkEnd } from "#shared/rules/floorLinks.ts";
import { footprintRect, occupiedHexes, type PlacedToken } from "#shared/rules/footprint.ts";
import { isHex, sceneGrid, type Grid } from "#shared/rules/grid.ts";
import { hexKey } from "#shared/rules/hex.ts";
import { rectHexes } from "#shared/rules/traps.ts";
import type { PillSpec } from "../../canvas/boardView.ts";
import { viewPointOf } from "../../canvas/isoPlace.ts";
import type { IsoGround } from "../../canvas/relief/context.ts";
import type { Box } from "../../lib/boardText.ts";
import { hexOutline } from "../../lib/scene.ts";
import { isometric, toView } from "../../lib/view.ts";
import { pillGeometry, pillPlace, pillReach } from "../measure/pillPlace.ts";
import { turnMoverId } from "../attach/turns.ts";
import { pathNow } from "../measure/movement.ts";
import { FLOOR_MARKS } from "../scenes/floorWords.ts";
import { floorStatus } from "./words.ts";
import { linkName } from "./linkWords.ts";

/*
 * What the board draws for each stairs or ladder end on the floor shown
 * (docs/design/design-v1-floors.md phase 2, 10, 11), as plain functions
 * for node --test: its name, the DM's mark of a far floor players have not
 * reached, and which names give way to the turn's marker.
 */

/**
 * An end's name pill (11): "Up to Upper floor" where the viewer's copy
 * holds that floor, else "Stairs up" or "Ladder down", which names none.
 * Null where the copy cannot tell the way.
 */
export function linkLabel(view: Pick<RoomState, "scenes">, link: LinkEnd): string | null {
  const dir = linkDir(view, link);
  if (dir === null) return null;
  const far = link.to === undefined ? undefined : ownEntry(view.scenes, link.to)?.floor?.name;
  return linkName(dir, link.kind, far ?? null);
}

/**
 * The ends on a floor whose far floor players have not reached, by id, as
 * the DM's Floors menu marks a floor (words.ts floorStatus): the DM's pill
 * adds "Not reached yet" there (10, picture 08). Only the DM's copy holds
 * the marks, so a player's reads none.
 */
export function notReachedLinks(view: Pick<RoomState, "meta" | "tokens" | "scenes" | "openFloors" | "characters" | "floorLinks">, sceneId: string): string[] {
  return Object.values(view.floorLinks ?? {})
    .filter((l) => l.sceneId === sceneId && l.to !== undefined && ownEntry(view.scenes, l.to) !== undefined && floorStatus(view, l.to) === FLOOR_MARKS.not)
    .map((l) => l.id)
    .sort();
}

/** Whether a creature placed so has any of its space on the squares: its hexes on a hex floor, its box on squares. */
function touches(g: Grid, placed: PlacedToken, rect: FloorLink["rect"]): boolean {
  if (isHex(g)) {
    const held = new Set(rectKeys(rect));
    return occupiedHexes(g, placed).some((h) => held.has(hexKey(h)));
  }
  const r = footprintRect(g, placed);
  const E = 1e-9;
  return rectsOverlap({ x: r.x + E, y: r.y + E, w: r.w - 2 * E, h: r.h - 2 * E }, rect);
}

/**
 * The ends whose names give way to the turn's marker (6.4, picture 07):
 * the turn's mover stands on the end, and its moves on this floor began
 * there, where the marker's ring hangs, as after it climbed onto it. Read
 * on the board's copy of the floor shown, as the marker reads it.
 */
export function quietLinks(view: Pick<RoomState, "tokens" | "encounter" | "scenes" | "floorLinks"> | null | undefined, sceneId: string, role: "dm" | "player"): string[] {
  if (!view) return [];
  const moverId = turnMoverId(view);
  const mover: Token | undefined = moverId === undefined ? undefined : ownEntry(view.tokens, moverId);
  const scene = ownEntry(view.scenes, sceneId);
  if (!mover || mover.sceneId !== sceneId || !scene) return [];
  const first = pathNow(view.encounter, mover, role)?.stops[0];
  if (!first) return [];
  const g = sceneGrid(scene);
  const began = { ...mover, x: first.x, y: first.y };
  return Object.values(view.floorLinks ?? {})
    .filter((l) => l.sceneId === sceneId && touches(g, mover, l.rect) && touches(g, began, l.rect))
    .map((l) => l.id)
    .sort();
}

/**
 * The squares each token on a floor stands on, as one string so the
 * board places its holes' pills again only when a token moves, which
 * a hole's pills keep off (placeEnds). Empty on a floor with no hole,
 * whose ends keep their own edges, so a move there costs one look at its
 * ends and no walk over the tokens.
 */
export function tokenSpots(view: Pick<RoomState, "tokens" | "scenes" | "floorLinks"> | null | undefined, sceneId: string): string {
  const scene = view ? ownEntry(view.scenes, sceneId) : undefined;
  if (!view || !scene) return "";
  if (!Object.values(view.floorLinks ?? {}).some((l) => l.sceneId === sceneId && l.kind === "opening" && linkDir(view, l) === "down")) return "";
  const g = sceneGrid(scene);
  return Object.values(view.tokens)
    .filter((t): t is Token => t !== undefined && t.sceneId === sceneId)
    .map((t) => {
      const r = footprintRect(g, t);
      return `${r.x},${r.y},${r.w},${r.h}`;
    })
    .sort()
    .join(" ");
}

/** The squares back from tokenSpots. */
export function spotsOf(key: string): FloorLink["rect"][] {
  if (key === "") return [];
  return key.split(" ").map((part) => {
    const [x, y, w, h] = part.split(",").map(Number);
    return { x: x!, y: y!, w: w!, h: h! };
  });
}

/** What places a pill in Isometric: the view's turn and the drawn ground. Null in Top-down. */
export type DrawSpace = Pick<IsoGround, "turn" | "ground"> | null;

/**
 * A pill's box where it draws: in cells in Top-down, and in Isometric's view
 * units otherwise. An upright pill stands at its point's drawn height, as
 * MarkPill puts it. One lying flat on the ground under the fog covers the
 * view's box round its corners at the ground's height, as the ground plane
 * turns and squashes it. A tight standing pill near the edge of `view`, the
 * clear part of the screen, slides back inside it as Pill.tsx draws it,
 * while a flat one keeps its point.
 */
export function drawnBox(p: PillSpec, scale: number, iso: DrawSpace, upright: boolean, tight = false, view: Box | null = null): Box {
  // A pointed pill's reach spans every place it could slide to, about twice its width, which is the safe box beside a marker. `tight` is the body as drawn, which is what two pills cover of each other.
  const box = (q: PillSpec, slid: Box | null) => (tight ? pillPlace({ ...q, scale }, slid).box : pillReach({ ...q, scale }));
  if (!iso) return box(p, view);
  if (upright) {
    const v = viewPointOf(iso, p);
    return box({ ...p, x: v.x, y: v.y }, view);
  }
  const b = box(p, null);
  const turned = isometric(iso.turn);
  const z = iso.ground(p.x, p.y);
  const corners = [toView(turned, { x: b.x0, y: b.y0 }, z), toView(turned, { x: b.x1, y: b.y0 }, z), toView(turned, { x: b.x0, y: b.y1 }, z), toView(turned, { x: b.x1, y: b.y1 }, z)];
  const xs = corners.map((c) => c.x);
  const ys = corners.map((c) => c.y);
  return { x0: Math.min(...xs), y0: Math.min(...ys), x1: Math.max(...xs), y1: Math.max(...ys) };
}

/** Whether a pill's box, as it draws, meets any of the turn's markers (always upright). */
export function meetsTurnMarker(pill: PillSpec, markers: readonly PillSpec[], scale: number, iso: DrawSpace, upright: boolean): boolean {
  const mine = drawnBox(pill, scale, iso, upright);
  return markers.some((m) => {
    const b = drawnBox(m, scale, iso, true);
    return Math.min(mine.x1, b.x1) > Math.max(mine.x0, b.x0) && Math.min(mine.y1, b.y1) > Math.max(mine.y0, b.y0);
  });
}

/**
 * An end's name pill kept off the turn's marker (FL2-POLISH): the name hangs
 * over the end's top edge, and where its box meets a marker's it hangs
 * under the bottom edge (`bottom`) instead, unless the marker meets that
 * spot too, when it keeps the first. Only the marker is read, never
 * another end's name or a trap's, so no two layers chase each other, and the
 * marker places itself from the creature alone (TurnStartLayer.tsx).
 *
 * The boxes meet or part where they draw, not on the map (B53-SOL-02): in
 * Isometric the marker always stands upright on the overlay, and the name
 * stands too where `upright` (the stand rule) or else lies flat, so two
 * pills apart on the map can cover each other on screen, and the reverse.
 */
export function clearOfMarkers(pill: PillSpec, bottom: { x: number; y: number }, markers: readonly PillSpec[], scale: number, iso: DrawSpace = null, upright = true): PillSpec {
  const meetsMarker = (p: PillSpec) => meetsTurnMarker(p, markers, scale, iso, upright);
  if (!meetsMarker(pill)) return pill;
  // Under the end can meet the marker too (Isometric on a phone), and then moving only trades one cover for another.
  const under: PillSpec = { ...pill, x: bottom.x, y: bottom.y, above: false, below: true };
  return meetsMarker(under) ? pill : under;
}

/** An end's squares as the board draws them: a box in cells, and on hexes the outline of its hexes. */
export type Outline = { x: number; y: number; w: number; h: number; loop: number[] | null };

export function outlineOf(g: Grid, rect: FloorLink["rect"]): Outline {
  if (!isHex(g)) return { ...rect, loop: null };
  const loop = hexOutline(g, rectHexes([rect]));
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (let i = 0; i + 1 < loop.length; i += 2) {
    x0 = Math.min(x0, loop[i]!);
    x1 = Math.max(x1, loop[i]!);
    y0 = Math.min(y0, loop[i + 1]!);
    y1 = Math.max(y1, loop[i + 1]!);
  }
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0, loop };
}

/** Where the name hangs: over the middle of the top edge, or under the bottom edge's, and on hexes the extreme point or side nearest the middle, so it never points at the notch between two hexes. */
export function nameAnchor(o: Outline, edge: "top" | "bottom" = "top"): { x: number; y: number } {
  const mid = o.x + o.w / 2;
  const y0 = edge === "top" ? o.y : o.y + o.h;
  if (!o.loop) return { x: mid, y: y0 };
  let best = { x: mid, y: y0 };
  let gap = Infinity;
  for (let i = 0; i + 1 < o.loop.length; i += 2) {
    const x = o.loop[i]!;
    const y = o.loop[i + 1]!;
    if (Math.abs(y - y0) > 1e-9) continue;
    if (Math.abs(x - mid) < gap) {
      gap = Math.abs(x - mid);
      best = { x, y };
    }
  }
  return best;
}

/** An end's corners: a box's four, and on hexes the outline's points. */
export function cornersOf(o: Outline): { x: number; y: number }[] {
  if (o.loop) {
    const out: { x: number; y: number }[] = [];
    for (let i = 0; i + 1 < o.loop.length; i += 2) out.push({ x: o.loop[i]!, y: o.loop[i + 1]! });
    return out;
  }
  return [
    { x: o.x, y: o.y },
    { x: o.x + o.w, y: o.y },
    { x: o.x, y: o.y + o.h },
    { x: o.x + o.w, y: o.y + o.h },
  ];
}

/** The squares an end covers as they draw: in Isometric the box round its corners at the ground's height, as a flat pill's is (drawnBox), and in Top-down the box round them. */
export function outlineBox(corners: readonly { x: number; y: number }[], iso: DrawSpace): Box {
  const seen = corners.map((c) => viewPointOf(iso, c));
  return { x0: Math.min(...seen.map((c) => c.x)), y0: Math.min(...seen.map((c) => c.y)), x1: Math.max(...seen.map((c) => c.x)), y1: Math.max(...seen.map((c) => c.y)) };
}

function boxesMeet(a: Box, b: Box): boolean {
  return Math.min(a.x1, b.x1) > Math.max(a.x0, b.x0) && Math.min(a.y1, b.y1) > Math.max(a.y0, b.y0);
}

/** One end's pills before they are placed: the name and the height chip as the end would hang them alone (LinkLayer.tsx). */
export type EndPills = { id: string; o: Outline; hole: boolean; first: PillSpec | null; dropPill: PillSpec | null };

/** One end's pills where they hang: `pill` is its name, `chip` its height. */
export type PlacedPills = { pill: PillSpec | null; chip: PillSpec | null };

/** The nodes a floor's search may visit before it keeps the best placement found, which the first path (each pill's cheapest choice alone) already is. */
const SEARCH_NODES = 20_000;

function hullOf(points: readonly { x: number; y: number }[]): { x: number; y: number }[] {
  const pts = [...points].sort((a, b) => a.x - b.x || a.y - b.y);
  const cross = (o: { x: number; y: number }, a: { x: number; y: number }, b: { x: number; y: number }) => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
  const half = (list: typeof pts) => {
    const out: typeof pts = [];
    for (const p of list) {
      while (out.length >= 2 && cross(out[out.length - 2]!, out[out.length - 1]!, p) <= 0) out.pop();
      out.push(p);
    }
    out.pop();
    return out;
  };
  return [...half(pts), ...half(pts.reverse())];
}

/**
 * Whether a box covers any of an end's squares as they draw: the convex
 * hull of its corners in view units, tested with separating axes. Touching
 * along an edge is no cover. The bounding box would count the empty corners
 * of a diamond.
 */
export function boxCoversOutline(box: Box, corners: readonly { x: number; y: number }[], iso: DrawSpace): boolean {
  const hull = hullOf(corners.map((c) => viewPointOf(iso, c)));
  if (hull.length < 3) return false;
  const E = 1e-9;
  const axes = [{ x: 1, y: 0 }, { x: 0, y: 1 }, ...hull.map((p, i) => {
    const q = hull[(i + 1) % hull.length]!;
    return { x: p.y - q.y, y: q.x - p.x };
  })];
  const rect = [{ x: box.x0, y: box.y0 }, { x: box.x1, y: box.y0 }, { x: box.x0, y: box.y1 }, { x: box.x1, y: box.y1 }];
  for (const a of axes) {
    const on = (pts: readonly { x: number; y: number }[]) => pts.map((p) => p.x * a.x + p.y * a.y);
    const r = on(rect);
    const h = on(hull);
    if (Math.min(Math.max(...r), Math.max(...h)) - Math.max(Math.min(...r), Math.min(...h)) <= E * Math.hypot(a.x, a.y)) return false;
  }
  return true;
}

/**
 * What a creature covers on the screen: its squares, and in Isometric the
 * standee rising from their middle as tall as they are deep (canvas/relief/standee.ts
 * standeeShape's frame), so a chip over a corner behind it keeps off its
 * upper body and its badges too (LP48FIXA-R1).
 */
export function tokenBox(r: FloorLink["rect"], iso: DrawSpace): Box {
  const ground = outlineBox(cornersOf({ ...r, loop: null }), iso);
  if (!iso) return ground;
  const foot = viewPointOf(iso, { x: r.x + r.w / 2, y: r.y + r.h / 2 });
  return { x0: Math.min(ground.x0, foot.x - r.w / 2), y0: Math.min(ground.y0, foot.y - r.h), x1: Math.max(ground.x1, foot.x + r.w / 2), y1: ground.y1 };
}

/** What one box covers of another: nothing, or a flat charge for each cover with the area added, so fewer covers always beat a smaller area. */
function covers(a: Box, b: Box, charge: number): number {
  return boxesMeet(a, b) ? charge + (Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0)) * (Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0)) : 0;
}

/** A pill over another pill weighs most, since two names on one row cannot be read, and one over its own hole more than one over another end's squares, since it hides the hole it names. The charges add up, so three covers of squares weigh as much as one of its own hole. */
const PILL_ON_PILL = 1_000_000;
const PILL_ON_OWN = 300_000;
const PILL_ON_SQUARES = 100_000;
/** A creature under a pill is hidden as a hole's squares are (LP47-POLISH). */
const PILL_ON_TOKEN = PILL_ON_SQUARES;

/**
 * Every end's pills on the floor shown (LP47B-ISO-1). A hole's pills are
 * wider than a small hole, and holes near each other let one's name cover
 * the other hole or its pills, or a creature beside it (LP47-POLISH). The
 * holes' pills are placed together: each name hangs under, and each chip
 * over, one corner of its hole where it stands (`stands`, always in
 * Top-down) and clears the turn's marker, centered or reaching outward
 * from the hole, or keeps the end's own edge, and the choice that costs
 * least wins. Each cover adds its charge and its area: a pill over a pill
 * weighs more than one over its own hole, which weighs more than one over
 * another end's squares or a token (D-261122-112). The charges add up, so
 * enough lesser covers can weigh as much as a greater one, and area only
 * breaks a tie of charges. The search keeps the first of equal choices,
 * so a lone hole's pills hang where they would alone: in Isometric a name
 * under the lowest corner on the screen and a chip over the highest, and
 * in Top-down from the middles of its bottom and top edges. Ends that are
 * not holes keep their own edge, and the holes keep off their pills.
 * Each pill is judged where it draws: near the edge of `view`, the clear
 * part of the screen at the camera's rest (canvas/boardView.ts
 * restViewSlot), a standing pill slides back inside it, which on a phone at
 * fit can put an outward pill onto its neighbor (ISO-1-PHONE-EDGE).
 * `prune` false searches without the lower bound, which only cuts the
 * search, so a test can check it changes no answer.
 */
export function placeEnds(ends: readonly EndPills[], markers: readonly PillSpec[], scale: number, iso: DrawSpace, stands: (p: PillSpec) => boolean, tokens: readonly FloorLink["rect"][] = [], options: { view?: Box | null; prune?: boolean } = {}): Map<string, PlacedPills> {
  const { view = null, prune = true } = options;
  const out = new Map<string, PlacedPills>();
  const squares = ends.map((e) => outlineBox(cornersOf(e.o), iso));
  const standing = tokens.map((r) => tokenBox(r, iso));
  type Cand = { spec: PillSpec; box: Box; solo: number };
  type Slot = { end: number; chip: boolean; cands: Cand[] };
  const slots: Slot[] = [];
  const fixed: Box[] = [];
  const edges = ends.map((e) => {
    const { o, hole, first } = e;
    // Every stage decides alike, from the first place's stand, so the ground and the overlay publish the same pill.
    return first ? clearOfMarkers(first, nameAnchor(o, hole ? "top" : "bottom"), markers, scale, iso, iso ? stands(first) : true) : null;
  });
  // Every pill stands in Top-down.
  const fits = (p: PillSpec) => iso === null || stands(p);
  ends.forEach((e, i) => {
    const edge = edges[i]!;
    if (!e.hole) {
      out.set(e.id, { pill: edge, chip: e.dropPill });
      for (const p of [edge, e.dropPill]) if (p) fixed.push(drawnBox(p, scale, iso, fits(p), true, view));
      return;
    }
    out.set(e.id, { pill: edge, chip: e.dropPill });
    const corners = cornersOf(e.o);
    const seen = corners.map((c) => viewPointOf(iso, c).x);
    const mid = (Math.min(...seen) + Math.max(...seen)) / 2;
    const lists: [PillSpec | null, boolean][] = [[edge, false], [e.dropPill, true]];
    for (const [spec, chip] of lists) {
      if (!spec) continue;
      const hangs = chip ? "over" : "under";
      const sign = hangs === "under" ? -1 : 1;
      const ordered = corners.map((c) => ({ c, y: viewPointOf(iso, c).y })).sort((a, b) => sign * (a.y - b.y));
      const at = (c: { x: number; y: number }, side?: "left" | "right"): PillSpec => ({ ...spec, x: c.x, y: c.y, above: chip, below: !chip, ...(side ? { side } : {}) });
      // Each corner centers a pill, and a corner left or right of the hole's middle also hangs one outward on its side, which clears the hole where a centered pill wider than it cannot (ISO-1-MORE-SPOTS).
      const outward = ordered.flatMap(({ c }) => {
        const x = seen[corners.indexOf(c)]!;
        return x < mid - 1e-9 ? [at(c, "left")] : x > mid + 1e-9 ? [at(c, "right")] : [];
      });
      const specs = [...ordered.map(({ c }) => at(c)), ...outward].filter((p) => fits(p) && (chip || !meetsTurnMarker(p, markers, scale, iso, true)));
      // In Isometric the end's own edge is the last choice, and the only one where no corner serves. In Top-down it is the first, as a lone hole's name and chip hang from its edges' middles.
      if (!iso) specs.unshift(spec);
      else if (specs.length === 0 || stands(spec)) specs.push(spec);
      const cands = specs.map((s2) => {
        const up = fits(s2);
        const box = drawnBox(s2, scale, iso, up, true, view);
        // The pointer always meets the rim it points at, so only the body can hide the hole.
        const tip = up ? pillGeometry({ ...s2, scale }).pointer / scale : 0;
        const body = chip ? { ...box, y1: box.y1 - tip } : { ...box, y0: box.y0 + tip };
        // A pill over its own hole hides the hole it names, so it costs more than one over another end's squares, but less than one over another pill (D-261122-112).
        return { spec: s2, box, solo: boxCoversOutline(body, corners, iso) ? covers(body, squares[i]!, PILL_ON_OWN) : 0 };
      });
      slots.push({ end: i, chip, cands });
    }
  });
  // What a pill covers apart from the other holes' pills: another end's squares, the tokens, and the pills that stay put.
  for (const slot of slots) {
    for (const c of slot.cands) {
      c.solo += squares.reduce((n, b, j) => (j !== slot.end ? n + covers(c.box, b, PILL_ON_SQUARES) : n), 0) + standing.reduce((n, b) => n + covers(c.box, b, PILL_ON_TOKEN), 0) + fixed.reduce((n, b) => n + covers(c.box, b, PILL_ON_PILL), 0);
    }
    // Cheapest first, so the first path is already good when the node limit cuts the search short. The sort is stable, so equal choices keep their corner order.
    slot.cands.sort((a, b) => a.solo - b.solo);
  }
  // The least the slots from each one on can still add, which prunes a path that cannot beat the best.
  const rest = slots.map(() => 0);
  for (let k = slots.length - 1, sum = 0; k >= 0; k--) rest[k] = sum += slots[k]!.cands[0]?.solo ?? 0;
  const best = { cost: Infinity, pick: [] as Cand[] };
  let nodes = 0;
  const pick: Cand[] = [];
  const search = (at: number, cost: number): void => {
    if (cost + (prune ? (rest[at] ?? 0) : 0) >= best.cost) return;
    if (at === slots.length) {
      best.cost = cost;
      best.pick = pick.slice();
      return;
    }
    for (const c of slots[at]!.cands) {
      if (best.pick.length > 0 && nodes++ > SEARCH_NODES) return;
      let next = cost + c.solo;
      for (const q of pick) next += covers(c.box, q.box, PILL_ON_PILL);
      pick.push(c);
      search(at + 1, next);
      pick.pop();
    }
  };
  search(0, 0);
  best.pick.forEach((c, k) => {
    const slot = slots[k]!;
    const id = ends[slot.end]!.id;
    const placed = out.get(id)!;
    out.set(id, slot.chip ? { ...placed, chip: c.spec } : { ...placed, pill: c.spec });
  });
  return out;
}
