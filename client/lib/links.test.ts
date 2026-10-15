import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { parseClaimInput, parseFragment } from "./links.ts";
import { formatRoomId, parseRoomId, parseRoomInput, roomPath } from "./roomId.ts";
import { parseRoute } from "./router.ts";

const KEY = "q5pYb8lJcN0p6tDq3kXz9wR1sV2uF4hG7jK8mN0pQ2s";

describe("room ids", () => {
  test("accepts XXXX-XXXX and 8 characters in any case", () => {
    assert.equal(parseRoomId("K7QH-2MXA"), "K7QH2MXA");
    assert.equal(parseRoomId("k7qh2mxa"), "K7QH2MXA");
    assert.equal(parseRoomId("  k7qh 2mxa "), "K7QH2MXA");
  });

  test("reads Crockford look-alikes as the digit they stand for", () => {
    assert.equal(parseRoomId("ILO0-1234"), "11001234");
  });

  test("rejects wrong lengths and letters outside the alphabet", () => {
    assert.equal(parseRoomId("K7QH-2MX"), null);
    assert.equal(parseRoomId("K7QH-2MXAB"), null);
    assert.equal(parseRoomId("K7QH-2MXU"), null);
    assert.equal(parseRoomId("K7QH_2MXA"), null);
    assert.equal(parseRoomId(""), null);
  });

  test("takes the id out of a pasted join link", () => {
    assert.equal(parseRoomInput("https://vtt.example.com/r/K7QH-2MXA"), "K7QH2MXA");
    assert.equal(parseRoomInput("/r/k7qh2mxa?x=1"), "K7QH2MXA");
  });

  test("formats for people and paths", () => {
    assert.equal(formatRoomId("K7QH2MXA"), "K7QH-2MXA");
    assert.equal(roomPath("K7QH2MXA"), "/r/K7QH-2MXA");
  });
});

describe("routes", () => {
  test("home, room and not found", () => {
    assert.deepEqual(parseRoute("/", { dev: false }), { name: "home" });
    assert.deepEqual(parseRoute("/r/K7QH-2MXA", { dev: false }), { name: "room", roomId: "K7QH2MXA" });
    assert.deepEqual(parseRoute("/r/K7QH2MXA/", { dev: false }), { name: "room", roomId: "K7QH2MXA" });
    assert.deepEqual(parseRoute("/r/nope", { dev: false }), { name: "room", roomId: null });
    assert.deepEqual(parseRoute("/r/%E0%A4%A", { dev: false }), { name: "room", roomId: null });
    assert.deepEqual(parseRoute("/elsewhere", { dev: false }), { name: "notFound" });
  });

  test("a table display enters a code, then shows its room", () => {
    assert.deepEqual(parseRoute("/display", { dev: false }), { name: "display", roomId: null });
    assert.deepEqual(parseRoute("/display/", { dev: false }), { name: "display", roomId: null });
    assert.deepEqual(parseRoute("/display/K7QH-2MXA", { dev: false }), { name: "display", roomId: "K7QH2MXA" });
    assert.deepEqual(parseRoute("/display/nope", { dev: false }), { name: "display", roomId: null, badId: true });
    assert.deepEqual(parseRoute("/displays", { dev: false }), { name: "notFound" });
  });

  test("the fixture room exists only in development", () => {
    assert.deepEqual(parseRoute("/dev/room", { dev: true }), { name: "devRoom" });
    assert.deepEqual(parseRoute("/dev/room", { dev: false }), { name: "notFound" });
  });
});

describe("fragments", () => {
  test("reads a DM key or an invite token", () => {
    assert.deepEqual(parseFragment(`#dm=${KEY}`), { kind: "dm", secret: KEY });
    assert.deepEqual(parseFragment(`#invite=${KEY}`), { kind: "invite", secret: KEY });
  });

  test("ignores other fragments and refuses malformed secrets", () => {
    assert.equal(parseFragment(""), null);
    assert.equal(parseFragment("#section"), null);
    assert.equal(parseFragment("#dm=short"), null);
    assert.equal(parseFragment("#dm=has spaces in it, quite long"), null);
  });

  test("tolerates base64 padding", () => {
    assert.deepEqual(parseFragment(`#dm=${KEY}=`), { kind: "dm", secret: KEY });
  });
});

describe("Enter a DM link or invite", () => {
  test("a full DM link from any origin", () => {
    assert.deepEqual(parseClaimInput(`https://vtt.example.com/r/K7QH2MXA#dm=${KEY}`), {
      kind: "dm",
      roomId: "K7QH2MXA",
      secret: KEY,
    });
    assert.deepEqual(parseClaimInput(`  http://localhost:5173/r/k7qh-2mxa#dm=${KEY}  `), {
      kind: "dm",
      roomId: "K7QH2MXA",
      secret: KEY,
    });
  });

  test("an invite link and a path without an origin", () => {
    assert.deepEqual(parseClaimInput(`/r/K7QH-2MXA#invite=${KEY}`), {
      kind: "invite",
      roomId: "K7QH2MXA",
      secret: KEY,
    });
  });

  test("a bare invite token", () => {
    assert.deepEqual(parseClaimInput(KEY), { kind: "bareInvite", secret: KEY });
    assert.deepEqual(parseClaimInput(`#invite=${KEY}`), { kind: "bareInvite", secret: KEY });
  });

  test("a DM key needs its room, so a key without a link is refused", () => {
    assert.equal(parseClaimInput(`#dm=${KEY}`), null);
    assert.equal(parseClaimInput(`https://vtt.example.com/#dm=${KEY}`), null);
  });

  test("anything else is refused", () => {
    assert.equal(parseClaimInput(""), null);
    assert.equal(parseClaimInput("hello"), null);
    assert.equal(parseClaimInput("https://vtt.example.com/r/K7QH2MXA"), null);
  });
});
