import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { animatedMapsOn, checkDatabaseDisk, loadConfig, roomSoundOn } from "./config.ts";

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

  test("the admin password is an argon2id hash or nothing, and an empty value is nothing (docs/design/design-v1-dm-tools.md 3.18)", () => {
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

  test("animated maps are off unless ANIMATED_MAPS is 1, and an empty value is off (D-261102-510)", () => {
    assert.equal(animatedMapsOn(loadConfig(base)), false);
    assert.equal(animatedMapsOn(loadConfig({ ...base, ANIMATED_MAPS: "" })), false);
    assert.equal(animatedMapsOn(loadConfig({ ...base, ANIMATED_MAPS: "0" })), false);
    assert.equal(animatedMapsOn(loadConfig({ ...base, ANIMATED_MAPS: "1" })), true);
    for (const value of ["true", "yes", "on", "2"]) assert.throws(() => loadConfig({ ...base, ANIMATED_MAPS: value }), /ANIMATED_MAPS/, value);
  });

  test("sound files are off unless ROOM_SOUND is 1, and an empty value is off (D-261102-513)", () => {
    assert.equal(roomSoundOn(loadConfig(base)), false);
    assert.equal(roomSoundOn(loadConfig({ ...base, ROOM_SOUND: "" })), false);
    assert.equal(roomSoundOn(loadConfig({ ...base, ROOM_SOUND: "0" })), false);
    assert.equal(roomSoundOn(loadConfig({ ...base, ROOM_SOUND: "1" })), true);
    assert.equal(animatedMapsOn(loadConfig({ ...base, ROOM_SOUND: "1" })), false, "the two switches are apart");
    for (const value of ["true", "yes", "on", "2"]) assert.throws(() => loadConfig({ ...base, ROOM_SOUND: value }), /ROOM_SOUND/, value);
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

describe("local mode (docs/design/design-v1-local-app.md 4)", () => {
  const key = Buffer.alloc(32, 9).toString("base64");
  const local = { NODE_ENV: "production", RACCOON_MODE: "local", DATABASE_URL: "postgres://x@localhost/x", ROOM_SECRET_KEY: key, HOST: "127.0.0.1", PORT: "3170" };

  test("hosted defaults are unchanged: no mode, an empty one and `server` are all hosted", () => {
    for (const env of [base, { ...base, RACCOON_MODE: "" }, { ...base, RACCOON_MODE: "server" }]) {
      const c = loadConfig(env);
      assert.equal(c.local, false);
      assert.equal(c.RACCOON_MODE, "server");
      assert.equal(c.publicOrigin, "http://localhost:5173");
    }
    const production = {
      NODE_ENV: "production",
      DATABASE_URL: "postgres://x@localhost/x",
      PUBLIC_ORIGIN: "https://vtt.example.com",
      EGRESS_STRICT_PROXY: "http://egress:3128",
      EGRESS_PUBLIC_PROXY: "http://egress:3129",
      ROOM_SECRET_KEY: key,
    };
    const hosted = loadConfig(production);
    assert.equal(hosted.local, false);
    assert.equal(hosted.production, true);
    assert.equal(hosted.publicOrigin, "https://vtt.example.com");
    // The hosted requirements still stand without the mode.
    assert.throws(() => loadConfig({ ...production, PUBLIC_ORIGIN: undefined }), /without PUBLIC_ORIGIN/);
    assert.throws(() => loadConfig({ ...production, EGRESS_PUBLIC_PROXY: undefined }), /without EGRESS_PUBLIC_PROXY/);
  });

  test("starts as a production build whose origin is localhost on its port, with neither a public origin nor proxies", () => {
    const c = loadConfig(local);
    assert.equal(c.local, true);
    assert.equal(c.production, true);
    assert.equal(c.publicOrigin, "http://localhost:3170");
    assert.deepEqual(c.roomSecretKey, Buffer.alloc(32, 9));
    assert.equal(loadConfig({ ...local, HOST: "0.0.0.0", PORT: "3171" }).publicOrigin, "http://localhost:3171");
    assert.equal(loadConfig({ ...local, PORT: "80" }).publicOrigin, "http://localhost", "a browser sends http's own port as nothing");
  });

  test("needs production, its own room key, and a HOST of 127.0.0.1 or 0.0.0.0", () => {
    assert.throws(() => loadConfig({ ...local, NODE_ENV: "development" }), /NODE_ENV must be production/);
    assert.throws(() => loadConfig({ ...local, NODE_ENV: undefined }), /NODE_ENV must be production/);
    assert.throws(() => loadConfig({ ...local, ROOM_SECRET_KEY: undefined }), /ROOM_SECRET_KEY is required.*openssl rand -base64 32/);
    for (const host of ["::", "10.0.0.5", "localhost", "0.0.0.0 "]) {
      assert.throws(() => loadConfig({ ...local, HOST: host }), /HOST must be 127\.0\.0\.1 .* or 0\.0\.0\.0/, host);
    }
    assert.equal(loadConfig({ ...local, HOST: undefined }).HOST, "127.0.0.1", "the default HOST is loopback, which local mode takes");
  });

  test("refuses each hosted setting, naming it with its reason", () => {
    const refused: Array<[Record<string, string>, RegExp]> = [
      [{ PUBLIC_ORIGIN: "http://localhost:3170" }, /PUBLIC_ORIGIN is refused: local pages open at localhost/],
      [{ TRUST_CF_CONNECTING_IP: "1" }, /TRUST_CF_CONNECTING_IP=1 is refused: a device on the network could claim 127\.0\.0\.1/],
      [{ TURNSTILE_SITE_KEY: "k", TURNSTILE_SECRET: "s" }, /TURNSTILE_SITE_KEY is refused[^]*TURNSTILE_SECRET is refused/],
      [{ ADMIN_PASSWORD_HASH: "$argon2id$v=19$m=19456,t=2,p=1$c2FsdHNhbHRzYWx0$aGFzaGhhc2hoYXNoaGFzaGhhc2hoYXNoaGFzaGhhc2g" }, /ADMIN_PASSWORD_HASH is refused/],
      [{ EGRESS_STRICT_PROXY: "http://egress:3128" }, /EGRESS_STRICT_PROXY is refused: local mode connects directly/],
      [{ EGRESS_PUBLIC_PROXY: "http://egress:3129" }, /EGRESS_PUBLIC_PROXY is refused: local mode connects directly/],
    ];
    for (const [env, message] of refused) assert.throws(() => loadConfig({ ...local, ...env }), message, Object.keys(env).join());
    // Off or empty, as compose passes unset, is not set.
    assert.doesNotThrow(() => loadConfig({ ...local, TRUST_CF_CONNECTING_IP: "0", TURNSTILE_SITE_KEY: "", TURNSTILE_SECRET: "", ADMIN_PASSWORD_HASH: "" }));
  });

  test("lists every problem at once", () => {
    assert.throws(
      () => loadConfig({ ...local, HOST: "::", PUBLIC_ORIGIN: "https://vtt.example.com", TRUST_CF_CONNECTING_IP: "1" }),
      (err: Error) => err.message.split("\n").length === 4 && /HOST/.test(err.message) && /PUBLIC_ORIGIN/.test(err.message) && /TRUST_CF/.test(err.message),
    );
  });
});
