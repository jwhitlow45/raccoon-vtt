import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { RoomState } from "#shared/model.ts";
import { behindBlackout, hpDraftKey } from "./hpDraft.ts";

describe("HP drafts through a blackout (LPD-PLAYER-7)", () => {
  test("one draft per set of creatures, whatever order they were selected in", () => {
    assert.equal(hpDraftKey([{ holder: "token:b" }, { holder: "token:a" }]), hpDraftKey([{ holder: "token:a" }, { holder: "token:b" }]));
    assert.notEqual(hpDraftKey([{ holder: "token:a" }]), hpDraftKey([{ holder: "token:a" }, { holder: "token:b" }]));
  });

  test("only a player behind a blackout leaves a draft: a DM's room never pauses", () => {
    const view = { meta: { view: { blackout: true } }, scenes: {} } as unknown as RoomState;
    assert.equal(behindBlackout({ view, sceneId: "s1", you: { role: "player" } as never }), true);
    assert.equal(behindBlackout({ view, sceneId: "s1", you: { role: "dm" } as never }), false);
    const resumed = { meta: { view: { blackout: false } }, scenes: {} } as unknown as RoomState;
    assert.equal(behindBlackout({ view: resumed, sceneId: "s1", you: { role: "player" } as never }), false);
    assert.equal(behindBlackout({ view: null, sceneId: null, you: null }), false, "a room still loading is not paused");
  });
});
