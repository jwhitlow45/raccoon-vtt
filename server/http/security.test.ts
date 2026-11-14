import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { originPolicy } from "../local/guard.ts";
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
      "default-src 'self'; img-src 'self' blob: data: https://serpapi.com https://encrypted-tbn0.gstatic.com https://encrypted-tbn1.gstatic.com https://encrypted-tbn2.gstatic.com https://encrypted-tbn3.gstatic.com https://api.openverse.org/v1/images/; media-src 'self' blob:; connect-src 'self'; script-src 'self'; style-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
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

describe("local mode (docs/design/design-v1-local-app.md 6.2)", () => {
  const P = 3170;
  const policy = originPolicy({ local: true, publicOrigin: `http://localhost:${P}`, PORT: P, HOST: "0.0.0.0" }, { localAddresses: () => ["10.0.0.5"] });
  const post = (headers: Record<string, string>) => ({ method: "POST", headers });

  test("without Sec-Fetch-Site, as over plain HTTP, any of the app's own origins passes", () => {
    for (const origin of [`http://localhost:${P}`, `http://127.0.0.1:${P}`, `http://10.0.0.5:${P}`]) assert.equal(csrfAllowed(post({ origin }), policy), true, origin);
  });

  test("`Origin: null`, a foreign origin and no origin are refused", () => {
    for (const origin of ["null", "http://evil.example", `http://10.0.0.6:${P}`, `https://localhost:${P}`]) assert.equal(csrfAllowed(post({ origin }), policy), false, origin);
    assert.equal(csrfAllowed(post({}), policy), false);
  });

  test("Sec-Fetch-Site, when a browser sends it, still decides", () => {
    assert.equal(csrfAllowed(post({ "sec-fetch-site": "same-origin" }), policy), true);
    assert.equal(csrfAllowed(post({ "sec-fetch-site": "same-site", origin: `http://localhost:${P}` }), policy), false);
    assert.equal(csrfAllowed(post({ "sec-fetch-site": "cross-site", origin: `http://10.0.0.5:${P}` }), policy), false);
  });

  test("a hosted policy is the one exact origin, as a string is", () => {
    const hosted = originPolicy({ local: false, publicOrigin: ORIGIN, PORT: 3000, HOST: "0.0.0.0" });
    assert.equal(csrfAllowed(post({ origin: ORIGIN }), hosted), true);
    assert.equal(csrfAllowed(post({ origin: "null" }), hosted), false);
    assert.equal(csrfAllowed(post({ origin: `http://localhost:${P}` }), hosted), false);
  });

  test("the referrer policy is same-origin, so WebKit sends the real origin, and there is no HSTS over plain HTTP", () => {
    const h = securityHeaders({ production: true, local: true, TURNSTILE_SECRET: undefined });
    assert.equal(h["referrer-policy"], "same-origin");
    assert.equal(h["strict-transport-security"], undefined);
  });

  test("hosted keeps no-referrer, with HSTS in production", () => {
    const h = securityHeaders({ production: true, local: false, TURNSTILE_SECRET: undefined });
    assert.equal(h["referrer-policy"], "no-referrer");
    assert.equal(h["strict-transport-security"], "max-age=31536000");
  });
});
