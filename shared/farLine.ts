import { readEntity } from "./keys.ts";
import type { LimitKind } from "./limits.ts";
import type { RoomState, Token } from "./model.ts";
import { isPoseOp, type Op, type OpType } from "./protocol.ts";
import { keepNumbering } from "./reducer/numbering.ts";

/**
 * How each op type meets the far line (shared/limits.ts FAR,
 * docs/design/design-v1-player-limits.md 5.4). Deletions free or stop, and
 * never meet a line. Bookkeeping writes fields of fixed width, rows of a
 * ring or lists with their own caps, so it is exempt by kind from the
 * counts, and in bytes goes on past where creates stop into the reserve
 * kept for it (shared/limits.ts BOOKKEEPING_RESERVE) up to the line itself. `byField` types carry bookkeeping and
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
  "fall.settle": "bookkeeping",
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
  "sys.shed": "server",
  "sys.meet": "server",
  "sys.dice": "bookkeeping",
};

/** Actor fields of fixed width, which a `character.update` or `token.update` may change as bookkeeping. */
const FIXED_ACTOR_FIELDS = new Set(["hp", "ac", "speeds", "senses", "initBonus", "passivePerception", "srdId", "wildShape"]);
/** An area's place and size, which a `template.update` may change as bookkeeping. */
const AREA_POSE_FIELDS = new Set(["origin", "faceOffset", "anchor", "yaw", "pitch", "size", "width", "height"]);

/**
 * The switches that hide or show a creature, an area or a creature's name,
 * or lock a creature (D-261122-041, 042, 050), which a `token.update`,
 * `token.updateMany` or `template.update` of them alone changes as
 * bookkeeping. Each is stored whatever its state, one byte apart, and a
 * player's exact part counts the thing at the same width either way, so a
 * toggle adds no entity and leaves every player's widths as they were
 * (server/rooms/sizeGuard.toggles.test.ts). A shown creature comes into the
 * exact part of a player who may move any or apply damage as any creature
 * coming into sight does, at a width the room keeps for every creature
 * (shared/limits.ts keptForPlayers). A name shown moves it from what the
 * copy hides to what it holds, which changes no width.
 */
const TOGGLE_FIELDS = new Set(["visibility", "locked", "nameHidden"]);

function fixedActorOnly(patch: object): boolean {
  const keys = Object.keys(patch);
  if (keys.length !== 1 || keys[0] !== "actor") return false;
  const actor = (patch as { actor?: unknown }).actor;
  return actor !== null && typeof actor === "object" && Object.keys(actor).every((field) => FIXED_ACTOR_FIELDS.has(field));
}

function togglesOnly(patch: object): boolean {
  const keys = Object.keys(patch);
  return keys.length > 0 && keys.every((field) => TOGGLE_FIELDS.has(field));
}

/**
 * Whether a restore puts back only toggles (TOGGLE_FIELDS): each entry a
 * creature or an area `state` holds, with its value as the restore writes
 * it equal to the stored one but in those fields and its rev, or the fight
 * with only its rows' `hidden` and its rev apart, every row in its place
 * (D-261122-043), as a show in a fight also shows the creature's row. A
 * creature's number is read as the reducer writes it (keepNumbering), so a
 * meeting that numbered it since leaves the undo of its hide a toggle. So
 * the undo of a hide is bookkeeping as the show is. Anything else it puts
 * back, or a thing changed since, meets the line as before.
 */
export function restoresToggles(op: Op, state: RoomState): boolean {
  if (op.t !== "sys.restore" || op.entries.length === 0) return false;
  return op.entries.every(({ key, value }) => {
    const stored = readEntity(state, key);
    if (key === "encounter") return sameButHiddenRows(value, stored);
    if (key.startsWith("template:")) return sameBut(value, stored, TOGGLED);
    if (!key.startsWith("token:") || !isRecord(value) || !isRecord(stored)) return false;
    return sameBut(keepNumbering(state, value as Token, stored as Token), stored, TOGGLED);
  });
}

/** What a toggle's restore may change on a creature or an area: the toggles and the rev every write steps. */
const TOGGLED: ReadonlySet<string> = new Set(["rev", ...TOGGLE_FIELDS]);
const FIGHT_TOGGLED: ReadonlySet<string> = new Set(["rev", "entries"]);
const ROW_TOGGLED: ReadonlySet<string> = new Set(["hidden"]);

function sameButHiddenRows(restored: unknown, stored: unknown): boolean {
  if (!isRecord(restored) || !isRecord(stored) || !sameBut(restored, stored, FIGHT_TOGGLED)) return false;
  const [ours, theirs] = [restored.entries, stored.entries];
  if (!Array.isArray(ours) || !Array.isArray(theirs) || ours.length !== theirs.length) return false;
  // Each row against the one in its place, its id compared with the rest, so the order and the rows are as stored.
  return theirs.every((row, i) => sameBut(ours[i], row, ROW_TOGGLED));
}

/** Whether two things hold the same fields with the same values, but those in `ignored`. */
function sameBut(restored: unknown, stored: unknown, ignored: ReadonlySet<string>): boolean {
  if (!isRecord(restored) || !isRecord(stored)) return false;
  const fields = (thing: Record<string, unknown>) => Object.keys(thing).filter((field) => !ignored.has(field));
  const theirs = fields(stored);
  return fields(restored).length === theirs.length && theirs.every((field) => Object.hasOwn(restored, field) && JSON.stringify(restored[field]) === JSON.stringify(stored[field]));
}

const isRecord = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);

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
      return isPoseOp(op) || fixedActorOnly(patch) || togglesOnly(patch);
    }
    case "token.updateMany":
      return fixedActorOnly(op.patch) || togglesOnly(op.patch);
    case "character.update":
      return fixedActorOnly(op.patch);
    case "template.update":
      return Object.keys(op.patch).every((field) => AREA_POSE_FIELDS.has(field)) || togglesOnly(op.patch);
    default:
      return false;
  }
}

/** The op types that can put a thing into a seat's class: creates of tokens, areas, drawings and rows, an area attached or detached, and restores. */
const SEAT_TYPES: ReadonlySet<OpType> = new Set<OpType>(["token.create", "template.create", "template.update", "drawing.create", "encounter.add", "undo", "redo", "sys.restore"]);

/**
 * The kind the live limits judge an op as (shared/limits.ts admitLimits).
 * `restoresMove` says a restore takes back or brings back a move, which is
 * bookkeeping as the move was. Any other restore meets the line as what it
 * brings back would.
 */
export function opKind(op: Op, restoresMove = false): LimitKind {
  const rule = farRule(op);
  const far = FAR_TREATMENT[op.t] === "deletion" ? "deletion" : rule === "exempt" || (rule === "restore" && restoresMove) ? "exempt" : "meets";
  return { far, seats: SEAT_TYPES.has(op.t) };
}
