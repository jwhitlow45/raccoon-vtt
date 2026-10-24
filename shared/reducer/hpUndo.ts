import { keys } from "../keys.ts";
import type { Actor, DurationAnchor, Effect, HpRevert, InitEntry, LogEvent, RoomState, Vitals } from "../model.ts";
import { stableStringify } from "../project.ts";
import { MAX_EFFECTS, type RefusalCode, type RestoreEntry } from "../protocol.ts";
import { findEntryFor, pausedAnchorForEntry } from "../rules/durations.ts";
import { hpLabel } from "../rules/hp.ts";
import { CHANGED_SINCE } from "./misc.ts";
import { guardHash, type Tx } from "./tx.ts";

/**
 * Taking an HP change back from the log (features section 10). Each HP
 * change keeps on its log line what it replaced (`HpRevert`). The DM's undo
 * of that line becomes an absolute restore of the creature, built from the
 * line and the creature as it stands, and guarded by its value like every
 * other undo (design 7.7), so it is stored and replays the same way.
 *
 * Only what the change moved goes back: HP, life, death saves, the
 * effects reaching or leaving 0 HP put on or took off, and whether the
 * temporary HP were a shape's (`withPoolOf`). Everything else
 * about the creature stays as it is now, so a move or a new condition since
 * survives. The undo is refused when the creature's HP state is no longer
 * what the change left, because someone changed it since: putting the old
 * numbers back would silently drop that later change.
 */

export type HpEvent = Extract<LogEvent, { type: "hp" }>;

function vitals(actor: Actor): Vitals {
  return { hp: { ...actor.hp }, life: actor.life, deathSaves: { ...actor.deathSaves } };
}

/** What an HP change replaced, from the actor before and after it and the initiative rows then. */
export function hpRevertOf(before: Actor, after: Actor, entries: readonly InitEntry[]): HpRevert {
  const out: HpRevert = { before: vitals(before), after: vitals(after) };
  const beforeIds = new Set(before.effects.map((e) => e.id));
  const afterIds = new Set(after.effects.map((e) => e.id));
  const added = after.effects.filter((e) => !beforeIds.has(e.id));
  const removed = before.effects.filter((e) => !afterIds.has(e.id));
  if (added.length > 0) out.added = added;
  if (removed.length > 0) out.removed = removed;
  const anchors: Record<string, DurationAnchor> = {};
  for (const effect of removed) {
    const anchor = effect.duration?.anchor;
    const entry = anchor && "entryId" in anchor ? entries.find((e) => e.id === anchor.entryId) : undefined;
    const paused = entry && pausedAnchorForEntry(entry);
    if (entry && paused && !("entryId" in paused)) anchors[entry.id] = paused;
  }
  if (Object.keys(anchors).length > 0) out.anchors = anchors;
  const pool: NonNullable<HpRevert["shapeTemp"]> = {};
  const was = poolShape(before);
  const is = poolShape(after);
  if (was !== undefined) pool.before = was;
  if (is !== undefined) pool.after = is;
  if (was !== undefined || is !== undefined) out.shapeTemp = pool;
  return out;
}

/**
 * The shape whose pool the temporary HP are, by its `srdId`, or undefined
 * for an empty pool or one no shape gave. An empty pool belongs to no one,
 * so a mark left on 0 never blocks taking a change back.
 */
function poolShape(actor: Actor): string | undefined {
  return actor.hp.temp > 0 && actor.unshaped?.shapeTemp && actor.srdId !== undefined ? actor.srdId : undefined;
}

/**
 * Whose the temporary HP put back are (W7-SOL-07). A pool a shape gave is
 * that shape's again while the creature is still in it. Once the creature is
 * in no shape, that pool went with the shape, as End the shape takes it, so
 * none comes back. In another shape, or from any other source, the pool is
 * no shape's.
 */
function withPoolOf(actor: Actor, shape: string | undefined): Actor {
  const { unshaped } = actor;
  if (shape !== undefined && unshaped && actor.srdId === shape) return { ...actor, unshaped: { ...unshaped, shapeTemp: true } };
  if (shape !== undefined && actor.srdId === undefined) return { ...actor, hp: { ...actor.hp, temp: 0 } };
  if (!unshaped?.shapeTemp) return actor;
  const { shapeTemp: _gone, ...rest } = unshaped;
  return { ...actor, unshaped: rest };
}

/**
 * A removed effect as it goes back. A duration counting a row that has
 * left the fight since pauses on the row's creature, as removing the row
 * would have done to it (design 9.5), or counts that creature's row now if
 * it has joined the fight again, as joining would have bound it. Without
 * this it would wait on a row that never comes back.
 */
function restoredEffect(state: RoomState, effect: Effect, anchors: HpRevert["anchors"]): Effect {
  const d = effect.duration;
  if (!d || !("entryId" in d.anchor)) return effect;
  const entryId = d.anchor.entryId;
  if (state.encounter?.entries.some((e) => e.id === entryId)) return effect;
  const creature = anchors?.[entryId];
  if (!creature) return effect;
  const row = findEntryFor(state, creature);
  return { ...effect, duration: { ...d, anchor: row ? { entryId: row.id } : creature } };
}

function same(a: unknown, b: unknown): boolean {
  return stableStringify(a) === stableStringify(b);
}

/**
 * The actor with the change taken back, or null when it changed since: its
 * HP, life or death saves differ from what the change left, its temporary
 * HP belong to another than then (W7-SOL-08), an effect the change put on
 * is gone or different, or one it took off is back. A removed condition
 * whose kind the creature has again (a new concentration, an Unconscious
 * the DM applied) also counts, since putting the old one back would give it
 * two.
 */
export function revertedActor(current: Actor, revert: HpRevert): Actor | null {
  if (!same(vitals(current), revert.after) || poolShape(current) !== revert.shapeTemp?.after) return null;
  const byId = new Map(current.effects.map((e) => [e.id, e]));
  for (const effect of revert.added ?? []) {
    const now = byId.get(effect.id);
    if (!now || !same(now, effect)) return null;
  }
  const keysNow = new Set(current.effects.map((e) => e.key));
  for (const effect of revert.removed ?? []) {
    if (byId.has(effect.id)) return null;
    if (effect.key !== "custom" && keysNow.has(effect.key)) return null;
  }
  const added = new Set((revert.added ?? []).map((e) => e.id));
  const effects: Effect[] = [...current.effects.filter((e) => !added.has(e.id)), ...(revert.removed ?? [])];
  return withPoolOf({ ...current, hp: { ...revert.before.hp }, life: revert.before.life, deathSaves: { ...revert.before.deathSaves }, effects }, revert.shapeTemp?.before);
}

/**
 * A Regeneration heal taken back reopens its prompt while the record it
 * settled is current and its turn runs (docs/design-v1-combat-controls.md
 * 3.4), so the card comes back. Later, the turn is over and nothing opens.
 */
function reopenedRegeneration(state: RoomState, actor: Actor, record: number | undefined): Actor {
  const current = actor.turnRecord;
  const encounter = state.encounter;
  if (record === undefined || current?.id !== record || current.settled?.regeneration === undefined) return actor;
  if (!encounter || encounter.activeEntryId !== current.entryId || encounter.round !== current.round) return actor;
  const { regeneration: _gone, ...settled } = current.settled;
  const { settled: _old, ...rest } = current;
  return { ...actor, turnRecord: Object.keys(settled).length > 0 ? { ...rest, settled } : rest };
}

/** Whether a later line already took this change back. */
export function takenBack(log: readonly { data?: LogEvent }[], logId: string): boolean {
  return log.some((e) => e.data?.type === "hp" && e.data.back === true && e.data.of === logId);
}

type Holder = { key: string; value: Record<string, unknown>; actor: Actor };

function holderOf(state: RoomState, event: HpEvent): Holder | null {
  if (event.characterId !== undefined) {
    const character = state.characters[event.characterId];
    return character ? { key: keys.character(character.id), value: character, actor: character.actor } : null;
  }
  if (event.tokenId !== undefined) {
    const token = state.tokens[event.tokenId];
    if (!token || !("inline" in token.actor)) return null;
    return { key: keys.token(token.id), value: token, actor: token.actor.inline };
  }
  return null;
}

export type HpUndo =
  | { ok: true; event: HpEvent; entries: RestoreEntry[] }
  | { ok: false; code: RefusalCode; message: string; event?: HpEvent };

/**
 * The restore that takes back the HP change on log line `logId`, guarded by
 * the creature's value now. Refusals name no one who changed it, as
 * CHANGED_SINCE does not. Only the log the room holds in memory counts: an
 * older line, or one from before lines kept what they replaced, answers that
 * it can no longer be taken back.
 */
export function hpUndoRestore(state: RoomState, logId: string): HpUndo {
  const data = state.log.find((e) => e.id === logId)?.data;
  if (data?.type !== "hp" || !data.revert || data.back) return { ok: false, code: "invalid", message: "that change can no longer be taken back" };
  if (takenBack(state.log, logId)) return { ok: false, code: "invalid", message: "it was already taken back", event: data };
  const holder = holderOf(state, data);
  if (!holder) return { ok: false, code: "gone", message: "that is not here", event: data };
  const reverted = revertedActor(holder.actor, data.revert);
  if (!reverted) return { ok: false, code: "invalid", message: CHANGED_SINCE, event: data };
  const removed = new Set((data.revert.removed ?? []).map((e) => e.id));
  const anchors = data.revert.anchors;
  const actor = reopenedRegeneration(state, { ...reverted, effects: reverted.effects.map((e) => (removed.has(e.id) ? restoredEffect(state, e, anchors) : e)) }, data.revert.record);
  // Conditions added since stay, so the ones coming back can pass the limit. The room could then not be exported and imported.
  if (actor.effects.length > MAX_EFFECTS) return { ok: false, code: "quota", message: `at most ${MAX_EFFECTS} effects per creature`, event: data };
  const value = holder.key.startsWith("token:") ? { ...holder.value, actor: { inline: actor } } : { ...holder.value, actor };
  return { ok: true, event: data, entries: [{ key: holder.key, value, expectHash: guardHash(holder.key, holder.value) }] };
}

/**
 * The log line for a change taken back, about the creature as the restore
 * left it. It repeats what the change was, so a player who saw "Goblin 2
 * takes 7 damage" reads that the DM took those 7 back, and projection
 * treats it as any HP line.
 */
export function writeHpUndoLine(tx: Tx, logId: string): void {
  const data = tx.state.log.find((e) => e.id === logId)?.data;
  if (data?.type !== "hp") return;
  const resolved = data.characterId !== undefined ? tx.tryResolveActor({ characterId: data.characterId }) : data.tokenId !== undefined ? tx.tryResolveActor({ tokenId: data.tokenId }) : undefined;
  if (!resolved) return;
  const line: HpEvent = { type: "hp", change: data.change, back: true, of: logId, left: { ...resolved.actor.hp }, label: hpLabel(resolved.actor) };
  if (data.amount !== undefined) line.amount = data.amount;
  tx.addActorEvents(resolved, [line]);
}
