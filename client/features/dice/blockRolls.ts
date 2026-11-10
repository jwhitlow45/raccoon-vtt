import { bonusFor, type D20Test } from "#shared/dice/bonus.ts";
import { startsSecret } from "#shared/dice/secret.ts";
import type { AbilityKey, CharacterId, RoomState, SkillKey, TokenId } from "#shared/model.ts";
import { playersTypeTotals } from "#shared/permissions.ts";
import { playersToken } from "#shared/project.ts";
import type { ActorTarget } from "#shared/protocol.ts";
import type { Proficiency } from "#shared/rules/proficiency.ts";
import type { RollPreset } from "#shared/rules/rollReminders.ts";
import { ABILITY_NAMES, SKILLS, skillsOf } from "#shared/rules/skills.ts";
import { displayName } from "../../lib/scene.ts";
import type { You } from "../../state/types.ts";
import { requestRollSource } from "../rolls/card.ts";
import { ownsCharacter } from "../tokens/access.ts";
import { creatureProficiency, type CreatureRolls, type DiceView } from "./creature.ts";
import { creatureKey, initiativeRow, initiativeTag, playerCreatures, presetLine, presetTag, routedTest, routeOf, scoreOf, signedText, testLabel } from "./options.ts";
import { presetFor } from "./presets.ts";
import { marksTest } from "./proficiencyPresentation.ts";
import type { RollModeCapability } from "./rollMode.ts";
import type { Labels } from "../../lib/labels.ts";

/**
 * Rolling from a stat block's ability boxes (docs/design/design-v1-stat-block-rolls.md),
 * free of React: whose block rolls, and each ability's rows, built from the
 * Dice panel's own rules so a roll is one roll wherever it shows.
 */

/** Where a block is mounted: a token's panel, the PC token's included, or a character's page. */
export type BlockFrom = { tokenId: TokenId } | { characterId: CharacterId };

/**
 * The creature a block's boxes roll for (section 2): its target in the
 * Dice panel's form, its token on the viewer's scene where it has one, its
 * name, and whether a player plays it, which the DM's ask reads.
 */
export type BlockRoller = { creature: ActorTarget; tokenId?: TokenId; name: string; played: boolean };

/** Who rolls from a block, or null where its boxes stay text (section 2). */
export function blockRoller(view: RoomState, you: You, sceneId: string | null, from: BlockFrom, labels: Labels): BlockRoller | null {
  const dm = you.role === "dm";
  const onScene = (t: RoomState["tokens"][string]) => t.sceneId === sceneId;
  if ("characterId" in from) {
    const character = view.characters[from.characterId];
    if (!character) return null;
    // The token the Dice panel picks for it: its first on the viewer's scene (playerCreatures).
    const token = Object.values(view.tokens).find((t) => onScene(t) && "ref" in t.actor && t.actor.ref === character.id);
    if (dm ? token === undefined : !ownsCharacter(you.memberId, character)) return null;
    return characterRoller(view, dm, character, token, labels);
  }
  const token = view.tokens[from.tokenId];
  if (!token || token.kind === "object") return null;
  if ("ref" in token.actor) {
    const character = view.characters[token.actor.ref];
    // The DM rolls for a character through a token on the scene in view. A player rolls for their own character wherever its token stands, and never with numbers they do not hold.
    if (!character || (dm ? !onScene(token) : !ownsCharacter(you.memberId, character))) return null;
    return characterRoller(view, dm, character, token, labels);
  }
  if (dm ? !onScene(token) : !playerCreatures(view, you.memberId, sceneId, (t) => displayName(t, labels)).some((o) => "tokenId" in o.creature && o.creature.tokenId === token.id)) return null;
  return { creature: { tokenId: token.id }, tokenId: token.id, name: displayName(token, labels), played: dm && playersToken(view, token) };
}

/** A character's roller, its token the one on the viewer's scene, played as the Dice panel's card reads it (RollOptions useCtx). */
function characterRoller(view: RoomState, dm: boolean, character: RoomState["characters"][string], token: RoomState["tokens"][string] | undefined, labels: Labels): BlockRoller {
  const played = dm && (token ? playersToken(view, token) : character.ownerIds.some((id) => view.members[id]?.kind === "player"));
  return { creature: { characterId: character.id }, ...(token ? { tokenId: token.id } : {}), name: character.name, played };
}

/** The tests in the Dice panel's exact shapes, so their row keys match its cells' (section 7). */
export function saveTest(ability: AbilityKey): Extract<D20Test, { kind: "save" }> {
  return { kind: "save", ability };
}

export function checkTest(ability: AbilityKey): Extract<D20Test, { kind: "check" }> {
  return { kind: "check", ability };
}

export function skillTest(ability: AbilityKey, skill: SkillKey): Extract<D20Test, { kind: "check" }> {
  return { kind: "check", ability, skill };
}

/** A box's accessible description: what its list holds (3.2). */
export function boxDescription(ability: AbilityKey): string {
  if (ability === "con") return "Opens the check and the save";
  if (ability === "dex") return "Opens the check, the save, its skills and Initiative";
  return "Opens the check, the save and its skills";
}

/** One row of an ability's list (4.2): a roll, or in a score room the score that sets the row without dice (4.3). */
export type AbilityRow = {
  /** Unique in its list: "check", "save", a skill's key, "initiative" or "score". */
  id: string;
  kind: "check" | "save" | "skill" | "initiative" | "score";
  /** What it rolls. Null for the score, which rolls nothing. */
  test: D20Test | null;
  /** Its name at the row's start, which typeahead reads: "Check", "Save", "Stealth", "Initiative", "Initiative score", "Roll initiative". */
  words: string;
  /** The bonus it rolls, or the score it sets. */
  bonus: number;
  /** "+6", "−1", or the score's "12". */
  bonusText: string;
  /** Small muted words after its name: "Asked", "Asks", a preset's tag, Initiative's tracker tag. Empty for none. */
  tag: string;
  /** Its proficiency mark, for a save or a skill. */
  level?: Proficiency;
  /** Where its tap goes. "score" sets the tracker row. */
  route: "roll" | "answer" | "ask" | "score";
  /** Its one-roll options, or null where it has none: an ask, the score. */
  capability: RollModeCapability | null;
  /** The Dice panel's row key, so a waiting roll is busy in both places. */
  rowKey: string;
  /** Everything that names this roll and its route, for its options to go back to the list when it changes (5.4). */
  source: string;
  /** Its accessible name: "Dexterity save +2, proficient, answers the DM's request, Dis: Restrained". */
  name: string;
  /** Its options' title: "Dexterity save +2", "Stealth +6", "Roll initiative +2". */
  title: string;
  /** The roll's label, as the Dice panel's cell labels it. */
  label: string;
  /** The preset its tap sends, for the routed test. */
  preset: RollPreset;
  /** Initiative's and the score's tracker row. */
  entryId?: string;
};

export type AbilityRowsInput = {
  dice: DiceView;
  rolls: CreatureRolls;
  roller: BlockRoller;
  /** The Dice panel's Ask switch is on for this creature (its default). */
  ask: boolean;
};

/** An ability's rows in order (4.1), or none while its creature has no numbers. */
export function abilityRows(ability: AbilityKey, input: AbilityRowsInput): AbilityRow[] {
  const { dice, rolls, roller } = input;
  const numbers = rolls.numbers;
  if (!numbers) return [];
  const state = dice.view;
  const dm = dice.you.role === "dm";
  const { creature } = roller;
  const key = creatureKey(state, creature);
  const presetOf = (test: D20Test) => presetFor(dice, creature, test, { rolls });
  // A DM's free roll for a creature no player plays starts secret, so Roll secretly would repeat the tap (D-261031-131).
  const secretTap = startsSecret(state, dm, [creature]);
  const tests: { id: string; kind: AbilityRow["kind"]; test: Extract<D20Test, { kind: "save" | "check" }>; words: string }[] = [
    { id: "check", kind: "check", test: checkTest(ability), words: "Check" },
    { id: "save", kind: "save", test: saveTest(ability), words: "Save" },
    ...skillsOf(ability).map((skill) => ({ id: skill, kind: "skill" as const, test: skillTest(ability, skill), words: SKILLS[skill].name })),
  ];
  const out: AbilityRow[] = tests.map(({ id, kind, test, words }) => {
    const route = routeOf({ state, creature, test, dm, played: roller.played, ask: input.ask });
    const preset = presetOf(routedTest(route, test));
    const bonus = bonusFor(numbers, test) ?? 0;
    const level = marksTest(test) ? creatureProficiency(dice, creature, test) : undefined;
    const title = kind === "skill" ? `${words} ${signedText(bonus)}` : `${ABILITY_NAMES[ability]} ${kind} ${signedText(bonus)}`;
    const how = route.kind === "answer" ? "answers the DM's request" : route.kind === "ask" ? `asks ${roller.name}` : "";
    const rowKey = `${key}|${JSON.stringify(test)}`;
    const sourceRoute = route.kind === "answer" ? [route.kind, requestRollSource(route.request, route.target), route.choice] : route;
    return {
      id,
      kind,
      test,
      words,
      bonus,
      bonusText: signedText(bonus),
      // The whole preset tag on each row, since no group label carries the shared parts here (D-261031-135).
      tag: [route.kind === "answer" ? "Asked" : route.kind === "ask" ? "Asks" : "", presetTag(preset)].filter(Boolean).join(" "),
      ...(level !== undefined ? { level } : {}),
      route: route.kind,
      // An ask has no one-roll options (docs/design/design-v1-roll-mode-menu.md 4). An answer keeps the request's visibility, so Secret stays with its reason (D-261031-169).
      capability: route.kind === "ask" ? null : route.kind === "answer" ? { d20: true, visibility: "request" } : { d20: true, visibility: "selectable", ...(secretTap ? { secretByDefault: true } : {}) },
      rowKey,
      source: JSON.stringify([rowKey, sourceRoute, test, bonus, preset, creature, input.ask]),
      name: [`${title}${spoken(level)}`, how, presetLine(preset)].filter(Boolean).join(", "),
      title,
      label: testLabel(test),
      preset,
    };
  });
  if (ability === "dex" && rolls.initBonus !== null) out.push(...initiativeRows(input, key, secretTap, rolls.initBonus, presetOf({ kind: "initiative" })));
  return out;
}

/** What a row's name adds for its mark, as ProficiencyMark's spokenProficiency words it, kept here so this file needs no React. */
function spoken(level: Proficiency | undefined): string {
  return level === "expert" ? ", expertise" : level === "prof" ? ", proficient" : "";
}

/**
 * Initiative under Dexterity (4.3): one roll, or in a room that uses
 * scores, for a monster with a row, the score that sets the row without
 * dice and then the roll, as the Dice panel's "Score 12" and "Roll instead"
 * (InitiativeCell).
 */
function initiativeRows(input: AbilityRowsInput, key: string, secretTap: boolean, bonus: number, preset: RollPreset): AbilityRow[] {
  const state = input.dice.view;
  const dm = input.dice.you.role === "dm";
  const { creature } = input.roller;
  const entry = initiativeRow(state, creature);
  // A score set without a roll is a typed value to the server, which a player's room may have off (shared/permissions.ts playersTypeTotals).
  const score = entry && (dm || playersTypeTotals(state.meta.settings)) ? scoreOf(state, creature) : null;
  const scored = score !== null && entry !== undefined;
  const rowKey = `${key}|initiative`;
  const title = `${scored ? "Roll initiative" : "Initiative"} ${signedText(bonus)}`;
  const does = scored ? "replaces the score" : entry ? (entry.value === null ? "sets its row" : `replaces ${entry.value}`) : "";
  const roll: AbilityRow = {
    id: "initiative",
    kind: "initiative",
    test: { kind: "initiative" },
    words: scored ? "Roll initiative" : "Initiative",
    bonus,
    bonusText: signedText(bonus),
    tag: scored ? ["replaces the score", initiativeTag(null, preset)].filter(Boolean).join(" · ") : initiativeTag(entry ?? null, preset),
    route: "roll",
    capability: { d20: true, visibility: "selectable", ...(secretTap ? { secretByDefault: true } : {}) },
    rowKey,
    source: JSON.stringify([rowKey, entry, bonus, preset, creature]),
    name: [title, does, presetLine(preset)].filter(Boolean).join(", "),
    title,
    label: "Initiative",
    preset,
    ...(entry ? { entryId: entry.id } : {}),
  };
  if (!scored) return [roll];
  const scoreRow: AbilityRow = {
    id: "score",
    kind: "score",
    test: null,
    words: "Initiative score",
    bonus: score,
    bonusText: String(score),
    tag: "",
    route: "score",
    capability: null,
    rowKey: `${key}|initiative-score`,
    source: JSON.stringify([rowKey, entry, score]),
    name: `Initiative score ${score}, sets its row`,
    title: `Initiative score ${score}`,
    label: "Initiative",
    preset,
    entryId: entry.id,
  };
  return [scoreRow, roll];
}
