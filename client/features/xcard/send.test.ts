import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { ApiError } from "../../lib/api.ts";
import { sendFailureText, sendXcard, type SendState } from "./send.ts";

describe("the X-card's sender", () => {
  test("a 429 asks for a moment, and a request that never got through says so", () => {
    assert.equal(sendFailureText(new ApiError(429, "Too many tries.", undefined, null)), "Not sent. Try again in a moment.");
    assert.equal(sendFailureText(new ApiError(0, "Could not reach the server.", "network", null)), "Not sent: no connection. Try again.");
    assert.equal(sendFailureText(new ApiError(502, "The server is not answering.", undefined, null)), "Not sent: no connection. Try again.");
    assert.equal(sendFailureText(new TypeError("Failed to fetch")), "Not sent: no connection. Try again.");
  });

  test("any other refusal says what the server said", () => {
    assert.equal(sendFailureText(new ApiError(401, "This device is not signed in to the room.", "no_session", null)), "Not sent. This device is not signed in to the room.");
  });

  test("a card that went out closes the Menu's sheet, so the sender's screen looks like everyone else's", async () => {
    const steps: string[] = [];
    const settle = (state: SendState) => steps.push(`settle:${state.kind}`);
    await sendXcard({ post: async () => {}, closeSheet: () => steps.push("closeSheet"), settle });
    assert.deepEqual(steps, ["settle:idle", "closeSheet"]);
  });

  test("a card that did not go out keeps the sheet open with the reason, for another try", async () => {
    const steps: string[] = [];
    let failed: SendState | undefined;
    await sendXcard({
      post: async () => {
        throw new ApiError(429, "Too many tries.", undefined, null);
      },
      closeSheet: () => steps.push("closeSheet"),
      settle: (state) => (failed = state),
    });
    assert.deepEqual(steps, []);
    assert.deepEqual(failed, { kind: "failed", message: "Not sent. Try again in a moment." });
  });
});
