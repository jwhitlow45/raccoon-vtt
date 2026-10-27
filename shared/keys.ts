import {
  CHUNK_CELLS,
  type BuildChunk,
  type Encounter,
  type EncounterSnapshot,
  type ExploredTile,
  type FogDraft,
  type FogTile,
  type FreeWall,
  type LogEntry,
  type MemoryChunk,
  type RoomMeta,
  type RoomState,
  type SceneMark,
  type SightHolders,
  type SightTile,
} from "./model.ts";

/**
 * One entity key scheme for everything that names an entity outside the
 * state object itself: touched keys from the reducer, restore entries for
 * undo, the per-connection held map on the server, and the `changes` in an
 * `ev` message. The key says which collection an entity lives in, so a
 * generic read or write never has to guess.
 *
 * Ids are UUIDs (or server ids without colons), so splitting on the first
 * colon is safe. Log ids are `"<seq>:<index>"` and keep their inner colon,
 * which is why parsing takes the rest of the string after the kind.
 */
export type EntityKey = string;

export type ParsedKey =
  | { kind: "token"; id: string }
  | { kind: "scene"; id: string }
  | { kind: "member"; id: string }
  | { kind: "character"; id: string }
  | { kind: "template"; id: string }
  | { kind: "drawing"; id: string }
  | { kind: "label"; id: string }
  | { kind: "handout"; id: string }
  | { kind: "monster"; id: string }
  | { kind: "srdImage"; id: string }
  | { kind: "savedEncounter"; id: string }
  | { kind: "stamp"; id: string }
  | { kind: "light"; id: string }
  | { kind: "journal"; id: string }
  | { kind: "pin"; id: string }
  | { kind: "roll"; id: string }
  | { kind: "handoutDoc"; id: string }
  | { kind: "companionBlock"; id: string }
  | { kind: "cast"; id: string }
  | { kind: "trap"; id: string }
  | { kind: "log"; id: string }
  | { kind: "trapLog"; id: string }
  | { kind: "trapSeen"; id: string }
  | { kind: "chunk"; sceneId: string; cx: number; cy: number }
  | { kind: "fog"; sceneId: string; tx: number; ty: number }
  | { kind: "explored"; sceneId: string; tx: number; ty: number }
  | { kind: "sight"; sceneId: string; tx: number; ty: number }
  | { kind: "sightAll"; sceneId: string; tx: number; ty: number }
  | { kind: "fogAll"; sceneId: string; tx: number; ty: number }
  | { kind: "exploredAny"; sceneId: string; tx: number; ty: number }
  | { kind: "exploredBy"; sceneId: string; memberId: string; tx: number; ty: number }
  | { kind: "holders"; sceneId: string }
  | { kind: "fogDraft"; sceneId: string }
  /** `id` is the state map key, as for the kinds named by id, so code that files an entry by `id` files these right too. */
  | { kind: "memory"; id: string; sceneId: string; cx: number; cy: number }
  | { kind: "memoryBy"; id: string; sceneId: string; memberId: string; cx: number; cy: number }
  /** A scene's mark, by the scene's id. */
  | { kind: "played"; id: string }
  | { kind: "memoryShared"; id: string }
  | { kind: "encounter" }
  | { kind: "encounterHistory" }
  | { kind: "meta" };

export type EntityKind = ParsedKey["kind"];

export const keys = {
  token: (id: string): EntityKey => `token:${id}`,
  scene: (id: string): EntityKey => `scene:${id}`,
  member: (id: string): EntityKey => `member:${id}`,
  character: (id: string): EntityKey => `character:${id}`,
  template: (id: string): EntityKey => `template:${id}`,
  drawing: (id: string): EntityKey => `drawing:${id}`,
  label: (id: string): EntityKey => `label:${id}`,
  handout: (id: string): EntityKey => `handout:${id}`,
  monster: (id: string): EntityKey => `monster:${id}`,
  srdImage: (srdId: string): EntityKey => `srdImage:${srdId}`,
  savedEncounter: (id: string): EntityKey => `savedEncounter:${id}`,
  stamp: (id: string): EntityKey => `stamp:${id}`,
  light: (id: string): EntityKey => `light:${id}`,
  /** A journal page (RoomState.journal, wave 5). */
  journal: (id: string): EntityKey => `journal:${id}`,
  pin: (id: string): EntityKey => `pin:${id}`,
  /** An open roll request (RoomState.rolls, wave 5). */
  roll: (id: string): EntityKey => `roll:${id}`,
  /** A document of handout pages in the DM's library (RoomState.handoutDocs). */
  handoutDoc: (id: string): EntityKey => `handoutDoc:${id}`,
  /** A stat block a character keeps for its companions (RoomState.companionBlocks). */
  companionBlock: (id: string): EntityKey => `companionBlock:${id}`,
  /** A player's open ask for saves (RoomState.casts). */
  cast: (id: string): EntityKey => `cast:${id}`,
  /** A trap (RoomState.traps). */
  trap: (id: string): EntityKey => `trap:${id}`,
  log: (id: string): EntityKey => `log:${id}`,
  /** A line of the DM's trap log, and of the players' (RoomState.trapLog, RoomState.trapSeen). */
  trapLog: (id: string): EntityKey => `trapLog:${id}`,
  trapSeen: (id: string): EntityKey => `trapSeen:${id}`,
  chunk: (sceneId: string, cx: number, cy: number): EntityKey => `chunk:${sceneId}:${cx},${cy}`,
  fog: (sceneId: string, tx: number, ty: number): EntityKey => `fog:${sceneId}:${tx},${ty}`,
  /** A tile of the party's explored layer (RoomState.exploredTiles). */
  explored: (sceneId: string, tx: number, ty: number): EntityKey => `explored:${sceneId}:${tx},${ty}`,
  /** A tile of the party's sight, derived and never stored: only projections hold it (SightTile). */
  sight: (sceneId: string, tx: number, ty: number): EntityKey => `sight:${sceneId}:${tx},${ty}`,
  /**
   * Per-player vision (docs/design-v1-per-player-vision.md 7.5), each
   * derived and never stored: a tile of the shared sight, the same for
   * every viewer of a per-player scene, of the shared fog (the DM's and the
   * party's layers merged) as players get it there, and of every holder's
   * layer joined, the DM's.
   */
  sightAll: (sceneId: string, tx: number, ty: number): EntityKey => `sightAll:${sceneId}:${tx},${ty}`,
  fogAll: (sceneId: string, tx: number, ty: number): EntityKey => `fogAll:${sceneId}:${tx},${ty}`,
  exploredAny: (sceneId: string, tx: number, ty: number): EntityKey => `exploredAny:${sceneId}:${tx},${ty}`,
  /** A tile of one holder's own explored layer (RoomState.exploredBy). No projection holds it under this key. */
  exploredBy: (sceneId: string, memberId: string, tx: number, ty: number): EntityKey => `exploredBy:${sceneId}:${memberId}:${tx},${ty}`,
  /** A per-player scene's sight holder list (RoomState.holders), the DM's. */
  holders: (sceneId: string): EntityKey => `holders:${sceneId}`,
  fogDraft: (sceneId: string): EntityKey => `fogDraft:${sceneId}`,
  /** A chunk of the party's memory (RoomState.memory, docs/design-v1-map-discovery.md 5.3). No projection holds it. */
  memory: (sceneId: string, cx: number, cy: number): EntityKey => `memory:${sceneId}:${cx},${cy}`,
  /** A chunk of a holder's own memory (RoomState.memoryBy). No projection holds it. */
  memoryBy: (sceneId: string, memberId: string, cx: number, cy: number): EntityKey => `memoryBy:${sceneId}:${memberId}:${cx},${cy}`,
  /** A scene's played mark (RoomState.playedScenes, 5.5). */
  played: (sceneId: string): EntityKey => `played:${sceneId}`,
  /** A scene's mark that its memory takes a share of the room (RoomState.memoryShared, 5.5). */
  memoryShared: (sceneId: string): EntityKey => `memoryShared:${sceneId}`,
  encounter: "encounter" as EntityKey,
  encounterHistory: "encounterHistory" as EntityKey,
  meta: "meta" as EntityKey,
};

/** The state map key of a chunk, `"<sceneId>:<cx>,<cy>"`. */
export function chunkKey(sceneId: string, cx: number, cy: number): string {
  return `${sceneId}:${cx},${cy}`;
}

/** The cell a point lies in, as `"x,y"`. A point on a grid line belongs to the cell after it. */
export function cellOf(x: number, y: number): string {
  return `${Math.floor(x)},${Math.floor(y)}`;
}

/** A free wall's midpoint, which decides the chunk that holds it and the cell whose erase takes it. */
export function wallMidpoint(wall: Pick<FreeWall, "a" | "b">): [number, number] {
  return [(wall.a[0] + wall.b[0]) / 2, (wall.a[1] + wall.b[1]) / 2];
}

/**
 * The chunk a free wall lives in: the one that holds its midpoint
 * (docs/design-v1-maps-vision.md section 2.2). Ops name a free wall by its
 * chunk, so the imports and fixtures that build chunks themselves must file
 * each wall exactly where the reducer does.
 */
export function wallChunk(wall: Pick<FreeWall, "a" | "b">): { cx: number; cy: number } {
  const [mx, my] = wallMidpoint(wall);
  return { cx: Math.floor(mx / CHUNK_CELLS), cy: Math.floor(my / CHUNK_CELLS) };
}

/**
 * The chunk that holds a door (`door.set`): the chunk of a grid edge's
 * cell, where the build files its edges, or a free door's named chunk.
 */
export function doorChunk(door: { edge: string } | { cx: number; cy: number }): { cx: number; cy: number } {
  if ("cx" in door) return { cx: door.cx, cy: door.cy };
  const [x, y] = door.edge.split(",");
  return { cx: Math.floor(Number(x) / CHUNK_CELLS), cy: Math.floor(Number(y) / CHUNK_CELLS) };
}

/** The state map key of a fog tile, an explored tile or a sight tile, `"<sceneId>:<tx>,<ty>"`. */
export function tileKey(sceneId: string, tx: number, ty: number): string {
  return `${sceneId}:${tx},${ty}`;
}

/** The state map key of a tile of a holder's own explored layer (RoomState.exploredBy), `"<sceneId>:<memberId>:<tx>,<ty>"`. */
export function holderTileKey(sceneId: string, memberId: string, tx: number, ty: number): string {
  return `${sceneId}:${memberId}:${tx},${ty}`;
}

/** The state map key of a chunk of a holder's own memory (RoomState.memoryBy), `"<sceneId>:<memberId>:<cx>,<cy>"`. */
export function holderChunkKey(sceneId: string, memberId: string, cx: number, cy: number): string {
  return `${sceneId}:${memberId}:${cx},${cy}`;
}

/**
 * A projected state's sight tiles, keyed like fog tiles. The server's
 * RoomState never holds them, since sight is derived (docs/design-v1-maps-vision.md
 * 4.3.4), and a client's confirmed state always does, perhaps empty. So the
 * same reducer can tell where it runs: with them it reads what the server
 * sent, without them it computes.
 */
export type SightMap = Record<string, SightTile>;

/** The sight tiles a state holds: a projection's, or undefined on the server's own state. */
export function sightOf(state: RoomState): SightMap | undefined {
  return (state as RoomState & { sight?: SightMap }).sight;
}

/**
 * The maps only a projection of a per-player scene holds
 * (docs/design-v1-per-player-vision.md 6.2), keyed like fog tiles: the
 * shared sight, the shared fog as players get it, and every holder's layer
 * joined, the DM's. Each is absent from every other state.
 */
export type ViewMaps = { sightAll?: SightMap; fogAll?: Record<string, FogTile>; exploredAny?: Record<string, FogTile> };

export function viewMapsOf(state: RoomState): ViewMaps {
  return state as RoomState & ViewMaps;
}

const GRID_RE = /^(-?\d+),(-?\d+)$/;

export function parseKey(key: EntityKey): ParsedKey | null {
  const colon = key.indexOf(":");
  if (colon < 0) {
    if (key === "encounter" || key === "encounterHistory" || key === "meta") return { kind: key };
    return null;
  }
  const kind = key.slice(0, colon);
  const rest = key.slice(colon + 1);
  if (rest.length === 0) return null;
  switch (kind) {
    case "token":
    case "scene":
    case "member":
    case "character":
    case "template":
    case "drawing":
    case "label":
    case "handout":
    case "monster":
    case "srdImage":
    case "savedEncounter":
    case "stamp":
    case "light":
    case "journal":
    case "pin":
    case "roll":
    case "handoutDoc":
    case "companionBlock":
    case "cast":
    case "trap":
    case "log":
    case "trapLog":
    case "trapSeen":
    case "played":
    case "memoryShared":
      return { kind, id: rest };
    case "fogDraft":
    case "holders":
      return { kind, sceneId: rest };
    case "exploredBy": {
      const sep = rest.lastIndexOf(":");
      const m = sep > 0 ? GRID_RE.exec(rest.slice(sep + 1)) : null;
      const owner = sep > 0 ? rest.indexOf(":") : -1;
      if (!m || owner <= 0 || owner >= sep - 1) return null;
      return { kind, sceneId: rest.slice(0, owner), memberId: rest.slice(owner + 1, sep), tx: Number(m[1]), ty: Number(m[2]) };
    }
    case "memoryBy": {
      const sep = rest.lastIndexOf(":");
      const m = sep > 0 ? GRID_RE.exec(rest.slice(sep + 1)) : null;
      const owner = sep > 0 ? rest.indexOf(":") : -1;
      if (!m || owner <= 0 || owner >= sep - 1) return null;
      return { kind, id: rest, sceneId: rest.slice(0, owner), memberId: rest.slice(owner + 1, sep), cx: Number(m[1]), cy: Number(m[2]) };
    }
    case "memory": {
      const sep = rest.lastIndexOf(":");
      const m = sep > 0 ? GRID_RE.exec(rest.slice(sep + 1)) : null;
      if (!m) return null;
      return { kind, id: rest, sceneId: rest.slice(0, sep), cx: Number(m[1]), cy: Number(m[2]) };
    }
    case "chunk":
    case "fog":
    case "explored":
    case "sight":
    case "sightAll":
    case "fogAll":
    case "exploredAny": {
      const sep = rest.lastIndexOf(":");
      if (sep <= 0) return null;
      const m = GRID_RE.exec(rest.slice(sep + 1));
      if (!m) return null;
      const a = Number(m[1]);
      const b = Number(m[2]);
      const sceneId = rest.slice(0, sep);
      return kind === "chunk" ? { kind, sceneId, cx: a, cy: b } : { kind, sceneId, tx: a, ty: b };
    }
    default:
      return null;
  }
}

/** The collection a key belongs to in RoomState, or null for singletons, derived sight and unknown keys. */
export function collectionOf(key: EntityKey): keyof RoomState | null {
  const parsed = parseKey(key);
  if (!parsed) return null;
  switch (parsed.kind) {
    case "token":
      return "tokens";
    case "scene":
      return "scenes";
    case "member":
      return "members";
    case "character":
      return "characters";
    case "template":
      return "templates";
    case "drawing":
      return "drawings";
    case "label":
      return "labels";
    case "handout":
      return "handouts";
    case "monster":
      return "monsters";
    case "srdImage":
      return "srdImages";
    case "savedEncounter":
      return "savedEncounters";
    case "stamp":
      return "stamps";
    case "light":
      return "lights";
    case "journal":
      return "journal";
    case "pin":
      return "pins";
    case "roll":
      return "rolls";
    case "handoutDoc":
      return "handoutDocs";
    case "companionBlock":
      return "companionBlocks";
    case "cast":
      return "casts";
    case "trap":
      return "traps";
    case "trapLog":
      return "trapLog";
    case "trapSeen":
      return "trapSeen";
    case "chunk":
      return "buildChunks";
    case "fog":
      return "fogTiles";
    case "explored":
      return "exploredTiles";
    case "exploredBy":
      return "exploredBy";
    case "holders":
      return "holders";
    case "fogDraft":
      return "fogDrafts";
    case "memory":
      return "memory";
    case "memoryBy":
      return "memoryBy";
    case "played":
      return "playedScenes";
    case "memoryShared":
      return "memoryShared";
    case "log":
      return "log";
    default:
      return null;
  }
}

/**
 * The value an entity key names, or null when absent. Works on the full state
 * and on a projected one, because the projection keeps the same shape.
 */
export function readEntity(state: RoomState, key: EntityKey): unknown {
  const parsed = parseKey(key);
  if (!parsed) return null;
  switch (parsed.kind) {
    case "token":
      return state.tokens[parsed.id] ?? null;
    case "scene":
      return state.scenes[parsed.id] ?? null;
    case "member":
      return state.members[parsed.id] ?? null;
    case "character":
      return state.characters[parsed.id] ?? null;
    case "template":
      return state.templates[parsed.id] ?? null;
    case "drawing":
      return state.drawings[parsed.id] ?? null;
    case "label":
      return state.labels[parsed.id] ?? null;
    case "handout":
      return state.handouts[parsed.id] ?? null;
    case "monster":
      return state.monsters[parsed.id] ?? null;
    case "srdImage":
      return state.srdImages[parsed.id] ?? null;
    case "savedEncounter":
      return state.savedEncounters[parsed.id] ?? null;
    case "stamp":
      return state.stamps[parsed.id] ?? null;
    case "light":
      return state.lights[parsed.id] ?? null;
    case "journal":
      return state.journal[parsed.id] ?? null;
    case "pin":
      return state.pins[parsed.id] ?? null;
    case "roll":
      return state.rolls[parsed.id] ?? null;
    case "handoutDoc":
      return state.handoutDocs[parsed.id] ?? null;
    case "companionBlock":
      return state.companionBlocks[parsed.id] ?? null;
    case "cast":
      return state.casts[parsed.id] ?? null;
    case "trap":
      return state.traps?.[parsed.id] ?? null;
    case "log":
      return state.log.find((e) => e.id === parsed.id) ?? null;
    case "trapLog":
      return (state.trapLog ?? []).find((e) => e.id === parsed.id) ?? null;
    case "trapSeen":
      return (state.trapSeen ?? []).find((e) => e.id === parsed.id) ?? null;
    case "chunk":
      return state.buildChunks[chunkKey(parsed.sceneId, parsed.cx, parsed.cy)] ?? null;
    case "fog":
      return state.fogTiles[tileKey(parsed.sceneId, parsed.tx, parsed.ty)] ?? null;
    case "explored":
      return state.exploredTiles[tileKey(parsed.sceneId, parsed.tx, parsed.ty)] ?? null;
    case "sight":
      return sightOf(state)?.[tileKey(parsed.sceneId, parsed.tx, parsed.ty)] ?? null;
    case "sightAll":
    case "fogAll":
    case "exploredAny":
      return viewMapsOf(state)[parsed.kind]?.[tileKey(parsed.sceneId, parsed.tx, parsed.ty)] ?? null;
    case "exploredBy":
      return state.exploredBy?.[holderTileKey(parsed.sceneId, parsed.memberId, parsed.tx, parsed.ty)] ?? null;
    case "holders":
      return state.holders?.[parsed.sceneId] ?? null;
    case "fogDraft":
      return state.fogDrafts[parsed.sceneId] ?? null;
    case "memory":
      return state.memory?.[parsed.id] ?? null;
    case "memoryBy":
      return state.memoryBy?.[parsed.id] ?? null;
    case "played":
      return state.playedScenes?.[parsed.id] ?? null;
    case "memoryShared":
      return state.memoryShared?.[parsed.id] ?? null;
    case "encounter":
      return state.encounter;
    case "encounterHistory":
      return state.encounterHistory;
    case "meta":
      return state.meta;
  }
}

function withEntry<T>(map: Record<string, T>, id: string, value: T | null): Record<string, T> {
  const next = { ...map };
  if (value === null) delete next[id];
  else next[id] = value;
  return next;
}

/**
 * A new state with one entity replaced or removed. The input is never
 * mutated: only the top-level object and the one collection are copied.
 *
 * Removing a singleton empties it: the encounter becomes null, the history
 * becomes an empty list. Removing the meta is refused, because a room always
 * has one. Log entries are kept in order and capped by the caller.
 */
export function writeEntity(state: RoomState, key: EntityKey, value: unknown): RoomState {
  const parsed = parseKey(key);
  if (!parsed) throw new Error(`unknown entity key ${key}`);
  switch (parsed.kind) {
    case "token":
      return { ...state, tokens: withEntry(state.tokens, parsed.id, value as RoomState["tokens"][string] | null) };
    case "scene":
      return { ...state, scenes: withEntry(state.scenes, parsed.id, value as RoomState["scenes"][string] | null) };
    case "member":
      return { ...state, members: withEntry(state.members, parsed.id, value as RoomState["members"][string] | null) };
    case "character":
      return {
        ...state,
        characters: withEntry(state.characters, parsed.id, value as RoomState["characters"][string] | null),
      };
    case "template":
      return {
        ...state,
        templates: withEntry(state.templates, parsed.id, value as RoomState["templates"][string] | null),
      };
    case "drawing":
      return { ...state, drawings: withEntry(state.drawings, parsed.id, value as RoomState["drawings"][string] | null) };
    case "label":
      return { ...state, labels: withEntry(state.labels, parsed.id, value as RoomState["labels"][string] | null) };
    case "handout":
      return { ...state, handouts: withEntry(state.handouts, parsed.id, value as RoomState["handouts"][string] | null) };
    case "monster":
      return { ...state, monsters: withEntry(state.monsters, parsed.id, value as RoomState["monsters"][string] | null) };
    case "srdImage":
      return { ...state, srdImages: withEntry(state.srdImages, parsed.id, value as RoomState["srdImages"][string] | null) };
    case "savedEncounter":
      return { ...state, savedEncounters: withEntry(state.savedEncounters, parsed.id, value as RoomState["savedEncounters"][string] | null) };
    case "stamp":
      return { ...state, stamps: withEntry(state.stamps, parsed.id, value as RoomState["stamps"][string] | null) };
    case "light":
      return { ...state, lights: withEntry(state.lights, parsed.id, value as RoomState["lights"][string] | null) };
    case "journal":
      return { ...state, journal: withEntry(state.journal, parsed.id, value as RoomState["journal"][string] | null) };
    case "pin":
      return { ...state, pins: withEntry(state.pins, parsed.id, value as RoomState["pins"][string] | null) };
    case "roll":
      return { ...state, rolls: withEntry(state.rolls, parsed.id, value as RoomState["rolls"][string] | null) };
    case "handoutDoc":
      return { ...state, handoutDocs: withEntry(state.handoutDocs, parsed.id, value as RoomState["handoutDocs"][string] | null) };
    case "companionBlock":
      return { ...state, companionBlocks: withEntry(state.companionBlocks, parsed.id, value as RoomState["companionBlocks"][string] | null) };
    case "cast":
      return { ...state, casts: withEntry(state.casts, parsed.id, value as RoomState["casts"][string] | null) };
    case "trap":
      return { ...state, traps: withEntry(state.traps, parsed.id, value as RoomState["traps"][string] | null) };
    case "trapLog":
      return { ...state, trapLog: withLine(state.trapLog ?? [], parsed.id, value as LogEntry | null) };
    case "trapSeen":
      return { ...state, trapSeen: withLine(state.trapSeen ?? [], parsed.id, value as LogEntry | null) };
    case "chunk":
      return {
        ...state,
        buildChunks: withEntry(state.buildChunks, chunkKey(parsed.sceneId, parsed.cx, parsed.cy), value as BuildChunk | null),
      };
    case "fog":
      return {
        ...state,
        fogTiles: withEntry(state.fogTiles, tileKey(parsed.sceneId, parsed.tx, parsed.ty), value as FogTile | null),
      };
    case "explored":
      return {
        ...state,
        exploredTiles: withEntry(state.exploredTiles, tileKey(parsed.sceneId, parsed.tx, parsed.ty), value as FogTile | null),
      };
    case "sight": {
      // Only a projected state holds sight, so writing one makes it a projection's.
      const sight = withEntry(sightOf(state) ?? {}, tileKey(parsed.sceneId, parsed.tx, parsed.ty), value as SightTile | null);
      return { ...state, sight } as RoomState;
    }
    case "sightAll":
    case "fogAll":
    case "exploredAny":
      // As sight: only a projection of a per-player scene holds these maps, and only while they hold a tile (project.ts).
      return withMap(state, parsed.kind, withEntry<unknown>(viewMapsOf(state)[parsed.kind] ?? {}, tileKey(parsed.sceneId, parsed.tx, parsed.ty), value));
    case "exploredBy":
      return { ...state, exploredBy: withEntry(state.exploredBy ?? {}, holderTileKey(parsed.sceneId, parsed.memberId, parsed.tx, parsed.ty), value as ExploredTile | null) };
    case "holders":
      // A projection holds the DM's scene's list only while there is one, as the server's own state need not.
      return withMap(state, "holders", withEntry(state.holders ?? {}, parsed.sceneId, value as SightHolders | null));
    case "fogDraft":
      return { ...state, fogDrafts: withEntry(state.fogDrafts, parsed.sceneId, value as FogDraft | null) };
    case "memory":
      return { ...state, memory: withEntry(state.memory ?? {}, parsed.id, value as MemoryChunk | null) };
    case "memoryBy":
      return { ...state, memoryBy: withEntry(state.memoryBy ?? {}, parsed.id, value as MemoryChunk | null) };
    case "played":
      return { ...state, playedScenes: withEntry(state.playedScenes ?? {}, parsed.id, value as SceneMark | null) };
    case "memoryShared":
      return { ...state, memoryShared: withEntry(state.memoryShared ?? {}, parsed.id, value as SceneMark | null) };
    case "log":
      return { ...state, log: withLine(state.log, parsed.id, value as LogEntry | null) };
    case "encounter":
      return { ...state, encounter: (value as Encounter | null) ?? null };
    case "encounterHistory":
      return { ...state, encounterHistory: (value as EncounterSnapshot[] | null) ?? [] };
    case "meta":
      if (value === null) throw new Error("the room meta cannot be removed");
      return { ...state, meta: value as RoomMeta };
  }
}

/** A projection with one of per-player vision's maps (ViewMaps, `holders`) replaced, and without it once it is empty. */
function withMap(state: RoomState, field: "sightAll" | "fogAll" | "exploredAny" | "holders", map: Record<string, unknown>): RoomState {
  const out = { ...state } as Record<string, unknown>;
  if (Object.keys(map).length === 0) delete out[field];
  else out[field] = map;
  return out as RoomState;
}

/** A log of lines with one replaced or removed, kept in id order. */
function withLine(lines: readonly LogEntry[], id: string, value: LogEntry | null): LogEntry[] {
  const without = lines.filter((e) => e.id !== id);
  return value === null ? without : [...without, value].sort((a, b) => compareLogIds(a.id, b.id));
}

/** Orders `"<seq>:<index>"` log ids numerically, so a replayed entry lands in place. */
export function compareLogIds(a: string, b: string): number {
  const [as, ai] = a.split(":");
  const [bs, bi] = b.split(":");
  const d = Number(as) - Number(bs);
  if (d !== 0) return d;
  return Number(ai ?? 0) - Number(bi ?? 0);
}

/** The rev of an entity value, or undefined for values that carry none (meta, history, log entries). */
export function revOf(value: unknown): number | undefined {
  if (value && typeof value === "object" && "rev" in value && typeof (value as { rev: unknown }).rev === "number") {
    return (value as { rev: number }).rev;
  }
  return undefined;
}
