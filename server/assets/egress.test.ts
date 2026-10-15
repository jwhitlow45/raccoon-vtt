import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, test } from "node:test";

/**
 * The strict port's host list lives in docker/squid.conf, outside any code
 * a test runs, so this reads the file itself. A host added there by mistake
 * would let the app reach it with no review of why.
 */
describe("squid's strict port", () => {
  test("reaches exactly the two image searches and Turnstile", async () => {
    const conf = await readFile(new URL("../../docker/squid.conf", import.meta.url), "utf8");
    const lines = conf.split("\n").filter((l) => /^acl strict_hosts /.test(l));
    assert.equal(lines.length, 1);
    const hosts = lines[0]!.trim().split(/\s+/).slice(3);
    assert.deepEqual(hosts.sort(), ["api.openverse.org", "challenges.cloudflare.com", "serpapi.com"]);
    assert.match(conf, /^http_access allow strict_port strict_hosts$/m);
  });
});
