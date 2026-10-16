import type { Actor, Effect, Encounter, EntryId, InitEntry, RoomSettings, RoomState } from "../model.ts";
import { INCAPACITATING_KEYS } from "./hp.ts";

/**
 * Initiative order and turn stepping (design section 9.4). The encounter's
 * entries are kept sorted by the reducer: value descending, null values last,
 * then tieOrder ascending.
 */

export function compareEntries(a: InitEntry, b: InitEntry): number {
  const av = a.value ?? Number.NEGATIVE_INFINITY;
  const bv = b.value ?? Number.NEGATIVE_INFINITY;
  if (av !== bv) return bv - av;
  return a.tieOrder - b.tieOrder;
}

export function sortEntries(entries: InitEntry[]): InitEntry[] {
  return [...entries].sort(compareEntries);
}

/** What the default tie rule looks at: PCs before monsters, then higher initBonus, then name. */
export type TieKey = { isPc: boolean; initBonus: number; name: string };

export function compareTieKeys(a: TieKey, b: TieKey): number {
  if (a.isPc !== b.isPc) return a.isPc ? -1 : 1;
  if (a.initBonus !== b.initBonus) return b.initBonus - a.initBonus;
  return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
}

/** The actor behind an entry, through its token or its character. */
export function actorOfEntry(state: RoomState, entry: InitEntry): Actor | undefined {
  if (entry.tokenId !== undefined) {
    const token = state.tokens[entry.tokenId];
    if (!token) return undefined;
    return "ref" in token.actor ? state.characters[token.actor.ref]?.actor : token.actor.inline;
  }
  if (entry.characterId !== undefined) return state.characters[entry.characterId]?.actor;
  return undefined;
}

/**
 * The character a row stands for, for its companions
 * (docs/design-v1-combat-flow.md 3.6.7 and 3.6.8): its token's character
 * when the row has a token, none for a token with its own actor, and the
 * row's `characterId` only for a row with no token. So a row naming one
 * player's token and another player's character, which the protocol
 * allows, is its token's, as its actor and name already are. Nesting and
 * the Reaction reset both ask this, so they always agree.
 */
export function rowCharacter(state: Pick<RoomState, "tokens">, entry: Pick<InitEntry, "tokenId" | "characterId">): string | undefined {
  if (entry.tokenId !== undefined) {
    const token = state.tokens[entry.tokenId];
    return token && "ref" in token.actor ? token.actor.ref : undefined;
  }
  return entry.characterId;
}

export function tieKeyOf(state: RoomState, entry: InitEntry): TieKey {
  const actor = actorOfEntry(state, entry);
  let isPc = false;
  let name = entry.label ?? "";
  if (entry.tokenId !== undefined) {
    const token = state.tokens[entry.tokenId];
    if (token) {
      isPc = token.kind === "pc";
      name = token.name;
    }
  } else if (entry.characterId !== undefined) {
    isPc = true;
    name = state.characters[entry.characterId]?.name ?? name;
  }
  return { isPc, initBonus: actor?.initBonus ?? 0, name };
}

/**
 * Inserts or re-inserts one entry and renumbers tieOrder. Within its tie
 * group the entry goes right after the last row the default rule ranks at or
 * above it, so a DM's dragged order is disturbed as little as possible. The
 * DM can still drag it afterwards.
 */
export function placeEntry(state: RoomState, entries: InitEntry[], entry: InitEntry): InitEntry[] {
  const others = sortEntries(entries.filter((e) => e.id !== entry.id));
  const key = tieKeyOf(state, entry);
  const value = entry.value ?? Number.NEGATIVE_INFINITY;
  let index = others.length;
  let groupStart = -1;
  for (let i = 0; i < others.length; i++) {
    const other = others[i]!;
    const otherValue = other.value ?? Number.NEGATIVE_INFINITY;
    if (otherValue > value) continue;
    if (otherValue < value) {
      if (groupStart < 0) index = i;
      break;
    }
    if (groupStart < 0) {
      groupStart = i;
      index = i;
    }
    if (compareTieKeys(tieKeyOf(state, other), key) <= 0) index = i + 1;
  }
  others.splice(index, 0, entry);
  return renumber(others);
}

export function renumber(entries: InitEntry[]): InitEntry[] {
  return entries.map((e, i) => (e.tieOrder === i ? e : { ...e, tieOrder: i }));
}

/** The reminder next to a row: Invisible rolls with advantage, Surprised or Incapacitated with disadvantage. Both cancel. */
export function advantageHint(effects: Effect[]): "adv" | "dis" | undefined {
  const adv = effects.some((e) => e.key === "invisible");
  const dis = effects.some((e) => e.key === "surprised" || INCAPACITATING_KEYS.has(e.key));
  if (adv && !dis) return "adv";
  if (dis && !adv) return "dis";
  return undefined;
}

/** The value `encounter.add` gives a monster when the room uses initiative scores instead of rolls. */
export function scoredValue(actor: Actor | undefined, settings: RoomSettings): number | null {
  if (!settings.monsterInitScore || !actor || actor.initScore === undefined) return null;
  return actor.initScore;
}

export function isDefeated(state: RoomState, entry: InitEntry): boolean {
  return actorOfEntry(state, entry)?.life === "dead";
}

/**
 * Whether a Next or Previous names a turn that is already over (`from`,
 * features section 10): the player's End Turn, another DM device or the
 * first of a double tap moved it first, so this press changes nothing. A
 * turn is its row and its round, because a lone combatant, or the last one
 * standing, acts again in the next round with the same row. One that names
 * no turn, as every op stored before the field, moves the turn as it always
 * did.
 */
export function turnMovedOn(encounter: Pick<Encounter, "activeEntryId" | "round"> | null, op: { from?: { entry: EntryId | null; round: number } }): boolean {
  if (op.from === undefined) return false;
  return !encounter || (encounter.activeEntryId ?? null) !== op.from.entry || encounter.round !== op.from.round;
}

export type TurnStep = { landing: EntryId; skipped: EntryId[]; wrapped: boolean };

/**
 * Where `next` lands. From no active entry it lands on the first row. It
 * skips defeated rows when the room says so, and never loops: when every row
 * is defeated it lands on the next one regardless.
 */
export function nextTurn(state: RoomState, encounter: Encounter, settings: RoomSettings): TurnStep | null {
  const entries = sortEntries(encounter.entries);
  if (entries.length === 0) return null;
  const activeIndex = encounter.activeEntryId === null ? -1 : entries.findIndex((e) => e.id === encounter.activeEntryId);
  const skipped: EntryId[] = [];
  let wrapped = false;
  let index = activeIndex;
  for (let step = 0; step < entries.length; step++) {
    index += 1;
    if (index >= entries.length) {
      index = 0;
      wrapped = true;
    }
    const entry = entries[index]!;
    if (settings.skipDefeated && isDefeated(state, entry)) {
      skipped.push(entry.id);
      continue;
    }
    return { landing: entry.id, skipped, wrapped };
  }
  // Everyone is defeated: take the plain next row, and let the DM sort it out.
  const fallback = entries[(activeIndex + 1) % entries.length]!;
  return { landing: fallback.id, skipped: [], wrapped: activeIndex + 1 >= entries.length };
}

/** The group key identical monsters share, for the tracker's grouping: the SRD id, or the base name. */
export function groupKeyFor(state: Pick<RoomState, "tokens">, entry: Pick<InitEntry, "tokenId" | "characterId">): string | undefined {
  if (entry.tokenId === undefined) return undefined;
  const token = state.tokens[entry.tokenId];
  if (!token || token.kind === "pc" || "ref" in token.actor) return undefined;
  return token.actor.inline.srdId ?? token.name;
}
