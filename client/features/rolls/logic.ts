import { ABILITY_KEYS, SKILL_KEYS, type AbilityKey, type Character, type CharacterId, type Member, type RollAnswer, type RollChange, type RollChoice, type RollRequest, type RollTarget, type RollTest, type RoomState, type SkillKey, type Token } from "#shared/model.ts";
import { LIMITS } from "#shared/limits.ts";
import { anyPlayer, playersToken } from "#shared/project.ts";
import { z } from "zod";
import { dmToolSchemas, type ActorTarget, type ClientOp } from "#shared/protocol.ts";
import type { OpAnswer, OpRefusal } from "../../state/types.ts";
import { ABILITY_NAMES, choiceText, SKILLS, testShortText, testText, TYPICAL_DCS } from "#shared/rules/skills.ts";
import { answerDice } from "#shared/logText.ts";
import { naturalOf } from "#shared/dice/roll.ts";
import { CONDITIONS } from "#shared/srd/conditions.ts";
import { NO_INPUTS, type RollInputs } from "./card.ts";
import { displayName } from "../../lib/scene.ts";

/**
 * Request a roll (docs/design-v1-dm-tools.md 3.3), as plain functions for
 * node --test: who the party is and which creatures a request starts with,
 * the op the DM's sheet sends, and the words of the cards and chips. A
 * player rolls the answer on the server or types the total they rolled.
 */

type View = Pick<RoomState, "members" | "characters" | "tokens" | "meta">;

/** A key for one creature a request asks, as the sheet and the cards tell them apart. */
export function targetKey(target: Pick<RollTarget, "tokenId" | "characterId">): string {
  return target.tokenId !== undefined ? `t:${target.tokenId}` : `c:${target.characterId ?? ""}`;
}

export function targetRef(target: Pick<RollTarget, "tokenId" | "characterId">): ActorTarget {
  return target.tokenId !== undefined ? { tokenId: target.tokenId } : { characterId: target.characterId! };
}

/** Members in roster order: the DM first, then by name, as the Members panel lists them. */
function rosterRank(members: Readonly<Record<string, Member | undefined>>): Map<string, number> {
  const list = Object.values(members).filter((m): m is Member => m !== undefined);
  list.sort((a, b) => (a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === "dm" ? -1 : 1));
  return new Map(list.map((m, i) => [m.id, i]));
}

/**
 * The party: every character a member of kind player owns (`anyPlayer`),
 * in roster order of their first player, then by name. The party bar and
 * "Ask the party" read the same list.
 */
export function partyCharacters(view: Pick<RoomState, "members" | "characters">): Character[] {
  const rank = rosterRank(view.members);
  const first = (c: Character) => Math.min(...c.ownerIds.filter((id) => view.members[id]?.kind === "player").map((id) => rank.get(id) ?? Infinity));
  return Object.values(view.characters)
    .filter((c): c is Character => c !== undefined && anyPlayer(view, c.ownerIds))
    .sort((a, b) => first(a) - first(b) || a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
}

/** A character's token on a scene, the first by id when it has several there. */
export function characterToken(tokens: Readonly<Record<string, Token | undefined>>, characterId: CharacterId, sceneId: string | null): Token | undefined {
  if (sceneId === null) return undefined;
  let found: Token | undefined;
  for (const t of Object.values(tokens)) {
    if (!t || t.sceneId !== sceneId || !("ref" in t.actor) || t.actor.ref !== characterId) continue;
    if (!found || t.id < found.id) found = t;
  }
  return found;
}

/** One creature the sheet lists, ticked or not. `why` says why one starts unticked, and `blocked` that it cannot be asked at all. */
export type TargetOption = { key: string; ref: ActorTarget; name: string; ticked: boolean; why?: string; blocked?: boolean };

/**
 * What a request opens the sheet with (docs/design-v1-roll-request.md
 * 4.8): its creatures, and with `fill` the roll already chosen, as doc 3's
 * Ask path opens it with the tapped test. The party bar passes none.
 */
export type AskFill = { test: RollTest; dc?: number; spell?: true; note?: string };
export type AskFrom = ({ kind: "party" } | { kind: "selection"; tokenIds: readonly string[] }) & { fill?: AskFill };

/**
 * The creatures a request starts with, defined once for every entry point.
 * "Ask the party" lists every party character, those with a token on the
 * players' scene ticked and the rest unticked, "on another scene". From a
 * token's action bar, the selected creatures a player plays start ticked
 * instead, a familiar included, followed by the rest of the party unticked.
 * A party character is asked as itself, so its answer follows it to any
 * scene. Any other creature is asked by its token, which must stand on the
 * players' scene: a familiar, or a token a player owns that points at a
 * character no player owns.
 *
 * A DM's view holds the tokens of the scene it shows only (`viewing`), so
 * from any other scene nobody can tell who stands on the players' scene.
 * Then "Ask the party" ticks every party character, which the request
 * reaches wherever it stands, and no character is called "on another
 * scene" (LP5-ROLLS-2). A selected token is in view, so its own rule holds.
 */
export function defaultTargets(view: View, from: AskFrom, viewing?: string | null): TargetOption[] {
  const playerScene = view.meta.playerSceneId;
  const playersSceneInView = viewing === undefined || viewing === playerScene;
  const out: TargetOption[] = [];
  const seen = new Set<string>();
  const add = (option: TargetOption) => {
    if (seen.has(option.key)) return;
    seen.add(option.key);
    out.push(option);
  };
  if (from.kind === "selection") {
    for (const id of from.tokenIds) {
      const token = view.tokens[id];
      const option = token ? askTarget(view, token) : null;
      if (option) add(option);
    }
  }
  for (const character of partyCharacters(view)) {
    const here = !playersSceneInView || characterToken(view.tokens, character.id, playerScene) !== undefined;
    add({
      key: `c:${character.id}`,
      ref: { characterId: character.id },
      name: character.name,
      ticked: from.kind === "party" && here,
      ...(here ? {} : { why: "on another scene" }),
    });
  }
  return out;
}

/**
 * How a selected token is asked, or null when no player plays it or it is
 * no creature. A party character is asked as itself. A token a player owns
 * that points at a character no player owns, such as the DM's NPC lent to a
 * player, is asked by its token, as a familiar is, since `roll.ask` refuses
 * that character. A token target off the players' scene is listed but
 * cannot be asked. An object, such as a Spiritual Weapon its cleric moves,
 * rolls nothing of its own (docs/design-v1-token-panel.md 3.3), so neither
 * bar offers "Request a roll" for it and the sheet does not list it.
 */
export function askTarget(view: Pick<RoomState, "members" | "characters" | "meta">, token: Token): TargetOption | null {
  if (token.kind === "object" || !playersToken(view, token)) return null;
  const character = "ref" in token.actor ? view.characters[token.actor.ref] : undefined;
  if (character && anyPlayer(view, character.ownerIds)) return { key: `c:${character.id}`, ref: { characterId: character.id }, name: character.name, ticked: true };
  if (token.sceneId === view.meta.playerSceneId) return { key: `t:${token.id}`, ref: { tokenId: token.id }, name: displayName(token), ticked: true };
  return { key: `t:${token.id}`, ref: { tokenId: token.id }, name: displayName(token), ticked: false, why: "not on the players’ scene", blocked: true };
}

/** Whether a token action bar offers "Request a roll": some selected creature can be asked, by the rule the sheet ticks them by. */
export function offersRequest(view: Pick<RoomState, "members" | "characters" | "meta">, tokens: readonly Token[]): boolean {
  return tokens.some((t) => {
    const option = askTarget(view, t);
    return option !== null && option.blocked !== true;
  });
}

/**
 * One choice of a request (docs/design-v1-roll-request.md 3): a whole roll,
 * a save of an ability, a check of an ability, or a check of a skill with
 * its ability, usually the skill's own. The sheet's three rows are views of
 * this one value, so a tap in any of them replaces it whole, and no earlier
 * tap can outlive a later one: a skill held apart from its ability stayed
 * picked under a new ability, and the DM sent Strength (Perception) when
 * they asked for a Strength check. Named RollPick, since `Pick` is
 * TypeScript's own.
 */
export type RollPick = { kind: "save"; ability: AbilityKey } | { kind: "check"; ability: AbilityKey; skill?: SkillKey };

/** What the DM's sheet holds before Send. */
export type AskDraft = {
  /** One or two, each null until the DM picks it: nothing is picked before the DM picks it. */
  choices: (RollPick | null)[];
  /** As typed: empty for a roll with no DC. */
  dc: string;
  dcShown: boolean;
  resultShown: boolean;
  /** "Against a spell", which applies, and is sent, only while every pick is a save (4.6). */
  spell: boolean;
  note: string;
  ticked: readonly ActorTarget[];
};

/** The two switches a sheet starts with: `askSwitches`, else both on. */
export type AskSwitches = { dcShown: boolean; resultShown: boolean };

export function emptyDraft(ticked: readonly ActorTarget[], switches: AskSwitches = { dcShown: true, resultShown: true }): AskDraft {
  return { choices: [null], dc: "", dcShown: switches.dcShown, resultShown: switches.resultShown, spell: false, note: "", ticked };
}

/**
 * A draft filled with a roll (4.7, 4.8): the choices, the DC, "Against a
 * spell" and the note, and the switches when the fill has them (a recent
 * request), while who rolls stays as the entry point set it.
 */
export function fillDraft(draft: AskDraft, fill: AskFill & Partial<AskSwitches>): AskDraft {
  return {
    ...draft,
    choices: fill.test.choices.map((c) => pickOf(fill.test.kind, c)),
    dc: fill.dc !== undefined ? String(fill.dc) : "",
    dcShown: fill.dcShown ?? draft.dcShown,
    resultShown: fill.resultShown ?? draft.resultShown,
    spell: fill.spell === true,
    note: fill.note ?? "",
  };
}

export function samePick(a: RollPick | null | undefined, b: RollPick | null | undefined): boolean {
  if (!a || !b) return !a && !b;
  return a.kind === b.kind && a.ability === b.ability && (a.kind === "check" ? a.skill : undefined) === (b.kind === "check" ? b.skill : undefined);
}

/** The pick a request's choice is, as a recent request or a fill holds it. */
export function pickOf(kind: RollTest["kind"], choice: RollChoice): RollPick {
  if (kind === "save") return { kind, ability: choice.ability };
  return choice.skill === undefined ? { kind, ability: choice.ability } : { kind, ability: choice.ability, skill: choice.skill };
}

/** A pick in the test's own words, short: "Dex save", "Wis (Perception) check". */
export function pickText(pick: RollPick): string {
  return testShortText({ kind: pick.kind, choices: [choiceOf(pick)] });
}

function choiceOf(pick: RollPick): RollChoice {
  return pick.kind === "check" && pick.skill !== undefined ? { ability: pick.ability, skill: pick.skill } : { ability: pick.ability };
}

/**
 * Why choice `i` cannot take a pick (4.3), or null when it can. A test
 * holds one kind (RollTest), so with the other choice picked, a pick of
 * the other kind is refused, and so is the other choice's own pick, since
 * a request offers two different rolls.
 */
export function pickRefusal(draft: Pick<AskDraft, "choices">, i: number, pick: RollPick): string | null {
  const other = draft.choices.length > 1 ? draft.choices[1 - i] : null;
  if (!other) return null;
  if (other.kind !== pick.kind) return other.kind === "save" ? "Both choices are saves." : "Both choices are checks.";
  return samePick(other, pick) ? `That is the ${i === 0 ? "second" : "first"} choice.` : null;
}

/** Choice `i` becomes `pick`, whole, or nothing (null) again. A pick a rule refuses changes nothing. */
export function choose(draft: AskDraft, i: number, pick: RollPick | null): AskDraft {
  if (i < 0 || i >= draft.choices.length || samePick(draft.choices[i], pick)) return draft;
  if (pick !== null && pickRefusal(draft, i, pick) !== null) return draft;
  return { ...draft, choices: draft.choices.map((c, j) => (j === i ? pick : c)) };
}

/**
 * What each control of choice `i`'s picker does (4.2), as the sheet wires
 * them and the picker's randomized test drives them: a tap in the Save or
 * Check row, a pick in the Skill dropdown, which starts at the skill's
 * usual ability (SRD 5.2.1 page 9), and "with", which changes a picked
 * skill's ability. "Choose a skill" clears only a skill: the dropdown
 * shows it for every other pick, so it never fires then.
 */
export const pickerSteps = {
  save: (draft: AskDraft, i: number, ability: AbilityKey): AskDraft => choose(draft, i, { kind: "save", ability }),
  check: (draft: AskDraft, i: number, ability: AbilityKey): AskDraft => choose(draft, i, { kind: "check", ability }),
  skill: (draft: AskDraft, i: number, skill: SkillKey | null): AskDraft => {
    if (skill !== null) return choose(draft, i, { kind: "check", ability: SKILLS[skill].ability, skill });
    const pick = draft.choices[i];
    return pick?.kind === "check" && pick.skill !== undefined ? choose(draft, i, null) : draft;
  },
  with: (draft: AskDraft, i: number, ability: AbilityKey): AskDraft => {
    const pick = draft.choices[i];
    return pick?.kind === "check" && pick.skill !== undefined ? choose(draft, i, { kind: "check", ability, skill: pick.skill }) : draft;
  },
};

/** "Or a second choice": an empty second picker, while there is one choice. */
export function addChoice(draft: AskDraft): AskDraft {
  return draft.choices.length < LIMITS.rollChoices ? { ...draft, choices: [...draft.choices, null] } : draft;
}

/** Remove on either of two choices. Removing the first makes the second the first. The last one stays. */
export function removeChoice(draft: AskDraft, i: number): AskDraft {
  if (draft.choices.length < 2 || i < 0 || i >= draft.choices.length) return draft;
  return { ...draft, choices: draft.choices.filter((_, j) => j !== i) };
}

/** The test the draft asks for, which Send sends and the status line names, or null while a choice is empty. */
export function draftTest(draft: Pick<AskDraft, "choices">): RollTest | null {
  const picks = draft.choices;
  if (picks.length === 0 || picks.some((p) => p === null)) return null;
  const kind = picks[0]!.kind;
  return { kind, choices: (picks as RollPick[]).map(choiceOf) };
}

/** Whether every pick so far is a check, and there is one: the typical DCs are for checks (SRD 5.2.1 page 6). */
export function allChecks(draft: Pick<AskDraft, "choices">): boolean {
  const picks = draft.choices.filter((p): p is RollPick => p !== null);
  return picks.length > 0 && picks.every((p) => p.kind === "check");
}

/**
 * What choice `i`'s picker shows (4.2), worked out from its one pick, so no
 * control holds a value of its own: the Save row its ability only for a
 * save, the Check row only for a check with no skill, the Skill dropdown
 * only for a skill, with "with" showing that skill's ability. At most one
 * row shows a value. Each list names what is disabled now, by
 * `pickRefusal`, and `why` says so under the picker.
 */
export type PickerView = {
  save: { value: AbilityKey | null; disabled: readonly AbilityKey[] };
  check: { value: AbilityKey | null; disabled: readonly AbilityKey[] };
  skill: { value: SkillKey | null; disabled: readonly SkillKey[] };
  with: { skill: SkillKey; value: AbilityKey; disabled: readonly AbilityKey[] } | null;
  why: string | null;
};

export function pickerView(draft: Pick<AskDraft, "choices">, i: number): PickerView {
  const pick = draft.choices[i] ?? null;
  const refused = (p: RollPick) => pickRefusal(draft, i, p) !== null;
  const skill = pick?.kind === "check" ? pick.skill : undefined;
  const other = draft.choices.length > 1 ? draft.choices[1 - i] : null;
  return {
    save: { value: pick?.kind === "save" ? pick.ability : null, disabled: ABILITY_KEYS.filter((a) => refused({ kind: "save", ability: a })) },
    check: { value: pick?.kind === "check" && skill === undefined ? pick.ability : null, disabled: ABILITY_KEYS.filter((a) => refused({ kind: "check", ability: a })) },
    skill: { value: skill ?? null, disabled: SKILL_KEYS.filter((s) => refused({ kind: "check", ability: SKILLS[s].ability, skill: s })) },
    with: pick && skill !== undefined ? { skill, value: pick.ability, disabled: ABILITY_KEYS.filter((a) => a !== pick.ability && refused({ kind: "check", ability: a, skill })) } : null,
    why: other ? `${other.kind === "save" ? "Both choices are saves." : "Both choices are checks."} ${pickText(other)} is the ${i === 0 ? "second" : "first"} choice.` : null,
  };
}

/** The sheet's status line (4.9): the test it would send with its DC, or what to pick, then how many are asked. */
export function askStatus(draft: AskDraft): string {
  const asked = `${draft.ticked.length} asked.`;
  const test = draftTest(draft);
  if (!test) return `Pick what to roll. ${asked}`;
  const dc = draft.dc.trim() ? `, DC ${draft.dc.trim()}` : ", no DC";
  return `${testTitle(test)}${dc}. ${asked}`;
}

function distinct(choices: readonly RollChoice[]): RollChoice[] {
  const seen = new Set<string>();
  return choices.filter((c) => {
    const key = `${c.ability}:${c.skill ?? ""}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** Whether every pick so far is a save, and there is one: "Against a spell" applies to saves alone (4.6). */
export function allSaves(draft: Pick<AskDraft, "choices">): boolean {
  const picks = draft.choices.filter((p): p is RollPick => p !== null);
  return picks.length > 0 && picks.every((p) => p.kind === "save");
}

/**
 * What a request asks (docs/design-v1-roll-request.md 7.3), whoever sends
 * it: the sheet through `draftInput`, or doc 3's save-ends and group save
 * pages directly. Each caller passes both switches itself, since
 * `askSwitches` is only the sheet's default.
 */
export type AskInput = {
  test: RollTest;
  dc?: number;
  dcShown: boolean;
  resultShown: boolean;
  spell?: true;
  cause?: "saveEnds";
  ends?: { effect: string; occurrence: string };
  note?: string;
  targets: readonly ActorTarget[];
};

/** The sheet's draft as a request (4.9), or what to pick or fix first, in the sheet's words. */
export function draftInput(draft: AskDraft): { ok: true; input: AskInput } | { ok: false; error: string } {
  const empty = draft.choices.findIndex((c) => c === null);
  if (empty === 0) return { ok: false, error: "Pick what to roll first." };
  if (empty > 0) return { ok: false, error: "Pick the second choice, or remove it." };
  const test = draftTest(draft)!;
  const dcText = draft.dc.trim();
  let dc: number | undefined;
  if (dcText !== "") {
    if (!/^\d{1,2}$/.test(dcText)) return { ok: false, error: DC_WORDS };
    dc = Number(dcText);
  }
  const note = draft.note.replace(/\s+/g, " ").trim();
  return {
    ok: true,
    input: {
      test,
      ...(dc !== undefined ? { dc } : {}),
      dcShown: draft.dcShown,
      resultShown: draft.resultShown,
      // "Against a spell" is drawn only while every pick is a save, so it goes only then.
      ...(draft.spell && test.kind === "save" ? { spell: true as const } : {}),
      ...(note !== "" ? { note } : {}),
      targets: draft.ticked,
    },
  };
}

const DC_WORDS = `A DC is a whole number from ${LIMITS.rollDcMin} to ${LIMITS.rollDcMax}, or empty for none.`;

export type AskCheck = { ok: true; op: Extract<ClientOp, { t: "roll.ask" }> } | { ok: false; error: string };

/** The `roll.ask` a request sends, or what to fix first, in the sheet's words: the checks the server makes, before it does. */
export function askOp(input: AskInput, id: string, open: number): AskCheck {
  if (open >= LIMITS.openRollsPerRoom) return { ok: false, error: `${LIMITS.openRollsPerRoom} requests are open. Close one first.` };
  if (input.targets.length === 0) return { ok: false, error: "Choose at least one creature to ask." };
  if (input.targets.length > LIMITS.rollTargets) return { ok: false, error: `Ask at most ${LIMITS.rollTargets} creatures at once.` };
  if (distinct(input.test.choices).length !== input.test.choices.length) return { ok: false, error: "The two choices are the same. Change or remove one." };
  if (input.dc !== undefined && (!Number.isInteger(input.dc) || input.dc < LIMITS.rollDcMin || input.dc > LIMITS.rollDcMax)) return { ok: false, error: DC_WORDS };
  const note = input.note?.replace(/\s+/g, " ").trim() ?? "";
  if ([...note].length > LIMITS.rollNoteChars) return { ok: false, error: `A note holds at most ${LIMITS.rollNoteChars} characters.` };
  return {
    ok: true,
    op: {
      t: "roll.ask",
      request: {
        id,
        test: input.test,
        ...(input.dc !== undefined ? { dc: input.dc } : {}),
        dcShown: input.dcShown,
        resultShown: input.resultShown,
        ...(input.spell ? { spell: true as const } : {}),
        ...(input.cause ? { cause: input.cause } : {}),
        ...(input.ends ? { ends: { effect: input.ends.effect, occurrence: input.ends.occurrence } } : {}),
        ...(note !== "" ? { note } : {}),
        targets: input.targets.map((t) => ("tokenId" in t ? { tokenId: t.tokenId } : { characterId: t.characterId })),
      },
    },
  };
}

/**
 * The typical DCs beside the DC field (4.4), while every pick is a check,
 * else none: each pressed exactly while the field holds its number, so the
 * chips are a view of the field and hold no value of their own.
 */
export function dcChips(draft: Pick<AskDraft, "choices" | "dc">): { dc: number; name: string; pressed: boolean }[] | null {
  if (!allChecks(draft)) return null;
  const typed = draft.dc.trim();
  return TYPICAL_DCS.map((t) => ({ ...t, pressed: typed === String(t.dc) }));
}

/** A tap on a typical DC: the field takes its number, or empties when it already holds it. */
export function tapDc(draft: AskDraft, dc: number): AskDraft {
  return { ...draft, dc: draft.dc.trim() === String(dc) ? "" : String(dc) };
}

/** What the sheet's Send does: the draft as a request, then the request's own checks. */
export function draftOp(draft: AskDraft, id: string, open: number): AskCheck {
  const input = draftInput(draft);
  return input.ok ? askOp(input.input, id, open) : input;
}

/**
 * The fold's summary of what players see (4.6): the switches as they
 * apply, "Against a spell." while it applies, then the note or "No
 * note.", so the folded line always says what Send sends.
 */
export function seenSummary(draft: AskDraft): string {
  const dc = draft.dc.trim() !== "";
  let seen: string;
  if (dc && draft.dcShown) seen = draft.resultShown ? "The DC and pass or fail." : "The DC. Pass or fail hidden.";
  else if (dc) seen = draft.resultShown ? "DC hidden. Pass or fail shown." : "DC and pass or fail hidden.";
  else seen = draft.resultShown ? "Pass or fail shown." : "Pass or fail hidden.";
  const spell = draft.spell && allSaves(draft) ? " Against a spell." : "";
  const note = draft.note.replace(/\s+/g, " ").trim();
  return `${seen}${spell} ${note !== "" ? `Note: ${note}.` : "No note."}`;
}

// ------------------------------------------------------------ recent requests

/** A request this device sent, to send again in one tap (4.7): the roll, its DC, the switches, "Against a spell" and the note. */
export type RecentAsk = { test: RollTest; dc?: number; dcShown: boolean; resultShown: boolean; spell?: true; note?: string };

export const RECENT_SIZE = 3;

const recentEntry = z.strictObject({
  test: dmToolSchemas.rollTest,
  dc: dmToolSchemas.rollDc.optional(),
  dcShown: z.boolean(),
  resultShown: z.boolean(),
  spell: z.literal(true).optional(),
  note: z.string().max(LIMITS.rollNoteChars * 4).optional(),
});

function recentKey(roomId: string): string {
  return `rvtt.askRecent.${roomId}`;
}

/** The stored list, newest first. Each entry is checked, and one that fails its check is dropped while the others stay. */
export function parseRecent(raw: string | null): RecentAsk[] {
  if (raw === null) return [];
  let list: unknown;
  try {
    list = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(list)) return [];
  const out: RecentAsk[] = [];
  for (const item of list) {
    const parsed = recentEntry.safeParse(item);
    if (parsed.success && out.length < RECENT_SIZE) out.push(stripUndefined(parsed.data));
  }
  return out;
}

function stripUndefined(entry: RecentAsk): RecentAsk {
  const out: RecentAsk = { test: entry.test, dcShown: entry.dcShown, resultShown: entry.resultShown };
  if (entry.dc !== undefined) out.dc = entry.dc;
  if (entry.spell) out.spell = true;
  if (entry.note !== undefined && entry.note !== "") out.note = entry.note;
  return out;
}

/** One entry per test and DC: a request sent again moves to the front with what it was sent with. */
function sameRecent(a: RecentAsk, b: RecentAsk): boolean {
  return a.dc === b.dc && a.test.kind === b.test.kind && JSON.stringify(a.test.choices) === JSON.stringify(b.test.choices);
}

/** The list with a request just taken: first, once per test and DC, at most three. */
export function withRecent(list: readonly RecentAsk[], entry: RecentAsk): RecentAsk[] {
  return [stripUndefined(entry), ...list.filter((e) => !sameRecent(e, entry))].slice(0, RECENT_SIZE);
}

/** A request's recent entry, from what it asked. */
export function recentOf(input: AskInput): RecentAsk {
  return stripUndefined({ test: input.test, dc: input.dc, dcShown: input.dcShown, resultShown: input.resultShown, spell: input.spell, note: input.note });
}

/** This device's recent requests in a room. Storage can be missing or blocked, as in a private window: then there are none. */
export function readRecent(roomId: string): RecentAsk[] {
  try {
    return parseRecent(typeof localStorage === "undefined" ? null : localStorage.getItem(recentKey(roomId)));
  } catch {
    return [];
  }
}

export function writeRecent(roomId: string, list: readonly RecentAsk[]): void {
  try {
    localStorage.setItem(recentKey(roomId), JSON.stringify(list.slice(0, RECENT_SIZE)));
  } catch {
    // Storage blocked or full: the request is sent, only not offered again.
  }
}

/** A recent request's button: "Dex save, DC 15", "Wis (Perception) check". */
export function recentLabel(entry: RecentAsk): string {
  return `${testShortText(entry.test)}${entry.dc !== undefined ? `, DC ${entry.dc}` : ""}`;
}

/** The switches the sheet starts with (4.6): as the newest recent request had them, else both on. The sheet's default and nobody else's. */
export function switchesOf(recent: readonly RecentAsk[]): AskSwitches {
  const newest = recent[0];
  return newest ? { dcShown: newest.dcShown, resultShown: newest.resultShown } : { dcShown: true, resultShown: true };
}

export function askSwitches(roomId: string): AskSwitches {
  return switchesOf(readRecent(roomId));
}

/**
 * A target has an answer: a total, a save its player failed without rolling
 * (`noRoll`, which reaches the creature's players whether or not pass or
 * fail is shown), or the DM's mark alone.
 */
export function answered(target: RollAnswer): boolean {
  return target.total !== undefined || target.result !== undefined || target.noRoll === true;
}

/**
 * "Close all answered": every request whose targets have all answered and
 * hold no player's ask to change a roll, which waits for the DM's Allow or
 * Keep (docs/design-v1-roll-request.md 1.1). The server checks the same
 * again when the op runs (`ifSettled`), so an ask that arrives meanwhile
 * keeps its request open.
 */
export function allAnsweredIds(rolls: Readonly<Record<string, RollRequest | undefined>>): string[] {
  return Object.values(rolls)
    .filter((r): r is RollRequest => r !== undefined && r.targets.every((t) => answered(t) && t.change === undefined))
    .map((r) => r.id);
}

/**
 * The DM's card that takes focus once others close (DmDesk.tsx): after a
 * card's own Close, the card after it in `shown` order (newest first), and
 * after "Close all answered", which stands above the cards, the first card
 * left. Null when none is left there.
 */
export function cardAfterClose(shown: readonly string[], closed: readonly string[], by: "card" | "all"): string | null {
  const at = by === "card" && closed[0] !== undefined ? shown.indexOf(closed[0]) : -1;
  return shown.slice(at + 1).find((id) => !closed.includes(id)) ?? null;
}

/** Newest first, as the cards and chips stack. */
export function newestFirst(rolls: Readonly<Record<string, RollRequest | undefined>>): RollRequest[] {
  return Object.values(rolls)
    .filter((r): r is RollRequest => r !== undefined)
    .sort((a, b) => (a.at === b.at ? b.id.localeCompare(a.id) : b.at.localeCompare(a.at)));
}

/**
 * The creature's name as this view knows it. A deleted one stays a target,
 * named for what it was. A DM's view holds the tokens of the scene it shows
 * only, so while the DM looks at a scene other than the players' a token
 * target missing from it may well be on the players' scene still, and is
 * not called removed.
 */
export function targetName(view: Pick<RoomState, "tokens" | "characters" | "meta">, target: Pick<RollTarget, "tokenId" | "characterId">, viewing?: string | null): string {
  if (target.tokenId !== undefined) {
    const token = view.tokens[target.tokenId];
    if (token) return displayName(token);
    return viewing !== undefined && viewing !== view.meta.playerSceneId ? "A token not on this scene" : "A removed token";
  }
  return view.characters[target.characterId ?? ""]?.name ?? "A removed character";
}

/** The DC as a player or the DM reads it: "DC 15", "DC hidden", or nothing for a roll with none. */
export function dcText(request: Pick<RollRequest, "dc" | "dcShown" | "dcHidden">, viewer: "dm" | "player"): string | null {
  if (viewer === "dm") return request.dc === undefined ? null : request.dcShown ? `DC ${request.dc}` : `DC ${request.dc}, hidden from players`;
  if (request.dc !== undefined) return `DC ${request.dc}`;
  return request.dcHidden ? "DC hidden" : null;
}

/**
 * What the player's card says, its DC joined to the question
 * (docs/design-v1-roll-request.md 5.1): "The DM asks for a Strength
 * (Athletics) or Dexterity (Acrobatics) check, DC 12: to break free of the
 * grapple.", "…saving throw against a spell, DC hidden."
 */
export function askLine(request: Pick<RollRequest, "test" | "note" | "dc" | "dcShown" | "dcHidden" | "spell">): string {
  const dc = dcText(request, "player");
  return `The DM asks for ${testText(request.test)}${request.spell ? " against a spell" : ""}${dc ? `, ${dc}` : ""}${request.note ? `: ${request.note}` : ""}.`;
}

/** The test with its noun and no article, for a card's title: "Dexterity saving throw", "Strength or Dexterity saving throw". */
export function testTitle(test: RollTest): string {
  return testText(test).replace(/^an? /, "").replace(/^./, (c) => c.toUpperCase());
}

export { testShortText };

/** One choice in a few letters, as a card names what was rolled: "Str (Athletics)", "Dex". */
export function choiceShort(choice: RollChoice): string {
  const ability = ABILITY_NAMES[choice.ability].slice(0, 3);
  return choice.skill === undefined ? ability : `${ability} (${SKILLS[choice.skill].name})`;
}

export { choiceText };

const RESULT: Record<"pass" | "fail", string> = { pass: "Pass", fail: "Fail" };

function answerWords(answer: RollAnswer, test: RollTest): string | null {
  if (answer.total !== undefined) {
    const choice = test.choices.length > 1 && answer.choice !== undefined ? test.choices[answer.choice] : undefined;
    return choice ? `${choiceShort(choice)} ${answer.total}` : String(answer.total);
  }
  if (answer.noRoll) return "a fail without rolling";
  if (answer.result === "fail") return "a mark of Fail";
  if (answer.result === "pass") return "a mark of Pass";
  return null;
}

/** The reasons a player may ask with, as the DM's row and the menu name them. */
export const CHANGE_REASONS: Record<RollChange["reason"], string> = {
  "heroic-inspiration": "Heroic Inspiration",
  "halfling-luck": "Halfling Luck",
  lucky: "Lucky",
  "bardic-inspiration": "Bardic Inspiration",
  "fix-total": "Fix my total",
};

/**
 * One answer as the DM reads it (docs/design-v1-roll-request.md 6): "rolled
 * 17 (1d20+5: 12)", "typed 17", "failed without rolling", "marked Pass",
 * with a natural 20 or 1, a condition that failed a rolled save, the DM's
 * own mark beside a total, and the choice first when the test offered two,
 * "Dex: rolled 17 (…)". An allowed change names its reason.
 */
function dmWords(answer: RollAnswer, test: RollTest): string | null {
  let words: string;
  if (answer.dice !== undefined) {
    const total = answer.total ?? answer.dice.total;
    const dice = answerDice(answer.dice, answer.typedBonus === true, true);
    const changed = answer.changed;
    if (changed && (changed.reason === "heroic-inspiration" || changed.reason === "halfling-luck")) words = `rerolled ${total} (${CHANGE_REASONS[changed.reason]})`;
    // Lucky on a disadvantage roll cancels to a normal roll and draws nothing, so its words come from the dice, not the ask.
    else if (changed?.reason === "lucky") words = `used Lucky: ${total} (${dice})`;
    else if (changed?.reason === "bardic-inspiration") words = `added a d${changed.die ?? "?"}, now ${total} (Bardic Inspiration)`;
    else words = `rolled ${total} (${dice})`;
    const natural = naturalOf(answer.dice);
    if (natural !== null) words += `, natural ${natural}`;
    if (answer.dice.fails && answer.result === "fail") words += `, fails (${CONDITIONS[answer.dice.fails].name})`;
  } else if (answer.total !== undefined) words = `typed ${answer.total}`;
  else if (answer.noRoll) words = "failed without rolling";
  else if (answer.result !== undefined) return `marked ${RESULT[answer.result]}`;
  else return null;
  if (answer.mark !== undefined) words += `, marked ${RESULT[answer.mark]}`;
  // A pass over a fail without rolling, from before marks were kept apart, reads as the overrule it was.
  else if (answer.noRoll && answer.result === "pass") words += ", marked Pass";
  const choice = test.choices.length > 1 && answer.choice !== undefined ? test.choices[answer.choice] : undefined;
  return choice ? `${choiceShort(choice)}: ${words}` : words;
}

/**
 * The DM's line for one target, beside the Pass and Fail marks: "waiting",
 * "rolled 17 (1d20+5: 12)", "typed 17", "Dex: typed 17", "failed without
 * rolling", "marked Pass", and an answer that replaced another says so:
 * "typed 15, changed from rolled 12 (1d20+5: 7) (Fail)", an allowed change
 * "rerolled 19 (Heroic Inspiration), was 9", a reopen "waiting again, was
 * typed 9 (Pass)".
 */
export function dmAnswerText(target: RollTarget, test: RollTest): string {
  const now = dmWords(target, test) ?? "waiting";
  const previous = target.previous;
  if (!previous || !answered(previous)) return now;
  if (target.changed && answered(target)) return `${now}, was ${previous.total ?? "no total"}`;
  const words = dmWords(previous, test)!;
  const was = previous.total !== undefined && previous.result !== undefined && previous.mark === undefined ? `${words} (${RESULT[previous.result]})` : words;
  return answered(target) ? `${now}, changed from ${was}` : `waiting again, was ${was}`;
}

/**
 * The live card's tally (6): "2 of 3 answered: 1 pass, 1 fail", the counts
 * left out while no answer has a result, and "1 asks to change a roll"
 * while a player's ask waits for the DM.
 */
export function tallyText(request: Pick<RollRequest, "targets">): { answered: string; asks: string | null } {
  const done = request.targets.filter(answered);
  const pass = done.filter((t) => t.result === "pass").length;
  const fail = done.filter((t) => t.result === "fail").length;
  const counts = [pass > 0 ? `${pass} pass` : "", fail > 0 ? `${fail} fail` : ""].filter((c) => c !== "").join(", ");
  const asking = request.targets.filter((t) => t.change !== undefined).length;
  return {
    answered: `${done.length} of ${request.targets.length} answered${counts ? `: ${counts}` : ""}`,
    asks: asking === 0 ? null : `${asking} ${asking === 1 ? "asks" : "ask"} to change a roll`,
  };
}

/** Whether a DM's mark is still wanted: an answer with a total on a request with no DC, and no result yet. */
export function wantsMark(request: Pick<RollRequest, "dc">, target: RollTarget): boolean {
  return request.dc === undefined && target.total !== undefined && target.result === undefined;
}

/**
 * Whether a player's answer is final in their own projection: a rolled one
 * at once (docs/design-v1-dice.md 5.4), and a typed one when the DC is
 * hidden, pass or fail is shown, and the answer has a result, the reducer's
 * from the DC or a DM's mark. Then the chip reads "Final." and the card
 * offers no change of its own. The reducer holds to it whatever this says
 * (shared/reducer/rolls.ts isFinal). A creature the DM rolled for reads
 * the same, since the projection carries no `by`.
 */
export function finalForPlayer(request: Pick<RollRequest, "dcHidden" | "resultShown">, target: Pick<RollTarget, "result" | "dice">): boolean {
  if (target.dice !== undefined) return true;
  return request.dcHidden === true && request.resultShown && target.result !== undefined;
}

/** What a chip's line adds after a final answer, which a tap opens the card to do. */
const ASK_THE_DM = " Ask the DM to change it.";

/**
 * A player's folded chip for one creature: "Dex save: sent 17. Pass.",
 * "sent 17" when pass or fail is hidden, the choice rolled when the test
 * offered two ("Str or Dex save: sent Dex 12. Fail."), "failed without rolling" (from
 * `noRoll`, which their projection keeps on every device whatever the
 * switch says), or "waiting" before an answer. A fail without rolling that
 * the DM overruled to a pass reads as that pass, as the log line does.
 */
export function chipLine(request: Pick<RollRequest, "test" | "dcHidden" | "resultShown">, target: RollTarget, opts: { name?: string } = {}): string {
  const lead = `${testShortText(request.test)}${opts.name ? ` (${opts.name})` : ""}`;
  if (target.dice !== undefined) {
    // A rolled answer is final, with its dice: "Dex save: rolled 17 (1d20+5: 12). Pass. Final."
    const choice = request.test.choices.length > 1 && target.choice !== undefined ? request.test.choices[target.choice] : undefined;
    const verdict = target.result === undefined ? "" : target.result === "fail" && target.dice.fails ? ` Fail (${CONDITIONS[target.dice.fails].name}).` : ` ${RESULT[target.result]}.`;
    return `${lead}: rolled ${choice ? `${choiceShort(choice)} ` : ""}${target.total ?? target.dice.total} (${answerDice(target.dice, target.typedBonus === true)}).${verdict} Final.`;
  }
  // A DM's mark is a result like any other, so it is final on the same request (shared/reducer/rolls.ts isFinal).
  const final = finalForPlayer(request, target) ? ` Final.${ASK_THE_DM}` : "";
  if (target.total !== undefined) {
    const result = target.result !== undefined ? ` ${RESULT[target.result]}.` : "";
    return `${lead}: sent ${answerWords(target, request.test)}.${result}${final}`;
  }
  if (target.result === "pass") return `${lead}: marked Pass by the DM.${final}`;
  if (target.noRoll) return `${lead}: failed without rolling.${final}`;
  if (target.result === "fail") return `${lead}: marked Fail by the DM.${final}`;
  return `${lead}: waiting for your roll.`;
}

/**
 * The name of a chip a tap opens: its lines, then "Open to change it."
 * once any creature on it has an answer it may change, or "Open to ask the
 * DM to change it." (a rolled answer) or "…to fix it." (a typed one) once
 * every answer is final. A request put off with Later has nothing to change
 * yet, so its name stops at "waiting for your roll."
 */
export function chipName(request: Pick<RollRequest, "targets" | "dcHidden" | "resultShown">, lines: readonly string[]): string {
  const text = lines.join(" ");
  const done = request.targets.filter(answered);
  if (done.length === 0) return text;
  // An answer the player may still change opens to change it. A final one opens to ask the DM (docs/design-v1-roll-request.md 5.4).
  if (done.some((t) => !finalForPlayer(request, t))) return `${text} Open to change it.`;
  // The name says the ask once, at its end: a line's own "Ask the DM to change it." would say it twice (LP7-DICE-12).
  const asked = text.replaceAll(ASK_THE_DM, "");
  return done.some((t) => t.dice !== undefined) ? `${asked} Open to ask the DM to change it.` : `${asked} Open to ask the DM to fix it.`;
}

/** What a final answer says on the open card, before "Final. Ask the DM to change it.", read in the chip's order: "Sent Dex 13. Pass". */
export function finalAnswerText(target: RollTarget, test: RollTest): string {
  if (target.total !== undefined) return `Sent ${answerWords(target, test)}${target.result !== undefined ? `. ${RESULT[target.result]}` : ""}`;
  if (target.result === "pass") return "Marked Pass by the DM";
  if (target.noRoll) return "Failed without rolling";
  return "Marked Fail by the DM";
}

/** A total as typed: a whole number from -50 to 100, a typographic minus allowed. */
export function parseTotal(text: string): { ok: true; total: number } | { ok: false; error: string } {
  const t = text.trim().replace(/−/g, "-");
  if (!/^[+-]?\d{1,3}$/.test(t)) return { ok: false, error: "Type the total you rolled, like 17." };
  const n = Number(t);
  if (n < LIMITS.rollTotalMin || n > LIMITS.rollTotalMax) return { ok: false, error: `Use a number from ${LIMITS.rollTotalMin} to ${LIMITS.rollTotalMax}.` };
  return { ok: true, total: n === 0 ? 0 : n };
}

/**
 * What a player typed into a card and has not sent: the total and which
 * choice they rolled, the answer it was typed over (`base`, from
 * answerKey), and whether the Total field has focus. Kept by the player's
 * rolls for each creature a request asks about, because the card itself
 * can be built again: under 600 layout px it stands across the screen and
 * from 600 px it sits in the alerts column, so turning a phone between
 * portrait and landscape mounts it afresh, and focus in the field fell to
 * the page.
 */
export type AnswerDraft = { text: string; choice: 0 | 1; base: string; focused?: boolean; inputs?: RollInputs };

/** The key of one creature's draft on one request. */
export function draftKey(requestId: string, target: Pick<RollTarget, "tokenId" | "characterId">): string {
  return `${requestId}:${targetKey(target)}`;
}

/**
 * A target's answer as the player's view holds it, as one value: equal keys
 * mean the server's answer has not changed. The tag tells a roll or a mark
 * from the answer before it, and an ask or an allowed retype changes it too
 * (docs/design-v1-roll-request.md 5.7), so an answer or an ask from the
 * player's other device forgets the draft.
 */
export function answerKey(target: RollAnswer & Pick<RollTarget, "change" | "retype">): string {
  return [target.total ?? "", target.choice ?? "", target.result ?? "", target.noRoll ? "no roll" : "", target.tag ?? "", target.change?.id ?? "", target.retype ? "retype" : ""].join("|");
}

/**
 * Forgets each draft whose request has closed, or whose creature's answer
 * changed since it was typed: a total sent from this player's other
 * device, a DM's mark, a DM's reopen. Checked on every change, folded
 * card or not: an answer that comes and is then reopened puts the answer
 * back as it stood when the draft was typed, and the stale draft would
 * then come back with the card.
 */
export function forgetStaleDrafts(drafts: Map<string, AnswerDraft>, requests: readonly RollRequest[]): void {
  const answers = new Map<string, string>();
  for (const r of requests) for (const t of r.targets) answers.set(draftKey(r.id, t), answerKey(t));
  for (const [key, draft] of drafts) if (answers.get(key) !== draft.base) drafts.delete(key);
}

/**
 * Keeps the focus mark only on the drafts of the request whose card shows.
 * Only turning the phone mounts that card afresh with the same request:
 * one folded by Send, Later or Back, or put aside by a newer request,
 * never takes focus back when it shows again.
 */
export function keepFocusFor(drafts: Map<string, AnswerDraft>, shownId: string | undefined): void {
  for (const [key, draft] of drafts) if (draft.focused && key.slice(0, key.indexOf(":")) !== shownId) drafts.set(key, { ...draft, focused: false });
}

/**
 * What a creature's answer starts as when its card mounts: the draft, and
 * focus in the Total field if it had it, unless the answer changed since
 * it was typed, such as a total sent from this player's other device,
 * which then wins as it does today. The card can mount in the same render
 * the answer changes, before forgetStaleDrafts runs, so this checks too.
 */
export function startingAnswer(
  target: RollAnswer & Pick<RollTarget, "change" | "retype">,
  draft: AnswerDraft | undefined,
  best: 0 | 1 = 0,
): { text: string; choice: 0 | 1; focused: boolean; inputs: RollInputs } {
  if (draft && draft.base === answerKey(target)) return { text: draft.text, choice: draft.choice, focused: draft.focused === true, inputs: draft.inputs ?? NO_INPUTS };
  // A rolled total is never typed again, so only a typed one fills the field. Two choices start at the higher bonus (5.1).
  const text = target.total !== undefined && target.dice === undefined ? String(target.total) : "";
  return { text, choice: target.choice ?? best, focused: false, inputs: NO_INPUTS };
}

/** Whether any of the creatures a request asked this player about, their own alone in their projection, still waits for an answer. */
export function playerNeedsAnswer(request: RollRequest): boolean {
  return request.targets.some((t) => !answered(t));
}

/**
 * The request a player's card shows: the one whose chip they tapped open,
 * or whose card they started answering (`opened`, set by the first
 * keystroke or choice, so a newer request becomes a chip rather than
 * replacing a half-typed total), else the newest that still needs an
 * answer and that they have not folded (by Send or Later). Every other
 * request is a chip.
 */
export function shownRequest(
  requests: readonly RollRequest[],
  needs: ReadonlyMap<string, boolean>,
  folded: ReadonlySet<string>,
  opened: string | null,
): RollRequest | undefined {
  return requests.find((r) => r.id === opened) ?? requests.find((r) => needs.get(r.id) === true && !folded.has(r.id));
}

/**
 * The request the folded summary opens when the player activates it
 * (docs/design-v1-visual.md 3.3.1). A card already mounted under the sheet
 * comes first, the one shownRequest shows, a chip the player tapped open
 * included, so a total typed into it is never dropped. Only with no card
 * mounted does it take the newest request still waiting for this player,
 * one they put off with Later: `mounted` false says its Later has to be
 * undone for its card to mount. Null when nothing waits and no card is up.
 */
export function requestToOpen(
  requests: readonly RollRequest[],
  needs: ReadonlyMap<string, boolean>,
  folded: ReadonlySet<string>,
  opened: string | null,
): { id: string; mounted: boolean } | null {
  const shown = shownRequest(requests, needs, folded, opened);
  if (shown) return { id: shown.id, mounted: true };
  const waiting = requests.find((r) => needs.get(r.id) === true);
  return waiting ? { id: waiting.id, mounted: false } : null;
}

/**
 * What changed since the last look at the player's requests: those that
 * need an answer and did not before, a new request or one the DM reopened,
 * come up again, and a new one chimes. The first look after the page opens
 * (`before` null) brings them up without a chime, as the turn notice does.
 */
export function cameUp(before: ReadonlyMap<string, boolean> | null, needs: ReadonlyMap<string, boolean>): { unfold: string[]; chime: boolean } {
  const unfold: string[] = [];
  let fresh = false;
  for (const [id, need] of needs) {
    if (!need || before?.get(id) === true) continue;
    unfold.push(id);
    if (!before?.has(id)) fresh = true;
  }
  return { unfold, chime: fresh && before !== null };
}

/**
 * One look at the player's requests, for the effect that brings cards up
 * and chimes (cameUp). The room mounts before its snapshot arrives, and a
 * first look at that empty view would make every request already open look
 * new once the snapshot lands, so a reload would buzz the phone. Until the
 * view has loaded there is no look at all, as the turn notice does.
 */
export function lookAtRequests(
  before: ReadonlyMap<string, boolean> | null,
  needs: ReadonlyMap<string, boolean>,
  loaded: boolean,
): { seen: ReadonlyMap<string, boolean> | null; unfold: string[]; chime: boolean } {
  if (!loaded) return { seen: before, unfold: [], chime: false };
  return { seen: new Map(needs), ...cameUp(before, needs) };
}

/**
 * How the DM's live cards sit in the fight alerts column. From 900 px up
 * the newest starts open. On a phone every card starts folded to one line,
 * and while a sheet stands over the map in portrait (a panel, or the list
 * of panels: `sheetOpen` in state/types.ts) the whole stack folds into one
 * button, since the column sits above sheets and would cover the sheet's
 * header and Close. In landscape the column steps left of the docked sheet,
 * so the cards stay.
 */
export function deskLayout(input: { width: number; height: number; wideMinWidth: number; sheetOpen: boolean }): { startsOpen(index: number): boolean; folded: boolean } {
  const phone = input.width < input.wideMinWidth;
  return {
    startsOpen: (index) => index === 0 && !phone,
    folded: phone && input.width <= input.height && input.sheetOpen,
  };
}

/**
 * The one button a player's chips fold into while a sheet stands over a
 * phone's map in portrait (deskLayout's `folded`, which the DM's cards
 * follow too). The fight alerts column sits above sheets, so a stack of
 * chips would cover the sheet's header and Close. It counts the creatures
 * of theirs the folded requests asked and how many have answered. Its tap
 * closes the sheet to show the chips, or on a phone with no sheet open
 * shows the chips past the first two, or folds them again (chipStack).
 * The name starts with the visible text, so a voice command that says what
 * it sees finds the button (WCAG 2.5.3). Showing and folding is a
 * disclosure, told by aria-expanded, so that name stays the same.
 */
export function foldedChips(requests: readonly RollRequest[], tap: ChipButton = "sheet", under: FoldedUnder = "sheet"): { text: string; label: string } {
  const asked = requests.reduce((n, r) => n + r.targets.length, 0);
  const done = requests.reduce((n, r) => n + r.targets.filter(answered).length, 0);
  const more = tap === "sheet" ? "" : "more ";
  const count = requests.length === 1 ? `1 ${more}roll request` : `${requests.length} ${more}roll requests`;
  const text = `Rolls ${done}/${asked}`;
  const them = requests.length === 1 ? "it" : "them";
  const what = tap !== "sheet" ? "" : under === "sheet" ? ` Close the sheet to see ${them}.` : ` Open to see ${them}.`;
  return { text, label: `${text}: ${count}, ${done} of ${asked} answered.${what}` };
}

/** What the button under a player's chips does: close the sheet over them, show the chips past the first two, or fold those again. */
export type ChipButton = "sheet" | "more" | "less";

/**
 * What a player's folded card stands under: an open sheet, or a popover of
 * the tool's options, which the summary's tap closes as it does the sheet,
 * since a press outside a popover closes it.
 */
export type FoldedUnder = "sheet" | "popover";

/** How many chips a phone shows before the rest fold into the button. */
export const PHONE_CHIPS = 2;

/**
 * How a player's chips, or the DM's cards, stand in the fight alerts
 * column: how many show, and which button follows them. Under a sheet on a
 * portrait phone none show (foldedChips), nor in landscape while the
 * player's card is folded under one (cardFoldsUnderSheet), since the card
 * folds into the same summary. On a phone otherwise only the newest two
 * do, since a stack would cover most of the map until the DM closes the
 * requests, and the button shows the rest or folds them again
 * (LP5-ROLLS-8, docs/design-v1-visual.md 3.3.1). From 900 px up the
 * column has room for all of them.
 */
export function chipStack(input: { count: number; phone: boolean; underSheet: boolean; expanded: boolean }): { shown: number; button: ChipButton | null } {
  if (input.count === 0) return { shown: 0, button: null };
  if (input.underSheet) return { shown: 0, button: "sheet" };
  if (!input.phone || input.count <= PHONE_CHIPS) return { shown: input.count, button: null };
  return input.expanded ? { shown: input.count, button: "less" } : { shown: PHONE_CHIPS, button: "more" };
}

/**
 * Whether a phone's chips, once shown past the first two, stay shown: while
 * the player has more requests than the first two. It counts requests, not
 * chips, since a chip the player opens leaves the chips while its card is
 * up, and the player would come back from it to a folded stack
 * (POSTW5-OPUS-7). With two or fewer, nothing is left to fold, so a later
 * third request starts folded, as a phone's chips always do.
 */
export function chipsStayShown(requests: number): boolean {
  return requests > PHONE_CHIPS;
}

/** Below this layout width the player's card is a sheet across the screen over the toolbar. From it up the card sits in the fight alerts column. */
export const CARD_MIN_WIDTH = 600;

/**
 * Whether the player's card folds while a sheet is open
 * (docs/design-v1-visual.md 3.3.1): whenever it would cover the sheet. The
 * card across the screen (under 600 layout px, portrait or landscape) would
 * cover the sheet's lower half, and in portrait the column's card would
 * cover the sheet's header (the desk's rule). It folds rather than moving
 * to the column since at 667 x 375 at 115% the layout is 580 px wide, the
 * right-hand sheet takes 340, and the 240 px left are narrower than the
 * column's 300 px card. Folded, it stays mounted, so what was typed into
 * it survives.
 */
export function cardFoldsUnderSheet(input: { width: number; height: number; wideMinWidth: number }): boolean {
  return input.width < CARD_MIN_WIDTH || (input.width < input.wideMinWidth && input.width <= input.height);
}

/**
 * What a player's requests say as one summary while they are folded under
 * a sheet (3.3.1), and as the rolls' part of the dock's alerts summary
 * (3.2.1, components/sheetFocus.ts). "Roll asked" while any request waits
 * for this player's answer, since that is the one thing to act on, else
 * "Rolls d/a" over every request. `name` is the words for a button's name,
 * with no closing advice: the dock adds its own after the other alerts.
 *
 * "Roll asked" names the request a tap opens (`opens`, from requestToOpen):
 * the card mounted under the sheet when there is one, else the newest
 * waiting. Naming the newest alone told a player who had typed into an
 * older card that the tap would bring up another roll.
 */
export function rollsSummary(requests: readonly RollRequest[], opens: string | null = null): { text: string; name: string; waiting: boolean } {
  const waiting = requests.filter(playerNeedsAnswer);
  const named = requests.find((r) => r.id === opens) ?? waiting[0];
  if (named && waiting.length > 0) {
    const more = waiting.filter((r) => r.id !== named.id).length;
    const rest = more === 0 ? "" : more === 1 ? " and 1 more roll" : ` and ${more} more rolls`;
    return { text: "Roll asked", name: `the DM asks for ${testText(named.test)}${rest}`, waiting: true };
  }
  return { ...answeredCount(requests), waiting: false };
}

/** "Rolls 1/3" and "rolls 1 of 3 answered", counting every creature the requests asked. The DM's desk publishes the same. */
export function answeredCount(requests: readonly RollRequest[]): { text: string; name: string } {
  const asked = requests.reduce((n, r) => n + r.targets.length, 0);
  const done = requests.reduce((n, r) => n + r.targets.filter(answered).length, 0);
  return { text: `Rolls ${done}/${asked}`, name: `rolls ${done} of ${asked} answered` };
}

/**
 * The player's own summary button while everything folds under a sheet, or
 * under a popover of the tool's options (FoldedUnder): "Roll asked" with
 * what to answer while a request waits, else the folded chips' count
 * (foldedChips). Its tap closes the sheet or the popover, so it is no
 * disclosure, and its name starts with its visible text (WCAG 2.5.3).
 */
export function sheetSummary(requests: readonly RollRequest[], opens: string | null = null, under: FoldedUnder = "sheet"): { text: string; label: string } {
  const summary = rollsSummary(requests, opens);
  if (!summary.waiting) return foldedChips(requests, "sheet", under);
  return { text: summary.text, label: `${summary.text}: ${summary.name}. ${under === "sheet" ? "Close the sheet" : "Open it"} to answer.` };
}

// ------------------------------------------------------------ one creature's answer on the card

/** What one creature's answer may send (docs/design-v1-roll-request.md 5.6). */
export type AnswerOp = "roll" | "send" | "fail" | "ask" | "withdraw";

/**
 * One creature's answer on the player's card, as a small machine (5.6):
 * idle, or busy with one op until that op's own answer, and the words of
 * the last refusal under the rows. The card draws it, and its randomized
 * test drives it (card.random.test.ts).
 */
export type AnswerFlow = { busy: { op: AnswerOp; tag: string } | null; error: string | null };

export const IDLE: AnswerFlow = { busy: null, error: null };

/** Which ops the card offers a creature now, whatever the flow: each needs the request to hold the creature still. */
export type AnswerOffers = Record<AnswerOp, boolean>;

/**
 * What the card offers (5.2, 5.5): Roll only while the creature waits, not
 * for a retype, with the Total field empty, a bonus known or typed and the
 * socket open. Send and Fail only on an answer that is not final, and Send
 * only while the room lets players type their totals. Ask only on a final
 * answer, where a new ask replaces a pending one, and on a typed one, whose
 * one ask is "Fix my total", only while players may type. Withdraw only
 * with one pending. A request that no longer holds the creature offers nothing.
 */
export function answerOffers(input: {
  holds: boolean;
  request: Pick<RollRequest, "test" | "dcHidden" | "resultShown">;
  target: RollTarget;
  text: string;
  connected: boolean;
  bonusReady: boolean;
  /** The room's "Players may type their roll totals" (shared/permissions.ts playersTypeTotals). */
  typeTotals: boolean;
}): AnswerOffers {
  const { request, target } = input;
  if (!input.holds) return { roll: false, send: false, fail: false, ask: false, withdraw: false };
  const final = finalForPlayer(request, target);
  // A total typed before the room turned typed totals off is hidden with its field, so it holds nothing back.
  const typed = input.typeTotals && input.text.trim() !== "";
  return {
    roll: !answered(target) && target.retype !== true && !typed && input.connected && input.bonusReady,
    send: !final && typed && input.typeTotals,
    fail: !final && request.test.kind === "save",
    // A newer item replaces a pending ask (5.5). An answer from before tags has none, and no ask can name it.
    ask: final && target.tag !== undefined && (target.dice !== undefined || input.typeTotals),
    withdraw: target.change !== undefined,
  };
}

/** Where an op whose answer was lost landed, read from the target while the request is open (5.6). */
export type Landing = "mine" | "other" | "none";

export function landingOf(target: RollTarget | undefined, tag: string): Landing {
  if (!target) return "none";
  if (target.tag === tag || target.change?.id === tag) return "mine";
  return answered(target) ? "other" : "none";
}

export type AnswerEvent =
  /** A tap of one op, taken only when idle and offered, with the tag its op will carry. */
  | { t: "tap"; op: AnswerOp; tag: string; offers: AnswerOffers }
  /** What the card refuses before sending, in the server's own words. */
  | { t: "check"; error: string }
  /** The answer to the busy op. A lost one is settled by where it landed, never sent again. */
  | { t: "answer"; tag: string; answer: "taken" | "refused" | "unknown"; text?: string; landing?: Landing }
  /** A keystroke or a choice, which clears the last refusal. */
  | { t: "edit" };

export function answerFlow(state: AnswerFlow, event: AnswerEvent): AnswerFlow {
  switch (event.t) {
    case "tap":
      return state.busy !== null || !event.offers[event.op] ? state : { busy: { op: event.op, tag: event.tag }, error: null };
    case "check":
      return state.busy !== null ? state : { busy: null, error: event.error };
    case "answer": {
      if (state.busy === null || state.busy.tag !== event.tag) return state;
      if (event.answer === "taken") return IDLE;
      if (event.answer === "refused") return { busy: null, error: event.text ?? "Not sent." };
      // Unknown is settled by the target, never retried: this device's answer landed, another came first, or it never landed and Roll comes back.
      return event.landing === "other" ? { busy: null, error: ANSWERED_FIRST } : IDLE;
    }
    case "edit":
      return state.error === null ? state : { ...state, error: null };
  }
}

/**
 * Whether a typed Send or Fail folds the card (5.4): once every creature on
 * it has an answer, unless it shows a result rolled while it was up, which
 * waits for Done.
 */
export function foldsAfterSend(request: Pick<RollRequest, "targets">, sentKey: string, rolledHere: ReadonlySet<string>): boolean {
  return rolledHere.size === 0 && request.targets.every((t) => targetKey(t) === sentKey || answered(t));
}

/** A lost answer whose creature another answer reached first, from the player's other device or the DM. */
export const ANSWERED_FIRST = "Another answer came first.";

const ASK_LOST = "The connection dropped before the server answered, so the request may not have gone out. Check the cards, then send again.";

/**
 * What the DM's sheet does with the server's answer to its `roll.ask`: it
 * closes once the request is taken, and otherwise stays open with what the
 * DM set up and the reason, such as 20 requests already open by the time
 * it arrived, or a connection that dropped before the server answered.
 */
export function askAnswer(answer: OpAnswer, refusal?: OpRefusal): { kind: "sent" } | { kind: "kept"; problem: string } {
  if (answer === "taken") return { kind: "sent" };
  if (answer === "unknown") return { kind: "kept", problem: ASK_LOST };
  return { kind: "kept", problem: refusal?.text ?? "The server refused the request. Check it and send again." };
}

/** The DM's sheet as it asks: what is set up, whether its request waits for the server's answer, and what to fix. */
export type AskSheet = { draft: AskDraft; sending: boolean; error: string | null };

/**
 * An edit on the sheet. While its request waits for the server, the sheet
 * is locked, since the sheet closes on the answer and an edit made after
 * Send would be lost without a word.
 */
export function editAsk(sheet: AskSheet, patch: Partial<AskDraft>): AskSheet {
  if (sheet.sending) return sheet;
  return { ...sheet, draft: { ...sheet.draft, ...patch }, error: null };
}

/** The server's answer to the sheet's request: taken closes it, and a refusal or a lost answer unlocks it with the reason (askAnswer). */
export function answerAsk(sheet: AskSheet, answer: OpAnswer, refusal?: OpRefusal): { close: true } | { close: false; sheet: AskSheet } {
  const outcome = askAnswer(answer, refusal);
  return outcome.kind === "sent" ? { close: true } : { close: false, sheet: { ...sheet, sending: false, error: outcome.problem } };
}

/** What Send says while the request waits: offline, it waits for the connection, as the pin pane and journal editor say. */
export function sendLabel(sending: boolean, connected: boolean): string {
  if (!sending) return "Send";
  return connected ? "Sending…" : "Waiting for the connection to send…";
}

/**
 * What a player's Send says for one creature: "Send", "Change" once it has
 * an answer, and while the answer waits for the server the DM sheet's words,
 * so offline it says it waits for the connection (LP5-ROLLS-11).
 */
export function answerLabel(sending: boolean, connected: boolean, hasAnswer: boolean): string {
  if (sending) return sendLabel(true, connected);
  return hasAnswer ? "Change" : "Send";
}

/**
 * What closing the sheet says while its request waits for the server. The
 * op is queued and the store sends it again after a reconnect, so the
 * request goes out whatever the sheet does: closing takes nothing back, and
 * the button reads Close rather than Cancel (as journal/pendingSave.ts).
 */
export function pendingAskCloseText(connected: boolean): string {
  return connected ? "The request is still sending." : "The request will send when the connection is back.";
}

/**
 * What a request says when the server answers after its sheet closed, in a
 * toast: nothing when it went out, and otherwise that it did not, since the
 * sheet that would have shown why is gone.
 */
export function closedAskText(answer: OpAnswer, refusal?: OpRefusal): string | null {
  if (answer === "taken") return null;
  if (answer === "unknown") return ASK_LOST;
  return refusal ? `The request was not sent. ${refusal.text.replace(/^Not saved\.\s*/, "")}`.trim() : "The request was not sent.";
}
