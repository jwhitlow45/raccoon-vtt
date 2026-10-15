import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { ApiError } from "../../lib/api.ts";
import { imageErrorMessage, isQuotaError, isShortWait } from "./errors.ts";

const refusal = (code: ConstructorParameters<typeof ApiError>[2], retryAfterMs: number | null = null) => new ApiError(429, "raw", code, retryAfterMs);

describe("image search refusals", () => {
  test("each Openverse quota is named, per day, with the ways that still work", () => {
    assert.equal(imageErrorMessage(refusal("quota_member")), "You have used your 20 image searches in this room for today. You can still pick an icon, upload, paste or use an image link.");
    assert.match(imageErrorMessage(refusal("quota_room")), /^This room has used its image searches for today\./);
    assert.match(imageErrorMessage(refusal("quota_ip")), /today\. You can still pick an icon/);
    assert.match(imageErrorMessage(refusal("quota_global", 6 * 3600_000)), /used up for today\./);
    for (const code of ["quota_member", "quota_room", "quota_ip", "quota_global"] as const) {
      assert.ok(isQuotaError(refusal(code)), code);
      assert.doesNotMatch(imageErrorMessage(refusal(code, 3 * 3600_000)), /month/);
    }
  });

  test("Openverse's per-minute budget asks for a minute, and does not steer away", () => {
    const busy = refusal("quota_global", 30_000);
    assert.equal(imageErrorMessage(busy), "Openverse is busy. Try again in a minute.");
    assert.ok(isShortWait(busy));
    assert.ok(!isShortWait(refusal("quota_global", 5 * 3600_000)));
    assert.ok(!isShortWait(refusal("quota_member", 30_000)));
  });

  test("a library delete refused for an image in use says it was kept", () => {
    assert.equal(imageErrorMessage(new ApiError(409, "raw", "asset_in_use", null)), "That image is in use again, so it was kept.");
  });

  test("a library delete on a room whose state cannot be read says so, not that the room is read-only", () => {
    assert.equal(imageErrorMessage(new ApiError(409, "raw", "state_unknown", null)), "The room's images can't be checked right now.");
  });
});
