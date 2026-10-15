import type { BuildChunk, Token } from "#shared/model.ts";
import { footprintGround } from "#shared/rules/heights.ts";

/**
 * How far below the ground under it a token stands, in feet, or null when
 * it is on the ground or above it (docs/design-v1-maps-vision.md 4.2). A
 * token is inside the ground after an undo or a restore put it back below
 * ground painted since, or when it burrows, which features 8 allows, so
 * nothing raises it on its own: its owners and the DM are told, and may
 * stand it on the ground.
 */
export function belowGround(chunks: Readonly<Record<string, BuildChunk>>, token: Pick<Token, "sceneId" | "size" | "x" | "y" | "elevation"> & Partial<Pick<Token, "w" | "h" | "squeeze">>): { ground: number; depth: number } | null {
  const ground = footprintGround(chunks, token);
  return token.elevation < ground ? { ground, depth: ground - token.elevation } : null;
}

export function belowGroundText(depth: number): string {
  return `Inside the ground (${depth} ft below).`;
}

/**
 * A token placed on the map stands on the ground there (section 4.2,
 * "Landings write the ground"), so one placed on a platform starts on top
 * of it rather than inside it. A token placed with an elevation of its own
 * keeps it. The client puts the elevation in the op, so replay never
 * depends on this rule.
 */
export function placeOnGround<T extends Pick<Token, "sceneId" | "size" | "x" | "y"> & Partial<Pick<Token, "w" | "h" | "elevation">>>(chunks: Readonly<Record<string, BuildChunk>>, token: T): T & { elevation?: number } {
  if ((token.elevation ?? 0) !== 0) return token;
  const ground = footprintGround(chunks, token);
  return ground === 0 ? token : { ...token, elevation: ground };
}
