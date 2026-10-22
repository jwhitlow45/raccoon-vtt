import { z } from "zod";
import { LIMITS, serializedBytes } from "./limits.ts";
import { ATTACH_KINDS } from "./rules/attach.ts";
import { critBound } from "./dice/crit.ts";
import { applyMode, diceCount, doubleDice, parseExtra, parseFormula, type Formula } from "./dice/formula.ts";
import { ICON_KEY_RE } from "./imageRef.ts";
import { DAMAGE_TYPES } from "./rules/damage.ts";
import {
  ABILITY_KEYS,
  CHUNK_CELLS,
  CONDITION_KEYS,
  CR_VALUES,
  CRIT_RULES,
  FREE_WALL_ID_LENGTH,
  FREE_WALL_LATTICE,
  MAX_FREE_WALL_CELLS,
  MAX_HEIGHT_FT,
  MAX_LIGHT_FT,
  MIN_HEIGHT_FT,
  ORDER_REVEALS,
  SKILL_KEYS,
  STAMP_MAX_CELLS,
  STAMP_MIN_CELLS,
  STATUS_KEYS,
} from "./model.ts";

/**
 * Every message and every op, as zod schemas with bounds (design sections 6,
 * 7.1, 8.1 and 10.5). The server validates with them before anything else
 * looks at a payload, and the client types its messages from them.
 *
 * Objects are strict, so an unknown field is a refusal rather than something
 * that slips through an allowlist later. Every string and array has a cap.
 */

// Bounds shared by several schemas.
export const MAX_NAME = 80;
export const MAX_CHAT = 1_000;
export const MAX_NOTES = 4_000;
export const MAX_OWNERS = 16;
export const MAX_EFFECTS = 32;
/** The highest counter an effect holds (its `level`). Exhaustion's level stays 1 to 6 (shared/reducer/actors.ts). */
export const MAX_EFFECT_LEVEL = 99;
export const MAX_DRAWING_POINTS = 2_000;
export const MAX_POLY_VERTICES = 200;
export const MAX_STROKE_POINTS = 500;
export const MAX_FOG_CELLS = 2_000;
export const MAX_FOG_DRAFT_OPS = 500;
export const MAX_BUILD_CELLS = 2_000;
export const MAX_BUILD_EDGES = 500;
export const MAX_MOVES = 100;
export const MAX_ENTRIES_PER_OP = 100;
export const MAX_SCENE_CELLS = 200;
export const MAX_EPH_BYTES = 4_096;
/** Stops on one ruler, live or kept. */
export const MAX_RULER_STOPS = 50;
/**
 * Stops on one turn's path, the start included. A creature with a 30 ft
 * speed that Dashes one square per drop makes 13, so a path this long is a
 * turn of many small taps, and its oldest corners merge (rules/path.ts).
 */
export const MAX_PATH_STOPS = 50;
/**
 * A route a move carries (docs/design-v1-movement.md 6.1, section 10): at
 * most 64 straight pieces and 300 squares of reach in all, each piece's
 * extra a whole number of feet per foot. A path keeps at most 100 corners
 * of its legs' routes, past which the oldest legs draw straight.
 */
export const MAX_ROUTE_PIECES = 64;
export const MAX_ROUTE_REACH = 300;
export const MAX_ROUTE_EXTRA = 7;
export const MAX_PATH_CORNERS = 100;
/** Routes an undo step keeps for one token, the moves a merged gesture made in order. */
export const MAX_KEPT_ROUTES = 32;
/** Range rings around one token, and the farthest one in feet. */
export const MAX_RANGE_RINGS = 4;
export const MAX_RANGE_RING_FT = 1_000;
export const MAX_RESTORE_ENTRIES = 5_000;
/** Images a token keeps besides the one it wears, for one-tap swaps. */
export const MAX_ALT_IMAGES = 6;
/** Entries per stat block section. The longest SRD section has 9. */
export const MAX_STAT_BLOCK_ENTRIES = 40;
/** The longest turn timer the DM can set: ten minutes. */
export const MAX_TURN_TIMER_SEC = 600;
/** The most legendary actions or Legendary Resistance uses one actor holds. */
export const MAX_LEGENDARY_USES = 10;
/**
 * Kinds of monster in one saved encounter, and creatures in all. Placing an
 * encounter sends one create op per creature, and 50 stay inside a socket's
 * op burst of 60 (design 10.4).
 */
export const MAX_ENCOUNTER_KINDS = 20;
export const MAX_ENCOUNTER_CREATURES = 50;
/** Levels in one saved encounter's party. */
export const MAX_PARTY_GROUPS = 10;

/**
 * Text rules. Single-line text refuses control characters and line or
 * paragraph separators: a room name reaches the admin CLI's terminal, where
 * an escape sequence would run, and a log line must stay one line. Names
 * also refuse bidi controls, which could make one roster name pass for
 * another, and need at least one character. Notes, chat and drawing text keep
 * tabs and line breaks and refuse every other control character.
 */
const SINGLE_LINE = /^[^\p{Cc}\u2028\u2029]*$/u;
const NAME_CHARS = /^[^\p{Cc}\u2028\u2029\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069]*$/u;
const MULTI_LINE = /^[^\x00-\x08\x0B\x0C\x0E-\x1F\x7F-\x9F]*$/u;

const line = (max: number) => z.string().max(max).regex(SINGLE_LINE, "control characters are not allowed");

const id = z.string().min(1).max(64);
/** A log entry's id, `"<seq>:<index>"` (shared/reducer/tx.ts). */
const logId = z.string().regex(/^\d{1,18}:\d{1,6}$/);
const name = z.string().min(1).max(MAX_NAME).regex(NAME_CHARS, "names cannot hold control or text direction characters");
const shortText = line(MAX_NAME);
const notes = z.string().max(MAX_NOTES).regex(MULTI_LINE, "control characters are not allowed");
const longText = z.string().max(MAX_CHAT).regex(MULTI_LINE, "control characters are not allowed");
const color = z.string().regex(/^#[0-9a-fA-F]{6}([0-9a-fA-F]{2})?$/);
/** A world coordinate in cells. Scenes are at most 200 cells wide, with some room to park things outside. */
const coord = z.number().min(-1_000).max(1_000);
const feet = z.number().int().min(-100_000).max(100_000);
/** A cell's ground height, as `build.height` paints it. */
const groundFeet = z.number().int().min(MIN_HEIGHT_FT).max(MAX_HEIGHT_FT);
const degrees = z.number().min(-360).max(360);
/** How far a cone or line aims up (or, negative, down): straight up at most. */
const pitch = z.number().min(-90).max(90);
const cellIndex = z.number().int().min(-1_000).max(1_000);
const cellKey = z.string().regex(/^-?\d{1,4},-?\d{1,4}$/);
const edgeKey = z.string().regex(/^-?\d{1,4},-?\d{1,4},[nw]$/);
const sheetUrl = line(500).regex(/^https:\/\//);
const areaFeet = z.number().min(5).max(1_000);
const memberIds = z.array(id).max(MAX_OWNERS);

const assetImage = z.strictObject({
  assetId: id,
  crop: z.strictObject({ cx: z.number().min(-1).max(1), cy: z.number().min(-1).max(1), zoom: z.number().min(0.1).max(10) }),
});
/**
 * A shipped game-icons.net icon on a disk of `color` (docs/design-v1-dm-tools.md
 * 3.12). Only the key's shape is checked: a key the client does not know
 * draws as initials, as an unknown stamp key draws as a dashed box.
 */
const iconKey = z.string().regex(ICON_KEY_RE, "not an icon key");
const iconImage = z.strictObject({ icon: iconKey, color: z.string().regex(/^#[0-9a-fA-F]{6}([0-9a-fA-F]{2})?$/) });
/** A token's, a portrait's or a monster's image: an upload from the room's library, or a shipped icon. */
const imageRef = z.union([assetImage, iconImage]);
/**
 * An SRD monster's slug, as shared/srd/monsters.ts writes them. The reducer
 * never loads the SRD list, which lives in a chunk of its own on the client,
 * so the shape is checked here and the count by the room limits.
 */
const srdId = z.string().min(1).max(80).regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, "not an SRD monster id");

const sizeSchema = z.enum(["tiny", "small", "medium", "large", "huge", "gargantuan", "custom"]);
const tokenKind = z.enum(["pc", "npc", "monster", "object"]);
const visibility = z.enum(["all", "dm"]);
const lifeState = z.enum(["alive", "dying", "stable", "dead"]);
const hpVisibility = z.enum(["hidden", "label", "bar", "exact"]);
const effectKey = z.enum([...CONDITION_KEYS, ...STATUS_KEYS, "custom"]);
const terrain = z.enum(["stone", "wood", "grass", "dirt", "cave", "water", "difficult", "rubble", "pit", "pillar", "stairs"]);

const speeds = z.strictObject({
  walk: z.number().int().min(0).max(1_000),
  fly: z.number().int().min(0).max(1_000).optional(),
  swim: z.number().int().min(0).max(1_000).optional(),
  climb: z.number().int().min(0).max(1_000).optional(),
  burrow: z.number().int().min(0).max(1_000).optional(),
  hover: z.boolean().optional(),
});

const legendaryCount = z.number().int().min(0).max(MAX_LEGENDARY_USES);
const legendary = z.strictObject({
  actionsMax: legendaryCount,
  actionsUsed: legendaryCount,
  resistMax: legendaryCount,
  resistUsed: legendaryCount,
});

const hpValue = z.number().int().min(0).max(100_000);

const durationAnchor = z.union([
  z.strictObject({ entryId: id }),
  z.strictObject({ tokenId: id }),
  z.strictObject({ characterId: id }),
]);

/**
 * A duration as the UI offers it (design 9.5). The reducer turns it into
 * boundary crossings of the anchor entry, or pauses it on a token or
 * character when the creature is not in an encounter.
 */
const durationInput = z.discriminatedUnion("mode", [
  z.strictObject({ mode: z.literal("turnStart"), of: durationAnchor }),
  z.strictObject({ mode: z.literal("turnEnd"), of: durationAnchor }),
  z.strictObject({ mode: z.literal("rounds"), rounds: z.number().int().min(1).max(1_000), of: durationAnchor }),
]);

const durationStored = z.strictObject({
  remaining: z.number().int().min(0).max(10_000),
  boundary: z.enum(["turnStart", "turnEnd"]),
  anchor: durationAnchor,
});

const effectBase = {
  id,
  key: effectKey,
  label: shortText.optional(),
  glyph: line(8).optional(),
  color: color.optional(),
  level: z.number().int().min(0).max(MAX_EFFECT_LEVEL).optional(),
  spell: shortText.optional(),
  hiddenFromPlayers: z.boolean().optional(),
  triggerShown: z.boolean().optional(),
};

/** The refusal of an outcome past `LIMITS.outcomeOpBytes`, which the group save checks before any roll. */
export const OUTCOME_TOO_BIG = "Too much for one step: remove a condition or split the group.";

/** An effect a save at the end of each of the creature's turns ends (docs/design-v1-roll-options.md 6.1). The DC is doc 1's 1 to 50. */
const effectSave = z.strictObject({
  ability: z.enum(ABILITY_KEYS),
  dc: z.number().int().min(LIMITS.rollDcMin).max(LIMITS.rollDcMax),
  spell: z.literal(true).optional(),
});

/** The pending, resolved or dismissed save of one turn end, named by that turn end's line. The server writes it. */
const effectDue = z.strictObject({ id: z.string().regex(/^\d{1,18}:\d{1,6}$/), state: z.enum(["pending", "resolved", "dismissed"]) });

const effectInput = z.strictObject({ ...effectBase, save: effectSave.optional(), duration: durationInput.optional() });
const effectStored = z.strictObject({ ...effectBase, save: effectSave.optional(), duration: durationStored.optional(), due: effectDue.optional() });

const actorSchema = z.strictObject({
  hp: z.strictObject({ cur: hpValue, max: hpValue, temp: hpValue }),
  life: lifeState,
  ac: z.number().int().min(0).max(100),
  speeds,
  initBonus: z.number().int().min(-20).max(40),
  initScore: z.number().int().min(-20).max(60).optional(),
  passivePerception: z.number().int().min(0).max(60),
  senses: shortText,
  creatureType: shortText.optional(),
  cr: line(8).optional(),
  xp: z.number().int().min(0).max(1_000_000).optional(),
  srdId: line(80).optional(),
  /** The room monster a token was placed from (wave 5). DM only, which permissions hold to. */
  monsterId: id.optional(),
  /** One of its character's companion stat blocks, on a companion only (docs/design-v1-companion-stat-blocks.md 3.2). */
  blockId: id.optional(),
  /** The SRD link is a character's Wild Shape (docs/design-v1-pc-stats.md 3.6). */
  wildShape: z.literal(true).optional(),
  sheetUrl: sheetUrl.optional(),
  effects: z.array(effectStored).max(MAX_EFFECTS),
  deathSaves: z.strictObject({ ok: z.number().int().min(0).max(3), fail: z.number().int().min(0).max(3) }),
  legendary: legendary.optional(),
  notes,
  dmNotes: notes,
});

/** The fields of an actor a patch may touch. HP goes through rules/hp.ts, life and effects through their own ops. */
const actorPatch = z.strictObject({
  hp: z.strictObject({ cur: hpValue.optional(), max: hpValue.optional(), temp: hpValue.optional() }).optional(),
  ac: z.number().int().min(0).max(100).optional(),
  speeds: speeds.optional(),
  initBonus: z.number().int().min(-20).max(40).optional(),
  initScore: z.number().int().min(-20).max(60).nullable().optional(),
  passivePerception: z.number().int().min(0).max(60).optional(),
  senses: shortText.optional(),
  creatureType: shortText.nullable().optional(),
  cr: line(8).nullable().optional(),
  xp: z.number().int().min(0).max(1_000_000).nullable().optional(),
  srdId: line(80).nullable().optional(),
  /** Attaches a room monster's stat block, or null detaches it (wave 5, section 3.6). Not an owner field. */
  monsterId: id.nullable().optional(),
  /**
   * Attaches one of its character's companion stat blocks, or null detaches
   * it (docs/design-v1-companion-stat-blocks.md 3.2). Setting any of the
   * three links to a value clears the other two.
   */
  blockId: id.nullable().optional(),
  /**
   * Goes with an `srdId` set in the same patch, on a character's own actor:
   * the shape is Wild Shape. A patch that sets `srdId` without it takes
   * another shape, and clearing `srdId` ends either (docs/design-v1-pc-stats.md 3.6).
   */
  wildShape: z.literal(true).optional(),
  sheetUrl: sheetUrl.nullable().optional(),
  legendary: legendary.nullable().optional(),
  notes: notes.optional(),
  dmNotes: notes.optional(),
});

const sceneGrid = z.strictObject({
  show: z.boolean(),
  color,
  opacity: z.number().min(0).max(1),
  lineWidth: z.number().min(0).max(10),
});
const pixelSize = z.number().int().min(1).max(16_384);
const sceneBounds = z.strictObject({
  w: z.number().int().min(1).max(MAX_SCENE_CELLS),
  h: z.number().int().min(1).max(MAX_SCENE_CELLS),
});
const sceneMap = z.strictObject({
  assetId: id,
  widthPx: pixelSize,
  heightPx: pixelSize,
  cellPx: z.number().min(1).max(16_384),
  originPx: z.strictObject({ x: z.number().min(-100_000).max(100_000), y: z.number().min(-100_000).max(100_000) }),
});
const defaultView = z.strictObject({ x: coord, y: coord, zoom: z.number().min(0.01).max(100) });

/** No player, every player, or the players listed (RoomSettings.playersMoveAny). */
const moveAnyToken = z.union([z.enum(["none", "all"]), z.array(id).max(LIMITS.membersPerRoom)]);

const settingsPatch = z.strictObject({
  feetPerCell: z.number().int().min(1).max(100).optional(),
  diagonal: z.enum(["five", "fiveTen", "euclid"]).optional(),
  aoeCoverage: z.enum(["half", "any", "center"]).optional(),
  aoeInclusion: z.enum(["anyCell", "center", "majority"]).optional(),
  pcHpVisibleToParty: z.boolean().optional(),
  monstersDieAtZero: z.boolean().optional(),
  playersSeeAoeOfOthers: z.boolean().optional(),
  playersMoveAny: moveAnyToken.optional(),
  playersCreateCharacters: z.boolean().optional(),
  playersApplyDamage: z.boolean().optional(),
  playersTypeTotals: z.boolean().optional(),
  skipDefeated: z.boolean().optional(),
  monsterInitScore: z.boolean().optional(),
  revealHiddenOnTurn: z.boolean().optional(),
  turnTimerSec: z.number().int().min(0).max(MAX_TURN_TIMER_SEC).optional(),
  /** Who may draw (wave 5, section 3.9). */
  playersDraw: moveAnyToken.optional(),
  /** Healing brings back the dead (docs/design-v1-combat-flow.md 3.4). */
  healRevives: z.boolean().optional(),
  /** How a critical hit rolls its damage (docs/design-v1-dice.md, critical hit rules). */
  critRule: z.enum(CRIT_RULES).optional(),
  /** Which creatures players see in the initiative order before their turn (docs/design-v1-combat-flow.md 11). */
  playersSeeOrder: z.enum(ORDER_REVEALS).optional(),
});

const fogShape = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("rect"), x: coord, y: coord, w: z.number().min(0).max(1_000), h: z.number().min(0).max(1_000) }),
  z.strictObject({ kind: z.literal("poly"), points: z.array(coord).min(6).max(MAX_POLY_VERTICES * 2) }),
  z.strictObject({
    kind: z.literal("stroke"),
    points: z.array(coord).min(2).max(MAX_STROKE_POINTS * 2),
    width: z.number().min(0.25).max(50),
  }),
  z.strictObject({ kind: z.literal("cells"), cells: z.array(cellKey).max(MAX_FOG_CELLS) }),
  z.strictObject({ kind: z.literal("all") }),
]);
const fogOp = z.strictObject({ id, mode: z.enum(["reveal", "hide"]), shape: fogShape });

const doorFeature = z.strictObject({
  kind: z.literal("door"),
  state: z.enum(["open", "closed", "locked"]),
  secret: z.boolean(),
  discovered: z.boolean(),
});

const edgeFeature = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("wall") }),
  z.strictObject({ kind: z.literal("none") }),
  doorFeature,
  z.strictObject({ kind: z.literal("window") }),
]);

/** What a free wall carries: an edge's features without "none", which only removes an automatic wall. */
const wallFeature = z.discriminatedUnion("kind", [z.strictObject({ kind: z.literal("wall") }), doorFeature, z.strictObject({ kind: z.literal("window") })]);

/**
 * A free wall's or a light's coordinate: a multiple of 1/64 cell inside the
 * largest scene, so every test of whether something touches or lies on it
 * stays exact (docs/design-v1-maps-vision.md section 2.1). A multiple of
 * 1/64 is a binary fraction, so the product below is exact. The reducer
 * checks the scene's own bounds.
 */
const latticeCoord = z
  .number()
  .min(0)
  .max(MAX_SCENE_CELLS)
  .refine((v) => Number.isInteger(v * FREE_WALL_LATTICE), { message: "not on the 1/64 cell lattice" });
const latticePoint = z.tuple([latticeCoord, latticeCoord]);
const freeWallId = z.string().regex(new RegExp(`^[A-Za-z0-9_-]{${FREE_WALL_ID_LENGTH}}$`), "not a free wall id");
/** A free wall is named by the chunk that holds it, so a chunk index is at most the largest scene's last one. */
const chunkIndex = z.number().int().min(0).max(Math.floor(MAX_SCENE_CELLS / CHUNK_CELLS));

/**
 * The squared length is exact on the lattice: each difference is a whole
 * number of 1/64 cells, so its square and the sum are exact in a double.
 */
const freeWall = z
  .strictObject({ id: freeWallId, a: latticePoint, b: latticePoint, f: wallFeature })
  .refine((w) => w.a[0] !== w.b[0] || w.a[1] !== w.b[1], { message: "a wall needs two different ends" })
  .refine((w) => (w.b[0] - w.a[0]) ** 2 + (w.b[1] - w.a[1]) ** 2 <= MAX_FREE_WALL_CELLS ** 2, {
    message: `a free wall is at most ${MAX_FREE_WALL_CELLS} cells long`,
  });

/** A shipped stamp's key: a slug, never a path, drawn from /stamps/<key>.webp. */
const stampKey = z.string().regex(/^[a-z0-9-]{1,40}$/, "not a stamp key");
const stampArt = z.union([z.strictObject({ key: stampKey }), z.strictObject({ assetId: id })]);
const stampCells = z.number().min(STAMP_MIN_CELLS).max(STAMP_MAX_CELLS);
const stampFields = {
  id,
  art: stampArt,
  x: coord,
  y: coord,
  w: stampCells,
  h: stampCells,
  rotation: degrees,
  tint: color.optional(),
  flip: z.boolean().optional(),
  z: z.number().int().min(-1_000_000).max(1_000_000),
  visibility,
};
const stampInput = z.strictObject(stampFields);

const lightFeet = z.number().min(0).max(MAX_LIGHT_FT);
/** A creature's carried light (Token.light): each radius at most the SRD's largest, as for a free light. */
const tokenLight = z.strictObject({ bright: lightFeet, dim: lightFeet });
const lightLevel = z.enum(["bright", "dim", "dark"]);
const sceneVision = z.strictObject({ on: z.boolean(), light: lightLevel });
const lightFields = {
  id,
  x: latticeCoord,
  y: latticeCoord,
  bright: lightFeet,
  dim: lightFeet,
  color: color.optional(),
  on: z.boolean(),
  walls: z.boolean(),
  label: shortText.optional(),
};
const lightInput = z.strictObject(lightFields);

const autoWalls = z.enum(["all", "floor", "off"]);
/** A Scenes panel folder: a single line that cannot pass for another name, as member names cannot. */
const folderName = z.string().min(1).max(LIMITS.folderNameChars).regex(NAME_CHARS, "folder names cannot hold control or text direction characters");
/** A map phase. Its size is the asset's, which the server fills in from the asset row before anything reads it. */
const mapPhase = z.strictObject({ id, name, assetId: id, widthPx: pixelSize, heightPx: pixelSize, light: lightLevel.optional() });
const mapPhases = z
  .array(mapPhase)
  .min(1)
  .max(LIMITS.phasesPerScene)
  .refine((list) => new Set(list.map((p) => p.id)).size === list.length, { message: "a phase is listed twice" });
/**
 * The calibration of a scene with phases, in the pixels of its reference
 * size (Scene.phaseGrid). The reducer holds each phase's own grid to the
 * map's bounds. The reference need not be any phase's size any more, so its
 * grid is bounded only by what scaling a map's grid between two sizes in
 * range can give.
 */
const refScale = 16_384;
const phaseGrid = z.strictObject({
  refWidthPx: pixelSize,
  refHeightPx: pixelSize,
  cellPx: z.number().positive().max(16_384 * refScale),
  originPx: z.strictObject({ x: z.number().min(-100_000 * refScale).max(100_000 * refScale), y: z.number().min(-100_000 * refScale).max(100_000 * refScale) }),
});

const areaShape = z.enum(["sphere", "cylinder", "cone", "cube", "line", "emanation"]);
/** When an area reminds the table it hits a creature again, each at most once. */
const areaTriggers = z
  .array(z.enum(["enter", "turnStart", "turnEnd"]))
  .min(1)
  .max(3)
  .refine((list) => new Set(list).size === list.length, { message: "a trigger is listed twice" });

const actorTarget = z.union([z.strictObject({ tokenId: id }), z.strictObject({ characterId: id })]);

/**
 * A token's link to its character, as an op sends it (docs/design-v1-combat-flow.md
 * 4.2): never the stored `reactionUsed`, which only `companionReaction`, Next
 * and Previous write.
 */
const companion = z.strictObject({ of: id, turn: z.enum(["own", "shared", "none"]) });

const tokenInput = z.strictObject({
  id,
  sceneId: id,
  kind: tokenKind,
  name,
  publicName: name.optional(),
  nameHidden: z.boolean().optional(),
  image: imageRef.optional(),
  size: sizeSchema,
  w: z.number().min(0.5).max(20).optional(),
  h: z.number().min(0.5).max(20).optional(),
  x: coord,
  y: coord,
  elevation: feet.optional(),
  height: z.number().int().min(0).max(10_000).optional(),
  rotation: degrees.optional(),
  disposition: z.enum(["ally", "neutral", "hostile"]).optional(),
  visibility: visibility.optional(),
  fogExempt: z.boolean().optional(),
  locked: z.boolean().optional(),
  layer: z.enum(["object", "token"]).optional(),
  ownerIds: memberIds.optional(),
  actor: z.union([z.strictObject({ ref: id }), z.strictObject({ inline: actorSchema })]),
  hpVisibility: hpVisibility.optional(),
  number: z.number().int().min(1).max(10_000).optional(),
  notes: notes.optional(),
  altImages: z.array(imageRef).max(MAX_ALT_IMAGES).optional(),
  rangeRings: z.array(z.number().int().min(5).max(MAX_RANGE_RING_FT)).max(MAX_RANGE_RINGS).optional(),
  light: tokenLight.optional(),
  partyVision: z.boolean().optional(),
  companion: companion.optional(),
});

const tokenPatch = z.strictObject({
  sceneId: id.optional(),
  kind: tokenKind.optional(),
  name: name.optional(),
  publicName: name.nullable().optional(),
  nameHidden: z.boolean().optional(),
  image: imageRef.nullable().optional(),
  size: sizeSchema.optional(),
  w: z.number().min(0.5).max(20).nullable().optional(),
  h: z.number().min(0.5).max(20).nullable().optional(),
  x: coord.optional(),
  y: coord.optional(),
  elevation: feet.optional(),
  height: z.number().int().min(0).max(10_000).nullable().optional(),
  rotation: degrees.optional(),
  disposition: z.enum(["ally", "neutral", "hostile"]).optional(),
  visibility: visibility.optional(),
  fogExempt: z.boolean().optional(),
  locked: z.boolean().optional(),
  layer: z.enum(["object", "token"]).optional(),
  ownerIds: memberIds.optional(),
  hpVisibility: hpVisibility.optional(),
  number: z.number().int().min(1).max(10_000).nullable().optional(),
  notes: notes.nullable().optional(),
  altImages: z.array(imageRef).max(MAX_ALT_IMAGES).nullable().optional(),
  /** An empty list takes the rings away. */
  rangeRings: z.array(z.number().int().min(5).max(MAX_RANGE_RING_FT)).max(MAX_RANGE_RINGS).optional(),
  /** Null puts the light out. The DM and the token's owners set it (section 4.3.9). */
  light: tokenLight.nullable().optional(),
  /** DM only. False takes the creature out of the party (section 4.3.2). */
  partyVision: z.boolean().optional(),
  /** Makes it a companion or changes how it is one. Null detaches it (docs/design-v1-combat-flow.md 3.6.9). */
  companion: companion.nullable().optional(),
  /** A `shared` companion's own Reaction spent or not, alone of everything about it (3.6.8). */
  companionReaction: z.boolean().optional(),
  actor: actorPatch.optional(),
});

/** A character's level, as the XP budget table counts them. */
const characterLevel = z.number().int().min(1).max(20);

/*
 * A player character's stat block (docs/design-v1-pc-stats.md 3.2 and 3.5).
 * A formula is bounded by its length and its characters and never parsed
 * here, so a later grammar never stops a stored op from replaying
 * (docs/design-v1-dice.md 4.1). The editor refuses what parseFormula
 * refuses, and a formula that stops parsing later shows as text with no
 * roll. Every list is free of repeats, and the whole block, or a patch of
 * it, is at most LIMITS.pcStatsBytes serialized.
 */
export const MAX_PC_ROLLS = 40;
export const MAX_PC_DICE_PARTS = 4;
const PC_FORMULA = /^[0-9dkhl%+\-− ]+$/i;
const pcFormula = (max: number) => z.string().min(1).max(max).regex(PC_FORMULA, "a formula holds dice and numbers only");
const pcName = (max: number) => z.string().min(1).max(max).regex(NAME_CHARS, "names cannot hold control or text direction characters");
const pcAbility = z.enum(ABILITY_KEYS);
const pcScore = z.number().int().min(1).max(30);
const pcAdjustValue = z.number().int().min(-20).max(20);
const pcDc = z.number().int().min(LIMITS.rollDcMin).max(LIMITS.rollDcMax);
function perKey<K extends string, T extends z.ZodType>(keys: readonly K[], value: T) {
  return z.strictObject(Object.fromEntries(keys.map((k) => [k, value.optional()])) as { [P in K]: z.ZodOptional<T> });
}
const unique = (list: readonly unknown[]) => new Set(list).size === list.length;
const withinPcStatsBytes = { message: `a stat block is at most ${LIMITS.pcStatsBytes / 1024} KiB` };

const pcDice = z
  .strictObject({
    formula: pcFormula(40),
    mod: z.literal(true).optional(),
    type: z.enum([...DAMAGE_TYPES, "healing"]).optional(),
    grows: z.literal(true).optional(),
    upcast: pcFormula(20).optional(),
    optional: z.literal(true).optional(),
    name: pcName(30).optional(),
  })
  .refine((d) => d.upcast === undefined || d.type !== undefined, { message: "only damage or healing grows with a higher slot" })
  .refine((d) => d.name === undefined || d.optional === true, { message: "only a rider has a name of its own" })
  // A rider is damage that applies only sometimes, which a named roll's damage parts alone can say.
  .refine((d) => d.optional === undefined || (d.type !== undefined && d.type !== "healing"), { message: "a rider is a damage part" });

const pcRoll = z
  .strictObject({
    id,
    name: pcName(60),
    kind: z.enum(["weapon", "spell", "other"]),
    ability: z.union([pcAbility, z.literal("spell")]).optional(),
    attack: z.strictObject({ prof: z.boolean(), bonus: pcAdjustValue }).optional(),
    save: z
      .strictObject({ ability: pcAbility, dc: pcDc.optional(), bonus: pcAdjustValue.optional(), onPass: z.enum(["half", "none"]).optional() })
      .refine((s) => s.dc === undefined || s.bonus === undefined, { message: "a save's DC is typed or worked out, not both" })
      .optional(),
    level: z.number().int().min(0).max(9).optional(),
    dice: z.array(pcDice).max(MAX_PC_DICE_PARTS),
    ddb: z.literal(true).optional(),
  })
  .refine((r) => r.attack !== undefined || r.save !== undefined || r.dice.length > 0, { message: "a roll needs an attack, a save or dice" });

const pcAdjust = z.strictObject({
  saves: perKey(ABILITY_KEYS, pcAdjustValue).optional(),
  skills: perKey(SKILL_KEYS, pcAdjustValue).optional(),
  allSaves: pcAdjustValue.optional(),
  allChecks: pcAdjustValue.optional(),
  init: pcAdjustValue.optional(),
  passive: pcAdjustValue.optional(),
  spellDc: pcAdjustValue.optional(),
  spellAttack: pcAdjustValue.optional(),
});

const pcParts = {
  abilities: z.strictObject({ str: pcScore, dex: pcScore, con: pcScore, int: pcScore, wis: pcScore, cha: pcScore }),
  saves: z.array(pcAbility).max(ABILITY_KEYS.length).refine(unique, { message: "a save is listed twice" }),
  skills: perKey(SKILL_KEYS, z.enum(["prof", "expert"])),
  adjust: pcAdjust,
  defenses: perKey(DAMAGE_TYPES, z.enum(["resistant", "immune", "vulnerable"])),
  rolls: z
    .array(pcRoll)
    .max(MAX_PC_ROLLS)
    .refine((rolls) => unique(rolls.map((r) => r.id)), { message: "two rolls share an id" }),
};
const pcCritOn = z.union([z.literal(19), z.literal(18)]);

/**
 * A Druid's known forms (docs/design-v1-known-forms.md 3.1), the most the
 * SRD's Beast Shapes table gives. Only the bound is checked: whether an id
 * is a Beast, or one a level may take, is the table's call, and the server
 * reads no SRD data for it, so a stored op never depends on that data.
 */
export const MAX_KNOWN_FORMS = 8;
const knownForms = z.array(srdId).max(MAX_KNOWN_FORMS).refine(unique, { message: "a known form is listed twice" });

const pcStats = z
  .strictObject({
    ...pcParts,
    jack: z.literal(true).optional(),
    alert: z.literal(true).optional(),
    spellAbility: pcAbility.optional(),
    critOn: pcCritOn.optional(),
    evasion: z.literal(true).optional(),
  })
  .refine((s) => serializedBytes(s) <= LIMITS.pcStatsBytes, withinPcStatsBytes);

/** Each part it names replaces that part whole, and null takes an optional one away (section 3.5). */
const pcStatsPatch = z
  .strictObject({
    abilities: pcParts.abilities.optional(),
    saves: pcParts.saves.optional(),
    skills: pcParts.skills.optional(),
    adjust: pcParts.adjust.optional(),
    defenses: pcParts.defenses.optional(),
    rolls: pcParts.rolls.optional(),
    jack: z.literal(true).nullable().optional(),
    alert: z.literal(true).nullable().optional(),
    spellAbility: pcAbility.nullable().optional(),
    critOn: pcCritOn.nullable().optional(),
    evasion: z.literal(true).nullable().optional(),
  })
  .refine((s) => serializedBytes(s) <= LIMITS.pcStatsBytes, withinPcStatsBytes);

/**
 * What a fill read (docs/design-v1-pc-stats.md 6.1, shared/rules/pcFill.ts),
 * as the D&D Beyond route answers it and the editor takes it: the block's
 * parts it read, each bounded as in the block, and the fields beside it. A
 * fill is checked by this before the route sends it and before the editor
 * shows it, so one that fails reads as `unreadable`.
 */
const pcFill = z.strictObject({
  source: z.enum(["paste", "ddb"]),
  stats: z.strictObject({
    abilities: pcParts.abilities.optional(),
    saves: pcParts.saves.optional(),
    skills: pcParts.skills.optional(),
    adjust: pcParts.adjust.optional(),
    defenses: pcParts.defenses.optional(),
    spellAbility: pcAbility.nullable().optional(),
    jack: z.boolean().optional(),
    alert: z.boolean().optional(),
    evasion: z.boolean().optional(),
    critOn: pcCritOn.nullable().optional(),
    rolls: pcParts.rolls,
  }),
  level: characterLevel.optional(),
  name: name.optional(),
  actor: z.strictObject({
    ac: z.number().int().min(0).max(100).optional(),
    hpMax: z.number().int().min(1).max(100_000).optional(),
    speeds: speeds.optional(),
    senses: shortText.optional(),
    sheetUrl: sheetUrl.optional(),
  }),
  warnings: z.array(line(400)).max(50),
});

const characterInput = z.strictObject({
  id,
  name,
  size: sizeSchema,
  ownerIds: memberIds,
  defaultImage: imageRef.optional(),
  actor: actorSchema,
  level: characterLevel.optional(),
  stats: pcStats.optional(),
});

const characterPatch = z.strictObject({
  name: name.optional(),
  size: sizeSchema.optional(),
  ownerIds: memberIds.optional(),
  defaultImage: imageRef.nullable().optional(),
  actor: actorPatch.optional(),
  level: characterLevel.nullable().optional(),
  /** Null removes the block. The actor keeps its last initiative and Passive Perception (docs/design-v1-pc-stats.md 3.5). */
  stats: pcStatsPatch.nullable().optional(),
  /** Replaces the list whole. An empty one removes it, so none and absent are one state. */
  knownForms: knownForms.optional(),
});

/** A stat block line the DM reads as text, such as the skills or the languages. */
const statLine = line(500);
const monsterSize = z.enum(["tiny", "small", "medium", "large", "huge", "gargantuan"]);
const monsterAc = z.number().int().min(0).max(100);
const monsterInitiative = z.number().int().min(-20).max(40);
const monsterHp = z.strictObject({ average: hpValue, formula: line(40) });
const abilityRow = z.strictObject({ score: z.number().int().min(0).max(99), save: z.number().int().min(-20).max(40) });
const abilities = z.strictObject({ str: abilityRow, dex: abilityRow, con: abilityRow, int: abilityRow, wis: abilityRow, cha: abilityRow });
const passive = z.number().int().min(0).max(60);
const crValue = line(4).refine((v) => (CR_VALUES as readonly string[]).includes(v), { message: "not a challenge rating" });
const xpValue = z.number().int().min(0).max(1_000_000);
const statEntries = z.array(z.strictObject({ name: line(120), text: notes })).max(MAX_STAT_BLOCK_ENTRIES);

/**
 * A custom monster's stat block (design section 6). Every text field is
 * bounded on its own, and the whole monster by the room limits' size for
 * one monster, so a create op stays far under the 64 KiB frame.
 */
const statBlockFields = {
  name,
  size: monsterSize,
  sizeAlt: monsterSize.optional(),
  type: line(120),
  alignment: line(120),
  ac: monsterAc,
  initiative: monsterInitiative,
  hp: monsterHp,
  speed: line(200),
  abilities,
  skills: statLine,
  vulnerabilities: statLine,
  resistances: statLine,
  immunities: statLine,
  gear: statLine,
  senses: statLine,
  passivePerception: passive,
  languages: statLine,
  cr: crValue,
  xp: xpValue,
  xpInLair: xpValue.optional(),
  traits: statEntries,
  actions: statEntries,
  bonusActions: statEntries,
  reactions: statEntries,
  legendaryActions: statEntries,
  defaultImage: imageRef.optional(),
};

const withinMonsterBytes = { message: `a monster is at most ${LIMITS.monsterBytes / 1024} KiB` };

const monsterInput = z.strictObject({ id, ...statBlockFields }).refine((m) => serializedBytes(m) <= LIMITS.monsterBytes, withinMonsterBytes);

/**
 * The stat block lines an edit changed. The editor sends only those, so two
 * DMs editing different lines of one monster both keep their work. The
 * optional lines take null to clear them.
 */
const monsterPatch = z
  .strictObject({
    name: name.optional(),
    size: monsterSize.optional(),
    sizeAlt: monsterSize.nullable().optional(),
    type: line(120).optional(),
    alignment: line(120).optional(),
    ac: monsterAc.optional(),
    initiative: monsterInitiative.optional(),
    hp: monsterHp.optional(),
    speed: line(200).optional(),
    abilities: abilities.optional(),
    skills: statLine.optional(),
    vulnerabilities: statLine.optional(),
    resistances: statLine.optional(),
    immunities: statLine.optional(),
    gear: statLine.optional(),
    senses: statLine.optional(),
    passivePerception: passive.optional(),
    languages: statLine.optional(),
    cr: crValue.optional(),
    xp: xpValue.optional(),
    xpInLair: xpValue.nullable().optional(),
    traits: statEntries.optional(),
    actions: statEntries.optional(),
    bonusActions: statEntries.optional(),
    reactions: statEntries.optional(),
    legendaryActions: statEntries.optional(),
    defaultImage: imageRef.nullable().optional(),
  })
  .refine((p) => serializedBytes(p) <= LIMITS.monsterBytes, withinMonsterBytes);

const withinBlockBytes = { message: `a stat block is at most ${LIMITS.companionBlockBytes / 1024} KiB` };

/**
 * A stat block a character keeps for its companions, as its create op
 * carries it (docs/design-v1-companion-stat-blocks.md 3.3): the monsters'
 * lines and bounds, with the character that keeps it and the SRD monster
 * it was copied from. The reducer sets `rev`.
 */
const companionBlockInput = z
  .strictObject({ id, characterId: id, fromSrd: srdId.optional(), ...statBlockFields })
  .refine((b) => serializedBytes(b) <= LIMITS.companionBlockBytes, withinBlockBytes);

/**
 * A saved encounter's monsters: an SRD monster by its id or one of the
 * room's own, each with a count, and at most MAX_ENCOUNTER_CREATURES in all.
 */
const encounterCount = z.number().int().min(1).max(MAX_ENCOUNTER_CREATURES);
const savedMonster = z.union([
  z.strictObject({ srdId, count: encounterCount, inLair: z.boolean().optional() }),
  z.strictObject({ monsterId: id, count: encounterCount, inLair: z.boolean().optional() }),
]);
const savedMonsters = z
  .array(savedMonster)
  .max(MAX_ENCOUNTER_KINDS)
  .refine((list) => list.reduce((n, m) => n + m.count, 0) <= MAX_ENCOUNTER_CREATURES, { message: `an encounter holds at most ${MAX_ENCOUNTER_CREATURES} creatures` });
const party = z.array(z.strictObject({ count: z.number().int().min(1).max(LIMITS.charactersPerRoom), level: characterLevel })).max(MAX_PARTY_GROUPS);

const savedEncounterFields = { name, monsters: savedMonsters, party: party.optional() };
const savedEncounterInput = z.strictObject({ id, ...savedEncounterFields });
const savedEncounterPatch = z.strictObject({ name: name.optional(), monsters: savedMonsters.optional(), party: party.nullable().optional() });

/** How an area changes movement inside it (AreaTemplate.slows). */
export const areaSlows = z.strictObject({ kind: z.enum(["difficult", "halfSpeed", "quarter"]), foes: z.literal(true).optional() });

/** Bounded like a token's custom size, elevation and height, since it is copied from one. */
const areaFootprint = z.strictObject({
  w: z.number().min(0.5).max(20),
  h: z.number().min(0.5).max(20),
  elevation: feet,
  height: z.number().min(0).max(10_000),
});

const templateFields = {
  sceneId: id,
  shape: areaShape,
  size: areaFeet,
  width: areaFeet.optional(),
  height: areaFeet.optional(),
  origin: z.strictObject({ x: coord, y: coord, z: feet }),
  yaw: degrees,
  pitch: pitch.optional(),
  faceOffset: z.strictObject({ u: z.number().min(-0.5).max(0.5), v: z.number().min(-0.5).max(0.5) }).optional(),
  anchor: z.enum(["bottom", "top"]).optional(),
  attachedTo: id.optional(),
  footprint: areaFootprint.optional(),
  triggers: areaTriggers.optional(),
  oncePerTurn: z.literal(true).optional(),
  slows: areaSlows.optional(),
  includeOrigin: z.boolean(),
  color,
  label: shortText.optional(),
  spell: shortText.optional(),
  casterId: id.optional(),
  ownerId: id,
  visibility,
};
const templateInput = z.strictObject({ id, ...templateFields });
const templatePatch = z.strictObject({
  shape: areaShape.optional(),
  size: areaFeet.optional(),
  width: areaFeet.nullable().optional(),
  height: areaFeet.nullable().optional(),
  origin: z.strictObject({ x: coord, y: coord, z: feet }).optional(),
  yaw: degrees.optional(),
  /** Null levels the area again. */
  pitch: pitch.nullable().optional(),
  faceOffset: z.strictObject({ u: z.number().min(-0.5).max(0.5), v: z.number().min(-0.5).max(0.5) }).nullable().optional(),
  anchor: z.enum(["bottom", "top"]).nullable().optional(),
  attachedTo: id.nullable().optional(),
  footprint: areaFootprint.nullable().optional(),
  /** Null turns the reminders off. */
  triggers: areaTriggers.nullable().optional(),
  /** Null lets each trigger remind once a turn on its own. */
  oncePerTurn: z.literal(true).nullable().optional(),
  /** Null makes movement inside normal. */
  slows: areaSlows.nullable().optional(),
  includeOrigin: z.boolean().optional(),
  color: color.optional(),
  label: shortText.nullable().optional(),
  spell: shortText.nullable().optional(),
  casterId: id.nullable().optional(),
  visibility: visibility.optional(),
});

const drawingInput = z.strictObject({
  id,
  sceneId: id,
  kind: z.enum(["free", "line", "rect", "ellipse", "polygon", "arrow", "text", "ruler"]),
  points: z.array(coord).min(2).max(MAX_DRAWING_POINTS),
  style: z.strictObject({
    stroke: color,
    fill: color.optional(),
    width: z.number().min(0).max(50),
    opacity: z.number().min(0).max(1),
    dash: z.array(z.number().min(0).max(100)).max(8).optional(),
  }),
  text: longText.optional(),
  ownerId: id,
  visibility,
  /** A kept ruler's token under each stop. The reducer checks it matches the stops. */
  anchors: z.array(id.nullable()).max(MAX_RULER_STOPS).optional(),
  /** A kept ruler's ground under each stop, in feet, 0 on a token. The reducer checks it matches the stops and the anchors. */
  z: z.array(groundFeet).max(MAX_RULER_STOPS).optional(),
  /** A kept ruler that measures the walk (Drawing.walk). */
  walk: z.literal(true).optional(),
});

const entryInput = z
  .strictObject({
    id,
    tokenId: id.optional(),
    characterId: id.optional(),
    label: shortText.optional(),
    value: z.number().int().min(-50).max(100).nullable().optional(),
    /** The tag of the dice line `value` came from, as `encounter.setValue` names it (shared/permissions.ts rolledInitiative). The reducer ignores it. */
    roll: id.optional(),
    hidden: z.boolean().optional(),
    inLair: z.boolean().optional(),
    groupKey: shortText.optional(),
    advantage: z.enum(["adv", "dis"]).optional(),
  })
  .refine((e) => e.tokenId !== undefined || e.characterId !== undefined || e.label !== undefined, {
    message: "an entry needs a token, a character or a label",
  });

const entryPatch = z.strictObject({
  hidden: z.boolean().optional(),
  reactionUsed: z.boolean().optional(),
  inLair: z.boolean().optional(),
  advantage: z.enum(["adv", "dis"]).nullable().optional(),
  label: shortText.nullable().optional(),
  groupKey: shortText.nullable().optional(),
});

const moveFields = { tokenId: id, x: coord, y: coord, elevation: feet.optional(), rotation: degrees.optional() };

/**
 * A walk's straight pieces from where the token stands, each piece's end in
 * order with its public extra feet per foot and whether one of them is the
 * swimming foot (docs/design-v1-movement.md 6.1). The lattice, the scene and
 * the reach are permissions' to check, since they need the token.
 */
export const routeSchema = z
  .array(z.tuple([coord, coord, z.number().int().min(0).max(MAX_ROUTE_EXTRA), z.union([z.literal(0), z.literal(1)])]))
  .min(1)
  .max(MAX_ROUTE_PIECES);

/** A door named by its grid edge, or a free door by its chunk and id (`door.set`). */
const doorRef = z.union([z.strictObject({ edge: edgeKey }), z.strictObject({ cx: chunkIndex, cy: chunkIndex, id: freeWallId })]);

/** A stair's direction as the Stairs brush sets it: by the rule, or north, east, south or west (section 4.2). */
const stairDirection = z.enum(["a", "n", "e", "s", "w"]);

/** A fog tile's bits: 512 bytes as base64 (shared/rules/fog.ts encodeTile). */
const tileBits = z.string().regex(/^[A-Za-z0-9+/]{683}=$/, "not a tile of bits");

/** A page's size bound: the map cap, so a later change to the handout pipeline needs no schema change. */
export const MAX_HANDOUT_PAGE_PX = 8_192;
const handoutPagePx = z.number().int().min(1).max(MAX_HANDOUT_PAGE_PX);
/** One page of a handout (docs/design-v1-pdf-handouts.md 3.3). The server puts the asset row's size over the client's. */
const handoutPage = z.strictObject({ assetId: id, width: handoutPagePx, height: handoutPagePx });
const handoutPages = z.array(handoutPage).min(1).max(LIMITS.handoutPages);
const handoutTo = z.union([z.literal("all"), z.array(id).min(1).max(50)]);

/**
 * One image, as every stored show has it, or the pages in order. Both are
 * strict, so a show with both `assetId` and `pages`, or with neither, is
 * refused rather than read one way or the other.
 */
const handoutInput = z.union([
  z.strictObject({ id, assetId: id, title: name, to: handoutTo }),
  z.strictObject({ id, pages: handoutPages, title: name, to: handoutTo }),
]);
/** A document as its create op carries it. The reducer sets `rev` and `createdAt`. */
const handoutDocInput = z.strictObject({ id, title: name, pages: handoutPages });

const hpChange = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("damage"), amount: z.number().int().min(0).max(100_000), crit: z.boolean().optional() }),
  z.strictObject({ kind: z.literal("heal"), amount: z.number().int().min(0).max(100_000) }),
  z.strictObject({ kind: z.literal("set"), cur: hpValue.optional(), max: hpValue.optional(), temp: hpValue.optional() }),
  z.strictObject({ kind: z.literal("temp"), amount: hpValue }),
]);

/**
 * A restore entry: the value an entity had, guarded by what it must hold
 * now. `expectRev: null` means it must be absent. `expectHash` is the hash
 * of the value it must have, its rev left out (Tx.inverse). A number in
 * `expectRev` is the rev guard of restores stored before value guards, and
 * a stored `sys.restore` from before `expectHash` existed has neither guard.
 * Both replay as they were applied.
 */
const restoreEntry = z.strictObject({
  key: z.string().min(1).max(200),
  value: z.unknown(),
  expectRev: z.number().int().min(0).nullable().optional(),
  expectHash: z.string().regex(/^[0-9a-f]{32}$/).optional(),
});

/** A turn of a fight, as a Next or Previous names the one it ends (`encounter.next` below). */
const turnRef = z.strictObject({ entry: id.nullable(), round: z.number().int().min(0).max(100_000) });

// Wave 5 (docs/design-v1-dm-tools.md).

/** A journal block's id: 12 random characters, unique in its page. */
const journalBlockId = z.string().regex(/^[A-Za-z0-9_-]{12}$/, "not a journal block id");
/**
 * A block as an op carries it. It says only whether it is secret, never
 * whether it is revealed: the reducer keeps each block's revealed state from
 * the stored block of the same id, so only `journal.reveal` reveals.
 */
const journalBlockInput = z.strictObject({ id: journalBlockId, text: notes, secret: z.literal(true).optional() });
const journalBlocks = z
  .array(journalBlockInput)
  .max(LIMITS.journalBlocksPerPage)
  .refine((list) => new Set(list.map((b) => b.id)).size === list.length, { message: "a block is listed twice" });
const journalAccess = z.union([z.enum(["dm", "all"]), z.strictObject({ member: id })]);
const journalPageInput = z.strictObject({ id, title: name, folder: folderName.optional(), access: journalAccess, blocks: journalBlocks });
const journalPatch = z.strictObject({
  title: name.optional(),
  /** Null takes the page out of its folder. */
  folder: folderName.nullable().optional(),
  access: journalAccess.optional(),
  /** The whole list, when any block changed. */
  blocks: journalBlocks.optional(),
});
const withinPageBytes = { message: `a journal page is at most ${LIMITS.journalPageBytes / 1024} KiB` };

const pinInput = z.strictObject({ id, sceneId: id, x: coord, y: coord, label: shortText.optional(), pageId: id.optional(), color, visibility });

const ability = z.enum(ABILITY_KEYS);
const skill = z.enum(SKILL_KEYS);
const rollChoice = z.strictObject({ ability, skill: skill.optional() });
const rollTest = z
  .strictObject({ kind: z.enum(["save", "check"]), choices: z.array(rollChoice).min(1).max(LIMITS.rollChoices) })
  .refine((t) => t.kind === "check" || t.choices.every((c) => c.skill === undefined), { message: "a saving throw names no skill" })
  .refine((t) => new Set(t.choices.map((c) => `${c.ability}:${c.skill ?? ""}`)).size === t.choices.length, { message: "a choice is listed twice" });
const rollDc = z.number().int().min(LIMITS.rollDcMin).max(LIMITS.rollDcMax);
const rollTotal = z.number().int().min(LIMITS.rollTotalMin).max(LIMITS.rollTotalMax);
const rollResult = z.enum(["pass", "fail"]);
const rollChoiceIndex = z.union([z.literal(0), z.literal(1)]);
const rollTargets = z
  .array(actorTarget)
  .min(1)
  .max(LIMITS.rollTargets)
  .refine((list) => new Set(list.map((t) => ("tokenId" in t ? `t:${t.tokenId}` : `c:${t.characterId}`))).size === list.length, { message: "a creature is listed twice" });
const rollRequestInput = z.strictObject({
  id,
  test: rollTest,
  dc: rollDc.optional(),
  dcShown: z.boolean(),
  resultShown: z.boolean(),
  note: line(LIMITS.rollNoteChars).optional(),
  targets: rollTargets,
  /** Wave 7 (docs/design-v1-roll-request.md 1.1): a save against a spell, which the test's bonuses read. */
  spell: z.literal(true).optional(),
  /** Public: what the request is for, so a player's card and the roll's test know a "save ends" save. */
  cause: z.literal("saveEnds").optional(),
  /** The DM's: the effect a pass removes and its save occurrence. The reducer holds it to one creature with that effect, asked once. */
  ends: z.strictObject({ effect: id, occurrence: id }).optional(),
});
/**
 * A stat block roll's key (shared/dice/named.ts blockActions): its section
 * (up to 16 characters), a colon, the slug of a name of up to 120, a
 * repeat's "-NN" and a part's ":later", so well past an id's 64. A
 * character's roll is keyed by its id, which fits too.
 */
const rollKey = line(160).min(1);

/**
 * A player's ask for saves (docs/design-v1-player-save-spell.md 5.2 and
 * 5.3): its caster and the players' scene, the spell's name as the row or
 * the area shows it, and exactly one of an area and the targets. `damage`
 * names the caster's damage roll, sent just before on the same socket, by
 * its tag and its batches. The server writes `by`, `at` and `rolled`.
 */
const castInput = z
  .strictObject({
    id,
    caster: id,
    sceneId: id,
    spell: line(LIMITS.diceLabelChars).min(1),
    roll: rollKey.optional(),
    slot: z.number().int().min(1).max(9).optional(),
    area: id.optional(),
    targets: z.array(id).min(1).max(LIMITS.rollTargets).optional(),
    damage: z.strictObject({ tag: id, parts: z.number().int().min(1).max(LIMITS.diceBatchesPerTag) }).optional(),
  })
  .refine((c) => (c.area === undefined) !== (c.targets === undefined), { message: "an ask names an area or its targets, one of the two" });
const castEnd = z.enum(["done", "dismissed", "withdrawn"]);
const castRolled = z.strictObject({ formula: z.string().min(1).max(LIMITS.diceFormulaChars), total: z.number().int().min(-100_000).max(100_000), type: z.enum(DAMAGE_TYPES).optional() });
/**
 * A player's ask to change an answer (docs/design-v1-roll-request.md 1.1):
 * its own id, the `tag` of the answer it would change, the reason, and a
 * reroll's face (an index into the answer's `dice.faces`) or Bardic
 * Inspiration's die.
 */
const rollChange = z.strictObject({
  id,
  on: id,
  reason: z.enum(["heroic-inspiration", "halfling-luck", "lucky", "bardic-inspiration", "fix-total"]),
  face: z.number().int().min(0).max(LIMITS.dicePerOp + 2).optional(),
  die: z.union([z.literal(6), z.literal(8), z.literal(10), z.literal(12)]).optional(),
});

// Dice (wave 7, docs/design-v1-dice.md 4.1 and 5.1).

const advantageMode = z.enum(["adv", "dis"]);
const critOn = z.union([z.literal(18), z.literal(19), z.literal(20)]);
/** One roll a `dice.roll` asks for. Its formula's grammar is checked on the client op, never on a stored one (diceRollAsked). */
const diceRollInput = z.strictObject({
  formula: line(LIMITS.diceFormulaChars),
  mode: advantageMode.optional(),
  label: line(LIMITS.diceLabelChars).optional(),
  creature: actorTarget.optional(),
  /** Its advantage sources held both kinds, so it rolls normally (3.3). */
  cancelled: z.literal(true).optional(),
  /** An attack roll's critical range (5.6). */
  critOn: critOn.optional(),
  /**
   * A save of this ability for its creature, so the resolve records `fails`
   * on it from a condition that fails that save whatever the total, as a
   * request's rolled save does (4.2, W7B-P-21). Ignored without `creature`.
   */
  save: ability.optional(),
  /**
   * A critical hit's damage, as asked: the resolve applies the room's rule
   * (the critical hit rules addendum), so no client computes a crit.
   */
  critical: z.literal(true).optional(),
  /**
   * The creature's initiative, so the line keeps it from players while the
   * order setting keeps the creature's place from them
   * (docs/design-v1-combat-flow.md 11.3). Ignored without `creature`.
   */
  initiative: z.literal(true).optional(),
});
const diceRollFields = {
  /** The receipt's key (1.2): one tag for a whole group, and `part` 0 to 19 for each batch of it. */
  tag: id,
  part: z.number().int().min(0).max(LIMITS.diceBatchesPerTag - 1).optional(),
  to: z.enum(["all", "dm"]),
  /** Each total is compared with one of them at most: a DC for a check or save, an AC for an attack (5.6). */
  dc: rollDc.optional(),
  ac: rollDc.optional(),
  rolls: z.array(diceRollInput).min(1).max(LIMITS.diceRollsPerOp),
};

/**
 * Each formula as the resolve will roll it: parsed, with its mode applied.
 * The words of the first that fails, so a raw op past a bound is refused
 * in the bound's own words (Appendix A). A critical's counts doubled, the
 * rule that draws the most, so the op's bounds hold under any room's rule.
 */
function diceFormulas(rolls: readonly { formula: string; mode?: "adv" | "dis"; critical?: true }[]): { ok: true; formulas: Formula[] } | { ok: false; message: string } {
  const formulas: Formula[] = [];
  for (const roll of rolls) {
    const parsed = parseFormula(roll.formula);
    if (!parsed.ok) return { ok: false, message: parsed.error };
    if (roll.critical) {
      const bound = critBound(parsed.formula);
      if (bound) return { ok: false, message: bound };
      formulas.push(doubleDice(parsed.formula));
      continue;
    }
    const applied = roll.mode ? applyMode(parsed.formula, roll.mode) : parsed;
    if (!applied.ok) return { ok: false, message: applied.error };
    formulas.push(applied.formula);
  }
  return { ok: true, formulas };
}

/**
 * A request's answer rolled on the server (docs/design-v1-dice.md 4.1, 7):
 * `extra` adds dice and numbers after the d20 and the bonus, `bonus` is the
 * player's own, used only where the server knows none, `unanswered` rolls
 * only a creature still waiting, and `change` is the DM's Allow of the ask
 * with that id, which rolls nothing else.
 */
const rollDiceFields = {
  tag: id,
  rollId: id,
  target: actorTarget,
  choice: rollChoiceIndex.optional(),
  mode: advantageMode.optional(),
  cancelled: z.literal(true).optional(),
  extra: line(LIMITS.diceExtraChars).optional(),
  bonus: z.number().int().min(-20).max(30).optional(),
  unanswered: z.literal(true).optional(),
  change: id.optional(),
};

/** A death save rolled on the server and counted from the state then (docs/design-v1-roll-options.md 4.3). */
const deathRollFields = {
  tag: id,
  target: actorTarget,
  mode: advantageMode.optional(),
  cancelled: z.literal(true).optional(),
  extra: line(LIMITS.diceExtraChars).optional(),
};

/** An extra that parses, in the grammar's own words when it does not. */
function extraParses(o: { extra?: string | undefined }, ctx: z.RefinementCtx): void {
  if (o.extra === undefined) return;
  const parsed = parseExtra(o.extra);
  if (!parsed.ok) ctx.addIssue({ code: "custom", message: parsed.error });
}

/** What a stored `sys.dice` asked: the client op's shape and length, with no formula parsed, so a later grammar never stops its replay. */
const diceRollAsked = z.strictObject({ t: z.literal("dice.roll"), ...diceRollFields });
const rollDiceAsked = z.strictObject({ t: z.literal("roll.dice"), ...rollDiceFields });
const deathRollAsked = z.strictObject({ t: z.literal("actor.deathRoll"), ...deathRollFields });

/** What the server drew for one roll (DiceResult). Bounded by shape alone, as `asked` is. */
const diceResult = z.strictObject({
  formula: line(200),
  faces: z.array(z.number().int().min(1).max(LIMITS.diceSidesMax)).max(LIMITS.dicePerOp + 2),
  total: z.number().int().min(-200_000).max(200_000),
  mode: advantageMode.optional(),
  cancelled: z.literal(true).optional(),
  fails: z.enum(CONDITION_KEYS).optional(),
  /** A critical hit's damage and the rule it was rolled under (the critical hit rules addendum). */
  crit: z.enum(CRIT_RULES).optional(),
});

/**
 * The fields one edit may set on a group of tokens (section 3.5): those
 * that make sense for every one of them alike. Names, notes, numbers, other
 * images, rings, places, scenes and stats stay per creature.
 */
const tokenGroupPatch = z
  .strictObject({
    visibility: visibility.optional(),
    locked: z.boolean().optional(),
    disposition: z.enum(["ally", "neutral", "hostile"]).optional(),
    hpVisibility: hpVisibility.optional(),
    size: sizeSchema.optional(),
    w: z.number().min(0.5).max(20).nullable().optional(),
    h: z.number().min(0.5).max(20).nullable().optional(),
    layer: z.enum(["object", "token"]).optional(),
    kind: tokenKind.optional(),
    nameHidden: z.boolean().optional(),
    fogExempt: z.boolean().optional(),
    image: imageRef.nullable().optional(),
    ownerIds: memberIds.optional(),
    light: tokenLight.nullable().optional(),
    partyVision: z.boolean().optional(),
  })
  .refine((p) => Object.keys(p).length > 0, { message: "a group edit changes something" });
const manyTokenIds = z
  .array(id)
  .min(1)
  .max(LIMITS.tokensPerManyOp)
  .refine((list) => new Set(list).size === list.length, { message: "a token is listed twice" });

// Traps (docs/design-v1-traps.md 6.1 and 6.2).

/** A trap's own id, as every id the app makes: so each list the reducer writes stays within its reserve (6.1). */
const plainId = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/, "not a plain id");
/** Half of a surrogate pair alone, which JSON escapes to six bytes: trap text refuses it, so it costs at most 3 bytes a unit (6.1). */
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
const wholeText = { message: "text cannot hold half a character" };
const whole = (s: string) => !LONE_SURROGATE.test(s);
const trapName = name.refine(whole, wholeText);
const trapLine = (max: number) => line(max).min(1).refine(whole, wholeText);
const trapNote = z.string().max(LIMITS.trapNoteChars).regex(MULTI_LINE, "control characters are not allowed").refine(whole, wholeText);
const sceneCell = z.number().int().min(0).max(MAX_SCENE_CELLS);
const cellRect = z.strictObject({ x: sceneCell, y: sceneCell, w: z.number().int().min(1).max(LIMITS.trapRectSide), h: z.number().int().min(1).max(LIMITS.trapRectSide) });
/** Cells two rectangles share count once. */
function rectCells(rects: readonly { x: number; y: number; w: number; h: number }[]): number {
  const seen = new Set<string>();
  for (const r of rects) for (let y = r.y; y < r.y + r.h; y++) for (let x = r.x; x < r.x + r.w; x++) seen.add(`${x},${y}`);
  return seen.size;
}
const cellRects = z
  .array(cellRect)
  .min(1)
  .max(LIMITS.trapRects)
  .refine((rects) => rectCells(rects) <= LIMITS.trapCells, { message: `squares are at most ${LIMITS.trapCells} cells` });
const halfCell = z
  .number()
  .min(0)
  .max(MAX_SCENE_CELLS)
  .refine((v) => Number.isInteger(v * 2), { message: "a wire's ends are on cell corners and edge midpoints" });
const trapWire = z
  .strictObject({ a: z.tuple([halfCell, halfCell]), b: z.tuple([halfCell, halfCell]) })
  .refine((w) => {
    const length = Math.sqrt((w.b[0] - w.a[0]) ** 2 + (w.b[1] - w.a[1]) ** 2);
    return length >= LIMITS.trapWireMin && length <= LIMITS.trapWireMax;
  }, { message: `a wire is ${LIMITS.trapWireMin} to ${LIMITS.trapWireMax} cells long` });
const trapZone = z.union([z.strictObject({ cells: cellRects }), z.strictObject({ wire: trapWire }), z.strictObject({ door: doorRef })]);
const trapArea = z.strictObject({
  shape: areaShape,
  size: areaFeet,
  width: areaFeet.optional(),
  height: areaFeet.optional(),
  origin: z.strictObject({ x: coord, y: coord, z: feet }),
  yaw: degrees,
  pitch: pitch.optional(),
  faceOffset: z.strictObject({ u: z.number().min(-0.5).max(0.5), v: z.number().min(-0.5).max(0.5) }).optional(),
  anchor: z.enum(["bottom", "top"]).optional(),
  includeOrigin: z.boolean(),
});
const trapCheck = z.strictObject({
  ability: z.enum(ABILITY_KEYS),
  skill: z.enum(SKILL_KEYS).optional(),
  dc: z.number().int().min(LIMITS.rollDcMin).max(LIMITS.rollDcMax),
  what: trapLine(LIMITS.trapCheckChars).optional(),
});
const trapAction = z.union([
  z.strictObject({ door: doorRef, state: z.enum(["open", "closed", "locked"]) }),
  z.strictObject({ light: id, on: z.boolean() }),
  z.strictObject({ show: z.union([z.strictObject({ tokenId: id }), z.strictObject({ stampId: id })]) }),
]);
const trapFormula = line(LIMITS.diceFormulaChars).min(1).refine((f) => parseFormula(f).ok, { message: "not a dice formula" });
export const TRAP_SOUNDS = ["click", "rumble", "crash", "whoosh", "hiss"] as const;
const trapTriggers = z
  .array(z.enum(["enter", "leave", "turnStart", "turnEnd"]))
  .max(4)
  .refine((list) => new Set(list).size === list.length, { message: "a trigger is listed twice" });
const trapHitsSchema = z.union([z.enum(["trigger", "zone"]), z.strictObject({ cells: cellRects }), z.strictObject({ area: trapArea })]);
const trapSave = z.strictObject({ ability: z.enum(ABILITY_KEYS), dc: z.number().int().min(LIMITS.rollDcMin).max(LIMITS.rollDcMax), onPass: z.enum(["half", "none"]) });
const trapDamage = z.array(z.strictObject({ formula: trapFormula, type: z.enum(DAMAGE_TYPES) })).min(1).max(LIMITS.trapDamageParts);
const trapConditions = z
  .array(z.enum(CONDITION_KEYS))
  .min(1)
  .max(LIMITS.trapConditions)
  .refine((list) => new Set(list).size === list.length, { message: "a condition is listed twice" });
const trapLasts = z
  .strictObject({ mode: z.enum(["turnStart", "turnEnd", "rounds"]), rounds: z.number().int().min(1).max(1_000).optional() })
  .refine((l) => (l.mode === "rounds") === (l.rounds !== undefined), { message: "rounds go with a duration in rounds" });
const trapDisarm = z.strictObject({ text: trapLine(LIMITS.trapDisarmChars).optional(), check: trapCheck.optional() });
const trapPreset = z.string().max(40).regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, "not a preset");
/** Ops set uses 1 to 99. Only the reducer leaves a trap at 0. */
const trapUses = z.number().int().min(1).max(99);
const trapPit = z.strictObject({ floor: z.number().int().min(MIN_HEIGHT_FT).max(MAX_HEIGHT_FT - 1) });

/** What a trap does, as an op sets it: never `noticedBy` or `due`, which only the reducer writes. */
const trapRigInput = z.strictObject({
  on: trapTriggers,
  who: z.enum(["party", "others", "any"]),
  minSize: z.literal("small").optional(),
  floor: z.boolean(),
  resets: z.enum(["never", "nextTurn"]),
  usesLeft: trapUses.optional(),
  stops: z.boolean(),
  foundOnSpring: z.boolean(),
  pit: trapPit.optional(),
  hits: trapHitsSchema,
  save: trapSave.optional(),
  damage: trapDamage.optional(),
  conditions: trapConditions.optional(),
  lasts: trapLasts.optional(),
  message: trapLine(LIMITS.trapMessageChars).optional(),
  sound: z.enum(TRAP_SOUNDS).optional(),
  actions: z.array(trapAction).max(LIMITS.trapActions),
  find: z.array(trapCheck).max(LIMITS.trapFindChecks),
  notice: z.boolean(),
  disarm: trapDisarm.optional(),
  note: trapNote.optional(),
  preset: trapPreset.optional(),
});

/** A rig's changed fields, each replaced whole, null taking an optional one away. */
const trapRigPatch = z
  .strictObject({
    on: trapTriggers.optional(),
    who: z.enum(["party", "others", "any"]).optional(),
    minSize: z.literal("small").nullable().optional(),
    floor: z.boolean().optional(),
    resets: z.enum(["never", "nextTurn"]).optional(),
    usesLeft: trapUses.nullable().optional(),
    stops: z.boolean().optional(),
    foundOnSpring: z.boolean().optional(),
    pit: trapPit.nullable().optional(),
    hits: trapHitsSchema.optional(),
    save: trapSave.nullable().optional(),
    damage: trapDamage.nullable().optional(),
    conditions: trapConditions.nullable().optional(),
    lasts: trapLasts.nullable().optional(),
    message: trapLine(LIMITS.trapMessageChars).nullable().optional(),
    sound: z.enum(TRAP_SOUNDS).nullable().optional(),
    actions: z.array(trapAction).max(LIMITS.trapActions).optional(),
    find: z.array(trapCheck).max(LIMITS.trapFindChecks).optional(),
    notice: z.boolean().optional(),
    disarm: trapDisarm.nullable().optional(),
    note: trapNote.nullable().optional(),
    preset: trapPreset.nullable().optional(),
  })
  .refine((p) => Object.keys(p).length > 0, { message: "a rig change changes something" });

/** A new trap: armed, with a plain id, its rig whole. */
const trapInput = z.strictObject({ id: plainId, sceneId: id, name: trapName, zone: trapZone, found: z.boolean().optional(), rig: trapRigInput });
const trapPatch = z
  .strictObject({
    name: trapName.optional(),
    zone: trapZone.optional(),
    state: z.enum(["armed", "sprung", "disarmed"]).optional(),
    found: z.boolean().optional(),
    rig: trapRigPatch.optional(),
  })
  .refine((p) => Object.keys(p).length > 0, { message: "a trap change changes something" });
/** An occurrence by its line in the DM's trap log (TrapDue.id). */
const trapDue = z.string().regex(/^\d{1,18}:\d{1,6}$/);

const op = <T extends string, S extends z.ZodRawShape>(t: T, shape: S) => z.strictObject({ t: z.literal(t), ...shape });

/** Ops a client may send (design 8.1). */
export const clientOps = [
  op("room.update", { name: name.optional(), settings: settingsPatch.optional() }),
  op("room.setPlayerScene", { sceneId: id }),
  op("view.follow", { follow: z.boolean() }),
  op("view.blackout", { blackout: z.boolean() }),
  op("member.update", { memberId: id, name: name.optional(), color: color.optional() }),
  op("scene.create", {
    scene: z.strictObject({
      id,
      name,
      bounds: sceneBounds,
      background: color.optional(),
      grid: sceneGrid.optional(),
      fogEnabled: z.boolean().optional(),
      map: sceneMap.optional(),
      defaultView: defaultView.optional(),
      /** The client picks it: "floor" for a scene from a map image, "off" for an import. Absent reads as "all". */
      autoWalls: autoWalls.optional(),
      folder: folderName.optional(),
      /** The client turns it on for new scenes (section 4.1). Absent reads as off. */
      blockMovement: z.boolean().optional(),
      vision: sceneVision.optional(),
      /** A Universal VTT import's mark (Scene.gridFromFile). No patch takes it, so it stays with the scene. */
      gridFromFile: z.literal(true).optional(),
    }),
  }),
  op("scene.update", {
    sceneId: id,
    patch: z.strictObject({
      name: name.optional(),
      bounds: sceneBounds.optional(),
      grid: sceneGrid.optional(),
      background: color.optional(),
      fogEnabled: z.boolean().optional(),
      defaultView: defaultView.nullable().optional(),
      autoWalls: autoWalls.optional(),
      /** Null takes the scene out of its folder. */
      folder: folderName.nullable().optional(),
      /** A `thumb` asset of this room. An edit of only this goes on no undo stack (server/rooms/undo.ts). */
      thumb: id.nullable().optional(),
      /**
       * The whole phase list, which is small. A scene's first list sets its
       * grid reference from the map it has then. Removing the active phase
       * switches to the first one left. `scene.setMap` with null removes them all.
       */
      phases: mapPhases.optional(),
      blockMovement: z.boolean().optional(),
      /** Turning vision on turns the scene's fog on too, unless the same patch says otherwise (section 4.3.1). */
      vision: sceneVision.optional(),
    }),
  }),
  op("scene.delete", { sceneId: id }),
  op("scene.reorder", { order: z.array(id).min(1).max(50) }),
  op("scene.setMap", { sceneId: id, map: sceneMap.nullable() }),
  op("scene.setGrid", { sceneId: id, cellPx: sceneMap.shape.cellPx, originPx: sceneMap.shape.originPx }),
  /** Switches the map to one of the scene's phases (docs/design-v1-maps-vision.md section 3.4). */
  op("scene.setPhase", { sceneId: id, phaseId: id }),
  /**
   * Copies a scene in one step (section 3.2). The copies' ids are derived
   * from `newSceneId` and the originals' ids (shared/reducer/duplicate.ts),
   * since an op carrying thousands of ids would pass the frame limit.
   */
  op("scene.duplicate", {
    sceneId: id,
    newSceneId: id,
    name,
    include: z.strictObject({ creatures: z.boolean(), characters: z.boolean(), fog: z.boolean(), drawings: z.boolean() }),
  }),
  op("token.create", { token: tokenInput }),
  op("token.update", { tokenId: id, patch: tokenPatch }),
  op("token.delete", { tokenId: id }),
  /**
   * `squeeze` stops the token squeezed in a narrow opening (Token.squeeze),
   * and is refused unless the opening is one (section 4.1). `teleport` says
   * the move is a "Teleport here" past a wall or a ledge: it skips the wall
   * test, its leg on the turn's path does not count, and the DM's log says so.
   */
  op("token.move", { ...moveFields, squeeze: z.literal(true).optional(), teleport: z.enum(["wall", "ledge"]).optional(), route: routeSchema.optional() })
    .refine((o) => o.route === undefined || o.teleport === undefined, { message: "a teleport walks no route" })
    .refine((o) => o.route === undefined || (o.route.at(-1)?.[0] === o.x && o.route.at(-1)?.[1] === o.y), { message: "a route ends where the move lands" }),
  op("token.moveMany", { moves: z.array(z.strictObject(moveFields)).min(1).max(MAX_MOVES) }),
  /**
   * Marks the last leg of the active creature's path this turn as not
   * counting against its speed (a shove, Misty Step or a teleport), or as
   * counting again (features section 4). The token stays where it is.
   */
  op("token.countLeg", { tokenId: id, counts: z.boolean() }),
  /**
   * Attaches a token to a holder (docs/design-v1-attach.md 8.1): a ride, a
   * perch, a carry or a drag, `steer` on a controlled ride alone. `x`, `y`
   * and `elevation` are the seat the client picked, which the reducer
   * checks fits, and for a drag where the creature stands. An attach of a
   * token already attached replaces its link.
   */
  op("token.attach", { tokenId: id, to: id, kind: z.enum(ATTACH_KINDS), steer: z.literal(true).optional(), x: coord, y: coord, elevation: feet }),
  /**
   * Detaches a token (8.1). A place is only for a creature getting off,
   * beside its holder: Put down and Let go leave it where it stands.
   */
  op("token.detach", { tokenId: id, x: coord.optional(), y: coord.optional(), elevation: feet.optional() })
    .refine((o) => (o.x === undefined) === (o.y === undefined), { message: "a place has both x and y" })
    .refine((o) => o.elevation === undefined || o.x !== undefined, { message: "an elevation comes with a place" }),
  op("actor.hp", { target: actorTarget, change: hpChange }),
  /**
   * Damage to several creatures in one step, such as everyone a Fireball
   * caught, each with its own amount: full on a failed save, half on a
   * success (features section 9). Each creature takes it by actor.hp's own
   * rules. One op, so it applies whole or not at all and one undo takes it
   * all back. DM only, since the DM confirms what an area deals.
   */
  /**
   * A group save's outcome (docs/design-v1-roll-options.md 5.5 and 8), the
   * DM's: for each creature, its damage by `actor.hp`'s rules, the
   * conditions to add as `actor.effects` adds them, the effects to remove,
   * and one more Legendary Resistance used. Whole or not at all, one undo
   * step, and its `plan` is its receipt's tag, so a plan sent again applies
   * at most once. `label` names it for undo: "Fireball".
   */
  op("actor.outcome", {
    plan: id,
    label: shortText.optional(),
    /**
     * The player's ask for saves this outcome resolves (docs/design-v1-player-save-spell.md 5.3), closed in the
     * same op with end "done". An outcome settles at most one thing: traps' `trap` (docs/design-v1-traps.md 6.2)
     * joins it here under a refine that refuses both.
     */
    cast: id.optional(),
    targets: z
      .array(
        z.strictObject({
          target: actorTarget,
          amount: z.number().int().min(1).max(100_000).optional(),
          effects: z.array(effectInput).min(1).max(LIMITS.outcomeEffectsEach).optional(),
          remove: z.array(id).min(1).max(LIMITS.outcomeEffectsEach).optional(),
          resist: z.literal(true).optional(),
        }),
      )
      .min(1)
      .max(LIMITS.outcomeTargets),
  }).refine((o) => serializedBytes(o) <= LIMITS.outcomeOpBytes, { message: OUTCOME_TOO_BIG }),
  op("actor.damageMany", {
    hits: z.array(z.strictObject({ target: actorTarget, amount: z.number().int().min(1).max(100_000) })).min(1).max(MAX_ENTRIES_PER_OP),
  }),
  op("actor.deathSave", {
    target: actorTarget,
    ok: z.number().int().min(0).max(3),
    fail: z.number().int().min(0).max(3),
  }),
  op("actor.life", { target: actorTarget, life: lifeState }),
  /**
   * A short or long rest (features section 15, SRD 5.2.1). `heal` is the HP
   * the Hit Point Dice spent on a short rest gave back, as the player typed
   * the total: a rest takes it as given and keeps no count of the dice.
   */
  op("actor.rest", { target: actorTarget, kind: z.enum(["short", "long"]), heal: hpValue.optional() }),
  op("actor.effect.add", { target: actorTarget, effect: effectInput }),
  op("actor.effect.update", {
    target: actorTarget,
    effectId: id,
    patch: z.strictObject({
      label: shortText.nullable().optional(),
      glyph: line(8).nullable().optional(),
      color: color.nullable().optional(),
      level: z.number().int().min(0).max(MAX_EFFECT_LEVEL).nullable().optional(),
      spell: shortText.nullable().optional(),
      hiddenFromPlayers: z.boolean().optional(),
      triggerShown: z.boolean().optional(),
      duration: durationInput.nullable().optional(),
      save: effectSave.nullable().optional(),
    }),
  }),
  op("actor.effect.remove", { target: actorTarget, effectId: id }),
  /**
   * The DM settles a save-ends occurrence no request is linked to
   * (docs/design-v1-roll-options.md 6.1): Accept failure or Dismiss on the
   * card. `due` is the occurrence, so a tap on an older card changes nothing.
   */
  op("actor.saveDue", { target: actorTarget, effectId: id, due: z.string().regex(/^\d{1,18}:\d{1,6}$/), state: z.enum(["resolved", "dismissed"]) }),
  op("character.create", { character: characterInput }),
  op("character.update", { characterId: id, patch: characterPatch }),
  op("character.delete", { characterId: id }),
  op("monster.create", { monster: monsterInput }),
  op("monster.update", { monsterId: id, patch: monsterPatch }),
  op("monster.delete", { monsterId: id }),
  /** The image an SRD monster's new tokens start with, or null to go back to none. */
  op("monster.setSrdImage", { srdId, image: imageRef.nullable() }),
  /**
   * A character's stat blocks for its companions
   * (docs/design-v1-companion-stat-blocks.md 3.3), the DM's and the
   * character's owners'. An edit sends the changed lines, as a monster's
   * does, and never names the character or the SRD source, which stay.
   */
  op("companionBlock.create", { block: companionBlockInput }),
  op("companionBlock.update", { blockId: id, patch: monsterPatch }),
  op("companionBlock.delete", { blockId: id }),
  op("savedEncounter.create", { encounter: savedEncounterInput }),
  /** `party: null` goes back to the room's characters. */
  op("savedEncounter.update", { encounterId: id, patch: savedEncounterPatch }),
  op("savedEncounter.delete", { encounterId: id }),
  op("template.create", { template: templateInput }),
  op("template.update", { templateId: id, patch: templatePatch }),
  op("template.delete", { templateId: id }),
  op("drawing.create", { drawing: drawingInput }),
  op("drawing.delete", { drawingId: id }),
  op("drawing.clear", { sceneId: id, scope: z.enum(["own", "all"]) }),
  op("fog.draft", { sceneId: id, add: z.array(fogOp).max(MAX_FOG_DRAFT_OPS).optional(), remove: z.array(id).max(MAX_FOG_DRAFT_OPS).optional() }),
  op("fog.publish", { sceneId: id }),
  op("fog.discard", { sceneId: id }),
  op("fog.live", { sceneId: id, ops: z.array(fogOp).min(1).max(MAX_FOG_DRAFT_OPS) }),
  op("fog.reset", { sceneId: id, to: z.enum(["hidden", "revealed"]) }),
  op("build.paint", { sceneId: id, terrain, cells: z.array(cellKey).min(1).max(MAX_BUILD_CELLS) }),
  op("build.erase", { sceneId: id, cells: z.array(cellKey).min(1).max(MAX_BUILD_CELLS) }),
  op("build.rect", {
    sceneId: id,
    terrain: terrain.nullable(),
    x: cellIndex,
    y: cellIndex,
    w: z.number().int().min(1).max(MAX_SCENE_CELLS),
    h: z.number().int().min(1).max(MAX_SCENE_CELLS),
  }),
  op("build.poly", { sceneId: id, terrain: terrain.nullable(), points: z.array(coord).min(6).max(MAX_POLY_VERTICES * 2) }),
  op("build.edge", {
    sceneId: id,
    edges: z.array(z.strictObject({ key: edgeKey, feature: edgeFeature.nullable() })).min(1).max(MAX_BUILD_EDGES),
  }),
  op("build.label", {
    sceneId: id,
    labelId: id,
    label: z.strictObject({ x: coord, y: coord, text: shortText, size: z.number().min(0.1).max(20) }).nullable(),
  }),
  op("build.clear", { sceneId: id }),
  /**
   * Free walls, named by the chunk that holds them and their id. A put lands
   * in its midpoint's chunk and replaces a wall of the same id there.
   * Removals apply first. The client batches an import under the byte bound.
   */
  op("build.walls", {
    sceneId: id,
    put: z.array(freeWall).max(LIMITS.freeWallsPerOp).optional(),
    remove: z.array(z.strictObject({ cx: chunkIndex, cy: chunkIndex, id: freeWallId })).max(LIMITS.freeWallsPerOp).optional(),
  }).refine((o) => serializedBytes(o) <= LIMITS.freeWallsOpBytes, { message: `a free walls op is at most ${LIMITS.freeWallsOpBytes / 1024} KiB` }),
  /** Stamps on the board layer. A put replaces a stamp of the same id on the same scene. Removals apply first. */
  op("build.stamps", {
    sceneId: id,
    put: z.array(stampInput).max(LIMITS.stampsPerOp).optional(),
    remove: z.array(id).max(LIMITS.stampsPerOp).optional(),
  }),
  /** Light sources, DM only in every wave. A put replaces a light of the same id on the same scene. Removals apply first. */
  op("build.lights", {
    sceneId: id,
    put: z.array(lightInput).max(LIMITS.lightsPerOp).optional(),
    remove: z.array(id).max(LIMITS.lightsPerOp).optional(),
  }),
  /**
   * Paints cells' ground to a height in feet (section 4.2), 0 clearing it.
   * Tokens standing on the ground there rise or sink with it in the same op.
   */
  op("build.height", { sceneId: id, cells: z.array(cellKey).min(1).max(MAX_BUILD_CELLS), height: z.number().int().min(MIN_HEIGHT_FT).max(MAX_HEIGHT_FT) }),
  /** Marks cells as stairs pointing up by the rule or one way, or clears the marks with null (section 4.2). */
  op("build.stairs", { sceneId: id, cells: z.array(cellKey).min(1).max(MAX_BUILD_CELLS), up: stairDirection.nullable() }),
  /** Marks cells as difficult ground or clears the marks (docs/design-v1-movement.md 6.3). Terrain is untouched, and no wall moves. */
  op("build.rough", { sceneId: id, cells: z.array(cellKey).min(1).max(MAX_BUILD_CELLS), on: z.boolean() }),
  /**
   * Opens, closes or locks one door (section 4.1), and for a secret door
   * marks it found or hidden again. A player may only open or close a door
   * they see and can reach (shared/permissions.ts).
   */
  /**
   * `by` names the creature that opens the door (docs/design-v1-traps.md
   * 5.3): its door traps go off for it. A player's open must name their own
   * token that reaches the door. A DM's may leave it out, and then sets no
   * trap off.
   */
  op("door.set", { sceneId: id, door: doorRef, state: z.enum(["open", "closed", "locked"]), found: z.boolean().optional(), by: id.optional() }),
  /** Traps, the DM's alone (docs/design-v1-traps.md 6.2). */
  op("trap.create", { trap: trapInput }),
  /** Only the fields that changed, so two DM devices editing different fields never undo each other. */
  op("trap.update", { trapId: id, patch: trapPatch }),
  op("trap.delete", { trapId: id }),
  /** Do its effects, for a private springing in a player's op that left them waiting. */
  op("trap.act", { trapId: id, due: trapDue }),
  /** Dismiss an occurrence, `sprung` marking the trap sprung (Mark sprung). */
  op("trap.settle", { trapId: id, due: trapDue, sprung: z.literal(true).optional() }),
  op("encounter.start", { entries: z.array(entryInput).max(MAX_ENTRIES_PER_OP) }),
  op("encounter.end", {}),
  op("encounter.add", { entries: z.array(entryInput).min(1).max(MAX_ENTRIES_PER_OP) }),
  op("encounter.remove", { entryIds: z.array(id).min(1).max(MAX_ENTRIES_PER_OP) }),
  /**
   * `roll` is the tag of the dice line a rolled value came from. While the
   * room has typed totals off, a player's value must be that roll's total
   * (shared/permissions.ts rolledInitiative). The reducer ignores it.
   */
  op("encounter.setValue", { entryId: id, value: z.number().int().min(-50).max(100).nullable(), roll: id.optional() }),
  op("encounter.setValues", {
    values: z.array(z.strictObject({ entryId: id, value: z.number().int().min(-50).max(100).nullable() })).min(1).max(MAX_ENTRIES_PER_OP),
  }),
  op("encounter.reorder", { entryIds: z.array(id).min(1).max(MAX_ENTRIES_PER_OP) }),
  /**
   * `from` names the turn the press ends: the acting row, null for Start
   * before any turn, and the round, since a lone combatant's next turn has
   * the same row. Once that turn is over, the op changes nothing and is
   * taken, so a player's End Turn and the DM's Next, two DM devices, or a
   * double tap move the turn once (features section 10). Ops stored
   * without it apply as they always did.
   */
  op("encounter.next", { from: turnRef.optional() }),
  op("encounter.prev", { from: turnRef.optional() }),
  op("encounter.update", { entryId: id, patch: entryPatch }),
  op("log.chat", { text: longText.min(1) }),
  op("log.whisper", { to: z.array(id).min(1).max(MAX_OWNERS), text: longText.min(1) }),
  op("handout.show", { handout: handoutInput }),
  op("handout.close", { handoutId: id }),
  /**
   * A PDF kept in the DM's library as a document of pages, under the id its
   * upload chose first, so a create sent twice cannot make two
   * (docs/design-v1-pdf-handouts.md 3.3). Both ops are the DM's.
   */
  op("handoutDoc.create", { doc: handoutDocInput }),
  op("handoutDoc.delete", { docId: id }),
  // Wave 5 (docs/design-v1-dm-tools.md).
  /** Several tokens changed alike in one step (section 3.5), whole or not at all. */
  op("token.updateMany", { tokenIds: manyTokenIds, patch: tokenGroupPatch }),
  /** Several tokens deleted in one step, each as `token.delete` deletes it. DM only. */
  op("token.deleteMany", { tokenIds: manyTokenIds }),
  /** Effects added to and removed from several creatures in one step, each checked as its single op would be. */
  op("actor.effects", {
    add: z.array(z.strictObject({ target: actorTarget, effect: effectInput })).max(LIMITS.effectsPerManyOp).optional(),
    remove: z.array(z.strictObject({ target: actorTarget, effectId: id })).max(LIMITS.effectsPerManyOp).optional(),
  }).refine((o) => (o.add?.length ?? 0) + (o.remove?.length ?? 0) > 0, { message: "an effects op adds or removes something" }),
  /** Journal pages (section 3.7), all DM only. A page's blocks are bounded with the rest of the op. */
  op("journal.create", { page: journalPageInput }).refine((o) => serializedBytes(o) <= LIMITS.journalPageBytes, withinPageBytes),
  op("journal.update", { pageId: id, patch: journalPatch }).refine((o) => serializedBytes(o) <= LIMITS.journalPageBytes, withinPageBytes),
  /** Reveals a secret block to the page's readers, or hides it again. Only this op changes what is revealed. */
  op("journal.reveal", { pageId: id, blockId: journalBlockId, revealed: z.boolean() }),
  /** Deletes a page, and in the same op makes every pin linked to it DM only and unlinks it. */
  op("journal.delete", { pageId: id }),
  /** A map pin (section 3.8): creates one, or replaces a pin of the same id on the same scene. */
  op("pin.put", { pin: pinInput }),
  op("pin.remove", { pinId: id }),
  /** Roll requests (section 3.3). Asking, reopening and closing are the DM's. */
  op("roll.ask", { request: rollRequestInput }),
  /**
   * A target's answer: a total with the choice rolled, or a save failed
   * without rolling (`result: "fail"`, no total). The DM may also mark a
   * result, alone or with a total. The reducer works out the result from a
   * DC and a total, and keeps a replaced answer as `previous`. `tag` is the
   * answer's client id, the key of its receipt (docs/design-v1-dice.md 1.2),
   * so an answer sent again with it never applies twice. Optional only so
   * stored ops replay (docs/design-v1-roll-request.md 7.5).
   */
  op("roll.answer", { rollId: id, target: actorTarget, choice: rollChoiceIndex.optional(), total: rollTotal.optional(), result: rollResult.optional(), tag: id.optional() }).refine(
    (o) => o.total !== undefined || o.result !== undefined,
    { message: "an answer has a total or a result" },
  ),
  /**
   * Clears a target's answer, kept as `previous`, so its player may answer once more. With `change`, the
   * DM's Allow of a "Fix my total" ask names it (docs/design-v1-roll-request.md 7.5), and the player may
   * then type the answer again but not roll it.
   */
  op("roll.reopen", { rollId: id, target: actorTarget, change: id.optional() }),
  /**
   * A player's ask to change their answer, which the DM allows or keeps (docs/design-v1-roll-request.md
   * 5.5 and 7.5), or the end of one: `ask` replaces any pending ask, and `clear` names the ask it ends,
   * the player's Withdraw or the DM's Keep. A face goes only with a reroll and a die only with Bardic
   * Inspiration, so the DM's card never reads a part the Allow would ignore.
   */
  op("roll.change", { rollId: id, target: actorTarget, ask: rollChange.optional(), clear: id.optional() })
    .refine((o) => (o.ask === undefined) !== (o.clear === undefined), { message: "a change asks or clears, one of the two" })
    .refine((o) => o.ask?.face === undefined || o.ask.reason === "heroic-inspiration" || o.ask.reason === "halfling-luck", { message: "a face goes with a reroll" })
    .refine((o) => o.ask?.die === undefined || o.ask.reason === "bardic-inspiration", { message: "a die goes with Bardic Inspiration" }),
  /**
   * Closes requests, settling each in the same op (docs/design-v1-roll-request.md 1.1): a pending ask is
   * kept, and a "save ends" request's occurrence is settled as `settle`, doc 3's Accept failure or Dismiss,
   * else by whether it was answered. `ifSettled` is "Close all answered": the server skips a request that
   * waits on a target or holds an ask when the op runs, so nothing that arrived after the tap closes unseen.
   */
  op("roll.close", {
    rollIds: z.array(id).min(1).max(LIMITS.openRollsPerRoom),
    settle: z.enum(["resolved", "dismissed"]).optional(),
    ifSettled: z.literal(true).optional(),
  }),
  /**
   * A player's ask for saves against their creature's spell (docs/design-v1-player-save-spell.md 5.3), and its end:
   * the DM's resolve with nothing to apply or dismissal, or a withdrawal by a player of its caster. The ask's id is its
   * receipt tag, so an ask sent again asks once.
   */
  op("cast.ask", { cast: castInput }),
  op("cast.close", { castId: id, end: castEnd }),
  /**
   * Rolls on the server (docs/design-v1-dice.md 4.1): 1 to 20 formulas, 100
   * dice in all after each mode, every formula parsing and every mode
   * applying, and the whole op at most 3 KiB serialized. The actor turns it
   * into the `sys.dice` it stores, holding every die it drew.
   */
  op("dice.roll", diceRollFields)
    .refine((o) => o.dc === undefined || o.ac === undefined, { message: "a roll is compared with a DC or an AC, not both" })
    // A critical hit's damage is damage: no d20 test, and so never a save (the critical hit rules addendum).
    .refine((o) => o.rolls.every((r) => !r.critical || (r.mode === undefined && r.cancelled === undefined && r.save === undefined && r.critOn === undefined)), {
      message: "a critical hit's damage is no d20 roll",
    })
    .superRefine((o, ctx) => {
      const checked = diceFormulas(o.rolls);
      if (!checked.ok) ctx.addIssue({ code: "custom", message: checked.message });
      else if (checked.formulas.reduce((n, f) => n + diceCount(f), 0) > LIMITS.dicePerOp) ctx.addIssue({ code: "custom", message: "Roll 1 to 100 dice, as 1d20+5." });
    })
    .refine((o) => serializedBytes(o) <= LIMITS.diceOpBytes, { message: "That is too much to roll at once. Roll fewer at a time." }),
  /** A request's answer rolled on the server (docs/design-v1-dice.md 7). The Allow of an ask carries nothing else that rolls. */
  op("roll.dice", rollDiceFields)
    .superRefine(extraParses)
    .refine((o) => o.change === undefined || (o.mode === undefined && o.cancelled === undefined && o.extra === undefined && o.bonus === undefined && o.choice === undefined && o.unanswered === undefined), {
      message: "an allowed change rolls only what the ask names",
    }),
  /** A death save rolled on the server (docs/design-v1-dice.md 4.1), permitted as `actor.deathSave` is. */
  op("actor.deathRoll", deathRollFields).superRefine(extraParses),
  op("undo", {
    /**
     * The `n` of this client's op that made the step the undo is meant for,
     * such as the token bar's "Undo move". The server then takes back that
     * step or nothing, never an older one (design 7.7).
     */
    of: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER).optional(),
    /**
     * The DM only: the log line of an HP change to take back, whoever made
     * it (features section 10). The server builds the restore from that line
     * and refuses it when the creature changed since.
     */
    log: logId.optional(),
  }),
  op("redo", {}),
] as const;

/**
 * Ops only the server produces: roster changes made over HTTP, and the
 * resolved form of undo and redo (design 7.7). A client that sends one is
 * refused by `clientOpSchema` before permissions ever see it.
 */
export const serverOnlyOps = [
  op("sys.memberJoin", {
    member: z.strictObject({ id, name, color, kind: z.enum(["dm", "player"]), createdAt: z.string().max(40) }),
  }),
  op("sys.memberSetKind", { memberId: id, kind: z.enum(["dm", "player"]) }),
  /** Takes a member with no grants left off the roster (S-15), with everything it owned let go. */
  op("sys.memberRemove", { memberId: id }),
  op("sys.restore", {
    entries: z.array(restoreEntry).min(1).max(MAX_RESTORE_ENTRIES),
    /** Which stack the restore came from, so the server can push its inverse on the other one. */
    from: z.enum(["undo", "redo"]),
    /**
     * Set on every restore the server builds since restores check what
     * depends on them (design 7.7). A stored restore without it was accepted
     * under the older rules and replays under them, so a room whose op log
     * holds one still loads.
     */
    deps: z.literal(true).optional(),
    /** The log line of the HP change this restore takes back, so the log says so (an undo with `log`). */
    undid: logId.optional(),
    /**
     * The step is a teleport's (`token.move` with `teleport`), so a player's
     * redo of it skips the wall and ledge test as the teleport did (section
     * 4.1). Only permissions read it.
     */
    teleport: z.literal(true).optional(),
    /**
     * The routes of the step's moves, by token, in the order they were
     * made, so a player's redo meets the walls along each piece as the
     * moves did (docs/design-v1-movement.md 7.4). Only permissions read it.
     */
    routes: z.record(id, z.array(routeSchema).min(1).max(MAX_KEPT_ROUTES)).optional(),
    /**
     * The controlled rides a player's step ended or made on a turn, each
     * with that turn's seq (docs/design-v1-attach.md 8.3). The restore puts
     * the mount back on the turn's list only when the same turn is under way
     * and the restored ride is the one it names, so an undone Get off or a
     * redone mounting shares the turn again and nothing else ever does.
     */
    rides: z.array(z.strictObject({ seq: z.number().int().min(0), mount: id, rider: id })).min(1).max(LIMITS.turnMounts).optional(),
    /**
     * The silent passengers among the entries (docs/design-v1-attach.md
     * 8.3): tokens that rode along by a chain not every player sees when the
     * step was made, put back by their holder's move alone. A player's
     * restore checks never read them, so no hidden change answers. Only
     * permissions read it, and only the server builds a restore.
     */
    quiet: z.array(id).min(1).max(MAX_RESTORE_ENTRIES).optional(),
  }),
  /**
   * What the party saw this batch that the scene's explored layer lacked
   * (section 4.3.3): each changed tile's new bits, which only ever add. The
   * actor appends it to the batch on the player scene. Replay applies the
   * stored bits and never computes sight.
   */
  op("sys.explore", {
    sceneId: id,
    tiles: z
      .array(z.strictObject({ tx: chunkIndex, ty: chunkIndex, bits: tileBits }))
      .min(1)
      .max((Math.floor(MAX_SCENE_CELLS / CHUNK_CELLS) + 1) ** 2),
  }),
  /**
   * A dice op as the server resolved it (docs/design-v1-dice.md 4.1): the
   * client op as it arrived, its `batch` (16 characters of the SHA-256 of
   * the roller and the tag), and one result per roll, in order, holding
   * every die drawn. The reducer only copies them, so replay never rolls.
   */
  op("sys.dice", {
    asked: z.discriminatedUnion("t", [diceRollAsked, rollDiceAsked, deathRollAsked]),
    batch: z.string().regex(/^[A-Za-z0-9_-]{16}$/, "not a batch id"),
    results: z.array(diceResult).min(1).max(LIMITS.diceRollsPerOp),
    /** A request's answer rolled with the bonus the player typed, since the server knew none (4.1). */
    typedBonus: z.literal(true).optional(),
  }),
] as const;

export const clientOpSchema = z.discriminatedUnion("t", [...clientOps]);
export const serverOnlyOpSchema = z.discriminatedUnion("t", [...serverOnlyOps]);
export const opSchema = z.discriminatedUnion("t", [...clientOps, ...serverOnlyOps]);

export type ClientOp = z.infer<typeof clientOpSchema>;
export type ServerOnlyOp = z.infer<typeof serverOnlyOpSchema>;
export type Op = z.infer<typeof opSchema>;
export type OpType = Op["t"];
export type OpOf<T extends OpType> = Extract<Op, { t: T }>;

/**
 * Whether an op only moves tokens: a move, a token update of nothing but
 * elevation and facing, or marking whether the last move counts. A
 * player's undo takes such a step back as a move (server/rooms/undo.ts),
 * which puts back the path of the turn with the position, and the token
 * bar offers to take it back after one, so an owner's own height or facing
 * change after a drag never reads as someone else moving the token.
 */
export function isPoseOp(op: Op): op is OpOf<"token.move" | "token.moveMany" | "token.update" | "token.countLeg" | "token.attach" | "token.detach"> {
  // A mistaken Ride should not cost a Get off at half Speed, so attaching and detaching undo as moves (docs/design-v1-attach.md 8.3).
  if (op.t === "token.move" || op.t === "token.moveMany" || op.t === "token.countLeg" || op.t === "token.attach" || op.t === "token.detach") return true;
  if (op.t !== "token.update") return false;
  const fields = Object.keys(op.patch);
  return fields.length > 0 && fields.every((field) => field === "elevation" || field === "rotation");
}

/** The fields of a resize patch: the size, the place it takes, and Custom's width and height, which only the DM sends. */
const RESIZE_FIELDS = new Set(["size", "x", "y", "w", "h"]);

/**
 * Whether an op is a resize patch (docs/design-v1-token-window.md 8.6): a
 * token update of its size and nothing but the place it takes there, and
 * for Custom its width and height. A player's undo takes it back as it
 * takes back a move, the size with the place, keeping later edits
 * (server/rooms/undo.ts). It is not a move, so the token bar's "Undo move"
 * does not offer it.
 */
export function isResizeOp(op: Op): boolean {
  return op.t === "token.update" && op.patch.size !== undefined && Object.keys(op.patch).every((field) => RESIZE_FIELDS.has(field));
}

/** Whether a player's applied op goes on their undo stack (design 7.7): their drawing ops, their moves and their resizes. */
export function onPlayerUndoStack(op: Op): boolean {
  return op.t === "drawing.create" || op.t === "drawing.delete" || op.t === "drawing.clear" || isPoseOp(op) || isResizeOp(op);
}

export type ActorTarget = z.infer<typeof actorTarget>;
export type DiceRollInput = z.infer<typeof diceRollInput>;
export type DiceResultInput = z.infer<typeof diceResult>;
export type DurationInput = z.infer<typeof durationInput>;
export type EffectInput = z.infer<typeof effectInput>;
export type ActorPatch = z.infer<typeof actorPatch>;
export type TokenInput = z.infer<typeof tokenInput>;
export type TokenPatch = z.infer<typeof tokenPatch>;
/** A companion link as ops send it: `{ of, turn }` alone. */
export type CompanionLink = z.infer<typeof companion>;
export type CharacterInput = z.infer<typeof characterInput>;
export type CharacterPatch = z.infer<typeof characterPatch>;
export type PcStatsPatch = z.infer<typeof pcStatsPatch>;
export type MonsterInput = z.infer<typeof monsterInput>;
export type MonsterPatch = z.infer<typeof monsterPatch>;
export type CompanionBlockInput = z.infer<typeof companionBlockInput>;
export type SavedEncounterInput = z.infer<typeof savedEncounterInput>;
export type SavedEncounterPatch = z.infer<typeof savedEncounterPatch>;
export type TemplateInput = z.infer<typeof templateInput>;
export type TemplatePatch = z.infer<typeof templatePatch>;
export type DrawingInput = z.infer<typeof drawingInput>;
export type EntryInput = z.infer<typeof entryInput>;
export type EntryPatch = z.infer<typeof entryPatch>;
export type RestoreEntry = z.infer<typeof restoreEntry>;
export type FogOpInput = z.infer<typeof fogOp>;
export type HpChange = z.infer<typeof hpChange>;
export type FreeWallInput = z.infer<typeof freeWall>;
export type StampInput = z.infer<typeof stampInput>;
export type LightInput = z.infer<typeof lightInput>;
export type MapPhaseInput = z.infer<typeof mapPhase>;
export type DoorRef = z.infer<typeof doorRef>;
export type JournalPageInput = z.infer<typeof journalPageInput>;
export type JournalPatch = z.infer<typeof journalPatch>;
export type JournalBlockInput = z.infer<typeof journalBlockInput>;
export type PinInput = z.infer<typeof pinInput>;
export type RollRequestInput = z.infer<typeof rollRequestInput>;
export type CastInput = z.infer<typeof castInput>;
export type TrapInput = z.infer<typeof trapInput>;
export type TrapPatch = z.infer<typeof trapPatch>;
export type TrapRigPatch = z.infer<typeof trapRigPatch>;
export type TokenGroupPatch = z.infer<typeof tokenGroupPatch>;
export type HandoutInput = z.infer<typeof handoutInput>;
export type HandoutDocInput = z.infer<typeof handoutDocInput>;

export const actorTargetSchema = actorTarget;
export const fogOpSchema = fogOp;
export const effectInputSchema = effectInput;
/**
 * A file's actor also holds `unshaped`, which only the reducer writes, so no
 * op's actor carries it (W7B-P-9).
 */
export const actorSchemaForImport = actorSchema.extend({
  unshaped: z.strictObject({ ac: z.number().int().min(0).max(100), speeds, shapeTemp: z.literal(true).optional() }).optional(),
});
/** The stat block's fields, so the stored-state schema checks imported monsters by the same bounds. */
export const statBlockFieldsForImport = statBlockFields;
/** A custom monster as a create op carries it, for the editor to check a draft before it saves. */
export const monsterInputSchema = monsterInput;
/** A companion's stat block as a create op carries it, for the editor to check a draft before it saves. */
export const companionBlockInputSchema = companionBlockInput;
/** The SRD id rule, so the stored-state schema checks imported SRD images the same way. */
export const srdIdSchema = srdId;
/** An area's reminders, so the stored-state schema checks imports the same way. */
export const areaTriggersSchema = areaTriggers;
/** A saved encounter's fields, so the stored-state schema checks imported ones by the same bounds. */
export const savedEncounterFieldsForImport = savedEncounterFields;
/** A saved encounter as a create op carries it, for the builder to check a draft before it saves. */
export const savedEncounterInputSchema = savedEncounterInput;
/** A character's stat block, so the stored-state schema checks imported ones by the same bounds and the editor checks a draft before it saves. */
export const pcStatsForImport = pcStats;
/** A character's known forms, so the stored-state schema checks imported ones by the same bound. */
export const knownFormsSchema = knownForms;
/** A stat block's patch, for the editor to check what it sends. */
export const pcStatsPatchSchema = pcStatsPatch;
/** A fill as the D&D Beyond route answers it (docs/design-v1-pc-stats.md 6.3). */
export const pcFillSchema = pcFill;
/** Who may move any token, so the stored-state schema checks imports the same way. */
export const moveAnyTokenSchema = moveAnyToken;
/** The text rules above, so the stored-state schema checks imports the same way. */
export const textSchemas = { name, shortText, notes, longText };
/**
 * The wave 3 shapes, so the stored-state schema checks imports by the same
 * bounds and the Universal VTT import checks what it will send.
 */
export const mapSchemas = {
  freeWall,
  freeWallId,
  wallFeature,
  latticeCoord,
  stampFields,
  stampInput,
  lightFields,
  lightInput,
  mapPhase,
  mapPhases,
  phaseGrid,
  autoWalls,
  folderName,
  /** Wave 4's shapes, for the stored-state schema. */
  tokenLight,
  lightLevel,
  sceneVision,
  tileBits,
};
/** Wave 5's shapes, so the stored-state schema checks imports by the same bounds (docs/design-v1-dm-tools.md 2.5). */
export const dmToolSchemas = {
  imageRef,
  iconKey,
  journalBlockId,
  journalAccess,
  pinInput,
  rollTest,
  rollDc,
  rollTotal,
  rollResult,
  rollChoiceIndex,
  whichPlayers: moveAnyToken,
};
/** Wave 7's shapes, so the stored-state schema checks imported dice lines by the same bounds (docs/design-v1-dice.md 5.3). */
export const diceSchemas = { diceResult, critOn, advantageMode };
/** Wave 7's answer fields, so the stored-state schema checks imported requests and lines by the same bounds. */
export const rollAnswerSchemas = { rollChange };
/** A player's ask for saves, so the stored-state schema checks imported asks by the same bounds (docs/design-v1-player-save-spell.md 5.7). */
export const castSchemas = { castInput, castEnd, castRolled };
/** A trap's fields, so the stored-state schema checks imported traps by the same bounds (docs/design-v1-traps.md 6.2). */
export const trapSchemas = { plainId, trapName, trapZone, trapRigInput, trapDue, cellRects, trapMessage: trapLine(LIMITS.trapMessageChars) };
/** A handout's pages and audience, so the stored-state schema checks imports by the same bounds (docs/design-v1-pdf-handouts.md 3.3). */
export const handoutSchemas = { handoutPage, handoutPages, handoutTo };
/** A document as its create op carries it, for the upload job to check its save before it sends it. */
export const handoutDocInputSchema = handoutDocInput;

// Ephemeral events (design 7.6). Never stored, forwarded per scene.

const point = z.strictObject({ x: coord, y: coord });
/**
 * A ruler stop. A free one carries `z`, the ground the measurer saw under
 * it, left out at 0, so every receiver reads the measurer's distance. A
 * stop on a token takes its height from the token, so it carries none.
 */
const rulerPoint = z
  .strictObject({ x: coord, y: coord, z: groundFeet.optional(), tokenId: id.optional() })
  .refine((p) => p.z === undefined || p.tokenId === undefined, { message: "a stop on a token takes its height from the token" });

export const ephEventSchema = z.discriminatedUnion("k", [
  z.strictObject({ k: z.literal("dragStart"), tokenId: id, x: coord, y: coord }),
  // `squeeze` is the dragging client's own preview, for drawing only: the server judges a frame's footprint itself (section 4.1).
  // `path` is the live route's corners and `ft` its cost (docs/design-v1-movement.md 6.5). The server sends `ft` only to the DM and the token's owners.
  z.strictObject({
    k: z.literal("dragMove"),
    tokenId: id,
    x: coord,
    y: coord,
    path: z.array(coord).max(200).optional(),
    ft: z.number().min(0).max(100_000).optional(),
    squeeze: z.literal(true).optional(),
  }),
  z.strictObject({ k: z.literal("dragEnd"), tokenId: id, x: coord, y: coord, squeeze: z.literal(true).optional() }),
  z.strictObject({ k: z.literal("dragCancel"), tokenId: id }),
  z.strictObject({ k: z.literal("ruler"), id, points: z.array(rulerPoint).min(1).max(MAX_RULER_STOPS), shared: z.boolean().optional(), walk: z.literal(true).optional() }),
  z.strictObject({ k: z.literal("rulerEnd"), id }),
  z.strictObject({
    k: z.literal("aoe"),
    id,
    shape: areaShape,
    origin: z.strictObject({ x: coord, y: coord, z: feet }),
    yaw: degrees,
    pitch: pitch.optional(),
    size: areaFeet,
    width: areaFeet.optional(),
    height: areaFeet.optional(),
    shared: z.boolean().optional(),
  }),
  z.strictObject({ k: z.literal("aoeEnd"), id }),
  z.strictObject({ k: z.literal("ping"), x: coord, y: coord }),
  z.strictObject({ k: z.literal("laser"), x: coord, y: coord, on: z.boolean() }),
  z.strictObject({ k: z.literal("focus"), x: coord, y: coord, zoom: z.number().min(0.01).max(100) }),
  /**
   * A DM device's camera for table displays (wave 5, docs/design-v1-dm-tools.md
   * 3.1): the center, width and height of its visible map area, in cells.
   * Only a DM sends it, and only display sockets on its scene receive it.
   */
  z.strictObject({ k: z.literal("view"), x: coord, y: coord, w: z.number().min(0.01).max(2_000), h: z.number().min(0.01).max(2_000) }),
]);
export type EphEvent = z.infer<typeof ephEventSchema>;

/** The frame budget caps a whole message. This cap is the ephemeral payload on its own. */
function withinEphBytes(e: unknown): boolean {
  return serializedBytes(e) <= MAX_EPH_BYTES;
}

// Client to server messages (design 7.1).

export const clientMessageSchema = z.discriminatedUnion("t", [
  z.strictObject({
    t: z.literal("hello"),
    clientId: z.string().min(1).max(64),
    resumeFrom: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
    sceneId: id.optional(),
  }),
  z.strictObject({
    t: z.literal("op"),
    n: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
    op: z.unknown(),
    /** The undo group (design 7.7): ops sent under one group, one after another, undo as one step. */
    g: id.optional(),
  }),
  z.strictObject({ t: z.literal("eph"), sceneId: id, e: ephEventSchema.refine(withinEphBytes, { message: "ephemeral payload too large" }) }),
  z.strictObject({ t: z.literal("scene"), sceneId: id }),
  z.strictObject({ t: z.literal("ping"), k: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER) }),
]);
export type ClientMessage = z.infer<typeof clientMessageSchema>;

// Server to client messages.

export const refusalCodes = ["invalid", "forbidden", "gone", "quota"] as const;
export type RefusalCode = (typeof refusalCodes)[number];

export const changeSchema = z.union([
  z.strictObject({ key: z.string().min(1).max(200), value: z.unknown() }),
  z.strictObject({ key: z.string().min(1).max(200), deleted: z.literal(true) }),
]);
export type Change = z.infer<typeof changeSchema>;

export const serverMessageSchema = z.discriminatedUnion("t", [
  z.strictObject({
    t: z.literal("snapshot"),
    seq: z.number().int().min(0),
    state: z.unknown(),
    /**
     * `display` is a table display (wave 5, section 3.1): its projection is a
     * player's who owns nothing, and it sends nothing but `hello` and `ping`.
     */
    you: z.strictObject({ memberId: id, role: z.enum(["dm", "player", "display"]), sceneId: id.nullable() }),
    watermark: z.number().int().min(0),
  }),
  z.strictObject({
    t: z.literal("ev"),
    seq: z.number().int().min(0),
    changes: z.array(changeSchema),
    acks: z.array(z.number().int().min(1)).optional(),
    rejects: z
      .array(z.strictObject({ n: z.number().int().min(1), code: z.enum(refusalCodes), message: z.string().max(200) }))
      .optional(),
    /** This client's undos and redos in the batch, each with what it took back, for the toast (design 7.7). */
    restored: z.array(z.strictObject({ n: z.number().int().min(1), what: z.string().max(200) })).optional(),
  }),
  z.strictObject({ t: z.literal("retry"), n: z.number().int().min(1).optional(), code: z.enum(["busy", "gap"]) }),
  z.strictObject({ t: z.literal("eph"), from: id, e: ephEventSchema }),
  /** `online` never lists a table display. DM sockets also get `displays`, how many display sockets are open (wave 5). */
  z.strictObject({ t: z.literal("presence"), online: z.array(id).max(1_000), displays: z.number().int().min(0).max(1_000).optional() }),
  /**
   * Someone tapped the X-card (wave 5, docs/design-v1-dm-tools.md 3.11). Sent
   * to every socket of the room, the sender's too. It names no one, and
   * nothing about it is stored.
   */
  z.strictObject({ t: z.literal("xcard"), at: z.string().max(40) }),
  z.strictObject({ t: z.literal("wait"), ms: z.number().int().min(0) }),
  z.strictObject({ t: z.literal("pong"), k: z.number().int().min(0) }),
  z.strictObject({ t: z.literal("resync"), reason: z.string().max(80) }),
  /**
   * DM sockets only: something about getting into the room changed outside
   * its state (the player password, a DM device added or signed out), so
   * the DM views that show it ask the server again instead of polling
   * (design 10.2).
   */
  z.strictObject({ t: z.literal("access") }),
]);
export type ServerMessage = z.infer<typeof serverMessageSchema>;

// Image search results and credits (wave 5, docs/design-v1-dm-tools.md 3.13).

/**
 * An openly licensed image's credit, as an Openverse result carries it.
 * Every field is bounded text, so the library and the token panel can show
 * it as it is. `landingUrl` is the image's page, linked with
 * `rel="noopener noreferrer"`.
 */
const imageCreditFields = {
  /** The work's own title, so the credit reads "Title by Author, License". */
  title: line(200).optional(),
  creator: line(200).optional(),
  /** Openverse's license code, such as "by-nc-sa" or "cc0". */
  license: line(40),
  licenseVersion: line(16).optional(),
  landingUrl: line(2_048).regex(/^https?:\/\//, "not a web address"),
  attribution: line(LIMITS.creditAttributionChars),
};
export const imageCreditSchema = z.strictObject(imageCreditFields);
export type ImageCredit = z.infer<typeof imageCreditSchema>;

/**
 * The credit an imported image keeps on its asset row (`assets.credit`),
 * never one a client sends: the search result's, with the width and height
 * of the image as it was fetched, so the credit says "Resized" only when the
 * stored size differs.
 */
export const assetCreditSchema = z.strictObject({
  ...imageCreditFields,
  originalWidth: z.number().int().min(1).max(100_000),
  originalHeight: z.number().int().min(1).max(100_000),
  /**
   * A starter pick's own account of what was changed before it shipped
   * (docs/design-v1-starter-art.md 9), shown in place of the app's guess.
   * An Openverse import has none.
   */
  changes: line(300).optional(),
});
export type AssetCredit = z.infer<typeof assetCreditSchema>;

/** The service a search's results came from. */
export type SearchSource = "google" | "openverse";

/**
 * One image search result, as the server sends it to the picker. The
 * original's size is there only when the service said, and `credit` only on
 * an Openverse result.
 */
export type SearchResult = {
  thumbnail: string;
  original: string;
  title: string;
  source: string;
  original_width?: number;
  original_height?: number;
  credit?: ImageCredit;
};
