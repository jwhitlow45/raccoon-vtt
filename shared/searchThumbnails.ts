/**
 * Where image search thumbnails may come from (design 11.3 and
 * docs/design-v1-dm-tools.md 3.13). The server keeps only results whose
 * thumbnail passes this rule, the CSP lets the picker show them, and a
 * failed original falls back to a thumbnail that passes it.
 *
 * SerpApi used to host Google Images thumbnails itself on serpapi.com. In
 * 2026 its results started pointing at Google's own thumbnail servers
 * instead, so both are allowed, on any path. Google serves them from a
 * handful of numbered hosts, listed one by one because a CSP source cannot
 * match a digit.
 *
 * Openverse serves its thumbnails from its API host, which also answers
 * every other API call, so a host alone would admit any of them. Its rule is
 * the host and the exact thumbnail path. The CSP lists that path too, but a
 * browser checks a source's path only on the request the page makes: after
 * a redirect it checks the scheme, host and port alone (CSP3 "Paths and
 * Redirects"). So the rule here, applied before a result reaches anyone, is
 * the real check, and the CSP's path only narrows what the page may ask for.
 */
type ThumbnailSource = {
  host: string;
  /** What the CSP's img-src lists for this source. */
  csp: string;
  /** The path a thumbnail must have, with no query or fragment. Absent, any path and query pass. */
  exactPath?: RegExp;
};

const GOOGLE_HOSTS = ["encrypted-tbn0.gstatic.com", "encrypted-tbn1.gstatic.com", "encrypted-tbn2.gstatic.com", "encrypted-tbn3.gstatic.com"];

/** `https://api.openverse.org/v1/images/<uuid>/thumb/`, as Openverse writes it. */
const OPENVERSE: ThumbnailSource = {
  host: "api.openverse.org",
  csp: "https://api.openverse.org/v1/images/",
  exactPath: /^\/v1\/images\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/thumb\/$/,
};

const SOURCES: readonly ThumbnailSource[] = [
  { host: "serpapi.com", csp: "https://serpapi.com" },
  ...GOOGLE_HOSTS.map((host) => ({ host, csp: `https://${host}` })),
  OPENVERSE,
];

/** The img-src sources the CSP lists for search thumbnails, in a fixed order. */
export const THUMBNAIL_CSP_SOURCES: readonly string[] = SOURCES.map((s) => s.csp);

function parseHttps(raw: string): URL | undefined {
  try {
    const url = new URL(raw);
    if (url.protocol !== "https:" || url.port !== "" || url.username !== "" || url.password !== "") return undefined;
    return url;
  } catch {
    return undefined;
  }
}

function passes(url: URL, source: ThumbnailSource): boolean {
  if (url.hostname !== source.host) return false;
  if (!source.exactPath) return true;
  return source.exactPath.test(url.pathname) && url.search === "" && url.hash === "";
}

/** True for an https URL with no port or credentials that a thumbnail source's rule admits. */
export function isThumbnailUrl(raw: string): boolean {
  const url = parseHttps(raw);
  return url !== undefined && SOURCES.some((source) => passes(url, source));
}

/**
 * True only for an Openverse thumbnail, spelled exactly as the rule's form,
 * so an Openverse result never carries a thumbnail from another source and
 * the cached string is the one the import's fallback check compares.
 */
export function isOpenverseThumbnail(raw: string): boolean {
  const url = parseHttps(raw);
  return url !== undefined && url.href === raw && passes(url, OPENVERSE);
}
