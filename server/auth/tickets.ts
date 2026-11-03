import { randomToken } from "./tokens.ts";

/**
 * Join tickets: proof that this session typed the player password a moment
 * ago, so step two of a join can show the roster and write a grant without
 * asking again (design section 10.2).
 *
 * They live in memory only. A restart drops them, which costs a player one
 * retyped password, and keeps an unused ticket from ever outliving the
 * process. Each one is bound to the room, the session and the room's
 * `player_epoch` when the password was checked, so it is useless in another
 * room, from another device, or after the DM changes the password.
 *
 * A ticket is reserved while a join it started is still settling
 * (docs/design/design-v1-join-requests.md 5.2): nobody can use it then, and
 * it is spent once the join commits, or comes back once the join is known
 * to have failed, so the device may try again without the password.
 */
export const TICKET_TTL_MS = 5 * 60_000;

export type JoinTicket = {
  roomId: string;
  sessionId: string;
  playerEpoch: number;
  expiresAt: number;
};

type Entry = { ticket: JoinTicket; reserved: boolean };

export class JoinTickets {
  #tickets = new Map<string, Entry>();
  #now: () => number;

  constructor(now: () => number = () => Date.now()) {
    this.#now = now;
  }

  get size(): number {
    return this.#tickets.size;
  }

  mint(roomId: string, sessionId: string, playerEpoch: number): string {
    this.#sweep();
    const token = randomToken();
    this.#tickets.set(token, { ticket: { roomId, sessionId, playerEpoch, expiresAt: this.#now() + TICKET_TTL_MS }, reserved: false });
    return token;
  }

  /** The live ticket, without using it up, and whether a join holds it. */
  peek(token: string): (JoinTicket & { reserved: boolean }) | undefined {
    const entry = this.#live(token);
    return entry ? { ...entry.ticket, reserved: entry.reserved } : undefined;
  }

  /**
   * Reserves the ticket for one join attempt. Synchronous, so of two
   * requests racing with the same ticket exactly one gets it, and the other
   * learns that it is held rather than gone.
   */
  reserve(token: string): JoinTicket | "reserved" | undefined {
    const entry = this.#live(token);
    if (!entry) return undefined;
    if (entry.reserved) return "reserved";
    entry.reserved = true;
    return entry.ticket;
  }

  /** The attempt committed: the ticket is used up. */
  spend(token: string): void {
    this.#tickets.delete(token);
  }

  /**
   * The attempt is known to have failed: the ticket may be used again, if
   * its 5 minutes are not up. A ticket dropped meanwhile (a password change,
   * Only by asking) stays dropped.
   */
  release(token: string): void {
    const entry = this.#live(token);
    if (entry) entry.reserved = false;
  }

  /** Drops every ticket for a room, reserved ones too, after its password changes or it switches to Only by asking. */
  dropRoom(roomId: string): void {
    for (const [token, entry] of this.#tickets) if (entry.ticket.roomId === roomId) this.#tickets.delete(token);
  }

  #live(token: string): Entry | undefined {
    const entry = this.#tickets.get(token);
    if (entry && entry.ticket.expiresAt <= this.#now()) {
      this.#tickets.delete(token);
      return undefined;
    }
    return entry;
  }

  #sweep(): void {
    const now = this.#now();
    for (const [token, entry] of this.#tickets) if (entry.ticket.expiresAt <= now) this.#tickets.delete(token);
  }
}
