import { createStore } from "zustand/vanilla";
import type { LoadFailure } from "./chunkLoad.ts";

/**
 * Load failures of the room's quiet parts (lib/quietLazy.tsx): the DM's
 * height marks and explored outline, the map layers that load after the
 * room opens. A part that failed draws nothing where it stands, since a notice
 * on the map's canvas would cover the map, so it reports here instead, and
 * the room shows one notice for all of them (pages/QuietLoadNotice.tsx)
 * with the same reload, which waits for queued edits, as a panel that did
 * not load. Retry is only for a part that threw while rendering.
 */

/** As components/LoadBoundary.tsx's Failure: `checking` while the page asks why, `error` for a part that threw. */
export type QuietFailure = LoadFailure | "checking" | "error";

export type QuietPart = { subject: string; failure: QuietFailure; retry(): void };

export const quietFailures = createStore<{ parts: Readonly<Record<string, QuietPart>> }>(() => ({ parts: {} }));

/** Records a part's failure under its own id, or clears it with null. */
export function reportQuietFailure(id: string, part: QuietPart | null): void {
  const { parts } = quietFailures.getState();
  if (part === null) {
    if (!(id in parts)) return;
    const { [id]: _gone, ...rest } = parts;
    quietFailures.setState({ parts: rest });
    return;
  }
  quietFailures.setState({ parts: { ...parts, [id]: part } });
}

/*
 * Which answer the one notice gives when several parts failed: a reload
 * first, since only it brings back a part a redeploy removed or Chrome
 * remembers as failed, then the offline wait, then a part that threw.
 */
const ORDER: readonly QuietFailure[] = ["updated", "failed", "offline", "error"];

/**
 * The notice for the parts that failed, or null when none did or the page
 * is still asking why (`checking`, a moment). Retry renders every failed
 * part again, which helps only a part that threw while rendering. One part
 * is named by its subject, several together.
 */
export function quietNotice(parts: Readonly<Record<string, QuietPart>>): { subject: string; failure: QuietFailure; retry(): void } | null {
  const failed = Object.values(parts).filter((p) => p.failure !== "checking");
  if (failed.length === 0) return null;
  const failure = ORDER.find((f) => failed.some((p) => p.failure === f)) ?? "error";
  const subjects = new Set(failed.map((p) => p.subject));
  const subject = subjects.size === 1 ? failed[0]!.subject : "Parts of the map";
  const retries = failed.map((p) => p.retry);
  return { subject, failure, retry: () => retries.forEach((retry) => retry()) };
}
