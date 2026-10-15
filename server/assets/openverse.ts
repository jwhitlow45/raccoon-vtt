import type pg from "pg";
import sharp from "sharp";
import { request, type Dispatcher } from "undici";
import type { ApiErrorCode } from "#shared/apiErrors.ts";
import { LIMITS } from "#shared/limits.ts";
import { assetCreditSchema, imageCreditSchema, type AssetCredit, type ImageCredit, type SearchResult } from "#shared/protocol.ts";
import { isOpenverseThumbnail } from "#shared/searchThumbnails.ts";
import { AssetError } from "./errors.ts";
import { WindowLimiter } from "./limits.ts";
import { configureSharp } from "./process.ts";
import { MAX_QUERY_LENGTH, normalizeQuery } from "./serpapi.ts";

/**
 * Openverse, the second image search (docs/design-v1-dm-tools.md 3.13): free
 * and openly licensed, searched when SerpApi cannot answer or when a member
 * asks for it.
 *
 * Openverse is run by others and its anonymous limits are per address, so
 * the whole server shares them. Every search that reaches it is reserved
 * first against a server-wide day and minute below Openverse's own, and
 * against the member in the room, the room and the address (section 2.4).
 * The table plays in person behind one address, so the member's count is
 * the one people meet, and the address's is only a cap against a flood.
 * Results are cached for 7 days under `openverse:<q>`, apart from SerpApi's.
 *
 * Every result keeps its credit, so an image imported from one stores who
 * made it and under which license (`creditForImport`).
 *
 * Two things about the service could not be checked before building
 * (section 10): how long a registered client's token lives in production,
 * and what a live 429 says. So the token is kept for the lifetime its answer
 * states, less 5 minutes, and a 401 with a token fetches a new one and tries
 * once more. A 429 is read by its status alone, and its Retry-After header
 * is honored when it has one.
 *
 * The client secret and the token travel only to api.openverse.org through
 * the strict egress port. Neither is logged, cached or answered, and errors
 * from here carry only status codes.
 */

const API = "https://api.openverse.org/v1";
const CACHE_PREFIX = "openverse:";
const CACHE_DAYS = 7;
/** Openverse answers in well under a second when it is healthy. */
const TIMEOUT_MS = 15_000;
const TOKEN_MARGIN_MS = 5 * 60_000;
/** A token answer without a usable lifetime is assumed to last this long, so it is fetched again soon. */
const UNSTATED_TOKEN_LIFETIME_MS = 10 * 60_000;
const MAX_TOKEN_LIFETIME_MS = 30 * 24 * 3600_000;
/** How long the server stops asking after a 429 that names no wait. */
const BUSY_MS = 60_000;
/** Openverse's file types the import accepts. SVG originals are left out, which the import refuses anyway. */
const EXTENSIONS = "jpg,png,webp,gif";

/**
 * Every Creative Commons license and public domain except no-derivatives
 * ones, since cropping an image into a token adapts it (question 5).
 * `license_type=modification` asks Openverse for exactly these, and this
 * list checks its answer.
 */
const ADAPTABLE_LICENSES: ReadonlySet<string> = new Set(["by", "by-sa", "by-nc", "by-nc-sa", "cc0", "pdm", "sampling+", "nc-sampling+"]);

export type OpenverseRequest = {
  url: string;
  method?: "GET" | "POST";
  headers?: Record<string, string>;
  /** Sent as application/x-www-form-urlencoded. */
  form?: Record<string, string>;
};
export type OpenverseResponse = { status: number; retryAfter?: string; body: unknown };
export type OpenverseHttp = (req: OpenverseRequest) => Promise<OpenverseResponse>;

export type OpenverseContext = { roomId: string; memberId: string; ip: string };

/** One Openverse search's query string, so tests can check what is asked. */
export function openverseSearchUrl(q: string, pageSize: number): string {
  const params = new URLSearchParams({
    q,
    page_size: String(pageSize),
    license_type: "modification",
    // Openverse's default, kept explicit.
    mature: "false",
    extension: EXTENSIONS,
  });
  return `${API}/images/?${params}`;
}

/**
 * Keeps up to `max` results that carry an adaptable license, Openverse's own
 * thumbnail, an https original and a credit that reads as one. Text is
 * bounded and stripped of control characters, so the picker, the library
 * and the token panel can show it as it is.
 */
export function sanitizeOpenverseResults(body: unknown, max: number): SearchResult[] {
  const list = (body as { results?: unknown } | null)?.results;
  if (!Array.isArray(list)) return [];
  const out: SearchResult[] = [];
  for (const item of list) {
    if (out.length >= max) break;
    if (typeof item !== "object" || item === null) continue;
    const r = item as Record<string, unknown>;
    if (r.mature === true) continue;
    const license = typeof r.license === "string" ? r.license.toLowerCase() : "";
    if (!ADAPTABLE_LICENSES.has(license)) continue;
    if (typeof r.thumbnail !== "string" || !isOpenverseThumbnail(r.thumbnail)) continue;
    const original = webUrl(r.url, ["https:"]);
    const landing = webUrl(r.foreign_landing_url, ["https:", "http:"]);
    if (!original || !landing) continue;

    const attribution = bounded(clean(r.attribution), LIMITS.creditAttributionChars);
    if (!attribution) continue;
    const draft: ImageCredit = { license, landingUrl: landing.href, attribution };
    const title = cut(clean(r.title), 200);
    if (title) draft.title = title;
    const creator = cut(clean(r.creator), 200);
    if (creator) draft.creator = creator;
    const version = cut(clean(r.license_version), 16);
    if (version) draft.licenseVersion = version;
    const credit = imageCreditSchema.safeParse(draft);
    if (!credit.success) continue;

    const result: SearchResult = {
      thumbnail: r.thumbnail,
      original: original.href,
      title,
      source: landing.hostname.slice(0, 100),
      credit: credit.data,
    };
    const w = dimension(r.width);
    const h = dimension(r.height);
    if (w !== undefined) result.original_width = w;
    if (h !== undefined) result.original_height = h;
    out.push(result);
  }
  return out;
}

function webUrl(value: unknown, protocols: string[]): URL | undefined {
  if (typeof value !== "string" || value.length > 2048) return undefined;
  try {
    const url = new URL(value);
    if (!protocols.includes(url.protocol) || url.username !== "" || url.password !== "") return undefined;
    return url.href.length <= 2048 ? url : undefined;
  } catch {
    return undefined;
  }
}

/**
 * One line of text: control and line separator characters become spaces.
 * A lone surrogate becomes U+FFFD, since Postgres refuses one in jsonb, as
 * it refuses U+0000, which is a control character.
 */
function clean(value: unknown): string {
  return typeof value === "string" ? value.toWellFormed().replace(/[\p{Cc}\u2028\u2029]+/gu, " ").trim() : "";
}

/** At most `max` UTF-16 units, never ending inside a surrogate pair. */
function cut(text: string, max: number): string {
  const out = text.slice(0, max);
  return /[\uD800-\uDBFF]$/.test(out) ? out.slice(0, -1) : out;
}

/** At most `max` UTF-16 units, ending in an ellipsis when cut. */
function bounded(text: string, max: number): string {
  return text.length <= max ? text : `${cut(text, max - 1).trimEnd()}…`;
}

function dimension(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value > 0 && value < 1_000_000 ? value : undefined;
}

/** A token's lifetime from `expires_in` (seconds), defensive about what production sends. */
function tokenLifetimeMs(expiresIn: unknown): number {
  const seconds = typeof expiresIn === "string" ? Number(expiresIn) : expiresIn;
  if (typeof seconds !== "number" || !Number.isFinite(seconds) || seconds <= 0) return UNSTATED_TOKEN_LIFETIME_MS;
  return Math.min(seconds * 1000, MAX_TOKEN_LIFETIME_MS);
}

/** Seconds from a Retry-After header that gives seconds, within an hour. */
function retryAfterSeconds(header: string | undefined): number | undefined {
  if (header === undefined || !/^\d{1,6}$/.test(header.trim())) return undefined;
  const seconds = Number(header.trim());
  return seconds >= 1 ? Math.min(seconds, 3600) : undefined;
}

function failed(why: string): AssetError {
  return new AssetError(502, "search_failed", { cause: new Error(why) });
}

export class OpenverseSearch {
  #pool: pg.Pool;
  #http: OpenverseHttp;
  #now: () => number;
  #credentials: { id: string; secret: string } | undefined;
  #minute: WindowLimiter;
  #token: { value: string; refreshAt: number } | undefined;
  #tokenLoading: Promise<string> | undefined;
  #busyUntil = 0;
  #inFlight = new Map<string, Promise<SearchResult[]>>();
  #lastCleanup = 0;

  constructor(opts: { pool: pg.Pool; http: OpenverseHttp; clientId?: string; clientSecret?: string; now?: () => number }) {
    this.#pool = opts.pool;
    this.#http = opts.http;
    this.#now = opts.now ?? Date.now;
    this.#credentials = opts.clientId && opts.clientSecret ? { id: opts.clientId, secret: opts.clientSecret } : undefined;
    this.#minute = new WindowLimiter(60_000, this.#now);
  }

  get registered(): boolean {
    return this.#credentials !== undefined;
  }

  get pageSize(): number {
    return this.registered ? LIMITS.openverseRegisteredPageSize : LIMITS.openverseAnonPageSize;
  }

  async search(rawQuery: string, ctx: OpenverseContext): Promise<SearchResult[]> {
    const q = normalizeQuery(rawQuery);
    if (q.length === 0 || q.length > MAX_QUERY_LENGTH) throw new AssetError(400, "bad_query");
    const key = CACHE_PREFIX + q;

    const cached = await this.#cached(key);
    if (cached) return cached;
    // As with SerpApi: the same new words at once share one search and one
    // charge, the first asker's. If that one is refused for a budget that is
    // not this caller's, this caller runs its own.
    const pending = this.#inFlight.get(key);
    if (pending) {
      const shared = await pending.catch(() => undefined);
      if (shared) return shared;
    }
    const run: Promise<SearchResult[]> = this.#searchUncached(q, key, ctx).finally(() => {
      if (this.#inFlight.get(key) === run) this.#inFlight.delete(key);
    });
    this.#inFlight.set(key, run);
    return run;
  }

  async #searchUncached(q: string, key: string, ctx: OpenverseContext): Promise<SearchResult[]> {
    const busy = this.#busyUntil - this.#now();
    if (busy > 0) throw new AssetError(429, "quota_global", { retryAfter: Math.ceil(busy / 1000) });
    const { personal, site } = await this.#reserveUsage(ctx);
    let refund = [...personal, site];
    try {
      const perMinute = [{ key: "site", limit: this.registered ? LIMITS.openverseRegisteredPerMinute : LIMITS.openverseAnonPerMinute }];
      const wait = this.#minute.retryAfter(perMinute);
      if (wait > 0) throw new AssetError(429, "quota_global", { retryAfter: wait });
      this.#minute.record(perMinute);
      // From here Openverse may count the search, so the server's day keeps
      // it whatever happens. The member, room and address get theirs back
      // when nothing usable came of it.
      refund = personal;
      const results = await this.#call(q);
      await this.#store(key, results);
      return results;
    } catch (err) {
      await this.#pool
        .query(`update search_usage set count = greatest(count - 1, 0) where bucket = any($1)`, [refund])
        .catch(() => undefined);
      throw err;
    }
  }

  async #cached(key: string): Promise<SearchResult[] | null> {
    const { rows } = await this.#pool.query<{ results: unknown }>(
      `select results from search_cache where q = $1 and fetched_at > now() - make_interval(days => $2)`,
      [key, CACHE_DAYS],
    );
    const results = rows[0]?.results;
    if (!Array.isArray(results)) return null;
    // SerpApi caches under the bare query, so a Google search for the words
    // "openverse:goblin" writes this row. Only rows that read as Openverse's
    // count, and anything else is searched again and overwritten.
    const own = results.every(
      (r: Partial<SearchResult> | null) => typeof r?.thumbnail === "string" && isOpenverseThumbnail(r.thumbnail) && imageCreditSchema.safeParse(r.credit).success,
    );
    return own ? (results as SearchResult[]) : null;
  }

  /**
   * Reserves the member's, the room's and the address's day and the
   * server's day in one transaction, each a conditional increment, so
   * concurrent searches cannot both take the last one.
   */
  async #reserveUsage(ctx: OpenverseContext): Promise<{ personal: string[]; site: string }> {
    const now = this.#now();
    const day = new Date(now).toISOString().slice(0, 10);
    const site = `ov:site:${day}`;
    const checks: Array<[bucket: string, limit: number, code: ApiErrorCode]> = [
      [`ov:m:${ctx.roomId}:${ctx.memberId}:${day}`, LIMITS.openverseMemberPerDay, "quota_member"],
      [`ov:r:${ctx.roomId}:${day}`, LIMITS.openverseRoomPerDay, "quota_room"],
      [`ov:ip:${ctx.ip}:${day}`, LIMITS.openverseIpPerDay, "quota_ip"],
      [site, this.registered ? LIMITS.openverseRegisteredPerDay : LIMITS.openverseAnonPerDay, "quota_global"],
    ];
    const client = await this.#pool.connect();
    try {
      await client.query("begin");
      for (const [bucket, limit, code] of checks) {
        const { rowCount } = await client.query(
          `insert into search_usage (bucket, count) values ($1, 1)
           on conflict (bucket) do update set count = search_usage.count + 1 where search_usage.count < $2
           returning count`,
          [bucket, limit],
        );
        if (!rowCount) {
          await client.query("rollback");
          // The server's day is spent until midnight UTC, when the buckets turn over.
          const retryAfter = code === "quota_global" ? Math.ceil((Date.parse(`${day}T00:00:00Z`) + 86_400_000 - now) / 1000) : undefined;
          throw new AssetError(429, code, { retryAfter });
        }
      }
      await client.query("commit");
      return { personal: checks.slice(0, 3).map(([bucket]) => bucket), site };
    } catch (err) {
      if (!(err instanceof AssetError)) await client.query("rollback").catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }

  async #call(q: string): Promise<SearchResult[]> {
    let token = this.#credentials ? await this.#accessToken() : undefined;
    let res = await this.#get(q, token);
    if (res.status === 401 && token !== undefined) {
      // The token ended sooner than its answer said, or was revoked.
      if (this.#token?.value === token) this.#token = undefined;
      token = await this.#accessToken();
      res = await this.#get(q, token);
    }
    if (res.status === 429) {
      const seconds = retryAfterSeconds(res.retryAfter) ?? BUSY_MS / 1000;
      this.#busyUntil = this.#now() + seconds * 1000;
      throw new AssetError(429, "quota_global", { retryAfter: seconds });
    }
    if (res.status !== 200) throw failed(`Openverse answered a search with ${res.status}`);
    return sanitizeOpenverseResults(res.body, this.pageSize);
  }

  async #get(q: string, token: string | undefined): Promise<OpenverseResponse> {
    try {
      return await this.#http({ url: openverseSearchUrl(q, this.pageSize), headers: token ? { authorization: `Bearer ${token}` } : {} });
    } catch {
      // The transport's own error is not passed on: it may quote the request.
      throw failed("Openverse could not be reached");
    }
  }

  async #accessToken(): Promise<string> {
    const held = this.#token;
    if (held && this.#now() < held.refreshAt) return held.value;
    this.#tokenLoading ??= this.#fetchToken().finally(() => {
      this.#tokenLoading = undefined;
    });
    return this.#tokenLoading;
  }

  async #fetchToken(): Promise<string> {
    const credentials = this.#credentials!;
    let res: OpenverseResponse;
    try {
      res = await this.#http({
        url: `${API}/auth_tokens/token/`,
        method: "POST",
        form: { grant_type: "client_credentials", client_id: credentials.id, client_secret: credentials.secret },
      });
    } catch {
      throw failed("Openverse's token request could not be sent");
    }
    const body = res.body as { access_token?: unknown; expires_in?: unknown } | null;
    const token = body?.access_token;
    // Printable ASCII only, since it goes into a header.
    if (res.status !== 200 || typeof token !== "string" || !/^[\x21-\x7e]{1,4096}$/.test(token)) {
      throw failed(`Openverse answered the token request with ${res.status}`);
    }
    const lifetime = tokenLifetimeMs(body?.expires_in);
    // Kept until 5 minutes before it ends, or half its life when that is shorter.
    this.#token = { value: token, refreshAt: this.#now() + Math.max(lifetime - TOKEN_MARGIN_MS, lifetime / 2) };
    return token;
  }

  async #store(key: string, results: SearchResult[]): Promise<void> {
    await this.#pool.query(
      `insert into search_cache (q, results, fetched_at) values ($1, $2, now())
       on conflict (q) do update set results = excluded.results, fetched_at = excluded.fetched_at`,
      [key, JSON.stringify(results)],
    );
    await this.#cleanup();
  }

  /**
   * At most hourly: drop expired cache rows and Openverse's buckets from past
   * days. SerpApi's own cleanup does the same for its buckets, and a server
   * without a SerpApi key has only this one.
   */
  async #cleanup(): Promise<void> {
    const now = this.#now();
    if (now - this.#lastCleanup < 3600_000) return;
    this.#lastCleanup = now;
    await this.#pool.query(`delete from search_cache where fetched_at < now() - make_interval(days => $1)`, [CACHE_DAYS]);
    await this.#pool.query(`delete from search_usage where bucket like 'ov:%' and right(bucket, 10) <> $1`, [
      new Date(now).toISOString().slice(0, 10),
    ]);
  }
}

/**
 * The credit of an image the import just fetched, or undefined when it came
 * from no Openverse result cached in the last 7 days. It is always the
 * cached result's, never anything a client sent, with the width and height
 * of the image as fetched (upright, as the pipeline turns it), so the credit
 * can say "Resized" only when the stored size differs.
 */
export async function creditForImport(
  pool: pg.Pool,
  fetched: { original: string } | { thumbnail: string },
  path: string,
): Promise<AssetCredit | undefined> {
  const { rows } = await pool.query<{ results: unknown }>(
    `select results from search_cache
     where q like 'openverse:%' and fetched_at > now() - make_interval(days => $1) and results @> $2::jsonb
     order by fetched_at desc limit 5`,
    [CACHE_DAYS, JSON.stringify([fetched])],
  );
  let credit: ImageCredit | undefined;
  for (const row of rows) {
    if (!Array.isArray(row.results)) continue;
    for (const r of row.results as Array<Record<string, unknown> | null>) {
      const same = "original" in fetched ? r?.original === fetched.original : r?.thumbnail === fetched.thumbnail;
      const parsed = same ? imageCreditSchema.safeParse(r?.credit) : undefined;
      if (parsed?.success) {
        credit = parsed.data;
        break;
      }
    }
    if (credit) break;
  }
  if (!credit) return undefined;
  const size = await originalSize(path);
  const full = assetCreditSchema.safeParse({ ...credit, originalWidth: size.width, originalHeight: size.height });
  return full.success ? full.data : undefined;
}

/** The fetched file's size, read from its header only, turned upright as `autoOrient()` turns it. */
async function originalSize(path: string): Promise<{ width: number; height: number }> {
  configureSharp();
  const meta = await sharp(path)
    .metadata()
    .catch((err: unknown) => {
      throw new AssetError(422, "bad_image", { cause: err });
    });
  const width = meta.autoOrient?.width ?? meta.width;
  const height = meta.autoOrient?.height ?? meta.height;
  if (!width || !height) throw new AssetError(422, "bad_image");
  return { width, height };
}

/**
 * Openverse's transport: GET or a form POST through `dispatcher`, with a
 * time limit and a 2 MiB cap. The request carries no credential but the
 * ones a caller puts in it.
 */
export function openverseHttp(dispatcher: Dispatcher, timeoutMs = TIMEOUT_MS): OpenverseHttp {
  return async ({ url, method = "GET", headers = {}, form }) => {
    const res = await request(url, {
      dispatcher,
      method,
      headers: {
        accept: "application/json",
        "accept-encoding": "identity",
        "user-agent": "raccoon-vtt (self-hosted virtual tabletop)",
        ...(form ? { "content-type": "application/x-www-form-urlencoded" } : {}),
        ...headers,
      },
      body: form ? new URLSearchParams(form).toString() : undefined,
      signal: AbortSignal.timeout(timeoutMs),
      headersTimeout: timeoutMs,
      bodyTimeout: timeoutMs,
    });
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of res.body) {
      size += (chunk as Buffer).length;
      if (size > 2 * 1024 * 1024) {
        res.body.destroy();
        throw new Error("response too large");
      }
      chunks.push(chunk as Buffer);
    }
    let body: unknown = null;
    try {
      body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } catch {
      body = null;
    }
    const retryAfter = res.headers["retry-after"];
    return { status: res.statusCode, retryAfter: typeof retryAfter === "string" ? retryAfter : undefined, body };
  };
}
