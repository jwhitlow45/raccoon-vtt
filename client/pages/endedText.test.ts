import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { endedText } from "./endedText.ts";

describe("what a closed room says", () => {
  test("a DM device is sent back to the DM link, not only to the player password", () => {
    for (const kind of ["revoked", "denied"] as const) {
      const text = endedText(kind, "dm");
      assert.equal(text.dmLink, true, kind);
      assert.match(text.body, /DM link/, kind);
      assert.doesNotMatch(text.body, /password/, kind);
      assert.equal(text.rejoin, "Join as a player");
    }
  });

  test("a player is sent back to the join page", () => {
    for (const kind of ["revoked", "denied"] as const) {
      const text = endedText(kind, "player");
      assert.equal(text.dmLink, false);
      assert.equal(text.rejoin, "Join again");
    }
  });

  test("a deleted room offers no way back in, whoever asks", () => {
    for (const role of ["dm", "player"] as const) {
      assert.deepEqual(endedText("deleted", role), { title: "This room is gone", body: "The DM closed or deleted this room.", rejoin: null, dmLink: false });
    }
  });
});
