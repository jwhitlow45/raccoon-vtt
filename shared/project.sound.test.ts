import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { keys, readEntity, type EntityKey } from "./keys.ts";
import type { RoomState, Viewer } from "./model.ts";
import type { Change, Op, OpOf } from "./protocol.ts";
import { allKeys, applyChanges, dependents, diffProjection, hashValue, heldOf, projectEntity, projectState, stableStringify, visibleAssetIds, type HeldEntry, type ProjectedState } from "./project.ts";
import { applyOp, type Applied } from "./reducer.ts";
import { following, soundDue, soundStep, type FiredEffect, type MusicRun, type Playing, type Sound, type SoundUse } from "./sound.ts";
import { AT, DM, P1, room } from "./testutil.ts";

/**
 * What of the room's sound reaches each viewer, path by path
 * (docs/design/design-v1-music.md 6.5, the cases of section 11 about Pat's
 * socket, the blackout and a reclassified effect, and section 12): the full
 * snapshot, one entity at a time, the held map, the visible set and the
 * fan-out of a batch. Every state is built by real ops through the reducer,
 * the server's ticks by soundStep at their due times, so a rule the reducer
 * and the projection disagree on shows here.
 */

/** A table display is one more player viewer who owns nothing (docs/design/design-v1-dm-tools.md 3.1). */
const DISPLAY: Viewer = { memberId: "display:abcdefghijkl", role: "player" };
const PLAYERS = [P1, DISPLAY] as const;
const OPTS = { sceneId: "s1" };

const BASE = Date.parse(AT);
/** Every start is the op's server time and the lead (6.3). */
const LEAD = 400;
const S0 = BASE + LEAD;

let seq = 0;
function run(state: RoomState, op: Op, ms = 0): Applied {
  const r = applyOp(state, op, DM, { seq: ++seq, at: new Date(BASE + ms).toISOString() });
  assert.ok(r.ok, `${op.t}: ${r.ok ? "" : r.message}`);
  return r;
}

type Entry = { id: string; use: SoundUse; ms: number; name: string; level?: number };
const LIBRARY: Entry[] = [
  { id: "m1", use: "music", ms: 60_000, name: "Harbor" },
  { id: "m2", use: "music", ms: 60_000, name: "Lanterns", level: -35 },
  { id: "m3", use: "music", ms: 60_000, name: "Last call" },
  // In the library and no playlist, so nothing ever plays it: the DM's alone.
  { id: "lich", use: "music", ms: 90_000, name: "The Lich Wakes" },
  { id: "rain", use: "loop", ms: 30_000, name: "Rain" },
  { id: "crowd", use: "loop", ms: 20_000, name: "Crowd" },
  { id: "thunder", use: "effect", ms: 25_000, name: "Thunder" },
  // Long enough to be Background too, so it can be reclassified after it fired.
  { id: "boom", use: "effect", ms: 5_000, name: "Boom" },
  { id: "door", use: "effect", ms: 1_000, name: "Door" },
];
const ALL_IDS = LIBRARY.map((s) => s.id);

const PLAY: Op = { t: "music.play", run: "r1", playlistId: "tavern", order: ["m1", "m2", "m3"], repeat: "all", fade: 5 };

/** The library, a playlist and the players' scene's sound, each by the DM's own ops. */
function library(): RoomState {
  let state = room({ playing: null });
  for (const s of LIBRARY) {
    state = run(state, { t: "sound.create", id: s.id, assetId: `file-${s.id}`, name: s.name, use: s.use, ms: s.ms, ...(s.level !== undefined ? { level: s.level } : {}) }).state;
  }
  state = run(state, { t: "playlist.create", id: "tavern", name: "Tavern night", sounds: ["m1", "m2", "m3"], repeat: "all", fade: 5 }).state;
  return run(state, { t: "scene.update", sceneId: "s1", patch: { sound: { music: { playlistId: "tavern", repeat: "all", fade: 5 }, loops: [{ soundId: "crowd", volume: 40 }] } } }).state;
}

/** The server's tick at its due time (6.4): soundStep from the confirmed state, stored by `sys.sound` from the rev it read. */
function tick(state: RoomState): Applied {
  const due = soundDue(state.playing ?? null, state.sounds ?? {});
  assert.ok(due !== null, "a tick is due");
  const step = soundStep(state.playing!, state.sounds ?? {}, due);
  assert.ok(step.changed, "the tick changes the music");
  return run(state, { t: "sys.sound", from: state.playing!.rev, music: step.music as OpOf<"sys.sound">["music"] }, due - BASE);
}

/**
 * Tavern night playing with Rain looping, Thunder and a built-in click
 * fired in the open, Door fired behind a blackout since lifted, and the
 * server's tick revealing Lanterns 20 s before it starts.
 */
function live(): RoomState {
  let state = run(library(), PLAY).state;
  state = run(state, { t: "loop.start", id: "l1", soundId: "rain", volume: 70 }, 1_000).state;
  state = run(state, { t: "effect.fire", id: "e1", soundId: "thunder" }, 2_000).state;
  state = run(state, { t: "effect.fire", id: "e2", builtin: "click" }, 3_000).state;
  state = run(state, { t: "view.blackout", blackout: true }, 4_000).state;
  state = run(state, { t: "effect.fire", id: "e3", soundId: "door" }, 5_000).state;
  state = run(state, { t: "view.blackout", blackout: false }, 6_000).state;
  return tick(state).state;
}

/** A sound as a player's projection carries it: what playing it needs, and the name only where the DM shares it. */
function cut(id: string, named = false): Sound {
  const s = LIBRARY.find((x) => x.id === id)!;
  return { id, rev: 0, assetId: `file-${id}`, ms: s.ms, use: s.use, ...(s.level !== undefined ? { level: s.level } : {}), ...(named ? { name: s.name } : {}) };
}

const THUNDER: FiredEffect = { id: "e1", soundId: "thunder", at: BASE + 2_000 + LEAD };
const CLICK: FiredEffect = { id: "e2", builtin: "click", at: BASE + 3_000 + LEAD };
const RAIN = { soundId: "rain", at: BASE + 1_000 + LEAD, volume: 70 };

/** What plays in live() as a player gets it. */
const LIVE_FOR_PLAYERS: Playing = {
  rev: 0,
  music: { run: "r1", repeat: "all", fade: 5, now: { soundId: "m1", at: S0 }, next: { soundId: "m2", at: S0 + 55_000 } },
  loops: { l1: RAIN },
  effects: [THUNDER, CLICK],
  volume: { music: 100, effects: 100 },
};

// The fan-out (server/rooms/fanout.ts publishBatch), as its candidates are found for a batch with no sight or log ring change.

type Conn = { viewer: Viewer; held: Map<EntityKey, HeldEntry>; view: ProjectedState };

function connect(state: RoomState, viewer: Viewer): Conn {
  const view = projectState(state, viewer, OPTS);
  return { viewer, held: heldOf(view), view };
}

/** The touched keys and their dependents in the state on each side, or every key of either when an op set `global`. */
function candidates(before: RoomState, r: Applied): EntityKey[] {
  if (r.global) return [...new Set([...allKeys(before), ...allKeys(r.state)])].sort();
  return [...new Set([...r.touched, ...dependents(before, r.touched, r.state), ...dependents(r.state, r.touched, before)])].sort();
}

/**
 * A copy built from changes holds `playing: null` and an empty `sounds`
 * where a fresh snapshot leaves the field out (keys.ts writeEntity). Both
 * read as nothing plays, so the comparison takes them as the same.
 */
function normalized(view: ProjectedState): string {
  const { sounds, playlists, playing, ...rest } = view;
  return stableStringify({
    ...rest,
    ...(sounds && Object.keys(sounds).length > 0 ? { sounds } : {}),
    ...(playlists && Object.keys(playlists).length > 0 ? { playlists } : {}),
    ...(playing ? { playing } : {}),
  });
}

/** One batch to each connection. Returns what each was sent, and checks its copy is the fresh projection and its held map that copy's. */
function publish(before: RoomState, r: Applied, conns: readonly Conn[]): Map<Conn, Change[]> {
  const out = new Map<Conn, Change[]>();
  const keyed = candidates(before, r);
  for (const c of conns) {
    const next = new Map<EntityKey, unknown>();
    for (const key of keyed) next.set(key, projectEntity(key, r.state, c.viewer, OPTS));
    const diff = diffProjection(c.held, next);
    c.held = diff.held;
    c.view = applyChanges(c.view, diff.changes);
    out.set(c, diff.changes);
    assert.equal(normalized(c.view), normalized(projectState(r.state, c.viewer, OPTS)), `${c.viewer.memberId}'s copy is the fresh projection`);
    assert.deepEqual([...c.held.keys()].sort(), [...heldOf(c.view).keys()].sort(), `${c.viewer.memberId}'s held map is its copy's`);
  }
  return out;
}

/** A table: the DM, a player and a display, each with their first snapshot. */
function table(state: RoomState): { dm: Conn; p1: Conn; display: Conn; all: Conn[] } {
  const dm = connect(state, DM);
  const p1 = connect(state, P1);
  const display = connect(state, DISPLAY);
  return { dm, p1, display, all: [dm, p1, display] };
}

/** Applies an op and publishes its batch: the state after and what each connection was sent. */
function batch(state: RoomState, op: Op, ms: number, conns: readonly Conn[]): { state: RoomState; sent: Map<Conn, Change[]>; r: Applied } {
  const r = run(state, op, ms);
  return { state: r.state, sent: publish(state, r, conns), r };
}

function tickBatch(state: RoomState, conns: readonly Conn[]): { state: RoomState; sent: Map<Conn, Change[]>; r: Applied } {
  const r = tick(state);
  return { state: r.state, sent: publish(state, r, conns), r };
}

function changeOf(changes: readonly Change[], key: EntityKey): Change | undefined {
  return changes.find((c) => c.key === key);
}

function soundKeysHeld(conn: Conn): string[] {
  return [...conn.held.keys()].filter((k) => k.startsWith("sound:")).sort();
}

describe("the DM gets the library, the playlists and what plays whole (6.5)", () => {
  const state = live();

  test("the full snapshot holds every sound, the playlists, the scene's sound and playing as stored", () => {
    const view = projectState(state, DM, OPTS);
    assert.deepEqual(view.sounds, state.sounds);
    assert.deepEqual(view.playlists, state.playlists);
    assert.deepEqual(view.playing, state.playing);
    assert.deepEqual(view.playing?.dmEffects, [{ id: "e3", soundId: "door", at: BASE + 5_000 + LEAD }], "the effect fired behind the blackout is the DM's");
    assert.deepEqual(view.playing?.music?.order, ["m1", "m2", "m3"]);
    assert.equal(view.playing?.music?.playlistId, "tavern");
    assert.deepEqual(view.scenes.s1?.sound, state.scenes.s1?.sound);
    assert.ok(state.playing!.rev > 0 && state.sounds!.m1!.rev > 0, "the DM sees the revs as stored");
  });

  test("each entity is the stored one", () => {
    for (const key of [...ALL_IDS.map((id) => keys.sound(id)), keys.playlist("tavern"), keys.playing, keys.scene("s1"), keys.scene("s2")]) {
      assert.deepEqual(projectEntity(key, state, DM, OPTS), readEntity(state, key), key);
    }
  });

  test("the held map names every sound, the playlist and playing, and the visible set every sound's file", () => {
    const held = heldOf(projectState(state, DM, OPTS));
    const soundKeys = [...held.keys()].filter((k) => k === keys.playing || k.startsWith("sound:") || k.startsWith("playlist:")).sort();
    assert.deepEqual(soundKeys, [keys.playing, keys.playlist("tavern"), ...ALL_IDS.map((id) => keys.sound(id))].sort());
    assert.deepEqual([...visibleAssetIds(state, DM, OPTS)].sort(), ALL_IDS.map((id) => `file-${id}`).sort());
  });
});

describe("a player and a table display get only what sounds now (6.5)", () => {
  const state = live();

  test("the full snapshot holds now, the revealed next, the loop and the open effects, each cut, and nothing of the library", () => {
    for (const viewer of PLAYERS) {
      const view = projectState(state, viewer, OPTS);
      assert.deepEqual(view.sounds, { m1: cut("m1"), m2: cut("m2"), rain: cut("rain"), thunder: cut("thunder") }, viewer.memberId);
      assert.deepEqual(view.playing, LIVE_FOR_PLAYERS, viewer.memberId);
      assert.deepEqual(Object.keys(view.playing!.music!).sort(), ["fade", "next", "now", "repeat", "run"], "no order, index, playlist or pause");
      assert.ok(!("dmEffects" in view.playing!), "no effect fired behind the blackout");
      assert.ok(!("playlists" in view), "no playlist");
      assert.ok(!("sound" in view.scenes.s1!), "no scene's sound");
      assert.deepEqual(Object.keys(view.scenes), ["s1"]);
    }
    const p1 = projectState(state, P1, OPTS);
    const display = projectState(state, DISPLAY, OPTS);
    assert.deepEqual({ sounds: display.sounds, playing: display.playing }, { sounds: p1.sounds, playing: p1.playing }, "a display gets what a player gets");
  });

  test("each entity: the library, the playlist and the DM's effect project to nothing, the scene without its sound", () => {
    for (const viewer of PLAYERS) {
      const project = (key: EntityKey) => projectEntity(key, state, viewer, OPTS);
      for (const id of ["lich", "m3", "crowd", "boom", "door"]) assert.equal(project(keys.sound(id)), null, `${id} is the DM's`);
      assert.deepEqual(project(keys.sound("m1")), cut("m1"));
      assert.deepEqual(project(keys.sound("m2")), cut("m2"), "the next track without its name");
      assert.deepEqual(project(keys.sound("rain")), cut("rain"));
      assert.deepEqual(project(keys.sound("thunder")), cut("thunder"));
      assert.equal(project(keys.playlist("tavern")), null);
      assert.deepEqual(project(keys.playing), LIVE_FOR_PLAYERS);
      const scene = project(keys.scene("s1")) as Record<string, unknown>;
      assert.ok(scene !== null && !("sound" in scene), "the players' scene without its sound");
      assert.equal(project(keys.scene("s2")), null);
    }
  });

  test("the held map over every key of the room agrees with each entity's projection, and names only what plays", () => {
    for (const viewer of PLAYERS) {
      const held = heldOf(projectState(state, viewer, OPTS));
      for (const key of allKeys(state)) {
        if (key !== keys.playing && !key.startsWith("sound:") && !key.startsWith("playlist:")) continue;
        const value = projectEntity(key, state, viewer, OPTS);
        assert.equal(held.get(key), value === null ? undefined : hashValue(value), key);
      }
      assert.deepEqual([...held.keys()].filter((k) => k === keys.playing || k.startsWith("sound:") || k.startsWith("playlist:")).sort(), [keys.playing, ...["m1", "m2", "rain", "thunder"].map((id) => keys.sound(id))].sort());
    }
  });

  test("the visible set holds exactly the files of the projected sounds", () => {
    for (const viewer of PLAYERS) {
      const projected = Object.values(projectState(state, viewer, OPTS).sounds ?? {}).map((s) => s.assetId);
      assert.deepEqual([...visibleAssetIds(state, viewer, OPTS)].sort(), projected.sort());
      assert.deepEqual(projected.sort(), ["file-m1", "file-m2", "file-rain", "file-thunder"]);
    }
  });

  test("a paused run is no music, its tracks leave, the loop and effects stay, and a resume brings the run back under its new id", () => {
    const paused = run(state, { t: "music.pause" }, 40_000).state;
    assert.ok(paused.playing?.music?.paused !== undefined, "the DM keeps the place");
    for (const viewer of PLAYERS) {
      const view = projectState(paused, viewer, OPTS);
      assert.equal(view.playing?.music, null);
      assert.deepEqual(view.playing?.loops, { l1: RAIN });
      assert.deepEqual(view.playing?.effects, [THUNDER, CLICK]);
      assert.deepEqual(Object.keys(view.sounds ?? {}).sort(), ["rain", "thunder"]);
      assert.deepEqual([...visibleAssetIds(paused, viewer, OPTS)].sort(), ["file-rain", "file-thunder"]);
    }
    const resumed = run(paused, { t: "music.resume", run: "r2" }, 50_000).state;
    const music = projectState(resumed, P1, OPTS).playing?.music;
    assert.equal(music?.run, "r2");
    assert.ok(music && !("paused" in music) && !("order" in music) && !("index" in music));
  });

  test("the effects leave out an entry whose sound is gone or now another use, and keep the built-ins", () => {
    // sound.delete takes the sound's entries out of both lists, so only a state from outside the reducer holds one (6.3).
    const gone: RoomState = { ...state, sounds: Object.fromEntries(Object.entries(state.sounds!).filter(([id]) => id !== "thunder")) };
    assert.deepEqual(projectState(gone, P1, OPTS).playing?.effects, [CLICK]);
    assert.equal(projectState(gone, P1, OPTS).sounds?.thunder, undefined);
    const fired = run(state, { t: "effect.fire", id: "e4", soundId: "boom" }, 36_000).state;
    const changed = run(fired, { t: "sound.update", id: "boom", use: "loop" }, 37_000).state;
    assert.equal(changed.playing!.effects.at(-1)?.soundId, "boom", "its entry stays in the state as history");
    for (const viewer of PLAYERS) {
      const view = projectState(changed, viewer, OPTS);
      assert.deepEqual(view.playing?.effects, [THUNDER, CLICK]);
      assert.equal(view.sounds?.boom, undefined);
      assert.ok(!visibleAssetIds(changed, viewer, OPTS).has("file-boom"));
    }
  });

  test("every rev a player gets is 0, so the count of the DM's changes never shows", () => {
    const view = projectState(state, P1, OPTS);
    assert.ok(state.playing!.rev > 1);
    assert.equal(view.playing?.rev, 0);
    for (const sound of Object.values(view.sounds ?? {})) assert.equal(sound.rev, 0);
  });
});

describe("names follow Players see what is playing: now and the loops only (6.5, section 11)", () => {
  test("with the switch on now and the loops are named, never the next track or an effect, and the frames say the same", () => {
    const state = live();
    const t = table(state);
    const on = batch(state, { t: "room.update", settings: { soundNames: true } }, 36_000, t.all);
    for (const viewer of PLAYERS) {
      const view = projectState(on.state, viewer, OPTS);
      assert.deepEqual(view.sounds, { m1: cut("m1", true), m2: cut("m2"), rain: cut("rain", true), thunder: cut("thunder") }, viewer.memberId);
    }
    for (const conn of [t.p1, t.display]) {
      const sent = on.sent.get(conn)!;
      assert.deepEqual(sent.filter((c) => c.key.startsWith("sound:")), [
        { key: keys.sound("m1"), value: cut("m1", true) },
        { key: keys.sound("rain"), value: cut("rain", true) },
      ]);
    }
    // At the end of the crossfade Lanterns is now: its name comes, and Harbor, no longer named by anything, goes.
    const promoted = tickBatch(on.state, t.all);
    assert.equal(promoted.state.playing?.music?.now.soundId, "m2");
    for (const conn of [t.p1, t.display]) {
      const sent = promoted.sent.get(conn)!;
      assert.deepEqual(changeOf(sent, keys.sound("m2")), { key: keys.sound("m2"), value: cut("m2", true) });
      assert.deepEqual(changeOf(sent, keys.sound("m1")), { key: keys.sound("m1"), deleted: true });
    }
    // The next reveal names Last call without its name.
    const revealed = tickBatch(promoted.state, t.all);
    assert.equal(revealed.state.playing?.music?.next?.soundId, "m3");
    for (const conn of [t.p1, t.display]) assert.deepEqual(changeOf(revealed.sent.get(conn)!, keys.sound("m3")), { key: keys.sound("m3"), value: cut("m3") });
    const off = batch(revealed.state, { t: "room.update", settings: { soundNames: false } }, 160_000, t.all);
    for (const conn of [t.p1, t.display]) {
      for (const sound of Object.values(conn.view.sounds ?? {})) assert.equal(sound.name, undefined, `${sound.id} named with the switch off`);
      assert.deepEqual(off.sent.get(conn)!.filter((c) => c.key.startsWith("sound:")).map((c) => c.key).sort(), [keys.sound("m2"), keys.sound("rain")]);
    }
  });
});

describe("behind a blackout players get nothing of the sound (6.5, 4.6, section 11)", () => {
  test("the snapshot, each entity, the held map and the visible set hold none of it, and the DM's hold all of it", () => {
    const state = run(live(), { t: "view.blackout", blackout: true }, 36_000).state;
    for (const viewer of PLAYERS) {
      const view = projectState(state, viewer, OPTS);
      assert.equal(view.playing, undefined);
      assert.equal(view.sounds, undefined);
      assert.equal(projectEntity(keys.playing, state, viewer, OPTS), null);
      for (const id of ALL_IDS) assert.equal(projectEntity(keys.sound(id), state, viewer, OPTS), null, id);
      assert.deepEqual([...heldOf(view).keys()].filter((k) => k === keys.playing || k.startsWith("sound:")), []);
      assert.deepEqual([...visibleAssetIds(state, viewer, OPTS)], []);
    }
    assert.deepEqual(projectState(state, DM, OPTS).playing, state.playing);
  });

  test("the blackout's batch withdraws everything, an effect fired in it sends players nothing, and it never reaches them after", () => {
    const start = run(library(), PLAY).state;
    const t = table(start);
    let state = batch(start, { t: "loop.start", id: "l1", soundId: "rain", volume: 70 }, 1_000, t.all).state;
    const dark = batch(state, { t: "view.blackout", blackout: true }, 2_000, t.all);
    for (const conn of [t.p1, t.display]) {
      assert.deepEqual(dark.sent.get(conn)!.filter((c) => c.key === keys.playing || c.key.startsWith("sound:")).sort((a, b) => a.key.localeCompare(b.key)), [
        { key: keys.playing, deleted: true },
        { key: keys.sound("m1"), deleted: true },
        { key: keys.sound("rain"), deleted: true },
      ]);
      assert.deepEqual([...conn.held.keys()].filter((k) => k === keys.playing || k.startsWith("sound:")), []);
    }
    const fired = batch(dark.state, { t: "effect.fire", id: "e1", soundId: "door" }, 3_000, t.all);
    assert.deepEqual(fired.state.playing?.dmEffects?.map((e) => e.id), ["e1"]);
    assert.deepEqual(fired.state.playing?.effects, []);
    for (const conn of [t.p1, t.display]) assert.deepEqual(fired.sent.get(conn), [], "the fire sends players nothing");
    assert.ok(changeOf(fired.sent.get(t.dm)!, keys.playing), "the DM hears it");
    const light = batch(fired.state, { t: "view.blackout", blackout: false }, 4_000, t.all);
    state = batch(light.state, { t: "effect.fire", id: "e2", soundId: "thunder" }, 5_000, t.all).state;
    for (const conn of [t.p1, t.display]) {
      assert.deepEqual(conn.view.playing?.effects.map((e) => e.id), ["e2"], "only the effect fired in the open");
      assert.ok(!conn.held.has(keys.sound("door")));
      assert.ok(!stableStringify(conn.view).includes('"e1"'), "the DM's effect is nowhere in the copy");
      assert.ok(!visibleAssetIds(state, conn.viewer, OPTS).has("file-door"));
    }
  });
});

describe("the fan-out sends what the projection changed, in the same batch (6.5)", () => {
  test("no frame names the next track before its reveal, and the reveal sends it without its name", () => {
    let state = run(library(), { t: "room.update", settings: { soundNames: true } }).state;
    const t = table(state);
    const frames: Change[] = [];
    const steps: [Op, number][] = [
      [PLAY, 0],
      [{ t: "loop.start", id: "l1", soundId: "rain", volume: 70 }, 1_000],
      [{ t: "effect.fire", id: "e1", soundId: "thunder" }, 2_000],
      [{ t: "sound.mix", music: 80 }, 3_000],
      [{ t: "music.set", fade: 2 }, 4_000],
      [{ t: "loop.set", id: "l1", volume: 50 }, 5_000],
    ];
    for (const [op, ms] of steps) {
      const b = batch(state, op, ms, t.all);
      frames.push(...b.sent.get(t.p1)!, ...b.sent.get(t.display)!);
      state = b.state;
    }
    assert.ok(frames.length > 0);
    for (const frame of frames) assert.ok(!stableStringify(frame).includes('"m2"'), `a frame before the reveal names Lanterns: ${stableStringify(frame)}`);
    assert.deepEqual(soundKeysHeld(t.p1), [keys.sound("m1"), keys.sound("rain"), keys.sound("thunder")].sort());
    const reveal = tickBatch(state, t.all);
    assert.equal(reveal.state.playing?.music?.next?.soundId, "m2");
    for (const conn of [t.p1, t.display]) {
      const sent = reveal.sent.get(conn)!;
      assert.deepEqual(changeOf(sent, keys.sound("m2")), { key: keys.sound("m2"), value: cut("m2") }, "the next track arrives with its reveal, unnamed");
      assert.deepEqual((changeOf(sent, keys.playing) as { value: Playing }).value.music?.next, reveal.state.playing?.music?.next);
    }
  });

  test("a sound named before a batch and not after leaves the held map in that batch", () => {
    let state = run(library(), PLAY).state;
    state = run(state, { t: "loop.start", id: "l1", soundId: "rain", volume: 70 }, 1_000).state;
    state = run(state, { t: "loop.start", id: "l2", soundId: "crowd", volume: 70 }, 1_000).state;
    state = run(state, { t: "effect.fire", id: "e1", soundId: "thunder" }, 2_000).state;
    const t = table(state);
    const stopped = batch(state, { t: "loop.stop", id: "l1" }, 3_000, t.all);
    for (const conn of [t.p1, t.display]) assert.deepEqual(changeOf(stopped.sent.get(conn)!, keys.sound("rain")), { key: keys.sound("rain"), deleted: true });
    const music = batch(stopped.state, { t: "music.stop" }, 4_000, t.all);
    for (const conn of [t.p1, t.display]) assert.deepEqual(changeOf(music.sent.get(conn)!, keys.sound("m1")), { key: keys.sound("m1"), deleted: true });
    const all = batch(music.state, { t: "sound.stopAll" }, 5_000, t.all);
    for (const conn of [t.p1, t.display]) {
      assert.deepEqual(all.sent.get(conn)!.filter((c) => c.key.startsWith("sound:")).sort((a, b) => a.key.localeCompare(b.key)), [
        { key: keys.sound("crowd"), deleted: true },
        { key: keys.sound("thunder"), deleted: true },
      ]);
      assert.deepEqual(soundKeysHeld(conn), []);
    }
    // Harbor leaves at the end of the crossfade into Lanterns, by the tick alone.
    let played = run(library(), PLAY).state;
    played = tick(played).state;
    const u = table(played);
    const promoted = tickBatch(played, u.all);
    for (const conn of [u.p1, u.display]) {
      assert.deepEqual(changeOf(promoted.sent.get(conn)!, keys.sound("m1")), { key: keys.sound("m1"), deleted: true });
      assert.deepEqual(soundKeysHeld(conn), [keys.sound("m2")]);
    }
  });

  test("a reclassified effect's entry leaves players' playing in its own batch, and Undo brings back only what the state holds", () => {
    let state = run(library(), PLAY).state;
    state = run(state, { t: "effect.fire", id: "e1", soundId: "boom" }, 1_000).state;
    state = run(state, { t: "effect.fire", id: "e2", builtin: "crash" }, 1_000).state;
    const boom: FiredEffect = { id: "e1", soundId: "boom", at: BASE + 1_000 + LEAD };
    const t = table(state);
    assert.deepEqual(t.p1.view.playing?.effects[0], boom);
    const changed = batch(state, { t: "sound.update", id: "boom", use: "loop" }, 2_000, t.all);
    assert.ok(!changed.r.touched.includes(keys.playing) && !changed.r.global, "no Setup op writes playing, so only its dependents can carry the change");
    assert.deepEqual(changed.state.playing, state.playing, "the entry stays in the state as history");
    for (const conn of [t.p1, t.display]) {
      const sent = changed.sent.get(conn)!;
      assert.deepEqual((changeOf(sent, keys.playing) as { value: Playing } | undefined)?.value.effects, [{ id: "e2", builtin: "crash", at: BASE + 1_000 + LEAD }]);
      assert.deepEqual(changeOf(sent, keys.sound("boom")), { key: keys.sound("boom"), deleted: true });
      assert.equal(sent.length, 2);
    }
    assert.deepEqual(changed.sent.get(t.dm)!.map((c) => c.key), [keys.sound("boom")], "the DM's playing did not change");
    // Undo setup: the state holds the entry still, so it comes back as it was, the same fire at the same time, and nothing more.
    const undone = batch(changed.state, { t: "sys.restore", entries: changed.r.inverse!, from: "undo", deps: true }, 3_000, t.all);
    assert.equal(undone.state.sounds?.boom?.use, "effect");
    for (const conn of [t.p1, t.display]) {
      assert.deepEqual(conn.view.playing?.effects, [boom, { id: "e2", builtin: "crash", at: BASE + 1_000 + LEAD }]);
      assert.deepEqual(conn.view.sounds?.boom, cut("boom"));
    }
    // With the entry trimmed while the sound was Background, which sounds nothing as an effect, Undo brings no voice back.
    let trimmed = changed.state;
    for (let i = 0; i < 8; i++) trimmed = batch(trimmed, { t: "effect.fire", id: `d${i}`, soundId: "door" }, 10_000 + i * 100, t.all).state;
    assert.ok(!trimmed.playing!.effects.some((e) => e.soundId === "boom"), "the reducer trimmed it");
    const undoneLate = batch(trimmed, { t: "sys.restore", entries: changed.r.inverse!, from: "undo", deps: true }, 12_000, t.all);
    assert.equal(undoneLate.state.sounds?.boom?.use, "effect");
    for (const conn of [t.p1, t.display]) {
      assert.deepEqual(undoneLate.sent.get(conn), []);
      assert.ok(!conn.view.playing?.effects.some((e) => e.soundId === "boom"));
      assert.equal(conn.view.sounds?.boom, undefined);
    }
  });

  test("deleting a sounding effect takes its entry and its sound from players in that batch", () => {
    let state = run(library(), { t: "effect.fire", id: "e1", soundId: "thunder" }).state;
    const t = table(state);
    state = batch(state, { t: "sound.delete", id: "thunder" }, 1_000, t.all).state;
    for (const conn of [t.p1, t.display]) {
      assert.deepEqual(conn.view.playing?.effects, []);
      assert.deepEqual(soundKeysHeld(conn), []);
    }
    assert.equal(state.sounds?.thunder, undefined);
  });
});

describe("the queue's edits and jumps (docs/design/design-v1-music-player.md 6.6)", () => {
  const queue = (edit: Extract<Op, { t: "music.queue" }>["edit"]): Op => ({ t: "music.queue", from: "r1", edit });
  const EDITS: Extract<Op, { t: "music.queue" }>["edit"][] = [
    { t: "next", soundIds: ["lich"] },
    { t: "add", soundIds: ["lich"] },
    { t: "move", soundId: "m3", to: "first" },
    { t: "move", soundId: "m2", to: "passEnd" },
    { t: "remove", soundId: "m2" },
    { t: "shuffle", seed: "mix1" },
  ];
  const SHOWN = new Set(["run", "repeat", "fade", "now", "next"]);

  /** What a player's projection holds of the run: never the DM's fields, and a next only as the track `following` names. */
  function playersRun(state: RoomState, where: string): MusicRun | null {
    const music = state.playing?.music ?? null;
    for (const viewer of PLAYERS) {
      const shown = projectState(state, viewer, OPTS).playing?.music ?? null;
      assert.deepEqual(Object.keys(shown ?? {}).filter((k) => !SHOWN.has(k)), [], `${where}: ${viewer.memberId} gets no order, index, shuffle, playlist or pause`);
      if (shown?.next !== undefined) assert.equal(shown.next.soundId, music!.order![following(music!)!], `${where}: the next track is the one that follows`);
      assert.deepEqual(shown?.next, music?.next, `${where}: next as the DM's run holds it`);
    }
    return projectState(state, P1, OPTS).playing?.music ?? null;
  }

  test("before the reveal window an edit changes nothing players hold, so the fan-out sends them nothing", () => {
    for (const edit of [...EDITS, { t: "unshuffle" } as const]) {
      let state = run(library(), PLAY).state;
      if (edit.t === "unshuffle") state = run(state, queue({ t: "shuffle", seed: "mix1" }), 5_000).state;
      const t = table(state);
      const b = batch(state, queue(edit), 10_000, t.all);
      assert.deepEqual(b.r.touched, [keys.playing], edit.t);
      assert.deepEqual(b.sent.get(t.p1), [], `${edit.t}: no change for Pat`);
      assert.deepEqual(b.sent.get(t.display), [], `${edit.t}: none for the display`);
      assert.equal(playersRun(b.state, edit.t)?.next, undefined);
      assert.deepEqual(soundKeysHeld(t.p1), [keys.sound("m1")]);
    }
  });

  test("inside it an edit that changes the following track swaps next at the same start, the new sound unnamed and the old one gone", () => {
    const swaps: [Extract<Op, { t: "music.queue" }>["edit"], string][] = [
      [{ t: "next", soundIds: ["lich"] }, "lich"],
      [{ t: "move", soundId: "m3", to: "first" }, "m3"],
      [{ t: "move", soundId: "m2", to: "passEnd" }, "m3"],
      [{ t: "remove", soundId: "m2" }, "m3"],
    ];
    for (const [edit, next] of swaps) {
      // The tick revealed Lanterns 20 s before its start at 55 s.
      const state = tick(run(run(library(), { t: "room.update", settings: { soundNames: true } }).state, PLAY).state).state;
      const t = table(state);
      const b = batch(state, queue(edit), 40_000, t.all);
      const where = `${edit.t} ${"soundId" in edit ? edit.soundId : ""}`;
      assert.deepEqual(playersRun(b.state, where)?.next, { soundId: next, at: S0 + 55_000 }, where);
      for (const conn of [t.p1, t.display]) {
        const sent = b.sent.get(conn)!;
        assert.deepEqual(changeOf(sent, keys.sound(next)), { key: keys.sound(next), value: cut(next) }, `${where}: the new next arrives unnamed`);
        assert.deepEqual(changeOf(sent, keys.sound("m2")), { key: keys.sound("m2"), deleted: true }, `${where}: the old next leaves`);
        assert.deepEqual(soundKeysHeld(conn), [keys.sound("m1"), keys.sound(next)].sort());
      }
      assert.deepEqual([...visibleAssetIds(b.state, P1, OPTS)].sort(), ["file-m1", `file-${next}`].sort(), `${where}: the old next's file is no longer Pat's`);
    }
  });

  test("inside it an edit that keeps the following track sends players nothing", () => {
    const keeping: Extract<Op, { t: "music.queue" }>["edit"][] = [
      { t: "add", soundIds: ["lich"] },
      { t: "move", soundId: "m3", to: "passEnd" },
    ];
    for (const edit of keeping) {
      const state = tick(run(library(), PLAY).state).state;
      const t = table(state);
      const b = batch(state, queue(edit), 40_000, t.all);
      assert.deepEqual(b.sent.get(t.p1), [], edit.t);
      assert.deepEqual(playersRun(b.state, edit.t)?.next, { soundId: "m2", at: S0 + 55_000 });
    }
  });

  test("a jump before and inside the window is a new run players join at its place, its next only when due", () => {
    const before = batch(run(library(), PLAY).state, { t: "music.jump", run: "r2", from: "r1", soundId: "m3", ms: 10_000 }, 10_000, table(run(library(), PLAY).state).all).state;
    assert.deepEqual(playersRun(before, "a jump before the window"), { run: "r2", repeat: "all", fade: 5, now: { soundId: "m3", at: S0 + 10_000 - 10_000 } });
    const state = tick(run(library(), PLAY).state).state;
    const t = table(state);
    const late = batch(state, { t: "music.jump", run: "r2", from: "r1", soundId: "m3", ms: 40_000 }, 40_000, t.all);
    assert.deepEqual(playersRun(late.state, "a seek into the window"), { run: "r2", repeat: "all", fade: 5, now: { soundId: "m3", at: S0 }, next: { soundId: "m1", at: S0 + 55_000 } });
    assert.deepEqual(changeOf(late.sent.get(t.p1)!, keys.sound("m2")), { key: keys.sound("m2"), deleted: true });
    assert.deepEqual(soundKeysHeld(t.p1), [keys.sound("m1"), keys.sound("m3")]);
  });
});
