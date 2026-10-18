import { chunkKey, doorChunk, keys, wallMidpoint } from "./keys.ts";
import { imageAssetId } from "./imageRef.ts";
import type { Actor, BuildChunk, Character, Drawing, DurationAnchor, Effect, ImageRef, InitEntry, JournalAccess, RollTarget, RoomSettings, RoomState, Scene, Token, Viewer } from "./model.ts";
import type { ActorTarget, DoorRef, Op, OpOf, RefusalCode, TokenInput, TokenPatch } from "./protocol.ts";
import { ownsCharacter, ownsToken, projectEntity, stableStringify, viewerSceneId, type ProjectOpts, type ProjectedEncounter } from "./project.ts";
import { LIMITS } from "./limits.ts";
import { restoreAddedAssets } from "./referencedAssets.ts";
import { handoutPages } from "./handouts.ts";
import { movementRules, type LegEnd } from "./ruleHooks.ts";
import { boxDistanceFt, tokenCellBox } from "./rules/distance.ts";
import { footprintSize } from "./rules/footprint.ts";
import { groundAt } from "./rules/heights.ts";
import type { Point } from "./rules/geom.ts";
import { LEDGE_IN_THE_WAY, WALL_IN_THE_WAY } from "./rules/movement.ts";
import { OWNER_SIZES, resizeRefusal } from "./rules/resize.ts";
import { turnMovedOn } from "./rules/initiative.ts";
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
/** A character's stat block is its players', as its light card is (docs/design-v1-pc-stats.md 4.1). */
const OWNER_CHARACTER_FIELDS = new Set(["name", "defaultImage", "actor", "level", "stats"]);
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
  if (actor.role !== "dm" && setsSave(op)) return refuse("forbidden", SAVE_IS_DMS);
  const levels = levelsFit(op, check);
  return levels.ok ? squeezeFits(op, check) : levels;
}

/** The refusal of a player's op that names an effect's save or its occurrence (docs/design-v1-roll-options.md 6.1). */
export const SAVE_IS_DMS = "only the DM sets a save that ends an effect";

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
 * replays whatever the walls became since.
 */
function squeezeFits(op: Op, c: Check): Decision {
  if (op.t !== "token.move" || !op.squeeze) return OK;
  const token = c.state.tokens[op.tokenId];
  if (!token) return OK;
  return movementRules.squeezeFits(c.state, token, { x: op.x, y: op.y }) ? OK : refuse("invalid", NOT_A_SQUEEZE);
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
    // The DM's death roll needs a creature that exists, checked before anything is drawn.
    case "actor.deathRoll":
      return ("tokenId" in op.target ? c.state.tokens[op.target.tokenId] : c.state.characters[op.target.characterId]) ? OK : GONE;
    // The rule of the op it carries (docs/design-v1-dice.md 4.2).
    case "sys.dice":
      return forDm(op.asked, c);
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
      const d = moveCheck(c, op.tokenId);
      return d.ok ? legCheck(c, op.tokenId, op, op.teleport !== undefined) : d;
    }
    case "token.moveMany": {
      for (const move of op.moves) {
        const d = moveCheck(c, move.tokenId);
        if (!d.ok) return d;
      }
      // A group move is refused whole when a leg is stopped: the client sends only the legs it found allowed.
      for (const move of op.moves) {
        const d = legCheck(c, move.tokenId, move, false);
        if (!d.ok) return d;
      }
      return OK;
    }

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
    case "actor.rest": {
      const t = c.target(op.target);
      if (!t.visible) return GONE;
      return t.owned ? OK : NOT_YOURS;
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
      if (op.patch.visibility !== undefined && op.patch.visibility !== "all") return refuse("forbidden", "players cannot hide areas");
      if (op.patch.attachedTo && !c.visibleToken(op.patch.attachedTo)) return GONE;
      if (op.patch.casterId && !c.visibleToken(op.patch.casterId)) return GONE;
      return OK;
    }
    case "template.delete": {
      const template = c.state.templates[op.templateId];
      if (!template || !c.visible(keys.template(op.templateId))) return GONE;
      return template.ownerId === c.actor.memberId ? OK : NOT_YOURS;
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
      return op.log === undefined ? OK : refuse("forbidden", "only the DM takes back a change from the log");
    case "redo":
      return OK;

    case "sys.restore": {
      // A player's stack holds only their own drawings and token moves and resizes (design 7.7), so that is all a restore may touch.
      for (const entry of op.entries) {
        if (entry.key.startsWith("token:")) {
          // An undo retraces a move that was allowed when made. A redo makes it again, so walls stop it as they would a new
          // move, except a teleport's, which passed them the first time too (docs/design-v1-maps-vision.md 4.1).
          const d = restorePoseCheck(c, entry.key.slice("token:".length), entry.value, op.from === "redo" && !op.teleport);
          if (!d.ok) return d;
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
  return moveCheck(new Check(state, viewer, { canUseAsset: () => false }), tokenId);
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
export const NO_TYPED_INITIATIVE = "The DM has turned off typed totals in this room. Roll your initiative instead.";

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
  // Newest first, so the fight's start line ends the search: anything older is another fight's. A start the log no longer holds is older than every line it holds.
  for (let i = state.log.length - 1; i >= 0; i--) {
    const data = state.log[i]!.data;
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

/** Movement (design 8.1): owners, or the players the room lets move any token, and never a locked token. */
function moveCheck(c: Check, tokenId: string): Decision {
  const token = c.visibleToken(tokenId);
  if (!token) return GONE;
  if (token.locked) return refuse("forbidden", "that token is locked");
  if (ownsToken(c.state, c.actor, token)) return OK;
  return movesAnyToken(c.state.meta.settings, c.actor.memberId) ? OK : NOT_YOURS;
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
const POSE_FIELDS = ["x", "y", "elevation", "rotation", "path", "squeeze", "rev"] as const;

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
  const may = inPlace && ownsToken(c.state, c.actor, token) ? OK : moveCheck(c, tokenId);
  if (!may.ok) return may;
  if (!restored) return FORBIDDEN;
  return withoutPose(restored) === withoutPose(current) ? OK : refuse("forbidden", "an undo of yours only moves tokens back");
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
function restorePoseCheck(c: Check, tokenId: string, value: unknown, redo: boolean): Decision {
  const current = c.state.tokens[tokenId];
  const restored = value && typeof value === "object" ? (value as Token) : null;
  if (!current || !restored || SIZE_FIELDS.every((field) => restored[field] === current[field])) {
    const d = restoreMoveCheck(c, tokenId, value);
    return d.ok && redo && restored ? legCheck(c, tokenId, restored, false) : d;
  }
  const token = c.visibleToken(tokenId);
  if (!token) return GONE;
  if (!ownsToken(c.state, c.actor, token)) return NOT_YOURS;
  if (token.locked) return refuse("forbidden", "that token is locked");
  if (current.size === "custom" || restored.size === "custom") return refuse("forbidden", OWNER_SIZES);
  if (withoutPose(restored, SIZE_FIELDS) !== withoutPose(current, SIZE_FIELDS)) return refuse("forbidden", "an undo of yours only moves or resizes tokens back");
  const refusal = resizeRefusal(c.state, current, restored);
  return refusal === null ? OK : refuse("forbidden", refusal);
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
  const refusal = resizeRefusal(c.state, token, { size: patch.size, x: patch.x ?? token.x, y: patch.y ?? token.y });
  return refusal === null ? OK : refuse("forbidden", refusal);
}

// What a player hears when a wall or a ledge stops a move, kept with the move rules since a resize says it too.
export { LEDGE_IN_THE_WAY, WALL_IN_THE_WAY };
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
function legCheck(c: Check, tokenId: string, to: Pick<Token, "x" | "y"> & { elevation?: number }, teleport: boolean): Decision {
  const token = c.state.tokens[tokenId];
  const scene = token ? c.state.scenes[token.sceneId] : undefined;
  if (!token || !scene) return OK;
  const end: LegEnd = { x: to.x, y: to.y, elevation: to.elevation ?? token.elevation };
  if (teleport) return insideScene(scene, token, end) ? OK : refuse("forbidden", TELEPORT_OFF_MAP);
  // A token rising or sinking where it stands crosses no edge.
  if (scene.blockMovement !== true || (end.x === token.x && end.y === token.y)) return OK;
  const blocker = movementRules.legBlocker(c.state, token, end);
  if (blocker === null) return OK;
  return refuse("forbidden", blocker === "wall" ? WALL_IN_THE_WAY : LEDGE_IN_THE_WAY);
}

function insideScene(scene: Scene, token: Token, at: Point): boolean {
  const fp = footprintSize(token);
  return at.x >= 0 && at.y >= 0 && at.x + fp.w <= scene.bounds.w && at.y + fp.h <= scene.bounds.h;
}

/** A player's refusals at a door (docs/design-v1-maps-vision.md 4.1), the way players learn about locks. */
export const DOOR_LOCKED = "It's locked.";
export const DOOR_TOO_FAR = "Too far from the door.";
export const DOOR_DM_ONLY = "only the DM locks doors and marks secret doors";
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
 */
function doorCheck(c: Check, op: OpOf<"door.set">): Decision {
  if (op.state === "locked" || op.found !== undefined) return refuse("forbidden", DOOR_DM_ONLY);
  const { cx, cy } = doorChunk(op.door);
  const shown = projectEntity(keys.chunk(op.sceneId, cx, cy), c.state, c.actor, c.opts) as BuildChunk | null;
  const stored = c.state.buildChunks[chunkKey(op.sceneId, cx, cy)];
  if (!shown || !stored || !doorIn(shown, op.door)) return GONE;
  // Reach comes before the lock: a player learns a door is locked by trying it, so a door out of reach answers the same
  // whether it is locked or not, and no request can list the locks across the scene.
  const reached = Object.values(c.state.tokens).some((token) => token.sceneId === op.sceneId && ownsToken(c.state, c.actor, token) && reachesDoor(c.state, token, op.door, stored));
  if (!reached) return refuse("forbidden", DOOR_TOO_FAR);
  // The lock is read from the stored door, since players get a locked door as closed.
  if (doorIn(stored, op.door)?.state === "locked") return refuse("forbidden", DOOR_LOCKED);
  return OK;
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
  const { cells, mid } = doorPlace(ref, chunk);
  const settings = state.meta.settings;
  const reach = doorReachFt(settings.feetPerCell);
  return cells.some((cell) => reachFt(state, token, cell, settings) <= reach) && movementRules.lineClear(state, token, mid, ref);
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
 * midpoint lies on one, and then each side is its own cell.
 */
function doorPlace(ref: DoorRef, chunk: BuildChunk): { cells: Point[]; mid: Point } {
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
  const cell = (sign: number): Point => ({ x: Math.floor(mx + (sign * nx) / scale), y: Math.floor(my + (sign * ny) / scale) });
  return { cells: [cell(1), cell(-1)], mid: { x: mx, y: my } };
}

/**
 * From a token to a cell beside the door, by the room's rule as its ruler
 * measures, in three dimensions (decided 2026-10-14): the token's
 * footprint and height, and the layer of the cell at the ground there. So
 * a token flying 30 ft up does not reach a door on the ground.
 */
function reachFt(state: RoomState, token: Token, cell: Point, settings: RoomSettings): number {
  const z0 = Math.floor(groundAt(state.buildChunks, token.sceneId, cell.x, cell.y) / settings.feetPerCell);
  return boxDistanceFt(tokenCellBox(token, settings.feetPerCell), { x0: cell.x, x1: cell.x + 1, y0: cell.y, y1: cell.y + 1, z0, z1: z0 + 1 }, settings);
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

/** Whether a footprint is within a companion's reach of its character's token, by the room's own distance rule. */
export function withinCompanionReach(settings: RoomSettings, spot: Parameters<typeof tokenCellBox>[0], character: Parameters<typeof tokenCellBox>[0]): boolean {
  return boxDistanceFt(tokenCellBox(spot, settings.feetPerCell), tokenCellBox(character, settings.feetPerCell), settings) <= companionReachFt(settings.feetPerCell);
}

/**
 * Whether a token placed as `input` could step to its spot from where the
 * character's token stands, on a scene that blocks moves: null when it
 * could, else what stops it. The form's spot finder asks the same, so the
 * spot it picks is one the server takes.
 */
export function companionLegBlocker(state: RoomState, input: TokenInput, from: Pick<Token, "x" | "y" | "elevation">): "wall" | "ledge" | null {
  const walker = { ...inputAsToken(input), x: from.x, y: from.y, elevation: from.elevation };
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
  const fp = footprintSize(input);
  if (input.x < 0 || input.y < 0 || input.x + fp.w > scene.bounds.w || input.y + fp.h > scene.bounds.h) return refuse("forbidden", "place it inside the map");
  const settings = c.state.meta.settings;
  const placed = { ...input, elevation: input.elevation ?? 0 };
  const own = Object.values(c.state.tokens)
    .filter((t) => t.sceneId === input.sceneId && "ref" in t.actor && t.actor.ref === character.id)
    .sort((a, b) => (a.id < b.id ? -1 : 1));
  if (own.length === 0) return refuse("forbidden", companionWords.noToken(character.name));
  const near = own.filter((t) => withinCompanionReach(settings, placed, t));
  if (near.length === 0) return refuse("forbidden", companionWords.tooFar(character.name));
  if (scene.blockMovement === true) {
    const blockers = near.map((t) => companionLegBlocker(c.state, input, t));
    if (!blockers.includes(null)) return refuse("forbidden", blockers[0] === "ledge" ? LEDGE_IN_THE_WAY : WALL_IN_THE_WAY);
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
  const fp = footprintSize(input);
  if (input.x < 0 || input.y < 0 || input.x + fp.w > scene.bounds.w || input.y + fp.h > scene.bounds.h) return refuse("forbidden", "place it inside the map");
  const placed = Object.values(c.state.tokens).some((t) => t.sceneId === input.sceneId && "ref" in t.actor && t.actor.ref === character.id);
  if (placed) return refuse("forbidden", "that character is on the map already");
  if (!tokenImagesUsable(c, input)) return GONE;
  return OK;
}
