/// <reference types="node" />
import assert from "node:assert/strict";
import test from "node:test";
import { formatDate, formatRelative, formatSize, formatWhen } from "./format.ts";

// Local noon, so a day boundary never falls inside a case whatever the test machine's zone.
const NOW = new Date(2026, 10, 13, 12, 0, 0);
const at = (y: number, mo: number, d: number, h: number, mi = 0) => new Date(y, mo - 1, d, h, mi).toISOString();

test("formatWhen says today, yesterday, then a date", () => {
  assert.equal(formatWhen(at(2026, 11, 13, 19, 42), NOW), "today at 7:42 PM");
  assert.equal(formatWhen(at(2026, 11, 12, 8, 5), NOW), "yesterday at 8:05 AM");
  assert.equal(formatWhen(at(2026, 11, 9, 19, 42), NOW), "Nov 9 at 7:42 PM");
  assert.equal(formatWhen(at(2025, 12, 30, 9, 0), NOW), "Dec 30, 2025 at 9:00 AM");
});

test("formatDate never says today", () => {
  assert.equal(formatDate(at(2026, 11, 13, 7, 42), NOW), "Nov 13 at 7:42 AM");
});

test("formatRelative steps from minutes to a date", () => {
  assert.equal(formatRelative(new Date(NOW.getTime() - 10_000).toISOString(), NOW), "just now");
  assert.equal(formatRelative(new Date(NOW.getTime() - 60_000).toISOString(), NOW), "1 minute ago");
  assert.equal(formatRelative(new Date(NOW.getTime() - 5 * 60_000).toISOString(), NOW), "5 minutes ago");
  assert.equal(formatRelative(at(2026, 11, 13, 9, 0), NOW), "3 hours ago");
  assert.equal(formatRelative(at(2026, 11, 12, 23, 0), NOW), "yesterday");
  assert.equal(formatRelative(at(2026, 11, 10, 10, 0), NOW), "3 days ago");
  assert.equal(formatRelative(at(2026, 10, 1, 10, 0), NOW), "Oct 1");
});

test("formatSize rounds up", () => {
  assert.equal(formatSize(512), "512 bytes");
  assert.equal(formatSize(1_234), "1.3 KB");
  assert.equal(formatSize(1_400_000_000), "1.4 GB");
  assert.equal(formatSize(52_100_000), "53 MB");
});
