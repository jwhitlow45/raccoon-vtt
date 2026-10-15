import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { ApiError } from "../lib/api.ts";
import { joinRefusal, joinSend, LINK_REFUSED, minutes, resumesWaiting } from "./joinChallenge.ts";

describe("a refused password step", () => {
  test("turnstile_required shows the check and sends again once it is solved, with no error", () => {
    const refusal = joinRefusal(new ApiError(403, "Refused.", "turnstile_required", null));
    assert.deepEqual(refusal, { error: null, challenged: true, resend: true, wrongPassword: false });
  });

  test("a rejected or unanswered check keeps it shown, but waits for the player to press Next", () => {
    const failed = joinRefusal(new ApiError(403, "Refused.", "turnstile_failed", null));
    assert.deepEqual(failed, { error: "The human check did not pass. Try again.", challenged: true, resend: false, wrongPassword: false });
    const down = joinRefusal(new ApiError(503, "Busy.", "turnstile_unavailable", null));
    assert.equal(down.challenged, true);
    assert.equal(down.resend, false);
    assert.match(down.error ?? "", /not answering/);
  });

  test("a wrong password reads as one, and does not by itself bring up the check", () => {
    assert.deepEqual(joinRefusal(new ApiError(403, "Refused.", "bad_password", null)), {
      error: "That password is not right.",
      challenged: false,
      resend: false,
      wrongPassword: true,
    });
  });

  test("a player link's refused password says the link no longer works", () => {
    assert.deepEqual(joinRefusal(new ApiError(403, "Refused.", "bad_password", null), true), {
      error: LINK_REFUSED,
      challenged: false,
      resend: false,
      wrongPassword: true,
    });
    assert.match(LINK_REFUSED, /no longer works.*Ask your DM for a new one/);
  });

  test("a player link that meets the check or a busy server is told the same as typing", () => {
    assert.deepEqual(joinRefusal(new ApiError(403, "Refused.", "turnstile_required", null), true), {
      error: null,
      challenged: true,
      resend: true,
      wrongPassword: false,
    });
    assert.equal(joinRefusal(new ApiError(429, "Busy.", "busy", 2_000), true).error, "The server is busy. Try again in a moment.");
    assert.equal(joinRefusal(new ApiError(429, "Limited.", "rate_limited", 90_000), true).wrongPassword, false);
  });

  test("the per-IP backoff says how long to wait, and a full hash queue is not blamed on the password", () => {
    assert.equal(
      joinRefusal(new ApiError(429, "Limited.", "rate_limited", 90_000)).error,
      "Too many wrong tries. Wait 2 minutes and try again.",
    );
    assert.equal(joinRefusal(new ApiError(429, "Busy.", "busy", 2_000)).error, "The server is busy. Try again in a moment.");
  });

  test("a network failure passes its own message through", () => {
    const offline = joinRefusal(new ApiError(0, "Could not reach the server.", "network", null));
    assert.deepEqual(offline, { error: "Could not reach the server.", challenged: false, resend: false, wrongPassword: false });
  });
});

describe("pressing Next", () => {
  const off = { pending: false, required: false, token: null };

  test("a room that has not asked for the check gets the password alone, even when a token is at hand", () => {
    assert.deepEqual(joinSend(false, off), { kind: "send" });
    assert.deepEqual(joinSend(false, { pending: false, required: true, token: "t" }), { kind: "send" });
  });

  test("a room that asked gets the token, or waits for one", () => {
    assert.deepEqual(joinSend(true, { pending: false, required: true, token: "t" }), { kind: "send", turnstileToken: "t" });
    assert.deepEqual(joinSend(true, { pending: false, required: true, token: null }), { kind: "wait" });
    assert.deepEqual(joinSend(true, { pending: true, required: false, token: null }), { kind: "wait" });
  });

  test("a room that asked, on a page with no site key, says the check cannot load", () => {
    assert.deepEqual(joinSend(true, off), { kind: "unavailable" });
  });
});

describe("waiting for the check", () => {
  test("acts once a token arrives, and keeps waiting while the check runs", () => {
    assert.equal(resumesWaiting(true, { pending: false, required: true, token: null }), false);
    assert.equal(resumesWaiting(true, { pending: true, required: false, token: null }), false);
    assert.equal(resumesWaiting(true, { pending: false, required: true, token: "t" }), true);
  });

  test("ends the wait when the site key turns out to be unreadable, before or after the challenge came back", () => {
    // The settings read failed while the page was already waiting: pending flips to false with no key.
    assert.equal(resumesWaiting(true, { pending: false, required: false, token: null }), true);
    assert.deepEqual(joinSend(true, { pending: false, required: false, token: null }), { kind: "unavailable" });
  });
});

describe("minutes", () => {
  test("rounds up, with words for one and unknown", () => {
    assert.equal(minutes(null), "a few minutes");
    assert.equal(minutes(1_000), "a minute");
    assert.equal(minutes(61_000), "2 minutes");
  });
});
