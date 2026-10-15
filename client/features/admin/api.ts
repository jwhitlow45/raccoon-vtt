import { ApiError, toApiError } from "../../lib/api.ts";

/**
 * The admin page's routes (server/http/admin.ts, docs/design-v1-dm-tools.md
 * 3.18). They answer 404 when the server has no ADMIN_PASSWORD_HASH, and
 * 401 without a live admin session. The shapes mirror the server's types,
 * which the client cannot import.
 */

export type AdminRoom = {
  id: string;
  name: string;
  createdAt: string;
  lastActiveAt: string;
  /** The quota's own sum: an image two rooms share counts in both. */
  bytes: number;
  images: number;
  loaded: boolean;
  sockets: number;
  pinned: boolean;
  readOnly: boolean;
};

export type BackupRun = {
  id: string;
  startedAt: string;
  finishedAt: string | null;
  outcome: "running" | "good" | "partial" | "failed" | "gone";
  dump: string | null;
  dumpBytes: number | null;
  imagesCopied: number | null;
  error: string | null;
};

export type AdminStorage = {
  volume: { totalBytes: number; usedBytes: number; freeBytes: number } | null;
  databaseBytes: number;
  images: { count: number; bytes: number };
  cleanup: { waiting: { count: number; bytes: number }; trash: { files: number; bytes: number } };
  backup: { last: BackupRun | null; lastGood: BackupRun | null; warning: string | null };
};

async function call<T>(method: string, path: string, json?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, {
      method,
      headers: json === undefined ? { accept: "application/json" } : { accept: "application/json", "content-type": "application/json" },
      body: json === undefined ? undefined : JSON.stringify(json),
      mode: "same-origin",
      credentials: "same-origin",
    });
  } catch {
    throw new ApiError(0, "Could not reach the server. Check your connection.", "network", null);
  }
  if (!res.ok) throw await toApiError(res);
  return (res.status === 204 ? undefined : await res.json()) as T;
}

const room = (id: string) => `/api/admin/rooms/${encodeURIComponent(id)}`;

export const adminApi = {
  login: (password: string, turnstileToken?: string) =>
    call<void>("POST", "/api/admin/login", { password, ...(turnstileToken ? { turnstileToken } : {}) }),
  signOut: () => call<void>("DELETE", "/api/admin/session"),
  storage: () => call<AdminStorage>("GET", "/api/admin/storage"),
  rooms: () => call<{ rooms: AdminRoom[] }>("GET", "/api/admin/rooms").then((r) => r.rooms),
  pin: (id: string, pinned: boolean) => call<void>("POST", `${room(id)}/pin`, { pinned }),
  /** `confirm` is the room ID as the admin typed it. */
  deleteRoom: (id: string, confirm: string) => call<void>("DELETE", room(id), { confirm }),
};
