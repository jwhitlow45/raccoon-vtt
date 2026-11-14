import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { SecretsDamaged, loadSecrets } from "./secrets.ts";

/** secrets.json (docs/design/design-v1-local-app.md 6.5): made once, readable only by its user, and never replaced when damaged. */

const platform = process.platform === "win32" ? "win32" : process.platform === "darwin" ? "darwin" : "linux";
let dir: string;
before(async () => {
  dir = await mkdtemp(join(tmpdir(), "rvtt-secrets-"));
});
after(async () => {
  await rm(dir, { recursive: true, force: true });
});

test("the first start makes both secrets, and later starts read the same ones", async () => {
  const file = join(dir, "first.json");
  const made = await loadSecrets(file, platform);
  assert.equal(Buffer.from(made.roomSecretKey, "base64").length, 32);
  assert.match(made.databasePassword, /^[0-9a-f]{64}$/);
  assert.deepEqual(await loadSecrets(file, platform), made);
});

test("secrets.json is readable by its user alone", { skip: platform === "win32" && "Windows keeps the profile's ACL" }, async () => {
  const file = join(dir, "mode.json");
  await loadSecrets(file, platform);
  assert.equal((await stat(file)).mode & 0o777, 0o600);
  // A copy put back by hand with wider access is narrowed again at the next start.
  await chmod(file, 0o644);
  await loadSecrets(file, platform);
  assert.equal((await stat(file)).mode & 0o777, 0o600);
});

test("a damaged file stops the start and is left as it was", async () => {
  const file = join(dir, "damaged.json");
  await writeFile(file, '{"roomSecretKey": "short"}');
  await assert.rejects(loadSecrets(file, platform), SecretsDamaged);
  assert.equal(await readFile(file, "utf8"), '{"roomSecretKey": "short"}');
  await writeFile(file, "not json");
  await assert.rejects(loadSecrets(file, platform), SecretsDamaged);
});

test("a missing file beside an existing database stops the start the same way, and nothing is written", async () => {
  const file = join(dir, "missing.json");
  await assert.rejects(loadSecrets(file, platform, true), (err: Error) => err instanceof SecretsDamaged && err.message === "secrets.json can't be read");
  await assert.rejects(readFile(file, "utf8"), { code: "ENOENT" });
  // With no database yet, it is a first start.
  assert.ok(await loadSecrets(file, platform, false));
});
