import { blockDefenses, effectDefenses, type Defense } from "../dice/defenses.ts";
import type { Actor, Character, RoomState, StatBlock } from "../model.ts";
import srdDefenses from "../srd/damage-defenses.json" with { type: "json" };
import { monsterView } from "../statBlock.ts";
import { pcDefenses } from "./pcStats.ts";

const SRD = srdDefenses as Record<string, Defense[]>;
const blocks = new WeakMap<StatBlock, Defense[]>();

function fromBlock(block: StatBlock | undefined): readonly Defense[] {
  if (!block) return [];
  let defenses = blocks.get(block);
  if (!defenses) {
    defenses = blockDefenses(monsterView(block));
    blocks.set(block, defenses);
  }
  return defenses;
}

/** Reads the authoritative actor, including defenses and effects omitted from a player's projection. */
export function damageDefenses(state: Pick<RoomState, "monsters" | "companionBlocks">, actor: Actor, character?: Character): Defense[] {
  const id = actor.srdId;
  const fromSrd = id !== undefined && Object.hasOwn(SRD, id) ? SRD[id]! : [];
  let block: readonly Defense[];
  if (character) block = fromSrd;
  else if (actor.blockId !== undefined) block = fromBlock(state.companionBlocks[actor.blockId]);
  else if (actor.monsterId !== undefined) {
    block = fromBlock(state.monsters[actor.monsterId]);
  } else block = fromSrd;
  return [...(character ? pcDefenses(character).defenses : []), ...block, ...effectDefenses(actor.effects)];
}
