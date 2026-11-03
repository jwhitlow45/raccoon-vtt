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


describe("the unknown-token cache and promotion (docs/design/design-v1-join-requests.md 5.1)", () => {
  const request = (token: string, ua = "phone") => ({ cookies: { rvtt: token }, headers: { "user-agent": ua } }) as unknown as FastifyRequest;

  test("a promotion clears its hash, so the next request finds the session at once", async () => {
    let rows: unknown[] = [];
    let queries = 0;
    const pool = {
      query: async () => {
        queries++;
        return { rows };
      },
    };
    const store = new SessionStore(pool as never, { name: "rvtt", secure: false }, () => 0);
    const token = randomToken();
    assert.equal(await store.lookup(request(token)), null);
    assert.equal(await store.lookup(request(token)), null);
    assert.equal(queries, 1, "the miss is warm in the cache");
    rows = [{ id: "s1", slide: false, touch: false, no_ua: true }];
    store.promoted(sha256(token));
    assert.equal((await store.lookup(request(token)))?.id, "s1", "CACHE-HEALS");
    assert.equal(queries, 2);
    // Idempotent: a second run from a reconciliation changes nothing.
    store.promoted(sha256(token));
    assert.equal((await store.lookup(request(token)))?.id, "s1");
  });

  test("a lookup in flight across the promotion's commit does not cache its miss", async () => {
    let release!: () => void;
    let paused = true;
    let queries = 0;
    const pool = {
      query: async () => {
        queries++;
        if (paused) {
          paused = false;
          await new Promise<void>((r) => (release = r));
          return { rows: [] };
        }
        return { rows: [{ id: "s1", slide: false, touch: false, no_ua: false }] };
      },
    };
    const store = new SessionStore(pool as never, { name: "rvtt", secure: false }, () => 0);
    const token = randomToken();
    const inFlight = store.lookup(request(token));
    await new Promise((r) => setImmediate(r));
    store.promoted(sha256(token));
    release();
    assert.equal(await inFlight, null, "its own answer is the miss it read");
    assert.equal((await store.lookup(request(token)))?.id, "s1", "but the next request reads the database");
    assert.equal(queries, 2);
  });

  test("a session with no user agent takes its own next request's, apart from the slide and touch writes", async () => {
    const writes: Array<{ text: string; values: unknown[] }> = [];
    const pool = {
      query: async (text: string, values: unknown[]) => {
        if (text.includes("select id")) return { rows: [{ id: "s1", slide: false, touch: false, no_ua: true }] };
        writes.push({ text, values });
        return { rows: [], rowCount: 1 };
      },
    };
    const store = new SessionStore(pool as never, { name: "rvtt", secure: false }, () => 0);
    const reply = { setCookie: () => undefined } as never;
    assert.deepEqual(await store.session(request(randomToken(), "Requester phone"), reply), { sessionId: "s1" });
    assert.equal(writes.length, 1);
    assert.match(writes[0]?.text ?? "", /set user_agent = \$2 where id = \$1 and user_agent is null/);
    assert.deepEqual(writes[0]?.values, ["s1", "Requester phone"]);
  });
});
