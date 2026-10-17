import { createHash } from "node:crypto";
import { resolveDiceOp, type DiceOp, type Resolved } from "#shared/dice/resolve.ts";
import { serverDraw, type Draw } from "#shared/dice/roll.ts";
import type { RoomState, Viewer } from "#shared/model.ts";

export type { DiceOp, Resolved } from "#shared/dice/resolve.ts";

/**
 * The server's dice (docs/design-v1-dice.md 4.2): the resolve with the
 * secure draw (shared/dice/roll.ts serverDraw), and each op's batch id.
 * Only the actor calls it, after admission and permissions, so no refusal
 * of a roll ever depends on what it would draw.
 */

/**
 * The first 16 characters of the base64url SHA-256 of the roller and the
 * tag (5.1): the same for every batch of one tag, so every viewer groups a
 * group's batches, and saying nothing of the tag, which only the roller's
 * line carries.
 */
export function batchOf(memberId: string, tag: string): string {
  return createHash("sha256").update(`${memberId}\n${tag}`).digest("base64url").slice(0, 16);
}

/** Whether an op is one the resolve rolls, which the actor stores as `sys.dice` in its place. */
export function isDiceOp(op: { t: string }): op is DiceOp {
  return op.t === "dice.roll";
}

export function resolveDice(op: DiceOp, state: RoomState, viewer: Viewer, deps: { draw?: Draw } = {}): Resolved {
  return resolveDiceOp(op, state, { draw: deps.draw ?? serverDraw, batch: batchOf(viewer.memberId, op.tag) });
}
