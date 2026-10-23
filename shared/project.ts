import { chunkKey, compareLogIds, doorChunk, keys, parseKey, readEntity, sightOf, tileKey, writeEntity, type EntityKey, type SightMap } from "./keys.ts";
import {
  FOG_SUBCELLS,
  type Actor,
  type AutoWalls,
  type AreaTemplate,
  type BuildChunk,
  type CastAsk,
  type Character,
  type CustomMonster,
  type Drawing,
  type Effect,
  type Encounter,
  type EncounterSnapshot,
  type FogDraft,
  type FogTile,
  type FreeWall,
  type CompanionBlock,
  type Handout,
  type HandoutDoc,
  type InitEntry,
  type JournalPage,
  type Label,
  type Light,
  type LogEntry,
  type LogEvent,
  type Member,
  type Pin,
  type RollRequest,
  type RollTarget,
  type RoomMeta,
  type RoomState,
  type SavedEncounter,
  type Scene,
  type SightTile,
  type SrdImage,
  type Stamp,
  type Token,
  type TokenPath,
  type Trap,
  type TurnStart,
  type Viewer,
  type WallFeature,
} from "./model.ts";
import { handoutPages } from "./handouts.ts";
import { imageAssetId } from "./imageRef.ts";
import { inLiveLog, liveStart } from "./logRings.ts";
import { revealSeenAnywhere } from "./migrate.ts";
import type { Change } from "./protocol.ts";
import type { Env } from "./reducer/tx.ts";
import { isWritable } from "./writable.ts";
import { autoWallBetween, paintedAt } from "./rules/autoWalls.ts";
import { visionRules, type PartySight } from "./ruleHooks.ts";
import { decodeTile, encodeTile, getBit, isAboveFog, isRangeFullyFogged, labelCells, tilesAcross, TILE_CELLS } from "./rules/fog.ts";
import { footprintRect, occupiedCells, occupiedRange, type CellRange } from "./rules/footprint.ts";
import { hpBar, hpLabel, hpLess, type HpLabel } from "./rules/hp.ts";
import { compareEntries, orderRevealOf, rowCharacter } from "./rules/initiative.ts";
import { pathThisTurn, stopsForNonOwners, stopsForOwners } from "./rules/path.ts";
import { zoneRanges } from "./rules/traps.ts";
import { sightRect } from "./rules/vision.ts";

/**
 * Per-viewer projection (design section 7.3): the security boundary that
 * keeps hidden data from players. Every projection is an allowlist. A field
 * that is not named here does not reach a player, so a field added to the
 * model later stays private until someone allows it on purpose.
 *
 * The projected state keeps the shape of RoomState, so the client runs the
 * shared reducer on it for optimistic updates (section 7.4) and `reads.ts`
 * decides which ops it may replay. Where a player gets less than the full
 * entity, the missing fields are simply absent.
 */

export type ProjectOpts = {
  /** The scene the viewer holds: a DM's choice from `hello`. Players always get the player scene. */
  sceneId: string | null;
};

export type ProjectedActor = Partial<Omit<Actor, "hp" | "life" | "effects">> & {
  life: Actor["life"];
  effects: Effect[];
  /** Only when the viewer may see exact numbers. */
  hp?: Actor["hp"];
  hpLabel?: HpLabel;
  /** `cur / max` rounded to 1/20, only for `bar` visibility. */
  hpBar?: number;
};

const DM_ONLY_TOKEN_FIELDS = ["ownerIds", "fogExempt", "fogExemptAuto", "nameHidden", "publicName", "visibility", "hpVisibility", "altImages"] as const;
type DmOnlyTokenField = (typeof DM_ONLY_TOKEN_FIELDS)[number];

export type ProjectedToken = Omit<Token, "actor" | DmOnlyTokenField> &
  Partial<Pick<Token, DmOnlyTokenField>> & {
    actor: { ref: string } | { inline: ProjectedActor };
    /** Player projections only: drawn above the fog (design 13.3). */
    aboveFog?: boolean;
    /**
     * Player projections only, derived and never stored: a member of kind
     * player owns the token or its character (docs/design-v1-dm-tools.md
     * 3.1), as `playerPlays` reads owners. A table display, whose
     * projection carries no owners, fits the party's tokens by it.
     */
    party?: true;
  };

export type ProjectedCharacter = Omit<Character, "actor" | "ownerIds"> & Partial<Pick<Character, "ownerIds">> & { actor: ProjectedActor };

export type ProjectedTemplate = Omit<AreaTemplate, "casterId"> & { casterId?: string | null };

export type ProjectedEntry = Omit<InitEntry, "groupKey"> & Partial<Pick<InitEntry, "groupKey">>;
export type ProjectedEncounter = Omit<Encounter, "entries"> & { entries: ProjectedEntry[] };

/**
 * A trap as a player gets it (docs/design-v1-traps.md 6.4): its name and
 * zone, and `disarmed` once the DM disarms it, with rev 0. Never whether it
 * is armed or sprung, its rig or its occurrences: the party saw it go off
 * or it did not.
 */
export type ProjectedTrap = Omit<Trap, "state" | "found"> & Partial<Pick<Trap, "state" | "found">> & { disarmed?: true };

export type ProjectedState = Omit<RoomState, "tokens" | "characters" | "templates" | "encounter" | "traps"> & {
  tokens: Record<string, ProjectedToken>;
  traps: Record<string, ProjectedTrap>;
  characters: Record<string, ProjectedCharacter>;
  templates: Record<string, ProjectedTemplate>;
  encounter: ProjectedEncounter | null;
  /**
   * The party's sight on the viewer's scene when its vision is on, keyed
   * `"<sceneId>:<tx>,<ty>"` (docs/design-v1-maps-vision.md 4.3.4). Derived
   * on the server and never stored, so only a projection holds it.
   */
  sight: SightMap;
};

export type HpAccess = "exact" | "bar" | "label" | "none";

/**
 * The scene a viewer's projection covers. Players never choose: the room
 * decides for them. During a blackout a player covers no scene at all, so
 * nothing the DM sets up behind the pause screen is in a player's data,
 * however it is read (design 13.3).
 */
export function viewerSceneId(state: RoomState, viewer: Viewer, opts: ProjectOpts): string | null {
  if (viewer.role === "dm") return opts.sceneId;
  return paused(state, viewer) ? null : state.meta.playerSceneId;
}

/**
 * Whether the viewer is a player behind a blackout. A projected state the
 * client replays on may lack the view settings, which reads as no blackout
 * there: only the server's projection decides what a player receives.
 */
function paused(state: RoomState, viewer: Viewer): boolean {
  return viewer.role === "player" && state.meta.view?.blackout === true;
}

function characterOf(state: RoomState, token: Token): Character | undefined {
  return "ref" in token.actor ? state.characters[token.actor.ref] : undefined;
}

export function ownsToken(state: RoomState, viewer: Viewer, token: Token): boolean {
  if (token.ownerIds.includes(viewer.memberId)) return true;
  const character = characterOf(state, token);
  return character !== undefined && character.ownerIds.includes(viewer.memberId);
}

export function ownsCharacter(viewer: Viewer, character: Character): boolean {
  return character.ownerIds.includes(viewer.memberId);
}

/**
 * Whether any player owns the token, directly or through its character: such
 * tokens are never withheld under fog. The client replays ops on its
 * projection (design 7.4), where a token or character the player does not
 * own has no `ownerIds`, so a missing list counts as empty.
 */
export function playerOwned(state: RoomState, token: Token): boolean {
  if ((token.ownerIds?.length ?? 0) > 0) return true;
  const character = characterOf(state, token);
  return character !== undefined && (character.ownerIds?.length ?? 0) > 0;
}

/**
 * A party member (docs/design-v1-maps-vision.md 4.3.2): a token a player
 * owns, or one the DM marked to lend the party its sight. Membership alone
 * decides "always shown": a member reaches players like a player-owned
 * token, above the fog and whether or not the party sees it, so an allied
 * creature lending sight from the dark stays on their screens. Which
 * members lend sight is shared/rules/vision.ts's.
 */
export function isPartyMember(state: RoomState, token: Token): boolean {
  return token.partyVision === true || playerOwned(state, token);
}

/**
 * What the party sees on a scene: computed on the server, and read from
 * the tiles the server sent where a projected state holds them, so a
 * client never computes sight (section 4.3.4).
 */
export function partySightOf(state: RoomState, sceneId: string): PartySight {
  const tiles = sightOf(state);
  return tiles !== undefined ? visionRules.sightFromTiles(tiles, sceneId) : visionRules.partySight(state, sceneId);
}

/** Whether a scene has party vision on. */
function visionOn(scene: Pick<Scene, "vision"> | undefined): boolean {
  return scene?.vision?.on === true;
}

/**
 * A fog reader with a per-call decode cache, because a projection checks
 * every token on the scene and most of them share a few tiles.
 *
 * It reads the fog players get: the DM's layer and the party's explored
 * layer merged, a sub-cell revealed where either reveals it
 * (docs/design-v1-maps-vision.md 4.3.3), on every scene, one whose vision
 * was turned off since it was explored included.
 */
type FogReader = (sceneId: string, cx: number, cy: number) => boolean;

function fogReader(state: RoomState): FogReader {
  const cache = new Map<string, Uint8Array | null>();
  return (sceneId, cx, cy) => {
    const tx = Math.floor(cx / TILE_CELLS);
    const ty = Math.floor(cy / TILE_CELLS);
    const key = tileKey(sceneId, tx, ty);
    let bits = cache.get(key);
    if (bits === undefined) {
      bits = mergedBits(state, key);
      cache.set(key, bits);
    }
    if (!bits) return true;
    const bx = (cx - tx * TILE_CELLS) * FOG_SUBCELLS;
    const by = (cy - ty * TILE_CELLS) * FOG_SUBCELLS;
    for (let sy = 0; sy < FOG_SUBCELLS; sy++) {
      for (let sx = 0; sx < FOG_SUBCELLS; sx++) if (getBit(bits, bx + sx, by + sy)) return false;
    }
    return true;
  };
}

/**
 * Whether players see any part of a cell's ground on a scene: not fully
 * under the fog they get (docs/design-v1-heights-readout.md 1), the DM's
 * layer and the party's explored one joined. It reads the DM's whole state
 * and a player's copy alike, since that copy holds the joined fog already,
 * so a route searched on either device keeps to the same ground
 * (docs/design-v1-movement.md 5.5).
 */
export function playersSeeGround(state: RoomState, sceneId: string): (x: number, y: number) => boolean {
  const fogged = fogReader(state);
  return (x, y) => !fogged(sceneId, x, y);
}

/** The revealed bits of a fog tile as players get it, the two layers joined, or null where neither holds the tile. */
function mergedBits(state: RoomState, key: string): Uint8Array | null {
  const dm = state.fogTiles[key];
  const explored = state.exploredTiles?.[key];
  if (!dm || !explored) return dm ? bitsOf(dm) : explored ? bitsOf(explored) : null;
  return mergedOf(dm, explored).bits;
}

/*
 * Decoded and merged tiles, kept for the life of the tile objects, which are
 * replaced and never changed. A batch's fan-out projects the same tiles for
 * every player, and a snapshot reads each tile for its fog, its labels and
 * its stamps, so each is decoded once.
 */
const decoded = new WeakMap<FogTile, Uint8Array | null>();
const merged = new WeakMap<FogTile, WeakMap<FogTile, { bits: Uint8Array; text?: string; tile?: FogTile }>>();

function bitsOf(tile: FogTile): Uint8Array | null {
  let bits = decoded.get(tile);
  if (bits === undefined) decoded.set(tile, (bits = decodeTile(tile.bits)));
  return bits;
}

function mergedOf(dm: FogTile, explored: FogTile): { bits: Uint8Array; text?: string; tile?: FogTile } {
  let byDm = merged.get(explored);
  if (!byDm) merged.set(explored, (byDm = new WeakMap()));
  let hit = byDm.get(dm);
  if (!hit) {
    const a = bitsOf(dm);
    const b = bitsOf(explored);
    const bits = new Uint8Array(a ?? b ?? new Uint8Array(0));
    if (a && b) for (let i = 0; i < bits.length; i++) bits[i] = bits[i]! | b[i]!;
    byDm.set(dm, (hit = { bits }));
  }
  return hit;
}

/**
 * Every fog tile key either layer holds, as a map that only says which
 * exist: what `isRangeFullyFogged` looks at before it reads a cell. Kept
 * per pair of layer objects, which are replaced and never changed.
 */
const fogPresence = new WeakMap<object, WeakMap<object, Record<string, FogTile>>>();

function anyFogTiles(state: RoomState): Record<string, FogTile> {
  const explored = state.exploredTiles;
  if (!explored || Object.keys(explored).length === 0) return state.fogTiles;
  // An op still writing into either layer (writable.ts) would change it under the merged map.
  if (isWritable(state.fogTiles) || isWritable(explored)) return { ...explored, ...state.fogTiles };
  let byExplored = fogPresence.get(state.fogTiles);
  if (!byExplored) fogPresence.set(state.fogTiles, (byExplored = new WeakMap()));
  let merged = byExplored.get(explored);
  if (!merged) byExplored.set(explored, (merged = { ...explored, ...state.fogTiles }));
  return merged;
}

/**
 * One projection's inputs. `paused` is a player behind a blackout, whose
 * `sceneId` is null as well (viewerSceneId), so every scene's contents
 * project to nothing. The room-level parts of the table go with them: the
 * initiative tracker, which can name what is coming in a row of its own,
 * and handouts. `sight` is the party's sight of a vision scene, worked out
 * once per projection.
 */
type Ctx = { state: RoomState; viewer: Viewer; sceneId: string | null; paused: boolean; fogged: FogReader; sight: (sceneId: string) => PartySight };

function ctxOf(state: RoomState, viewer: Viewer, opts: ProjectOpts): Ctx {
  return { state, viewer, sceneId: viewerSceneId(state, viewer, opts), paused: paused(state, viewer), fogged: fogReader(state), sight: sightReader(state) };
}

function sightReader(state: RoomState): (sceneId: string) => PartySight {
  const cache = new Map<string, PartySight>();
  return (sceneId) => {
    let sight = cache.get(sceneId);
    if (!sight) cache.set(sceneId, (sight = partySightOf(state, sceneId)));
    return sight;
  };
}

/**
 * The one rule for tokens a player may know about (design 7.3 and 13.4): on
 * the viewer's scene, not hidden unless owned, and not withheld where it
 * stands (withheldFromPlayers, which says what `revealedSeen` is for).
 */
function tokenVisibleTo(ctx: Ctx, token: Token, revealedSeen = false): boolean {
  if (ctx.viewer.role === "dm") return token.sceneId === ctx.sceneId;
  if (token.sceneId !== ctx.sceneId) return false;
  if (token.visibility === "dm" && !ownsToken(ctx.state, ctx.viewer, token)) return false;
  return !withheldFromPlayers(ctx.state, ctx.fogged, ctx.sight, token, revealedSeen);
}

/**
 * Whether where a token stands keeps it from players who do not own it. A
 * party member or a token the DM exempted never is (design 13.4). On a
 * scene with party vision, any other creature reaches players only while it
 * is in the party's sight (docs/design-v1-maps-vision.md 4.3.3): with fog
 * on, sight is always inside the revealed ground, since explore runs in the
 * same batch, so the fog rule is implied. Elsewhere it is withheld only when
 * every cell it stands on is fully fogged, the two fog layers merged.
 *
 * A creature revealed on its turn follows that rule too (rules/fog.ts
 * isAboveFog). `revealedSeen` brings back the rule that ops stored before
 * op version 4 marked by, where the automatic exemption counted as seen
 * anywhere. Only the seen marks of such an op, and the reducer's check of
 * a player's guarded Next or Previous (activeRowShownTo), pass it on replay.
 *
 * The checks run cheapest first, so sight is asked only about the DM's
 * other creatures.
 */
function withheldFromPlayers(state: RoomState, fogged: FogReader, sight: (sceneId: string) => PartySight, token: Token, revealedSeen = false): boolean {
  const scene = state.scenes[token.sceneId];
  if (!scene) return false;
  if (!visionOn(scene) && !scene.fogEnabled) return false;
  if (isAboveFog(token, isPartyMember(state, token)) || (revealedSeen && token.fogExemptAuto)) return false;
  if (visionOn(scene)) return !sight(scene.id).seesToken(token);
  return occupiedCells(token).every((cell) => fogged(token.sceneId, cell.x, cell.y));
}

/**
 * Whether where a token stands keeps it from players who do not own it, by
 * the rule projections use: out of the party's sight on a vision scene,
 * fully under the merged fog elsewhere, unless it is a party member or
 * exempt. Its visibility and a blackout are the caller's to check. The
 * ephemeral channel asks it of a drag preview's spot, with the footprint its
 * own preview rule decides (docs/design-v1-maps-vision.md 4.1 and 4.3.5).
 */
export function withheldWhereItStands(state: RoomState, token: Token): boolean {
  return withheldFromPlayers(state, fogReader(state), sightReader(state), token);
}

/*
 * Behind a blackout players see none of the table (design 7.3), so nothing
 * that happens meanwhile is marked as seen by them. The marks outlive the
 * blackout: a stop, a turn's start or a log line marked seen behind it would
 * reach players once it lifts, though they never saw it.
 */
function behindBlackout(state: RoomState): boolean {
  return state.meta.view?.blackout === true;
}

/**
 * Whether a player who does not own the token can see it now: the same rule
 * for every non-owner, so one answer covers them all. The reducer records it
 * on log events about the token (`seen` in the model).
 *
 * The marks are stored, so each of these questions takes the op's envelope:
 * an op stored before op version 4 marks by the rule it was applied under
 * (shared/migrate.ts revealSeenAnywhere), and replays to the same state.
 */
export function seenByNonOwners(state: RoomState, token: Token, env: Pick<Env, "opVersion">): boolean {
  if (behindBlackout(state) || token.sceneId !== state.meta.playerSceneId || token.visibility === "dm") return false;
  return !withheldFromPlayers(state, fogReader(state), sightReader(state), token, revealSeenAnywhere(env.opVersion));
}

/**
 * Whether players who do not own the token could see it where it stands,
 * whichever scene they are on. The reducer records it on a turn's starting
 * spot (`TurnStart.seen`) and on the stops of a path, which players get
 * only while they see the token on their own scene anyway.
 */
export function inSightOfNonOwners(state: RoomState, token: Token, env: Pick<Env, "opVersion">): boolean {
  if (behindBlackout(state) || token.visibility === "dm") return false;
  return !withheldFromPlayers(state, fogReader(state), sightReader(state), token, revealSeenAnywhere(env.opVersion));
}

/**
 * Whether players who do not own the token would see it at every one of
 * these spots, each asked of the token placed there against the state as it
 * is (docs/design-v1-movement.md 7.2): the stops' rule, `inSightOfNonOwners`,
 * with the fog and sight read once for the whole walk.
 */
export function seenAtEvery(state: RoomState, token: Token, spots: readonly { x: number; y: number; elevation: number; squeezed?: boolean }[], env: Pick<Env, "opVersion">): boolean {
  if (behindBlackout(state) || token.visibility === "dm") return false;
  const fogged = fogReader(state);
  const sight = sightReader(state);
  const revealed = revealSeenAnywhere(env.opVersion);
  const { squeeze: _squeeze, ...rest } = token;
  return spots.every((p) => !withheldFromPlayers(state, fogged, sight, { ...rest, x: p.x, y: p.y, elevation: p.elevation, ...(p.squeezed ? { squeeze: true as const } : {}) }, revealed));
}

/** The same question for an initiative row, by the encounter projection's rule: not hidden, in the order players see, and its creature in sight. */
export function rowSeenByNonOwners(state: RoomState, entry: InitEntry, env: Pick<Env, "opVersion">): boolean {
  if (entry.hidden || behindBlackout(state) || !orderShown(state, entry)) return false;
  if (entry.tokenId !== undefined) {
    const token = state.tokens[entry.tokenId];
    if (!token || !seenByNonOwners(state, token, env)) return false;
  }
  return entry.characterId === undefined || state.characters[entry.characterId] !== undefined;
}

function tokenVisibleById(ctx: Ctx, tokenId: string, revealedSeen = false): boolean {
  const token = ctx.state.tokens[tokenId];
  return token !== undefined && tokenVisibleTo(ctx, token, revealedSeen);
}

/**
 * How much of a creature's HP the viewer may see. A creature with no HP to
 * show (hpLess: an effect companion, or a maximum of 0) shows other players
 * none, so 0 of 0 never reaches them as Bloodied. A creature companion a
 * player plays is the party's, so its HP follows the party's rule rather
 * than its own `hpVisibility` (docs/design-v1-combat-flow.md 3.6.5).
 */
export function hpAccess(state: RoomState, viewer: Viewer, holder: { token?: Token; character?: Character }): HpAccess {
  if (viewer.role === "dm") return "exact";
  if (holder.character) {
    if (ownsCharacter(viewer, holder.character)) return "exact";
    if (holder.token && ownsToken(state, viewer, holder.token)) return "exact";
    if (hpLess(holder.character.actor, holder.token)) return "none";
    return state.meta.settings.pcHpVisibleToParty ? "exact" : "label";
  }
  const token = holder.token;
  if (!token) return "none";
  if (ownsToken(state, viewer, token)) return "exact";
  if ("inline" in token.actor && hpLess(token.actor.inline, token)) return "none";
  if (token.companion && playersToken(state, token)) return state.meta.settings.pcHpVisibleToParty ? "exact" : "label";
  return token.hpVisibility === "hidden" ? "none" : token.hpVisibility;
}

/**
 * An effect companion (docs/design-v1-combat-flow.md 3.6.6), which reaches
 * every viewer who does not own it alive, whatever its stored life: a
 * creature made an effect keeps its life underneath, and no device without
 * its `companion` field may be told it is dead.
 */
function effectCompanion(token: Pick<Token, "kind" | "companion">): boolean {
  return token.companion !== undefined && token.kind === "object";
}

/**
 * Effects as players get them: none the DM hid. And for players who do not
 * own the creature, a Ready action's trigger only when a player plays it
 * (playerPlays) or the DM shows it (`triggerShown`): by design, players
 * learn that a monster readied, not what it waits for. A party member's
 * trigger was typed by its player and is the table's. `triggers` is asked
 * only of an actor that holds such a trigger, since it can scan the tokens.
 */
function publicEffects(effects: Effect[], triggers: () => boolean): Effect[] {
  let shown: boolean | undefined;
  return effects.flatMap((e) => {
    if (e.hiddenFromPlayers) return [];
    const seen = playerSave(e);
    if (seen.key !== "readied" || seen.label === undefined || seen.triggerShown === true || (shown ??= triggers())) return [seen];
    const { label: _trigger, ...rest } = seen;
    return [rest];
  });
}

/**
 * A "save ends" effect as every player gets it, its owners included
 * (docs/design-v1-roll-options.md 6.1): which save ends it and whether it is
 * against a spell, never its DC, which stays the DM's to show on a request,
 * and never its occurrence, which is the DM's in every projection.
 */
function playerSave(e: Effect): Effect {
  if (e.save === undefined && e.due === undefined) return e;
  const { save, due: _due, ...rest } = e;
  if (!save) return rest;
  // The model's `dc` is the stored one, which a player's view never has.
  const seen = { ability: save.ability, ...(save.spell ? { spell: true as const } : {}) };
  return { ...rest, save: seen as Effect["save"] };
}

/**
 * Whether a player, not a DM, is among these owners. A DM may own a
 * creature, and a player made DM keeps the ids of what they owned, so an
 * owner id alone does not make a creature a player's.
 */
export function anyPlayer(state: Pick<RoomState, "members">, ids: readonly string[] | undefined): boolean {
  return ids?.some((id) => state.members[id]?.kind === "player") ?? false;
}

/**
 * Whether a player plays the creature whose actor this token or character
 * holds, so its Ready action's trigger is the table's (publicEffects). A
 * player who owns any token of a character may change its effects
 * (permissions.ts), so owning one counts as playing it, as owning the
 * character does. An inline token's actor is its own, so only its owners
 * count.
 */
export function playerPlays(state: Pick<RoomState, "members" | "tokens">, holder: { token: Pick<Token, "ownerIds"> } | { character: Pick<Character, "id" | "ownerIds"> }): boolean {
  if ("token" in holder) return anyPlayer(state, holder.token.ownerIds);
  const id = holder.character.id;
  return anyPlayer(state, holder.character.ownerIds) || Object.values(state.tokens).some((t) => "ref" in t.actor && t.actor.ref === id && anyPlayer(state, t.ownerIds));
}

/**
 * The derived `party` flag (docs/design-v1-dm-tools.md 3.1): a member of
 * kind player owns the token or its character. Not `playerOwned`, which
 * counts a DM owner too, and not `partyVision`, which lends sight without a
 * player. Who plays which character is no secret at the table.
 */
export function playersToken(state: Pick<RoomState, "members" | "characters">, token: Pick<Token, "ownerIds" | "actor">): boolean {
  if (anyPlayer(state, token.ownerIds)) return true;
  const character = "ref" in token.actor ? state.characters[token.actor.ref] : undefined;
  return character !== undefined && anyPlayer(state, character.ownerIds);
}

function projectActorPublic(actor: Actor, access: HpAccess, triggers: () => boolean, shownAlive = false): ProjectedActor {
  const out: ProjectedActor = { life: shownAlive ? "alive" : actor.life, effects: publicEffects(actor.effects, triggers) };
  if (access === "exact") out.hp = actor.hp;
  else if (access === "label") out.hpLabel = hpLabel(actor);
  else if (access === "bar") out.hpBar = hpBar(actor);
  return out;
}

/**
 * Owners get the whole actor except the DM's notes and the room monster it
 * was placed from, whose block may be text from a book the group owns
 * (docs/design-v1-dm-tools.md 3.6). A condition hidden from players stays
 * hidden from its owner too.
 */
function projectActorOwner(actor: Actor): ProjectedActor {
  const { dmNotes: _dmNotes, monsterId: _monsterId, ...rest } = actor;
  return { ...rest, effects: publicEffects(actor.effects, () => true) };
}

export function projectToken(state: RoomState, viewer: Viewer, token: Token, opts: ProjectOpts): ProjectedToken | null {
  return projectTokenCtx(ctxOf(state, viewer, opts), token);
}

/*
 * A player's token, character and encounter carry rev 0, as a player's scene
 * and build chunks do. The rev counts every write, so a hidden condition, a
 * DM note, a hidden name's real one or a hidden initiative row would each
 * send players an `ev` that differs only in its rev, telling them the DM
 * did something secret to that creature or fight (design 7.3: a change that
 * projects to the same value sends that viewer nothing).
 */
function projectTokenCtx(ctx: Ctx, token: Token): ProjectedToken | null {
  if (!tokenVisibleTo(ctx, token)) return null;
  if (ctx.viewer.role === "dm") return token;
  const aboveFog = isAboveFog(token, isPartyMember(ctx.state, token));
  if (ownsToken(ctx.state, ctx.viewer, token)) {
    const actor = "inline" in token.actor ? { inline: projectActorOwner(token.actor.inline) } : token.actor;
    // Owners get their token's light to change it. Party membership is the DM's mark (docs/design-v1-maps-vision.md 4.3.5).
    const { partyVision: _partyVision, attached: _attached, ...own } = token;
    const out: ProjectedToken = { ...own, rev: 0, actor, aboveFog };
    const link = linkShown(ctx, token);
    if (link) out.attached = link;
    if (playersToken(ctx.state, token)) out.party = true;
    const path = projectPathCtx(ctx, token, true);
    if (path) out.path = path;
    else delete out.path;
    return out;
  }
  const out: ProjectedToken = {
    id: token.id,
    rev: 0,
    sceneId: token.sceneId,
    kind: token.kind,
    name: token.nameHidden ? (token.publicName ?? "Unknown creature") : token.name,
    size: token.size,
    x: token.x,
    y: token.y,
    elevation: token.elevation,
    rotation: token.rotation,
    disposition: token.disposition,
    locked: token.locked,
    layer: token.layer,
    actor:
      "ref" in token.actor
        ? token.actor
        : { inline: projectActorPublic(token.actor.inline, hpAccess(ctx.state, ctx.viewer, { token }), () => playerPlays(ctx.state, { token }), effectCompanion(token)) },
    aboveFog,
  };
  if (token.image !== undefined) out.image = token.image;
  if (token.w !== undefined) out.w = token.w;
  if (token.h !== undefined) out.h = token.h;
  if (token.height !== undefined) out.height = token.height;
  // The note for everyone. The DM's own note is the actor's dmNotes, which no player projection carries.
  if (token.notes !== undefined) out.notes = token.notes;
  // A hidden name's number would tell players it is one of a numbered group, and which one.
  if (token.number !== undefined && !token.nameHidden) out.number = token.number;
  // Rings around a creature in sight say no more than the creature itself (features section 4).
  if (token.rangeRings !== undefined) out.rangeRings = token.rangeRings;
  // A squeeze changes the footprint every rule reads, so everyone who sees the creature gets it. Its light does not
  // reach them: they see only its effect (docs/design-v1-maps-vision.md 4.3.5).
  if (token.squeeze) out.squeeze = true;
  if (playersToken(ctx.state, token)) {
    out.party = true;
    // A party member's companion is no secret at the table. One of a character no player plays reaches players as a
    // plain token, so no link between a DM creature and a character leaks (docs/design-v1-combat-flow.md 3.6.5).
    if (token.companion) out.companion = token.companion;
  }
  const link = linkShown(ctx, token);
  if (link) out.attached = link;
  const path = projectPathCtx(ctx, token, false);
  if (path) out.path = path;
  return out;
}

/**
 * A token's link as a player gets it (docs/design-v1-attach.md 8.5): only
 * while its holder is in their projection, with its kind and `steer`, as an
 * area attached to a token they cannot see is withheld whole. So a torch a
 * hidden creature holds reaches them as a loose torch, which follows its
 * holder all the same.
 */
function linkShown(ctx: Ctx, token: Token): Token["attached"] | null {
  const link = token.attached;
  if (!link || !tokenVisibleById(ctx, link.to)) return null;
  return { to: link.to, kind: link.kind, ...(link.steer ? { steer: true as const } : {}) };
}

/**
 * The creature's path this turn, for a player who sees the creature and
 * its initiative row now (design 7.3). A path from an earlier turn, or one
 * of a row the player cannot see, would say whose turn it is or was, so it
 * is not sent at all. The one exception is the creature's own turn for its
 * owners, on a row the DM hid from them: they walk it, and its drag's label
 * reads the turn's earlier legs as the move stores them (review
 * AT-HIDDENPATH). Owners get every stop, and other players only those they
 * could see (rules/path.ts). Neither gets the marks of who could see.
 */
function projectPathCtx(ctx: Ctx, token: Token, owner: boolean): TokenPath | null {
  const encounter = ctx.state.encounter;
  const path = pathThisTurn(encounter, token);
  if (!encounter || !path) return null;
  const entry = encounter.entries.find((e) => e.id === encounter.activeEntryId);
  const ownTurn = owner && encounter.turnStart?.tokenId === token.id;
  if (!ownTurn && (!entry || !entryShown(ctx, entry))) return null;
  const stops = owner ? stopsForOwners(path.stops) : stopsForNonOwners(path.stops);
  return stops.length > 0 ? { turn: path.turn, stops } : null;
}

export function projectCharacter(state: RoomState, viewer: Viewer, character: Character): ProjectedCharacter {
  if (viewer.role === "dm") return character;
  // Rev 0 for players, as on their tokens (projectTokenCtx).
  if (ownsCharacter(viewer, character)) return { ...character, rev: 0, actor: projectActorOwner(character.actor) };
  const out: ProjectedCharacter = {
    id: character.id,
    rev: 0,
    name: character.name,
    size: character.size,
    actor: projectActorPublic(character.actor, hpAccess(state, viewer, { character }), () => playerPlays(state, { character })),
  };
  if (character.defaultImage !== undefined) out.defaultImage = character.defaultImage;
  return out;
}

function projectTemplateCtx(ctx: Ctx, template: AreaTemplate): ProjectedTemplate | null {
  if (template.sceneId !== ctx.sceneId) return null;
  if (ctx.viewer.role === "dm") return template;
  if (template.visibility === "dm") return null;
  if (template.attachedTo !== undefined && !tokenVisibleById(ctx, template.attachedTo)) return null;
  if (template.ownerId !== ctx.viewer.memberId && !ctx.state.meta.settings.playersSeeAoeOfOthers) {
    const owner = ctx.state.members[template.ownerId];
    if (owner === undefined || owner.kind !== "dm") return null;
  }
  if (template.casterId !== undefined && !tokenVisibleById(ctx, template.casterId)) {
    return { ...template, casterId: null };
  }
  return template;
}

/**
 * A kept ruler on a token measures from where that token stands now, so a
 * player gets it only while they can see every token it is on, as with a
 * live shared ruler (design 7.6). A token that is gone counts as unseen.
 *
 * A stop's stored point is where its token stood when the ruler was kept,
 * perhaps under fog or while hidden, so a player gets the middle of the
 * token where they see it now in its place (the ruler tool's tokenStop).
 */
function projectDrawingCtx(ctx: Ctx, drawing: Drawing): Drawing | null {
  if (drawing.sceneId !== ctx.sceneId) return null;
  if (ctx.viewer.role === "dm") return drawing;
  if (drawing.visibility === "dm") return null;
  if (!drawing.anchors?.some((id) => id !== null)) return drawing;
  const points = [...drawing.points];
  for (const [i, id] of drawing.anchors.entries()) {
    if (id === null) continue;
    const token = ctx.state.tokens[id];
    if (!token || !tokenVisibleTo(ctx, token)) return null;
    const r = footprintRect(token);
    points[2 * i] = r.x + r.w / 2;
    points[2 * i + 1] = r.y + r.h / 2;
  }
  return { ...drawing, points };
}

function projectChunkCtx(ctx: Ctx, chunk: BuildChunk): BuildChunk | null {
  if (chunk.sceneId !== ctx.sceneId) return null;
  if (ctx.viewer.role === "dm") return chunk;
  return projectChunkForPlayer(ctx.state.buildChunks, chunk, ctx.state.scenes[chunk.sceneId]?.autoWalls);
}

/** A door as players see it, when it is not a hidden secret one: a locked door arrives closed. */
function unlocked(door: Extract<WallFeature, { kind: "door" }>): WallFeature {
  return door.state === "locked" ? { ...door, state: "closed" } : door;
}

function hiddenDoor(feature: WallFeature): boolean {
  return feature.kind === "door" && feature.secret && !feature.discovered;
}

/** Free walls in the order of their ends' coordinates, so the order never shows which one was imported as a door. */
function byCoordinates(a: FreeWall, b: FreeWall): number {
  return a.a[0] - b.a[0] || a.a[1] - b.a[1] || a.b[0] - b.b[0] || a.b[1] - b.b[1] || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

/**
 * A build chunk as a player may see it (design 12): the build exactly as it
 * would be if every hidden secret door were the wall players think it is.
 *
 * - A hidden secret door on an edge where the scene's automatic walls rule
 *   puts a wall goes away, since automatic walls are never sent. Anywhere
 *   else it becomes a plain wall, the same as one the DM drew, so players
 *   never see a gap where a hidden door is (docs/design-v1-maps-vision.md
 *   2.1). `autoWalls` is the scene's rule, absent read as "all".
 * - A free wall is never automatic, so a hidden secret free door always
 *   arrives as a plain wall. Free walls arrive sorted by their coordinates.
 * - A locked door arrives closed. The lock is the DM's note, players learn
 *   it by trying the door.
 * - The rev is always 0, so an edit players cannot see changes nothing they
 *   receive, and a chunk with nothing left to show is withheld.
 *
 * Whether an edge has an automatic wall can depend on a neighbor chunk's
 * cells (an edge on a chunk's north or west border), so `dependents`
 * re-projects the chunks below and to the right of a touched one, and a
 * change of the scene's rule re-projects everything. The map export's
 * player view calls this too.
 */
export function projectChunkForPlayer(all: Readonly<Record<string, BuildChunk>>, chunk: BuildChunk, autoWalls: AutoWalls | undefined): BuildChunk | null {
  const hit = playerChunks.get(chunk);
  if (hit && hit.all === all && hit.autoWalls === autoWalls) return hit.out;
  const out = playerChunkOf(all, chunk, autoWalls);
  playerChunks.set(chunk, { all, autoWalls, out });
  return out;
}

/*
 * A player's chunk, kept per chunk object for as long as the scene's chunks
 * (the neighbors it reads) and its automatic walls rule stay the same
 * objects, which are replaced and never changed. Every snapshot and every
 * batch that re-projects the map then hands players the same object, which
 * the server's fan-out need not hash again (design 7.3).
 */
const playerChunks = new WeakMap<BuildChunk, { all: object; autoWalls: AutoWalls | undefined; out: BuildChunk | null }>();

function playerChunkOf(all: Readonly<Record<string, BuildChunk>>, chunk: BuildChunk, autoWalls: AutoWalls | undefined): BuildChunk | null {
  const rule = autoWalls ?? "all";
  // The one painted predicate, stair marks included, across chunk borders: the walls ask the same (section 2.1).
  const painted = (x: number, y: number) => paintedAt(all, chunk.sceneId, x, y);
  const edges: BuildChunk["edges"] = {};
  for (const [key, edge] of Object.entries(chunk.edges)) {
    if (edge.kind !== "door") {
      edges[key] = edge;
    } else if (!hiddenDoor(edge)) {
      edges[key] = unlocked(edge);
    } else {
      const [xs, ys, side] = key.split(",");
      const x = Number(xs);
      const y = Number(ys);
      const automatic = autoWallBetween(rule, painted(x, y), side === "n" ? painted(x, y - 1) : painted(x - 1, y));
      if (!automatic) edges[key] = { kind: "wall" };
    }
  }
  const walls = (chunk.walls ?? [])
    .map((w): FreeWall => (w.f.kind !== "door" ? w : { ...w, f: hiddenDoor(w.f) ? { kind: "wall" } : unlocked(w.f) }))
    .sort(byCoordinates);
  const empty = Object.keys(chunk.cells).length === 0 && Object.keys(edges).length === 0 && walls.length === 0;
  if (empty && chunk.heights === undefined && chunk.up === undefined && chunk.rough === undefined) return null;
  const out: BuildChunk = { sceneId: chunk.sceneId, cx: chunk.cx, cy: chunk.cy, rev: 0, cells: chunk.cells, edges };
  if (walls.length > 0) out.walls = walls;
  // Heights and stair marks are map data, like the floor, and not secret (docs/design-v1-maps-vision.md 4.2).
  if (chunk.heights !== undefined) out.heights = chunk.heights;
  if (chunk.up !== undefined) out.up = chunk.up;
  // Difficult ground marks are map data too: players see them where they see the map (docs/design-v1-movement.md 3.4).
  if (chunk.rough !== undefined) out.rough = chunk.rough;
  return out;
}

/**
 * One fog tile of the viewer's scene. The DM gets the DM's own layer, and
 * the explored layer beside it (projectExploredCtx). A player gets one fog,
 * each tile the two layers merged (docs/design-v1-maps-vision.md 4.3.3), so
 * every rule players' devices apply to fog works on it unchanged. A
 * player's tile has rev 0, as a player's chunk does: neither layer's count
 * of edits reaches players, so a DM reveal of ground the party already
 * explored, or an explore of ground the DM revealed, sends them nothing.
 */
function projectFogCtx(ctx: Ctx, sceneId: string, tx: number, ty: number): FogTile | null {
  if (sceneId !== ctx.sceneId) return null;
  const key = tileKey(sceneId, tx, ty);
  const dm = ctx.state.fogTiles[key] ?? null;
  if (ctx.viewer.role === "dm") return dm;
  const explored = ctx.state.exploredTiles?.[key];
  if (!explored) return dm && playerTile(dm, () => ({ ...dm, rev: 0 }));
  if (!dm) return playerTile(explored, () => ({ sceneId, tx, ty, rev: 0, bits: explored.bits }));
  const both = mergedOf(dm, explored);
  return (both.tile ??= { sceneId, tx, ty, rev: 0, bits: (both.text ??= encodeTile(both.bits)) });
}

/*
 * A player's fog tile from one layer alone, kept per tile object like the
 * merged ones (mergedOf), so every projection of an unchanged tile is the
 * same object, which the server's fan-out need not hash again.
 */
const playerTiles = new WeakMap<FogTile, FogTile>();

function playerTile(tile: FogTile, make: () => FogTile): FogTile {
  let out = playerTiles.get(tile);
  if (!out) playerTiles.set(tile, (out = make()));
  return out;
}

/** The party's explored layer is the DM's to see beside the fog. Players get it only merged into theirs. */
function projectExploredCtx(ctx: Ctx, tile: FogTile): FogTile | null {
  return ctx.viewer.role === "dm" && tile.sceneId === ctx.sceneId ? tile : null;
}

/**
 * One tile of the party's sight on the viewer's scene, while its vision is
 * on (docs/design-v1-maps-vision.md 4.3.4). Players and the DM alike get it.
 * Sight is derived, never stored, and the same for every player.
 */
function projectSightCtx(ctx: Ctx, sceneId: string, tx: number, ty: number): unknown {
  if (sceneId !== ctx.sceneId || !visionOn(ctx.state.scenes[sceneId])) return null;
  return ctx.sight(sceneId).tiles.get(`${tx},${ty}`) ?? null;
}

/** Every sight tile of the viewer's scene, keyed as a projected state holds them. */
function sightTilesCtx(ctx: Ctx): SightMap {
  const out: SightMap = {};
  const sceneId = ctx.sceneId;
  if (sceneId === null || !visionOn(ctx.state.scenes[sceneId])) return out;
  for (const [at, tile] of ctx.sight(sceneId).tiles) out[`${sceneId}:${at}`] = tile;
  return out;
}

function projectFogDraftCtx(ctx: Ctx, draft: FogDraft): FogDraft | null {
  if (ctx.viewer.role !== "dm") return null;
  return draft.sceneId === ctx.sceneId ? draft : null;
}

/** A label fully under enabled fog is withheld from players like a token, so a "Trap" in the dark is not in the data at all. */
function projectLabelCtx(ctx: Ctx, label: Label): Label | null {
  if (label.sceneId !== ctx.sceneId) return null;
  if (ctx.viewer.role === "dm") return label;
  const scene = ctx.state.scenes[label.sceneId];
  if (!scene || !scene.fogEnabled) return label;
  const fogged = isRangeFullyFogged(anyFogTiles(ctx.state), label.sceneId, labelCells(label), (x, y) => ctx.fogged(label.sceneId, x, y));
  return fogged ? null : label;
}

/**
 * The cells under a stamp's rotated bounding box, which the fog rule tests
 * as it tests a label's (design 13.4). A sine or cosine within rounding of
 * zero counts as zero, so a stamp turned a quarter turn with its edges on
 * grid lines covers exactly its cells rather than one more row.
 */
export function stampCells(stamp: Pick<Stamp, "x" | "y" | "w" | "h" | "rotation">): CellRange {
  const rad = (stamp.rotation * Math.PI) / 180;
  const exact = (v: number) => (Math.abs(v) < 1e-12 ? 0 : Math.abs(v));
  const c = exact(Math.cos(rad));
  const s = exact(Math.sin(rad));
  const hx = (stamp.w * c + stamp.h * s) / 2;
  const hy = (stamp.w * s + stamp.h * c) / 2;
  return { x0: Math.floor(stamp.x - hx), y0: Math.floor(stamp.y - hy), x1: Math.ceil(stamp.x + hx), y1: Math.ceil(stamp.y + hy) };
}

/**
 * Stamps on the viewer's scene (docs/design-v1-maps-vision.md 3.5). A
 * player gets none the DM hid, and none whose box is fully under enabled
 * fog, as labels go, so a chest in an unexplored room is not in their data.
 */
function projectStampCtx(ctx: Ctx, stamp: Stamp): Stamp | null {
  if (stamp.sceneId !== ctx.sceneId) return null;
  if (ctx.viewer.role === "dm") return stamp;
  if (stamp.visibility === "dm") return null;
  const scene = ctx.state.scenes[stamp.sceneId];
  if (!scene || !scene.fogEnabled) return stamp;
  const fogged = isRangeFullyFogged(anyFogTiles(ctx.state), stamp.sceneId, stampCells(stamp), (x, y) => ctx.fogged(stamp.sceneId, x, y));
  return fogged ? null : stamp;
}

/**
 * Traps (docs/design-v1-traps.md 6.4). The DM gets every trap on its scene.
 * A player gets one only once it is found, on the player scene outside a
 * blackout, not under full fog over its cells by the labels' rule (a wire's
 * cells, a door's two cells), and for a door zone only while its door is
 * not a secret one still hidden: its name, its zone, and whether the DM
 * disarmed it. So a springing, re-arming, uses and rig edits send players
 * nothing, and a trap nobody found is in no player's data at all.
 */
function projectTrapCtx(ctx: Ctx, trap: Trap): ProjectedTrap | null {
  if (trap.sceneId !== ctx.sceneId) return null;
  if (ctx.viewer.role === "dm") return trap;
  if (!trap.found) return null;
  const zone = trap.zone;
  if ("door" in zone) {
    const { cx, cy } = doorChunk(zone.door);
    const chunk = ctx.state.buildChunks[chunkKey(trap.sceneId, cx, cy)];
    const feature = "edge" in zone.door ? chunk?.edges[zone.door.edge] : chunk?.walls?.find((w) => w.id === (zone.door as { id: string }).id)?.f;
    if (feature?.kind === "door" && feature.secret && !feature.discovered) return null;
  }
  const scene = ctx.state.scenes[trap.sceneId];
  if (scene?.fogEnabled) {
    const fogs = anyFogTiles(ctx.state);
    const fogged = (r: CellRange) => isRangeFullyFogged(fogs, trap.sceneId, r, (x, y) => ctx.fogged(trap.sceneId, x, y));
    if (zoneRanges(ctx.state, trap.sceneId, zone).every(fogged)) return null;
  }
  let out = playerTraps.get(trap);
  if (!out) playerTraps.set(trap, (out = { id: trap.id, rev: 0, sceneId: trap.sceneId, name: trap.name, zone, ...(trap.state === "disarmed" ? { disarmed: true as const } : {}) }));
  return out;
}

/* A player's trap, kept per trap object, which is replaced and never changed, so a re-projection that changes nothing sends nothing. */
const playerTraps = new WeakMap<Trap, ProjectedTrap>();

/**
 * A players' trap line (docs/design-v1-traps.md 6.3): every player and
 * table display gets it, with `by` cut to the creatures this viewer sees
 * now, and none behind a pause, as roll and turn lines. The DM's trap log
 * is the DM's alone.
 */
function projectTrapSeenCtx(ctx: Ctx, entry: LogEntry): LogEntry | null {
  if (ctx.viewer.role === "dm") return entry;
  const data = entry.data;
  if (ctx.paused || data?.type !== "trapSeen") return null;
  const by = data.by.filter((id) => tokenVisibleById(ctx, id));
  return by.length === data.by.length ? entry : { ...entry, data: { ...data, by } };
}

/** Lights are the DM's in every wave. Players will only ever see their effect (section 3.6). */
function projectLightCtx(ctx: Ctx, light: Light): Light | null {
  if (ctx.viewer.role !== "dm") return null;
  return light.sceneId === ctx.sceneId ? light : null;
}

/**
 * A scene as a player gets it: an allowlist (docs/design-v1-maps-vision.md
 * 3.3). Its folder, thumbnail and phases are the DM's, so neither the other
 * images of the map nor their names ("On fire") reach a player. Its rev,
 * order and walls version are 0, as a chunk's rev is, so a DM's edit of
 * those fields, a thumbnail landing in the background included, changes
 * nothing players receive. The walls version moves with every build op,
 * a hidden secret door's or a lock's edit too, which players cannot see.
 * No client reads it: the rules caches follow the derived wall set.
 */
function projectSceneCtx(ctx: Ctx, scene: Scene): Scene | null {
  if (ctx.viewer.role === "dm") return scene;
  if (scene.id !== ctx.sceneId) return null;
  const out: Scene = {
    id: scene.id,
    rev: 0,
    name: scene.name,
    order: 0,
    bounds: scene.bounds,
    grid: scene.grid,
    background: scene.background,
    fogEnabled: scene.fogEnabled,
    wallsVersion: 0,
  };
  if (scene.map !== undefined) out.map = scene.map;
  if (scene.defaultView !== undefined) out.defaultView = scene.defaultView;
  if (scene.autoWalls !== undefined) out.autoWalls = scene.autoWalls;
  // Players' devices draw sight and stop drags at walls by these (docs/design-v1-maps-vision.md 4.3.5).
  if (scene.blockMovement !== undefined) out.blockMovement = scene.blockMovement;
  if (scene.vision !== undefined) out.vision = scene.vision;
  return out;
}

function projectHandoutCtx(ctx: Ctx, handout: Handout): Handout | null {
  if (ctx.viewer.role === "dm") return handout;
  if (ctx.paused) return null;
  if (handout.to === "all" || handout.to.includes(ctx.viewer.memberId)) return handout;
  return null;
}

/** The room's own stat blocks are the DM's notes on a book: players get only the tokens made from them. */
function projectMonsterCtx(ctx: Ctx, monster: CustomMonster): CustomMonster | null {
  return ctx.viewer.role === "dm" ? monster : null;
}

/**
 * Which image the DM chose for an SRD monster is DM metadata, like the
 * room's own monsters: players see the image only on tokens they may see,
 * so a default chosen ahead of a fight never hints at what is coming.
 */
function projectSrdImageCtx(ctx: Ctx, entry: SrdImage): SrdImage | null {
  return ctx.viewer.role === "dm" ? entry : null;
}

/** A fight the DM built ahead says what is coming: players get only the tokens it places, when they can see them. */
function projectSavedEncounterCtx(ctx: Ctx, encounter: SavedEncounter): SavedEncounter | null {
  return ctx.viewer.role === "dm" ? encounter : null;
}

/** A document in the DM's library reaches players only as a handout it is shown as (docs/design-v1-pdf-handouts.md 3.4). */
function projectHandoutDocCtx(ctx: Ctx, doc: HandoutDoc): HandoutDoc | null {
  return ctx.viewer.role === "dm" ? doc : null;
}

/**
 * A player's ask for saves (docs/design-v1-player-save-spell.md 5.5): the
 * DM gets it whole. A player gets it only while they own its caster now,
 * and never behind a pause, so another player, a table display and the
 * caster's former owners never learn of it. Its targets are cut to the
 * tokens the viewer sees now, its area to one they see, and its damage roll
 * and what it rolled reach only the asker, since a Secret roll's totals
 * reach only its roller and the DM.
 */
function projectCastCtx(ctx: Ctx, ask: CastAsk): CastAsk | null {
  if (ctx.viewer.role === "dm") return ask;
  if (ctx.paused || !ownsRollCreature(ctx, { tokenId: ask.caster })) return null;
  const out: CastAsk = { id: ask.id, rev: ask.rev, by: ask.by, caster: ask.caster, sceneId: ask.sceneId, spell: ask.spell, at: ask.at };
  if (ask.roll !== undefined) out.roll = ask.roll;
  if (ask.slot !== undefined) out.slot = ask.slot;
  if (ask.area !== undefined) {
    const area = ctx.state.templates[ask.area];
    if (area && projectTemplateCtx(ctx, area)) out.area = ask.area;
  }
  if (ask.targets !== undefined) out.targets = ask.targets.filter((id) => tokenVisibleById(ctx, id));
  if (ask.by === ctx.viewer.memberId) {
    if (ask.damage !== undefined) out.damage = ask.damage;
    if (ask.rolled !== undefined) out.rolled = ask.rolled;
  }
  return out;
}

/**
 * A character's stat blocks for its companions reach the DM and whoever
 * owns the character, who are exactly the owners of its companions
 * (docs/design-v1-companion-stat-blocks.md 4.2). The character's ownership
 * is the only input, so who reads a block never drifts from who plays the
 * companions. They are not scene data, so a blackout keeps them, as it
 * keeps the player's characters.
 */
function projectCompanionBlockCtx(ctx: Ctx, block: CompanionBlock): CompanionBlock | null {
  if (ctx.viewer.role === "dm") return block;
  const character = ctx.state.characters[block.characterId];
  // Rev 0 for players, as on their characters (projectCharacter).
  return character !== undefined && ownsCharacter(ctx.viewer, character) ? { ...block, rev: 0 } : null;
}

/** Whether a player may read a journal page: one shared with every player, or with them alone (docs/design-v1-dm-tools.md 3.7). */
export function pageReadableBy(page: Pick<JournalPage, "access">, memberId: string): boolean {
  return page.access === "all" || (typeof page.access === "object" && page.access.member === memberId);
}

/**
 * A journal page as a player who may read it gets it, outside a blackout:
 * every secret block not revealed is dropped whole, and a revealed one
 * loses its flag and reads as ordinary text. `rev` is 0, so an edit inside
 * a block they cannot see sends them nothing, and the order of what is left
 * shows no gap. A table display reads as a player who owns nothing, so it
 * gets the pages shared with all.
 */
function projectJournalCtx(ctx: Ctx, page: JournalPage): JournalPage | null {
  if (ctx.viewer.role === "dm") return page;
  if (ctx.paused || !pageReadableBy(page, ctx.viewer.memberId)) return null;
  let out = playerPages.get(page);
  if (!out) playerPages.set(page, (out = playerPageOf(page)));
  return out;
}

/*
 * A player's page, kept per page object, which is replaced and never
 * changed, so every reader of an unchanged page gets the same object and
 * the fan-out need not hash it again.
 */
const playerPages = new WeakMap<JournalPage, JournalPage>();

function playerPageOf(page: JournalPage): JournalPage {
  const blocks = page.blocks.filter((b) => b.secret === undefined || b.secret.revealed).map((b) => ({ id: b.id, text: b.text }));
  const out: JournalPage = { id: page.id, rev: 0, title: page.title, access: page.access, blocks };
  if (page.folder !== undefined) out.folder = page.folder;
  return out;
}

/** The cell a pin's point lies in, which the fog rule tests as it tests a label's cells. */
export function pinCells(pin: Pick<Pin, "x" | "y">): CellRange {
  const x = Math.floor(pin.x);
  const y = Math.floor(pin.y);
  return { x0: x, y0: y, x1: x + 1, y1: y + 1 };
}

/**
 * Map pins (docs/design-v1-dm-tools.md 3.8), by the labels' rule and two
 * more: a player gets a pin on their scene that is not DM only, not on a
 * fully fogged cell (the two fog layers merged), and whose page, if it has
 * one, they may read. A pin linked to a DM-only page is the DM's, so players
 * never learn that a note exists there.
 */
function projectPinCtx(ctx: Ctx, pin: Pin): Pin | null {
  if (pin.sceneId !== ctx.sceneId) return null;
  if (ctx.viewer.role === "dm") return pin;
  if (pin.visibility === "dm") return null;
  if (pin.pageId !== undefined) {
    const page = ctx.state.journal[pin.pageId];
    if (!page || !pageReadableBy(page, ctx.viewer.memberId)) return null;
  }
  const scene = ctx.state.scenes[pin.sceneId];
  if (!scene || !scene.fogEnabled) return pin;
  const fogged = isRangeFullyFogged(anyFogTiles(ctx.state), pin.sceneId, pinCells(pin), (x, y) => ctx.fogged(pin.sceneId, x, y));
  return fogged ? null : pin;
}

/**
 * Whether a roll line holds a result no player's answer could carry, so
 * that a DM's bare mark wrote it: a result with no total and no save failed
 * without rolling (a mark on a creature still waiting), a pass on a save
 * failed without rolling, a result beside a total on a request with no DC
 * (a player's total there carries none), or a result other than the DC's
 * own verdict on the total (an overrule). A player sends only a total, or
 * a fail without rolling on a save (permissions.ts rollAnswerCheck), and
 * the reducer sets a result only from the DC. The stored line is the same
 * whoever wrote it, so this reads its values alone: a mark that says what
 * the answer already says, such as a mark back to the DC's verdict after an
 * overrule, cannot be told from the answer and still reaches the player as
 * the same words again.
 */
function isMarkLine(data: Extract<LogEvent, { type: "roll" }>): boolean {
  if (data.result === undefined) return false;
  if (data.total === undefined) return !data.noRoll || data.result === "pass";
  if (data.dc === undefined) return true;
  return data.result !== (data.total >= data.dc ? "pass" : "fail");
}

/** Whether the viewer owns the creature a roll target or a roll line names, now. A creature that is gone is no one's. */
function ownsRollCreature(ctx: Ctx, ref: { tokenId?: string; characterId?: string }): boolean {
  if (ref.tokenId !== undefined) {
    const token = ctx.state.tokens[ref.tokenId];
    return token !== undefined && ownsToken(ctx.state, ctx.viewer, token);
  }
  if (ref.characterId !== undefined) {
    const character = ctx.state.characters[ref.characterId];
    return character !== undefined && ownsCharacter(ctx.viewer, character);
  }
  return false;
}

/**
 * A roll request (docs/design-v1-dm-tools.md 3.3) as a player gets it:
 * only when it names a creature they own now, with only those targets, the
 * DC only when players see it (else `dcHidden`, never the number), each
 * result only when players see pass or fail, no `by` or `previous`, and rev
 * 0, so another player's answer sends them nothing. None during a blackout.
 * A table display owns nothing, so it gets none.
 *
 * A save its player failed without rolling keeps `noRoll` whatever the
 * switch says, as a total does: it is their own input, so it tells them
 * nothing, and without it their other devices and a reload would ask again
 * and a DM's reopen would not show. A DM's bare mark carries no `noRoll`, so
 * it stays hidden with the result.
 */
function projectRollCtx(ctx: Ctx, request: RollRequest): RollRequest | null {
  if (ctx.viewer.role === "dm") return request;
  if (ctx.paused) return null;
  const targets = request.targets.filter((t) => ownsRollCreature(ctx, t)).map((t) => playerRollTarget(t, request.resultShown));
  if (targets.length === 0) return null;
  const out: RollRequest = { id: request.id, rev: 0, test: request.test, dcShown: request.dcShown, resultShown: request.resultShown, at: request.at, targets };
  if (request.note !== undefined) out.note = request.note;
  // What the roll is for goes with it, and `ends`, which names the effect and its occurrence, stays the DM's (docs/design-v1-roll-request.md 7.5).
  if (request.spell) out.spell = true;
  if (request.cause !== undefined) out.cause = request.cause;
  if (request.dc !== undefined) {
    if (request.dcShown) out.dc = request.dc;
    else out.dcHidden = true;
  }
  return out;
}

/**
 * A target as its creature's players read it: the answer they gave or the
 * server rolled for them, its dice and provenance and a pending ask
 * (docs/design-v1-dice.md 5.2, docs/design-v1-roll-request.md 7.5), and the
 * result and the DM's mark only while pass or fail is shown. `by` and
 * `previous`, with the old dice, stay the DM's.
 */
function playerRollTarget(target: RollTarget, resultShown: boolean): RollTarget {
  const out: RollTarget = target.tokenId !== undefined ? { tokenId: target.tokenId } : { characterId: target.characterId! };
  if (target.choice !== undefined) out.choice = target.choice;
  if (target.total !== undefined) out.total = target.total;
  if (resultShown && target.result !== undefined) out.result = target.result;
  if (resultShown && target.mark !== undefined) out.mark = target.mark;
  if (target.noRoll) out.noRoll = true;
  if (target.tag !== undefined) out.tag = target.tag;
  if (target.dice !== undefined) out.dice = target.dice;
  if (target.typedBonus) out.typedBonus = true;
  if (target.change !== undefined) out.change = target.change;
  if (target.changed !== undefined) out.changed = target.changed;
  // The card offers the Total field without a roll row while it is set (docs/design-v1-roll-request.md 5.5).
  if (target.retype) out.retype = true;
  return out;
}

/**
 * Whether the room's order setting lets players see the row now
 * (docs/design-v1-combat-flow.md 11.2): the whole order, the party's own
 * creature, an ally where allies show, or a row whose turn has come. The
 * acting row always passes, so the Hidden rules alone decide what players
 * see of it on its turn. With a `viewer`, a monster or NPC lent to that
 * player shows from the start too. Without one, the answer is for players
 * who own no part of the row.
 */
export function orderShown(state: RoomState, entry: InitEntry, viewer?: Viewer): boolean {
  const reveal = orderRevealOf(state.meta.settings);
  if (reveal === "all" || entry.hadTurn || state.encounter?.activeEntryId === entry.id) return true;
  return shownFromTheStart(state, entry, reveal === "allies", viewer);
}

/**
 * Whether a creature's initiative roll is the DM's and its own players'
 * alone, written so on its dice line (`DiceRoll.hidden`): the order setting
 * keeps its place from players who own no part of it now, since no row of
 * it has had its turn and it is not shown from the start. A creature with
 * no row yet counts too, so a roll made before it joins the fight tells
 * players nothing either.
 */
export function initiativeHidden(state: RoomState, creature: { tokenId: string } | { characterId: string }): boolean {
  const reveal = orderRevealOf(state.meta.settings);
  if (reveal === "all" || shownFromTheStart(state, creature, reveal === "allies")) return false;
  const characterId = "characterId" in creature ? creature.characterId : rowCharacter(state, creature);
  const itsRow = (e: InitEntry) => ("tokenId" in creature && e.tokenId === creature.tokenId) || (characterId !== undefined && rowCharacter(state, e) === characterId);
  return !(state.encounter?.entries.some((e) => itsRow(e) && orderShown(state, e)) ?? false);
}

/**
 * A creature whose place players see from the fight's start: a player
 * character or a companion of one, which every player sees, a monster or
 * NPC lent to the `viewer`, which only that player sees (the project owner,
 * 2026-10-17), or with `allies` one with the Ally ring.
 */
function shownFromTheStart(state: RoomState, creature: { tokenId?: string; characterId?: string }, allies: boolean, viewer?: Viewer): boolean {
  const token = creature.tokenId !== undefined ? state.tokens[creature.tokenId] : undefined;
  if (token) return partysOwn(state, token) || (viewer !== undefined && ownsToken(state, viewer, token)) || (allies && token.disposition === "ally");
  const character = creature.characterId !== undefined ? state.characters[creature.characterId] : undefined;
  return character !== undefined && anyPlayer(state, character.ownerIds);
}

/**
 * A token the party plays as its own: a player character, or a companion,
 * a player's. A monster or NPC lent to a player is that player's alone.
 */
function partysOwn(state: RoomState, token: Token): boolean {
  if (!playersToken(state, token)) return false;
  if (token.kind === "pc" || token.companion !== undefined) return true;
  const character = characterOf(state, token);
  return character !== undefined && anyPlayer(state, character.ownerIds);
}

/** Whether a player's encounter holds the row: not hidden, in the order players see, and its creature in their sight. */
function entryShown(ctx: Ctx, entry: InitEntry, revealedSeen = false): boolean {
  if (entry.hidden || !orderShown(ctx.state, entry, ctx.viewer)) return false;
  if (entry.tokenId !== undefined && !tokenVisibleById(ctx, entry.tokenId, revealedSeen)) return false;
  return entry.characterId === undefined || ctx.state.characters[entry.characterId] !== undefined;
}

/**
 * Whether a player's encounter holds the acting row, as their tracker and
 * strip show it: the encounter projection's own rule. The reducer asks it of
 * a player's guarded Next or Previous (reducer/encounter.ts
 * pressChangesNothing), so it takes the op's envelope as the seen marks do:
 * an op stored before op version 4 counts a creature revealed on its turn as
 * shown wherever it stood, as that build's projection did, and replays to
 * the same state.
 */
export function activeRowShownTo(state: RoomState, viewer: Viewer, env: Pick<Env, "opVersion">): boolean {
  const encounter = state.encounter;
  const entry = encounter?.entries.find((e) => e.id === encounter.activeEntryId);
  if (!entry) return false;
  if (viewer.role === "dm") return true;
  const ctx = ctxOf(state, viewer, { sceneId: state.meta.playerSceneId });
  return !ctx.paused && entryShown(ctx, entry, revealSeenAnywhere(env.opVersion));
}

function projectEncounterCtx(ctx: Ctx): ProjectedEncounter | null {
  const encounter = ctx.state.encounter;
  if (!encounter) return null;
  if (ctx.viewer.role === "dm") return encounter;
  if (ctx.paused) return null;
  const entries: ProjectedEntry[] = [];
  for (const entry of encounter.entries) {
    if (!entryShown(ctx, entry)) continue;
    // Which rows have had their turn stays the DM's. The order rule has read it already.
    const { groupKey: _groupKey, hadTurn: _hadTurn, ...rest } = entry;
    // The row shows the token's projected name, so the DM's own label never leaks a hidden name.
    if (rest.tokenId !== undefined) delete rest.label;
    entries.push(rest);
  }
  // The stored tieOrder numbers every row, hidden ones too, so a gap would
  // tell a player that a hidden creature exists and roughly when it acts.
  // Numbering only the rows they see, in turn order, keeps that order.
  entries.sort(compareEntries);
  for (const [i, e] of entries.entries()) e.tieOrder = i;
  const activeEntryId = entries.some((e) => e.id === encounter.activeEntryId) ? encounter.activeEntryId : null;
  // Rev 0, as on players' tokens (projectTokenCtx): a hidden row's edits change nothing else they receive.
  const out: ProjectedEncounter = { rev: 0, round: encounter.round, activeEntryId, started: encounter.activeEntryId !== null, entries };
  const turnStart = projectTurnStart(ctx, encounter.turnStart, activeEntryId);
  if (turnStart) out.turnStart = turnStart;
  return out;
}

/**
 * Where the active creature's turn began, for a player who sees that
 * creature on their scene now. Other players get it only when they could
 * see the creature at that spot when the turn began (`seen`), so the marker
 * never shows where a creature stood while it was hidden or in the dark.
 * The token's owners always get their own.
 */
function projectTurnStart(ctx: Ctx, start: TurnStart | undefined, activeEntryId: string | null): TurnStart | null {
  if (!start || activeEntryId === null || start.entryId !== activeEntryId) return null;
  const token = ctx.state.tokens[start.tokenId];
  if (!token || token.sceneId !== start.sceneId || !tokenVisibleTo(ctx, token)) return null;
  if (!start.seen && !ownsToken(ctx.state, ctx.viewer, token)) return null;
  const out: TurnStart = { entryId: start.entryId, tokenId: start.tokenId, sceneId: start.sceneId, x: start.x, y: start.y, elevation: start.elevation };
  if (start.seq !== undefined) out.seq = start.seq;
  // The mounts sharing the turn that the player's copy holds (docs/design-v1-attach.md 8.5).
  const mounts = start.mounts?.filter((id) => tokenVisibleById(ctx, id));
  if (mounts && mounts.length > 0) out.mounts = mounts;
  return out;
}

/** DM only. An empty history projects as absent, so the held map and the snapshot's `[]` agree. */
function projectHistoryCtx(ctx: Ctx): EncounterSnapshot[] | null {
  if (ctx.viewer.role !== "dm" || ctx.state.encounterHistory.length === 0) return null;
  return ctx.state.encounterHistory;
}

/**
 * The creature a log event is about, or null when a player may not have the
 * event: the creature is out of sight now, or the event is about a token
 * that players who do not own it could not see when it happened.
 */
function holderOfEvent(ctx: Ctx, data: { tokenId?: string; characterId?: string; seen?: true }): { token?: Token; character?: Character } | null {
  const holder: { token?: Token; character?: Character } = {};
  if (data.tokenId !== undefined) {
    const token = ctx.state.tokens[data.tokenId];
    if (!token || !tokenVisibleTo(ctx, token)) return null;
    if (!data.seen && !ownsToken(ctx.state, ctx.viewer, token)) return null;
    holder.token = token;
    const character = characterOf(ctx.state, token);
    if (character) holder.character = character;
  }
  if (data.characterId !== undefined) {
    const character = ctx.state.characters[data.characterId];
    if (!character) return null;
    holder.character = character;
  }
  return holder;
}

/** Whether the creature's life is shown to this viewer as alive whatever it is: an effect companion the viewer does not own. */
function hiddenLife(ctx: Ctx, holder: { token?: Token }): boolean {
  return holder.token !== undefined && effectCompanion(holder.token) && !ownsToken(ctx.state, ctx.viewer, holder.token);
}

/** Whether the viewer owns the creature on an initiative row, so its turns are part of the viewer's own history. */
function ownsRow(ctx: Ctx, row: ProjectedEntry): boolean {
  const token = row.tokenId !== undefined ? ctx.state.tokens[row.tokenId] : undefined;
  if (token && ownsToken(ctx.state, ctx.viewer, token)) return true;
  const character = row.characterId !== undefined ? ctx.state.characters[row.characterId] : undefined;
  return character !== undefined && ownsCharacter(ctx.viewer, character);
}

function projectEventCtx(ctx: Ctx, data: LogEvent): LogEvent | null {
  switch (data.type) {
    case "hp": {
      const holder = holderOfEvent(ctx, data);
      if (!holder) return null;
      const access = hpAccess(ctx.state, ctx.viewer, holder);
      // An allowlist: what the change replaced and which line a take-back names are the DM's alone, the owner included.
      const out: LogEvent = { type: "hp", change: data.change };
      if (data.tokenId !== undefined) out.tokenId = data.tokenId;
      if (data.characterId !== undefined) out.characterId = data.characterId;
      if (data.seen) out.seen = true;
      if (data.crit !== undefined) out.crit = data.crit;
      if (data.back) out.back = true;
      if (access !== "none" && data.label !== undefined) out.label = data.label;
      if (access === "exact") {
        if (data.amount !== undefined) out.amount = data.amount;
        if (data.left !== undefined) out.left = data.left;
      }
      return out;
    }
    case "concentration": {
      if (data.hidden) return null;
      const holder = holderOfEvent(ctx, data);
      if (!holder) return null;
      if (hpAccess(ctx.state, ctx.viewer, holder) === "exact") return data;
      const { dc: _dc, ...rest } = data;
      return rest;
    }
    case "effect":
      // Hidden from players, owners included, like the effect itself on the actor.
      if (data.hidden) return null;
      return holderOfEvent(ctx, data) ? data : null;
    case "rest": {
      // Everyone who sees the creature sees it rest. The HP it got back is as private as its HP.
      const holder = holderOfEvent(ctx, data);
      if (!holder) return null;
      const access = hpAccess(ctx.state, ctx.viewer, holder);
      const out: LogEvent = { type: "rest", kind: data.kind };
      if (data.tokenId !== undefined) out.tokenId = data.tokenId;
      if (data.characterId !== undefined) out.characterId = data.characterId;
      if (data.seen) out.seen = true;
      if (access !== "none" && data.label !== undefined) out.label = data.label;
      if (access === "exact") {
        if (data.amount !== undefined) out.amount = data.amount;
        if (data.left !== undefined) out.left = data.left;
      }
      return out;
    }
    case "deathSave": {
      // Life is public, but how close a creature is to death is as private as its HP.
      const holder = holderOfEvent(ctx, data);
      if (!holder || hiddenLife(ctx, holder)) return null;
      if (hpAccess(ctx.state, ctx.viewer, holder) === "exact") return data;
      const { ok: _ok, fail: _fail, ...rest } = data;
      return rest;
    }
    case "life": {
      // An effect companion reaches non-owners alive (effectCompanion), so its life lines would say otherwise.
      const holder = holderOfEvent(ctx, data);
      return holder && !hiddenLife(ctx, holder) ? data : null;
    }
    case "turn": {
      const rows = projectEncounterCtx(ctx)?.entries;
      const row = rows?.find((e) => e.id === data.entryId);
      if (!row || !(data.seen || ownsRow(ctx, row))) return null;
      if (data.to === undefined && data.toSeen === undefined) return data;
      // The row a take-back resumed, only for a player who could see it resume, and sees it now.
      const { to, toSeen, ...rest } = data;
      const resumed = rows?.find((e) => e.id === to);
      return resumed && (toSeen || ownsRow(ctx, resumed)) ? { ...rest, to: resumed.id } : rest;
    }
    case "area": {
      // The area must have been in players' sight when it happened and be in this player's now, as must the creature.
      if (data.hidden || !holderOfEvent(ctx, data)) return null;
      const template = ctx.state.templates[data.templateId];
      return template && projectTemplateCtx(ctx, template) ? data : null;
    }
    case "encounter":
      // A fight started behind the pause screen is news when the game resumes.
      return ctx.paused ? null : data;
    case "handout": {
      const handout = ctx.state.handouts[data.handoutId];
      return handout && projectHandoutCtx(ctx, handout) ? data : null;
    }
    case "member":
      // Every player sees the whole roster, so its history is public too.
      // Not tied to who is on the roster now: a removed member's lines stay.
      return data;
    case "teleport":
      // The DM's note (docs/design-v1-maps-vision.md 4.1). No player gets it, the token's owners included.
      return null;
    case "saveEnds":
      // The DM's reminder with the save's DC (docs/design-v1-roll-options.md 6.1). A player's creature's player gets a request instead.
      return null;
    case "companion":
      // The DM's note that a player added a companion (docs/design-v1-combat-flow.md 3.6.3). No player gets it.
      return null;
    case "characterDeleted":
      // The DM's note that a player deleted a character, with counts that name what no player may see. No player gets it.
      return null;
    case "roll": {
      // As the request itself (projectRollCtx): its creature's players now, under the same two switches.
      if (ctx.paused || !ownsRollCreature(ctx, data)) return null;
      // With pass or fail hidden a DM's mark adds nothing a player may read, and its line alone would tell them the DM judged it (LP5-ROLLS-4).
      // A line written since wave 7 carries its tag and says itself whether a mark wrote it (docs/design-v1-roll-request.md 7.5).
      if (!data.resultShown && (data.tag === undefined ? isMarkLine(data) : data.mark === true)) return null;
      const out: LogEvent = { type: "roll", test: data.test };
      if (data.tokenId !== undefined) out.tokenId = data.tokenId;
      if (data.characterId !== undefined) out.characterId = data.characterId;
      if (data.choice !== undefined) out.choice = data.choice;
      if (data.total !== undefined) out.total = data.total;
      if (data.noRoll) out.noRoll = true;
      if (data.dcShown && data.dc !== undefined) {
        out.dc = data.dc;
        out.dcShown = true;
      }
      if (data.resultShown) {
        out.resultShown = true;
        if (data.result !== undefined) out.result = data.result;
      }
      // A rolled answer's dice reach the creature's players with its total (docs/design-v1-dice.md 5.2).
      if (data.dice !== undefined) out.dice = data.dice;
      if (data.typedBonus) out.typedBonus = true;
      if (data.tag !== undefined) out.tag = data.tag;
      if (data.changed !== undefined) out.changed = data.changed;
      return out;
    }
    case "dice":
      return projectDiceCtx(ctx, data);
    case "cast":
      // As the ask itself (projectCastCtx): its caster's players now, never behind a pause.
      return ctx.paused || !ownsRollCreature(ctx, data) ? null : data;
    // Trap lines live in their own logs (projectTrapSeenCtx), never in this one.
    case "trap":
    case "trapSeen":
    case "trapNotice":
      return null;
  }
}

/**
 * A `dice` line for a player (docs/design-v1-dice.md 5.2). Each roll is
 * kept when it names no creature, a character, or a token the player may
 * have the events of (holderOfEvent: in sight now, and seen then or
 * owned), so a token's roll follows that token's events and none passes a
 * blackout. An initiative roll marked `hidden`, for a creature whose place
 * in the order players did not know then, is kept only for the creature's
 * own players, such as a monster's lent to one (docs/design-v1-combat-flow.md
 * 11.3). With none kept there is no line.
 * Open to everyone, or the
 * player's own, it reads in full, the tag only for its roller. A secret
 * roll of someone else's reads as the bare line, and only when the same
 * roll made public would have reached the player, so a roll for a creature
 * hidden or in the dark leaves no trace. A table display is no member of
 * the room and gets no line, as it gets no `roll` line.
 */
function projectDiceCtx(ctx: Ctx, data: Extract<LogEvent, { type: "dice" }>): LogEvent | null {
  if (!ctx.state.members[ctx.viewer.memberId]) return null;
  const rolls = data.rolls
    .filter((roll) => (!roll.hidden || ownsRollCreature(ctx, roll)) && (roll.tokenId === undefined || holderOfEvent(ctx, roll) !== null))
    // The mark is the DM's, so the DM's log alone says the roll was kept from players.
    .map((roll) => {
      if (!roll.hidden) return roll;
      const { hidden: _hidden, ...rest } = roll;
      return rest;
    });
  if (rolls.length === 0) return null;
  const mine = data.by === ctx.viewer.memberId;
  if (data.to === "dm" && !mine) return { type: "dice", by: data.by, to: "dm", rolls: [] };
  const out: Extract<LogEvent, { type: "dice" }> = { type: "dice", by: data.by, to: data.to, rolls };
  if (mine && data.tag !== undefined) out.tag = data.tag;
  if (mine && data.part !== undefined) out.part = data.part;
  if (data.batch !== undefined) out.batch = data.batch;
  if (data.dc !== undefined) out.dc = data.dc;
  if (data.ac !== undefined) out.ac = data.ac;
  return out;
}

/**
 * A line of the live log for a viewer: inside their live log
 * (shared/logRings.ts liveStart) and passing its own rules. Lines older
 * than where it starts reach them through the archive's pages.
 */
function projectLiveLineCtx(ctx: Ctx, entry: LogEntry): LogEntry | null {
  return inLiveLog(ctx.state, ctx.viewer, entry.id) ? projectLogEntryCtx(ctx, entry) : null;
}

/** The live log as the viewer may read it: from where their live log starts, each line by its own rules. */
function projectLiveLogCtx(ctx: Ctx): LogEntry[] {
  const log = ctx.state.log;
  const start = liveStart(ctx.state, ctx.viewer);
  let from = 0;
  if (start !== null) while (from < log.length && compareLogIds(log[from]!.id, start) < 0) from++;
  const out: LogEntry[] = [];
  for (let i = from; i < log.length; i++) {
    const projected = projectLogEntryCtx(ctx, log[i]!);
    if (projected) out.push(projected);
  }
  return out;
}

/**
 * Lines from the archive (`room_log`) as a viewer may read them, each by
 * its own rules against the room as it is now, as the live log's lines
 * are, with none of the live log's rings: an archive page holds every line
 * the viewer may read before its cursor (design 10.8).
 */
export function projectArchivedLog(state: RoomState, lines: readonly LogEntry[], viewer: Viewer, opts: ProjectOpts): LogEntry[] {
  const ctx = ctxOf(state, viewer, opts);
  const out: LogEntry[] = [];
  for (const line of lines) {
    const projected = projectLogEntryCtx(ctx, line);
    if (projected) out.push(projected);
  }
  return out;
}

function projectLogEntryCtx(ctx: Ctx, entry: LogEntry): LogEntry | null {
  if (entry.kind === "whisper") {
    const me = ctx.viewer.memberId;
    return entry.from === me || entry.to?.includes(me) ? entry : null;
  }
  if (ctx.viewer.role === "dm") return entry;
  if (entry.kind === "chat") return entry;
  if (!entry.data) return null;
  const data = projectEventCtx(ctx, entry.data);
  if (!data) return null;
  return data === entry.data ? entry : { ...entry, data };
}

function projectMemberCtx(_ctx: Ctx, member: Member): Member {
  return member;
}

function projectMetaCtx(ctx: Ctx): RoomMeta {
  return ctx.state.meta;
}

/** One entity as the viewer may see it, or null when the viewer may not know it exists. */
export function projectEntity(key: EntityKey, state: RoomState, viewer: Viewer, opts: ProjectOpts): unknown {
  return projectEntityCtx(ctxOf(state, viewer, opts), key);
}

function projectEntityCtx(ctx: Ctx, key: EntityKey): unknown {
  const parsed = parseKey(key);
  if (!parsed) return null;
  const value = readEntity(ctx.state, key);
  switch (parsed.kind) {
    case "token":
      return value ? projectTokenCtx(ctx, value as Token) : null;
    case "character":
      return value ? projectCharacter(ctx.state, ctx.viewer, value as Character) : null;
    case "template":
      return value ? projectTemplateCtx(ctx, value as AreaTemplate) : null;
    case "drawing":
      return value ? projectDrawingCtx(ctx, value as Drawing) : null;
    case "chunk":
      return value ? projectChunkCtx(ctx, value as BuildChunk) : null;
    case "fog":
      return projectFogCtx(ctx, parsed.sceneId, parsed.tx, parsed.ty);
    case "explored":
      return value ? projectExploredCtx(ctx, value as FogTile) : null;
    case "sight":
      return projectSightCtx(ctx, parsed.sceneId, parsed.tx, parsed.ty);
    case "fogDraft":
      return value ? projectFogDraftCtx(ctx, value as FogDraft) : null;
    case "label":
      return value ? projectLabelCtx(ctx, value as Label) : null;
    case "scene":
      return value ? projectSceneCtx(ctx, value as Scene) : null;
    case "member":
      return value ? projectMemberCtx(ctx, value as Member) : null;
    case "handout":
      return value ? projectHandoutCtx(ctx, value as Handout) : null;
    case "monster":
      return value ? projectMonsterCtx(ctx, value as CustomMonster) : null;
    case "srdImage":
      return value ? projectSrdImageCtx(ctx, value as SrdImage) : null;
    case "savedEncounter":
      return value ? projectSavedEncounterCtx(ctx, value as SavedEncounter) : null;
    case "stamp":
      return value ? projectStampCtx(ctx, value as Stamp) : null;
    case "light":
      return value ? projectLightCtx(ctx, value as Light) : null;
    case "journal":
      return value ? projectJournalCtx(ctx, value as JournalPage) : null;
    case "pin":
      return value ? projectPinCtx(ctx, value as Pin) : null;
    case "roll":
      return value ? projectRollCtx(ctx, value as RollRequest) : null;
    case "handoutDoc":
      return value ? projectHandoutDocCtx(ctx, value as HandoutDoc) : null;
    case "companionBlock":
      return value ? projectCompanionBlockCtx(ctx, value as CompanionBlock) : null;
    case "cast":
      return value ? projectCastCtx(ctx, value as CastAsk) : null;
    case "trap":
      return value ? projectTrapCtx(ctx, value as Trap) : null;
    case "log":
      return value ? projectLiveLineCtx(ctx, value as LogEntry) : null;
    case "trapLog":
      return value && ctx.viewer.role === "dm" ? value : null;
    case "trapSeen":
      return value ? projectTrapSeenCtx(ctx, value as LogEntry) : null;
    case "encounter":
      return projectEncounterCtx(ctx);
    case "encounterHistory":
      return projectHistoryCtx(ctx);
    case "meta":
      return projectMetaCtx(ctx);
  }
}

function projectMap<T, P>(map: Record<string, T>, project: (value: T) => P | null): Record<string, P> {
  const out: Record<string, P> = {};
  for (const [id, value] of Object.entries(map)) {
    const projected = project(value);
    if (projected !== null) out[id] = projected;
  }
  return out;
}

/** The full snapshot for a viewer: one scene's contents and the room-level data the viewer may see. */
export function projectState(state: RoomState, viewer: Viewer, opts: ProjectOpts): ProjectedState {
  const ctx = ctxOf(state, viewer, opts);
  return {
    meta: projectMetaCtx(ctx),
    members: projectMap(state.members, (m) => projectMemberCtx(ctx, m)),
    scenes: projectMap(state.scenes, (s) => projectSceneCtx(ctx, s)),
    buildChunks: projectMap(state.buildChunks, (c) => projectChunkCtx(ctx, c)),
    labels: projectMap(state.labels, (l) => projectLabelCtx(ctx, l)),
    fogTiles: projectFogTilesCtx(ctx),
    fogDrafts: projectMap(state.fogDrafts, (d) => projectFogDraftCtx(ctx, d)),
    tokens: projectMap(state.tokens, (t) => projectTokenCtx(ctx, t)),
    characters: projectMap(state.characters, (c) => projectCharacter(state, viewer, c)),
    templates: projectMap(state.templates, (t) => projectTemplateCtx(ctx, t)),
    drawings: projectMap(state.drawings, (d) => projectDrawingCtx(ctx, d)),
    encounter: projectEncounterCtx(ctx),
    encounterHistory: projectHistoryCtx(ctx) ?? [],
    handouts: projectMap(state.handouts, (h) => projectHandoutCtx(ctx, h)),
    log: projectLiveLogCtx(ctx),
    monsters: projectMap(state.monsters, (m) => projectMonsterCtx(ctx, m)),
    srdImages: projectMap(state.srdImages, (e) => projectSrdImageCtx(ctx, e)),
    savedEncounters: projectMap(state.savedEncounters, (e) => projectSavedEncounterCtx(ctx, e)),
    stamps: projectMap(state.stamps, (st) => projectStampCtx(ctx, st)),
    lights: projectMap(state.lights, (l) => projectLightCtx(ctx, l)),
    exploredTiles: projectMap(state.exploredTiles, (t) => projectExploredCtx(ctx, t)),
    journal: projectMap(state.journal, (page) => projectJournalCtx(ctx, page)),
    pins: projectMap(state.pins, (pin) => projectPinCtx(ctx, pin)),
    rolls: projectMap(state.rolls, (request) => projectRollCtx(ctx, request)),
    handoutDocs: projectMap(state.handoutDocs, (doc) => projectHandoutDocCtx(ctx, doc)),
    companionBlocks: projectMap(state.companionBlocks, (block) => projectCompanionBlockCtx(ctx, block)),
    casts: projectMap(state.casts, (ask) => projectCastCtx(ctx, ask)),
    traps: projectMap(state.traps ?? {}, (trap) => projectTrapCtx(ctx, trap)),
    trapLog: viewer.role === "dm" ? (state.trapLog ?? []) : [],
    trapSeen: (state.trapSeen ?? []).map((e) => projectTrapSeenCtx(ctx, e)).filter((e): e is LogEntry => e !== null),
    sight: sightTilesCtx(ctx),
  };
}

/** The viewer's scene's fog tiles, each key either layer holds (projectFogCtx). */
function projectFogTilesCtx(ctx: Ctx): Record<string, FogTile> {
  const out: Record<string, FogTile> = {};
  for (const layer of [ctx.state.fogTiles, ctx.state.exploredTiles ?? {}]) {
    for (const [key, tile] of Object.entries(layer)) {
      if (key in out) continue;
      const projected = projectFogCtx(ctx, tile.sceneId, tile.tx, tile.ty);
      if (projected) out[key] = projected;
    }
  }
  return out;
}

/** Every entity key a projection may hold, so a global re-projection can be compared with a held map. */
export function allKeys(state: RoomState): EntityKey[] {
  const out: EntityKey[] = [keys.meta, keys.encounter, keys.encounterHistory];
  for (const id of Object.keys(state.members)) out.push(keys.member(id));
  for (const id of Object.keys(state.scenes)) out.push(keys.scene(id));
  for (const c of Object.values(state.buildChunks)) out.push(keys.chunk(c.sceneId, c.cx, c.cy));
  for (const id of Object.keys(state.labels)) out.push(keys.label(id));
  for (const t of Object.values(state.fogTiles)) out.push(keys.fog(t.sceneId, t.tx, t.ty));
  // A tile only the party explored is still a fog tile to players (projectFogCtx).
  for (const [key, t] of Object.entries(state.exploredTiles ?? {})) {
    out.push(keys.explored(t.sceneId, t.tx, t.ty));
    if (!state.fogTiles[key]) out.push(keys.fog(t.sceneId, t.tx, t.ty));
  }
  out.push(...sightKeys(state));
  for (const id of Object.keys(state.fogDrafts)) out.push(keys.fogDraft(id));
  for (const id of Object.keys(state.tokens)) out.push(keys.token(id));
  for (const id of Object.keys(state.characters)) out.push(keys.character(id));
  for (const id of Object.keys(state.templates)) out.push(keys.template(id));
  for (const id of Object.keys(state.drawings)) out.push(keys.drawing(id));
  for (const id of Object.keys(state.handouts)) out.push(keys.handout(id));
  for (const id of Object.keys(state.monsters)) out.push(keys.monster(id));
  for (const id of Object.keys(state.srdImages)) out.push(keys.srdImage(id));
  for (const id of Object.keys(state.savedEncounters)) out.push(keys.savedEncounter(id));
  for (const id of Object.keys(state.stamps)) out.push(keys.stamp(id));
  for (const id of Object.keys(state.lights)) out.push(keys.light(id));
  for (const id of Object.keys(state.journal)) out.push(keys.journal(id));
  for (const id of Object.keys(state.pins)) out.push(keys.pin(id));
  for (const id of Object.keys(state.rolls)) out.push(keys.roll(id));
  for (const id of Object.keys(state.handoutDocs)) out.push(keys.handoutDoc(id));
  for (const id of Object.keys(state.companionBlocks)) out.push(keys.companionBlock(id));
  for (const id of Object.keys(state.casts ?? {})) out.push(keys.cast(id));
  for (const e of state.log) out.push(keys.log(e.id));
  for (const id of Object.keys(state.traps ?? {})) out.push(keys.trap(id));
  for (const e of state.trapLog ?? []) out.push(keys.trapLog(e.id));
  for (const e of state.trapSeen ?? []) out.push(keys.trapSeen(e.id));
  return out;
}

/**
 * The sight tile keys a state can hold. A projection holds its own. On the
 * server's state, which holds none, every tile inside each vision scene's
 * bounds may be one, and projecting a key that has no tile gives null, so
 * listing them all spares computing sight for scenes nobody is looking at.
 */
function sightKeys(state: RoomState): EntityKey[] {
  const held = sightOf(state);
  const out: EntityKey[] = [];
  if (held !== undefined) {
    for (const key of Object.keys(held)) out.push(`sight:${key}`);
    return out;
  }
  for (const scene of Object.values(state.scenes)) {
    if (!visionOn(scene)) continue;
    for (let ty = 0; ty < tilesAcross(scene.bounds.h); ty++) for (let tx = 0; tx < tilesAcross(scene.bounds.w); tx++) out.push(keys.sight(scene.id, tx, ty));
  }
  return out;
}

/**
 * Entities whose projection can change when the touched ones do (design
 * 7.3, fan-out): templates on a touched token, kept rulers on one, tokens
 * of a touched character, the encounter when a row's creature changed,
 * tokens with a path when the encounter changed, and log entries that name
 * any of them. On wave 4 scenes, the fog tile an explored write changes and
 * what stands on a tile where exploring or the party's sight changed
 * (tileDependents).
 */
export function dependents(state: RoomState, touched: EntityKey[]): EntityKey[] {
  const seen = new Set(touched);
  const out: EntityKey[] = [];
  const add = (key: EntityKey) => {
    if (!seen.has(key)) {
      seen.add(key);
      out.push(key);
    }
  };
  const tokenIds = new Set<string>();
  const characterIds = new Set<string>();
  const handoutIds = new Set<string>();
  const templateIds = new Set<string>();
  const pageIds = new Set<string>();
  let encounterTouched = false;
  // The tiles an explore wrote or the party's sight changed on, by scene: what stands on them is projected again.
  const tiles = new Map<string, Set<string>>();
  const onTile = (sceneId: string, tx: number, ty: number) => {
    let held = tiles.get(sceneId);
    if (!held) tiles.set(sceneId, (held = new Set()));
    held.add(`${tx},${ty}`);
  };
  // A player gets a token's path only while it is the path of the turn under way and of a row they see (projectPathCtx).
  if (touched.includes(keys.encounter)) {
    for (const token of Object.values(state.tokens)) if (token.path) add(keys.token(token.id));
  }
  for (const key of touched) {
    const parsed = parseKey(key);
    if (!parsed) continue;
    if (parsed.kind === "chunk") {
      // A player's chunk reads the cells beside its north and west borders (projectChunkForPlayer).
      for (const [cx, cy] of [
        [parsed.cx + 1, parsed.cy],
        [parsed.cx, parsed.cy + 1],
      ] as const) {
        if (state.buildChunks[chunkKey(parsed.sceneId, cx, cy)]) add(keys.chunk(parsed.sceneId, cx, cy));
      }
    } else if (parsed.kind === "explored") {
      add(keys.fog(parsed.sceneId, parsed.tx, parsed.ty));
      onTile(parsed.sceneId, parsed.tx, parsed.ty);
    } else if (parsed.kind === "sight") onTile(parsed.sceneId, parsed.tx, parsed.ty);
    else if (parsed.kind === "token") tokenIds.add(parsed.id);
    else if (parsed.kind === "character") characterIds.add(parsed.id);
    else if (parsed.kind === "handout") handoutIds.add(parsed.id);
    else if (parsed.kind === "template") templateIds.add(parsed.id);
    else if (parsed.kind === "journal") pageIds.add(parsed.id);
    else if (parsed.kind === "encounter") encounterTouched = true;
  }
  // A door trap reaches players only while its door is no secret one still hidden (projectTrapCtx), so its chunk re-projects it.
  const chunksTouched = touched.flatMap((key) => {
    const parsed = parseKey(key);
    return parsed?.kind === "chunk" ? [chunkKey(parsed.sceneId, parsed.cx, parsed.cy)] : [];
  });
  if (chunksTouched.length > 0) {
    const held = new Set(chunksTouched);
    for (const trap of Object.values(state.traps ?? {})) {
      if (!("door" in trap.zone)) continue;
      const { cx, cy } = doorChunk(trap.zone.door);
      if (held.has(chunkKey(trap.sceneId, cx, cy))) add(keys.trap(trap.id));
    }
  }
  // A pin reaches players only while its page is one they may read (projectPinCtx), so a page's access re-projects its pins.
  if (pageIds.size > 0) {
    for (const pin of Object.values(state.pins)) if (pin.pageId !== undefined && pageIds.has(pin.pageId)) add(keys.pin(pin.id));
  }
  if (tiles.size > 0) tileDependents(state, tiles, add, tokenIds);
  for (const token of Object.values(state.tokens)) {
    if ("ref" in token.actor && characterIds.has(token.actor.ref)) {
      add(keys.token(token.id));
      tokenIds.add(token.id);
    }
  }
  // A character's Ready trigger reaches players while a player owns any token of it (playerPlays), so a token placed or
  // removed re-projects its character. A change of owners re-projects everything anyway (Tx global).
  for (const id of tokenIds) {
    const token = state.tokens[id];
    if (token && "ref" in token.actor) add(keys.character(token.actor.ref));
  }
  // A carried token's link reaches a player while they see its holder (linkShown), so the holder's change re-projects it.
  // Hidden links count here too, but only to choose what to project again: each copy is still projected by its own rule,
  // and only what changed in it is sent (docs/design-v1-attach.md 8.0).
  for (const token of Object.values(state.tokens)) if (token.attached && tokenIds.has(token.attached.to)) add(keys.token(token.id));
  // So does a mount sharing the turn, in the turn's start.
  if (state.encounter?.turnStart?.mounts?.some((id) => tokenIds.has(id))) {
    add(keys.encounter);
    encounterTouched = true;
  }
  // A path of the turn reaches a player while they see the turn's row, which follows the turn's own creature (projectPathCtx).
  // A mount sharing the turn moves on a path of its own (docs/design-v1-attach.md 7.2), so the creature's change, into
  // sight or out of it, re-projects every path of the turn, the mount's with no change to the mount.
  const turn = state.encounter?.turnStart;
  if (turn && tokenIds.has(turn.tokenId)) {
    for (const token of Object.values(state.tokens)) if (token.path?.turn === turn.seq) add(keys.token(token.id));
  }
  for (const template of Object.values(state.templates)) {
    if ((template.attachedTo !== undefined && tokenIds.has(template.attachedTo)) || (template.casterId !== undefined && tokenIds.has(template.casterId))) {
      add(keys.template(template.id));
      templateIds.add(template.id);
    }
  }
  for (const drawing of Object.values(state.drawings)) {
    if (drawing.anchors?.some((id) => id !== null && tokenIds.has(id))) add(keys.drawing(drawing.id));
  }
  // A roll request reaches a player through the creatures it names, so one that goes away takes its targets with it.
  for (const request of Object.values(state.rolls)) {
    const named = request.targets.some((t) => (t.tokenId !== undefined && tokenIds.has(t.tokenId)) || (t.characterId !== undefined && characterIds.has(t.characterId)));
    if (named) add(keys.roll(request.id));
  }
  // An ask reaches a player through its caster, and its targets and area follow what they see (docs/design-v1-player-save-spell.md 5.5).
  for (const ask of Object.values(state.casts)) {
    const named = tokenIds.has(ask.caster) || (ask.targets?.some((id) => tokenIds.has(id)) ?? false) || (ask.area !== undefined && templateIds.has(ask.area));
    if (named) add(keys.cast(ask.id));
  }
  if (state.encounter) {
    const hit = state.encounter.entries.some(
      (e) => (e.tokenId !== undefined && tokenIds.has(e.tokenId)) || (e.characterId !== undefined && characterIds.has(e.characterId)),
    );
    if (hit) {
      add(keys.encounter);
      encounterTouched = true;
    }
  }
  for (const entry of state.log) {
    const data = entry.data;
    if (!data) continue;
    const refsToken = "tokenId" in data && data.tokenId !== undefined && tokenIds.has(data.tokenId);
    const refsCharacter = "characterId" in data && data.characterId !== undefined && characterIds.has(data.characterId);
    const refsHandout = data.type === "handout" && handoutIds.has(data.handoutId);
    const refsEncounter = data.type === "turn" && encounterTouched;
    // An area's reminder follows the area's own projection too.
    const refsTemplate = data.type === "area" && templateIds.has(data.templateId);
    // A dice line names a creature in each roll (docs/design-v1-dice.md 5.2).
    const refsRoll = data.type === "dice" && data.rolls.some((r) => (r.tokenId !== undefined && tokenIds.has(r.tokenId)) || (r.characterId !== undefined && characterIds.has(r.characterId)));
    if (refsToken || refsCharacter || refsHandout || refsEncounter || refsTemplate || refsRoll) add(keys.log(entry.id));
  }
  // A players' trap line names the creatures every player saw, each viewer getting those they see now (projectTrapSeenCtx).
  if (tokenIds.size > 0) {
    for (const entry of state.trapSeen ?? []) if (entry.data?.type === "trapSeen" && entry.data.by.some((id) => tokenIds.has(id))) add(keys.trapSeen(entry.id));
  }
  return out;
}

/**
 * What can change for players where the party's explored layer was written
 * or its sight changed (docs/design-v1-maps-vision.md 4.3.3 and 4.3.5): the
 * tokens, labels and stamps on those tiles. A player's fog tile is the two
 * fog layers merged, which withholds labels and stamps, and on a vision
 * scene a creature reaches players only while sight covers its own
 * footprint, so nothing off those tiles can change with them. Their own
 * dependents follow as for any touched token. One pass over each
 * collection, however many tiles changed. Clearing explored bits sets
 * `global` instead (shared/reducer/tx.ts).
 *
 * A token counts by the cells the fog rule reads and by the unsnapped
 * rectangle sight judges it by, which can reach a cell further where the
 * DM dropped it off the grid.
 */
function tileDependents(state: RoomState, tiles: ReadonlyMap<string, ReadonlySet<string>>, add: (key: EntityKey) => void, tokenIds: Set<string>): void {
  const on = (sceneId: string, r: CellRange): boolean => {
    const held = tiles.get(sceneId);
    if (!held) return false;
    for (let ty = Math.floor(r.y0 / TILE_CELLS); ty * TILE_CELLS < r.y1; ty++) {
      for (let tx = Math.floor(r.x0 / TILE_CELLS); tx * TILE_CELLS < r.x1; tx++) if (held.has(`${tx},${ty}`)) return true;
    }
    return false;
  };
  for (const token of Object.values(state.tokens)) {
    if (!tiles.has(token.sceneId)) continue;
    const cells = occupiedRange(token);
    const seen = sightRect(token);
    const r = { x0: Math.min(cells.x0, Math.floor(seen.x0)), y0: Math.min(cells.y0, Math.floor(seen.y0)), x1: Math.max(cells.x1, Math.ceil(seen.x1)), y1: Math.max(cells.y1, Math.ceil(seen.y1)) };
    if (!on(token.sceneId, r)) continue;
    add(keys.token(token.id));
    tokenIds.add(token.id);
  }
  for (const label of Object.values(state.labels)) if (on(label.sceneId, labelCells(label))) add(keys.label(label.id));
  for (const stamp of Object.values(state.stamps)) if (on(stamp.sceneId, stampCells(stamp))) add(keys.stamp(stamp.id));
  for (const pin of Object.values(state.pins)) if (on(pin.sceneId, pinCells(pin))) add(keys.pin(pin.id));
  for (const trap of Object.values(state.traps ?? {})) if (zoneRanges(state, trap.sceneId, trap.zone).some((r) => on(trap.sceneId, r))) add(keys.trap(trap.id));
}

/**
 * The sight tile keys whose value differs between two states, on each of
 * the given scenes (docs/design-v1-maps-vision.md 4.3.5): the narrow half
 * of the fan-out on vision scenes. With them as touched keys, `dependents`
 * adds the tokens, labels and stamps on those tiles. A tile the vision
 * cache kept is the same object in both, and one it computed again is
 * compared by content, so only a real change counts.
 */
export function changedSightKeys(before: RoomState, after: RoomState, sceneIds: Iterable<string>): EntityKey[] {
  const out: EntityKey[] = [];
  for (const sceneId of new Set(sceneIds)) {
    if (!visionOn(before.scenes[sceneId]) && !visionOn(after.scenes[sceneId])) continue;
    const was = partySightOf(before, sceneId).tiles;
    const now = partySightOf(after, sceneId).tiles;
    if (was === now) continue;
    const changed = (at: string) => {
      const a = was.get(at);
      const b = now.get(at);
      if (a === b || (a && b && sameSightTile(a, b))) return;
      const [tx, ty] = at.split(",").map(Number) as [number, number];
      out.push(keys.sight(sceneId, tx, ty));
    };
    for (const at of now.keys()) changed(at);
    for (const at of was.keys()) if (!now.has(at)) changed(at);
  }
  return out;
}

function sameSightTile(a: SightTile, b: SightTile): boolean {
  return "f" in a ? "f" in b && a.f === b.f : "b" in b && a.b === b.b;
}

/**
 * The assets a viewer's projection refers to (design 11.2). The server adds
 * the viewer's own uploads. Shipped icons name no asset and add nothing
 * (docs/design-v1-dm-tools.md 3.12).
 */
export function visibleAssetIds(state: RoomState, viewer: Viewer, opts: ProjectOpts): Set<string> {
  const ids = new Set<string>();
  const addImage = (image: Parameters<typeof imageAssetId>[0]) => {
    const id = imageAssetId(image);
    if (id !== undefined) ids.add(id);
  };
  const projected = projectState(state, viewer, opts);
  for (const scene of Object.values(projected.scenes)) if (scene.map) ids.add(scene.map.assetId);
  for (const token of Object.values(projected.tokens)) {
    addImage(token.image);
    // Only the DM's and the owners' projections carry a token's other images, so a disguise's true face stays theirs.
    for (const image of token.altImages ?? []) addImage(image);
  }
  for (const character of Object.values(projected.characters)) addImage(character.defaultImage);
  // Every page of each handout the viewer gets, and no page of one they do not (docs/design-v1-pdf-handouts.md 3.4).
  for (const handout of Object.values(projected.handouts)) for (const page of handoutPages(handout)) ids.add(page.assetId);
  // Only a DM's projection holds documents. A document's pages reach a player only by being shown.
  for (const doc of Object.values(projected.handoutDocs)) for (const page of doc.pages) ids.add(page.assetId);
  // A stamp's image while the stamp is in the projection, so a stamp withheld under fog keeps its picture back too.
  for (const stamp of Object.values(projected.stamps)) if ("assetId" in stamp.art) ids.add(stamp.art.assetId);
  // Only a DM's projection holds them. A player meets these images on tokens alone.
  for (const monster of Object.values(projected.monsters)) addImage(monster.defaultImage);
  for (const entry of Object.values(projected.srdImages)) addImage(entry.image);
  // A companion block's picture reaches the DM and the character's owners, the block's readers, and no one else.
  for (const block of Object.values(projected.companionBlocks)) addImage(block.defaultImage);
  if (viewer.role === "dm") {
    // The DM may use every asset of the room, scenes it is not viewing included, every phase and thumbnail with them.
    for (const scene of Object.values(state.scenes)) {
      if (scene.map) ids.add(scene.map.assetId);
      for (const phase of scene.phases ?? []) ids.add(phase.assetId);
      if (scene.thumb) ids.add(scene.thumb);
    }
    for (const token of Object.values(state.tokens)) {
      addImage(token.image);
      for (const image of token.altImages ?? []) addImage(image);
    }
    for (const stamp of Object.values(state.stamps)) if ("assetId" in stamp.art) ids.add(stamp.art.assetId);
  }
  return ids;
}

// Hashing for the server's held map (design 7.3).

/** JSON with sorted object keys, so the same value always hashes the same. */
export function stableStringify(value: unknown): string {
  if (value === null || value === undefined) return "null";
  switch (typeof value) {
    case "number":
      return Number.isFinite(value) ? String(value) : "null";
    case "string":
      return JSON.stringify(value);
    case "boolean":
      return value ? "true" : "false";
    case "object": {
      if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
      const obj = value as Record<string, unknown>;
      const parts: string[] = [];
      for (const key of Object.keys(obj).sort()) {
        const v = obj[key];
        if (v === undefined) continue;
        parts.push(`${JSON.stringify(key)}:${stableStringify(v)}`);
      }
      return `{${parts.join(",")}}`;
    }
    default:
      return "null";
  }
}

function rotl(x: number, r: number): number {
  return (x << r) | (x >>> (32 - r));
}

function fmix(h: number): number {
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return h >>> 0;
}

const C1 = 0x239b961b;
const C2 = 0xab0e9789;
const C3 = 0x38b34ae5;
const C4 = 0xa1e38b93;

/**
 * MurmurHash3 x86 128 over the UTF-16 code units of a string, as 32 hex
 * characters. It runs in the browser and on the server without Node crypto,
 * and 128 bits make an accidental collision in a held map a non-issue.
 */
export function hash128(text: string): string {
  const len = text.length * 2;
  const byte = (i: number): number => {
    const c = text.charCodeAt(i >> 1);
    return (i & 1) === 0 ? c & 0xff : c >>> 8;
  };
  // A block's 32-bit little-endian word is two whole code units, so the loop reads them directly rather than byte by byte.
  const word = (unit: number): number => text.charCodeAt(unit) | (text.charCodeAt(unit + 1) << 16);
  let h1 = 0;
  let h2 = 0;
  let h3 = 0;
  let h4 = 0;
  const blocks = len - (len % 16);
  for (let u = 0; u < blocks >> 1; u += 8) {
    let k1 = word(u);
    let k2 = word(u + 2);
    let k3 = word(u + 4);
    let k4 = word(u + 6);
    k1 = Math.imul(rotl(Math.imul(k1, C1), 15), C2);
    h1 ^= k1;
    h1 = (Math.imul(rotl(h1, 19) + h2, 5) + 0x561ccd1b) | 0;
    k2 = Math.imul(rotl(Math.imul(k2, C2), 16), C3);
    h2 ^= k2;
    h2 = (Math.imul(rotl(h2, 17) + h3, 5) + 0x0bcaa747) | 0;
    k3 = Math.imul(rotl(Math.imul(k3, C3), 17), C4);
    h3 ^= k3;
    h3 = (Math.imul(rotl(h3, 15) + h4, 5) + 0x96cd1c35) | 0;
    k4 = Math.imul(rotl(Math.imul(k4, C4), 18), C1);
    h4 ^= k4;
    h4 = (Math.imul(rotl(h4, 13) + h1, 5) + 0x32ac3b17) | 0;
  }
  const tail = len - blocks;
  const tailByte = (n: number): number => (n < tail ? byte(blocks + n) : 0);
  if (tail > 12) {
    const k4 = tailByte(12) | (tailByte(13) << 8) | (tailByte(14) << 16);
    h4 ^= Math.imul(rotl(Math.imul(k4, C4), 18), C1);
  }
  if (tail > 8) {
    const k3 = tailByte(8) | (tailByte(9) << 8) | (tailByte(10) << 16) | (tailByte(11) << 24);
    h3 ^= Math.imul(rotl(Math.imul(k3, C3), 17), C4);
  }
  if (tail > 4) {
    const k2 = tailByte(4) | (tailByte(5) << 8) | (tailByte(6) << 16) | (tailByte(7) << 24);
    h2 ^= Math.imul(rotl(Math.imul(k2, C2), 16), C3);
  }
  if (tail > 0) {
    const k1 = tailByte(0) | (tailByte(1) << 8) | (tailByte(2) << 16) | (tailByte(3) << 24);
    h1 ^= Math.imul(rotl(Math.imul(k1, C1), 15), C2);
  }
  h1 ^= len;
  h2 ^= len;
  h3 ^= len;
  h4 ^= len;
  h1 = (h1 + h2) | 0;
  h1 = (h1 + h3) | 0;
  h1 = (h1 + h4) | 0;
  h2 = (h2 + h1) | 0;
  h3 = (h3 + h1) | 0;
  h4 = (h4 + h1) | 0;
  h1 = fmix(h1);
  h2 = fmix(h2);
  h3 = fmix(h3);
  h4 = fmix(h4);
  h1 = (h1 + h2) | 0;
  h1 = (h1 + h3) | 0;
  h1 = (h1 + h4) | 0;
  h2 = (h2 + h1) | 0;
  h3 = (h3 + h1) | 0;
  h4 = (h4 + h1) | 0;
  const hex = (h: number) => (h >>> 0).toString(16).padStart(8, "0");
  return hex(h1) + hex(h2) + hex(h3) + hex(h4);
}

/** The hash of a projected value for the held map. Different values with the same serialization are the same value. */
export function hashValue(projected: unknown): string {
  return hash128(stableStringify(projected));
}

/**
 * What a held map keeps for a key: the hash of the value the connection was
 * last sent, or that value itself until a batch first compares it. The
 * server's snapshots keep the map's bulky values so (server/rooms/fanout.ts),
 * and a value the next projection gives back as the very same object is
 * never hashed at all. Values are replaced, never changed, so a value
 * stands for its hash.
 */
export type HeldEntry = string | object;

export type ProjectionDiff<E extends HeldEntry = HeldEntry> = { changes: Change[]; held: Map<EntityKey, E | string> };

/**
 * What one connection must be sent (design 7.3): for each candidate key, an
 * upsert when the projected value is new or differs from what the
 * connection holds, a removal when it held the entity and the projection is
 * now null. Returns the held map as it should be after the send. The input
 * map is not changed. `hash` lets the server hash a value that several
 * connections receive once per batch, such as a sight tile every player
 * gets (docs/design-v1-maps-vision.md 4.3.5).
 */
export function diffProjection<E extends HeldEntry>(held: ReadonlyMap<EntityKey, E>, next: ReadonlyMap<EntityKey, unknown>, hash: (projected: unknown) => string = hashValue): ProjectionDiff<E> {
  const out = new Map<EntityKey, E | string>(held);
  const changes: Change[] = [];
  for (const [key, value] of next) {
    if (value === null || value === undefined) {
      if (out.has(key)) {
        out.delete(key);
        changes.push({ key, deleted: true });
      }
      continue;
    }
    const prev = out.get(key);
    if (prev === value) continue;
    const h = hash(value);
    if (prev !== undefined && (typeof prev === "string" ? prev : hash(prev)) === h) {
      out.set(key, h);
      continue;
    }
    out.set(key, h);
    changes.push({ key, value });
  }
  return { changes, held: out };
}

/** Builds the held map for a fresh snapshot. */
export function heldOf(projected: ProjectedState): Map<EntityKey, string> {
  const held = new Map<EntityKey, string>();
  for (const key of allKeys(projected as unknown as RoomState)) {
    const value = readEntity(projected as unknown as RoomState, key);
    if (value === null) continue;
    if (key === keys.encounterHistory && (value as unknown[]).length === 0) continue;
    held.set(key, hashValue(value));
  }
  return held;
}

/** Applies an `ev`'s changes to a projected state, the client's side of the fan-out. */
export function applyChanges(projected: ProjectedState, changes: Change[]): ProjectedState {
  let state = projected as unknown as RoomState;
  for (const change of changes) {
    state = writeEntity(state, change.key, "deleted" in change ? null : change.value);
  }
  return state as unknown as ProjectedState;
}
