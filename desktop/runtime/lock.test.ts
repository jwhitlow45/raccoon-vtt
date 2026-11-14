import assert from "node:assert/strict";
import { test } from "node:test";
import { guardPath, lockLocation, type LocationDeps } from "./lock.ts";

/**
 * Where the lock lives (docs/design/design-v1-local-app.md 8.1,
 * D-261113-092, 105): a per-user folder no caller's environment can move,
 * a fallback under the home folder when that folder is missing, not
 * private, or would make the socket's path too long, and words instead of a
 * lock when even the fallback is too long. The processes themselves are in
 * lock.itest.ts.
 */

const HASH = "0123456789abcdef";
const made: string[] = [];

function deps(over: Partial<LocationDeps> & Pick<LocationDeps, "platform">): LocationDeps {
  return {
    uid: 1000,
    home: "/home/dm",
    ownPrivateDir: () => true,
    makeFallbackDir: (dir) => made.push(dir),
    ...over,
  };
}

test("Linux uses /run/user/<uid> by its fixed name when it is the user's own", () => {
  const seen: string[] = [];
  const at = lockLocation(HASH, deps({ platform: "linux", ownPrivateDir: (dir) => (seen.push(dir), true) }));
  assert.deepEqual(at, { path: "/run/user/1000/raccoonvtt-0123456789abcdef.sock" });
  assert.equal(seen[0], "/run/user/1000");
});

test("Linux falls back to ~/.cache/RaccoonVTT when /run/user/<uid> is missing or open to others", () => {
  made.length = 0;
  const at = lockLocation(HASH, deps({ platform: "linux", ownPrivateDir: (dir) => dir !== "/run/user/1000" }));
  assert.deepEqual(at, { path: "/home/dm/.cache/RaccoonVTT/raccoonvtt-0123456789abcdef.sock" });
  assert.deepEqual(made, ["/home/dm/.cache/RaccoonVTT"]);
});

test("a socket path past 107 bytes on Linux falls back to the home folder", () => {
  const long = `/run/${"x".repeat(80)}`;
  const at = lockLocation(HASH, deps({ platform: "linux", runtimeDir: () => long }));
  assert.deepEqual(at, { path: "/home/dm/.cache/RaccoonVTT/raccoonvtt-0123456789abcdef.sock" });
  // 107 bytes exactly still fits.
  const name = "/raccoonvtt-0123456789abcdef.sock";
  const exact = `/r${"y".repeat(107 - name.length - 2)}`;
  assert.equal(Buffer.byteLength(exact + name), 107);
  assert.deepEqual(lockLocation(HASH, deps({ platform: "linux", runtimeDir: () => exact })), { path: exact + name });
});

test("macOS uses its per-user temp folder, up to 103 bytes", () => {
  const name = "/raccoonvtt-0123456789abcdef.sock";
  const fits = `/usertemp/${"a".repeat(103 - name.length - "/usertemp/".length)}`;
  assert.deepEqual(lockLocation(HASH, deps({ platform: "darwin", runtimeDir: () => fits })), { path: fits + name });
  const over = `${fits}b`;
  assert.deepEqual(lockLocation(HASH, deps({ platform: "darwin", home: "/Volumes/home/dm", runtimeDir: () => over })), {
    path: "/Volumes/home/dm/.cache/RaccoonVTT/raccoonvtt-0123456789abcdef.sock",
  });
  assert.deepEqual(lockLocation(HASH, deps({ platform: "darwin", home: "/Volumes/home/dm", runtimeDir: () => null })), {
    path: "/Volumes/home/dm/.cache/RaccoonVTT/raccoonvtt-0123456789abcdef.sock",
  });
});

test("a home folder too long for even the fallback stops with words, and makes no folder", () => {
  made.length = 0;
  const home = `/home/${"z".repeat(90)}`;
  assert.deepEqual(lockLocation(HASH, deps({ platform: "linux", home, ownPrivateDir: () => false })), { error: "pathTooLong" });
  assert.deepEqual(made, []);
});

test("a fallback folder that is not the user's own is refused, never used", () => {
  assert.throws(() => lockLocation(HASH, deps({ platform: "linux", ownPrivateDir: () => false })), /must belong to this user/);
});

test("Windows uses a named pipe, which Windows removes with its owner", () => {
  assert.deepEqual(lockLocation(HASH, deps({ platform: "win32" })), { path: "\\\\.\\pipe\\raccoonvtt-0123456789abcdef" });
});

test("the guard sits beside the socket", () => {
  assert.equal(guardPath("/run/user/1000/raccoonvtt-0123456789abcdef.sock"), "/run/user/1000/raccoonvtt-0123456789abcdef.sock.recover");
});
