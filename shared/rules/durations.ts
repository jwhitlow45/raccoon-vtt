import type { DurationAnchor, Effect, Encounter, EntryId, InitEntry, RoomState } from "../model.ts";
import type { DurationInput } from "../protocol.ts";

/**
 * Effect durations (design section 9.5). A duration counts crossings of one
 * boundary (turn start or turn end) of its anchor entry. While a creature is
 * not in an encounter the anchor is its token or character instead, and the
 * duration is paused with its `remaining` kept.
 */

export type StoredDuration = NonNullable<Effect["duration"]>;
export type Boundary = StoredDuration["boundary"];
export type Crossing = { entryId: EntryId; boundary: Boundary };

export function isPaused(duration: StoredDuration): boolean {
  return !("entryId" in duration.anchor);
}

/** The character a token's actor lives on, if any. */
function refOf(state: RoomState, tokenId: string): string | undefined {
  const token = state.tokens[tokenId];
  if (!token) return undefined;
  return "ref" in token.actor ? token.actor.ref : undefined;
}

/** Whether an entry stands for the creature a duration anchor names, through its token or its character. */
export function entryMatchesAnchor(state: RoomState, entry: InitEntry, of: DurationAnchor): boolean {
  if ("entryId" in of) return entry.id === of.entryId;
  if ("tokenId" in of) {
    if (entry.tokenId === of.tokenId) return true;
    const ref = refOf(state, of.tokenId);
    return ref !== undefined && entry.characterId === ref;
  }
  if (entry.characterId === of.characterId) return true;
  return entry.tokenId !== undefined && refOf(state, entry.tokenId) === of.characterId;
}

export function findEntryFor(state: RoomState, of: DurationAnchor): InitEntry | undefined {
  const encounter = state.encounter;
  if (!encounter) return undefined;
  return encounter.entries.find((e) => entryMatchesAnchor(state, e, of));
}

/**
 * Turns the UI's choice into stored crossings, counted from now. "End of X's
 * next turn" during X's own turn must survive the current turn's end, so it
 * needs two crossings. With no entry for X, the duration is anchored to the
 * token or character and waits.
 */
export function resolveDuration(state: RoomState, input: DurationInput): StoredDuration {
  const entry = findEntryFor(state, input.of);
  const anchor: DurationAnchor = entry ? { entryId: entry.id } : pausedAnchor(state, input.of);
  const active = entry !== undefined && state.encounter?.activeEntryId === entry.id;
  switch (input.mode) {
    case "turnStart":
      return { remaining: 1, boundary: "turnStart", anchor };
    case "turnEnd":
      return { remaining: active ? 2 : 1, boundary: "turnEnd", anchor };
    case "rounds":
      return { remaining: input.rounds, boundary: "turnStart", anchor };
  }
}

/** The anchor a duration keeps while its creature is out of combat: never an entry id. */
function pausedAnchor(state: RoomState, of: DurationAnchor): DurationAnchor {
  if ("entryId" in of) {
    const entry = state.encounter?.entries.find((e) => e.id === of.entryId);
    if (entry?.tokenId !== undefined) return { tokenId: entry.tokenId };
    if (entry?.characterId !== undefined) return { characterId: entry.characterId };
    return of;
  }
  return of;
}

/** Where durations go when an entry leaves the encounter: its token, else its character, else they stay orphaned. */
export function pausedAnchorForEntry(entry: InitEntry): DurationAnchor {
  if (entry.tokenId !== undefined) return { tokenId: entry.tokenId };
  if (entry.characterId !== undefined) return { characterId: entry.characterId };
  return { entryId: entry.id };
}

export type TickResult = { effects: Effect[]; expired: Effect[]; changed: boolean };

/** Counts the given boundary crossings against every anchored duration and drops the ones that reach 0. */
export function tickEffects(effects: Effect[], crossings: Crossing[]): TickResult {
  if (crossings.length === 0) return { effects, expired: [], changed: false };
  const expired: Effect[] = [];
  let changed = false;
  const next: Effect[] = [];
  for (const effect of effects) {
    const d = effect.duration;
    if (!d || !("entryId" in d.anchor)) {
      next.push(effect);
      continue;
    }
    const entryId = d.anchor.entryId;
    const hits = crossings.filter((c) => c.entryId === entryId && c.boundary === d.boundary).length;
    if (hits === 0) {
      next.push(effect);
      continue;
    }
    changed = true;
    const remaining = d.remaining - hits;
    if (remaining <= 0) expired.push(effect);
    else next.push({ ...effect, duration: { ...d, remaining } });
  }
  return { effects: changed ? next : effects, expired, changed };
}

/**
 * Binds paused durations to a new entry. `targets` lists the anchors that
 * mean the same creature as the entry: its token, its character, and the
 * other tokens of that character.
 */
export function bindToEntry(effects: Effect[], entryId: EntryId, targets: DurationAnchor[]): { effects: Effect[]; changed: boolean } {
  let changed = false;
  const next = effects.map((effect) => {
    const d = effect.duration;
    if (!d || "entryId" in d.anchor) return effect;
    const matches = targets.some((t) => sameAnchor(t, d.anchor));
    if (!matches) return effect;
    changed = true;
    return { ...effect, duration: { ...d, anchor: { entryId } } };
  });
  return { effects: next, changed };
}

/** Pauses durations anchored to an entry that left the encounter. */
export function unbindFromEntry(effects: Effect[], entryId: EntryId, to: DurationAnchor): { effects: Effect[]; changed: boolean; paused: Effect[] } {
  let changed = false;
  const paused: Effect[] = [];
  const next = effects.map((effect) => {
    const d = effect.duration;
    if (!d || !("entryId" in d.anchor) || d.anchor.entryId !== entryId) return effect;
    changed = true;
    paused.push(effect);
    return { ...effect, duration: { ...d, anchor: to } };
  });
  return { effects: next, changed, paused };
}

export function sameAnchor(a: DurationAnchor, b: DurationAnchor): boolean {
  if ("entryId" in a) return "entryId" in b && a.entryId === b.entryId;
  if ("tokenId" in a) return "tokenId" in b && a.tokenId === b.tokenId;
  return "characterId" in b && a.characterId === b.characterId;
}

/** The anchors that all name the creature behind an entry, for `bindToEntry`. */
export function anchorsForEntry(state: RoomState, entry: InitEntry): DurationAnchor[] {
  const anchors: DurationAnchor[] = [];
  let characterId = entry.characterId;
  if (entry.tokenId !== undefined) {
    anchors.push({ tokenId: entry.tokenId });
    characterId ??= refOf(state, entry.tokenId);
  }
  if (characterId !== undefined) {
    anchors.push({ characterId });
    for (const token of Object.values(state.tokens)) {
      if ("ref" in token.actor && token.actor.ref === characterId && token.id !== entry.tokenId) {
        anchors.push({ tokenId: token.id });
      }
    }
  }
  return anchors;
}

/**
 * The boundary crossings one `next` produces: the end of the turn that was
 * active, then the start of the turn that begins. Entries skipped on the way
 * (defeated) cross both boundaries at once, so an effect waiting on a dead
 * creature's turn still ends.
 */
export function crossingsForNext(encounter: Encounter, skipped: EntryId[], landing: EntryId): Crossing[] {
  const crossings: Crossing[] = [];
  if (encounter.activeEntryId !== null) crossings.push({ entryId: encounter.activeEntryId, boundary: "turnEnd" });
  for (const id of skipped) {
    crossings.push({ entryId: id, boundary: "turnStart" }, { entryId: id, boundary: "turnEnd" });
  }
  crossings.push({ entryId: landing, boundary: "turnStart" });
  return crossings;
}
