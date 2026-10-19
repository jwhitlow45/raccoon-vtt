import { z } from "zod";
import { ABILITY_KEYS, CONDITION_KEYS, CRIT_RULES, HEIGHTS_CHARS, MAX_HEIGHT_FT, MIN_HEIGHT_FT, ORDER_REVEALS, ROUGH_CHARS, STAIRS_CHARS, STATUS_KEYS, type MapPhase, type PhaseGrid, type RoomState, type SceneMap } from "#shared/model.ts";
import { LIMITS } from "#shared/limits.ts";
import { withLevelInRange } from "#shared/srd/conditions.ts";
import {
  MAX_ALT_IMAGES,
  castSchemas,
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
  areaSlows,
  areaTriggersSchema,
  moveAnyTokenSchema,
  pcStatsForImport,
  knownFormsSchema,
  fogOpSchema,
  handoutSchemas,
  mapSchemas,
  savedEncounterFieldsForImport,
  srdIdSchema,
  statBlockFieldsForImport,
  textSchemas,
} from "#shared/protocol.ts";
import { MAX_LOG } from "#shared/reducer.ts";
import { phaseMap, phaseProblem } from "#shared/reducer/phases.ts";

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
  up: z.string().regex(new RegExp(`^[.aensw]{${STAIRS_CHARS}}$`)).optional(),
  // Difficult ground marks (docs/design-v1-movement.md 6.3), absent when there are none.
  rough: z.string().regex(new RegExp(`^[.d]{${ROUGH_CHARS}}$`)).optional(),
});

const label = z.strictObject({ id, rev, sceneId: id, x: coord, y: coord, text: shortText, size: z.number().min(0.1).max(20) });

const fogTile = z.strictObject({
  sceneId: id,
  tx: z.number().int().min(0).max(20),
  ty: z.number().int().min(0).max(20),
  rev,
  bits: z.string().length(684),
});

const fogDraft = z.strictObject({ sceneId: id, rev, ops: z.array(fogOpSchema).max(500) });

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
  joinedUnseen: z.literal(true).optional(),
  footprint: z.strictObject({ w: z.number().min(0.5).max(20), h: z.number().min(0.5).max(20), squeeze: z.literal(true).optional() }).optional(),
  // Walking routes (docs/design-v1-movement.md 6.2): the leg's corners, at most the path's 100 once legs join, and what it took.
  via: z.array(coord).max(2 * MAX_PATH_CORNERS).optional(),
  moved: z.number().min(0).max(1_000_000).optional(),
  cost: z.number().min(0).max(1_000_000).optional(),
  diag: z.tuple([z.number().min(0).max(1_000_000), z.number().min(0).max(1_000_000)]).optional(),
  routeSeen: z.literal(true).optional(),
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
});

const turnStart = z.strictObject({
  entryId: id,
  tokenId: id,
  sceneId: id,
  x: coord,
  y: coord,
  elevation: z.number().int().min(-100_000).max(100_000),
  seen: z.literal(true).optional(),
  seq: z.number().int().min(0).optional(),
});

const encounter = z.strictObject({
  rev,
  round: z.number().int().min(0).max(100_000),
  activeEntryId: id.nullable(),
  entries: z.array(entry).max(600),
  // Backups from before the turn-start marker have none.
  turnStart: turnStart.optional(),
});

const effectStored = effectSchema;

const encounterSnapshot = z.strictObject({
  encounter,
  effects: z.record(id, z.array(effectStored).max(32)),
  revealed: z.array(z.strictObject({ tokenId: id, visibility, fogExemptAuto: z.boolean() })).max(600),
  legendary: z.strictObject({ holderId: id, actionsUsed: z.number().int().min(0).max(10) }).optional(),
  companionReactions: z.array(id).max(600).optional(),
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
      })
      .optional(),
    back: z.literal(true).optional(),
    of: z.string().regex(/^\d{1,18}:\d{1,6}$/).optional(),
  }),
  z.strictObject({ type: z.literal("life"), ...holder, life: lifeState }),
  z.strictObject({ type: z.literal("effect"), ...holder, key: effectKey, action: z.enum(["add", "remove", "expire", "pause"]), spell: shortText.optional(), hidden: z.literal(true).optional() }),
  z.strictObject({ type: z.literal("concentration"), ...holder, dc: z.number().int().min(0).max(30).optional(), spell: shortText.optional(), ended: z.boolean().optional(), hidden: z.literal(true).optional() }),
  z.strictObject({ type: z.literal("saveEnds"), ...holder, effectId: id, key: effectKey, ability: z.enum(ABILITY_KEYS), dc: z.number().int().min(1).max(50) }),
  z.strictObject({ type: z.literal("deathSave"), ...holder, ok: z.number().int().min(0).max(3), fail: z.number().int().min(0).max(3) }),
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
  z.strictObject({ type: z.literal("teleport"), tokenId: id, past: z.enum(["wall", "ledge"]) }),
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
        }),
      )
      .max(LIMITS.diceRollsPerOp),
  }),
]);

const logEntry = z.strictObject({
  id: z.string().regex(/^\d{1,18}:\d{1,6}$/),
  at: iso,
  kind: z.enum(["chat", "whisper", "event"]),
  from: id.optional(),
  to: z.array(id).max(MAX_OWNERS).optional(),
  text: longText.optional(),
  data: logEvent.optional(),
});

const record = <T extends z.ZodType>(value: T) => z.record(z.string().min(1).max(120), value);

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
  log: z.array(logEntry).max(MAX_LOG),
  monsters: record(monster),
  srdImages: z.record(srdIdSchema, srdImage),
  savedEncounters: record(savedEncounter),
  stamps: record(stamp),
  lights: record(light),
  // The party's explored layer, in the fog tiles' shape (docs/design-v1-maps-vision.md 4.3.3).
  exploredTiles: record(fogTile),
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
});

export function parseRoomState(value: unknown): { ok: true; state: RoomState } | { ok: false; message: string } {
  const parsed = roomStateSchema.safeParse(value);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return { ok: false, message: `${issue?.path.join(".") ?? ""}: ${issue?.message ?? "invalid"}` };
  }
  return { ok: true, state: parsed.data as RoomState };
}
