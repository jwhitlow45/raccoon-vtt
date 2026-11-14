import assert from "node:assert/strict";
import { test } from "node:test";
import type { VersionStamp } from "../contract.ts";
import { judge, readable, type Build } from "./versionGuard.ts";

/** The start's version checks (docs/design/design-v1-local-app.md 8.4). */

const BUILD: Build = { app: "0.5.0", snapshotVersion: 46, opVersion: 60, pgMajor: 17 };
const stamp = (over: Partial<VersionStamp> = {}): VersionStamp => ({
  app: "0.5.0",
  snapshotVersion: 46,
  opVersion: 60,
  pgMajor: 17,
  writtenAt: "2026-11-13T12:00:00.000Z",
  ...over,
});

test("no stamp and no rooms: a new database", () => {
  assert.deepEqual(judge(null, true, BUILD), { kind: "new" });
});

test("no stamp beside rooms: nothing says which build wrote them", () => {
  assert.deepEqual(judge(null, false, BUILD), { kind: "noStamp" });
});

test("this build's stamp: start", () => {
  assert.deepEqual(judge(stamp(), false, BUILD), { kind: "current" });
});

test("a restored stamp, this build's version with older formats: start, with no backup first", () => {
  assert.deepEqual(judge(stamp({ snapshotVersion: 40, opVersion: 50 }), false, BUILD), { kind: "current" });
});

test("another version in formats this build reads: back up before the update", () => {
  assert.deepEqual(judge(stamp({ app: "0.4.2", snapshotVersion: 44, opVersion: 58 }), false, BUILD), { kind: "update", dataApp: "0.4.2" });
  // An older build over the same formats starts too, after its backup.
  assert.deepEqual(judge(stamp({ app: "0.6.0" }), false, BUILD), { kind: "update", dataApp: "0.6.0" });
});

test("a newer room format or a newer change format is refused", () => {
  assert.deepEqual(judge(stamp({ app: "0.6.0", snapshotVersion: 47 }), false, BUILD), { kind: "newer", dataApp: "0.6.0" });
  assert.deepEqual(judge(stamp({ app: "0.6.0", opVersion: 61 }), false, BUILD), { kind: "newer", dataApp: "0.6.0" });
  // Newer formats are refused even when the version string matches this build's.
  assert.deepEqual(judge(stamp({ opVersion: 61 }), true, BUILD), { kind: "newer", dataApp: "0.5.0" });
});

test("a backup is readable when neither format is newer than this build's", () => {
  assert.equal(readable({ snapshotVersion: 46, opVersion: 60 }, BUILD), true);
  assert.equal(readable({ snapshotVersion: 30, opVersion: 20 }, BUILD), true);
  assert.equal(readable({ snapshotVersion: 47, opVersion: 60 }, BUILD), false);
  assert.equal(readable({ snapshotVersion: 46, opVersion: 61 }, BUILD), false);
});
