import type { ClientOp } from "#shared/protocol.ts";
import { randomTag } from "../../state/ids.ts";

type Claimable = Extract<ClientOp, { t: "clock.start" | "clock.set" | "clock.advance" | "clock.update" }>;

/**
 * The op with a fresh claim on it, for an op that can write a clock line
 * (docs/design/design-v1-calendar-c2c3.md 4.6). The reducer copies the claim onto
 * the line, and this device then knows the line for its own and makes no
 * toast for it. The sharing switch and a calendar save without a time write
 * no line and send none. A claim names no thing, so it is a random tag, never
 * a new id.
 */
export function withClaim<T extends Claimable>(op: T, claim: string = randomTag()): T {
  return { ...op, claim };
}
