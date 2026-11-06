import { keptD20 } from "#shared/dice/roll.ts";
import type { LogEntry, RoomState, Token } from "#shared/model.ts";
import { distanceFt } from "#shared/rules/distance.ts";
import { sceneGrid } from "#shared/rules/grid.ts";
import { hpLess } from "#shared/rules/hp.ts";
import { displayName } from "../../lib/scene.ts";
import { joinNames } from "../clock/words.ts";
import { tokenAccess } from "../tokens/access.ts";
import { damageSummary } from "./damageSummaryLines.ts";
import { hpChips, type HpChip } from "./options.ts";

/*
 * Who a damage roll's "Apply to" chips name, and what they carry (QOL audit
 * Q2, D-261106-102 and 116). A logged roll knows at most its creature,
 * never the attack or its reach, so the chips rank and never cut by range:
 * the roller's enemies first, then everyone else, each nearest the roller
 * first, four at most. A roll for no creature here offers the selection,
 * unranked. Pure, for the tests and for every surface that draws chips:
 * the turn card, the Dice panel's newest roll and a toast.
 */

export type ApplyView = Pick<RoomState, "tokens" | "characters" | "scenes" | "meta">;
export type ApplyYou = { role: "dm" | "player"; memberId: string };

/** The creature a roll was made for, as its log line names it (DiceRoll `tokenId`, `characterId`). */
export type RollOrigin = { tokenId?: string; characterId?: string };

/** One chip's creature: the token it names, and whose HP that is, as an HP entry's target says it (groupHp.ts HpTarget). */
export type ApplyTarget = { tokenId: string; holder: string; name: string };

/** At most this many chips, so the row stays one line on a computer and two on a phone. */
export const MAX_APPLY_CHIPS = 4;

/** Whose HP a token's is: its character's, shared by every token of it, or its own. The same words as groupHp.ts hpTargets. */
export function holderOf(token: Pick<Token, "id" | "actor">): string {
  return "ref" in token.actor ? `character:${token.actor.ref}` : `token:${token.id}`;
}

/** Whether a token is a creature, alive, whose HP this viewer may change, as its own bar decides it (tokens/access.ts). */
function changesHp(view: ApplyView, you: ApplyYou, token: Token): boolean {
  if (token.kind === "object") return false;
  const actor = "inline" in token.actor ? token.actor.inline : view.characters[token.actor.ref]?.actor;
  if (hpLess(actor, token) || actor?.life === "dead") return false;
  return tokenAccess({ role: you.role, memberId: you.memberId, view, token }).hp !== "none";
}

/** The disposition the roller's enemies have: a hostile roller's are the allies, an ally's the hostiles, and a neutral roller has none. */
function enemiesOf(disposition: Token["disposition"]): Token["disposition"] | null {
  return disposition === "hostile" ? "ally" : disposition === "ally" ? "hostile" : null;
}

/** By code point, so every device sorts the same names alike whatever its language. */
function byText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * The chips of a roll for this viewer, on the scene this device shows.
 * The origin is the roll's token on that scene, else its character's
 * tokens there, the nearest counting for each creature. With none, the
 * selected tokens there in selection order. `leave` holds creatures the
 * roll was already applied to. Never the roller, a dead creature, one
 * this viewer may not hurt, or a token off this device's map: a player's
 * map is their projection, which holds no withheld or fogged token.
 */
export function applyTargets(input: { view: ApplyView; you: ApplyYou; sceneId: string | null; origin: RollOrigin; selected: readonly string[]; leave?: ReadonlySet<string> }): ApplyTarget[] {
  const { view, you } = input;
  const scene = input.sceneId !== null ? view.scenes[input.sceneId] : undefined;
  if (!scene) return [];
  const here = Object.values(view.tokens).filter((t) => t.sceneId === scene.id);
  const rollToken = input.origin.tokenId !== undefined ? view.tokens[input.origin.tokenId] : undefined;
  const characterId = input.origin.characterId ?? (rollToken && "ref" in rollToken.actor ? rollToken.actor.ref : undefined);
  const roller = rollToken ? holderOf(rollToken) : characterId !== undefined ? `character:${characterId}` : null;
  const origins = (rollToken?.sceneId === scene.id ? [rollToken] : characterId !== undefined ? here.filter((t) => "ref" in t.actor && t.actor.ref === characterId) : []).sort((a, b) => byText(a.id, b.id));
  const leave = input.leave ?? new Set<string>();
  const offered = (t: Token) => holderOf(t) !== roller && !leave.has(holderOf(t)) && changesHp(view, you, t);
  const target = (t: Token): ApplyTarget => ({ tokenId: t.id, holder: holderOf(t), name: displayName(t) });
  if (origins.length === 0) {
    const seen = new Set<string>();
    const out: ApplyTarget[] = [];
    for (const id of input.selected) {
      const t = view.tokens[id];
      if (!t || t.sceneId !== scene.id || !offered(t) || seen.has(holderOf(t))) continue;
      seen.add(holderOf(t));
      out.push(target(t));
      if (out.length === MAX_APPLY_CHIPS) break;
    }
    return out;
  }
  const grid = sceneGrid(scene);
  const settings = view.meta.settings;
  const enemy = enemiesOf(origins[0]!.disposition);
  // One chip a creature, at its token nearest the roller.
  const nearest = new Map<string, { token: Token; ft: number }>();
  for (const t of here) {
    if (!offered(t)) continue;
    const ft = Math.min(...origins.map((o) => distanceFt(grid, o, t, settings)));
    const holder = holderOf(t);
    const was = nearest.get(holder);
    if (!was || ft < was.ft || (ft === was.ft && byText(t.id, was.token.id) < 0)) nearest.set(holder, { token: t, ft });
  }
  const group = (t: Token) => (enemy !== null && t.disposition === enemy ? 0 : 1);
  return [...nearest.values()]
    .sort((a, b) => group(a.token) - group(b.token) || a.ft - b.ft || byText(displayName(a.token), displayName(b.token)) || byText(a.token.id, b.token.id))
    .slice(0, MAX_APPLY_CHIPS)
    .map((c) => target(c.token));
}

/** The creature a roll's lines name: its first roll's token or character. None for a typed formula. */
export function rollOrigin(lines: readonly LogEntry[]): RollOrigin {
  for (const line of lines) {
    if (line.data?.type !== "dice") continue;
    for (const roll of line.data.rolls) {
      if (roll.tokenId === undefined && roll.characterId === undefined) continue;
      return { ...(roll.tokenId !== undefined ? { tokenId: roll.tokenId } : {}), ...(roll.characterId !== undefined ? { characterId: roll.characterId } : {}) };
    }
  }
  return {};
}

const NONE_APPLIED: ReadonlySet<string> = new Set();

/**
 * What a damage roll's chips carry, as the HP entry's Use does
 * (options.ts hpChips): its amount, its parts with their types, whether it
 * was a critical hit, and its lines, so a chip and Use never disagree.
 * A bare formula typed with no words, such as 2d6+3, counts too: it is
 * damage rolled by hand, with no label to say so and no d20 to make it a
 * test. Null for anything else, and for an amount of nothing.
 */
export function rollChip(lines: readonly LogEntry[]): HpChip | null {
  const first = lines[0]?.data;
  if (first?.type !== "dice") return null;
  const [labeled] = hpChips(lines, first.by, "damage", { applied: NONE_APPLIED, nameOf: () => "" });
  if (labeled) return labeled.amount > 0 ? labeled : null;
  const rolls = lines.flatMap((line) => (line.data?.type === "dice" ? line.data.rolls : []));
  if (rolls.length === 0 || rolls.some((r) => r.label !== undefined || keptD20(r) !== null)) return null;
  const amount = rolls.reduce((n, r) => n + r.total, 0);
  if (amount <= 0) return null;
  const ids = lines.map((line) => line.id);
  return { lineId: ids.at(-1)!, lineIds: ids, amount, text: `Use ${amount}`, critical: false };
}

/** A chip's amount as the HP entry's preview says it: "6 Slashing damage", "6 Slashing damage + 3 Fire damage", "9 damage". */
export function chipWords(chip: Pick<HpChip, "amount" | "parts">): string {
  return chip.parts ? damageSummary(chip.parts).parts.map((part) => `${part.amount} ${part.label}`).join(" + ") : `${chip.amount} damage`;
}

/** A chip's name for a screen reader: the DM's applies, a player's fills their HP entry (D-261106-174). */
export function chipName(chip: Pick<HpChip, "amount" | "parts">, name: string, applies: boolean): string {
  return applies ? `Apply ${chipWords(chip)} to ${name}` : `Fill ${chipWords(chip)} for ${name}`;
}

/** The row's line once the roll landed on some: "Applied to Thorn.", "Applied to Thorn and Bree." */
export function appliedWords(names: readonly string[]): string {
  return `Applied to ${joinNames(names)}.`;
}

/**
 * Whether this viewer gets chips under a roll: the DM always, and a
 * player only under their own rolls while "Players can apply damage and
 * healing" is on (D-261106-119). A player has no Undo, so theirs fill the
 * HP entry rather than apply (D-261106-174).
 */
export function offersChips(you: ApplyYou, mine: boolean, playersApplyDamage: boolean): boolean {
  return you.role === "dm" || (mine && playersApplyDamage);
}
