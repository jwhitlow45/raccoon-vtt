import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { AssetError } from "./errors.ts";
import { MAX_RESULTS, SerpApiAccount, normalizeQuery, sanitizeResults, type HttpJson } from "./serpapi.ts";

describe("normalizeQuery", () => {
  test("trims and lowercases, so the cache key matches what is searched", () => {
    assert.equal(normalizeQuery("  Goblin Archer \n"), "goblin archer");
  });
});

describe("sanitizeResults", () => {
  const good = {
    position: 1,
    thumbnail: "https://serpapi.com/searches/abc/images/1.jpeg",
    original: "https://art.example/goblin.png",
    title: "Goblin archer",
    source: "art.example",
    original_width: 1200,
    original_height: 800,
    link: "https://art.example/page",
    is_product: false,
    serpapi_related_content_link: "https://serpapi.com/search.json?api_key=leak",
  };

  test("keeps only the six fields the picker uses", () => {
    assert.deepEqual(sanitizeResults({ images_results: [good] }), [
      {
        thumbnail: good.thumbnail,
        original: good.original,
        title: good.title,
        source: good.source,
        original_width: 1200,
        original_height: 800,
      },
    ]);
  });

  test("keeps at most 40", () => {
    const many = Array.from({ length: 100 }, (_, i) => ({ ...good, original: `https://art.example/${i}.png` }));
    assert.equal(sanitizeResults({ images_results: many }).length, MAX_RESULTS);
  });

  test("drops results whose thumbnail is not on a thumbnail host or whose original is unusable", () => {
    const results = sanitizeResults({
      images_results: [
        { ...good, thumbnail: "https://encrypted-tbn9.gstatic.com/x.jpg" },
        { ...good, thumbnail: "https://www.gstatic.com/x.jpg" },
        { ...good, thumbnail: "http://serpapi.com/x.jpg" },
        { ...good, thumbnail: "https://serpapi.com.evil.example/x.jpg" },
        { ...good, original: "javascript:alert(1)" },
        { ...good, original: 42 },
        null,
        "junk",
        { ...good, original: "http://plain.example/x.png", original_width: "1200", title: 7 },
      ],
    });
    assert.equal(results.length, 1);
    assert.deepEqual(results[0], {
      thumbnail: good.thumbnail,
      original: "http://plain.example/x.png",
      title: "",
      source: good.source,
      original_height: 800,
    });
  });

  test("keeps thumbnails on Google's numbered thumbnail hosts, where SerpApi now points them", () => {
    const results = sanitizeResults({
      images_results: [{ ...good, thumbnail: "https://encrypted-tbn0.gstatic.com/images?q=tbn:ANd9Gc" }],
    });
    assert.equal(results.length, 1);
    assert.equal(results[0]?.thumbnail, "https://encrypted-tbn0.gstatic.com/images?q=tbn:ANd9Gc");
  });

  test("anything that is not a result list gives no results", () => {
    assert.deepEqual(sanitizeResults(null), []);
    assert.deepEqual(sanitizeResults({ images_results: "x" }), []);
  });
});

describe("SerpApiAccount", () => {
  function account(left: number, thisHour: number) {
    const calls: string[] = [];
    let now = 0;
    const state = { left, thisHour };
    const http: HttpJson = async (url) => {
      calls.push(url);
      return {
        status: 200,
        body: { api_key: "SECRET", plan_searches_left: state.left, this_hour_searches: state.thisHour, total_searches_left: 999 },
      };
    };
    const acct = new SerpApiAccount("SECRET", http, () => now);
    return { acct, calls, state, advance: (ms: number) => (now += ms) };
  }

  test("reads the Account API once a minute and counts down locally in between", async () => {
    const { acct, calls, advance } = account(12, 0);
    assert.equal(await acct.reserve(), true);
    assert.equal(await acct.reserve(), true);
    // 10 left now, which is still allowed, then 9.
    assert.equal(await acct.reserve(), true);
    assert.equal(await acct.reserve(), false);
    assert.equal(calls.length, 1);
    assert.ok(calls[0]!.startsWith("https://serpapi.com/account.json?api_key="));
    advance(60_000);
    assert.equal(await acct.reserve(), true);
    assert.equal(calls.length, 2);
  });

  test("refuses at 45 searches this hour", async () => {
    const { acct } = account(200, 44);
    assert.equal(await acct.reserve(), true);
    assert.equal(await acct.reserve(), false);
  });

  test("concurrent first searches share one account read", async () => {
    const { acct, calls } = account(200, 0);
    await Promise.all([acct.reserve(), acct.reserve(), acct.reserve()]);
    assert.equal(calls.length, 1);
  });

  test("an unreadable account means no search", async () => {
    const failing = new SerpApiAccount("k", async () => ({ status: 401, body: { error: "Invalid API key" } }));
    await assert.rejects(failing.reserve(), (err: unknown) => err instanceof AssetError && err.status === 502);
    const throwing = new SerpApiAccount("k", async () => {
      throw new Error("ECONNRESET https://serpapi.com/account.json?api_key=k");
    });
    await assert.rejects(throwing.reserve(), (err: unknown) => {
      // The transport error (which may quote the URL, key included) is not passed on.
      return err instanceof AssetError && err.cause === undefined && !String(err.message).includes("api_key");
    });
  });
});
