import type { PcFill } from "#shared/rules/pcFill.ts";
import { checkedFill } from "#shared/rules/pcFill.ts";
import { ApiError, api } from "../../lib/api.ts";

/**
 * The D&D Beyond step's requests and words (docs/design-v1-pc-stats.md 6.3
 * and Appendix D): a share link fetched by the server, or the character's
 * JSON pasted and read on this device by the same reader, in a chunk of its
 * own that loads only then. Each refusal ends with the way out.
 */

export const DDB_WORDS = {
  private: "D&D Beyond would not share that character. Set its privacy to Public in D&D Beyond, then try again, or paste its JSON.",
  notFound: "D&D Beyond has no character with that number.",
  failed: "D&D Beyond did not answer. Try again later, or paste the character's JSON.",
  unreadable: "That did not read as a D&D Beyond character. Its format may have changed. Paste its JSON or type the numbers.",
  busy: "Another import is running. Try again in a moment, or paste the character's JSON.",
  tooBig: "That is more than 5 MiB. Copy the character's JSON alone and paste it again.",
} as const;

/** "Too many imports this hour. Try again in 12 minutes, or paste the character's JSON.", the minutes from the answer's Retry-After. */
export function quotaWords(retryAfterMs: number | null): string {
  const minutes = Math.max(1, Math.ceil((retryAfterMs ?? 60_000) / 60_000));
  return `Too many imports this hour. Try again in ${minutes} ${minutes === 1 ? "minute" : "minutes"}, or paste the character's JSON.`;
}

/** A failed Get it in the step's words. No answer at all, the device's own time limit included, reads as D&D Beyond not answering. */
export function importErrorText(err: unknown): string {
  if (!(err instanceof ApiError)) return DDB_WORDS.failed;
  switch (err.code) {
    case "private":
      return DDB_WORDS.private;
    case "not_found":
      return DDB_WORDS.notFound;
    case "unreadable":
      return DDB_WORDS.unreadable;
    case "busy":
      return DDB_WORDS.busy;
    case "quota_member":
    case "quota_ip":
    case "quota_global":
      return quotaWords(err.retryAfterMs);
    default:
      return DDB_WORDS.failed;
  }
}

/** How long this device waits for the server's answer before it says D&D Beyond did not answer. */
export const DEVICE_WAIT_MS = 15_000;

/** The server's fill for a share link, checked as the protocol bounds it. A newer request or the step's end aborts it through `signal`. */
export async function getDdbFill(roomId: string, link: string, signal: AbortSignal): Promise<PcFill> {
  const timeout = AbortSignal.timeout(DEVICE_WAIT_MS);
  const both = AbortSignal.any([signal, timeout]);
  try {
    const res = await api.ddbImport(roomId, link, both);
    const fill = checkedFill(res?.fill);
    if (!fill) throw new ApiError(422, DDB_WORDS.unreadable, "unreadable", null);
    return fill;
  } catch (err) {
    if (signal.aborted) throw err;
    if (timeout.aborted) throw new ApiError(0, DDB_WORDS.failed, "fetch_failed", null);
    throw err;
  }
}

export const PASTE_LIMIT = 5 * 1024 * 1024;

/**
 * Pasted JSON read on this device (6.3): the `{ success, data }` envelope
 * or the bare data, up to 5 MiB, refused before reading past it. The reader
 * loads in its own chunk on first use.
 */
export async function readPastedJson(text: string): Promise<{ fill: PcFill } | { error: string }> {
  if (text.length > PASTE_LIMIT || new Blob([text]).size > PASTE_LIMIT) return { error: DDB_WORDS.tooBig };
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return { error: DDB_WORDS.unreadable };
  }
  const { readDdbCharacter } = await import("#shared/ddb/read.ts");
  const fill = checkedFill(readDdbCharacter(json));
  return fill ? { fill } : { error: DDB_WORDS.unreadable };
}
