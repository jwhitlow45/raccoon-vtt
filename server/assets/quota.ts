import { statfs } from "node:fs/promises";
import type pg from "pg";
import { AssetError } from "./errors.ts";
import { KeyedMutex } from "./locks.ts";

/**
 * The bytes a room's storage quota counts (design sections 10.1 and 10.5):
 * asset variants, the snapshot, op rows, watermark rows and roll receipts
 * (docs/design-v1-dice.md 1.2), for the room id `$1`. Row sizes come from
 * pg_column_size, which is what the room actually costs on disk after TOAST
 * compression.
 *
 * A starter pick's row is left out (docs/design-v1-starter-art.md 5): its
 * files are shared by every room that picked the work, and the catalog
 * bounds how many a room can hold, so it is nothing a room can grow
 * without end.
 *
 * The log archive is left out: it keeps every line for good and nothing in
 * the room deletes it, so the free-disk floor bounds it instead
 * (hasFreeDisk). The admin page shows it in a room's size on disk
 * (ROOM_ARCHIVE_BYTES_SQL).
 */
export const ROOM_QUOTA_BYTES_SQL = `
       coalesce((select sum(bytes) from assets where room_id = $1 and starter is null), 0)
     + coalesce((select sum(pg_column_size(s.*)) from room_snapshots s where room_id = $1), 0)
     + coalesce((select sum(pg_column_size(o.*)) from room_ops o where room_id = $1), 0)
     + coalesce((select sum(pg_column_size(w.*)) from client_watermarks w where room_id = $1), 0)
     + coalesce((select sum(pg_column_size(r.*)) from roll_receipts r where room_id = $1), 0)`;

/** The log archive's bytes for the room id `$1`, its access rows included, which a room's size on disk counts and its quota does not. */
export const ROOM_ARCHIVE_BYTES_SQL = `coalesce((select sum(pg_column_size(l.*)) from room_log l where room_id = $1), 0)
     + coalesce((select sum(pg_column_size(x.*)) from room_log_access x where room_id = $1), 0)`;

export async function roomStoredBytes(db: pg.Pool | pg.PoolClient, roomId: string): Promise<number> {
  const { rows } = await db.query<{ bytes: string }>(`select ${ROOM_QUOTA_BYTES_SQL} as bytes`, [roomId]);
  return Number(rows[0]?.bytes ?? 0);
}

/** A room's bytes on disk: what its quota counts plus its log archive. The admin page and CLI list this. */
export async function roomPhysicalBytes(db: pg.Pool | pg.PoolClient, roomId: string): Promise<number> {
  const { rows } = await db.query<{ bytes: string }>(`select ${ROOM_QUOTA_BYTES_SQL} + ${ROOM_ARCHIVE_BYTES_SQL} as bytes`, [roomId]);
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
  if (!(await hasFreeDisk(dir, minFreeBytes))) {
    throw new AssetError(507, "storage_full", { closeConnection: true });
  }
}

/**
 * Whether the volume holding `dir` has at least `minFreeBytes` free.
 * Uploads ask it of the asset folder. The log archive asks it before each
 * write of DATABASE_DISK_DIR, or of the asset folder's disk when that is
 * unset (the usual one-disk setup): the floor leaves Postgres room to keep
 * committing ops when one room's history has grown large.
 */
export async function hasFreeDisk(dir: string, minFreeBytes: number): Promise<boolean> {
  if (minFreeBytes <= 0) return true;
  const stats = await statfs(dir);
  return stats.bavail * stats.bsize >= minFreeBytes;
}
