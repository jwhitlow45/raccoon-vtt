import { creatureBonus, creatureNumbers, type NamedRoll, type RollNumbers, type RollSources, type SrdRolls } from "#shared/dice/bonus.ts";
import { blockDefenses, effectDefenses, type Defense } from "#shared/dice/defenses.ts";
import { blockActions, hasTrait } from "#shared/dice/named.ts";
import type { Actor, CompanionBlock, CustomMonster, RoomState, Token } from "#shared/model.ts";
import type { ActorTarget } from "#shared/protocol.ts";
import type { SrdMonster, StatBlockMonster } from "#shared/srd/monsters.ts";
import { monsterView, statBlockOf } from "#shared/statBlock.ts";
import type { You } from "../../state/types.ts";
import { statBlockShown, tokenStatBlock } from "../monsters/statBlockLink.ts";
import { ownsToken } from "../tokens/access.ts";

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

/**
 * The block this viewer reads on this token, as the token panel shows it
 * (statBlockLink.ts tokenStatBlock and statBlockShown): undefined while the
 * SRD's monsters are still loading, null for none.
 */
function blockView(dice: DiceView, token: Token, actor: Actor): StatBlockMonster | null | undefined {
  const dm = dice.you.role === "dm";
  const owner = !dm && ownsToken(dice.view, dice.you.memberId, token);
  if (!statBlockShown({ dm, owner, kind: token.kind, actor, companion: token.companion !== undefined })) return null;
  const link = tokenStatBlock(actor, dice.view.monsters, dice.view.companionBlocks);
  if (link.kind === "room") return roomView(link.monster);
  if (link.kind === "block") return storedView(link.block);
  if (link.kind !== "srd") return null;
  if (dice.srd.monsters === null) return undefined;
  return dice.srd.monsters.find((m) => m.srdId === link.srdId) ?? null;
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
 * beast's block: until that model is built, a character has its numbers and
 * its effects' defenses alone.
 */
export function creatureRolls(dice: DiceView, creature: ActorTarget): CreatureRolls | null {
  const state = dice.view;
  const token = "tokenId" in creature ? state.tokens[creature.tokenId] : undefined;
  if ("tokenId" in creature && !token) return null;
  const character = token ? ("ref" in token.actor ? state.characters[token.actor.ref] : undefined) : "characterId" in creature ? state.characters[creature.characterId] : undefined;
  const actor = token && "inline" in token.actor ? token.actor.inline : character?.actor;
  if (!actor) return null;

  // creatureNumbers reads the SRD table for an SRD creature and for a character in an SRD shape.
  const ownSrd = actor.srdId !== undefined && (character !== undefined || (actor.blockId === undefined && actor.monsterId === undefined));
  if (ownSrd && dice.srd.rolls === null) return null;
  const sources: RollSources = {
    tokens: state.tokens,
    characters: state.characters,
    companionBlocks: state.companionBlocks,
    monsters: state.monsters,
    srd: dice.srd.rolls,
  };

  let view: StatBlockMonster | null = null;
  if (token && !character) {
    const read = blockView(dice, token, actor);
    if (read === undefined) return null;
    view = read;
  }
  const legendary = actor.legendary;
  return {
    numbers: creatureNumbers(sources, creature),
    initBonus: creatureBonus(sources, creature, { kind: "initiative" }) ?? 0,
    named: view ? blockActions(view) : [],
    defenses: [...(view ? blockDefenses(view) : []), ...effectDefenses(actor.effects)],
    magicResistance: view ? hasTrait(view, "Magic Resistance") : false,
    evasion: view ? hasTrait(view, "Evasion") : false,
    legendaryLeft: legendary ? Math.max(0, legendary.resistMax - legendary.resistUsed) : 0,
  };
}
