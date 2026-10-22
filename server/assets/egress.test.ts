import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import net from "node:net";
import { describe, test } from "node:test";
import { request } from "undici";
import { createEgress } from "./egress.ts";

/**
 * The strict port's host list lives in docker/squid.conf, outside any code
 * a test runs, so this reads the file itself. A host added there by mistake
 * would let the app reach it with no review of why.
 */
describe("squid's strict port", () => {
  test("reaches exactly the two image searches, Turnstile and D&D Beyond's character service", async () => {
    const conf = await readFile(new URL("../../docker/squid.conf", import.meta.url), "utf8");
    const lines = conf.split("\n").filter((l) => /^acl strict_hosts /.test(l));
    assert.equal(lines.length, 1);
    const hosts = lines[0]!.trim().split(/\s+/).slice(3);
    assert.deepEqual(hosts.sort(), ["api.openverse.org", "challenges.cloudflare.com", "character-service.dndbeyond.com", "serpapi.com"]);
    assert.match(conf, /^http_access allow strict_port strict_hosts$/m);
  });

  test("the update recipe restarts squid, which reads the list only at start and is not recreated when the file changes", async () => {
    const readme = await readFile(new URL("../../README.md", import.meta.url), "utf8");
    const updating = readme.slice(readme.indexOf("## Updating"));
    const recipe = /```bash\n([\s\S]*?)```/.exec(updating)?.[1] ?? "";
    const lines = recipe.trim().split("\n");
    assert.equal(lines.at(-2), "docker compose -f docker-compose.server.yml up -d --build");
    assert.equal(lines.at(-1), "docker compose -f docker-compose.server.yml restart egress");
  });
});

describe("a proxy that takes a CONNECT and never answers it", () => {
  test("a request on either port fails near the limit, the next one reaches the proxy, and close resolves", { timeout: 15_000 }, async () => {
    let connects = 0;
    const sockets: net.Socket[] = [];
    const proxy = net.createServer((socket) => {
      sockets.push(socket);
      socket.on("error", () => undefined);
      socket.on("data", (chunk) => {
        if (String(chunk).startsWith("CONNECT")) connects++;
      });
    });
    await new Promise<void>((resolve) => proxy.listen(0, "127.0.0.1", resolve));
    const { port } = proxy.address() as net.AddressInfo;
    const uri = `http://127.0.0.1:${port}`;
    const egress = createEgress({ production: false, EGRESS_PUBLIC_PROXY: uri, EGRESS_STRICT_PROXY: uri }, { connectAnswerMs: 300 });
    const timedOut = (err: unknown) => (err as { code?: string }).code === "UND_ERR_HEADERS_TIMEOUT";
    try {
      const started = Date.now();
      await Promise.all([
        assert.rejects(request("https://example.com/a", { dispatcher: egress.public }), timedOut),
        assert.rejects(request("https://example.com/b", { dispatcher: egress.strict }), timedOut),
      ]);
      const took = Date.now() - started;
      assert.ok(took >= 250 && took < 5_000, `failed after ${took} ms`);
      assert.equal(connects, 2);
      // Nothing queues behind the stuck CONNECT: the next request on the same port reaches the proxy.
      await assert.rejects(request("https://example.com/c", { dispatcher: egress.public }), timedOut);
      assert.equal(connects, 3);
      const closed = await Promise.race([egress.close().then(() => true), new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 3_000))]);
      assert.ok(closed, "close resolves");
    } finally {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => proxy.close(() => resolve()));
    }
  });
});
