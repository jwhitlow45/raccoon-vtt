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
 */
export const TICKET_TTL_MS = 5 * 60_000;

export type JoinTicket = {
  roomId: string;
  sessionId: string;
  playerEpoch: number;
  expiresAt: number;
};

export class JoinTickets {
  #tickets = new Map<string, JoinTicket>();
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
    this.#tickets.set(token, { roomId, sessionId, playerEpoch, expiresAt: this.#now() + TICKET_TTL_MS });
    return token;
  }

  /** The live ticket, without using it up. */
  peek(token: string): JoinTicket | undefined {
    const ticket = this.#tickets.get(token);
    if (ticket && ticket.expiresAt <= this.#now()) {
      this.#tickets.delete(token);
      return undefined;
    }
    return ticket;
  }

  /**
   * Removes the ticket and returns it. Synchronous, so of two requests
   * racing with the same ticket exactly one gets it.
   */
  take(token: string): JoinTicket | undefined {
    const ticket = this.peek(token);
    if (ticket) this.#tickets.delete(token);
    return ticket;
  }

  /** Puts back a ticket taken by a request that then failed for an unrelated reason. */
  restore(token: string, ticket: JoinTicket): void {
    if (ticket.expiresAt > this.#now()) this.#tickets.set(token, ticket);
  }

  /** Drops every ticket for a room, after its password changes. */
  dropRoom(roomId: string): void {
    for (const [token, ticket] of this.#tickets) if (ticket.roomId === roomId) this.#tickets.delete(token);
  }

  #sweep(): void {
    const now = this.#now();
    for (const [token, ticket] of this.#tickets) if (ticket.expiresAt <= now) this.#tickets.delete(token);
  }
}
