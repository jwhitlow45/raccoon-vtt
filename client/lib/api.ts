import { isApiErrorCode, type ApiErrorCode } from "#shared/apiErrors.ts";
import type { AssetId, BuildChunk, FogTile, Label, LogEntry, Member, MemberId, Scene, Stamp } from "#shared/model.ts";
import type { AssetCredit, SearchResult, SearchSource } from "#shared/protocol.ts";

/**
 * Typed helpers for the HTTP routes in design section 10.8.
 *
 * Every call is a same-origin fetch with the session cookie. The cookie is
 * SameSite=Strict and every non-GET route requires same-origin
 * (Sec-Fetch-Site) and an exact content type (section 10.7), so `mode` and
 * `credentials` are pinned to same-origin and JSON bodies always say
 * `application/json`.
 *
 * Response shapes follow the design's wording. The server slice owns the
 * real ones, so a mismatch is fixed here, in one place.
 */

export type MemberSummary = Pick<Member, "id" | "name" | "color">;
/**
 * Step 1 of the player join's answer: the ticket, the players this device
 * may continue as, and the colors the room's DMs use now, one per DM, with
 * no names or ids (docs/design-v1-visual.md 4.4).
 */
export type JoinStep = { ticket: string; players: MemberSummary[]; dmColors: string[] };
export type Me = {
  member: Pick<Member, "id" | "name" | "color" | "kind">;
  role: "dm" | "player";
  /** The room's name as created, sent by GET /me (not by a join or claim answer). */
  roomName?: string;
};
export type AssetKind = "map" | "token" | "handout" | "thumb";
export type AssetVariant = "full" | "mobile" | "thumb";
export type AssetRow = {
  id: AssetId;
  kind: AssetKind;
  /** Canonical size: the `full` variant's pixels. */
  width: number;
  height: number;
  variants: AssetVariant[];
  /** Upload responses for maps only: a suggested cellPx from a hint such as `30x20` in the file name, or a starter map's measured grid. */
  cellPx?: number;
  /** A starter map pick's answer only: where its measured grid's lines cross, when the build found it, on the image as stored. */
  originPx?: { x: number; y: number };
  /** An Openverse image's credit, with the original's size (docs/design-v1-dm-tools.md 3.13). */
  credit?: AssetCredit;
  /** For a DM only: whether the room's committed state names the image (docs/design-v1-dm-tools.md 3.19). */
  inUse?: boolean;
  /** The bytes the image's files take, when the server says. */
  bytes?: number;
  /** A handout upload's answer only: whether this upload made the image, rather than reusing one the room had (docs/design-v1-pdf-handouts.md 3.9). */
  created?: boolean;
  /** A starter pick's work key, `<pack>/<work>` (docs/design-v1-starter-art.md 5). Absent for the room's own uploads. */
  starter?: string;
  /** A starter pick's SHA-256 in hex, sent with `starter`, to tell whether this page's catalog describes the file the room holds. */
  sha256?: string;
};
/** The server's own shape, which sends the original's size only when the search service gave it. */
export type { SearchResult, SearchSource };
/** Who a device with no member in the room becomes on a DM claim (design 10.2). */
export type DmClaimChoice = { name?: string; memberId?: MemberId };
/** `device` is a rough label from the user agent, such as "Safari on iPhone". `current` marks the calling device. */
/** `online`: the device has a socket open in the room now. `display` marks a table display (docs/design-v1-dm-tools.md 3.1), signed out the same way. */
export type DmDevice = { sessionId: string; memberId: MemberId; device: string; lastSeenAt: string; online: boolean; current: boolean; display?: true };
/** One of this device's own invites from the last hour, found by its expiry time. */
export type DmInviteState = { expiresAt: string; used: boolean };
/** A table display's pairing code (docs/design-v1-dm-tools.md 3.1): `link` is the path `/display#code=<code>`, good once within 10 minutes. */
export type DisplayCode = { code: string; link: string; expiresAt: string };
/** Who a table display is in its room: no member, only an id no member can have. */
export type DisplayMe = { roomId: string; roomName: string; role: "display"; memberId: string };
/**
 * A page of the log's archive, projected for the caller
 * (docs/design-v1-log-history.md 2.2). Its cursors are its own oldest and
 * newest lines. A full page offers the next one in both directions, which
 * may come back empty. A short page ends the direction it was read in, and
 * an empty one names no cursor at all.
 */
export type LogPage = {
  /** Oldest first. */
  entries: LogEntry[];
  /** Pass as `before` for the next older page. Null once an older page came back short or empty. */
  nextBefore: string | null;
  /** Pass as `after` for the next newer page. Null once a newer page came back short or empty, and absent from a server before history paging. */
  nextAfter?: string | null;
  /**
   * The member a page asked for `as` was answered as, a DM's preview of
   * that player (docs/design-v1-per-player-vision.md 7.4, D-261026-10).
   * Absent from every other page.
   */
  as?: MemberId;
};
/**
 * What the server holds of the caller's own ops of one tag
 * (docs/design-v1-dice.md 1.2): each part committed with the lines it wrote,
 * projected for the caller, or refused with its words. A part the answer
 * lacks is unknown.
 */
export type ReceiptLookup = {
  parts: ({ part: number; state: "committed"; seq: number; lines: LogEntry[] } | { part: number; state: "refused"; code: string; message: string })[];
};
/**
 * One evening of the log the caller may read (docs/design-v1-dm-tools.md
 * 3.10): its first and last lines' ids, which select it for an export, and
 * their times, which only label it. Times can run backward when a clock
 * did, so the ids are its key.
 */
export type LogSession = { firstId: string; lastId: string; from: string; to: string; lines: number };
/** A page of sessions, newest first. `lines` counts the caller's whole readable log, whatever the page. */
export type LogSessionPage = { sessions: LogSession[]; lines: number; nextSessionsBefore: string | null };
/** An export to read in full: one session by its first and last ids, both inclusive, or everything with neither. */
export type LogRange = { fromId?: string; toId?: string };
/**
 * The largest log file the page reads into memory before it offers the
 * browser's own download instead (docs/design-v1-log-history.md 4.2).
 */
export const MAX_LOG_FILE_BYTES = 8 * 1024 * 1024;
/** A file the server rendered, with the name it asked to be saved under. */
export type ServerFile = { blob: Blob; fileName: string };
/** A file past the size the page reads, cancelled before any of it became a Blob. */
export class FileTooLargeError extends Error {
  constructor() {
    super("This file is large.");
    this.name = "FileTooLargeError";
  }
}
/** A file whose body stopped before its end, as the server ends one that fails partway. Never saved. */
export class FileCutShortError extends Error {
  constructor() {
    super("The file stopped before its end.");
    this.name = "FileCutShortError";
  }
}
export type ImportForm = {
  /** Replaces the exported room's name. Left out, the name in the export is kept. */
  name?: string;
  playerPassword: string;
  dmName: string;
  turnstileToken?: string;
};

/** The largest room export the site takes back, under Cloudflare's 100 MB request limit (design 10.7 and 16.4). */
export const MAX_IMPORT_BYTES = 95_000_000;

/** A code from the server's list, or "network" when no response arrived. */
export type ApiErrorCodeOrNetwork = ApiErrorCode | "network";

export class ApiError extends Error {
  readonly status: number;
  /**
   * The server's machine-readable code when it sent one from its list, or
   * "network" when no response arrived. Typed from that list, so checking
   * for a code the server never sends fails the typecheck.
   */
  readonly code: ApiErrorCodeOrNetwork | undefined;
  /** From a Retry-After header, in milliseconds. */
  readonly retryAfterMs: number | null;
  /** Any other fields of the error body, such as `reason` on a refused password. */
  readonly detail: Readonly<Record<string, unknown>>;

  constructor(
    status: number,
    message: string,
    code: ApiErrorCodeOrNetwork | undefined,
    retryAfterMs: number | null,
    detail: Readonly<Record<string, unknown>> = {},
  ) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.retryAfterMs = retryAfterMs;
    this.detail = detail;
  }
}

const STATUS_MESSAGES: Record<number, string> = {
  400: "That request was not valid.",
  401: "This device is not signed in to the room.",
  403: "You do not have access to that.",
  404: "Not found.",
  409: "Someone else changed this first. Try again.",
  413: "That is too large.",
  429: "Too many tries. Wait a little and try again.",
  // 502 and 504 come from the proxy in front of the app (Cloudflare, or
  // Vite in development) when the app itself does not answer.
  502: "The server is not answering. Try again in a moment.",
  503: "The server is busy. Try again in a minute.",
  504: "The server is not answering. Try again in a moment.",
};

/** Seconds or an HTTP date, per RFC 9110. Null when absent or unreadable. */
export function parseRetryAfter(value: string | null, now: number = Date.now()): number | null {
  if (value === null) return null;
  const text = value.trim();
  if (/^\d+$/.test(text)) return Number(text) * 1000;
  const at = Date.parse(text);
  return Number.isNaN(at) ? null : Math.max(0, at - now);
}

export async function toApiError(res: Response): Promise<ApiError> {
  let code: ApiErrorCode | undefined;
  let message: string | undefined;
  let detail: Record<string, unknown> = {};
  try {
    const body: unknown = await res.json();
    if (body && typeof body === "object") {
      const b = body as Record<string, unknown>;
      detail = b;
      // The access routes answer `{error: code, ...extra}` (server/auth/http.ts).
      // Anything else, such as Fastify's own `FST_` codes, is left out:
      // nothing on this side knows it, and the status still applies.
      const raw = typeof b.code === "string" ? b.code : b.error;
      if (isApiErrorCode(raw)) code = raw;
      // `message` is meant for people. `error` is often a terse technical
      // string, so it is used only when nothing better exists.
      if (typeof b.message === "string") message = b.message;
    }
  } catch {
    // No JSON body. The status says enough.
  }
  return new ApiError(
    res.status,
    message ?? STATUS_MESSAGES[res.status] ?? `Something went wrong (${res.status}).`,
    code,
    parseRetryAfter(res.headers.get("retry-after")),
    detail,
  );
}

type RequestOptions = { json?: unknown; body?: Blob; contentType?: string; headers?: Record<string, string>; signal?: AbortSignal };

async function request<T>(method: string, path: string, options: RequestOptions = {}): Promise<T> {
  const headers: Record<string, string> = { ...options.headers, accept: "application/json" };
  let body: BodyInit | undefined;
  if (options.json !== undefined) {
    headers["content-type"] = "application/json";
    body = JSON.stringify(options.json);
  } else if (options.body) {
    headers["content-type"] = options.contentType ?? options.body.type;
    body = options.body;
  }
  let res: Response;
  try {
    res = await fetch(path, {
      method,
      headers,
      body,
      mode: "same-origin",
      credentials: "same-origin",
      signal: options.signal,
    });
  } catch (err) {
    if (options.signal?.aborted) throw err;
    throw new ApiError(0, "Could not reach the server. Check your connection.", "network", null);
  }
  if (!res.ok) throw await toApiError(res);
  if (res.status === 204) return undefined as T;
  const type = res.headers.get("content-type") ?? "";
  return (type.includes("application/json") ? await res.json() : undefined) as T;
}

export type RetryOptions = {
  /** Total time to keep retrying, 60 s by default (design section 11.1). */
  budgetMs?: number;
  /** True while waiting on the server, so the UI can say "Waiting for the server…". */
  onWaiting?: (waiting: boolean) => void;
  signal?: AbortSignal;
  now?: () => number;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
};

const DEFAULT_WAIT_MS = 2000;
const MIN_WAIT_MS = 250;
const MAX_WAIT_MS = 15_000;

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    function onAbort() {
      clearTimeout(timer);
      reject(signal?.reason);
    }
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * Uploads, URL imports and searches answer 503 with Retry-After when the
 * server's intake slots or processing queue are full (design section 11.1).
 * At an in-person session start several phones upload at once, so instead of
 * failing, the client waits as told and tries again, for up to 60 s in total.
 * Any other error, or a wait that would run past the budget, is thrown.
 */
/** The file name in a Content-Disposition header, or null when it names none. */
export function dispositionFileName(header: string | null): string | null {
  const match = header ? /filename="([^"]+)"/.exec(header) : null;
  return match ? match[1]! : null;
}

/**
 * A GET whose answer is a file, read whole, with the same errors as
 * `request`. With `maxBytes` the body is read a chunk at a time and
 * cancelled once it passes that, so a large file never sits in memory
 * whole. A body that breaks off is an error, never a shorter file.
 */
async function requestFile(path: string, fallbackName: string, signal?: AbortSignal, maxBytes?: number): Promise<ServerFile> {
  let res: Response;
  try {
    res = await fetch(path, { method: "GET", headers: { accept: "text/markdown, application/json" }, mode: "same-origin", credentials: "same-origin", signal });
  } catch (err) {
    if (signal?.aborted) throw err;
    throw new ApiError(0, "Could not reach the server. Check your connection.", "network", null);
  }
  if (!res.ok) throw await toApiError(res);
  const fileName = dispositionFileName(res.headers.get("content-disposition")) ?? fallbackName;
  const type = res.headers.get("content-type") ?? "";
  if (maxBytes === undefined || !res.body) {
    try {
      return { blob: await res.blob(), fileName };
    } catch (err) {
      if (signal?.aborted) throw err;
      throw new FileCutShortError();
    }
  }
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    let next: ReadableStreamReadResult<Uint8Array>;
    try {
      next = await reader.read();
    } catch (err) {
      if (signal?.aborted) throw err;
      throw new FileCutShortError();
    }
    if (next.done) break;
    size += next.value.byteLength;
    if (size > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw new FileTooLargeError();
    }
    chunks.push(next.value);
  }
  return { blob: new Blob(chunks as BlobPart[], { type }), fileName };
}

export async function retryOn503<T>(attempt: () => Promise<T>, options: RetryOptions = {}): Promise<T> {
  const budget = options.budgetMs ?? 60_000;
  const now = options.now ?? Date.now;
  const wait = options.sleep ?? sleep;
  const start = now();
  let waiting = false;
  try {
    for (;;) {
      try {
        return await attempt();
      } catch (err) {
        if (!(err instanceof ApiError) || err.status !== 503) throw err;
        const ms = Math.min(Math.max(err.retryAfterMs ?? DEFAULT_WAIT_MS, MIN_WAIT_MS), MAX_WAIT_MS);
        if (now() - start + ms > budget) throw err;
        if (!waiting) {
          waiting = true;
          options.onWaiting?.(true);
        }
        await wait(ms, options.signal);
      }
    }
  } finally {
    if (waiting) options.onWaiting?.(false);
  }
}

/**
 * Every upload from this device, one at a time (docs/design-v1-pdf-handouts.md
 * 4.1.4). The server gives an IP one intake slot, so a second upload would
 * only wait for this one's 503s to pass. An upload marked `background`, a
 * PDF's pages, waits behind every other: an image picked in a form goes
 * before the job's next page. Aborting an upload still waiting here takes
 * it out and rejects at once, without sending it, so a Cancel never waits
 * behind another upload.
 */
export class UploadQueue {
  #running = false;
  readonly #waiting: { background: boolean; start(): void }[] = [];

  run<T>(work: () => Promise<T>, options: { background?: boolean; signal?: AbortSignal } = {}): Promise<T> {
    const { signal } = options;
    if (signal?.aborted) return Promise.reject(signal.reason);
    return new Promise<T>((resolve, reject) => {
      const entry = {
        background: options.background === true,
        start: () => {
          signal?.removeEventListener("abort", onAbort);
          work()
            .then(resolve, reject)
            .finally(() => this.#next());
        },
      };
      const onAbort = () => {
        const at = this.#waiting.indexOf(entry);
        if (at < 0) return;
        this.#waiting.splice(at, 1);
        reject(signal?.reason);
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      // Before the first background upload waiting, or last.
      const firstBackground = entry.background ? -1 : this.#waiting.findIndex((w) => w.background);
      if (firstBackground < 0) this.#waiting.push(entry);
      else this.#waiting.splice(firstBackground, 0, entry);
      if (!this.#running) this.#next();
    });
  }

  /** Uploads waiting, the one running not counted. */
  get waiting(): number {
    return this.#waiting.length;
  }

  #next(): void {
    const entry = this.#waiting.shift();
    this.#running = entry !== undefined;
    entry?.start();
  }
}

const uploads = new UploadQueue();

/** How an upload goes through the device's queue, beside its 503 retries. */
export type UploadOptions = RetryOptions & {
  /** The original file name, sent only so a map's name can hint its grid (design 11.1). */
  name?: string;
  /** Waits behind every other upload of this device: a PDF's pages (UploadQueue). */
  background?: boolean;
  /** True while a request is on its way and its answer awaited, false while queued or waiting to retry, so a Cancel knows which it stops. */
  onSending?: (sending: boolean) => void;
};

const room = (roomId: string) => `/api/rooms/${encodeURIComponent(roomId)}`;

/**
 * A scene as every player and table display gets it, for the DM's map
 * export (docs/design-v1-map-discovery.md 4, "Map export's player view"):
 * the server's shared projection of its build, memory included, and the
 * labels and stamps players get there, and the scene and fog as players'
 * copy holds them (server/http/playerView.ts). The DM's own copy holds the
 * whole build and no memory, so only the server can say this.
 */
export type PlayerSceneView = { scene: Scene; buildChunks: Record<string, BuildChunk>; labels: Record<string, Label>; stamps: Record<string, Stamp>; fogTiles: Record<string, FogTile> };

export const api = {
  /** Public server settings: the Turnstile site key when Turnstile is on, and whether image search is. */
  getConfig: () => request<{ turnstileSiteKey: string | null; searchEnabled: boolean }>("GET", "/api/config"),

  createRoom: (input: { name: string; playerPassword: string; dmName: string; turnstileToken?: string }) =>
    request<{ roomId: string; dmLink: string }>("POST", "/api/rooms", { json: input }),

  /** The room's name only, for the join page. */
  getRoom: (roomId: string) => request<{ name: string }>("GET", room(roomId)),

  /** The DM only: a scene as players get it (PlayerSceneView). */
  getPlayerView: (roomId: string, sceneId: string, signal?: AbortSignal) => request<PlayerSceneView>("GET", `${room(roomId)}/scenes/${encodeURIComponent(sceneId)}/player-view`, { signal }),

  /** The caller's member and role. A 401, 403 or 404 means this device has no grant here. */
  getMe: (roomId: string) => request<Me>("GET", `${room(roomId)}/me`),

  /**
   * Step 1 of the player join: the password. The roster comes back only on
   * success. A room that has seen many wrong passwords also asks for a
   * solved Turnstile check, and answers `turnstile_required` without one.
   */
  join: (roomId: string, password: string, turnstileToken?: string) =>
    request<JoinStep>("POST", `${room(roomId)}/join`, {
      json: { password, ...(turnstileToken ? { turnstileToken } : {}) },
    }),

  /** Step 2: continue as an existing player, or become a new one. */
  completeJoin: (
    roomId: string,
    input: { ticket: string; memberId: MemberId } | { ticket: string; name: string; color: string },
  ) => request<Me>("POST", `${room(roomId)}/join/complete`, { json: input }),

  /**
   * `name` (someone new) or `memberId` (a current DM member, "This is me")
   * is used only when this device has no member in the room yet. With
   * neither, such a device is refused with `choose_member`, whose detail
   * lists the room's DM members to choose from (claimRefusal.ts).
   */
  claimDm: (roomId: string, input: DmClaimChoice & { key: string }) =>
    request<Me>("POST", `${room(roomId)}/dm`, { json: input }),

  /** `link` is a path (`/r/<id>#invite=<token>`). The invite works once, for 10 minutes. */
  mintInvite: (roomId: string) =>
    request<{ token: string; link: string; expiresAt: string }>("POST", `${room(roomId)}/dm/invite`, { json: {} }),

  /** The same choice as claimDm. Asking spends nothing: the invite is used only by a claim that succeeds. */
  redeemInvite: (roomId: string, input: DmClaimChoice & { token: string }) =>
    request<Me>("POST", `${room(roomId)}/dm/redeem`, { json: input }),

  /** A bare invite token. The server finds the room from it, and names it in a `choose_member` refusal too. */
  redeemBareInvite: (input: DmClaimChoice & { token: string }) =>
    request<Me & { roomId: string }>("POST", "/api/dm/redeem", { json: input }),

  listDmDevices: (roomId: string) => request<{ devices: DmDevice[]; invites: DmInviteState[] }>("GET", `${room(roomId)}/dm/devices`),

  revokeDmDevice: (roomId: string, sessionId: string) =>
    request<void>("DELETE", `${room(roomId)}/dm/devices/${encodeURIComponent(sessionId)}`),

  replaceDmLink: (roomId: string) =>
    request<{ dmLink: string }>("POST", `${room(roomId)}/dm/replace-link`, { json: {} }),

  removeDm: (roomId: string, memberId: MemberId) =>
    request<void>("DELETE", `${room(roomId)}/dm/members/${encodeURIComponent(memberId)}`),

  changePassword: (roomId: string, password: string) =>
    request<void>("POST", `${room(roomId)}/password`, { json: { password } }),

  /**
   * The player link (`/r/<id>#pw=<password>`) for a DM to show at any time,
   * or null when the server holds no copy of the password it can open: the
   * password was set before the server kept one, or its key changed.
   * Changing the password once stores a fresh copy.
   */
  getPlayerLink: (roomId: string) => request<{ playerLink: string | null }>("GET", `${room(roomId)}/player-link`),

  kick: (roomId: string, memberId: MemberId) =>
    request<void>("DELETE", `${room(roomId)}/members/${encodeURIComponent(memberId)}/grants`),

  /** A kick that also takes the member off the roster. */
  removeMember: (roomId: string, memberId: MemberId) =>
    request<void>("DELETE", `${room(roomId)}/members/${encodeURIComponent(memberId)}`),

  /** The DM types the room's name to confirm. */
  deleteRoom: (roomId: string, name: string) => request<void>("DELETE", room(roomId), { json: { name } }),

  /** Runs the export route's checks without making the zip: resolves when an export may start now, else throws the refusal. */
  checkExport: (roomId: string) => request<void>("HEAD", exportUrl(roomId)),

  /** The caller's own receipts of one tag, for an op whose answer this device lost (docs/design-v1-dice.md 1.2). */
  getReceipts: (roomId: string, tag: string) => request<ReceiptLookup>("GET", `${room(roomId)}/receipts/${encodeURIComponent(tag)}`),

  /** A public D&D Beyond character read by the server into a stat block's fill (docs/design-v1-pc-stats.md 6.3). The caller checks the fill. */
  ddbImport: (roomId: string, link: string, signal?: AbortSignal) => request<{ fill: unknown }>("POST", `${room(roomId)}/ddb-import`, { json: { link }, signal }),

  /**
   * A page of the log's archive, projected for the caller: lines before an
   * id, after one, or the newest with neither (docs/design-v1-log-history.md
   * 2.2). A DM's page names the scene it is viewing. `as`: a DM's preview of
   * that player, whose pages the server projects for them
   * (docs/design-v1-per-player-vision.md 7.4).
   */
  getLog: (roomId: string, options: { before?: string; after?: string; sceneId?: string | null; limit?: number; as?: string } = {}, signal?: AbortSignal) => {
    const q = new URLSearchParams();
    if (options.before !== undefined) q.set("before", options.before);
    if (options.after !== undefined) q.set("after", options.after);
    if (options.sceneId) q.set("sceneId", options.sceneId);
    if (options.limit !== undefined) q.set("limit", String(options.limit));
    if (options.as !== undefined) q.set("as", options.as);
    const query = q.toString();
    return request<LogPage>("GET", `${room(roomId)}/log${query ? `?${query}` : ""}`, { signal });
  },

  /**
   * A new room from an export zip (design 16.4). The body is the zip itself,
   * so the form travels in a header, never in the URL where logs would keep
   * the password.
   */
  importRoom: (file: Blob, form: ImportForm, options: RetryOptions = {}) =>
    retryOn503(
      () =>
        request<{ roomId: string; dmLink: string }>("POST", "/api/rooms/import", {
          body: file,
          contentType: "application/zip",
          headers: { "x-import-form": importFormHeader(form) },
          signal: options.signal,
        }),
      options,
    ),

  listAssets: (roomId: string) => request<{ assets: AssetRow[] }>("GET", `${room(roomId)}/assets`),

  /**
   * Deletes library images nothing uses, DM only, at most 500 a request
   * (docs/design-v1-dm-tools.md 3.19). The server refuses with
   * `asset_in_use` an image the room's state names when the request runs.
   */
  deleteAssets: (roomId: string, ids: readonly string[]) => request<unknown>("POST", `${room(roomId)}/assets/delete`, { json: { ids } }),

  /** Through the device's one upload queue (UploadQueue), with its 503 retries. */
  uploadAsset: (roomId: string, kind: AssetKind, file: Blob, options: UploadOptions = {}) =>
    uploads.run(
      () =>
        retryOn503(async () => {
          options.onSending?.(true);
          try {
            return await request<AssetRow>("PUT", `${room(roomId)}/assets?kind=${kind}${options.name ? `&name=${encodeURIComponent(options.name.slice(0, 255))}` : ""}`, {
              body: file,
              contentType: file.type,
              signal: options.signal,
            });
          } finally {
            options.onSending?.(false);
          }
        }, options),
      { background: options.background, signal: options.signal },
    ),

  importAsset: (roomId: string, input: { url: string; fallback?: string; kind: AssetKind }, options: RetryOptions = {}) =>
    retryOn503(
      () => request<AssetRow>("POST", `${room(roomId)}/assets/import`, { json: input, signal: options.signal }),
      options,
    ),

  /**
   * Copies a starter work into the room as an image of this kind
   * (docs/design-v1-starter-art.md 5). The server reads the work from its
   * own catalog and keeps the catalog's credit, so only the key is sent.
   */
  pickStarter: (roomId: string, input: { work: string; kind: "map" | "token" | "handout" }, options: RetryOptions = {}) =>
    retryOn503(
      () => request<AssetRow>("POST", `${room(roomId)}/assets/starter`, { json: input, signal: options.signal }),
      options,
    ),

  // Table displays (docs/design-v1-dm-tools.md 3.1). Minting takes this
  // device's DM grant. The other three use the display's own session, in a
  // cookie of its own, so a DM's laptop can hold both at once.

  /** A one-time code for a table display. At most 3 wait at once (`too_many_codes`). */
  mintDisplayCode: (roomId: string) => request<DisplayCode>("POST", `${room(roomId)}/display/code`, { json: {} }),

  /** Pairs this device as a table display. `bad_code`, or `displays_full` when the room has 4 already. */
  redeemDisplayCode: (code: string) => request<{ roomId: string }>("POST", "/api/display/redeem", { json: { code } }),

  /** This device as the room's table display. A 401 or 403 means it is not one, or no longer. */
  getDisplayMe: (roomId: string) => request<DisplayMe>("GET", `${room(roomId)}/display/me`),

  /** Leave: signs this display out for good and clears its cookie. */
  leaveDisplay: () => request<void>("DELETE", "/api/display/session"),

  // Notes and the table (docs/design-v1-dm-tools.md 3.10 and 3.11).

  /**
   * The evenings of the log the caller may read, newest first, 25 to a page
   * by default: the page before `before`, a session's `firstId` from
   * `nextSessionsBefore`, or the newest. Every page counts against the same
   * hourly limit as an export, whatever the server had cached.
   */
  logSessions: (roomId: string, options: { before?: string; limit?: number } = {}) => {
    const q = new URLSearchParams();
    if (options.before !== undefined) q.set("before", options.before);
    if (options.limit !== undefined) q.set("limit", String(options.limit));
    const query = q.toString();
    return request<LogSessionPage>("GET", `${room(roomId)}/log/sessions${query ? `?${query}` : ""}`);
  },

  /**
   * The log as a Markdown file, read into memory up to MAX_LOG_FILE_BYTES:
   * one session or everything (`range`), with times in `tz`, the device's
   * IANA time zone. Past that size it throws FileTooLargeError, and
   * logExportUrl then serves the browser's own download.
   */
  exportLog: (roomId: string, range: LogRange, tz: string, signal?: AbortSignal) => requestFile(logExportUrl(roomId, range, tz), "log.md", signal, MAX_LOG_FILE_BYTES),

  /**
   * The X-card: asks the whole table to edit out what just happened, with
   * no name on it. The server answers 204 for a tap that merged into a card
   * already showing, and a bare 429 past a session's taps for the hour.
   */
  xcard: (roomId: string) => request<void>("POST", `${room(roomId)}/xcard`),

  /** Google first when the server has it, Openverse when it cannot answer, or Openverse on purpose with `source`. */
  imageSearch: (roomId: string, q: string, options: RetryOptions & { source?: "openverse" } = {}) =>
    retryOn503(
      () =>
        request<{ results: SearchResult[]; source: SearchSource }>("POST", `${room(roomId)}/image-search`, {
          json: options.source ? { q, source: options.source } : { q },
          signal: options.signal,
        }),
      options,
    ),
};

/** JSON as base64url, the encoding the import route reads its form header in. */
export function importFormHeader(form: ImportForm): string {
  const bytes = new TextEncoder().encode(JSON.stringify(form));
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function assetUrl(assetId: AssetId, variant: AssetVariant): string {
  return `/api/assets/${encodeURIComponent(assetId)}/${variant}`;
}

/** A table display's images come through its own route, which reads the display's cookie and allows only what it may show. */
export function displayAssetUrl(roomId: string, assetId: AssetId, variant: AssetVariant): string {
  return `${room(roomId)}/display/assets/${encodeURIComponent(assetId)}/${variant}`;
}

/** A plain GET the browser downloads, so the zip streams to disk instead of into memory. */
/** The log export's address, for the browser's own download of a file too large to read here. Each visit is another export. */
export function logExportUrl(roomId: string, range: LogRange, tz: string): string {
  const q = new URLSearchParams();
  if (range.fromId !== undefined && range.toId !== undefined) {
    q.set("fromId", range.fromId);
    q.set("toId", range.toId);
  }
  q.set("tz", tz);
  return `${room(roomId)}/log/export?${q.toString()}`;
}

export function exportUrl(roomId: string): string {
  return `${room(roomId)}/export`;
}
