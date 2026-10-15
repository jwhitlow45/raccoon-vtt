import { readPlayerFragment, type PlayerFragment } from "#shared/playerLink.ts";
import { parseRoomInput } from "./roomId.ts";
import { parseRoute } from "./router.ts";

/**
 * Opening a player link, `/r/<roomId>#pw=<password>` (design section 10.2).
 *
 * The password is taken out of the address bar with replaceState before the
 * app renders, so it stays neither in the address bar nor in the page's
 * history entry. It then waits here, in memory only, until the room's page
 * either finds the device already in the room and drops it, or hands it to
 * the join page, which sends it once.
 *
 * A plain module with the browser passed in, so the tests run without a DOM.
 */

export type LinkPassword = {
  roomId: string;
  /** Null when the link had a `pw=` that was empty or cut off. */
  password: string | null;
  /** Which link this was. A second link for the same room starts its page over. */
  seq: number;
};

export type LinkState = {
  /** The link waiting for its room's page, if any. */
  pending: LinkPassword | null;
  /** Links seen in this page so far. */
  opened: number;
};

let state: LinkState = { pending: null, opened: 0 };
const listeners = new Set<() => void>();

function set(next: LinkState): void {
  state = next;
  for (const listener of listeners) listener();
}

export function linkState(): LinkState {
  return state;
}

export function subscribeLinkState(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Holds a link's password for its room's page. */
export function offerLinkPassword(roomId: string, password: string | null): void {
  const seq = state.opened + 1;
  set({ pending: { roomId, password, seq }, opened: seq });
}

/** The room's page took the link, so it is not offered again. Repeating it is harmless. */
export function dropLinkPassword(seq: number): void {
  if (state.pending?.seq === seq) set({ ...state, pending: null });
}

export type BrowserLocation = { pathname: string; search: string; hash: string };

/**
 * Takes `pw=` out of the address bar, through `replace` (history.replaceState
 * in the app), before anything else reads it. A password on a path that is
 * not a room is still removed, and then forgotten. Returns whether there was
 * one.
 */
export function captureLinkPassword(location: BrowserLocation, replace: (url: string) => void): boolean {
  const fragment = readPlayerFragment(location.hash);
  if (!fragment) return false;
  replace(location.pathname + location.search + fragment.hash);
  const route = parseRoute(location.pathname, { dev: false });
  if (route.name === "room" && route.roomId) offerLinkPassword(route.roomId, fragment.password);
  return true;
}

/**
 * What the Home page's "Join a room" field reads: a room ID, a join link, or
 * a whole player link pasted from a chat, whose password then comes along.
 */
export function readJoinInput(input: string): { roomId: string; fragment: PlayerFragment | null } | null {
  const roomId = parseRoomInput(input);
  if (!roomId) return null;
  const hashAt = input.indexOf("#");
  return { roomId, fragment: hashAt === -1 ? null : readPlayerFragment(input.slice(hashAt).trim()) };
}
