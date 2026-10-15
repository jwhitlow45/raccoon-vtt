import assert from "node:assert/strict";
import { test } from "node:test";
import { formatDisplayCode, isDisplayMemberId, newDisplayCode, newDisplayMemberId, parseDisplayCode } from "./displaySessions.ts";

test("a display code is 10 Crockford characters, and random", () => {
  const seen = new Set<string>();
  for (let i = 0; i < 200; i++) {
    const code = newDisplayCode();
    assert.match(code, /^[0-9A-HJKMNP-TV-Z]{10}$/);
    seen.add(code);
  }
  assert.equal(seen.size, 200);
});

test("a code typed with a remote reads back as the code", () => {
  assert.equal(formatDisplayCode("K7QH2MXA4F"), "K7QH 2MXA 4F");
  assert.equal(parseDisplayCode("K7QH 2MXA 4F"), "K7QH2MXA4F");
  assert.equal(parseDisplayCode("k7qh-2mxa-4f"), "K7QH2MXA4F");
  // Crockford's decoding: I and L read as 1, O as 0.
  assert.equal(parseDisplayCode("IL0O 2MXA 4F"), "11002MXA4F");
  assert.equal(parseDisplayCode("K7QH2MXA4"), null);
  assert.equal(parseDisplayCode("K7QH2MXA4FF"), null);
  assert.equal(parseDisplayCode("K7QH2MXA4U"), null);
  assert.equal(parseDisplayCode(`${"K".repeat(10)}${" ".repeat(40)}`), null);
});

test("a display's member id is one no member can have", () => {
  const id = newDisplayMemberId();
  assert.match(id, /^display:[A-Za-z0-9_-]{12}$/);
  assert.ok(isDisplayMemberId(id));
  assert.equal(isDisplayMemberId("0192f1d6-7a0c-7cc2-8a1e-4a7b6c5d4e3f"), false);
});
