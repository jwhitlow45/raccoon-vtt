import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type pg from "pg";
import { AssetError } from "./errors.ts";
import { OpenverseSearch, openverseSearchUrl, sanitizeOpenverseResults, type OpenverseHttp, type OpenverseRequest, type OpenverseResponse } from "./openverse.ts";

const ID = "4bc43a04-ef46-4544-a0c1-63c63f56e276";
const SECRET = "client-secret-never-leaves";

function item(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: ID,
    title: "Goblins and a Troll",
    foreign_landing_url: "https://www.flickr.com/photos/dunechaser/123",
    url: "https://live.staticflickr.com/1/123_abc_b.jpg",
    creator: "Dunechaser",
    creator_url: "https://www.flickr.com/photos/dunechaser",
    license: "by-nc-sa",
    license_version: "2.0",
    license_url: "https://creativecommons.org/licenses/by-nc-sa/2.0/",
    provider: "flickr",
    source: "flickr",
    attribution: '"Goblins and a Troll" by Dunechaser is licensed under CC BY-NC-SA 2.0.',
    mature: false,
    width: 1024,
    height: 768,
    thumbnail: `https://api.openverse.org/v1/images/${ID}/thumb/`,
    detail_url: `https://api.openverse.org/v1/images/${ID}/`,
    tags: [{ name: "goblin" }],
    ...over,
  };
}

describe("the Openverse search request", () => {
  test("asks for adaptable licenses, no mature results and the file types the import takes", () => {
    const url = new URL(openverseSearchUrl("goblin archer", 20));
    assert.equal(url.origin + url.pathname, "https://api.openverse.org/v1/images/");
    assert.deepEqual(Object.fromEntries(url.searchParams), {
      q: "goblin archer",
      page_size: "20",
      license_type: "modification",
      mature: "false",
      extension: "jpg,png,webp,gif",
    });
  });
});

describe("sanitizeOpenverseResults", () => {
  test("keeps the picker's fields and a credit, and nothing else", () => {
    assert.deepEqual(sanitizeOpenverseResults({ result_count: 1, results: [item()] }, 20), [
      {
        thumbnail: `https://api.openverse.org/v1/images/${ID}/thumb/`,
        original: "https://live.staticflickr.com/1/123_abc_b.jpg",
        title: "Goblins and a Troll",
        source: "www.flickr.com",
        original_width: 1024,
        original_height: 768,
        credit: {
          title: "Goblins and a Troll",
          creator: "Dunechaser",
          license: "by-nc-sa",
          licenseVersion: "2.0",
          landingUrl: "https://www.flickr.com/photos/dunechaser/123",
          attribution: '"Goblins and a Troll" by Dunechaser is licensed under CC BY-NC-SA 2.0.',
        },
      },
    ]);
  });

  test("keeps every adaptable license and drops no-derivatives and unknown ones", () => {
    const licenses = ["by", "by-sa", "by-nc", "by-nc-sa", "cc0", "pdm", "sampling+", "nc-sampling+", "by-nd", "by-nc-nd", "proprietary", ""];
    const kept = sanitizeOpenverseResults({ results: licenses.map((license) => item({ license })) }, 40).map((r) => r.credit?.license);
    assert.deepEqual(kept, ["by", "by-sa", "by-nc", "by-nc-sa", "cc0", "pdm", "sampling+", "nc-sampling+"]);
  });

  test("drops a result whose thumbnail is not Openverse's own or whose links are unusable", () => {
    const results = sanitizeOpenverseResults(
      {
        results: [
          item({ thumbnail: "https://serpapi.com/searches/a/images/1.jpeg" }),
          item({ thumbnail: "https://api.openverse.org/v1/images/?q=goblin" }),
          item({ thumbnail: `https://api.openverse.org/v1/images/${ID}/thumb/?full=1` }),
          item({ url: "http://plain.example/goblin.jpg" }),
          item({ url: "javascript:alert(1)" }),
          item({ foreign_landing_url: "javascript:alert(1)" }),
          item({ foreign_landing_url: null }),
          item({ attribution: null }),
          item({ mature: true }),
          null,
          "junk",
          item({ foreign_landing_url: "http://www.flickr.com/photos/x/1", creator: null, license_version: null, width: "1024", title: null }),
        ],
      },
      20,
    );
    assert.equal(results.length, 1);
    assert.deepEqual(results[0], {
      thumbnail: `https://api.openverse.org/v1/images/${ID}/thumb/`,
      original: "https://live.staticflickr.com/1/123_abc_b.jpg",
      title: "",
      source: "www.flickr.com",
      original_height: 768,
      credit: {
        license: "by-nc-sa",
        landingUrl: "http://www.flickr.com/photos/x/1",
        attribution: '"Goblins and a Troll" by Dunechaser is licensed under CC BY-NC-SA 2.0.',
      },
    });
  });

  test("bounds the text: control characters gone, the attribution at 400 with an ellipsis", () => {
    const [r] = sanitizeOpenverseResults(
      { results: [item({ title: "Gob\u0000lin\nking", creator: "A\u2028B", attribution: `${"x".repeat(398)}\uD83D\uDE00 tail` })] },
      20,
    );
    assert.equal(r?.title, "Gob lin king");
    assert.equal(r?.credit?.title, "Gob lin king");
    assert.equal(r?.credit?.creator, "A B");
    // Cut at 399 units would split the emoji's pair, so it goes whole.
    assert.equal(r?.credit?.attribution, `${"x".repeat(398)}…`);
    assert.ok(r!.credit!.attribution.length <= 400);
    const [lone] = sanitizeOpenverseResults({ results: [item({ title: "a\uD800b" })] }, 20);
    assert.equal(lone?.title, "a\uFFFDb");
  });

  test("keeps at most the page size", () => {
    const many = Array.from({ length: 50 }, () => item());
    assert.equal(sanitizeOpenverseResults({ results: many }, 20).length, 20);
    assert.equal(sanitizeOpenverseResults({ results: many }, 40).length, 40);
    assert.deepEqual(sanitizeOpenverseResults({ results: "x" }, 20), []);
    assert.deepEqual(sanitizeOpenverseResults(null, 20), []);
  });
});

/**
 * A pool that grants every budget and caches nothing, so these tests reach
 * the transport on every search. The budgets themselves are tested against
 * Postgres in server/http/openverse.itest.ts.
 */
function grantingPool(): { pool: pg.Pool; refunds: string[][] } {
  const refunds: string[][] = [];
  const query = async (sql: string, params?: unknown[]) => {
    if (/^update search_usage set count = greatest/.test(sql)) refunds.push(params?.[0] as string[]);
    return { rows: [], rowCount: 1 };
  };
  const pool = { query, connect: async () => ({ query, release() {} }) } as unknown as pg.Pool;
  return { pool, refunds };
}

type Reply = Partial<OpenverseResponse> | Error;

/** A stand-in for api.openverse.org. Each reply list is used in order, and the last one repeats. */
function fakeOpenverse(replies: { token?: Reply[]; search?: Reply[] } = {}) {
  const calls: OpenverseRequest[] = [];
  const next = (list: Reply[] | undefined, i: number, fallback: Reply): Reply => list?.[Math.min(i, list.length - 1)] ?? fallback;
  let tokens = 0;
  let searches = 0;
  const http: OpenverseHttp = async (req) => {
    calls.push(req);
    const url = new URL(req.url);
    const reply =
      url.pathname === "/v1/auth_tokens/token/"
        ? next(replies.token, tokens++, { status: 200, body: { access_token: `token-${tokens}`, scope: "read write", expires_in: 36_000, token_type: "Bearer" } })
        : next(replies.search, searches++, { status: 200, body: { results: Array.from({ length: 50 }, () => item()) } });
    if (reply instanceof Error) throw reply;
    return { status: 200, body: null, ...reply };
  };
  return {
    http,
    calls,
    tokenCalls: () => calls.filter((c) => c.url.endsWith("/auth_tokens/token/")),
    searchCalls: () => calls.filter((c) => c.url.includes("/v1/images/")),
  };
}

function clock(start = Date.UTC(2026, 9, 14, 12)) {
  let now = start;
  return { now: () => now, advance: (ms: number) => (now += ms) };
}

const ctx = { roomId: "ROOM2345", memberId: "m1", ip: "203.0.113.0" };

function searcher(fake: ReturnType<typeof fakeOpenverse>, opts: { registered?: boolean; now?: () => number } = {}) {
  const { pool, refunds } = grantingPool();
  const ov = new OpenverseSearch({
    pool,
    http: fake.http,
    clientId: opts.registered ? "client-id" : undefined,
    clientSecret: opts.registered ? SECRET : undefined,
    now: opts.now,
  });
  return { ov, refunds };
}

function isCode(status: number, code: string) {
  return (err: unknown) => err instanceof AssetError && err.status === status && err.code === code;
}

describe("OpenverseSearch", () => {
  test("anonymous: 20 results a page and no token", async () => {
    const fake = fakeOpenverse();
    const { ov } = searcher(fake);
    const results = await ov.search("  Goblin ", ctx);
    assert.equal(results.length, 20);
    assert.equal(fake.tokenCalls().length, 0);
    const [call] = fake.searchCalls();
    assert.equal(new URL(call!.url).searchParams.get("q"), "goblin");
    assert.equal(new URL(call!.url).searchParams.get("page_size"), "20");
    assert.equal(call!.headers?.authorization, undefined);
  });

  test("registered: one token for 40 results a page, kept until 5 minutes before it ends", async () => {
    const time = clock();
    const fake = fakeOpenverse();
    const { ov } = searcher(fake, { registered: true, now: time.now });
    // Different words at once share one token request.
    await Promise.all([ov.search("goblin", ctx), ov.search("kobold", ctx), ov.search("orc", ctx)]);
    const [token] = fake.tokenCalls();
    assert.equal(fake.tokenCalls().length, 1);
    assert.equal(token!.method, "POST");
    assert.deepEqual(token!.form, { grant_type: "client_credentials", client_id: "client-id", client_secret: SECRET });
    for (const call of fake.searchCalls()) {
      assert.equal(call.headers?.authorization, "Bearer token-1");
      assert.equal(new URL(call.url).searchParams.get("page_size"), "40");
    }
    // The answer said 10 hours. At 9 h 54 min it is still kept, at 9 h 55 min a new one is fetched.
    time.advance(9 * 3600_000 + 54 * 60_000);
    await ov.search("bugbear", ctx);
    assert.equal(fake.tokenCalls().length, 1);
    time.advance(60_000);
    await ov.search("hobgoblin", ctx);
    assert.equal(fake.tokenCalls().length, 2);
    assert.equal(fake.searchCalls().at(-1)?.headers?.authorization, "Bearer token-2");
  });

  test("a token answer with no usable lifetime is fetched again after 5 minutes", async () => {
    const time = clock();
    const fake = fakeOpenverse({ token: [{ status: 200, body: { access_token: "short" } }] });
    const { ov } = searcher(fake, { registered: true, now: time.now });
    await ov.search("goblin", ctx);
    time.advance(4 * 60_000);
    await ov.search("kobold", ctx);
    assert.equal(fake.tokenCalls().length, 1);
    time.advance(60_000);
    await ov.search("orc", ctx);
    assert.equal(fake.tokenCalls().length, 2);
  });

  test("a 401 with a token fetches a new one and tries once more", async () => {
    const fake = fakeOpenverse({ search: [{ status: 401, body: { detail: "expired" } }, { status: 200, body: { results: [item()] } }] });
    const { ov } = searcher(fake, { registered: true });
    assert.equal((await ov.search("goblin", ctx)).length, 1);
    assert.equal(fake.tokenCalls().length, 2);
    assert.deepEqual(
      fake.searchCalls().map((c) => c.headers?.authorization),
      ["Bearer token-1", "Bearer token-2"],
    );

    const stuck = fakeOpenverse({ search: [{ status: 401, body: {} }] });
    const { ov: refused, refunds } = searcher(stuck, { registered: true, now: clock().now });
    await assert.rejects(refused.search("goblin", ctx), isCode(502, "search_failed"));
    assert.equal(stuck.searchCalls().length, 2);
    // The member, room and address get theirs back. The server's day keeps it.
    assert.deepEqual(refunds, [["ov:m:ROOM2345:m1:2026-10-14", "ov:r:ROOM2345:2026-10-14", "ov:ip:203.0.113.0:2026-10-14"]]);
  });

  test("a refused or unreadable token is a failed search that never shows the secret", async () => {
    for (const reply of [
      { status: 401, body: { error: "invalid_client", client_secret: SECRET } },
      { status: 200, body: { access_token: "bad\r\nheader: x" } },
      { status: 200, body: null },
      new Error(`connect ECONNREFUSED client_secret=${SECRET}`),
    ]) {
      const fake = fakeOpenverse({ token: [reply] });
      const { ov } = searcher(fake, { registered: true });
      await assert.rejects(ov.search("goblin", ctx), (err: unknown) => {
        assert.ok(isCode(502, "search_failed")(err));
        const text = `${(err as Error).message} ${String((err as Error).cause)} ${JSON.stringify(err)}`;
        assert.ok(!text.includes(SECRET), text);
        return true;
      });
      assert.equal(fake.searchCalls().length, 0);
    }
  });

  test("a 429 is quota_global, and Openverse is left alone for a minute or as long as it asks", async () => {
    const time = clock();
    const fake = fakeOpenverse({ search: [{ status: 429, body: { detail: "Request was throttled." } }, { status: 200, body: { results: [] } }] });
    const { ov, refunds } = searcher(fake, { now: time.now });
    await assert.rejects(ov.search("goblin", ctx), (err: unknown) => isCode(429, "quota_global")(err) && (err as AssetError).retryAfter === 60);
    assert.equal(refunds.length, 1);
    await assert.rejects(ov.search("kobold", ctx), isCode(429, "quota_global"));
    assert.equal(fake.searchCalls().length, 1, "no call while Openverse is busy");
    time.advance(60_000);
    assert.deepEqual(await ov.search("kobold", ctx), []);

    const asks = fakeOpenverse({ search: [{ status: 429, retryAfter: "120", body: null }, { status: 200, body: { results: [] } }] });
    const later = clock();
    const { ov: patient } = searcher(asks, { now: later.now });
    await assert.rejects(patient.search("goblin", ctx), (err: unknown) => (err as AssetError).retryAfter === 120);
    later.advance(119_000);
    await assert.rejects(patient.search("goblin", ctx), isCode(429, "quota_global"));
    later.advance(1_000);
    assert.deepEqual(await patient.search("goblin", ctx), []);
  });

  test("any other answer, or none, is a failed search", async () => {
    for (const reply of [{ status: 500, body: {} }, { status: 401, body: {} }, new Error("socket hang up")]) {
      const { ov } = searcher(fakeOpenverse({ search: [reply] }));
      await assert.rejects(ov.search("goblin", ctx), isCode(502, "search_failed"));
    }
  });

  test("15 searches a minute anonymous, 80 registered, refused before Openverse is asked", async () => {
    for (const [registered, limit] of [[false, 15], [true, 80]] as const) {
      const time = clock();
      const fake = fakeOpenverse();
      const { ov, refunds } = searcher(fake, { registered, now: time.now });
      for (let i = 0; i < limit; i++) await ov.search(`word ${i}`, ctx);
      await assert.rejects(ov.search("one more", ctx), (err: unknown) => isCode(429, "quota_global")(err) && (err as AssetError).retryAfter === 60);
      assert.equal(fake.searchCalls().length, limit);
      // Nothing was asked, so every count comes back, the server's day included.
      assert.equal(refunds.at(-1)?.length, 4);
      time.advance(60_000);
      await ov.search("one more", ctx);
    }
  });

  test("an empty or oversized query costs nothing", async () => {
    const fake = fakeOpenverse();
    const { ov } = searcher(fake);
    await assert.rejects(ov.search("   ", ctx), isCode(400, "bad_query"));
    await assert.rejects(ov.search("x".repeat(101), ctx), isCode(400, "bad_query"));
    assert.equal(fake.calls.length, 0);
  });
});
