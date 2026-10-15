import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { MockAgent } from "undici";
import { setTurnstileDispatcherForTests, verifyTurnstile } from "./turnstile.ts";

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
