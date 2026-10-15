import { parseRoomId } from "./roomId.ts";

/**
 * The app has two routes (design section 14.1), so a regular expression does
 * the job React Router would. `/dev/room` shows the Room page with fixture
 * data and `/dev/kit` every shared component (client/dev/Kit.tsx). Both
 * exist only in development builds.
 */
export type Route =
  | { name: "home" }
  /** `roomId` is null when the path segment is not a valid room ID. */
  | { name: "room"; roomId: string | null }
  | { name: "devRoom" }
  | { name: "devKit" }
  /** A table display (docs/design-v1-dm-tools.md 3.1): `/display` enters a code, `/display/:roomId` shows the room. */
  | { name: "display"; roomId: string | null; badId?: true }
  /** The server admin page (docs/design-v1-dm-tools.md 3.18), the not-found page when the server has no admin password. */
  | { name: "admin" }
  | { name: "notFound" };

function displayRoute(segment: string): Route {
  try {
    const roomId = parseRoomId(decodeURIComponent(segment));
    return roomId ? { name: "display", roomId } : { name: "display", roomId: null, badId: true };
  } catch {
    return { name: "display", roomId: null, badId: true };
  }
}

export function parseRoute(pathname: string, options: { dev: boolean }): Route {
  if (pathname === "/" || pathname === "") return { name: "home" };
  const room = /^\/r\/([^/]+)\/?$/.exec(pathname);
  if (room) {
    let segment: string;
    try {
      segment = decodeURIComponent(room[1]!);
    } catch {
      return { name: "room", roomId: null };
    }
    return { name: "room", roomId: parseRoomId(segment) };
  }
  if (options.dev && /^\/dev\/room\/?$/.test(pathname)) return { name: "devRoom" };
  if (options.dev && /^\/dev\/kit\/?$/.test(pathname)) return { name: "devKit" };
  const display = /^\/display(?:\/([^/]+))?\/?$/.exec(pathname);
  if (display) return display[1] === undefined ? { name: "display", roomId: null } : displayRoute(display[1]);
  if (/^\/admin\/?$/.test(pathname)) return { name: "admin" };
  return { name: "notFound" };
}
