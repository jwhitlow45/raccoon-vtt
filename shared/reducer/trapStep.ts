import { chunkKey, doorChunk, keys } from "../keys.ts";
import { LIMITS } from "../limits.ts";
import type { RoomState, Token, Trap, TrapDoorRef, TrapDue, Viewer } from "../model.ts";
import type { Op, OpOf } from "../protocol.ts";
import { armedTraps, planDoor, planHand, planTrapMove, planTurn, setsOff, standsOn as standsOnTrap, trapHits, trapsLiveOn, walkOp, type Springing, type TrapRoom } from "../rules/traps.ts";
import { inSightOfNonOwners, seenByNonOwners } from "../project.ts";
import { playersToken } from "../players.ts";
import { pressChangesNothing } from "./encounter.ts";
import { addDue, belowOpens, dmLine, orderedBy, PIT_ACTION, pitOpens, plainList, playersLine, runActions } from "./traps.ts";
import { gone, Refuse, type Env, type Tx } from "./tx.ts";
import type { Landing } from "./falls.ts";
import { ownEntry } from "../records.ts";

/*
 * The trap step (docs/design/design-v1-traps.md 5 and 13.2): what sets traps off
 * in an op, planned from the room before it and the op alone, and what
 * they write once dispatch has moved everything. The plan reads only the
 * op and stored state, so replay and every server plan the same.
 */

/** What the trap step planned before dispatch: the op dispatch moves, with its stopped landings, and the springings found so far. */
export type TrapPlan = { op: Op; before: Springing[] };

/**
 * What the trap step wrote: whether it wrote anything, after which the
 * reducer asks whether it changed what the op's player sees (6.5), and
 * whether a pit opened, after which attach's link pass runs again (13.2).
 */
export type TrapWrites = { wrote: boolean; pit?: true };

/**
 * Before dispatch (13.2 step 1): a walk's both passes, which may rewrite
 * its landing and route, and the turn that ends in an `encounter.next`, on
 * the room before it.
 */
export function planBefore(op: Op, before: RoomState, actor: Viewer, env: Env): TrapPlan {
  if (walkOp(op)) {
    try {
      const plan = planTrapMove(op, before as TrapRoom, actor, env, (trap) => (trap.rig?.below === true ? belowOpens(before, trap) : pitOpens(before, trap)));
      return { op: plan.op, before: plan.springings };
    } catch (err) {
      // An op the move rules refuse is dispatch's to refuse, in its own words.
      if (err instanceof Refuse) return { op, before: [] };
      throw err;
    }
  }
  if (op.t === "encounter.next" && !pressChangesNothing(before, actor, op, env)) {
    const encounter = before.encounter;
    const ending = encounter?.entries.find((e) => e.id === encounter.activeEntryId);
    if (ending?.tokenId !== undefined) return { op, before: planTurn(before as TrapRoom, ending.tokenId, "turnEnd", env) };
  }
  return { op, before: [] };
}

/**
 * After dispatch: the turn that starts, on the room after it started, once
 * the `nextTurn` traps are armed again, and a door opened by a creature, on
 * the room after it opened. Then the writes of every springing in order
 * (5.7): the turn that ended first, the arming, then the rest.
 */
export function trapStep(tx: Tx, op: Op, before: RoomState, plan: TrapPlan): TrapWrites {
  const env = tx.env;
  const out: TrapWrites = { wrote: false };
  const started = turnStarted(tx, op);
  let rest: Springing[] = [];
  if (started !== null) {
    // The turn's own test sees the room with its nextTurn traps armed again, the ending turn's springings counted (5.4).
    const traps = { ...tx.state.traps };
    for (const s of plan.before) {
      const t = ownEntry(traps, s.trap.id);
      if (t && writesTrap(s, tx.actor)) traps[t.id] = sprungOf(t);
    }
    for (const [id, t] of Object.entries(traps)) if (rearms(t)) traps[id] = { ...t, state: "armed" };
    rest = planTurn({ ...tx.state, traps }, started, "turnStart", env);
  } else if (op.t === "door.set" && op.by !== undefined && op.state === "open" && doorWasShut(before, op.sceneId, op.door)) {
    rest = planDoor(before, tx.state as TrapRoom, op.sceneId, op.door, op.by, env);
  }
  for (const s of plan.before) write(tx, s, out);
  if (started !== null) armNextTurn(tx);
  for (const s of rest) write(tx, s, out);
  // Outside a fight a nextTurn trap arms again at the end of the op that set it off (5.4).
  if (!tx.state.encounter) for (const s of [...plan.before, ...rest]) rearmNow(tx, s.trap.id);
  if (op.t === "encounter.end") armNextTurn(tx);
  return out;
}

/** The DM's Set it off (6.2): whatever its state and wherever it is, for the creatures named, as a DM op's springing. */
export function trapSpring(tx: Tx, op: OpOf<"trap.spring">): void {
  const trap = ownEntry(tx.state.traps, op.trapId);
  if (!trap) throw gone("trap");
  const tokenIds = op.tokenIds.filter((id) => ownEntry(tx.state.tokens, id)?.sceneId === trap.sceneId);
  const out: TrapWrites = { wrote: false };
  write(tx, planHand(tx.state as TrapRoom, trap, tokenIds, tx.env), out);
  if (!tx.state.encounter) rearmNow(tx, trap.id);
}

/**
 * The creature whose turn this op started, or null: a Next, or a removal
 * that passed the turn on. Previous and undo start none, and neither do the
 * server's own explore, remember, music and meet ops, whatever their version.
 * Those take the room count as it stands (tx.ts Env.uncounted), which can
 * be the Next's own number, so the number alone would read them as the op
 * that started the turn and set its turn-start traps off again. Before op
 * version 57 they took a number of their own, never a Next's, so leaving
 * them out by type changes no stored room.
 */
function turnStarted(tx: Tx, op: Op): string | null {
  if (op.t === "encounter.prev" || op.t === "sys.restore" || op.t === "sys.explore" || op.t === "sys.remember" || op.t === "sys.sound" || op.t === "sys.meet" || op.t === "sys.rideEnd" || op.t === "sys.share") return null;
  const encounter = tx.state.encounter;
  const start = encounter?.turnStart;
  if (!encounter || !start || start.seq !== tx.env.seq || start.entryId !== encounter.activeEntryId) return null;
  return start.tokenId;
}

function doorWasShut(state: RoomState, sceneId: string, ref: TrapDoorRef): boolean {
  const { cx, cy } = doorChunk(ref);
  const chunk = ownEntry(state.buildChunks, chunkKey(sceneId, cx, cy));
  const feature = "edge" in ref ? chunk?.edges[ref.edge] : chunk?.walls?.find((w) => w.id === ref.id)?.f;
  return feature?.kind === "door" && feature.state !== "open";
}

/** Whether a springing goes off as the trap is set: every public one, and a private one in the DM's own op (5.5). */
function writesTrap(s: Springing, actor: Viewer): boolean {
  return s.pass === "public" || actor.role === "dm";
}

function sprungOf(trap: Trap): Trap {
  const rig = trap.rig!;
  return { ...trap, state: "sprung", rig: rig.usesLeft !== undefined ? { ...rig, usesLeft: Math.max(0, rig.usesLeft - 1) } : rig };
}

/** A sprung trap that arms again at a turn's start: `nextTurn`, with a use left or no limit. */
function rearms(trap: Trap): boolean {
  return trap.state === "sprung" && trap.rig?.resets === "nextTurn" && trap.rig.usesLeft !== 0;
}

function armNextTurn(tx: Tx): void {
  for (const trap of Object.values(tx.state.traps ?? {}).sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))) {
    if (rearms(trap)) tx.write(keys.trap(trap.id), { ...trap, state: "armed" });
  }
}

function rearmNow(tx: Tx, trapId: string): void {
  const trap = ownEntry(tx.state.traps, trapId);
  if (trap && rearms(trap)) tx.write(keys.trap(trap.id), { ...trap, state: "armed" });
}

/**
 * One springing's writes (5.7, 6.3). A private one in a player's op writes
 * only what no public rule reads, a hidden occurrence and the DM's line,
 * and nothing while the trap holds a hidden occurrence already. Every other
 * goes off as the trap is set: its actions in their listed order, sprung
 * with a use spent, found when players perceived it, the DM's line, the
 * players' line when perceived, and an occurrence when it has a save,
 * damage or conditions, marked done since its actions ran.
 */
function write(tx: Tx, s: Springing, out: TrapWrites): void {
  const trap = ownEntry(tx.state.traps, s.trap.id);
  const rig = trap?.rig;
  if (!trap || !rig) return;
  out.wrote = true;
  const shown = (id: string) => s.party.has(id) || s.seen.has(id);
  const by = orderedBy(s.by, shown);
  const hits = plainList([...s.hits].sort(), LIMITS.trapHits);
  const occurrence = (id: string, flags: Pick<TrapDue, "perceived" | "hidden" | "acted">): TrapDue => ({
    id,
    at: tx.env.at,
    how: s.how,
    by: by.list,
    ...(by.more > 0 ? { more: by.more } : {}),
    hits: hits.list,
    ...(hits.more > 0 ? { hitsMore: hits.more } : {}),
    ...flags,
  });
  if (!writesTrap(s, tx.actor)) {
    if (rig.due?.some((d) => d.hidden)) return;
    const line = dmLine(tx, trap, { how: s.how, by: by.list, more: by.more, hits: s.hits.length, did: [], seen: s.seen, hidden: true });
    addDue(tx, trap.id, occurrence(line.id, { hidden: true }));
    return;
  }
  const did = runActions(tx, trap);
  // A trapdoor's drop runs its own link pass (shared/reducer.ts 4.3 step 8), so only a pit asks for this one.
  if (rig.below !== true && did.some((d) => d.action === PIT_ACTION && d.ok)) out.pit = true;
  const perceived = s.pass === "public" && s.perceived;
  const next = sprungOf(ownEntry(tx.state.traps, trap.id) ?? trap);
  const found = perceived && rig.foundOnSpring === true && !trap.found;
  if (found) next.found = true;
  tx.write(keys.trap(trap.id), next);
  const line = dmLine(tx, next, { how: s.how, by: by.list, more: by.more, hits: s.hits.length, did, seen: s.seen, hidden: false });
  if (perceived) playersLine(tx, next, by.list.filter((id) => s.seen.has(id)));
  if (rig.save || rig.damage || rig.conditions) addDue(tx, trap.id, occurrence(line.id, { ...(perceived ? { perceived: true as const } : {}), acted: true }));
}

/**
 * The arrival step (docs/design/design-v1-floors.md phase 4, 6, 4.3 step
 * 6), once an op from version 64: each creature's last landing sets off
 * every armed trap on the landing floor whose squares its space overlaps
 * and whose rig goes off on `enter`, by `who`, `minSize` and `floor`, as a
 * walk's would, so a flier landing in the air sets off no floor trap. On
 * live floors only, as every trap (rules/traps.ts trapsLiveOn). Who sets a
 * trap off together goes off in one springing, public where every player
 * saw them before the op, as a walk's public pass reads them, else in the
 * private pass, and written by `write` as a walk's springings are. Two
 * traps go off by floor, then trap id. A trapdoor it springs drops at once.
 * Null where nothing goes off.
 */
export function arrivalStep(tx: Tx, before: RoomState, landings: readonly Landing[]): TrapWrites | null {
  const last = new Map<string, Landing>();
  for (const landing of landings) {
    last.delete(landing.tokenId);
    last.set(landing.tokenId, landing);
  }
  if (last.size === 0) return null;
  const room = tx.state as TrapRoom;
  const seenBefore = (id: string) => {
    const token = ownEntry(before.tokens, id);
    return token !== undefined && inSightOfNonOwners(before, token, tx.env);
  };
  const springings: Springing[] = [];
  for (const sceneId of [...new Set([...last.values()].map((l) => l.sceneId))].sort()) {
    if (!trapsLiveOn(room, sceneId)) continue;
    const landers = [...last.values()]
      .filter((l) => l.sceneId === sceneId)
      .map((l) => ownEntry(room.tokens, l.tokenId))
      .filter((t): t is Token => t !== undefined && t.sceneId === sceneId)
      .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    for (const trap of armedTraps(room.traps ?? {}, sceneId)) {
      const rig = trap.rig!;
      if (!rig.on.includes("enter") || !("cells" in trap.zone)) continue;
      const on = landers.filter((t) => setsOff(rig, room, t) && standsOnTrap(room, trap, t, seenBefore));
      const shown = on.filter((t) => seenBefore(t.id));
      const pass = shown.length > 0 ? "public" : "private";
      const by = (pass === "public" ? shown : on).map((t) => t.id);
      if (by.length > 0) springings.push(arrival(trap, pass, by, room, tx.env));
    }
  }
  if (springings.length === 0) return null;
  const out: TrapWrites = { wrote: false };
  for (const s of springings) write(tx, s, out);
  if (!tx.state.encounter) for (const s of springings) rearmNow(tx, s.trap.id);
  return out;
}

/** An arrival's springing at the room it landed in, as rules/traps.ts springingAt makes a turn's. */
function arrival(trap: Trap, pass: "public" | "private", by: string[], room: RoomState, env: Env): Springing {
  const seen = new Set<string>();
  const party = new Set<string>();
  for (const id of by) {
    const token = ownEntry(room.tokens, id);
    if (!token) continue;
    if (seenByNonOwners(room, token, env)) seen.add(id);
    if (playersToken(room, token)) party.add(id);
  }
  return { trap, how: "enter", pass, by, hits: trapHits(trap, room, by, env.opVersion), perceived: pass === "public" && seen.size > 0, seen, party };
}
