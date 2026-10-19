import { LIMITS, PLAYER_ROLLED_TOO_MUCH, PLAYERS_ROLLED_TOO_MUCH, ROOM_ROLLED_TOO_MUCH } from "#shared/limits.ts";
import type { Op, RefusalCode } from "#shared/protocol.ts";
import type { Clock } from "./budgets.ts";

/**
 * Receipts (docs/design-v1-dice.md 1.2): the dedupe record of every
 * admitted op that rolls or applies, by member, tag and part. A receipt
 * says whether its op committed, with the seq that names its log lines, or
 * was refused after admission, with the refusal's words. It never holds the
 * result itself, which the archive may prune while the receipt stays.
 *
 * The actor holds every receipt younger than 24 hours in memory, loaded
 * with the room, so a restart keeps the duplicate rule, and beside them the
 * staged receipts of the batch being built. A staged receipt is the slot an
 * admitted op reserved: it counts against the caps from admission, so work
 * in flight never passes them, and it goes back if its batch fails for good.
 *
 * The caps never evict. A room holds at most `receiptsPerDay` receipts
 * younger than 24 hours, a player at most `receiptsPerPlayerDay`, and the
 * players together at most the room's cap less `receiptsDmFloor`, so five
 * players at their share can never lock the DMs out of the day.
 */

export const DAY_MS = 24 * 60 * 60 * 1000;

export type Receipt = {
  memberId: string;
  tag: string;
  part: number;
  state: "committed" | "refused";
  /** A committed op's seq: its log lines are `<seq>:<index>`. */
  seq?: number;
  code?: RefusalCode;
  message?: string;
  /** When it was written, in the actor clock's milliseconds. */
  at: number;
  /** Admitted from a player, so it counts against the player's share and the players' together. */
  player: boolean;
};

export type ReceiptCaps = { perDay: number; perPlayer: number; dmFloor: number };

const CAPS: ReceiptCaps = { perDay: LIMITS.receiptsPerDay, perPlayer: LIMITS.receiptsPerPlayerDay, dmFloor: LIMITS.receiptsDmFloor };

/** The receipt key an op carries, for every op that rolls or applies: its client `tag`, and a batch's `part`. Null for every other op. */
export function tagOf(op: Op): { tag: string; part: number } | null {
  // A group save's outcome is settled by its plan's id (docs/design-v1-roll-options.md 5.5).
  if (op.t === "actor.outcome") return { tag: op.plan, part: 0 };
  // A player's ask for saves is settled by its own id (docs/design-v1-player-save-spell.md 5.3), so an ask sent again asks once.
  if (op.t === "cast.ask") return { tag: op.cast.id, part: 0 };
  if (!("tag" in op) || typeof op.tag !== "string") return null;
  const part = "part" in op && typeof op.part === "number" ? op.part : 0;
  return { tag: op.tag, part };
}

/**
 * What admitting an op charges the member's budget (4.4): a free roll one
 * token a roll, and every other tagged op one, so a member uses receipts no
 * faster than their budget and an op that permissions refuse later has
 * paid for its receipt.
 */
export function admissionCost(op: Op): number {
  return op.t === "dice.roll" ? op.rolls.length : 1;
}

function keyOf(memberId: string, tag: string, part: number): string {
  return JSON.stringify([memberId, tag, part]);
}

export class ReceiptBook {
  readonly #now: Clock;
  readonly #caps: ReceiptCaps;
  /** Committed receipts younger than 24 hours, by key, and the same oldest first, which expiry walks. */
  #held = new Map<string, Receipt>();
  #heldOrder: Receipt[] = [];
  #heldStart = 0;
  /** Receipts of admitted ops whose batch is not durable yet. */
  #staged = new Map<string, Receipt>();
  /** Held and staged, by member, and for players together. */
  #byMember = new Map<string, number>();
  #players = 0;

  constructor(now: Clock, caps: Partial<ReceiptCaps> = {}) {
    this.#now = now;
    this.#caps = { ...CAPS, ...caps };
  }

  /** The room's receipts as stored, at load. Only those younger than 24 hours count or answer duplicates. */
  load(receipts: readonly Receipt[]): void {
    const cutoff = this.#now() - DAY_MS;
    for (const r of [...receipts].sort((a, b) => a.at - b.at)) if (r.at > cutoff) this.#hold(r);
  }

  /** The settled receipt of this key, held or staged, if any. */
  find(memberId: string, tag: string, part: number): Receipt | undefined {
    this.#expire();
    const key = keyOf(memberId, tag, part);
    return this.#staged.get(key) ?? this.#held.get(key);
  }

  /**
   * Why a new tagged op of this member may not be admitted, or null. It
   * counts held and staged receipts, so work in flight is counted, and it
   * reserves nothing: the actor stages the op's receipt before it handles
   * any other op.
   */
  refusal(memberId: string, player: boolean): string | null {
    this.#expire();
    if (this.size >= this.#caps.perDay) return ROOM_ROLLED_TOO_MUCH;
    if (!player) return null;
    if ((this.#byMember.get(memberId) ?? 0) >= this.#caps.perPlayer) return PLAYER_ROLLED_TOO_MUCH;
    if (this.#players >= this.#caps.perDay - this.#caps.dmFloor) return PLAYERS_ROLLED_TOO_MUCH;
    return null;
  }

  /** An admitted op's receipt, in the batch being built. It holds its slot until the batch commits or fails. */
  stage(receipt: Receipt): void {
    const key = keyOf(receipt.memberId, receipt.tag, receipt.part);
    if (this.#staged.has(key)) throw new Error("a receipt is staged twice");
    this.#staged.set(key, receipt);
    this.#count(receipt, 1);
  }

  /** The batch holding these staged receipts is durable. */
  committed(receipts: readonly Receipt[]): void {
    for (const r of receipts) {
      const key = keyOf(r.memberId, r.tag, r.part);
      if (this.#staged.get(key) !== r) continue;
      this.#staged.delete(key);
      this.#count(r, -1);
      this.#hold(r);
    }
  }

  /** The batch holding these staged receipts will never commit: they go, and give their slots back. */
  abandoned(receipts: readonly Receipt[]): void {
    for (const r of receipts) {
      const key = keyOf(r.memberId, r.tag, r.part);
      if (this.#staged.get(key) !== r) continue;
      this.#staged.delete(key);
      this.#count(r, -1);
    }
  }

  /** Receipts younger than 24 hours with the staged ones: the room's count against its cap. */
  get size(): number {
    return this.#held.size + this.#staged.size;
  }

  get staged(): number {
    return this.#staged.size;
  }

  /** A member's receipts younger than 24 hours, staged ones included. */
  countOf(memberId: string): number {
    this.#expire();
    return this.#byMember.get(memberId) ?? 0;
  }

  /** The players' receipts together, staged ones included. */
  get players(): number {
    this.#expire();
    return this.#players;
  }

  #hold(r: Receipt): void {
    const key = keyOf(r.memberId, r.tag, r.part);
    const old = this.#held.get(key);
    // A tag used again past its 24 hours replaces the old receipt, as the table's upsert does.
    if (old) this.#count(old, -1);
    this.#held.set(key, r);
    this.#heldOrder.push(r);
    this.#count(r, 1);
  }

  #count(r: Receipt, by: 1 | -1): void {
    const n = (this.#byMember.get(r.memberId) ?? 0) + by;
    if (n === 0) this.#byMember.delete(r.memberId);
    else this.#byMember.set(r.memberId, n);
    if (r.player) this.#players += by;
  }

  /** Receipts reach 24 hours in the order they were held, so expiry only ever walks the front. */
  #expire(): void {
    const cutoff = this.#now() - DAY_MS;
    while (this.#heldStart < this.#heldOrder.length) {
      const r = this.#heldOrder[this.#heldStart]!;
      if (r.at > cutoff) break;
      this.#heldStart++;
      const key = keyOf(r.memberId, r.tag, r.part);
      if (this.#held.get(key) === r) {
        this.#held.delete(key);
        this.#count(r, -1);
      }
    }
    // The walked front is dropped once it is most of the array, so the order never grows past what is held.
    if (this.#heldStart > 1024 && this.#heldStart * 2 > this.#heldOrder.length) {
      this.#heldOrder = this.#heldOrder.slice(this.#heldStart);
      this.#heldStart = 0;
    }
  }
}
