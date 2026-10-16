import { keys } from "../keys.ts";
import type { CompanionBlock } from "../model.ts";
import type { OpOf } from "../protocol.ts";
import { gone, invalid, type Tx } from "./tx.ts";

/**
 * The stat blocks a character keeps for its companions
 * (docs/design-v1-companion-stat-blocks.md 3.3), kept as the room's own
 * monsters are. A companion links one through its actor's `blockId`, and
 * deleting a block writes no token: a link to a block that is gone reads as
 * deleted until someone attaches another or detaches (section 3.2 rule 4).
 */
export function companionBlockCreate(tx: Tx, op: OpOf<"companionBlock.create">): void {
  if (tx.state.companionBlocks[op.block.id]) throw invalid("that stat block already exists");
  tx.character(op.block.characterId);
  const block: CompanionBlock = { ...op.block, rev: 0 };
  tx.write(keys.companionBlock(block.id), block);
}

/** The changed lines, as a monster's edit applies them. Its character and its SRD source never change. */
export function companionBlockUpdate(tx: Tx, op: OpOf<"companionBlock.update">): void {
  const block = tx.state.companionBlocks[op.blockId];
  if (!block) throw gone("stat block");
  const next: CompanionBlock = { ...block };
  const { sizeAlt, xpInLair, defaultImage, ...lines } = op.patch;
  for (const [field, value] of Object.entries(lines)) {
    if (value !== undefined) (next as Record<string, unknown>)[field] = value;
  }
  if (sizeAlt === null) delete next.sizeAlt;
  else if (sizeAlt !== undefined) next.sizeAlt = sizeAlt;
  if (xpInLair === null) delete next.xpInLair;
  else if (xpInLair !== undefined) next.xpInLair = xpInLair;
  if (defaultImage === null) delete next.defaultImage;
  else if (defaultImage !== undefined) next.defaultImage = defaultImage;
  tx.write(keys.companionBlock(block.id), next);
}

export function companionBlockDelete(tx: Tx, op: OpOf<"companionBlock.delete">): void {
  if (!tx.state.companionBlocks[op.blockId]) throw gone("stat block");
  tx.remove(keys.companionBlock(op.blockId));
}

/** A deleted character's blocks, in id order so a replay writes the same keys in the same order. */
export function deleteCharacterBlocks(tx: Tx, characterId: string): void {
  const ids = Object.values(tx.state.companionBlocks)
    .filter((block) => block.characterId === characterId)
    .map((block) => block.id)
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  for (const id of ids) tx.remove(keys.companionBlock(id));
}
