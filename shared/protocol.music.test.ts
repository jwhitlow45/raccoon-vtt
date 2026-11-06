import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { parseRoomState } from "#server/rooms/stateSchema.ts";
import { SOUND_LIMITS } from "./limits.ts";
import type { RoomState } from "./model.ts";
import { clientOpSchema, musicRunSchema, opSchema, queueEditSchema, type OpOf } from "./protocol.ts";
import type { MusicRun, QueueEdit } from "./sound.ts";
import { room } from "./testutil.ts";

/**
 * The queue's ops and the run's Shuffle (docs/design/design-v1-music-player.md
 * 6.2 to 6.4): every op and field a DM's device sends comes back from the
 * schema as it was sent, and the bounds hold.
 */

type Schema = { safeParse: (v: unknown) => { success: boolean; data?: unknown } };

/** The value back from the schema through JSON, as the server receives it. */
function roundTrip(schema: Schema, value: unknown): unknown {
  const parsed = schema.safeParse(JSON.parse(JSON.stringify(value)));
  assert.ok(parsed.success, JSON.stringify(value));
  return parsed.data;
}

const same = (schema: Schema, value: unknown) => assert.deepEqual(roundTrip(schema, value), value);
const bad = (schema: Schema, value: unknown, why: string) => assert.equal(schema.safeParse(value).success, false, why);

const ids = (n: number) => Array.from({ length: n }, (_, i) => `t${i}`);

describe("the queue's edits", () => {
  test("each edit comes back as sent, alone and in music.queue", () => {
    const edits: QueueEdit[] = [
      { t: "next", soundIds: ["m2", "m3"] },
      { t: "add", soundIds: ["m4"] },
      { t: "move", soundId: "m2", to: "first" },
      { t: "move", soundId: "m2", to: "passEnd" },
      { t: "move", soundId: "m2", to: "last" },
      { t: "move", soundId: "m2", to: { before: "m5" } },
      { t: "remove", soundId: "m3" },
      { t: "shuffle", seed: "Ab_9-x" },
      { t: "unshuffle" },
    ];
    for (const edit of edits) {
      same(queueEditSchema, edit);
      const op: OpOf<"music.queue"> = { t: "music.queue", from: "r1", edit };
      same(clientOpSchema, op);
      same(opSchema, op);
    }
  });

  test("id lists hold 1 to 100 ids, none twice, and the other fields keep their shapes", () => {
    for (const t of ["next", "add"] as const) {
      same(queueEditSchema, { t, soundIds: ids(100) });
      bad(queueEditSchema, { t, soundIds: [] }, `${t} names a track`);
      bad(queueEditSchema, { t, soundIds: ids(101) }, `${t} names 100 at most`);
      bad(queueEditSchema, { t, soundIds: ["m1", "m1"] }, `${t} names a track once`);
    }
    bad(queueEditSchema, { t: "move", soundId: "m1", to: "end" }, "a place the queue does not name");
    bad(queueEditSchema, { t: "move", soundId: "m1", to: { after: "m2" } }, "only before");
    bad(queueEditSchema, { t: "move", soundId: "m1", to: { before: "m2", extra: 1 } }, "strict");
    bad(queueEditSchema, { t: "move", soundId: "m1" }, "a move goes somewhere");
    bad(queueEditSchema, { t: "shuffle" }, "a shuffle carries its seed");
    bad(queueEditSchema, { t: "shuffle", seed: "has space" }, "a seed is a run id's shape");
    bad(queueEditSchema, { t: "shuffle", seed: "x".repeat(41) }, "a run id is 40 characters at most");
    bad(queueEditSchema, { t: "unshuffle", seed: "s1" }, "strict");
    bad(queueEditSchema, { t: "reverse" }, "no such edit");
    bad(clientOpSchema, { t: "music.queue", edit: { t: "unshuffle" } }, "an edit names the run it was made on");
    bad(clientOpSchema, { t: "music.queue", from: "not a run", edit: { t: "unshuffle" } }, "from is a run id");
  });
});

describe("a jump", () => {
  test("Play now, Previous and a seek come back as sent", () => {
    const jumps: OpOf<"music.jump">[] = [
      { t: "music.jump", run: "r2", from: "r1", soundId: "m3" },
      { t: "music.jump", run: "r2", from: "r1", soundId: "m3", ms: 0, on: "m3" },
      { t: "music.jump", run: "r2", from: "r1", soundId: "m2", ms: 84_000, on: "m3" },
    ];
    for (const op of jumps) same(clientOpSchema, op);
  });

  test("it names a new run, the run it was made on and a whole ms within a file's length", () => {
    const jump = { t: "music.jump", run: "r2", from: "r1", soundId: "m3" };
    bad(clientOpSchema, { ...jump, run: undefined }, "a jump is a new run");
    bad(clientOpSchema, { ...jump, from: undefined }, "a jump names the run it was made on");
    bad(clientOpSchema, { ...jump, soundId: undefined }, "a jump names its track");
    bad(clientOpSchema, { ...jump, ms: -1 }, "no negative place");
    bad(clientOpSchema, { ...jump, ms: 1.5 }, "whole ms");
    same(clientOpSchema, { ...jump, ms: SOUND_LIMITS.fileMaxMs });
    bad(clientOpSchema, { ...jump, ms: SOUND_LIMITS.fileMaxMs + 1 }, "within a file's length");
    bad(clientOpSchema, { ...jump, on: { soundId: "m3", at: 1 } }, "on names the track alone, never its time");
  });
});

describe("Add to playlist", () => {
  test("one track and its playlist come back as sent, and nothing more", () => {
    same(clientOpSchema, { t: "playlist.add", id: "tavern", soundId: "harbor" });
    bad(clientOpSchema, { t: "playlist.add", id: "tavern", soundIds: ["harbor"] }, "one track");
    bad(clientOpSchema, { t: "playlist.add", id: "tavern" }, "a track");
    bad(clientOpSchema, { t: "playlist.add", id: "tavern", soundId: "harbor", index: 0 }, "an append names no place");
  });
});

describe("a run's Shuffle", () => {
  const run: MusicRun = { run: "r1", playlistId: "pl1", order: ["m2", "m1"], index: 0, repeat: "all", fade: 5, now: { soundId: "m2", at: 1_000 } };

  test("music.play carries it, and only as true", () => {
    const play: OpOf<"music.play"> = { t: "music.play", run: "r1", playlistId: "pl1", order: ["m2", "m1"], repeat: "all", fade: 5, shuffle: true };
    same(clientOpSchema, play);
    const { shuffle: _off, ...plain } = play;
    same(clientOpSchema, plain);
    bad(clientOpSchema, { ...play, shuffle: false }, "off is absent");
  });

  test("the stored run and the server's tick carry it, and only as true", () => {
    same(musicRunSchema, { ...run, shuffle: true });
    same(musicRunSchema, run);
    bad(musicRunSchema, { ...run, shuffle: false }, "off is absent");
    same(opSchema, { t: "sys.sound", from: 3, music: { ...run, shuffle: true } });
    bad(opSchema, { t: "sys.sound", from: 3, music: { ...run, shuffle: "yes" } }, "a flag");
  });

  test("a room's stored state holds it, so a backup and a snapshot keep it", () => {
    const state: RoomState = room({
      sounds: {
        m1: { id: "m1", rev: 0, name: "Tavern", assetId: "a1", ms: 120_000, use: "music" },
        m2: { id: "m2", rev: 0, name: "Road", assetId: "a2", ms: 90_000, use: "music" },
      },
      playlists: { pl1: { id: "pl1", rev: 0, name: "Night", sounds: ["m1", "m2"], repeat: "all", fade: 5 } },
      playing: { rev: 1, music: { ...run, shuffle: true }, loops: {}, effects: [], volume: { music: 100, effects: 100 } },
    });
    const parsed = parseRoomState(JSON.parse(JSON.stringify(state)));
    assert.ok(parsed.ok, parsed.ok ? "" : parsed.message);
    assert.equal(parsed.state.playing?.music?.shuffle, true);
    const off = parseRoomState(JSON.parse(JSON.stringify({ ...state, playing: { ...state.playing!, music: { ...run, shuffle: false } } })));
    assert.equal(off.ok, false, "off is absent");
  });
});
