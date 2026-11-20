import { FOG_SUBCELLS, type CellRect, type FreeWall, type Light, type LightLevel, type RoomState, type SceneId, type Token } from "./model.ts";
import { wallChunk } from "./keys.ts";
import { GROUND, OPENING_RECT, UPPER, tower, withOpening } from "./floorLinksTestutil.ts";
import type { PartySight } from "./ruleHooks.ts";
import { NOT_SEEN, sightTileLevels } from "./rules/vision.ts";
import { actor, character, member, token } from "./testutil.ts";

/*
 * Sight through openings' test world (docs/design/design-v1-floors.md
 * phase 4, 7): the stairs tests' tower (floorLinksTestutil.ts) with party
 * vision and fog on every floor, an opening from Upper floor down to
 * Ground floor, and readers of the levels a sight holds there. Not a test
 * file itself.
 */

export type TowerLight = { ground?: LightLevel; upper?: LightLevel; attic?: LightLevel };

/**
 * The tower with vision and fog on each floor at its light (dark unless
 * told), the opening (o1 on Upper floor, o2 below it) at OPENING_RECT
 * unless `opening` is false, Upper floor reached by its opened mark unless
 * `reached` is false, and the floors in `perPlayer` per-player.
 */
export function openTower(light: TowerLight = {}, opts: { opening?: boolean; reached?: boolean; perPlayer?: readonly SceneId[]; rect?: CellRect } = {}, over: Partial<RoomState> = {}): RoomState {
  const base = tower({ tokens: {}, members: { dm1: member("dm1", "dm"), p1: member("p1"), p2: member("p2"), p3: member("p3") }, ...over });
  const lit: Record<string, LightLevel> = { [GROUND]: light.ground ?? "dark", [UPPER]: light.upper ?? "dark", at: light.attic ?? "dark" };
  const scenes = { ...base.scenes };
  for (const [id, level] of Object.entries(lit)) {
    const s = scenes[id]!;
    scenes[id] = { ...s, fogEnabled: true, vision: { on: true, light: level, ...(opts.perPlayer?.includes(id) ? { perPlayer: true as const } : {}) } };
  }
  let state: RoomState = { ...base, scenes, tokens: over.tokens ?? {}, characters: { ...base.characters, ...over.characters } };
  if (opts.reached !== false) state = { ...state, openFloors: { ...state.openFloors, [UPPER]: { sceneId: UPPER, rev: 0 } } };
  if (opts.opening !== false) state = withOpening(state, opts.rect ? { rect: opts.rect } : {});
  return state;
}

/** A player's creature that lends sight: a PC owned by `owner`, without darkvision unless told. */
export function pc(id: string, owner: string, sceneId: SceneId, x: number, y: number, over: Partial<Token> = {}, senses = ""): Token {
  return token(id, { kind: "pc", name: id, disposition: "ally", ownerIds: [owner], actor: { inline: actor({ senses }) }, sceneId, x, y, ...over });
}

/** A creature the DM marked to lend every player its sight. */
export function ally(id: string, sceneId: SceneId, x: number, y: number, over: Partial<Token> = {}): Token {
  return token(id, { kind: "npc", name: id, disposition: "ally", partyVision: true, sceneId, x, y, ...over });
}

/** A monster that lends nothing. */
export function goblin(id: string, sceneId: SceneId, x: number, y: number, over: Partial<Token> = {}): Token {
  return token(id, { name: "Goblin", sceneId, x, y, ...over });
}

/** A free light, on, whose walls cast shadows. */
export function lamp(id: string, sceneId: SceneId, x: number, y: number, over: Partial<Light> = {}): Light {
  return { id, rev: 0, sceneId, x, y, bright: 10, dim: 10, on: true, walls: true, ...over };
}

/** A room with these tokens and lights put in. */
export function withAll(state: RoomState, tokens: readonly Token[] = [], lights: readonly Light[] = []): RoomState {
  return { ...state, tokens: { ...state.tokens, ...Object.fromEntries(tokens.map((t) => [t.id, t])) }, lights: { ...state.lights, ...Object.fromEntries(lights.map((l) => [l.id, l])) } };
}

/** A room with a free wall on a floor, from (x0, y0) to (x1, y1) in cells, at most 8 cells long. `id` is padded to a wall id's 12 characters. */
export function withWall(state: RoomState, sceneId: SceneId, id: string, x0: number, y0: number, x1: number, y1: number): RoomState {
  const wall: FreeWall = { id: id.padEnd(12, "0"), a: [x0, y0], b: [x1, y1], f: { kind: "wall" } };
  const { cx, cy } = wallChunk(wall);
  const key = `${sceneId}:${cx},${cy}`;
  const was = state.buildChunks[key] ?? { sceneId, cx, cy, rev: 1, cells: {}, edges: {} };
  return { ...state, buildChunks: { ...state.buildChunks, [key]: { ...was, rev: was.rev + 1, walls: [...(was.walls ?? []), wall] } } };
}

/** The sub-cells of a rectangle of cells on squares, in row order. */
export function subsOf(rect: CellRect = OPENING_RECT): [number, number][] {
  const out: [number, number][] = [];
  for (let sy = rect.y * FOG_SUBCELLS; sy < (rect.y + rect.h) * FOG_SUBCELLS; sy++) for (let sx = rect.x * FOG_SUBCELLS; sx < (rect.x + rect.w) * FOG_SUBCELLS; sx++) out.push([sx, sy]);
  return out;
}

const TILE_SUB = 16 * FOG_SUBCELLS;

/** One sub-cell's level in a sight's tiles. */
export function levelAt(sight: PartySight, sx: number, sy: number): number {
  const tx = Math.floor(sx / TILE_SUB);
  const ty = Math.floor(sy / TILE_SUB);
  const tile = sight.tiles.get(`${tx},${ty}`);
  const levels = tile ? sightTileLevels(tile) : null;
  return levels ? levels[(sy - ty * TILE_SUB) * TILE_SUB + (sx - tx * TILE_SUB)]! : NOT_SEEN;
}

/** The levels a sight holds over these sub-cells, in their order. */
export function levelsAt(sight: PartySight, subs: readonly (readonly [number, number])[]): number[] {
  return subs.map(([sx, sy]) => levelAt(sight, sx, sy));
}

/** Every sub-cell's level a sight holds over a floor of `w` by `h` cells, row by row. */
export function levelGrid(sight: PartySight, w = 20, h = 20): Uint8Array {
  const W = w * FOG_SUBCELLS;
  const out = new Uint8Array(W * h * FOG_SUBCELLS);
  for (const [at, tile] of sight.tiles) {
    const [tx, ty] = at.split(",").map(Number) as [number, number];
    const levels = sightTileLevels(tile);
    if (!levels) continue;
    for (let j = 0; j < TILE_SUB; j++) {
      const sy = ty * TILE_SUB + j;
      if (sy >= h * FOG_SUBCELLS) break;
      for (let i = 0; i < TILE_SUB; i++) {
        const sx = tx * TILE_SUB + i;
        if (sx < W) out[sy * W + sx] = levels[j * TILE_SUB + i]!;
      }
    }
  }
  return out;
}

/**
 * The joined answer 7.2 asks for, worked out from the two floors' own
 * answers: the own floor's level everywhere, and inside the join's
 * sub-cells the better of it and the other floor's.
 */
export function joinedGrid(own: PartySight, other: PartySight, subs: readonly (readonly [number, number])[], w = 20, h = 20): Uint8Array {
  const out = levelGrid(own, w, h);
  const theirs = levelGrid(other, w, h);
  const W = w * FOG_SUBCELLS;
  for (const [sx, sy] of subs) out[sy * W + sx] = Math.max(out[sy * W + sx]!, theirs[sy * W + sx]!);
  return out;
}

/** A sight's tiles as plain entries, to compare two sights by what they hold. */
export function tilesOf(sight: PartySight): [string, unknown][] {
  return [...sight.tiles].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
}

export { character };
