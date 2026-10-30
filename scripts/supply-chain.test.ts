import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const root = new URL("../", import.meta.url);

test("CI's PostgreSQL services use docker-compose.yml's pinned digest", () => {
  const compose = readFileSync(new URL("docker-compose.yml", root), "utf8");
  const pinned = /image:\s+(?:&[\w-]+\s+)?postgres:[^\s@]+@(sha256:[0-9a-f]{64})/.exec(compose)?.[1];
  assert.ok(pinned, "docker-compose.yml must pin a PostgreSQL image digest");
  const ci = readFileSync(new URL(".github/workflows/ci.yml", root), "utf8");
  const images = [...ci.matchAll(/^\s+image: (postgres:\S+)$/gm)].map((m) => m[1]!);
  assert.ok(images.length > 0, "CI must declare PostgreSQL service images");
  for (const image of images) {
    assert.equal(image.split("@")[1], pinned, "update ci.yml's PostgreSQL service images after a Compose image bump");
  }
});
