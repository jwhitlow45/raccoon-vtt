import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkDatabaseDisk, loadConfig } from "./config.ts";

const base = { NODE_ENV: "test", DATABASE_URL: "postgres://x@localhost/x" };

describe("loadConfig", () => {
  test("PUBLIC_ORIGIN becomes the exact origin a browser sends", () => {
    assert.equal(loadConfig({ ...base, PUBLIC_ORIGIN: "https://vtt.example.com/" }).publicOrigin, "https://vtt.example.com");
    assert.equal(loadConfig({ ...base, PUBLIC_ORIGIN: "https://VTT.Example.com:443" }).publicOrigin, "https://vtt.example.com");
    assert.equal(loadConfig({ ...base, PUBLIC_ORIGIN: "http://localhost:5173" }).publicOrigin, "http://localhost:5173");
    assert.equal(loadConfig(base).publicOrigin, "http://localhost:5173");
  });

  test("a PUBLIC_ORIGIN with a path, query or credentials stops the boot", () => {
    for (const value of ["https://vtt.example.com/vtt", "https://vtt.example.com/?x=1", "https://j:pw@vtt.example.com", "ftp://vtt.example.com"]) {
      assert.throws(() => loadConfig({ ...base, PUBLIC_ORIGIN: value }), /PUBLIC_ORIGIN/, value);
    }
  });

  test("Turnstile needs both keys or neither", () => {
    assert.throws(() => loadConfig({ ...base, TURNSTILE_SECRET: "s" }), /TURNSTILE/);
    assert.throws(() => loadConfig({ ...base, TURNSTILE_SITE_KEY: "k" }), /TURNSTILE/);
    assert.doesNotThrow(() => loadConfig({ ...base, TURNSTILE_SECRET: "s", TURNSTILE_SITE_KEY: "k" }));
    assert.doesNotThrow(() => loadConfig(base));
  });

  test("the admin password is an argon2id hash or nothing, and an empty value is nothing (docs/design-v1-dm-tools.md 3.18)", () => {
    const hash = "$argon2id$v=19$m=19456,t=2,p=1$c2FsdHNhbHRzYWx0$aGFzaGhhc2hoYXNoaGFzaGhhc2hoYXNoaGFzaGhhc2g";
    assert.equal(loadConfig({ ...base, ADMIN_PASSWORD_HASH: hash }).ADMIN_PASSWORD_HASH, hash);
    assert.equal(loadConfig({ ...base, ADMIN_PASSWORD_HASH: "" }).ADMIN_PASSWORD_HASH, undefined);
    assert.equal(loadConfig(base).ADMIN_PASSWORD_HASH, undefined);
    assert.throws(() => loadConfig({ ...base, ADMIN_PASSWORD_HASH: "hunter2-hunter2-hunter2" }), /argon2id/);
  });

  test("an Openverse registration needs both halves or neither", () => {
    assert.throws(() => loadConfig({ ...base, OPENVERSE_CLIENT_ID: "id" }), /OPENVERSE/);
    assert.throws(() => loadConfig({ ...base, OPENVERSE_CLIENT_SECRET: "secret" }), /OPENVERSE/);
    assert.doesNotThrow(() => loadConfig({ ...base, OPENVERSE_CLIENT_ID: "", OPENVERSE_CLIENT_SECRET: "" }));
    const c = loadConfig({ ...base, OPENVERSE_CLIENT_ID: "id", OPENVERSE_CLIENT_SECRET: "secret" });
    assert.deepEqual([c.OPENVERSE_CLIENT_ID, c.OPENVERSE_CLIENT_SECRET], ["id", "secret"]);
  });
});

describe("ROOM_SECRET_KEY", () => {
  const production = {
    NODE_ENV: "production",
    DATABASE_URL: "postgres://x@localhost/x",
    PUBLIC_ORIGIN: "https://vtt.example.com",
    EGRESS_STRICT_PROXY: "http://egress:3128",
    EGRESS_PUBLIC_PROXY: "http://egress:3129",
  };
  const key = Buffer.alloc(32, 7).toString("base64");

  test("production refuses to start without it, and says how to make one", () => {
    assert.throws(() => loadConfig(production), /without ROOM_SECRET_KEY.*openssl rand -base64 32/);
    assert.throws(() => loadConfig({ ...production, ROOM_SECRET_KEY: "" }), /without ROOM_SECRET_KEY/);
    assert.deepEqual(loadConfig({ ...production, ROOM_SECRET_KEY: key }).roomSecretKey, Buffer.alloc(32, 7));
  });

  test("a key that is not 32 bytes of base64 stops the boot instead of becoming another key", () => {
    for (const bad of [Buffer.alloc(16).toString("base64"), Buffer.alloc(33).toString("base64"), `${key.slice(0, 10)}!${key.slice(11)}`, "not a key"]) {
      assert.throws(() => loadConfig({ ...base, ROOM_SECRET_KEY: bad }), /ROOM_SECRET_KEY must be 32 random bytes/, bad);
    }
  });

  test("development falls back to a fixed key, and the key's text is not kept in the config", () => {
    const dev = loadConfig(base);
    assert.equal(dev.roomSecretKey.length, 32);
    assert.deepEqual(loadConfig(base).roomSecretKey, dev.roomSecretKey);
    const set = loadConfig({ ...base, ROOM_SECRET_KEY: key });
    assert.ok(!("ROOM_SECRET_KEY" in set));
    assert.ok(!JSON.stringify(set).includes(key));
  });

  test("a DATABASE_DISK_DIR the server cannot measure stops the boot, once, and an unset one checks nothing", () => {
    const dir = mkdtempSync(join(tmpdir(), "rvtt-dbdisk-"));
    try {
      assert.doesNotThrow(() => checkDatabaseDisk(loadConfig({ ...base, DATABASE_DISK_DIR: dir })));
      assert.throws(() => checkDatabaseDisk(loadConfig({ ...base, DATABASE_DISK_DIR: join(dir, "missing") })), /DATABASE_DISK_DIR must be a folder on the database's disk/);
      const measured: string[] = [];
      checkDatabaseDisk(loadConfig(base), (d) => measured.push(d));
      checkDatabaseDisk(loadConfig({ ...base, DATABASE_DISK_DIR: "" }), (d) => measured.push(d));
      assert.deepEqual(measured, [], "unset, and empty as compose passes unset, measure nothing");
      assert.throws(
        () =>
          checkDatabaseDisk({ DATABASE_DISK_DIR: dir }, () => {
            throw Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" });
          }),
        /EACCES/,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
