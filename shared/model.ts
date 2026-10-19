/**
 * The room's data model, shared by the server, the client and every test.
 *
 * This file is the contract between the parts of the app, so it holds types
 * and the few constants that define them, and nothing that runs. The shapes
 * follow docs/design.md section 6. Where this file and the design disagree,
 * fix one of them in the same change.
 *
 * Positions are in grid cells (floats), elevations and lengths of areas in
 * feet. See design section 5.
 */

import type { DamageType } from "./rules/damage.ts";

export type MemberId = string;
export type SceneId = string;
export type TokenId = string;
export type CharacterId = string;
export type TemplateId = string;
export type DrawingId = string;
export type LabelId = string;
export type HandoutId = string;
export type HandoutDocId = string;
export type AssetId = string;
export type EntryId = string;
export type EffectId = string;
export type MonsterId = string;
export type CompanionBlockId = string;
/** An SRD 5.2.1 monster's slug, such as "goblin-warrior" (shared/srd/monsters.ts). */
export type SrdId = string;
export type SavedEncounterId = string;
export type StampId = string;
export type LightId = string;
export type JournalPageId = string;
export type PinId = string;
export type RollId = string;
export type CastId = string;
/**
 * A shipped game-icons.net icon (docs/design-v1-dm-tools.md 3.12):
 * `"<author>/<name>"`, such as "lorc/wolf-head". The author is part of the
 * key because some names exist under two authors. A key means the same in
 * every room, and one a client does not know draws as initials.
 */
export type IconKey = string;

/** `"<sceneId>:<cx>,<cy>"`, one 16x16-cell chunk of a scene's build. */
export type ChunkKey = string;
/** `"<sceneId>:<tx>,<ty>"`, one 16x16-cell tile of a scene's fog, explored layer or sight. */
export type TileKey = string;

/** Cells per side of a build chunk and of a fog tile. */
export const CHUNK_CELLS = 16;
/** Fog sub-cells per grid cell side: 4 x 4 per cell, 1.25 ft at 5 ft per cell. */
export const FOG_SUBCELLS = 4;

export type RoomState = {
  meta: RoomMeta;
  members: Record<MemberId, Member>;
  scenes: Record<SceneId, Scene>;
  buildChunks: Record<ChunkKey, BuildChunk>;
  labels: Record<LabelId, Label>;
  fogTiles: Record<TileKey, FogTile>;
  /** DM only. One draft per scene. */
  fogDrafts: Record<SceneId, FogDraft>;
  tokens: Record<TokenId, Token>;
  characters: Record<CharacterId, Character>;
  templates: Record<TemplateId, AreaTemplate>;
  drawings: Record<DrawingId, Drawing>;
  encounter: Encounter | null;
  /** DM only. The last 20 states before each `next`, so `prev` can restore them. */
  encounterHistory: EncounterSnapshot[];
  handouts: Record<HandoutId, Handout>;
  /** The most recent 200 entries. Older ones live in the room_log table. */
  log: LogEntry[];
  /** DM only. The room's own stat blocks, entered from books the group owns. */
  monsters: Record<MonsterId, CustomMonster>;
  /** DM only. The image tokens of an SRD monster start with, by SRD id. */
  srdImages: Record<SrdId, SrdImage>;
  /** DM only. Fights built ahead in the encounter builder, ready to place on a map. */
  savedEncounters: Record<SavedEncounterId, SavedEncounter>;
  /** Pictures placed on a scene's board layer (wave 3). Empty in rooms from before them. */
  stamps: Record<StampId, Stamp>;
  /** DM only, in every wave. Light sources on a scene (wave 3 stores them, wave 4 lights with them). */
  lights: Record<LightId, Light>;
  /**
   * What the party has seen on vision scenes (wave 4), a second fog layer
   * beside the DM's `fogTiles`, in the same tile shape. Only the server
   * writes it, by `sys.explore`, and only hides and resets clear it. It has
   * no undo. Players get one fog, each tile the two layers merged
   * (shared/project.ts), and the DM gets both. Empty in rooms from before it
   * (docs/design-v1-maps-vision.md section 4.3.3).
   */
  exploredTiles: Record<TileKey, FogTile>;
  /**
   * The DM's journal pages (wave 5, docs/design-v1-dm-tools.md 3.7), room
   * level like the monsters. Players get the pages shared with them, without
   * the secret blocks the DM has not revealed. Empty in rooms from before it.
   */
  journal: Record<JournalPageId, JournalPage>;
  /** Map pins linked to notes (wave 5, section 3.8). Empty in rooms from before them. */
  pins: Record<PinId, Pin>;
  /**
   * Open roll requests (wave 5, section 3.3), room level. Closing one removes
   * it, so every request here is open. Empty in rooms from before them.
   */
  rolls: Record<RollId, RollRequest>;
  /**
   * DM only. The PDFs the DM uploaded, each a document of handout pages kept
   * in the library until the DM deletes it (docs/design-v1-pdf-handouts.md
   * 3.2). Showing one copies its pages into a handout, so players never get
   * a document. Empty in rooms from before them.
   */
  handoutDocs: Record<HandoutDocId, HandoutDoc>;
  /**
   * The stat blocks each character keeps for its companions
   * (docs/design-v1-companion-stat-blocks.md 3.1). The DM and the
   * character's owners receive them, and no one else. Empty in rooms from
   * before them.
   */
  companionBlocks: Record<CompanionBlockId, CompanionBlock>;
  /**
   * Players' open asks for saves against their creatures' spells
   * (docs/design-v1-player-save-spell.md 5.2), room level as roll requests
   * are. Closing one removes it, so every ask here is open. Empty in rooms
   * from before them.
   */
  casts: Record<CastId, CastAsk>;
};

export type RoomMeta = {
  name: string;
  settings: RoomSettings;
  playerSceneId: SceneId | null;
  view: { follow: boolean; blackout: boolean };
};

export type DiagonalRule = "five" | "fiveTen" | "euclid";
export type AoeCoverage = "half" | "any" | "center";
export type AoeInclusion = "anyCell" | "center" | "majority";

/** A choice of players: none of them, all of them, or the ones listed. */
export type WhichPlayers = "none" | "all" | MemberId[];

/**
 * Which players may move tokens they do not own (features section 5): none
 * of them, all of them, or the ones listed. Either way only tokens they can
 * see and that are not locked. Rooms from before it had a switch, which
 * snapshot migration 3 to 4 turned into "all" or "none".
 */
export type MoveAnyToken = WhichPlayers;

/**
 * How a critical hit rolls its damage (docs/design-v1-dice.md, the critical
 * hit rules addendum), for every attack in the room: the dice rolled twice,
 * the 2024 rule, or one of the common table rules. The server applies it
 * when it rolls, so every result records the rule it was rolled under.
 */
export const CRIT_RULES = ["rollTwice", "maxPlusRoll", "doubleDice", "doubleTotal"] as const;
export type CritRule = (typeof CRIT_RULES)[number];

/**
 * Which creatures players see in the initiative order before each one's
 * first turn of the fight (docs/design-v1-combat-flow.md 11): only those
 * players play, those and the ones with the Ally ring, or every one. A
 * creature joins their order when its turn comes and stays for the fight.
 */
export const ORDER_REVEALS = ["party", "allies", "all"] as const;
export type OrderReveal = (typeof ORDER_REVEALS)[number];

export type RoomSettings = {
  feetPerCell: number;
  diagonal: DiagonalRule;
  aoeCoverage: AoeCoverage;
  aoeInclusion: AoeInclusion;
  pcHpVisibleToParty: boolean;
  monstersDieAtZero: boolean;
  playersSeeAoeOfOthers: boolean;
  playersMoveAny: MoveAnyToken;
  /**
   * Players may make characters of their own and put their tokens on the
   * players' scene (shared/permissions.ts). Rooms from before it lack the
   * field, which reads as off.
   */
  playersCreateCharacters: boolean;
  playersApplyDamage: boolean;
  /**
   * Players may type the totals of the rolls they are asked for. Off, every
   * answer of theirs is rolled on the server, and the server refuses a
   * typed one (shared/permissions.ts). The DM's own rolls and totals are
   * unaffected. Rooms from before it lack the field, which reads as on, so
   * read it through `playersTypeTotals` (shared/permissions.ts).
   */
  playersTypeTotals?: boolean;
  skipDefeated: boolean;
  monsterInitScore: boolean;
  revealHiddenOnTurn: boolean;
  /**
   * Seconds each turn has before the tracker nudges whoever acts (features
   * section 10). It never ends a turn. 0 is off, the default, and rooms from
   * before it lack the field, which reads as off.
   */
  turnTimerSec: number;
  /**
   * Which players may draw (wave 5, docs/design-v1-dm-tools.md 3.9). A
   * permission rule, so stored drawings replay as they were made. Kept
   * rulers, pings and the laser stay allowed. Absent reads as "all", so
   * every room from before it keeps letting everyone draw.
   */
  playersDraw?: WhichPlayers;
  /**
   * Healing a dead creature, or setting its current HP above 0, brings it
   * back with that HP (docs/design-v1-combat-flow.md 3.4). Off follows the
   * rules as written, where only the DM's Revive does. Absent reads as on,
   * so rooms from before it bring back the dead too. Rules read it through
   * `healRevivesDead` (shared/migrate.ts), which keeps ops stored before op
   * version 5 on the rule they were applied under.
   */
  healRevives?: boolean;
  /**
   * How a critical hit rolls its damage. Absent reads as "rollTwice", the
   * 2024 rule, so every room from before it keeps rolling crits as it did.
   * Read it through `critRuleOf` (shared/dice/crit.ts).
   */
  critRule?: CritRule;
  /**
   * Which creatures players see in the initiative order before their turn.
   * Absent reads as "all", so every room from before it keeps showing the
   * whole order. Read it through `orderRevealOf` (shared/rules/initiative.ts).
   */
  playersSeeOrder?: OrderReveal;
};

/** The 2024 defaults. See design section 6 for what each one means. */
export const DEFAULT_SETTINGS: RoomSettings = {
  feetPerCell: 5,
  diagonal: "five",
  aoeCoverage: "half",
  aoeInclusion: "anyCell",
  pcHpVisibleToParty: true,
  monstersDieAtZero: true,
  playersSeeAoeOfOthers: true,
  playersMoveAny: "none",
  playersCreateCharacters: true,
  playersApplyDamage: false,
  playersTypeTotals: true,
  skipDefeated: true,
  monsterInitScore: false,
  revealHiddenOnTurn: true,
  turnTimerSec: 0,
  healRevives: true,
  critRule: "rollTwice",
  playersSeeOrder: "party",
};

/**
 * A person in the room. `kind` is only a label for the roster: authority
 * comes from the grant bound to each socket (design section 10.2), never from
 * this record, so a member marked "dm" here has no power by itself.
 */
export type Member = {
  id: MemberId;
  rev: number;
  name: string;
  color: string;
  kind: "dm" | "player";
  createdAt: string;
};

export type Scene = {
  id: SceneId;
  rev: number;
  name: string;
  order: number;
  /** Cells, at most 200 x 200. */
  bounds: { w: number; h: number };
  map?: SceneMap;
  grid: { show: boolean; color: string; opacity: number; lineWidth: number };
  background: string;
  fogEnabled: boolean;
  /** Bumped by every build op that can change walls or doors: the cache key for wall derivation (design 12). */
  wallsVersion: number;
  defaultView?: { x: number; y: number; zoom: number };
  /**
   * Which painted cells make automatic walls (AutoWalls). Absent reads as
   * "all", the rule every scene from before wave 3 was built under, so no
   * existing scene changes its walls.
   */
  autoWalls?: AutoWalls;
  /** DM only. The folder the Scenes panel files the scene under, absent for none. */
  folder?: string;
  /**
   * DM only. A `thumb` asset a DM device rendered for the Scenes panel. It is
   * bookkeeping like `wallsVersion`: undo guards leave it out and a restore
   * keeps the current one (shared/reducer/tx.ts).
   */
  thumb?: AssetId;
  /**
   * DM only. The images the map can switch between, the active one included,
   * at most MAX_PHASES. `map` is always the active phase's image, so
   * everything that draws or projects the map reads `map` alone.
   */
  phases?: MapPhase[];
  /** DM only. The active phase, present exactly when `phases` is. */
  phaseId?: string;
  /** DM only. The grid every phase is aligned by, present exactly when `phases` is. */
  phaseGrid?: PhaseGrid;
  /**
   * Walls, doors and ledges stop players' moves (wave 4, section 4.1). A
   * permission rule, never a reducer one, so stored moves replay as they
   * were made. The DM's moves are never stopped. Absent reads as off, the
   * rule for every scene from before it. The client turns it on for new ones.
   */
  blockMovement?: boolean;
  /** Party vision and the scene's light level (section 4.3). Absent reads as off. */
  vision?: SceneVision;
  /**
   * DM only. The scene's grid came exact with its file, a Universal VTT
   * import's, and its walls stand in that grid's squares, so Find the grid
   * only offers what it finds there (docs/design-v1-grid-detect.md section
   * 6). Only `scene.create` sets it, and nothing clears it. A scene
   * imported before it existed lacks it, and a first grid line before the
   * image, which only the import makes, stands in for it.
   */
  gridFromFile?: true;
};

/** How lit a scene is where no light reaches (section 4.3.2). */
export type LightLevel = "bright" | "dim" | "dark";

/**
 * Party vision (section 4.3): with `on`, players see only what the party's
 * creatures see, and remember what they explored. Turning it on turns the
 * scene's fog on too, since only fog remembers.
 */
export type SceneVision = { on: boolean; light: LightLevel };

/**
 * Which painted cells make an automatic wall toward an unpainted neighbor
 * (docs/design-v1-maps-vision.md section 2.1):
 * - "all": every painted cell. Blank mats and every scene from before wave 3.
 * - "floor": only floor terrains (stone, wood, grass, dirt, cave), for scenes
 *   made from a map image, where the art is the floor and painted water or
 *   stairs are notes on it.
 * - "off": none. Universal VTT imports, which bring their own walls.
 */
export type AutoWalls = "all" | "floor" | "off";

/**
 * One image the map can wear. Its size is the asset's canonical size, which
 * the server fills in from the asset row, never the client.
 */
export type MapPhase = {
  id: string;
  name: string;
  assetId: AssetId;
  widthPx: number;
  heightPx: number;
  /** The light level switching to this phase gives the scene's vision, so Night can make it dark (wave 4). */
  light?: LightLevel;
};

/**
 * The grid of a scene with phases, in the pixels of a reference image size
 * that is stored here, not read from any phase. Reordering, replacing or
 * removing phases never changes it, so each phase's grid is one
 * multiplication from it (shared/reducer/phases.ts).
 */
export type PhaseGrid = { refWidthPx: number; refHeightPx: number; cellPx: number; originPx: { x: number; y: number } };

/**
 * Where the map image sits. All pixel values are in the canonical space of
 * the asset's `full` variant, so every variant (the phone one included) is
 * stretched to the same world rectangle. See design section 5.
 */
export type SceneMap = {
  assetId: AssetId;
  widthPx: number;
  heightPx: number;
  cellPx: number;
  originPx: { x: number; y: number };
};

export type TerrainId =
  | "stone"
  | "wood"
  | "grass"
  | "dirt"
  | "cave"
  | "water"
  | "difficult"
  | "rubble"
  | "pit"
  | "pillar"
  | "stairs";

export type EdgeFeature =
  | { kind: "wall" }
  /** Removes an automatic wall. */
  | { kind: "none" }
  | { kind: "door"; state: "open" | "closed" | "locked"; secret: boolean; discovered: boolean }
  | { kind: "window" };

/**
 * One 16x16-cell chunk of a scene's build, in scene coordinates.
 * Cell keys are `"x,y"`. Edge keys are `"x,y,n"` or `"x,y,w"`, the north or
 * west edge of cell (x, y).
 */
export type BuildChunk = {
  sceneId: SceneId;
  cx: number;
  cy: number;
  rev: number;
  cells: Record<string, TerrainId>;
  edges: Record<string, EdgeFeature>;
  /**
   * Walls, doors and windows off the grid lines (wave 3), such as a
   * Universal VTT import brings. Each lives in the chunk that holds its
   * midpoint. Absent when the chunk has none.
   */
  walls?: FreeWall[];
  /**
   * Each cell's ground height in feet (wave 4, section 4.2): base64 of
   * CHUNK_CELLS x CHUNK_CELLS little-endian 16-bit signed integers, row-major
   * over the chunk's cells, HEIGHTS_CHARS long. Absent when every cell is at
   * 0. shared/heightCodec.ts reads and writes it.
   */
  heights?: string;
  /**
   * Stair marks (wave 4): one StairMark per cell, row-major over the
   * chunk's cells, STAIRS_CHARS long. A mark makes the cell a stair without
   * painting any terrain, so a stair can be drawn over a map image. Absent
   * when the chunk has none.
   */
  up?: string;
  /**
   * Difficult ground marks (docs/design-v1-movement.md 6.3): one character
   * per cell, row-major over the chunk's cells, ROUGH_CHARS long, "." none
   * and "d" difficult ground. A mark paints over whatever is under it,
   * floor or map art, without changing the cell's terrain. Absent when the
   * chunk has none.
   */
  rough?: string;
};

/**
 * One cell's stair mark: "." not a stair, "a" a stair pointing up by the
 * rule (toward its one higher neighbor, rules/heights.ts), or "n", "e", "s"
 * or "w", a stair pointing up that way.
 */
export type StairMark = "." | "a" | "n" | "e" | "s" | "w";
/** A stair's direction as a build op sets it: by the rule or by hand. */
export type StairDirection = Exclude<StairMark, ".">;

/** Characters of a chunk's `heights`: 512 bytes in base64. */
export const HEIGHTS_CHARS = 684;
/** Characters of a chunk's `up`: one per cell. */
export const STAIRS_CHARS = CHUNK_CELLS * CHUNK_CELLS;
/** Characters of a chunk's `rough`: one per cell. */
export const ROUGH_CHARS = CHUNK_CELLS * CHUNK_CELLS;
/** The lowest and highest ground a cell can be painted to, in whole feet. */
export const MIN_HEIGHT_FT = -100;
export const MAX_HEIGHT_FT = 200;

/** A wall, door or window: what an edge or a free wall can carry. */
export type WallFeature = Exclude<EdgeFeature, { kind: "none" }>;

/**
 * A wall segment that need not lie on a grid line. Its ends are in cells,
 * each coordinate a multiple of FREE_WALL_LATTICE, within the scene, and it
 * is at most MAX_FREE_WALL_CELLS long. `id` is FREE_WALL_ID_LENGTH random
 * characters, unique within its chunk, and never says what the wall is or
 * where it came from. Ops name a free wall by its chunk and id.
 */
export type FreeWall = { id: string; a: [number, number]; b: [number, number]; f: WallFeature };

/** Free wall and free light coordinates are multiples of 1 / FREE_WALL_LATTICE cell. */
export const FREE_WALL_LATTICE = 64;
/** The longest free wall, in cells, so one reaches at most 4 cells past its chunk. */
export const MAX_FREE_WALL_CELLS = 8;
/** Characters in a free wall's id. */
export const FREE_WALL_ID_LENGTH = 12;

export type Label = {
  id: LabelId;
  rev: number;
  sceneId: SceneId;
  x: number;
  y: number;
  text: string;
  size: number;
};

/**
 * What a stamp draws: a shipped picture by its key (public/stamps/<key>.webp,
 * a slug, never a path), or a `token` asset from the room's library. A key
 * the client does not know draws as a dashed box.
 */
export type StampArt = { key: string } | { assetId: AssetId };

/**
 * A picture placed on the map's board layer (wave 3): a tree, a table, a
 * chest. Drawn below walls, labels and tokens. Players get it unless it is
 * DM only or fully under fog, as labels are (shared/project.ts).
 */
export type Stamp = {
  id: StampId;
  rev: number;
  sceneId: SceneId;
  art: StampArt;
  /** The center, in cells. */
  x: number;
  y: number;
  /** Cells, STAMP_MIN_CELLS to STAMP_MAX_CELLS. */
  w: number;
  h: number;
  /** Degrees, clockwise from east. */
  rotation: number;
  /** A color multiplied into the art. */
  tint?: string;
  flip?: boolean;
  /** Drawing order on the scene: higher draws on top. */
  z: number;
  visibility: "all" | "dm";
};

export const STAMP_MIN_CELLS = 0.25;
export const STAMP_MAX_CELLS = 20;

/**
 * A light source on a scene (wave 3 stores them, wave 4 lights with them).
 * DM only in every wave: players see only its effect. Radii in feet follow
 * the SRD's wording, "Bright Light in a 20-foot radius and Dim Light for an
 * additional 20 feet" being `{ bright: 20, dim: 20 }`. The position is on
 * the FREE_WALL_LATTICE, as free walls are, so a test of whether it sits on
 * a wall stays exact.
 */
export type Light = {
  id: LightId;
  rev: number;
  sceneId: SceneId;
  /** Cells. */
  x: number;
  y: number;
  /** Feet, at most MAX_LIGHT_FT: the bright radius. */
  bright: number;
  /** Feet, at most MAX_LIGHT_FT: dim light this far beyond the bright radius. */
  dim: number;
  /** Stored, not drawn in v1. */
  color?: string;
  on: boolean;
  /** Walls cast shadows from it (Universal VTT "shadows"). */
  walls: boolean;
  label?: string;
};

/** The SRD's largest light, Daylight, is 60 ft bright and 60 ft dim beyond, so each radius stops at 120. */
export const MAX_LIGHT_FT = 120;

/**
 * One 16x16-cell tile of committed fog: 64 x 64 sub-cells, row-major, one bit
 * each, 1 = revealed, as base64. A tile that is entirely fogged is absent.
 */
export type FogTile = {
  sceneId: SceneId;
  tx: number;
  ty: number;
  rev: number;
  bits: string;
};

/**
 * One 16x16-cell tile of what the party sees (section 4.3.4), derived on the
 * server and never stored: `b` holds 2 bits per sub-cell in row order as
 * base64 (0 not seen, 1 grey, 2 dim, 3 bright), and `f` a tile all at one
 * level. Only tiles with a level above 0 exist. Projections carry them in a
 * `sight` map keyed `"<sceneId>:<tx>,<ty>"` (ProjectedState), the client
 * keeps them in its confirmed state, and shared/rules/vision.ts encodes them.
 */
export type SightTile = { b: string } | { f: 1 | 2 | 3 };

export type FogShape =
  | { kind: "rect"; x: number; y: number; w: number; h: number }
  /** Flat `[x0, y0, x1, y1, ...]`, at most 200 vertices. */
  | { kind: "poly"; points: number[] }
  /** A brush stroke, simplified, at most 500 points. */
  | { kind: "stroke"; points: number[]; width: number }
  /** `"x,y"` cell keys, at most 2,000. Used by "reveal room". */
  | { kind: "cells"; cells: string[] }
  | { kind: "all" };

export type FogOp = { id: string; mode: "reveal" | "hide"; shape: FogShape };

export type FogDraft = { sceneId: SceneId; rev: number; ops: FogOp[] };

export type CreatureSize = "tiny" | "small" | "medium" | "large" | "huge" | "gargantuan" | "custom";

/** Footprint side in cells per size. `custom` uses the token's own w and h. */
export const SIZE_CELLS: Record<Exclude<CreatureSize, "custom">, number> = {
  tiny: 0.5,
  small: 1,
  medium: 1,
  large: 2,
  huge: 3,
  gargantuan: 4,
};

export type TokenKind = "pc" | "npc" | "monster" | "object";
export type HpVisibility = "hidden" | "label" | "bar" | "exact";

/**
 * An image from the room's library as a token wears it: an asset of kind
 * `token` and the crop that fits it to the token's circle or square (design
 * 11.4).
 */
export type AssetImage = { assetId: AssetId; crop: { cx: number; cy: number; zoom: number } };

/**
 * A shipped game-icons.net icon on a colored disk (wave 5,
 * docs/design-v1-dm-tools.md 3.12). It names no asset, so it needs no
 * upload and no asset check. The glyph's color is worked out from `color`
 * on the device, never stored.
 */
export type IconImage = { icon: IconKey; color: string };

/**
 * An image as a token, a character's portrait or a monster's default
 * wears it: an uploaded asset or a shipped icon. shared/imageRef.ts reads
 * either.
 */
export type ImageRef = AssetImage | IconImage;

export type Token = {
  id: TokenId;
  rev: number;
  sceneId: SceneId;
  kind: TokenKind;
  name: string;
  publicName?: string;
  nameHidden: boolean;
  image?: ImageRef;
  size: CreatureSize;
  /** Cells, only for `custom`, 0.5 to 20. */
  w?: number;
  h?: number;
  x: number;
  y: number;
  /** Feet. Can be negative. */
  elevation: number;
  /** Feet. Defaults to the footprint side. */
  height?: number;
  rotation: number;
  disposition: "ally" | "neutral" | "hostile";
  visibility: "all" | "dm";
  /** Set by the DM: shown to players even under fog. */
  fogExempt: boolean;
  /**
   * Set when a hidden combatant is revealed on its turn, cleared when its fight ends. It no longer lifts the creature
   * above the fog or out of the sight rules (design 13.4). Only the seen marks of ops stored before op version 4 read it.
   */
  fogExemptAuto: boolean;
  locked: boolean;
  layer: "object" | "token";
  ownerIds: MemberId[];
  actor: { ref: CharacterId } | { inline: Actor };
  hpVisibility: HpVisibility;
  /** Auto-numbering for duplicates ("Goblin 3"). */
  number?: number;
  /**
   * The token's note for everyone: every player who can see the token reads
   * it. Its note for the DM alone is its actor's `dmNotes`, which never
   * reaches a player (design 7.3).
   */
  notes?: string;
  /**
   * Other images the token can wear, such as a druid's Wild Shape forms or
   * a disguise, at most MAX_ALT_IMAGES. Swapping trades one with `image` in
   * a single update. Only the DM and the token's owners receive them, since
   * a disguised creature's true face is in this list (design 7.3).
   */
  altImages?: ImageRef[];
  /**
   * Distances in feet to draw rings at around the token, such as a bow's
   * 80/320 (features section 4). Shown to everyone who sees the token.
   */
  rangeRings?: number[];
  /**
   * Where the creature went on its turn (features section 4): one stop per
   * drop, so the table can see which squares it crossed and how far it has
   * moved. Only the active creature's moves on its own turn add to it. The
   * turn passing writes no token, so a path from an earlier turn stays here
   * and counts as empty (shared/rules/path.ts) until a move replaces it.
   */
  path?: TokenPath;
  /**
   * Stopped squeezed in a narrow opening (wave 4, section 4.1): every rule
   * that reads its footprint uses the squeezed one, one size smaller on each
   * side of at least 2 cells, while the map draws it full size. Part of its
   * pose. A move sets it only with the flag, any other move clears it, and so
   * does an edit of its size, scene or position.
   */
  squeeze?: true;
  /** A light the creature carries, at its eye (section 4.3.8). The DM and its owners set it, and only they receive it. */
  light?: TokenLight;
  /** DM only: a creature the DM runs that lends the party its sight and is always shown to players (section 4.3.2). */
  partyVision?: boolean;
  /**
   * A creature or effect a character brings (docs/design-v1-combat-flow.md
   * 3.6): a familiar, a summon, a spell's weapon. Its owners are always its
   * character's owners, it has no number, and it is never a PC. Players
   * other than its owners get it only while the token is the party's.
   */
  companion?: Companion;
};

/** Whose turn a companion acts on (docs/design-v1-combat-flow.md 3.6.2): its own row, its character's turn listed under it, or its character's turn and not listed. */
export type CompanionTurn = "own" | "shared" | "none";

/**
 * A token's link to its character. `reactionUsed` is a `shared`
 * companion's own Reaction, present only while spent: its character's turn
 * starting clears it, and Previous sets it again.
 */
export type Companion = { of: CharacterId; turn: CompanionTurn; reactionUsed?: true };

/** A carried light in feet, as the SRD words it: bright within `bright`, dim for `dim` beyond it, each at most MAX_LIGHT_FT. */
export type TokenLight = { bright: number; dim: number };

/**
 * One turn's movement, as stops in the order the creature reached them.
 * The first is where the turn began. Each later stop ends a leg, the
 * straight line from the stop before it, so a later rule (walls blocking a
 * move) can judge each leg on its own.
 */
export type TokenPath = {
  /** The turn these moves belong to: its `TurnStart.seq`. */
  turn: number;
  stops: PathStop[];
};

export type PathStop = {
  x: number;
  y: number;
  /** Feet. */
  elevation: number;
  /**
   * The leg that ends here does not count against the creature's speed:
   * a shove, Misty Step or a teleport. It is drawn faint and left out of
   * the distance moved.
   */
  uncounted?: true;
  /**
   * Players who do not own the token could see it here then, by the rule
   * of `TurnStart.seen`. They get only such stops, and never the mark
   * (design 7.3).
   */
  seen?: true;
  /**
   * The leg that ends here is two or more legs joined when the path was
   * full, through a stop those players could not see. Its `uncounted` mark
   * stays the DM's and the owners', as it was while the stop between was
   * there (rules/path.ts).
   */
  joinedUnseen?: true;
  /**
   * The footprint in cells the creature had when the stop was made, and
   * whether it was squeezed, where that differs from its footprint now: a
   * resize on its turn, or a move into or out of a squeeze, writes the old
   * one here on every earlier stop that holds none
   * (docs/design-v1-token-window.md 8.7). A stop without it was made with
   * the token's footprint now. So each leg is measured and drawn as it was
   * made, and no later change of the footprint changes the feet moved
   * before it.
   */
  footprint?: { w: number; h: number; squeeze?: true };
  /**
   * Display only (docs/design-v1-movement.md 6.2): the corners of the walk
   * between the stop before and this one, flat x, y in cells, when the leg
   * bent around walls or terrain. Accounting never reads it.
   */
  via?: number[];
  /** Feet walked on the leg: its length under the room's rule, no extras. Written for every leg since op version 13. */
  moved?: number;
  /** Feet the leg took off the creature's speed: difficult terrain, swimming and crawling counted. */
  cost?: number;
  /** The 5-10-5 diagonals the leg took, horizontal and vertical, in squares, so the next leg's count runs on. Absent when none. */
  diag?: [number, number];
  /**
   * Players who do not own the token saw every spot of the leg, before and
   * after the move (7.2). In players' copies, the leg was seen whole: both
   * its ends seen too, and not joined across an unseen stop.
   */
  routeSeen?: true;
};

export type LifeState = "alive" | "dying" | "stable" | "dead";

export type Actor = {
  hp: { cur: number; max: number; temp: number };
  life: LifeState;
  ac: number;
  speeds: { walk: number; fly?: number; swim?: number; climb?: number; burrow?: number; hover?: boolean };
  initBonus: number;
  /** 10 + DEX modifier, used when `monsterInitScore` is on. */
  initScore?: number;
  passivePerception: number;
  senses: string;
  creatureType?: string;
  cr?: string;
  xp?: number;
  srdId?: string;
  /**
   * DM only, in every projection, owners included: the room's own monster
   * the token was placed from, whose full stat block the DM reads on the
   * token (wave 5, docs/design-v1-dm-tools.md 3.6). Absent for SRD monsters,
   * which keep `srdId`, and in rooms from before it.
   */
  monsterId?: MonsterId;
  /**
   * One of its character's companion stat blocks, on a companion's own
   * actor only (docs/design-v1-companion-stat-blocks.md 3.2). An actor
   * links at most one block: `srdId`, `monsterId` or this. Its owners
   * receive it, other players never. A link to a block deleted since reads
   * as deleted until someone attaches another or detaches.
   */
  blockId?: CompanionBlockId;
  /**
   * On a character's own actor only, with `srdId`: the SRD creature is the
   * character's Wild Shape (docs/design-v1-pc-stats.md 3.6), so its rolls
   * take the creature's Strength, Dexterity and Constitution and keep the
   * character's own Intelligence, Wisdom, Charisma and proficiencies. An
   * `srdId` without it is another shape, such as Polymorph, which takes
   * every number of the creature.
   */
  wildShape?: true;
  /**
   * On a character's own actor only, while it is in a shape: its own AC and
   * speeds from before the shape, which the creature's replace while it
   * lasts (W7B-P-9). The reducer keeps it: the patch that takes a shape
   * stores it, and the one that ends the shape puts them back. `shapeTemp`
   * marks the temporary HP pool as the one a shape other than Wild Shape
   * gave, such as Polymorph's, which goes when the shape ends. Any other
   * source that sets the pool takes the mark away, so End the shape never
   * takes temporary HP that came from elsewhere (W7-SOL-06).
   */
  unshaped?: { ac: number; speeds: Actor["speeds"]; shapeTemp?: true };
  /** https only, at most 500 characters. */
  sheetUrl?: string;
  effects: Effect[];
  deathSaves: { ok: number; fail: number };
  legendary?: { actionsMax: number; actionsUsed: number; resistMax: number; resistUsed: number };
  notes: string;
  dmNotes: string;
};

export type Character = {
  id: CharacterId;
  rev: number;
  ownerIds: MemberId[];
  name: string;
  size: CreatureSize;
  defaultImage?: ImageRef;
  actor: Actor;
  /**
   * The character's level, 1 to 20, which the encounter builder's XP budget
   * reads (features section 10). Absent until the DM or the character's
   * player sets it, and in rooms from before it.
   */
  level?: number;
  /**
   * The character's stat block (docs/design-v1-pc-stats.md 3.2), which the
   * DM and its players read and edit. Absent until someone adds one, and in
   * rooms from before it. While it is there the actor's `initBonus` and
   * `passivePerception` follow it.
   */
  stats?: PcStats;
  /**
   * A Druid's known forms for Wild Shape (docs/design-v1-known-forms.md 3.1):
   * SRD ids, 1 to MAX_KNOWN_FORMS, each once, in the order chosen. On the
   * character, not its stat block, since a druid with no block still takes
   * shapes. Absent is none, never an empty list, and rooms from before it
   * have none.
   */
  knownForms?: string[];
};

/**
 * A player character's stat block (docs/design-v1-pc-stats.md 3.2): what
 * the rules derive every save, check and attack from, and the adjustments
 * the derivation does not know. It is not a character sheet: no spell
 * slots, inventory or feature text.
 */
export type PcStats = {
  /** Scores, 1 to 30. */
  abilities: Record<AbilityKey, number>;
  /** Proficient saving throws, each once. */
  saves: AbilityKey[];
  /** A skill left out has neither. */
  skills: Partial<Record<SkillKey, "prof" | "expert">>;
  /** Jack of All Trades. */
  jack?: true;
  /** Proficiency on initiative (Alert). */
  alert?: true;
  spellAbility?: AbilityKey;
  /** A weapon attack's critical range: Improved or Superior Critical. */
  critOn?: 19 | 18;
  /** Evasion (Rogue 7, Monk 7): a Dexterity save for half takes none on a pass, half on a fail. */
  evasion?: true;
  adjust: PcAdjust;
  defenses: Partial<Record<DamageType, "resistant" | "immune" | "vulnerable">>;
  /** At most 40. */
  rolls: PcRoll[];
};

/** What a number adds beyond its derivation: integers, -20 to 20, absent is 0. */
export type PcAdjust = {
  saves?: Partial<Record<AbilityKey, number>>;
  skills?: Partial<Record<SkillKey, number>>;
  allSaves?: number;
  allChecks?: number;
  init?: number;
  passive?: number;
  spellDc?: number;
  spellAttack?: number;
};

/** Unique in its block, so a list can key by it. */
export type PcRollId = string;

/** One weapon, spell or other roll on a character's stat block. It needs an attack, a save or dice. */
export type PcRoll = {
  id: PcRollId;
  /** 1 to 60 characters, one line. */
  name: string;
  kind: "weapon" | "spell" | "other";
  /** `spell` reads the block's `spellAbility` at the time. */
  ability?: AbilityKey | "spell";
  /** An attack roll. */
  attack?: { prof: boolean; bonus: number };
  /** The save it forces: `dc` fixed, else derived with `bonus`, never both. A pass takes half the damage with `half`, else none. */
  /**
   * What a pass takes: half the damage or none. Absent is not known, never
   * typed nor read, and reads as unknownOnPass in shared/rules/pcStats.ts
   * gives it: the SRD's rule for a spell of the same name, so an unset
   * Fireball still halves.
   */
  save?: { ability: AbilityKey; dc?: number; bonus?: number; onPass?: "half" | "none" };
  /** A spell's level, 0 to 9, 0 for a cantrip. */
  level?: number;
  /** 0 to 4 parts, rolled together. */
  dice: PcDice[];
  /** Made by a D&D Beyond import. Editing the roll makes it the player's own. */
  ddb?: true;
};

/** One part of a roll's dice. */
export type PcDice = {
  /** Dice and numbers, at most 40 characters: "1d8", "2d6+1". */
  formula: string;
  /** Adds the roll's ability modifier. */
  mod?: true;
  /** Neither: a plain roll, as Bardic Inspiration's d8. */
  type?: DamageType | "healing";
  /** A cantrip's dice, times 2 from level 5, 3 from 11, 4 from 17. */
  grows?: true;
  /** Damage or healing dice added per slot level above the spell's own: "1d6". */
  upcast?: string;
  /** A rider, rolled only when it applies, such as Sneak Attack. A damage part alone. */
  optional?: true;
  /** A rider's name, 30 characters. */
  name?: string;
};

export type MonsterSize = Exclude<CreatureSize, "custom">;

export const ABILITY_KEYS = ["str", "dex", "con", "int", "wis", "cha"] as const;
export type AbilityKey = (typeof ABILITY_KEYS)[number];

/** Every challenge rating a stat block can print. */
export const CR_VALUES = ["0", "1/8", "1/4", "1/2", ...Array.from({ length: 30 }, (_, i) => String(i + 1))] as const;

/**
 * One trait, action, bonus action, reaction or legendary action, as the
 * stat block prints it: a bold run-in `name` ("Fire Breath (Recharge 5–6)",
 * without its full stop) and the `text` after it. Each line of `text` is a
 * paragraph. A line that opens with "At Will:" or "2/Day Each:" is an item
 * of a spell list, and one that opens with "• " a bullet. An empty name is a
 * paragraph without one.
 */
export type StatBlockEntry = { name: string; text: string };

/**
 * A stat block the DM entered from a book the group owns (features section
 * 15). It lives in this room's state and backups only, never ships with the
 * app, and is never projected to players, who see only the tokens made from
 * it.
 *
 * The fields follow the 2024 stat block line by line, so it reads back as
 * the same block. Lines that only the DM reads stay text as printed. Lines a
 * token takes numbers from are numbers, except the speed, which keeps its
 * wording ("40 ft. (bear form only)") and is read into the token's speeds
 * the way the SRD import reads it. The browser, the stat block view and
 * token creation see it in the SRD monsters' shape (shared/statBlock.ts).
 */
export type CustomMonster = {
  id: MonsterId;
  rev: number;
  name: string;
  size: MonsterSize;
  /** The second size of a "Medium or Small" block. */
  sizeAlt?: MonsterSize;
  /** With any tag, such as "Dragon (Chromatic)". */
  type: string;
  alignment: string;
  ac: number;
  /** The initiative bonus. The score printed after it is always 10 more. */
  initiative: number;
  /** `formula` uses an ASCII minus, such as "1d4 - 1", or is empty for a fixed number. */
  hp: { average: number; formula: string };
  /** As printed after "Speed": "30 ft., Fly 60 ft. (hover)". */
  speed: string;
  /** Each score with its saving throw bonus, which is the modifier unless proficient. */
  abilities: Record<AbilityKey, { score: number; save: number }>;
  skills: string;
  vulnerabilities: string;
  resistances: string;
  /** Damage and condition immunities, as the 2024 block joins them: "Poison; Charmed, Poisoned". */
  immunities: string;
  gear: string;
  /** Special senses, without Passive Perception. */
  senses: string;
  passivePerception: number;
  languages: string;
  /** "0", "1/8", "1/4", "1/2", or "1" to "30". */
  cr: string;
  xp: number;
  xpInLair?: number;
  traits: StatBlockEntry[];
  actions: StatBlockEntry[];
  bonusActions: StatBlockEntry[];
  reactions: StatBlockEntry[];
  legendaryActions: StatBlockEntry[];
  /**
   * The image every token placed from it starts with. Not a line of the
   * block, but kept in it so the editor saves it with the rest as one op.
   */
  defaultImage?: ImageRef;
};

/**
 * The DM's default image for one SRD monster: what every token placed from
 * it starts with. The SRD ships with the app, so the room keeps only this
 * one choice per monster, keyed and identified by the SRD id. DM only, like
 * the room's own monsters: players see only the tokens.
 */
export type SrdImage = { id: SrdId; rev: number; image: ImageRef };

/** A custom monster's stat block without the fields every entity carries. */
export type StatBlock = Omit<CustomMonster, "id" | "rev">;

/**
 * A stat block a character keeps for its companions
 * (docs/design-v1-companion-stat-blocks.md 3.1): text pasted from a book,
 * one typed in, or an SRD block copied to be edited. Read by the DM and by
 * whoever owns the character, who are the owners of its companions. An SRD
 * block picked as it is stays a link (`Actor.srdId`) and is never copied
 * here. Its `defaultImage` is the picture a companion added from it starts
 * with.
 */
export type CompanionBlock = StatBlock & {
  id: CompanionBlockId;
  rev: number;
  /** The character that keeps it. It never changes. */
  characterId: CharacterId;
  /** The SRD monster it was copied from, so its view keeps the SRD's credit. Absent for a block pasted or typed. */
  fromSrd?: SrdId;
};

/**
 * One kind of monster in a saved encounter and how many of it: an SRD
 * monster by its id, or one of the room's own. `inLair` places it with its
 * lair's legendary uses and XP, as the monster browser's toggle does.
 */
export type SavedEncounterMonster = ({ srdId: SrdId } | { monsterId: MonsterId }) & { count: number; inLair?: boolean };

/** Some player characters of one level, for an encounter's XP budget. */
export type PartyGroup = { count: number; level: number };

/**
 * A fight the DM builds ahead in the encounter builder (features section
 * 10) and places on any map later. DM only, like the room's own monsters:
 * players never receive one, only the tokens it places.
 *
 * It names its monsters rather than copying them, so an edit to one of the
 * room's own shows in every encounter that uses it, and one deleted since
 * is left out when the encounter is placed.
 */
export type SavedEncounter = {
  id: SavedEncounterId;
  rev: number;
  name: string;
  monsters: SavedEncounterMonster[];
  /** The party its budget is for, as the DM set it. Absent: the room's characters as they are now. */
  party?: PartyGroup[];
};

/** The 15 conditions, the same names in 2014 and 2024. */
export const CONDITION_KEYS = [
  "blinded",
  "charmed",
  "deafened",
  "exhaustion",
  "frightened",
  "grappled",
  "incapacitated",
  "invisible",
  "paralyzed",
  "petrified",
  "poisoned",
  "prone",
  "restrained",
  "stunned",
  "unconscious",
] as const;
export type ConditionKey = (typeof CONDITION_KEYS)[number];

/** Statuses that are not conditions. Bloodied is computed from HP, never stored. */
export const STATUS_KEYS = [
  "concentrating",
  "hidden",
  "flying",
  "dodging",
  "raging",
  "blessed",
  "baned",
  "hasted",
  "hunters-mark",
  "hexed",
  "heroic-inspiration",
  "surprised",
  "marked",
  /**
   * Holding a Ready action (features section 10): waiting on a trigger it
   * chose, to act with its Reaction before its next turn. The trigger is
   * the effect's `label`.
   */
  "readied",
] as const;
export type StatusKey = (typeof STATUS_KEYS)[number];

export type DurationAnchor = { entryId: EntryId } | { tokenId: TokenId } | { characterId: CharacterId };

export type Effect = {
  id: EffectId;
  key: ConditionKey | StatusKey | "custom";
  label?: string;
  glyph?: string;
  color?: string;
  /** Exhaustion level 1 to 6, or a counter. */
  level?: number;
  /** "Concentrating: Bless" */
  spell?: string;
  hiddenFromPlayers?: boolean;
  /**
   * A Ready action's trigger (its `label`) reaches players who do not own
   * the creature even when no player owns it. By design, players learn only
   * that a monster readied, so the trigger is the DM's unless the DM shows
   * it. DM only, off by default.
   */
  triggerShown?: boolean;
  /**
   * Counts crossings of the anchor's turn boundary. While the anchor is a
   * token or character (outside combat), the duration is paused. See design
   * section 9.5.
   */
  duration?: { remaining: number; boundary: "turnStart" | "turnEnd"; anchor: DurationAnchor };
  /**
   * Wave 7: a save at the end of each of the creature's own turns ends it
   * (docs/design-v1-roll-options.md 6.1), `spell` when it is against a
   * spell. Only the DM sets it. Players keep the ability and lose the DC
   * (shared/project.ts playerSave), so a player's view has no `dc`.
   */
  save?: { ability: AbilityKey; dc: number; spell?: true };
  /**
   * Wave 7: the pending save of a "save ends" effect, one per turn end that
   * asks it (docs/design-v1-roll-options.md 6.1 writes it). Closing the
   * request linked to it settles it (docs/design-v1-roll-request.md 1.1).
   * The DM's.
   */
  due?: { id: string; state: "pending" | "resolved" | "dismissed" };
};

export type AreaShape = "sphere" | "cylinder" | "cone" | "cube" | "line" | "emanation";

export type AreaFootprint = { w: number; h: number; elevation: number; height: number };

/**
 * When an area hits a creature again after it was cast (features section
 * 9): as the creature enters it during a turn, by its own move or the
 * area's, or as the creature starts or ends its turn inside. Spirit
 * Guardians, for example, hits on entering and at the end of a turn.
 */
export type AreaTrigger = "enter" | "turnStart" | "turnEnd";

export type AreaTemplate = {
  id: TemplateId;
  rev: number;
  sceneId: SceneId;
  shape: AreaShape;
  /** Feet, 5 to 1000: radius, length, side, or emanation distance. */
  size: number;
  /** Feet, 5 to 1000: line width. */
  width?: number;
  /** Feet, 5 to 1000: cylinder height. */
  height?: number;
  /** x and y in cells, z in feet. Ignored when attached. */
  origin: { x: number; y: number; z: number };
  /** Degrees, clockwise from east. */
  yaw: number;
  /**
   * Cones and lines only: degrees above level, -90 to 90, so a cone aimed
   * upward can reach a flier (negative aims down). Absent means level, as
   * in rooms from before it.
   */
  pitch?: number;
  /** Cube only: where the origin sits on the face, each -0.5 to 0.5 of the side. */
  faceOffset?: { u: number; v: number };
  /** Cylinder only: which circle the origin is the center of. */
  anchor?: "bottom" | "top";
  attachedTo?: TokenId;
  /**
   * Emanation only, when it stays where it was cast from a token (Tiny Hut,
   * Globe of Invulnerability): that token's footprint in cells and vertical
   * extent in feet when it was cast, centered on `origin`. The area keeps its
   * shape after the token walks away, and for a player who cannot see the
   * token. An attached emanation ignores it and follows its token.
   */
  footprint?: AreaFootprint;
  /**
   * When the log reminds the table that this area hits a creature again,
   * such as "Goblin 2 ended its turn in Spirit Guardians". Set from the SRD
   * preset where the spell says so, and by hand. Absent means never, as in
   * rooms from before it.
   */
  triggers?: AreaTrigger[];
  /**
   * The area hits a creature only once per turn, whichever trigger comes
   * first, as most of these spells say ("A creature makes this save only
   * once per turn"). Without it each trigger reminds once a turn on its
   * own, so Grease's save for ending a turn there follows the one for
   * entering it.
   */
  oncePerTurn?: true;
  /**
   * How the area changes movement inside it (docs/design-v1-movement.md
   * 3.5): difficult terrain, Spirit Guardians' halved Speed, or Plant
   * Growth's 4 ft per foot. `foes` leaves out the caster and creatures of its
   * disposition, and without a caster affects everyone. Absent means normal.
   */
  slows?: AreaSlows;
  includeOrigin: boolean;
  color: string;
  label?: string;
  spell?: string;
  casterId?: TokenId;
  ownerId: MemberId;
  visibility: "all" | "dm";
};

export type AreaSlows = { kind: "difficult" | "halfSpeed" | "quarter"; foes?: true };

/**
 * `ruler` is a ruler kept on the map (features section 4): its stops are the
 * points, and the ruler tool draws and measures it, never the drawing tool.
 * Keeping one as a drawing gives it the drawings' owner, DM-only
 * visibility, undo, scene and member clean-up and limits as they are.
 */
export type DrawingKind = "free" | "line" | "rect" | "ellipse" | "polygon" | "arrow" | "text" | "ruler";

export type Drawing = {
  id: DrawingId;
  rev: number;
  sceneId: SceneId;
  kind: DrawingKind;
  /** Flat `[x0, y0, x1, y1, ...]` in cells, at most 2,000 numbers. */
  points: number[];
  style: { stroke: string; fill?: string; width: number; opacity: number; dash?: number[] };
  text?: string;
  ownerId: MemberId;
  visibility: "all" | "dm";
  /**
   * Ruler only: the token each stop is on, or null for a free stop. A stop
   * on a token measures from the token's footprint wherever it stands now,
   * as a live ruler does, and players get the ruler only while they can see
   * every token it is on (design 7.3).
   */
  anchors?: (TokenId | null)[];
  /**
   * Ruler only: the ground under each stop in feet, as the measurer saw it
   * when the ruler was kept, so every viewer reads the measurer's distance.
   * 0 for a stop on a token, which stands at the token's own height, and for
   * ground the measurer could not see. Left out when every entry is 0. A
   * later repaint or fog change leaves it as kept.
   */
  z?: number[];
  /** Ruler only: it measures the walk between its stops, not straight lines (docs/design-v1-movement.md 3.3). */
  walk?: true;
};

export type Encounter = {
  rev: number;
  round: number;
  activeEntryId: EntryId | null;
  /**
   * Player projections only, never stored: whether a turn has started. A
   * player's `activeEntryId` is also null while a row they cannot see is
   * acting (design 7.3), so this tells "not started" from "another
   * creature's turn". The DM reads `activeEntryId` itself.
   */
  started?: boolean;
  /** Kept sorted by the reducer: value descending, then tieOrder. */
  entries: InitEntry[];
  /**
   * Where the active creature stood when its turn began. Absent before the
   * first turn, for a row without a token, and in rooms from before it.
   */
  turnStart?: TurnStart;
};

/**
 * The spot a creature's turn began on (features section 10), recorded in
 * the shared state when the turn starts, so every device and a reload show
 * the same marker and the same distance moved since. `seen` says players
 * who do not own the token could see it there then: only then do they get
 * the spot, so a hidden or fogged creature's starting place never reaches
 * them (design 7.3).
 */
export type TurnStart = {
  entryId: EntryId;
  tokenId: TokenId;
  sceneId: SceneId;
  x: number;
  y: number;
  /** Feet. */
  elevation: number;
  seen?: true;
  /**
   * The seq of the op that started the turn, which names this turn and no
   * other: Previous puts it back with the turn, and the next turn gets a
   * new one. A path tagged with it is this turn's (`TokenPath.turn`).
   * Absent on turns started before paths were recorded, which record none.
   */
  seq?: number;
};

export type InitEntry = {
  id: EntryId;
  tokenId?: TokenId;
  characterId?: CharacterId;
  label?: string;
  value: number | null;
  tieOrder: number;
  /**
   * The SRD id or base name shared by identical monsters. DM only. Kept as
   * stored, so a row keyed before the dragon turtle's SRD id was renamed
   * holds the old id, which `rowGroup` reads as today's.
   */
  groupKey?: string;
  hidden: boolean;
  reactionUsed: boolean;
  inLair: boolean;
  /**
   * The DM's roll reminder, shown next to the row in place of what the
   * creature's conditions suggest. The DM's auto initiative rolls by it
   * (design 9.4). Anyone else rolling only reads it.
   */
  advantage?: "adv" | "dis";
  /**
   * The row's turn has started in this fight, so players see its place in
   * the order whatever `playersSeeOrder` reads (docs/design-v1-combat-flow.md
   * 11.2). Set when its turn starts, never by an op's input. DM only.
   */
  hadTurn?: true;
};

export type EncounterSnapshot = {
  encounter: Encounter;
  /** Effects keyed by token or character id, as they were before the `next`. */
  effects: Record<string, Effect[]>;
  /** Tokens revealed on that turn, so `prev` can hide them again. */
  revealed: { tokenId: TokenId; visibility: "all" | "dm"; fogExemptAuto: boolean }[];
  /** The legendary actions the creature whose turn started had used before `next` reset them. Absent in older rooms. */
  legendary?: { holderId: TokenId | CharacterId; actionsUsed: number };
  /** The `shared` companions whose Reaction this `next` cleared, so `prev` can set them again. Absent when it cleared none. */
  companionReactions?: TokenId[];
  at: string;
};

/**
 * The SRD 5.2.1's 18 skills (page 9), each under its usual ability in
 * shared/rules/skills.ts.
 */
export const SKILL_KEYS = [
  "acrobatics",
  "animal-handling",
  "arcana",
  "athletics",
  "deception",
  "history",
  "insight",
  "intimidation",
  "investigation",
  "medicine",
  "nature",
  "perception",
  "performance",
  "persuasion",
  "religion",
  "sleight-of-hand",
  "stealth",
  "survival",
] as const;
export type SkillKey = (typeof SKILL_KEYS)[number];

/**
 * One D20 Test a request offers: an ability, and in a check perhaps a skill.
 * A pair, never two lists, so the skill stays with its ability. A skill's
 * ability may differ from its usual one, as the SRD allows.
 */
export type RollChoice = { ability: AbilityKey; skill?: SkillKey };

/** A saving throw or an ability check, with one choice or two the creature picks from (section 3.3). */
export type RollTest = { kind: "save" | "check"; choices: RollChoice[] };

/**
 * What the server drew for one roll (wave 7, docs/design-v1-dice.md 5.1).
 * The formula is text, so a line of 20 rolls stays within its bound, and
 * shared/dice/roll.ts reads it back to pair each dice term with its faces.
 */
export type DiceResult = {
  /** Canonical, as rolled: "2d20kh1+5" for 1d20+5 with advantage. */
  formula: string;
  /** Every die drawn, in the formula's order, kept or dropped. */
  faces: number[];
  total: number;
  mode?: "adv" | "dis";
  /** Its advantage sources held both kinds, so it rolled normally (3.3), which a later Lucky must know (5.4). */
  cancelled?: true;
  /** A rolled save its creature fails whatever the total, by a condition its players can see (4.2). */
  fails?: ConditionKey;
  /**
   * A critical hit's damage, and the room's rule it was rolled under (the
   * critical hit rules addendum). Only the resolve sets it, so the line
   * reads by that rule whatever the setting says later.
   */
  crit?: CritRule;
};

/** A request's answer, or the one a later answer replaced. */
export type RollAnswer = {
  /** Which of the test's choices was rolled, 0 or 1. Absent for a save failed without rolling, and for a DM's bare mark. */
  choice?: 0 | 1;
  /** The total rolled, -50 to 100. */
  total?: number;
  result?: "pass" | "fail";
  /**
   * The creature's player chose to fail the save without rolling (SRD 5.2.1
   * page 7). Their own input, like a total, so the creature's players get it
   * even when pass or fail is hidden from them, and their devices know the
   * request is answered. A DM's bare mark never sets it.
   */
  noRoll?: true;
  /**
   * Wave 7. The client id of the op that wrote this answer, the key of its
   * receipt (docs/design-v1-dice.md 1.2). An answer written before wave 7
   * has none (docs/design-v1-roll-request.md 7.5).
   */
  tag?: string;
  /** Present exactly when the total was rolled on the server, with `fails` on it when a condition failed it (docs/design-v1-dice.md 5.1). */
  dice?: DiceResult;
  /** Rolled with a bonus the player typed, since the server knew none for the roll (docs/design-v1-dice.md 4.1). */
  typedBonus?: true;
  /** The DM's own mark, kept apart from what a DC gives (docs/design-v1-roll-request.md 1.1). */
  mark?: "pass" | "fail";
  /** The ask an allowed change answered (docs/design-v1-dice.md 5.4). */
  changed?: RollChange;
};

/**
 * A player's ask to change a rolled answer (docs/design-v1-roll-request.md
 * 1.1, docs/design-v1-dice.md 5.4): its own id, the `tag` of the answer it
 * would change, the reason, and a reroll's face (an index into the
 * answer's `dice.faces`) or Bardic Inspiration's die.
 */
export type RollChange = {
  id: string;
  on: string;
  reason: "heroic-inspiration" | "halfling-luck" | "lucky" | "bardic-inspiration" | "fix-total";
  face?: number;
  die?: 6 | 8 | 10 | 12;
};

/**
 * One creature a request asks, a token or a character, with its answer.
 * `by` and `previous` are the DM's: no player projection carries them.
 */
export type RollTarget = { tokenId?: TokenId; characterId?: CharacterId } & RollAnswer & {
    /** Who gave the answer or the mark: the creature's player or a DM. */
    by?: MemberId;
    /** The answer this one replaced, or the one a reopen cleared. */
    previous?: RollAnswer;
    /** A player's pending ask to change the answer (docs/design-v1-roll-request.md 1.1), which the DM's Allow names by its id. */
    change?: RollChange;
    /**
     * An allowed "Fix my total" (docs/design-v1-roll-request.md 5.5): the
     * player types the answer again and may not roll it, so a fixed typed
     * total never turns into a fresh roll. The next answer clears it.
     */
    retype?: true;
  };

/**
 * A player's ask for saves against their creature's spell or save action
 * (docs/design-v1-player-save-spell.md 5.2). Open until the DM resolves or
 * dismisses it, or a player of its caster withdraws it. It holds
 * references, never numbers the DM trusts: the DC, the dice and the
 * conditions come from the DM's view of the caster's stat block. The one
 * exception is `rolled`, which only the reducer writes, from lines the
 * server rolled.
 */
export type CastAsk = {
  /** Also the ask's receipt tag, so the same ask sent again asks once (5.3). */
  id: CastId;
  rev: number;
  /** The asker. */
  by: MemberId;
  /** A creature the asker owned when asking. */
  caster: TokenId;
  /** The players' scene when asked, the caster's and the area's. */
  sceneId: SceneId;
  /** 1 to 60 characters: the name the row or the area shows. Display text only. */
  spell: string;
  /** With targets: the NamedRoll key on the caster's stat block, read on the DM's device. */
  roll?: string;
  /** 1 to 9, the casting level. */
  slot?: number;
  /** Exactly one of `area` and `targets`. */
  area?: TemplateId;
  /** 1 to 50 tokens the asker saw. */
  targets?: TokenId[];
  /** The caster's damage roll: its tag, and how many batches it went in. */
  damage?: { tag: string; parts: number };
  /** That roll's results in part order, written by the reducer from its lines. Absent when they did not all check out. */
  rolled?: CastRolled[];
  /** The envelope time. */
  at: string;
};

/** One roll of the caster's damage: its formula as rolled, its total, and the damage type its label names. */
export type CastRolled = { formula: string; total: number; type?: DamageType };

/** How an ask for saves ended: resolved by the DM (an Apply, or a close with nothing to apply), set aside, or withdrawn. */
export type CastEnd = "done" | "dismissed" | "withdrawn";

/**
 * A roll the DM asked players for (wave 5, docs/design-v1-dm-tools.md
 * 3.3): "DEX save, DC 15". Each player rolls the answer on the server or
 * types the total they rolled (docs/design-v1-roll-request.md). A player's projection holds only their own targets,
 * the DC only when shown, results only when shown, and `rev` 0.
 */
export type RollRequest = {
  id: RollId;
  rev: number;
  test: RollTest;
  /** 1 to 50. Absent for a roll with no DC. */
  dc?: number;
  /** Players see the DC. */
  dcShown: boolean;
  /**
   * Player projections only, derived and never stored: the request has a
   * DC that players do not see. Never with the number.
   */
  dcHidden?: true;
  /** Players see pass or fail. */
  resultShown: boolean;
  /** Single-line text, at most 80 characters: "against the poison". */
  note?: string;
  /** Wave 7: a save against a spell, which the roll's test carries (docs/design-v1-roll-request.md 1.1, docs/design-v1-dice.md 6.1). */
  spell?: true;
  /** Wave 7: public, what the request is for (docs/design-v1-roll-request.md 1.1). */
  cause?: "saveEnds";
  /** Wave 7, the DM's: the effect a pass removes, and the save occurrence (`Effect.due.id`) it answers (docs/design-v1-roll-request.md 1.1). */
  ends?: { effect: EffectId; occurrence: string };
  /** The envelope time it was asked. */
  at: string;
  /** 1 to 50, one per creature. */
  targets: RollTarget[];
};

/** Who reads a journal page: the DM alone, every player, or one player. */
export type JournalAccess = "dm" | "all" | { member: MemberId };

/**
 * One block of a page. A secret is a block with a flag, never a region
 * parsed out of text, so projection drops whole blocks and never reads
 * Markdown (docs/design-v1-dm-tools.md 3.7).
 */
export type JournalBlock = {
  /** 12 random characters, unique in the page. */
  id: string;
  /** Markdown, at most 4,000 characters. */
  text: string;
  /** Only `journal.reveal` changes `revealed`. A new secret block starts hidden. */
  secret?: { revealed: boolean };
};

export type JournalPage = {
  id: JournalPageId;
  rev: number;
  title: string;
  /** The folder the Journal panel files the page under, absent for none. */
  folder?: string;
  access: JournalAccess;
  /** At most 100. */
  blocks: JournalBlock[];
};

/**
 * A marker on a scene, perhaps linked to a journal page (wave 5,
 * docs/design-v1-dm-tools.md 3.8). Players get it on the player scene
 * when it is not DM only, not on a fully fogged cell, and its page, if any,
 * is one they may read.
 */
export type Pin = {
  id: PinId;
  rev: number;
  sceneId: SceneId;
  /** Cells. */
  x: number;
  y: number;
  /** Single line, at most 80 characters. */
  label?: string;
  pageId?: JournalPageId;
  color: string;
  visibility: "all" | "dm";
};

/** One page of a handout: a `handout` image and its canonical size, the `full` variant's pixels. */
export type HandoutPage = { assetId: AssetId; width: number; height: number };

export type Handout = {
  id: HandoutId;
  rev: number;
  /** The first page. A handout without `pages` is this one image, as every handout from before PDFs is. */
  assetId: AssetId;
  /**
   * Every page in order, the first included (docs/design-v1-pdf-handouts.md
   * 3.1). Absent for one image. The reducer writes `assetId` from the first,
   * so a reader that knows only `assetId` still shows the first page.
   */
  pages?: HandoutPage[];
  title: string;
  to: "all" | MemberId[];
  shownAt: string;
};

/**
 * A PDF the DM uploaded, kept in the library until the DM deletes it
 * (docs/design-v1-pdf-handouts.md 3.2). It is not a handout: a handout is a
 * showing, and nothing links one back to the document it came from, so no
 * id of this DM-only entity reaches players.
 */
export type HandoutDoc = {
  id: HandoutDocId;
  rev: number;
  /** A name, as a handout's title is, from the PDF's own title or its file name. */
  title: string;
  /** Every page in order, at least one. */
  pages: HandoutPage[];
  /** When it was saved, for the library's order, newest first. */
  createdAt: string;
};

/**
 * Structured log events. They name entities by id and never carry
 * pre-rendered text, so each viewer's client renders them with its own
 * projected names, and projection can strip what a viewer may not see
 * (design section 7.3).
 *
 * Events about a creature carry two marks, set when the event is written
 * because projection only knows the state as it is now:
 * - `seen`, on events about a token: a player who does not own the token
 *   could see it then. Other players get only marked events, so what
 *   happened to a creature while it was hidden, under fog or on another
 *   scene stays hidden after a reveal. An event from before the mark existed
 *   counts as unseen. Events about a character need no mark, since every
 *   player knows every character.
 * - `hidden`, on effect and concentration events: the effect is hidden from
 *   players. Only the DM gets the event, the creature's owner included, as
 *   the actor projection hides the effect itself.
 */
type AboutCreature = { tokenId?: TokenId; characterId?: CharacterId; seen?: true };

/** The parts of an actor an HP change can move. */
export type Vitals = { hp: { cur: number; max: number; temp: number }; life: LifeState; deathSaves: { ok: number; fail: number } };

/**
 * What an HP change replaced, kept on its log line so the DM can take the
 * change back from the log (features section 10, design 7.7). DM only: no
 * player projection carries it, the creature's owner included. Reaching 0
 * HP can put Unconscious on and end concentration, and healing from 0 takes
 * that Unconscious off, so the effects it added and removed come along.
 *
 * `anchors` names the creature behind each initiative row a removed
 * effect's duration counts, a token or a character. The row can leave the
 * fight before the change is taken back, and the duration then pauses on
 * that creature, as it would have had the effect stayed (design 9.5).
 *
 * `shapeTemp` names, by its `srdId`, the shape whose pool the temporary HP
 * were before and after the change (`Actor.unshaped.shapeTemp`), each absent
 * for an empty pool or one no shape gave. Taking the change back is refused
 * when the pool's owner now differs from `after`, as for changed numbers
 * (W7-SOL-08). Otherwise it makes the pool `before`'s again while that shape
 * lasts, or empties it once the shape has ended, as End the shape would have
 * (W7-SOL-07).
 */
export type HpRevert = {
  before: Vitals;
  after: Vitals;
  added?: Effect[];
  removed?: Effect[];
  anchors?: Record<EntryId, DurationAnchor>;
  shapeTemp?: { before?: string; after?: string };
};

export type LogEvent =
  /**
   * `label` is the HP label after the change, so a viewer who may not see
   * numbers still reads "is Bloodied". `left` is the HP after it, for
   * viewers who see the numbers. `back` is the DM taking the change in `of`
   * back from the log, which only the DM's projection names.
   */
  | (AboutCreature & {
      type: "hp";
      change: "damage" | "heal" | "set" | "temp";
      amount?: number;
      crit?: boolean;
      label?: "Healthy" | "Bloodied" | "Dying" | "Dead";
      left?: Vitals["hp"];
      revert?: HpRevert;
      back?: true;
      of?: string;
    })
  | (AboutCreature & { type: "life"; life: LifeState })
  | (AboutCreature & { type: "effect"; key: Effect["key"]; action: "add" | "remove" | "expire" | "pause"; spell?: string; hidden?: true })
  | (AboutCreature & { type: "concentration"; dc?: number; spell?: string; ended?: boolean; hidden?: true })
  /**
   * Wave 7: a creature ended its turn with an effect a save ends
   * (docs/design-v1-roll-options.md 6.1). The line's id is the occurrence the
   * effect's `due` names. DM only, as the DC is.
   */
  | (AboutCreature & { type: "saveEnds"; effectId: EffectId; key: Effect["key"]; ability: AbilityKey; dc: number })
  /** The counts are left out for a player who may not see the creature's exact HP. */
  | (AboutCreature & { type: "deathSave"; ok?: number; fail?: number })
  /**
   * A short or long rest finished (features section 15). `amount` is the HP
   * a short rest's Hit Point Dice gave back. Like an HP line, the numbers
   * reach only viewers who may see the creature's exact HP.
   */
  | (AboutCreature & { type: "rest"; kind: "short" | "long"; amount?: number; left?: Vitals["hp"]; label?: "Healthy" | "Bloodied" | "Dying" | "Dead" })
  /**
   * `seen` as above, for the initiative row: players who do not own its
   * creature could see the row when the turn started. `back` is the DM's
   * Previous taking that turn back, so a turn that starts again after it
   * never reads as a repeated line. A take-back names the row whose turn it
   * resumed (`to`), so a turn clock knows which turn began again then, and
   * `toSeen` marks that players who do not own that row could see it then.
   * Players get `to` only with that mark or as the row's owners, and never
   * the mark itself.
   */
  | { type: "turn"; entryId: EntryId; round: number; seen?: true; back?: true; to?: EntryId; toSeen?: true }
  /**
   * A reminder that an area hits a creature again (AreaTemplate.triggers):
   * it entered the area during a turn, or started or ended its turn there.
   * `moved` says the area came onto the creature rather than the other way
   * round. `area` is the area's name when it happened, so the DM's line
   * still reads once the area is gone. Players lose the line with the area,
   * since their projection keeps it only while they see the area (design
   * 7.3). `seen` is the token's mark as above, and
   * `hidden` says the area itself was hidden from players then, so only the
   * DM gets the line.
   */
  | { type: "area"; templateId: TemplateId; tokenId: TokenId; trigger: AreaTrigger; area: string; moved?: true; seen?: true; hidden?: true }
  | { type: "encounter"; action: "start" | "end" }
  | { type: "handout"; handoutId: HandoutId }
  /** `remove` is the DM taking the member off the roster. Its earlier lines stay, read without its name. */
  | { type: "member"; memberId: MemberId; action: "join" | "kick" | "dm" | "undm" | "remove" }
  /**
   * A token moved with "Teleport here" past what stopped its walk (wave 4,
   * section 4.1). DM only: the DM's devices show it as a toast, and no player
   * projection carries it, the token's owners included.
   */
  | { type: "teleport"; tokenId: TokenId; past: "wall" | "ledge" }
  /**
   * A player added a companion beside their character
   * (docs/design-v1-combat-flow.md 3.6.3). DM only, as the teleport line
   * is. `name` is the companion's name then, so the line still reads once
   * it is renamed or dismissed.
   */
  | { type: "companion"; tokenId: TokenId; characterId: CharacterId; memberId: MemberId; name: string }
  /**
   * A player deleted a character they play alone (features section 15).
   * DM only, as the companion line is: the DM cannot undo it, so the line
   * says what went. `name` is the character's name then, and the counts are
   * what the delete removed, on every scene: its tokens, its companions and
   * its rows in the fight.
   */
  | { type: "characterDeleted"; characterId: CharacterId; memberId: MemberId; name: string; tokens: number; companions: number; rows: number }
  /**
   * An answer to a roll request, or a DM's mark of one (wave 5,
   * docs/design-v1-dm-tools.md 3.3), as the target stood after it. It
   * carries the test and the request's two switches, so the line keeps its
   * rules after the request is closed: it reaches the DM and the players
   * who own its creature now, with the DC only under `dcShown` and the
   * result only under `resultShown`. A table display gets none.
   */
  | {
      type: "roll";
      test: RollTest;
      tokenId?: TokenId;
      characterId?: CharacterId;
      choice?: 0 | 1;
      dc?: number;
      dcShown?: true;
      resultShown?: true;
      total?: number;
      result?: "pass" | "fail";
      /** The player failed the save without rolling, which reaches the creature's players as a total does. */
      noRoll?: true;
      /** Wave 7: the answer's dice when the server rolled it, and whether with a bonus the player typed (docs/design-v1-dice.md 5.1). */
      dice?: DiceResult;
      typedBonus?: true;
      /** The op that wrote it (docs/design-v1-roll-request.md 7.5), and for an allowed change the ask it answered (5.4). */
      tag?: string;
      changed?: RollChange;
      /** A DM's mark wrote it, which the projection drops when pass or fail is hidden (docs/design-v1-roll-request.md 7.5). */
      mark?: true;
    }
  /**
   * A free roll on the server (wave 7, docs/design-v1-dice.md 5.1): one line
   * per `dice.roll`, every roll with what was drawn. `to: 'dm'` is a secret
   * roll, which other players read as the bare line `rolls: []` (5.2).
   * `tag` reaches only the roller, with `part`, the batch of the tag the line
   * is, so each part's own line settles that part alone (1.2). `batch` is the
   * same for every batch of one tag and says nothing of the tag, so every
   * viewer groups a group's batches as one roll without learning the
   * roller's ids.
   */
  | { type: "dice"; tag?: string; part?: number; batch?: string; by: MemberId; to: "all" | "dm"; dc?: number; ac?: number; rolls: DiceRoll[] }
  /**
   * A player's ask for saves (docs/design-v1-player-save-spell.md 5.2):
   * written first in the op that asks, and again with `end` first in the op
   * that closes it. It reaches the DM and the players who own its caster
   * now, as the ask does. Its end reads the same whatever the saves did.
   */
  | { type: "cast"; castId: CastId; tokenId: TokenId; spell: string; slot?: number; end?: CastEnd };

/**
 * One roll of a `dice` line: its result, the label and creature asked, and
 * an attack roll's critical range. `seen` marks a roll for a token whose
 * non-owners could see it when it was written, as other token events are.
 * `initiative` marks a creature's initiative, so a roll made again from it
 * is one too and meets the order rule as it stands then. `save` names the
 * ability of a creature's save, so a roll made again from it is that save
 * again and a condition that fails it still records the fail. `hidden` marks the
 * initiative of a creature whose place in the order players did not know
 * then (docs/design-v1-combat-flow.md 11.3): only the DM and the creature's
 * own players get that roll.
 */
export type DiceRoll = DiceResult & { label?: string; tokenId?: TokenId; characterId?: CharacterId; seen?: true; critOn?: 18 | 19 | 20; initiative?: true; save?: AbilityKey; hidden?: true };

export type LogEntry = {
  /** `"<seq>:<index>"`, so a replay can never insert the same entry twice. */
  id: string;
  at: string;
  kind: "chat" | "whisper" | "event";
  from?: MemberId;
  to?: MemberId[];
  text?: string;
  data?: LogEvent;
};

/** Who is looking: used by projection and permissions. */
export type Viewer = { memberId: MemberId; role: "dm" | "player" };
