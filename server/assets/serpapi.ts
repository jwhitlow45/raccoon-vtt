import type pg from "pg";
import { request, type Dispatcher } from "undici";
import type { ApiErrorCode } from "#shared/apiErrors.ts";
import type { SearchResult } from "#shared/protocol.ts";
import { untilAborted } from "./egress.ts";
import { AssetError } from "./errors.ts";
import { isThumbnailUrl } from "#shared/searchThumbnails.ts";

/**
 * Image search through SerpApi's Google Images engine (design section 11.3).
 *
 * The free plan allows 250 searches a month and 50 an hour, and nothing
 * stops a public site from spending them all, so every search that reaches
 * SerpApi is reserved against three budgets first: SerpApi's own count of
 * what is left (global), the room's month, and the client IP's day. Results
 * are cached by normalized query for 7 days, so a repeated search is free.
 *
 * The API key travels only in the request to serpapi.com, through the strict
 * egress port. It is never logged, never cached, and never in a response.
 * The Account API answer even echoes the key back, which is why only two
 * numbers are ever read from it.
 */

export type HttpJson = (url: string) => Promise<{ status: number; body: unknown }>;

export const MAX_RESULTS = 40;
export const MAX_QUERY_LENGTH = 100;
const CACHE_DAYS = 7;
const ACCOUNT_TTL_MS = 60_000;
const MIN_SEARCHES_LEFT = 10;
const MAX_THIS_HOUR = 45;
const ROOM_PER_MONTH = 60;
const YOUNG_ROOM_PER_MONTH = 5;
const IP_PER_DAY = 15;

/** The cache key, and also what is sent, so the cache always matches what was asked. */
export function normalizeQuery(q: string): string {
  return q.trim().toLowerCase();
}

/**
 * Keeps up to 40 results with the six fields the picker uses. A thumbnail
 * must be on a thumbnail host (shared/searchThumbnails.ts), because those are
 * the only third-party image hosts the SPA's CSP allows and the only ones the
 * import's thumbnail fallback accepts.
 */
export function sanitizeResults(body: unknown): SearchResult[] {
  const list = (body as { images_results?: unknown } | null)?.images_results;
  if (!Array.isArray(list)) return [];
  const out: SearchResult[] = [];
  for (const item of list) {
    if (out.length >= MAX_RESULTS) break;
    if (typeof item !== "object" || item === null) continue;
    const r = item as Record<string, unknown>;
    const thumbnail = httpsUrl(r.thumbnail);
    const original = httpsUrl(r.original) ?? httpUrl(r.original);
    if (!thumbnail || !isThumbnailUrl(thumbnail) || !original) continue;
    const result: SearchResult = {
      thumbnail,
      original,
      title: text(r.title, 200),
      source: text(r.source, 100),
    };
    const w = dimension(r.original_width);
    const h = dimension(r.original_height);
    if (w !== undefined) result.original_width = w;
    if (h !== undefined) result.original_height = h;
    out.push(result);
  }
  return out;
}

function httpsUrl(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length > 2048) return undefined;
  try {
    const url = new URL(value);
    return url.protocol === "https:" ? url.href : undefined;
  } catch {
    return undefined;
  }
}

/** Originals on plain http are kept: the import refuses them and falls back to the thumbnail. */
function httpUrl(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length > 2048) return undefined;
  try {
    const url = new URL(value);
    return url.protocol === "http:" ? url.href : undefined;
  } catch {
    return undefined;
  }
}

function text(value: unknown, max: number): string {
  return typeof value === "string" ? value.slice(0, max) : "";
}

function dimension(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value > 0 && value < 1_000_000 ? value : undefined;
}

/**
 * SerpApi's own count of searches left, read from the Account API (which
 * costs no search), cached for a minute and decremented locally for each
 * search in between. SerpApi counts on its own cycle, so its numbers are the
 * only reliable global budget. When the account cannot be read, search is
 * refused: an unknown budget is treated as spent.
 */
export class SerpApiAccount {
  #http: HttpJson;
  #apiKey: string;
  #now: () => number;
  #state: { left: number; thisHour: number; at: number } | undefined;
  #loading: Promise<{ left: number; thisHour: number; at: number }> | undefined;

  constructor(apiKey: string, http: HttpJson, now: () => number = Date.now) {
    this.#apiKey = apiKey;
    this.#http = http;
    this.#now = now;
  }

  /** Spends one search from the global budget, or returns false when it is too low. */
  async reserve(): Promise<boolean> {
    const state = await this.#current();
    if (state.left < MIN_SEARCHES_LEFT || state.thisHour >= MAX_THIS_HOUR) return false;
    state.left--;
    state.thisHour++;
    return true;
  }

  async #current(): Promise<{ left: number; thisHour: number; at: number }> {
    if (this.#state && this.#now() - this.#state.at < ACCOUNT_TTL_MS) return this.#state;
    this.#loading ??= this.#load().finally(() => {
      this.#loading = undefined;
    });
    return this.#loading;
  }

  async #load(): Promise<{ left: number; thisHour: number; at: number }> {
    const url = `https://serpapi.com/account.json?${new URLSearchParams({ api_key: this.#apiKey })}`;
    let res: { status: number; body: unknown };
    try {
      res = await this.#http(url);
    } catch {
      throw new AssetError(502, "search_failed");
    }
    const body = res.body as { plan_searches_left?: unknown; this_hour_searches?: unknown } | null;
    const left = body?.plan_searches_left;
    const thisHour = body?.this_hour_searches;
    if (res.status !== 200 || typeof left !== "number" || typeof thisHour !== "number") {
      throw new AssetError(502, "search_failed");
    }
    this.#state = { left, thisHour, at: this.#now() };
    return this.#state;
  }
}

export type SearchContext = { roomId: string; roomCreatedAt: Date; ip: string };

export class ImageSearch {
  #pool: pg.Pool;
  #http: HttpJson;
  #apiKey: string;
  #account: SerpApiAccount;
  #now: () => number;
  #inFlight = new Map<string, Promise<SearchResult[]>>();
  #lastCleanup = 0;

  constructor(opts: { pool: pg.Pool; apiKey: string; http: HttpJson; now?: () => number }) {
    this.#pool = opts.pool;
    this.#apiKey = opts.apiKey;
    this.#http = opts.http;
    this.#now = opts.now ?? Date.now;
    this.#account = new SerpApiAccount(opts.apiKey, opts.http, this.#now);
  }

  async search(rawQuery: string, ctx: SearchContext): Promise<SearchResult[]> {
    const q = normalizeQuery(rawQuery);
    if (q.length === 0 || q.length > MAX_QUERY_LENGTH) throw new AssetError(400, "bad_query");

    const cached = await this.#cached(q);
    if (cached) return cached;
    // Two people searching the same new words at once share one search and
    // one charge, which goes to whoever asked first. If that search is
    // refused (the first asker's room or IP budget is not this caller's),
    // this caller runs its own.
    const pending = this.#inFlight.get(q);
    if (pending) {
      const shared = await pending.catch(() => undefined);
      if (shared) return shared;
    }
    const run: Promise<SearchResult[]> = this.#searchUncached(q, ctx).finally(() => {
      if (this.#inFlight.get(q) === run) this.#inFlight.delete(q);
    });
    this.#inFlight.set(q, run);
    return run;
  }

  async #searchUncached(q: string, ctx: SearchContext): Promise<SearchResult[]> {
    const buckets = await this.#reserveUsage(ctx);
    try {
      if (!(await this.#account.reserve())) throw new AssetError(429, "quota_global");
      const results = await this.#callSerpApi(q);
      await this.#store(q, results);
      return results;
    } catch (err) {
      // The room and IP get their search back when nothing usable came of
      // it. The global count is not refunded locally: SerpApi may have
      // counted the call, and the next account read a minute later corrects
      // the local count either way.
      await this.#pool
        .query(`update search_usage set count = greatest(count - 1, 0) where bucket = any($1)`, [buckets])
        .catch(() => undefined);
      throw err;
    }
  }

  async #cached(q: string): Promise<SearchResult[] | null> {
    const { rows } = await this.#pool.query<{ results: SearchResult[] }>(
      `select results from search_cache where q = $1 and fetched_at > now() - make_interval(days => $2)`,
      [q, CACHE_DAYS],
    );
    return rows[0]?.results ?? null;
  }

  /**
   * Reserves the room's monthly and the IP's daily count in one transaction,
   * each with a conditional increment, so concurrent searches cannot both
   * take the last one.
   */
  async #reserveUsage(ctx: SearchContext): Promise<string[]> {
    const now = new Date(this.#now());
    const month = now.toISOString().slice(0, 7);
    const day = now.toISOString().slice(0, 10);
    const young = now.getTime() - ctx.roomCreatedAt.getTime() < 24 * 3600_000;
    const checks: Array<[bucket: string, limit: number, code: ApiErrorCode]> = [
      [`r:${ctx.roomId}:${month}`, young ? YOUNG_ROOM_PER_MONTH : ROOM_PER_MONTH, "quota_room"],
      [`ip:${ctx.ip}:${day}`, IP_PER_DAY, "quota_ip"],
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
          throw new AssetError(429, code);
        }
      }
      await client.query("commit");
      return checks.map(([bucket]) => bucket);
    } catch (err) {
      if (!(err instanceof AssetError)) await client.query("rollback").catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }

  async #callSerpApi(q: string): Promise<SearchResult[]> {
    const params = new URLSearchParams({ engine: "google_images", safe: "active", q, api_key: this.#apiKey });
    let res: { status: number; body: unknown };
    try {
      res = await this.#http(`https://serpapi.com/search.json?${params}`);
    } catch {
      throw new AssetError(502, "search_failed");
    }
    const error = (res.body as { error?: unknown } | null)?.error;
    if (typeof error === "string") {
      // SerpApi reports an empty result page as an error. It is an answer,
      // and caching it keeps a typo from costing a search every time.
      if (/hasn't returned any results/i.test(error)) return [];
      throw new AssetError(502, "search_failed");
    }
    if (res.status !== 200) throw new AssetError(502, "search_failed");
    return sanitizeResults(res.body);
  }

  async #store(q: string, results: SearchResult[]): Promise<void> {
    await this.#pool.query(
      `insert into search_cache (q, results, fetched_at) values ($1, $2, now())
       on conflict (q) do update set results = excluded.results, fetched_at = excluded.fetched_at`,
      [q, JSON.stringify(results)],
    );
    await this.#cleanup();
  }

  /** At most hourly: drop expired cache rows and usage buckets from past days and months. */
  async #cleanup(): Promise<void> {
    const now = this.#now();
    if (now - this.#lastCleanup < 3600_000) return;
    this.#lastCleanup = now;
    const iso = new Date(now).toISOString();
    await this.#pool.query(`delete from search_cache where fetched_at < now() - make_interval(days => $1)`, [CACHE_DAYS]);
    await this.#pool.query(
      `delete from search_usage
       where (bucket like 'r:%' and right(bucket, 7) <> $1) or (bucket like 'ip:%' and right(bucket, 10) <> $2)`,
      [iso.slice(0, 7), iso.slice(0, 10)],
    );
  }
}

/**
 * True when `url` is the thumbnail of a result cached in the last 7 days.
 * The import fallback may only fetch a thumbnail a search handed out, so a
 * client cannot point it anywhere else (a serpapi.com one goes through the
 * strict egress port, a Google one through the public port).
 */
export async function isCachedThumbnail(pool: pg.Pool, url: string): Promise<boolean> {
  const { rowCount } = await pool.query(
    `select 1 from search_cache where fetched_at > now() - make_interval(days => $1) and results @> $2::jsonb limit 1`,
    [CACHE_DAYS, JSON.stringify([{ thumbnail: url }])],
  );
  return Boolean(rowCount);
}

/**
 * GETs JSON through `dispatcher` with a time limit and a 2 MiB cap. The limit
 * is 30 s because Google Images through SerpApi has answered in 19 s in
 * production, and 15 s failed searches that would have succeeded.
 */
export function httpJson(dispatcher: Dispatcher, timeoutMs = 30_000): HttpJson {
  return async (url) => {
    const signal = AbortSignal.timeout(timeoutMs);
    const pending = request(url, {
      dispatcher,
      method: "GET",
      headers: { accept: "application/json", "accept-encoding": "identity" },
      signal,
      headersTimeout: timeoutMs,
      bodyTimeout: timeoutMs,
    });
    const res = await untilAborted(pending, signal, (late) => late.body.destroy());
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
    return { status: res.statusCode, body };
  };
}
