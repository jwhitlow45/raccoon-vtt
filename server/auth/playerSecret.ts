import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { RoomNotFoundError } from "../rooms/gateway.ts";
import type { Queryable } from "./tx.ts";

/**
 * The player password, kept readable for the room's DM (design 10.2,
 * decided in section 17), so a DM can show the player link and its QR code
 * at any time instead of only right after setting the password.
 *
 * The argon2 hash still checks every join. Beside it, `rooms.player_pw_sealed`
 * holds the password under AES-256-GCM with the server's ROOM_SECRET_KEY. A
 * database dump alone therefore reads no password, and only the DM-only
 * player link route (server/http/rooms.ts) ever opens one.
 *
 * Layout: a version byte, the 12-byte IV, the 16-byte tag, then the
 * ciphertext. The room ID and its `player_epoch` are bound in as associated
 * data. The room ID stops a sealed value copied onto another room's row
 * from opening there. The epoch makes a value that outlived its password
 * fail rather than show a stale link: every password change bumps the
 * epoch, so if anything ever sets a new hash without a new sealed value (an
 * older build after a rollback, say), the old value stops opening and the DM
 * is told to set the password again.
 */
const VERSION = 1;
const IV_BYTES = 12;
const TAG_BYTES = 16;
const HEADER_BYTES = 1 + IV_BYTES + TAG_BYTES;

function associatedData(roomId: string, playerEpoch: number): Buffer {
  return Buffer.from(`raccoon-vtt player password v${VERSION} ${roomId} ${playerEpoch}`, "utf8");
}

export function sealPlayerPassword(key: Buffer, roomId: string, playerEpoch: number, password: string): Buffer {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key, iv, { authTagLength: TAG_BYTES });
  cipher.setAAD(associatedData(roomId, playerEpoch));
  const body = Buffer.concat([cipher.update(password, "utf8"), cipher.final()]);
  return Buffer.concat([Buffer.of(VERSION), iv, cipher.getAuthTag(), body]);
}

/**
 * The password, or null when the value does not open: another key (the
 * server's key was changed), another room or epoch, or damaged bytes. GCM
 * checks the tag before returning anything, so a wrong key never yields a
 * wrong password.
 */
export function openPlayerPassword(key: Buffer, roomId: string, playerEpoch: number, sealed: Buffer): string | null {
  if (sealed.length < HEADER_BYTES || sealed[0] !== VERSION) return null;
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, sealed.subarray(1, 1 + IV_BYTES), { authTagLength: TAG_BYTES });
    decipher.setAAD(associatedData(roomId, playerEpoch));
    decipher.setAuthTag(sealed.subarray(1 + IV_BYTES, HEADER_BYTES));
    return Buffer.concat([decipher.update(sealed.subarray(HEADER_BYTES)), decipher.final()]).toString("utf8");
  } catch {
    return null;
  }
}

/**
 * Seals the password for the room's current `player_epoch` and stores it.
 * Call it in the transaction that sets the password's hash, after any epoch
 * bump, so the two always change together.
 */
export async function storePlayerPassword(q: Queryable, key: Buffer, roomId: string, password: string): Promise<void> {
  const { rows } = await q.query<{ player_epoch: number }>("select player_epoch from rooms where id = $1", [roomId]);
  const epoch = rows[0]?.player_epoch;
  if (epoch === undefined) throw new RoomNotFoundError(roomId);
  await q.query("update rooms set player_pw_sealed = $2 where id = $1", [roomId, sealPlayerPassword(key, roomId, epoch, password)]);
}

/** The room's player password for its DM, or null when none is stored or it does not open. */
export async function readPlayerPassword(
  q: Queryable,
  key: Buffer,
  roomId: string,
): Promise<{ password: string | null; stored: boolean } | null> {
  const { rows } = await q.query<{ player_pw_sealed: Buffer | null; player_epoch: number }>(
    "select player_pw_sealed, player_epoch from rooms where id = $1",
    [roomId],
  );
  const row = rows[0];
  if (!row) return null;
  if (!row.player_pw_sealed) return { password: null, stored: false };
  return { password: openPlayerPassword(key, roomId, row.player_epoch, row.player_pw_sealed), stored: true };
}
