import { z } from "zod";
import { LIMITS, serializedBytes } from "./limits.ts";
import { ICON_KEY_RE } from "./imageRef.ts";
import {
  ABILITY_KEYS,
  CHUNK_CELLS,
  CONDITION_KEYS,
  CR_VALUES,
  FREE_WALL_ID_LENGTH,
  FREE_WALL_LATTICE,
  MAX_FREE_WALL_CELLS,
  MAX_HEIGHT_FT,
  MAX_LIGHT_FT,
  MIN_HEIGHT_FT,
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

const effectInput = z.strictObject({ ...effectBase, duration: durationInput.optional() });
const effectStored = z.strictObject({ ...effectBase, duration: durationStored.optional() });

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
  skipDefeated: z.boolean().optional(),
  monsterInitScore: z.boolean().optional(),
  revealHiddenOnTurn: z.boolean().optional(),
  turnTimerSec: z.number().int().min(0).max(MAX_TURN_TIMER_SEC).optional(),
  /** Who may draw (wave 5, section 3.9). */
  playersDraw: moveAnyToken.optional(),
  /** Healing brings back the dead (docs/design-v1-combat-flow.md 3.4). */
  healRevives: z.boolean().optional(),
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

const characterInput = z.strictObject({
  id,
  name,
  size: sizeSchema,
  ownerIds: memberIds,
  defaultImage: imageRef.optional(),
  actor: actorSchema,
  level: characterLevel.optional(),
});

const characterPatch = z.strictObject({
  name: name.optional(),
  size: sizeSchema.optional(),
  ownerIds: memberIds.optional(),
  defaultImage: imageRef.nullable().optional(),
  actor: actorPatch.optional(),
  level: characterLevel.nullable().optional(),
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
});

const entryInput = z
  .strictObject({
    id,
    tokenId: id.optional(),
    characterId: id.optional(),
    label: shortText.optional(),
    value: z.number().int().min(-50).max(100).nullable().optional(),
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
  op("token.move", { ...moveFields, squeeze: z.literal(true).optional(), teleport: z.enum(["wall", "ledge"]).optional() }),
  op("token.moveMany", { moves: z.array(z.strictObject(moveFields)).min(1).max(MAX_MOVES) }),
  /**
   * Marks the last leg of the active creature's path this turn as not
   * counting against its speed (a shove, Misty Step or a teleport), or as
   * counting again (features section 4). The token stays where it is.
   */
  op("token.countLeg", { tokenId: id, counts: z.boolean() }),
  op("actor.hp", { target: actorTarget, change: hpChange }),
  /**
   * Damage to several creatures in one step, such as everyone a Fireball
   * caught, each with its own amount: full on a failed save, half on a
   * success (features section 9). Each creature takes it by actor.hp's own
   * rules. One op, so it applies whole or not at all and one undo takes it
   * all back. DM only, since the DM confirms what an area deals.
   */
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
   * the Hit Point Dice spent on a short rest gave back, as the player rolled
   * them: the app rolls no dice.
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
    }),
  }),
  op("actor.effect.remove", { target: actorTarget, effectId: id }),
  op("character.create", { character: characterInput }),
  op("character.update", { characterId: id, patch: characterPatch }),
  op("character.delete", { characterId: id }),
  op("monster.create", { monster: monsterInput }),
  op("monster.update", { monsterId: id, patch: monsterPatch }),
  op("monster.delete", { monsterId: id }),
  /** The image an SRD monster's new tokens start with, or null to go back to none. */
  op("monster.setSrdImage", { srdId, image: imageRef.nullable() }),
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
  /**
   * Opens, closes or locks one door (section 4.1), and for a secret door
   * marks it found or hidden again. A player may only open or close a door
   * they see and can reach (shared/permissions.ts).
   */
  op("door.set", { sceneId: id, door: doorRef, state: z.enum(["open", "closed", "locked"]), found: z.boolean().optional() }),
  op("encounter.start", { entries: z.array(entryInput).max(MAX_ENTRIES_PER_OP) }),
  op("encounter.end", {}),
  op("encounter.add", { entries: z.array(entryInput).min(1).max(MAX_ENTRIES_PER_OP) }),
  op("encounter.remove", { entryIds: z.array(id).min(1).max(MAX_ENTRIES_PER_OP) }),
  op("encounter.setValue", { entryId: id, value: z.number().int().min(-50).max(100).nullable() }),
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
   * DC and a total, and keeps a replaced answer as `previous`.
   */
  op("roll.answer", { rollId: id, target: actorTarget, choice: rollChoiceIndex.optional(), total: rollTotal.optional(), result: rollResult.optional() }).refine(
    (o) => o.total !== undefined || o.result !== undefined,
    { message: "an answer has a total or a result" },
  ),
  /** Clears a target's answer, kept as `previous`, so its player may answer once more. */
  op("roll.reopen", { rollId: id, target: actorTarget }),
  op("roll.close", { rollIds: z.array(id).min(1).max(LIMITS.openRollsPerRoom) }),
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
export function isPoseOp(op: Op): op is OpOf<"token.move" | "token.moveMany" | "token.update" | "token.countLeg"> {
  if (op.t === "token.move" || op.t === "token.moveMany" || op.t === "token.countLeg") return true;
  if (op.t !== "token.update") return false;
  const fields = Object.keys(op.patch);
  return fields.length > 0 && fields.every((field) => field === "elevation" || field === "rotation");
}

/** Whether a player's applied op goes on their undo stack (design 7.7): their drawing ops and their moves. */
export function onPlayerUndoStack(op: Op): boolean {
  return op.t === "drawing.create" || op.t === "drawing.delete" || op.t === "drawing.clear" || isPoseOp(op);
}

export type ActorTarget = z.infer<typeof actorTarget>;
export type DurationInput = z.infer<typeof durationInput>;
export type EffectInput = z.infer<typeof effectInput>;
export type ActorPatch = z.infer<typeof actorPatch>;
export type TokenInput = z.infer<typeof tokenInput>;
export type TokenPatch = z.infer<typeof tokenPatch>;
/** A companion link as ops send it: `{ of, turn }` alone. */
export type CompanionLink = z.infer<typeof companion>;
export type CharacterInput = z.infer<typeof characterInput>;
export type CharacterPatch = z.infer<typeof characterPatch>;
export type MonsterInput = z.infer<typeof monsterInput>;
export type MonsterPatch = z.infer<typeof monsterPatch>;
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
export type TokenGroupPatch = z.infer<typeof tokenGroupPatch>;
export type HandoutInput = z.infer<typeof handoutInput>;
export type HandoutDocInput = z.infer<typeof handoutDocInput>;

export const actorTargetSchema = actorTarget;
export const fogOpSchema = fogOp;
export const effectInputSchema = effectInput;
export const actorSchemaForImport = actorSchema;
/** The stat block's fields, so the stored-state schema checks imported monsters by the same bounds. */
export const statBlockFieldsForImport = statBlockFields;
/** A custom monster as a create op carries it, for the editor to check a draft before it saves. */
export const monsterInputSchema = monsterInput;
/** The SRD id rule, so the stored-state schema checks imported SRD images the same way. */
export const srdIdSchema = srdId;
/** An area's reminders, so the stored-state schema checks imports the same way. */
export const areaTriggersSchema = areaTriggers;
/** A saved encounter's fields, so the stored-state schema checks imported ones by the same bounds. */
export const savedEncounterFieldsForImport = savedEncounterFields;
/** A saved encounter as a create op carries it, for the builder to check a draft before it saves. */
export const savedEncounterInputSchema = savedEncounterInput;
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
  z.strictObject({ k: z.literal("dragMove"), tokenId: id, x: coord, y: coord, path: z.array(coord).max(200).optional(), squeeze: z.literal(true).optional() }),
  z.strictObject({ k: z.literal("dragEnd"), tokenId: id, x: coord, y: coord, squeeze: z.literal(true).optional() }),
  z.strictObject({ k: z.literal("dragCancel"), tokenId: id }),
  z.strictObject({ k: z.literal("ruler"), id, points: z.array(rulerPoint).min(1).max(MAX_RULER_STOPS), shared: z.boolean().optional() }),
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
