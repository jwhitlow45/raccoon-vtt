import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { playerLink } from "#shared/playerLink.ts";
import { joinLinkToShare, passwordOfLink } from "./shareLink.ts";

describe("the join link a device shares", () => {
  const origin = "https://vtt.example.com";

  test("a DM who can see the player link copies it, password and all", () => {
    const share = joinLinkToShare({ roomId: "K7QH2MXA", origin, playerLink: playerLink("K7QH2MXA", "owl-bear.wand!") });
    assert.equal(share.url, "https://vtt.example.com/r/K7QH-2MXA#pw=owl-bear%2Ewand%21");
    assert.equal(share.label, "Copy player link");
    assert.equal(share.withPassword, true);
  });

  test("players, and a DM without a stored password, copy the plain room link", () => {
    const share = joinLinkToShare({ roomId: "K7QH2MXA", origin, playerLink: null });
    assert.deepEqual(share, { url: "https://vtt.example.com/r/K7QH-2MXA", label: "Copy join link", withPassword: false });
  });

  test("the password comes back out of a player link exactly", () => {
    for (const password of ["owlbear-druid-wand", "a b&c#d%e", "ünï 🐉"]) {
      assert.equal(passwordOfLink(playerLink("K7QH2MXA", password)), password);
    }
    assert.equal(passwordOfLink("/r/K7QH-2MXA"), null);
  });
});
