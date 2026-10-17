import type { EntityKey } from "./keys.ts";
import type { LogEntry, RoomState, Viewer } from "./model.ts";
import type { Op, RefusalCode, RestoreEntry } from "./protocol.ts";
import {
  actorDamageMany,
  actorDeathSave,
  actorHp,
  actorLife,
  actorRest,
  effectAdd,
  effectRemove,
  effectUpdate,
} from "./reducer/actors.ts";
import { remindAfter, remindTurnEnd } from "./reducer/areaTriggers.ts";
import {
  encounterAdd,
  encounterEnd,
  encounterNext,
  encounterPrev,
  encounterRemove,
  encounterReorder,
  encounterSetValue,
  encounterSetValues,
  encounterStart,
  encounterUpdate,
  pressChangesNothing,
} from "./reducer/encounter.ts";
import {
  buildClear,
  buildEdge,
  buildErase,
  buildLabel,
  buildLights,
  buildPaint,
  buildPoly,
  buildRect,
  buildStamps,
  buildWalls,
  doorSet,
  fogDiscard,
  fogDraft,
  fogLive,
  fogPublish,
  fogReset,
  sysExplore,
} from "./reducer/map.ts";
import { buildHeight, buildStairs } from "./reducer/heights.ts";
import { sceneDuplicate } from "./reducer/duplicate.ts";
import { journalCreate, journalDelete, journalReveal, journalUpdate } from "./reducer/journal.ts";
import { actorEffects, tokenDeleteMany, tokenUpdateMany } from "./reducer/many.ts";
import { pinPut, pinRemove } from "./reducer/pins.ts";
import { rollAnswer, rollAsk, rollClose, rollReopen } from "./reducer/rolls.ts";
import { sysDice } from "./reducer/dice.ts";
import { handoutClose, handoutDocCreate, handoutDocDelete, handoutShow, logChat, logWhisper, restore } from "./reducer/misc.ts";
import { sceneSetPhase } from "./reducer/phases.ts";
import { monsterCreate, monsterDelete, monsterSetSrdImage, monsterUpdate } from "./reducer/monsters.ts";
import { companionBlockCreate, companionBlockDelete, companionBlockUpdate } from "./reducer/companionBlocks.ts";
import { savedEncounterCreate, savedEncounterDelete, savedEncounterUpdate } from "./reducer/savedEncounters.ts";
import {
  memberUpdate,
  roomSetPlayerScene,
  roomUpdate,
  sceneCreate,
  sceneDelete,
  sceneReorder,
  sceneSetGrid,
  sceneSetMap,
  sceneUpdate,
  sysMemberJoin,
  sysMemberRemove,
  sysMemberSetKind,
  viewBlackout,
  viewFollow,
} from "./reducer/room.ts";
import {
  characterCreate,
  characterDelete,
  characterUpdate,
  drawingClear,
  drawingCreate,
  drawingDelete,
  templateCreate,
  templateDelete,
  templateUpdate,
  tokenCreate,
  tokenDelete,
  tokenMove,
  tokenCountLeg,
  tokenMoveMany,
  tokenUpdate,
} from "./reducer/tokens.ts";
import { Refuse, Tx, invalid, type Env } from "./reducer/tx.ts";

export type { Env } from "./reducer/tx.ts";
export { MAX_LOG } from "./reducer/tx.ts";

export type Applied = {
  ok: true;
  state: RoomState;
  /** Every entity key the op wrote, in order, including log entries it added or trimmed. */
  touched: EntityKey[];
  /** Design 7.2 step 8: the fan-out must re-project everything in scope. */
  global: boolean;
  log: LogEntry[];
  /** The absolute restore that undoes the op, or null when nothing undoable changed. */
  inverse: RestoreEntry[] | null;
};

export type Refusal = { ok: false; code: RefusalCode; message: string };
export type ApplyResult = Applied | Refusal;

/**
 * The one reducer (design section 2): pure and deterministic. The same state,
 * op, actor and envelope always give the same result. Time and derived ids
 * come only from `env`, the input state is never mutated, and the only
 * commands the server has to resolve first (undo and redo) are refused here
 * so a stray one can never reach the log.
 */
export function applyOp(state: RoomState, op: Op, actor: Viewer, env: Env): ApplyResult {
  const tx = new Tx(state, actor, env);
  try {
    // Areas that hit a creature again remind the table around the op itself (reducer/areaTriggers.ts).
    if (op.t === "encounter.next" && !pressChangesNothing(state, actor, op, env)) remindTurnEnd(tx);
    dispatch(tx, op);
    remindAfter(tx, state, op);
    tx.finish();
  } catch (err) {
    if (err instanceof Refuse) return { ok: false, code: err.code, message: err.message };
    throw err;
  }
  // The inverse hashes every entity the op touched (Tx.inverse), and only the
  // server's undo stack reads it. The client replays its pending ops on every
  // update and never does, so it is worked out on first read.
  let inverse: RestoreEntry[] | null | undefined;
  return {
    ok: true,
    state: tx.state,
    touched: tx.touched(),
    global: tx.global,
    log: tx.log,
    get inverse() {
      if (inverse === undefined) inverse = tx.inverse();
      return inverse;
    },
  };
}

function dispatch(tx: Tx, op: Op): void {
  switch (op.t) {
    case "room.update":
      return roomUpdate(tx, op);
    case "room.setPlayerScene":
      return roomSetPlayerScene(tx, op);
    case "view.follow":
      return viewFollow(tx, op);
    case "view.blackout":
      return viewBlackout(tx, op);
    case "member.update":
      return memberUpdate(tx, op);
    case "scene.create":
      return sceneCreate(tx, op);
    case "scene.update":
      return sceneUpdate(tx, op);
    case "scene.delete":
      return sceneDelete(tx, op);
    case "scene.reorder":
      return sceneReorder(tx, op);
    case "scene.setMap":
      return sceneSetMap(tx, op);
    case "scene.setGrid":
      return sceneSetGrid(tx, op);
    case "scene.setPhase":
      return sceneSetPhase(tx, op);
    case "scene.duplicate":
      return sceneDuplicate(tx, op);
    case "token.create":
      return tokenCreate(tx, op);
    case "token.update":
      return tokenUpdate(tx, op);
    case "token.delete":
      return tokenDelete(tx, op);
    case "token.move":
      return tokenMove(tx, op);
    case "token.moveMany":
      return tokenMoveMany(tx, op);
    case "token.countLeg":
      return tokenCountLeg(tx, op);
    case "actor.hp":
      return actorHp(tx, op);
    case "actor.damageMany":
      return actorDamageMany(tx, op);
    case "actor.deathSave":
      return actorDeathSave(tx, op);
    case "actor.life":
      return actorLife(tx, op);
    case "actor.rest":
      return actorRest(tx, op);
    case "actor.effect.add":
      return effectAdd(tx, op);
    case "actor.effect.update":
      return effectUpdate(tx, op);
    case "actor.effect.remove":
      return effectRemove(tx, op);
    case "character.create":
      return characterCreate(tx, op);
    case "character.update":
      return characterUpdate(tx, op);
    case "character.delete":
      return characterDelete(tx, op);
    case "monster.create":
      return monsterCreate(tx, op);
    case "monster.update":
      return monsterUpdate(tx, op);
    case "monster.delete":
      return monsterDelete(tx, op);
    case "monster.setSrdImage":
      return monsterSetSrdImage(tx, op);
    case "companionBlock.create":
      return companionBlockCreate(tx, op);
    case "companionBlock.update":
      return companionBlockUpdate(tx, op);
    case "companionBlock.delete":
      return companionBlockDelete(tx, op);
    case "savedEncounter.create":
      return savedEncounterCreate(tx, op);
    case "savedEncounter.update":
      return savedEncounterUpdate(tx, op);
    case "savedEncounter.delete":
      return savedEncounterDelete(tx, op);
    case "template.create":
      return templateCreate(tx, op);
    case "template.update":
      return templateUpdate(tx, op);
    case "template.delete":
      return templateDelete(tx, op);
    case "drawing.create":
      return drawingCreate(tx, op);
    case "drawing.delete":
      return drawingDelete(tx, op);
    case "drawing.clear":
      return drawingClear(tx, op);
    case "fog.draft":
      return fogDraft(tx, op);
    case "fog.publish":
      return fogPublish(tx, op);
    case "fog.discard":
      return fogDiscard(tx, op);
    case "fog.live":
      return fogLive(tx, op);
    case "fog.reset":
      return fogReset(tx, op);
    case "build.paint":
      return buildPaint(tx, op);
    case "build.erase":
      return buildErase(tx, op);
    case "build.rect":
      return buildRect(tx, op);
    case "build.poly":
      return buildPoly(tx, op);
    case "build.edge":
      return buildEdge(tx, op);
    case "build.label":
      return buildLabel(tx, op);
    case "build.clear":
      return buildClear(tx, op);
    case "build.walls":
      return buildWalls(tx, op);
    case "build.stamps":
      return buildStamps(tx, op);
    case "build.lights":
      return buildLights(tx, op);
    case "build.height":
      return buildHeight(tx, op);
    case "build.stairs":
      return buildStairs(tx, op);
    case "door.set":
      return doorSet(tx, op);
    case "encounter.start":
      return encounterStart(tx, op);
    case "encounter.end":
      return encounterEnd(tx);
    case "encounter.add":
      return encounterAdd(tx, op);
    case "encounter.remove":
      return encounterRemove(tx, op);
    case "encounter.setValue":
      return encounterSetValue(tx, op);
    case "encounter.setValues":
      return encounterSetValues(tx, op);
    case "encounter.reorder":
      return encounterReorder(tx, op);
    case "encounter.next":
      return encounterNext(tx, op);
    case "encounter.prev":
      return encounterPrev(tx, op);
    case "encounter.update":
      return encounterUpdate(tx, op);
    case "log.chat":
      return logChat(tx, op);
    case "log.whisper":
      return logWhisper(tx, op);
    case "handout.show":
      return handoutShow(tx, op);
    case "handout.close":
      return handoutClose(tx, op);
    case "handoutDoc.create":
      return handoutDocCreate(tx, op);
    case "handoutDoc.delete":
      return handoutDocDelete(tx, op);
    case "sys.memberJoin":
      return sysMemberJoin(tx, op);
    case "sys.memberSetKind":
      return sysMemberSetKind(tx, op);
    case "sys.memberRemove":
      return sysMemberRemove(tx, op);
    case "sys.restore":
      return restore(tx, op);
    case "sys.explore":
      return sysExplore(tx, op);
    case "token.updateMany":
      return tokenUpdateMany(tx, op);
    case "token.deleteMany":
      return tokenDeleteMany(tx, op);
    case "actor.effects":
      return actorEffects(tx, op);
    case "journal.create":
      return journalCreate(tx, op);
    case "journal.update":
      return journalUpdate(tx, op);
    case "journal.reveal":
      return journalReveal(tx, op);
    case "journal.delete":
      return journalDelete(tx, op);
    case "pin.put":
      return pinPut(tx, op);
    case "pin.remove":
      return pinRemove(tx, op);
    case "roll.ask":
      return rollAsk(tx, op);
    case "roll.answer":
      return rollAnswer(tx, op);
    case "roll.reopen":
      return rollReopen(tx, op);
    case "roll.close":
      return rollClose(tx, op);
    case "sys.dice":
      return sysDice(tx, op);
    case "undo":
    case "redo":
    // The server rolls (docs/design-v1-dice.md 4.2): the actor stores the `sys.dice` it resolves in place of each.
    case "dice.roll":
    case "roll.dice":
    case "actor.deathRoll":
      throw invalid(`${op.t} is resolved by the server before it reaches the reducer`);
  }
}
