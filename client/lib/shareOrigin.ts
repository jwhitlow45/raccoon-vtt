import { useEffect, useSyncExternalStore } from "react";
import { api, type LocalServerConfig } from "./api.ts";
import { useRoomConnection } from "../state/view.ts";

/**
 * The origin every link for another device names (docs/design/design-v1-local-app.md 5).
 * Hosted, that is the page's own origin. In the desktop app it is the
 * computer's network address, which the page cannot read for itself and
 * which changes while the DM tab stays open, so /api/config is asked again
 * at the moments a change can show.
 */

/** While a share surface is shown, the answer is at most this old. */
export const SHARE_POLL_MS = 5000;

export type ShareView = { local: LocalServerConfig | null; fetchedAt: number } | null;

/** The origin to build links with: the network address when the app has one, else the page's own. */
export function shareOriginOf(view: ShareView, pageOrigin: string): string {
  return view?.local?.shareOrigin ?? pageOrigin;
}

/** Whether another look is due: always until the first answer, never on a hosted server, else every `SHARE_POLL_MS`. */
export function refreshDue(view: ShareView, now: number): boolean {
  if (view === null) return true;
  if (view.local === null) return false;
  return now - view.fetchedAt >= SHARE_POLL_MS;
}

let view: ShareView = null;
let inflight: Promise<void> | null = null;
const listeners = new Set<() => void>();

function publish(next: ShareView): void {
  view = next;
  for (const listener of listeners) listener();
}

/** Asks /api/config now. Overlapping asks share one request. A failed ask keeps the last answer. */
export function refreshShareOrigin(): Promise<void> {
  inflight ??= api
    .getConfig()
    .then(
      (config) => {
        const previous = view?.local;
        const same = previous !== undefined && JSON.stringify(previous) === JSON.stringify(config.local);
        // An unchanged answer still moves the clock, but without waking every subscriber to render the same link.
        if (same && view) view = { local: view.local, fetchedAt: Date.now() };
        else publish({ local: config.local, fetchedAt: Date.now() });
      },
      () => {},
    )
    .finally(() => {
      inflight = null;
    });
  return inflight;
}

/** Tests only: forget what was asked. */
export function resetShareOrigin(): void {
  view = null;
  inflight = null;
}

/**
 * `location.origin`, or the app's network address when /api/config names
 * one. Asked when a share surface mounts, every 5 s while one is shown, when
 * the window regains focus and when the room's connection returns to open (a
 * switch, a port change and a restore all restart the server).
 */
export function useShareOrigin(): string {
  const current = useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    () => view,
    () => null,
  );
  const connection = useRoomConnection();
  useEffect(() => {
    const ask = () => {
      if (refreshDue(view, Date.now())) void refreshShareOrigin();
    };
    ask();
    const timer = setInterval(ask, SHARE_POLL_MS);
    const onFocus = () => {
      if (view?.local) void refreshShareOrigin();
    };
    addEventListener("focus", onFocus);
    return () => {
      clearInterval(timer);
      removeEventListener("focus", onFocus);
    };
  }, []);
  useEffect(() => {
    if (connection === "open" && view?.local) void refreshShareOrigin();
  }, [connection]);
  // A render outside a browser (the unit tests' server render) has no page origin to name.
  return shareOriginOf(current, typeof location === "undefined" ? "http://localhost" : location.origin);
}

/** The local part of the answer, for pages that need more than the origin (Home's other-device states). */
export function useLocalConfig(): { loaded: boolean; local: LocalServerConfig | null } {
  const current = useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    () => view,
    () => null,
  );
  useEffect(() => {
    if (view === null) void refreshShareOrigin();
  }, []);
  return { loaded: current !== null, local: current?.local ?? null };
}
