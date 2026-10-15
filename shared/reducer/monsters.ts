import { keys } from "../keys.ts";
import type { CustomMonster, SrdImage } from "../model.ts";
import type { OpOf } from "../protocol.ts";
import { gone, invalid, type Tx } from "./tx.ts";

/**
 * The room's own stat blocks (design section 6). Tokens made from one are
 * independent copies that never point back, so a monster changes and goes
 * without touching anything on a scene.
 */
export function monsterCreate(tx: Tx, op: OpOf<"monster.create">): void {
  if (tx.state.monsters[op.monster.id]) throw invalid("monster already exists");
  tx.write(keys.monster(op.monster.id), { ...op.monster, rev: 0 });
}

export function monsterUpdate(tx: Tx, op: OpOf<"monster.update">): void {
  const monster = tx.state.monsters[op.monsterId];
  if (!monster) throw gone("monster");
  const next: CustomMonster = { ...monster };
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
  tx.write(keys.monster(monster.id), next);
}

export function monsterDelete(tx: Tx, op: OpOf<"monster.delete">): void {
  if (!tx.state.monsters[op.monsterId]) throw gone("monster");
  tx.remove(keys.monster(op.monsterId));
}

/**
 * The image an SRD monster's new tokens start with. Tokens already placed
 * keep theirs: the DM applies a new image to them with token updates, so
 * each stays an independent copy. Clearing an image the monster does not
 * have changes nothing, so two DM devices clearing it at once both succeed.
 */
export function monsterSetSrdImage(tx: Tx, op: OpOf<"monster.setSrdImage">): void {
  const key = keys.srdImage(op.srdId);
  if (op.image === null) {
    if (tx.state.srdImages[op.srdId]) tx.remove(key);
    return;
  }
  const next: SrdImage = { id: op.srdId, rev: 0, image: op.image };
  tx.write(key, next);
}
