import { isPoseOp, type Op, type OpType } from "./protocol.ts";

/**
 * How each op type meets the far line (shared/limits.ts FAR,
 * docs/design/design-v1-player-limits.md 5.4). Deletions free or stop, and
 * never meet a line. Bookkeeping writes fields of fixed width, rows of a
 * ring or lists with their own caps, which the bound reserves at their
 * widest, so it is exempt by kind. `byField` types carry bookkeeping and
 * content in one op and are judged by the fields they name. Every other
 * growing op meets the line. `own` types keep their own rules: a move of
 * the players' scene meets the near reserves, and who sees for themselves
 * the widest reserves. `restore` types are judged as the kind of what they
 * bring back. The server's ops are reserved and never refused for bytes.
 *
 * A type left out fails the typecheck, so a new op is classed when it is
 * added.
 */
export type FarTreatment = "deletion" | "bookkeeping" | "byField" | "meets" | "own" | "restore" | "server";

export const FAR_TREATMENT: { readonly [T in OpType]: FarTreatment } = {
  "token.delete": "deletion",
  "token.deleteMany": "deletion",
  "scene.delete": "deletion",
  "character.delete": "deletion",
  "monster.delete": "deletion",
  "template.delete": "deletion",
  "drawing.delete": "deletion",
  "drawing.clear": "deletion",
  "handout.close": "deletion",
  "handoutDoc.delete": "deletion",
  "encounter.remove": "deletion",
  "encounter.end": "deletion",
  "fog.discard": "deletion",
  "build.clear": "deletion",
  "journal.delete": "deletion",
  "pin.remove": "deletion",
  "roll.close": "deletion",
  "cast.close": "deletion",
  "companionBlock.delete": "deletion",
  "music.stop": "deletion",
  "trap.delete": "deletion",
  "floorLink.delete": "deletion",
  "sound.delete": "deletion",
  "playlist.delete": "deletion",
  "savedEncounter.delete": "deletion",
  "loop.stop": "deletion",
  "sound.stopAll": "deletion",
  "music.pause": "deletion",

  "token.move": "bookkeeping",
  "token.moveMany": "bookkeeping",
  "token.climb": "bookkeeping",
  "token.countLeg": "bookkeeping",
  "token.attach": "bookkeeping",
  "token.detach": "bookkeeping",
  "encounter.next": "bookkeeping",
  "encounter.prev": "bookkeeping",
  "encounter.setValue": "bookkeeping",
  "encounter.setValues": "bookkeeping",
  "encounter.reorder": "bookkeeping",
  "encounter.update": "bookkeeping",
  "actor.hp": "bookkeeping",
  "actor.damageMany": "bookkeeping",
  "actor.outcome": "bookkeeping",
  "actor.life": "bookkeeping",
  "actor.deathSave": "bookkeeping",
  "actor.deathRoll": "bookkeeping",
  "actor.rechargeRoll": "bookkeeping",
  "actor.rest": "bookkeeping",
  "actor.prompt": "bookkeeping",
  "actor.saveDue": "bookkeeping",
  "actor.use": "bookkeeping",
  "actor.effect.add": "bookkeeping",
  "actor.effect.remove": "bookkeeping",
  "actor.effect.update": "bookkeeping",
  "actor.effects": "bookkeeping",
  "dice.roll": "bookkeeping",
  "roll.dice": "bookkeeping",
  "roll.answer": "bookkeeping",
  "roll.change": "bookkeeping",
  "log.chat": "bookkeeping",
  "log.whisper": "bookkeeping",
  "door.set": "bookkeeping",
  "view.follow": "bookkeeping",
  "view.blackout": "bookkeeping",
  "trap.act": "bookkeeping",
  "trap.settle": "bookkeeping",
  "trap.spring": "bookkeeping",
  "clock.start": "bookkeeping",
  "clock.stop": "bookkeeping",
  "clock.set": "bookkeeping",
  "clock.advance": "bookkeeping",
  "scene.reorder": "bookkeeping",
  "scene.setPhase": "bookkeeping",
  "floor.order": "bookkeeping",
  "floor.open": "bookkeeping",
  "music.play": "bookkeeping",
  "music.resume": "bookkeeping",
  "music.skip": "bookkeeping",
  "music.set": "bookkeeping",
  "music.queue": "bookkeeping",
  "music.jump": "bookkeeping",
  "loop.start": "bookkeeping",
  "loop.set": "bookkeeping",
  "sound.mix": "bookkeeping",
  "sound.scene": "bookkeeping",
  "effect.fire": "bookkeeping",

  "token.update": "byField",
  "token.updateMany": "byField",
  "character.update": "byField",
  "template.update": "byField",

  "token.create": "meets",
  "character.create": "meets",
  "companionBlock.create": "meets",
  "template.create": "meets",
  "drawing.create": "meets",
  "encounter.add": "meets",
  "encounter.start": "meets",
  "cast.ask": "meets",
  "monster.create": "meets",
  "scene.create": "meets",
  "scene.duplicate": "meets",
  "journal.create": "meets",
  "handout.show": "meets",
  "handoutDoc.create": "meets",
  "pin.put": "meets",
  "roll.ask": "meets",
  "roll.reopen": "meets",
  "savedEncounter.create": "meets",
  "sound.create": "meets",
  "playlist.create": "meets",
  "playlist.add": "meets",
  "trap.create": "meets",
  "floorLink.put": "meets",
  "companionBlock.update": "meets",
  "monster.update": "meets",
  "monster.setSrdImage": "meets",
  "journal.update": "meets",
  "journal.reveal": "meets",
  "savedEncounter.update": "meets",
  "sound.update": "meets",
  "playlist.update": "meets",
  "trap.update": "meets",
  "floorLink.update": "meets",
  "member.update": "meets",
  "clock.update": "meets",
  "scene.update": "meets",
  "scene.setMap": "meets",
  "scene.setGrid": "meets",
  "room.update": "meets",
  "build.paint": "meets",
  "build.erase": "meets",
  "build.rect": "meets",
  "build.poly": "meets",
  "build.edge": "meets",
  "build.label": "meets",
  "build.walls": "meets",
  "build.stamps": "meets",
  "build.lights": "meets",
  "build.height": "meets",
  "build.stairs": "meets",
  "build.rough": "meets",
  "build.ask": "meets",
  "fog.draft": "meets",
  "fog.publish": "meets",
  "fog.live": "meets",
  "fog.reset": "meets",

  "room.setPlayerScene": "own",
  "vision.holders": "own",

  undo: "restore",
  redo: "restore",
  "sys.restore": "restore",

  "sys.explore": "server",
  "sys.remember": "server",
  "sys.sound": "server",
  "sys.memberJoin": "server",
  "sys.memberSetKind": "server",
  "sys.memberRemove": "server",
  "sys.rideEnd": "server",
  "sys.share": "server",
  "sys.meet": "server",
  "sys.dice": "bookkeeping",
};

/** Actor fields of fixed width, which a `character.update` or `token.update` may change as bookkeeping. */
const FIXED_ACTOR_FIELDS = new Set(["hp", "ac", "speeds", "senses", "initBonus", "passivePerception", "srdId", "wildShape"]);
/** An area's place and size, which a `template.update` may change as bookkeeping. */
const AREA_POSE_FIELDS = new Set(["origin", "faceOffset", "anchor", "yaw", "pitch", "size", "width", "height"]);

function fixedActorOnly(patch: object): boolean {
  const keys = Object.keys(patch);
  if (keys.length !== 1 || keys[0] !== "actor") return false;
  const actor = (patch as { actor?: unknown }).actor;
  return actor !== null && typeof actor === "object" && Object.keys(actor).every((field) => FIXED_ACTOR_FIELDS.has(field));
}

/**
 * How `op` meets the far line: `exempt`, `meets`, `own` (its own rule), or
 * `restore`, which the caller judges as the kind of what the step brings
 * back, so a restored drawing meets its seat and the line and a move's
 * undo is exempt.
 */
export function farRule(op: Op): "exempt" | "meets" | "own" | "restore" {
  const treatment = FAR_TREATMENT[op.t];
  switch (treatment) {
    case "deletion":
    case "bookkeeping":
    case "server":
      return "exempt";
    case "meets":
    case "own":
    case "restore":
      return treatment;
    case "byField":
      return byFieldExempt(op) ? "exempt" : "meets";
  }
}

function byFieldExempt(op: Op): boolean {
  switch (op.t) {
    case "token.update": {
      const { patch } = op;
      return isPoseOp(op) || fixedActorOnly(patch);
    }
    case "token.updateMany":
      return fixedActorOnly(op.patch);
    case "character.update":
      return fixedActorOnly(op.patch);
    case "template.update":
      return Object.keys(op.patch).every((field) => AREA_POSE_FIELDS.has(field));
    default:
      return false;
  }
}
