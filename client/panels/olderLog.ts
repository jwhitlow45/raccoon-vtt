import { api, ApiError, type LogPage } from "../lib/api.ts";
import type { Direction, PageAsk } from "./historyWindow.ts";

/** What a page that could not be taken says, as any page that failed to load does. */
export const OLDER_LOG_FAILED = "Could not load older messages.";
export const NEWER_LOG_FAILED = "Could not load newer messages.";

/** The longest Retry-After a busy page waits out before its one retry. */
const MAX_BUSY_WAIT_MS = 5_000;

function wait(ms: number, signal?: AbortSignal): Promise<void> {
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

export type PageOptions = { signal?: AbortSignal; sleep?: (ms: number, signal?: AbortSignal) => Promise<void> };

/**
 * One page of the Log panel's history: older than `before`, newer than
 * `after`, or the newest with neither. A DM's pages follow the scene on
 * screen (`sceneId`). In "view as a player" (`previewOf`,
 * docs/design-v1-per-player-vision.md 7.4, D-261026-10) the page is asked
 * for as that player and taken only when the server says it answered as
 * that player, as the preview's socket takes only that player's snapshot:
 * a page without the answer, or answered as anyone else, is refused, so a
 * server that ignores `as` never shows the DM's own lines, whispers and
 * hidden rolls as the player's.
 *
 * The server reads one page per room at a time from its raw archive, so a
 * second member's page can find it busy for a moment (429 busy). That page
 * waits out the Retry-After once and asks again before it fails
 * (docs/design-v1-log-history.md 2.3, LOG-OPUS-19).
 */
export async function logPage(roomId: string, ask: PageAsk, viewer: { sceneId: string | null; previewOf: string | null }, options: PageOptions = {}): Promise<LogPage> {
  const once = () => api.getLog(roomId, { ...ask, sceneId: viewer.sceneId, ...(viewer.previewOf !== null ? { as: viewer.previewOf } : {}) }, options.signal);
  let page: LogPage;
  try {
    page = await once();
  } catch (err) {
    if (!(err instanceof ApiError && err.status === 429 && err.code === "busy")) throw err;
    await (options.sleep ?? wait)(Math.min(err.retryAfterMs ?? 1000, MAX_BUSY_WAIT_MS), options.signal);
    page = await once();
  }
  if (viewer.previewOf !== null && page.as !== viewer.previewOf) throw new Error(ask.after !== undefined ? NEWER_LOG_FAILED : OLDER_LOG_FAILED);
  return page;
}

/** What a failed page says: which way it failed, and the server's reason when it gave one worth reading. */
export function pageErrorText(dir: Direction, err: unknown): string {
  const base = dir === "older" ? OLDER_LOG_FAILED : NEWER_LOG_FAILED;
  if (!(err instanceof ApiError) || err.code === "busy") return base;
  if (err.code === "network" || err.status === 0) return `${base} Check your connection.`;
  return `${base} ${err.message}`;
}
