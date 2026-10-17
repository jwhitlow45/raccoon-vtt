import { statfs } from "node:fs/promises";
import type pg from "pg";
import { AssetError } from "./errors.ts";
import { KeyedMutex } from "./locks.ts";

/**
 * Bytes a room owns in Postgres and on the asset volume (design sections 10.1
 * and 10.5): asset variants, the snapshot, op rows, log rows, watermark
 * rows and roll receipts (docs/design-v1-dice.md 1.2). Row sizes come from
 * pg_column_size, which is what the room actually costs on disk after TOAST
 * compression.
 */
export async function roomStoredBytes(db: pg.Pool | pg.PoolClient, roomId: string): Promise<number> {
  const { rows } = await db.query<{ bytes: string }>(
    `select
       coalesce((select sum(bytes) from assets where room_id = $1), 0)
     + coalesce((select sum(pg_column_size(s.*)) from room_snapshots s where room_id = $1), 0)
     + coalesce((select sum(pg_column_size(o.*)) from room_ops o where room_id = $1), 0)
     + coalesce((select sum(pg_column_size(l.*)) from room_log l where room_id = $1), 0)
     + coalesce((select sum(pg_column_size(w.*)) from client_watermarks w where room_id = $1), 0)
     + coalesce((select sum(pg_column_size(r.*)) from roll_receipts r where room_id = $1), 0)
     as bytes`,
    [roomId],
  );
  return Number(rows[0]?.bytes ?? 0);
}

export type StoredBytesFn = (roomId: string) => Promise<number>;

/**
 * Per-room storage reservations (design section 11.1).
 *
 * An upload reserves its Content-Length (or its kind's size cap) before
 * reading a byte. Processing can make variants bigger than the upload, for
 * example a small PNG of fine line art, so the commit step reserves the
 * difference before the row is written. Reserving and committing both run
 * under a per-room lock that also reads the stored size, so two concurrent
 * uploads can never both fit into the same remaining space.
 */
export class RoomQuota {
  readonly quotaBytes: number;
  #storedBytes: StoredBytesFn;
  #reserved = new Map<string, number>();
  #locks = new KeyedMutex();

  constructor(quotaBytes: number, storedBytes: StoredBytesFn) {
    this.quotaBytes = quotaBytes;
    this.#storedBytes = storedBytes;
  }

  reservedBytes(roomId: string): number {
    return this.#reserved.get(roomId) ?? 0;
  }

  /** Reserves `bytes` for the room, or answers 413 when they do not fit. */
  async reserve(roomId: string, bytes: number): Promise<Reservation> {
    return this.#locks.run(roomId, async () => {
      const stored = await this.#storedBytes(roomId);
      if (stored + this.reservedBytes(roomId) + bytes > this.quotaBytes) {
        throw new AssetError(413, "quota_exceeded", { closeConnection: true });
      }
      this.#add(roomId, bytes);
      return new Reservation(this, roomId, bytes);
    });
  }

  /** @internal Used by Reservation. */
  async commitReservation<T>(res: Reservation, finalBytes: number, write: () => Promise<T>): Promise<T> {
    return this.#locks.run(res.roomId, async () => {
      if (res.released) throw new Error("reservation already released");
      if (finalBytes > res.bytes) {
        const stored = await this.#storedBytes(res.roomId);
        const others = this.reservedBytes(res.roomId) - res.bytes;
        if (stored + others + finalBytes > this.quotaBytes) {
          throw new AssetError(413, "quota_exceeded");
        }
      }
      try {
        return await write();
      } finally {
        // Released under the lock, after the row is written, so the next
        // reader sees the bytes either as reserved or as stored, never neither.
        this.releaseReservation(res);
      }
    });
  }

  /** @internal Used by Reservation. Idempotent. */
  releaseReservation(res: Reservation): void {
    if (res.released) return;
    res.released = true;
    this.#add(res.roomId, -res.bytes);
  }

  #add(roomId: string, delta: number): void {
    const next = this.reservedBytes(roomId) + delta;
    if (next <= 0) this.#reserved.delete(roomId);
    else this.#reserved.set(roomId, next);
  }
}

export class Reservation {
  readonly roomId: string;
  readonly bytes: number;
  released = false;
  #quota: RoomQuota;

  constructor(quota: RoomQuota, roomId: string, bytes: number) {
    this.#quota = quota;
    this.roomId = roomId;
    this.bytes = bytes;
  }

  /**
   * Runs `write` (which stores rows totalling `finalBytes`) once the final
   * size is known to fit, then releases the reservation. Throws 413 when
   * the variants outgrew the reservation and the difference does not fit.
   */
  commit<T>(finalBytes: number, write: () => Promise<T>): Promise<T> {
    return this.#quota.commitReservation(this, finalBytes, write);
  }

  release(): void {
    this.#quota.releaseReservation(this);
  }
}

/**
 * The volume-wide guard (design section 10.1): refuse new images when under
 * `minFreeBytes` are free, so one room cannot fill the disk that Postgres and
 * every other room share.
 */
export async function assertFreeDisk(dir: string, minFreeBytes: number): Promise<void> {
  if (minFreeBytes <= 0) return;
  const stats = await statfs(dir);
  if (stats.bavail * stats.bsize < minFreeBytes) {
    throw new AssetError(507, "storage_full", { closeConnection: true });
  }
}
