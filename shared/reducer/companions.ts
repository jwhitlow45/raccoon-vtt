import { keys } from "../keys.ts";
import type { Actor, Effect, Encounter, EncounterSnapshot, InitEntry, RoomState, Token } from "../model.ts";
import { pausedAnchorForEntry } from "../rules/durations.ts";
import { renumber, rowCharacter, sortEntries } from "../rules/initiative.ts";
import { bindDurations, removeEntries } from "./encounter.ts";
import { invalid, type Tx } from "./tx.ts";

/**
 * The companion rules (docs/design-v1-combat-flow.md 3.6) the token,
 * character, encounter and restore reducers call, kept in one place. A
 * companion is a token that belongs to a character: its owners are always
 * the character's, it never carries a number, an effect takes no turn of
 * its own, and one that acts on its character's turn never has an
 * initiative row, live or saved for Previous.
 */

export const COMPANION_OWNERS = "a companion is played by whoever plays its character";
export const NO_NUMBER = "a companion has no number";
export const NO_OWN_TURN = "an effect takes no turn of its own";
export const NOT_SHARED = "it does not act on its character's turn";
export const ON_ITS_TURN = "it acts on its character's turn";
export const ON_ITS_TURN_NOW = "a companion in it now acts on its character's turn";

/** Whether the token is a companion that acts on its character's turn, listed under it or not, and so has no row. */
export function actsOnCharacterTurn(token: Pick<Token, "companion"> | undefined): boolean {
  return token?.companion !== undefined && token.companion.turn !== "own";
}

/** Map order is not stable across a jsonb round trip, so every scan that writes goes by id. */
function byId<T extends { id: string }>(items: T[]): T[] {
  return [...items].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/**
 * The token as an op leaves it, if it is a companion: its character exists
 * (`gone` otherwise), it has stats of its own and is no PC, an effect takes
 * no turn of its own, and it carries no number. One rule for creation, turn
 * changes and kind changes, by anyone.
 */
export function checkCompanion(tx: Tx, token: Token): void {
  const companion = token.companion;
  if (!companion) return;
  tx.character(companion.of);
  if (!("inline" in token.actor) || token.kind === "pc") throw invalid("a companion has stats of its own and is never a player character");
  if (companion.turn === "own" && token.kind === "object") throw invalid(NO_OWN_TURN);
  if (token.number !== undefined) throw invalid(NO_NUMBER);
}

function sameList(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((id, i) => id === b[i]);
}

/**
 * Writes each character's owners onto its companions whose owners differ,
 * tokens in id order, so a replay writes the same keys in the same order.
 * Ownership itself stays the token's, so every rule that reads owners
 * treats a companion as any token its player owns.
 */
export function syncOwners(tx: Tx, characterIds: Iterable<string>): void {
  const wanted = new Set(characterIds);
  if (wanted.size === 0) return;
  for (const token of byId(Object.values(tx.state.tokens))) {
    const of = token.companion?.of;
    if (of === undefined || !wanted.has(of)) continue;
    const character = tx.state.characters[of];
    if (!character || sameList(token.ownerIds, character.ownerIds)) continue;
    tx.write(keys.token(token.id), { ...token, ownerIds: [...character.ownerIds] });
  }
}

/**
 * The encounter without the given rows. An active row among them passes its
 * turn to the next row in the order, as removeEntries passes it, and the
 * spot that turn began on goes with it, since no turn line starts the new
 * one in a saved step.
 */
function encounterWithout(encounter: Encounter, removing: ReadonlySet<string>): Encounter {
  const sorted = sortEntries(encounter.entries);
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
  const entries = renumber(sorted.filter((e) => !removing.has(e.id)));
  if (activeEntryId === encounter.activeEntryId) return { ...encounter, entries };
  const { turnStart: _spot, ...rest } = encounter;
  return { ...rest, activeEntryId, entries };
}

/**
 * Effects whose durations counted a removed row, counting `to` instead, or
 * paused on the row's creature when there is none, as removeEntries
 * pauses them (pausedAnchorForEntry). So no duration counts a row that is
 * gone.
 */
function reanchored(effects: Effect[], removed: ReadonlyMap<string, InitEntry>, to: string | undefined): Effect[] {
  let changed = false;
  const next = effects.map((effect) => {
    const d = effect.duration;
    if (!d || !("entryId" in d.anchor)) return effect;
    const row = removed.get(d.anchor.entryId);
    if (!row) return effect;
    changed = true;
    return { ...effect, duration: { ...d, anchor: to !== undefined ? { entryId: to } : pausedAnchorForEntry(row) } };
  });
  return changed ? next : effects;
}

/** The row of the character a companion acts with, first in the order, among rows not being removed. */
function characterRow(state: Pick<RoomState, "tokens">, entries: readonly InitEntry[], characterId: string, removing: ReadonlySet<string>): InitEntry | undefined {
  return sortEntries([...entries]).find((e) => !removing.has(e.id) && rowCharacter(state, e) === characterId);
}

/**
 * A saved step of the history without the companion's rows
 * (docs/design-v1-combat-flow.md 3.6.8), its saved effects that counted
 * them rebound to the character's row of that step when the companion now
 * acts on its character's turn (`rebind`), else paused on the companion.
 */
function stepWithout(state: Pick<RoomState, "tokens">, step: EncounterSnapshot, tokenId: string, characterId: string | undefined, rebind: boolean): EncounterSnapshot {
  const rows = step.encounter.entries.filter((e) => e.tokenId === tokenId);
  if (rows.length === 0) return step;
  const removing = new Set(rows.map((e) => e.id));
  const removed = new Map(rows.map((e) => [e.id, e]));
  const target = rebind && characterId !== undefined ? characterRow(state, step.encounter.entries, characterId, removing) : undefined;
  const effects: Record<string, Effect[]> = {};
  for (const [holder, list] of Object.entries(step.effects)) effects[holder] = reanchored(list, removed, target?.id);
  return { ...step, encounter: encounterWithout(step.encounter, removing), effects };
}

/**
 * Takes a companion's rows out of the fight and its history
 * (docs/design-v1-combat-flow.md 3.6.7 and 3.6.8), when it comes to act on
 * its character's turn (`rebind`) or is deleted. The live rows leave as
 * Remove from the fight takes them, an active one passing its turn on with
 * its turn line. Then, with `rebind`, the durations paused on the companion
 * bind to its character's row, if the fight has one. Every saved step loses
 * the rows too, so Previous never brings one back, and its saved effects
 * that counted them are rebound the same way, or paused on the companion.
 *
 * Call it with the token as the op leaves it, already written, so binding
 * finds its new turn.
 */
export function dropRows(tx: Tx, token: Token, rebind: boolean): void {
  const encounter = tx.state.encounter;
  if (!encounter) return;
  const ids = encounter.entries.filter((e) => e.tokenId === token.id).map((e) => e.id);
  if (ids.length > 0) removeEntries(tx, ids);
  const characterId = token.companion?.of;
  if (rebind && characterId !== undefined) {
    const after = tx.state.encounter;
    const row = after ? characterRow(tx.state, after.entries, characterId, new Set()) : undefined;
    if (row) bindDurations(tx, row);
  }
  const history = tx.state.encounterHistory;
  const rewritten = history.map((step) => stepWithout(tx.state, step, token.id, characterId, rebind));
  if (rewritten.some((step, i) => step !== history[i])) tx.write(keys.encounterHistory, rewritten);
}

/** Whether an encounter holds a row for a companion that acts on its character's turn, which no row may stand for. */
export function rowsForSharedCompanions(state: Pick<RoomState, "tokens">, encounter: Encounter | null): boolean {
  return encounter?.entries.some((e) => e.tokenId !== undefined && actsOnCharacterTurn(state.tokens[e.tokenId])) ?? false;
}

/**
 * The companion rules over a whole state, pure, for an imported room
 * (docs/design-v1-combat-flow.md 4.7), so a hand-made or older file comes
 * within them: a companion whose character is missing, or that is a PC or
 * has no stats of its own, becomes a plain token. Each other companion
 * takes its character's owners and loses any number, an effect with its
 * own turn acts on its character's turn listed under it, and only a
 * `shared` one keeps a spent Reaction. Rows of companions that act on
 * their character's turn leave the encounter and its history, with every
 * duration that counted them rebound as dropRows rebinds it.
 */
export function normalizeCompanionState(state: RoomState): RoomState {
  const tokens: Record<string, Token> = {};
  for (const [id, token] of Object.entries(state.tokens)) {
    const companion = token.companion;
    if (!companion) {
      tokens[id] = token;
      continue;
    }
    const character = state.characters[companion.of];
    if (!character || !("inline" in token.actor) || token.kind === "pc") {
      const { companion: _gone, ...plain } = token;
      tokens[id] = plain;
      continue;
    }
    const turn = companion.turn === "own" && token.kind === "object" ? "shared" : companion.turn;
    const { number: _number, ...rest } = token;
    tokens[id] = {
      ...rest,
      ownerIds: [...character.ownerIds],
      companion: { of: companion.of, turn, ...(turn === "shared" && companion.reactionUsed ? { reactionUsed: true as const } : {}) },
    };
  }
  let out: RoomState = { ...state, tokens };
  for (const token of byId(Object.values(tokens))) {
    if (!actsOnCharacterTurn(token)) continue;
    out = withoutCompanionRows(out, token);
  }
  return out;
}

/** One companion's rows out of a state's encounter and history, pure, as dropRows takes them with `rebind`. */
function withoutCompanionRows(state: RoomState, token: Token): RoomState {
  const characterId = token.companion?.of;
  let out = state;
  const encounter = state.encounter;
  const rows = encounter?.entries.filter((e) => e.tokenId === token.id) ?? [];
  if (encounter && rows.length > 0) {
    const removing = new Set(rows.map((e) => e.id));
    const removed = new Map(rows.map((e) => [e.id, e]));
    const target = characterId !== undefined ? characterRow(state, encounter.entries, characterId, removing) : undefined;
    const actor = (a: Actor): Actor => {
      const effects = reanchored(a.effects, removed, target?.id);
      return effects === a.effects ? a : { ...a, effects };
    };
    const characters = Object.fromEntries(Object.entries(state.characters).map(([id, c]) => [id, { ...c, actor: actor(c.actor) }]));
    const tokens = Object.fromEntries(
      Object.entries(state.tokens).map(([id, t]) => [id, "inline" in t.actor ? { ...t, actor: { inline: actor(t.actor.inline) } } : t]),
    );
    out = { ...out, encounter: encounterWithout(encounter, removing), characters, tokens };
  }
  const history = out.encounterHistory.map((step) => stepWithout(out, step, token.id, characterId, true));
  return { ...out, encounterHistory: history };
}
