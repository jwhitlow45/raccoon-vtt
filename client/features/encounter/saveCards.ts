import type { D20Test, NamedRoll } from "#shared/dice/bonus.ts";
import { advantageFields, type AdvantageSource } from "#shared/dice/formula.ts";
import type { Effect, LogEntry, RollChange, RollTarget, RoomState } from "#shared/model.ts";
import { anyPlayer, playersToken } from "#shared/project.ts";
import type { ActorTarget, ClientOp } from "#shared/protocol.ts";
import { dcOnLine, startsSecret } from "#shared/dice/secret.ts";
import type { RollPreset } from "#shared/rules/rollReminders.ts";
import { resultOf } from "#shared/rules/rolls.ts";
import type { PendingSave } from "#shared/rules/saveEnds.ts";
import { ABILITY_NAMES } from "#shared/rules/skills.ts";
import { effectName } from "#shared/logText.ts";
import { effectChip } from "../../lib/tokenView.ts";
import { creatureKey, d20Roll, presetLine, signedText, testLabel } from "../dice/options.ts";
import type { PanelRoll } from "../dice/useDicePanel.ts";
import { askOp, targetRef, type AskCheck } from "../rolls/logic.ts";
import { entryName, playerOwnedEntry } from "./logic.ts";

/**
 * The fight alerts' cards that roll a save after the fact
 * (docs/design-v1-roll-options.md 6.1, 6.2 and 6.4), free of React so
 * node --test covers them: which cards show, the buttons each offers, what
 * each button sends and the words. The save-ends cards are the DM's, read
 * from the effects alone (shared/rules/saveEnds.ts), so a reload brings
 * back exactly the occurrences still pending.
 */

// ------------------------------------------------------------ the card's own roll

/**
 * Adv or Dis pressed on the card itself (6.3): one more advantage source
 * for its roll, never the Dice panel's choices, which a roll with `to`
 * neither applies nor takes.
 */
export type CardChip = "adv" | "dis" | null;

export function chipSources(chip: CardChip): AdvantageSource[] {
  return chip ? [{ kind: chip, from: "pressed" }] : [];
}

/** A chip's tap: the other one goes off, as the Dice panel's do. */
export function pressChip(chip: CardChip, pressed: "adv" | "dis"): CardChip {
  return chip === pressed ? null : pressed;
}

/** A card's d20 roll for its creature: the bonus, the preset's sources and extra, and the card's chip. */
export function cardRoll(creature: ActorTarget, bonus: number, preset: RollPreset, test: D20Test, chip: CardChip): PanelRoll {
  const roll = d20Roll(creature, bonus, preset, testLabel(test));
  return { ...roll, sources: [...(roll.sources ?? []), ...chipSources(chip)] };
}

/** "Roll +1", the words of every card's Roll. */
export function rollText(bonus: number): string {
  return `Roll ${signedText(bonus)}`;
}

/** "Use Legendary Resistance (2 left)". */
export function resistText(left: number): string {
  return `Use Legendary Resistance (${left} left)`;
}

/** The uses of Legendary Resistance an actor has left. */
export function legendaryLeft(actor: { legendary?: { resistMax: number; resistUsed: number } } | undefined): number {
  const legendary = actor?.legendary;
  return legendary ? Math.max(0, legendary.resistMax - legendary.resistUsed) : 0;
}

// ------------------------------------------------------------ save ends

/** The test a save-ends card rolls: its ability, its cause, and "against a spell" from the effect (3.2). */
export function saveEndsTest(effect: PendingSave["effect"]): Extract<D20Test, { kind: "save" }> {
  const test: Extract<D20Test, { kind: "save" }> = { kind: "save", ability: effect.save.ability, cause: "saveEnds" };
  if (effect.save.spell) test.spell = true;
  return test;
}

/** What the DM's view knows of a save-ends card's creature. */
export type SaveFacts = {
  name: string;
  /** A player plays it, so its save is that player's to roll (16). */
  played: boolean;
  /** A request can go to it now: a character, or a token on the players' scene (shared/reducer/rolls.ts rollAsk). */
  askable: boolean;
  legendaryLeft: number;
};

type FactsView = Pick<RoomState, "tokens" | "characters" | "members" | "meta">;

export function saveFacts(view: FactsView, target: ActorTarget): SaveFacts {
  const name = entryName(view, target);
  if ("characterId" in target) {
    const character = view.characters[target.characterId];
    const played = character !== undefined && anyPlayer(view, character.ownerIds);
    return { name, played, askable: played, legendaryLeft: legendaryLeft(character?.actor) };
  }
  const token = view.tokens[target.tokenId];
  const played = token !== undefined && playersToken(view, token);
  const actor = token && "inline" in token.actor ? token.actor.inline : undefined;
  return { name, played, askable: played && token.sceneId === view.meta.playerSceneId, legendaryLeft: legendaryLeft(actor) };
}

/** An effect as its chip names it: "Frightened", "Concentrating: Bless", a custom effect's label. */
export function effectWords(effect: Pick<Effect, "key" | "label" | "glyph" | "color" | "level" | "spell">): string {
  return effectChip(effect).label;
}

/** "Goblin 2 ended its turn Frightened." and "Wisdom save, DC 15, ends it." (6.1). */
export function saveEndsWords(name: string, effect: PendingSave["effect"]): { head: string; save: string } {
  return { head: `${name} ended its turn ${effectWords(effect)}.`, save: `${ABILITY_NAMES[effect.save.ability]} save, DC ${effect.save.dc}, ends it.` };
}

export type SaveAction = "ask" | "roll" | "pass" | "fail" | "resist" | "accept" | "dismiss";
export type CardButton<A extends string> = { action: A; text: string };

export type SaveCardInput = {
  pending: PendingSave;
  facts: SaveFacts;
  /** The save's bonus, null where none is known. */
  bonus: number | null;
  /** The creature's block is still loading, so neither its bonus nor its Magic Resistance is known yet. */
  loading: boolean;
  preset: RollPreset | null;
  /** The DM tapped Failed while a choice was left, which sends nothing yet. */
  failTapped: boolean;
  /** The total of the card's own roll once its line landed. */
  rolled: number | null;
};

export type SaveCardModel = {
  head: string;
  save: string;
  /** What stands now, under the card's words: who was asked, an answer, a fail, a pending ask to change it. */
  status: string | null;
  /** The roll's preset in a few words, while Roll shows: "Dis: Restrained. +1d4: Blessed". */
  rollNote: string | null;
  buttons: CardButton<SaveAction>[];
  /** Roll shows, waiting for the creature's block: busy, and its tap does nothing yet. */
  rollLoading: boolean;
};

const CHANGE_WORDS: Record<RollChange["reason"], string> = {
  "heroic-inspiration": "asks to reroll (Heroic Inspiration)",
  "halfling-luck": "asks to reroll (Halfling Luck)",
  lucky: "asks for advantage (Lucky)",
  "bardic-inspiration": "asks to add a die (Bardic Inspiration)",
  "fix-total": "asks to fix the total",
};

/**
 * A player's pending ask to change a fail, as doc 4's live card names it:
 * "Bree asks to reroll (Heroic Inspiration).". Allow and Keep are doc 4's
 * (docs/design-v1-roll-request.md 1.1), and Accept failure settles the ask
 * as Keep.
 */
export function changeWords(name: string, change: RollChange): string {
  const words = change.reason === "bardic-inspiration" && change.die !== undefined ? `asks to add a d${change.die} (Bardic Inspiration)` : CHANGE_WORDS[change.reason];
  return `${name} ${words}.`;
}

function answered(target: RollTarget): boolean {
  return target.total !== undefined || target.result !== undefined || target.noRoll === true;
}

/** A linked request's answer on the card: "Bree rolled 9: a fail.", "Bree failed without rolling.", "Marked failed.". */
export function answerStatus(name: string, target: RollTarget, dc: number | undefined): string {
  if (!answered(target)) return `Asked ${name}. Waiting for the roll.`;
  const result = resultOf(target, dc);
  const outcome = target.dice?.fails ? `fails (${effectName(target.dice.fails)})` : result === "pass" ? "a pass" : result === "fail" ? "a fail" : null;
  if (target.mark !== undefined && target.total === undefined) return target.mark === "pass" ? "Marked passed." : "Marked failed.";
  if (target.total === undefined) return target.noRoll ? `${name} failed without rolling.` : result === "pass" ? "Marked passed." : "Marked failed.";
  const verb = target.dice ? "rolled" : "answered";
  const marked = target.mark !== undefined ? `, marked ${target.mark === "pass" ? "passed" : "failed"}` : "";
  return outcome ? `${name} ${verb} ${target.total}${marked}: ${outcome}.` : `${name} ${verb} ${target.total}${marked}.`;
}

/**
 * The buttons of one save-ends card (6.1). A choice is left after a fail
 * while the creature has Legendary Resistance uses or a request is linked:
 * then the fail shows with Accept failure, and Use Legendary Resistance
 * for a creature with uses. With none, a fail settles at once. A `fails`
 * preset marks it failed, so it offers no roll that could pass, and its one
 * tap settles it. Dismiss stands until a fail shows.
 */
export function saveCard(input: SaveCardInput): SaveCardModel {
  const { pending, facts, preset } = input;
  const { effect, request } = pending;
  const words = saveEndsWords(facts.name, effect);
  const fails = preset?.fails;
  const settle: CardButton<SaveAction>[] = [
    ...(facts.legendaryLeft > 0 ? [{ action: "resist" as const, text: resistText(facts.legendaryLeft) }] : []),
    { action: "accept", text: "Accept failure" },
  ];
  const marks: CardButton<SaveAction>[] = [
    { action: "pass", text: "Passed" },
    { action: "fail", text: "Failed" },
    { action: "dismiss", text: "Dismiss" },
  ];
  const canRoll = !fails && (input.loading || (input.bonus !== null && preset !== null));
  const roll: CardButton<SaveAction>[] = canRoll ? [{ action: "roll", text: input.bonus !== null ? rollText(input.bonus) : "Roll" }] : [];
  const rollNote = canRoll && preset ? presetLine(preset) || null : null;
  const base = { ...words, rollLoading: canRoll && input.loading };

  if (request) {
    const target = request.targets[0];
    if (!target) return { ...base, status: null, rollNote: null, buttons: [], rollLoading: false };
    const change = target.change ? changeWords(facts.name, target.change) : null;
    const status = [answerStatus(facts.name, target, request.dc), change].filter(Boolean).join(" ");
    const result = resultOf(target, request.dc);
    if (result === "fail") return { ...base, status, rollNote: null, buttons: settle, rollLoading: false };
    // A pass ends the effect in the answer's own op, so the card goes with the next view.
    if (result === "pass") return { ...base, status, rollNote: null, buttons: [], rollLoading: false };
    if (answered(target)) return { ...base, status, rollNote: null, buttons: marks, rollLoading: false };
    return { ...base, status: fails ? `${status} Fails: ${effectName(fails)}.` : status, rollNote, buttons: [...roll, ...marks] };
  }

  if (input.rolled !== null && input.rolled >= effect.save.dc) return { ...base, status: `Rolled ${input.rolled}: a pass.`, rollNote: null, buttons: [], rollLoading: false };
  const rolledFail = input.rolled !== null;
  if (fails || input.failTapped || rolledFail) {
    const status = fails ? `Fails: ${effectName(fails)}.` : rolledFail ? `Rolled ${input.rolled}: a fail.` : "Failed.";
    /*
     * With no choice left, a roll's fail is settled as it lands (landedOp),
     * so the card goes before Accept failure is needed. It stays for a fail
     * that waited on a use another device spent meanwhile, which would
     * otherwise leave the card with nothing to tap.
     */
    return { ...base, status, rollNote: null, buttons: settle, rollLoading: false };
  }
  const ask: CardButton<SaveAction>[] = facts.askable ? [{ action: "ask", text: `Ask ${facts.name}` }] : [];
  const status = facts.played && !facts.askable ? `${facts.name} is not on the players' scene, so no request can go.` : null;
  return { ...base, status, rollNote, buttons: [...ask, ...roll, ...marks] };
}

/** A DM's mark on a linked request's target, with the answer's own tag (shared/permissions.ts ANSWER_NEEDS_TAG). */
function markOp(pending: PendingSave, result: "pass" | "fail", tag: string): ClientOp | null {
  const target = pending.request?.targets[0];
  if (!pending.request || !target) return null;
  return { t: "roll.answer", rollId: pending.request.id, target: targetRef(target), result, tag };
}

/** Passed: the effect goes, which undo takes back. With a request, the DM's Pass mark, whose answer ends the effect on the server. */
/**
 * Where the card's own roll goes and the DC its line carries: hidden from
 * players only for a monster, as every roll starts, and in the open
 * without the DC, which only the DM's view holds (dcOnLine).
 */
export function saveEndsRollTo(view: Pick<RoomState, "members" | "characters" | "tokens">, pending: PendingSave): { to: "all" | "dm"; dc?: number } {
  const to = startsSecret(view, true, [pending.target]) ? "dm" : "all";
  const dc = dcOnLine(to, pending.effect.save.dc, false);
  return dc === undefined ? { to } : { to, dc };
}

export function passOp(pending: PendingSave, tag: string): ClientOp {
  return markOp(pending, "pass", tag) ?? { t: "actor.effect.remove", target: pending.target, effectId: pending.effect.id };
}

/**
 * Failed: with a request, the DM's Fail mark, which leaves the request
 * open. Without one, the occurrence settles as resolved when no choice is
 * left, and null when Legendary Resistance is left, so the card shows the
 * fail and waits.
 */
export function failOp(pending: PendingSave, left: number, tag: string): ClientOp | null {
  const mark = markOp(pending, "fail", tag);
  if (mark) return mark;
  return left > 0 ? null : settleOp(pending, "resolved");
}

/** Accept failure and Dismiss: `actor.saveDue` with no request, else one `roll.close` that settles the occurrence (doc 4 1.1). */
export function settleOp(pending: PendingSave, state: "resolved" | "dismissed"): ClientOp {
  if (pending.request) return { t: "roll.close", rollIds: [pending.request.id], settle: state };
  return { t: "actor.saveDue", target: pending.target, effectId: pending.effect.id, due: pending.effect.due.id, state };
}

/** Use Legendary Resistance: one `actor.outcome` that spends the use and ends the effect, since a fail turned to a success is a pass. */
export function resistOp(pending: PendingSave, plan: string): ClientOp {
  return { t: "actor.outcome", plan, label: "Legendary Resistance", targets: [{ target: pending.target, resist: true, remove: [pending.effect.id] }] };
}

/**
 * Ask Bree: one request for this occurrence, through doc 4's askOp, with
 * its switches set explicitly: the DC hidden and the result shown (16).
 */
export function askSaveOp(pending: PendingSave, id: string, open: number): AskCheck {
  const { effect } = pending;
  return askOp(
    {
      test: { kind: "save", choices: [{ ability: effect.save.ability }] },
      dc: effect.save.dc,
      dcShown: false,
      resultShown: true,
      ...(effect.save.spell ? { spell: true as const } : {}),
      cause: "saveEnds",
      ends: { effect: effect.id, occurrence: effect.due.id },
      targets: [pending.target],
    },
    id,
    open,
  );
}

/** The DM's Roll on a creature the request still waits on: `roll.dice` with `unanswered`, so it never replaces an answer. */
export function waitingRollOp(pending: PendingSave, preset: RollPreset, chip: CardChip, tag: string): Extract<ClientOp, { t: "roll.dice" }> | null {
  const target = pending.request?.targets[0];
  if (!pending.request || !target) return null;
  const extra = preset.extra.join("").replace(/^\+/, "");
  return {
    t: "roll.dice",
    tag,
    rollId: pending.request.id,
    target: targetRef(target),
    ...advantageFields([...preset.sources, ...chipSources(chip)]),
    ...(extra ? { extra } : {}),
    unanswered: true,
  };
}

/**
 * What the card's own roll does once its line lands, with no request: a
 * pass ends the effect, a fail with no Legendary Resistance left settles
 * the occurrence as resolved, and a fail with uses left sends nothing, so
 * the card shows it and waits.
 */
export function landedOp(pending: PendingSave, total: number, left: number): ClientOp | null {
  if (total >= pending.effect.save.dc) return { t: "actor.effect.remove", target: pending.target, effectId: pending.effect.id };
  return left > 0 ? null : settleOp(pending, "resolved");
}

/**
 * What a card's roll did once it decided the save and the card went with
 * it, as a notice in the alerts: "Goblin 2 rolled 17: Frightened ended."
 * or "Goblin 2 rolled 9: still Frightened.". Null when a choice is left,
 * since the card stays and shows the fail itself.
 */
export function landedWords(pending: PendingSave, name: string, total: number, left: number): string | null {
  const what = effectWords(pending.effect);
  if (total >= pending.effect.save.dc) return `${name} rolled ${total}: ${what} ended.`;
  return left > 0 ? null : `${name} rolled ${total}: still ${what}.`;
}

// ------------------------------------------------------------ concentration

export const CONCENTRATION_TEST = { kind: "save", ability: "con", cause: "concentration" } as const satisfies D20Test;

export type ConcentrationAction = "roll" | "pass" | "fail" | "resist" | "accept";

export type ConcentrationInput = {
  /** Missing when the viewer may not see the creature's exact HP. */
  dc: number | undefined;
  bonus: number | null;
  loading: boolean;
  preset: RollPreset | null;
  /** Legendary Resistance uses left, which only the DM spends. */
  legendaryLeft: number;
  failTapped: boolean;
  rolled: number | null;
};

export type ConcentrationModel = {
  status: string | null;
  rollNote: string | null;
  buttons: CardButton<ConcentrationAction>[];
  rollLoading: boolean;
  /** The roll decided it: a pass dismisses the card, a fail ends concentration. */
  decided: "pass" | "fail" | null;
};

/**
 * The concentration card (6.2): Roll beside Passed and Failed. With the DC
 * on the card a roll decides it, except that a creature with Legendary
 * Resistance left waits on Use Legendary Resistance or Accept failure, as a
 * Failed tap on it does. Without the DC the total shows, and Passed or
 * Failed decide.
 */
export function concentrationCard(input: ConcentrationInput): ConcentrationModel {
  const resist: CardButton<ConcentrationAction>[] = [
    ...(input.legendaryLeft > 0 ? [{ action: "resist" as const, text: resistText(input.legendaryLeft) }] : []),
    { action: "accept", text: "Accept failure" },
  ];
  const marks: CardButton<ConcentrationAction>[] = [
    { action: "pass", text: "Passed" },
    { action: "fail", text: "Failed" },
  ];
  const none = { rollNote: null, rollLoading: false };
  if (input.rolled !== null) {
    if (input.dc === undefined) return { ...none, status: `Rolled ${input.rolled}.`, buttons: marks, decided: null };
    if (input.rolled >= input.dc) return { ...none, status: `Rolled ${input.rolled}: a pass.`, buttons: [], decided: "pass" };
    if (input.legendaryLeft > 0) return { ...none, status: `Rolled ${input.rolled}: a fail.`, buttons: resist, decided: null };
    // The fail ends concentration as it lands. Accept failure stays for one that waited on a use another device spent meanwhile.
    return { ...none, status: `Rolled ${input.rolled}: a fail.`, buttons: resist, decided: "fail" };
  }
  if (input.failTapped && input.legendaryLeft > 0) return { ...none, status: "Failed.", buttons: resist, decided: null };
  const canRoll = input.loading || (input.bonus !== null && input.preset !== null);
  const roll: CardButton<ConcentrationAction>[] = canRoll ? [{ action: "roll", text: input.bonus !== null ? rollText(input.bonus) : "Roll" }] : [];
  return {
    status: null,
    rollNote: canRoll && input.preset ? presetLine(input.preset) || null : null,
    buttons: [...roll, ...marks],
    rollLoading: canRoll && input.loading,
    decided: null,
  };
}

/** A concentration roll that decided it, as a notice once the card goes: "Thorn rolled 14: concentration holds.". */
/**
 * Where a concentration roll goes and the DC its line carries: hidden from
 * players only for a DM's monster, and in the open without the DC, which
 * tells the damage to players without the creature's exact HP (dcOnLine).
 */
export function concentrationRollTo(view: Pick<RoomState, "members" | "characters" | "tokens">, dm: boolean, prompt: { target: ActorTarget; dc?: number }): { to: "all" | "dm"; dc?: number } {
  const to = startsSecret(view, dm, [prompt.target]) ? "dm" : "all";
  const dc = dcOnLine(to, prompt.dc, false);
  return dc === undefined ? { to } : { to, dc };
}

export function concentrationWords(name: string, total: number, decided: "pass" | "fail"): string {
  return `${name} rolled ${total}: ${decided === "pass" ? "concentration holds" : "concentration ended"}.`;
}

/** Ends a creature's concentration, as Failed always has: every concentrating effect goes. */
export function endConcentrationOps(target: ActorTarget, effects: readonly Pick<Effect, "id" | "key">[]): ClientOp[] {
  return effects.filter((e) => e.key === "concentrating").map((e) => ({ t: "actor.effect.remove", target, effectId: e.id }));
}

/** Use Legendary Resistance on a concentration save: one `actor.outcome` that only spends the use, so concentration holds. */
export function concentrationResistOp(target: ActorTarget, plan: string): ClientOp {
  return { t: "actor.outcome", plan, label: "Legendary Resistance", targets: [{ target, resist: true }] };
}

// ------------------------------------------------------------ recharge

/** "5–6", or "6" for Recharge 6. */
export function rechargeRange(recharge: number): string {
  return recharge === 6 ? "6" : `${recharge}–6`;
}

/** "Fire Breath can recharge (5–6)." (6.4). */
export function rechargeText(name: string, recharge: number): string {
  return `${name} can recharge (${rechargeRange(recharge)}).`;
}

/** The turn a log line starts: the row `encounter.next` or a removal lands on. Previous takes a turn back and starts none. */
export function turnStarted(entry: LogEntry): string | null {
  const data = entry.data;
  if (entry.kind !== "event" || data?.type !== "turn" || data.back) return null;
  return data.entryId;
}

/** The turn of a creature with actions marked Used on this device, as it started: the Used keys are read then (6.4). */
export type RechargeTurn = { logId: string; creature: ActorTarget; holder: string; used: string[] };

/**
 * A turn start that may prompt a recharge: the row's creature, its token
 * or else its character, when no player plays it and this device marked
 * any of its actions Used. Null otherwise, so a creature with nothing
 * marked never loads a block for nothing.
 */
export function rechargeTurn(view: Pick<RoomState, "tokens" | "characters" | "encounter">, logId: string, entryId: string, used: Readonly<Record<string, readonly string[] | undefined>>): RechargeTurn | null {
  const entry = view.encounter?.entries.find((e) => e.id === entryId);
  if (!entry || playerOwnedEntry(view, entry)) return null;
  const creature: ActorTarget | null = entry.tokenId !== undefined ? { tokenId: entry.tokenId } : entry.characterId !== undefined ? { characterId: entry.characterId } : null;
  if (!creature) return null;
  const holder = creatureKey(view, creature);
  const keys = used[holder] ?? [];
  return keys.length > 0 ? { logId, creature, holder, used: [...keys] } : null;
}

export type RechargePrompt = {
  id: string;
  key: string;
  name: string;
  recharge: number;
  text: string;
  row: string;
  /** The seq of the turn's line: the card reads only a roll of its row sent since, so an earlier turn's result is not this one's (ASTRA-06). */
  after: number;
};

/**
 * The recharge prompts of one turn start: each named roll with a recharge
 * that was marked Used when the turn started. An action never marked Used
 * is never prompted. `row` is the Dice panel's own row for that recharge
 * (RollOptions.tsx), so the result shows there too and is acted on once,
 * and `after` keeps the card to this turn's rolls of it.
 */
export function rechargePrompts(turn: RechargeTurn, named: readonly NamedRoll[]): RechargePrompt[] {
  const used = new Set(turn.used);
  return named
    .filter((r): r is NamedRoll & { recharge: NonNullable<NamedRoll["recharge"]> } => r.recharge !== undefined && used.has(r.key))
    .map((r) => ({ id: `${turn.logId}|${r.key}`, key: r.key, name: r.name, recharge: r.recharge, text: rechargeText(r.name, r.recharge), row: `${turn.holder}|${r.key}|recharge`, after: Number(turn.logId.split(":")[0]) }));
}

/** A recharge roll's success: its total at or above the action's recharge. */
export function recharged(total: number, recharge: number): boolean {
  return total >= recharge;
}
