import { useSyncExternalStore } from "react";
import { CONDITION_KEYS, STATUS_KEYS, type ConditionKey, type StatusKey } from "#shared/model.ts";

/**
 * The conditions this device last put on a creature, newest first, three
 * kept (docs/design/design-v1-qol.md 3, Q13), which the bar's Conditions and a token's
 * picker show first as Recent, so a scroll to Prone goes once Prone is
 * recent. A custom status is left out: its tile opens a form of its own,
 * not one status. This device's storage only, never the room's, and one
 * list for every room, since a condition means the same in each.
 */

export type RecentCondition = ConditionKey | StatusKey;

export const RECENT_CONDITIONS = 3;

export const RECENT_CONDITIONS_KEY = "rvtt.recentConditions";

const KNOWN: ReadonlySet<string> = new Set([...CONDITION_KEYS, ...STATUS_KEYS]);

function known(key: unknown): key is RecentCondition {
  return typeof key === "string" && KNOWN.has(key);
}

/** The list with this condition first, once each, three at most. A key that is no condition or status leaves the list as it was. */
export function withUsed(list: readonly RecentCondition[], key: string): RecentCondition[] {
  if (!known(key)) return [...list];
  return [key, ...list.filter((k) => k !== key)].slice(0, RECENT_CONDITIONS);
}

/** What storage held, newest first: known keys only, once each, three at most. Anything unreadable is an empty list. */
export function parseRecentConditions(raw: string | null): RecentCondition[] {
  if (!raw) return [];
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(data)) return [];
  const out: RecentCondition[] = [];
  for (const key of data.slice(0, 20)) if (known(key) && !out.includes(key)) out.push(key);
  return out.slice(0, RECENT_CONDITIONS);
}

export type ConditionStorage = Pick<Storage, "getItem" | "setItem">;

function deviceStorage(): ConditionStorage | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

let list: readonly RecentCondition[] | null = null;
const listeners = new Set<() => void>();

/** The list on this page, read from storage once. Blocked storage reads as an empty list. */
export function recentConditions(storage: ConditionStorage | null = deviceStorage()): readonly RecentCondition[] {
  if (list !== null) return list;
  let raw: string | null = null;
  try {
    raw = storage?.getItem(RECENT_CONDITIONS_KEY) ?? null;
  } catch {
    // Blocked: the list starts empty and lasts for this page load.
  }
  list = parseRecentConditions(raw);
  return list;
}

/** Puts a condition first, as one goes on a creature. Storage that is blocked or full keeps it for this page load only. */
export function noteConditionUsed(key: string, storage: ConditionStorage | null = deviceStorage()): void {
  const before = recentConditions(storage);
  const next = withUsed(before, key);
  if (next.length === before.length && next.every((k, i) => k === before[i])) return;
  list = next;
  try {
    storage?.setItem(RECENT_CONDITIONS_KEY, JSON.stringify(next));
  } catch {
    // Kept for this page load.
  }
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useRecentConditions(): readonly RecentCondition[] {
  return useSyncExternalStore(subscribe, recentConditions, recentConditions);
}

/** For tests: forget the list read, so the next read takes storage again. */
export function forgetRecentConditions(): void {
  list = null;
}
