import { chunkKey, compareLogIds, doorChunk, holderChunkKey, holderTileKey, keys, parseKey, partsKey, readEntity, sightOf, tileKey, viewMapsOf, wallChunk, writeEntity, type EntityKey, type SightMap } from "./keys.ts";
import { projectCorrection } from "./undoCorrection.ts";
import {
  CHUNK_CELLS,
  FOG_SUBCELLS,
  FREE_WALL_ID_LENGTH,
  type Actor,
  type AutoWalls,
  type AreaTemplate,
  type BuildChunk,
  type CastAsk,
  type Character,
  type DiceRoll,
  type CustomMonster,
  type Drawing,
  type EdgeFeature,
  type Effect,
  type Encounter,
  type EncounterSnapshot,
  type ExploredTile,
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
  type LineParts,
  type LogEntry,
  type LogEvent,
  type Member,
  type MemoryChunk,
  type Pin,
  type PlayerChunk,
  type RememberedWall,
  type RollRequest,
  type RollTarget,
  type RoomClock,
  type RoomMeta,
  type RoomState,
  type SavedEncounter,
  type Scene,
  type SightHolders,
  type SightTile,
  type SrdImage,
  type Stamp,
  type StairDir,
  type StairMark,
  type TerrainId,
  type PathStop,
  type Token,
  type TokenPath,
  type Trap,
  type TurnStart,
  type Viewer,
  type WallFeature,
} from "./model.ts";
import { handoutPages } from "./handouts.ts";
import { imageAssetId } from "./imageRef.ts";
import { inLiveLog, lineAudience, liveStart, neverRead } from "./logRings.ts";
import { clipsByHeldWalls, revealSeenAnywhere } from "./migrate.ts";
import type { Change } from "./protocol.ts";
import { lengthAs, type FiredEffect, type MusicRun, type Playing, type Playlist, type Sound, type SoundId } from "./sound.ts";
import type { Env } from "./reducer/tx.ts";
import { isWritable } from "./writable.ts";
import { autoWallBetween, autoWallsOf, paintedAt } from "./rules/autoWalls.ts";
import { visionRules, type PartySight } from "./ruleHooks.ts";
import { decodeTile, encodeTile, getBit, isAboveFog, isRangeFullyFogged, labelCells, tilesAcross, TILE_CELLS } from "./rules/fog.ts";
import { footprintRect, footprintSubcells, occupiedCells, occupiedHexes, occupiedRange, type CellRange } from "./rules/footprint.ts";
import { classSight, fogClassOf, groundOf, holdsOwnSight, joinPieces, wallLattice, wallSpans, type CellPiece, type Ground, type Piece, type PieceKind } from "./rules/held.ts";
import { chunkHeights, chunkMarks, encodeHeights } from "./rules/heights.ts";
import { HEX_R, hexAt, hexCenter, hexKey, hexSubcells, sceneHexSpan, type HexGrid } from "./rules/hex.ts";
import { isHex, sceneGrid, SQUARES, type Grid } from "./rules/grid.ts";
import { hpBar, hpLabel, hpLess, type HpLabel } from "./rules/hp.ts";
import { compareEntries, orderRevealOf, rowCharacter } from "./rules/initiative.ts";
import { legOnGround, pathThisTurn, seenWhole, stopsForNonOwners, stopsForOwners } from "./rules/path.ts";
import { zoneFogged, zoneRanges } from "./rules/traps.ts";
import { clipFootprint, seesCreature, sightClipOf, sightRect } from "./rules/vision.ts";
import type { SegmentIndex } from "./rules/segments.ts";
import { deriveWalls, indexBuild, sceneWalls, type WallSet } from "./rules/walls.ts";
import { ownEntry } from "./records.ts";

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
     * Seen by all where it stands, by the walls the shared class holds
     * (withheldWhereItStands), on the scenes `seenAllMarked` names, which a
     * device reads it on, its absence there as not seen by all. A holder's
     * copy and the DM's hold walls the shared copy lacks, so neither can
     * work it out.
     */
    seenAll?: true;
    /**
     * Player projections only, derived and never stored: a member of kind
     * player owns the token or its character (docs/design/design-v1-dm-tools.md
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
 * A trap as a player gets it (docs/design/design-v1-traps.md 6.4): its name and
 * zone, and `disarmed` once the DM disarms it, with rev 0. Never whether it
 * is armed or sprung, its rig or its occurrences: the party saw it go off
 * or it did not.
 */
export type ProjectedTrap = Omit<Trap, "state" | "found"> & Partial<Pick<Trap, "state" | "found">> & { disarmed?: true };

/**
 * The room's clock as a viewer gets it (docs/design/design-v1-calendar.md 6.4):
 * the DM's whole, a player's and a table display's without the sharing
 * switch, which they get only while it is on, and with rev 0.
 */
export type ProjectedClock = Omit<RoomClock, "shown"> & { shown?: boolean };

export type ProjectedState = Omit<RoomState, "meta" | "tokens" | "characters" | "templates" | "encounter" | "traps" | "holders" | "exploredBy" | "clock"> & {
  meta: RoomMeta & {
    /** DM only, never stored. Retained HP undo records, including lines outside the live projection. */
    hpUndoLogIds?: string[];
  };
  tokens: Record<string, ProjectedToken>;
  traps: Record<string, ProjectedTrap>;
  characters: Record<string, ProjectedCharacter>;
  templates: Record<string, ProjectedTemplate>;
  encounter: ProjectedEncounter | null;
  /**
   * The viewer's sight on their scene when its vision is on, keyed
   * `"<sceneId>:<tx>,<ty>"` (docs/design/design-v1-maps-vision.md 4.3.4): the
   * party's, or on a per-player scene the viewer's own, the DM's the union
   * (docs/design/design-v1-per-player-vision.md 6.2). Derived on the server and
   * never stored, so only a projection holds it.
   */
  sight: SightMap;
  /**
   * Only on a per-player scene (docs/design/design-v1-per-player-vision.md 6.2):
   * the shared sight with vision on, the same for every viewer, the shared
   * fog as players get it, every player's, and every holder's layer
   * joined, the DM's.
   */
  sightAll?: SightMap;
  fogAll?: Record<string, FogTile>;
  exploredAny?: Record<string, FogTile>;
  /** The DM's scene's sight holder list, while it has one. No other projection holds any. */
  holders?: Record<string, SightHolders>;
  /** Never in a projection: a holder's layer reaches them only merged into their fog. Here so a projection still reads as a room. */
  exploredBy?: Record<string, ExploredTile>;
  /** The room's clock, while the viewer gets one (projectClockCtx). Absent otherwise. */
  clock?: ProjectedClock;
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
  return "ref" in token.actor ? ownEntry(state.characters, token.actor.ref) : undefined;
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
 * A party member (docs/design/design-v1-maps-vision.md 4.3.2): a token a player
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
 * What every viewer sees on a scene, "seen by all"
 * (docs/design/design-v1-per-player-vision.md decision 10): the party's sight on a
 * whole-party scene, and on a per-player scene the shared sight alone,
 * which every public rule reads. Computed on the server, and read from the
 * tiles the server sent where a projected state holds them, so a client
 * never computes sight (docs/design/design-v1-maps-vision.md 4.3.4). A projection
 * of a per-player scene holds the shared sight as `sightAll`, and one that
 * lacks a tile there sees nothing on it.
 */
export function partySightOf(state: RoomState, sceneId: string): PartySight {
  const tiles = sightOf(state);
  const perPlayer = perPlayerScene(ownEntry(state.scenes, sceneId));
  if (tiles !== undefined) return visionRules.sightFromTiles(perPlayer ? (viewMapsOf(state).sightAll ?? {}) : tiles, sceneId);
  return perPlayer ? visionRules.holderSight(state, sceneId, null) : visionRules.partySight(state, sceneId);
}

/**
 * The union of every source's sight on a scene, which the DM's tools read
 * (docs/design/design-v1-per-player-vision.md decision 14): the party's sight, on
 * a per-player scene too. A DM's device holds it as its `sight`.
 */
export function unionSightOf(state: RoomState, sceneId: string): PartySight {
  const tiles = sightOf(state);
  return tiles !== undefined ? visionRules.sightFromTiles(tiles, sceneId) : visionRules.partySight(state, sceneId);
}

/**
 * What one viewer sees on a scene: the party's sight on a whole-party
 * scene, and on a per-player scene a sight holder's own sight or, for any
 * other player and a table display, the shared sight. A DM sees the union.
 * A projected state holds its own viewer's (`sight`).
 */
function viewerSightOf(state: RoomState, viewer: Viewer, sceneId: string): PartySight {
  const tiles = sightOf(state);
  if (tiles !== undefined) return visionRules.sightFromTiles(tiles, sceneId);
  if (viewer.role === "dm" || !perPlayerScene(ownEntry(state.scenes, sceneId))) return visionRules.partySight(state, sceneId);
  return visionRules.holderSight(state, sceneId, holdsSight(state, sceneId, viewer.memberId) ? viewer.memberId : null);
}

/** The grid of a scene, squares for a scene the state lacks. */
export function gridOfScene(state: Pick<RoomState, "scenes">, sceneId: string): Grid {
  const scene = ownEntry(state.scenes, sceneId);
  return scene ? sceneGrid(scene) : SQUARES;
}

/** The grid of the scene a token stands on, squares for a scene the state lacks. */
export function gridOfToken(state: Pick<RoomState, "scenes">, token: Pick<Token, "sceneId">): Grid {
  return gridOfScene(state, token.sceneId);
}

/** Whether a scene has party vision on. */
function visionOn(scene: Pick<Scene, "vision"> | undefined): boolean {
  return scene?.vision?.on === true;
}

/** Whether a scene is a per-player one (docs/design/design-v1-per-player-vision.md 6.1), whatever its vision's `on` says. */
export function perPlayerScene(scene: Pick<Scene, "vision"> | undefined): boolean {
  return scene?.vision?.perPlayer === true;
}

/**
 * The sight holders of a per-player scene (docs/design/design-v1-per-player-vision.md
 * 6.1): the players whose entry on its list is on, in the list's order. A
 * member who is no player holds no sight. A projected state holds no list,
 * so on a device this is always empty.
 */
export function sightHolders(state: RoomState, sceneId: string): string[] {
  const entries = ownEntry(state.holders, sceneId)?.entries ?? [];
  return entries.flatMap((e) => (e.on && ownEntry(state.members, e.memberId)?.kind === "player" ? [e.memberId] : []));
}

function holdsSight(state: RoomState, sceneId: string, memberId: string): boolean {
  if (ownEntry(state.members, memberId)?.kind !== "player") return false;
  return ownEntry(state.holders, sceneId)?.entries.some((e) => e.on && e.memberId === memberId) === true;
}

/**
 * A fog reader with a per-call decode cache, because a projection checks
 * every token on the scene and most of them share a few tiles.
 *
 * It reads the fog players get: the DM's layer and the party's explored
 * layer merged, a sub-cell revealed where either reveals it
 * (docs/design/design-v1-maps-vision.md 4.3.3), on every scene, one whose vision
 * was turned off since it was explored included. With a `memberId` it
 * reads that player's own fog: on a per-player scene where they hold
 * sight, their own explored layer is merged in too
 * (docs/design/design-v1-per-player-vision.md 6.3). On a projected state it reads
 * the fog the projection holds, its viewer's own.
 *
 * It answers whether a whole cell is fogged, and through `sub` whether one
 * sub-cell is, by its scene-wide raster index, which a creature on hexes is
 * read by (docs/design/design-v1-hex-grids.md HX-D10).
 */
type FogReader = ((sceneId: string, cx: number, cy: number) => boolean) & { sub(sceneId: string, sx: number, sy: number): boolean };

function fogReader(state: RoomState, memberId: string | null = null): FogReader {
  const cache = new Map<string, Uint8Array | null>();
  const holder = new Map<string, boolean>();
  const own = (sceneId: string): string | null => {
    if (memberId === null) return null;
    let held = holder.get(sceneId);
    if (held === undefined) holder.set(sceneId, (held = perPlayerScene(ownEntry(state.scenes, sceneId)) && holdsSight(state, sceneId, memberId)));
    return held ? memberId : null;
  };
  return cellReader(cache, (sceneId, tx, ty) => {
    const by = own(sceneId);
    return mergedBits(state, tileKey(sceneId, tx, ty), by === null ? undefined : ownEntry(state.exploredBy, holderTileKey(sceneId, by, tx, ty)));
  });
}

/**
 * The fog every player shares (docs/design/design-v1-per-player-vision.md 6.3):
 * the DM's layer and the party's merged. A projection of a per-player
 * scene, a DM's too, holds it as `fogAll`, where a missing tile, or a
 * missing map, is fully fogged. Elsewhere it is the fog the state holds,
 * as `fogReader` reads it.
 */
function sharedFogReader(state: RoomState): FogReader {
  const plain = fogReader(state);
  if (sightOf(state) === undefined) return plain;
  const fogAll = viewMapsOf(state).fogAll ?? {};
  const cache = new Map<string, Uint8Array | null>();
  const shared = cellReader(cache, (sceneId, tx, ty) => {
    const tile = fogAll[tileKey(sceneId, tx, ty)];
    return tile ? bitsOf(tile) : null;
  });
  const which = (sceneId: string) => (perPlayerScene(ownEntry(state.scenes, sceneId)) ? shared : plain);
  return Object.assign((sceneId: string, cx: number, cy: number) => which(sceneId)(sceneId, cx, cy), { sub: (sceneId: string, sx: number, sy: number) => which(sceneId).sub(sceneId, sx, sy) });
}

/** A fog reader over the revealed bits `bitsAt` gives each tile, null where no layer holds it, decoded once a tile. */
function cellReader(cache: Map<string, Uint8Array | null>, bitsAt: (sceneId: string, tx: number, ty: number) => Uint8Array | null): FogReader {
  const tileBits = (sceneId: string, tx: number, ty: number): Uint8Array | null => {
    const key = tileKey(sceneId, tx, ty);
    let bits = cache.get(key);
    if (bits === undefined) {
      bits = bitsAt(sceneId, tx, ty);
      cache.set(key, bits);
    }
    return bits;
  };
  const cell = (sceneId: string, cx: number, cy: number): boolean => {
    const tx = Math.floor(cx / TILE_CELLS);
    const ty = Math.floor(cy / TILE_CELLS);
    const bits = tileBits(sceneId, tx, ty);
    if (!bits) return true;
    const bx = (cx - tx * TILE_CELLS) * FOG_SUBCELLS;
    const by = (cy - ty * TILE_CELLS) * FOG_SUBCELLS;
    for (let sy = 0; sy < FOG_SUBCELLS; sy++) {
      for (let sx = 0; sx < FOG_SUBCELLS; sx++) if (getBit(bits, bx + sx, by + sy)) return false;
    }
    return true;
  };
  const sub = (sceneId: string, sx: number, sy: number): boolean => {
    if (sx < 0 || sy < 0) return true;
    const side = TILE_CELLS * FOG_SUBCELLS;
    const tx = Math.floor(sx / side);
    const ty = Math.floor(sy / side);
    const bits = tileBits(sceneId, tx, ty);
    return !bits || !getBit(bits, sx - tx * side, sy - ty * side);
  };
  return Object.assign(cell, { sub });
}

/**
 * Whether players see any part of a cell's ground on a scene: not fully
 * under the fog they get (docs/design/design-v1-heights-readout.md 1), the DM's
 * layer and the party's explored one joined. It reads the DM's whole state
 * and a player's copy alike, since that copy holds the joined fog already,
 * so a route searched on either device keeps to the same ground
 * (docs/design/design-v1-movement.md 5.5). On a per-player scene a player's copy
 * holds their own fog, so it is the ground that player remembers
 * (docs/design/design-v1-per-player-vision.md 6.3).
 */
/** Ground by cells, and by fog sub-cells (`sub`), which a hex scene reads its hexes by (docs/design/design-v1-hex-grids.md HX-D10). */
export type GroundReader = ((x: number, y: number) => boolean) & { sub(sx: number, sy: number): boolean };

export function playersSeeGround(state: RoomState, sceneId: string): GroundReader {
  const fogged = fogReader(state);
  return Object.assign((x: number, y: number) => !fogged(sceneId, x, y), { sub: (sx: number, sy: number) => !fogged.sub(sceneId, sx, sy) });
}

/**
 * The ground any player remembers on a scene, which the DM's tools read
 * (docs/design/design-v1-per-player-vision.md decision 14): `playersSeeGround`,
 * and on a per-player scene each sight holder's own layer joined to it, as
 * `exploredAny` shows the DM. A DM's device reads that `exploredAny`, so it
 * predicts the trap hint from the ground the server reads (review PV1-O14).
 * A player's copy holds none, and reads its own ground.
 */
export function groundAnyPlayerSees(state: RoomState, sceneId: string): (x: number, y: number) => boolean {
  const shared = playersSeeGround(state, sceneId);
  if (!perPlayerScene(ownEntry(state.scenes, sceneId))) return shared;
  if (sightOf(state) !== undefined) {
    const joined = viewMapsOf(state).exploredAny;
    if (!joined) return shared;
    const any = cellReader(new Map(), (s, tx, ty) => {
      const tile = joined[tileKey(s, tx, ty)];
      return tile ? bitsOf(tile) : null;
    });
    return (x, y) => shared(x, y) || !any(sceneId, x, y);
  }
  const own = sightHolders(state, sceneId).map((id) => fogReader(state, id));
  return (x, y) => shared(x, y) || own.some((fogged) => !fogged(sceneId, x, y));
}

/**
 * The ground every player shares on a scene (docs/design/design-v1-per-player-vision.md
 * 6.3): `playersSeeGround` on a whole-party scene, and on a per-player one
 * the DM's and party's layers alone, on every device, for shared and kept
 * walking rulers and anything else every device must read alike.
 */
export function sharedGround(state: RoomState, sceneId: string): GroundReader {
  const fogged = sharedFogReader(state);
  return Object.assign((x: number, y: number) => !fogged(sceneId, x, y), { sub: (sx: number, sy: number) => !fogged.sub(sceneId, sx, sy) });
}

/**
 * The revealed bits of a fog tile as players get it, the layers joined, or
 * null where none holds the tile: the DM's and the party's, and a sight
 * holder's own (`own`) where one reads it.
 */
function mergedBits(state: RoomState, key: string, own?: FogTile): Uint8Array | null {
  const dm = ownEntry(state.fogTiles, key);
  const explored = ownEntry(state.exploredTiles, key);
  if (own) {
    const layers = [dm, explored, own].filter((t): t is FogTile => t !== undefined);
    return layers.length === 1 ? bitsOf(own) : mergedChain(layers).bits;
  }
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

/*
 * Tiles of any number of layers merged, kept per sequence of tile objects
 * (docs/design/design-v1-per-player-vision.md 6.9): a holder's fog tile, three
 * layers, and the DM's view of every holder's layer joined. An unchanged
 * sequence returns the same entry, and so the same projected tile.
 */
type Chain = { next: WeakMap<FogTile, Chain>; hit?: { bits: Uint8Array; text?: string; tile?: FogTile } };
const chains = new WeakMap<FogTile, Chain>();

function mergedChain(tiles: readonly FogTile[]): { bits: Uint8Array; text?: string; tile?: FogTile } {
  let node: Chain | undefined;
  for (const tile of tiles) {
    const level = node ? node.next : chains;
    let next = level.get(tile);
    if (!next) level.set(tile, (next = { next: new WeakMap() }));
    node = next;
  }
  if (!node) throw new Error("no tiles to merge");
  if (!node.hit) {
    let bits: Uint8Array | null = null;
    for (const tile of tiles) {
      const b = bitsOf(tile);
      if (!b) continue;
      if (!bits) bits = new Uint8Array(b);
      else for (let i = 0; i < bits.length; i++) bits[i] = bits[i]! | b[i]!;
    }
    node.hit = { bits: bits ?? new Uint8Array(0) };
  }
  return node.hit;
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
 * The presence map of one viewer's fog on a scene (anyFogTiles): on a
 * per-player scene a sight holder's holds their own layer's tiles too, so
 * a label on ground only their layer holds reaches them, and a player's
 * copy of the shared fog holds `fogAll`'s. Exported for its test.
 *
 * A projection asks it once per label, stamp, pin and found trap, so a
 * holder's map is kept per pair of maps it joins, which are replaced and
 * never changed, as `anyFogTiles` keeps its own (review PV1-O2).
 */
export function presenceOf(state: RoomState, memberId: string | null, sceneId: string): Record<string, FogTile> {
  const shared = anyFogTiles(state);
  if (memberId === null || !perPlayerScene(ownEntry(state.scenes, sceneId)) || !holdsSight(state, sceneId, memberId)) return shared;
  const own = holderLayer(state, sceneId, memberId);
  // An op still writing into a layer (writable.ts) would change it under the kept map.
  if (isWritable(state.fogTiles) || isWritable(state.exploredTiles ?? {}) || isWritable(state.exploredBy ?? {})) return joinedPresence(own, shared);
  let byShared = holderPresence.get(own);
  if (!byShared) holderPresence.set(own, (byShared = new WeakMap()));
  let hit = byShared.get(shared);
  if (!hit) byShared.set(shared, (hit = joinedPresence(own, shared)));
  return hit;
}

const holderPresence = new WeakMap<object, WeakMap<object, Record<string, FogTile>>>();

function joinedPresence(own: Record<string, FogTile>, shared: Record<string, FogTile>): Record<string, FogTile> {
  return Object.keys(own).length === 0 ? shared : { ...own, ...shared };
}

/**
 * One holder's explored layer on a scene, keyed as fog tiles are
 * (`"<sceneId>:<tx>,<ty>"`), kept per layer collection, which is replaced
 * and never changed, unless an op is still writing into it.
 */
const holderLayers = new WeakMap<object, Map<string, Record<string, ExploredTile>>>();

function holderLayer(state: RoomState, sceneId: string, memberId: string): Record<string, ExploredTile> {
  const all = state.exploredBy ?? {};
  const writing = isWritable(all);
  let byHolder = writing ? undefined : holderLayers.get(all);
  const at = partsKey([sceneId, memberId]);
  const hit = byHolder?.get(at);
  if (hit) return hit;
  const out: Record<string, ExploredTile> = {};
  for (const tile of Object.values(all)) if (tile.sceneId === sceneId && tile.memberId === memberId) out[tileKey(sceneId, tile.tx, tile.ty)] = tile;
  if (!writing) {
    if (!byHolder) holderLayers.set(all, (byHolder = new Map()));
    byHolder.set(at, out);
  }
  return out;
}

/**
 * One projection's inputs. `paused` is a player behind a blackout, whose
 * `sceneId` is null as well (viewerSceneId), so every scene's contents
 * project to nothing. The room-level parts of the table go with them: the
 * initiative tracker, which can name what is coming in a row of its own,
 * and handouts. `member` is a viewer on the roster, which a table display
 * is not. `sight`, `fogged` and `presence` are the viewer's own: on a
 * per-player scene a sight holder's sight and fog, the shared ones for
 * every other player and a display, and the union for a DM
 * (docs/design/design-v1-per-player-vision.md 6.2). Sight is worked out once per
 * projection. `held` is whether a creature's outline on hexes is clipped
 * by the walls the viewer holds (ClipBy): always for a projection, and for
 * the reducer's questions by the op's version.
 */
type Ctx = {
  state: RoomState;
  viewer: Viewer;
  sceneId: string | null;
  paused: boolean;
  member: boolean;
  fogged: FogReader;
  presence: (sceneId: string) => Record<string, FogTile>;
  sight: (sceneId: string) => PartySight;
  held: boolean;
  /** The viewer's ground per scene (rules/held.ts), worked out when first asked (groundCtx). */
  grounds: Map<string, Ground | null>;
};

function ctxOf(state: RoomState, viewer: Viewer, opts: ProjectOpts, held = true): Ctx {
  const own = viewer.role === "player" ? viewer.memberId : null;
  return {
    state,
    viewer,
    sceneId: viewerSceneId(state, viewer, opts),
    paused: paused(state, viewer),
    member: Object.hasOwn(state.members, viewer.memberId),
    fogged: fogReader(state, own),
    presence: (sceneId) => presenceOf(state, own, sceneId),
    sight: sightReader((sceneId) => viewerSightOf(state, viewer, sceneId)),
    held,
    grounds: new Map(),
  };
}

function sightReader(read: (sceneId: string) => PartySight): (sceneId: string) => PartySight {
  const cache = new Map<string, PartySight>();
  return (sceneId) => {
    let sight = cache.get(sceneId);
    if (!sight) cache.set(sceneId, (sight = read(sceneId)));
    return sight;
  };
}

/** The readers of what every viewer shares (decision 10): the shared fog and "seen by all"'s sight. */
type Shared = { fogged: FogReader; sight: (sceneId: string) => PartySight };

function sharedOf(state: RoomState): Shared {
  return { fogged: sharedFogReader(state), sight: sightReader((sceneId) => partySightOf(state, sceneId)) };
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
  return !withheldOnScreen(ctx, token, revealedSeen);
}

/** What a viewer's screen judges a creature by: their own sight and fog, and whose walls clip its outline (Ctx `held`). */
type Screen = Pick<Ctx, "state" | "viewer" | "fogged" | "sight" | "held">;

/**
 * Whether a viewer's screen withholds a token where it stands
 * (docs/design/design-v1-per-player-vision.md 6.2): by their own sight and fog,
 * a creature's outline on hexes clipped by the walls they hold. On a
 * per-player hex scene a sight holder's screen also shows every creature
 * the shared class's copy shows, which every other player's screen shows,
 * so each screen shows whatever is seen by all. A device clips by the
 * walls its copy holds and adds nothing.
 */
function withheldOnScreen(screen: Screen, token: Token, revealedSeen: boolean): boolean {
  const { state } = screen;
  if (!withheldFromPlayers(state, screen.fogged, screen.sight, token, revealedSeen, clipOfScreen(screen, token.sceneId))) return false;
  const scene = ownEntry(state.scenes, token.sceneId);
  if (!screen.held || screen.viewer.role !== "player" || sightOf(state) !== undefined || !perPlayerScene(scene) || !scene || !isHex(sceneGrid(scene))) return true;
  if (fogClassOf(state, scene.id, screen.viewer.memberId) === null) return true;
  const shared = sharedOf(state);
  return withheldFromPlayers(state, shared.fogged, shared.sight, token, revealedSeen, SHARED_COPY);
}

/** The walls that clip a creature's outline on a viewer's screen: their fog class's copy, and for a DM, who holds it, the build. */
function clipOfScreen(screen: Screen, sceneId: string): ClipBy {
  if (!screen.held || screen.viewer.role === "dm") return "build";
  return { view: fogClassOf(screen.state, sceneId, screen.viewer.memberId) };
}

/**
 * Whether where a token stands keeps it from players who do not own it. A
 * party member or a token the DM exempted never is (design 13.4). On a
 * scene with party vision, any other creature reaches players only while it
 * is in the party's sight (docs/design/design-v1-maps-vision.md 4.3.3): with fog
 * on, sight is always inside the revealed ground, since explore runs in the
 * same batch, so the fog rule is implied. Elsewhere it is withheld only when
 * every cell it stands on is fully fogged, the two fog layers merged. The
 * sight and fog are whichever viewer's the caller passes: one player's own
 * on a per-player scene, or what every viewer shares
 * (docs/design/design-v1-per-player-vision.md 6.2). On a hex scene both read the
 * fog sub-cells inside the creature's hexes (`footprintFogged`), those its
 * stored center sees past every sight wall when the scene has any
 * (docs/design/design-v1-hex-grids.md HX-D10, vision.ts clipFootprint).
 *
 * A creature revealed on its turn follows that rule too (rules/fog.ts
 * isAboveFog). `revealedSeen` brings back the rule that ops stored before
 * op version 4 marked by, where the automatic exemption counted as seen
 * anywhere. Only the seen marks of such an op, and the reducer's check of
 * a player's guarded Next or Previous (activeRowShownTo), pass it on replay.
 *
 * `clip` says whose walls clip a creature's outline on hexes (ClipBy).
 *
 * The checks run cheapest first, so sight is asked only about the DM's
 * other creatures.
 */
function withheldFromPlayers(state: RoomState, fogged: FogReader, sight: (sceneId: string) => PartySight, token: Token, revealedSeen: boolean, clip: ClipBy): boolean {
  const scene = ownEntry(state.scenes, token.sceneId);
  if (!scene) return false;
  if (!visionOn(scene) && !scene.fogEnabled) return false;
  if (isAboveFog(token, isPartyMember(state, token)) || (revealedSeen && token.fogExemptAuto)) return false;
  const grid = sceneGrid(scene);
  const walls = clipWalls(state, scene, grid, clip, token);
  if (visionOn(scene)) return !seesCreature(sight(scene.id), token, grid, walls);
  return footprintFogged(grid, fogged, token, walls);
}

/**
 * Whether every part of a creature's footprint is fogged by `fogged`: each
 * cell it stands on on squares, and on hexes each fog sub-cell inside its
 * hexes (docs/design/design-v1-hex-grids.md HX-D10), so a hex half in a revealed
 * cell shows it only where a revealed sub-cell lies inside the hex. Only
 * the sub-cells the wall clip keeps count, and a creature that keeps none
 * is under the fog.
 */
function footprintFogged(grid: Grid, fogged: FogReader, token: Token, clip: SegmentIndex | null): boolean {
  if (grid.shape === "hex") return clipFootprint(grid, token, clip).kept.every(([sx, sy]) => fogged.sub(token.sceneId, sx, sy));
  return occupiedCells(grid, token).every((cell) => fogged(token.sceneId, cell.x, cell.y));
}

/*
 * The sight walls that clip a creature's sub-cells on a hex scene
 * (HX-D10), per build and scene, null on squares and where there are none.
 * The walls are the state's own, so a DM's device clips by what the server
 * does. A build an op is still writing is never kept, as walls.ts keeps no
 * list of its chunks.
 */
const sightClips = new WeakMap<object, WeakMap<Scene, SegmentIndex | null>>();

function sightClip(state: Pick<RoomState, "buildChunks">, scene: Scene, grid: Grid): SegmentIndex | null {
  if (grid.shape !== "hex") return null;
  const chunks = state.buildChunks;
  let byScene = sightClips.get(chunks);
  const hit = byScene?.get(scene);
  if (hit !== undefined) return hit;
  const clip = sightClipOf(sceneWalls(scene, chunks));
  if (!isWritable(chunks)) {
    if (!byScene) sightClips.set(chunks, (byScene = new WeakMap()));
    byScene.set(scene, clip);
  }
  return clip;
}

/**
 * Whose walls clip a creature's outline on a hex scene (HX-D10). "build" is
 * the walls of the state's own chunks: what ops stored before op version 37
 * read (shared/migrate.ts clipsByHeldWalls), and what a DM holds. Otherwise
 * it is one fog class's copy of the walls (heldSightClip), the null class
 * being the one every player shares.
 */
type ClipBy = "build" | { view: FogClass };

const SHARED_COPY: ClipBy = { view: null };

/** The shared class's copy, or for an op stored before op version 37 the build's walls. */
function sharedClip(env: Pick<Env, "opVersion">): ClipBy {
  return clipsByHeldWalls(env.opVersion) ? SHARED_COPY : "build";
}

function clipWalls(state: RoomState, scene: Scene, grid: Grid, clip: ClipBy, token: Token): SegmentIndex | null {
  return clip === "build" ? sightClip(state, scene, grid) : heldSightClip(state, scene, grid, clip.view, token);
}

/**
 * The sight walls one fog class holds round a creature on a hex scene with
 * fog on (HX-D10): the free walls of the class's own chunks (playerChunk),
 * remembered versions included, at every position within a free wall's
 * reach (4 cells) of the creature's footprint box, and one ring past them.
 * They are the very walls the class's device holds, so a creature's
 * outline is clipped by the walls the viewer holds and its eye steps off
 * those alone. With fog off every viewer holds the build. A device's state
 * already is its copy, so there it is the walls the state holds.
 *
 * Three layers keep it. The player chunks keep their own memo. The index
 * is kept while the chunk objects it was built from are the same. And one
 * state's answers are kept by every collection those chunks read, the scene
 * object among them, whose fields they read (sceneFields), so one op's
 * many questions build each neighborhood once. That last layer keeps
 * nothing while an op is still writing any of them or the scenes, nor while
 * the room holds memory, since a remembered element reads which ground is
 * in sight now.
 */
const heldClips = new Map<string, { parts: readonly (PlayerChunk | null)[]; clip: SegmentIndex | null }>();
const HELD_CLIPS_KEPT = 4096;
let heldSerial = 0;
const byCollections = new WeakMap<object, WeakMap<object, unknown>>();
const NO_COLLECTION = {};

export function heldSightClip(state: RoomState, scene: Scene, grid: Grid, view: FogClass, token: Token): SegmentIndex | null {
  if (!isHex(grid) || !scene.fogEnabled || sightOf(state) !== undefined) return sightClip(state, scene, grid);
  const own = view !== null && holdsOwnSight(state, scene.id, view) ? view : null;
  const r = footprintRect(grid, token);
  const cx0 = Math.floor((r.x - 4) / CHUNK_CELLS);
  const cy0 = Math.floor((r.y - 4) / CHUNK_CELLS);
  const cx1 = Math.floor((r.x + r.w + 4) / CHUNK_CELLS);
  const cy1 = Math.floor((r.y + r.h + 4) / CHUNK_CELLS);
  const at = partsKey([own, cx0, cy0, cx1, cy1]);
  const kept = stateClips(state, scene);
  const known = kept?.get(at);
  if (known !== undefined) return known;
  const positions: { cx: number; cy: number }[] = [];
  for (let cy = cy0 - 1; cy <= cy1 + 1; cy++) for (let cx = cx0 - 1; cx <= cx1 + 1; cx++) positions.push({ cx, cy });
  const batch = playerChunkBatch(state, scene.id, positions, own);
  const parts = positions.map((p) => batch.get(chunkKey(scene.id, p.cx, p.cy)) ?? null);
  const key = partsKey([sceneFields(scene), at]);
  const index = heldClips.get(key);
  let clip: SegmentIndex | null;
  if (index && index.parts.length === parts.length && index.parts.every((c, i) => c === parts[i])) clip = index.clip;
  else {
    const chunks = parts.filter((c): c is PlayerChunk => c !== null);
    // Derived apart from sceneWalls, whose few sets a scene keeps are the build's and its device copies'.
    clip = chunks.length === 0 ? null : sightClipOf(deriveWalls(indexBuild(chunks), `held:${++heldSerial}`, { rule: autoWallsOf(scene), bounds: scene.bounds, grid }));
    if (heldClips.size >= HELD_CLIPS_KEPT) heldClips.clear();
    heldClips.set(key, { parts, clip });
  }
  kept?.set(at, clip);
  return clip;
}

/** The per-state layer of heldSightClip: null while it may keep nothing. */
function stateClips(state: RoomState, scene: Scene): Map<string, SegmentIndex | null> | null {
  const parts: object[] = [scene, state.buildChunks, state.fogTiles, state.exploredTiles ?? NO_COLLECTION, state.exploredBy ?? NO_COLLECTION, state.memory ?? NO_COLLECTION, state.memoryBy ?? NO_COLLECTION];
  if (isWritable(state.scenes) || parts.some((p) => isWritable(p)) || holdsMemory(state)) return null;
  let at: WeakMap<object, unknown> = byCollections;
  for (let i = 0; i < parts.length - 1; i++) {
    let next = at.get(parts[i]!) as WeakMap<object, unknown> | undefined;
    if (!next) at.set(parts[i]!, (next = new WeakMap()));
    at = next;
  }
  let out = at.get(parts[parts.length - 1]!) as Map<string, SegmentIndex | null> | undefined;
  if (!out) at.set(parts[parts.length - 1]!, (out = new Map()));
  return out;
}

/* Whether a memory collection holds any chunk, kept per collection, which is replaced and never changed. */
const memoryHeld = new WeakMap<object, boolean>();

function holdsMemory(state: RoomState): boolean {
  const any = (all: Readonly<Record<string, unknown>> | undefined) => {
    if (!all) return false;
    let held = memoryHeld.get(all);
    if (held === undefined) memoryHeld.set(all, (held = Object.keys(all).length > 0));
    return held;
  };
  return any(state.memory) || any(state.memoryBy);
}

/**
 * Whether every hex of a creature holds a sub-cell the wall clip keeps and
 * `open` passes: on a per-player scene, a spot on shared ground. A hex
 * the clip empties lies wholly behind a wall and counts as under the fog.
 */
function everyHexOpen(grid: HexGrid, token: Token, clip: SegmentIndex | null, open: (sx: number, sy: number) => boolean): boolean {
  const { subs, keep } = clipFootprint(grid, token, clip);
  const hexes = new Map<string, boolean>();
  for (let i = 0; i < subs.length; i++) {
    const [sx, sy] = subs[i]!;
    const key = hexKey(hexAt(grid, { x: (sx + 0.5) / FOG_SUBCELLS, y: (sy + 0.5) / FOG_SUBCELLS }));
    if (hexes.get(key) !== true) hexes.set(key, (keep === null || keep[i] === 1) && open(sx, sy));
  }
  for (const ok of hexes.values()) if (!ok) return false;
  return true;
}

/**
 * Whether where a token stands keeps it from players who do not own it, by
 * the rule projections use: out of the party's sight on a vision scene,
 * fully under the merged fog elsewhere, unless it is a party member or
 * exempt. Its visibility and a blackout are the caller's to check. On a
 * per-player scene it is the rule of what every viewer shares, the shared
 * sight and fog (docs/design/design-v1-per-player-vision.md decision 10), and
 * on hexes the walls the shared class holds.
 */
export function withheldWhereItStands(state: RoomState, token: Token): boolean {
  const shared = sharedOf(state);
  return withheldFromPlayers(state, shared.fogged, shared.sight, token, false, SHARED_COPY);
}

/**
 * Whether where a token stands keeps it from one viewer, by their own
 * sight and fog (docs/design/design-v1-per-player-vision.md 6.2): the rule their
 * projection judges creatures by (withheldOnScreen), which on a device is
 * the copy's own, and for a DM the union. Its visibility and a blackout are
 * the caller's. The ephemeral channel asks it of a drag preview's spot for
 * each receiver, with the footprint its own preview rule decides
 * (docs/design/design-v1-maps-vision.md 4.1 and 4.3.5, and 7.5 of the per-player
 * design).
 */
export function withheldFromViewer(state: RoomState, viewer: Viewer, token: Token): boolean {
  return withheldOnScreen(screenOf(state, viewer, true), token, false);
}

function screenOf(state: RoomState, viewer: Viewer, held: boolean): Screen {
  const own = viewer.role === "player" ? viewer.memberId : null;
  return { state, viewer, fogged: fogReader(state, own), sight: sightReader((sceneId) => viewerSightOf(state, viewer, sceneId)), held };
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
 * on log events about the token (`seen` in the model). On a per-player scene
 * it is "seen by all", the shared sight and fog (docs/design/design-v1-per-player-vision.md
 * decision 10), and `seenMark` records which sight holders saw it besides.
 *
 * The marks are stored, so each of these questions takes the op's envelope:
 * an op stored before op version 4 marks by the rule it was applied under
 * (shared/migrate.ts revealSeenAnywhere), and one stored before op version
 * 37 clips a creature's outline on hexes by the build's walls
 * (clipsByHeldWalls), so each replays to the same state.
 */
export function seenByNonOwners(state: RoomState, token: Token, env: Pick<Env, "opVersion">): boolean {
  if (behindBlackout(state) || token.sceneId !== state.meta.playerSceneId || token.visibility === "dm") return false;
  const shared = sharedOf(state);
  return !withheldFromPlayers(state, shared.fogged, shared.sight, token, revealSeenAnywhere(env.opVersion), sharedClip(env));
}

/**
 * Whether players who do not own the token could see it where it stands,
 * whichever scene they are on. The reducer records it on a turn's starting
 * spot (`TurnStart.seen`) and on the stops of a path, which players get
 * only while they see the token on their own scene anyway. On a per-player
 * scene, "seen by all" as `seenByNonOwners` reads it.
 */
export function inSightOfNonOwners(state: RoomState, token: Token, env: Pick<Env, "opVersion">): boolean {
  if (behindBlackout(state) || token.visibility === "dm") return false;
  const shared = sharedOf(state);
  return !withheldFromPlayers(state, shared.fogged, shared.sight, token, revealSeenAnywhere(env.opVersion), sharedClip(env));
}

/**
 * Whether players who do not own the token would see it at every one of
 * these spots, each asked of the token placed there against the state as it
 * is (docs/design/design-v1-movement.md 7.2): the stops' rule, `inSightOfNonOwners`,
 * with the fog and sight read once for the whole walk. On a per-player
 * scene every spot must also lie on the ground every player shares
 * (docs/design/design-v1-per-player-vision.md 6.5), so a route's corners never
 * draw ground only some players remember for anyone else.
 */
export function seenAtEvery(state: RoomState, token: Token, spots: readonly { x: number; y: number; elevation: number; squeezed?: boolean }[], env: Pick<Env, "opVersion">): boolean {
  if (behindBlackout(state) || token.visibility === "dm") return false;
  const shared = sharedOf(state);
  const revealed = revealSeenAnywhere(env.opVersion);
  const { squeeze: _squeeze, ...rest } = token;
  const placed = (p: (typeof spots)[number]): Token => ({ ...rest, x: p.x, y: p.y, elevation: p.elevation, ...(p.squeezed ? { squeeze: true as const } : {}) });
  const clip = sharedClip(env);
  if (!spots.every((p) => !withheldFromPlayers(state, shared.fogged, shared.sight, placed(p), revealed, clip))) return false;
  const scene = ownEntry(state.scenes, token.sceneId);
  if (!perPlayerScene(scene) || !scene?.fogEnabled) return true;
  // Every cell of the footprint on shared ground, not wholly under the shared fog: on hexes every hex of it, by the sub-cells the wall clip keeps (HX-D10).
  const grid = sceneGrid(scene);
  const open = (t: Token) =>
    grid.shape === "hex"
      ? everyHexOpen(grid, t, clipWalls(state, scene, grid, clip, t), (sx, sy) => !shared.fogged.sub(token.sceneId, sx, sy))
      : occupiedCells(grid, t).every((cell) => !shared.fogged(token.sceneId, cell.x, cell.y));
  return spots.every((p) => open(placed(p)));
}

/** The same question for an initiative row, by the encounter projection's rule: not hidden, in the order players see, and its creature in sight. */
export function rowSeenByNonOwners(state: RoomState, entry: InitEntry, env: Pick<Env, "opVersion">): boolean {
  if (entry.hidden || behindBlackout(state) || !orderShown(state, entry)) return false;
  if (entry.tokenId !== undefined) {
    const token = ownEntry(state.tokens, entry.tokenId);
    if (!token || !seenByNonOwners(state, token, env)) return false;
  }
  return entry.characterId === undefined || ownEntry(state.characters, entry.characterId) !== undefined;
}

/**
 * What a mark records of who saw a token (docs/design/design-v1-per-player-vision.md
 * 6.5): `seen` when every viewer did, by `seenByNonOwners` (scope "here",
 * for log lines) or `inSightOfNonOwners` ("anywhere", for stops and a
 * turn's start). On a per-player scene otherwise, `seenBy`: the sight
 * holders who do not own the token and whose projection shows it, sorted,
 * present even when empty. Behind a blackout, for a token the DM hid, and
 * under "here" off the player scene there is no mark, and a list under
 * "anywhere" off the player scene is empty, since a player's projection
 * covers only the player scene. A device's marks are predictions and hold
 * no list: only the server writes lists.
 */
export type SeenMark = { seen?: true; seenBy?: string[] };

export function seenMark(state: RoomState, token: Token, env: Pick<Env, "opVersion">, scope: "here" | "anywhere"): SeenMark {
  if (behindBlackout(state) || token.visibility === "dm") return {};
  const here = token.sceneId === state.meta.playerSceneId;
  if (scope === "here" && !here) return {};
  const revealed = revealSeenAnywhere(env.opVersion);
  const shared = sharedOf(state);
  if (!withheldFromPlayers(state, shared.fogged, shared.sight, token, revealed, sharedClip(env))) return { seen: true };
  if (!perPlayerScene(ownEntry(state.scenes, token.sceneId)) || sightOf(state) !== undefined) return {};
  if (!here) return { seenBy: [] };
  const held = clipsByHeldWalls(env.opVersion);
  return {
    seenBy: holdersWho(state, token.sceneId, (id) => {
      const viewer: Viewer = { memberId: id, role: "player" };
      return !ownsToken(state, viewer, token) && !withheldOnScreen(screenOf(state, viewer, held), token, false);
    }),
  };
}

/** The sight holders of a scene that pass `test`, sorted. */
function holdersWho(state: RoomState, sceneId: string, test: (memberId: string) => boolean): string[] {
  return sightHolders(state, sceneId).filter(test).sort();
}

/**
 * A turn line's mark for its row (docs/design/design-v1-per-player-vision.md 6.5):
 * `seen` when every viewer's tracker shows it (rowSeenByNonOwners), and on
 * a per-player player scene otherwise the sight holders who do not own the
 * row's creature and whose tracker shows it.
 */
export function rowSeenMark(state: RoomState, entry: InitEntry, env: Pick<Env, "opVersion">): SeenMark {
  if (rowSeenByNonOwners(state, entry, env)) return { seen: true };
  const token = entry.tokenId !== undefined ? ownEntry(state.tokens, entry.tokenId) : undefined;
  const sceneId = state.meta.playerSceneId;
  if (entry.hidden || behindBlackout(state) || !token || sceneId === null || token.sceneId !== sceneId || !perPlayerScene(ownEntry(state.scenes, sceneId)) || sightOf(state) !== undefined) return {};
  const owners = new Set([...ownersOf(state, token), ...(entry.characterId !== undefined ? (ownEntry(state.characters, entry.characterId)?.ownerIds ?? []) : [])]);
  const revealed = revealSeenAnywhere(env.opVersion);
  const held = clipsByHeldWalls(env.opVersion);
  return { seenBy: holdersWho(state, sceneId, (id) => !owners.has(id) && entryShown(ctxOf(state, { memberId: id, role: "player" }, { sceneId }, held), entry, revealed)) };
}

/**
 * An area's reminder's mark on a per-player scene (docs/design/design-v1-per-player-vision.md
 * 6.5), judged in the room as it stood then (`at`): the players who saw
 * both the creature and the area, its owners among them. `seen` when every
 * viewer did, else `seenBy`, perhaps empty. `hidden` only for an area the
 * DM hid or one on a token no player sees, a line only the DM reads, which
 * so holds no list. Null on a whole-party scene, whose reminders keep their
 * rule.
 *
 * Every player on the roster may be a witness, as `lineReader` reads them:
 * one who holds no sight of their own still sees by the shared sight, and
 * sees an area of their own whatever the room's setting for others' areas
 * (review PV1-ASTRA-3).
 */
export function areaSeenMark(at: RoomState, template: AreaTemplate, token: Token, env: Pick<Env, "opVersion">): (SeenMark & { hidden?: true }) | null {
  const scene = ownEntry(at.scenes, token.sceneId);
  if (!perPlayerScene(scene) || sightOf(at) !== undefined) return null;
  const attached = template.attachedTo !== undefined ? ownEntry(at.tokens, template.attachedTo) : undefined;
  const seesAttached = attached === undefined || seenByNonOwners(at, attached, env) || (seenMark(at, attached, env, "here").seenBy ?? []).length > 0;
  if (template.visibility === "dm" || !seesAttached) return { hidden: true };
  if (behindBlackout(at) || token.sceneId !== at.meta.playerSceneId) return {};
  const witnessed = (ctx: Ctx) => tokenVisibleTo(ctx, token, revealSeenAnywhere(env.opVersion)) && projectTemplateCtx(ctx, template) !== null;
  const sceneId = token.sceneId;
  const held = clipsByHeldWalls(env.opVersion);
  if (witnessed(ctxOf(at, ANY_PLAYER, { sceneId }, held))) return { seen: true };
  const players = Object.values(at.members).flatMap((m) => (m.kind === "player" ? [m.id] : []));
  return { seenBy: players.filter((id) => witnessed(ctxOf(at, { memberId: id, role: "player" }, { sceneId }, held))).sort() };
}

function tokenVisibleById(ctx: Ctx, tokenId: string, revealedSeen = false): boolean {
  const token = ownEntry(ctx.state.tokens, tokenId);
  return token !== undefined && tokenVisibleTo(ctx, token, revealedSeen);
}

/**
 * How much of a creature's HP the viewer may see. A creature with no HP to
 * show (hpLess: an effect companion, or a maximum of 0) shows other players
 * none, so 0 of 0 never reaches them as Bloodied. A creature companion a
 * player plays is the party's, so its HP follows the party's rule rather
 * than its own `hpVisibility` (docs/design/design-v1-combat-flow.md 3.6.5).
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
 * An effect companion (docs/design/design-v1-combat-flow.md 3.6.6), which reaches
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
 * (docs/design/design-v1-roll-options.md 6.1): which save ends it and whether it is
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
  return ids?.some((id) => ownEntry(state.members, id)?.kind === "player") ?? false;
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
 * The derived `party` flag (docs/design/design-v1-dm-tools.md 3.1): a member of
 * kind player owns the token or its character. Not `playerOwned`, which
 * counts a DM owner too, and not `partyVision`, which lends sight without a
 * player. Who plays which character is no secret at the table.
 */
export function playersToken(state: Pick<RoomState, "members" | "characters">, token: Pick<Token, "ownerIds" | "actor">): boolean {
  if (anyPlayer(state, token.ownerIds)) return true;
  const character = "ref" in token.actor ? ownEntry(state.characters, token.actor.ref) : undefined;
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
 * Owners get the whole actor except the DM's notes, the room monster it
 * was placed from, whose block may be text from a book the group owns
 * (docs/design/design-v1-dm-tools.md 3.6), and whether the DM placed it in its
 * lair, which its row shows only once it joins a fight. A condition hidden
 * from players stays hidden from its owner too.
 */
function projectActorOwner(actor: Actor): ProjectedActor {
  const { dmNotes: _dmNotes, monsterId: _monsterId, inLair: _inLair, ...rest } = actor;
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
  const marked = seenAllMarked(ownEntry(ctx.state.scenes, token.sceneId), ctx.viewer.role) && seenByAllCtx(ctx, token);
  if (ctx.viewer.role === "dm") return marked ? markedCopy(token) : token;
  const out = projectPlayerToken(ctx, token);
  if (marked) out.seenAll = true;
  return out;
}

/**
 * Where a device reads seen by all from the projection's `seenAll` mark
 * rather than working it out: a player's copy of a per-player hex scene,
 * whose holders hold walls the shared class lacks, and the DM's copy of a
 * hex scene with fog on or per player, which holds the build and no memory.
 */
export function seenAllMarked(scene: Pick<Scene, "vision" | "fogEnabled" | "gridShape"> | undefined, role: Viewer["role"]): boolean {
  if (!scene || !isHex(sceneGrid(scene))) return false;
  return perPlayerScene(scene) || (role === "dm" && scene.fogEnabled);
}

/** Seen by all where it stands: by the shared class's copy of the walls, or by the build's for an op stored before op version 37 (Ctx `held`). */
function seenByAllCtx(ctx: Ctx, token: Token): boolean {
  if (ctx.held) return !withheldWhereItStands(ctx.state, token);
  const shared = sharedOf(ctx.state);
  return !withheldFromPlayers(ctx.state, shared.fogged, shared.sight, token, false, "build");
}

/* A DM's token with the mark, kept per token object, which is replaced and never changed, so the fan-out hashes it once. */
const markedCopies = new WeakMap<Token, ProjectedToken>();

function markedCopy(token: Token): ProjectedToken {
  let out = markedCopies.get(token);
  if (!out) {
    out = { ...token, seenAll: true };
    if (!isWritable(token)) markedCopies.set(token, out);
  }
  return out;
}

function projectPlayerToken(ctx: Ctx, token: Token): ProjectedToken {
  const aboveFog = isAboveFog(token, isPartyMember(ctx.state, token));
  if (ownsToken(ctx.state, ctx.viewer, token)) {
    const actor = "inline" in token.actor ? { inline: projectActorOwner(token.actor.inline) } : token.actor;
    // Owners get their token's light to change it. Party membership is the DM's mark (docs/design/design-v1-maps-vision.md 4.3.5).
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
  // reach them: they see only its effect (docs/design/design-v1-maps-vision.md 4.3.5).
  if (token.squeeze) out.squeeze = true;
  // Where in its box a token they see is drawn says nothing the token itself does not (docs/design/design-v1-snap-off.md 5.6).
  if (token.nudge) out.nudge = token.nudge;
  if (playersToken(ctx.state, token)) {
    out.party = true;
    // A party member's companion is no secret at the table. One of a character no player plays reaches players as a
    // plain token, so no link between a DM creature and a character leaks (docs/design/design-v1-combat-flow.md 3.6.5).
    if (token.companion) out.companion = token.companion;
  }
  const link = linkShown(ctx, token);
  if (link) out.attached = link;
  const path = projectPathCtx(ctx, token, false);
  if (path) out.path = path;
  return out;
}

/**
 * A token's link as a player gets it (docs/design/design-v1-attach.md 8.5): only
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
  const stops = owner ? ownersStopsCtx(ctx, token, path.stops) : stopsForNonOwners(path.stops, ctx.viewer.memberId);
  return stops.length > 0 ? { turn: path.turn, stops } : null;
}

/**
 * An owner's stops (rules/path.ts stopsForOwners). On a per-player scene
 * with fog, a leg not every player saw whole keeps its corners for an owner
 * only where every spot of it lies on ground that owner's own fog reveals
 * now (docs/design/design-v1-per-player-vision.md 6.5), so a co-owner's private
 * route never draws ground this one never saw. On a scene that keeps
 * memory that ground is the owner's live ground alone, their sight and the
 * DM's reveals (docs/design/design-v1-map-discovery.md decision 12): corners on
 * ground they only explored would draw the build as the mover's memory or
 * private sight held it, which may differ from theirs. A leg every player
 * saw whole keeps them, so a later hide never takes corners every device
 * already counts from (publicCounters). What each leg took stays.
 */
function ownersStopsCtx(ctx: Ctx, token: Token, stops: readonly PathStop[]): PathStop[] {
  const out = stopsForOwners(stops);
  const scene = ownEntry(ctx.state.scenes, token.sceneId);
  if (!scene?.fogEnabled) return out;
  const live = scene.vision?.on === true ? groundCtx(ctx, token.sceneId) : null;
  if (!live && !perPlayerScene(scene)) return out;
  const grid = gridOfToken(ctx.state, token);
  const ground = live
    ? { cell: live.live, sub: live.subLive }
    : { cell: (x: number, y: number) => !ctx.fogged(token.sceneId, x, y), sub: (sx: number, sy: number) => !ctx.fogged.sub(token.sceneId, sx, sy) };
  for (const [i, stop] of out.entries()) {
    if (i === 0 || stop.via === undefined || seenWhole(stops, i, true)) continue;
    if (!legOnGround(grid, token, stops[i - 1]!, stops[i]!, ground)) delete stop.via;
  }
  return out;
}

export function projectCharacter(state: RoomState, viewer: Viewer, character: Character): ProjectedCharacter {
  if (viewer.role === "dm") return character;
  // Rev 0 for players, as on their tokens (projectTokenCtx). The last Long Rest's stamp is the DM's, the owners' copy
  // included, so no clock change ever re-projects a character (docs/design/design-v1-calendar.md 6.4).
  if (ownsCharacter(viewer, character)) {
    const { longRest: _longRest, ...owned } = character;
    return { ...owned, rev: 0, actor: projectActorOwner(character.actor) };
  }
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
    const owner = ownEntry(ctx.state.members, template.ownerId);
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
    const token = ownEntry(ctx.state.tokens, id);
    if (!token || !tokenVisibleTo(ctx, token)) return null;
    const r = footprintRect(gridOfToken(ctx.state, token), token);
    points[2 * i] = r.x + r.w / 2;
    points[2 * i + 1] = r.y + r.h / 2;
  }
  return { ...drawing, points };
}

/**
 * A chunk position of the viewer's scene. The DM gets the stored chunk. A
 * player on a scene with fog on gets what their fog class holds there, a
 * stub where no chunk is stored (playerChunk), and on a scene with fog off
 * the whole build as before (projectChunkForPlayer).
 */
function projectChunkAtCtx(ctx: Ctx, sceneId: string, cx: number, cy: number): BuildChunk | null {
  if (sceneId !== ctx.sceneId) return null;
  const chunk = ownEntry(ctx.state.buildChunks, chunkKey(sceneId, cx, cy));
  if (ctx.viewer.role === "dm") return chunk ?? null;
  const scene = ownEntry(ctx.state.scenes, sceneId);
  if (scene?.fogEnabled) return playerChunk(ctx.state, { sceneId, cx, cy }, fogClassOf(ctx.state, sceneId, ctx.viewer.memberId));
  return chunk ? projectChunkForPlayer(ctx.state.buildChunks, chunk, scene?.autoWalls) : null;
}

/** The viewer's scene's chunks, by chunk key, as a snapshot holds them (projectChunkAtCtx). */
function projectChunksCtx(ctx: Ctx): Record<string, BuildChunk> {
  const sceneId = ctx.sceneId;
  const scene = sceneId === null ? undefined : ownEntry(ctx.state.scenes, sceneId);
  if (sceneId === null || !scene) return {};
  if (ctx.viewer.role !== "dm" && scene.fogEnabled) return heldChunks(ctx.state, sceneId, fogClassOf(ctx.state, sceneId, ctx.viewer.memberId));
  return projectMap(ctx.state.buildChunks, (c) => projectChunkAtCtx(ctx, c.sceneId, c.cx, c.cy));
}

/** A door as players see it, when it is not a hidden secret one: a locked door arrives closed, and without its cover. */
function unlocked(door: Extract<WallFeature, { kind: "door" }>): WallFeature {
  const { cover, ...shown } = door;
  if (door.state === "locked") return { ...shown, state: "closed" };
  return cover === undefined ? door : shown;
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
 *   never see a gap where a hidden door is (docs/design/design-v1-maps-vision.md
 *   2.1). `autoWalls` is the scene's rule, absent read as "all". One whose
 *   cover is "drawn" is a plain wall whatever the cells, as the drawn wall
 *   it looks like is: a device derives automatic walls from the cells it
 *   gets here, and a sent wall wins over a derived one.
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

/**
 * A chunk's fields for players on a scene with fog off (projectChunkForPlayer),
 * held to every key of BuildChunk as SCENE_FOR_PLAYERS is. With fog on a
 * player's chunk is built from held ground instead, with fields of its own
 * (playerChunk, PlayerChunkFields).
 */
export const CHUNK_FOR_PLAYERS = {
  sceneId: "copied",
  cx: "copied",
  cy: "copied",
  rev: "zeroed",
  cells: "copied",
  edges: "changed: a hidden secret door reads as a wall or goes, a lock reads closed, and a door's cover goes",
  walls: "changed: a hidden secret free door reads as a wall, a lock reads closed, sorted by their ends",
  // Heights and stair marks are map data, like the floor, and not secret (docs/design/design-v1-maps-vision.md 4.2).
  heights: "copied",
  up: "copied",
  // Difficult ground marks are map data too: players see them where they see the map (docs/design/design-v1-movement.md 3.4).
  rough: "copied",
  // The shape its cell keys were written for, as public as the scene's shape (docs/design/design-v1-hex-grids.md HX-D14).
  grid: "copied",
} as const satisfies Record<keyof BuildChunk, PlayerField>;

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
    } else if (edge.cover === "drawn") {
      edges[key] = { kind: "wall" };
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
  if (chunk.heights !== undefined) out.heights = chunk.heights;
  if (chunk.up !== undefined) out.up = chunk.up;
  if (chunk.rough !== undefined) out.rough = chunk.rough;
  if (chunk.grid !== undefined) out.grid = chunk.grid;
  return out;
}

// ---------------------------------------------------------------------------
// The map as players discover it (docs/design/design-v1-map-discovery.md 5.1 and 5.2)

/**
 * A fog class (5.6): a sight holder's member id on a per-player scene, or
 * null for every other player and table display. Every player of one class
 * holds the same map, so a chunk is projected once per class.
 */
export type FogClass = string | null;

/** How far a scene's cell data and free walls reach, in cells: its bounds, and on hexes its hex columns and rows. */
function cellReach(scene: Pick<Scene, "bounds" | "gridShape">): { w: number; h: number } {
  const grid = sceneGrid(scene);
  if (!isHex(grid)) return scene.bounds;
  const span = sceneHexSpan(grid, scene.bounds);
  return { w: Math.max(scene.bounds.w, span.cols), h: Math.max(scene.bounds.h, span.rows) };
}

/**
 * The chunk positions of a scene with fog on: every position its cells and
 * free walls can be filed under, one past its east and south sides
 * included (decision 14), in row order.
 */
export function chunkPositions(scene: Pick<Scene, "bounds" | "gridShape">): { cx: number; cy: number }[] {
  const { w, h } = cellReach(scene);
  const out: { cx: number; cy: number }[] = [];
  for (let cy = 0; cy <= Math.floor(h / CHUNK_CELLS); cy++) for (let cx = 0; cx <= Math.floor(w / CHUNK_CELLS); cx++) out.push({ cx, cy });
  return out;
}

/** Whether a chunk position is one of a scene's (chunkPositions). */
export function inPositions(scene: Pick<Scene, "bounds" | "gridShape">, cx: number, cy: number): boolean {
  const { w, h } = cellReach(scene);
  return Number.isInteger(cx) && Number.isInteger(cy) && cx >= 0 && cy >= 0 && cx <= Math.floor(w / CHUNK_CELLS) && cy <= Math.floor(h / CHUNK_CELLS);
}

/**
 * The fog tiles a position's chunk reads (5.6): the 3 x 3 tiles around it,
 * which its cells, edges and the pieces filed there lie on, since fog tiles
 * and chunks share their grid, and on hexes also every tile under the
 * world box its hex keys cover, a tile past it each way (HX-D22).
 */
export function positionTiles(scene: Pick<Scene, "gridShape">, cx: number, cy: number): [number, number][] {
  const out: [number, number][] = [];
  const grid = sceneGrid(scene);
  // Every key of every position asks this: on squares the 3 x 3 alone, which never repeats a tile.
  if (!isHex(grid)) {
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) if (cx + dx >= 0 && cy + dy >= 0) out.push([cx + dx, cy + dy]);
    return out;
  }
  const seen = new Set<string>();
  const add = (tx: number, ty: number) => {
    const at = `${tx},${ty}`;
    if (tx < 0 || ty < 0 || seen.has(at)) return;
    seen.add(at);
    out.push([tx, ty]);
  };
  for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) add(cx + dx, cy + dy);
  {
    const corners = [
      hexCenter(grid, { col: cx * CHUNK_CELLS, row: cy * CHUNK_CELLS }),
      hexCenter(grid, { col: cx * CHUNK_CELLS + CHUNK_CELLS - 1, row: cy * CHUNK_CELLS + CHUNK_CELLS - 1 }),
    ];
    const x0 = Math.floor((Math.min(corners[0]!.x, corners[1]!.x) - 1) / CHUNK_CELLS) - 1;
    const x1 = Math.floor((Math.max(corners[0]!.x, corners[1]!.x) + 1) / CHUNK_CELLS) + 1;
    const y0 = Math.floor((Math.min(corners[0]!.y, corners[1]!.y) - 1) / CHUNK_CELLS) - 1;
    const y1 = Math.floor((Math.max(corners[0]!.y, corners[1]!.y) + 1) / CHUNK_CELLS) + 1;
    for (let ty = y0; ty <= y1; ty++) for (let tx = x0; tx <= x1; tx++) add(tx, ty);
  }
  return out;
}

/** The positions of a scene whose chunk reads a fog tile (positionTiles). */
function positionsReading(scene: Pick<Scene, "bounds" | "gridShape">, tx: number, ty: number): { cx: number; cy: number }[] {
  if (!isHex(sceneGrid(scene))) {
    const out: { cx: number; cy: number }[] = [];
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) if (inPositions(scene, tx + dx, ty + dy)) out.push({ cx: tx + dx, cy: ty + dy });
    return out;
  }
  return chunkPositions(scene).filter(({ cx, cy }) => positionTiles(scene, cx, cy).some(([x, y]) => x === tx && y === ty));
}

/** What an edge is to players (5.2): a drawn wall, door or window as they see it, `"auto"` for an automatic wall, or null for nothing. */
export type ShownEdge = WallFeature | "auto" | null;

/**
 * An edge of the build as players see it (5.2): a drawn feature with a
 * hidden secret door as the wall players take it for and a lock as closed,
 * an automatic wall by the scene's rule on the real cells either side, a
 * hidden secret door where the rule walls the edge counting as that
 * automatic wall (MD-O-1), and a drawn "none" as nothing. The map step on
 * the server compares edges by this too, so memory and the projection read
 * one value.
 *
 * A hidden door's cover decides first (docs/design/design-v1-maps-vision.md
 * 2.1): "drawn" is a drawn wall under every rule, and "auto" the automatic
 * wall under any rule but "off", where no automatic wall stands and one
 * would be the tell. A door with no cover, from before covers, keeps the
 * look by its cells. The look reads only the door, its two real cells and
 * the rule, never what a fog class holds, so every class is sent one value
 * and the caches keyed by those stand.
 */
export function shownEdge(chunks: Readonly<Record<string, BuildChunk>>, sceneId: string, rule: AutoWalls, key: string): ShownEdge {
  const [xs, ys, side] = key.split(",");
  const x = Number(xs);
  const y = Number(ys);
  const chunk = chunks[chunkKey(sceneId, Math.floor(x / CHUNK_CELLS), Math.floor(y / CHUNK_CELLS))];
  const drawn = chunk?.edges[key];
  const automatic = () => autoWallBetween(rule, paintedAt(chunks, sceneId, x, y), side === "n" ? paintedAt(chunks, sceneId, x, y - 1) : paintedAt(chunks, sceneId, x - 1, y));
  if (drawn === undefined) return automatic() ? "auto" : null;
  if (drawn.kind === "none") return null;
  if (drawn.kind !== "door") return drawn;
  if (!hiddenDoor(drawn)) return unlocked(drawn);
  if (drawn.cover === "drawn") return { kind: "wall" };
  if (drawn.cover === "auto" && rule !== "off") return "auto";
  return automatic() ? "auto" : { kind: "wall" };
}

/** A free wall as players see it (5.2): a hidden secret door as a wall, a lock as closed. */
export function shownFreeWall(wall: FreeWall): FreeWall {
  if (wall.f.kind !== "door") return wall;
  return { ...wall, f: hiddenDoor(wall.f) ? { kind: "wall" } : unlocked(wall.f) };
}

/** Whether players see a free wall as a door, which reaches them whole (decision 2). */
function visibleDoor(wall: FreeWall): boolean {
  return wall.f.kind === "door" && !hiddenDoor(wall.f);
}

/**
 * The stair direction players get for a cell (5.2): `n`, `e`, `s` or `w`
 * for a stair the scene's stair map points, "." for any other cell. The
 * map reads the real cells around each stair, so a player's device takes
 * it from the server rather than from what it holds.
 */
export function shownUpDir(walls: WallSet, x: number, y: number): StairDir {
  return walls.stairAt(x, y) ?? ".";
}

/** One layer's memory chunk at a position, the party's for a null layer. */
function memoryAt(state: RoomState, sceneId: string, layer: FogClass, cx: number, cy: number): MemoryChunk | undefined {
  return layer === null ? ownEntry(state.memory, chunkKey(sceneId, cx, cy)) : ownEntry(state.memoryBy, holderChunkKey(sceneId, layer, cx, cy));
}

/**
 * Which value a held element shows (decision 6, rule 2): live where it
 * touches the viewer's live ground, else the entry of the memory it reads,
 * their own where their own layer holds a cell it touches and the party's
 * elsewhere, else live. A null entry is an element that was absent then.
 */
function chosen<T>(live: boolean, own: boolean, mine: Record<string, T> | undefined, party: Record<string, T> | undefined, key: string, now: T): T {
  if (live) return now;
  const from = own ? mine : party;
  return from !== undefined && Object.hasOwn(from, key) ? from[key]! : now;
}

/**
 * A player's chunk at a position of a scene with fog on
 * (docs/design/design-v1-map-discovery.md 5.2), for a fog class: only what the
 * class holds, each element live or remembered, with the fields only a
 * player's chunk carries. Null where it holds no cell, wall or piece, and
 * on a scene with fog off, whose chunks go as projectChunkForPlayer says.
 *
 * - Cells, heights, stair marks and difficult ground go by their cell,
 *   edges by either cell beside them (decision 1), and every other cell
 *   reads as empty, 0 and ".".
 * - `known`: the held cells, bit k for the chunk's cell k in row order,
 *   least significant bit first, packed and written as fog tiles are.
 *   `auto`: bit 2k for cell k's north edge and 2k + 1 for its west edge,
 *   where a held edge carries an automatic wall. `upDir`: one StairDir per
 *   cell, present only where a held cell is a stair.
 * - Free walls are cut at held cells and their cut ends rounded
 *   (rules/held.ts joinPieces), each piece with an id made from its own
 *   geometry (pieceId) and filed by its own midpoint. Only doors players
 *   see stay whole, under their real id and chunk.
 * - One constructor builds every position, a stored chunk's or a stub, its
 *   cells and edges in sorted key order, so two positions that hold the
 *   same are the same bytes on the socket, whatever order the DM drew in.
 */
export function playerChunk(state: RoomState, at: { sceneId: string; cx: number; cy: number }, view: FogClass): PlayerChunk | null {
  const scene = ownEntry(state.scenes, at.sceneId);
  if (!scene || !scene.fogEnabled || !inPositions(scene, at.cx, at.cy)) return null;
  const own = view !== null && holdsOwnSight(state, scene.id, view) ? view : null;
  const ground = groundOf(state, at.sceneId, own);
  if (!ground) return null;
  // A piece filed here lies on held cells within 4 cells of the position, its longest reach from its own midpoint.
  if (!heldNear(ground, at.cx, at.cy, 4)) return null;
  const memo = memoKey(state, scene, own, ground, at.cx, at.cy);
  const hit = memo === null ? undefined : recall(memo);
  if (hit !== undefined) return hit;
  const pieces = piecesNear(state, scene, ground, at.cx, at.cy);
  const out = chunkFor(state, scene, ground, at.cx, at.cy, pieces);
  if (memo !== null) keep(memo, out, pieces);
  return out;
}

/**
 * A batch's positions for one fog class. Only cache misses contribute their
 * neighborhoods to the cut, so neighboring positions share wall work and
 * unrelated held chunks never force a scene-wide cut. A miss whose free
 * walls and ground read the same as its last answer's takes that answer's
 * pieces and is left out of the cut too (recallPieces), as when a stair or
 * a floor changes beside walls that stay.
 */
export function playerChunkBatch(state: RoomState, sceneId: string, positions: readonly { cx: number; cy: number }[], view: FogClass): Map<string, PlayerChunk | null> {
  const out = new Map<string, PlayerChunk | null>();
  const scene = ownEntry(state.scenes, sceneId);
  const own = view !== null && holdsOwnSight(state, sceneId, view) ? view : null;
  const ground = scene?.fogEnabled ? groundOf(state, sceneId, own) : null;
  const missing: { cx: number; cy: number; key: string; memo: Memo | null; pieces: readonly FreeWall[] | undefined }[] = [];
  for (const { cx, cy } of positions) {
    const key = chunkKey(sceneId, cx, cy);
    if (out.has(key)) continue;
    out.set(key, null);
    if (!scene || !ground || !inPositions(scene, cx, cy) || !heldNear(ground, cx, cy, 4)) continue;
    const memo = memoKey(state, scene, own, ground, cx, cy);
    const hit = memo === null ? undefined : recall(memo);
    if (hit !== undefined) out.set(key, hit);
    else missing.push({ cx, cy, key, memo, pieces: memo === null ? undefined : recallPieces(memo) });
  }
  if (!scene || !ground || missing.length === 0) return out;
  const cut = missing.filter((m) => m.pieces === undefined);
  const near = new Set<string>();
  for (const { cx, cy } of cut) for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) near.add(`${cx + dx},${cy + dy}`);
  const filed = cut.length === 0 ? null : scenePieces(state, scene, ground, near, cut.length === 1 ? cut[0] : undefined);
  for (const { cx, cy, key, memo, pieces } of missing) {
    const walls = pieces ?? filed?.get(`${cx},${cy}`) ?? NO_WALLS;
    const chunk = chunkFor(state, scene, ground, cx, cy, walls);
    out.set(key, chunk);
    if (memo !== null) keep(memo, chunk, walls);
  }
  return out;
}

/** Every position's chunk of one scene with fog on for one class, by chunk key, as a snapshot holds them: the free walls cut once for the whole scene. */
export function heldChunks(state: RoomState, sceneId: string, view: FogClass): Record<string, PlayerChunk> {
  const scene = ownEntry(state.scenes, sceneId);
  const out: Record<string, PlayerChunk> = {};
  if (!scene || !scene.fogEnabled) return out;
  const own = view !== null && holdsOwnSight(state, sceneId, view) ? view : null;
  const ground = groundOf(state, sceneId, own);
  if (!ground) return out;
  let filed: Map<string, FreeWall[]> | null = null;
  for (const { cx, cy } of chunkPositions(scene)) {
    // Nothing held at a position or across its north and west sides, and no piece filed there: it holds nothing, without a key.
    if (!heldNear(ground, cx, cy, 1) && !(filed ??= scenePieces(state, scene, ground, null)).has(`${cx},${cy}`)) continue;
    const memo = memoKey(state, scene, own, ground, cx, cy);
    let chunk = memo === null ? undefined : recall(memo);
    if (chunk === undefined) {
      filed ??= scenePieces(state, scene, ground, null);
      const pieces = filed.get(`${cx},${cy}`) ?? NO_WALLS;
      chunk = chunkFor(state, scene, ground, cx, cy, pieces);
      if (memo !== null) keep(memo, chunk, pieces);
    }
    if (chunk) out[chunkKey(sceneId, cx, cy)] = chunk;
  }
  return out;
}

/**
 * Whether any cell of a position, or within `reach` cells west and north of
 * it, `reach` east and south too past 1, is held: a position holds a cell,
 * an edge or a piece only then. Always true on hexes, whose positions read
 * the tiles their hexes' world box covers.
 */
function heldNear(ground: Ground, cx: number, cy: number, reach: number): boolean {
  if (isHex(ground.grid)) return true;
  const x0 = cx * CHUNK_CELLS - reach;
  const y0 = cy * CHUNK_CELLS - reach;
  const x1 = (cx + 1) * CHUNK_CELLS + (reach > 1 ? reach : 0);
  const y1 = (cy + 1) * CHUNK_CELLS + (reach > 1 ? reach : 0);
  for (let y = Math.max(0, y0); y < y1; y++) for (let x = Math.max(0, x0); x < x1; x++) if (ground.held(x, y)) return true;
  return false;
}

/*
 * Players' chunks, kept by every object a position reads (5.6): its own
 * stored chunk and memories, the stored chunks west and north of it, whose
 * cells its edges read, the free walls alone of the rest of its 3 x 3
 * neighborhood, stored and remembered, the fog layers' tiles there, and
 * where memory is near, the class's sight, and for a position with stairs
 * the scene's stair map. Each is replaced and never changed, so
 * an unchanged position hands players the very same object, which the
 * fan-out need not hash again, and a changed input never hits. Of the scene
 * the key holds only the fields a position reads (sceneFields), since every
 * build stroke and door toggle replaces the scene object to bump its walls
 * version (MD2-O-4). Each position keeps the two answers read last, for
 * the committed state and a staged one (used), in slots hung off the
 * scene's bounds object, so a room's slots go when it unloads (MD2-O-5).
 * Nothing is kept while an op is still writing the state.
 */
const objectIds = new WeakMap<object, number>();
let nextObjectId = 1;

function idOf(o: object | undefined | null): number {
  if (!o) return 0;
  let id = objectIds.get(o);
  if (id === undefined) objectIds.set(o, (id = nextObjectId++));
  return id;
}

/*
 * A slot's answer, kept by two keys: `key`, every input object as above,
 * for the common hit, and `base` with `region`, every input but the fog
 * layers' tiles and the class's sight, which stand in by the cells of
 * those tiles each layer holds (regionOf). A move that explores sub-cells
 * of cells already held, or sees ground where no memory is, replaces the
 * tile objects, so the first key misses, but the position reads nothing
 * new and the second finds the same answer (the performance pass).
 * `walls`, every free wall the position reads, with `region` keys the
 * pieces filed there on their own (recallPieces).
 */
type Kept = { key: string; base: string; region: string | null; value: PlayerChunk | null; walls: string; pieces: readonly FreeWall[] };
type Slots = Map<string, Kept[]>;
type Memo = { slots: Slots; slot: string; key: string; base: string; walls: string; region: () => string | null };
const memos = new WeakMap<object, Slots>();
const MEMO_SLOTS = 50_000;

/* Whether a chunk holds a stair, a mark or painted stairs: kept per chunk object, which is replaced and never changed, since every key asks it. */
const stairChunks = new WeakMap<BuildChunk, boolean>();

function hasStairs(chunk: BuildChunk): boolean {
  let has = stairChunks.get(chunk);
  if (has === undefined) {
    has = marksOf(chunk) !== null || Object.values(chunk.cells).includes("stairs");
    if (!isWritable(chunk)) stairChunks.set(chunk, has);
  }
  return has;
}

/* A chunk's stair marks (heights.ts chunkMarks), kept per chunk object the same way, since every fog class's copy of a position reads them. */
const marksByChunk = new WeakMap<BuildChunk, string | null>();

function marksOf(chunk: BuildChunk): string | null {
  let marks = marksByChunk.get(chunk);
  if (marks === undefined) {
    marks = chunkMarks(chunk);
    if (!isWritable(chunk)) marksByChunk.set(chunk, marks);
  }
  return marks;
}

/** What a player's chunk reads of its scene: chunkFor, groundOf, the pieces' rounding and the stair map. Kept per scene object, which is replaced and never changed. */
const fieldsOfScene = new WeakMap<Scene, string>();

function sceneFields(scene: Scene): string {
  let fields = fieldsOfScene.get(scene);
  if (fields === undefined) {
    fields = partsKey([scene.id, scene.bounds.w, scene.bounds.h, autoWallsOf(scene), scene.gridShape ?? null, scene.fogEnabled, scene.vision?.on === true]);
    if (!isWritable(scene)) fieldsOfScene.set(scene, fields);
  }
  return fields;
}

/*
 * The ids of a finished collection's entries (idOf) at chunk or tile
 * coordinates of one scene and layer, kept per collection, which is never
 * written again (writable.ts). Each position's key reads the 3 x 3 around
 * it, so a fan-out keying every position near a move reads each entry for
 * up to nine of them.
 */
type IdsByLayer = Map<string, Map<string | null, Map<number, number>>>;
type IdKind = "chunk" | "tile" | "walls";
const entryIds: Record<IdKind, WeakMap<object, IdsByLayer>> = { chunk: new WeakMap(), tile: new WeakMap(), walls: new WeakMap() };

/** A chunk's id (idOf), a tile's, or for `walls` the id of the chunk's free walls alone, which a reducer that leaves them keeps: 0 with none, as with no chunk. */
function entryId(kind: IdKind, entry: object | undefined): number {
  return idOf(kind === "walls" ? (entry as { walls?: object } | undefined)?.walls : entry);
}

/** Columns from -1, as a position on the scene's side reads past it, up to this one: within them `(y + 1) * ID_ROW + (x + 1)` names one place. */
const ID_ROW = 65536;

function idAt(collection: Readonly<Record<string, object | undefined>> | undefined, kind: IdKind, sceneId: string, holder: string | null, x: number, y: number): number {
  if (!collection) return 0;
  // Past the columns one number can name, read without keeping, so no two places share an id's slot.
  if (!Number.isInteger(x) || !Number.isInteger(y) || x < -1 || x + 1 >= ID_ROW) return entryId(kind, collection[entryKey(kind, sceneId, holder, x, y)]);
  let byScene = entryIds[kind].get(collection);
  if (!byScene) entryIds[kind].set(collection, (byScene = new Map()));
  let byHolder = byScene.get(sceneId);
  if (!byHolder) byScene.set(sceneId, (byHolder = new Map()));
  let ids = byHolder.get(holder);
  if (!ids) byHolder.set(holder, (ids = new Map()));
  const at = (y + 1) * ID_ROW + (x + 1);
  let id = ids.get(at);
  if (id === undefined) ids.set(at, (id = entryId(kind, collection[entryKey(kind, sceneId, holder, x, y)])));
  return id;
}

function entryKey(kind: IdKind, sceneId: string, holder: string | null, x: number, y: number): string {
  if (kind !== "tile") return holder === null ? chunkKey(sceneId, x, y) : holderChunkKey(sceneId, holder, x, y);
  return holder === null ? tileKey(sceneId, x, y) : holderTileKey(sceneId, holder, x, y);
}

function memoKey(state: RoomState, scene: Scene, own: FogClass, ground: Ground, cx: number, cy: number): Memo | null {
  if (isWritable(state.buildChunks) || isWritable(state.fogTiles) || isWritable(state.exploredTiles ?? {}) || isWritable(state.exploredBy ?? {}) || isWritable(state.memory ?? {}) || isWritable(state.memoryBy ?? {})) return null;
  const sceneId = scene.id;
  const parts: (number | string)[] = [sceneFields(scene)];
  const walls: (number | string)[] = [sceneFields(scene)];
  let remembered = false;
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      const x = cx + dx;
      const y = cy + dy;
      // The position's own chunk, and those west and north whose cells its edges read (shownEdges), count whole. Of the rest, and of every memory but its own, only free walls are read (scenePieces), so memory is near where those are.
      const whole = dx === 0 ? dy <= 0 : dy === 0 && dx < 0;
      const memoryKind = dx === 0 && dy === 0 ? "chunk" : "walls";
      const party = idAt(state.memory, memoryKind, sceneId, null, x, y);
      const mine = own === null ? 0 : idAt(state.memoryBy, memoryKind, sceneId, own, x, y);
      if (party !== 0 || mine !== 0) remembered = true;
      parts.push(idAt(state.buildChunks, whole ? "chunk" : "walls", sceneId, null, x, y), party, mine);
      walls.push(idAt(state.buildChunks, "walls", sceneId, null, x, y), idAt(state.memory, "walls", sceneId, null, x, y), own === null ? 0 : idAt(state.memoryBy, "walls", sceneId, own, x, y));
    }
  }
  // A stair's direction reads the scene's whole stair map.
  const here = ownEntry(state.buildChunks, chunkKey(sceneId, cx, cy));
  if (here && hasStairs(here)) parts.push(idOf(sceneWalls(scene, state.buildChunks)));
  const base = partsKey(parts);
  for (const [x, y] of positionTiles(scene, cx, cy)) {
    parts.push(idAt(state.fogTiles, "tile", sceneId, null, x, y), idAt(state.exploredTiles, "tile", sceneId, null, x, y), own === null ? 0 : idAt(state.exploredBy, "tile", sceneId, own, x, y));
  }
  // Sight chooses live or remembered only where memory is.
  if (remembered) parts.push(idOf(classSight(state, scene, own)));
  let slots = memos.get(scene.bounds);
  if (!slots) memos.set(scene.bounds, (slots = new Map()));
  let region: string | null | undefined;
  return { slots, slot: partsKey([sceneId, own, cx, cy]), key: partsKey(parts), base, walls: partsKey(walls), region: () => (region === undefined ? (region = regionOf(ground, scene, cx, cy, remembered)) : region) };
}

/*
 * The cells of the position's tiles each fog layer holds: held, and with
 * memory near live and own too, one bit a cell (Ground.cellsKey). The
 * cells a square position reads, its own and those a piece filed there or
 * an edge reads within 5 cells of it, lie in those tiles, and the
 * projection reads ground by whole cells. Null on hexes, whose hexes are
 * held by the sub-cells inside them: those keep the tile objects' key alone.
 */
function regionOf(ground: Ground, scene: Scene, cx: number, cy: number, remembered: boolean): string | null {
  if (isHex(ground.grid)) return null;
  const parts: string[] = [];
  for (const [tx, ty] of positionTiles(scene, cx, cy)) {
    parts.push(ground.cellsKey("held", tx, ty));
    if (remembered) parts.push(ground.cellsKey("live", tx, ty), ground.cellsKey("own", tx, ty));
  }
  return partsKey(parts);
}

function recall(memo: Memo): PlayerChunk | null | undefined {
  const held = memo.slots.get(memo.slot);
  if (!held) return undefined;
  const hit = held.find((m) => m.key === memo.key);
  if (hit) return used(held, hit).value;
  if (!held.some((m) => m.base === memo.base && m.region !== null)) return undefined;
  const region = memo.region();
  const same = region === null ? undefined : held.find((m) => m.base === memo.base && m.region === region);
  if (!same) return undefined;
  // The same answer by what the position reads: kept under this state's objects too, for the next ask.
  same.key = memo.key;
  return used(held, same).value;
}

/*
 * The free walls a position's last answers filed there, when it reads the
 * same walls, stored and remembered, and the same ground as one of them:
 * the pieces are made of those walls and the cells of the position's
 * tiles each fog layer holds alone (scenePieces, regionOf), whatever else
 * the position reads changed. Not on hexes, where no region is kept.
 */
function recallPieces(memo: Memo): readonly FreeWall[] | undefined {
  const held = memo.slots.get(memo.slot);
  if (!held?.some((m) => m.walls === memo.walls && m.region !== null)) return undefined;
  const region = memo.region();
  return region === null ? undefined : held.find((m) => m.walls === memo.walls && m.region === region)?.pieces;
}

/*
 * The answer just read goes first, so a slot keeps the two answers read
 * last, not the two worked out last. A creature that steps off and comes
 * back, as each move of a turn does, reads one answer again between new
 * ones: kept by when they were worked out, it went every other step.
 */
function used(held: Kept[], kept: Kept): Kept {
  if (held[0] !== kept) {
    held.splice(held.indexOf(kept), 1);
    held.unshift(kept);
  }
  return kept;
}

function keep(memo: Memo, value: PlayerChunk | null, pieces: readonly FreeWall[]): void {
  const { slots } = memo;
  const held = slots.get(memo.slot) ?? [];
  slots.delete(memo.slot);
  slots.set(memo.slot, [{ key: memo.key, base: memo.base, region: memo.region(), value, walls: memo.walls, pieces }, ...held.filter((m) => m.key !== memo.key)].slice(0, 2));
  if (slots.size > MEMO_SLOTS) slots.delete(slots.keys().next().value!);
}

const NO_WALLS: readonly FreeWall[] = [];
const CELLS_PER_CHUNK = CHUNK_CELLS * CHUNK_CELLS;
const EMPTY_CHUNK: BuildChunk = { sceneId: "", cx: 0, cy: 0, rev: 0, cells: {}, edges: {} };

function chunkFor(state: RoomState, scene: Scene, ground: Ground, cx: number, cy: number, walls: readonly FreeWall[]): PlayerChunk | null {
  const sceneId = scene.id;
  const hex = isHex(ground.grid);
  const chunks = state.buildChunks;
  const stored = chunks[chunkKey(sceneId, cx, cy)];
  const mine = ground.remembers && ground.holder !== null ? memoryAt(state, sceneId, ground.holder, cx, cy) : undefined;
  const party = ground.remembers ? memoryAt(state, sceneId, null, cx, cy) : undefined;
  const x0 = cx * CHUNK_CELLS;
  const y0 = cy * CHUNK_CELLS;
  const known = new Uint8Array(CELLS_PER_CHUNK / 8);
  const cells: Record<string, TerrainId> = {};
  const feet = chunkHeights(stored ?? EMPTY_CHUNK);
  const marks = stored ? marksOf(stored) : null;
  const heights = new Int16Array(CELLS_PER_CHUNK);
  const up = new Array<StairMark>(CELLS_PER_CHUNK).fill(".");
  const rough = new Array<boolean>(CELLS_PER_CHUNK).fill(false);
  const upDir = new Array<StairDir>(CELLS_PER_CHUNK).fill(".");
  let anyHeld = false;
  let anyStair = false;
  // Stair directions read the scene's whole stair map, by hex keys on a hex scene (H3).
  const stairMap = sceneWalls(scene, chunks);
  for (let k = 0; k < CELLS_PER_CHUNK; k++) {
    const x = x0 + (k % CHUNK_CELLS);
    const y = y0 + Math.floor(k / CHUNK_CELLS);
    const key = `${x},${y}`;
    // On squares by coordinates, which saves reading the key back on every cell of every class.
    if (hex ? !ground.keyHeld(key) : !ground.held(x, y)) continue;
    anyHeld = true;
    known[k >> 3] = known[k >> 3]! | (1 << (k & 7));
    const live = hex ? ground.keyLive(key) : ground.live(x, y);
    const own = hex ? ground.keyOwn(key) : ground.own(x, y);
    const terrain = chosen<TerrainId | null>(live, own, mine?.cells, party?.cells, key, stored?.cells[key] ?? null);
    if (terrain !== null) cells[key] = terrain;
    heights[k] = chosen(live, own, mine?.heights, party?.heights, key, feet ? feet[k]! : 0);
    const mark = chosen<StairMark>(live, own, mine?.up, party?.up, key, marks ? (marks[k] as StairMark) : ".");
    up[k] = mark;
    rough[k] = chosen(live, own, mine?.rough, party?.rough, key, stored?.rough?.[k] === "d");
    if (stairMap && (mark !== "." || terrain === "stairs")) {
      anyStair = true;
      upDir[k] = chosen(live, own, mine?.upDir, party?.upDir, key, shownUpDir(stairMap, x, y));
    }
  }
  // Edges: held when either cell beside them is held, so the walls round a held room reach players from the chunk past it too.
  const edges: Record<string, WallFeature> = {};
  const auto = new Uint8Array((2 * CELLS_PER_CHUNK) / 8);
  let anyAuto = false;
  if (!hex) {
    const shown = shownEdges(chunks, scene, cx, cy);
    for (let k = 0; k < CELLS_PER_CHUNK; k++) {
      const x = x0 + (k % CHUNK_CELLS);
      const y = y0 + Math.floor(k / CHUNK_CELLS);
      for (const side of ["n", "w"] as const) {
        const ox = side === "n" ? x : x - 1;
        const oy = side === "n" ? y - 1 : y;
        if (!ground.held(x, y) && !ground.held(ox, oy)) continue;
        const key = `${x},${y},${side}`;
        const live = ground.live(x, y) || ground.live(ox, oy);
        const own = ground.own(x, y) || ground.own(ox, oy);
        const value = chosen<EdgeFeature | "auto" | null>(live, own, mine?.edges, party?.edges, key, shown[2 * k + (side === "w" ? 1 : 0)]!);
        if (value === null || (value !== "auto" && value.kind === "none")) continue;
        if (value === "auto") {
          const bit = 2 * k + (side === "w" ? 1 : 0);
          auto[bit >> 3] = auto[bit >> 3]! | (1 << (bit & 7));
          anyAuto = true;
        } else edges[key] = value;
      }
    }
  }
  // A held edge with nothing on it holds nothing, so a position past held ground goes only for a wall it carries.
  if (!anyHeld && !anyAuto && Object.keys(edges).length === 0 && walls.length === 0) return null;
  const out: PlayerChunk = { sceneId, cx, cy, rev: 0, cells: sortedRecord(cells), edges: sortedRecord(edges) };
  if (walls.length > 0) out.walls = [...walls];
  const heightsText = encodeHeights(heights);
  if (heightsText !== undefined) out.heights = heightsText;
  if (up.some((m) => m !== ".")) out.up = up.join("");
  if (rough.some((r) => r)) out.rough = rough.map((r) => (r ? "d" : ".")).join("");
  if (hex && scene.gridShape !== undefined) out.grid = scene.gridShape;
  out.known = encodeTile(known);
  if (anyAuto) out.auto = encodeTile(auto);
  if (anyStair) out.upDir = upDir.join("");
  return out;
}

/*
 * Every north and west edge of a position as players see it live, edge 2k
 * north and 2k + 1 west of cell k: the same for every fog class, so a batch
 * that projects a position for each class works it out once. Kept one a
 * position, hung off the scene's bounds object as players' chunks are, by
 * the chunk objects the edges read (the position's own and those north and
 * west, whose cells the automatic walls read) and the rule. A chunk is
 * replaced and never changed, so a build edit elsewhere, which replaces
 * the collection, keeps the answer. Nothing is kept from a collection an
 * op is still writing.
 */
const shownEdgeCache = new WeakMap<object, Map<string, { ids: string; values: ShownEdge[] }>>();

function shownEdges(chunks: Readonly<Record<string, BuildChunk>>, scene: Scene, cx: number, cy: number): readonly ShownEdge[] {
  const sceneId = scene.id;
  const rule = autoWallsOf(scene);
  const ids = partsKey([rule, idOf(chunks[chunkKey(sceneId, cx, cy)]), idOf(chunks[chunkKey(sceneId, cx - 1, cy)]), idOf(chunks[chunkKey(sceneId, cx, cy - 1)])]);
  const writable = isWritable(chunks);
  let byPosition = writable ? undefined : shownEdgeCache.get(scene.bounds);
  const at = partsKey([sceneId, cx, cy]);
  const hit = byPosition?.get(at);
  if (hit && hit.ids === ids) return hit.values;
  const values: ShownEdge[] = new Array(2 * CELLS_PER_CHUNK);
  for (let k = 0; k < CELLS_PER_CHUNK; k++) {
    const x = cx * CHUNK_CELLS + (k % CHUNK_CELLS);
    const y = cy * CHUNK_CELLS + Math.floor(k / CHUNK_CELLS);
    values[2 * k] = shownEdge(chunks, sceneId, rule, `${x},${y},n`);
    values[2 * k + 1] = shownEdge(chunks, sceneId, rule, `${x},${y},w`);
  }
  if (!writable) {
    if (!byPosition) shownEdgeCache.set(scene.bounds, (byPosition = new Map()));
    byPosition.set(at, { ids, values });
  }
  return values;
}

function sortedRecord<T>(record: Record<string, T>): Record<string, T> {
  const out: Record<string, T> = {};
  for (const key of Object.keys(record).sort()) out[key] = record[key]!;
  return out;
}

/** The free-wall id alphabet (model.ts FreeWall), which piece ids are written in. */
const ID_CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-";

/**
 * A piece's id (decision 2): the first 12 symbols of the free-wall id
 * alphabet from hash128 over its scene, its two ends as sent and its kind,
 * each number as `String(n)`, with a counter for a collision in its
 * position. Every input is public, so the id says nothing of the walls it
 * was cut from.
 */
export function pieceId(sceneId: string, piece: Pick<Piece, "a" | "b" | "kind">, again = 0): string {
  const text = `${sceneId}|${String(piece.a[0])},${String(piece.a[1])},${String(piece.b[0])},${String(piece.b[1])}|${piece.kind}${again > 0 ? `#${again}` : ""}`;
  const hex = hash128(text);
  let id = "";
  for (let i = 0; i < FREE_WALL_ID_LENGTH; i++) {
    // Six bits at a time from the front of the 128: three hex digits hold them.
    const bit = i * 6;
    const word = parseInt(hex.slice(bit >> 2, (bit >> 2) + 3), 16);
    id += ID_CHARS[(word >> (6 - (bit & 3))) & 63]!;
  }
  return id;
}

/** The free walls players get at one position: cut from the stored and remembered walls of its 3 x 3 neighborhood, which every piece filed there comes from (5.2). */
function piecesNear(state: RoomState, scene: Scene, ground: Ground, cx: number, cy: number): readonly FreeWall[] {
  const near = new Set<string>();
  for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) near.add(`${cx + dx},${cy + dy}`);
  return scenePieces(state, scene, ground, near, { cx, cy }).get(`${cx},${cy}`) ?? NO_WALLS;
}

/*
 * How far past a position's sides the cells lie whose stretches can make a
 * piece filed there: a piece lies in one 4-cell band of its run and no
 * steeper than 45 degrees to it, so within 2 cells of its own midpoint,
 * which lies in the position, and a cell more is margin. A visible door
 * reads every cell of its element, wherever it stands.
 */
const FILED_REACH = 3;

/** One free wall as an element: its real chunk and id, its live value as players see it, and the versions each layer remembers. */
type WallElement = { cx: number; cy: number; id: string; live: FreeWall | undefined; party?: readonly RememberedWall[]; mine?: readonly RememberedWall[] };

/** The same per-cell choices select both the whole visible door and any non-door pieces of its element. */
function heldWallParts(ground: Ground, e: Pick<WallElement, "live" | "party" | "mine">, inFocus?: (cell: string) => boolean, near?: (wall: FreeWall | null | undefined) => boolean): { door: FreeWall | null; stretches: CellPiece[] } {
  const stretches: CellPiece[] = [];
  const candidates = [e.live, ...(e.party ?? []).map((v) => v.wall), ...(e.mine ?? []).map((v) => v.wall)];
  const anyDoor = candidates.some((w) => w && visibleDoor(w));
  if (!anyDoor && near && !candidates.some(near)) return { door: null, stretches: [] };
  const cells = new Set<string>();
  for (const wall of candidates) {
    if (wall) for (const span of wallSpans(ground.grid, wall)) cells.add(span.cell);
  }
  let door: { wall: FreeWall; live: boolean } | null = null;
  for (const cell of cells) {
    if (!anyDoor && inFocus && !inFocus(cell)) continue;
    if (!ground.keyHeld(cell)) continue;
    const live = ground.keyLive(cell);
    let wall: FreeWall | null | undefined = e.live;
    if (!live) {
      const version = (ground.keyOwn(cell) ? e.mine : e.party)?.find((v) => v.cells.includes(cell));
      if (version) wall = version.wall;
    }
    if (!wall) continue;
    const span = wallSpans(ground.grid, wall).find((s) => s.cell === cell);
    if (!span) continue;
    if (visibleDoor(wall)) {
      if (door === null || (live && !door.live)) door = { wall, live };
      continue;
    }
    const { a, b } = wallLattice(wall);
    stretches.push({ a, b, t0: span.t0, t1: span.t1, kind: wall.f.kind === "window" ? "window" : "wall" });
  }
  return { door: door?.wall ?? null, stretches };
}

/**
 * The whole visible door a class receives: a live cell's door takes
 * precedence, otherwise the first held cell's visible door. This is also
 * the witness for naming a blocker beside live ground.
 */
export function heldFreeDoor(state: RoomState, ground: Ground, at: { cx: number; cy: number; id: string }): FreeWall | null {
  const key = chunkKey(ground.sceneId, at.cx, at.cy);
  const wall = ownEntry(state.buildChunks, key)?.walls?.find((w) => w.id === at.id);
  return heldWallParts(ground, {
    live: wall ? shownFreeWall(wall) : undefined,
    party: ground.remembers ? ownEntry(state.memory, key)?.walls?.[at.id] : undefined,
    mine: ground.remembers && ground.holder !== null ? ownEntry(state.memoryBy, holderChunkKey(ground.sceneId, ground.holder, at.cx, at.cy))?.walls?.[at.id] : undefined,
  }).door;
}

/**
 * The free walls players of one class get, filed by position (5.2): every
 * wall of the given positions (all of the scene's when null), live and
 * remembered, chosen per cell. A cell in sight or revealed by the DM takes
 * the live value, any other held cell the version of the memory it reads
 * that covers it, else the live value. The chosen stretches then join,
 * split and round (joinPieces), and each piece gets its id. A door players
 * see goes whole under its real id and chunk: live where any cell it holds
 * is live, else as remembered.
 */
function scenePieces(state: RoomState, scene: Scene, ground: Ground, positions: ReadonlySet<string> | null, only?: { cx: number; cy: number }): Map<string, FreeWall[]> {
  const sceneId = scene.id;
  // For one position on squares, only the cells whose stretches can be filed there (FILED_REACH), and only its pieces get ids.
  const focus = only && !isHex(ground.grid) ? { x0: only.cx * CHUNK_CELLS - FILED_REACH, y0: only.cy * CHUNK_CELLS - FILED_REACH, x1: (only.cx + 1) * CHUNK_CELLS + FILED_REACH, y1: (only.cy + 1) * CHUNK_CELLS + FILED_REACH } : null;
  const inFocus = (cell: string) => {
    if (!focus) return true;
    const comma = cell.indexOf(",");
    const x = Number(cell.slice(0, comma));
    const y = Number(cell.slice(comma + 1));
    return x + 1 >= focus.x0 && x <= focus.x1 && y + 1 >= focus.y0 && y <= focus.y1;
  };
  const near = (w: FreeWall | null | undefined) =>
    !focus || !w || (Math.max(w.a[0], w.b[0]) >= focus.x0 && Math.min(w.a[0], w.b[0]) <= focus.x1 && Math.max(w.a[1], w.b[1]) >= focus.y0 && Math.min(w.a[1], w.b[1]) <= focus.y1);
  const elements = new Map<string, WallElement>();
  const element = (cx: number, cy: number, id: string): WallElement => {
    const key = `${cx},${cy}:${id}`;
    let e = elements.get(key);
    if (!e) elements.set(key, (e = { cx, cy, id, live: undefined }));
    return e;
  };
  const wanted = (cx: number, cy: number) => positions === null || positions.has(`${cx},${cy}`);
  for (const chunk of positions === null ? sceneChunkList(state.buildChunks, sceneId) : chunksAt(state.buildChunks, sceneId, null, positions)) {
    if (!wanted(chunk.cx, chunk.cy)) continue;
    for (const wall of chunk.walls ?? []) element(chunk.cx, chunk.cy, wall.id).live = shownFreeWall(wall);
  }
  if (ground.remembers) {
    const layers: FogClass[] = ground.holder === null ? [null] : [null, ground.holder];
    for (const layer of layers) {
      const all = (layer === null ? state.memory : state.memoryBy) ?? {};
      for (const chunk of positions === null ? Object.values(all) : chunksAt(all, sceneId, layer, positions)) {
        if (chunk.sceneId !== sceneId || (chunk.memberId ?? null) !== layer || !chunk.walls || !wanted(chunk.cx, chunk.cy)) continue;
        for (const [id, versions] of Object.entries(chunk.walls)) {
          const e = element(chunk.cx, chunk.cy, id);
          if (layer === null) e.party = versions;
          else e.mine = versions;
        }
      }
    }
  }
  const stretches: CellPiece[] = [];
  const doors: FreeWall[] = [];
  for (const key of [...elements.keys()].sort()) {
    const e = elements.get(key)!;
    const held = heldWallParts(ground, e, inFocus, near);
    stretches.push(...held.stretches);
    if (held.door) doors.push(held.door);
  }
  const filed = new Map<string, FreeWall[]>();
  const file = (pos: string, wall: FreeWall) => {
    let list = filed.get(pos);
    if (!list) filed.set(pos, (list = []));
    list.push(wall);
  };
  const filedHere = (cx: number, cy: number) => !only || (cx === only.cx && cy === only.cy);
  for (const wall of doors) {
    const at = wallChunk(wall);
    if (filedHere(at.cx, at.cy)) file(`${at.cx},${at.cy}`, wall);
  }
  for (const piece of joinPieces(stretches, ground)) if (filedHere(piece.cx, piece.cy)) file(`${piece.cx},${piece.cy}`, { id: "", a: piece.a, b: piece.b, f: { kind: piece.kind } });
  for (const [pos, list] of filed) {
    list.sort(byCoordinates);
    // Ids taken in the position, doors' first: a piece that collides with one hashes again with a counter (MD-R4-1).
    const taken = new Set(list.filter((w) => w.id !== "").map((w) => w.id));
    const out: FreeWall[] = [];
    let last: FreeWall | undefined;
    for (const wall of list) {
      if (wall.id !== "") {
        out.push(wall);
        continue;
      }
      // Equal pieces in one position are one piece.
      if (last && last.a[0] === wall.a[0] && last.a[1] === wall.a[1] && last.b[0] === wall.b[0] && last.b[1] === wall.b[1] && last.f.kind === wall.f.kind) continue;
      const piece = { a: wall.a, b: wall.b, kind: wall.f.kind as PieceKind };
      let again = 0;
      let id = pieceId(sceneId, piece);
      while (taken.has(id)) id = pieceId(sceneId, piece, ++again);
      taken.add(id);
      last = { ...wall, id };
      out.push(last);
    }
    filed.set(pos, out);
  }
  return filed;
}

/*
 * The chunks of a collection, stored or remembered, of one scene and layer
 * (a chunk's memberId, none for the party's and the stored ones) that
 * stand at the positions given, by where each chunk says it stands. One
 * position's pieces read its 3 x 3, and with every layer's memory full the
 * collections hold many hundred chunks, so they are grouped once per
 * collection, which is replaced and never changed.
 */
const chunksByPosition = new WeakMap<object, Map<string, Map<string | null, Map<string, (BuildChunk | MemoryChunk)[]>>>>();

function chunksAt<T extends BuildChunk | MemoryChunk>(all: Readonly<Record<string, T>>, sceneId: string, layer: FogClass, positions: ReadonlySet<string>): readonly T[] {
  let byScene = isWritable(all) ? undefined : chunksByPosition.get(all);
  if (!byScene) {
    byScene = new Map();
    for (const chunk of Object.values(all)) {
      if (!chunk) continue;
      let byLayer = byScene.get(chunk.sceneId);
      if (!byLayer) byScene.set(chunk.sceneId, (byLayer = new Map()));
      const member = "memberId" in chunk ? (chunk.memberId ?? null) : null;
      let byPosition = byLayer.get(member);
      if (!byPosition) byLayer.set(member, (byPosition = new Map()));
      // Two numbers as text hold no comma of their own, so this names one position.
      const key = `${chunk.cx},${chunk.cy}`;
      let list = byPosition.get(key);
      if (!list) byPosition.set(key, (list = []));
      list.push(chunk);
    }
    if (!isWritable(all)) chunksByPosition.set(all, byScene);
  }
  const byPosition = byScene.get(sceneId)?.get(layer);
  if (!byPosition) return [];
  return [...positions].flatMap((key) => (byPosition.get(key) ?? []) as T[]);
}

/** A scene's stored chunks, grouped once per chunk collection, which is replaced and never changed. */
const chunkLists = new WeakMap<object, Map<string, BuildChunk[]>>();

function sceneChunkList(all: Readonly<Record<string, BuildChunk>>, sceneId: string): readonly BuildChunk[] {
  let lists = isWritable(all) ? undefined : chunkLists.get(all);
  if (!lists) {
    lists = new Map();
    for (const chunk of Object.values(all)) {
      if (!chunk) continue;
      let list = lists.get(chunk.sceneId);
      if (!list) lists.set(chunk.sceneId, (list = []));
      list.push(chunk);
    }
    if (!isWritable(all)) chunkLists.set(all, lists);
  }
  return lists.get(sceneId) ?? [];
}

/**
 * One fog tile of the viewer's scene. The DM gets the DM's own layer, and
 * the explored layer beside it (projectExploredCtx). A player gets one fog,
 * each tile the two layers merged (docs/design/design-v1-maps-vision.md 4.3.3), so
 * every rule players' devices apply to fog works on it unchanged. A
 * player's tile has rev 0, as a player's chunk does: neither layer's count
 * of edits reaches players, so a DM reveal of ground the party already
 * explored, or an explore of ground the DM revealed, sends them nothing.
 * On a per-player scene a sight holder's tile merges their own layer too
 * (docs/design/design-v1-per-player-vision.md 6.3).
 */
function projectFogCtx(ctx: Ctx, sceneId: string, tx: number, ty: number): FogTile | null {
  if (sceneId !== ctx.sceneId) return null;
  if (ctx.viewer.role === "dm") return ownEntry(ctx.state.fogTiles, tileKey(sceneId, tx, ty)) ?? null;
  const own = perPlayerScene(ownEntry(ctx.state.scenes, sceneId)) && holdsSight(ctx.state, sceneId, ctx.viewer.memberId) ? ownEntry(ctx.state.exploredBy, holderTileKey(sceneId, ctx.viewer.memberId, tx, ty)) : undefined;
  return own ? holderFogTile(ctx.state, sceneId, tx, ty, own) : sharedFogTile(ctx.state, sceneId, tx, ty);
}

/** A fog tile as every player shares it: the DM's and the party's layers merged (projectFogCtx). */
function sharedFogTile(state: RoomState, sceneId: string, tx: number, ty: number): FogTile | null {
  const key = tileKey(sceneId, tx, ty);
  const dm = ownEntry(state.fogTiles, key) ?? null;
  const explored = ownEntry(state.exploredTiles, key);
  if (!explored) return dm && playerTile(dm, () => ({ ...dm, rev: 0 }));
  if (!dm) return playerTile(explored, () => ({ sceneId, tx, ty, rev: 0, bits: explored.bits }));
  const both = mergedOf(dm, explored);
  return (both.tile ??= { sceneId, tx, ty, rev: 0, bits: (both.text ??= encodeTile(both.bits)) });
}

/** A sight holder's fog tile where their own layer holds one: it merged with the DM's and the party's, kept per tile objects. */
function holderFogTile(state: RoomState, sceneId: string, tx: number, ty: number, own: ExploredTile): FogTile {
  const key = tileKey(sceneId, tx, ty);
  const layers = [ownEntry(state.fogTiles, key), ownEntry(state.exploredTiles, key), own].filter((t): t is FogTile => t !== undefined);
  if (layers.length === 1) return playerTile(own, () => ({ sceneId, tx, ty, rev: 0, bits: own.bits }));
  const all = mergedChain(layers);
  return (all.tile ??= { sceneId, tx, ty, rev: 0, bits: (all.text ??= encodeTile(all.bits)) });
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
 * Per-player vision's derived tiles (docs/design/design-v1-per-player-vision.md
 * 6.2), only on the viewer's per-player scene. The shared sight, with
 * vision on, the same for every viewer, the DM's too. The shared fog, the
 * same for every player, which their devices read every public rule by.
 * And for the DM every sight holder's layer joined, beside the party's.
 */
function viewersPerPlayerScene(ctx: Ctx, sceneId: string): boolean {
  return sceneId === ctx.sceneId && perPlayerScene(ownEntry(ctx.state.scenes, sceneId));
}

function projectSightAllCtx(ctx: Ctx, sceneId: string, tx: number, ty: number): SightTile | null {
  if (!viewersPerPlayerScene(ctx, sceneId) || !visionOn(ownEntry(ctx.state.scenes, sceneId))) return null;
  return visionRules.holderSight(ctx.state, sceneId, null).tiles.get(`${tx},${ty}`) ?? null;
}

function projectFogAllCtx(ctx: Ctx, sceneId: string, tx: number, ty: number): FogTile | null {
  if (!viewersPerPlayerScene(ctx, sceneId)) return null;
  return sharedFogTile(ctx.state, sceneId, tx, ty);
}

function projectExploredAnyCtx(ctx: Ctx, sceneId: string, tx: number, ty: number): FogTile | null {
  if (ctx.viewer.role !== "dm" || !viewersPerPlayerScene(ctx, sceneId)) return null;
  return exploredAnyTile(ctx.state, sceneId, tx, ty);
}

/** Every holder layer's tile at a place joined, kept per tile objects, or null where no layer holds one. */
function exploredAnyTile(state: RoomState, sceneId: string, tx: number, ty: number): FogTile | null {
  const layers = holderTiles(state, sceneId, tx, ty);
  const first = layers[0];
  if (!first) return null;
  if (layers.length === 1) return playerTile(first, () => ({ sceneId, tx, ty, rev: 0, bits: first.bits }));
  const all = mergedChain(layers);
  return (all.tile ??= { sceneId, tx, ty, rev: 0, bits: (all.text ??= encodeTile(all.bits)) });
}

/** The tiles every entry of a scene's holder list holds at a place, in the list's order. */
function holderTiles(state: RoomState, sceneId: string, tx: number, ty: number): ExploredTile[] {
  const out: ExploredTile[] = [];
  for (const e of ownEntry(state.holders, sceneId)?.entries ?? []) {
    const tile = ownEntry(state.exploredBy, holderTileKey(sceneId, e.memberId, tx, ty));
    if (tile) out.push(tile);
  }
  return out;
}

/**
 * A scene's sight holder list is the DM's, on the per-player scene the DM
 * views (docs/design/design-v1-per-player-vision.md 6.1), as the snapshot gives it
 * (perPlayerMapsCtx). The reducer never leaves one on a whole-party scene,
 * but a restored room might hold one (review PV1-O9).
 */
function projectHoldersCtx(ctx: Ctx, list: SightHolders): SightHolders | null {
  return ctx.viewer.role === "dm" && list.sceneId === ctx.sceneId && perPlayerScene(ownEntry(ctx.state.scenes, list.sceneId)) ? list : null;
}

/**
 * One tile of the party's sight on the viewer's scene, while its vision is
 * on (docs/design/design-v1-maps-vision.md 4.3.4). Players and the DM alike get it.
 * Sight is derived, never stored, and the same for every player.
 */
function projectSightCtx(ctx: Ctx, sceneId: string, tx: number, ty: number): unknown {
  if (sceneId !== ctx.sceneId || !visionOn(ownEntry(ctx.state.scenes, sceneId))) return null;
  return ctx.sight(sceneId).tiles.get(`${tx},${ty}`) ?? null;
}

/** Every sight tile of the viewer's scene, keyed as a projected state holds them. */
function sightTilesCtx(ctx: Ctx): SightMap {
  const out: SightMap = {};
  const sceneId = ctx.sceneId;
  if (sceneId === null || !visionOn(ownEntry(ctx.state.scenes, sceneId))) return out;
  for (const [at, tile] of ctx.sight(sceneId).tiles) out[`${sceneId}:${at}`] = tile;
  return out;
}

function projectFogDraftCtx(ctx: Ctx, draft: FogDraft): FogDraft | null {
  if (ctx.viewer.role !== "dm") return null;
  return draft.sceneId === ctx.sceneId ? draft : null;
}

/**
 * A label fully under enabled fog is withheld from players like a token, so
 * a "Trap" in the dark is not in the data at all. On a scene that keeps
 * memory a label off the viewer's live ground shows as they last saw it
 * (shownByMemory).
 */
function projectLabelCtx(ctx: Ctx, label: Label): Label | null {
  if (label.sceneId !== ctx.sceneId) return null;
  if (ctx.viewer.role === "dm") return label;
  const scene = ownEntry(ctx.state.scenes, label.sceneId);
  if (!scene || !scene.fogEnabled) return label;
  return shownByMemory(ctx, "labels", label.id, label);
}

/** The cells a label or stamp is judged by: its box (labelCells, stampCells). */
function boxOf(field: "labels" | "stamps", value: Label | Stamp): CellRange {
  return field === "labels" ? labelCells(value as Label) : stampCells(value as Stamp);
}

/**
 * A label or stamp as a player of the viewer's class sees it on a scene
 * with fog on (docs/design/design-v1-map-discovery.md 5.3, decision 5): live where
 * its box touches their live ground, else as the memory it reads
 * remembers it (decision 6), where their own layer holds a cell of a box
 * their own and the party's elsewhere. A remembered absence hides it. A
 * remembered one whose box touches live ground is gone from where they
 * look, and one off held ground shows nothing. Without an entry it goes by
 * today's rule: shown unless its box is fully under their fog. A stamp the
 * DM keeps to themselves never shows, remembered or not.
 */
function shownByMemory<T extends Label | Stamp>(ctx: Ctx, field: "labels" | "stamps", id: string, live: T | null): T | null {
  const sceneId = ctx.sceneId;
  if (sceneId === null) return null;
  const now = live && live.sceneId === sceneId ? live : null;
  if (field === "stamps" && (now as Stamp | null)?.visibility === "dm") return null;
  const held = (r: CellRange) => !isRangeFullyFogged(ctx.presence(sceneId), sceneId, r, (x, y) => ctx.fogged(sceneId, x, y));
  const liveBox = now ? boxOf(field, now) : null;
  const ground = groundCtx(ctx, sceneId);
  if (!ground || !ground.remembers) return liveBox && held(liveBox) ? now : null;
  if (liveBox && ground.rangeLive(liveBox)) return now;
  const party = rememberedById(ctx.state, sceneId, null, field, id);
  const mine = ground.holder === null ? undefined : rememberedById(ctx.state, sceneId, ground.holder, field, id);
  const boxes = [now, party, mine].filter((v): v is T => v !== null && v !== undefined).map((v) => boxOf(field, v));
  const entry = ground.holder !== null && boxes.some((r) => ground.rangeOwn(r)) ? mine : party;
  if (entry === undefined) return liveBox && held(liveBox) ? now : null;
  if (entry === null) return null;
  const box = boxOf(field, entry);
  if (ground.rangeLive(box) || !held(box)) return null;
  return entry as T;
}

/** The viewer's ground on a scene (rules/held.ts), worked out once per projection. Null for the DM. */
function groundCtx(ctx: Ctx, sceneId: string): Ground | null {
  if (ctx.viewer.role === "dm") return null;
  if (!ctx.grounds.has(sceneId)) ctx.grounds.set(sceneId, groundOf(ctx.state, sceneId, fogClassOf(ctx.state, sceneId, ctx.viewer.memberId)));
  return ctx.grounds.get(sceneId)!;
}

/**
 * Each layer's remembered labels and stamps by id, indexed once per memory
 * collection, which is replaced and never changed: a label lies in one
 * chunk of its layer only (shared/reducer/memory.ts).
 */
type ById = Map<string, Label | Stamp | null>;
const rememberedIndex = new WeakMap<object, Map<string, ById>>();

function rememberedIn(all: Record<string, MemoryChunk> | undefined, at: string): ById | undefined {
  if (!all) return undefined;
  let index = isWritable(all) ? undefined : rememberedIndex.get(all);
  if (!index) {
    index = new Map();
    for (const chunk of Object.values(all)) {
      for (const field of ["labels", "stamps"] as const) {
        const record = chunk[field];
        if (!record) continue;
        const where = partsKey([chunk.sceneId, chunk.memberId ?? null, field]);
        let byId = index.get(where);
        if (!byId) index.set(where, (byId = new Map()));
        for (const [id, value] of Object.entries(record)) byId.set(id, value);
      }
    }
    if (!isWritable(all)) rememberedIndex.set(all, index);
  }
  return index.get(at);
}

/**
 * Whether any layer's memory on a scene, the party's or a holder's, names
 * a label or stamp. Only then does its projection read memory and sight
 * (shownByMemory), so the fan-out keeps an answer across batches only
 * where none does (server/rooms/fanout.ts, MD2-O-1).
 */
export function namedByMemory(state: RoomState, sceneId: string, field: "labels" | "stamps", id: string): boolean {
  return [state.memory, state.memoryBy].some((all) => namesIn(all).has(partsKey([sceneId, field, id])));
}

const memoryNames = new WeakMap<object, Set<string>>();

function namesIn(all: Record<string, MemoryChunk> | undefined): ReadonlySet<string> {
  if (!all) return NO_NAMES;
  let names = isWritable(all) ? undefined : memoryNames.get(all);
  if (!names) {
    names = new Set();
    for (const chunk of Object.values(all)) {
      for (const field of ["labels", "stamps"] as const) for (const id of Object.keys(chunk[field] ?? {})) names.add(partsKey([chunk.sceneId, field, id]));
    }
    if (!isWritable(all)) memoryNames.set(all, names);
  }
  return names;
}

const NO_NAMES: ReadonlySet<string> = new Set();

/** What one layer remembers of a label or stamp by id: the value, null for one that was absent then, undefined for no entry. */
function rememberedById(state: RoomState, sceneId: string, layer: FogClass, field: "labels" | "stamps", id: string): Label | Stamp | null | undefined {
  const byId = rememberedIn(layer === null ? state.memory : state.memoryBy, partsKey([sceneId, layer, field]));
  return byId?.get(id);
}

/** The ids of labels or stamps only memory names on a scene, which still reach players who remember them (5.3). */
function rememberedOnly(state: RoomState, sceneId: string, field: "labels" | "stamps"): string[] {
  const out = new Set<string>();
  const live = field === "labels" ? state.labels : state.stamps;
  for (const all of [state.memory, state.memoryBy]) {
    for (const chunk of Object.values(all ?? {})) {
      if (chunk.sceneId !== sceneId) continue;
      for (const id of Object.keys(chunk[field] ?? {})) if (!Object.hasOwn(live, id)) out.add(id);
    }
  }
  return [...out].sort();
}

/** A label or stamp by key for the viewer: the live one, or one only their memory holds. */
function projectRememberedCtx(ctx: Ctx, field: "labels" | "stamps", id: string): Label | Stamp | null {
  if (ctx.viewer.role === "dm" || ctx.sceneId === null) return null;
  const scene = ownEntry(ctx.state.scenes, ctx.sceneId);
  if (!scene || !scene.fogEnabled) return null;
  return shownByMemory<Label | Stamp>(ctx, field, id, null);
}

/** The viewer's labels or stamps, as a snapshot holds them: the live ones and those only memory names. */
function projectByMemoryCtx<T extends Label | Stamp>(ctx: Ctx, field: "labels" | "stamps", live: Record<string, T>, project: (value: T) => T | null): Record<string, T> {
  const out = projectMap(live, project);
  if (ctx.viewer.role === "dm" || ctx.sceneId === null) return out;
  for (const id of rememberedOnly(ctx.state, ctx.sceneId, field)) {
    const value = projectRememberedCtx(ctx, field, id);
    if (value) out[id] = value as T;
  }
  return out;
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
 * Stamps on the viewer's scene (docs/design/design-v1-maps-vision.md 3.5). A
 * player gets none the DM hid, and none whose box is fully under enabled
 * fog, as labels go, so a chest in an unexplored room is not in their data.
 */
function projectStampCtx(ctx: Ctx, stamp: Stamp): Stamp | null {
  if (stamp.sceneId !== ctx.sceneId) return null;
  if (ctx.viewer.role === "dm") return stamp;
  if (stamp.visibility === "dm") return null;
  const scene = ownEntry(ctx.state.scenes, stamp.sceneId);
  if (!scene || !scene.fogEnabled) return stamp;
  return shownByMemory(ctx, "stamps", stamp.id, stamp);
}

/**
 * Traps (docs/design/design-v1-traps.md 6.4). The DM gets every trap on its scene.
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
    const chunk = ownEntry(ctx.state.buildChunks, chunkKey(trap.sceneId, cx, cy));
    const feature = "edge" in zone.door ? chunk?.edges[zone.door.edge] : chunk?.walls?.find((w) => w.id === (zone.door as { id: string }).id)?.f;
    if (feature?.kind === "door" && feature.secret && !feature.discovered) return null;
  }
  const scene = ownEntry(ctx.state.scenes, trap.sceneId);
  if (scene?.fogEnabled) {
    const fogs = ctx.presence(trap.sceneId);
    const fogged = (r: CellRange) => isRangeFullyFogged(fogs, trap.sceneId, r, (x, y) => ctx.fogged(trap.sceneId, x, y));
    // On hexes by the sub-cells inside its hexes, so ground revealed beside them never shows it (docs/design/design-v1-hex-grids.md H2).
    if (zoneFogged(ctx.state, trap.sceneId, zone, fogged, (sx, sy) => ctx.fogged.sub(trap.sceneId, sx, sy))) return null;
  }
  let out = playerTraps.get(trap);
  if (!out) {
    out = { id: trap.id, rev: 0, sceneId: trap.sceneId, name: trap.name, zone, ...(trap.state === "disarmed" ? { disarmed: true as const } : {}), ...(trap.grid !== undefined ? { grid: trap.grid } : {}) };
    playerTraps.set(trap, out);
  }
  return out;
}

/* A player's trap, kept per trap object, which is replaced and never changed, so a re-projection that changes nothing sends nothing. */
const playerTraps = new WeakMap<Trap, ProjectedTrap>();

/** A found trap's fields for players (docs/design/design-v1-traps.md 6.2), held to every key of Trap as SCENE_FOR_PLAYERS is. */
export const TRAP_FOR_PLAYERS = {
  id: "copied",
  rev: "zeroed",
  sceneId: "copied",
  name: "copied",
  zone: "copied",
  state: "changed: players read only that it is disarmed, as `disarmed`",
  found: "dm: a player's copy exists only while the trap is found",
  rig: "dm: what it does and who it catches",
  // The shape its zone was written for, as public as the scene's shape (docs/design/design-v1-hex-grids.md HX-D14).
  grid: "copied",
} as const satisfies Record<keyof Trap, PlayerField>;

/**
 * A players' trap line (docs/design/design-v1-traps.md 6.3): every player and
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
 * How a player's or table display's copy of a stored entity takes each of
 * its fields: "copied" as stored, "zeroed" to 0, "changed" with why, or
 * kept by the DM with why. Each list `satisfies` every key of its type, so
 * a new field fails the typecheck until someone decides, and
 * project.fields.test.ts holds each projection to its list.
 */
export type PlayerField = "copied" | "zeroed" | `changed: ${string}` | `dm: ${string}`;

/**
 * A scene's fields for players (docs/design/design-v1-maps-vision.md 3.3). Its
 * rev, order and walls version are 0, as a chunk's rev is, so a DM's edit
 * of those fields, a thumbnail landing in the background included,
 * changes nothing players receive. The walls version moves with every
 * build op, a hidden secret door's or a lock's edit too, which players
 * cannot see. No client reads it: the rules caches follow the derived wall
 * set.
 */
export const SCENE_FOR_PLAYERS = {
  id: "copied",
  rev: "zeroed",
  name: "copied",
  order: "zeroed",
  bounds: "copied",
  // With its video, which every op keeps the showing phase's, the only one players receive (docs/design/design-v1-animated-maps.md 7).
  map: "copied",
  grid: "copied",
  background: "copied",
  fogEnabled: "copied",
  wallsVersion: "zeroed",
  defaultView: "copied",
  autoWalls: "changed: \"off\" with fog on, since a player's chunks then carry the automatic walls they hold",
  folder: "dm: how the DM files scenes in the Scenes panel",
  thumb: "dm: the Scenes panel's picture, which a background render moves",
  phases: "dm: the map's other images and their names (On fire)",
  phaseId: "dm: which of the DM's images is showing, with the phases",
  phaseGrid: "dm: the phases' reference grid",
  // Players' devices draw sight and stop drags at walls by these (docs/design/design-v1-maps-vision.md 4.3.5).
  blockMovement: "copied",
  vision: "copied",
  gridFromFile: "dm: the import's mark, which only Find the grid reads",
  // Players' devices snap, draw and measure by it (docs/design/design-v1-hex-grids.md section 7).
  gridShape: "copied",
  // A following player's device shows it (docs/design/design-v1-isometric-view.md 7). It names a view, nothing of the map.
  suggestedView: "copied",
  // Players' devices draw it and their rolls follow it (docs/design/design-v1-weather.md 7). It names a look and its rules, nothing of the map.
  weather: "copied",
  sound: "dm: the playlist and loops the scene starts, which players hear only once they play (docs/design/design-v1-music.md 6.5)",
} as const satisfies Record<keyof Scene, PlayerField>;

/** A scene as a player gets it: an allowlist, field by field as SCENE_FOR_PLAYERS rules. */
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
  // With fog on a player's chunks carry the automatic walls they hold (`auto`), so their device derives none (docs/design/design-v1-map-discovery.md 5.2).
  if (scene.fogEnabled) out.autoWalls = "off";
  else if (scene.autoWalls !== undefined) out.autoWalls = scene.autoWalls;
  if (scene.blockMovement !== undefined) out.blockMovement = scene.blockMovement;
  if (scene.vision !== undefined) out.vision = scene.vision;
  if (scene.gridShape !== undefined) out.gridShape = scene.gridShape;
  // A following player's device shows it (docs/design/design-v1-isometric-view.md 7). It names a view, nothing of the map.
  if (scene.suggestedView !== undefined) out.suggestedView = scene.suggestedView;
  // Only the players' scene comes this far, so weather the DM sets up on another scene never leaves the DM's devices.
  if (scene.weather !== undefined) out.weather = scene.weather;
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

/** A document in the DM's library reaches players only as a handout it is shown as (docs/design/design-v1-pdf-handouts.md 3.4). */
function projectHandoutDocCtx(ctx: Ctx, doc: HandoutDoc): HandoutDoc | null {
  return ctx.viewer.role === "dm" ? doc : null;
}

/**
 * A player's ask for saves (docs/design/design-v1-player-save-spell.md 5.5): the
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
    const area = ownEntry(ctx.state.templates, ask.area);
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
 * (docs/design/design-v1-companion-stat-blocks.md 4.2). The character's ownership
 * is the only input, so who reads a block never drifts from who plays the
 * companions. They are not scene data, so a blackout keeps them, as it
 * keeps the player's characters.
 */
function projectCompanionBlockCtx(ctx: Ctx, block: CompanionBlock): CompanionBlock | null {
  if (ctx.viewer.role === "dm") return block;
  const character = ownEntry(ctx.state.characters, block.characterId);
  // Rev 0 for players, as on their characters (projectCharacter).
  return character !== undefined && ownsCharacter(ctx.viewer, character) ? { ...block, rev: 0 } : null;
}

/** Whether a player may read a journal page: one shared with every player, or with them alone (docs/design/design-v1-dm-tools.md 3.7). */
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
 * Map pins (docs/design/design-v1-dm-tools.md 3.8), by the labels' rule and two
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
    const page = ownEntry(ctx.state.journal, pin.pageId);
    if (!page || !pageReadableBy(page, ctx.viewer.memberId)) return null;
  }
  const scene = ownEntry(ctx.state.scenes, pin.sceneId);
  if (!scene || !scene.fogEnabled) return pin;
  const fogged = isRangeFullyFogged(ctx.presence(pin.sceneId), pin.sceneId, pinCells(pin), (x, y) => ctx.fogged(pin.sceneId, x, y));
  return fogged ? null : pin;
}

/** Whether the viewer owns the creature a roll target or a roll line names, now. A creature that is gone is no one's. */
function ownsRollCreature(ctx: Ctx, ref: { tokenId?: string; characterId?: string }): boolean {
  if (ref.tokenId !== undefined) {
    const token = ownEntry(ctx.state.tokens, ref.tokenId);
    return token !== undefined && ownsToken(ctx.state, ctx.viewer, token);
  }
  if (ref.characterId !== undefined) {
    const character = ownEntry(ctx.state.characters, ref.characterId);
    return character !== undefined && ownsCharacter(ctx.viewer, character);
  }
  return false;
}

/**
 * A roll request (docs/design/design-v1-dm-tools.md 3.3) as a player gets it:
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
  // What the roll is for goes with it, and `ends`, which names the effect and its occurrence, stays the DM's (docs/design/design-v1-roll-request.md 7.5).
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
 * (docs/design/design-v1-dice.md 5.2, docs/design/design-v1-roll-request.md 7.5), and the
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
  // The card offers the Total field without a roll row while it is set (docs/design/design-v1-roll-request.md 5.5).
  if (target.retype) out.retype = true;
  return out;
}

/**
 * Whether the room's order setting lets players see the row now
 * (docs/design/design-v1-combat-flow.md 11.2): the whole order, the party's own
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
  const token = creature.tokenId !== undefined ? ownEntry(state.tokens, creature.tokenId) : undefined;
  if (token) return partysOwn(state, token) || (viewer !== undefined && ownsToken(state, viewer, token)) || (allies && token.disposition === "ally");
  const character = creature.characterId !== undefined ? ownEntry(state.characters, creature.characterId) : undefined;
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
  return entry.characterId === undefined || ownEntry(ctx.state.characters, entry.characterId) !== undefined;
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
  const ctx = ctxOf(state, viewer, { sceneId: state.meta.playerSceneId }, clipsByHeldWalls(env.opVersion));
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
  const token = ownEntry(ctx.state.tokens, start.tokenId);
  if (!token || token.sceneId !== start.sceneId || !tokenVisibleTo(ctx, token)) return null;
  if (!start.seen && !start.seenBy?.includes(ctx.viewer.memberId) && !ownsToken(ctx.state, ctx.viewer, token)) return null;
  const out: TurnStart = { entryId: start.entryId, tokenId: start.tokenId, sceneId: start.sceneId, x: start.x, y: start.y, elevation: start.elevation };
  if (start.seq !== undefined) out.seq = start.seq;
  // The mounts sharing the turn that the player's copy holds (docs/design/design-v1-attach.md 8.5).
  const mounts = start.mounts?.filter((id) => tokenVisibleById(ctx, id));
  if (mounts && mounts.length > 0) out.mounts = mounts;
  return out;
}

/** DM only. An empty history projects as absent, so the held map and the snapshot's `[]` agree. */
function projectHistoryCtx(ctx: Ctx): EncounterSnapshot[] | null {
  if (ctx.viewer.role !== "dm" || ctx.state.encounterHistory.length === 0) return null;
  return ctx.state.encounterHistory;
}

/** Everyone who plays a token, by its own owners or its character's. A projected token a player does not own has no `ownerIds`. */
function ownersOf(state: RoomState, token: Token): string[] {
  return [...(token.ownerIds ?? []), ...(characterOf(state, token)?.ownerIds ?? [])];
}

/** Who may read a log event: every player and table display, or only the members listed. */
export type Reach = "all" | readonly string[];

function reaches(reach: Reach, memberId: string): boolean {
  return reach === "all" || reach.includes(memberId);
}

function both(a: Reach, b: Reach): Reach {
  if (a === "all") return b;
  if (b === "all") return a;
  return a.filter((id) => b.includes(id));
}

/**
 * Who may read a log event, by the line and the room as it stands (design
 * 7.3, Log): "all", each viewer still reading it only by what they see when
 * they read it (projectEventCtx), or only the members listed, which may be
 * none. The list is what the line names:
 *
 * - An event about a token that players who do not own it could not see
 *   when it happened (no `seen`), or an effect companion's life, which
 *   reaches others as alive whatever it is (effectCompanion): the token's
 *   players.
 * - A turn of a row players who do not own it could not see then: the row
 *   creature's players.
 * - A roll's answer, and a cast: their creature's players, as the request
 *   and the ask reach them (projectRollCtx, projectCastCtx).
 * - A dice line: everyone who may read any of its rolls (diceRollReach).
 * - A handout: its recipients.
 * - A line no player ever gets (neverRead): none.
 *
 * The projection asks it of every line when it is read, so a line reaches
 * no one it does not name now. A line from op version 19 on also keeps the
 * readers it had when it was written (lineReach), so it never reaches one
 * it could not have reached then, a player who comes to own its creature
 * later included.
 */
export function eventReach(state: RoomState, data: LogEvent): Reach {
  if (neverRead(data)) return [];
  switch (data.type) {
    case "correction":
      // A correction without stored authorization evidence cannot reach players.
      return [];
    case "area":
      // On a per-player scene a reminder reaches exactly its witnesses, its creature's owners among them only as they saw the area (6.5).
      if (data.seenBy !== undefined && !data.seen) return ownEntry(state.tokens, data.tokenId) ? data.seenBy : [];
      return creatureReach(state, data, false);
    case "hp":
    case "rest":
    case "concentration":
    case "effect":
    case "use":
      return creatureReach(state, data, false);
    case "deathSave":
    case "life":
      return creatureReach(state, data, true);
    case "turn": {
      const row = state.encounter?.entries.find((e) => e.id === data.entryId);
      if (!row) return [];
      if (data.seen) return "all";
      const token = row.tokenId !== undefined ? ownEntry(state.tokens, row.tokenId) : undefined;
      const character = row.characterId !== undefined ? ownEntry(state.characters, row.characterId) : undefined;
      return [...(token ? ownersOf(state, token) : []), ...(character?.ownerIds ?? []), ...(data.seenBy ?? [])];
    }
    case "encounter":
    case "member":
      return "all";
    // Its audience is frozen when written (lineReader): a line written while the clock was hidden is the DM's by its number.
    case "clock":
      return "all";
    case "handout": {
      const handout = ownEntry(state.handouts, data.handoutId);
      if (!handout) return [];
      return handout.to === "all" ? "all" : handout.to;
    }
    case "roll":
    case "cast":
      return creaturePlayers(state, data);
    case "dice": {
      const out = new Set<string>();
      for (const roll of data.rolls) {
        const reach = diceRollReach(state, roll);
        if (reach === "all") return "all";
        for (const id of reach) out.add(id);
      }
      return [...out];
    }
    case "teleport":
    case "saveEnds":
    case "companion":
    case "characterDeleted":
    case "trap":
    case "trapSeen":
    case "trapNotice":
      return [];
  }
}

/** The players of the creature a roll line, a cast or a roll names. A creature that is gone is no one's. */
function creaturePlayers(state: RoomState, ref: { tokenId?: string; characterId?: string }): string[] {
  if (ref.tokenId !== undefined) {
    const token = ownEntry(state.tokens, ref.tokenId);
    return token ? ownersOf(state, token) : [];
  }
  if (ref.characterId !== undefined) return ownEntry(state.characters, ref.characterId)?.ownerIds ?? [];
  return [];
}

/**
 * Who may have an event about a creature: everyone when it names only a
 * character, or a token that players who do not own it could see when it
 * happened, else the token's players and, on a per-player scene, the sight
 * holders its list names (docs/design/design-v1-per-player-vision.md 6.5). An
 * effect companion's life (`lifeOnly`) reaches only its players however it
 * was seen.
 */
function creatureReach(state: RoomState, data: { tokenId?: string; characterId?: string; seen?: true; seenBy?: string[] }, lifeOnly: boolean): Reach {
  if (data.characterId !== undefined && !ownEntry(state.characters, data.characterId)) return [];
  if (data.tokenId === undefined) return "all";
  const token = ownEntry(state.tokens, data.tokenId);
  if (!token) return [];
  const companionLife = lifeOnly && effectCompanion(token);
  if (data.seen && !companionLife) return "all";
  return companionLife || data.seenBy === undefined ? ownersOf(state, token) : [...ownersOf(state, token), ...data.seenBy];
}

/**
 * Who may have one roll of a `dice` line (docs/design/design-v1-dice.md 5.2): as an
 * event about its token when it names one, and when marked `hidden`, an
 * initiative roll for a creature whose place in the order players did not
 * know then, only the creature's players (docs/design/design-v1-combat-flow.md
 * 11.3).
 */
function diceRollReach(state: RoomState, roll: DiceRoll): Reach {
  const own = roll.hidden ? creaturePlayers(state, roll) : "all";
  return roll.tokenId === undefined ? own : both(own, creatureReach(state, roll, false));
}

/** Any player who owns nothing and was given nothing, as one who joins later is. No member id is empty. */
const ANY_PLAYER: Viewer = { memberId: "", role: "player" };

/**
 * Who a log line reaches, fixed when its op is done (Tx.settleLog,
 * shared/logRings.ts): what the real projection of the room as the op
 * leaves it gives each player on the roster, and any player who owns
 * nothing (ANY_PLAYER), so the readers fixed then follow every rule a
 * player's read applies (projectEventCtx), a blackout, a creature's sight,
 * another player's area and a creature the op deleted included, and never
 * drift from them.
 *
 * - "shared" when every player reads it, and so would any player who owns
 *   nothing, one who joins later included. `parts` names who read each part
 *   of it that not all of them did (LineParts).
 * - "party" when only some do: each reader, in id order, with the line as
 *   they read it then.
 * - "dm" when none does.
 *
 * A chat line reaches all. A whisper is its parties' (whisperParties).
 */
export type LineReach = { audience: "shared"; parts?: LineParts } | { audience: "party"; views: [string, LogEvent, LineParts?][] } | { audience: "dm" };

type Read = { id: string; ctx: Ctx; view: LogEvent | null };

export function lineReach(state: RoomState, entry: Pick<LogEntry, "kind" | "data">): LineReach {
  return lineReader(state)(entry);
}

/**
 * lineReach for every line of one room: each player's read keeps one
 * context, with that player's own fog and sight reader, across every line,
 * so an op of many lines judges them all against the same room for about
 * the cost of reading each. The reach is stored, so it takes the op's
 * version: one stored before op version 37 reads a creature's outline on
 * hexes by the build's walls (clipsByHeldWalls).
 */
export function lineReader(state: RoomState, opVersion?: number): (entry: Pick<LogEntry, "kind" | "data">) => LineReach {
  // Each reader with their own sight and fog, which on a per-player scene are theirs alone, and any player the shared
  // ones (docs/design/design-v1-per-player-vision.md 6.5). Any player stands for a member who owns nothing, so it reads a dice
  // line as members do.
  const held = clipsByHeldWalls(opVersion);
  const ctxOfReader = (viewer: Viewer): Ctx => ({ ...ctxOf(state, viewer, { sceneId: null }, held), member: true });
  const players = Object.values(state.members)
    .filter((m) => m.kind === "player")
    .map((m) => m.id)
    .sort()
    .map((id) => ctxOfReader({ memberId: id, role: "player" }));
  const anyPlayer = ctxOfReader(ANY_PLAYER);
  return (entry) => {
    if (entry.kind !== "event" || !entry.data) return { audience: "shared" };
    const data = entry.data;
    // A clock line's audience is frozen as the op leaves the clock (docs/design/design-v1-calendar.md 6.4): shared while it
    // is shown, the DM's otherwise. Read later, it reaches whoever it reached then (projectEventCtx).
    if (data.type === "clock") return state.clock?.shown === true ? { audience: "shared" } : { audience: "dm" };
    const read = (ctx: Ctx): Read => ({ id: ctx.viewer.memberId, ctx, view: projectEventCtx(ctx, data) });
    const reads = players.map(read);
    const readers = reads.filter((r) => r.view !== null);
    const anyone = read(anyPlayer);
    // A line holding a list of who saw it is a party line, whose copies each hold their reader's view (6.5).
    if (anyone.view === null || readers.length < players.length || holdsLists(data)) {
      return readers.length === 0 ? { audience: "dm" } : { audience: "party", views: readers.map((r) => [r.id, r.view!]) };
    }
    const parts = partsOf(data, anyone, reads);
    return parts ? { audience: "shared", parts } : { audience: "shared" };
  };
}

/**
 * Who read each part of a shared line that not every player did, nor any
 * player who owns nothing: those parts its readers' views kept, by the
 * rules that keep them apart (projectEventCtx, keptRolls).
 */
function partsOf(data: LogEvent, anyone: Read, reads: readonly Read[]): LineParts | undefined {
  const parts: LineParts = {};
  const narrow = (has: (r: Read) => boolean): string[] | null => (has(anyone) && reads.every(has) ? null : reads.filter(has).map((r) => r.id));
  const field = (name: string) => (r: Read) => r.view !== null && (r.view as Record<string, unknown>)[name] !== undefined;
  const set = (key: "exact" | "label" | "to", ids: string[] | null) => {
    if (ids) parts[key] = ids;
  };
  switch (data.type) {
    case "hp":
    case "rest":
      if (data.amount !== undefined || data.left !== undefined) set("exact", narrow((r) => field("amount")(r) || field("left")(r)));
      if (data.label !== undefined) set("label", narrow(field("label")));
      break;
    case "concentration":
      if (data.dc !== undefined) set("exact", narrow(field("dc")));
      break;
    case "deathSave":
      if (data.ok !== undefined || data.fail !== undefined) set("exact", narrow((r) => field("ok")(r) || field("fail")(r)));
      break;
    case "turn":
      if (data.to !== undefined) set("to", narrow(field("to")));
      break;
    case "use":
      if (data.cost !== undefined || data.left !== undefined || data.max !== undefined) set("exact", narrow((r) => field("cost")(r) || field("left")(r) || field("max")(r)));
      break;
    case "dice": {
      const kept = new Map([anyone, ...reads].map((r) => [r, new Set(keptRolls(r.ctx, data))]));
      const rolls = data.rolls.map((_, i) => narrow((r) => kept.get(r)!.has(i)));
      if (rolls.some((ids) => ids !== null)) parts.rolls = rolls;
      break;
    }
    default:
      break;
  }
  return Object.keys(parts).length > 0 ? parts : undefined;
}

/** A shared line's event without the parts a player was not among the readers of (LineParts), before their read's own rules. */
function withinParts(data: LogEvent, parts: LineParts, memberId: string): LogEvent {
  const lacks = (ids: readonly string[] | undefined) => ids !== undefined && !ids.includes(memberId);
  switch (data.type) {
    case "hp":
    case "rest": {
      const out = { ...data };
      if (lacks(parts.exact)) {
        delete out.amount;
        delete out.left;
      }
      if (lacks(parts.label)) delete out.label;
      return out;
    }
    case "concentration": {
      if (!lacks(parts.exact)) return data;
      const { dc: _dc, ...rest } = data;
      return rest;
    }
    case "deathSave": {
      if (!lacks(parts.exact)) return data;
      const { ok: _ok, fail: _fail, ...rest } = data;
      return rest;
    }
    case "turn": {
      if (!lacks(parts.to)) return data;
      const { to: _to, toSeen: _toSeen, ...rest } = data;
      return rest;
    }
    case "use": {
      if (!lacks(parts.exact)) return data;
      const { cost: _cost, left: _left, max: _max, ...rest } = data;
      return rest;
    }
    case "dice": {
      const rolls = parts.rolls;
      if (!rolls) return data;
      return { ...data, rolls: data.rolls.filter((_, i) => !lacks(rolls[i] ?? undefined)) };
    }
    default:
      return data;
  }
}

/** The creature a log event is about, as a player in sight of it now may have it: null when its token is gone or out of their sight. */
function holderInSight(ctx: Ctx, data: { tokenId?: string; characterId?: string }): { token?: Token; character?: Character } | null {
  const holder: { token?: Token; character?: Character } = {};
  if (data.tokenId !== undefined) {
    const token = ownEntry(ctx.state.tokens, data.tokenId);
    if (!token || !tokenVisibleTo(ctx, token)) return null;
    holder.token = token;
    const character = characterOf(ctx.state, token);
    if (character) holder.character = character;
  }
  if (data.characterId !== undefined) {
    const character = ownEntry(ctx.state.characters, data.characterId);
    if (!character) return null;
    holder.character = character;
  }
  return holder;
}

/**
 * A log event as a player reads it: only when eventReach reaches them, and
 * then by what the room shows them now. These read-time rules hide a line
 * or a part of it from a viewer who may have seen it arrive, and tell
 * nothing about lines they never get: its creature, area or row is out of
 * their sight or gone now, the game is paused, a handout is not theirs now,
 * and what HP numbers they may read. A party line's copy (`copy`) is the
 * line as its reader read it when it was written, so what it kept then
 * stands unless its creature, area or row is out of their sight now.
 */
function projectEventCtx(ctx: Ctx, data: LogEvent, copy = false): LogEvent | null {
  // A copy of a secret roll of someone else's, read as the bare line then, names no roll or creature to check again.
  if (copy && data.type === "dice" && data.to === "dm" && data.rolls.length === 0) return ctx.member && data.by !== ctx.viewer.memberId ? data : null;
  if (!reaches(eventReach(ctx.state, data), ctx.viewer.memberId)) return null;
  data = withoutLists(data, ctx.viewer.memberId);
  switch (data.type) {
    case "hp": {
      const holder = holderInSight(ctx, data);
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
      const holder = holderInSight(ctx, data);
      if (!holder) return null;
      if (hpAccess(ctx.state, ctx.viewer, holder) === "exact") return data;
      // lineReader uses this same gate to record the audience, so a hidden check also leaves no gap in player log ids.
      if (data.exact) return null;
      const { dc: _dc, ...rest } = data;
      return rest;
    }
    case "effect":
      // Hidden from players, owners included, like the effect itself on the actor (neverRead).
      return holderInSight(ctx, data) ? data : null;
    case "rest": {
      // Everyone who sees the creature sees it rest. The HP it got back is as private as its HP.
      const holder = holderInSight(ctx, data);
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
      const holder = holderInSight(ctx, data);
      if (!holder) return null;
      if (hpAccess(ctx.state, ctx.viewer, holder) === "exact") return data;
      if (data.exact) return null;
      const { ok: _ok, fail: _fail, ...rest } = data;
      return rest;
    }
    case "life":
      return holderInSight(ctx, data) ? data : null;
    case "turn": {
      const rows = projectEncounterCtx(ctx)?.entries;
      const row = rows?.find((e) => e.id === data.entryId);
      if (!row) return null;
      if (data.to === undefined && data.toSeen === undefined) return data;
      // The row a take-back resumed, only for a player who could see it resume, and sees it now.
      const { to, toSeen, ...rest } = data;
      const resumed = rows?.find((e) => e.id === to);
      return resumed && (toSeen || copy || ownsRow(ctx, resumed)) ? { ...rest, to: resumed.id } : rest;
    }
    case "area": {
      // The area must have been in players' sight when it happened and be in this player's now, as must the creature.
      if (!holderInSight(ctx, data)) return null;
      const template = ownEntry(ctx.state.templates, data.templateId);
      return template && projectTemplateCtx(ctx, template) ? data : null;
    }
    case "encounter":
      // A fight started behind the pause screen is news when the game resumes.
      return ctx.paused ? null : data;
    case "clock":
      // A player keeps every clock line that reached them, after sharing goes off or the clock stops too (docs/design/design-v1-calendar.md 6.4).
      // Behind a blackout they wait with the clock, held back here at read time. A line's audience was frozen when it was written,
      // so one written while shared reaches players when the blackout lifts, even if sharing went off meanwhile (D-261102-530).
      return ctx.paused ? null : data;
    case "handout": {
      const handout = ownEntry(ctx.state.handouts, data.handoutId);
      return handout && projectHandoutCtx(ctx, handout) ? data : null;
    }
    case "member":
      // Every player sees the whole roster, so its history is public too.
      // Not tied to who is on the roster now: a removed member's lines stay.
      return data;
    case "roll": {
      // As the request itself (projectRollCtx): its creature's players, under the same two switches.
      if (ctx.paused) return null;
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
      // A rolled answer's dice reach the creature's players with its total (docs/design/design-v1-dice.md 5.2).
      if (data.dice !== undefined) out.dice = data.dice;
      if (data.typedBonus) out.typedBonus = true;
      if (data.tag !== undefined) out.tag = data.tag;
      if (data.changed !== undefined) out.changed = data.changed;
      return out;
    }
    case "dice":
      return projectDiceCtx(ctx, data);
    case "use": {
      // The DM's and its owners' read the counts (docs/design/design-v1-combat-controls.md 8). Others read only a public use, by name.
      const holder = holderInSight(ctx, data);
      if (!holder) return null;
      const owns = (holder.token !== undefined && ownsToken(ctx.state, ctx.viewer, holder.token)) || (holder.character !== undefined && ownsCharacter(ctx.viewer, holder.character));
      const { cost, left, max, hidden, ...rest } = data;
      if (owns) return { ...rest, ...(cost !== undefined ? { cost } : {}), ...(left !== undefined ? { left } : {}), ...(max !== undefined ? { max } : {}) };
      // A give back, and a use after a secret roll, say nothing to anyone else.
      return data.back || hidden ? null : rest;
    }
    case "cast":
      // As the ask itself (projectCastCtx): its caster's players, never behind a pause.
      return ctx.paused ? null : data;
    // The DM's alone (neverRead), and trap lines live in their own logs (projectTrapSeenCtx).
    case "correction":
    case "teleport":
    case "saveEnds":
    case "companion":
    case "characterDeleted":
    case "trap":
    case "trapSeen":
    case "trapNotice":
      return null;
  }
}

/**
 * An event without the lists of who saw it (docs/design/design-v1-per-player-vision.md
 * 6.5), which are the DM's: a reader they name reads it as seen, so their
 * read follows the rules of a line every player saw. A dice line's rolls
 * lose theirs in projectDiceCtx. An event that holds none is the same object.
 */
function withoutLists(data: LogEvent, reader: string): LogEvent {
  if (data.type === "dice" || (!("seenBy" in data) && !("toSeenBy" in data))) return data;
  const { seenBy, toSeenBy, ...rest } = data as LogEvent & { seenBy?: string[]; toSeenBy?: string[] };
  const out = rest as Record<string, unknown>;
  if (seenBy?.includes(reader)) out.seen = true;
  if (toSeenBy?.includes(reader)) out.toSeen = true;
  return out as LogEvent;
}

/** Whether an event holds a list of who saw it (6.5), which makes its line a party line (lineReader). */
export function holdsLists(data: LogEvent): boolean {
  if (data.type === "dice") return data.rolls.some((r) => r.seenBy !== undefined);
  return "seenBy" in data || "toSeenBy" in data;
}

/** An event as the DM's line keeps it once its readers are fixed (Tx.settleLog): with no list, the copies naming who read it. */
export function listsStripped(data: LogEvent): LogEvent {
  if (!holdsLists(data)) return data;
  if (data.type === "dice") return { ...data, rolls: data.rolls.map(({ seenBy: _seenBy, ...roll }) => roll) };
  const { seenBy: _seenBy, toSeenBy: _toSeenBy, ...rest } = data as LogEvent & { seenBy?: string[]; toSeenBy?: string[] };
  return rest as LogEvent;
}

/** Whether the viewer owns the creature on an initiative row, so its turns are part of the viewer's own history. */
function ownsRow(ctx: Ctx, row: ProjectedEntry): boolean {
  const token = row.tokenId !== undefined ? ownEntry(ctx.state.tokens, row.tokenId) : undefined;
  if (token && ownsToken(ctx.state, ctx.viewer, token)) return true;
  const character = row.characterId !== undefined ? ownEntry(ctx.state.characters, row.characterId) : undefined;
  return character !== undefined && ownsCharacter(ctx.viewer, character);
}

/**
 * A `dice` line for a player (docs/design/design-v1-dice.md 5.2). Each roll is
 * kept when it reaches them (diceRollReach) and names no token or one in
 * their sight now, so a token's roll follows that token's events and none
 * passes a blackout. With none kept there is no line.
 * Open to everyone, or the
 * player's own, it reads in full, the tag only for its roller. A secret
 * roll of someone else's reads as the bare line, and only when the same
 * roll made public would have reached the player, so a roll for a creature
 * hidden or in the dark leaves no trace. A table display is no member of
 * the room and gets no line, as it gets no `roll` line.
 */
function projectDiceCtx(ctx: Ctx, data: Extract<LogEvent, { type: "dice" }>): LogEvent | null {
  if (!ctx.member) return null;
  const rolls = keptRolls(ctx, data).map((i): DiceRoll => {
    const roll = data.rolls[i]!;
    // The mark is the DM's, so the DM's log alone says the roll was kept from players, and so is a roll's list of who saw it (6.5).
    if (!roll.hidden && roll.seenBy === undefined) return roll;
    const { hidden: _hidden, seenBy, ...rest } = roll;
    return seenBy?.includes(ctx.viewer.memberId) ? { ...rest, seen: true } : rest;
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

/** The places of a dice line's rolls a player gets: each that reaches them (diceRollReach) and names no token or one in their sight now. */
function keptRolls(ctx: Ctx, data: Extract<LogEvent, { type: "dice" }>): number[] {
  const out: number[] = [];
  data.rolls.forEach((roll, i) => {
    if (reaches(diceRollReach(ctx.state, roll), ctx.viewer.memberId) && (roll.tokenId === undefined || holderInSight(ctx, roll) !== null)) out.push(i);
  });
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
  // The DM's live projection can start later than the server's retained
  // HP lines. Keep Undo on those archive pages, but never on dropped or
  // already reverted lines, whose stored revert record still exists there.
  const held = viewer.role === "dm" ? new Set(state.log.map((e) => e.id)) : null;
  const reverted = new Set(viewer.role === "dm" ? state.log.flatMap((e) => e.data?.type === "hp" && e.data.back && e.data.of ? [e.data.of] : []) : []);
  for (const line of lines) {
    const projected = projectLogEntryCtx(ctx, line);
    if (!projected) continue;
    if (held && projected.data?.type === "hp" && projected.data.revert && (!held.has(projected.id) || reverted.has(projected.id))) {
      const { revert: _gone, ...data } = projected.data;
      out.push({ ...projected, data });
    } else out.push(projected);
  }
  return out;
}

/**
 * One log line as `viewer` reads it, by the same rules as the live log and
 * the archive. The client uses it on the lines a predicted op wrote, so a
 * prediction never shows a line part the server's projection would cut.
 */
export function projectLogEntry(state: RoomState, line: LogEntry, viewer: Viewer, opts: ProjectOpts): LogEntry | null {
  return projectLogEntryCtx(ctxOf(state, viewer, opts), line);
}

/**
 * A log line as a viewer reads it, by its audience (shared/logRings.ts): a
 * whisper by its parties, a DM line, a party line's own included, by the DM
 * alone, and a party line's copy by its one reader. A player then reads an
 * event by its own rules (projectEventCtx), a shared line's without the
 * parts they were not among the readers of when it was written (LineParts),
 * and never the DM's own fields, `parts` and a copy's `copyOf`. A viewer
 * who is no member, a table display, reads no line: it shows no log
 * (docs/design/design-v1-dm-tools.md 3.1), so no line one gets and another does
 * not can tell anyone at the table anything there.
 */
function projectLogEntryCtx(ctx: Ctx, entry: LogEntry): LogEntry | null {
  if (!ctx.member && ctx.viewer.role !== "dm") return null;
  const me = ctx.viewer.memberId;
  if (entry.kind === "whisper") return entry.from === me || entry.to?.includes(me) ? entry : null;
  const audience = lineAudience(entry);
  if (audience === "party") {
    if (ctx.viewer.role === "dm" || entry.to![0] !== me) return null;
  } else if (ctx.viewer.role === "dm") return entry;
  else if (audience === "dm") return null;
  const { parts, copyOf, ...line } = entry;
  const whole = parts === undefined && copyOf === undefined;
  if (entry.kind === "chat") return whole ? entry : line;
  if (!entry.data) return null;
  if (entry.data.type === "correction") {
    const data = projectCorrection(ctx.state, ctx.viewer, entry.data, parts?.correction, (key) => projectEntityCtx(ctx, key));
    return data ? { ...line, data } : null;
  }
  const data = projectEventCtx(ctx, parts ? withinParts(entry.data, parts, me) : entry.data, audience === "party");
  if (!data) return null;
  return data === entry.data && whole ? entry : { ...line, data };
}

function projectMemberCtx(_ctx: Ctx, member: Member): Member {
  return member;
}

function projectMetaCtx(ctx: Ctx): ProjectedState["meta"] {
  if (ctx.viewer.role !== "dm") {
    // Preview can start from the DM's view, so discard its private derived metadata.
    const { hpUndoLogIds: _undo, ...meta } = ctx.state.meta as ProjectedState["meta"];
    return meta;
  }
  // Archive pages can outlive the server's undo records. Send their current
  // eligibility with live updates, independently of the DM's shorter tail.
  const reverted = new Set(ctx.state.log.flatMap((e) => e.data?.type === "hp" && e.data.back && e.data.of ? [e.data.of] : []));
  const hpUndoLogIds = ctx.state.log.filter((e) => e.data?.type === "hp" && e.data.revert && !e.data.back && !reverted.has(e.id)).map((e) => e.id);
  return { ...ctx.state.meta, hpUndoLogIds };
}

/** One entity as the viewer may see it, or null when the viewer may not know it exists. */
export function projectEntity(key: EntityKey, state: RoomState, viewer: Viewer, opts: ProjectOpts): unknown {
  return projectEntityCtx(ctxOf(state, viewer, opts), key);
}

/*
 * Projections the reducer asks for while it applies an op: who a
 * correction's copies go to (undoCorrection.ts) and whether a trap step
 * changed what a player sees (reducer.ts). Their answers are stored or
 * decide what is, so each takes the op's envelope, and an op stored before
 * op version 37 projects by the build's walls it was applied under
 * (clipsByHeldWalls). The envelope is a required argument, so no reducer
 * caller can fall back to the live rule. The rest of the module's exports
 * project live, for sockets, previews and devices.
 */

/*
 * Below op version 37 the projection carried no `seenAll` mark, so for such
 * an op these leave it out, as the projection the op was applied under did:
 * a mark the build's walls move would otherwise make a trap step look seen,
 * or send a correction a copy, where the op as written did neither.
 */

/** projectEntity for the op `env` stores. */
export function projectEntityForOp(key: EntityKey, state: RoomState, viewer: Viewer, opts: ProjectOpts, env: Pick<Env, "opVersion">): unknown {
  const held = clipsByHeldWalls(env.opVersion);
  const out = projectEntityCtx(ctxOf(state, viewer, opts, held), key);
  return held || out === null || parseKey(key)?.kind !== "token" ? out : unmarked(out as ProjectedToken);
}

/** projectState for the op `env` stores. */
export function projectStateForOp(state: RoomState, viewer: Viewer, opts: ProjectOpts, env: Pick<Env, "opVersion">): ProjectedState {
  const held = clipsByHeldWalls(env.opVersion);
  const out = projectStateCtx(ctxOf(state, viewer, opts, held));
  return held ? out : { ...out, tokens: Object.fromEntries(Object.entries(out.tokens).map(([id, t]) => [id, unmarked(t)])) };
}

/** A projected token without the `seenAll` mark: the same object when it has none. */
function unmarked(token: ProjectedToken): ProjectedToken {
  if (token.seenAll === undefined) return token;
  const { seenAll: _seenAll, ...rest } = token;
  return rest;
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
      return projectChunkAtCtx(ctx, parsed.sceneId, parsed.cx, parsed.cy);
    case "fog":
      return projectFogCtx(ctx, parsed.sceneId, parsed.tx, parsed.ty);
    case "explored":
      return value ? projectExploredCtx(ctx, value as FogTile) : null;
    case "sight":
      return projectSightCtx(ctx, parsed.sceneId, parsed.tx, parsed.ty);
    case "sightAll":
      return projectSightAllCtx(ctx, parsed.sceneId, parsed.tx, parsed.ty);
    case "fogAll":
      return projectFogAllCtx(ctx, parsed.sceneId, parsed.tx, parsed.ty);
    case "exploredAny":
      return projectExploredAnyCtx(ctx, parsed.sceneId, parsed.tx, parsed.ty);
    // A holder's layer reaches them only merged into their fog (projectFogCtx), and the DM only joined (exploredAny).
    case "exploredBy":
      return null;
    // What players remember and the scenes' marks reach no viewer's projection, the DM's included: only the room export
    // carries them (docs/design/design-v1-map-discovery.md 11, rule 3).
    case "memory":
    case "memoryBy":
    case "played":
    case "memoryShared":
      return null;
    case "holders":
      return value ? projectHoldersCtx(ctx, value as SightHolders) : null;
    case "fogDraft":
      return value ? projectFogDraftCtx(ctx, value as FogDraft) : null;
    case "label":
      return value ? projectLabelCtx(ctx, value as Label) : projectRememberedCtx(ctx, "labels", parsed.id);
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
      return value ? projectStampCtx(ctx, value as Stamp) : projectRememberedCtx(ctx, "stamps", parsed.id);
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
    case "saveOutcome":
      return ctx.viewer.role === "dm" ? value : null;
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
    case "clock":
      return projectClockCtx(ctx);
    case "sound":
      return value ? projectSoundCtx(ctx, value as Sound) : null;
    case "playlist":
      return ctx.viewer.role === "dm" ? value : null;
    case "playing":
      return projectPlayingCtx(ctx);
    case "meta":
      return projectMetaCtx(ctx);
  }
}

/*
 * Synced music and sound (docs/design/design-v1-music.md 6.5). The DM gets
 * the library, the playlists and what plays whole. A player, a table
 * display and a View as preview get only what sounds now: the music's
 * `now` and its `next` once revealed, the loops, and the effects fired in
 * the open whose sounds are still Effects, each sound cut to what playing
 * it needs, and a name only for `now` and the loops while the DM turns on
 * Players see what is playing. Never the library, a playlist, the run's
 * order, its place in it or a pause's position, a scene's sound, an effect
 * fired behind a blackout or while Only DM devices play, an effect's name,
 * or the next track's name. Behind a blackout, and while the DM turns on
 * Only DM devices play (docs/design/design-v1-sound-dm-only.md 8), nothing:
 * the setting reaches them, and no sound entry or file does. Each revision
 * is 0, so a count of the DM's changes never shows. The projection reads no
 * clock: the server's ticks write what plays.
 */

/** The run as players get it: what plays and how, with no order, place or label, and nothing while paused. */
function playersMusic(state: RoomState, music: MusicRun | null): MusicRun | null {
  if (music === null || music.paused !== undefined) return null;
  const sounds = state.sounds;
  if (lengthAs(sounds, music.now.soundId, "music") === undefined) return null;
  const next = music.next !== undefined && lengthAs(sounds, music.next.soundId, "music") !== undefined ? music.next : undefined;
  return { run: music.run, repeat: music.repeat, fade: music.fade, now: music.now, ...(next ? { next } : {}) };
}

/** What plays as players get it, or null behind a blackout, while Only DM devices play, and when nothing does. */
function playersPlaying(ctx: Ctx): Playing | null {
  const playing = ctx.state.playing;
  if (!playing || ctx.paused || ctx.state.meta.settings.soundDmOnly === true) return null;
  const sounds = ctx.state.sounds;
  const loops: Playing["loops"] = {};
  for (const [id, loop] of Object.entries(playing.loops)) if (lengthAs(sounds, loop.soundId, "loop") !== undefined) loops[id] = loop;
  // An entry whose sound is gone or now has another use is history: it stops wherever it sounds (6.3).
  const effects = playing.effects.filter((e: FiredEffect) => e.builtin !== undefined || (e.soundId !== undefined && lengthAs(sounds, e.soundId, "effect") !== undefined));
  return { rev: 0, music: playersMusic(ctx.state, playing.music), loops, effects, volume: playing.volume };
}

function projectPlayingCtx(ctx: Ctx): Playing | null {
  if (ctx.viewer.role === "dm") return ctx.state.playing ?? null;
  return playersPlaying(ctx);
}

/** The sounds a player's projection names, each with whether its name goes too. */
function soundsNamed(ctx: Ctx): Map<SoundId, boolean> {
  const out = new Map<SoundId, boolean>();
  const playing = playersPlaying(ctx);
  if (!playing) return out;
  const names = ctx.state.meta.settings.soundNames === true;
  if (playing.music) {
    out.set(playing.music.now.soundId, names);
    if (playing.music.next && !out.has(playing.music.next.soundId)) out.set(playing.music.next.soundId, false);
  }
  for (const loop of Object.values(playing.loops)) out.set(loop.soundId, names);
  for (const effect of playing.effects) if (effect.soundId !== undefined && !out.has(effect.soundId)) out.set(effect.soundId, false);
  return out;
}

function projectSoundCtx(ctx: Ctx, sound: Sound): Sound | null {
  if (ctx.viewer.role === "dm") return sound;
  const named = soundsNamed(ctx).get(sound.id);
  return named === undefined ? null : playersSound(sound, named);
}

/** A sound cut to what playing it needs, its name only when the DM shares it. */
function playersSound(sound: Sound, named: boolean): Sound {
  const out: Sound = { id: sound.id, rev: 0, assetId: sound.assetId, ms: sound.ms, use: sound.use };
  if (sound.level !== undefined) out.level = sound.level;
  if (named && sound.name !== undefined) out.name = sound.name;
  return out;
}

/** The library, the playlists and what plays as fields of a projection, each only while it holds something, so a room without sound projects as it always did. */
function soundFields(ctx: Ctx): Pick<ProjectedState, "sounds" | "playlists" | "playing"> {
  const out: Pick<ProjectedState, "sounds" | "playlists" | "playing"> = {};
  const playing = projectPlayingCtx(ctx);
  if (playing) out.playing = playing;
  if (ctx.viewer.role === "dm") {
    if (ctx.state.sounds && Object.keys(ctx.state.sounds).length > 0) out.sounds = ctx.state.sounds;
    if (ctx.state.playlists && Object.keys(ctx.state.playlists).length > 0) out.playlists = ctx.state.playlists as Record<string, Playlist>;
    return out;
  }
  const sounds: Record<SoundId, Sound> = {};
  for (const [id, named] of soundsNamed(ctx)) {
    const sound = Object.hasOwn(ctx.state.sounds ?? {}, id) ? ctx.state.sounds![id] : undefined;
    if (sound) sounds[id] = playersSound(sound, named);
  }
  if (Object.keys(sounds).length > 0) out.sounds = sounds;
  return out;
}

/**
 * The room's clock (docs/design/design-v1-calendar.md 6.4): the DM's whole. A
 * player and a table display get its id, time and calendar while it is
 * shown, and nothing of it otherwise. Rev 0, so its number never tells how
 * often a hidden clock moved. A running fight's seconds come from the
 * round, which every player already gets, so a shown clock read with them
 * tells nothing more. Behind a blackout a player gets none, as they get no
 * encounter: the clock read without the fight's rounds would show the wrong
 * time, and a blackout's global re-projection brings both back together.
 */
function projectClockCtx(ctx: Ctx): ProjectedClock | null {
  const clock = ctx.state.clock;
  if (!clock) return null;
  if (ctx.viewer.role === "dm") return clock;
  if (ctx.paused) return null;
  return clock.shown ? { id: clock.id, rev: 0, t: clock.t, calendar: clock.calendar } : null;
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
  return projectStateCtx(ctxOf(state, viewer, opts));
}

function projectStateCtx(ctx: Ctx): ProjectedState {
  const { state, viewer } = ctx;
  return {
    meta: projectMetaCtx(ctx),
    members: projectMap(state.members, (m) => projectMemberCtx(ctx, m)),
    scenes: projectMap(state.scenes, (s) => projectSceneCtx(ctx, s)),
    buildChunks: projectChunksCtx(ctx),
    labels: projectByMemoryCtx(ctx, "labels", state.labels, (l) => projectLabelCtx(ctx, l)),
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
    stamps: projectByMemoryCtx(ctx, "stamps", state.stamps, (st) => projectStampCtx(ctx, st)),
    lights: projectMap(state.lights, (l) => projectLightCtx(ctx, l)),
    exploredTiles: projectMap(state.exploredTiles, (t) => projectExploredCtx(ctx, t)),
    journal: projectMap(state.journal, (page) => projectJournalCtx(ctx, page)),
    pins: projectMap(state.pins, (pin) => projectPinCtx(ctx, pin)),
    rolls: projectMap(state.rolls, (request) => projectRollCtx(ctx, request)),
    handoutDocs: projectMap(state.handoutDocs, (doc) => projectHandoutDocCtx(ctx, doc)),
    companionBlocks: projectMap(state.companionBlocks, (block) => projectCompanionBlockCtx(ctx, block)),
    casts: projectMap(state.casts, (ask) => projectCastCtx(ctx, ask)),
    ...(viewer.role === "dm" && state.saveOutcomes !== undefined ? { saveOutcomes: state.saveOutcomes } : {}),
    traps: projectMap(state.traps ?? {}, (trap) => projectTrapCtx(ctx, trap)),
    trapLog: viewer.role === "dm" ? (state.trapLog ?? []) : [],
    trapSeen: (state.trapSeen ?? []).map((e) => projectTrapSeenCtx(ctx, e)).filter((e): e is LogEntry => e !== null),
    sight: sightTilesCtx(ctx),
    ...perPlayerMapsCtx(ctx),
    ...clockField(ctx),
    ...soundFields(ctx),
  };
}

/** The clock as a field only while the viewer gets one, so a room without it projects as it always did (keys.ts writeEntity). */
function clockField(ctx: Ctx): Pick<ProjectedState, "clock"> {
  const clock = projectClockCtx(ctx);
  return clock ? { clock } : {};
}

/**
 * The maps only a projection of a per-player scene holds
 * (docs/design/design-v1-per-player-vision.md 6.2), each only while it holds
 * anything, so a whole-party scene projects as it always did and a change
 * that empties one takes it away (keys.ts writeEntity): `sightAll` with
 * vision on, `fogAll`, and the DM's `exploredAny` and holder list. Every
 * viewer gets `fogAll`, the DM too, so a device reads what every viewer
 * shares from it alone, and one that holds no tile there finds it fully
 * fogged.
 */
function perPlayerMapsCtx(ctx: Ctx): Pick<ProjectedState, "sightAll" | "fogAll" | "exploredAny" | "holders"> {
  const sceneId = ctx.sceneId;
  const scene = sceneId === null ? undefined : ownEntry(ctx.state.scenes, sceneId);
  if (sceneId === null || !scene || !perPlayerScene(scene)) return {};
  const out: Pick<ProjectedState, "sightAll" | "fogAll" | "exploredAny" | "holders"> = {};
  if (visionOn(scene)) {
    const sightAll: SightMap = {};
    for (const [at, tile] of visionRules.holderSight(ctx.state, sceneId, null).tiles) sightAll[`${sceneId}:${at}`] = tile;
    if (Object.keys(sightAll).length > 0) out.sightAll = sightAll;
  }
  const tiles = (each: (tx: number, ty: number) => FogTile | null, keyed: Iterable<{ sceneId: string; tx: number; ty: number }>) => {
    const map: Record<string, FogTile> = {};
    for (const t of keyed) {
      if (t.sceneId !== sceneId) continue;
      const key = tileKey(sceneId, t.tx, t.ty);
      if (key in map) continue;
      const tile = each(t.tx, t.ty);
      if (tile) map[key] = tile;
    }
    return map;
  };
  const fogAll = tiles((tx, ty) => projectFogAllCtx(ctx, sceneId, tx, ty), [...Object.values(ctx.state.fogTiles), ...Object.values(ctx.state.exploredTiles ?? {})]);
  if (Object.keys(fogAll).length > 0) out.fogAll = fogAll;
  if (ctx.viewer.role === "dm") {
    const exploredAny = tiles((tx, ty) => projectExploredAnyCtx(ctx, sceneId, tx, ty), Object.values(ctx.state.exploredBy ?? {}));
    if (Object.keys(exploredAny).length > 0) out.exploredAny = exploredAny;
    const list = ownEntry(ctx.state.holders, sceneId);
    if (list) out.holders = { [sceneId]: list };
  }
  return out;
}

/** The viewer's scene's fog tiles, each key any layer they read holds (projectFogCtx): a holder's own layer too. */
function projectFogTilesCtx(ctx: Ctx): Record<string, FogTile> {
  const out: Record<string, FogTile> = {};
  const own = ctx.viewer.role === "player" && ctx.sceneId !== null ? holderLayer(ctx.state, ctx.sceneId, ctx.viewer.memberId) : {};
  for (const layer of [ctx.state.fogTiles, ctx.state.exploredTiles ?? {}, own]) {
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
  const out: EntityKey[] = [keys.meta, keys.encounter, keys.encounterHistory, keys.clock, keys.playing];
  for (const id of Object.keys(state.sounds ?? {})) out.push(keys.sound(id));
  for (const id of Object.keys(state.playlists ?? {})) out.push(keys.playlist(id));
  for (const id of Object.keys(state.members)) out.push(keys.member(id));
  for (const id of Object.keys(state.scenes)) out.push(keys.scene(id));
  for (const c of Object.values(state.buildChunks)) out.push(keys.chunk(c.sceneId, c.cx, c.cy));
  // On a scene with fog on every position may hold a stub (docs/design/design-v1-map-discovery.md 5.6), and memory can name labels and stamps the build no longer has.
  const chunkKeys = new Set(Object.values(state.buildChunks).map((c) => keys.chunk(c.sceneId, c.cx, c.cy)));
  for (const scene of Object.values(state.scenes)) {
    if (!scene.fogEnabled) continue;
    for (const { cx, cy } of chunkPositions(scene)) {
      const key = keys.chunk(scene.id, cx, cy);
      if (!chunkKeys.has(key)) out.push(key);
    }
    for (const id of rememberedOnly(state, scene.id, "labels")) out.push(keys.label(id));
    for (const id of rememberedOnly(state, scene.id, "stamps")) out.push(keys.stamp(id));
  }
  for (const id of Object.keys(state.labels)) out.push(keys.label(id));
  for (const t of Object.values(state.fogTiles)) out.push(keys.fog(t.sceneId, t.tx, t.ty));
  // A tile only the party explored is still a fog tile to players (projectFogCtx).
  for (const [key, t] of Object.entries(state.exploredTiles ?? {})) {
    out.push(keys.explored(t.sceneId, t.tx, t.ty));
    if (!ownEntry(state.fogTiles, key)) out.push(keys.fog(t.sceneId, t.tx, t.ty));
  }
  out.push(...sightKeys(state));
  out.push(...perPlayerKeys(state));
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
  for (const id of Object.keys(state.saveOutcomes ?? {})) out.push(keys.saveOutcome(id));
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
 * The keys per-player vision adds a projection may hold
 * (docs/design/design-v1-per-player-vision.md 7.5): each holder list, a fog tile
 * only a holder's layer holds, and on each per-player scene the shared
 * sight's tiles (every tile inside its bounds on the server's state, as for
 * sight), the shared fog's and the holders' layers joined. A projection
 * holds its own maps. None on a room with no per-player scene.
 */
function perPlayerKeys(state: RoomState): EntityKey[] {
  const out: EntityKey[] = [];
  for (const id of Object.keys(state.holders ?? {})) out.push(keys.holders(id));
  if (sightOf(state) !== undefined) {
    const maps = viewMapsOf(state);
    for (const key of Object.keys(maps.sightAll ?? {})) out.push(`sightAll:${key}`);
    for (const key of Object.keys(maps.fogAll ?? {})) out.push(`fogAll:${key}`);
    for (const key of Object.keys(maps.exploredAny ?? {})) out.push(`exploredAny:${key}`);
    return out;
  }
  const own = new Set<string>();
  for (const t of Object.values(state.exploredBy ?? {})) {
    const key = tileKey(t.sceneId, t.tx, t.ty);
    if (own.has(key)) continue;
    own.add(key);
    if (!ownEntry(state.fogTiles, key) && !ownEntry(state.exploredTiles, key)) out.push(keys.fog(t.sceneId, t.tx, t.ty));
    if (perPlayerScene(ownEntry(state.scenes, t.sceneId))) out.push(keys.exploredAny(t.sceneId, t.tx, t.ty));
  }
  for (const scene of Object.values(state.scenes)) {
    if (!perPlayerScene(scene)) continue;
    if (visionOn(scene)) {
      for (let ty = 0; ty < tilesAcross(scene.bounds.h); ty++) for (let tx = 0; tx < tilesAcross(scene.bounds.w); tx++) out.push(keys.sightAll(scene.id, tx, ty));
    }
    const shared = new Set<string>();
    for (const t of [...Object.values(state.fogTiles), ...Object.values(state.exploredTiles ?? {})]) {
      const key = tileKey(t.sceneId, t.tx, t.ty);
      if (t.sceneId !== scene.id || shared.has(key)) continue;
      shared.add(key);
      out.push(keys.fogAll(t.sceneId, t.tx, t.ty));
    }
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
 * (tileDependents). On hex scenes, the tokens around a written chunk
 * (wallDependents), and with fog on those round every player chunk whose
 * walls a write can change, since each viewer's copy of them clips a
 * creature's outline (heldSightClip). With both states of a batch, scene
 * changes invalidate all chunk positions only when their projection inputs
 * differ.
 */
export function dependents(state: RoomState, touched: EntityKey[], other?: RoomState): EntityKey[] {
  const seen = new Set(touched);
  const out: EntityKey[] = [];
  const add = (key: EntityKey) => {
    if (!seen.has(key)) {
      seen.add(key);
      out.push(key);
    }
  };
  // Current ownership and sight can narrow a frozen correction's readers without editing its log row.
  if (touched.some((key) => !key.startsWith("log:"))) {
    for (const line of state.log) if (line.data?.type === "correction") add(keys.log(line.id));
  }
  // The DM's projected meta carries retained HP undo ids, which can change
  // when a log line is added or dropped without changing the stored meta.
  if (touched.some((key) => key.startsWith("log:"))) add(keys.meta);
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
  // An owner's route corners on a per-player scene read their own fog, and on any scene with fog and vision on their live
  // ground along the whole leg (projectPathCtx, decision 12), so a layer or a sight they read re-projects their tokens with
  // a path there: every owned one for the party's layer or any sight, a holder's own for theirs. A token's own tiles are
  // not enough, since a leg runs far from where it stands (MD2-ASTRA-5).
  const cornered = new Set<string>();
  const cornersOn = (sceneId: string, memberId: string | null) => {
    const at = partsKey([sceneId, memberId]);
    if (cornered.has(at)) return;
    cornered.add(at);
    for (const token of Object.values(state.tokens)) {
      if (token.sceneId !== sceneId || !token.path) continue;
      if (memberId === null ? playerOwned(state, token) : ownsToken(state, { memberId, role: "player" }, token)) add(keys.token(token.id));
    }
  };
  // A player gets a token's path only while it is the path of the turn under way and of a row they see (projectPathCtx).
  if (touched.includes(keys.encounter)) {
    for (const token of Object.values(state.tokens)) if (token.path) add(keys.token(token.id));
  }
  /*
   * On a scene with fog on a player's chunk at a position reads the stored
   * and remembered chunks of its 8 neighbors, since a piece filed by its
   * own midpoint lies up to 4 cells from the chunk its wall is stored in,
   * and an edge reads the cells beside it (docs/design/design-v1-map-discovery.md
   * 5.6). Stubs count, so every position of the scene is a key.
   */
  const fogScene = (sceneId: string) => ownEntry(state.scenes, sceneId)?.fogEnabled === true;
  const visionScene = (sceneId: string) => fogScene(sceneId) && ownEntry(state.scenes, sceneId)?.vision?.on === true;
  const aroundChunk = (sceneId: string, cx: number, cy: number) => {
    const scene = ownEntry(state.scenes, sceneId);
    if (!scene) return;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) if (inPositions(scene, cx + dx, cy + dy)) add(keys.chunk(sceneId, cx + dx, cy + dy));
  };
  // The positions whose chunk reads a fog tile (positionTiles), each tile's worked out once, since on hexes it reads every position.
  const reading = new Map<string, { cx: number; cy: number }[]>();
  const readingTile = (scene: Scene, tx: number, ty: number) => {
    const at = partsKey([scene.id, tx, ty]);
    let out = reading.get(at);
    if (!out) reading.set(at, (out = positionsReading(scene, tx, ty)));
    return out;
  };
  const aroundTile = (sceneId: string, tx: number, ty: number) => {
    const scene = ownEntry(state.scenes, sceneId);
    if (scene) for (const { cx, cy } of readingTile(scene, tx, ty)) add(keys.chunk(sceneId, cx, cy));
  };
  const stairScenes = new Set<string>();
  const wallChunks: { sceneId: string; cx: number; cy: number }[] = [];
  // On a hex scene with fog on, the player chunks a fog, explored or memory write changes, or a sight change where memory
  // is: every viewer's copy of their walls clips the creatures round them, and each copy carries the seenAll mark.
  const heldHex = (sceneId: string) => fogScene(sceneId) && isHex(gridOfScene(state, sceneId));
  const copyAround = (sceneId: string, cx: number, cy: number) => {
    if (heldHex(sceneId)) for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) wallChunks.push({ sceneId, cx: cx + dx, cy: cy + dy });
  };
  const copyOnTile = (sceneId: string, tx: number, ty: number) => {
    const scene = ownEntry(state.scenes, sceneId);
    if (scene && heldHex(sceneId)) for (const { cx, cy } of readingTile(scene, tx, ty)) wallChunks.push({ sceneId, cx, cy });
  };
  soundDependents(state, touched, add);
  for (const key of touched) {
    const parsed = parseKey(key);
    if (!parsed) continue;
    if (parsed.kind === "chunk") {
      if (isHex(gridOfScene(state, parsed.sceneId))) wallChunks.push(parsed);
      if (fogScene(parsed.sceneId)) {
        aroundChunk(parsed.sceneId, parsed.cx, parsed.cy);
        stairScenes.add(parsed.sceneId);
        continue;
      }
      // A player's chunk reads the cells beside its north and west borders (projectChunkForPlayer).
      for (const [cx, cy] of [
        [parsed.cx + 1, parsed.cy],
        [parsed.cx, parsed.cy + 1],
      ] as const) {
        if (ownEntry(state.buildChunks, chunkKey(parsed.sceneId, cx, cy))) add(keys.chunk(parsed.sceneId, cx, cy));
      }
    } else if (parsed.kind === "memory" || parsed.kind === "memoryBy") {
      // What players remember shows in their chunks there and around, and in the labels and stamps it names (5.6).
      aroundChunk(parsed.sceneId, parsed.cx, parsed.cy);
      copyAround(parsed.sceneId, parsed.cx, parsed.cy);
      const chunk = readEntity(state, key) as MemoryChunk | null;
      for (const id of Object.keys(chunk?.labels ?? {})) add(keys.label(id));
      for (const id of Object.keys(chunk?.stamps ?? {})) add(keys.stamp(id));
    } else if (parsed.kind === "scene") {
      // Comparing both sides avoids rebuilding a scene for a name or walls-version write.
      // Callers with one state keep the conservative dependency set.
      const scene = ownEntry(state.scenes, parsed.id);
      const was = ownEntry(other?.scenes, parsed.id);
      if (scene?.fogEnabled && (!was || sceneFields(scene) !== sceneFields(was) || stableStringify(scene.vision) !== stableStringify(was.vision))) {
        for (const { cx, cy } of chunkPositions(scene)) add(keys.chunk(scene.id, cx, cy));
      }
      // Every chunk of a viewer's copy reads the scene's fields, so on hexes each creature's outline may clip anew.
      if (scene && heldHex(scene.id) && (!was || sceneFields(scene) !== sceneFields(was))) {
        for (const token of Object.values(state.tokens)) {
          if (token.sceneId !== scene.id) continue;
          add(keys.token(token.id));
          tokenIds.add(token.id);
        }
      }
    } else if (parsed.kind === "fog") copyOnTile(parsed.sceneId, parsed.tx, parsed.ty);
    else if (parsed.kind === "explored") {
      add(keys.fog(parsed.sceneId, parsed.tx, parsed.ty));
      onTile(parsed.sceneId, parsed.tx, parsed.ty);
      copyOnTile(parsed.sceneId, parsed.tx, parsed.ty);
      if (fogScene(parsed.sceneId)) aroundTile(parsed.sceneId, parsed.tx, parsed.ty);
      // Every player's fog reads the party's layer, and on a per-player scene so do the shared fog and every owner's
      // route corners (docs/design/design-v1-per-player-vision.md 7.5).
      if (perPlayerScene(ownEntry(state.scenes, parsed.sceneId))) add(keys.fogAll(parsed.sceneId, parsed.tx, parsed.ty));
      if (perPlayerScene(ownEntry(state.scenes, parsed.sceneId)) || visionScene(parsed.sceneId)) cornersOn(parsed.sceneId, null);
    } else if (parsed.kind === "exploredBy") {
      // A holder's layer reaches them merged into their fog, and the DM joined with the others' (7.5).
      add(keys.fog(parsed.sceneId, parsed.tx, parsed.ty));
      add(keys.exploredAny(parsed.sceneId, parsed.tx, parsed.ty));
      onTile(parsed.sceneId, parsed.tx, parsed.ty);
      copyOnTile(parsed.sceneId, parsed.tx, parsed.ty);
      cornersOn(parsed.sceneId, parsed.memberId);
      if (fogScene(parsed.sceneId)) aroundTile(parsed.sceneId, parsed.tx, parsed.ty);
    } else if (parsed.kind === "sight" || parsed.kind === "sightAll") {
      onTile(parsed.sceneId, parsed.tx, parsed.ty);
      if (visionScene(parsed.sceneId)) cornersOn(parsed.sceneId, null);
      // Sight decides live or remembered only where some memory has entries (MD-O-24).
      if (fogScene(parsed.sceneId) && hasMemory(state, parsed.sceneId)) {
        aroundTile(parsed.sceneId, parsed.tx, parsed.ty);
        copyOnTile(parsed.sceneId, parsed.tx, parsed.ty);
      }
    }
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
  if (wallChunks.length > 0) wallDependents(state, wallChunks, add, tokenIds);
  // A stair's direction reads the scene's whole stair map, so a build edit can turn a stair chunks away (ASTRA-4): every chunk with a stair goes again.
  for (const sceneId of stairScenes) for (const key of stairChunkKeys(state, sceneId)) add(key);
  for (const token of Object.values(state.tokens)) {
    if ("ref" in token.actor && characterIds.has(token.actor.ref)) {
      add(keys.token(token.id));
      tokenIds.add(token.id);
    }
  }
  // A character's Ready trigger reaches players while a player owns any token of it (playerPlays), so a token placed or
  // removed re-projects its character. A change of owners re-projects everything anyway (Tx global).
  for (const id of tokenIds) {
    const token = ownEntry(state.tokens, id);
    if (token && "ref" in token.actor) add(keys.character(token.actor.ref));
  }
  // A carried token's link reaches a player while they see its holder (linkShown), so the holder's change re-projects it.
  // Hidden links count here too, but only to choose what to project again: each copy is still projected by its own rule,
  // and only what changed in it is sent (docs/design/design-v1-attach.md 8.0).
  for (const token of Object.values(state.tokens)) if (token.attached && tokenIds.has(token.attached.to)) add(keys.token(token.id));
  // So does a mount sharing the turn, in the turn's start.
  if (state.encounter?.turnStart?.mounts?.some((id) => tokenIds.has(id))) {
    add(keys.encounter);
    encounterTouched = true;
  }
  // A path of the turn reaches a player while they see the turn's row, which follows the turn's own creature (projectPathCtx).
  // A mount sharing the turn moves on a path of its own (docs/design/design-v1-attach.md 7.2), so the creature's change, into
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
  // An ask reaches a player through its caster, and its targets and area follow what they see (docs/design/design-v1-player-save-spell.md 5.5).
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
    // A dice line names a creature in each roll (docs/design/design-v1-dice.md 5.2).
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
 * What a change of sound re-projects for players (docs/design/design-v1-music.md
 * 6.5). The fan-out asks with each side of a batch, so the sounds a write
 * of `playing` names before and after both go again: a newly named sound
 * arrives in the same batch, and one no longer named leaves. A sound whose
 * use changed, by its op, an Undo or a Redo, re-projects `playing` while
 * either effect list names it, so its entry leaves players' lists, and
 * its voice stops, in that batch (MSOL-38). Names follow `soundNames`, a
 * setting, whose change re-projects everything (Tx global).
 */
function soundDependents(state: RoomState, touched: readonly EntityKey[], add: (key: EntityKey) => void): void {
  const playing = state.playing;
  if (!playing) return;
  let sounds: Set<SoundId> | null = null;
  for (const key of touched) {
    if (key === keys.playing) {
      if (playing.music) {
        add(keys.sound(playing.music.now.soundId));
        if (playing.music.next) add(keys.sound(playing.music.next.soundId));
      }
      for (const loop of Object.values(playing.loops)) add(keys.sound(loop.soundId));
      for (const effect of [...playing.effects, ...(playing.dmEffects ?? [])]) if (effect.soundId !== undefined) add(keys.sound(effect.soundId));
      continue;
    }
    if (!key.startsWith("sound:")) continue;
    sounds ??= new Set([...playing.effects, ...(playing.dmEffects ?? [])].flatMap((e) => (e.soundId !== undefined ? [e.soundId] : [])));
    if (sounds.has(key.slice("sound:".length))) add(keys.playing);
  }
}

/**
 * What can change for players where the party's explored layer was written
 * or its sight changed (docs/design/design-v1-maps-vision.md 4.3.3 and 4.3.5): the
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
 * DM dropped it off the grid. On a hex scene both read the sub-cells inside
 * its hexes, so it counts by the cells those lie in, which reach past its
 * box where it was dropped off its anchor (docs/design/design-v1-hex-grids.md
 * HX-D10).
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
    const grid = gridOfToken(state, token);
    const cells = occupiedRange(grid, token);
    const seen = grid.shape === "hex" ? null : sightRect(token);
    const r = seen ? { x0: Math.min(cells.x0, Math.floor(seen.x0)), y0: Math.min(cells.y0, Math.floor(seen.y0)), x1: Math.max(cells.x1, Math.ceil(seen.x1)), y1: Math.max(cells.y1, Math.ceil(seen.y1)) } : cells;
    if (!on(token.sceneId, r)) continue;
    add(keys.token(token.id));
    tokenIds.add(token.id);
  }
  for (const label of Object.values(state.labels)) if (on(label.sceneId, labelCells(label))) add(keys.label(label.id));
  for (const stamp of Object.values(state.stamps)) if (on(stamp.sceneId, stampCells(stamp))) add(keys.stamp(stamp.id));
  // A remembered label or stamp is judged by its remembered box too, wherever the live one stands (docs/design/design-v1-map-discovery.md 5.3).
  for (const all of [state.memory, state.memoryBy]) {
    for (const chunk of Object.values(all ?? {})) {
      if (!tiles.has(chunk.sceneId)) continue;
      for (const [id, label] of Object.entries(chunk.labels ?? {})) if (label && on(chunk.sceneId, labelCells(label))) add(keys.label(id));
      for (const [id, stamp] of Object.entries(chunk.stamps ?? {})) if (stamp && on(chunk.sceneId, stampCells(stamp))) add(keys.stamp(id));
    }
  }
  for (const pin of Object.values(state.pins)) if (on(pin.sceneId, pinCells(pin))) add(keys.pin(pin.id));
  for (const trap of Object.values(state.traps ?? {})) if (zoneRanges(state, trap.sceneId, trap.zone).some((r) => on(trap.sceneId, r))) add(keys.trap(trap.id));
}

/**
 * The tokens a wall change on a hex scene can show or withhold without
 * moving them (docs/design/design-v1-hex-grids.md HX-D22). The wall clip
 * (HX-D10) reads the sight walls through a creature's hexes, so this adds
 * every token whose footprint box meets a written chunk or one of its 8
 * neighbors, whatever vision and fog do. Every op that changes walls writes the chunks they are
 * stored in, a restore too. Eight neighbors suffice, since a free wall
 * reaches at most 4 cells past its chunk and a footprint is at most 4 cells
 * across. A written chunk is no global change: a Wall line stroke would
 * project the whole room again.
 */
function wallDependents(state: RoomState, chunks: readonly { sceneId: string; cx: number; cy: number }[], add: (key: EntityKey) => void, tokenIds: Set<string>): void {
  const boxes = new Map<string, CellRange[]>();
  for (const { sceneId, cx, cy } of chunks) {
    let list = boxes.get(sceneId);
    if (!list) boxes.set(sceneId, (list = []));
    list.push({ x0: (cx - 1) * CHUNK_CELLS, y0: (cy - 1) * CHUNK_CELLS, x1: (cx + 2) * CHUNK_CELLS, y1: (cy + 2) * CHUNK_CELLS });
    // On hexes the chunk's heights and stairs raise the sides of its hexes, whose world box lies elsewhere than its free walls' world chunk (HX-D22).
    const g = gridOfScene(state, sceneId);
    const held = ownEntry(state.buildChunks, chunkKey(sceneId, cx, cy));
    if (isHex(g) && (held?.heights !== undefined || held?.up !== undefined)) list.push(hexChunkBox(g, cx, cy, CHUNK_CELLS));
  }
  for (const token of Object.values(state.tokens)) {
    const list = boxes.get(token.sceneId);
    if (!list) continue;
    const r = footprintRect(gridOfToken(state, token), token);
    if (!list.some((b) => r.x <= b.x1 && r.x + r.w >= b.x0 && r.y <= b.y1 && r.y + r.h >= b.y0)) continue;
    add(keys.token(token.id));
    tokenIds.add(token.id);
  }
}

/** The world box of a hex chunk's hexes, grown `margin` cells each way: from its first and last keys' centers, which the odd rows' or columns' shift stays inside. */
function hexChunkBox(g: HexGrid, cx: number, cy: number, margin: number): CellRange {
  const a = hexCenter(g, { col: cx * CHUNK_CELLS, row: cy * CHUNK_CELLS });
  const b = hexCenter(g, { col: (cx + 1) * CHUNK_CELLS - 1, row: (cy + 1) * CHUNK_CELLS - 1 });
  // A hexagon reaches HEX_R past its center at its points and half a cell at its flat sides.
  const reach = margin + HEX_R;
  return { x0: Math.min(a.x, b.x) - reach, y0: Math.min(a.y, b.y) - reach, x1: Math.max(a.x, b.x) + reach, y1: Math.max(a.y, b.y) + reach };
}

/** Whether any layer's memory of a scene has entries. */
function hasMemory(state: RoomState, sceneId: string): boolean {
  for (const all of [state.memory, state.memoryBy]) for (const chunk of Object.values(all ?? {})) if (chunk.sceneId === sceneId) return true;
  return false;
}

/** The chunk keys of a scene whose chunk holds a stair: a mark or painted stairs. */
function stairChunkKeys(state: RoomState, sceneId: string): EntityKey[] {
  const out: EntityKey[] = [];
  for (const chunk of sceneChunkList(state.buildChunks, sceneId)) {
    if (hasStairs(chunk)) out.push(keys.chunk(sceneId, chunk.cx, chunk.cy));
  }
  return out;
}

/**
 * The sight tile keys whose value differs between two states, on each of
 * the given scenes (docs/design/design-v1-maps-vision.md 4.3.5): the narrow half
 * of the fan-out on vision scenes. With them as touched keys, `dependents`
 * adds the tokens, labels and stamps on those tiles. A tile the vision
 * cache kept is the same object in both, and one it computed again is
 * compared by content, so only a real change counts.
 */
export function changedSightKeys(before: RoomState, after: RoomState, sceneIds: Iterable<string>): EntityKey[] {
  const out: EntityKey[] = [];
  for (const sceneId of new Set(sceneIds)) {
    if (!visionOn(ownEntry(before.scenes, sceneId)) && !visionOn(ownEntry(after.scenes, sceneId))) continue;
    const sight = new Set<string>();
    diffSight(unionSightOf(before, sceneId).tiles, unionSightOf(after, sceneId).tiles, sight);
    // On a per-player scene each viewer's `sight` is one raster of several (docs/design/design-v1-per-player-vision.md 7.5): a
    // tile any of them changed on is a candidate for every viewer, and the shared sight's are `sightAll` too. A switch
    // of mode or of the holder list re-projects everything anyway (Tx global).
    if (perPlayerScene(ownEntry(before.scenes, sceneId)) && perPlayerScene(ownEntry(after.scenes, sceneId))) {
      const shared = new Set<string>();
      diffSight(visionRules.holderSight(before, sceneId, null).tiles, visionRules.holderSight(after, sceneId, null).tiles, shared);
      for (const at of shared) {
        sight.add(at);
        const [tx, ty] = at.split(",").map(Number) as [number, number];
        out.push(keys.sightAll(sceneId, tx, ty));
      }
      for (const id of new Set([...sightHolders(before, sceneId), ...sightHolders(after, sceneId)])) {
        diffSight(visionRules.holderSight(before, sceneId, id).tiles, visionRules.holderSight(after, sceneId, id).tiles, sight);
      }
    }
    for (const at of sight) {
      const [tx, ty] = at.split(",").map(Number) as [number, number];
      out.push(keys.sight(sceneId, tx, ty));
    }
  }
  return out;
}

/** Adds to `into` the places whose tile differs between two sights. A tile the vision cache kept is the same object in both. */
function diffSight(was: ReadonlyMap<string, SightTile>, now: ReadonlyMap<string, SightTile>, into: Set<string>): void {
  if (was === now) return;
  const changed = (at: string) => {
    const a = was.get(at);
    const b = now.get(at);
    if (a === b || (a && b && sameSightTile(a, b))) return;
    into.add(at);
  };
  for (const at of now.keys()) changed(at);
  for (const at of was.keys()) if (!now.has(at)) changed(at);
}

function sameSightTile(a: SightTile, b: SightTile): boolean {
  return "f" in a ? "f" in b && a.f === b.f : "b" in b && a.b === b.b;
}

/**
 * The assets a viewer's projection refers to (design 11.2). The server adds
 * the viewer's own uploads. Shipped icons name no asset and add nothing
 * (docs/design/design-v1-dm-tools.md 3.12).
 */
export function visibleAssetIds(state: RoomState, viewer: Viewer, opts: ProjectOpts): Set<string> {
  const ids = new Set<string>();
  const addImage = (image: Parameters<typeof imageAssetId>[0]) => {
    const id = imageAssetId(image);
    if (id !== undefined) ids.add(id);
  };
  const projected = projectState(state, viewer, opts);
  // A player's scene carries only the showing phase's video, on its map (docs/design/design-v1-animated-maps.md 7).
  for (const scene of Object.values(projected.scenes)) {
    if (scene.map) ids.add(scene.map.assetId);
    if (scene.map?.video) ids.add(scene.map.video.assetId);
  }
  for (const token of Object.values(projected.tokens)) {
    addImage(token.image);
    // Only the DM's and the owners' projections carry a token's other images, so a disguise's true face stays theirs.
    for (const image of token.altImages ?? []) addImage(image);
  }
  for (const character of Object.values(projected.characters)) addImage(character.defaultImage);
  // Every page of each handout the viewer gets, and no page of one they do not (docs/design/design-v1-pdf-handouts.md 3.4).
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
  // A player meets only the files of what sounds now, the next track and the effects in the open list, and the DM every
  // sound of the library (docs/design/design-v1-music.md 6.5). The asset routes serve no sound while the switch is off.
  for (const sound of Object.values(projected.sounds ?? {})) ids.add(sound.assetId);
  if (viewer.role === "dm") {
    // The DM may use every asset of the room, scenes it is not viewing included, every phase and thumbnail with them.
    for (const scene of Object.values(state.scenes)) {
      if (scene.map) ids.add(scene.map.assetId);
      if (scene.map?.video) ids.add(scene.map.video.assetId);
      for (const phase of scene.phases ?? []) {
        ids.add(phase.assetId);
        if (phase.video) ids.add(phase.video.assetId);
      }
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
 * gets (docs/design/design-v1-maps-vision.md 4.3.5).
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
