/**
 * Runs a request at most once per key for the life of the page, and hands
 * every caller the same promise.
 *
 * Device invites are single use, so redeeming one twice would show an
 * error for an invite that worked. React's StrictMode runs effects twice in
 * development, and a quick double tap can submit twice, so claims go
 * through here. A failure is forgotten, so the person can retry.
 */
const results = new Map<string, Promise<unknown>>();

export function once<T>(key: string, run: () => Promise<T>): Promise<T> {
  const existing = results.get(key);
  if (existing) return existing as Promise<T>;
  const pending = run();
  results.set(key, pending);
  pending.catch(() => results.delete(key));
  return pending;
}
