import { FOG_SUBCELLS, type CellRect, type FloorLink, type RoomState, type Scene, type SceneId } from "../model.ts";
import { ownEntry } from "../records.ts";
import { isWritable } from "../writable.ts";
import { playersSee } from "./floors.ts";
import { sceneGrid } from "./grid.ts";
import { hexSubcells } from "./hex.ts";
import type { Join } from "./vision.ts";

/*
 * Sight and light through openings (docs/design/design-v1-floors.md phase 4,
 * 7): which openings join a floor to the next, read by vision.ts through
 * its VisionWorld (ruleHooks.ts), so vision.ts imports neither walls.ts nor
 * the stairs' rules.
 */

const NONE: Join[] = [];

/**
 * The joins of a floor (7.1): each opening on it whose two floors both have
 * party vision on and that players both see (rules/floors.ts playersSee),
 * in id order. A blackout, a floor not reached, or a floor held only
 * through a creature the DM hid makes none. Every input is public to
 * players, as the gate must be: whether a join exists changes what every
 * class sees, so it may turn on nothing a player could not know.
 */
export function openingJoins(state: RoomState, sceneId: SceneId): Join[] {
  // Most rooms hold no link at all, and every sight read asks.
  if (state.floorLinks === undefined) return NONE;
  const keep = finished(state);
  let byScene = keep ? joinsByState.get(state) : undefined;
  const hit = byScene?.get(sceneId);
  if (hit !== undefined) return hit;
  const joins = joinsOf(state, sceneId);
  if (keep) {
    if (!byScene) joinsByState.set(state, (byScene = new Map()));
    byScene.set(sceneId, joins);
  }
  return joins;
}

const joinsByState = new WeakMap<RoomState, Map<SceneId, Join[]>>();

/** Whether no op writes into the state or a collection the gate reads any more (writable.ts), so an answer kept for it holds. */
function finished(state: RoomState): boolean {
  return (
    !isWritable(state) &&
    !isWritable(state.floorLinks ?? {}) &&
    !isWritable(state.scenes) &&
    !isWritable(state.tokens) &&
    !isWritable(state.characters) &&
    !isWritable(state.openFloors ?? {}) &&
    !isWritable(state.meta)
  );
}

function joinsOf(state: RoomState, sceneId: SceneId): Join[] {
  const scene = ownEntry(state.scenes, sceneId);
  if (!scene || scene.vision?.on !== true || !playersSee(state, sceneId)) return NONE;
  const fitting = fittingJoins(state, scene);
  if (fitting.length === 0) return NONE;
  // Every join of a floor mostly leads to one floor, so each far floor's gate is asked once.
  const seen = new Map<SceneId, boolean>();
  const sees = (id: SceneId) => {
    let known = seen.get(id);
    if (known === undefined) seen.set(id, (known = playersSee(state, id)));
    return known;
  };
  const out = fitting.filter((join) => sees(join.other));
  return out.length > 0 ? out : NONE;
}

/*
 * The joins of a floor whose ends and floors fit, in id order, before the
 * players' gate: an opening not hidden, its pair crossing back, both floors
 * with party vision on, one rect under one grid shape. Only the links and
 * the scenes decide them, which a creature's move leaves as they were, so
 * they are kept per scene while both stay the same objects, as linksProblem
 * keeps its answers (D-261120-005). The gate reads the creatures and the
 * room's view, so it is asked of each state.
 */
const fittingByLinks = new WeakMap<object, { scenes: RoomState["scenes"]; byScene: Map<SceneId, Join[]> }>();

function fittingJoins(state: RoomState, scene: Scene): Join[] {
  const links = state.floorLinks ?? {};
  const keep = !isWritable(links) && !isWritable(state.scenes);
  let kept = keep ? fittingByLinks.get(links) : undefined;
  if (keep && kept?.scenes !== state.scenes) fittingByLinks.set(links, (kept = { scenes: state.scenes, byScene: new Map() }));
  const hit = kept?.byScene.get(scene.id);
  if (hit !== undefined) return hit;
  const ends = Object.values(links)
    .filter((link) => link.sceneId === scene.id && link.kind === "opening" && link.hidden !== true)
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const out: Join[] = [];
  for (const link of ends) {
    const other = ownEntry(state.scenes, link.to);
    const pair = ownEntry(links, link.pair);
    if (!other || other.vision?.on !== true || !pair || pair.kind !== "opening" || pair.sceneId !== link.to || pair.to !== scene.id) continue;
    // Both floors' sub-cells must be one column: the same squares under the same grid.
    if (!sameRect(pair.rect, link.rect) || (other.gridShape ?? "squares") !== (scene.gridShape ?? "squares")) continue;
    out.push({ linkId: link.id, rev: link.rev, rect: link.rect, other: link.to, subs: subsOf(scene, other, link) });
  }
  kept?.byScene.set(scene.id, out);
  return out;
}

function sameRect(a: CellRect, b: CellRect): boolean {
  return a.x === b.x && a.y === b.y && a.w === b.w && a.h === b.h;
}

/*
 * The fog sub-cells of an end's squares in row order: on squares every
 * sub-cell of each cell, on hexes those whose centers lie inside each hex
 * (hex.ts hexSubcells), as a creature on hexes is read, and only those on
 * both floors, so neither floor's sight reaches past its own raster. Kept
 * per end, shape and the floors' sizes, since ends are replaced and never
 * changed.
 */
const subsByLink = new WeakMap<FloorLink, Map<string, readonly (readonly [number, number])[]>>();

function subsOf(scene: Scene, other: Scene, link: FloorLink): readonly (readonly [number, number])[] {
  const shape = scene.gridShape ?? "squares";
  const W = Math.min(scene.bounds.w, other.bounds.w) * FOG_SUBCELLS;
  const H = Math.min(scene.bounds.h, other.bounds.h) * FOG_SUBCELLS;
  const at = `${shape}|${W}|${H}`;
  let byShape = subsByLink.get(link);
  if (!byShape) subsByLink.set(link, (byShape = new Map()));
  const hit = byShape.get(at);
  if (hit) return hit;
  const g = sceneGrid(scene);
  const r = link.rect;
  const out: [number, number][] = [];
  if (g.shape === "hex") {
    const seen = new Set<string>();
    for (let row = r.y; row < r.y + r.h; row++) {
      for (let col = r.x; col < r.x + r.w; col++) {
        for (const [sx, sy] of hexSubcells(g, { col, row })) {
          const key = `${sx},${sy}`;
          if (sx < 0 || sy < 0 || sx >= W || sy >= H || seen.has(key)) continue;
          seen.add(key);
          out.push([sx, sy]);
        }
      }
    }
    out.sort((a, b) => a[1] - b[1] || a[0] - b[0]);
  } else {
    for (let sy = r.y * FOG_SUBCELLS; sy < Math.min(H, (r.y + r.h) * FOG_SUBCELLS); sy++) for (let sx = r.x * FOG_SUBCELLS; sx < Math.min(W, (r.x + r.w) * FOG_SUBCELLS); sx++) out.push([sx, sy]);
  }
  byShape.set(at, out);
  return out;
}
