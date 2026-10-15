import { keys } from "../keys.ts";
import type { Effect, Encounter, EncounterSnapshot, InitEntry, RoomState, Token, TurnStart, Viewer } from "../model.ts";
import type { EntryInput, OpOf } from "../protocol.ts";
import {
  anchorsForEntry,
  bindToEntry,
  crossingsForNext,
  pausedAnchorForEntry,
  tickEffects,
  unbindFromEntry,
} from "../rules/durations.ts";
import { activeRowShownTo, inSightOfNonOwners, rowSeenByNonOwners } from "../project.ts";
import { effectEvent } from "../rules/hp.ts";
import { actorOfEntry, groupKeyFor, nextTurn, placeEntry, renumber, scoredValue, sortEntries, turnMovedOn } from "../rules/initiative.ts";
import { gone, invalid, type Env, type ResolvedActor, type Tx } from "./tx.ts";

/** How many `next` steps `prev` can walk back. */
export const MAX_HISTORY = 20;

function encounterOf(tx: Tx): Encounter {
  const encounter = tx.state.encounter;
  if (!encounter) throw gone("encounter");
  return encounter;
}

function writeEncounter(tx: Tx, encounter: Encounter): void {
  tx.write(keys.encounter, { ...encounter, entries: renumber(sortEntries(encounter.entries)) });
}

/**
 * The encounter with a new active row, and the spot that row's creature
 * stands on as where its turn began (features section 10). A row without a
 * token, or whose token is gone, has no spot.
 */
function withTurn(tx: Tx, encounter: Encounter, activeEntryId: string | null): Encounter {
  const { turnStart: _previous, ...rest } = encounter;
  const next: Encounter = { ...rest, activeEntryId };
  const entry = activeEntryId === null ? undefined : encounter.entries.find((e) => e.id === activeEntryId);
  const token = entry?.tokenId !== undefined ? tx.state.tokens[entry.tokenId] : undefined;
  if (entry && token) {
    // The seq names this turn, so a path recorded during it is told from one of an earlier turn (rules/path.ts).
    const start: TurnStart = { entryId: entry.id, tokenId: token.id, sceneId: token.sceneId, x: token.x, y: token.y, elevation: token.elevation, seq: tx.env.seq };
    if (inSightOfNonOwners(tx.state, token, tx.env)) start.seen = true;
    next.turnStart = start;
  }
  return next;
}

function buildEntry(tx: Tx, input: EntryInput, existing: InitEntry[]): InitEntry {
  if (existing.some((e) => e.id === input.id)) throw invalid("entry already exists");
  let token: Token | undefined;
  if (input.tokenId !== undefined) token = tx.token(input.tokenId);
  if (input.characterId !== undefined) tx.character(input.characterId);
  const entry: InitEntry = {
    id: input.id,
    value: input.value ?? null,
    tieOrder: 0,
    hidden: input.hidden ?? token?.visibility === "dm",
    reactionUsed: false,
    inLair: input.inLair ?? false,
  };
  if (input.tokenId !== undefined) entry.tokenId = input.tokenId;
  if (input.characterId !== undefined) entry.characterId = input.characterId;
  if (input.label !== undefined) entry.label = input.label;
  if (input.advantage !== undefined) entry.advantage = input.advantage;
  const groupKey = input.groupKey ?? groupKeyFor(tx.state, entry);
  if (groupKey !== undefined) entry.groupKey = groupKey;
  // With initiative scores on, a monster enters at 10 + Dex modifier instead of waiting for a typed roll.
  if (entry.value === null && token && token.kind !== "pc") {
    entry.value = scoredValue(actorOfEntry(tx.state, entry), tx.state.meta.settings);
  }
  return entry;
}

/** Binds every paused duration that names the entry's creature to the entry (design 9.5). */
function bindDurations(tx: Tx, entry: InitEntry): void {
  const targets = anchorsForEntry(tx.state, entry);
  if (targets.length === 0) return;
  for (const resolved of tx.actors()) {
    const r = bindToEntry(resolved.actor.effects, entry.id, targets);
    if (r.changed) tx.putActor(resolved, { ...resolved.actor, effects: r.effects });
  }
}

/** Pauses durations anchored to an entry that leaves, logging each so the table knows why a timer stopped. */
function unbindDurations(tx: Tx, entry: InitEntry): void {
  const to = pausedAnchorForEntry(entry);
  for (const resolved of tx.actors()) {
    const r = unbindFromEntry(resolved.actor.effects, entry.id, to);
    if (!r.changed) continue;
    tx.putActor(resolved, { ...resolved.actor, effects: r.effects });
    for (const effect of r.paused) tx.addActorEvents(resolved, [effectEvent(effect, "pause")]);
  }
}

function clearAutoExempt(tx: Tx, tokenId: string | undefined): void {
  if (tokenId === undefined) return;
  const token = tx.state.tokens[tokenId];
  if (token?.fogExemptAuto) tx.write(keys.token(token.id), { ...token, fogExemptAuto: false });
}

export function encounterStart(tx: Tx, op: OpOf<"encounter.start">): void {
  if (tx.state.encounter) throw invalid("an encounter is already running");
  let entries: InitEntry[] = [];
  for (const input of op.entries) {
    const entry = buildEntry(tx, input, entries);
    entries = placeEntry(tx.state, entries, entry);
  }
  writeEncounter(tx, { rev: 0, round: 1, activeEntryId: null, entries });
  for (const entry of entries) bindDurations(tx, entry);
  if (tx.state.encounterHistory.length > 0) tx.write(keys.encounterHistory, []);
  tx.addEvent({ type: "encounter", action: "start" });
}

export function encounterEnd(tx: Tx): void {
  const encounter = encounterOf(tx);
  for (const entry of encounter.entries) unbindDurations(tx, entry);
  for (const token of Object.values(tx.state.tokens).sort((a, b) => (a.id < b.id ? -1 : 1))) {
    clearAutoExempt(tx, token.id);
  }
  tx.write(keys.encounter, null);
  if (tx.state.encounterHistory.length > 0) tx.write(keys.encounterHistory, []);
  tx.addEvent({ type: "encounter", action: "end" });
}

export function encounterAdd(tx: Tx, op: OpOf<"encounter.add">): void {
  const encounter = encounterOf(tx);
  let entries = encounter.entries;
  const added: InitEntry[] = [];
  for (const input of op.entries) {
    const entry = buildEntry(tx, input, entries);
    entries = placeEntry(tx.state, entries, entry);
    added.push(entry);
  }
  writeEncounter(tx, { ...encounter, entries });
  for (const entry of added) bindDurations(tx, entry);
}

/**
 * Removes rows, pausing their durations and dropping the automatic fog
 * exemption their tokens got on reveal. When the active row goes, the turn
 * passes to the row after it without ticking anything. That turn starts as
 * any other does, with its own turn line: the line is where the turn's
 * clock starts and where the areas' once-per-turn window opens.
 */
export function removeEntries(tx: Tx, entryIds: string[]): void {
  const encounter = encounterOf(tx);
  const removing = new Set(entryIds);
  const sorted = sortEntries(encounter.entries);
  for (const id of removing) if (!sorted.some((e) => e.id === id)) throw gone("entry");
  let activeEntryId = encounter.activeEntryId;
  if (activeEntryId !== null && removing.has(activeEntryId)) {
    const index = sorted.findIndex((e) => e.id === activeEntryId);
    activeEntryId = null;
    for (let step = 1; step <= sorted.length; step++) {
      const candidate = sorted[(index + step) % sorted.length]!;
      if (!removing.has(candidate.id)) {
        activeEntryId = candidate.id;
        break;
      }
    }
  }
  const kept = { ...encounter, entries: sorted.filter((e) => !removing.has(e.id)) };
  // A turn passed on by the removal starts where its creature stands now.
  writeEncounter(tx, activeEntryId === encounter.activeEntryId ? kept : withTurn(tx, kept, activeEntryId));
  for (const entry of sorted) {
    if (!removing.has(entry.id)) continue;
    unbindDurations(tx, entry);
    clearAutoExempt(tx, entry.tokenId);
  }
  const landing = activeEntryId !== encounter.activeEntryId ? kept.entries.find((e) => e.id === activeEntryId) : undefined;
  if (landing) tx.addEvent({ type: "turn", entryId: landing.id, round: encounter.round, ...(rowSeenByNonOwners(tx.state, landing, tx.env) ? { seen: true as const } : {}) });
}

export function encounterRemove(tx: Tx, op: OpOf<"encounter.remove">): void {
  removeEntries(tx, op.entryIds);
}

function setValue(tx: Tx, encounter: Encounter, entryId: string, value: number | null): Encounter {
  const entry = encounter.entries.find((e) => e.id === entryId);
  if (!entry) throw gone("entry");
  return { ...encounter, entries: placeEntry(tx.state, encounter.entries, { ...entry, value }) };
}

export function encounterSetValue(tx: Tx, op: OpOf<"encounter.setValue">): void {
  writeEncounter(tx, setValue(tx, encounterOf(tx), op.entryId, op.value));
}

export function encounterSetValues(tx: Tx, op: OpOf<"encounter.setValues">): void {
  let encounter = encounterOf(tx);
  for (const { entryId, value } of op.values) encounter = setValue(tx, encounter, entryId, value);
  writeEncounter(tx, encounter);
}

/** Drag-to-reorder: the listed rows take the given order, and rows left out follow in their current order. */
export function encounterReorder(tx: Tx, op: OpOf<"encounter.reorder">): void {
  const encounter = encounterOf(tx);
  const byId = new Map(encounter.entries.map((e) => [e.id, e]));
  const listed: InitEntry[] = [];
  const seen = new Set<string>();
  for (const id of op.entryIds) {
    if (seen.has(id)) throw invalid("an entry appears twice");
    seen.add(id);
    const entry = byId.get(id);
    if (!entry) throw gone("entry");
    listed.push(entry);
  }
  const rest = sortEntries(encounter.entries).filter((e) => !seen.has(e.id));
  writeEncounter(tx, { ...encounter, entries: renumber([...listed, ...rest]) });
}

export function encounterUpdate(tx: Tx, op: OpOf<"encounter.update">): void {
  const encounter = encounterOf(tx);
  const index = encounter.entries.findIndex((e) => e.id === op.entryId);
  const entry = encounter.entries[index];
  if (!entry) throw gone("entry");
  const next: InitEntry = { ...entry };
  const p = op.patch;
  if (p.hidden !== undefined) next.hidden = p.hidden;
  if (p.reactionUsed !== undefined) next.reactionUsed = p.reactionUsed;
  if (p.inLair !== undefined) next.inLair = p.inLair;
  if (p.advantage === null) delete next.advantage;
  else if (p.advantage !== undefined) next.advantage = p.advantage;
  if (p.label === null) delete next.label;
  else if (p.label !== undefined) next.label = p.label;
  if (p.groupKey === null) delete next.groupKey;
  else if (p.groupKey !== undefined) next.groupKey = p.groupKey;
  const entries = [...encounter.entries];
  entries[index] = next;
  writeEncounter(tx, { ...encounter, entries });
}

function holderId(resolved: ResolvedActor): string {
  return resolved.id;
}

/**
 * Whether a Next or Previous changes nothing (design 9.4): it names a turn
 * already over, or it is a player's guarded press while the acting row is
 * not theirs and in their view. A player's press only ever ends their own
 * turn, and permissions answer every guarded press of a player whose view
 * holds no acting row alike (shared/permissions.ts). So a press must move
 * nothing then, whatever it names: a hidden row's turn, or the player's own
 * row hidden by the DM or on another scene, whose turn their page never
 * shows. Ops without `from` keep the old rules. Whether the acting row is in
 * the player's view follows the op's envelope (activeRowShownTo), so a press
 * stored before op version 4 replays as it applied.
 */
export function pressChangesNothing(state: RoomState, actor: Viewer, op: OpOf<"encounter.next"> | OpOf<"encounter.prev">, env: Env): boolean {
  if (turnMovedOn(state.encounter, op)) return true;
  return op.from !== undefined && actor.role !== "dm" && !(activeRowShownTo(state, actor, env) && ownsActiveRow(state, actor));
}

/** Whether the viewer plays the acting row's creature. Missing owner lists, as a player's projection holds them, count as none. */
function ownsActiveRow(state: RoomState, viewer: Viewer): boolean {
  const encounter = state.encounter;
  const entry = encounter?.entries.find((e) => e.id === encounter.activeEntryId);
  if (!entry) return false;
  const token = entry.tokenId !== undefined ? state.tokens[entry.tokenId] : undefined;
  const ref = entry.characterId ?? (token && "ref" in token.actor ? token.actor.ref : undefined);
  const character = ref !== undefined ? state.characters[ref] : undefined;
  return (token?.ownerIds ?? []).includes(viewer.memberId) || (character?.ownerIds ?? []).includes(viewer.memberId);
}

/**
 * Advances the turn (design 9.4): ticks durations across the boundaries the
 * step crosses, resets the per-turn resources of the row that starts, reveals
 * a hidden combatant on its first turn, and records what it changed so `prev`
 * can put it all back.
 */
export function encounterNext(tx: Tx, op: OpOf<"encounter.next">): void {
  if (pressChangesNothing(tx.state, tx.actor, op, tx.env)) return;
  const encounter = encounterOf(tx);
  const settings = tx.state.meta.settings;
  const step = nextTurn(tx.state, encounter, settings);
  if (!step) throw invalid("the encounter has no combatants");
  const snapshot: EncounterSnapshot = { encounter, effects: {}, revealed: [], at: tx.env.at };

  const entries = encounter.entries.map((e) => (e.id === step.landing ? { ...e, reactionUsed: false } : e));
  const landing = entries.find((e) => e.id === step.landing)!;

  // The reveal comes before the durations tick: expiry lines are stamped
  // seen or not from the state when they are written, and a creature this
  // turn reveals has its expiries marked as its turn line is, seen where
  // players see it stand.
  if (landing.hidden && settings.revealHiddenOnTurn) {
    landing.hidden = false;
    if (landing.tokenId !== undefined) {
      const token = tx.state.tokens[landing.tokenId];
      if (token) {
        snapshot.revealed.push({ tokenId: token.id, visibility: token.visibility, fogExemptAuto: token.fogExemptAuto });
        tx.write(keys.token(token.id), { ...token, visibility: "all", fogExemptAuto: true });
      }
    }
  }

  const crossings = crossingsForNext(encounter, step.skipped, step.landing);
  for (const resolved of tx.actors()) {
    const r = tickEffects(resolved.actor.effects, crossings);
    if (!r.changed) continue;
    snapshot.effects[holderId(resolved)] = resolved.actor.effects;
    tx.putActor(resolved, { ...resolved.actor, effects: r.effects });
    for (const effect of r.expired) tx.addActorEvents(resolved, [effectEvent(effect, "expire")]);
  }

  const landingActor = landing.tokenId !== undefined
    ? tx.tryResolveActor({ tokenId: landing.tokenId })
    : landing.characterId !== undefined
      ? tx.tryResolveActor({ characterId: landing.characterId })
      : undefined;
  if (landingActor?.actor.legendary && landingActor.actor.legendary.actionsUsed !== 0) {
    snapshot.legendary = { holderId: holderId(landingActor), actionsUsed: landingActor.actor.legendary.actionsUsed };
    tx.putActor(landingActor, { ...landingActor.actor, legendary: { ...landingActor.actor.legendary, actionsUsed: 0 } });
  }

  // After the reveal, so a creature this turn reveals has its starting spot marked as its turn line is.
  const round = encounter.round + (step.wrapped ? 1 : 0);
  writeEncounter(tx, withTurn(tx, { ...encounter, round, entries }, step.landing));
  tx.write(keys.encounterHistory, [...tx.state.encounterHistory, snapshot].slice(-MAX_HISTORY));
  tx.addEvent({ type: "turn", entryId: step.landing, round, ...(rowSeenByNonOwners(tx.state, landing, tx.env) ? { seen: true as const } : {}) });
}

/** Walks one `next` back from the history: the encounter, the effects it ticked, the legendary actions it reset and the tokens it revealed. */
export function encounterPrev(tx: Tx, op: OpOf<"encounter.prev">): void {
  if (pressChangesNothing(tx.state, tx.actor, op, tx.env)) return;
  const encounter = encounterOf(tx);
  const history = tx.state.encounterHistory;
  const snapshot = history[history.length - 1];
  if (!snapshot) throw invalid("nothing to go back to");
  // The line names the turn taken back, marked from the state before the
  // undo, as its own turn line was: a row this step re-hides keeps both out
  // of the players' log alike. It also names the row whose turn resumes,
  // marked from the state after, which is when that turn begins again.
  const taken = encounter.entries.find((e) => e.id === encounter.activeEntryId);
  const takenSeen = taken !== undefined && rowSeenByNonOwners(tx.state, taken, tx.env);
  writeEncounter(tx, snapshot.encounter);
  for (const [id, effects] of Object.entries(snapshot.effects).sort(([a], [b]) => (a < b ? -1 : 1))) {
    restoreEffects(tx, id, effects);
  }
  if (snapshot.legendary) restoreLegendary(tx, snapshot.legendary);
  for (const revealed of snapshot.revealed) {
    const token = tx.state.tokens[revealed.tokenId];
    if (!token) continue;
    tx.write(keys.token(token.id), { ...token, visibility: revealed.visibility, fogExemptAuto: revealed.fogExemptAuto });
  }
  tx.write(keys.encounterHistory, history.slice(0, -1));
  if (taken) {
    const resumed = snapshot.encounter.entries.find((e) => e.id === snapshot.encounter.activeEntryId);
    tx.addEvent({
      type: "turn",
      entryId: taken.id,
      round: encounter.round,
      back: true,
      ...(takenSeen ? { seen: true as const } : {}),
      ...(resumed ? { to: resumed.id, ...(rowSeenByNonOwners(tx.state, resumed, tx.env) ? { toSeen: true as const } : {}) } : {}),
    });
  }
}

/** Puts back the legendary actions a creature had used, if it still has legendary actions to count. */
function restoreLegendary(tx: Tx, saved: NonNullable<EncounterSnapshot["legendary"]>): void {
  const resolved = tx.state.characters[saved.holderId]
    ? tx.tryResolveActor({ characterId: saved.holderId })
    : tx.tryResolveActor({ tokenId: saved.holderId });
  const legendary = resolved?.actor.legendary;
  if (!resolved || !legendary || legendary.actionsUsed === saved.actionsUsed) return;
  tx.putActor(resolved, { ...resolved.actor, legendary: { ...legendary, actionsUsed: saved.actionsUsed } });
}

function restoreEffects(tx: Tx, id: string, effects: Effect[]): void {
  const character = tx.state.characters[id];
  if (character) {
    tx.write(keys.character(id), { ...character, actor: { ...character.actor, effects } });
    return;
  }
  const token = tx.state.tokens[id];
  if (token && "inline" in token.actor) {
    tx.write(keys.token(id), { ...token, actor: { inline: { ...token.actor.inline, effects } } });
  }
}
