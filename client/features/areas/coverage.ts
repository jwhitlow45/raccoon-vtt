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
    walls: sceneWalls(scene, inputs.buildChunks),
    tokens: inputs.tokens as Readonly<Record<string, AreaToken>>,
    samples,
  };
}

const coverage = new CoverageCache(256);

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
