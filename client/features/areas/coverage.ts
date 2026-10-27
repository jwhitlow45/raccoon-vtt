import type { Character, RoomState, Scene, Token } from "#shared/model.ts";
import {
  CoverageCache,
  coverageCacheKey,
  creaturesInArea,
  SAMPLES,
  type AreaContext,
  type AreaTemplateInput,
  type AreaToken,
  type CoverageResult,
} from "#shared/rules/aoe.ts";
import { sceneWalls } from "#shared/rules/walls.ts";
import { sceneGrid, type Grid } from "#shared/rules/grid.ts";
import { HEX_R, hexCenter } from "#shared/rules/hex.ts";
import type { FogView } from "../../canvas/relief/fogView.ts";
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
 */

/** The parts of the view coverage reads, so a renderer can subscribe to just these. */
export type AreaInputs = Pick<RoomState, "tokens" | "buildChunks"> & { settings: RoomState["meta"]["settings"] };

export function areaContext(view: RoomState, scene: Scene, samples: number = SAMPLES): AreaContext {
  return contextFrom({ tokens: view.tokens, buildChunks: view.buildChunks, settings: view.meta.settings }, scene, samples);
}

export function contextFrom(inputs: AreaInputs, scene: Scene, samples: number = SAMPLES): AreaContext {
  return {
    settings: inputs.settings,
    bounds: scene.bounds,
    grid: sceneGrid(scene),
    walls: sceneWalls(scene, inputs.buildChunks),
    tokens: inputs.tokens as Readonly<Record<string, AreaToken>>,
    samples,
  };
}

const coverage = new CoverageCache(256);

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
 * otherwise the revealed sub-cells of its window, as rectangles in cells.
 * The shading is cut by every wall this device holds, those under a
 * player's fog included, so over a fogged sub-cell its edge would draw
 * them. The rule is a moving aura's (canvas/markStand.ts auraClip).
 */
export function shadingClip(fog: FogView, cov: Pick<CoverageResult, "x0" | "y0" | "w" | "h" | "hexes">, g: Grid): { x: number; y: number; w: number; h: number }[] | null {
  const win = coveredWindow(cov, g);
  const box = { x0: win.x0, y0: win.y0, x1: win.x0 + win.w, y1: win.y0 + win.h };
  return fog.all || fog.boxClear(box) ? null : fog.revealedRects(box);
}

export function cachedCoverage(t: AreaTemplateInput, ctx: AreaContext): CoverageResult {
  return coverage.get(t, ctx);
}

const caught = new WeakMap<object, Map<string, string[]>>();
const CAUGHT_PER_MAP = 64;
const NOBODY: string[] = [];

/** The tokens on `sceneId` a template catches, in the view's order. Cached until any token changes. */
export function caughtTokens(t: AreaTemplateInput, ctx: AreaContext, sceneId: string): string[] {
  const tokens = ctx.tokens;
  if (!tokens) return NOBODY;
  let byKey = caught.get(tokens);
  if (!byKey) caught.set(tokens, (byKey = new Map()));
  const key = `${sceneId}|${coverageCacheKey(t, ctx)}`;
  const hit = byKey.get(key);
  if (hit) return hit;
  const onScene = Object.values(tokens).filter((tok): tok is AreaToken => !!tok && tok.sceneId === sceneId);
  const ids = creaturesInArea({ ...t, sceneId }, onScene, ctx);
  byKey.set(key, ids);
  if (byKey.size > CAUGHT_PER_MAP) {
    const oldest = byKey.keys().next().value;
    if (oldest !== undefined) byKey.delete(oldest);
  }
  return ids;
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
