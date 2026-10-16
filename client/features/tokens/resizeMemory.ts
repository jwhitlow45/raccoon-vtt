import { createStore } from "zustand/vanilla";
import type { CreatureSize, Token } from "#shared/model.ts";
import { scopeSlot } from "../../state/scope.ts";

/*
 * Where a creature grew from, on this page (docs/design-v1-token-window.md
 * 8.2): the base rule alone can leave a creature a square from where it
 * started, since a growth away from a wall spreads right and down and its
 * shrink takes the grown footprint's top-left square. So the page that
 * grows a token remembers each growth it sent, and a shrink back to a size
 * one of them started from returns to that growth's place while the token
 * stands exactly where and as big as the newest growth left it. The
 * guarantee is that and no more: another device, a reload, or a move in
 * between leaves the base rule.
 */

/** A token's place and size, as a growth found and left it. Custom's `w` and `h` are in cells. */
export type Pose = { x: number; y: number; size: CreatureSize; w?: number; h?: number };

/** One growth this page sent: the pose before it, and the pose it left. */
export type Growth = { from: Pose; to: Pose };

export function poseOf(token: Pick<Token, "x" | "y" | "size" | "w" | "h">): Pose {
  return token.size === "custom" ? { x: token.x, y: token.y, size: token.size, w: token.w, h: token.h } : { x: token.x, y: token.y, size: token.size };
}

function samePose(a: Pose, b: Pose): boolean {
  return a.x === b.x && a.y === b.y && a.size === b.size && a.w === b.w && a.h === b.h;
}

/**
 * The remembered return for a shrink to `size`: the place of the newest
 * growth that started from that size, and the growths kept once it is
 * taken (those older than it). None where the token no longer stands
 * exactly where and as big as the newest growth left it, someone having
 * moved, resized or undone it since, or where no growth started from that
 * size.
 */
export function rememberedReturn(growths: readonly Growth[], now: Pose, size: CreatureSize): { at: { x: number; y: number }; kept: Growth[] } | null {
  const newest = growths[growths.length - 1];
  if (!newest || !samePose(newest.to, now)) return null;
  for (let i = growths.length - 1; i >= 0; i--) {
    const g = growths[i]!;
    if (g.from.size === size && size !== "custom") return { at: { x: g.from.x, y: g.from.y }, kept: growths.slice(0, i) };
  }
  return null;
}

/**
 * The growths after a resize this page sent from `before` to `after`: a
 * growth goes on top of a list that still describes the token, or starts
 * a new one where it no longer does. A shrink keeps `kept` where it took a
 * remembered return, and otherwise drops the list.
 */
export function afterResize(growths: readonly Growth[], before: Pose, after: Pose, grew: boolean, kept: readonly Growth[] | null): Growth[] {
  if (grew) {
    const newest = growths[growths.length - 1];
    const current = newest !== undefined && samePose(newest.to, before) ? growths : [];
    return [...current, { from: before, to: after }];
  }
  return kept ? [...kept] : [];
}

/** Per Room page (state/scope.ts): each token's growths this page sent, by token id. A reload starts with none. */
export const growthsSlot = scopeSlot(() => createStore<Readonly<Record<string, readonly Growth[]>>>(() => ({})));
