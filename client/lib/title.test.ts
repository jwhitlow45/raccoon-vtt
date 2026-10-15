import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { APP_TITLE, roomTitle } from "./title.ts";

describe("the browser tab title", () => {
  test("is the plain app name outside a room", () => {
    assert.equal(APP_TITLE, "RaccoonVTT");
  });

  test("names the room after a middle dot", () => {
    assert.equal(roomTitle("Curse of the Crypt"), "RaccoonVTT · Curse of the Crypt");
  });

  test("trims the room name", () => {
    assert.equal(roomTitle("  Crypt "), "RaccoonVTT · Crypt");
  });

  test("stays plain until the room's name is known", () => {
    assert.equal(roomTitle(""), APP_TITLE);
    assert.equal(roomTitle("   "), APP_TITLE);
    assert.equal(roomTitle(null), APP_TITLE);
    assert.equal(roomTitle(undefined), APP_TITLE);
  });
});
