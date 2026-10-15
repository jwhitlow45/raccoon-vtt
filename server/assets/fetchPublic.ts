import { isIP } from "node:net";
import { request, type Dispatcher } from "undici";
import { AssetError } from "./errors.ts";
import { sniffImage } from "./process.ts";
import { receiveToFile, type Received } from "./upload.ts";

/**
 * Fetches an image from a URL a member pasted or picked from search results
 * (design section 10.6). Every rule here is a second line behind squid,
 * which already refuses private ranges and non-443 ports, so a mistake in
 * one layer does not open the app's network to the internet.
 */

export const MAX_URL_LENGTH = 2048;
export const MAX_FETCH_BYTES = 10 * 1024 * 1024;
const MAX_REDIRECTS = 3;
const TIMEOUT_MS = 10_000;
const REDIRECTS = new Set([301, 302, 303, 307, 308]);

/**
 * Parses and checks one URL: `https:` on the default port, no userinfo, at
 * most 2 KB, and a DNS name rather than an IP literal. IP literals are
 * refused outright because Node never runs the DNS lookup for them, so the
 * development guard would not see them. The WHATWG parser has already turned
 * spellings like `0x7f.1` or `2130706433` into dotted form by this point.
 *
 * A name without a dot is refused too. No public image host has one, and in
 * a docker network bare names are exactly what other containers answer to.
 */
export function validateImageUrl(raw: string, allowedHost?: string): URL {
  if (raw.length > MAX_URL_LENGTH) throw badUrl();
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw badUrl();
  }
  if (url.protocol !== "https:") throw badUrl();
  // The parser drops a port equal to the scheme's default, so an explicit
  // :443 reads back as "" and anything else is a different port.
  if (url.port !== "") throw badUrl();
  if (url.username !== "" || url.password !== "") throw badUrl();
  const host = url.hostname;
  if (host.startsWith("[") || isIP(host) !== 0) throw badUrl();
  if (!host.includes(".") || host.endsWith(".")) throw badUrl();
  if (allowedHost !== undefined && host !== allowedHost) throw badUrl();
  return url;
}

export type FetchOptions = {
  dispatcher: Dispatcher;
  /** Where to write the body. The caller owns and deletes it. */
  path: string;
  /** Every hop must be exactly this host (the import's thumbnail fallback). */
  allowedHost?: string;
  maxBytes?: number;
  timeoutMs?: number;
};

export type Fetched = Received & { finalUrl: URL };

/**
 * Downloads one image to `opts.path`. Redirects are followed by hand, each
 * hop checked as strictly as the first, at most 3. The 10 s budget covers
 * every hop and the whole body. The body is capped by Content-Length and
 * again while streaming, because a server may lie or omit it. Compression is
 * refused (Accept-Encoding: identity), so the cap counts the real bytes.
 *
 * Every failure after the first URL check is the same `fetch_failed`, so the
 * caller cannot learn whether a host was private, refused, or slow.
 */
export async function fetchPublicImage(rawUrl: string, opts: FetchOptions): Promise<Fetched> {
  const maxBytes = opts.maxBytes ?? MAX_FETCH_BYTES;
  const timeoutMs = opts.timeoutMs ?? TIMEOUT_MS;
  const signal = AbortSignal.timeout(timeoutMs);
  const started = Date.now();
  let url = validateImageUrl(rawUrl, opts.allowedHost);

  for (let hop = 0; ; hop++) {
    let res: Dispatcher.ResponseData;
    try {
      res = await request(url, {
        dispatcher: opts.dispatcher,
        method: "GET",
        headers: {
          accept: "image/avif,image/webp,image/png,image/jpeg,image/gif",
          "accept-encoding": "identity",
          "user-agent": "raccoon-vtt image import",
        },
        signal,
        headersTimeout: timeoutMs,
        bodyTimeout: timeoutMs,
      });
    } catch (err) {
      throw fetchFailed(err);
    }

    if (REDIRECTS.has(res.statusCode)) {
      discard(res);
      const location = res.headers.location;
      if (hop >= MAX_REDIRECTS || typeof location !== "string") throw fetchFailed();
      try {
        url = validateImageUrl(new URL(location, url).href, opts.allowedHost);
      } catch (err) {
        throw fetchFailed(err);
      }
      continue;
    }
    if (res.statusCode !== 200) {
      discard(res);
      throw fetchFailed();
    }
    const encoding = res.headers["content-encoding"];
    if (encoding !== undefined && encoding !== "identity") {
      discard(res);
      throw fetchFailed();
    }
    const declared = Number(res.headers["content-length"]);
    if (Number.isFinite(declared) && declared > maxBytes) {
      discard(res);
      throw new AssetError(413, "too_large");
    }

    let received: Received;
    try {
      received = await receiveToFile(
        res.body,
        opts.path,
        // The overall signal already enforces the time budget. The deadline
        // here is a backstop with the time that is left.
        { maxBytes, deadlineMs: Math.max(1, timeoutMs - (Date.now() - started)), minBytesPerSec: 0, graceMs: Infinity },
        "destroy",
      );
    } catch (err) {
      if (err instanceof AssetError && err.code === "too_large") throw new AssetError(413, "too_large");
      throw fetchFailed(err);
    }
    await sniffImage(opts.path);
    return { ...received, finalUrl: url };
  }
}

/**
 * Lets go of a response whose body is not wanted. An undici body destroyed
 * before its end emits an abort error, and with no listener that error
 * crashes the process, so any link that answers 404 or redirects would
 * take the whole server down. The error is expected here and dropped.
 */
function discard(res: Dispatcher.ResponseData): void {
  res.body.on("error", () => {});
  res.body.destroy();
}

function badUrl(): AssetError {
  return new AssetError(400, "bad_url");
}

function fetchFailed(cause?: unknown): AssetError {
  return new AssetError(422, "fetch_failed", { cause });
}
