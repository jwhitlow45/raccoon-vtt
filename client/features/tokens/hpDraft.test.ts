import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { RoomState } from "#shared/model.ts";
import { behindBlackout, hpDraftKey, leaveHpDraft, takeHpDraft, type HpDraft } from "./hpDraft.ts";

describe("HP drafts through a blackout (LPD-PLAYER-7)", () => {
  test("one draft per place and set of creatures, whatever order they were selected in", () => {
    assert.equal(hpDraftKey("bar", [{ holder: "token:b" }, { holder: "token:a" }]), hpDraftKey("bar", [{ holder: "token:a" }, { holder: "token:b" }]));
    assert.notEqual(hpDraftKey("bar", [{ holder: "token:a" }]), hpDraftKey("bar", [{ holder: "token:a" }, { holder: "token:b" }]));
    assert.notEqual(hpDraftKey("bar", [{ holder: "token:a" }]), hpDraftKey("panel", [{ holder: "token:a" }]));
  });

  test("the bar and the panel for one creature each get back their own typing, in any order (P3-ASTRA-01)", () => {
    const drafts = new Map<string, HpDraft>();
    const thorn = [{ holder: "token:thorn" }];
    const bar = hpDraftKey("bar", thorn);
    const panel = hpDraftKey("panel", thorn);
    // Behind the blackout React unmounts the bar first and the panel last, the panel's entry empty.
    leaveHpDraft(drafts, bar, { mode: "heal", text: "5", crit: false }, true);
    leaveHpDraft(drafts, panel, { mode: "damage", text: "", crit: false }, true);
    // Once the pause ends the panel mounts first, and the bar waits for the map's size.
    assert.deepEqual(takeHpDraft(drafts, panel), { mode: "damage", text: "", crit: false });
    assert.deepEqual(takeHpDraft(drafts, bar), { mode: "heal", text: "5", crit: false }, "the bar's typing outlived the panel");
    assert.equal(drafts.size, 0, "each was taken once");
  });

  test("an entry that unmounts outside a blackout leaves nothing", () => {
    const drafts = new Map<string, HpDraft>();
    leaveHpDraft(drafts, hpDraftKey("bar", [{ holder: "token:thorn" }]), { mode: "heal", text: "5", crit: false }, false);
    assert.equal(drafts.size, 0);
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
