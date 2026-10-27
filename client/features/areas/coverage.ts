import type { Character, RoomState, Scene, Token } from "#shared/model.ts";
import {
  CoverageCache,
  coverageCacheKey,
  creaturesInArea,
  resolveArea,
  SAMPLES,
  type AreaContext,
  type AreaTemplateInput,
  type AreaToken,
  type CoverageResult,
} from "#shared/rules/aoe.ts";
import { FREE_WALL_LATTICE } from "#shared/model.ts";
import { convexLive, type Ground } from "#shared/rules/held.ts";
import { rayHull } from "#shared/reducer/areaTriggers.ts";
import { sceneWalls, type WallSet } from "#shared/rules/walls.ts";
import { sceneGrid, type Grid } from "#shared/rules/grid.ts";
import { HEX_R, hexCenter } from "#shared/rules/hex.ts";
import { auraClip } from "../../canvas/markStand.ts";
import type { FogView } from "../../canvas/relief/fogView.ts";
import { standingStretches } from "../../canvas/relief/runs.ts";
import { displayName } from "../../lib/scene.ts";

/**
 * The client's side of area coverage: the rules context for a scene, and
 * caches so a redraw never recomputes what has not changed.
 *
 * Shading is cached per `coverageCacheKey` (design 9.3), which already lists
 * the attached token's rev and position, the settings and the walls
 * version. Who is caught also depends on every other token, so that answer
 * is cached per tokens map: the view gives the map a new identity whenever
 * any token changes, and the old answers go with the old map.
 *
 * The walls version in that key is the derived wall set's own, which
 * changes whenever the scene's chunks, automatic walls rule or bounds do
 * (rules/walls.ts `sceneWalls`). So a change of automatic walls, or its
 * undo, refreshes shading even where it moves no chunk, and an optimistic
 * build the server refused can never leave shading behind under a walls
 * version number the next build reuses.
 *
 * On a hex scene the context carries the scene's grid, so coverage is
 * graded per hex and an emanation counts steps (docs/design-v1-hex-grids.md
 * HX-D11), and the board shades the result's `hexes`: one source of
 * truth, the very hexes the server reads for who an area catches.
 *
 * An area being aimed on a player's device, on a scene with fog, reads only
 * the walls that player could know (`heldWalls`), so a wall wholly under
 * their fog shapes nothing they see, wherever its origin lies. Its shading
 * and who it rings can then differ from the cast across fogged ground,
 * which the server decides with every wall.
 *
 * On a player's device a creature is in an area's caught list, and gets a
 * target ring, only when every ray the area's inclusion reads to it lies
 * on that device's live ground (`live`, docs/design-v1-map-discovery.md
 * decision 13), the server's rule for the reminders and caught lines a
 * player gets. The device's live ground is its sight with fog and party
 * vision on, and its revealed fog with vision off (rules/held.ts
 * deviceGround). It cannot tell ground the DM revealed from ground the
 * party only explored, since its fog merges them, so on DM-revealed ground
 * out of sight it can list fewer than the server's answer, which settles
 * it (LK-35). A device still shades coverage by the walls it holds.
 */

/** The parts of the view coverage reads, so a renderer can subscribe to just these. `live` is a player's device's live ground (liveGround.ts), on a scene with fog on. */
export type AreaInputs = Pick<RoomState, "tokens" | "buildChunks"> & { settings: RoomState["meta"]["settings"]; live?: Ground | null };

/** An area context on this device, with its live ground where a player's caught list reads it. */
export type DeviceAreaContext = AreaContext & { live?: Ground };

export function areaContext(view: RoomState, scene: Scene, samples: number = SAMPLES): DeviceAreaContext {
  return contextFrom({ tokens: view.tokens, buildChunks: view.buildChunks, settings: view.meta.settings }, scene, samples);
}

/** `fog` is the viewer's for an area being aimed (canvas/viewerFog.ts): its walls are then the ones that viewer could know. */
export function contextFrom(inputs: AreaInputs, scene: Scene, samples: number = SAMPLES, fog?: FogView): DeviceAreaContext {
  const walls = sceneWalls(scene, inputs.buildChunks);
  return {
    settings: inputs.settings,
    bounds: scene.bounds,
    grid: sceneGrid(scene),
    walls: fog ? heldWalls(walls, fog) : walls,
    tokens: inputs.tokens as Readonly<Record<string, AreaToken>>,
    samples,
    ...(inputs.live ? { live: inputs.live } : {}),
  };
}

const coverage = new CoverageCache(256);

/** Each wall set as each fog reads it, kept while both are: the store replaces the fog's tiles on every change. */
const held = new WeakMap<WallSet, WeakMap<object, WallSet>>();
let heldSets = 0;

/**
 * The walls a viewer could know: each wall, door, window, pillar side and
 * ledge cut to the stretches with a revealed sub-cell beside them, as
 * Isometric stands a player's walls (relief/runs.ts standingStretches).
 * A cut end inside a sub-cell, on a slanted wall, goes to the nearest
 * point of the 1/64 lattice, as the wall split needs (rules/segments.ts),
 * which moves it less than a pixel. The set itself for a viewer who sees
 * all the ground.
 */
export function heldWalls(walls: WallSet, fog: FogView): WallSet {
  if (fog.all || !fog.tiles) return walls;
  let byFog = held.get(walls);
  if (!byFog) held.set(walls, (byFog = new WeakMap()));
  let set = byFog.get(fog.tiles);
  if (!set) {
    const lattice = (v: number) => Math.round(v * FREE_WALL_LATTICE) / FREE_WALL_LATTICE;
    set = walls.cutTo(`${walls.version}|held:${++heldSets}`, (ax, ay, bx, by) => {
      const parts: number[] = [];
      for (const [t0, t1] of standingStretches(fog, { x: ax, y: ay }, { x: bx, y: by })) {
        const p = t0 === 0 ? [ax, ay] : [lattice(ax + (bx - ax) * t0), lattice(ay + (by - ay) * t0)];
        const q = t1 === 1 ? [bx, by] : [lattice(ax + (bx - ax) * t1), lattice(ay + (by - ay) * t1)];
        if (p[0] !== q[0] || p[1] !== q[1]) parts.push(p[0]!, p[1]!, q[0]!, q[1]!);
      }
      return parts;
    });
    byFog.set(fog.tiles, set);
  }
  return set;
}

/**
 * The window of cells a result's shading lies in: on squares the window
 * coverage examined, and on hexes the cells the covered hexes reach into,
 * each a cell across its flats and 2 HEX_R across its points. An empty
 * result has an empty window.
 */
export function coveredWindow(cov: Pick<CoverageResult, "x0" | "y0" | "w" | "h" | "hexes">, g: Grid): { x0: number; y0: number; w: number; h: number } {
  if (g.shape !== "hex" || !cov.hexes) return { x0: cov.x0, y0: cov.y0, w: cov.w, h: cov.h };
  if (cov.hexes.length === 0) return { x0: 0, y0: 0, w: 0, h: 0 };
  const half = g.orient === "rows" ? { x: 0.5, y: HEX_R } : { x: HEX_R, y: 0.5 };
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const c of cov.hexes) {
    const p = hexCenter(g, c);
    x0 = Math.min(x0, p.x - half.x);
    y0 = Math.min(y0, p.y - half.y);
    x1 = Math.max(x1, p.x + half.x);
    y1 = Math.max(y1, p.y + half.y);
  }
  const fx = Math.floor(x0);
  const fy = Math.floor(y0);
  return { x0: fx, y0: fy, w: Math.ceil(x1) - fx, h: Math.ceil(y1) - fy };
}

/**
 * Where an area's shading may show when it draws above the fog, as an
 * aimed area does (AreaPreviewLayer.tsx): null where it shows whole, to a
 * viewer who sees all the ground or over a window wholly revealed, and
 * otherwise the revealed sub-cells of its window, as rectangles in cells:
 * a moving aura's rule (canvas/markStand.ts auraClip). The fog stays
 * opaque, as over a placed area, which lies under it.
 */
export function shadingClip(fog: FogView, cov: Pick<CoverageResult, "x0" | "y0" | "w" | "h" | "hexes">, g: Grid): { x: number; y: number; w: number; h: number }[] | null {
  const win = coveredWindow(cov, g);
  return auraClip(fog, { x0: win.x0, y0: win.y0, x1: win.x0 + win.w, y1: win.y0 + win.h });
}

export function cachedCoverage(t: AreaTemplateInput, ctx: AreaContext): CoverageResult {
  return coverage.get(t, ctx);
}

const caught = new WeakMap<object, Map<string, string[]>>();
const CAUGHT_PER_MAP = 64;
const NOBODY: string[] = [];

/** A serial per live ground, so a caught list is kept per ground: the device makes a new one whenever its fog or sight tiles change (liveGround.ts). */
const grounds = new WeakMap<Ground, number>();
let groundSerial = 0;

function groundKey(live: Ground | undefined): string {
  if (!live) return "";
  let k = grounds.get(live);
  if (k === undefined) grounds.set(live, (k = ++groundSerial));
  return `live:${k}`;
}

/**
 * The tokens on `sceneId` a template catches, in the view's order, and on
 * a player's device only those whose rays lie on its live ground
 * (`raysLive`). Cached until any token, or the live ground, changes.
 */
export function caughtTokens(t: AreaTemplateInput, ctx: DeviceAreaContext, sceneId: string): string[] {
  const tokens = ctx.tokens;
  if (!tokens) return NOBODY;
  let byKey = caught.get(tokens);
  if (!byKey) caught.set(tokens, (byKey = new Map()));
  const key = `${sceneId}|${groundKey(ctx.live)}|${coverageCacheKey(t, ctx)}`;
  const hit = byKey.get(key);
  if (hit) return hit;
  const onScene = Object.values(tokens).filter((tok): tok is AreaToken => !!tok && tok.sceneId === sceneId);
  const live = ctx.live;
  const all = creaturesInArea({ ...t, sceneId }, onScene, ctx);
  const ids = live ? all.filter((id) => raysLive(t, tokens[id]!, ctx, live)) : all;
  byKey.set(key, ids);
  if (byKey.size > CAUGHT_PER_MAP) {
    const oldest = byKey.keys().next().value;
    if (oldest !== undefined) byKey.delete(oldest);
  }
  return ids;
}

/**
 * Whether every ray an area's inclusion reads to a creature lies on a
 * player's live ground (docs/design-v1-map-discovery.md decision 13), by
 * the hull the server reads for the reminders that player gets
 * (shared/reducer/areaTriggers.ts `rayHull`): every cell of the scene's
 * grid it touches live. So a player's list never says an area reaches a
 * creature through ground they do not see now, where a remembered wall
 * may be gone or an unseen one stand.
 */
export function raysLive(t: AreaTemplateInput, creature: AreaToken, ctx: AreaContext, live: Ground): boolean {
  const attached = t.attachedTo !== undefined ? ctx.tokens?.[t.attachedTo] : undefined;
  return convexLive(live, rayHull(ctx.grid, t, resolveArea(t, ctx), attached, creature));
}

export type InAreaEntry = { id: string; name: string; ally: boolean; dead: boolean };

/** Names as this viewer's projection gives them, allies marked, the living first. */
export function inAreaEntries(
  ids: readonly string[],
  tokens: Readonly<Record<string, Token | undefined>>,
  characters: Readonly<Record<string, Character | undefined>> | undefined,
): InAreaEntry[] {
  const entries: InAreaEntry[] = [];
  for (const id of ids) {
    const t = tokens[id];
    if (!t) continue;
    const actor = "inline" in t.actor ? t.actor.inline : characters?.[t.actor.ref]?.actor;
    entries.push({ id, name: displayName(t), ally: t.disposition === "ally", dead: actor?.life === "dead" });
  }
  const order = (e: InAreaEntry) => (e.dead ? 2 : e.ally ? 1 : 0);
  return entries.sort((a, b) => order(a) - order(b) || a.name.localeCompare(b.name, undefined, { numeric: true }));
}

/** "Goblin 1, Goblin 2, Thorn (ally)", or "Nobody". */
export function inAreaText(entries: readonly InAreaEntry[]): string {
  if (entries.length === 0) return "Nobody";
  return entries.map((e) => `${e.name}${e.ally ? " (ally)" : ""}${e.dead ? " (dead)" : ""}`).join(", ");
}
