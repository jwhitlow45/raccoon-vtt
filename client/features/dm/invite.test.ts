import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { absoluteLink, deviceSeenText, inviteCountdown, inviteUsed, lastSeenText, passwordProblem, weakPasswordText } from "./invite.ts";

describe("invite expiry", () => {
  const minted = Date.parse("2026-10-12T20:00:00.000Z");
  const expiresAt = new Date(minted + 10 * 60_000).toISOString();

  test("counts down minutes and seconds from the server's expiry", () => {
    assert.deepEqual(inviteCountdown(expiresAt, minted), { expired: false, msLeft: 600_000, text: "Expires in 10:00" });
    assert.equal(inviteCountdown(expiresAt, minted + 18_200).text, "Expires in 9:42");
    assert.equal(inviteCountdown(expiresAt, minted + 599_001).text, "Expires in 0:01");
  });

  test("is expired at the deadline and after it", () => {
    assert.deepEqual(inviteCountdown(expiresAt, minted + 600_000), { expired: true, msLeft: 0, text: "Expired" });
    assert.equal(inviteCountdown(expiresAt, minted + 3_600_000).expired, true);
  });

  test("an unreadable expiry counts as expired, never as forever", () => {
    assert.equal(inviteCountdown("soon", minted).expired, true);
  });

  test("the link becomes a whole URL for the QR code", () => {
    assert.equal(absoluteLink("/r/K7QH-2MXA#invite=abc", "https://vtt.example"), "https://vtt.example/r/K7QH-2MXA#invite=abc");
  });
});

describe("devices list", () => {
  const now = Date.parse("2026-10-12T20:00:00.000Z");
  const ago = (ms: number) => new Date(now - ms).toISOString();

  test("last seen reads in plain words", () => {
    assert.equal(lastSeenText(ago(30_000), now), "Seen just now");
    assert.equal(lastSeenText(ago(5 * 60_000), now), "Seen 5 minutes ago");
    assert.equal(lastSeenText(ago(60 * 60_000), now), "Seen 1 hour ago");
    assert.equal(lastSeenText(ago(3 * 24 * 60 * 60_000), now), "Seen 3 days ago");
  });
});

describe("player password", () => {
  test("needs 8 characters, counted as the server counts them", () => {
    assert.equal(passwordProblem("owl-bear"), null);
    assert.match(passwordProblem("short") ?? "", /at least 8/i);
    assert.match(passwordProblem("🦝🦝🦝🦝🦝🦝🦝") ?? "", /at least 8/i);
    assert.equal(passwordProblem("🦝🦝🦝🦝🦝🦝🦝🦝"), null);
    assert.match(passwordProblem("x".repeat(129)) ?? "", /at most/i);
  });

  test("the server's reasons in words", () => {
    assert.match(weakPasswordText("too_common"), /too common/);
    assert.match(weakPasswordText(undefined), /did not accept/);
  });
});

describe("the DM devices list stays fresh", () => {
  const now = Date.parse("2026-10-13T12:00:00.000Z");
  const longAgo = new Date(now - 2 * 60 * 60_000).toISOString();

  test("a connected device reads as online, whatever its stored time says", () => {
    assert.equal(deviceSeenText({ lastSeenAt: longAgo, online: true }, now), "Online now");
    assert.equal(deviceSeenText({ lastSeenAt: longAgo, online: true, current: true }, now), "In use on this device");
    assert.equal(deviceSeenText({ lastSeenAt: longAgo, online: false }, now), "Seen 2 hours ago");
  });

  test("an invite is used once the server says so, matched by its expiry", () => {
    const at = "2026-10-13T12:10:00.000Z";
    assert.equal(inviteUsed([{ expiresAt: at, used: true }], at), true);
    assert.equal(inviteUsed([{ expiresAt: at, used: false }], at), false);
    assert.equal(inviteUsed([{ expiresAt: "2026-10-13T12:11:00.000Z", used: true }], at), false);
    assert.equal(inviteUsed(undefined, at), false);
  });
});
