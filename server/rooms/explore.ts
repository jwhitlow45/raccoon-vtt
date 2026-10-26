import { holderTileKey, tileKey } from "#shared/keys.ts";
import { exploringSceneId, LIMITS } from "#shared/limits.ts";
import type { FogTile, RoomState, Scene, SightTile, Token } from "#shared/model.ts";
import { perPlayerScene, sightHolders } from "#shared/project.ts";
import type { OpOf } from "#shared/protocol.ts";
import { visionRules } from "#shared/ruleHooks.ts";
import { decodeTile, encodeTile } from "#shared/rules/fog.ts";
import { seenFogBits, visionReport, type VisionWorld } from "#shared/rules/vision.ts";
import { sceneWalls } from "#shared/rules/walls.ts";

/**
 * The explore step (docs/design-v1-maps-vision.md 4.3.3): after a batch,
 * what the party sees on the player scene that its explored layer lacks,
 * as the one `sys.explore` the actor appends to the batch. Only the player
 * scene explores, only while its vision and fog are on, and nothing is
 * explored behind a blackout, since players are shown nothing then. The
 * DM's own fog is not read: ground the DM revealed is recorded as explored
 * once the party sees it, so undoing the reveal leaves it to players.
 *
 * Each tile carries its new bits, the explored tile joined with what the
 * party sees there, so the stored op says what the layer became. Tiles go
 * in row order, so the same state always gives the same op.
 *
 * On a per-player scene (docs/design-v1-per-player-vision.md 6.1 and 6.3)
 * the step also decides who joins the holder list, with vision on, and
 * with fog on as well it writes the shared sight into the party's layer
 * and each holder's own sight, less what the party's layer and their own
 * hold, into theirs (perPlayerExplore).
 */
export function exploreOp(state: RoomState): OpOf<"sys.explore"> | null {
  if (state.meta.view?.blackout === true) return null;
  const playerScene = state.meta.playerSceneId === null ? undefined : state.scenes[state.meta.playerSceneId];
  if (playerScene && perPlayerScene(playerScene)) return perPlayerExplore(state, playerScene);
  const sceneId = exploringSceneId(state);
  if (sceneId === null) return null;
  const tiles = partyTiles(state, sceneId, visionRules.partySight(state, sceneId).tiles);
  if (tiles.length === 0) return null;
  return { t: "sys.explore", sceneId, tiles };
}

type ExploredTiles = { tx: number; ty: number; bits: string }[];

/** The party layer's new tiles for what `sight` sees, in row order. */
function partyTiles(state: RoomState, sceneId: string, sight: ReadonlyMap<string, SightTile>): ExploredTiles {
  const tiles: ExploredTiles = [];
  for (const [at, tile] of sight) {
    const [tx, ty] = at.split(",").map(Number) as [number, number];
    const bits = explored(tile, state.exploredTiles[tileKey(sceneId, tx, ty)]);
    if (bits !== null) tiles.push({ tx, ty, bits });
  }
  return tiles.sort((a, b) => a.ty - b.ty || a.tx - b.tx);
}

/*
 * The per-player step, on the player scene with vision on. Joins come
 * first: the reducer applies them before any layer, so a player who joins
 * ticked gets their layer's first tiles in the same op. Each holder's sight
 * is read here, before the commit, so the fan-out finds every holder's
 * raster drawn (design 8.1).
 */
function perPlayerExplore(state: RoomState, scene: Scene): OpOf<"sys.explore"> | null {
  if (scene.vision?.on !== true) return null;
  const join = joinsOf(state, scene);
  const tiles: ExploredTiles = [];
  const members: { memberId: string; tiles: ExploredTiles }[] = [];
  if (scene.fogEnabled) {
    const shared = visionRules.holderSight(state, scene.id, null);
    tiles.push(...partyTiles(state, scene.id, shared.tiles));
    const holders = [...sightHolders(state, scene.id), ...join.flatMap((j) => (j.on ? [j.memberId] : []))];
    for (const memberId of holders) {
      const own = visionRules.holderSight(state, scene.id, memberId);
      // A holder lent only what everyone is lent has nothing of their own to remember.
      if (own === shared) continue;
      const mine: ExploredTiles = [];
      for (const [at, tile] of own.tiles) {
        const [tx, ty] = at.split(",").map(Number) as [number, number];
        const bits = ownExplored(tile, shared.tiles.get(at), state.exploredTiles[tileKey(scene.id, tx, ty)], state.exploredBy[holderTileKey(scene.id, memberId, tx, ty)]);
        if (bits !== null) mine.push({ tx, ty, bits });
      }
      if (mine.length > 0) members.push({ memberId, tiles: mine.sort((a, b) => a.ty - b.ty || a.tx - b.tx) });
    }
  }
  if (tiles.length === 0 && members.length === 0 && join.length === 0) return null;
  return { t: "sys.explore", sceneId: scene.id, tiles, ...(members.length > 0 ? { members } : {}), ...(join.length > 0 ? { join } : {}) };
}

/*
 * Sight reads the derived walls through this world, as shared/ruleHooks.ts
 * gives it to the vision rules, so the source list below is the one the
 * party's sight was computed from.
 */
const WORLD: VisionWorld = { walls: sceneWalls };

/**
 * The players the holder list gains (docs/design-v1-per-player-vision.md
 * 6.1, decision 4): each player with no entry who owns one of the scene's
 * sources now, in the sources' order and then by member id, ticked while
 * fewer than the cap in force are. The actor runs no limit check on this
 * op and the reducer bounds a join only by the design's most, so this is
 * where `LIMITS.sightHoldersPerScene` holds for joins.
 */
function joinsOf(state: RoomState, scene: Scene): { memberId: string; on: boolean }[] {
  const entries = state.holders[scene.id]?.entries ?? [];
  const listed = new Set(entries.map((e) => e.memberId));
  const unlisted = (id: string) => !listed.has(id) && state.members[id]?.kind === "player";
  // The source list costs a pass over the scene's lights and walls, so it is read only when some unlisted player owns a
  // creature there that could be a source. A creature that passes this test and still lends nothing (past the cap, its
  // eye on a wall, under the ground) has the list read every batch. It is not cached: it takes about 0.2 ms on the
  // dark cap scene, and the moves that make most batches replace the tokens a cache would be keyed by (review
  // PV3-OPUS-8).
  if (!Object.values(state.tokens).some((t) => t.sceneId === scene.id && maySee(state, t) && ownersOf(state, t).some(unlisted))) return [];
  let on = entries.filter((e) => e.on && state.members[e.memberId]?.kind === "player").length;
  const join: { memberId: string; on: boolean }[] = [];
  for (const m of visionReport(state, scene.id, WORLD).members) {
    const token = state.tokens[m.tokenId];
    if (!m.lends || !token) continue;
    for (const id of ownersOf(state, token)) {
      if (!unlisted(id)) continue;
      listed.add(id);
      const ticked = on < LIMITS.sightHoldersPerScene;
      if (ticked) on++;
      join.push({ memberId: id, on: ticked });
    }
  }
  return join;
}

/** A token's players and its character's, each once, by id. */
function ownersOf(state: RoomState, token: Token): string[] {
  const character = "ref" in token.actor ? state.characters[token.actor.ref] : undefined;
  return [...new Set([...token.ownerIds, ...(character?.ownerIds ?? [])])].sort();
}

/** Whether a token passes the cheap tests a source must (vision.ts candidatesOf): shown, a creature or a marked object, alive and awake. */
function maySee(state: RoomState, token: Token): boolean {
  if (token.visibility !== "all") return false;
  if (token.kind === "object" && (token.companion !== undefined || token.partyVision !== true)) return false;
  const actor = "inline" in token.actor ? token.actor.inline : state.characters[token.actor.ref]?.actor;
  return actor !== undefined && actor.life === "alive" && !actor.effects.some((e) => e.key === "unconscious");
}

/*
 * The answer for each pair of tile objects, which are replaced and never
 * changed. A move changes a few sight tiles, so after every batch the rest
 * are a lookup here rather than 4,096 sub-cells read again.
 */
const NONE = {};
const answers = new WeakMap<SightTile, WeakMap<object, string | null>>();

/** The explored tile's bits with what the party sees joined in, or null when it already holds all of it. */
function explored(sight: SightTile, held: FogTile | undefined): string | null {
  let byHeld = answers.get(sight);
  if (!byHeld) answers.set(sight, (byHeld = new WeakMap()));
  const heldKey = held ?? NONE;
  const hit = byHeld.get(heldKey);
  if (hit !== undefined) return hit;
  const seen = seenFogBits(sight);
  // An unreadable held tile counts as empty, as the reducer reads it.
  const was = held ? decodeTile(held.bits) : null;
  let adds = false;
  for (let i = 0; i < seen.length; i++) {
    const old = was ? was[i]! : 0;
    if ((seen[i]! & ~old) !== 0) adds = true;
    seen[i] = seen[i]! | old;
  }
  const answer = adds ? encodeTile(seen) : null;
  byHeld.set(heldKey, answer);
  return answer;
}

/* A holder's answers, kept per sequence of the four tile objects they read (NONE where there is none), as above. */
type Chain = WeakMap<object, Chain | string | null>;
const ownAnswers: Chain = new WeakMap();

/**
 * A holder's own tile with what they see joined in, less what the shared
 * sight sees there and the party's layer holds, since the party's layer
 * remembers those for every player. Null when there is nothing new.
 */
function ownExplored(sight: SightTile, shared: SightTile | undefined, party: FogTile | undefined, held: FogTile | undefined): string | null {
  const path: object[] = [sight, shared ?? NONE, party ?? NONE, held ?? NONE];
  let node = ownAnswers;
  for (const part of path.slice(0, -1)) {
    let next = node.get(part) as Chain | undefined;
    if (!next) node.set(part, (next = new WeakMap()));
    node = next;
  }
  const last = path[path.length - 1]!;
  const hit = node.get(last);
  if (hit !== undefined) return hit as string | null;
  const seen = seenFogBits(sight);
  const everyone = shared ? seenFogBits(shared) : null;
  const pooled = party ? decodeTile(party.bits) : null;
  const was = held ? decodeTile(held.bits) : null;
  let adds = false;
  for (let i = 0; i < seen.length; i++) {
    const mine = seen[i]! & ~(everyone ? everyone[i]! : 0) & ~(pooled ? pooled[i]! : 0);
    const old = was ? was[i]! : 0;
    if ((mine & ~old) !== 0) adds = true;
    seen[i] = mine | old;
  }
  const answer = adds ? encodeTile(seen) : null;
  node.set(last, answer);
  return answer;
}
