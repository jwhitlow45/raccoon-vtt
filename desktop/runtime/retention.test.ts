import assert from "node:assert/strict";
import { test } from "node:test";
import { KEEP_BEFORE_UPDATE, KEEP_RECENT, retention, unlistedStoreFiles, type Kept } from "./retention.ts";

/** Backup retention (docs/design/design-v1-local-app.md 8.2). */

const DAY = 24 * 3600 * 1000;
const NOW = Date.parse("2026-11-13T12:00:00Z");

function daily(daysAgo: number, kind: Kept["kind"] = "daily"): Kept {
  return { name: `${kind}-${String(daysAgo).padStart(3, "0")}`, kind, started: NOW - daysAgo * DAY };
}

test("the newest 7 daily or by-hand backups are kept", () => {
  const backups = Array.from({ length: 10 }, (_, i) => daily(i * 0.1, i % 2 ? "manual" : "daily"));
  const { keep, drop } = retention(backups, NOW);
  assert.equal(KEEP_RECENT, 7);
  assert.deepEqual([...keep].sort(), backups.slice(0, 7).map((b) => b.name).sort());
  assert.deepEqual(drop.sort(), backups.slice(7).map((b) => b.name).sort());
});

test("the newest of each of the last 4 weeks is kept beside them", () => {
  const recent = Array.from({ length: 7 }, (_, i) => daily(i * 0.1));
  const older = [daily(8), daily(9), daily(15), daily(16), daily(22), daily(29), daily(40)];
  const { keep, drop } = retention([...recent, ...older], NOW);
  // Week 0 is covered by the recent ones. Weeks 1, 2 and 3 keep their newest. Week 4 and later go.
  for (const b of recent) assert.ok(keep.has(b.name));
  assert.ok(keep.has(daily(8).name));
  assert.ok(keep.has(daily(15).name));
  assert.ok(keep.has(daily(22).name));
  assert.deepEqual(drop.sort(), [daily(9).name, daily(16).name, daily(29).name, daily(40).name].sort());
});

test("before-update backups are kept apart: the newest 3, whatever the daily ones do", () => {
  const regular = Array.from({ length: 9 }, (_, i) => daily(i * 0.01));
  const updates = Array.from({ length: 5 }, (_, i) => daily(30 + i, "before-update"));
  const { keep } = retention([...regular, ...updates], NOW);
  assert.equal(KEEP_BEFORE_UPDATE, 3);
  for (const b of updates.slice(0, 3)) assert.ok(keep.has(b.name), b.name);
  for (const b of updates.slice(3)) assert.ok(!keep.has(b.name), b.name);
  // They never take a place from the daily ones.
  for (const b of regular.slice(0, 7)) assert.ok(keep.has(b.name), b.name);
});

test("a run of updates never pushes out the daily backups, nor the other way round", () => {
  const updates = Array.from({ length: 10 }, (_, i) => daily(i * 0.01, "before-update"));
  const regular = Array.from({ length: 7 }, (_, i) => daily(1 + i * 0.1));
  const { keep } = retention([...updates, ...regular], NOW);
  for (const b of regular) assert.ok(keep.has(b.name));
  assert.equal(updates.filter((b) => keep.has(b.name)).length, 3);
});

test("store files no kept list names are the ones to delete", () => {
  const out = unlistedStoreFiles(["aa/1.webp", "bb/2.webp", "cc/3.webp"], [["aa/1.webp"], ["cc/3.webp", "dd/4.webp"]]);
  assert.deepEqual(out, ["bb/2.webp"]);
  assert.deepEqual(unlistedStoreFiles(["aa/1.webp"], []), ["aa/1.webp"]);
});
