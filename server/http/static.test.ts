import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import Fastify, { type FastifyInstance } from "fastify";
import { IMMUTABLE, registerStatic } from "./static.ts";

describe("the built SPA", () => {
  let dist: string;
  let app: FastifyInstance;

  before(async () => {
    dist = await mkdtemp(join(tmpdir(), "rvtt-static-"));
    await mkdir(join(dist, "game-icons", "82d94881", "lorc"), { recursive: true });
    await writeFile(join(dist, "index.html"), "<!doctype html><title>RaccoonVTT</title>");
    await writeFile(join(dist, "app.js"), "export {};");
    await writeFile(join(dist, "game-icons", "82d94881", "lorc", "wolf-head.svg"), '<svg xmlns="http://www.w3.org/2000/svg"/>');
    await writeFile(join(dist, "game-icons", "82d94881", "index.json"), "{}");
    await mkdir(join(dist, "fonts"));
    await writeFile(join(dist, "fonts", "InterVariable-8a540aa8.woff2"), "wOF2");
    await writeFile(join(dist, "fonts", "Inter-LICENSE.txt"), "SIL Open Font License");
    await mkdir(join(dist, "starter", "test-pack", "thumbs"), { recursive: true });
    await writeFile(join(dist, "starter", "test-pack", "knight.webp"), "RIFF knight");
    await writeFile(join(dist, "starter", "test-pack", "thumbs", "knight.webp"), "RIFF thumb");
    app = Fastify();
    await registerStatic(app, dist);
  });

  after(async () => {
    await app.close();
    await rm(dist, { recursive: true, force: true });
  });

  test("a token icon and the icon index are cached for good, since a new pin is a new folder", async () => {
    for (const url of ["/game-icons/82d94881/lorc/wolf-head.svg", "/game-icons/82d94881/index.json"]) {
      const res = await app.inject({ method: "GET", url });
      assert.equal(res.statusCode, 200, url);
      assert.equal(res.headers["cache-control"], IMMUTABLE, url);
    }
  });

  test("the interface font, named for its hash, is cached for good, so a reload's preload of it is used", async () => {
    const res = await app.inject({ method: "GET", url: "/fonts/InterVariable-8a540aa8.woff2" });
    assert.equal(res.statusCode, 200);
    assert.equal(res.headers["cache-control"], IMMUTABLE);
  });

  test("other files keep the default revalidation", async () => {
    for (const url of ["/app.js", "/fonts/Inter-LICENSE.txt"]) {
      const res = await app.inject({ method: "GET", url });
      assert.equal(res.statusCode, 200, url);
      assert.notEqual(res.headers["cache-control"], IMMUTABLE, url);
    }
  });

  test("an icon the build does not have is a 404, never the page", async () => {
    const res = await app.inject({ method: "GET", url: "/game-icons/82d94881/lorc/no-such-icon.svg" });
    assert.equal(res.statusCode, 404);
    assert.deepEqual(res.json(), { error: "not_found" });
  });

  /**
   * A dot segment spelled with escapes is resolved before routing (WHATWG
   * URL parsing), so "/game-icons/%2e%2e/app.js" is the build's own app.js,
   * served as any request for it is. What matters is that the icons' route,
   * whose answers are cached for good, never serves a file outside its
   * folder, and lists none.
   */
  test("the icons' route serves nothing outside their folder, and lists none of it", async () => {
    for (const url of ["/game-icons/82d94881/", "/game-icons/%2e%2e/index.html", "/game-icons/%2e%2e/app.js", "/game-icons/..%2fapp.js", "/game-icons/82d94881/lorc/..%2f..%2f..%2fapp.js"]) {
      const res = await app.inject({ method: "GET", url });
      assert.notEqual(res.headers["cache-control"], IMMUTABLE, url);
    }
    const listing = await app.inject({ method: "GET", url: "/game-icons/82d94881/" });
    assert.equal(listing.statusCode, 404);
    assert.doesNotMatch(listing.body, /wolf-head/);
  });

  test("a starter work and its thumbnail are served from one route, revalidated, since a rebuilt file keeps its name", async () => {
    for (const [url, body] of [["/starter/test-pack/knight.webp", "RIFF knight"], ["/starter/test-pack/thumbs/knight.webp", "RIFF thumb"]] as const) {
      const res = await app.inject({ method: "GET", url });
      assert.equal(res.statusCode, 200, url);
      assert.equal(res.body, body, url);
      assert.notEqual(res.headers["cache-control"], IMMUTABLE, url);
    }
  });

  test("a starter file the build does not have is a 404, never the page, and the route lists nothing", async () => {
    for (const url of ["/starter/test-pack/owlbear.webp", "/starter/test-pack/", "/starter/"]) {
      const res = await app.inject({ method: "GET", url });
      assert.equal(res.statusCode, 404, url);
      assert.doesNotMatch(res.body, /RaccoonVTT|knight/, url);
    }
  });

  test("client routes still load the page", async () => {
    const res = await app.inject({ method: "GET", url: "/r/K7QH-2MXA" });
    assert.equal(res.statusCode, 200);
    assert.match(res.body, /RaccoonVTT/);
  });
});
