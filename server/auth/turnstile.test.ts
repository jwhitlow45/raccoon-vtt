import assert from "node:assert/strict";
import net from "node:net";
import { after, before, describe, test } from "node:test";
import { MockAgent } from "undici";
import { setTurnstileConnectAnswerMsForTests, setTurnstileDispatcherForTests, verifyTurnstile } from "./turnstile.ts";

describe("verifyTurnstile", () => {
  let cloudflare: MockAgent;
  before(() => {
    cloudflare = new MockAgent();
    cloudflare.disableNetConnect();
    cloudflare
      .get("https://challenges.cloudflare.com")
      .intercept({ path: "/turnstile/v0/siteverify", method: "POST" })
      .reply(200, (opts) => {
        const token = new URLSearchParams(String(opts.body)).get("response");
        return { success: true, hostname: token === "here" ? "vtt.example.com" : "elsewhere.example.com" };
      })
      .persist();
    setTurnstileDispatcherForTests(cloudflare);
  });
  after(async () => {
    setTurnstileDispatcherForTests(null);
    await cloudflare.close();
  });

  const config = (production: boolean) => ({
    TURNSTILE_SECRET: "secret",
    EGRESS_STRICT_PROXY: undefined,
    production,
    publicOrigin: "https://vtt.example.com",
  });

  test("in production, a token solved on another hostname does not count", async () => {
    assert.equal(await verifyTurnstile(config(true), "here", "203.0.113.5"), "ok");
    assert.equal(await verifyTurnstile(config(true), "there", "203.0.113.5"), "failed");
  });

  test("outside production the hostname is not checked, since test keys report a placeholder", async () => {
    assert.equal(await verifyTurnstile(config(false), "there", "203.0.113.5"), "ok");
  });
});

describe("verifyTurnstile through a proxy that takes a CONNECT and never answers it (review HF22-F6)", () => {
  test("answers unavailable near the strict port's limit, well before its own 10 s, and the next one reaches the proxy", { timeout: 15_000 }, async () => {
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
    // Through turnstile's own dispatcher for the strict port the config names, its limit shortened.
    await setTurnstileConnectAnswerMsForTests(300);
    const config = { TURNSTILE_SECRET: "secret", EGRESS_STRICT_PROXY: `http://127.0.0.1:${port}`, production: false, publicOrigin: "https://vtt.example.com" };
    try {
      const started = Date.now();
      assert.equal(await verifyTurnstile(config, "token", "203.0.113.5"), "unavailable");
      const took = Date.now() - started;
      assert.ok(took >= 250 && took < 5_000, `answered after ${took} ms`);
      assert.equal(connects, 1);
      assert.equal(await verifyTurnstile(config, "token", "203.0.113.5"), "unavailable");
      assert.equal(connects, 2);
    } finally {
      for (const socket of sockets) socket.destroy();
      await setTurnstileConnectAnswerMsForTests(undefined);
      await new Promise<void>((resolve) => proxy.close(() => resolve()));
    }
  });
});
