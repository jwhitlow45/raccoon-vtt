import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { contentSecurityPolicy, csrfAllowed, securityHeaders } from "./security.ts";

const ORIGIN = "https://vtt.example.com";

describe("CSRF rule", () => {
  const post = (headers: Record<string, string>) => ({ method: "POST", headers });

  test("safe methods always pass", () => {
    assert.equal(csrfAllowed({ method: "GET", headers: { "sec-fetch-site": "cross-site" } }, ORIGIN), true);
  });

  test("Sec-Fetch-Site must be same-origin when present", () => {
    assert.equal(csrfAllowed(post({ "sec-fetch-site": "same-origin" }), ORIGIN), true);
    for (const site of ["same-site", "cross-site", "none"]) {
      assert.equal(csrfAllowed(post({ "sec-fetch-site": site, origin: ORIGIN }), ORIGIN), false, site);
    }
  });

  test("without Sec-Fetch-Site the Origin must match exactly", () => {
    assert.equal(csrfAllowed(post({ origin: ORIGIN }), ORIGIN), true);
    assert.equal(csrfAllowed(post({ origin: `${ORIGIN}/` }), ORIGIN), false);
    assert.equal(csrfAllowed(post({ origin: "https://vtt.example.com.evil.test" }), ORIGIN), false);
    assert.equal(csrfAllowed(post({ origin: "http://vtt.example.com" }), ORIGIN), false);
    assert.equal(csrfAllowed(post({}), ORIGIN), false);
    assert.equal(csrfAllowed({ method: "DELETE", headers: {} }, ORIGIN), false);
  });
});

describe("security headers", () => {
  test("the CSP is exactly the design's", () => {
    assert.equal(
      contentSecurityPolicy(false),
      "default-src 'self'; img-src 'self' blob: data: https://serpapi.com https://encrypted-tbn0.gstatic.com https://encrypted-tbn1.gstatic.com https://encrypted-tbn2.gstatic.com https://encrypted-tbn3.gstatic.com https://api.openverse.org/v1/images/; connect-src 'self'; script-src 'self'; style-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
    );
  });

  test("Turnstile adds its origin to script-src and frame-src", () => {
    const csp = contentSecurityPolicy(true);
    assert.match(csp, /script-src 'self' https:\/\/challenges\.cloudflare\.com;/);
    assert.match(csp, /frame-src 'self' https:\/\/challenges\.cloudflare\.com;/);
  });

  test("HSTS only in production", () => {
    assert.equal(securityHeaders({ production: true, TURNSTILE_SECRET: undefined })["strict-transport-security"], "max-age=31536000");
    assert.equal(securityHeaders({ production: false, TURNSTILE_SECRET: undefined })["strict-transport-security"], undefined);
  });

  test("the rest are always sent", () => {
    const h = securityHeaders({ production: false, TURNSTILE_SECRET: undefined });
    assert.equal(h["referrer-policy"], "no-referrer");
    assert.equal(h["x-content-type-options"], "nosniff");
    assert.equal(h["permissions-policy"], "camera=(), microphone=(), geolocation=()");
  });
});
