import { z } from "zod";
import { ABILITY_KEYS, CONDITION_KEYS, CRIT_RULES, HEIGHTS_CHARS, MAX_HEIGHT_FT, MIN_HEIGHT_FT, ORDER_REVEALS, ROUGH_CHARS, STAIRS_CHARS, STATUS_KEYS, TURN_FLAGS, type MapPhase, type PhaseGrid, type RoomState, type SceneMap } from "#shared/model.ts";
import { chunkKey, holderChunkKey } from "#shared/keys.ts";
import { LIMITS, MOST_SIGHT_HOLDERS, serializedBytes } from "#shared/limits.ts";
import { ATTACH_KINDS } from "#shared/rules/attach.ts";
import { DAMAGE_TYPES } from "#shared/rules/damage.ts";
import { withLevelInRange } from "#shared/srd/conditions.ts";
import {
  MAX_ALT_IMAGES,
  castSchemas,
  trapSchemas,
  TRAP_SOUNDS,
  diceSchemas,
  dmToolSchemas,
  rollAnswerSchemas,
  MAX_EFFECTS,
  MAX_OWNERS,
  MAX_PATH_STOPS,
  MAX_RANGE_RINGS,
  MAX_PATH_CORNERS,
  MAX_RANGE_RING_FT,
  MAX_RULER_STOPS,
  MAX_TURN_TIMER_SEC,
  actorSchemaForImport,
  combatUseSchemas,
  durationRemainingSchema,
  effectDueSchema,
  areaSlows,
  areaTriggersSchema,
  moveAnyTokenSchema,
  pcStatsForImport,
  knownFormsSchema,
  ddbSyncForImport,
  syncAtAhead,
  fogOpSchema,
  handoutSchemas,
  mapSchemas,
  memorySchemas,
  savedEncounterFieldsForImport,
  srdIdSchema,
  statBlockFieldsForImport,
  textSchemas,
} from "#shared/protocol.ts";
import { MAX_LOG_LINES } from "#shared/logRings.ts";
import { phaseMap, phaseProblem } from "#shared/reducer/phases.ts";
import { OWN_SQUARE_GRID, cameWithGrid, holdsGridKeys, isHex, sceneGrid, sceneHolds, standsWords } from "#shared/rules/grid.ts";

/**
 * The shape of a stored room state, for validating an imported `room.json`
 * (design 16.4). It mirrors shared/model.ts field for field and is strict,
 * so an export from a newer version with fields this server does not know
 * is refused rather than loaded with holes.
 *
 * Counts per collection are left to `checkLimits`, which already knows the
 * room limits. Only the shapes and the per-entity bounds live here.
 */
const id = z.string().min(1).max(64);
const { name, shortText, longText, notes } = textSchemas;
const color = z.string().regex(/^#[0-9a-fA-F]{6}([0-9a-fA-F]{2})?$/);
const rev = z.number().int().min(0);
const coord = z.number().min(-1_000).max(1_000);
const iso = z.string().max(40);
const memberIds = z.array(id).max(MAX_OWNERS);
/** What a log line counts, such as the tokens a deleted character took with it. */
const count = z.number().int().min(0).max(1_000_000);
/** An upload or, from wave 5, a shipped icon (docs/design-v1-dm-tools.md 3.12). */
const imageRef = dmToolSchemas.imageRef;
const sizeSchema = z.enum(["tiny", "small", "medium", "large", "huge", "gargantuan", "custom"]);
const visibility = z.enum(["all", "dm"]);

const settings = z.strictObject({
  feetPerCell: z.number().int().min(1).max(100),
  diagonal: z.enum(["five", "fiveTen", "euclid"]),
  aoeCoverage: z.enum(["half", "any", "center"]),
  aoeInclusion: z.enum(["anyCell", "center", "majority"]),
  pcHpVisibleToParty: z.boolean(),
  monstersDieAtZero: z.boolean(),
  playersSeeAoeOfOthers: z.boolean(),
  playersMoveAny: moveAnyTokenSchema,
  // Older rooms and backups have no such setting: it reads as off. This differs
  // from DEFAULT_SETTINGS (on, for new rooms) on purpose, since those rooms were
  // made under the old default and must not gain a permission.
  playersCreateCharacters: z.boolean().default(false),
  playersApplyDamage: z.boolean(),
  // Older rooms and backups have no such setting: it reads as on, the rule they were played under.
  playersTypeTotals: z.boolean().default(true),
  skipDefeated: z.boolean(),
  monsterInitScore: z.boolean(),
  revealHiddenOnTurn: z.boolean(),
  // Older rooms and backups have no turn timer: it reads as off.
  turnTimerSec: z.number().int().min(0).max(MAX_TURN_TIMER_SEC).default(0),
  // Backups from before wave 5 have none, which reads as every player (docs/design-v1-dm-tools.md 3.9).
  playersDraw: dmToolSchemas.whichPlayers.optional(),
  // Backups from before it have none, which reads as on (docs/design-v1-combat-flow.md 3.4).
  healRevives: z.boolean().optional(),
  // Backups from before it rolled every crit by the 2024 rule, which is what they keep.
  critRule: z.enum(CRIT_RULES).default("rollTwice"),
  // Backups from before it showed players the whole order, which is what they keep (docs/design-v1-combat-flow.md 11.1).
  playersSeeOrder: z.enum(ORDER_REVEALS).default("all"),
  // Backups from before hex grids have none, which reads as squares (docs/design-v1-hex-grids.md HX-D19).
  newScenes: mapSchemas.gridShape.optional(),
  // Backups from before map discovery have none, which reads as each kind's old default (docs/design-v1-map-discovery.md 8.2).
  newScenePlayers: memorySchemas.scenePreset.optional(),
});

const meta = z.strictObject({
  name,
  settings,
  playerSceneId: id.nullable(),
  view: z.strictObject({ follow: z.boolean(), blackout: z.boolean() }),
});

const member = z.strictObject({ id, rev, name, color, kind: z.enum(["dm", "player"]), createdAt: iso });

/**
 * A scene's phases come with their active one and their grid reference, or
 * not at all (Scene.phases), and the active one is in the list. The import
 * remaps phase images and drops a phase whose image did not come through
 * (remap.ts), so this holds after that too.
 *
 * Each phase must also pass the reducer's own checks against the grid (its
 * shape, and its scaled calibration within the protocol's bounds), and
 * `map` must be exactly the active phase's image on that grid, as every op
 * leaves it. Otherwise a switch on an imported scene would write a map the
 * protocol refuses, and the room would no longer export and import again.
 */
const scene = z
  .strictObject({
    id,
    rev,
    name,
    order: z.number().int().min(0).max(10_000),
    bounds: z.strictObject({ w: z.number().int().min(1).max(200), h: z.number().int().min(1).max(200) }),
    map: z
      .strictObject({
        assetId: id,
        widthPx: z.number().int().min(1).max(16_384),
        heightPx: z.number().int().min(1).max(16_384),
        cellPx: z.number().min(1).max(16_384),
        originPx: z.strictObject({ x: z.number().min(-100_000).max(100_000), y: z.number().min(-100_000).max(100_000) }),
      })
      .optional(),
    grid: z.strictObject({ show: z.boolean(), color, opacity: z.number().min(0).max(1), lineWidth: z.number().min(0).max(10) }),
    background: color,
    fogEnabled: z.boolean(),
    wallsVersion: z.number().int().min(0),
    defaultView: z.strictObject({ x: coord, y: coord, zoom: z.number().min(0.01).max(100) }).optional(),
    // Backups from before wave 3 have none of these, which reads as before (docs/design-v1-maps-vision.md 2.3).
    autoWalls: mapSchemas.autoWalls.optional(),
    folder: mapSchemas.folderName.optional(),
    thumb: id.optional(),
    phases: mapSchemas.mapPhases.optional(),
    phaseId: id.optional(),
    phaseGrid: mapSchemas.phaseGrid.optional(),
    // Backups from before wave 4 have neither, which reads as off (docs/design-v1-maps-vision.md 2.3).
    blockMovement: z.boolean().optional(),
    vision: mapSchemas.sceneVision.optional(),
    // Backups from before schema version 13 have none, and their imports keep the older sign (Scene.gridFromFile).
    gridFromFile: z.literal(true).optional(),
    // Backups from before hex grids have none, which reads as squares (docs/design-v1-hex-grids.md section 7).
    gridShape: mapSchemas.gridShape.optional(),
    // Backups from before the isometric view have none, which reads as Top-down (docs/design-v1-isometric-view.md 7).
    suggestedView: z.literal("isometric").optional(),
  })
  .refine(
    (s) =>
      s.phases === undefined
        ? s.phaseId === undefined && s.phaseGrid === undefined
        : s.phaseGrid !== undefined && s.map !== undefined && s.phases.some((p) => p.id === s.phaseId),
    { message: "a scene's phases come with their active phase, its grid and a map" },
  )
  .refine(phasesFitTheirGrid, { message: "a scene's phases fit its grid, and its map is the showing phase's image" });

function phasesFitTheirGrid(s: { map?: SceneMap | undefined; phases?: MapPhase[] | undefined; phaseId?: string | undefined; phaseGrid?: PhaseGrid | undefined }): boolean {
  const grid = s.phaseGrid;
  const active = s.phases?.find((p) => p.id === s.phaseId);
  // The shape refine above answers for a scene without phases, or with half of them.
  if (!s.phases || !grid || !active || !s.map) return true;
  if (s.phases.some((p) => phaseProblem(grid, p) !== null)) return false;
  const expected = phaseMap(grid, active);
  const map = s.map;
  return (
    map.assetId === expected.assetId &&
    map.widthPx === expected.widthPx &&
    map.heightPx === expected.heightPx &&
    map.cellPx === expected.cellPx &&
    map.originPx.x === expected.originPx.x &&
    map.originPx.y === expected.originPx.y
  );
}

const terrain = z.enum(["stone", "wood", "grass", "dirt", "cave", "water", "difficult", "rubble", "pit", "pillar", "stairs"]);
const edgeFeature = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("wall") }),
  z.strictObject({ kind: z.literal("none") }),
  z.strictObject({ kind: z.literal("door"), state: z.enum(["open", "closed", "locked"]), secret: z.boolean(), discovered: z.boolean() }),
  z.strictObject({ kind: z.literal("window") }),
]);
const cellKey = z.string().regex(/^-?\d{1,4},-?\d{1,4}$/);
const edgeKey = z.string().regex(/^-?\d{1,4},-?\d{1,4},[nw]$/);

/** A chunk's stair marks by its stamp (docs/design-v1-hex-grids.md HX-D14): compass letters on squares, six facings on hexes. */
const SQUARE_MARKS = /^[.aensw]*$/;
const HEX_MARKS = /^[.a0-5]*$/;
/** A remembered stair's way up by its scene's shape: memory carries no stamp, so its scene's shape is the one it was seen on. */
const SQUARE_WAYS = /^[nesw.]$/;
const HEX_WAYS = /^[0-5.]$/;
const STAIR_FACINGS = "a stair on squares faces n, e, s or w, and one on hexes a side from 0 to 5";

const chunk = z.strictObject({
  sceneId: id,
  cx: z.number().int().min(-100).max(100),
  cy: z.number().int().min(-100).max(100),
  rev,
  cells: z.record(cellKey, terrain),
  edges: z.record(edgeKey, edgeFeature),
  // The protocol's bounds, the 8 cell length and the 1/64 lattice included. The count per scene is checkLimits's.
  walls: z.array(mapSchemas.freeWall).min(1).max(LIMITS.freeWallsPerScene).optional(),
  // Wave 4: each cell's height and stair mark, in the stored forms of BuildChunk, absent when there are none.
  heights: z.string().regex(new RegExp(`^[A-Za-z0-9+/]{${HEIGHTS_CHARS - 1}}=$`)).optional(),
  // Either shape's facings here: the refinement below keeps each to its own stamp.
  up: z.string().regex(new RegExp(`^[.aensw0-5]{${STAIRS_CHARS}}$`)).optional(),
  // Difficult ground marks (docs/design-v1-movement.md 6.3), absent when there are none.
  rough: z.string().regex(new RegExp(`^[.d]{${ROUGH_CHARS}}$`)).optional(),
  // The hex shape its cell data was written under, absent for squares (docs/design-v1-hex-grids.md HX-D14).
  grid: mapSchemas.gridShape.optional(),
}).refine((c) => c.up === undefined || (c.grid === undefined ? SQUARE_MARKS : HEX_MARKS).test(c.up), {
  message: STAIR_FACINGS,
  path: ["up"],
});

const label = z.strictObject({ id, rev, sceneId: id, x: coord, y: coord, text: shortText, size: z.number().min(0.1).max(20) });

const fogTile = z.strictObject({
  sceneId: id,
  tx: z.number().int().min(0).max(20),
  ty: z.number().int().min(0).max(20),
  rev,
  bits: z.string().length(684),
});

const fogDraft = z.strictObject({ sceneId: id, rev, ops: z.array(fogOpSchema).max(500), grid: mapSchemas.gridShape.optional() });

/**
 * Per-player vision (docs/design-v1-per-player-vision.md 6.7): who saw a
 * stop or a turn's start, at most the design's most holders, each sorted
 * with no repeat. A stored log line holds no list: the DM's keeps none once
 * its readers are fixed, and a reader's copy names only them (Tx.settleLog,
 * review PV1-O12).
 */
const sortedIds = (max: number) =>
  z
    .array(id)
    .max(max)
    .refine((ids) => ids.every((m, i) => i === 0 || ids[i - 1]! < m), { message: "not sorted, or a member listed twice" });
const stopSeenBy = sortedIds(MOST_SIGHT_HOLDERS);
const sightHolders = z.strictObject({
  sceneId: id,
  rev,
  entries: z
    .array(z.strictObject({ memberId: id, on: z.boolean() }))
    .max(LIMITS.membersPerRoom)
    .refine((e) => new Set(e.map((h) => h.memberId)).size === e.length, { message: "a player is listed twice" })
    .refine((e) => e.filter((h) => h.on).length <= MOST_SIGHT_HOLDERS, { message: `at most ${MOST_SIGHT_HOLDERS} players see for themselves` }),
});
const exploredTile = fogTile.extend({ memberId: id });

/**
 * A chunk of one layer's memory (docs/design-v1-map-discovery.md 5.3), by
 * the bounds the map step's `sys.remember` is held to. A stored chunk is
 * never a player's, so the build chunk above, strict, refuses a player
 * chunk's `known`, `auto` and `upDir`.
 */
const memoryChunk = z.strictObject({
  sceneId: id,
  cx: memorySchemas.chunkIndex,
  cy: memorySchemas.chunkIndex,
  rev,
  memberId: id.optional(),
  ...memorySchemas.memoryEntries.shape,
});
/**
 * A layer's chunks, each under the key the reducer files it by, so no
 * stored chunk is one `layerChunks` never finds: the party's with no
 * member, and a holder's naming theirs.
 */
const memoryChunks = (layer: "party" | "holder") =>
  z.record(z.string().min(1).max(layer === "party" ? 120 : 140), memoryChunk).superRefine((chunks, ctx) => {
    for (const [key, c] of Object.entries(chunks)) {
      const want = layer === "party" ? (c.memberId === undefined ? chunkKey(c.sceneId, c.cx, c.cy) : null) : c.memberId === undefined ? null : holderChunkKey(c.sceneId, c.memberId, c.cx, c.cy);
      if (key !== want) ctx.addIssue({ code: "custom", path: [key], message: layer === "party" ? "not the party's chunk filed by its scene and place" : "not a holder's chunk filed by its scene, member and place" });
    }
  });
const sceneMark = z.strictObject({ sceneId: id, rev });
/** A share mark, `party` once the scene folded (shared/model.ts ShareMark). */
const shareMark = z.strictObject({ sceneId: id, rev, party: z.literal(true).optional() });
/** The scenes' marks, each under its own scene's id. */
function marksOf<T extends z.ZodType<{ sceneId: string }>>(mark: T) {
  return z.record(z.string().min(1).max(120), mark).superRefine((marks, ctx) => {
    for (const [key, m] of Object.entries(marks)) if (key !== (m as { sceneId: string }).sceneId) ctx.addIssue({ code: "custom", path: [key], message: "a mark under another scene's id" });
  });
}
const sceneMarks = marksOf(sceneMark);
const shareMarks = marksOf(shareMark);

const feet = z.number().int().min(-100_000).max(100_000);

/**
 * An effect as stored. Its level is a counter from 0 to 99, as the ops
 * take it, but Exhaustion's is the condition's level, 1 to 6, the rule new
 * ops are held to (shared/permissions.ts). A room from before the rule may
 * hold any counter there, so the import brings it within 1 to 6 rather
 * than refusing the backup.
 */
const effectSchema = actorSchemaForImport.shape.effects.element.transform(withLevelInRange);
const actorStored = actorSchemaForImport.extend({ effects: z.array(effectSchema).max(MAX_EFFECTS) });

const pathStop = z.strictObject({
  x: coord,
  y: coord,
  elevation: feet,
  uncounted: z.literal(true).optional(),
  seen: z.literal(true).optional(),
  seenBy: stopSeenBy.optional(),
  joinedUnseen: z.literal(true).optional(),
  footprint: z.strictObject({ w: z.number().min(0.5).max(20), h: z.number().min(0.5).max(20), squeeze: z.literal(true).optional() }).optional(),
  // Walking routes (docs/design-v1-movement.md 6.2): the leg's corners, at most the path's 100 once legs join, and what it took.
  via: z.array(coord).max(2 * MAX_PATH_CORNERS).optional(),
  moved: z.number().min(0).max(1_000_000).optional(),
  cost: z.number().min(0).max(1_000_000).optional(),
  diag: z.tuple([z.number().min(0).max(1_000_000), z.number().min(0).max(1_000_000)]).optional(),
  routeSeen: z.literal(true).optional(),
  // Attached tokens (docs/design-v1-attach.md 7.2): a leg the holder's move took the creature along.
  carried: z.literal(true).optional(),
});

const token = z.strictObject({
  id,
  rev,
  sceneId: id,
  kind: z.enum(["pc", "npc", "monster", "object"]),
  name,
  publicName: name.optional(),
  nameHidden: z.boolean(),
  image: imageRef.optional(),
  size: sizeSchema,
  w: z.number().min(0.5).max(20).optional(),
  h: z.number().min(0.5).max(20).optional(),
  x: coord,
  y: coord,
  elevation: z.number().int().min(-100_000).max(100_000),
  height: z.number().int().min(0).max(10_000).optional(),
  rotation: z.number().min(-360).max(360),
  disposition: z.enum(["ally", "neutral", "hostile"]),
  visibility,
  fogExempt: z.boolean(),
  fogExemptAuto: z.boolean(),
  locked: z.boolean(),
  layer: z.enum(["object", "token"]),
  ownerIds: memberIds,
  actor: z.union([z.strictObject({ ref: id }), z.strictObject({ inline: actorStored })]),
  hpVisibility: z.enum(["hidden", "label", "bar", "exact"]),
  number: z.number().int().min(1).max(10_000).optional(),
  notes: notes.optional(),
  altImages: z.array(imageRef).min(1).max(MAX_ALT_IMAGES).optional(),
  rangeRings: z.array(z.number().int().min(5).max(MAX_RANGE_RING_FT)).min(1).max(MAX_RANGE_RINGS).optional(),
  // Backups from before paths were recorded have none.
  path: z.strictObject({ turn: z.number().int().min(0), stops: z.array(pathStop).min(1).max(MAX_PATH_STOPS) }).optional(),
  // Backups from before wave 4 have none of these.
  squeeze: z.literal(true).optional(),
  light: mapSchemas.tokenLight.optional(),
  partyVision: z.boolean().optional(),
  // Backups from before companions have none (docs/design-v1-combat-flow.md 4.7). A spent Reaction comes with its token.
  companion: z.strictObject({ of: id, turn: z.enum(["own", "shared", "none"]), reactionUsed: z.literal(true).optional() }).optional(),
  // Backups from before attached tokens have none (docs/design-v1-attach.md 8.1).
  attached: z.strictObject({ to: id, kind: z.enum(ATTACH_KINDS), steer: z.literal(true).optional() }).optional(),
});

const character = z.strictObject({
  id,
  rev,
  ownerIds: memberIds,
  name,
  size: sizeSchema,
  defaultImage: imageRef.optional(),
  actor: actorStored,
  // Backups from before character levels have none.
  level: z.number().int().min(1).max(20).optional(),
  // Backups from before stat blocks for player characters have none (docs/design-v1-pc-stats.md 3.5).
  stats: pcStatsForImport.optional(),
  // Backups from before known forms have none. A hand-made empty list passes here, and the remap stores it as none (docs/design-v1-known-forms.md 3.1).
  knownForms: knownFormsSchema.optional(),
  // Backups from before re-sync have no record (docs/design-v1-resync.md 4).
  ddbSync: ddbSyncForImport.optional(),
  // Backups from before combat uses have no class resources (docs/design-v1-combat-controls.md 3.6).
  resources: z
    .array(combatUseSchemas.resourceStored)
    .max(LIMITS.resourcesPerCharacter)
    .refine((list) => new Set(list.map((r) => r.id)).size === list.length, { message: "a resource is listed twice" })
    .optional(),
});

const areaFeet = z.number().min(5).max(1_000);
const template = z.strictObject({
  id,
  rev,
  sceneId: id,
  shape: z.enum(["sphere", "cylinder", "cone", "cube", "line", "emanation"]),
  size: areaFeet,
  width: areaFeet.optional(),
  height: areaFeet.optional(),
  origin: z.strictObject({ x: coord, y: coord, z: z.number().int().min(-100_000).max(100_000) }),
  yaw: z.number().min(-360).max(360),
  pitch: z.number().min(-90).max(90).optional(),
  faceOffset: z.strictObject({ u: z.number().min(-0.5).max(0.5), v: z.number().min(-0.5).max(0.5) }).optional(),
  anchor: z.enum(["bottom", "top"]).optional(),
  attachedTo: id.optional(),
  footprint: z
    .strictObject({
      w: z.number().min(0.5).max(20),
      h: z.number().min(0.5).max(20),
      elevation: z.number().int().min(-100_000).max(100_000),
      height: z.number().min(0).max(10_000),
      // The size a stationary emanation was cast from (docs/design-v1-hex-grids.md HX-D11), never custom.
      size: sizeSchema.exclude(["custom"]).optional(),
    })
    .optional(),
  triggers: areaTriggersSchema.optional(),
  oncePerTurn: z.literal(true).optional(),
  slows: areaSlows.optional(),
  includeOrigin: z.boolean(),
  color,
  label: shortText.optional(),
  spell: shortText.optional(),
  casterId: id.optional(),
  ownerId: id,
  visibility,
});

const drawing = z.strictObject({
  id,
  rev,
  sceneId: id,
  kind: z.enum(["free", "line", "rect", "ellipse", "polygon", "arrow", "text", "ruler"]),
  points: z.array(coord).min(2).max(2_000),
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
  anchors: z.array(id.nullable()).max(MAX_RULER_STOPS).optional(),
  z: z.array(z.number().int().min(MIN_HEIGHT_FT).max(MAX_HEIGHT_FT)).max(MAX_RULER_STOPS).optional(),
  walk: z.literal(true).optional(),
});

const entry = z.strictObject({
  id,
  tokenId: id.optional(),
  characterId: id.optional(),
  label: shortText.optional(),
  value: z.number().int().min(-50).max(100).nullable(),
  tieOrder: z.number().int().min(-100_000).max(100_000),
  groupKey: shortText.optional(),
  hidden: z.boolean(),
  reactionUsed: z.boolean(),
  inLair: z.boolean(),
  advantage: z.enum(["adv", "dis"]).optional(),
  hadTurn: z.literal(true).optional(),
  // Attached tokens (docs/design-v1-attach.md 7.1): the round a controlled mount's row is passed over or marks time in.
  skipRound: z.number().int().min(0).max(100_000).optional(),
  markRound: z.number().int().min(0).max(100_000).optional(),
});

const turnStart = z.strictObject({
  entryId: id,
  tokenId: id,
  sceneId: id,
  x: coord,
  y: coord,
  elevation: z.number().int().min(-100_000).max(100_000),
  seen: z.literal(true).optional(),
  seenBy: stopSeenBy.optional(),
  seq: z.number().int().min(0).optional(),
  mounts: z.array(id).min(1).max(LIMITS.turnMounts).optional(),
});

const encounter = z.strictObject({
  rev,
  round: z.number().int().min(0).max(100_000),
  activeEntryId: id.nullable(),
  entries: z.array(entry).max(LIMITS.encounterRows),
  // Backups from before the turn-start marker have none.
  turnStart: turnStart.optional(),
  startSeq: z.number().int().min(0).optional(),
});

const effectStored = effectSchema;

const encounterSnapshot = z.strictObject({
  encounter,
  effects: z.record(id, z.array(effectStored).max(32)),
  revealed: z.array(z.strictObject({ tokenId: id, visibility, fogExemptAuto: z.boolean() })).max(LIMITS.encounterRows),
  legendary: z.strictObject({ holderId: id, actionsUsed: z.number().int().min(0).max(10) }).optional(),
  companionReactions: z.array(id).max(LIMITS.encounterRows).optional(),
  // What a turn start replaced for each of its creatures (docs/design-v1-combat-controls.md 3.3), none in backups from before it.
  turnUses: z
    .array(
      z.strictObject({
        holderId: id,
        record: combatUseSchemas.turnRecord.nullable().optional(),
        marks: combatUseSchemas.uses.optional(),
        actionsUsed: z.number().int().min(0).max(10).optional(),
        link: z.string().min(1).max(100).optional(),
      }),
    )
    .max(LIMITS.encounterRows)
    .optional(),
  // The row flags a Next changed (design 9.4), none in backups from before op version 21.
  turnFlags: z
    .array(z.strictObject({ entryId: id, flags: z.array(z.enum(TURN_FLAGS)).min(1).max(TURN_FLAGS.length) }))
    .max(LIMITS.encounterRows)
    .optional(),
  // What a Next changed in each creature's effects, and a turn whose row has left the fight (design 9.4, op version 21).
  effectChanges: z
    .array(
      z.strictObject({
        holderId: id,
        ended: z.array(z.strictObject({ at: z.number().int().min(0).max(MAX_EFFECTS), effect: effectStored })).max(MAX_EFFECTS).optional(),
        // A Next crosses each row's boundary once at most, so a count it lowered is one less (rules/durations.ts tickEffects).
        counted: z
          .array(z.strictObject({ id, from: durationRemainingSchema, to: durationRemainingSchema }).refine((c) => c.to === c.from - 1, "a count a Next lowered is one less than it was"))
          .max(MAX_EFFECTS)
          .optional(),
        asked: z.array(z.strictObject({ id, from: effectDueSchema.nullable(), to: effectDueSchema })).max(MAX_EFFECTS).optional(),
      }),
    )
    // One for each creature a Next changed, as `effects` holds them: up to every creature in the room, which the state's byte limit bounds.
    .optional(),
  resumesGone: z.literal(true).optional(),
  at: iso,
});

// Wave 5 (docs/design-v1-dm-tools.md). Counts and byte sizes are checkLimits's.

/** A stored block keeps whether a secret is revealed, which only `journal.reveal` changes. */
const journalBlock = z.strictObject({
  id: dmToolSchemas.journalBlockId,
  text: notes,
  secret: z.strictObject({ revealed: z.boolean() }).optional(),
});
const journalPage = z
  .strictObject({
    id,
    rev,
    title: name,
    folder: mapSchemas.folderName.optional(),
    access: dmToolSchemas.journalAccess,
    blocks: z.array(journalBlock).max(LIMITS.journalBlocksPerPage),
  })
  .refine((p) => new Set(p.blocks.map((b) => b.id)).size === p.blocks.length, { message: "a page lists a block twice" });

/** The put op's bounds, with its rev. */
const pin = z.strictObject({ ...dmToolSchemas.pinInput.shape, rev });

const rollAnswerFields = {
  choice: dmToolSchemas.rollChoiceIndex.optional(),
  total: dmToolSchemas.rollTotal.optional(),
  result: dmToolSchemas.rollResult.optional(),
  noRoll: z.literal(true).optional(),
  // Wave 7: a rolled answer's dice and provenance (docs/design-v1-dice.md 5.1, docs/design-v1-roll-request.md 1.1).
  tag: id.optional(),
  dice: diceSchemas.diceResult.optional(),
  typedBonus: z.literal(true).optional(),
  mark: dmToolSchemas.rollResult.optional(),
  changed: rollAnswerSchemas.rollChange.optional(),
};
const rollTarget = z
  .strictObject({
    tokenId: id.optional(),
    characterId: id.optional(),
    ...rollAnswerFields,
    by: id.optional(),
    previous: z.strictObject(rollAnswerFields).optional(),
    change: rollAnswerSchemas.rollChange.optional(),
    retype: z.literal(true).optional(),
  })
  .refine((t) => (t.tokenId === undefined) !== (t.characterId === undefined), { message: "a roll target is one token or one character" });
/** Never with `dcHidden`, which only player projections carry. */
const rollRequest = z.strictObject({
  id,
  rev,
  test: dmToolSchemas.rollTest,
  dc: dmToolSchemas.rollDc.optional(),
  dcShown: z.boolean(),
  resultShown: z.boolean(),
  note: shortText.optional(),
  spell: z.literal(true).optional(),
  cause: z.literal("saveEnds").optional(),
  ends: z.strictObject({ effect: id, occurrence: id }).optional(),
  at: iso,
  targets: z.array(rollTarget).min(1).max(LIMITS.rollTargets),
});

/** A player's ask for saves (docs/design-v1-player-save-spell.md 5.2), as its op carries it with what the server wrote. */
const castAsk = z
  .strictObject({
    ...castSchemas.castInput.shape,
    rev,
    by: id,
    rolled: z.array(castSchemas.castRolled).min(1).max(LIMITS.diceBatchesPerTag * LIMITS.diceRollsPerOp).optional(),
    at: iso,
  })
  .refine((c) => (c.area === undefined) !== (c.targets === undefined), { message: "an ask names an area or its targets, one of the two" });

/** A handout of pages has them in order (docs/design-v1-pdf-handouts.md 3.3). One image has none. */
const handout = z.strictObject({
  id,
  rev,
  assetId: id,
  pages: handoutSchemas.handoutPages.optional(),
  title: name,
  to: handoutSchemas.handoutTo,
  shownAt: iso,
});

/** A document of handout pages, with its create op's bounds (docs/design-v1-pdf-handouts.md 3.2). The room's page count is `checkLimits`'s. */
const handoutDoc = z.strictObject({ id, rev, title: name, pages: handoutSchemas.handoutPages, createdAt: iso });

/** The create op's bounds. The byte limits for one monster and for all of them are `checkLimits`'s. */
const monster = z.strictObject({ id, rev, ...statBlockFieldsForImport });

/** A companion's stat block, with its create op's bounds. Its size and the character's and room's totals are `checkLimits`'s. */
const companionBlock = z.strictObject({ id, rev, characterId: id, fromSrd: srdIdSchema.optional(), ...statBlockFieldsForImport });

/** An SRD monster's default image, keyed by its SRD id. The count is `checkLimits`'s. */
const srdImage = z.strictObject({ id: srdIdSchema, rev, image: imageRef });

/** The create op's bounds. The count is `checkLimits`'s. */
const savedEncounter = z.strictObject({ id, rev, ...savedEncounterFieldsForImport });

/** The put op's bounds, with the scene the op named. Counts are `checkLimits`'s. */
const stamp = z.strictObject({ ...mapSchemas.stampFields, rev, sceneId: id });
const light = z.strictObject({ ...mapSchemas.lightFields, rev, sceneId: id });

const effectKey = z.enum([...CONDITION_KEYS, ...STATUS_KEYS, "custom"]);
const lifeState = z.enum(["alive", "dying", "stable", "dead"]);
const holder = { tokenId: id.optional(), characterId: id.optional(), seen: z.literal(true).optional() };
const hpNumber = z.number().int().min(0).max(100_000);
const hpValues = z.strictObject({ cur: hpNumber, max: hpNumber, temp: hpNumber });
const vitals = z.strictObject({ hp: hpValues, life: lifeState, deathSaves: z.strictObject({ ok: z.number().int().min(0).max(3), fail: z.number().int().min(0).max(3) }) });
const logEvent = z.discriminatedUnion("type", [
  z.strictObject({
    type: z.literal("hp"),
    ...holder,
    change: z.enum(["damage", "heal", "set", "temp"]),
    amount: hpNumber.optional(),
    crit: z.boolean().optional(),
    label: z.enum(["Healthy", "Bloodied", "Dying", "Dead"]).optional(),
    // Lines from before the HP log kept these have none of them.
    left: hpValues.optional(),
    revert: z
      .strictObject({
        before: vitals,
        after: vitals,
        added: z.array(effectStored).max(32).optional(),
        removed: z.array(effectStored).max(32).optional(),
        anchors: z.record(id, z.union([z.strictObject({ tokenId: id }), z.strictObject({ characterId: id })])).optional(),
        shapeTemp: z.strictObject({ before: actorSchemaForImport.shape.srdId, after: actorSchemaForImport.shape.srdId }).optional(),
        record: combatUseSchemas.turnRecordId.optional(),
      })
      .optional(),
    back: z.literal(true).optional(),
    of: z.string().regex(/^\d{1,18}:\d{1,6}$/).optional(),
  }),
  z.strictObject({ type: z.literal("life"), ...holder, life: lifeState }),
  // A creature's use of a limited ability (docs/design-v1-combat-controls.md 8).
  z.strictObject({
    type: z.literal("use"),
    ...holder,
    what: z.enum(["legendary", "resist", "ability", "resource"]),
    name: combatUseSchemas.useName.optional(),
    cost: z.number().int().min(1).max(LIMITS.resourcePoolMax).optional(),
    left: z.number().int().min(0).max(LIMITS.resourcePoolMax).optional(),
    max: z.number().int().min(0).max(LIMITS.resourcePoolMax).optional(),
    back: z.literal(true).optional(),
    hidden: z.literal(true).optional(),
  }),
  z.strictObject({ type: z.literal("effect"), ...holder, key: effectKey, action: z.enum(["add", "remove", "expire", "pause"]), spell: shortText.optional(), hidden: z.literal(true).optional() }),
  z.strictObject({ type: z.literal("concentration"), ...holder, dc: z.number().int().min(0).max(30).optional(), spell: shortText.optional(), ended: z.boolean().optional(), hidden: z.literal(true).optional(), exact: z.literal(true).optional() }),
  z.strictObject({ type: z.literal("saveEnds"), ...holder, effectId: id, key: effectKey, ability: z.enum(ABILITY_KEYS), dc: z.number().int().min(1).max(50) }),
  z.strictObject({ type: z.literal("deathSave"), ...holder, ok: z.number().int().min(0).max(3), fail: z.number().int().min(0).max(3), exact: z.literal(true).optional() }),
  z.strictObject({
    type: z.literal("rest"),
    ...holder,
    kind: z.enum(["short", "long"]),
    amount: hpNumber.optional(),
    left: hpValues.optional(),
    label: z.enum(["Healthy", "Bloodied", "Dying", "Dead"]).optional(),
  }),
  z.strictObject({
    type: z.literal("turn"),
    entryId: id,
    round: z.number().int().min(0).max(100_000),
    seen: z.literal(true).optional(),
    back: z.literal(true).optional(),
    to: id.optional(),
    toSeen: z.literal(true).optional(),
  }),
  z.strictObject({
    type: z.literal("area"),
    templateId: id,
    tokenId: id,
    trigger: z.enum(["enter", "turnStart", "turnEnd"]),
    area: shortText,
    moved: z.literal(true).optional(),
    seen: z.literal(true).optional(),
    hidden: z.literal(true).optional(),
  }),
  z.strictObject({ type: z.literal("encounter"), action: z.enum(["start", "end"]) }),
  z.strictObject({ type: z.literal("handout"), handoutId: id }),
  z.strictObject({ type: z.literal("member"), memberId: id, action: z.enum(["join", "kick", "dm", "undm", "remove"]) }),
  z.strictObject({ type: z.literal("teleport"), tokenId: id, past: z.enum(["wall", "ledge", "unknown"]) }),
  z.strictObject({ type: z.literal("companion"), tokenId: id, characterId: id, memberId: id, name }),
  z.strictObject({ type: z.literal("characterDeleted"), characterId: id, memberId: id, name, tokens: count, companions: count, rows: count }),
  z.strictObject({
    type: z.literal("roll"),
    test: dmToolSchemas.rollTest,
    tokenId: id.optional(),
    characterId: id.optional(),
    choice: dmToolSchemas.rollChoiceIndex.optional(),
    dc: dmToolSchemas.rollDc.optional(),
    dcShown: z.literal(true).optional(),
    resultShown: z.literal(true).optional(),
    total: dmToolSchemas.rollTotal.optional(),
    result: dmToolSchemas.rollResult.optional(),
    noRoll: z.literal(true).optional(),
    dice: diceSchemas.diceResult.optional(),
    typedBonus: z.literal(true).optional(),
    tag: id.optional(),
    changed: rollAnswerSchemas.rollChange.optional(),
    mark: z.literal(true).optional(),
  }),
  // A player's ask for saves and its end (docs/design-v1-player-save-spell.md 5.2).
  z.strictObject({
    type: z.literal("cast"),
    castId: id,
    tokenId: id,
    spell: castSchemas.castInput.shape.spell,
    slot: castSchemas.castInput.shape.slot,
    end: castSchemas.castEnd.optional(),
  }),
  // A free roll's line with what was drawn (docs/design-v1-dice.md 5.3).
  z.strictObject({
    type: z.literal("dice"),
    tag: id.optional(),
    part: z.number().int().min(0).max(LIMITS.diceBatchesPerTag - 1).optional(),
    batch: z.string().regex(/^[A-Za-z0-9_-]{16}$/).optional(),
    by: id,
    to: z.enum(["all", "dm"]),
    dc: dmToolSchemas.rollDc.optional(),
    ac: dmToolSchemas.rollDc.optional(),
    rolls: z
      .array(
        z.strictObject({
          ...diceSchemas.diceResult.shape,
          label: shortText.max(LIMITS.diceLabelChars).optional(),
          tokenId: id.optional(),
          characterId: id.optional(),
          seen: z.literal(true).optional(),
          critOn: diceSchemas.critOn.optional(),
          initiative: z.literal(true).optional(),
          save: z.enum(ABILITY_KEYS).optional(),
          hidden: z.literal(true).optional(),
          type: z.enum(DAMAGE_TYPES).optional(),
        }),
      )
      .max(LIMITS.diceRollsPerOp),
  }),
]);

/** How a trap went off (TrapHow). */
const trapHow = z.enum(["enter", "leave", "turnStart", "turnEnd", "cross", "open", "hand"]);
const lineId = z.string().regex(/^\d{1,18}:\d{1,6}$/);

/** A trap's waiting occurrence (docs/design-v1-traps.md 6.1), as the reducer stores it. */
const trapDue = z.strictObject({
  id: lineId,
  at: iso,
  how: trapHow,
  by: z.array(id).max(LIMITS.trapBy),
  more: count.optional(),
  hits: z.array(id).max(LIMITS.trapHits),
  hitsMore: count.optional(),
  perceived: z.literal(true).optional(),
  hidden: z.literal(true).optional(),
  acted: z.literal(true).optional(),
});

/** A trap as stored: its op fields with what the reducer writes, uses down to 0, who the hint named and its occurrences. */
const trap = z.strictObject({
  id: trapSchemas.plainId,
  rev,
  sceneId: id,
  name: trapSchemas.trapName,
  zone: trapSchemas.trapZone,
  state: z.enum(["armed", "sprung", "disarmed"]),
  found: z.boolean(),
  rig: trapSchemas.trapRigInput
    .extend({
      usesLeft: z.number().int().min(0).max(99).optional(),
      noticedBy: id.optional(),
      due: z.array(trapDue).max(LIMITS.trapDuePerTrap).optional(),
    })
    .optional(),
  // The hex shape its zone was written under, absent for squares (docs/design-v1-hex-grids.md HX-D14).
  grid: mapSchemas.gridShape.optional(),
});

/** The lines of the two trap logs (docs/design-v1-traps.md 6.3). */
const trapLine = z.discriminatedUnion("type", [
  z.strictObject({
    type: z.literal("trap"),
    trapId: id,
    sceneId: id,
    name: trapSchemas.trapName,
    how: trapHow,
    by: z.array(id).max(LIMITS.trapBy),
    more: count.optional(),
    hits: count,
    did: z.array(z.strictObject({ action: z.number().int().min(-1).max(LIMITS.trapActions - 1), ok: z.boolean() })).max(LIMITS.trapActions + 1),
    seen: z.array(z.number().int().min(0).max(LIMITS.trapBy - 1)).max(LIMITS.trapBy).optional(),
    hidden: z.literal(true).optional(),
    sound: z.enum(TRAP_SOUNDS).optional(),
  }),
  z.strictObject({ type: z.literal("trapSeen"), by: z.array(id).max(LIMITS.trapBy), more: count.optional(), message: trapSchemas.trapMessage, sound: z.enum(TRAP_SOUNDS).optional() }),
  z.strictObject({ type: z.literal("trapNotice"), trapId: id, sceneId: id, tokenId: id, passive: z.number().int().min(0).max(60), dc: dmToolSchemas.rollDc }),
]);
const trapLogEntry = z.strictObject({ id: lineId, at: iso, kind: z.literal("event"), data: trapLine });

/** Who read a part of a shared line (LineParts): members of the room, which holds at most `membersPerRoom`. */
const partReaders = z.array(id).max(LIMITS.membersPerRoom);

const logEntry = z.strictObject({
  id: z.string().regex(/^\d{1,18}:\d{1,6}$/),
  at: iso,
  kind: z.enum(["chat", "whisper", "event"]),
  from: id.optional(),
  to: z.array(id).max(MAX_OWNERS).optional(),
  text: longText.optional(),
  data: logEvent.optional(),
  parts: z
    .strictObject({
      exact: partReaders.optional(),
      label: partReaders.optional(),
      to: partReaders.optional(),
      rolls: z.array(partReaders.nullable()).max(LIMITS.diceRollsPerOp).optional(),
    })
    .optional(),
  copyOf: lineId.optional(),
});

const record = <T extends z.ZodType>(value: T) => z.record(z.string().min(1).max(120), value);

/** One audience's pairs of the record of a turn's reminders (RoomState.reminded), each under its caps. */
const remindedPairs = (cap: number, bytes: number) =>
  z
    .record(id, z.record(id, z.number().int().min(1).max(7)))
    .refine((pairs) => Object.values(pairs).reduce((n, tokens) => n + Object.keys(tokens).length, 0) <= cap, `at most ${cap} reminders`)
    .refine((pairs) => serializedBytes(pairs) <= bytes, `at most ${bytes} bytes of reminders`);
const reminded = z.strictObject({
  shared: remindedPairs(LIMITS.remindedShared, LIMITS.remindedSharedBytes).optional(),
  players: z
    .record(id, remindedPairs(LIMITS.remindedPerPlayer, LIMITS.remindedPerPlayerBytes))
    .refine((players) => Object.keys(players).length <= LIMITS.membersPerRoom, `at most ${LIMITS.membersPerRoom} players`)
    .optional(),
  dm: remindedPairs(LIMITS.remindedDm, LIMITS.remindedDmBytes).optional(),
});

export const roomStateSchema = z.strictObject({
  meta,
  members: record(member),
  scenes: record(scene),
  buildChunks: record(chunk),
  labels: record(label),
  fogTiles: record(fogTile),
  fogDrafts: record(fogDraft),
  tokens: record(token),
  characters: record(character),
  templates: record(template),
  drawings: record(drawing),
  encounter: encounter.nullable(),
  encounterHistory: z.array(encounterSnapshot).max(20),
  handouts: record(handout),
  log: z.array(logEntry).max(MAX_LOG_LINES),
  monsters: record(monster),
  srdImages: z.record(srdIdSchema, srdImage),
  savedEncounters: record(savedEncounter),
  stamps: record(stamp),
  lights: record(light),
  // The party's explored layer, in the fog tiles' shape (docs/design-v1-maps-vision.md 4.3.3).
  exploredTiles: record(fogTile),
  // Per-player vision (docs/design-v1-per-player-vision.md 6.7). A backup from before it reaches this schema through the
  // snapshot migration, which adds them empty. A holder's tile key names its scene, member and place, longer than an id.
  holders: record(sightHolders),
  exploredBy: z.record(z.string().min(1).max(140), exploredTile),
  // Wave 5. A backup from before them reaches this schema through the snapshot migration, which adds them empty.
  journal: record(journalPage),
  pins: record(pin),
  rolls: record(rollRequest),
  // PDF handouts. A backup from before them reaches this schema through the snapshot migration, which adds them empty.
  handoutDocs: record(handoutDoc),
  // Companion stat blocks. A backup from before them reaches this schema through the snapshot migration, which adds them empty.
  companionBlocks: record(companionBlock),
  // Players' asks for saves. A backup from before them reaches this schema through the snapshot migration, which adds them empty.
  casts: record(castAsk),
  // Traps and their two logs. A backup from before them reaches this schema through the snapshot migration, which adds them empty.
  traps: record(trap),
  trapLog: z.array(trapLogEntry).max(LIMITS.trapLogLines),
  trapSeen: z.array(trapLogEntry).max(LIMITS.trapSeenLines),
  // The record of the running turn's reminders, which an export may carry and the import leaves behind (remap.ts).
  reminded: reminded.optional(),
  // Map discovery (docs/design-v1-map-discovery.md 5.3, 5.5). A backup from before it reaches this schema through the
  // snapshot migration, which adds them empty, and an import that carries none starts with none. A holder's chunk key
  // names its scene, member and place, longer than an id.
  memory: memoryChunks("party").default({}),
  memoryBy: memoryChunks("holder").default({}),
  playedScenes: sceneMarks.default({}),
  memoryShared: shareMarks.default({}),
});

/**
 * The stored state an import's room.json holds, checked whole. A sync
 * record whose `at` is more than a day past the import's time takes the
 * import's time instead (docs/design-v1-resync.md 4). The record and its
 * base stay, so the next re-sync still compares three ways, and no record
 * from the future reaches a stored room, where the next stamp would follow it.
 */
export function parseRoomState(value: unknown, now = Date.now()): { ok: true; state: RoomState } | { ok: false; message: string } {
  const parsed = roomStateSchema.safeParse(value);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return { ok: false, message: `${issue?.path.join(".") ?? ""}: ${issue?.message ?? "invalid"}` };
  }
  const state = parsed.data as RoomState;
  // A stamp speaks only for grid-keyed content (HX-D14). One on a chunk without any, as a backup made by hand may put on
  // free walls, names no grid, and the room keeps none, so no rule reads the chunks of its scene by it.
  for (const [key, chunk] of Object.entries(state.buildChunks)) {
    if (chunk.grid === undefined || holdsGridKeys(chunk)) continue;
    const { grid: _grid, ...rest } = chunk;
    state.buildChunks[key] = rest;
  }
  // Cell data stands only on the shape it was written for, and a hex scene holds only what its phase supports
  // (docs/design-v1-hex-grids.md HX-D14), as every op leaves a room. A backup made by hand can break that, and the
  // rules would read its square keys as hexes.
  for (const scene of Object.values(state.scenes).sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))) {
    // A hex scene never reads as a file's own square grid (D-261026-8), as `scene.create` and the map ops refuse it.
    if (isHex(sceneGrid(scene)) && cameWithGrid(scene)) return { ok: false, message: `scenes.${scene.id}: ${OWN_SQUARE_GRID}` };
    const found = sceneHolds(state, scene);
    if (found) return { ok: false, message: `scenes.${scene.id}: ${standsWords(found, scene)}` };
  }
  // Memory holds what its scene's own chunks held, and the scene's shape switching takes it all away (reducer/memory.ts),
  // so its stairs face by that shape. A backup made by hand can give them the other's.
  for (const [layer, chunks] of [
    ["memory", state.memory],
    ["memoryBy", state.memoryBy],
  ] as const) {
    for (const [key, chunk] of Object.entries(chunks ?? {})) {
      const scene = state.scenes[chunk.sceneId];
      if (!scene) continue;
      const hex = isHex(sceneGrid(scene));
      const marks = Object.values(chunk.up ?? {}).every((m) => (hex ? HEX_MARKS : SQUARE_MARKS).test(m));
      const ways = Object.values(chunk.upDir ?? {}).every((d) => (hex ? HEX_WAYS : SQUARE_WAYS).test(d));
      if (!marks || !ways) return { ok: false, message: `${layer}.${key}.${marks ? "upDir" : "up"}: ${STAIR_FACINGS}` };
    }
  }
  for (const character of Object.values(state.characters)) {
    if (character.ddbSync && syncAtAhead(character.ddbSync.at, now)) character.ddbSync = { ...character.ddbSync, at: new Date(now).toISOString() };
  }
  return { ok: true, state };
}
