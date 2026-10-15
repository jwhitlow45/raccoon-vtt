import type { FastifyInstance, FastifyRequest } from "fastify";
import type { ApiErrorCode } from "#shared/apiErrors.ts";
import type { Config } from "../config.ts";
import { turnstileEnabled } from "../auth/turnstile.ts";
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
 */
export function contentSecurityPolicy(turnstile: boolean): string {
  const script = turnstile ? `script-src 'self' ${TURNSTILE_ORIGIN}` : "script-src 'self'";
  const directives = [
    "default-src 'self'",
    `img-src 'self' blob: data: ${THUMBNAIL_CSP_SOURCES.join(" ")}`,
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

export function securityHeaders(config: Pick<Config, "production" | "TURNSTILE_SECRET">): Record<string, string> {
  return {
    "content-security-policy": contentSecurityPolicy(turnstileEnabled(config)),
    "referrer-policy": "no-referrer",
    "x-content-type-options": "nosniff",
    "permissions-policy": "camera=(), microphone=(), geolocation=()",
    // Only over https. Sent from http://localhost it would pin a developer's
    // browser to https for a year on a host that has none.
    ...(config.production ? { "strict-transport-security": "max-age=31536000" } : {}),
  };
}

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/**
 * Whether a state-changing request provably comes from our own pages. Every
 * browser the app supports sends Sec-Fetch-Site, and only a same-origin
 * fetch says `same-origin`. A client that omits it must instead present the
 * exact public origin. SameSite=Strict already keeps the cookie off
 * cross-site requests, so this is the second lock on the same door.
 */
export function csrfAllowed(req: Pick<FastifyRequest, "method" | "headers">, publicOrigin: string): boolean {
  if (SAFE_METHODS.has(req.method)) return true;
  const site = req.headers["sec-fetch-site"];
  if (site !== undefined) return site === "same-origin";
  return req.headers.origin === publicOrigin;
}

export function registerSecurity(app: FastifyInstance, config: Config): void {
  const headers = securityHeaders(config);

  // Set first, so any route can still override one for its own response.
  app.addHook("onRequest", async (req, reply) => {
    reply.headers(headers);
    if (!csrfAllowed(req, config.publicOrigin)) {
      return reply.code(403).send({ error: "cross_origin" satisfies ApiErrorCode });
    }
  });

  // JSON bodies must be application/json. Fastify also parses text/plain by
  // default, which is the one body type a cross-site HTML form can send
  // without a preflight, so that parser goes. Uploads and imports register
  // their own parsers for image/* and application/zip.
  app.removeContentTypeParser("text/plain");
}
