import type { BackupKind } from "../contract.ts";

/**
 * Which backups to keep (docs/design/design-v1-local-app.md 8.2): the
 * newest 7 daily or by-hand backups, the newest of each of the last 4
 * weeks, and the newest 3 taken before an update. Before-update backups are
 * kept apart, so a run of updates never pushes out the daily ones, and a
 * week of daily backups never pushes out the one a DM needs to go back.
 */

export const KEEP_RECENT = 7;
export const KEEP_WEEKS = 4;
export const KEEP_BEFORE_UPDATE = 3;
const WEEK_MS = 7 * 24 * 3600 * 1000;

export type Kept = { name: string; kind: BackupKind; started: number };

export function retention(backups: readonly Kept[], now: number): { keep: Set<string>; drop: string[] } {
  const keep = new Set<string>();
  const newestFirst = [...backups].sort((a, b) => b.started - a.started || (a.name < b.name ? 1 : -1));
  const regular = newestFirst.filter((b) => b.kind !== "before-update");
  for (const b of regular.slice(0, KEEP_RECENT)) keep.add(b.name);
  const weeks = new Set<number>();
  for (const b of regular) {
    const week = Math.floor((now - b.started) / WEEK_MS);
    if (week >= 0 && week < KEEP_WEEKS && !weeks.has(week)) {
      weeks.add(week);
      keep.add(b.name);
    }
  }
  for (const b of newestFirst.filter((b) => b.kind === "before-update").slice(0, KEEP_BEFORE_UPDATE)) keep.add(b.name);
  return { keep, drop: newestFirst.filter((b) => !keep.has(b.name)).map((b) => b.name) };
}

/** Store files that no kept backup's list names, which retention may delete. */
export function unlistedStoreFiles(storeFiles: Iterable<string>, keptLists: Iterable<Iterable<string>>): string[] {
  const listed = new Set<string>();
  for (const list of keptLists) for (const path of list) listed.add(path);
  return [...storeFiles].filter((path) => !listed.has(path));
}
