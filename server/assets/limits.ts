import type { AssetKind } from "./kinds.ts";

/**
 * Sliding-window counters for the hourly upload and import limits (design
 * section 10.3): 30 per session, 60 per IP and 120 per room, and for scene
 * thumbnails and handouts budgets of their own (hourlyChecks below).
 *
 * These live in memory rather than in rate_events. A restart forgets them,
 * which costs nothing here: the window is one hour, a deploy is rare, and
 * nobody outside can cause a restart. Each key keeps at most `limit`
 * timestamps, and empty keys are dropped on a sweep, so memory stays bounded
 * by the number of keys active in the last hour.
 */
export class WindowLimiter {
  readonly windowMs: number;
  #events = new Map<string, number[]>();
  #now: () => number;
  #lastSweep = 0;

  constructor(windowMs: number, now: () => number = Date.now) {
    this.windowMs = windowMs;
    this.#now = now;
  }

  /**
   * Seconds until every key has room for one more event, or 0 when all do.
   * Checking is separate from recording, so a request that is turned away
   * later (no free slot, say) does not spend the caller's budget.
   */
  retryAfter(checks: ReadonlyArray<{ key: string; limit: number }>): number {
    const now = this.#now();
    this.#sweep(now);
    let wait = 0;
    for (const { key, limit } of checks) {
      const times = this.#live(key, now);
      if (times.length >= limit) {
        const oldest = times[times.length - limit]!;
        wait = Math.max(wait, Math.ceil((oldest + this.windowMs - now) / 1000));
      }
    }
    return wait;
  }

  record(checks: ReadonlyArray<{ key: string; limit: number }>): void {
    const now = this.#now();
    for (const { key, limit } of checks) {
      const times = this.#live(key, now);
      times.push(now);
      if (times.length > limit) times.splice(0, times.length - limit);
      this.#events.set(key, times);
    }
  }

  #live(key: string, now: number): number[] {
    const times = this.#events.get(key);
    if (!times) return [];
    const cutoff = now - this.windowMs;
    let drop = 0;
    while (drop < times.length && times[drop]! <= cutoff) drop++;
    if (drop > 0) times.splice(0, drop);
    return times;
  }

  #sweep(now: number): void {
    if (now - this.#lastSweep < 60_000) return;
    this.#lastSweep = now;
    for (const key of [...this.#events.keys()]) {
      if (this.#live(key, now).length === 0) this.#events.delete(key);
    }
  }
}

const HOURLY = { session: 30, ip: 60, room: 120 } as const;

/**
 * Scene thumbnails have a budget of their own. A DM device draws and
 * uploads one by itself each time the DM leaves a scene it changed
 * (docs/design-v1-maps-vision.md 3.3), so a long prep session makes many,
 * and spending the 30 uploads above on them refused the DM's own maps. A
 * thumbnail is DM only and at most 512 KiB, and every one still counts
 * against the room's storage quota, so a generous hourly count is enough.
 */
const THUMB_HOURLY = { session: 240, room: 240 } as const;

/**
 * So do handouts, each page of a PDF being one upload
 * (docs/design-v1-pdf-handouts.md 3.7): on the shared budget a 30-page PDF
 * spent the DM's whole hour and refused the next map. Two documents at the
 * page cap fit in an hour. A handout is DM only, and every page still
 * counts against the room's storage quota.
 */
export const HANDOUT_HOURLY = { session: 250, room: 250 } as const;

/**
 * Starter picks (docs/design-v1-starter-art.md 5) have a budget of their
 * own too. A pick runs the image pipeline as an upload does, which is the
 * cost this guards, but it never grows the room's storage, and a DM trying
 * works while preparing picks more often than they upload. A DM's pick of
 * a work the room already holds as that kind makes no new image and spends
 * nothing (the pick route checks). A player's spends one either way, so a
 * spent budget never tells a held work from a fresh one. Per IP and per
 * room as well as per
 * session, since a player may pick a portrait and anyone with the
 * password can mint new sessions.
 */
export const STARTER_HOURLY = { session: 60, ip: 120, room: 240 } as const;

/** The hourly budgets a starter pick spends, whatever its kind. */
export function starterHourlyChecks(sessionId: string, ip: string, roomId: string): Array<{ key: string; limit: number }> {
  return [
    { key: `starter:s:${sessionId}`, limit: STARTER_HOURLY.session },
    { key: `starter:ip:${ip}`, limit: STARTER_HOURLY.ip },
    { key: `starter:r:${roomId}`, limit: STARTER_HOURLY.room },
  ];
}

/**
 * The hourly budgets an upload of `kind` spends, by key. Uploads and URL
 * imports share one (design section 10.3): 30 per session, 60 per IP, 120
 * per room. Per IP and per room are there because anyone with the password
 * can mint new sessions. A thumbnail or a handout spends only its own, per
 * session and per room: only a DM may upload one, and a DM session needs
 * the DM link. A URL import passes no kind, so it always spends the shared
 * budget and the larger ones never pay for outbound fetches.
 */
export function hourlyChecks(sessionId: string, ip: string, roomId: string, kind?: AssetKind): Array<{ key: string; limit: number }> {
  if (kind === "thumb") {
    return [
      { key: `thumb:s:${sessionId}`, limit: THUMB_HOURLY.session },
      { key: `thumb:r:${roomId}`, limit: THUMB_HOURLY.room },
    ];
  }
  if (kind === "handout") {
    return [
      { key: `handout:s:${sessionId}`, limit: HANDOUT_HOURLY.session },
      { key: `handout:r:${roomId}`, limit: HANDOUT_HOURLY.room },
    ];
  }
  return [
    { key: `s:${sessionId}`, limit: HOURLY.session },
    { key: `ip:${ip}`, limit: HOURLY.ip },
    { key: `r:${roomId}`, limit: HOURLY.room },
  ];
}
