import { AssetError } from "./errors.ts";

/**
 * Intake slots (design section 11.1): the bound on how many request bodies
 * the server streams to disk and processes at once.
 *
 * A slot is taken before the first body byte is read and held through
 * streaming, processing and cleanup, so temporary data on the volume is
 * bounded by the slot count times the size caps.
 *
 * - 4 slots in all, one of them kept for pinned rooms, so the server owner's
 *   own room can always upload while strangers' rooms are busy.
 * - 1 per client IP. Every phone at a table shares one IP, so in a pinned
 *   room the share is counted per session instead, and the DM's map upload
 *   never blocks a player's token.
 * - 2 per room, so one room cannot take the whole server.
 * - 1 room import (a zip of a whole room) server-wide, because each holds a
 *   95 MB body.
 */
export type SlotRequest = {
  kind: "upload" | "roomImport";
  /** Absent for a room import, which creates its room. */
  roomId?: string;
  ip: string;
  sessionId: string;
  pinned: boolean;
};

export type SlotLimits = {
  total: number;
  reservedForPinned: number;
  perIp: number;
  perRoom: number;
  roomImports: number;
};

export const DEFAULT_SLOT_LIMITS: SlotLimits = {
  total: 4,
  reservedForPinned: 1,
  perIp: 1,
  perRoom: 2,
  roomImports: 1,
};

export class IntakeSlots {
  readonly limits: SlotLimits;
  #inUse = 0;
  #roomImports = 0;
  #byClient = new Map<string, number>();
  #byRoom = new Map<string, number>();

  constructor(limits: SlotLimits = DEFAULT_SLOT_LIMITS) {
    this.limits = limits;
  }

  get inUse(): number {
    return this.#inUse;
  }

  /**
   * Takes a slot, or answers 503 with Retry-After. The returned function
   * gives the slot back and is safe to call more than once.
   */
  acquire(req: SlotRequest): () => void {
    const release = this.tryAcquire(req);
    if (!release) throw new AssetError(503, "busy", { retryAfter: 2, closeConnection: true });
    return release;
  }

  tryAcquire(req: SlotRequest): (() => void) | null {
    const l = this.limits;
    const ceiling = req.pinned ? l.total : l.total - l.reservedForPinned;
    if (this.#inUse >= ceiling) return null;
    if (req.kind === "roomImport" && this.#roomImports >= l.roomImports) return null;
    const clientKey = req.pinned ? `s:${req.sessionId}` : `ip:${req.ip}`;
    if ((this.#byClient.get(clientKey) ?? 0) >= l.perIp) return null;
    if (req.roomId !== undefined && (this.#byRoom.get(req.roomId) ?? 0) >= l.perRoom) return null;

    this.#inUse++;
    if (req.kind === "roomImport") this.#roomImports++;
    bump(this.#byClient, clientKey, 1);
    if (req.roomId !== undefined) bump(this.#byRoom, req.roomId, 1);

    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.#inUse--;
      if (req.kind === "roomImport") this.#roomImports--;
      bump(this.#byClient, clientKey, -1);
      if (req.roomId !== undefined) bump(this.#byRoom, req.roomId, -1);
    };
  }
}

/** A plain counter: the cap on concurrent outbound image fetches (design section 10.3). */
export class Semaphore {
  readonly max: number;
  #inUse = 0;

  constructor(max: number) {
    this.max = max;
  }

  get inUse(): number {
    return this.#inUse;
  }

  tryAcquire(): (() => void) | null {
    if (this.#inUse >= this.max) return null;
    this.#inUse++;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.#inUse--;
    };
  }
}

function bump(map: Map<string, number>, key: string, delta: number): void {
  const next = (map.get(key) ?? 0) + delta;
  if (next <= 0) map.delete(key);
  else map.set(key, next);
}
