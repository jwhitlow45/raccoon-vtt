import type { RoomState, Token } from "#shared/model.ts";
import { WalkWorld, worldUnits, type WorkBudget } from "#shared/rules/walk.ts";
import { publicWorld, type PublicWorld } from "#shared/rules/walkWorld.ts";
import { pathNow } from "../measure/movement.ts";
import { groupWorld, walkersFor, walkersOfGroup } from "../attach/walk.ts";
import { cutForWalkers, dropMode, planGroup, planOne, planPress, rebased, type DropPlan, type DropToken, type Point, type Role } from "./drop.ts";

/** The public world for a walk by this token as this device sees the room (docs/design-v1-movement.md 5.5), with what it drags or carries (docs/design-v1-attach.md 7.3). */
export function worldFor(view: RoomState, token: Token, role: Role): PublicWorld {
  const stops = pathNow(view.encounter, token, role)?.stops ?? [];
  return groupWorld(view, token, role, publicWorld(view, token, { role }, stops));
}

/**
 * An arrow key's press of the drawn token, and the rest of its group, to
 * `asked` (design 14.17), planned on the frame's budget: where the room
 * has the tokens now, since a drop that waited may have landed first
 * (`rebased`), a group's straight legs, and a lone token's one square,
 * never searched round a wall, what it walks over counted (drop.ts
 * `planPress`). Its world's build and its step's check are charged to the
 * budget, steps that cannot stop partway.
 */
export function pressPlan(view: RoomState, drawn: DropToken, asked: Point, drawnGroup: readonly DropToken[], role: Role, budget: WorkBudget): DropPlan {
  const { token, at } = rebased(view.tokens, drawn, asked);
  const group = drawnGroup.map((t) => rebased(view.tokens, t, t).token);
  const mode = dropMode(role, view.scenes[token.sceneId]);
  if (group.length > 1) return planGroup(view, group, at.x - token.x, at.y - token.y, mode, walkersOfGroup(view, group, role));
  const full = view.tokens[token.id];
  if (!full) return planOne(view, token, at, mode);
  const world = new WalkWorld(worldFor(view, full, role).input);
  budget.charge(worldUnits(world));
  // A holder's press stops where a creature it drags beside it would meet a wall (docs/design-v1-attach.md 4.2).
  return cutForWalkers(view, token, planPress(view, world, token, at, mode, view.meta.settings.feetPerCell, (units) => budget.charge(units)), walkersFor(view, token.id, role), mode);
}
