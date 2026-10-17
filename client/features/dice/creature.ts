import { creatureBonus, creatureNumbers, type NamedRoll, type RollNumbers, type RollSources, type SrdRolls } from "#shared/dice/bonus.ts";
import { blockDefenses, effectDefenses, type Defense } from "#shared/dice/defenses.ts";
import { blockActions, hasTrait, multiattackNote } from "#shared/dice/named.ts";
import { pcDefenses, pcNamedRolls } from "#shared/rules/pcStats.ts";
import type { Actor, Character, CompanionBlock, CustomMonster, RoomState, Token } from "#shared/model.ts";
import type { ActorTarget } from "#shared/protocol.ts";
import type { SrdMonster, StatBlockMonster } from "#shared/srd/monsters.ts";
import { monsterView, statBlockOf } from "#shared/statBlock.ts";
import type { You } from "../../state/types.ts";
import { statBlockShown, tokenStatBlock, type TokenStatBlock } from "../monsters/statBlockLink.ts";
import { ownsCharacter, ownsToken } from "../tokens/access.ts";

/**
 * One creature's rolls for the Dice panel and every card that rolls for it
 * (docs/design-v1-roll-options.md 3.4): its numbers, its named rolls, its
 * defenses and the traits the presets and the group save read, from what
 * the viewer's view already holds.
 */
export type CreatureRolls = {
  numbers: RollNumbers | null;
  initBonus: number;
  named: NamedRoll[];
  defenses: Defense[];
  magicResistance: boolean;
  evasion: boolean;
  /** The token's Legendary Resistance uses left, resistMax less resistUsed. */
  legendaryLeft: number;
  /** The block's Multiattack paragraph, which heads the actions as a note (4.2). */
  multiattack: string | null;
};

/** What creatureRolls reads: the viewer, their view of the room, and the SRD's two chunks once each has loaded (null until then). */
export type DiceView = {
  you: You;
  view: RoomState;
  srd: { monsters: readonly SrdMonster[] | null; rolls: SrdRolls | null };
};

// A room monster's or a companion's block becomes its Markdown view once per version, so blockActions' cache holds across renders.
const roomViews = new WeakMap<CustomMonster, StatBlockMonster>();
const storedViews = new WeakMap<CompanionBlock, StatBlockMonster>();

function roomView(monster: CustomMonster): StatBlockMonster {
  let view = roomViews.get(monster);
  if (!view) {
    view = monsterView(statBlockOf(monster));
    roomViews.set(monster, view);
  }
  return view;
}

function storedView(block: CompanionBlock): StatBlockMonster {
  let view = storedViews.get(block);
  if (!view) {
    view = monsterView(block);
    storedViews.set(block, view);
  }
  return view;
}

type Found = { token?: Token; character?: Character; actor: Actor };

function find(state: RoomState, creature: ActorTarget): Found | null {
  if ("tokenId" in creature) {
    const token = state.tokens[creature.tokenId];
    if (!token) return null;
    if ("inline" in token.actor) return { token, actor: token.actor.inline };
    const character = state.characters[token.actor.ref];
    return character ? { token, character, actor: character.actor } : null;
  }
  const character = state.characters[creature.characterId];
  return character ? { character, actor: character.actor } : null;
}

/** The link of the block this viewer reads on a token's own actor, as the token panel shows it (statBlockLink.ts tokenStatBlock and statBlockShown). */
function shownLink(dice: Pick<DiceView, "you" | "view">, token: Token, actor: Actor): TokenStatBlock {
  const dm = dice.you.role === "dm";
  const owner = !dm && ownsToken(dice.view, dice.you.memberId, token);
  if (!statBlockShown({ dm, owner, kind: token.kind, actor, companion: token.companion !== undefined })) return { kind: "none" };
  return tokenStatBlock(actor, dice.view.monsters, dice.view.companionBlocks);
}

/**
 * Which of the SRD's chunks creatureRolls waits on for this creature: the
 * monsters for an SRD block the viewer reads, and the numbers table for an
 * SRD creature or a character in an SRD shape. The hook that loads them
 * (useDiceView.ts) asks this, so a page with no SRD creature loads neither.
 */
/** Whether this viewer reads a character's own block, and so a shaped character's creature block: the DM and its players (docs/design-v1-pc-stats.md 7.3). */
function readsCharacter(dice: Pick<DiceView, "you" | "view">, character: Character): boolean {
  return dice.you.role === "dm" || ownsCharacter(dice.you.memberId, character);
}

export function srdNeeds(dice: Pick<DiceView, "you" | "view">, creature: ActorTarget): { monsters: boolean; rolls: boolean } {
  const found = find(dice.view, creature);
  if (!found) return { monsters: false, rolls: false };
  const { token, character, actor } = found;
  const monsters = character
    ? actor.srdId !== undefined && readsCharacter(dice, character)
    : token !== undefined && shownLink(dice, token, actor).kind === "srd";
  // creatureNumbers reads the table for an SRD creature, and for a character in an SRD shape whatever else its actor links.
  const rolls = actor.srdId !== undefined && (character !== undefined || (actor.blockId === undefined && actor.monsterId === undefined));
  return { monsters, rolls };
}

/**
 * A creature's rolls, or null while a chunk it needs loads or when it is
 * gone. Its numbers are doc 1's creatureNumbers, the server's own rule, so
 * the bonus shown is the one rolled. Its named rolls, its block's defenses
 * and its traits come only from the block the viewer may read, so a player
 * never reads a block the token panel would not show them.
 *
 * A character's own rolls and defenses are doc 2's (pcNamedRolls and
 * pcDefenses, docs/design-v1-pc-stats.md 5), with a shaped character's
 * creature block before them.
 */
export function creatureRolls(dice: DiceView, creature: ActorTarget): CreatureRolls | null {
  const state = dice.view;
  const found = find(state, creature);
  if (!found) return null;
  const { token, character, actor } = found;
  const needs = srdNeeds(dice, creature);
  if ((needs.monsters && dice.srd.monsters === null) || (needs.rolls && dice.srd.rolls === null)) return null;
  const sources: RollSources = {
    tokens: state.tokens,
    characters: state.characters,
    companionBlocks: state.companionBlocks,
    monsters: state.monsters,
    srd: dice.srd.rolls,
  };

  let view: StatBlockMonster | null = null;
  if (character) {
    // A character in a shape lists its creature's actions and defenses (docs/design-v1-pc-stats.md 3.6).
    if (actor.srdId !== undefined && readsCharacter(dice, character)) view = dice.srd.monsters?.find((m) => m.srdId === actor.srdId) ?? null;
  } else if (token) {
    const link = shownLink(dice, token, actor);
    if (link.kind === "room") view = roomView(link.monster);
    else if (link.kind === "block") view = storedView(link.block);
    else if (link.kind === "srd") view = dice.srd.monsters?.find((m) => m.srdId === link.srdId) ?? null;
  }
  // A character's own block is read by the DM and its players. pcNamedRolls keeps only its other rolls in Wild Shape, and pcDefenses keeps Evasion there.
  const own = character && readsCharacter(dice, character) ? { named: pcNamedRolls(character), ...pcDefenses(character) } : { named: [], defenses: [], evasion: false };
  const legendary = actor.legendary;
  return {
    numbers: creatureNumbers(sources, creature),
    initBonus: creatureBonus(sources, creature, { kind: "initiative" }) ?? 0,
    named: [...(view ? blockActions(view) : []), ...own.named],
    defenses: [...own.defenses, ...(view ? blockDefenses(view) : []), ...effectDefenses(actor.effects)],
    magicResistance: view ? hasTrait(view, "Magic Resistance") : false,
    evasion: own.evasion || (view ? hasTrait(view, "Evasion") : false),
    legendaryLeft: legendary ? Math.max(0, legendary.resistMax - legendary.resistUsed) : 0,
    multiattack: view ? multiattackNote(view) : null,
  };
}
