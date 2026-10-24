import { keys } from "../keys.ts";
import type { Effect, Encounter, EncounterSnapshot, InitEntry, RoomState, Token, TurnStart, Viewer } from "../model.ts";
import type { EntryInput, OpOf } from "../protocol.ts";
import {
  anchorsForEntry,
  bindToEntry,
  crossingsForNext,
  entryMatchesAnchor,
  pausedAnchorForEntry,
  tickEffects,
  unbindFromEntry,
} from "../rules/durations.ts";
import { attaches, combatUses, hiddenRowsShareNoMount, logsByAudience, marksHadTurn, revealsRowAnew } from "../migrate.ts";
import { LIMITS } from "../limits.ts";
import { holderOf } from "../rules/attach.ts";
import { activeRowShownTo, inSightOfNonOwners, rowSeenByNonOwners } from "../project.ts";
import { effectEvent } from "../rules/hp.ts";
import { actorOfEntry, groupKeyFor, nextTurn, placeEntry, renumber, rowCharacter, scoredValue, sortEntries, turnMovedOn } from "../rules/initiative.ts";
import { gone, invalid, type Env, type ResolvedActor, type Tx } from "./tx.ts";
import { restoreTurnUses, startTurnUses, withoutTurnScoped } from "./uses.ts";

/** How many `next` steps `prev` can walk back. */
export const MAX_HISTORY = 20;

function encounterOf(tx: Tx): Encounter {
  const encounter = tx.state.encounter;
  if (!encounter) throw gone("encounter");
  return encounter;
}

export function writeEncounter(tx: Tx, encounter: Encounter): void {
  tx.write(keys.encounter, { ...encounter, entries: renumber(sortEntries(encounter.entries)) });
}

/**
 * The encounter with a new active row, and the spot that row's creature
 * stands on as where its turn began (features section 10). A row without a
 * token, or whose token is gone, has no spot. The row is marked as having
 * had its turn, so its place in the order stays in players' view for the
 * rest of the fight (docs/design-v1-combat-flow.md 11.2). The turn's areas
 * remind anew (Tx.startTurn).
 */
function withTurn(tx: Tx, encounter: Encounter, activeEntryId: string | null): Encounter {
  tx.startTurn();
  const { turnStart: _previous, ...rest } = encounter;
  const next: Encounter = { ...rest, activeEntryId };
  const entry = activeEntryId === null ? undefined : encounter.entries.find((e) => e.id === activeEntryId);
  if (entry && !entry.hadTurn && marksHadTurn(tx.env.opVersion)) next.entries = encounter.entries.map((e) => (e === entry ? { ...e, hadTurn: true } : e));
  const token = entry?.tokenId !== undefined ? tx.state.tokens[entry.tokenId] : undefined;
  if (entry && token) {
    // The seq names this turn, so a path recorded during it is told from one of an earlier turn (rules/path.ts).
    const start: TurnStart = { entryId: entry.id, tokenId: token.id, sceneId: token.sceneId, x: token.x, y: token.y, elevation: token.elevation, seq: tx.env.seq };
    if (inSightOfNonOwners(tx.state, token, tx.env)) start.seen = true;
    next.turnStart = start;
  }
  return next;
}

/**
 * A token's initiative row: its own, else its character's row that names
 * no token, so a mount on a character's row is found the same way wherever
 * its row is read (docs/design-v1-attach.md 7.1).
 */
export function tokenRow(entries: readonly InitEntry[], state: RoomState, tokenId: string): InitEntry | undefined {
  const own = entries.find((e) => e.tokenId === tokenId);
  if (own) return own;
  const token = state.tokens[tokenId];
  const ref = token && "ref" in token.actor ? token.actor.ref : undefined;
  return ref === undefined ? undefined : entries.find((e) => e.tokenId === undefined && e.characterId === ref);
}

/**
 * The mounts a creature's turn shares (docs/design-v1-attach.md 7.1): up
 * its chain of controlled rides, each mount whose rider and itself every
 * player sees now, so the link is seen too, at most a turn's limit. Every
 * caller first asks whether the turn's row leads mounts at all
 * (rowLeadsMounts), since the tokens alone cannot say.
 */
export function sharedMounts(tx: Tx, creatureId: string): string[] {
  const mounts: string[] = [];
  const seen = new Set<string>();
  let rider = tx.state.tokens[creatureId];
  while (rider && !seen.has(rider.id) && mounts.length < LIMITS.turnMounts) {
    seen.add(rider.id);
    const link = rider.attached;
    const mount = link?.kind === "ride" && link.steer ? holderOf(tx.state.tokens, rider) : undefined;
    if (!mount || !inSightOfNonOwners(tx.state, rider, tx.env) || !inSightOfNonOwners(tx.state, tx.state.tokens[mount.id]!, tx.env)) break;
    mounts.push(mount.id);
    rider = tx.state.tokens[mount.id];
  }
  return mounts;
}

/**
 * Whether a rider's row may lead its controlled mount (docs/design-v1-attach.md
 * 7.1): share its turn with the mount, or give the mount's row its value and
 * place. From op version 18 only a row every player's tracker shows does,
 * by the encounter projection's own rule (project.ts rowSeenByNonOwners),
 * since the mount's row, its value, place and `markRound`, reaches players
 * who cannot see the rider's, and would tell them its value and whose turn
 * it is (reviews FU21A-OP-1 and FU21A-OP-2). `encounter` is the one the
 * row stands in, which a turn's start has not written yet. Older ops read
 * the tokens alone, as they did.
 */
export function rowLeadsMounts(tx: Tx, encounter: Encounter, row: InitEntry | undefined): boolean {
  if (!hiddenRowsShareNoMount(tx.env.opVersion)) return true;
  return row !== undefined && rowSeenByNonOwners({ ...tx.state, encounter }, row, tx.env);
}

/**
 * The turn that starts with the controlled mounts its creature rides
 * (docs/design-v1-attach.md 7.1): up the creature's chain of controlled
 * rides, each mount whose rider and itself every player sees now, so the
 * link is seen too, on a row every player sees (rowLeadsMounts). Each joins
 * `TurnStart.mounts`, and its row, if it has one, marks time this round
 * (`markRound`). On Next the row's Reaction comes back with its rider's
 * (`reactions`).
 */
function withMounts(tx: Tx, encounter: Encounter, reactions: boolean): Encounter {
  const start = encounter.turnStart;
  if (!start || !rowLeadsMounts(tx, encounter, encounter.entries.find((e) => e.id === start.entryId))) return encounter;
  const mounts = sharedMounts(tx, start.tokenId);
  if (mounts.length === 0) return encounter;
  const rows = new Set(mounts.flatMap((id) => tokenRow(encounter.entries, tx.state, id)?.id ?? []));
  const entries = encounter.entries.map((e) => (rows.has(e.id) ? { ...e, markRound: encounter.round, ...(reactions ? { reactionUsed: false } : {}) } : e));
  return { ...encounter, entries, turnStart: { ...start, mounts } };
}

function buildEntry(tx: Tx, input: EntryInput, existing: InitEntry[]): InitEntry {
  if (existing.some((e) => e.id === input.id)) throw invalid("entry already exists");
  let token: Token | undefined;
  if (input.tokenId !== undefined) token = tx.token(input.tokenId);
  // A companion that acts on its character's turn has no row of its own, for anyone (docs/design-v1-combat-flow.md 3.6.7).
  if (token?.companion && token.companion.turn !== "own") throw invalid("it acts on its character's turn");
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
  const groupKey = input.groupKey ?? groupKeyFor(tx.state, entry, tx.env.opVersion);
  if (groupKey !== undefined) entry.groupKey = groupKey;
  // With initiative scores on, a monster enters at 10 + DEX modifier instead of waiting for a typed roll.
  if (entry.value === null && token && token.kind !== "pc") {
    entry.value = scoredValue(actorOfEntry(tx.state, entry), tx.state.meta.settings);
  }
  return entry;
}

/** Binds every paused duration that names the entry's creature to the entry (design 9.5). */
export function bindDurations(tx: Tx, entry: InitEntry): void {
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
  writeEncounter(tx, { rev: 0, round: 1, activeEntryId: null, entries, ...(logsByAudience(tx.env.opVersion) ? { startSeq: tx.env.seq } : {}) });
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
  // A fight's end is no rest (docs/design-v1-combat-controls.md 2.4): counted uses, recharges and pips stay. What lasts a
  // turn goes from every actor, a creature removed from the fight earlier included, since the next fight starts anew.
  if (combatUses(tx.env.opVersion)) {
    for (const resolved of tx.actors()) {
      const next = withoutTurnScoped(resolved.actor);
      if (next !== resolved.actor) tx.putActor(resolved, next);
    }
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
  // A turn passed on by the removal starts where its creature stands now, with the mounts it rides (docs/design-v1-attach.md 7.1).
  const passed = activeEntryId === encounter.activeEntryId ? kept : withTurn(tx, kept, activeEntryId);
  writeEncounter(tx, passed !== kept && attaches(tx.env.opVersion) ? withMounts(tx, passed, false) : passed);
  for (const entry of sorted) {
    if (!removing.has(entry.id)) continue;
    unbindDurations(tx, entry);
    clearAutoExempt(tx, entry.tokenId);
  }
  const landing = activeEntryId !== encounter.activeEntryId ? kept.entries.find((e) => e.id === activeEntryId) : undefined;
  // The turn passed on starts for its creatures as Next starts one, with no saved step: the removal's undo takes it back.
  if (landing && combatUses(tx.env.opVersion)) startTurn(tx, tx.state.encounter ?? kept, landing, null);
  if (landing) tx.addEvent({ type: "turn", entryId: landing.id, round: encounter.round, ...(rowSeenByNonOwners(tx.state, landing, tx.env) ? { seen: true as const } : {}) });
}

/**
 * Starts a turn for every creature of it (docs/design-v1-combat-controls.md
 * 3.3), Next's and a removal's alike: its records and resets (uses.ts
 * startTurnUses). A row that only marks time this round starts nothing: its
 * mount's turn began with its rider's, which gave it its record.
 */
export function startTurn(tx: Tx, encounter: Encounter, landing: InitEntry, snapshot: EncounterSnapshot | null): void {
  if (landing.markRound === encounter.round) return;
  startTurnUses(tx, encounter, landing, sharedCompanions(tx, landing).map((t) => t.id), snapshot);
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
  if (op.counts) lairCounts(tx, entry, op.counts);
}

/**
 * In lair's counts (docs/design-v1-combat-controls.md 2.4): the row's
 * creature takes the block's lair or base legendary counts and XP, which
 * the op carries since the reducer never reads a block. What it spent stays,
 * cut to the new counts.
 */
function lairCounts(tx: Tx, entry: InitEntry, counts: NonNullable<OpOf<"encounter.update">["counts"]>): void {
  const resolved = entry.tokenId !== undefined ? tx.tryResolveActor({ tokenId: entry.tokenId }) : entry.characterId !== undefined ? tx.tryResolveActor({ characterId: entry.characterId }) : undefined;
  if (!resolved) return;
  const was = resolved.actor.legendary;
  const legendary = {
    actionsMax: counts.actionsMax,
    actionsUsed: Math.min(was?.actionsUsed ?? 0, counts.actionsMax),
    resistMax: counts.resistMax,
    resistUsed: Math.min(was?.resistUsed ?? 0, counts.resistMax),
  };
  tx.putActor(resolved, { ...resolved.actor, legendary, ...(counts.xp !== undefined ? { xp: counts.xp } : {}) });
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
  const mounted = attaches(tx.env.opVersion);
  const step = nextTurn(tx.state, encounter, settings, mounted);
  if (!step) throw invalid("the encounter has no combatants");
  const snapshot: EncounterSnapshot = { encounter, effects: {}, revealed: [], at: tx.env.at };
  const round = encounter.round + (step.wrapped ? 1 : 0);

  // A row that marks time this round keeps its spent Reaction: it came back on its rider's turn (docs/design-v1-attach.md 7.1).
  const keepsReaction = (e: InitEntry) => mounted && e.markRound === round;
  let entries = encounter.entries.map((e) => (e.id === step.landing && !keepsReaction(e) ? { ...e, reactionUsed: false } : e));
  const reveals = settings.revealHiddenOnTurn && entries.find((e) => e.id === step.landing)!.hidden;
  if (reveals && revealsRowAnew(tx.env.opVersion)) entries = entries.map((e) => (e.id === step.landing ? { ...e, hidden: false } : e));
  const landing = entries.find((e) => e.id === step.landing)!;

  // The reveal comes before the durations tick: expiry lines are stamped
  // seen or not from the state when they are written, and a creature this
  // turn reveals has its expiries marked as its turn line is, seen where
  // players see it stand.
  if (reveals) {
    // Older ops changed the row in place, the state's own when it kept its Reaction, and replay so (revealsRowAnew).
    if (!revealsRowAnew(tx.env.opVersion)) landing.hidden = false;
    if (landing.tokenId !== undefined) {
      const token = tx.state.tokens[landing.tokenId];
      if (token) {
        snapshot.revealed.push({ tokenId: token.id, visibility: token.visibility, fogExemptAuto: token.fogExemptAuto });
        tx.write(keys.token(token.id), { ...token, visibility: "all", fogExemptAuto: true });
      }
    }
  }

  clearCompanionReactions(tx, landing, snapshot);

  const crossings = crossingsForNext(encounter, step.skipped, step.landing);
  for (const resolved of tx.actors()) {
    const r = tickEffects(resolved.actor.effects, crossings);
    if (!r.changed) continue;
    snapshot.effects[holderId(resolved)] = resolved.actor.effects;
    tx.putActor(resolved, { ...resolved.actor, effects: r.effects });
    for (const effect of r.expired) tx.addActorEvents(resolved, [effectEvent(effect, "expire")]);
  }
  const ended = encounter.activeEntryId === null ? undefined : encounter.entries.find((e) => e.id === encounter.activeEntryId);
  if (ended) askSavesAtTurnEnd(tx, ended, snapshot);

  // Ops stored before combat uses refilled the landing row's pips alone, a row that marks time included, and replay so.
  const combat = combatUses(tx.env.opVersion);
  const landingActor = combat
    ? undefined
    : landing.tokenId !== undefined
      ? tx.tryResolveActor({ tokenId: landing.tokenId })
      : landing.characterId !== undefined
        ? tx.tryResolveActor({ characterId: landing.characterId })
        : undefined;
  if (landingActor?.actor.legendary && landingActor.actor.legendary.actionsUsed !== 0) {
    snapshot.legendary = { holderId: holderId(landingActor), actionsUsed: landingActor.actor.legendary.actionsUsed };
    tx.putActor(landingActor, { ...landingActor.actor, legendary: { ...landingActor.actor.legendary, actionsUsed: 0 } });
  }

  // After the reveal, so a creature this turn reveals has its starting spot marked as its turn line is.
  let turned = withTurn(tx, { ...encounter, round, entries }, step.landing);
  // The mounts the starting creature rides join its turn, their Reactions back with its own (7.1).
  if (mounted) turned = withMounts(tx, turned, true);
  entries = turned.entries;
  writeEncounter(tx, turned);
  // After the mounts join, which are the turn's creatures too (docs/design-v1-combat-controls.md 2.3).
  if (combat) startTurn(tx, turned, landing, snapshot);
  tx.write(keys.encounterHistory, [...tx.state.encounterHistory, snapshot].slice(-MAX_HISTORY));
  tx.addEvent({ type: "turn", entryId: step.landing, round, ...(rowSeenByNonOwners(tx.state, landing, tx.env) ? { seen: true as const } : {}) });
}

/**
 * The saves that end effects at the end of a turn (docs/design-v1-roll-options.md
 * 6.1): on each creature the ended row stands for (a companion acting on
 * its character's turn among them), each effect with `save` that is still
 * there after the tick gets one `saveEnds` line, and that line's id becomes
 * its pending occurrence. Only the row whose turn ended asks, never a row the
 * step skipped. A request linked to the occurrence before closes in the same
 * op (rolls.ts endSaves), and Previous puts the effects back as they were,
 * since the step saves them first. No stored effect has `save`, so replay
 * is unchanged.
 */
function askSavesAtTurnEnd(tx: Tx, ended: InitEntry, snapshot: EncounterSnapshot): void {
  for (const resolved of tx.actors()) {
    const of = resolved.holder === "token" ? { tokenId: resolved.id } : { characterId: resolved.id };
    // A player's view has no DC, and the server writes the line for it.
    const asks = (e: Effect) => e.save?.dc !== undefined;
    if (!resolved.actor.effects.some(asks) || !entryMatchesAnchor(tx.state, ended, of)) continue;
    snapshot.effects[holderId(resolved)] ??= resolved.actor.effects;
    const effects = resolved.actor.effects.map((effect): Effect => {
      if (!effect.save || effect.save.dc === undefined) return effect;
      const line = tx.addEvent({ type: "saveEnds", ...of, effectId: effect.id, key: effect.key, ability: effect.save.ability, dc: effect.save.dc });
      return { ...effect, due: { id: line.id, state: "pending" } };
    });
    tx.putActor(resolved, { ...resolved.actor, effects });
  }
}

/**
 * A `shared` companion keeps a Reaction of its own on its token
 * (docs/design-v1-combat-flow.md 3.6.8), which its character's turn
 * starting clears, as the row's own. The landing row's character is
 * `rowCharacter`'s, the one nesting reads, and only its companions on the
 * row token's scene, or the players' scene for a row with no token, are
 * cleared: one left on another scene keeps its flag. The ids go in the
 * saved step for Previous, which absent means none.
 */
function clearCompanionReactions(tx: Tx, landing: InitEntry, snapshot: EncounterSnapshot): void {
  const cleared: string[] = [];
  for (const token of sharedCompanions(tx, landing)) {
    const companion = token.companion!;
    if (!companion.reactionUsed) continue;
    const { reactionUsed: _spent, ...link } = companion;
    tx.write(keys.token(token.id), { ...token, companion: link });
    cleared.push(token.id);
  }
  if (cleared.length > 0) snapshot.companionReactions = cleared;
}

/** The `shared` companions a row's turn is also theirs (clearCompanionReactions), by id. */
function sharedCompanions(tx: Tx, landing: InitEntry): Token[] {
  const characterId = rowCharacter(tx.state, landing);
  if (characterId === undefined) return [];
  const sceneId = landing.tokenId !== undefined ? tx.state.tokens[landing.tokenId]?.sceneId : tx.state.meta.playerSceneId;
  return Object.values(tx.state.tokens)
    .sort((a, b) => (a.id < b.id ? -1 : 1))
    .filter((token) => token.companion?.of === characterId && token.companion.turn === "shared" && token.sceneId === sceneId);
}

/**
 * Walks one `next` back from the history: the encounter, the effects it
 * ticked, the legendary actions it reset, the tokens it revealed and the
 * companion Reactions it cleared.
 */
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
  // The turn put back reminds anew, as the turn line it got did before op version 19: no record of it is kept to restore.
  tx.startTurn();
  for (const [id, effects] of Object.entries(snapshot.effects).sort(([a], [b]) => (a < b ? -1 : 1))) {
    restoreEffects(tx, id, effects);
  }
  if (snapshot.legendary) restoreLegendary(tx, snapshot.legendary);
  if (snapshot.turnUses) restoreTurnUses(tx, snapshot.turnUses);
  for (const revealed of snapshot.revealed) {
    const token = tx.state.tokens[revealed.tokenId];
    if (!token) continue;
    tx.write(keys.token(token.id), { ...token, visibility: revealed.visibility, fogExemptAuto: revealed.fogExemptAuto });
  }
  // A companion converted, detached or deleted since gets nothing back.
  for (const tokenId of snapshot.companionReactions ?? []) {
    const token = tx.state.tokens[tokenId];
    if (token?.companion?.turn !== "shared" || token.companion.reactionUsed) continue;
    tx.write(keys.token(token.id), { ...token, companion: { ...token.companion, reactionUsed: true } });
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
  if (!resolved || !legendary) return;
  // In lair may have lowered the count since (docs/design-v1-combat-controls.md 2.4). Older ops put the pips back as they were.
  const actionsUsed = combatUses(tx.env.opVersion) ? Math.min(saved.actionsUsed, legendary.actionsMax) : saved.actionsUsed;
  if (legendary.actionsUsed === actionsUsed) return;
  tx.putActor(resolved, { ...resolved.actor, legendary: { ...legendary, actionsUsed } });
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
