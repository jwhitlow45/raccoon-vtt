import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { memberRow } from "./memberRow.ts";

describe("memberRow (LPD-REGRESS-2)", () => {
  test("your own row says it in the detail line, so the name and (you) keep the room", () => {
    assert.deepEqual(memberRow({ kind: "player", own: true, online: true }), { detail: "Player · Online", tag: null });
    assert.deepEqual(memberRow({ kind: "dm", own: true, online: true }), { detail: "DM · Online", tag: null });
    assert.deepEqual(memberRow({ kind: "dm", own: true, online: false }), { detail: "DM · Offline", tag: null });
  });

  test("everyone else's row keeps the tag", () => {
    assert.deepEqual(memberRow({ kind: "player", own: false, online: true }), { detail: "Player", tag: "Online" });
    assert.deepEqual(memberRow({ kind: "dm", own: false, online: false }), { detail: "DM", tag: "Offline" });
  });
});
