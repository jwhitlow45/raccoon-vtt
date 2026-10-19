import type { NamedRoll } from "#shared/dice/bonus.ts";
import type { AreaTemplate, CastAsk, RoomState } from "#shared/model.ts";
import { damageTypeName } from "#shared/rules/damage.ts";
import { creatureRolls, type DiceView } from "../creature.ts";
import type { Page } from "../groupSave/chain.ts";
import { actionFill, areaFill, fromLine, type FillInput } from "../groupSave/fills.ts";
import { parseParts } from "../groupSave/outcome.ts";
import type { StartInput } from "../groupSave/start.ts";
import { creatureKey } from "../options.ts";
import { areaPresetOf, sameSpell, spellLevel } from "./cast.ts";

/**
 * The DM's side of a player's ask for saves (docs/design-v1-player-save-spell.md
 * 3.3), as plain functions: who the ask names, the group save it opens and
 * its fill, read from the DM's view and never from the ask, and the card's
 * words. The ask brings only what the server wrote: its spell, level, area
 * or targets, and the caster's own damage roll.
 */

/** "Goblin 3" for numbered duplicates, as the log names a token. */
function tokenName(token: { name: string; number?: number }): string {
  return token.number === undefined ? token.name : `${token.name} ${token.number}`;
}

/** The caster as the card names it: its token in view, else the player who asked, as the log names a creature it cannot see. */
export function castWho(view: Pick<RoomState, "tokens" | "members">, ask: Pick<CastAsk, "caster" | "by">): string {
  const token = view.tokens[ask.caster];
  if (token) return tokenName(token);
  return view.members[ask.by]?.name ?? "A player";
}

/** The caster's row the ask was sent from: its key, else a save of the spell's name. */
function askedRoll(dice: DiceView, ask: CastAsk): NamedRoll | undefined {
  const named = creatureRolls(dice, { tokenId: ask.caster })?.named ?? [];
  return (ask.roll !== undefined ? named.find((r) => r.key === ask.roll && r.save) : undefined) ?? named.find((r) => r.save && sameSpell(r.name, ask.spell));
}

/** The ask's damage as one field, part by part: "9d6 Fire + 2d8 Radiant". */
function rolledField(rolled: NonNullable<CastAsk["rolled"]>): string {
  return rolled.map((r) => `${r.formula}${r.type ? ` ${damageTypeName(r.type)}` : ""}`).join(" + ");
}

export type CastFill = {
  input: FillInput;
  /** The caster's roll, seeded committed under its own tag with its amounts by part, when the field reads it back part for part. */
  damage: NonNullable<Page["damage"]> | null;
  /** Why the roll was not taken: "Thorn's roll could not be read part by part. Roll it here or type it." */
  says: string | null;
};

/**
 * The fill of an ask's group save (3.3). An area ask fills as the area's
 * Save and damage does, with the ask's caster in place of the area's, else
 * from the caster's row. A targets ask fills from the caster's row at the
 * level, else from the spell's area preset. With neither, it is a Dexterity
 * save with no DC, as an area without a preset opens. A leveled spell
 * always keeps its level, so the page's Slot level stepper shows for it.
 *
 * With `rolled` (and `imported` not false), the damage field is the roll's
 * own formulas and types, and the roll is seeded as the page's. A part's
 * type comes only from its label, which a long name cuts, and an untyped
 * part joins the part after it, so a roll whose field would not read back
 * part for part imports nothing: a count that differs, or two or more parts
 * with any untyped. A lone untyped part takes the fill's type, as a typed
 * "28" does.
 */
export function castFill(dice: DiceView, ask: CastAsk, slot?: number, opts: { imported?: boolean } = {}): CastFill {
  const who = castWho(dice.view, ask);
  const pick = slot ?? ask.slot;
  const named = askedRoll(dice, ask);
  const template: AreaTemplate | undefined = ask.area ? dice.view.templates[ask.area] : undefined;
  const preset = areaPresetOf(template?.spell ?? ask.spell);
  const fromArea = (): FillInput | null =>
    preset ? areaFill(dice, { spell: preset.name, casterId: ask.caster, ...(template?.label !== undefined ? { label: template.label } : {}) }, pick) : null;
  const fromRow = (): FillInput | null => (named ? actionFill(dice, named, { key: creatureKey(dice.view, { tokenId: ask.caster }), tokenId: ask.caster }, pick) : null);
  const found = ask.area ? (fromArea() ?? fromRow()) : (fromRow() ?? fromArea());

  const level = named ? spellLevel(named, ask.spell) : preset?.level;
  const leveled = level !== undefined && level >= 1 ? Math.max(level, Math.min(9, Math.floor(pick ?? level))) : undefined;
  // With neither a row nor a preset, a Dexterity save with no DC, and the caster's roll still read below, since the server wrote it (SSB-A-05).
  const base: FillInput = found ?? { test: { kind: "save", ability: "dex" }, dc: null, spell: leveled !== undefined, fill: { name: ask.spell, from: "", caster: ask.caster }, outcome: {} };

  const outcome = { ...base.outcome, ...(base.outcome.slot === undefined && leveled !== undefined ? { slot: leveled } : {}) };
  let fill = base.fill;
  let damage: CastFill["damage"] = null;
  let says: string | null = null;
  let rolledWords: string | undefined;
  const rolled = opts.imported === false ? undefined : ask.rolled;
  if (rolled && rolled.length > 0 && ask.damage) {
    const field = rolledField(rolled);
    const parsed = parseParts(field, fill.damageType);
    const untyped = rolled.length >= 2 && rolled.some((r) => r.type === undefined);
    if (parsed.ok && parsed.parts.length === rolled.length && !untyped) {
      outcome.damage = field;
      const type = rolled[0]?.type ?? fill.damageType;
      fill = { ...fill, ...(type ? { damageType: type } : {}) };
      damage = { tag: ask.damage.tag, state: "committed", amounts: parsed.parts.map((p, i) => ("formula" in p ? rolled[i]?.total : undefined)), imported: true };
      rolledWords = `rolled ${rolled.map((r) => r.total.toLocaleString("en-US")).join(" + ")} (${who}'s roll)`;
    } else {
      says = `${who}'s roll could not be read part by part. Roll it here or type it.`;
    }
  }

  const at = outcome.slot !== undefined ? ` at level ${outcome.slot}` : "";
  let from: string;
  if (found) {
    const dcFrom = base.dc !== null && base.spell ? `${who}'s spell save DC` : null;
    from = fromLine(`${who}'s ${fill.name}${at}`, base.test, base.dc, dcFrom, outcome.damage ?? "", outcome.onPass ?? "half", outcome.conditions ?? [], rolledWords);
  } else {
    from = rolledWords
      ? `From ${who}'s ${ask.spell}${at}: not on ${who}'s stat block, so set the save. ${outcome.damage}, ${rolledWords}.`
      : `From ${who}'s ${ask.spell}${at}: not on ${who}'s stat block, so set the save and the damage.`;
  }
  return { input: { ...base, fill: { ...fill, from }, outcome }, damage, says };
}

/** The group save an ask opens: its area, followed until the roll, or its tokens, never the DM's selection, with castFill's fields. */
export function castStart(dice: DiceView, ask: CastAsk): StartInput {
  const filled = castFill(dice, ask);
  const { input } = filled;
  return {
    source: ask.area ? { kind: "area", templateId: ask.area } : { kind: "selection", tokenIds: [...(ask.targets ?? [])] },
    test: input.test,
    dc: input.dc,
    fill: input.fill,
    outcome: input.outcome,
    spell: input.spell,
    panel: ask.area ? "areas" : "dice",
    cast: { ask, who: castWho(dice.view, ask), ...(filled.says ? { says: filled.says } : {}) },
    ...(filled.damage ? { damage: filled.damage } : {}),
  };
}

// ------------------------------------------------------------ the card

export type CastCardText = {
  /** "Thorn asks for saves: Fireball, level 4". */
  title: string;
  /** The folded line on a phone: "Thorn asks for saves: Fireball". */
  short: string;
  /** "Thorn rolled 31 Fire", or "No damage rolled". */
  rolled: string;
  /** "In the area: 4", "Targets: Goblin 1, Goblin 2", or "On Crypt" from another scene. */
  where: string;
  /** Why it cannot open, with only Dismiss left: "Its area is gone". */
  gone: string | null;
  /** "Open", or "Go to Crypt and open" for an ask on another scene. */
  open: string;
  openName: string;
  dismissName: string;
};

/**
 * The card's words (3.3, 6). The DM's view holds only the scene on screen,
 * so an ask on another scene names its scene and counts its targets, and
 * only an ask on this scene reads its area or caster as gone. `caught` is
 * the area's caught creatures as the DM's page counts them, hidden ones
 * included.
 */
export function castCardText(view: Pick<RoomState, "tokens" | "members" | "templates" | "scenes">, ask: CastAsk, input: { viewing: string | null; caught: number | null }): CastCardText {
  const who = castWho(view, ask);
  const spell = ask.spell;
  const level = ask.slot !== undefined ? `, level ${ask.slot}` : "";
  const rolled = ask.rolled && ask.rolled.length > 0 ? `${who} rolled ${ask.rolled.map((r) => `${r.total.toLocaleString("en-US")}${r.type ? ` ${damageTypeName(r.type)}` : ""}`).join(" + ")}` : "No damage rolled";
  const scene = view.scenes[ask.sceneId];
  const here = input.viewing === ask.sceneId;
  let gone: string | null = null;
  if (!scene) gone = "Its scene is gone";
  else if (here && ask.area !== undefined && !view.templates[ask.area]) gone = "Its area is gone";
  else if (here && !view.tokens[ask.caster]) gone = "Its caster is gone";
  let where: string;
  if (!here) where = scene ? `On ${scene.name}` : "";
  else if (ask.area !== undefined) where = `In the area: ${input.caught ?? 0}`;
  else {
    const ids = ask.targets ?? [];
    const names = ids.flatMap((id) => {
      const t = view.tokens[id];
      return t ? [tokenName(t)] : [];
    });
    const missing = ids.length - names.length;
    where = `Targets: ${[...names, ...(missing > 0 ? [`${missing} gone`] : [])].join(", ")}`;
  }
  return {
    title: `${who} asks for saves: ${spell}${level}`,
    short: `${who} asks for saves: ${spell}`,
    rolled,
    where,
    gone,
    open: here || !scene ? "Open" : `Go to ${scene.name} and open`,
    openName: `Open the group save for ${who}'s ${spell}`,
    dismissName: `Dismiss ${who}'s ${spell}`,
  };
}

/** The asks the DM's desk shows, newest first, less the one the open group save holds, whose card comes back on Discard. */
export function deskAsks(casts: Readonly<Record<string, CastAsk>>, held: string | null): CastAsk[] {
  return Object.values(casts)
    .filter((a) => a.id !== held)
    .sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : a.id < b.id ? 1 : -1));
}

/**
 * The desk's folded button with asks among what it folds (rolls/logic.ts
 * foldedChips): "Rolls 1/3, 1 ask", or "2 asks" with no request folded.
 * Its name starts with its visible text (WCAG 2.5.3).
 */
export function foldedWithAsks(base: { text: string; label: string } | null, asks: number, tap: "sheet" | "more" | "less"): { text: string; label: string } | null {
  if (asks === 0) return base;
  const count = `${asks} ${asks === 1 ? "ask" : "asks"}`;
  const more = tap === "sheet" ? "" : "more ";
  const forSaves = `${asks} ${more}${asks === 1 ? "ask" : "asks"} for saves`;
  if (!base) return { text: count, label: `${count}: ${forSaves}.${tap === "sheet" ? ` Close the sheet to see ${asks === 1 ? "it" : "them"}.` : ""}` };
  const cut = base.label.indexOf(": ");
  const head = cut >= 0 ? base.label.slice(0, cut) : base.label;
  const rest = cut >= 0 ? base.label.slice(cut + 2) : "";
  return { text: `${base.text}, ${count}`, label: `${head}, ${count}: ${forSaves}, ${rest}` };
}
