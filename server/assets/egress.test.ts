import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, test } from "node:test";

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
