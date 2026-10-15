import { useSyncExternalStore } from "react";
import { isOverlayEntry } from "./backClose.ts";

/**
 * History-based navigation for the tiny router. `popstate` covers back and
 * forward, `hashchange` covers a DM pasting a link with a new fragment into
 * the address bar of a page that is already open (no navigation happens, only
 * the hash changes), and `navigate` notifies directly, because pushState
 * fires neither event.
 */
const listeners = new Set<() => void>();

function notify(): void {
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  window.addEventListener("popstate", listener);
  window.addEventListener("hashchange", listener);
  return () => {
    listeners.delete(listener);
    window.removeEventListener("popstate", listener);
    window.removeEventListener("hashchange", listener);
  };
}

/**
 * Goes to `path`. Leaving from inside an open sheet replaces the sheet's
 * history entry (lib/backClose.ts), so Back from the new page returns to
 * the room rather than to a sheet that is no longer there.
 */
export function navigate(path: string, options: { replace?: boolean } = {}): void {
  if (options.replace || isOverlayEntry(history.state)) history.replaceState(null, "", path);
  else history.pushState(null, "", path);
  notify();
}

/**
 * Removes a secret from the address bar without a navigation. replaceState
 * rewrites the current history entry, so the secret does not stay in the
 * back stack either.
 */
export function replaceUrl(path: string): void {
  history.replaceState(null, "", path);
  notify();
}

/** The current path and hash, re-rendering on every change. */
export function useLocation(): { pathname: string; hash: string } {
  const href = useSyncExternalStore(subscribe, () => location.pathname + location.hash);
  const hashAt = href.indexOf("#");
  return hashAt === -1 ? { pathname: href, hash: "" } : { pathname: href.slice(0, hashAt), hash: href.slice(hashAt) };
}
