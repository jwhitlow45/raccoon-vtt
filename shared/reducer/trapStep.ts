import { chunkKey, doorChunk, keys } from "../keys.ts";
import { LIMITS } from "../limits.ts";
import type { RoomState, Trap, TrapDoorRef, TrapDue, Viewer } from "../model.ts";
import type { Op, OpOf } from "../protocol.ts";
import { planDoor, planHand, planTrapMove, planTurn, walkOp, type Springing, type TrapRoom } from "../rules/traps.ts";
import { pressChangesNothing } from "./encounter.ts";
import { addDue, dmLine, orderedBy, PIT_ACTION, plainList, playersLine, runActions } from "./traps.ts";
import { gone, Refuse, type Env, type Tx } from "./tx.ts";

/*
 * The trap step (docs/design-v1-traps.md 5 and 13.2): what sets traps off
 * in an op, planned from the room before it and the op alone, and what
 * they write once dispatch has moved everything. The plan reads only the
 * op and stored state, so replay and every server plan the same.
 */

/** What the trap step planned before dispatch: the op dispatch moves, with its stopped landings, and the springings found so far. */
export type TrapPlan = { op: Op; before: Springing[] };

/**
 * What the trap step wrote: whether a public springing stopped a token or
 * told its players, which marks a player's undo step (6.5), and whether a
 * pit opened, after which attach's link pass runs again (13.2).
 */
export type TrapWrites = { wrote: boolean; trapped: boolean; pit?: true };

/**
 * Before dispatch (13.2 step 1): a walk's both passes, which may rewrite
 * its landing and route, and the turn that ends in an `encounter.next`, on
 * the room before it.
 */
export function planBefore(op: Op, before: RoomState, actor: Viewer, env: Env): TrapPlan {
  if (walkOp(op)) {
    try {
      const plan = planTrapMove(op, before as TrapRoom, actor, env);
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
  const out: TrapWrites = { wrote: false, trapped: false };
  const started = turnStarted(tx, op);
  let rest: Springing[] = [];
  if (started !== null) {
    // The turn's own test sees the room with its nextTurn traps armed again, the ending turn's springings counted (5.4).
    const traps = { ...tx.state.traps };
    for (const s of plan.before) {
      const t = traps[s.trap.id];
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
  const trap = tx.state.traps[op.trapId];
  if (!trap) throw gone("trap");
  const tokenIds = op.tokenIds.filter((id) => tx.state.tokens[id]?.sceneId === trap.sceneId);
  const out: TrapWrites = { wrote: false, trapped: false };
  write(tx, planHand(tx.state as TrapRoom, trap, tokenIds, tx.env), out);
  if (!tx.state.encounter) rearmNow(tx, trap.id);
}

/** The creature whose turn this op started, or null: a Next, or a removal that passed the turn on. Previous and undo start none. */
function turnStarted(tx: Tx, op: Op): string | null {
  if (op.t === "encounter.prev" || op.t === "sys.restore") return null;
  const encounter = tx.state.encounter;
  const start = encounter?.turnStart;
  if (!encounter || !start || start.seq !== tx.env.seq || start.entryId !== encounter.activeEntryId) return null;
  return start.tokenId;
}

function doorWasShut(state: RoomState, sceneId: string, ref: TrapDoorRef): boolean {
  const { cx, cy } = doorChunk(ref);
  const chunk = state.buildChunks[chunkKey(sceneId, cx, cy)];
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
  const trap = tx.state.traps?.[trapId];
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
  const trap = tx.state.traps?.[s.trap.id];
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
  if (did.some((d) => d.action === PIT_ACTION && d.ok)) out.pit = true;
  const perceived = s.pass === "public" && s.perceived;
  const next = sprungOf(tx.state.traps[trap.id] ?? trap);
  if (perceived && rig.foundOnSpring) next.found = true;
  tx.write(keys.trap(trap.id), next);
  const line = dmLine(tx, next, { how: s.how, by: by.list, more: by.more, hits: s.hits.length, did, seen: s.seen, hidden: false });
  const told = perceived && playersLine(tx, next, by.list.filter((id) => s.seen.has(id)));
  if (rig.save || rig.damage || rig.conditions) addDue(tx, trap.id, occurrence(line.id, { ...(perceived ? { perceived: true as const } : {}), acted: true }));
  if (s.pass === "public" && (s.stopped || told)) out.trapped = true;
}
