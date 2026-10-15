import { ApiError, type Me } from "./api.ts";
import { parseRoomId } from "./roomId.ts";

/**
 * The rooms this device has been in, so the Home page can list them and a
 * player never retypes a room ID (UP-7). The installed app opens on Home,
 * and "Leave room" goes there too.
 *
 * Only what the list shows is kept, in this device's local storage: the
 * room's ID and name, and who this device was there. It grants nothing. The
 * session cookie is what lets a device back in, and Home asks the server
 * about each room before offering it as signed in.
 *
 * Plain functions over a storage the caller passes, so the tests run
 * without a DOM.
 */
export type KnownRoom = {
  roomId: string;
  name: string;
  role: "dm" | "player";
  memberName: string;
  /** Milliseconds since the epoch. The list is newest first. */
  openedAt: number;
};

const KEY = "rvtt.rooms";
/** Enough for a group's campaigns and one-shots, short enough to scan at a glance. */
export const MAX_KNOWN_ROOMS = 8;
const MAX_TEXT = 80;

type Storage = Pick<globalThis.Storage, "getItem" | "setItem">;

/** Storage that may be missing or refuse (private mode, blocked site data). Only a convenience is lost then. */
function browserStorage(): Storage | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

/** What local storage held, keeping only well formed entries: anything could have written there. */
export function parseKnownRooms(raw: string | null): KnownRoom[] {
  if (!raw) return [];
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(data)) return [];
  const seen = new Set<string>();
  const rooms: KnownRoom[] = [];
  for (const item of data) {
    if (!item || typeof item !== "object") continue;
    const r = item as Record<string, unknown>;
    const roomId = typeof r.roomId === "string" ? parseRoomId(r.roomId) : null;
    if (!roomId || seen.has(roomId)) continue;
    if (r.role !== "dm" && r.role !== "player") continue;
    seen.add(roomId);
    rooms.push({
      roomId,
      name: typeof r.name === "string" ? r.name.slice(0, MAX_TEXT) : "",
      role: r.role,
      memberName: typeof r.memberName === "string" ? r.memberName.slice(0, MAX_TEXT) : "",
      openedAt: typeof r.openedAt === "number" && Number.isFinite(r.openedAt) ? r.openedAt : 0,
    });
  }
  return rooms.sort((a, b) => b.openedAt - a.openedAt).slice(0, MAX_KNOWN_ROOMS);
}

/** The list with this room first, replacing any older entry for it, and the oldest dropped past the limit. */
export function withRoom(rooms: readonly KnownRoom[], room: KnownRoom): KnownRoom[] {
  return [room, ...rooms.filter((r) => r.roomId !== room.roomId)].slice(0, MAX_KNOWN_ROOMS);
}

export function withoutRoom(rooms: readonly KnownRoom[], roomId: string): KnownRoom[] {
  return rooms.filter((r) => r.roomId !== roomId);
}

export function readKnownRooms(storage: Storage | null = browserStorage()): KnownRoom[] {
  try {
    return parseKnownRooms(storage?.getItem(KEY) ?? null);
  } catch {
    return [];
  }
}

function write(rooms: readonly KnownRoom[], storage: Storage | null): void {
  try {
    storage?.setItem(KEY, JSON.stringify(rooms));
  } catch {
    // Storage full or refused. The list is only a convenience.
  }
}

/**
 * Called when the device enters a room, and when it creates or imports one.
 * `name` may be empty when the page does not know it.
 */
export function rememberRoom(
  entry: { roomId: string; name: string; me: { role: Me["role"]; member: Pick<Me["member"], "name"> | null } },
  now: number = Date.now(),
  storage: Storage | null = browserStorage(),
): void {
  const rooms = readKnownRooms(storage);
  const name = entry.name || rooms.find((r) => r.roomId === entry.roomId)?.name || "";
  const room: KnownRoom = { roomId: entry.roomId, name, role: entry.me.role, memberName: entry.me.member?.name ?? "", openedAt: now };
  write(withRoom(rooms, room), storage);
}

export function forgetRoom(roomId: string, storage: Storage | null = browserStorage()): void {
  write(withoutRoom(readKnownRooms(storage), roomId), storage);
}

/** Updates what the list shows, keeping its place in the order. */
export function refreshRoom(roomId: string, fresh: Partial<Omit<KnownRoom, "roomId" | "openedAt">>, storage: Storage | null = browserStorage()): void {
  const rooms = readKnownRooms(storage);
  if (!rooms.some((r) => r.roomId === roomId)) return;
  write(
    rooms.map((r) => (r.roomId === roomId ? { ...r, ...fresh } : r)),
    storage,
  );
}

/** Where this device stands in a remembered room. */
export type RoomStanding =
  | { kind: "in"; role: "dm" | "player"; memberName: string; roomName: string | null }
  /** No grant: signed out, kicked, the password changed, or a DM link replaced. */
  | { kind: "out"; roomName: string | null }
  /** The room no longer exists. */
  | { kind: "gone" }
  /** Offline or the server is busy: offer the room anyway. */
  | { kind: "unknown" };

/**
 * Asks the server. GET /me answers a deleted room the same as a room this
 * device has no grant for, because the grant went with the room, so a
 * refusal is followed by the public room lookup, which says whether the
 * room is still there.
 */
export async function checkStanding(
  roomId: string,
  calls: { getMe(roomId: string): Promise<Me>; getRoom(roomId: string): Promise<{ name: string }> },
): Promise<RoomStanding> {
  try {
    const me = await calls.getMe(roomId);
    return { kind: "in", role: me.role, memberName: me.member?.name ?? "", roomName: me.roomName ?? null };
  } catch (err) {
    if (!(err instanceof ApiError) || (err.status !== 401 && err.status !== 403 && err.status !== 404)) return { kind: "unknown" };
  }
  try {
    return { kind: "out", roomName: (await calls.getRoom(roomId)).name };
  } catch (err) {
    return err instanceof ApiError && err.status === 404 ? { kind: "gone" } : { kind: "out", roomName: null };
  }
}

/**
 * A line for the Home page to show once, such as after this device deleted
 * a room (UD-24). Kept in memory: Home is reached by an in-page navigation,
 * and a reload has nothing left to say.
 */
let homeNotice: string | null = null;

export function setHomeNotice(text: string): void {
  homeNotice = text;
}

export function takeHomeNotice(): string | null {
  const text = homeNotice;
  homeNotice = null;
  return text;
}
