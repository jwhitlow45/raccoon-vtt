import type { ClientOp } from "#shared/protocol.ts";

type Claimable = Extract<ClientOp, { t: "clock.start" | "clock.set" | "clock.advance" | "clock.update" }>;

/**
 * The op with a fresh claim id on it, for an op that can write a clock line
 * (docs/design/design-v1-calendar-c2c3.md 4.6). The reducer copies the id onto
 * the line, and this device then knows the line for its own and makes no
 * toast for it. The sharing switch and a calendar save without a time write
 * no line and send none.
 */
export function withClaim<T extends Claimable>(op: T, newId: () => string): T {
  return { ...op, claim: newId() };
}
