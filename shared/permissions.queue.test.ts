import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { canApply, SOUND_OFF, type PermissionDeps } from "./permissions.ts";
import type { Op } from "./protocol.ts";
import type { Sound } from "./sound.ts";
import { DM, P1, P2, room } from "./testutil.ts";

/*
 * The queue's ops are the DM's (docs/design/design-v1-music-player.md 6.3):
 * a player, and so a table display or View as a player, controls none of
 * them, and with the server's switch off each is refused as Play is, since
 * each names a sound file.
 */

const OFF: PermissionDeps = { canUseAsset: () => true, roomSound: false };
const ON: PermissionDeps = { canUseAsset: () => true, roomSound: true };

const music = (id: string): Sound => ({ id, rev: 0, name: id, assetId: `file-${id}`, ms: 120_000, use: "music" });

const state = room({
  sounds: { m1: music("m1"), m2: music("m2") },
  playlists: { tavern: { id: "tavern", rev: 0, name: "Tavern", sounds: ["m1"], repeat: "all", fade: 5 } },
  playing: { rev: 1, music: { run: "r1", playlistId: "tavern", order: ["m1", "m2"], index: 0, repeat: "all", fade: 5, now: { soundId: "m1", at: 1_000 } }, loops: {}, effects: [], volume: { music: 100, effects: 100 } },
});

const OPS: Op[] = [
  { t: "music.queue", from: "r1", edit: { t: "next", soundIds: ["m2"] } },
  { t: "music.queue", from: "r1", edit: { t: "move", soundId: "m2", to: "first" } },
  { t: "music.queue", from: "r1", edit: { t: "remove", soundId: "m2" } },
  { t: "music.queue", from: "r1", edit: { t: "shuffle", seed: "s1" } },
  { t: "music.queue", from: "r1", edit: { t: "unshuffle" } },
  { t: "music.jump", run: "r2", from: "r1", soundId: "m2" },
  { t: "music.jump", run: "r2", from: "r1", soundId: "m1", ms: 30_000, on: "m1" },
  { t: "playlist.add", id: "tavern", soundId: "m2" },
  { t: "music.play", run: "r3", playlistId: "tavern", order: ["m1"], repeat: "all", fade: 5, shuffle: true },
];

describe("the queue's permissions", () => {
  test("players are refused every queue op, as every other sound op", () => {
    for (const op of OPS) {
      for (const who of [P1, P2]) {
        const decision = canApply(op, who, state, ON);
        assert.equal(decision.ok, false, `${op.t} for ${who.memberId}`);
        if (!decision.ok) assert.equal(decision.code, "forbidden", op.t);
      }
    }
  });

  test("the DM may send each, and the switch off refuses each, since each names a sound file", () => {
    for (const op of OPS) {
      assert.equal(canApply(op, DM, state, ON).ok, true, `${op.t} with the switch on`);
      const off = canApply(op, DM, state, OFF);
      assert.equal(off.ok, false, `${op.t} with the switch off`);
      if (!off.ok) assert.equal(off.message, SOUND_OFF, op.t);
    }
  });
});
