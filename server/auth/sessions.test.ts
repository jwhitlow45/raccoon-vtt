import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { FastifyRequest } from "fastify";
import { assertCookieSettings, cookieSettings, SESSION_MAX_AGE_S, SessionStore } from "./sessions.ts";
import { isToken, randomToken, sha256, tokenMatches } from "./tokens.ts";

describe("session cookie settings", () => {
  test("production uses __Host-rvtt with Secure", () => {
    assert.deepEqual(cookieSettings({ production: true }), { name: "__Host-rvtt", secure: true });
  });

  test("development uses rvtt without Secure", () => {
    assert.deepEqual(cookieSettings({ production: false }), { name: "rvtt", secure: false });
  });

  test("Max-Age is 180 days", () => {
    assert.equal(SESSION_MAX_AGE_S, 15552000);
  });

  test("production refuses the development cookie", () => {
    const prod = { production: true, publicOrigin: "https://vtt.example.com" };
    assert.throws(() => assertCookieSettings(prod, { name: "rvtt", secure: false }), /development session cookie/);
    assert.throws(() => assertCookieSettings(prod, { name: "__Host-rvtt", secure: false }), /development session cookie/);
    assert.doesNotThrow(() => assertCookieSettings(prod, cookieSettings(prod)));
  });

  test("production refuses a plain http origin", () => {
    const prod = { production: true, publicOrigin: "http://vtt.example.com" };
    assert.throws(() => assertCookieSettings(prod, cookieSettings(prod)), /not https/);
  });

  test("development accepts its own settings", () => {
    const dev = { production: false, publicOrigin: "http://localhost:5173" };
    assert.doesNotThrow(() => assertCookieSettings(dev, cookieSettings(dev)));
  });
});

describe("tokens", () => {
  test("are 32 random bytes in base64url", () => {
    const token = randomToken();
    assert.equal(Buffer.from(token, "base64url").length, 32);
    assert.ok(isToken(token));
    assert.notEqual(randomToken(), token);
  });

  test("match only their own hash", () => {
    const token = randomToken();
    assert.equal(tokenMatches(token, sha256(token)), true);
    assert.equal(tokenMatches(randomToken(), sha256(token)), false);
    assert.equal(tokenMatches(token, Buffer.alloc(3)), false);
  });

  test("isToken refuses other shapes", () => {
    for (const bad of [undefined, "", "abc", `${randomToken()}x`, "a".repeat(42) + "!"]) assert.equal(isToken(bad), false);
  });
});

describe("session lookups", () => {
  test("a cookie that names no session is answered from memory for a minute", async () => {
    let queries = 0;
    let now = 0;
    const pool = {
      query: async () => {
        queries++;
        return { rows: [] };
      },
    };
    const store = new SessionStore(pool as never, { name: "rvtt", secure: false }, () => now);
    const request = (token: string) => ({ cookies: { rvtt: token } }) as unknown as FastifyRequest;
    const invented = randomToken();
    assert.equal(await store.lookup(request(invented)), null);
    assert.equal(await store.lookup(request(invented)), null);
    assert.equal(queries, 1);
    // Another invented value is its own miss.
    assert.equal(await store.lookup(request(randomToken())), null);
    assert.equal(queries, 2);
    now += 61_000;
    assert.equal(await store.lookup(request(invented)), null);
    assert.equal(queries, 3);
    // Something that is not token-shaped never reaches the database at all.
    assert.equal(await store.lookup(request("nope")), null);
    assert.equal(queries, 3);
  });
});

