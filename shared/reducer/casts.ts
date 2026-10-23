import { parseFormula } from "../dice/formula.ts";
import { keys } from "../keys.ts";
import { eventLines } from "../logRings.ts";
import type { CastAsk, CastEnd, CastRolled, LogEvent, Token } from "../model.ts";
import { ASK_CLOSED } from "../permissions.ts";
import type { OpOf } from "../protocol.ts";
import { DAMAGE_TYPES, type DamageType } from "../rules/damage.ts";
import { Refuse, invalid, type Tx } from "./tx.ts";

/**
 * A player's asks for saves (docs/design-v1-player-save-spell.md 5.2 and
 * 5.3). The player names their creature, its spell and what it targets,
 * and the DM's page fills the group save from the DM's own view of the
 * caster's stat block. Closing an ask removes it, and the log keeps its
 * lines, so every ask in the state is open.
 */

const DAMAGE_WORDS = new Set<string>(DAMAGE_TYPES);

/** The damage type a damage roll's label ends with ("Fireball damage, Fire"), as the group save reads another's roll. */
export function labelDamageType(label: string | undefined): DamageType | undefined {
  const last = label?.split(", ").at(-1)?.toLowerCase();
  return last !== undefined && last !== label?.toLowerCase() && DAMAGE_WORDS.has(last) ? (last as DamageType) : undefined;
}

export function castAsk(tx: Tx, op: OpOf<"cast.ask">): void {
  const input = op.cast;
  if (tx.state.casts[input.id]) throw invalid("that ask already exists");
  const ask: CastAsk = { id: input.id, rev: 0, by: tx.actor.memberId, caster: input.caster, sceneId: input.sceneId, spell: input.spell, at: tx.env.at };
  if (input.roll !== undefined) ask.roll = input.roll;
  if (input.slot !== undefined) ask.slot = input.slot;
  if (input.area !== undefined) ask.area = input.area;
  if (input.targets !== undefined) ask.targets = [...input.targets];
  if (input.damage !== undefined) {
    ask.damage = { tag: input.damage.tag, parts: input.damage.parts };
    const rolled = rolledOf(tx, ask, tx.state.tokens[ask.caster]);
    if (rolled) ask.rolled = rolled;
  }
  // First in the op, so the line's `<seq>:0` id is the same whatever else the op writes (5.3).
  tx.addEvent(castLine(ask));
  tx.write(keys.cast(ask.id), ask);
}

export function castClose(tx: Tx, op: OpOf<"cast.close">): void {
  const ask = tx.state.casts[op.castId];
  if (!ask) throw new Refuse("gone", ASK_CLOSED);
  closeCast(tx, ask, op.end);
}

/**
 * Removes the ask and writes its closing line, which must come first in its
 * op: an Apply writes HP lines the caster's players may not see, so a line
 * after them would carry an id that counts them (3.5).
 */
export function closeCast(tx: Tx, ask: CastAsk, end: CastEnd): void {
  tx.addEvent({ ...castLine(ask), end });
  tx.remove(keys.cast(ask.id));
}

function castLine(ask: CastAsk): Extract<LogEvent, { type: "cast" }> {
  const line: Extract<LogEvent, { type: "cast" }> = { type: "cast", castId: ask.id, tokenId: ask.caster, spell: ask.spell };
  if (ask.slot !== undefined) line.slot = ask.slot;
  return line;
}

/**
 * The caster's damage roll, read from the log the op meets (5.3), which
 * replay rebuilds the same, one line per roll (eventLines), so a roll that
 * only its caster's players read counts once, however many hold a copy of
 * it. Every line of the asker's under the roll's tag in `part` order, a
 * line without one being part 0 as the receipts read it, when the lines
 * hold each part from 0 to `parts` less one exactly once and none past it,
 * since the splitter puts a roll past 100 dice into several batches under
 * one tag. Each member's tags are their own (receipts), so another's line
 * under the same tag, such as the DM's for a creature no player sees, is
 * never read, and whether a ring still holds it changes nothing. Every
 * roll names the caster, by its token or its character, and is plain
 * damage: no critical, and no d20 test (no critical range, save,
 * initiative or advantage, and no d20 in its formula). Anything else
 * leaves it undefined, as a pruned roll does, and the DM rolls.
 */
function rolledOf(tx: Tx, ask: CastAsk, caster: Token | undefined): CastRolled[] | undefined {
  const damage = ask.damage;
  if (!damage || !caster) return undefined;
  const parts = new Map<number, Extract<LogEvent, { type: "dice" }>>();
  for (const entry of eventLines(tx.state.log)) {
    const data = entry.data;
    if (data?.type !== "dice" || data.by !== ask.by || data.tag !== damage.tag) continue;
    const part = data.part ?? 0;
    if (part >= damage.parts || parts.has(part)) return undefined;
    parts.set(part, data);
  }
  if (parts.size !== damage.parts) return undefined;
  const characterId = "ref" in caster.actor ? caster.actor.ref : undefined;
  const out: CastRolled[] = [];
  for (let part = 0; part < damage.parts; part++) {
    const line = parts.get(part)!;
    if (line.rolls.length === 0) return undefined;
    for (const roll of line.rolls) {
      const names = roll.tokenId === caster.id || (roll.tokenId === undefined && characterId !== undefined && roll.characterId === characterId);
      if (!names || roll.crit !== undefined || roll.critOn !== undefined || roll.save !== undefined || roll.initiative || roll.mode !== undefined) return undefined;
      const parsed = parseFormula(roll.formula);
      if (!parsed.ok || parsed.formula.some((term) => term.kind === "dice" && term.sides === 20)) return undefined;
      const item: CastRolled = { formula: roll.formula, total: roll.total };
      const type = labelDamageType(roll.label);
      if (type) item.type = type;
      out.push(item);
    }
  }
  return out;
}
