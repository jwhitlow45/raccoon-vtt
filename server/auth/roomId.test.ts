import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { dmLink, formatRoomId, inviteLink, newRoomId, parseRoomId } from "./roomId.ts";

describe("room ids", () => {
  test("new ids are 8 Crockford base32 characters", () => {
    for (let i = 0; i < 200; i++) {
      assert.match(newRoomId(), /^[0-9A-HJKMNP-TV-Z]{8}$/);
    }
  });

  test("new ids do not repeat", () => {
    const ids = new Set(Array.from({ length: 1000 }, newRoomId));
    assert.equal(ids.size, 1000);
  });

  test("parsing accepts the shown form, any case, and Crockford's look-alikes", () => {
    assert.equal(parseRoomId("K7QH-2MXA"), "K7QH2MXA");
    assert.equal(parseRoomId("k7qh2mxa"), "K7QH2MXA");
    assert.equal(parseRoomId("O1IL-0000"), "0111" + "0000");
  });

  test("parsing refuses anything that cannot be an id", () => {
    for (const bad of ["", "K7QH2MX", "K7QH2MXAB", "K7QH-2MXU", "K7QH 2MXA", "../../etc", 42, undefined, "A".repeat(40)]) {
      assert.equal(parseRoomId(bad), null, String(bad));
    }
  });

  test("links use the shown form and keep the secret in the fragment", () => {
    assert.equal(formatRoomId("K7QH2MXA"), "K7QH-2MXA");
    assert.equal(dmLink("K7QH2MXA", "abc"), "/r/K7QH-2MXA#dm=abc");
    assert.equal(inviteLink("K7QH2MXA", "abc"), "/r/K7QH-2MXA#invite=abc");
  });
});
