import { chunkKey, doorChunk, holderChunkKey, keys, wallMidpoint } from "./keys.ts";
import { imageAssetId } from "./imageRef.ts";
import { eventLines } from "./logRings.ts";
import type { Actor, BuildChunk, CastAsk, Character, Drawing, DurationAnchor, Effect, ImageRef, InitEntry, JournalAccess, PromptKey, RollTarget, RoomSettings, RoomState, Scene, Token, Viewer } from "./model.ts";
import { MAX_ROUTE_REACH, syncStampFits, type ActorTarget, type CharacterExpect, type DoorRef, type ExpectPart, type Op, type OpOf, type RefusalCode, type TokenInput, type TokenPatch } from "./protocol.ts";
import { gridOfToken, hash128, heldFreeDoor, inSightOfNonOwners, ownsCharacter, ownsToken, projectEntity, shownFreeWall, stableStringify, viewerSceneId, type ProjectOpts, type ProjectedEncounter } from "./project.ts";
import { CHARACTER_CHANGED, LIMITS } from "./limits.ts";
import { restoreAddedAssets } from "./referencedAssets.ts";
import { handoutPages } from "./handouts.ts";
import { movementRules, type Blocker, type LegEnd } from "./ruleHooks.ts";
import { carriedIndex, holderOf, isCreature, landsAt, linkHolds, onHolder, walkerFor, withinReach } from "./rules/attach.ts";
import { boxDistanceFt, pointCellBox, tokenCellBox } from "./rules/distance.ts";
import { checkSetReach, planMove } from "./rules/moveLeg.ts";
import { footprintRect, footprintSize, occupiedHexes, snapStep, storedCenter, type FootprintToken } from "./rules/footprint.ts";
import { isHex, sceneGrid, SQUARES, type Grid } from "./rules/grid.ts";
import { hexAt, hexInScene, hexKey, hexNeighbors, type HexGrid } from "./rules/hex.ts";
import { groundAt } from "./rules/heights.ts";
import { convexHull } from "./rules/aoe.ts";
import type { Point } from "./rules/geom.ts";
import { convexLive, fogClassOf, groundOf, partLive, type Ground } from "./rules/held.ts";
import {
  LEDGE_IN_THE_WAY,
  WALL_IN_THE_WAY,
  hexLegSpots,
  hexStandAt,
  hexStartStand,
  hexStandHexes,
  hexStandPlace,
  landing,
  lastClearSpot,
  legSpots,
  legStop,
  legStopPart,
  onSqueezedLattice,
  ownWalk,
  straightClear,
  walkEnd,
  walkFrom,
  walkOn,
  type Walker,
} from "./rules/movement.ts";
import { legSteps, onRouteLattice, routeLattice, routePoints, routeStop, routeWalkers, type RoutePiece } from "./rules/route.ts";
import { NO_ROOM_TO_GROW, OWNER_SIZES, resizeCandidates, resizeRefusal } from "./rules/resize.ts";
import { turnMovedOn } from "./rules/initiative.ts";
import { turnUnderWay } from "./rules/path.ts";
import { entryMatchesAnchor } from "./rules/durations.ts";
import { EXHAUSTION_MAX_LEVEL, levelFits } from "./srd/conditions.ts";

/**
 * Who may do what (design sections 8.1 and 8.2). The DM may do everything a
 * client can send, and a player gets the rules in the ops table: own things,
 * the two room toggles, and reference checks on every id in the op.
 *
 * A player who names something they cannot see gets `gone`, the same answer
 * a missing entity gives, so a refusal never confirms that a hidden thing
 * exists. Visibility is decided by the projection itself, never by a second
 * copy of its rules.
 */
export type AssetKind = "map" | "token" | "handout" | "thumb";

export type PermissionDeps = {
  /** Whether the member may reference the asset: their own upload, or one in their visible set (design 11.2). */
  canUseAsset: (memberId: string, assetId: string, kind: AssetKind) => boolean;
  /**
   * Whether a restore may put back a reference to this asset: it is still
   * a row of this room, of the kind its place takes (docs/design-v1-dm-tools.md
   * 2.6). Cleanup and the library delete can remove a row an undo step still
   * names, and putting it back would draw a broken picture for everyone. The
   * server loads the facts for the ids a restore adds (restoreAddedAssets in
   * shared/referencedAssets.ts) and passes this. Without it, as in the dev
   * fixture's local server, restores are not checked for deleted images.
   */
  restoredAssetUsable?: (assetId: string, kind: AssetKind) => boolean;
};

export type Decision = { ok: true } | { ok: false; code: RefusalCode; message: string };

const OK: Decision = { ok: true };

function refuse(code: RefusalCode, message: string): Decision {
  return { ok: false, code, message };
}

const FORBIDDEN = refuse("forbidden", "only the DM can do that");
/** The refusal of a drawing, or of an undo or redo that puts one back, by a player the DM has not let draw (docs/design-v1-dm-tools.md 3.9). */
export const NO_DRAWING = "The DM has not let you draw.";
/** The same, as an undo or redo refusal words it after "could not undo drawing: ", like every restore's reason. */
export const NO_DRAWING_BACK = "the DM has not let you draw";
const NOT_YOURS = refuse("forbidden", "that is not yours");
const GONE = refuse("gone", "that is not here");

/** A token's light is its owners' to set (docs/design-v1-maps-vision.md 4.3.9). `partyVision` stays the DM's. */
const OWNER_TOKEN_FIELDS = new Set(["image", "altImages", "rotation", "elevation", "name", "publicName", "notes", "rangeRings", "light"]);
/** A character's stat block and known forms are its players', as its light card is (docs/design-v1-pc-stats.md 4.1, docs/design-v1-known-forms.md 3.2). */
const OWNER_CHARACTER_FIELDS = new Set(["name", "defaultImage", "actor", "level", "stats", "knownForms", "ddbSync", "resources"]);
const OWNER_ACTOR_FIELDS = new Set(["hp", "speeds", "ac", "initBonus", "passivePerception", "senses", "notes", "sheetUrl"]);
/**
 * A character's players take a shape on its own actor (docs/design-v1-pc-stats.md
 * 4.1): an SRD creature and whether it is Wild Shape. A room monster's link
 * stays the DM's.
 */
const CHARACTER_OWNER_ACTOR_FIELDS = new Set([...OWNER_ACTOR_FIELDS, "srdId", "wildShape"]);

class Check {
  readonly state: RoomState;
  readonly actor: Viewer;
  readonly deps: PermissionDeps;
  readonly opts: ProjectOpts;
  private encounter: ProjectedEncounter | null | undefined;
  private readonly grounds = new Map<string, Ground | null>();

  constructor(state: RoomState, actor: Viewer, deps: PermissionDeps) {
    this.state = state;
    this.actor = actor;
    this.deps = deps;
    this.opts = { sceneId: state.meta.playerSceneId };
  }

  visible(key: string): boolean {
    return projectEntity(key, this.state, this.actor, this.opts) !== null;
  }

  visibleToken(id: string): Token | undefined {
    const token = this.state.tokens[id];
    return token && this.visible(keys.token(id)) ? token : undefined;
  }

  /**
   * The actor's live ground on a scene, where the touch rule speaks
   * (docs/design-v1-map-discovery.md 6, decision 11): a player's, on a
   * scene with fog on, squares and hexes alike (MD2-LK-3), each tested by
   * its own cells. Null where today's words stand: for the DM, and with
   * fog off, where nothing is withheld.
   */
  liveGround(sceneId: string): Ground | null {
    if (!this.grounds.has(sceneId)) {
      const scene = this.state.scenes[sceneId];
      const speaks = this.actor.role === "player" && scene?.fogEnabled === true;
      this.grounds.set(sceneId, speaks ? groundOf(this.state, sceneId, fogClassOf(this.state, sceneId, this.actor.memberId)) : null);
    }
    return this.grounds.get(sceneId)!;
  }

  /** The encounter as the actor's projection holds it: null with no fight, and for a player behind a blackout. */
  visibleEncounter(): ProjectedEncounter | null {
    this.encounter ??= projectEntity(keys.encounter, this.state, this.actor, this.opts) as ProjectedEncounter | null;
    return this.encounter;
  }

  visibleEntry(id: string): InitEntry | undefined {
    const projected = this.visibleEncounter()?.entries.find((e) => e.id === id);
    return projected ? this.state.encounter?.entries.find((e) => e.id === id) : undefined;
  }

  ownsTokenId(id: string): boolean {
    const token = this.state.tokens[id];
    return token !== undefined && ownsToken(this.state, this.actor, token);
  }

  ownsCharacterId(id: string): boolean {
    const character = this.state.characters[id];
    return character !== undefined && ownsCharacter(this.actor, character);
  }

  ownsEntry(entry: InitEntry): boolean {
    if (entry.tokenId !== undefined) return this.ownsTokenId(entry.tokenId);
    if (entry.characterId !== undefined) return this.ownsCharacterId(entry.characterId);
    return false;
  }

  /** Whether the actor may act on the creature behind an HP or effect op, and whether they own it. */
  target(target: ActorTarget): { visible: boolean; owned: boolean; viaToken: boolean } {
    if ("tokenId" in target) {
      const token = this.visibleToken(target.tokenId);
      return { visible: token !== undefined, owned: token !== undefined && ownsToken(this.state, this.actor, token), viaToken: true };
    }
    const character = this.state.characters[target.characterId];
    return { visible: character !== undefined, owned: character !== undefined && ownsCharacter(this.actor, character), viaToken: false };
  }

  /** The target's effect with this id, whether or not players may see it. */
  effect(target: ActorTarget, effectId: string): Effect | undefined {
    let actor: Actor | undefined;
    if ("characterId" in target) actor = this.state.characters[target.characterId]?.actor;
    else {
      const token = this.state.tokens[target.tokenId];
      actor = token && ("inline" in token.actor ? token.actor.inline : this.state.characters[token.actor.ref]?.actor);
    }
    return actor?.effects.find((e) => e.id === effectId);
  }

  /**
   * Whether the target's actor holds an effect with this id that players
   * may not see (design 7.3): the owner's projection leaves it out, so the
   * owner can neither change it nor learn that it exists.
   */
  hiddenEffect(target: ActorTarget, effectId: string): boolean {
    return this.effect(target, effectId)?.hiddenFromPlayers === true;
  }

  /** Whether the target holds an effect with this id that players may see. */
  shownEffect(target: ActorTarget, effectId: string): boolean {
    const effect = this.effect(target, effectId);
    return effect !== undefined && effect.hiddenFromPlayers !== true;
  }

  anchorVisible(of: DurationAnchor): boolean {
    if ("tokenId" in of) return this.visibleToken(of.tokenId) !== undefined;
    if ("characterId" in of) return this.state.characters[of.characterId] !== undefined;
    return this.visibleEntry(of.entryId) !== undefined;
  }

  asset(assetId: string, kind: AssetKind): boolean {
    return this.deps.canUseAsset(this.actor.memberId, assetId, kind);
  }
}

export function canApply(op: Op, actor: Viewer, state: RoomState, deps: PermissionDeps): Decision {
  if (op.t === "roll.answer" && op.tag === undefined) return refuse("invalid", ANSWER_NEEDS_TAG);
  const check = new Check(state, actor, deps);
  const decision = actor.role === "dm" ? forDm(op, check) : forPlayer(op, check);
  // After the role's checks, so a player who names a hidden effect hears that it is not there, never what it holds.
  if (!decision.ok) return decision;
  const hexed = hexPhaseFits(op, check);
  if (!hexed.ok) return hexed;
  if (actor.role !== "dm" && setsSave(op)) return refuse("forbidden", SAVE_IS_DMS);
  const levels = levelsFit(op, check);
  if (!levels.ok) return levels;
  const squeezed = squeezeFits(op, check);
  if (!squeezed.ok) return squeezed;
  const routed = routeFits(op, check);
  if (!routed.ok) return routed;
  const stamped = stampFits(op, check);
  if (!stamped.ok) return stamped;
  const prompted = promptFits(op, check);
  return prompted.ok ? expectFits(op, check) : prompted;
}

/**
 * The refusals on a hex scene of what hexes do not have yet (docs/design-v1-hex-grids.md
 * section 6, phase H1), in the words its limit lines show.
 */
export const ON_HEXES = {
  build: "Painted ground needs squares.",
  edges: "On hexes walls are wall lines.",
} as const;

/**
 * The server refuses on a hex scene every op whose rules are not hex yet
 * (HX-D20): every build op that paints ground or puts walls on grid lines.
 * No such op was ever stored, so lifting a refusal in a later phase changes
 * no replay. Lights, stamps, labels, Clear build and every fog shape stay.
 * From H2 so do free walls, Erase and difficult ground, routes and
 * squeezes, whose stops on hexes are anchors (`onHexStop`), attaching and a
 * token sent onto a hex scene with its links, and traps, and from H3
 * Reveal room's fog shapes of hex keys, heights, stairs and pits
 * (docs/design-v1-hex-grids.md section 6). A
 * restore keeps the same line in the reducer (shared/reducer/misc.ts),
 * since two DMs can race a switch.
 */
/** The build ops a builder ask may carry on a hex scene: those `hexPhaseFits` takes there. */
const HEX_ASKS: ReadonlySet<string> = new Set(["build.erase", "build.rough", "build.height", "build.stairs"]);

function hexPhaseFits(op: Op, c: Check): Decision {
  const hex = (sceneId: string | undefined) => {
    const scene = sceneId === undefined ? undefined : c.state.scenes[sceneId];
    return scene !== undefined && isHex(sceneGrid(scene));
  };
  const no = (words: string) => refuse("invalid", words);
  switch (op.t) {
    // Phase H2 builds on hexes with Wall lines (free walls), Erase and Difficult ground by hex keys (HX-D9), and H3 with heights and stairs.
    case "build.walls":
    case "build.erase":
    case "build.rough":
    case "build.height":
    case "build.stairs":
      return OK;
    case "build.edge":
      return hex(op.sceneId) ? no(ON_HEXES.edges) : OK;
    case "build.paint":
    case "build.rect":
    case "build.poly":
      return hex(op.sceneId) ? no(ON_HEXES.build) : OK;
    case "build.ask":
      if (!hex(op.sceneId)) return OK;
      if (op.ops.some((o) => o.t === "build.edge")) return no(ON_HEXES.edges);
      return op.ops.every((o) => HEX_ASKS.has(o.t)) ? OK : no(ON_HEXES.build);
    default:
      return OK;
  }
}

/** The refusal of a prompt whose turn record is not the creature's current one, or whose row and round no longer act (docs/design-v1-combat-controls.md 2.3). */
export const TURN_OVER = "That turn is over.";
/** The refusal of a prompt its record never held: a death save not dying at the start, or a recharge not due then. */
export const NOT_DUE = "That is not due this turn.";

export function noLongerDying(name: string): string {
  return `${name} is no longer dying.`;
}

/**
 * Why a turn's prompt (docs/design-v1-combat-controls.md 2.3) cannot be
 * settled now, or null: by its roll, its Apply or its Skip, or with
 * `reopen` a skipped one opened again. It is the occurrence `(record, what)`
 * on the creature's current record, while that record's row acts in its
 * round, so every surface settles it once and no answer lands after its
 * turn. A death save waits while the record began dying and the creature
 * still is, and a recharge while its mark is there. Regeneration is
 * accepted for any creature, since only the block says it has the trait.
 * Reopening a prompt not settled changes nothing, so it is no refusal.
 * Permissions ask it before any die is drawn, and the reducer again.
 */
export function promptRefusal(state: Pick<RoomState, "encounter">, actor: Pick<Actor, "turnRecord" | "life" | "uses">, name: string, record: number, what: string, reopen = false): string | null {
  const current = actor.turnRecord;
  const encounter = state.encounter;
  if (!current || current.id !== record || !encounter || encounter.activeEntryId !== current.entryId || encounter.round !== current.round) return TURN_OVER;
  const settled = current.settled !== undefined && Object.hasOwn(current.settled, what) ? current.settled[what as PromptKey] : undefined;
  if (reopen) return settled?.state === "done" ? SETTLED_MEANWHILE : null;
  if (settled) return SETTLED_MEANWHILE;
  if (what === "deathSave") {
    if (current.life !== "dying") return NOT_DUE;
    return actor.life === "dying" ? null : noLongerDying(name);
  }
  if (what.startsWith("recharge:")) {
    const key = what.slice("recharge:".length);
    if (!current.due?.includes(key)) return NOT_DUE;
    return actor.uses !== undefined && Object.hasOwn(actor.uses, key) ? null : SETTLED_MEANWHILE;
  }
  return what === "regeneration" ? null : NOT_DUE;
}

/** The creature an op names, with the name a refusal gives it: its character's, for a token that plays one. */
function creatureOf(state: RoomState, target: ActorTarget): { actor: Actor; name: string } | undefined {
  if ("characterId" in target) {
    const character = state.characters[target.characterId];
    return character && { actor: character.actor, name: character.name };
  }
  const token = state.tokens[target.tokenId];
  if (!token) return undefined;
  if ("inline" in token.actor) return { actor: token.actor.inline, name: token.name };
  const character = state.characters[token.actor.ref];
  return character && { actor: character.actor, name: character.name };
}

/**
 * The prompt an op settles or reopens, checked here, where ops arrive,
 * before the server draws any die for it (promptRefusal): a Skip or Reopen,
 * a death save or recharge roll that names its record, and Regeneration's
 * Apply. A creature that is not here is the op's own rules' to answer.
 */
function promptFits(op: Op, c: Check): Decision {
  let asked: { target: ActorTarget; record: number; what: string; reopen: boolean } | undefined;
  if (op.t === "actor.prompt") asked = { target: op.target, record: op.record, what: op.what, reopen: op.state === "open" };
  else if ((op.t === "actor.deathRoll" || op.t === "actor.rechargeRoll") && op.record !== undefined) {
    asked = { target: op.target, record: op.record, what: op.t === "actor.deathRoll" ? "deathSave" : `recharge:${op.key}`, reopen: false };
  } else if (op.t === "actor.use" && op.use.kind === "regenerate") asked = { target: op.target, record: op.use.record, what: "regeneration", reopen: false };
  if (!asked) return OK;
  const creature = creatureOf(c.state, asked.target);
  if (!creature) return OK;
  const refusal = promptRefusal(c.state, creature.actor, creature.name, asked.record, asked.what, asked.reopen);
  return refusal === null ? OK : refuse("invalid", refusal);
}

/**
 * A character as `expect` reads it: the server's, or a player's own copy,
 * whose actor holds every part `expect` names.
 */
export type ExpectSubject = Pick<Character, "stats" | "level" | "name" | "ddbSync" | "resources"> & {
  actor: Pick<Actor, "ac" | "speeds" | "senses" | "sheetUrl" | "srdId" | "wildShape"> & { hp?: Pick<Actor["hp"], "cur" | "max"> };
};

/**
 * The value of a character's part as `expect` hashes it
 * (docs/design-v1-resync.md 4), absent as null: HP is the current and
 * maximum alone, and the shape its SRD id and whether it is Wild Shape.
 *
 * A part of the block, and the record that describes the block, is null
 * with no block and wrapped with one, so a block deleted meanwhile never
 * hashes as one that lacks an optional part or a record. Apply and Undo
 * always expect the record, so neither puts a default block back.
 */
function expectValue(character: ExpectSubject, part: ExpectPart): unknown {
  if (part === "ddbSync" || part.startsWith("stats.")) {
    const stats = character.stats;
    if (stats === undefined) return null;
    return [part === "ddbSync" ? (character.ddbSync ?? null) : (stats[part.slice("stats.".length) as keyof typeof stats] ?? null)];
  }
  const actor = character.actor;
  switch (part) {
    case "level":
      return character.level;
    case "name":
      return character.name;
    case "actor.ac":
      return actor.ac;
    case "actor.speeds":
      return actor.speeds;
    case "actor.senses":
      return actor.senses;
    case "actor.sheetUrl":
      return actor.sheetUrl;
    case "actor.hp":
      return actor.hp ? { cur: actor.hp.cur, max: actor.hp.max } : undefined;
    case "actor.shape":
      return { srdId: actor.srdId, wildShape: actor.wildShape };
    case "resources":
      // The list whole, each count spent included, so a use spent since the review refuses the write (docs/design-v1-ddb-resources.md 5).
      return character.resources ?? null;
  }
}

/** A part's 12-hex hash, as a re-sync sends it in `expect` and the server checks it. */
export function expectHash(character: ExpectSubject, part: ExpectPart): string {
  return hash128(stableStringify(expectValue(character, part) ?? null)).slice(0, 12);
}

/** The `expect` of each part named, against the character as the sender sees it. */
export function expectOf(character: ExpectSubject, parts: Iterable<ExpectPart>): CharacterExpect {
  const out: CharacterExpect = {};
  for (const part of parts) out[part] = expectHash(character, part);
  return out;
}

/**
 * A `character.update`'s `expect`, for every role (docs/design-v1-resync.md
 * 4): each part it names still hashes as the sender saw it, on the staged
 * state. Here, where ops arrive, after the role's checks, so a player who
 * does not play the character hears that first, and never in the reducer,
 * so replay never runs it. Every part is one a player's own copy holds
 * whole, so a DM's change to anything else never refuses a player, and any
 * mismatch is the one refusal, which tells nothing of what differed.
 */
function expectFits(op: Op, c: Check): Decision {
  if (op.t !== "character.update" || op.expect === undefined) return OK;
  const character = c.state.characters[op.characterId];
  if (!character) return OK;
  for (const [part, hash] of Object.entries(op.expect) as [ExpectPart, string | undefined][]) {
    if (hash !== undefined && expectHash(character, part) !== hash) return refuse("invalid", CHARACTER_CHANGED);
  }
  return OK;
}

/** A sync write's refusal when the record it replaces leaves its stamp no room (`stampFits`). */
export const SYNC_STAMP_FULL = "this character's sync record cannot take a later time";

/**
 * A sync write the reducer would stamp (docs/design-v1-resync.md 4), for
 * every role: refused when the stamp past the record it replaces would not
 * parse, so no stored state ever fails the schema. Only a record at the
 * schema's last millisecond, which no clock makes, gets here.
 */
function stampFits(op: Op, c: Check): Decision {
  if (op.t !== "character.update" || !op.patch.ddbSync || op.patch.ddbSync.at !== undefined || op.patch.stats === null) return OK;
  const before = c.state.characters[op.characterId]?.ddbSync?.at;
  return syncStampFits(before) ? OK : refuse("invalid", SYNC_STAMP_FULL);
}

/** The refusals of a route whose shape no walk has (docs/design-v1-movement.md 7.1), whoever sends it. */
export const ROUTE_OFF_LATTICE = "a route steps by half squares from where the token stands, inside the scene";
export const ROUTE_TOO_LONG = `a route reaches at most ${MAX_ROUTE_REACH} squares`;
/** On a hex scene a route's stops are anchors (docs/design-v1-hex-grids.md 4.2, HX-D17). */
export const ROUTE_OFF_HEXES = "a route steps from hex to hex, each stop on its own hexes or a squeeze's, inside the scene";

/**
 * A move's route, for every role (7.1): each point on the half-square
 * lattice from where the token stands, its footprint inside the scene,
 * consecutive points apart, and at most 300 squares of reach in all, each
 * piece's change of elevation by the walk's own rule (route.ts
 * `routePoints`), and each piece's reach the largest over the token and the
 * group's public members it takes along (moveLeg.ts checkSetReach, review
 * R7-OPUS-1), with no climbs for a player on a scene with fog on. The DM's
 * routes are checked this far and no further.
 */
function routeFits(op: Op, c: Check): Decision {
  if (op.t !== "token.move" || !op.route) return OK;
  const token = c.state.tokens[op.tokenId];
  const scene = token ? c.state.scenes[token.sceneId] : undefined;
  if (!token || !scene) return OK;
  const fp = footprintSize(token);
  const grid = sceneGrid(scene);
  let prev: Point = { x: token.x, y: token.y };
  for (const [x, y] of op.route) {
    if (isHex(grid)) {
      if (!onHexStop(grid, scene, token, { x, y }) || (x === prev.x && y === prev.y)) return refuse("invalid", ROUTE_OFF_HEXES);
    } else {
      const inside = x >= 0 && y >= 0 && x + fp.w <= scene.bounds.w + 1e-9 && y + fp.h <= scene.bounds.h + 1e-9;
      if (!onRouteLattice(token, { x, y }) || !inside || (x === prev.x && y === prev.y)) return refuse("invalid", ROUTE_OFF_LATTICE);
    }
    prev = { x, y };
  }
  const seen = seenAllIn(c);
  const trace = routeWalkers(c.state.buildChunks, walkerFor(c.state, token, seen, { to: op }), op.route, op.elevation ?? token.elevation);
  return checkSetReach(c.state, token, trace, seen, c.state.meta.settings.feetPerCell, c.actor.role, op.squeeze === true) <= MAX_ROUTE_REACH ? OK : refuse("invalid", ROUTE_TOO_LONG);
}

/**
 * Whether a stop of a route on hexes stands on an anchor: the box's middle
 * on its size's anchor or, for a creature that squeezes, the smaller
 * size's, a hair of rounding allowed, with every hex it takes inside the
 * scene. So a piece's stand is never in doubt (movement.ts HexStand).
 */
function onHexStop(g: HexGrid, scene: Scene, token: Token, at: Point): boolean {
  const stand = hexStandAt(g, token, at, onSqueezedLattice(g, token, at));
  const placed = hexStandPlace(g, token, stand);
  return Math.abs(placed.x - at.x) < 1e-6 && Math.abs(placed.y - at.y) < 1e-6 && hexStandHexes(g, stand).every((h) => hexInScene(g, scene.bounds, h));
}

/** The refusal of a player's op that names an effect's save or its occurrence (docs/design-v1-roll-options.md 6.1). */
export const SAVE_IS_DMS = "only the DM sets a save that ends an effect";

/**
 * Why the scene the players are on cannot be deleted. Deleting it would
 * send them to whichever scene comes first in the list, which may be one
 * the DM is preparing in private. The scene menu shows these words too.
 */
export const MOVE_PLAYERS_FIRST = "Move the players to another scene first.";
/** The same, as an undo or redo refusal words it after "could not redo deleting the scene Crypt: ", like every restore's reason. */
export const MOVE_PLAYERS_FIRST_BACK = "move the players to another scene first";

/**
 * Whether an op names a "save ends" save or occurrence on an effect. Only
 * the DM sets one, since its DC is the DM's, and only the server writes an
 * occurrence, so every op that carries effects is checked: an effect added
 * one or many at a time, a change to one, and a creature created with its
 * effects.
 */
function setsSave(op: Op): boolean {
  const named = (effects: readonly { save?: unknown; due?: unknown }[]) => effects.some((e) => e.save !== undefined || e.due !== undefined);
  switch (op.t) {
    case "actor.effect.add":
      return named([op.effect]);
    case "actor.effect.update":
      return op.patch.save !== undefined;
    case "actor.effects":
      return named((op.add ?? []).map((item) => item.effect));
    case "token.create":
      return "inline" in op.token.actor && named(op.token.actor.inline.effects);
    case "character.create":
      return named(op.character.actor.effects);
    default:
      return false;
  }
}

/** The refusal of a squeeze flag on a move that is not into a narrow opening (docs/design-v1-maps-vision.md 4.1). */
export const NOT_A_SQUEEZE = "it only squeezes where an opening is too narrow for it";

/**
 * A move that stops a token squeezed (`squeeze`), by anyone, the DM
 * included, needs section 4.1's four checks at its end: the flag marks
 * only a real squeeze, since every rule then reads the smaller footprint.
 * Here, where ops arrive, never in the reducer, so a stored squeeze
 * replays whatever the walls became since. It is judged as the walk that
 * ends there reads it, as the drop that sent it did (review AT-ASTRA-19):
 * off a holder every player sees, on the ground (rules/attach.ts
 * walkerFor), where its last leg starts, and off the holder for good once
 * the walk cleared it (movement.ts walkOn).
 */
function squeezeFits(op: Op, c: Check): Decision {
  if (op.t !== "token.move" || !op.squeeze) return OK;
  const token = c.state.tokens[op.tokenId];
  if (!token) return OK;
  const walker = walkerFor(c.state, token, seenAllIn(c), { to: op });
  const points = op.route ? routePoints(c.state.buildChunks, walker, op.route, op.elevation ?? token.elevation) : [];
  if (movementRules.squeezeFits(c.state, walkEnd(c.state, walker, { x: op.x, y: op.y }, points.slice(1, -1)))) return OK;
  // The full footprint is the squeeze's stopping step (docs/design-v1-map-discovery.md 6).
  const ground = c.liveGround(token.sceneId);
  const { squeeze: _squeeze, ...full } = token;
  return refuse("invalid", ground && !footprintLive(ground, { ...full, x: op.x, y: op.y }) ? SOMETHING_BLOCKS : NOT_A_SQUEEZE);
}

const LEVEL_DOES_NOT_FIT = refuse("invalid", `Exhaustion is level 1 to ${EXHAUSTION_MAX_LEVEL}`);

/**
 * Exhaustion's level is 1 to 6 on every op that sets one, by whoever sends
 * it (srd/conditions.ts levelFits). The rule lives here, where ops arrive,
 * rather than in the reducer: the reducer replays stored ops, and the
 * rooms in use stored ops from before it that it must still apply as they
 * were. A change names its effect, not the effect's kind, so the effect it
 * changes decides.
 */
function levelsFit(op: Op, c: Check): Decision {
  const fits = (effects: readonly { key: string; level?: number }[]) => effects.every((e) => levelFits(e.key, e.level));
  switch (op.t) {
    case "actor.effect.add":
      return levelFits(op.effect.key, op.effect.level) ? OK : LEVEL_DOES_NOT_FIT;
    case "actor.effect.update": {
      const effect = c.effect(op.target, op.effectId);
      return !effect || levelFits(effect.key, op.patch.level) ? OK : LEVEL_DOES_NOT_FIT;
    }
    case "token.create":
      return "inline" in op.token.actor && !fits(op.token.actor.inline.effects) ? LEVEL_DOES_NOT_FIT : OK;
    case "actor.effects":
      return fits((op.add ?? []).map((item) => item.effect)) ? OK : LEVEL_DOES_NOT_FIT;
    case "character.create":
      return fits(op.character.actor.effects) ? OK : LEVEL_DOES_NOT_FIT;
    default:
      return OK;
  }
}

/** The DM may do everything a client sends. Asset references are still checked, so no op names another room's file. */
function forDm(op: Op, c: Check): Decision {
  switch (op.t) {
    case "sys.memberJoin":
    case "sys.memberSetKind":
    case "sys.memberRemove":
      // Roster changes come from HTTP flows the server runs itself, never from a socket.
      return refuse("forbidden", "the server makes roster changes");
    case "sys.explore":
      // The actor writes what the party explored after each batch (docs/design-v1-maps-vision.md 4.3.3).
      return refuse("forbidden", "the server records what the party explored");
    case "sys.remember":
      // So it writes what players remember (docs/design-v1-map-discovery.md 5.3).
      return refuse("forbidden", "the server records what players remember");
    case "member.update":
      return op.memberId === c.actor.memberId ? OK : refuse("forbidden", "members edit only themselves");
    case "token.create":
      return tokenImagesUsable(c, op.token) ? OK : GONE;
    case "token.update":
      return tokenImagesUsable(c, op.patch) ? OK : GONE;
    case "token.updateMany":
      return imageUsable(c, op.patch.image) ? OK : GONE;
    case "sys.restore":
      return restoredAssetsUsable(op, c);
    case "character.create":
      return imageUsable(c, op.character.defaultImage) ? OK : GONE;
    case "character.update":
      return imageUsable(c, op.patch.defaultImage) ? OK : GONE;
    case "monster.create":
      return imageUsable(c, op.monster.defaultImage) ? OK : GONE;
    case "monster.update":
      return imageUsable(c, op.patch.defaultImage) ? OK : GONE;
    case "monster.setSrdImage":
      return imageUsable(c, op.image) ? OK : GONE;
    case "companionBlock.create":
      return imageUsable(c, op.block.defaultImage) ? OK : GONE;
    case "companionBlock.update":
      return imageUsable(c, op.patch.defaultImage) ? OK : GONE;
    case "scene.create":
      return op.scene.map && !c.asset(op.scene.map.assetId, "map") ? GONE : OK;
    case "scene.delete":
      // Here, where ops arrive, never in the reducer: a stored delete of the players' scene from before the rule still replays, moving them on as it did.
      return op.sceneId === c.state.meta.playerSceneId ? refuse("invalid", MOVE_PLAYERS_FIRST) : OK;
    case "scene.setMap":
      return op.map && !c.asset(op.map.assetId, "map") ? GONE : OK;
    case "scene.update": {
      // A thumbnail is a `thumb` asset and every phase a `map` asset, each of this room (docs/design-v1-maps-vision.md 3.3, 3.4).
      if (op.patch.thumb && !c.asset(op.patch.thumb, "thumb")) return GONE;
      return (op.patch.phases ?? []).every((phase) => c.asset(phase.assetId, "map")) ? OK : GONE;
    }
    case "build.stamps":
      // A stamp from the room's library wears a token image, as a token does (design 8.2).
      return (op.put ?? []).every((stamp) => !("assetId" in stamp.art) || c.asset(stamp.art.assetId, "token")) ? OK : GONE;
    case "handout.show":
      // Every page a handout image of this room, so a map, a token image or another room's image among them is not here.
      return handoutPages(op.handout).every((page) => c.asset(page.assetId, "handout")) ? OK : GONE;
    case "handoutDoc.create":
      return op.doc.pages.every((page) => c.asset(page.assetId, "handout")) ? OK : GONE;
    case "journal.create":
      return pageReader(c, op.page.access);
    case "journal.update":
      return op.patch.access === undefined ? OK : pageReader(c, op.patch.access);
    case "dice.roll":
      return diceRollCheck(c, op);
    case "roll.dice":
      return rollDiceCheck(c, op);
    case "roll.reopen":
      return op.change === undefined ? OK : allowFixCheck(c, op);
    // The DM keeps or allows a player's ask and never makes one (docs/design-v1-roll-request.md 7.5).
    case "roll.change":
      return op.ask === undefined ? OK : refuse("forbidden", ONLY_PLAYERS_ASK);
    // The DM's death roll and recharge roll need a creature that exists, checked before anything is drawn.
    case "actor.deathRoll":
    case "actor.rechargeRoll":
      return ("tokenId" in op.target ? c.state.tokens[op.target.tokenId] : c.state.characters[op.target.characterId]) ? OK : GONE;
    // The rule of the op it carries (docs/design-v1-dice.md 4.2).
    case "sys.dice":
      return forDm(op.asked, c);
    // A player asks for saves, and the DM resolves or sets the ask aside (docs/design-v1-player-save-spell.md 5.4).
    case "cast.ask":
      return refuse("forbidden", DM_RUNS_GROUP_SAVE);
    case "cast.close":
      if (op.end === "withdrawn") return refuse("forbidden", ONLY_ITS_PLAYER_WITHDRAWS);
      return c.state.casts[op.castId] ? OK : refuse("gone", ASK_CLOSED);
    // Two DM devices that opened one ask apply it once.
    case "actor.outcome":
      return op.cast === undefined || c.state.casts[op.cast] ? OK : refuse("gone", ASK_CLOSED);
    default:
      return OK;
  }
}

/** The refusal of a page private to a DM, who reads every page anyway (docs/design-v1-dm-tools.md 3.7). */
export const PAGE_FOR_A_PLAYER = "a page is private to one player, never to a DM";

/**
 * A page private to one member is private to a player: a DM reads every
 * page, so a page "private" to one would be DM only in effect while its
 * pins named a DM as their reader. Checked here, where ops arrive, rather
 * than in the reducer, so a stored op from before the rule replays as it
 * was. Making a member a DM turns their private pages DM only (reducer/room.ts).
 */
function pageReader(c: Check, access: JournalAccess): Decision {
  if (typeof access !== "object") return OK;
  return c.state.members[access.member]?.kind === "dm" ? refuse("invalid", PAGE_FOR_A_PLAYER) : OK;
}

function forPlayer(op: Op, c: Check): Decision {
  // The scene the player holds, which behind a blackout is none (design 7.3): an op on the table then answers as if it were not there.
  const playerScene = viewerSceneId(c.state, c.actor, c.opts);
  switch (op.t) {
    case "room.update":
    case "room.setPlayerScene":
    case "view.follow":
    case "view.blackout":
    case "scene.create":
    case "scene.update":
    case "scene.delete":
    case "scene.reorder":
    case "scene.setMap":
    case "scene.setGrid":
    case "scene.setPhase":
    case "vision.holders":
    case "scene.duplicate":
    case "actor.life":
    case "actor.damageMany":
    case "monster.create":
    case "monster.update":
    case "monster.delete":
    case "monster.setSrdImage":
    case "savedEncounter.create":
    case "savedEncounter.update":
    case "savedEncounter.delete":
    case "fog.draft":
    case "fog.publish":
    case "fog.discard":
    case "fog.live":
    case "fog.reset":
    case "build.paint":
    case "build.erase":
    case "build.rect":
    case "build.poly":
    case "build.edge":
    case "build.label":
    case "build.clear":
    case "build.walls":
    case "build.stamps":
    case "build.lights":
    case "build.height":
    case "build.stairs":
    case "build.rough":
    case "build.ask":
    case "encounter.start":
    case "encounter.end":
    case "encounter.setValues":
    case "encounter.reorder":
    case "encounter.prev":
    case "handout.show":
    case "handout.close":
    case "handoutDoc.create":
    case "handoutDoc.delete":
    case "sys.memberJoin":
    case "sys.memberSetKind":
    case "sys.memberRemove":
    case "sys.explore":
    case "sys.remember":
    case "token.deleteMany":
    case "journal.create":
    case "journal.update":
    case "journal.reveal":
    case "journal.delete":
    case "pin.put":
    case "pin.remove":
    case "roll.ask":
    case "roll.reopen":
    case "roll.close":
    // A save-ends occurrence is the DM's to settle, and a group save's outcome the DM's to apply (docs/design-v1-roll-options.md 6.1, 5.5).
    case "actor.saveDue":
    case "actor.outcome":
    // Traps are the DM's alone: players search and disarm through the DM's requests (docs/design-v1-traps.md 6.2).
    case "trap.create":
    case "trap.update":
    case "trap.delete":
    case "trap.spring":
    case "trap.act":
    case "trap.settle":
      return FORBIDDEN;

    case "token.updateMany": {
      // Owners may set the owner fields among a group edit's (OWNER_TOKEN_FIELDS), on tokens they own, each as a
      // `token.update` would be checked (docs/design-v1-dm-tools.md 3.5).
      for (const id of op.tokenIds) {
        const token = c.visibleToken(id);
        if (!token) return GONE;
        if (!ownsToken(c.state, c.actor, token)) return NOT_YOURS;
      }
      for (const field of Object.keys(op.patch)) if (!OWNER_TOKEN_FIELDS.has(field)) return refuse("forbidden", `owners cannot change ${field}`);
      return tokenImagesUsable(c, op.patch) ? OK : GONE;
    }

    case "actor.effects": {
      // Each item as its single op, the hidden effects' rules included, so the whole answers as its first refusal.
      for (const item of op.add ?? []) {
        const d = forPlayer({ t: "actor.effect.add", target: item.target, effect: item.effect }, c);
        if (!d.ok) return d;
      }
      for (const item of op.remove ?? []) {
        const d = forPlayer({ t: "actor.effect.remove", target: item.target, effectId: item.effectId }, c);
        if (!d.ok) return d;
      }
      return OK;
    }

    case "roll.answer":
      return rollAnswerCheck(c, op);
    case "roll.change":
      return rollChangeCheck(c, op);

    case "cast.ask":
      return castAskCheck(c, op, playerScene);
    case "cast.close":
      return castCloseCheck(c, op, playerScene);

    case "dice.roll":
      return diceRollCheck(c, op);
    case "roll.dice":
      return rollDiceCheck(c, op);
    case "sys.dice":
      return forPlayer(op.asked, c);

    case "door.set":
      return doorCheck(c, op);

    case "member.update":
      return op.memberId === c.actor.memberId ? OK : refuse("forbidden", "members edit only themselves");

    case "character.create":
      return createCharacterCheck(c, op.character);
    case "companionBlock.create":
    case "companionBlock.update":
    case "companionBlock.delete":
      return companionBlockCheck(c, op);
    case "token.create":
      return op.token.companion ? companionCheck(c, op.token, op.token.companion) : placeTokenCheck(c, op.token);
    case "token.delete": {
      // Dismiss: a companion's owners delete it, as its character's player (docs/design-v1-combat-flow.md 3.6.4). Every
      // other token is the DM's.
      const token = c.visibleToken(op.tokenId);
      if (!token) return GONE;
      if (!token.companion) return FORBIDDEN;
      return ownsToken(c.state, c.actor, token) ? OK : NOT_YOURS;
    }

    case "token.move": {
      const d = namedMoveCheck(c, op.tokenId, op);
      if (!d.ok) return d;
      const own = !op.route ? legCheck(c, op.tokenId, op, op.teleport !== undefined) : routeFits(op, c);
      if (!own.ok) return own;
      const stops = hexStopAgrees(c, op);
      if (!stops.ok) return stops;
      // A route of no walk's shape is refused as such before its pieces meet the walls.
      const walked = op.route ? routeCheck(c, op.tokenId, [op.route], op) : OK;
      return walked.ok ? draggedWalls(c, op) : walked;
    }
    case "token.moveMany": {
      for (const move of op.moves) {
        const d = namedMoveCheck(c, move.tokenId, move);
        if (!d.ok) return d;
      }
      // A group move is refused whole when a leg is stopped: the client sends only the legs it found allowed.
      for (const move of op.moves) {
        const d = legCheck(c, move.tokenId, move, false);
        if (!d.ok) return d;
      }
      return draggedWalls(c, op);
    }

    case "token.attach":
      return attachCheck(c, op);
    case "token.detach":
      return detachCheck(c, op);

    case "token.countLeg": {
      // An owner says how their creature moved, on a locked token too, as with its elevation and facing.
      const token = c.visibleToken(op.tokenId);
      if (!token) return GONE;
      return ownsToken(c.state, c.actor, token) ? OK : NOT_YOURS;
    }

    case "token.update": {
      const token = c.visibleToken(op.tokenId);
      if (!token) return GONE;
      if (!ownsToken(c.state, c.actor, token)) return NOT_YOURS;
      if (token.companion) return companionUpdateCheck(c, token, token.companion, op.patch);
      if (op.patch.size !== undefined) return resizeCheck(c, token, op.patch);
      for (const field of Object.keys(op.patch)) {
        if (!OWNER_TOKEN_FIELDS.has(field)) return refuse("forbidden", `owners cannot change ${field}`);
        if ((field === "name" || field === "publicName") && token.kind !== "pc") return refuse("forbidden", "only a PC's owner renames it");
      }
      if (!tokenImagesUsable(c, op.patch)) return GONE;
      return OK;
    }

    case "actor.hp": {
      const t = c.target(op.target);
      if (!t.visible) return GONE;
      if (t.owned) return OK;
      const relative = op.change.kind === "damage" || op.change.kind === "heal";
      if (relative && c.state.meta.settings.playersApplyDamage && t.viaToken) return OK;
      return NOT_YOURS;
    }

    case "actor.deathSave":
    // A death save rolled on the server, as its counts are set (docs/design-v1-dice.md 4.1).
    case "actor.deathRoll":
    case "actor.rechargeRoll":
    case "actor.prompt":
    case "actor.rest": {
      const t = c.target(op.target);
      if (!t.visible) return GONE;
      return t.owned ? OK : NOT_YOURS;
    }

    case "actor.use": {
      const t = c.target(op.target);
      if (!t.visible) return GONE;
      if (!t.owned) return NOT_YOURS;
      // Class resources are the character's players' alone (docs/design-v1-combat-controls.md 7.2), so a player lent
      // only the token spends none, as they read and edit none.
      if (op.use.kind !== "resource" || !("tokenId" in op.target)) return OK;
      const token = c.state.tokens[op.target.tokenId];
      return token && "ref" in token.actor && !c.ownsCharacterId(token.actor.ref) ? NOT_YOURS : OK;
    }

    case "actor.effect.remove": {
      const t = c.target(op.target);
      if (!t.visible) return GONE;
      if (!t.owned) return NOT_YOURS;
      return c.shownEffect(op.target, op.effectId) ? OK : GONE;
    }

    case "actor.effect.add":
    case "actor.effect.update": {
      const t = c.target(op.target);
      if (!t.visible) return GONE;
      if (!t.owned) return NOT_YOURS;
      // A condition the DM hid is not in the owner's projection, so an id
      // that names one is answered as one that is not there at all, in the
      // same words and before the patch is looked at. Otherwise the answer
      // to a change of a hidden condition would tell it from a removed one.
      if (op.t === "actor.effect.add" ? c.hiddenEffect(op.target, op.effect.id) : !c.shownEffect(op.target, op.effectId)) return GONE;
      const hides = op.t === "actor.effect.add" ? op.effect.hiddenFromPlayers : op.patch.hiddenFromPlayers;
      if (hides !== undefined) return refuse("forbidden", "only the DM hides a condition from players");
      const shows = op.t === "actor.effect.add" ? op.effect.triggerShown : op.patch.triggerShown;
      if (shows !== undefined) return refuse("forbidden", "only the DM shows a trigger to players");
      const duration = op.t === "actor.effect.add" ? op.effect.duration : op.patch.duration;
      if (duration && !c.anchorVisible(duration.of)) return GONE;
      return OK;
    }

    case "character.update": {
      const character = c.state.characters[op.characterId];
      if (!character) return GONE;
      if (!ownsCharacter(c.actor, character)) return NOT_YOURS;
      for (const field of Object.keys(op.patch)) {
        if (!OWNER_CHARACTER_FIELDS.has(field)) return refuse("forbidden", `owners cannot change ${field}`);
      }
      for (const field of Object.keys(op.patch.actor ?? {})) {
        if (!CHARACTER_OWNER_ACTOR_FIELDS.has(field)) return refuse("forbidden", `owners cannot change ${field}`);
      }
      if (!imageUsable(c, op.patch.defaultImage)) return GONE;
      return OK;
    }

    case "character.delete": {
      // Who plays a character is no secret at the table, so a refusal may say which rule it failed.
      const character = c.state.characters[op.characterId];
      if (!character) return GONE;
      if (!ownsCharacter(c.actor, character)) return NOT_YOURS;
      return playsAlone(c.actor.memberId, character) ? OK : refuse("forbidden", PLAYED_WITH_OTHERS);
    }

    case "template.create": {
      const t = op.template;
      if (c.state.templates[t.id]) return GONE;
      if (t.ownerId !== c.actor.memberId) return NOT_YOURS;
      if (t.visibility !== "all") return refuse("forbidden", "players cannot hide areas");
      if (t.sceneId !== playerScene) return GONE;
      if (t.attachedTo !== undefined && !c.visibleToken(t.attachedTo)) return GONE;
      if (t.casterId !== undefined && !c.visibleToken(t.casterId)) return GONE;
      return OK;
    }
    case "template.update": {
      const template = c.state.templates[op.templateId];
      if (!template || !c.visible(keys.template(op.templateId))) return GONE;
      if (template.ownerId !== c.actor.memberId) return NOT_YOURS;
      const asked = askedAreaRefusal(c, template.id);
      if (asked) return asked;
      if (op.patch.visibility !== undefined && op.patch.visibility !== "all") return refuse("forbidden", "players cannot hide areas");
      if (op.patch.attachedTo && !c.visibleToken(op.patch.attachedTo)) return GONE;
      if (op.patch.casterId && !c.visibleToken(op.patch.casterId)) return GONE;
      return OK;
    }
    case "template.delete": {
      const template = c.state.templates[op.templateId];
      if (!template || !c.visible(keys.template(op.templateId))) return GONE;
      if (template.ownerId !== c.actor.memberId) return NOT_YOURS;
      return askedAreaRefusal(c, template.id) ?? OK;
    }

    case "drawing.create": {
      const d = op.drawing;
      // A kept ruler is a measurement from the ruler tool, not a drawing, so it stays allowed (question 6).
      if (d.kind !== "ruler" && !drawsAllowed(c.state.meta.settings, c.actor.memberId)) return refuse("forbidden", NO_DRAWING);
      if (c.state.drawings[d.id]) return GONE;
      if (d.ownerId !== c.actor.memberId) return NOT_YOURS;
      if (d.visibility !== "all") return refuse("forbidden", "players cannot hide drawings");
      if (d.sceneId !== playerScene) return GONE;
      // A kept ruler stands only on tokens the player can see, like any reference (design 8.2).
      if (d.anchors?.some((id) => id !== null && !c.visibleToken(id))) return GONE;
      return OK;
    }
    case "drawing.delete": {
      const drawing = c.state.drawings[op.drawingId];
      if (!drawing || !c.visible(keys.drawing(op.drawingId))) return GONE;
      return drawing.ownerId === c.actor.memberId ? OK : NOT_YOURS;
    }
    case "drawing.clear":
      if (op.scope !== "own") return FORBIDDEN;
      return op.sceneId === playerScene ? OK : GONE;

    case "encounter.add": {
      // A fight the player's projection does not hold, as behind a blackout, answers as no fight does.
      if (!c.state.encounter || !c.visible(keys.encounter)) return GONE;
      for (const entry of op.entries) {
        if (c.state.encounter.entries.some((e) => e.id === entry.id)) return GONE;
        if (entry.hidden || entry.groupKey !== undefined) return refuse("forbidden", "players add plain rows");
        if (entry.tokenId !== undefined) {
          if (!c.visibleToken(entry.tokenId)) return GONE;
          if (!c.ownsTokenId(entry.tokenId)) return NOT_YOURS;
        } else if (entry.characterId !== undefined) {
          if (!c.state.characters[entry.characterId]) return GONE;
          if (!c.ownsCharacterId(entry.characterId)) return NOT_YOURS;
        } else {
          return refuse("forbidden", "players add only their own characters");
        }
        // A row joins with a value only as a roll's total while the room has typed totals off, as encounter.setValue does.
        const row: InitEntry = { id: entry.id, value: null, tieOrder: 0, hidden: false, reactionUsed: false, inLair: false, ...(entry.tokenId !== undefined ? { tokenId: entry.tokenId } : {}), ...(entry.characterId !== undefined ? { characterId: entry.characterId } : {}) };
        if (typedInitiative(c, row, entry.value ?? null, entry.roll)) return refuse("forbidden", NO_TYPED_INITIATIVE);
      }
      return OK;
    }
    case "encounter.remove": {
      for (const id of op.entryIds) {
        const entry = c.visibleEntry(id);
        if (!entry) return GONE;
        if (!c.ownsEntry(entry)) return NOT_YOURS;
      }
      return OK;
    }
    case "encounter.setValue": {
      const entry = c.visibleEntry(op.entryId);
      if (!entry) return GONE;
      if (!c.ownsEntry(entry)) return NOT_YOURS;
      if (typedInitiative(c, entry, op.value, op.roll)) return refuse("forbidden", NO_TYPED_INITIATIVE);
      return OK;
    }
    case "encounter.update": {
      // A player marks their own creature's Reaction spent, as when a readied action fires (features section 10). Every other row flag is the DM's.
      const entry = c.visibleEntry(op.entryId);
      if (!entry) return GONE;
      if (!c.ownsEntry(entry)) return NOT_YOURS;
      return Object.keys(op.patch).every((field) => field === "reactionUsed") ? OK : FORBIDDEN;
    }
    case "encounter.next": {
      // Behind a blackout, as with no fight, the player holds no encounter: every press is gone, whatever it names.
      if (!c.visibleEncounter() || !c.state.encounter) return GONE;
      const active = c.state.encounter.activeEntryId;
      const entry = active === null ? undefined : c.visibleEntry(active);
      if (op.from !== undefined) {
        // A guarded press ends only the player's own turn, and the reducer leaves any other alone
        // (reducer/encounter.ts pressChangesNothing). So while no row this player sees acts, every
        // guarded press is taken alike, and none tells which hidden row acts. A late one is taken
        // quietly, since the turn already moved on.
        if (!entry || turnMovedOn(c.state.encounter, op)) return OK;
        return c.ownsEntry(entry) ? OK : refuse("forbidden", "it is not your turn");
      }
      if (!entry) return GONE;
      return c.ownsEntry(entry) ? OK : refuse("forbidden", "it is not your turn");
    }

    case "log.chat":
      return OK;
    case "log.whisper":
      return op.to.every((id) => c.state.members[id] !== undefined) ? OK : GONE;

    case "undo":
      // Taking back an HP change from the log is the DM's (features section 10). A player's own stack is theirs.
      if (op.log !== undefined) return refuse("forbidden", "only the DM takes back a change from the log");
      return op.scope === "setup" || op.discard === true ? refuse("forbidden", "only the DM uses setup history or discards a step") : OK;
    case "redo":
      return op.scope === "setup" || op.discard === true ? refuse("forbidden", "only the DM uses setup history or discards a step") : OK;

    case "sys.restore": {
      // A player's stack holds only their own drawings and token moves and resizes (design 7.7), so that is all a restore may touch.
      const restoring = restoredTokens(op);
      const quiet = new Set(op.quiet ?? []);
      for (const entry of op.entries) {
        if (entry.key.startsWith("token:")) {
          // An undo retraces a move that was allowed when made. A redo makes it again, so walls stop it as they would a new
          // move, except a teleport's, which passed them the first time too (docs/design-v1-maps-vision.md 4.1).
          const tokenId = entry.key.slice("token:".length);
          // A silent passenger of the step answers nothing, whatever the DM changed about it unseen since (docs/design-v1-attach.md 8.3).
          if (quiet.has(tokenId)) {
            const current = c.state.tokens[tokenId];
            const restored = entry.value && typeof entry.value === "object" ? (entry.value as Token) : null;
            if (!current || !restored || withoutPose(restored) !== withoutPose(current)) return FORBIDDEN;
            continue;
          }
          const redo = op.from === "redo" && !op.teleport;
          const holder = carriedThroughout(c, tokenId, entry.value, restoring);
          const d = holder ? restoreCarriedCheck(c, tokenId, entry.value, redo, holder, op.routes?.[holder], restoring) : restorePoseCheck(c, tokenId, entry.value, redo, op.routes?.[tokenId]);
          if (!d.ok) return restoreWords(d);
          continue;
        }
        if (!entry.key.startsWith("drawing:")) return FORBIDDEN;
        const before = entry.value as Drawing | null | undefined;
        const current = c.state.drawings[entry.key.slice("drawing:".length)];
        // Only on the scene the player holds, as a drawing op is, so an undo never writes off it and answers
        // the same whether a scene the players left is still there or was deleted since.
        if ((before && before.sceneId !== playerScene) || (current && current.sceneId !== playerScene)) return GONE;
        if (before && (before.ownerId !== c.actor.memberId || before.visibility !== "all")) return FORBIDDEN;
        if (current && (current.ownerId !== c.actor.memberId || current.visibility !== "all")) return FORBIDDEN;
        // Putting a drawing back draws it again, so it needs the permission a new one does (docs/design-v1-dm-tools.md 2.6).
        // Taking one away stays allowed.
        if (before && before.kind !== "ruler" && !drawsAllowed(c.state.meta.settings, c.actor.memberId)) return refuse("forbidden", NO_DRAWING_BACK);
      }
      return OK;
    }
  }
}

/**
 * Whether the actor may wear an image: an upload must be one they may use,
 * of kind `token`. A shipped icon names no asset, so its key's shape, which
 * the protocol checked, is all it needs (docs/design-v1-dm-tools.md 3.12).
 */
function imageUsable(c: Check, image: ImageRef | null | undefined): boolean {
  const assetId = imageAssetId(image);
  return assetId === undefined || c.asset(assetId, "token");
}

/** Whether every image a token op names, the one it wears and its alternates, is one the actor may use. */
function tokenImagesUsable(c: Check, input: { image?: ImageRef | null; altImages?: ImageRef[] | null }): boolean {
  return imageUsable(c, input.image) && (input.altImages ?? []).every((image) => imageUsable(c, image));
}

/**
 * Whether a member may move a token at all, by rights alone: the question
 * the ephemeral channel asks of a drag preview. Walls stay out of it
 * (docs/design-v1-maps-vision.md 4.1): the dragging client stops its own
 * preview at a wall, and the move it drops is tested when it arrives.
 */
export function mayMoveToken(state: RoomState, viewer: Viewer, tokenId: string): Decision {
  if (viewer.role === "dm") return state.tokens[tokenId] ? OK : GONE;
  const c = new Check(state, viewer, { canUseAsset: () => false });
  const d = namedMoveCheck(c, tokenId);
  if (d.ok || d.code === "gone") return d;
  // A token a holder the player moves carries goes with it, however the player stands with it (docs/design-v1-attach.md 6),
  // up links the player sees alone, so a hidden holder lends no drag a right (8.0).
  const seen = new Set<string>([tokenId]);
  let at = state.tokens[tokenId];
  for (let up = at && holderOf(state.tokens, at); up && !seen.has(up.id) && c.visibleToken(up.id); up = at && holderOf(state.tokens, at)) {
    seen.add(up.id);
    if (namedMoveCheck(c, up.id).ok) return OK;
    at = state.tokens[up.id];
  }
  return d;
}

/**
 * Whether the room lets this player draw (docs/design-v1-dm-tools.md 3.9):
 * every player, the default and the rule for rooms from before the setting,
 * or this one among those the DM picked. The Draw tool asks the same, so it
 * shows exactly when the server would take a drawing.
 */
export function drawsAllowed(settings: Partial<Pick<RoomSettings, "playersDraw">>, memberId: string): boolean {
  const who = settings.playersDraw ?? "all";
  return who === "all" || (Array.isArray(who) && who.includes(memberId));
}

/**
 * A player's answer to a roll request (docs/design-v1-dm-tools.md 3.3): a
 * request that exists and names a creature they own now, else `gone`, the
 * same answer a missing request gives, so a refusal never says whom else
 * the DM asked. They send a total, while the room lets players type them
 * (playersTypeTotals), or fail a save without rolling. Whether
 * an answer is final is the reducer's, which applies it whatever the client
 * shows.
 */
function rollAnswerCheck(c: Check, op: OpOf<"roll.answer">): Decision {
  const request = c.state.rolls[op.rollId];
  if (!request || !c.visible(keys.roll(op.rollId))) return GONE;
  const named = request.targets.some((t) => ("tokenId" in op.target ? t.tokenId === op.target.tokenId : t.characterId === op.target.characterId));
  const owned = "tokenId" in op.target ? c.ownsTokenId(op.target.tokenId) : c.ownsCharacterId(op.target.characterId);
  if (!named || !owned) return GONE;
  if (op.result !== undefined && (op.result !== "fail" || op.total !== undefined || request.test.kind !== "save")) {
    return refuse("forbidden", "players send the total they rolled, or fail a saving throw without rolling");
  }
  if (op.total !== undefined && !playersTypeTotals(c.state.meta.settings)) return refuse("forbidden", NO_TYPED_TOTALS);
  return OK;
}

/**
 * Whether players may type their roll totals (RoomSettings.playersTypeTotals):
 * absent reads as on. Off, a player's answer is rolled on the server, and a
 * typed one, or an ask to fix one, is refused. A typed answer already in stands.
 */
export function playersTypeTotals(settings: Partial<Pick<RoomSettings, "playersTypeTotals">>): boolean {
  return settings.playersTypeTotals !== false;
}

/** The refusal of a player's typed total while the room has them off. */
export const NO_TYPED_TOTALS = "The DM has turned off typed totals in this room. Tap Roll instead.";
/** The refusal of a player's typed initiative while the room has typed totals off. */
export const NO_TYPED_INITIATIVE = "The DM has turned off typed totals in this room. Roll your Initiative instead.";

/**
 * Whether a player's initiative value for a row is a typed one the room
 * refuses: every op that sets one, `encounter.setValue` and the value a row
 * joins with in `encounter.add`, asks this. While typed totals are off, a
 * value goes only as the total of the player's own roll (rolledInitiative).
 * No value types no number, so clearing one, or joining without one, goes.
 */
function typedInitiative(c: Check, row: InitEntry, value: number | null, roll: string | undefined): boolean {
  if (value === null || playersTypeTotals(c.state.meta.settings)) return false;
  return !rolledInitiative(c.state, c.actor.memberId, row, value, roll);
}

/**
 * Whether a player's initiative value is the total of their own initiative
 * roll for that row's creature in this fight: a `dice` line of theirs under
 * the tag the value names, newer than the fight's start, with a roll marked
 * `initiative` for the row's creature (its token or its character) whose
 * total, kept within the row's -50 to 100, is the value. So an attack's
 * total, or an initiative from an earlier fight, never sets a row. The line
 * is in the log every viewer of it reads, so its formula stays in plain view.
 */
function rolledInitiative(state: RoomState, memberId: string, row: InitEntry, value: number, roll: string | undefined): boolean {
  if (roll === undefined) return false;
  // Newest first, one line per event, so the fight's start ends the search: anything older is another fight's. The encounter keeps the
  // start's seq, so a start line the DM's ring dropped still ends it. A fight from before it ends at its start line, and a start the log no
  // longer holds is older than every line it holds.
  const startSeq = state.encounter?.startSeq;
  const lines = eventLines(state.log);
  for (let i = lines.length - 1; i >= 0; i--) {
    const data = lines[i]!.data;
    if (startSeq !== undefined && Number(lines[i]!.id.slice(0, lines[i]!.id.indexOf(":"))) < startSeq) return false;
    if (data?.type === "encounter" && data.action === "start") return false;
    if (data?.type !== "dice" || data.tag !== roll || data.by !== memberId) continue;
    const ok = data.rolls.some((r) => {
      const creature = r.tokenId !== undefined ? { tokenId: r.tokenId } : r.characterId !== undefined ? { characterId: r.characterId } : null;
      return r.initiative === true && creature !== null && entryMatchesAnchor(state, row, creature) && Math.max(-50, Math.min(100, r.total)) === value;
    });
    if (ok) return true;
  }
  return false;
}

/**
 * The refusal of a live answer without its tag, the DM's or a player's
 * (docs/design-v1-roll-request.md 7.5). The tag is the answer's receipt key
 * and its provenance, and the reducer judges an untagged answer by the rule
 * from before them. So the rule lives here, where live ops arrive, and stored
 * answers from before it replay as they were. Only a page loaded before the
 * update still sends one.
 */
export const ANSWER_NEEDS_TAG = "An answer needs its tag. Reload the page.";

/** The refusal of a roll for a creature that has an answer by now (docs/design-v1-dice.md 4.3), a player's or one with `unanswered`. */
export const ANSWERED_MEANWHILE = "It was answered meanwhile.";
/** The refusal of the DM's Allow of an ask that is no longer the pending one (docs/design-v1-dice.md 4.3). */
export const SETTLED_MEANWHILE = "It was settled meanwhile.";

/**
 * A request's answer rolled on the server (docs/design-v1-dice.md 4.3), as
 * `roll.answer` is checked: a player for a target they own now, else
 * `gone`, and the DM for any target. A player rolls only a creature still
 * waiting, as does any roll with `unanswered`, so a DM's Roll that crosses a
 * player's answer never replaces it. Nor does a player roll a target whose
 * "Fix my total" the DM allowed (`retype`): that reopens the answer for
 * typing alone, while the DM may still roll it. While the room has typed
 * totals off the player types nothing, so they roll it, a `retype` set
 * before the switch went off included. `change`, the DM's Allow, needs the
 * target's pending ask to have that id, to name the current answer and that
 * answer to be rolled, so an ask replaced or withdrawn while the Allow
 * travels, or a second device's Allow, draws nothing. All before any draw.
 */
function rollDiceCheck(c: Check, op: OpOf<"roll.dice">): Decision {
  const request = c.state.rolls[op.rollId];
  if (!request || !c.visible(keys.roll(op.rollId))) return GONE;
  const target = request.targets.find((t) => ("tokenId" in op.target ? t.tokenId === op.target.tokenId : t.characterId === op.target.characterId));
  if (!target) return GONE;
  const player = c.actor.role === "player";
  if (player && !("tokenId" in op.target ? c.ownsTokenId(op.target.tokenId) : c.ownsCharacterId(op.target.characterId))) return GONE;
  if (player && op.change !== undefined) return refuse("forbidden", "Only the DM allows a change to a roll.");
  if (player && target.retype && playersTypeTotals(c.state.meta.settings)) return refuse("invalid", TYPE_THE_TOTAL);
  const answered = target.total !== undefined || target.result !== undefined;
  if (op.change === undefined) return (player || op.unanswered) && answered ? refuse("invalid", ANSWERED_MEANWHILE) : OK;
  const ask = target.change;
  return ask && ask.id === op.change && ask.on === target.tag && target.dice ? OK : refuse("invalid", SETTLED_MEANWHILE);
}

/** The refusal of a player's roll where the DM allowed "Fix my total", which reopens the answer for typing alone (docs/design-v1-roll-request.md 5.5). */
export const TYPE_THE_TOTAL = "Type the corrected total.";
/** The refusal of a DM's ask: an ask is the player's, and the DM changes an answer directly. */
export const ONLY_PLAYERS_ASK = "Only a player asks to change a roll.";

/**
 * A player's ask to change their answer, or its Withdraw
 * (docs/design-v1-roll-request.md 7.5), as `roll.answer` is checked: a
 * request they can see that names a creature they own now, else `gone`.
 * Whether the ask fits the answer it names is the reducer's, since it reads
 * the request's DC, which a player's view may lack. "Fix my total" goes only
 * while the room lets players type their totals.
 */
function rollChangeCheck(c: Check, op: OpOf<"roll.change">): Decision {
  const request = c.state.rolls[op.rollId];
  if (!request || !c.visible(keys.roll(op.rollId))) return GONE;
  const named = request.targets.some((t) => ("tokenId" in op.target ? t.tokenId === op.target.tokenId : t.characterId === op.target.characterId));
  const owned = "tokenId" in op.target ? c.ownsTokenId(op.target.tokenId) : c.ownsCharacterId(op.target.characterId);
  if (!named || !owned) return GONE;
  // "Fix my total" leads only to a typed answer, which the room has off.
  if (op.ask?.reason === "fix-total" && !playersTypeTotals(c.state.meta.settings)) return refuse("forbidden", NO_TYPED_TOTALS);
  return OK;
}

/**
 * The DM's Allow of a "Fix my total" ask (`roll.reopen { change }`), held
 * to the ask it names as `roll.dice { change }` is: that ask pending, a fix
 * of the total, and made on the answer the target holds now. So a stale
 * Allow, a second device's, or one of an ask the player withdrew or
 * replaced reopens nothing.
 */
function allowFixCheck(c: Check, op: OpOf<"roll.reopen">): Decision {
  const target = c.state.rolls[op.rollId]?.targets.find((t) => ("tokenId" in op.target ? t.tokenId === op.target.tokenId : t.characterId === op.target.characterId));
  if (!target) return GONE;
  return fixPending(target, op.change) ? OK : refuse("invalid", SETTLED_MEANWHILE);
}

/** Whether the target's pending ask is the "Fix my total" this id names, made on the answer it holds now. */
export function fixPending(target: Pick<RollTarget, "change" | "tag">, id: string | undefined): boolean {
  const ask = target.change;
  return ask !== undefined && ask.id === id && ask.reason === "fix-total" && ask.on === target.tag;
}

/** The refusal of a player's roll for a creature they see and do not own (docs/design-v1-dice.md 4.3). */
export const NOT_YOUR_ROLL = "You roll only for your own creatures.";

/**
 * A free roll (docs/design-v1-dice.md 4.3), by anyone, for no creature or
 * for creatures of their own, checked before anything is drawn. The DM may
 * name any creature that exists, on any scene. A player names only one they
 * own now, as for a roll answer: one they cannot see is `gone`, as a missing
 * one is, and one they see and do not own is refused, so no refusal says a
 * hidden creature exists.
 */
function diceRollCheck(c: Check, op: OpOf<"dice.roll">): Decision {
  for (const roll of op.rolls) {
    const creature = roll.creature;
    if (!creature) continue;
    if (c.actor.role === "dm") {
      const exists = "tokenId" in creature ? c.state.tokens[creature.tokenId] !== undefined : c.state.characters[creature.characterId] !== undefined;
      if (!exists) return GONE;
      continue;
    }
    const t = c.target(creature);
    if (!t.visible) return GONE;
    if (!t.owned) return refuse("forbidden", NOT_YOUR_ROLL);
  }
  return OK;
}

/**
 * A DM's undo or redo never puts back a reference to an image that was
 * deleted since (docs/design-v1-dm-tools.md 2.6). Only references the
 * restore adds are checked: one the entity holds now is in use, so it was
 * not deleted. A player's restores touch only drawings and token poses,
 * which add no image.
 */
function restoredAssetsUsable(op: OpOf<"sys.restore">, c: Check): Decision {
  const usable = c.deps.restoredAssetUsable;
  if (!usable) return OK;
  for (const ref of restoreAddedAssets(op.entries, c.state)) {
    if (!usable(ref.assetId, ref.kind)) return refuse("gone", "its image was deleted since");
  }
  return OK;
}

/** The refusal of a DM's ask for saves: the DM starts the group save itself (docs/design-v1-player-save-spell.md 5.4). */
export const DM_RUNS_GROUP_SAVE = "The DM runs a group save directly.";
/** The refusal of a DM's withdrawal: an ask is withdrawn by a player of its caster, and the DM dismisses it instead. */
export const ONLY_ITS_PLAYER_WITHDRAWS = "Only its player withdraws an ask. Dismiss it instead.";
/** The refusal of an outcome or a close for an ask that is gone: resolved on another device, set aside, or withdrawn. */
export const ASK_CLOSED = "The ask was closed meanwhile.";
/** The refusal of an ask naming a damage roll that another open ask names. */
export const ROLL_ASKED_ALREADY = "That roll already went with another ask.";
/** The refusal of a fourth waiting ask, in the block's own words. */
export const ASKS_WAITING = `You have ${LIMITS.castsPerMember} asks waiting. Withdraw one first.`;
/** The refusal of a change to an area its player asked saves for, until the ask closes (5.4). */
export const AREA_ASKED = "Saves asked. Withdraw to change it.";
/** The same refusal where its owner can no longer withdraw the ask: its caster is gone, or passed to another player. */
export const AREA_ASKED_DM = "Saves were asked for this area. The DM can dismiss the ask.";

/**
 * An asked area stays fixed for its owner (5.4), and the refusal says who
 * can free it: the owner by Withdraw while they own the caster, else only
 * the DM's Dismiss, since an ask whose caster is gone or passed on is no
 * longer theirs to withdraw.
 */
function askedAreaRefusal(c: Check, templateId: string): Decision | null {
  const asks = Object.values(c.state.casts).filter((ask) => ask.area === templateId);
  if (asks.length === 0) return null;
  return refuse("forbidden", asks.some((ask) => c.ownsTokenId(ask.caster)) ? AREA_ASKED : AREA_ASKED_DM);
}

/** Whether an open ask for saves names this area, which locks it for its player (docs/design-v1-player-save-spell.md 5.4). */
export function askedArea(state: Pick<RoomState, "casts">, templateId: string): boolean {
  return Object.values(state.casts).some((ask) => ask.area === templateId);
}

/**
 * The member's asks that count against their cap of waiting asks: those
 * they made whose caster exists and they own now. The block counts the
 * same, so its "3 asks waiting" never disagrees with the server.
 */
export function waitingAsks(state: Pick<RoomState, "casts" | "tokens" | "characters">, viewer: Viewer): CastAsk[] {
  return Object.values(state.casts).filter((ask) => {
    if (ask.by !== viewer.memberId) return false;
    const token = state.tokens[ask.caster];
    return token !== undefined && ownsToken(state as RoomState, viewer, token);
  });
}

/**
 * A player's ask for saves (docs/design-v1-player-save-spell.md 5.4): for
 * a creature they see and own on the players' scene, which the ask names,
 * so nothing goes behind a pause. An area is one of theirs that they see
 * there, and each target a token they see there, named once. A hidden
 * caster, area or target answers as a missing one, so a refusal never says
 * a hidden thing is there.
 */
function castAskCheck(c: Check, op: OpOf<"cast.ask">, playerScene: string | null): Decision {
  const input = op.cast;
  if (c.state.casts[input.id]) return GONE;
  const caster = c.visibleToken(input.caster);
  if (!caster || playerScene === null || caster.sceneId !== playerScene || input.sceneId !== playerScene) return GONE;
  if (!ownsToken(c.state, c.actor, caster)) return NOT_YOURS;
  if (input.area !== undefined) {
    const area = c.state.templates[input.area];
    if (!area || area.sceneId !== playerScene || !c.visible(keys.template(input.area))) return GONE;
    if (area.ownerId !== c.actor.memberId) return NOT_YOURS;
  }
  if (input.targets !== undefined) {
    for (const id of input.targets) {
      const target = c.visibleToken(id);
      if (!target || target.sceneId !== playerScene) return GONE;
    }
    if (new Set(input.targets).size !== input.targets.length) return refuse("invalid", "a target is named twice");
  }
  const tag = input.damage?.tag;
  if (tag !== undefined && Object.values(c.state.casts).some((ask) => ask.damage?.tag === tag)) return refuse("invalid", ROLL_ASKED_ALREADY);
  if (waitingAsks(c.state, c.actor).length >= LIMITS.castsPerMember) return refuse("quota", ASKS_WAITING);
  return OK;
}

/** A player's withdrawal, of an ask whose caster they own now. The DM's resolve and dismissal are the DM's alone. */
function castCloseCheck(c: Check, op: OpOf<"cast.close">, playerScene: string | null): Decision {
  const ask = c.state.casts[op.castId];
  // Behind a pause a player holds no ask (shared/project.ts), so none is there to withdraw.
  if (!ask || playerScene === null || !c.ownsTokenId(ask.caster)) return refuse("gone", ASK_CLOSED);
  return op.end === "withdrawn" ? OK : FORBIDDEN;
}

/** Movement (design 8.1): owners, or the players the room lets move any token, and never a locked token. */
function moveCheck(c: Check, tokenId: string): Decision {
  const token = c.visibleToken(tokenId);
  if (!token) return GONE;
  if (token.locked) return refuse("forbidden", "that token is locked");
  if (ownsToken(c.state, c.actor, token)) return OK;
  return movesAnyToken(c.state.meta.settings, c.actor.memberId) ? OK : NOT_YOURS;
}

/** Whether every player sees a token where it stands, as the reducer's seen marks judge (docs/design-v1-attach.md 8.0). */
function seenByAll(c: Check, token: Token): boolean {
  return inSightOfNonOwners(c.state, token, {});
}

/** seenByAll by id, as the attach rules ask it. */
function seenAllIn(c: Check): (t: { id: string }) => boolean {
  return (t) => {
    const token = c.state.tokens[t.id];
    return token !== undefined && seenByAll(c, token);
  };
}

/**
 * Whether the player directs this mount (docs/design-v1-attach.md 6): it
 * carries a creature of theirs by a controlled ride, "it moves on your turn
 * as you direct it", and the DM chose that by marking the ride controlled.
 * A refusal must not read what some player cannot see, so only a rider and
 * a link every player sees count (8.0).
 */
function directsMount(c: Check, mount: Token): boolean {
  if (!seenByAll(c, mount)) return false;
  for (const id of carriedIndex(c.state.tokens).get(mount.id) ?? []) {
    const rider = c.state.tokens[id];
    if (rider?.attached?.kind !== "ride" || rider.attached.steer !== true || !isCreature(rider)) continue;
    if (ownsToken(c.state, c.actor, rider) && seenByAll(c, rider)) return true;
  }
  return false;
}

/**
 * Whether the player may move a token an op names (design 8.1 and
 * docs/design-v1-attach.md 6): by the movement rule, or a controlled mount
 * one of their creatures rides, or, with `to`, a token carried by one they
 * may move whose move keeps its link there, a new seat or a dragged
 * creature still within reach. Its whole group rides along whoever owns the
 * rest. A lock stops a token's own drag, whatever the other rights.
 */
function namedMoveCheck(c: Check, tokenId: string, to?: Pick<Token, "x" | "y"> & { elevation?: number; squeeze?: boolean }): Decision {
  const d = moveCheck(c, tokenId);
  if (d.ok || d.code === "gone") return d;
  const token = c.visibleToken(tokenId)!;
  if (token.locked) return d;
  if (directsMount(c, token)) return OK;
  const holder = holderOf(c.state.tokens, token);
  const link = token.attached;
  if (!to || !link || !holder || !seenByAll(c, token) || !seenByAll(c, holder as Token)) return d;
  if (!moveCheck(c, holder.id).ok && !directsMount(c, holder as Token)) return d;
  const there = { ...token, x: to.x, y: to.y, elevation: to.elevation ?? token.elevation };
  // A token they may not move keeps its height on its holder, or takes the holder's, and a dragged one lands as a walk lands (4.1, 4.3).
  const height = onHolder(link.kind) ? there.elevation === token.elevation || there.elevation === (holder as Token).elevation : landsAt(c.state.buildChunks, token, { ...there, squeeze: to.squeeze === true });
  return height && linkHolds(gridOfToken(c.state, token), c.state.meta.settings, link.kind, there, holder as Token) ? OK : d;
}

/**
 * The walls test of a player's group move (docs/design-v1-attach.md 4.2):
 * besides each named token's own legs, each dragged creature among the
 * public members walks the holder's route offset by its place, piece by
 * piece, on its own ground. A step onto a seat and a get-off leg are walks
 * too, so what the stepping token drags meets the walls as it would on a move. What sits on its holder rides and is not tested,
 * and a dragged creature some player cannot see walks in the private pass,
 * stopping where it must unseen (rules/moveLeg.ts), so no refusal reads it.
 */
function draggedWalls(c: Check, op: Op): Decision {
  const first =
    op.t === "token.move" || op.t === "token.attach" || op.t === "token.detach" ? op.tokenId : op.t === "token.moveMany" ? op.moves[0]?.tokenId : undefined;
  const token = first !== undefined ? c.state.tokens[first] : undefined;
  if (!token || c.state.scenes[token.sceneId]?.blockMovement !== true) return OK;
  if (op.t === "token.move" && op.teleport !== undefined) return OK;
  for (const moved of planMove(op, c.state, c.actor, {})) {
    const member = c.state.tokens[moved.tokenId];
    if (moved.carriedBy === undefined || moved.pass !== "public" || !member || member.attached?.kind !== "drag") continue;
    for (let i = 1; i < moved.route.length; i++) {
      // A creature a holder drags beside it walks as itself, since a drag is no seat: as the move's trace has it (route.ts followerTrace),
      // full size at each point, as it is stored wherever it stops (moveLeg.ts stoppedAtWalls).
      const to = { ...moved.route[i]!, squeeze: false };
      const blocker = movementRules.legBlocker(c.state, moved.trace[i - 1]!, to);
      if (blocker !== null) return refuse("forbidden", walkWords(c, moved.trace[i - 1]!, to, blocker));
    }
  }
  return OK;
}

/** A player's refusals of attaching (docs/design-v1-attach.md 6). */
export const RIDE_ON_YOUR_TURN = "You can get on a mount on your own turn.";

/** The player's name for a token, as their copy shows it. */
function shownName(token: Token): string {
  return token.nameHidden ? (token.publicName ?? "Unknown creature") : token.name;
}

/** Whether the creature holds a Grappled effect players see: the DM's mark is the DM's consent to drag it (question 2). */
function grappledShown(c: Check, token: Token): boolean {
  const actor = "inline" in token.actor ? token.actor.inline : c.state.characters[token.actor.ref]?.actor;
  return actor?.effects.some((e) => e.key === "grappled" && e.hiddenFromPlayers !== true) ?? false;
}

/**
 * Whether a turn is running in the player's copy and its acting row is the
 * creature's own (7.1: mounting is "during your move"). On a row the DM hid
 * from them, it is still their own creature's turn by the rule that sends
 * its owners its path then (project.ts projectPathCtx, review
 * FU20A-RIDEHIDDEN): they learn the turn once it moves anyway, so getting on
 * a mount tells them nothing more. Any other hidden row refuses in the same
 * words as a row they see, so the answer never says whose turn it is.
 * Permissions never run at replay, so this needs no op version.
 */
function ownTurnOr(c: Check, tokenId: string): Decision {
  const encounter = c.visibleEncounter();
  if (!encounter || (encounter.activeEntryId === null && encounter.started !== true)) return OK;
  const entry = encounter.activeEntryId !== null ? c.visibleEntry(encounter.activeEntryId) : undefined;
  if (!entry) return turnUnderWay(c.state.encounter)?.tokenId === tokenId && c.ownsTokenId(tokenId) ? OK : refuse("forbidden", RIDE_ON_YOUR_TURN);
  const token = c.state.tokens[tokenId];
  const ref = token && "ref" in token.actor ? token.actor.ref : undefined;
  const its = entry.tokenId === tokenId || (entry.tokenId === undefined && ref !== undefined && entry.characterId === ref);
  return its ? OK : refuse("forbidden", RIDE_ON_YOUR_TURN);
}

/**
 * A player's attach (docs/design-v1-attach.md 6), on two tokens their copy
 * holds. A ride, a perch or a carry onto a holder needs the right to move
 * both and the two within reach as they stand. A drag needs the right to
 * move the holder, the two within reach, and the right to move the
 * creature too or a Grappled mark players see on it, and a creature
 * carried by a creature always needs that mark. A token already held comes
 * off its holder before anything else holds it. On a scene whose walls stop moves, every attach but a drag
 * steps onto its seat by the leg test, and what the stepping token drags
 * follows that step by the walls test of a group move. A ride during a
 * fight waits for the rider's own turn. The
 * limits and loops are the reducer's, on what every player sees and the two
 * named tokens.
 */
function attachCheck(c: Check, op: OpOf<"token.attach">): Decision {
  const carried = c.visibleToken(op.tokenId);
  const holder = c.visibleToken(op.to);
  if (!carried || !holder) return GONE;
  const settings = c.state.meta.settings;
  // The seat is at the holder's elevation, as the reducer puts it (4.1).
  const seat = { x: op.x, y: op.y, elevation: holder.elevation };
  // A token already held, by a link the player sees, comes off it first, so a rider pays to get off (7.3) and no hold is taken over.
  // Its own holder may change how it holds it, and a ride only to the same ride again, as Controlled toggles.
  const held = carried.attached ? c.visibleToken(carried.attached.to) : undefined;
  if (held && (op.to !== held.id || (carried.attached!.kind === "ride" && op.kind !== "ride"))) return refuse("forbidden", comesOffFirst(carried, held));
  const grapple = op.kind === "drag" || (op.kind === "carry" && isCreature(carried) && isCreature(holder));
  if (grapple) {
    const may = moveCheck(c, holder.id);
    if (!may.ok) return may;
    if (!withinReach(gridOfToken(c.state, carried), settings, carried, holder)) return refuse("forbidden", `${shownName(carried)} is too far to ${op.kind === "drag" ? "drag" : "carry"}`);
    // A creature carried by a creature is a grappled one, as the list offers it (4.1). A drag also takes a creature the player may move.
    const marked = grappledShown(c, carried);
    if (op.kind === "carry" ? !marked : !moveCheck(c, carried.id).ok && !marked) return refuse("forbidden", `${shownName(carried)} is not marked Grappled`);
    // A creature carried by a creature steps onto its seat, which meets the walls as every attach but a drag does (4.1).
    if (op.kind !== "drag") {
      const walls = legCheck(c, carried.id, seat, false);
      if (!walls.ok) return walls;
    }
  } else {
    for (const id of [carried.id, holder.id]) {
      const may = moveCheck(c, id);
      if (!may.ok) return may;
    }
    if (!withinReach(gridOfToken(c.state, carried), settings, carried, holder)) return refuse("forbidden", `${shownName(carried)} is too far from ${shownName(holder)}`);
    const walls = legCheck(c, carried.id, seat, false);
    if (!walls.ok) return walls;
  }
  const dragged = draggedWalls(c, op);
  if (!dragged.ok) return dragged;
  return op.kind === "ride" ? ownTurnOr(c, carried.id) : OK;
}

/** Why a player's attach of a token already held waits for it to come off: in the words of the button that takes it off (4.3). */
function comesOffFirst(carried: Token, holder: Token): string {
  if (carried.attached?.kind === "drag") return `${shownName(holder)} lets go of ${shownName(carried)} first`;
  return isCreature(carried) ? `${shownName(carried)} gets off ${shownName(holder)} first` : `${shownName(holder)} puts down ${shownName(carried)} first`;
}

/**
 * A player's detach (docs/design-v1-attach.md 6): of a link their copy
 * holds, by the right to move the carried token or its holder, and a
 * creature's player can always get off. A link to a holder they cannot see
 * is not in their copy, so it answers as a token attached to nothing does.
 * Getting off is a walk from the seat, which meets the walls.
 */
function detachCheck(c: Check, op: OpOf<"token.detach">): Decision {
  const carried = c.visibleToken(op.tokenId);
  if (!carried) return GONE;
  const holder = carried.attached ? c.visibleToken(carried.attached.to) : undefined;
  if (!holder) return refuse("invalid", `${shownName(carried)} is not attached to anything`);
  if (!ownsToken(c.state, c.actor, carried) && !moveCheck(c, carried.id).ok) {
    const may = moveCheck(c, holder.id);
    if (!may.ok) return may;
  }
  if (op.x === undefined || op.y === undefined) return OK;
  const walls = legCheck(c, carried.id, { x: op.x, y: op.y, ...(op.elevation !== undefined ? { elevation: op.elevation } : {}) }, false);
  return walls.ok ? draggedWalls(c, op) : walls;
}

/**
 * Whether the room lets this player move tokens they do not own (features
 * section 5): every player, or this one among those the DM picked. The
 * canvas asks the same question, so a drag it offers is one the server takes.
 */
export function movesAnyToken(settings: Partial<Pick<RoomSettings, "playersMoveAny">>, memberId: string): boolean {
  const who = settings.playersMoveAny;
  return who === "all" || (Array.isArray(who) && who.includes(memberId));
}

/**
 * The fields a move sets, which a player's undo of a move may put back: its
 * turn's path goes back with the position, and a squeeze with the place it
 * was squeezed in (docs/design-v1-maps-vision.md 4.1).
 */
const POSE_FIELDS = ["x", "y", "elevation", "rotation", "path", "squeeze", "attached", "rev"] as const;

function withoutPose(token: Token, also: readonly string[] = []): string {
  const rest: Record<string, unknown> = { ...token };
  for (const field of [...POSE_FIELDS, ...also]) delete rest[field];
  return stableStringify(rest);
}

/**
 * A player's undo of a token move (design 7.7): the server builds it to
 * put the token back where it stood, with the path it had there, and
 * change nothing else, and only on a token the player may move now. Checked here too, so no restore built
 * another way could let a player rewrite the rest of a token.
 *
 * An undo that leaves the token on its spot changes only its elevation or
 * facing, which an owner may change on a locked token too (owners'
 * token.update, OWNER_TOKEN_FIELDS). Such an undo by an owner takes the
 * owner's rights, so a change they could make they can also take back. A
 * player who moves the token without owning it still needs it unlocked.
 */
function restoreMoveCheck(c: Check, tokenId: string, value: unknown): Decision {
  const current = c.state.tokens[tokenId];
  if (!current) return GONE;
  const token = c.visibleToken(tokenId);
  if (!token) return GONE;
  const restored = value && typeof value === "object" ? (value as Token) : null;
  const inPlace = restored !== null && restored.sceneId === current.sceneId && restored.x === current.x && restored.y === current.y;
  // An undo or a redo takes the right its op took (docs/design-v1-attach.md 6 and 8.3): a move's, a controlled mount's
  // and a new seat's (namedMoveCheck), and a link's own, which its owner may always undo, locked or not, as detachCheck lets them.
  // Only a link the player sees counts, so a hidden steed never changes the answer (8.0).
  const shownTo = (t: Token) => (t.attached && c.visibleToken(t.attached.to) ? t.attached.to : undefined);
  const linkChanges = restored !== null && shownTo(restored) !== shownTo(current);
  const may =
    (inPlace && ownsToken(c.state, c.actor, token)) || viaHolder(c, current, restored) || (linkChanges && ownsToken(c.state, c.actor, token)) ? OK : namedMoveCheck(c, tokenId, restored ?? undefined);
  if (!may.ok) return may;
  if (!restored) return FORBIDDEN;
  return withoutPose(restored) === withoutPose(current) ? OK : refuse("forbidden", "an undo of yours only moves tokens back");
}

/** The tokens a restore writes, with the values it puts back. */
function restoredTokens(op: OpOf<"sys.restore">): Map<string, unknown> {
  const out = new Map<string, unknown>();
  for (const entry of op.entries) if (entry.key.startsWith("token:")) out.set(entry.key.slice("token:".length), entry.value);
  return out;
}

/**
 * The token of the restore a token rides under, before and after it
 * (docs/design-v1-attach.md 8.3): walking up its links now, and up the
 * links the restore puts back, each reaches a token of the same restore
 * the player may move. Its top one names the group, or undefined when the
 * token is not carried so throughout. Such a token rides back as it rode
 * out, and needs no right to move it of its own.
 */
function carriedThroughout(c: Check, tokenId: string, value: unknown, restoring: ReadonlyMap<string, unknown>): string | undefined {
  // Up links the player sees alone, from the first: a hidden holder between never carries a token through (8.0).
  const holderIn = (id: string, v: unknown): string | undefined => {
    const to = v && typeof v === "object" ? (v as Token).attached?.to : undefined;
    return to !== undefined && c.visibleToken(to) && c.state.tokens[to]?.sceneId === c.state.tokens[id]?.sceneId ? to : undefined;
  };
  const linkOf = (id: string, put: boolean): string | undefined => holderIn(id, put && restoring.has(id) ? restoring.get(id) : c.state.tokens[id]);
  const under = (put: boolean): string | undefined => {
    const visited = new Set<string>([tokenId]);
    let found: string | undefined;
    for (let up = put && value && typeof value === "object" ? holderIn(tokenId, value) : linkOf(tokenId, false); up !== undefined && !visited.has(up); up = linkOf(up, put)) {
      visited.add(up);
      if (restoring.has(up) && namedMoveCheck(c, up).ok) found = up;
    }
    return found;
  };
  const now = under(false);
  const then = under(true);
  return now !== undefined && then !== undefined ? now : undefined;
}

/**
 * A passenger's part of a player's undo or redo of a group move
 * (docs/design-v1-attach.md 8.3). One outside the public members (hidden,
 * seen by only some players, or riding a holder players cannot see) takes
 * no check at all, so no refusal ever reads it. A public one must be in the
 * player's copy and change only its pose, and on a redo a dragged one
 * walks its holder's kept routes offset by its place, as the move did.
 */
function restoreCarriedCheck(c: Check, tokenId: string, value: unknown, redo: boolean, holderId: string, routes: readonly (readonly RoutePiece[])[] | undefined, restoring: ReadonlyMap<string, unknown>): Decision {
  const current = c.state.tokens[tokenId];
  const restored = value && typeof value === "object" ? (value as Token) : null;
  if (!current || !restored) return OK;
  const seenAll = (id: string) => {
    const t = c.state.tokens[id];
    return t !== undefined && seenByAll(c, t);
  };
  const chain = (): boolean => {
    const visited = new Set<string>([tokenId]);
    for (let at = tokenId, up = current.attached?.to; up !== undefined && !visited.has(up); at = up, up = c.state.tokens[up]?.attached?.to) {
      visited.add(up);
      if (!seenAll(at) || !seenAll(up)) return false;
      if (restoring.has(up)) return true;
    }
    return false;
  };
  if (!chain()) return OK;
  if (!c.visibleToken(tokenId)) return GONE;
  if (withoutPose(restored) !== withoutPose(current)) return refuse("forbidden", "an undo of yours only moves tokens back");
  if (!redo || current.attached?.kind !== "drag") return OK;
  const holder = c.state.tokens[holderId];
  if (!holder || !routes || routes.length === 0) return legCheck(c, tokenId, restored, false);
  const ox = current.x - holder.x;
  const oy = current.y - holder.y;
  const offset = routes.map((route) => route.map(([x, y, extra, swim]): RoutePiece => [x + ox, y + oy, extra, swim]));
  return routeCheck(c, tokenId, offset, restored);
}

/**
 * Whether a player takes back a link by its holder's right (docs/design-v1-attach.md
 * 6 and 8.3): the token is attached, now or in what the restore puts back,
 * to a holder in their copy that they may move, as a detach of it needs. So
 * undoing a Drag of a goblin the DM marked Grappled is theirs, as the drag was.
 */
function viaHolder(c: Check, current: Token, restored: Token | null): boolean {
  for (const to of [current.attached?.to, restored?.attached?.to]) {
    if (to !== undefined && c.visibleToken(to) && namedMoveCheck(c, to).ok) return true;
  }
  return false;
}

/** The fields a resize sets beside a move's, which a player's undo or redo of a resize may also put back. */
const SIZE_FIELDS = ["size", "w", "h"] as const;

/**
 * A player's undo or redo of a move or a resize (docs/design-v1-token-window.md
 * 8.7), judged two ways by whether it changes the token's size. One that
 * keeps the size is a move's, judged by restoreMoveCheck as before, and its
 * redo meets the walls as a new move would (`redo`, false for a teleport's).
 * One that changes the size needs the rights of a resize now, not when the
 * step was made: the player owns the token, it is unlocked, and neither its
 * size now nor the one put back is Custom. So a token given to another
 * player since refuses it, even where this player may still move any token.
 * Then the footprint put back is judged as a resize to it (resizeRefusal),
 * and nothing but the pose and the size may differ.
 */
function restorePoseCheck(c: Check, tokenId: string, value: unknown, redo: boolean, routes?: readonly (readonly RoutePiece[])[]): Decision {
  const current = c.state.tokens[tokenId];
  const restored = value && typeof value === "object" ? (value as Token) : null;
  if (!current || !restored || SIZE_FIELDS.every((field) => restored[field] === current[field])) {
    const d = restoreMoveCheck(c, tokenId, value);
    if (!d.ok || !redo || !restored) return d;
    // A redo of walks meets the walls along each piece of the routes they took, in order, and never routes again (7.4).
    return routes && routes.length > 0 ? routeCheck(c, tokenId, routes, restored) : legCheck(c, tokenId, restored, false);
  }
  const token = c.visibleToken(tokenId);
  if (!token) return GONE;
  if (!ownsToken(c.state, c.actor, token)) return NOT_YOURS;
  if (token.locked) return refuse("forbidden", "that token is locked");
  if (current.size === "custom" || restored.size === "custom") return refuse("forbidden", OWNER_SIZES);
  if (withoutPose(restored, SIZE_FIELDS) !== withoutPose(current, SIZE_FIELDS)) return refuse("forbidden", "an undo of yours only moves or resizes tokens back");
  const refusal = resizeRefusal(c.state, current, restored);
  return refusal === null ? OK : refuse("forbidden", resizeWords(c, current, restored, refusal));
}

/**
 * A player's resize (docs/design-v1-token-window.md 8.6): a `token.update`
 * whose patch holds `size`, from the owner branch and from
 * companionUpdateCheck, so a companion and any other owned token are judged
 * by one rule. The player owns the token and it is unlocked, as for a move,
 * since a resize can shift it. The patch holds the size and the place
 * alone, one of the six sizes, and a Custom token stays the DM's. Then the
 * spot is judged by rules 4 and 5 (resize.ts resizeRefusal), a place left
 * out of the patch read as the current one. The client runs the same check
 * on its own copy, so a device sends only a spot the server takes, unless
 * its view lacks a wall.
 */
function resizeCheck(c: Check, token: Token, patch: TokenPatch): Decision {
  if (!ownsToken(c.state, c.actor, token)) return NOT_YOURS;
  if (token.locked) return refuse("forbidden", "that token is locked");
  const sizeAndPlace = Object.keys(patch).every((field) => field === "size" || field === "x" || field === "y");
  if (!sizeAndPlace || patch.size === undefined || patch.size === "custom" || token.size === "custom") return refuse("forbidden", OWNER_SIZES);
  const next = { size: patch.size, x: patch.x ?? token.x, y: patch.y ?? token.y };
  const refusal = resizeRefusal(c.state, token, next);
  return refusal === null ? OK : refuse("forbidden", resizeWords(c, token, next, refusal));
}

// What a player hears when a wall or a ledge stops a move, kept with the move rules since a resize says it too.
export { LEDGE_IN_THE_WAY, WALL_IN_THE_WAY };
/** The same, as an undo or redo refusal words them after "could not redo moving Thorn: ", like every restore's reason (MOVE_PLAYERS_FIRST_BACK). */
export const WALL_IN_THE_WAY_BACK = "a wall is in the way";
export const LEDGE_IN_THE_WAY_BACK = "a ledge is in the way";
/** A growth's refusal (rules/resize.ts NO_ROOM_TO_GROW) in the same form, after "could not redo resizing Bear: ". */
export const NO_ROOM_TO_GROW_BACK = "no room to grow here";

/** A restore's refusal in the words that follow its step's label: a wall's, a ledge's or a growth's in its restore form, any other as it is. */
function restoreWords(d: Decision): Decision {
  if (d.ok) return d;
  if (d.message === WALL_IN_THE_WAY) return { ...d, message: WALL_IN_THE_WAY_BACK };
  if (d.message === LEDGE_IN_THE_WAY) return { ...d, message: LEDGE_IN_THE_WAY_BACK };
  if (d.message === NO_ROOM_TO_GROW) return { ...d, message: NO_ROOM_TO_GROW_BACK };
  if (d.message === SOMETHING_BLOCKS) return { ...d, message: SOMETHING_BLOCKS_BACK };
  return d;
}
// ---------------------------------------------------------------------------
// The touch rule (docs/design-v1-map-discovery.md 6, decision 11)

/**
 * What a player hears when what stopped them may lie on ground they do not
 * see now: it names no kind, so a stop or refusal never tells them what
 * stands where their sight and the DM's reveals never reached, or what
 * changed on ground they only remember.
 */
export const SOMETHING_BLOCKS = "Something blocks the way.";
/** The same, as a restore's refusal words it after its step's label. */
export const SOMETHING_BLOCKS_BACK = "something blocks the way";

/*
 * Whether every cell a closed box of half sides (hx, hy) touches, its
 * middle swept from P to Q, lies on live ground, by the scene's own cells,
 * squares or hexes (held.ts convexLive). Touching a cell's side or corner
 * counts, and a hair more than touching too, so rounding only ever gives
 * the generic words. Cells off the scene hold nothing to hide.
 */
function sweepLive(g: Ground, px: number, py: number, qx: number, qy: number, hx: number, hy: number): boolean {
  const box = (x: number, y: number) => [
    { x: x - hx, y: y - hy },
    { x: x + hx, y: y - hy },
    { x: x + hx, y: y + hy },
    { x: x - hx, y: y + hy },
  ];
  return convexLive(g, convexHull([...box(px, py), ...box(qx, qy)]));
}

/** Whether a footprint standing where it stands, closed, so with the sides and corners of the cells beside it, lies on live ground: a stopping step's test. */
function footprintLive(g: Ground, token: FootprintToken & Point): boolean {
  if (isHex(g.grid)) {
    // A hex's sides and corners touch only its neighbors.
    const grid = g.grid as HexGrid;
    const hexes = occupiedHexes(grid, token);
    return [...hexes, ...hexes.flatMap((h) => hexNeighbors(grid, h))].every((h) => !hexInScene(grid, g.bounds, h) || g.keyLive(hexKey(h)));
  }
  const { w, h } = footprintSize(token);
  const c = storedCenter(token);
  return sweepLive(g, c.x, c.y, c.x, c.y, w / 2, h / 2);
}

/**
 * Whether every cell a footprint covers lies on live ground: where the
 * sender's device reads what the op meets as it is, so a refusal there
 * stays in place (6). The cells beside it count only for the words. On
 * hexes, the hexes it stands on (footprint.ts occupiedHexes).
 */
function coverLive(g: Ground, token: FootprintToken & Point): boolean {
  if (isHex(g.grid)) {
    const grid = g.grid as HexGrid;
    return occupiedHexes(grid, token).every((h) => !hexInScene(grid, g.bounds, h) || g.keyLive(hexKey(h)));
  }
  const { w, h } = footprintSize(token);
  const E = 1e-9;
  // Only the cells inside the scene, so a footprint asked for far off it costs no more than the scene (MD2-ASTRA-7).
  for (let y = Math.max(0, Math.floor(token.y + E)); y < Math.min(g.bounds.h, Math.ceil(token.y + h - E)); y++) {
    for (let x = Math.max(0, Math.floor(token.x + E)); x < Math.min(g.bounds.w, Math.ceil(token.x + w - E)); x++) if (!g.live(x, y)) return false;
  }
  return true;
}

/**
 * A stopped leg's stopping step (decision 11): from its last clear spot, by
 * the rule a walk's landing finds it (movement.ts landing), to the next spot
 * along the leg. Null when nothing stops the leg.
 */
function stoppingStep(state: RoomState, walker: Walker, to: LegEnd): { from: Point; to: Point } | null {
  const allowed = (at: Point) => legStop(state, walker, { x: at.x, y: at.y, elevation: to.elevation }) === null;
  if (allowed(to)) return null;
  const scene = state.scenes[walker.sceneId];
  const g = scene ? sceneGrid(scene) : SQUARES;
  if (isHex(g)) return hexStoppingStep(state, g, walker, to);
  const from = lastClearSpot(walker, to, allowed);
  const spots = legSpots(walker, to);
  const i = spots.findIndex((s) => s.x === from.x && s.y === from.y);
  return { from, to: spots[i + 1] ?? { x: to.x, y: to.y } };
}

/**
 * The stopping step on hexes (LP24-A-HEXFIGHT-3): a walk there lands on
 * the stands of its hex line (movement.ts hexLanding), which the square
 * lattice's spots do not follow, so the step runs from the stand `landing`
 * gives to the next stand of that line. A stand may be squeezed or full at
 * the same hex, so it is found by its reference hex.
 */
function hexStoppingStep(state: RoomState, g: HexGrid, walker: Walker, to: LegEnd): { from: Point; to: Point } {
  const from = landing(state, walker, to, "walk");
  const spots = hexLegSpots(g, walker, to);
  const ref = (at: Point, squeezed: boolean) => hexKey(hexStandAt(g, walker, at, squeezed).ref);
  const i = spots.findIndex((s) => ref(s.at, s.squeeze) === ref(from, from.squeeze));
  return { from: { x: from.x, y: from.y }, to: (i < 0 ? undefined : spots[i + 1]?.at) ?? { x: to.x, y: to.y } };
}

/**
 * The words of a stopped walk (decision 11, D-261027-04): today's, naming
 * what the straight step from the last clear spot meets, only where the
 * part of it the walker's core meets lies on the sender's live ground
 * (held.ts partLive): a wall or a door beside a live cell or through one,
 * a ledge only between two live cells. So a stop at a door the player sees
 * names the door whatever lies unseen behind it: the landing shows where
 * it is and the player sees it, so the words tell nothing new. Anywhere
 * else the generic words, remembered ground included, since a remembered
 * wall may be gone and an unseen one may stand there. A ledge needs both
 * sides, since a raised edge beside an unseen cell tells that cell's
 * height. A step that only a shifted path passes, or one that meets
 * nothing on its own, names none.
 */
function walkWords(c: Check, walker: Walker, to: LegEnd, blocker: Blocker): string {
  return stopWords(c.state, c.liveGround(walker.sceneId), walker, to, blocker);
}

/**
 * `walkWords` on a given live ground: the server's for the sender, or a
 * player's device's own (rules/held.ts deviceGround), which predicts the
 * words of its own stops by the same rule (6, the words). Null ground
 * gives today's words, named by `blocker`.
 */
export function stopWords(state: RoomState, ground: Ground | null, walker: Walker, to: LegEnd, blocker: Blocker): string {
  if (!ground) return blocker === "wall" ? WALL_IN_THE_WAY : LEDGE_IN_THE_WAY;
  const step = stoppingStep(state, walker, to);
  if (!step) return SOMETHING_BLOCKS;
  const chunks = state.buildChunks;
  const at = step.from.x === walker.x && step.from.y === walker.y ? walker : walkOn(chunks, walkFrom(chunks, walker), step.from);
  const end = { x: step.to.x, y: step.to.y, elevation: to.elevation };
  if (straightClear(state, at, end)) return SOMETHING_BLOCKS;
  const met = legStopPart(state, at, end);
  if (!met?.part) return SOMETHING_BLOCKS;
  const ledge = met.stop.blocker === "ledge";
  if (!partLive(ground, met.part, ledge, met.stop.door ? doorMatchesLive(state, ground, met.stop.door) : undefined)) return SOMETHING_BLOCKS;
  return ledge ? LEDGE_IN_THE_WAY : WALL_IN_THE_WAY;
}

/** The door shown whole must match the live blocker before it can borrow a neighboring cell's sight. Non-door pieces still read their met cell. */
function doorMatchesLive(state: RoomState, ground: Ground, door: DoorRef): ((x: number, y: number) => boolean) | undefined {
  if ("edge" in door) return undefined;
  const key = chunkKey(ground.sceneId, door.cx, door.cy);
  const wall = state.buildChunks[key]?.walls?.find((w) => w.id === door.id);
  if (!wall) return undefined;
  const shown = shownFreeWall(wall);
  const live = stableStringify(shown);
  const held = heldFreeDoor(state, ground, door);
  if (held || shown.f.kind === "door") {
    const matches = held !== null && stableStringify(held) === live;
    return () => matches;
  }
  return (x, y) => {
    const memory = ground.holder !== null && ground.own(x, y) ? state.memoryBy?.[holderChunkKey(ground.sceneId, ground.holder, door.cx, door.cy)] : state.memory?.[key];
    const version = memory?.walls?.[door.id]?.find((v) => v.cells.includes(`${x},${y}`));
    return version === undefined || stableStringify(version.wall) === live;
  };
}

/**
 * A companion's placement refused in place (6): the step from its
 * character's token in today's rule where its footprint lies on live
 * ground, which the form predicts, else the generic words, since the
 * touch rule lands it elsewhere when anything fits (touchLanding).
 */
function companionStopWords(c: Check, input: TokenInput, beside: Token, blocker: Blocker): string {
  const ground = c.liveGround(input.sceneId);
  if (!ground) return blocker === "ledge" ? LEDGE_IN_THE_WAY : WALL_IN_THE_WAY;
  if (!coverLive(ground, inputAsToken(input))) return SOMETHING_BLOCKS;
  const walker = ownWalk({ ...inputAsToken(input), x: beside.x, y: beside.y, elevation: beside.elevation });
  return walkWords(c, walker, { x: input.x, y: input.y, elevation: input.elevation ?? beside.elevation }, blocker);
}

/** A resize refused by the walls (6): its new footprint is the stopping step, so off live ground it names no kind and no room. */
function resizeWords(c: Check, token: Token, next: { size: Token["size"]; x: number; y: number; w?: number; h?: number }, refusal: string): string {
  if (refusal !== WALL_IN_THE_WAY && refusal !== LEDGE_IN_THE_WAY && refusal !== NO_ROOM_TO_GROW) return refusal;
  const ground = c.liveGround(token.sceneId);
  if (!ground) return refusal;
  const { squeeze: _squeeze, ...rest } = token;
  return footprintLive(ground, { ...rest, size: next.size, x: next.x, y: next.y, ...(next.w !== undefined ? { w: next.w } : {}), ...(next.h !== undefined ? { h: next.h } : {}) }) ? refusal : SOMETHING_BLOCKS;
}

/** The refusals the touch rule may land instead (touchLanding). Any other refusal of the op stands. */
const TOUCH_REFUSALS: ReadonlySet<string> = new Set([WALL_IN_THE_WAY, LEDGE_IN_THE_WAY, SOMETHING_BLOCKS, NOT_A_SQUEEZE, NO_ROOM_TO_GROW]);

/** A player's op the touch rule lands, as the server stores it in place of the one sent, and the words of what stopped it. */
export type TouchLanding = { op: Op; words: string };

/**
 * The touch rule's landing (docs/design-v1-map-discovery.md 6, decision 11,
 * MD-R9-1): a player's op on a scene with fog on, squares or hexes, that
 * the real build stops, landed instead of refused, so no spot can be probed
 * for free by a refusal in place. The server asks it of every player op before the
 * permission check (server/rooms/actor.ts) and on an answer stores and
 * applies its op, which `canApply` takes, and tells the sender the walk was
 * `blocked`. Null leaves the op to `canApply`: it passes, it is refused for
 * a reason the walls do not give, or nothing fits.
 * - A walk, plain, routed, an arrow's step or a holder's with those it
 *   drags, whatever the held build said, lands at its last clear spot by
 *   `landing`'s rule, on the first piece the walls stop, its route kept up
 *   to there. Where that spot is not one the check takes (a creature it
 *   drags stopped, a squeeze), the walk is cut back further, to the last
 *   spot along it that the check takes, the start at the least.
 * - A squeeze the walk reaches but the spot does not take lands unsqueezed
 *   there, unless the sender sees the whole footprint there, which their
 *   device then predicts, so it is refused in place.
 * - A group's stopped legs each land at their last clear spot.
 * - A resize whose new footprint does not lie on live ground takes the
 *   nearest spot its own search would try that fits.
 * - A companion placed off live ground goes to the nearest spot the
 *   placement takes.
 * The words are the stopping step's (walkWords), or the generic words for
 * a landing found by the check alone.
 */
export function touchLanding(op: Op, actor: Viewer, state: RoomState, deps: PermissionDeps): TouchLanding | null {
  if (actor.role === "dm") return null;
  const first = canApply(op, actor, state, deps);
  if (first.ok || !TOUCH_REFUSALS.has(first.message)) return null;
  const c = new Check(state, actor, deps);
  const takes = (o: Op) => canApply(o, actor, state, deps).ok;
  switch (op.t) {
    case "token.move":
      return moveLanding(c, op, takes);
    case "token.moveMany":
      return groupLanding(c, op, takes);
    case "token.update":
      return resizeLanding(c, op, takes);
    case "token.create":
      return companionLanding(c, op, takes);
    default:
      return null;
  }
}

/** The token a touch landing moves, its scene's live ground, and its walker, where the rule lands its walks. */
function walkingOn(c: Check, tokenId: string, to: Point): { token: Token; ground: Ground; walker: Token & Walker } | null {
  const token = c.state.tokens[tokenId];
  const scene = token ? c.state.scenes[token.sceneId] : undefined;
  const ground = token ? c.liveGround(token.sceneId) : null;
  if (!token || !scene || !ground || scene.blockMovement !== true) return null;
  return { token, ground, walker: walkerFor(c.state, token, seenAllIn(c), { to }) };
}

/** The height a walk takes at a spot it is cut at: its own there (movement.ts walkOn), as a route's corner has it. */
function cutHeight(c: Check, walking: Walker, at: Point): number {
  const chunks = c.state.buildChunks;
  return walkOn(chunks, walkFrom(chunks, walking), at).elevation;
}

/** A move cut to a spot: the route's pieces before `piece`, then one to the spot, and the spot's height where it is not the token's. */
function cutMove(op: OpOf<"token.move">, token: Token, at: Point, piece: number, elevation: number, squeeze: boolean): OpOf<"token.move"> {
  const { route, squeeze: _squeeze, elevation: _elevation, ...rest } = op;
  const out: OpOf<"token.move"> = { ...rest, x: at.x, y: at.y };
  if (elevation !== token.elevation) out.elevation = elevation;
  if (squeeze) out.squeeze = true;
  if (route) {
    const start = piece === 0 ? { x: token.x, y: token.y } : { x: route[piece - 1]![0], y: route[piece - 1]![1] };
    const kept = route.slice(0, piece);
    const cut = start.x === at.x && start.y === at.y ? kept : [...kept, [at.x, at.y, route[piece]![2], route[piece]![3]] as [number, number, number, 0 | 1]];
    if (cut.length > 0) out.route = cut;
  }
  return out;
}

/* `squeeze: false` for a mover of a group, which carries no squeeze: the search then goes back to the last spot it takes unsqueezed. */
function moveLanding(c: Check, op: OpOf<"token.move">, takes: (o: Op) => boolean, opts: { squeeze: boolean } = { squeeze: true }): TouchLanding | null {
  if (op.teleport !== undefined) return null;
  const on = walkingOn(c, op.tokenId, op);
  if (!on) return null;
  const { token, ground, walker } = on;
  const elevation = op.elevation ?? token.elevation;
  if (op.squeeze) {
    const { squeeze: _squeeze, ...plain } = op;
    if (takes(plain)) {
      const { squeeze: _s, ...full } = token;
      return coverLive(ground, { ...full, x: op.x, y: op.y }) ? null : { op: plain, words: SOMETHING_BLOCKS };
    }
  }
  // The walk's pieces, each from its walker where it starts: a plain move is one piece.
  const pieces: { from: Walker; to: LegEnd }[] = [];
  if (op.route) {
    const walkers = routeWalkers(c.state.buildChunks, walker, op.route, elevation);
    for (let i = 1; i < walkers.length; i++) pieces.push({ from: walkers[i - 1]!, to: { x: walkers[i]!.x, y: walkers[i]!.y, elevation: walkers[i]!.elevation } });
  } else pieces.push({ from: walker, to: { x: op.x, y: op.y, elevation } });
  const stopped = op.route ? routeStop(c.state, walker, op.route, elevation) : null;
  const j = op.route ? (stopped?.piece ?? -1) : movementRules.legBlocker(c.state, walker, pieces[0]!.to) !== null ? 0 : -1;
  if (j >= 0) {
    const piece = pieces[j]!;
    const land = landing(c.state, piece.from, piece.to, "walk");
    const at = { x: land.x, y: land.y };
    const words = land.stopped ? walkWords(c, piece.from, piece.to, land.stopped.blocker) : SOMETHING_BLOCKS;
    const height = op.route ? (land.x === piece.to.x && land.y === piece.to.y ? piece.to.elevation : cutHeight(c, piece.from, at)) : land.stopped ? cutHeight(c, walker, at) : elevation;
    // Unsqueezed at a spot the walk reaches only squeezed is no landing for a mover that cannot squeeze: it goes back further.
    const tries = land.squeeze ? (!opts.squeeze ? [] : j === 0 || !op.route ? [true, false] : [false]) : [false];
    for (const squeeze of tries) {
      const cut = cutMove(op, token, at, j, height, squeeze);
      if (takes(cut)) return { op: cut, words };
    }
  }
  // Cut back along the whole walk to the last spot the check takes, by gallop and bisection as `landing` steps a leg.
  const spots: { piece: number; at: Point; from: Walker; squeeze?: boolean }[] = [{ piece: 0, at: { x: token.x, y: token.y }, from: walker }];
  const hexGrid = sceneGrid(c.state.scenes[token.sceneId]!);
  for (const [i, piece] of pieces.entries()) {
    if (isHex(hexGrid)) {
      // On hexes each spot is a stand of the leg's hex line, squeezed where the leg walks squeezed (movement.ts hexLegSpots).
      for (const spot of hexLegSpots(hexGrid, piece.from, piece.to).slice(1)) spots.push({ piece: i, at: spot.at, from: piece.from, squeeze: spot.squeeze });
    } else if (op.route) {
      const steps = legSteps(piece.from, piece.to, routeLattice(token));
      for (let k = 1; k <= steps.n; k++) spots.push({ piece: i, at: steps.at(k), from: piece.from });
    } else for (const at of legSpots(piece.from, piece.to).slice(1)) spots.push({ piece: i, at, from: piece.from });
  }
  const candidate = (k: number): OpOf<"token.move"> => {
    const s = spots[k]!;
    return cutMove(op, token, s.at, s.piece, cutHeight(c, s.from, s.at), s.squeeze === true);
  };
  const last = lastTaken(spots.length - 1, (k) => takes(candidate(k)));
  return last === null ? null : { op: candidate(last), words: SOMETHING_BLOCKS };
}

/*
 * The last index in 0 to n - 1 whose candidate the check takes, assuming
 * those it takes come first: gallop, then bisect, then step back from there
 * should a later one still be refused. Null when none is taken.
 */
function lastTaken(n: number, taken: (k: number) => boolean): number | null {
  if (n <= 0) return null;
  let lo = -1;
  let hi = n;
  for (let probe = 0; probe < hi; probe = probe === 0 ? 1 : probe * 2) {
    if (taken(probe)) lo = probe;
    else {
      hi = probe;
      break;
    }
  }
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (taken(mid)) lo = mid;
    else hi = mid;
  }
  return lo >= 0 ? lo : null;
}

/*
 * A group lands each named move by the single move's rule (moveLanding):
 * a move the walls refuse alone, its own leg or a creature it drags, is cut
 * back to the last spot the check takes for it, and the group is then
 * checked whole. So a dragged follower's unseen wall never refuses the
 * group in place (MD2-ASTRA-4). A group carries no squeeze, so a mover
 * whose own landing would squeeze goes back to the last spot it takes
 * unsqueezed (MD2-ASTRA-8, MD2-LK-9). Words are the first landed move's.
 */
function groupLanding(c: Check, op: OpOf<"token.moveMany">, takes: (o: Op) => boolean): TouchLanding | null {
  let words: string | null = null;
  const moves = op.moves.map((move) => {
    const single: OpOf<"token.move"> = { t: "token.move", ...move };
    const alone = canApply(single, c.actor, c.state, c.deps);
    if (alone.ok || !TOUCH_REFUSALS.has(alone.message)) return move;
    const landed = moveLanding(c, single, takes, { squeeze: false });
    if (!landed || landed.op.t !== "token.move") return move;
    words ??= landed.words;
    const { elevation: _elevation, ...rest } = move;
    return { ...rest, x: landed.op.x, y: landed.op.y, ...(landed.op.elevation !== undefined ? { elevation: landed.op.elevation } : {}) };
  });
  if (words === null) return null;
  const cut: OpOf<"token.moveMany"> = { ...op, moves };
  return takes(cut) ? { op: cut, words } : null;
}

function resizeLanding(c: Check, op: OpOf<"token.update">, takes: (o: Op) => boolean): TouchLanding | null {
  const size = op.patch.size;
  const token = c.state.tokens[op.tokenId];
  const ground = token ? c.liveGround(token.sceneId) : null;
  if (size === undefined || !token || !ground) return null;
  const x = op.patch.x ?? token.x;
  const y = op.patch.y ?? token.y;
  const { squeeze: _squeeze, ...rest } = token;
  if (coverLive(ground, { ...rest, size, x, y })) return null;
  // The spots a resize may take, in its own search's order (rules/resize.ts resizeCandidates): a half-cell shift is no spot of a size on whole cells.
  const scene = c.state.scenes[token.sceneId]!;
  for (const at of resizeCandidates(token, { size }, scene)) {
    if (at.x === x && at.y === y) continue;
    const shifted: OpOf<"token.update"> = { ...op, patch: { ...op.patch, x: at.x, y: at.y } };
    if (takes(shifted)) return { op: shifted, words: SOMETHING_BLOCKS };
  }
  return null;
}

/** How far from the spot asked a companion's landing looks, in cells: past a Gargantuan creature's reach of its character. */
const COMPANION_LANDING_REACH = 6;

function companionLanding(c: Check, op: OpOf<"token.create">, takes: (o: Op) => boolean): TouchLanding | null {
  const input = op.token;
  const ground = input.companion ? c.liveGround(input.sceneId) : null;
  if (!ground || coverLive(ground, inputAsToken(input))) return null;
  const step = snapStep(inputAsToken(input));
  const spots: Point[] = [];
  const n = Math.round(COMPANION_LANDING_REACH / step);
  for (let j = -n; j <= n; j++) for (let i = -n; i <= n; i++) if (i !== 0 || j !== 0) spots.push({ x: input.x + i * step, y: input.y + j * step });
  // Nearest first, then by row and column, so the landing never depends on the order anything was stored in.
  spots.sort((a, b) => (a.x - input.x) ** 2 + (a.y - input.y) ** 2 - ((b.x - input.x) ** 2 + (b.y - input.y) ** 2) || a.y - b.y || a.x - b.x);
  // Clear of the creatures the sender sees, as the form's spot finder keeps it (client/features/tokens/companions.ts), and never of one they do not.
  const fp = footprintSize(inputAsToken(input));
  const seen = Object.values(c.state.tokens).filter((t) => t.sceneId === input.sceneId && c.visibleToken(t.id) !== undefined);
  const clear = (at: Point) =>
    seen.every((t) => {
      const o = footprintSize(t);
      return at.x + fp.w <= t.x || t.x + o.w <= at.x || at.y + fp.h <= t.y || t.y + o.h <= at.y;
    });
  // Only spots within the companion's reach of a token of its character can be taken, so the check runs on those alone,
  // and on at most COMPANION_LANDING_TRIES of them, so one crafted op costs a bounded number of checks (MD2-O-12).
  const settings = c.state.meta.settings;
  const scene = c.state.scenes[input.sceneId];
  const ref = input.companion?.of;
  const own = Object.values(c.state.tokens).filter((t) => t.sceneId === input.sceneId && "ref" in t.actor && t.actor.ref === ref);
  let tries = 0;
  for (const at of spots) {
    if (!clear(at) || !scene) continue;
    const placed = { ...input, x: at.x, y: at.y, elevation: input.elevation ?? 0 };
    if (!own.some((t) => withinCompanionReach(settings, sceneGrid(scene), placed, t))) continue;
    if (++tries > COMPANION_LANDING_TRIES) break;
    const moved: OpOf<"token.create"> = { ...op, token: { ...input, x: at.x, y: at.y } };
    if (takes(moved)) return { op: moved, words: SOMETHING_BLOCKS };
  }
  return null;
}

/** The most spots a companion's landing asks the check of: every spot within a Gargantuan character's reach on a half-cell grid, and to spare. */
const COMPANION_LANDING_TRIES = 160;

/** A teleport lands on the map, wherever the walls are (section 4.1). */
export const TELEPORT_OFF_MAP = "a teleport lands inside the map";

/**
 * Walls, doors and ledges stop a player's move on a scene that blocks
 * movement (docs/design-v1-maps-vision.md 4.1). A permission rule, never a
 * reducer one, so stored moves replay as they were made. A teleport skips
 * the test and nothing else: the player still needs the right to move the
 * token, and it lands inside the scene.
 *
 * The test itself is part 4B's (shared/rules/movement.ts, through
 * shared/ruleHooks.ts). It reads the stored segments as players see them,
 * a secret door not yet found as a wall, so the server and a phone dragging
 * the token always agree.
 */
function legCheck(c: Check, tokenId: string, to: StoredEnd, teleport: boolean): Decision {
  const token = c.state.tokens[tokenId];
  const scene = token ? c.state.scenes[token.sceneId] : undefined;
  if (!token || !scene) return OK;
  const end = legEndOf(scene, to, token.elevation);
  if (teleport) return insideScene(scene, token, end) ? OK : refuse("forbidden", TELEPORT_OFF_MAP);
  if (scene.blockMovement !== true) return OK;
  // Off a holder on the ground it walks on the ground, crossing only the holder's inner ledges, as its route and the drag's own check do (rules/attach.ts walkerFor).
  const walker = walkerFor(c.state, token, seenAllIn(c));
  // A token rising or sinking where it stands crosses no edge.
  if (end.x === token.x && end.y === token.y && !squeezeChangesInPlace(scene, walker, end)) return OK;
  const blocker = movementRules.legBlocker(c.state, walker, end);
  if (blocker === null) return OK;
  return refuse("forbidden", walkWords(c, walker, end, blocker));
}

/**
 * A player's walk along routes on a scene that blocks movement
 * (docs/design-v1-movement.md 7.1, 7.4): today's leg test, shifts and all,
 * on each piece, from the token where the piece starts with the walk's own
 * elevation there. The first piece stopped refuses the move in today's
 * words. A redo's routes run one after another from where the token stands
 * now, each ending where its move landed. When they end anywhere but where
 * the redo puts the token, the last stretch is a straight leg, as a redo
 * of plain moves is.
 */
function routeCheck(c: Check, tokenId: string, routes: readonly (readonly RoutePiece[])[], to: StoredEnd): Decision {
  const token = c.state.tokens[tokenId];
  const scene = token ? c.state.scenes[token.sceneId] : undefined;
  if (!token || !scene || scene.blockMovement !== true) return OK;
  // Off a holder on the ground it walks on the ground, crossing only the holder's inner ledges until clear of it, as the drag searched it (rules/attach.ts walkerFor).
  let at: Token & Walker = walkerFor(c.state, token, seenAllIn(c));
  for (const [n, route] of routes.entries()) {
    const last = n === routes.length - 1;
    const end = route[route.length - 1];
    // A route that ends where the step does lands at its height. Any other ends at the walk's own height there (movement.ts walkOn).
    const landing = last && end && end[0] === to.x && end[1] === to.y ? (to.elevation ?? at.elevation) : undefined;
    const walkers = routeWalkers(c.state.buildChunks, at, route, landing);
    // Each piece from where it starts, squeezed only where the walk starts: the client checks its routes by this same rule before it sends them.
    const stop = routeStop(c.state, at, route, walkers[walkers.length - 1]!.elevation, (state, from, to) => movementRules.legBlocker(state, from, to));
    if (stop !== null) return refuse("forbidden", walkWords(c, walkers[stop.piece]!, walkers[stop.piece + 1]!, stop.blocker));
    // The next route goes on from its end as the walk left it (movement.ts walkOn): off the holder for good once any stop was clear of it, squeezed no more.
    at = walkers[walkers.length - 1]!;
  }
  const end = legEndOf(scene, to, at.elevation);
  if (at.x === to.x && at.y === to.y && !squeezeChangesInPlace(scene, at, end)) return OK;
  const blocker = movementRules.legBlocker(c.state, at, end);
  return blocker === null ? OK : refuse("forbidden", walkWords(c, at, end, blocker));
}

/** Where a move, an attach or a restore puts a token, with the squeeze it stores there (absent for none). */
type StoredEnd = Pick<Token, "x" | "y"> & { elevation?: number; squeeze?: boolean };

/**
 * A leg's end as the token is stored there. On hexes it carries the stored
 * squeeze (LegEnd), so the leg's end stands on the hexes the token will
 * take: a group's mover, a seat, a getting off and a restore without the
 * flag stand full size wherever they lie (review H2-OPUS-05). On squares
 * the core decides where a creature stands, so the end is as before.
 */
function legEndOf(scene: Scene, to: StoredEnd, elevation: number): LegEnd {
  const end: LegEnd = { x: to.x, y: to.y, elevation: to.elevation ?? elevation };
  if (isHex(sceneGrid(scene))) end.squeeze = to.squeeze === true;
  return end;
}

/**
 * Whether a move to the walker's own spot takes or leaves a squeeze there
 * on hexes, which changes the hexes it stands on, so the leg is judged:
 * standing up where the full footprint does not fit is stopped. On squares
 * a squeeze never changes the core the move rules read.
 */
function squeezeChangesInPlace(scene: Scene, walker: Walker, end: LegEnd): boolean {
  const g = sceneGrid(scene);
  return isHex(g) && hexStartStand(g, walker).squeezed !== hexStandAt(g, walker, end, end.squeeze === true).squeezed;
}

/** The refusal of a walk on hexes whose end is not the stand its squeeze names (`hexStopAgrees`). */
export const HEX_STOP_OFF = "a walk on hexes ends on its own hexes, or squeezed on a squeeze's";

/**
 * A player's walk on a hex scene that stops moves ends where its squeeze
 * says it stands: on an anchor of the creature's size without `squeeze`,
 * of the size one smaller with it. A route's stops read their squeeze by
 * where they stand (movement.ts HexStand), so this keeps a walk's op in
 * the shape its route and the drag that sent it have. The walls themselves
 * are met by the stored squeeze (`legEndOf`), a squeeze taken or left in
 * place included. A teleport walks no leg.
 */
function hexStopAgrees(c: Check, op: OpOf<"token.move">): Decision {
  const token = c.state.tokens[op.tokenId];
  const scene = token ? c.state.scenes[token.sceneId] : undefined;
  if (!token || !scene || scene.blockMovement !== true || op.teleport !== undefined) return OK;
  const g = sceneGrid(scene);
  if (!isHex(g) || (op.x === token.x && op.y === token.y)) return OK;
  const placed = hexStandPlace(g, token, hexStandAt(g, token, op, op.squeeze === true));
  return Math.abs(placed.x - op.x) < 1e-6 && Math.abs(placed.y - op.y) < 1e-6 ? OK : refuse("invalid", HEX_STOP_OFF);
}

/** Whether a footprint at `at` lies inside the scene: its box on squares, and on hexes every hex it stands on (docs/design-v1-hex-grids.md 4.2). */
function insideScene(scene: Scene, token: Pick<Token, "size" | "w" | "h">, at: Point): boolean {
  const grid = sceneGrid(scene);
  if (isHex(grid)) return occupiedHexes(grid, { ...token, x: at.x, y: at.y }).every((h) => hexInScene(grid, scene.bounds, h));
  const fp = footprintSize({ ...token, x: at.x, y: at.y });
  return at.x >= 0 && at.y >= 0 && at.x + fp.w <= scene.bounds.w && at.y + fp.h <= scene.bounds.h;
}

/** A player's refusals at a door (docs/design-v1-maps-vision.md 4.1), the way players learn about locks. */
export const DOOR_LOCKED = "It's locked.";
export const DOOR_TOO_FAR = "Too far from the door.";
export const DOOR_DM_ONLY = "only the DM locks doors and marks secret doors";
/** A player's open names who opens the door, so its door traps know whom they catch (docs/design-v1-traps.md 5.3). */
export const CHOOSE_OPENER = "Choose who opens the door.";
/**
 * How far a token reaches a door, by the room's own distance rule: 5 ft, or
 * one cell where a cell is wider, so a creature beside the door always
 * reaches it (decided 2026-10-14).
 */
export function doorReachFt(feetPerCell: number): number {
  return Math.max(5, feetPerCell);
}

/**
 * A player may open or close a door, never lock it or mark it found, and
 * only one their own projection shows as a door: anything else, a secret
 * door not yet found included, is not there. A locked door says so, and the
 * door must be within reach of a token of their own on the scene.
 *
 * On a scene with fog on the door is judged first as the player's copy
 * shows it, memory's where they remember one (docs/design-v1-map-discovery.md
 * 6), and reach from there, so while reach fails the answer is the one a
 * real door there would give. Once reach passes, a door gone from the build
 * or moved since they saw it is gone, without reading a stored wall that is
 * no longer there (doorPlace). A door already as asked is taken, as any
 * open of an open door is, so the sender then sees it as it is.
 */
function doorCheck(c: Check, op: OpOf<"door.set">): Decision {
  if (op.state === "locked" || op.found !== undefined) return refuse("forbidden", DOOR_DM_ONLY);
  const shown = shownDoorChunk(c, op);
  if (!shown) return GONE;
  // Reach comes before the lock: a player learns a door is locked by trying it, so a door out of reach answers the same
  // whether it is locked or not, and no request can list the locks across the scene. An open names its opener, a token
  // of theirs that reaches the door (docs/design-v1-traps.md 5.3), and a close any token of theirs that does.
  if (op.state === "open") {
    const by = op.by !== undefined ? c.visibleToken(op.by) : null;
    if (!by || by.sceneId !== op.sceneId || !ownsToken(c.state, c.actor, by)) return refuse("invalid", CHOOSE_OPENER);
    if (!reachesDoor(c.state, by, op.door, shown)) return refuse("forbidden", reachWords(c, [by], op.door, shown));
  } else {
    const own = Object.values(c.state.tokens).filter((token) => token.sceneId === op.sceneId && ownsToken(c.state, c.actor, token));
    if (!own.some((token) => reachesDoor(c.state, token, op.door, shown))) return refuse("forbidden", reachWords(c, own, op.door, shown));
  }
  const { cx, cy } = doorChunk(op.door);
  const stored = c.state.buildChunks[chunkKey(op.sceneId, cx, cy)];
  const real = stored ? doorIn(stored, op.door) : null;
  // A door the DM hid again since the sender saw it found is a wall to players, as their projection shows it once seen (MD2-O-2).
  if (!stored || !real || (real.secret && !real.discovered) || !samePlace(shown, stored, op.door)) return GONE;
  // The lock is read from the stored door, since players get a locked door as closed.
  if (real.state === "locked") return refuse("forbidden", DOOR_LOCKED);
  return OK;
}

/** The chunk a player's copy holds the door in, when it shows a door there: memory's where they remember one. */
function shownDoorChunk(c: Check, op: OpOf<"door.set">): BuildChunk | null {
  const { cx, cy } = doorChunk(op.door);
  const shown = projectEntity(keys.chunk(op.sceneId, cx, cy), c.state, c.actor, c.opts) as BuildChunk | null;
  return shown && doorIn(shown, op.door) ? shown : null;
}

/**
 * Whether a player's `door.set` reached the door their copy shows
 * (docs/design-v1-map-discovery.md 5.3, doors touched): the server drops
 * that door's memory in every layer the sender reads when the op is taken,
 * or refused as gone once reach passed, so they then see it as it is.
 */
export function doorReachPassed(op: OpOf<"door.set">, actor: Viewer, state: RoomState, deps: PermissionDeps): boolean {
  if (actor.role === "dm") return false;
  const c = new Check(state, actor, deps);
  const shown = shownDoorChunk(c, op);
  if (!shown) return false;
  if (op.state === "open") {
    const by = op.by !== undefined ? c.visibleToken(op.by) : null;
    return by !== null && by !== undefined && by.sceneId === op.sceneId && ownsToken(state, actor, by) && reachesDoor(state, by, op.door, shown);
  }
  return Object.values(state.tokens).some((token) => token.sceneId === op.sceneId && ownsToken(state, actor, token) && reachesDoor(state, token, op.door, shown));
}

/* Whether the stored door stands where the shown one does: an edge door always does, a free door by its ends. */
function samePlace(shown: BuildChunk, stored: BuildChunk, ref: DoorRef): boolean {
  if ("edge" in ref) return true;
  const a = shown.walls?.find((w) => w.id === ref.id);
  const b = stored.walls?.find((w) => w.id === ref.id);
  return !!a && !!b && a.a[0] === b.a[0] && a.a[1] === b.a[1] && a.b[0] === b.b[0] && a.b[1] === b.b[1];
}

/**
 * The words of a door out of reach (decision 11): too far, unless a token
 * near enough has its line to the door stopped where that line, less its
 * end at the door, touches ground off the sender's live ground. Then what
 * stopped it may stand where they do not see, so it names nothing.
 */
function reachWords(c: Check, tokens: readonly Token[], ref: DoorRef, chunk: BuildChunk): string {
  const ground = tokens[0] ? c.liveGround(tokens[0].sceneId) : null;
  if (!ground) return DOOR_TOO_FAR;
  const g = doorGrid(c.state, tokens[0]!.sceneId);
  const { cells, mid } = doorPlace(ref, chunk, g);
  const settings = c.state.meta.settings;
  const reach = doorReachFt(settings.feetPerCell);
  for (const token of tokens) {
    if (!cells.some((cell) => reachFt(c.state, g, token, cell, settings) <= reach)) continue;
    const r = footprintRect(g, token);
    const cx = r.x + r.w / 2;
    const cy = r.y + r.h / 2;
    const k = 1 - 1e-6;
    if (!sweepLive(ground, cx, cy, cx + (mid.x - cx) * k, cy + (mid.y - cy) * k, 0, 0)) return SOMETHING_BLOCKS;
  }
  return DOOR_TOO_FAR;
}

/**
 * Whether a token reaches a door (docs/design-v1-maps-vision.md 4.1): a cell
 * beside it within 5 ft or one cell by the room's distance rule, and a clear
 * line from the token to the door's middle. `chunk` holds the door, stored
 * or as a player's projection holds it, which keep the same geometry. The
 * server's door check and a player's token action bar both ask this, so the
 * bar offers a door exactly when the server would open it.
 */
export function reachesDoor(state: RoomState, token: Token, ref: DoorRef, chunk: BuildChunk): boolean {
  const g = doorGrid(state, token.sceneId);
  const { cells, mid } = doorPlace(ref, chunk, g);
  const settings = state.meta.settings;
  const reach = doorReachFt(settings.feetPerCell);
  return cells.some((cell) => reachFt(state, g, token, cell, settings) <= reach) && movementRules.lineClear(state, token, mid, ref);
}

/** The grid a door's reach is read on: its scene's. */
function doorGrid(state: RoomState, sceneId: string): Grid {
  const scene = state.scenes[sceneId];
  return scene ? sceneGrid(scene) : SQUARES;
}

/** The door a chunk holds under this name, or null when it holds none there. */
function doorIn(chunk: BuildChunk, ref: DoorRef): Extract<BuildChunk["edges"][string], { kind: "door" }> | null {
  const feature = "edge" in ref ? chunk.edges[ref.edge] : chunk.walls?.find((w) => w.id === ref.id)?.f;
  return feature?.kind === "door" ? feature : null;
}

/**
 * The cells beside a door and its midpoint. An edge's two cells share it.
 * A free door's are the cells just off its midpoint on each side, a step
 * of at most 1/256 cell along its normal: a midpoint of lattice ends is a
 * multiple of 1/128, so the step crosses a grid line only when the
 * midpoint lies on one, and then each side is its own cell. On a hex
 * scene the points themselves come back, each standing for the hex that
 * holds it (docs/design-v1-hex-grids.md section 6, H2): a hex's side is
 * no grid line, so the step finds the hexes on each side of a door drawn
 * along one, and a door through a hex reads that hex from both sides.
 */
function doorPlace(ref: DoorRef, chunk: BuildChunk, g: Grid): { cells: Point[]; mid: Point } {
  if ("edge" in ref) {
    const [xs, ys, side] = ref.edge.split(",");
    const x = Number(xs);
    const y = Number(ys);
    return side === "n" ? { cells: [{ x, y }, { x, y: y - 1 }], mid: { x: x + 0.5, y } } : { cells: [{ x, y }, { x: x - 1, y }], mid: { x, y: y + 0.5 } };
  }
  const wall = chunk.walls!.find((w) => w.id === ref.id)!;
  const [mx, my] = wallMidpoint(wall);
  const nx = -(wall.b[1] - wall.a[1]);
  const ny = wall.b[0] - wall.a[0];
  const scale = Math.max(Math.abs(nx), Math.abs(ny)) * 256;
  const side = (sign: number): Point => ({ x: mx + (sign * nx) / scale, y: my + (sign * ny) / scale });
  if (isHex(g)) return { cells: [side(1), side(-1)], mid: { x: mx, y: my } };
  const cell = (sign: number): Point => {
    const p = side(sign);
    return { x: Math.floor(p.x), y: Math.floor(p.y) };
  };
  return { cells: [cell(1), cell(-1)], mid: { x: mx, y: my } };
}

/**
 * From a token to a cell beside the door, by the room's rule as its ruler
 * measures, in three dimensions (decided 2026-10-14): the token's
 * footprint and height, and the layer of the cell at the ground there. So
 * a token flying 30 ft up does not reach a door on the ground. On hexes
 * `cell` is a point beside the door, read as the hex that holds it, its
 * ground by that hex's key, and the steps between hexes.
 */
function reachFt(state: RoomState, g: Grid, token: Token, cell: Point, settings: RoomSettings): number {
  if (isHex(g)) {
    const hex = hexAt(g, cell);
    const ground = groundAt(state.buildChunks, token.sceneId, hex.col, hex.row);
    return boxDistanceFt(tokenCellBox(g, token, settings.feetPerCell), pointCellBox(g, { x: cell.x, y: cell.y, z: ground }, settings.feetPerCell), settings);
  }
  const z0 = Math.floor(groundAt(state.buildChunks, token.sceneId, cell.x, cell.y) / settings.feetPerCell);
  return boxDistanceFt(tokenCellBox(SQUARES, token, settings.feetPerCell), { x0: cell.x, x1: cell.x + 1, y0: cell.y, y1: cell.y + 1, z0, z1: z0 + 1 }, settings);
}

/** The refusal of a player's delete of a character someone else also plays. */
export const PLAYED_WITH_OTHERS = "someone else plays that character too. Ask the DM to delete it";

/**
 * Whether a player may delete this character: they are its only owner
 * (decided 2026-10-16). The room does not record who made a character, so
 * sole ownership is the rule, and it covers one the player made and one
 * the DM gave to that player alone. It does not depend on
 * `playersCreateCharacters`. The delete takes what the DM's does, every
 * token and companion of the character and its rows in the fight, and is
 * on no undo stack: a player's stack holds only drawings and moves, and a
 * restore that put a character back would let a player write one. The
 * Characters panel asks the same, so it offers Delete exactly when the
 * server would take it.
 */
export function playsAlone(memberId: string, character: Pick<Character, "ownerIds">): boolean {
  return character.ownerIds.length === 1 && character.ownerIds[0] === memberId;
}

/** Whether the room lets players make their own characters. Rooms from before the setting have none: off. */
function playersCreate(c: Check): boolean {
  return c.state.meta.settings.playersCreateCharacters === true;
}

/**
 * A player's own new character (features 15, `playersCreateCharacters`):
 * owned by that player alone, at most LIMITS.charactersPerPlayer of them, and
 * starting plain, unhurt and with nothing only the DM may set. The DM keeps
 * every power over it afterwards.
 */
function createCharacterCheck(c: Check, input: Extract<Op, { t: "character.create" }>["character"]): Decision {
  if (!playersCreate(c)) return FORBIDDEN;
  if (c.state.characters[input.id]) return GONE;
  if (input.ownerIds.length !== 1 || input.ownerIds[0] !== c.actor.memberId) return refuse("forbidden", "a character you make belongs to you alone");
  const owned = Object.values(c.state.characters).filter((ch) => ownsCharacter(c.actor, ch)).length;
  if (owned >= LIMITS.charactersPerPlayer) {
    return refuse("forbidden", `you can have at most ${LIMITS.charactersPerPlayer} characters. Ask the DM for another`);
  }
  const a = input.actor;
  const unhurt = a.hp.cur === a.hp.max && a.hp.cur > 0 && a.hp.temp === 0 && a.life === "alive" && a.deathSaves.ok === 0 && a.deathSaves.fail === 0;
  const plain = a.effects.length === 0 && a.dmNotes === "" && a.legendary === undefined && a.monsterId === undefined;
  if (!unhurt || !plain) return refuse("forbidden", "a new character starts unhurt, with no conditions or DM notes");
  if (!imageUsable(c, input.defaultImage)) return GONE;
  return OK;
}

/**
 * A player's edit of a character's companion stat blocks
 * (docs/design-v1-companion-stat-blocks.md 4.1), with no room setting, as
 * adding a companion needs none: a create names a character that exists and
 * that they own, and an edit or a delete names a block of a character they
 * own. Any other block answers `gone`, the answer for anything outside
 * their view, as does a new id that is in use, so no answer tells them that
 * a block they cannot see exists.
 */
function companionBlockCheck(c: Check, op: OpOf<"companionBlock.create" | "companionBlock.update" | "companionBlock.delete">): Decision {
  if (op.t === "companionBlock.create") {
    const character = c.state.characters[op.block.characterId];
    if (!character) return GONE;
    if (!ownsCharacter(c.actor, character)) return NOT_YOURS;
    if (c.state.companionBlocks[op.block.id]) return GONE;
    return imageUsable(c, op.block.defaultImage) ? OK : GONE;
  }
  if (!ownsBlock(c, op.blockId)) return GONE;
  return op.t === "companionBlock.update" && !imageUsable(c, op.patch.defaultImage) ? GONE : OK;
}

/** Whether a block exists and belongs to a character the player owns: the blocks in their view. */
function ownsBlock(c: Check, blockId: string): boolean {
  const block = c.state.companionBlocks[blockId];
  return block !== undefined && c.ownsCharacterId(block.characterId);
}

/** What an owner may change on a companion beyond any token's owner fields (docs/design-v1-combat-flow.md 3.6.4). */
const COMPANION_OWNER_FIELDS = new Set(["name", "actor", "kind", "companion", "companionReaction"]);
/**
 * The stat block links a companion's owners set beside the stats an owner
 * edits (docs/design-v1-companion-stat-blocks.md 4.1): an SRD block, or one
 * of the character's own. A room monster's link stays the DM's.
 */
const COMPANION_OWNER_ACTOR_FIELDS = new Set([...OWNER_ACTOR_FIELDS, "srdId", "blockId"]);

/**
 * A `blockId` a player names must be a block of a character they own, else
 * `gone`, before the reducer's own rules run, so no answer tells them that
 * a block outside their view exists (docs/design-v1-companion-stat-blocks.md 4.1).
 */
function blockLinkVisible(c: Check, blockId: string | null | undefined): boolean {
  return blockId === undefined || blockId === null || ownsBlock(c, blockId);
}

/**
 * An owner's edit of a companion: to its player, a companion is what their
 * character is. Beyond any token's owner fields they may rename it, edit
 * the stats an owner edits on a character, make it a creature or an
 * effect, change its turn, and mark its Reaction. Which character it
 * belongs to, its owners, its number and the DM's fields stay the DM's.
 * The reducer's own rules (an effect's turn, owners, numbers) then apply
 * as for the DM.
 */
function companionUpdateCheck(c: Check, token: Token, link: NonNullable<Token["companion"]>, patch: TokenPatch): Decision {
  // A companion's size is its owners' through the one rule every owned token's resize takes (docs/design-v1-token-window.md 8.6).
  if (patch.size !== undefined) return resizeCheck(c, token, patch);
  for (const field of Object.keys(patch)) {
    if (field === "publicName") return refuse("forbidden", "only a PC's owner renames it");
    if (!OWNER_TOKEN_FIELDS.has(field) && !COMPANION_OWNER_FIELDS.has(field)) return refuse("forbidden", `owners cannot change ${field}`);
  }
  for (const field of Object.keys(patch.actor ?? {})) {
    if (!COMPANION_OWNER_ACTOR_FIELDS.has(field)) return refuse("forbidden", `owners cannot change ${field}`);
  }
  if (!blockLinkVisible(c, patch.actor?.blockId)) return GONE;
  if (patch.kind !== undefined && patch.kind !== "npc" && patch.kind !== "object") return refuse("forbidden", "a companion is a creature or an effect");
  if (patch.companion !== undefined && patch.companion?.of !== link.of) return refuse("forbidden", "only the DM changes whose companion it is");
  return tokenImagesUsable(c, patch) ? OK : GONE;
}

/** How near a player's companion lands to its character's token: 5 ft, or one cell where a cell is wider, as a door's reach. */
export function companionReachFt(feetPerCell: number): number {
  return doorReachFt(feetPerCell);
}

/**
 * Whether a footprint is within a companion's reach of its character's
 * token, by the room's own distance rule on the scene's grid: on hexes the
 * fewest hex steps between the two footprints, with the room's rule only
 * for height (rules/distance.ts, docs/design-v1-hex-grids.md 4.3).
 */
export function withinCompanionReach(settings: RoomSettings, grid: Grid, spot: FootprintToken, character: FootprintToken): boolean {
  return boxDistanceFt(tokenCellBox(grid, spot, settings.feetPerCell), tokenCellBox(grid, character, settings.feetPerCell), settings) <= companionReachFt(settings.feetPerCell);
}

/**
 * Whether a token placed as `input` could step to its spot from where the
 * character's token stands, on a scene that blocks moves: null when it
 * could, else what stops it. The form's spot finder asks the same, so the
 * spot it picks is one the server takes.
 */
export function companionLegBlocker(state: RoomState, input: TokenInput, from: Pick<Token, "x" | "y" | "elevation">): "wall" | "ledge" | null {
  // A token not yet in the room has no holder to leave.
  const walker = ownWalk({ ...inputAsToken(input), x: from.x, y: from.y, elevation: from.elevation });
  return movementRules.legBlocker(state, walker, { x: input.x, y: input.y, elevation: input.elevation ?? from.elevation });
}

/** A token input as the rules that read a placed token see it. Only its place, size and scene matter to them. */
function inputAsToken(input: TokenInput): Token {
  return {
    id: input.id,
    rev: 0,
    sceneId: input.sceneId,
    kind: input.kind,
    name: input.name,
    nameHidden: false,
    size: input.size,
    ...(input.w !== undefined ? { w: input.w } : {}),
    ...(input.h !== undefined ? { h: input.h } : {}),
    x: input.x,
    y: input.y,
    elevation: input.elevation ?? 0,
    ...(input.height !== undefined ? { height: input.height } : {}),
    rotation: 0,
    disposition: input.disposition ?? "ally",
    visibility: "all",
    fogExempt: false,
    fogExemptAuto: false,
    locked: false,
    layer: "token",
    ownerIds: [],
    actor: input.actor,
    hpVisibility: "label",
  };
}

/** The refusals a player's new companion can meet where it lands, which the form shows in the same words. */
export const companionWords = {
  noToken: (name: string) => `${name} has no token here.`,
  tooFar: (name: string) => `Put it next to ${name}.`,
  full: (name: string) => `${name} has ${LIMITS.companionsPerCharacter} companions here. Ask the DM for more.`,
};

/**
 * A player's companion for a character they own (docs/design-v1-combat-flow.md
 * 3.6.3 and 4.4), with no setting needed: summons arrive mid-turn. It lands
 * on the scene the player holds, inside the map, within 5 ft of a token of
 * the character, and on a scene where walls stop moves, where that token's
 * creature could step. It is a creature with HP or an effect with none,
 * only a creature takes its own turn, and it starts plain, unhurt and
 * bare, owned by whoever plays the character, at most
 * LIMITS.companionsPerCharacter of them on that scene. The DM keeps every
 * power over it afterwards.
 */
function companionCheck(c: Check, input: TokenInput, link: NonNullable<TokenInput["companion"]>): Decision {
  const character: Character | undefined = c.state.characters[link.of];
  if (!character) return GONE;
  if (!ownsCharacter(c.actor, character)) return NOT_YOURS;
  const scene = c.state.scenes[input.sceneId];
  if (c.state.tokens[input.id] || !scene || input.sceneId !== viewerSceneId(c.state, c.actor, c.opts)) return GONE;
  if (!insideScene(scene, input, input)) return refuse("forbidden", "place it inside the map");
  const settings = c.state.meta.settings;
  const placed = { ...input, elevation: input.elevation ?? 0 };
  const own = Object.values(c.state.tokens)
    .filter((t) => t.sceneId === input.sceneId && "ref" in t.actor && t.actor.ref === character.id)
    .sort((a, b) => (a.id < b.id ? -1 : 1));
  if (own.length === 0) return refuse("forbidden", companionWords.noToken(character.name));
  const near = own.filter((t) => withinCompanionReach(settings, sceneGrid(scene), placed, t));
  if (near.length === 0) return refuse("forbidden", companionWords.tooFar(character.name));
  if (scene.blockMovement === true) {
    const blockers = near.map((t) => companionLegBlocker(c.state, input, t));
    if (!blockers.includes(null)) return refuse("forbidden", companionStopWords(c, input, near[0]!, blockers[0]!));
  }
  if (!("inline" in input.actor)) return refuse("forbidden", "a companion has stats of its own");
  const a = input.actor.inline;
  const creature = input.kind === "npc" && a.hp.max >= 1;
  const effect = input.kind === "object" && a.hp.max === 0 && a.hp.cur === 0 && a.ac === 0;
  if (!creature && !effect) return refuse("forbidden", "a companion is a creature with at least 1 HP, or an effect with no HP or AC");
  if (link.turn === "own" && input.kind !== "npc") return refuse("forbidden", "an effect takes no turn of its own");
  const special =
    (input.visibility ?? "all") !== "all" ||
    input.fogExempt === true ||
    input.locked === true ||
    input.nameHidden === true ||
    input.publicName !== undefined ||
    input.number !== undefined ||
    input.layer !== "token" ||
    input.light !== undefined ||
    input.partyVision !== undefined ||
    input.hpVisibility !== undefined;
  if (special) return refuse("forbidden", "players add only a plain companion");
  const bare =
    a.hp.cur === a.hp.max &&
    a.hp.temp === 0 &&
    a.life === "alive" &&
    a.deathSaves.ok === 0 &&
    a.deathSaves.fail === 0 &&
    a.effects.length === 0 &&
    a.dmNotes === "" &&
    a.legendary === undefined &&
    a.monsterId === undefined;
  if (!bare) return refuse("forbidden", "a new companion starts unhurt, with no conditions or DM notes");
  // Only what its player could change afterwards (docs/design-v1-companion-stat-blocks.md 4.1): a link, never the DM's fields.
  if (a.initScore !== undefined || a.creatureType !== undefined || a.cr !== undefined || a.xp !== undefined) {
    return refuse("forbidden", "a new companion leaves its initiative score, creature type, CR and XP to the DM");
  }
  if (!blockLinkVisible(c, a.blockId)) return GONE;
  if (input.ownerIds !== undefined && !sameMembers(input.ownerIds, character.ownerIds)) return refuse("forbidden", "a companion is played by whoever plays its character");
  if (!tokenImagesUsable(c, input)) return GONE;
  const here = Object.values(c.state.tokens).filter((t) => t.sceneId === input.sceneId && t.companion?.of === character.id).length;
  if (here >= LIMITS.companionsPerCharacter) return refuse("forbidden", companionWords.full(character.name));
  return OK;
}

function sameMembers(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((id) => b.includes(id));
}

/**
 * A player's token for their own character on the players' scene, inside
 * its bounds, one per character there, and a plain player character token
 * of the character's own size: everything else about token creation stays
 * the DM's. Its name is the player's to choose, as owners may rename a PC's
 * token later anyway (OWNER_TOKEN_FIELDS).
 */
function placeTokenCheck(c: Check, input: Extract<Op, { t: "token.create" }>["token"]): Decision {
  if (!playersCreate(c)) return FORBIDDEN;
  if (!("ref" in input.actor)) return FORBIDDEN;
  const character: Character | undefined = c.state.characters[input.actor.ref];
  if (!character) return GONE;
  if (!ownsCharacter(c.actor, character)) return NOT_YOURS;
  const scene = c.state.scenes[input.sceneId];
  if (c.state.tokens[input.id] || !scene || input.sceneId !== viewerSceneId(c.state, c.actor, c.opts)) return GONE;
  const special =
    input.kind !== "pc" ||
    (input.visibility ?? "all") !== "all" ||
    input.fogExempt === true ||
    input.locked === true ||
    input.nameHidden === true ||
    input.publicName !== undefined ||
    input.number !== undefined ||
    // A character token's HP follows the character's rules, so "exact" is the only setting it carries.
    (input.hpVisibility ?? "exact") !== "exact" ||
    (input.layer ?? "token") !== "token" ||
    // Party membership is the DM's mark (docs/design-v1-maps-vision.md 4.3.5), false included, since it is no plain token's.
    input.partyVision !== undefined;
  if (special) return refuse("forbidden", "players place only a plain token of their own character");
  if (input.size !== character.size || input.w !== undefined || input.h !== undefined) return refuse("forbidden", "the token takes its character's size");
  if (input.ownerIds !== undefined && !sameMembers(input.ownerIds, character.ownerIds)) return refuse("forbidden", "the token belongs to whoever owns its character");
  if (!insideScene(scene, input, input)) return refuse("forbidden", "place it inside the map");
  const placed = Object.values(c.state.tokens).some((t) => t.sceneId === input.sceneId && "ref" in t.actor && t.actor.ref === character.id);
  if (placed) return refuse("forbidden", "that character is on the map already");
  if (!tokenImagesUsable(c, input)) return GONE;
  return OK;
}
