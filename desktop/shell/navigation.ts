import { extname, join, normalize, sep } from "node:path";
import { RELEASES_PAGE_PREFIX } from "./updates.ts";

/**
 * The window's page is served by the shell itself at `app://raccoonvtt/`
 * (design 3), from the window's Vite build, so it works while the app server
 * is down.
 */
export const APP_SCHEME = "app";
export const APP_HOST = "raccoonvtt";
export const APP_ORIGIN = `${APP_SCHEME}://${APP_HOST}`;
export const WINDOW_URL = `${APP_ORIGIN}/`;

/**
 * The window's policy (design 6.4). It loads only its own files, draws the
 * QR code as a data URL, and talks to nothing: every request goes through
 * the bridge, so `connect-src` is none.
 */
export const WINDOW_CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data:",
  "connect-src 'none'",
  "object-src 'none'",
  "base-uri 'none'",
  "frame-ancestors 'none'",
].join("; ");

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
};

export function contentType(file: string): string {
  return TYPES[extname(file).toLowerCase()] ?? "application/octet-stream";
}

/**
 * The file under `root` an `app://raccoonvtt/...` URL names, or null for
 * any other origin and for a path that would leave `root`. `/` is the page.
 * The query and fragment never name a file.
 */
export function windowFile(url: string, root: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== `${APP_SCHEME}:` || parsed.host !== APP_HOST) return null;
  let path: string;
  try {
    path = decodeURIComponent(parsed.pathname);
  } catch {
    return null;
  }
  // A backslash or NUL in a decoded path is never one of the build's names,
  // and either could reach past `root` on Windows.
  if (path.includes("\\") || path.includes("\0")) return null;
  const file = join(root, normalize(path === "/" ? "index.html" : path.replace(/^\/+/, "")));
  // Whatever the path held, the file must be inside the build.
  const base = root.endsWith(sep) ? root : `${root}${sep}`;
  return file.startsWith(base) ? file : null;
}

/**
 * Whether the window may open `url` in the default browser (design 6.4): the
 * app at `http://localhost:<port>/` while it has a port, and the release
 * pages. Anything else, such as a link a room name could carry, stays shut.
 */
export function externalAllowed(url: string, port: number | null): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.username || parsed.password) return false;
  if (port !== null && parsed.protocol === "http:" && parsed.hostname === "localhost" && parsed.port === String(port)) return true;
  return parsed.protocol === "https:" && parsed.href.startsWith(RELEASES_PAGE_PREFIX);
}

/** The app's own page in the DM's browser. */
export function appPage(port: number): string {
  return `http://localhost:${port}/`;
}
