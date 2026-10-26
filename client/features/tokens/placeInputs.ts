import type { RoomState, Scene } from "#shared/model.ts";
import { sceneGrid } from "#shared/rules/grid.ts";
import type { TokenInput } from "#shared/protocol.ts";
import { monsterImage, refOf } from "../monsters/images.ts";
import { blankToken, characterToken, monsterToken, occupiedBoxes, sizeFootprint, spreadPositions, type Point } from "./factory.ts";
import type { Pending } from "./placement.ts";

/**
 * The tokens one tap of the "Add token" tool places for what is pending,
 * spread around the tap so a batch of goblins never stacks. Kept free of
 * React, so which link and image each token gets is tested under Node.
 */
export function pendingTokens(
  pending: Exclude<Pending, { kind: "batch" }>,
  input: { view: Pick<RoomState, "tokens" | "characters" | "monsters" | "srdImages">; scene: Pick<Scene, "id" | "bounds" | "gridShape">; world: Point; newId(): string },
): TokenInput[] {
  const { view, scene, world } = input;
  const occupied = occupiedBoxes(Object.values(view.tokens), scene.id);
  const grid = sceneGrid(scene);
  if (pending.kind === "blank") {
    const [at] = spreadPositions({ grid, center: world, footprint: sizeFootprint("medium"), count: 1, bounds: scene.bounds, occupied });
    return at ? [blankToken({ id: input.newId(), sceneId: scene.id, kind: pending.tokenKind, at })] : [];
  }
  if (pending.kind === "character") {
    const character = view.characters[pending.characterId];
    if (!character) return [];
    const [at] = spreadPositions({ grid, center: world, footprint: sizeFootprint(character.size), count: 1, bounds: scene.bounds, occupied });
    return at ? [characterToken(character, { id: input.newId(), sceneId: scene.id, at })] : [];
  }
  const spots = spreadPositions({ grid, center: world, footprint: sizeFootprint(pending.monster.size), count: pending.count, bounds: scene.bounds, occupied });
  // Read now rather than when the DM chose the monster, so an image set from another device in between is the one placed.
  const ref = refOf(pending.monster, pending.monsterId);
  const image = ref ? monsterImage(view, ref) : undefined;
  const link = pending.monsterId !== undefined ? { monsterId: pending.monsterId } : {};
  return spots.map((at) => monsterToken(pending.monster, pending, { id: input.newId(), sceneId: scene.id, at, ...(image ? { image } : {}), ...link }));
}
