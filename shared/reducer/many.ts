import type { OpOf } from "../protocol.ts";
import { effectAdd, effectRemove } from "./actors.ts";
import { deleteToken, tokenUpdate } from "./tokens.ts";
import type { Tx } from "./tx.ts";

/**
 * Several tokens edited in one step (docs/design-v1-dm-tools.md 3.5). Each
 * goes through its single op's reducer, so a group edit does exactly what
 * the same edits one by one would. The op applies whole or not at all, as
 * `actor.damageMany` does, and its inverse is one undo step.
 */
export function tokenUpdateMany(tx: Tx, op: OpOf<"token.updateMany">): void {
  for (const tokenId of op.tokenIds) tokenUpdate(tx, { t: "token.update", tokenId, patch: op.patch });
}

/** Each token as `token.delete` deletes it, its initiative rows and attached areas included. */
export function tokenDeleteMany(tx: Tx, op: OpOf<"token.deleteMany">): void {
  for (const tokenId of op.tokenIds) deleteToken(tx, tokenId);
}

/** Adds first, then removals, each as its single op, the hidden effects' rules included. */
export function actorEffects(tx: Tx, op: OpOf<"actor.effects">): void {
  for (const item of op.add ?? []) effectAdd(tx, { t: "actor.effect.add", target: item.target, effect: item.effect });
  for (const item of op.remove ?? []) effectRemove(tx, { t: "actor.effect.remove", target: item.target, effectId: item.effectId });
}
