import { LIMITS } from "#shared/limits.ts";
import { ApiError, type ApiErrorCodeOrNetwork } from "../../lib/api.ts";

/**
 * Plain words for the asset routes' refusals (server/http/assets.ts and
 * search.ts answer `{error: code}`). When a search quota runs out, the
 * picker says which one and points at the ways that still work (design
 * section 11.3).
 *
 * Image search falls back to Openverse whenever Google cannot answer
 * (docs/design-v1-dm-tools.md 3.13), so every quota a search can still run
 * out of is one of Openverse's, and each is counted per day.
 */

const OTHER_WAYS = "You can still pick an icon, upload, paste or use an image link.";

/** A refusal that clears within this is Openverse's per-minute budget, worth waiting out. Longer is the day's. */
const SHORT_WAIT_MS = 2 * 60_000;

const MESSAGES: Partial<Record<ApiErrorCodeOrNetwork, string>> = {
  quota_member: `You have used your ${LIMITS.openverseMemberPerDay} image searches in this room for today. ${OTHER_WAYS}`,
  quota_room: `This room has used its image searches for today. ${OTHER_WAYS}`,
  quota_ip: `Too many image searches from this network today. ${OTHER_WAYS}`,
  quota_global: `The server's image searches are used up for today. ${OTHER_WAYS}`,
  search_failed: "The image search did not answer. Try again in a moment.",
  bad_query: "Type what to search for.",
  too_large: "That image is too large. Token images can be up to 10 MB.",
  unsupported_type: "That file type is not supported. Use a JPEG, PNG, WebP, GIF or AVIF image.",
  bad_image: "That file could not be read as an image.",
  quota_exceeded: "This room is out of storage space. The DM can free some up.",
  storage_full: "The server is out of storage space. Try again later.",
  rate_limited: "Too many images in a short time. Wait a little and try again.",
  read_only: "This room is read-only right now.",
  bad_url: "That link cannot be imported. Use a public https:// link to an image.",
  fetch_failed: "That link did not give an image the server could fetch. Try downloading the image and uploading it.",
  bad_fallback: "That search result has expired. Search again.",
  too_slow: "The upload was too slow and was stopped. Try again on a better connection.",
  upload_aborted: "The upload was interrupted. Try again.",
  busy: "The server is busy. Try again in a minute.",
  forbidden: "You do not have access to that.",
  asset_in_use: "That image is in use again, so it was kept.",
  state_unknown: "The room's images can't be checked right now.",
};

export function imageErrorMessage(err: unknown): string {
  if (err instanceof ApiError) {
    if (isShortWait(err)) return "Openverse is busy. Try again in a minute.";
    if (err.code && MESSAGES[err.code]) return MESSAGES[err.code]!;
    return err.message;
  }
  if (err instanceof DOMException && err.name === "AbortError") return "Cancelled.";
  return "Something went wrong with that image.";
}

/** Search quota refusals, after which the picker steers to the other tabs. */
export function isQuotaError(err: unknown): boolean {
  return (
    err instanceof ApiError &&
    (err.code === "quota_member" || err.code === "quota_room" || err.code === "quota_ip" || err.code === "quota_global")
  );
}

/** A refusal for Openverse's per-minute budget or its own 429, which a minute's wait clears. */
export function isShortWait(err: unknown): boolean {
  return err instanceof ApiError && err.code === "quota_global" && err.retryAfterMs !== null && err.retryAfterMs <= SHORT_WAIT_MS;
}
