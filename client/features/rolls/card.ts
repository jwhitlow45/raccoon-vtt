import { advantageFields, applyMode, d20Formula, formatFormula, formulaRange, parseExtra, parseFormula, type AdvantageMode, type AdvantageSource } from "#shared/dice/formula.ts";
import { OUT_OF_RANGE } from "#shared/dice/resolve.ts";
import { naturalOf, rerollable, rerollFace, rolledTerms } from "#shared/dice/roll.ts";
import { LIMITS } from "#shared/limits.ts";
import { effectName } from "#shared/logText.ts";
import type { DiceResult, RollChange, RollRequest, RollTarget } from "#shared/model.ts";
import type { RollPreset } from "#shared/rules/rollReminders.ts";
import { CONDITIONS } from "#shared/srd/conditions.ts";

/**
 * The player's card rolls a request's answer on the server
 * (docs/design-v1-roll-request.md 5.2 to 5.4), as plain functions for node
 * --test: Roll's words and why it waits, the reading under the roll row,
 * the op's roll fields, and the words of a rolled result. The DM's live
 * card reads the same reading for its Roll (6).
 */

/** What the player adds for what the app does not know (5.2): Adv or Dis, extra dice, and a bonus typed where none is known. */
export type RollInputs = { pressed: AdvantageMode | null; extra: string; bonus: string };

export const NO_INPUTS: RollInputs = { pressed: null, extra: "", bonus: "" };

export const TYPE_BONUS = "Type your bonus first, such as +5 or 0.";
export const CLEAR_TOTAL = "Clear the total to roll instead.";
export const BONUS_WORDS = "A bonus is a whole number from -20 to 30.";

/** A bonus as written on a button: "+3", "-1", "+0". */
export function signed(n: number): string {
  return n < 0 ? `-${-n}` : `+${n}`;
}

/** A bonus the player types where the app knows none (5.2): a whole number from -20 to 30, a typographic minus allowed. Null while empty. */
export function parseBonus(text: string): { ok: true; bonus: number } | { ok: false; error: string } | null {
  const t = text.trim().replace(/[−–]/g, "-");
  if (t === "") return null;
  if (!/^[+-]?\d{1,2}$/.test(t)) return { ok: false, error: BONUS_WORDS };
  const n = Number(t);
  if (n < -20 || n > 30) return { ok: false, error: BONUS_WORDS };
  return { ok: true, bonus: n === 0 ? 0 : n };
}

/**
 * A roll's bonus where the app may know none: the creature's, else the one
 * typed beside its Roll once its block would have loaded. A creature with
 * no stat block still rolls, and never with a "+0" no one gave. `typing`
 * is whether the field shows, and `waits` why the Roll waits.
 */
export function knownOrTyped(known: number | null, text: string, loaded: boolean): { bonus: number | null; typing: boolean; waits: string | null; error: boolean } {
  const typing = loaded && known === null;
  const typed = typing ? parseBonus(text) : null;
  const bonus = known ?? (typed?.ok ? typed.bonus : null);
  const waits = typing && bonus === null ? (typed?.ok === false ? typed.error : TYPE_BONUS) : null;
  return { bonus, typing, waits, error: typed?.ok === false };
}

/** A source's name in a reading: "Restrained", "Magic Resistance", or "Advantage" for the one the player pressed. */
export function sourceName(source: AdvantageSource): string {
  if (source.from === "pressed") return source.kind === "adv" ? "Advantage" : "Disadvantage";
  if (source.from === "magic-resistance") return "Magic Resistance";
  if (source.from === "tracker") return "the tracker's mark";
  return effectName(source.from);
}

/**
 * Which effect a preset's extra term came from, for the reading's words. The
 * table gives three (shared/rules/rollReminders.ts): Bless's +1d4, Bane's
 * -1d4 and Exhaustion's -2 per level, each in a shape of its own.
 */
function extraName(term: string): string | null {
  if (term === "+1d4") return effectName("blessed");
  if (term === "-1d4") return effectName("baned");
  if (/^-\d+$/.test(term)) return CONDITIONS.exhaustion.name;
  return null;
}

/** The player's extra as it joins the preset's: signed, so "1d6" reads "+1d6" after "+1d4". */
function signedExtra(text: string): string {
  const t = text.trim().replace(/[−–]/g, "-");
  return t === "" || /^[+-]/.test(t) ? t : `+${t}`;
}

/** The names of the sources of one kind, once each, in order. */
function names(sources: readonly AdvantageSource[], kind?: "adv" | "dis"): string[] {
  const out: string[] = [];
  for (const s of sources) {
    if (kind !== undefined && s.kind !== kind) continue;
    const name = sourceName(s);
    if (!out.includes(name)) out.push(name);
  }
  return out;
}

function list(words: readonly string[]): string {
  if (words.length <= 1) return words[0] ?? "";
  return `${words.slice(0, -1).join(", ")} and ${words[words.length - 1]}`;
}

export type CardRoll = {
  /** "Roll +3", "Roll d20" while no bonus is known or typed, "Roll d20+5". */
  label: string;
  /** Why Roll waits, its description while disabled: no bonus typed yet, or a total in the field. Null when it can go. */
  blocked: string | null;
  /** How the tap will roll (5.3), or null with no preset and nothing pressed or typed. */
  reading: string | null;
  /** How long the player's extra may be, so the whole extra keeps within its 40 characters. */
  extraRoom: number;
  /** The `roll.dice` fields the tap sends, or the words of what the server would refuse first. */
  fields: { ok: true; value: { mode?: AdvantageMode; cancelled?: true; extra?: string; bonus?: number } } | { ok: false; error: string };
};

/**
 * Roll on the card (5.2, 5.3) for one creature and one choice: `bonus` is
 * the creature's as this device knows it, `preset` doc 3's for the test, read
 * at the tap, and `inputs` the player's own. The preset's sources and the
 * pressed chip resolve once by the cancel rule (docs/design-v1-dice.md 3.3),
 * and the preset's extra comes before the player's. `text` is the Total
 * field's draft, which holds Roll back only while the room lets players type
 * totals (`typeTotals`, absent reads as on): off, the field is hidden with
 * whatever it held, so that draft is no reason to wait.
 */
export function cardRoll(input: { bonus: number | null; preset: RollPreset | null; inputs: RollInputs; text: string; typeTotals?: boolean }): CardRoll {
  const { preset, inputs } = input;
  const typed = input.bonus === null ? parseBonus(inputs.bonus) : null;
  const bonus = input.bonus ?? (typed?.ok ? typed.bonus : null);
  const label = input.bonus !== null ? `Roll ${signed(input.bonus)}` : typed?.ok ? `Roll d20${signed(typed.bonus)}` : "Roll d20";
  const sources: AdvantageSource[] = [...(preset?.sources ?? []), ...(inputs.pressed ? [{ kind: inputs.pressed, from: "pressed" }] : [])];
  const presetExtra = (preset?.extra ?? []).join("");
  const own = signedExtra(inputs.extra);
  const extra = `${presetExtra}${own}`;
  const mode = advantageFields(sources);
  const base = d20Formula(bonus ?? 0);

  // The reading: the roll as it will go, its mode with its reasons, and each extra with its own.
  const parts: string[] = [];
  for (const term of preset?.extra ?? []) {
    const name = extraName(term);
    parts.push(name ? `${term} (${name})` : term);
  }
  if (own !== "") parts.push(own);
  const extras = parts.length > 0 ? `, ${parts.join(", ")}` : "";
  let reading: string | null = null;
  if (mode.mode) {
    // The player's own chip needs no naming beside the mode it gives: "with advantage", not "with advantage (Advantage)".
    const why = names(sources.filter((src) => src.from !== "pressed"), mode.mode);
    reading = `Rolls ${base} with ${mode.mode === "adv" ? "advantage" : "disadvantage"}${why.length > 0 ? ` (${list(why)})` : ""}${extras}.`;
  }
  else if (mode.cancelled) reading = `Rolls ${base}${extras}: ${list([...names(sources, "adv"), ...names(sources, "dis")])} cancel.`;
  else if (parts.length > 0) reading = `Rolls ${base}${extras}.`;
  if (preset?.fails) {
    const fails = `${CONDITIONS[preset.fails].name}: this save fails whatever the roll.`;
    reading = reading ? `${reading} ${fails}` : fails;
  }

  let blocked: string | null = null;
  if (input.typeTotals !== false && input.text.trim() !== "") blocked = CLEAR_TOTAL;
  else if (bonus === null) blocked = TYPE_BONUS;

  let fields: CardRoll["fields"];
  if (typed && !typed.ok) fields = { ok: false, error: typed.error };
  else if (bonus === null) fields = { ok: false, error: TYPE_BONUS };
  else fields = rollFields(base, extra, own, mode, input.bonus === null ? bonus : undefined);
  return { label, blocked, reading, extraRoom: Math.max(0, LIMITS.diceExtraChars - presetExtra.length), fields };
}

/** The checks the server makes first, in its words (5.2): the extra reads, and the roll keeps within -50 to 100. */
function rollFields(base: string, extra: string, own: string, mode: { mode?: AdvantageMode; cancelled?: true }, bonus: number | undefined): CardRoll["fields"] {
  if (own !== "") {
    const parsed = parseExtra(own);
    if (!parsed.ok) return { ok: false, error: parsed.error };
  }
  if (extra !== "") {
    const whole = parseExtra(extra);
    if (!whole.ok) return { ok: false, error: whole.error };
  }
  const parsed = parseFormula(`${base}${extra}`);
  if (!parsed.ok) return { ok: false, error: parsed.error };
  const formula = mode.mode ? applyMode(parsed.formula, mode.mode) : parsed;
  if (!formula.ok) return { ok: false, error: formula.error };
  const range = formulaRange(formula.formula);
  if (range.min < LIMITS.rollTotalMin || range.max > LIMITS.rollTotalMax) return { ok: false, error: OUT_OF_RANGE };
  return { ok: true, value: { ...mode, ...(extra !== "" ? { extra } : {}), ...(bonus !== undefined ? { bonus } : {}) } };
}

/** A rolled result's dice for the screen: the formula as rolled, then each die, a dropped one marked to be struck through. */
export function rolledDice(result: Pick<DiceResult, "formula" | "faces" | "mode">): { formula: string; faces: { face: number; dropped: boolean }[] } {
  const parsed = parseFormula(result.formula);
  const terms = rolledTerms(result);
  const formula = parsed.ok ? formatFormula(parsed.formula, result.mode) : result.formula;
  const faces = terms ? terms.flatMap((t) => ("kept" in t ? t.faces.map((face, i) => ({ face, dropped: !t.kept[i] })) : [])) : [];
  return { formula, faces };
}

/** "Natural 20" or "Natural 1", where the kept d20 shows one. */
export function naturalText(result: Pick<DiceResult, "formula" | "faces">): string | null {
  const natural = naturalOf(result);
  return natural === null ? null : `Natural ${natural}`;
}

/**
 * A rolled answer's verdict as the player reads it: "Pass", "Fail", "Fail
 * (Stunned)" when a condition failed it, or nothing while pass or fail is
 * hidden from them.
 */
export function verdictText(target: Pick<RollTarget, "result" | "dice">): string | null {
  if (target.result === undefined) return null;
  if (target.result === "fail" && target.dice?.fails) return `Fail (${CONDITIONS[target.dice.fails].name})`;
  return target.result === "pass" ? "Pass" : "Fail";
}

/**
 * The card's result in words (5.4): "Rolled 17 (1d20+5 with advantage: 12, 7
 * dropped). Pass.", with "Natural 20." where it shows one. The screen draws
 * the same with a dropped die struck through.
 */
export function rolledText(target: Pick<RollTarget, "total" | "result" | "dice">): string {
  const dice = target.dice;
  if (!dice) return "";
  const shown = rolledDice(dice);
  const faces = shown.faces.map((f) => (f.dropped ? `${f.face} dropped` : String(f.face))).join(", ");
  const natural = naturalText(dice);
  const verdict = verdictText(target);
  return `Rolled ${target.total ?? dice.total} (${shown.formula}${faces ? `: ${faces}` : ""}).${natural ? ` ${natural}.` : ""}${verdict ? ` ${verdict}.` : ""}`;
}

/** What the polite live region says when a roll lands while the card shows: "Thorn rolled 17. Pass." */
export function rolledNews(name: string, target: Pick<RollTarget, "total" | "result" | "dice">): string {
  const verdict = verdictText(target);
  return `${name} rolled ${target.total ?? target.dice?.total ?? ""}.${verdict ? ` ${verdict}.` : ""}`;
}

/** The one of two choices a creature starts at (5.1): the higher bonus, the first on a tie or with none known. */
export function bestChoice(bonuses: readonly (number | null)[]): 0 | 1 {
  const [a, b] = bonuses;
  return a !== null && a !== undefined && b !== null && b !== undefined && b > a ? 1 : 0;
}

/** The choice labels on a card with two (5.1): "Dexterity +3", or the name alone where no bonus is known. */
export function choiceLabel(text: string, bonus: number | null): string {
  return bonus === null ? text : `${text} ${signed(bonus)}`;
}

/** Whether a request is still open with this creature on it, the condition every tap on its card checks. */
export function holds(request: Pick<RollRequest, "targets"> | undefined, target: Pick<RollTarget, "tokenId" | "characterId">): boolean {
  return request !== undefined && request.targets.some((t) => (target.tokenId !== undefined ? t.tokenId === target.tokenId : t.characterId === target.characterId));
}

/**
 * The DM's Roll for a creature still waiting (6): its bonus from the DM's
 * view, the preset over every effect and the request's `spell`, worded as
 * doc 3's buttons are, "Roll +5", "Roll DEX +5, Disadvantage (Restrained)"
 * or "Roll +5: fails (Stunned)", and the fields its `roll.dice` sends with
 * `unanswered`, so an answer that came first stands. Where the DM's view
 * knows no bonus, the DM types one: "Roll d20" until then, "Roll d20+3"
 * after, and the fields carry it for the server to use where it knows none.
 */
export function dmRoll(input: { bonus: number | null; typed?: boolean; preset: RollPreset | null; ability?: string }): { label: string; fields: { mode?: AdvantageMode; cancelled?: true; extra?: string; bonus?: number } } {
  const { preset, bonus } = input;
  const sources = preset?.sources ?? [];
  const mode = advantageFields(sources);
  const extra = (preset?.extra ?? []).join("");
  const how = bonus === null ? "d20" : input.typed ? `d20${signed(bonus)}` : signed(bonus);
  let label = `Roll ${input.ability ? `${input.ability} ` : ""}${how}`;
  if (mode.mode) label += `, ${mode.mode === "adv" ? "Advantage" : "Disadvantage"} (${list(names(sources, mode.mode))})`;
  for (const term of preset?.extra ?? []) {
    const name = extraName(term);
    label += `, ${term}${name ? ` (${name})` : ""}`;
  }
  if (preset?.fails) label += `: fails (${CONDITIONS[preset.fails].name})`;
  return { label, fields: { ...mode, ...(extra !== "" ? { extra } : {}), ...(input.typed && bonus !== null ? { bonus } : {}) } };
}

// ------------------------------------------------------------ asking the DM to change an answer

/** One item of "Ask to change it" (5.5): its words, and the ask it sends, which the device gives an id and the answer's tag. */
export type AskItem = { id: string; label: string; ask: Pick<RollChange, "reason" | "face" | "die"> };

const BARDIC_DICE = [6, 8, 10, 12] as const;
/** At most this many extra Heroic Inspiration items, one per other die, so the menu stays short. */
const OTHER_DICE = 3;

/**
 * The menu under a final answer (5.5), by doc 1 5.4's rules, which the
 * server checks again: on a rolled answer Heroic Inspiration on the die
 * `rerollFace` names, then one item per other die of the roll, Halfling
 * Luck while a d20 shows 1, Lucky where it changes something (a normal roll
 * whose sources did not cancel, or a disadvantage roll), and the four
 * Bardic Inspiration dice. On a typed answer that is final, "Fix my total",
 * while the room lets players type their totals.
 */
export function askItems(target: Pick<RollTarget, "dice">, typeTotals: boolean): AskItem[] {
  const dice = target.dice;
  if (!dice) return typeTotals ? [{ id: "fix-total", label: "Fix my total", ask: { reason: "fix-total" } }] : [];
  const items: AskItem[] = [];
  const face = rerollFace(dice, "heroic-inspiration");
  if (face !== null) items.push({ id: "heroic", label: "Reroll: Heroic Inspiration", ask: { reason: "heroic-inspiration", face } });
  const terms = rolledTerms(dice) ?? [];
  let others = 0;
  for (const term of terms) {
    if (!("kept" in term)) continue;
    term.faces.forEach((value, i) => {
      const at = term.first + i;
      if (at === face || others >= OTHER_DICE || !rerollable(dice, "heroic-inspiration", at)) return;
      others++;
      items.push({ id: `heroic-${at}`, label: `Reroll the d${term.term.sides} (${value}): Heroic Inspiration`, ask: { reason: "heroic-inspiration", face: at } });
    });
  }
  const one = rerollFace(dice, "halfling-luck");
  if (one !== null) items.push({ id: "halfling", label: "Reroll: Halfling Luck", ask: { reason: "halfling-luck", face: one } });
  if (dice.mode !== "adv" && !dice.cancelled) items.push({ id: "lucky", label: "Advantage: Lucky", ask: { reason: "lucky" } });
  for (const die of BARDIC_DICE) items.push({ id: `bardic-${die}`, label: `Add a d${die} (Bardic Inspiration)`, ask: { reason: "bardic-inspiration", die } });
  return items;
}

/** What an ask asks for, mid-sentence: "to reroll (Heroic Inspiration)", "for advantage (Lucky)", "to add a d8 (Bardic Inspiration)", "to fix the total". */
function askWords(change: Pick<RollChange, "reason" | "die">): string {
  switch (change.reason) {
    case "heroic-inspiration":
      return "to reroll (Heroic Inspiration)";
    case "halfling-luck":
      return "to reroll (Halfling Luck)";
    case "lucky":
      return "for advantage (Lucky)";
    case "bardic-inspiration":
      return `to add a d${change.die ?? "?"} (Bardic Inspiration)`;
    case "fix-total":
      return "to fix the total";
  }
}

/** The player's card while an ask waits: "Asked the DM to reroll (Heroic Inspiration)." */
export function askedText(change: Pick<RollChange, "reason" | "die">): string {
  return `Asked the DM ${askWords(change)}.`;
}

/** The DM's row while an ask waits: "Asks to reroll (Heroic Inspiration)", and with the creature's name for a folded card's line. */
export function askRowText(change: Pick<RollChange, "reason" | "die">, name?: string): string {
  return name ? `${name} asks ${askWords(change)}` : `Asks ${askWords(change)}`;
}

/** The player's card once the DM kept the roll, or a close settled the ask as Keep (1.1). */
export const KEPT = "The DM kept the roll.";

/**
 * Whether an ask that went away was kept by the DM (5.5): the answer it
 * named still stands and this device did not withdraw it. An Allow writes
 * a new answer with its own tag, and a Reopen or an allowed "Fix my total"
 * clears the answer, so none of them reads as kept, even when an allowed
 * reroll lands on the same total as before.
 */
export function askKept(gone: Pick<RollChange, "id" | "on"> | undefined, now: Pick<RollTarget, "change" | "tag">, withdrew: string | null): boolean {
  return gone !== undefined && now.change === undefined && gone.id !== withdrew && now.tag !== undefined && now.tag === gone.on;
}
