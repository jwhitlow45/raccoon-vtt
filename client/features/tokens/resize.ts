import type { Actor, Character, CompanionBlock, CreatureSize, CustomMonster, RoomState, Token } from "#shared/model.ts";
import type { TokenPatch } from "#shared/protocol.ts";
import { resizeSpot, sizeChange, SIX_SIZES, type NextSize } from "#shared/rules/resize.ts";
import type { SrdMonster } from "#shared/srd/monsters.ts";
import { tokenStatBlock } from "../monsters/statBlockLink.ts";
import { afterResize, poseOf, rememberedReturn, type Growth, type Pose } from "./resizeMemory.ts";

/*
 * Changing a creature's size on the fly (docs/design-v1-token-window.md 8),
 * as plain functions for node --test: the patch every place that changes a
 * size sends, the creature's own size for "Back to", and who may resize.
 */

/** What a resize sends, and whether the spot moved off the base spot or the remembered square to clear a wall, or why it cannot be sent. */
export type ResizeAnswer = { patch: TokenPatch; shifted: boolean; growths: Growth[] } | { refused: string };

/**
 * The one patch every place that changes a size sends (8.6): the token
 * window's stepper, the panel's Size field, "Back to", the DM's Custom
 * fields and the group's More. It holds the size, the place where the spot
 * changes, and for the DM the Custom width and height, set or cleared. The
 * spot is the shared rule's (shared/rules/resize.ts resizeSpot) on this
 * viewer's copy, checked for anyone but the DM, and a shrink returns to
 * the square this page grew it from where `growths` still describe it
 * (resizeMemory.ts). `growths` in the answer is the list once it is sent.
 * A refusal is the player's words, sent as nothing.
 */
export function resizePatch(view: Pick<RoomState, "scenes" | "buildChunks">, token: Token, next: NextSize, role: "dm" | "player", growths: readonly Growth[] = []): ResizeAnswer {
  const change = sizeChange(token, next);
  const now = poseOf(token);
  const memory = change === "shrink" ? rememberedReturn(growths, now, next.size) : null;
  const spot = resizeSpot(view, token, next, { checked: role !== "dm", ...(memory ? { remembered: memory.at } : {}) });
  if ("refused" in spot) return { refused: spot.refused };
  const custom = role === "dm" ? (next.size === "custom" ? { w: next.w ?? null, h: next.h ?? null } : token.size === "custom" ? { w: null, h: null } : {}) : {};
  const moved = spot.x !== token.x || spot.y !== token.y ? { x: spot.x, y: spot.y } : {};
  const patch: TokenPatch = { size: next.size, ...custom, ...moved } as TokenPatch;
  const after: Pose = next.size === "custom" ? { x: spot.x, y: spot.y, size: "custom", w: next.w, h: next.h } : { x: spot.x, y: spot.y, size: next.size };
  const tookMemory = memory !== null && spot.x === memory.at.x && spot.y === memory.at.y;
  return { patch, shifted: spot.shifted, growths: afterResize(growths, now, after, change === "grow", tookMemory ? memory.kept : null) };
}

/**
 * A group's resize from its More (8.6): one resize patch for each token,
 * so each keeps its own middle, read and written through the same growth
 * memory a single token's resize uses, so a group's shrink returns each
 * creature to the square it grew from, whichever control grew it. The ops
 * go as one gesture, one undo step. A token whose resize is refused is
 * left out, its memory as it was.
 */
export function resizeGroup(
  view: Pick<RoomState, "scenes" | "buildChunks">,
  tokens: readonly Token[],
  next: NextSize,
  role: "dm" | "player",
  growths: Readonly<Record<string, readonly Growth[]>>,
): { ops: { t: "token.update"; tokenId: string; patch: TokenPatch }[]; growths: Record<string, Growth[]> } {
  const ops: { t: "token.update"; tokenId: string; patch: TokenPatch }[] = [];
  const kept: Record<string, Growth[]> = {};
  for (const t of tokens) {
    const answer = resizePatch(view, t, next, role, growths[t.id] ?? []);
    if ("refused" in answer) continue;
    ops.push({ t: "token.update", tokenId: t.id, patch: answer.patch });
    kept[t.id] = answer.growths;
  }
  return { ops, growths: kept };
}

/** One size up or down the six (8.9): Medium steps to Small, which is the same square. Null past Tiny or Gargantuan, and for Custom. */
export function stepSize(size: CreatureSize, by: 1 | -1): Exclude<CreatureSize, "custom"> | null {
  if (size === "custom") return null;
  return SIX_SIZES[SIX_SIZES.indexOf(size) + by] ?? null;
}

/**
 * The creature's own size where this viewer's copy knows it (8.8): a PC's
 * character's size, a linked room monster's block or a companion's own
 * stat block (docs/design-v1-companion-stat-blocks.md 3.2), both sizes of a
 * "Medium or Small" block, or an SRD monster's block once the SRD has
 * loaded (`srd`, null until then). Null where none is known: an unlinked
 * NPC, a monster without a block, a companion whose block was deleted, an
 * object.
 */
export function baseSize(input: {
  token: Pick<Token, "actor" | "kind">;
  actor: Pick<Actor, "srdId" | "monsterId" | "blockId"> | undefined;
  characters: Readonly<Record<string, Pick<Character, "size"> | undefined>> | undefined;
  monsters: Readonly<Record<string, Pick<CustomMonster, "size" | "sizeAlt"> | undefined>> | undefined;
  blocks?: Readonly<Record<string, Pick<CompanionBlock, "size" | "sizeAlt"> | undefined>> | undefined;
  srd: readonly Pick<SrdMonster, "srdId" | "size">[] | null;
}): Exclude<CreatureSize, "custom">[] | null {
  const { token } = input;
  if (token.kind === "object") return null;
  if ("ref" in token.actor) {
    const size = input.characters?.[token.actor.ref]?.size;
    return size && size !== "custom" ? [size] : null;
  }
  const link = tokenStatBlock(input.actor, input.monsters as Readonly<Record<string, CustomMonster | undefined>> | undefined, input.blocks as Readonly<Record<string, CompanionBlock | undefined>> | undefined);
  if (link.kind === "room") return [link.monster.size, ...(link.monster.sizeAlt !== undefined ? [link.monster.sizeAlt] : [])];
  if (link.kind === "block") return [link.block.size, ...(link.block.sizeAlt !== undefined ? [link.block.sizeAlt] : [])];
  if (link.kind === "srd") {
    const block = input.srd?.find((m) => m.srdId === link.srdId);
    return block ? [block.size] : null;
  }
  return null;
}

/** "Back to Medium" (8.8): the base's first size, where the token's size is neither of the base's. Null where it is, or none is known. */
export function backTo(size: CreatureSize, base: readonly Exclude<CreatureSize, "custom">[] | null): Exclude<CreatureSize, "custom"> | null {
  if (!base || base.length === 0 || base.includes(size as Exclude<CreatureSize, "custom">)) return null;
  return base[0]!;
}

/** The six sizes' names, as the size lists show them. */
export const SIZE_WORDS: Record<CreatureSize, string> = {
  tiny: "Tiny",
  small: "Small",
  medium: "Medium",
  large: "Large",
  huge: "Huge",
  gargantuan: "Gargantuan",
  custom: "Custom",
};

/** A Custom token's size as words: "Custom, 2 by 3 squares", with ", set by the DM" for its owners. */
export function customWords(token: Pick<Token, "w" | "h">, forOwner: boolean): string {
  const cells = (v: number | undefined) => String(v ?? 1);
  return `Custom, ${cells(token.w)} by ${cells(token.h)} squares${forOwner ? ", set by the DM" : ""}`;
}
