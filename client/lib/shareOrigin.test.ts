import assert from "node:assert/strict";
import { test } from "node:test";
import { refreshDue, shareOriginOf, SHARE_POLL_MS, type ShareView } from "./shareOrigin.ts";

const local = (shareOrigin: string | null): ShareView => ({ local: { shareOrigin, createHere: true, hostPage: null }, fetchedAt: 1000 });

test("a hosted server and an unanswered ask give the page's own origin", () => {
  assert.equal(shareOriginOf(null, "https://vtt.example"), "https://vtt.example");
  assert.equal(shareOriginOf({ local: null, fetchedAt: 0 }, "https://vtt.example"), "https://vtt.example");
});

test("the app's network address wins over the page's origin", () => {
  assert.equal(shareOriginOf(local("http://10.0.0.5:3170"), "http://localhost:3170"), "http://10.0.0.5:3170");
});

test("with the switch off the page's origin stands", () => {
  assert.equal(shareOriginOf(local(null), "http://localhost:3170"), "http://localhost:3170");
});

test("the first ask is always due, a hosted answer never is", () => {
  assert.equal(refreshDue(null, 0), true);
  assert.equal(refreshDue({ local: null, fetchedAt: 0 }, 10 ** 9), false);
});

test("a local answer is asked again after 5 s and not before", () => {
  assert.equal(refreshDue(local(null), 1000 + SHARE_POLL_MS - 1), false);
  assert.equal(refreshDue(local(null), 1000 + SHARE_POLL_MS), true);
});
