import type { Actor, RoomState } from "./model.ts";
import type { ActorPatch, Op, TokenGroupPatch, TokenPatch } from "./protocol.ts";
import type { UndoScope } from "./undoContract.ts";

/** Field-sensitive entries are decided against the accepted operation's before-state below. */
export const UNDO_SCOPE_BY_OP = {
  "room.update": "setup",
  "room.setPlayerScene": "play",
  "view.follow": "play",
  "view.blackout": "play",
  "member.update": "none",
  "scene.create": "setup",
  "scene.update": "fields",
  "scene.delete": "setup",
  "scene.reorder": "setup",
  "scene.setMap": "setup",
  "scene.setGrid": "setup",
  "scene.setPhase": "play",
  "scene.duplicate": "setup",
  "vision.holders": "setup",
  "token.create": "play",
  "token.update": "fields",
  "token.updateMany": "fields",
  "token.delete": "play",
  "token.deleteMany": "play",
  "token.move": "play",
  "token.moveMany": "play",
  "token.countLeg": "play",
  "token.attach": "play",
  "token.detach": "play",
  "actor.hp": "play",
  "actor.outcome": "play",
  "actor.damageMany": "play",
  "actor.deathSave": "play",
  "actor.life": "play",
  "actor.rest": "play",
  "actor.effect.add": "play",
  "actor.effect.update": "play",
  "actor.effect.remove": "play",
  "actor.effects": "play",
  "actor.saveDue": "play",
  "actor.use": "play",
  "actor.prompt": "play",
  "character.create": "setup",
  "character.update": "fields",
  "character.delete": "setup",
  "monster.create": "setup",
  "monster.update": "setup",
  "monster.delete": "setup",
  "monster.setSrdImage": "setup",
  "companionBlock.create": "setup",
  "companionBlock.update": "setup",
  "companionBlock.delete": "setup",
  "savedEncounter.create": "setup",
  "savedEncounter.update": "setup",
  "savedEncounter.delete": "setup",
  "template.create": "play",
  "template.update": "play",
  "template.delete": "play",
  "drawing.create": "play",
  "drawing.delete": "play",
  "drawing.clear": "play",
  "fog.draft": "play",
  "fog.publish": "play",
  "fog.discard": "play",
  "fog.live": "play",
  "fog.reset": "play",
  "build.paint": "play",
  "build.erase": "play",
  "build.rect": "play",
  "build.poly": "play",
  "build.edge": "play",
  "build.label": "play",
  "build.clear": "play",
  "build.walls": "play",
  "build.stamps": "play",
  "build.lights": "play",
  "build.height": "play",
  "build.stairs": "play",
  "build.rough": "play",
  "build.ask": "none",
  "door.set": "play",
  "trap.create": "setup",
  "trap.update": "fields",
  "trap.delete": "setup",
  "trap.spring": "play",
  "trap.act": "play",
  "trap.settle": "play",
  "encounter.start": "play",
  "encounter.end": "play",
  "encounter.add": "play",
  "encounter.remove": "play",
  "encounter.setValue": "play",
  "encounter.setValues": "play",
  "encounter.reorder": "play",
  "encounter.next": "play",
  "encounter.prev": "play",
  "encounter.update": "play",
  "log.chat": "none",
  "log.whisper": "none",
  "handout.show": "play",
  "handout.close": "play",
  "handoutDoc.create": "setup",
  "handoutDoc.delete": "setup",
  "journal.create": "setup",
  "journal.update": "setup",
  "journal.reveal": "play",
  "journal.delete": "setup",
  "pin.put": "setup",
  "pin.remove": "setup",
  "roll.ask": "fields",
  "roll.answer": "play",
  "roll.reopen": "play",
  "roll.change": "none",
  "roll.close": "fields",
  "cast.ask": "none",
  "cast.close": "none",
  "dice.roll": "none",
  "roll.dice": "none",
  "actor.deathRoll": "none",
  "actor.rechargeRoll": "none",
  undo: "none",
  redo: "none",
  "sys.memberJoin": "none",
  "sys.memberSetKind": "none",
  "sys.memberRemove": "none",
  "sys.restore": "none",
  "sys.explore": "none",
  "sys.remember": "none",
  "sys.dice": "none",
} as const satisfies Record<Op["t"], UndoScope | "fields">;

const PLAY_TOKEN_FIELDS = new Set([
  "sceneId", "x", "y", "elevation", "rotation", "size", "w", "h", "visibility", "light", "companionReaction", "actor",
] satisfies (keyof TokenPatch)[]);
const PLAY_TOKEN_GROUP_FIELDS = new Set(["visibility", "size", "w", "h", "light"] satisfies (keyof TokenGroupPatch)[]);
const HP_FIELDS = new Set(["cur", "temp"]);
const LEGENDARY_FIELDS = new Set(["actionsMax", "actionsUsed", "resistMax", "resistUsed"]);
const SHAPE_FIELDS = new Set(["srdId", "wildShape", "ac", "speeds", "hp"] satisfies (keyof ActorPatch)[]);
const SPEED_FIELDS = new Set(["walk", "fly", "swim", "climb", "burrow", "hover"] satisfies (keyof Actor["speeds"])[]);
const VISION_FIELDS = new Set(["on", "light", "perPlayer"]);
const TRAP_PLAY_FIELDS = new Set(["state", "found"]);

function onlyFields(value: object, allowed: ReadonlySet<string>): boolean {
  return Object.keys(value).every((key) => allowed.has(key));
}

function onlyField(value: object, field: string): boolean {
  const fields = Object.keys(value);
  return fields.length === 1 && fields[0] === field;
}

/** Match the shape producer's complete patch, not a sheet save containing some shape fields. */
function isShapePatch(patch: ActorPatch): boolean {
  if (onlyField(patch, "srdId") && patch.srdId === null) return true;
  if (!onlyFields(patch, SHAPE_FIELDS) || typeof patch.srdId !== "string" || patch.srdId.length === 0 || patch.ac === undefined || patch.speeds === undefined) return false;
  return onlyFields(patch.speeds, SPEED_FIELDS) && (patch.hp === undefined || onlyField(patch.hp, "temp"));
}

function actorScope(patch: ActorPatch, before: Actor | undefined, shape: boolean): UndoScope {
  if (shape && isShapePatch(patch)) return "play";
  if (onlyField(patch, "hp") && patch.hp !== undefined && onlyFields(patch.hp, HP_FIELDS)) return "play";
  if (onlyField(patch, "legendary") && patch.legendary && before?.legendary && onlyFields(patch.legendary, LEGENDARY_FIELDS)) {
    if (patch.legendary.actionsMax === before.legendary.actionsMax && patch.legendary.resistMax === before.legendary.resistMax) return "play";
  }
  return "setup";
}

/** Classification never grants permission or decides whether reduction produced an undoable change. */
export function undoScope(op: Op, before: RoomState): UndoScope {
  switch (op.t) {
    case "roll.ask":
    case "roll.close":
      return op.reason === "savePage" ? "none" : "play";
    case "token.update": {
      if (!onlyFields(op.patch, PLAY_TOKEN_FIELDS)) return "setup";
      if (op.patch.actor === undefined) return "play";
      const token = before.tokens[op.tokenId];
      const character = token && "ref" in token.actor ? before.characters[token.actor.ref] : undefined;
      const actor = token && "inline" in token.actor ? token.actor.inline : character?.actor;
      return actorScope(op.patch.actor, actor, character !== undefined && onlyField(op.patch, "actor"));
    }
    case "token.updateMany":
      return onlyFields(op.patch, PLAY_TOKEN_GROUP_FIELDS) ? "play" : "setup";
    case "character.update":
      return onlyField(op.patch, "actor") && op.patch.actor !== undefined
        ? actorScope(op.patch.actor, before.characters[op.characterId]?.actor, before.characters[op.characterId] !== undefined)
        : "setup";
    case "trap.update":
      return onlyFields(op.patch, TRAP_PLAY_FIELDS) ? "play" : "setup";
    case "scene.update": {
      if (onlyField(op.patch, "thumb")) return "none";
      if (onlyField(op.patch, "suggestedView")) return "play";
      const vision = op.patch.vision;
      if (!onlyField(op.patch, "vision") || vision === undefined || !onlyFields(vision, VISION_FIELDS)) return "setup";
      const scene = before.scenes[op.sceneId];
      if (!scene || vision.on !== (scene.vision?.on === true)) return "setup";
      return vision.perPlayer === undefined || vision.perPlayer === (scene.vision?.perPlayer === true) ? "play" : "setup";
    }
    default:
      // A new field-sensitive operation cannot fall through as a fixed scope.
      return UNDO_SCOPE_BY_OP[op.t];
  }
}
