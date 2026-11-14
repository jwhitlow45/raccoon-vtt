import type { FastifyInstance, FastifyRequest } from "fastify";
import type { ApiErrorCode } from "#shared/apiErrors.ts";
import type { Config } from "../config.ts";
import { turnstileEnabled } from "../auth/turnstile.ts";
import { originPolicy, type OriginPolicy } from "../local/guard.ts";
import { THUMBNAIL_CSP_SOURCES } from "#shared/searchThumbnails.ts";

/**
 * HTTP hardening (design section 10.7): CSRF, JSON-only bodies, and the
 * security headers. Register it before any route.
 */

const TURNSTILE_ORIGIN = "https://challenges.cloudflare.com";

/**
 * The Content-Security-Policy, exactly as the design gives it. React sets
 * styles through the DOM style API, which `style-src` does not restrict, so
 * no 'unsafe-inline' is needed.
 *
 * Turnstile needs its script and its iframe and nothing else: its requests
 * run inside the iframe, under Cloudflare's own policy. Checked in Chrome
 * with Cloudflare's test keys, passing and interactive, with no violation.
 *
 * Search thumbnails load from their own hosts (design 11.3). Openverse's
 * source is a path on its API host, which keeps the page from asking that
 * host for anything but a thumbnail. A redirect from there is checked by
 * host alone, so the server's rule in shared/searchThumbnails.ts, which
 * drops any result whose thumbnail fails it, is what holds.
 *
 * Media loads from this origin, an animated map's video, and from `blob:`,
 * the first-frame probe that opens the DM's file before it uploads
 * (docs/design/design-v1-animated-maps.md 7).
 */
export function contentSecurityPolicy(turnstile: boolean): string {
  const script = turnstile ? `script-src 'self' ${TURNSTILE_ORIGIN}` : "script-src 'self'";
  const directives = [
    "default-src 'self'",
    `img-src 'self' blob: data: ${THUMBNAIL_CSP_SOURCES.join(" ")}`,
    "media-src 'self' blob:",
    "connect-src 'self'",
    script,
    "style-src 'self'",
    // Frames otherwise fall back to default-src 'self', so Turnstile's
    // iframe is added to that rather than replacing it.
    ...(turnstile ? [`frame-src 'self' ${TURNSTILE_ORIGIN}`] : []),
    "frame-ancestors 'none'",
    "base-uri 'none'",
    "form-action 'self'",
  ];
  return directives.join("; ");
}

export function securityHeaders(config: Pick<Config, "production" | "TURNSTILE_SECRET"> & Partial<Pick<Config, "local">>): Record<string, string> {
  return {
    "content-security-policy": contentSecurityPolicy(turnstileEnabled(config)),
    // Over plain HTTP no browser sends Sec-Fetch-Site, and under no-referrer
    // WebKit sends `Origin: null` on a same-origin unsafe fetch, which the
    // CSRF check must refuse. With same-origin every browser sends the real
    // origin, and a link to another site still carries no referrer
    // (docs/design/design-v1-local-app.md 4, D-261113-080).
    "referrer-policy": config.local ? "same-origin" : "no-referrer",
    "x-content-type-options": "nosniff",
    "permissions-policy": "camera=(), microphone=(), geolocation=()",
    // Only over https. Sent from http://localhost it would pin a developer's
    // browser to https for a year on a host that has none, and the desktop
    // app has no https at all.
    ...(config.production && !config.local ? { "strict-transport-security": "max-age=31536000" } : {}),
  };
}

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/**
 * Whether a state-changing request provably comes from our own pages. Every
 * browser the app supports sends Sec-Fetch-Site over https, and only a
 * same-origin fetch says `same-origin`. A client that omits it, as every
 * browser does over plain HTTP, must instead present an allowed origin:
 * the exact public origin, or in local mode one of the app's own
 * (server/local/guard.ts), never `null`. A string is the one exact origin.
 * SameSite=Strict already keeps the cookie off cross-site requests, so this
 * is the second lock on the same door.
 */
export function csrfAllowed(req: Pick<FastifyRequest, "method" | "headers">, policy: Pick<OriginPolicy, "originAllowed"> | string): boolean {
  if (SAFE_METHODS.has(req.method)) return true;
  const site = req.headers["sec-fetch-site"];
  if (site !== undefined) return site === "same-origin";
  return typeof policy === "string" ? req.headers.origin === policy : policy.originAllowed(req.headers.origin);
}

export function registerSecurity(app: FastifyInstance, config: Config, policy: OriginPolicy = originPolicy(config)): void {
  const headers = securityHeaders(config);

  // Set first, so any route can still override one for its own response.
  app.addHook("onRequest", async (req, reply) => {
    reply.headers(headers);
    if (!csrfAllowed(req, policy)) {
      return reply.code(403).send({ error: "cross_origin" satisfies ApiErrorCode });
    }
  });

  // JSON bodies must be application/json. Fastify also parses text/plain by
  // default, which is the one body type a cross-site HTML form can send
  // without a preflight, so that parser goes. Uploads and imports register
  // their own parsers for image/* and application/zip.
  app.removeContentTypeParser("text/plain");
}
