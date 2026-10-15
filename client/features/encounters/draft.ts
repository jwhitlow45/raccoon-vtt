import type { CustomMonster, PartyGroup, SavedEncounter, SavedEncounterMonster } from "#shared/model.ts";
import { stableStringify } from "#shared/project.ts";
import { MAX_ENCOUNTER_CREATURES, MAX_ENCOUNTER_KINDS, MAX_PARTY_GROUPS, type SavedEncounterInput, type SavedEncounterPatch } from "#shared/protocol.ts";
import type { SrdMonster, StatBlockMonster } from "#shared/srd/monsters.ts";
import { viewOf } from "../monsters/draft.ts";
import type { MonsterXp } from "./budget.ts";

/**
 * The encounter builder's draft (features section 10), kept free of React
 * so its rules run under plain Node: adding monsters within the protocol's
 * caps, the op a save sends, and which stat block each line of an
 * encounter names.
 *
 * The whole encounter is one draft and one op on Save, like the custom
 * monster editor, so a session of adding and removing is one undo step.
 */

export type Draft = {
  name: string;
  monsters: SavedEncounterMonster[];
  /** The party as the DM set it, or null for the room's characters as they are. */
  party: PartyGroup[] | null;
};

export function emptyDraft(): Draft {
  return { name: "", monsters: [], party: null };
}

export function draftOf(saved: SavedEncounter): Draft {
  return { name: saved.name, monsters: saved.monsters, party: saved.party ?? null };
}

export type MonsterRef = { srdId: string } | { monsterId: string };

/** A key for one line of an encounter: which monster, and whether in its lair. */
export function lineKey(m: SavedEncounterMonster): string {
  return `${"srdId" in m ? `srd:${m.srdId}` : `room:${m.monsterId}`}${m.inLair ? ":lair" : ""}`;
}

function sameMonster(m: SavedEncounterMonster, ref: MonsterRef): boolean {
  return "srdId" in ref ? "srdId" in m && m.srdId === ref.srdId : "monsterId" in m && m.monsterId === ref.monsterId;
}

export function creatureCount(monsters: readonly SavedEncounterMonster[]): number {
  return monsters.reduce((n, m) => n + m.count, 0);
}

/** How many more creatures fit under MAX_ENCOUNTER_CREATURES. */
export function roomLeft(draft: Draft): number {
  return MAX_ENCOUNTER_CREATURES - creatureCount(draft.monsters);
}

/**
 * One more of a monster: another on its line when the encounter has one
 * outside its lair, else a new line. Unchanged when the encounter is full.
 */
export function addMonster(draft: Draft, ref: MonsterRef): Draft {
  if (roomLeft(draft) <= 0) return draft;
  const i = draft.monsters.findIndex((m) => sameMonster(m, ref) && !m.inLair);
  if (i >= 0) return setCount(draft, i, draft.monsters[i]!.count + 1);
  if (draft.monsters.length >= MAX_ENCOUNTER_KINDS) return draft;
  return { ...draft, monsters: [...draft.monsters, { ...ref, count: 1 }] };
}

/** A line's count, kept from 1 up to what still fits. */
export function setCount(draft: Draft, index: number, count: number): Draft {
  const line = draft.monsters[index];
  if (!line) return draft;
  const max = line.count + roomLeft(draft);
  const next = Math.max(1, Math.min(max, Math.floor(count)));
  if (next === line.count) return draft;
  return { ...draft, monsters: draft.monsters.map((m, i) => (i === index ? { ...m, count: next } : m)) };
}

export function removeLine(draft: Draft, index: number): Draft {
  return { ...draft, monsters: draft.monsters.filter((_, i) => i !== index) };
}

export function setLair(draft: Draft, index: number, inLair: boolean): Draft {
  return {
    ...draft,
    monsters: draft.monsters.map((m, i) => {
      if (i !== index) return m;
      const { inLair: _old, ...rest } = m;
      return inLair ? { ...rest, inLair: true } : rest;
    }),
  };
}

/** A party group changed, with its count from 1 to `maxCount` and its level from 1 to 20. */
export function setGroup(party: readonly PartyGroup[], index: number, group: PartyGroup, maxCount: number): PartyGroup[] {
  const clean = { count: Math.max(1, Math.min(maxCount, Math.floor(group.count))), level: Math.max(1, Math.min(20, Math.floor(group.level))) };
  return party.map((g, i) => (i === index ? clean : g));
}

export function addGroup(party: readonly PartyGroup[]): PartyGroup[] {
  if (party.length >= MAX_PARTY_GROUPS) return [...party];
  return [...party, { count: 1, level: party[party.length - 1]?.level ?? 1 }];
}

/** The draft as a create op carries it, with its name tidied. */
export function encounterInput(id: string, draft: Draft): SavedEncounterInput {
  const input: SavedEncounterInput = { id, name: draft.name.trim(), monsters: draft.monsters };
  if (draft.party) input.party = draft.party;
  return input;
}

/** What an edit changed, for `savedEncounter.update`, or null when it changed nothing. */
export function encounterPatch(saved: SavedEncounter, draft: Draft): SavedEncounterPatch | null {
  const patch: SavedEncounterPatch = {};
  const name = draft.name.trim();
  if (name !== saved.name) patch.name = name;
  if (stableStringify(draft.monsters) !== stableStringify(saved.monsters)) patch.monsters = draft.monsters;
  if (stableStringify(draft.party ?? null) !== stableStringify(saved.party ?? null)) patch.party = draft.party;
  return Object.keys(patch).length > 0 ? patch : null;
}

/** Which stat block a line names: an SRD one, one of the room's own, or null for one deleted since or not loaded yet. */
export type Resolved = { view: StatBlockMonster; source: "srd" | "room" } | null;

export function resolveLine(m: SavedEncounterMonster, srd: ReadonlyMap<string, SrdMonster> | null, monsters: Readonly<Record<string, CustomMonster>> | undefined): Resolved {
  if ("srdId" in m) {
    const view = srd?.get(m.srdId);
    return view ? { view, source: "srd" } : null;
  }
  const monster = monsters?.[m.monsterId];
  return monster ? { view: viewOf(monster), source: "room" } : null;
}

/** The XP one creature of a line is worth, from its stat block: the lair's XP when it is in its lair and the block gives one. */
export function lineXp(m: SavedEncounterMonster, view: StatBlockMonster): number {
  return m.inLair ? (view.xpInLair ?? view.xp) : view.xp;
}

export function monsterXps(monsters: readonly SavedEncounterMonster[], resolve: (m: SavedEncounterMonster) => Resolved): MonsterXp[] {
  return monsters.map((m) => {
    const r = resolve(m);
    return { count: m.count, xp: r ? lineXp(m, r.view) : null };
  });
}

/** The SRD list by id, for resolving lines. */
export function srdIndex(list: readonly SrdMonster[]): Map<string, SrdMonster> {
  return new Map(list.map((m) => [m.srdId, m]));
}
