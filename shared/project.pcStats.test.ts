import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { keys } from "./keys.ts";
import type { DdbSync, PcStats, RoomState, Viewer } from "./model.ts";
import { projectEntity, projectState, type ProjectedCharacter } from "./project.ts";
import { EMPTY_PC_STATS } from "./rules/pcStats.ts";
import { AT, DM, P1, P2, character, member, room, token } from "./testutil.ts";

/**
 * Who receives a character's stat block (docs/design-v1-pc-stats.md 4.2):
 * the DM whole, the character's players whole, and no one else. The only
 * path is the character's existing projection, held here as a matrix so a
 * later edit of its fixed list cannot leak the block.
 */

const BLOCK: PcStats = { ...structuredClone(EMPTY_PC_STATS as PcStats), saves: ["dex"], skills: { stealth: "expert" } };
const DISPLAY: Viewer = { memberId: "display:abcdefghijkl", role: "player" };
const P3: Viewer = { memberId: "p3", role: "player" };

function setup(): RoomState {
  return room({
    members: { dm1: member("dm1", "dm"), p1: member("p1"), p2: member("p2"), p3: member("p3") },
    characters: { bree: character("bree", { name: "Bree", ownerIds: ["p1", "p2"], rev: 7, stats: BLOCK }) },
    // p3 owns one of Bree's tokens, which is not owning Bree.
    tokens: { t: token("t", { kind: "pc", ownerIds: ["p3"], actor: { ref: "bree" } }) },
  });
}

function seen(state: RoomState, viewer: Viewer): ProjectedCharacter | null {
  return projectEntity(keys.character("bree"), state, viewer, { sceneId: state.meta.playerSceneId }) as ProjectedCharacter | null;
}

describe("who receives a stat block", () => {
  test("the DM whole, as the character", () => {
    assert.deepEqual(seen(setup(), DM)?.stats, BLOCK);
  });

  test("the character's players and co-owners whole, with the character's rev 0", () => {
    for (const viewer of [P1, P2]) {
      const projected = seen(setup(), viewer);
      assert.deepEqual(projected?.stats, BLOCK);
      assert.equal(projected?.rev, 0);
    }
  });

  test("another player, a player who owns only one of its tokens, and the table display never", () => {
    const state = setup();
    state.characters.cy = character("cy", { ownerIds: ["p3"] });
    for (const viewer of [P3, DISPLAY]) {
      const projected = seen(state, viewer);
      assert.ok(projected, "the character itself is seen");
      assert.equal("stats" in projected, false);
      assert.equal(JSON.stringify(projectState(state, viewer, { sceneId: state.meta.playerSceneId })).includes("expert"), false, "nowhere in the whole view");
    }
  });

  test("a blackout keeps the block for its players, since a character is not scene data", () => {
    const state = setup();
    state.meta.view.blackout = true;
    assert.deepEqual(seen(state, P1)?.stats, BLOCK);
    assert.equal(seen(state, P3) === null || !("stats" in seen(state, P3)!), true);
  });
});

/** A sync record with a marker no other field holds, so a search of the whole view finds any copy of it. */
const RECORD: DdbSync = { at: AT, from: "987654321", base: { level: 5 }, rolls: { "fedcba987654": { k: "w:0123456789ab", h: "abcdef012345" } } };

describe("who receives a character's D&D Beyond sync record (docs/design-v1-resync.md 4)", () => {
  function synced(): RoomState {
    const state = setup();
    state.characters.bree!.ddbSync = RECORD;
    state.characters.cy = character("cy", { ownerIds: ["p3"] });
    return state;
  }

  test("the DM and the character's players and co-owners whole, since the merge runs on their device", () => {
    for (const viewer of [DM, P1, P2]) assert.deepEqual(seen(synced(), viewer)?.ddbSync, RECORD);
  });

  test("another player, a player who owns only one of its tokens, and the table display never, anywhere in the view", () => {
    const state = synced();
    for (const viewer of [P3, DISPLAY]) {
      const projected = seen(state, viewer);
      assert.ok(projected, "the character itself is seen");
      assert.equal("ddbSync" in projected, false);
      const whole = JSON.stringify(projectState(state, viewer, { sceneId: state.meta.playerSceneId }));
      assert.equal(whole.includes("987654321") || whole.includes("fedcba987654"), false, "nowhere in the whole view");
    }
  });
});
