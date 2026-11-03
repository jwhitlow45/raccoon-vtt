import assert from "node:assert/strict";
import { describe, test, type TestContext } from "node:test";
import { uuidv7 } from "#shared/ids.ts";
import { SOUND_LIMITS } from "#shared/limits.ts";
import type { RoomState } from "#shared/model.ts";
import { SOUND_OFF } from "#shared/permissions.ts";
import type { ServerMessage } from "#shared/protocol.ts";
import { LEAD_MS, type MusicRun, type Playing, type Sound } from "#shared/sound.ts";
import { RoomActor, type ActorDeps } from "./actor.ts";
import { SnapshotBudget } from "./budgets.ts";
import type { RoomGateway } from "./gateway.ts";
import type { AssetFactRow } from "./persistence.ts";
import { scopeFixture, scopeObserver, ScopeClient, UndoScopeDb, until } from "./undoScopeTesting.ts";

/**
 * The server moves the music on (docs/design/design-v1-music.md 6.4) and
 * keeps sound's rules where ops arrive (6.2): the queued tick computed from
 * the staged state, its back-off, the members rule with a table display
 * on, the load rules, the server's switch, the quota, and a sound's length
 * from its row.
 */

type Event = Extract<ServerMessage, { t: "ev" }>;

const ROOM = "UNDOSCOPE";
const T0 = Date.parse("2026-11-02T20:00:00.000Z");
const FILE = uuidv7();
const RAIN_FILE = uuidv7();

function sound(id: string, use: Sound["use"], ms: number): Sound {
  return { id, rev: 0, name: id, assetId: id === "rain" ? RAIN_FILE : FILE, ms, use };
}

/** The fixture's room with a library of three 60 s tracks, a loop and an effect, and a playlist of the tracks. */
function library(playing?: Playing): ReturnType<typeof scopeFixture> {
  const f = scopeFixture();
  f.state.sounds = { a: sound("a", "music", 60_000), b: sound("b", "music", 60_000), c: sound("c", "music", 60_000), rain: sound("rain", "loop", 20_000), boom: sound("boom", "effect", 3_000) };
  f.state.playlists = { night: { id: "night", rev: 0, name: "Night", sounds: ["a", "b", "c"], repeat: "all", fade: 5 } };
  if (playing) f.state.playing = playing;
  return f;
}

function run(fields: Partial<MusicRun> = {}): MusicRun {
  return { run: "r0", playlistId: "night", order: ["a", "b", "c"], index: 0, repeat: "all", fade: 5, now: { soundId: "a", at: T0 }, ...fields };
}

function playing(music: MusicRun | null, more: Partial<Playing> = {}): Playing {
  return { rev: 4, music, loops: {}, effects: [], volume: { music: 100, effects: 100 }, ...more };
}

function rows(): AssetFactRow[] {
  return [
    { id: FILE, room_id: ROOM, kind: "sound" as AssetFactRow["kind"], width: 0, height: 0, uploaders: null, media: "mp3", audio: { ms: 61_234, channels: 2, kbps: 128 } } as AssetFactRow,
    { id: RAIN_FILE, room_id: ROOM, kind: "sound" as AssetFactRow["kind"], width: 0, height: 0, uploaders: null, media: "mp3", audio: { ms: 1, channels: 9, kbps: 1 } } as AssetFactRow,
  ];
}

type Harness = { actor: RoomActor; db: UndoScopeDb; clock: { now: number }; warnings: string[] };

async function load(t: TestContext, state: RoomState, opts: { roomSound?: boolean; lastActiveAt?: number; readOnly?: boolean } = {}): Promise<Harness> {
  const db = new UndoScopeDb(state);
  db.assetRows = rows();
  const clock = { now: T0 };
  const warnings: string[] = [];
  const info: ActorDeps["info"] = { roomId: ROOM, pinned: false, createdIp: null, readOnly: opts.readOnly ?? false, ...(opts.lastActiveAt !== undefined ? { lastActiveAt: opts.lastActiveAt } : {}) };
  const actor = await RoomActor.load({
    pool: db.pool(),
    info,
    log: { info() {}, warn(_o: unknown, message?: string) { warnings.push(String(message)); }, error() {}, debug() {} } as ActorDeps["log"],
    budget: new SnapshotBudget(),
    gateway: {} as RoomGateway,
    options: { batchMs: 1, retryBaseMs: 5, retryMaxMs: 20, snapshotIdleMs: 60_000, grantRecheckMs: 60_000, roomSound: opts.roomSound ?? true, now: () => clock.now },
  });
  assert.ok(actor);
  t.after(() => actor.shutdown({ code: 1012, snapshot: false }));
  return { actor, db, clock, warnings };
}

/** Lets the queue reach a tick placed at the clock's time: a socket's coming places the timer afresh. */
async function tickNow(h: Harness, f: ReturnType<typeof scopeFixture>, ops = h.db.stored.length): Promise<void> {
  await scopeObserver(h.actor, { memberId: f.player.id, role: "player", display: true });
  await until(() => (h.db.stored.length > ops ? true : undefined), "a stored tick");
}

const settled = () => new Promise((resolve) => setTimeout(resolve, 30));

describe("the server's tick (6.4)", () => {
  test("a tick at its due time stores the reveal and then the promotion, each with the rev it read", async (t) => {
    const f = library(playing(run()));
    const h = await load(t, f.state);
    const dm = await ScopeClient.open(h.actor, f.dm, "dm", () => h.clock.now);
    // 60 s tracks crossing over 5 s: the next starts at 55 s, revealed 20 s before.
    assert.equal(h.actor.soundTickAt, T0 + 35_000);
    h.clock.now = T0 + 35_000;
    await tickNow(h, f);
    const reveal = h.db.stored.at(-1)!;
    assert.equal(reveal.t, "sys.sound");
    assert.deepEqual(reveal, { t: "sys.sound", from: 4, music: { ...run(), next: { soundId: "b", at: T0 + 55_000 } } });
    assert.equal(h.actor.committed.state.playing?.rev, 5);
    assert.equal(h.actor.soundTickAt, T0 + 60_000, "promoted once the outgoing track has ended");
    h.clock.now = T0 + 60_000;
    await tickNow(h, f);
    assert.deepEqual(h.db.stored.at(-1), { t: "sys.sound", from: 5, music: { ...run(), index: 1, now: { soundId: "b", at: T0 + 55_000 } } });
    void dm;
  });

  test("a Skip queued before the tick wins: the tick computes from what the Skip left", async (t) => {
    const f = library(playing(run()));
    const h = await load(t, f.state);
    const dm = await ScopeClient.open(h.actor, f.dm, "dm", () => h.clock.now);
    h.clock.now = T0 + 36_000;
    await dm.apply({ t: "music.skip", run: "r1" });
    const after = h.actor.committed.state.playing!.music!;
    assert.deepEqual(after.now, { soundId: "b", at: T0 + 36_000 + LEAD_MS });
    // The tick that was due at 35 s finds b just started: nothing to reveal yet, so it stores nothing.
    await scopeObserver(h.actor, { memberId: f.player.id, role: "player", display: true });
    await settled();
    assert.equal(h.db.stored.filter((op) => op.t === "sys.sound").length, 0);
    assert.equal(h.actor.soundTickAt, T0 + 36_400 + 35_000);
  });

  test("a refused step logs once, waits for a commit to playing or a minute, and never spins", async (t) => {
    // A hand-made room whose run names a loop sound among its tracks: the tick's step is refused (sysSound's track check).
    const { playlistId: _label, ...unlabelled } = run({ order: ["a", "rain"], now: { soundId: "a", at: T0 - 40_000 } });
    const f = library(playing(unlabelled));
    const h = await load(t, f.state);
    await settled();
    assert.equal(h.db.stored.length, 0);
    assert.equal(h.warnings.filter((w) => w === "the music's step was refused").length, 1);
    const dm = await ScopeClient.open(h.actor, f.dm, "dm", () => h.clock.now);
    assert.equal(h.actor.soundTickAt, T0 + SOUND_LIMITS.tickBackoffMs, "backed off a minute, not re-armed at its passed due time");
    // A commit to playing lifts the back-off at once: the step is tried again, refused again, and backs off again.
    await dm.apply({ t: "sound.mix", music: 50 });
    await settled();
    assert.equal(h.db.stored.filter((op) => op.t === "sys.sound").length, 0);
    assert.equal(h.actor.soundTickAt, T0 + SOUND_LIMITS.tickBackoffMs);
    assert.equal(h.warnings.filter((w) => w === "the music's step was refused").length, 1, "one log line a run");
    h.clock.now = T0 + 30_000;
    await scopeObserver(h.actor, { memberId: f.player.id, role: "player", display: true });
    await settled();
    assert.equal(h.db.stored.filter((op) => op.t === "sys.sound").length, 0, "no retry inside the minute");
    // A minute on, the schedule has passed the broken track, which ends the run: that step stores.
    h.clock.now = T0 + SOUND_LIMITS.tickBackoffMs;
    await tickNow(h, f);
    assert.deepEqual(h.db.stored.at(-1), { t: "sys.sound", from: 5, music: null });
  });

  test("no tick runs while no socket is open, nor with the switch off", async (t) => {
    const f = library(playing(run()));
    const h = await load(t, f.state);
    assert.equal(h.actor.soundTickAt, null);
    const g = library(playing(null, { loops: { l1: { soundId: "rain", at: T0, volume: 70 } } }));
    const off = await load(t, g.state, { roomSound: false });
    await settled();
    await ScopeClient.open(off.actor, g.dm, "dm", () => off.clock.now);
    assert.equal(off.actor.soundTickAt, null);
  });
});

describe("the members rule and the load rules (6.4)", () => {
  test("15 minutes after the last member socket closed, with a table display on, a tick stops music, loops and effects", async (t) => {
    const f = library(playing(run({ repeat: "one" }), { loops: { l1: { soundId: "rain", at: T0, volume: 70 } }, effects: [{ id: "e1", builtin: "crash", at: T0 }] }));
    const h = await load(t, f.state);
    const dm = await ScopeClient.open(h.actor, f.dm, "dm", () => h.clock.now);
    await scopeObserver(h.actor, { memberId: f.player.id, role: "player", display: true });
    assert.equal(h.actor.soundTickAt, null, "Repeat one with a member here never ticks");
    h.clock.now = T0 + 60_000;
    h.actor.detach(dm.conn);
    assert.equal(h.actor.soundTickAt, T0 + 60_000 + SOUND_LIMITS.membersGoneMs, "the display keeps a timer for the members rule");
    h.clock.now = T0 + 60_000 + SOUND_LIMITS.membersGoneMs;
    await tickNow(h, f);
    assert.deepEqual(h.db.stored.at(-1), { t: "sys.sound", from: 4, music: null, loops: {}, effects: [] });
    const after = h.actor.committed.state.playing!;
    assert.equal(after.music, null);
    assert.deepEqual(after.loops, {});
    assert.deepEqual(after.effects, []);
  });

  test("a room loaded more than 15 minutes after its last commit starts silent, and one loaded sooner keeps its place", async (t) => {
    const f = library(playing(run({ repeat: "one" })));
    const late = await load(t, f.state, { lastActiveAt: T0 - SOUND_LIMITS.membersGoneMs - 1 });
    await until(() => (late.db.stored.length > 0 ? true : undefined), "the load's stop");
    assert.deepEqual(late.db.stored, [{ t: "sys.sound", from: 4, music: null, loops: {}, effects: [] }]);
    const g = library(playing(run({ repeat: "one" })));
    const soon = await load(t, g.state, { lastActiveAt: T0 - 60_000 });
    await settled();
    assert.equal(soon.db.stored.length, 0, "a deploy in the middle of a session keeps its sound");
    assert.equal(soon.actor.committed.state.playing?.music?.now.at, T0);
  });

  test("a load within 15 minutes catches up in one step", async (t) => {
    const f = library(playing(run()));
    const h = await load(t, f.state, { lastActiveAt: T0 });
    h.clock.now = T0 + 40_000;
    await settled();
    // At load the clock was T0 and nothing was due: the step comes with the first socket once the clock moved on.
    await tickNow(h, f);
    assert.equal(h.db.stored.length, 1);
    assert.deepEqual(h.db.stored[0], { t: "sys.sound", from: 4, music: { ...run(), next: { soundId: "b", at: T0 + 55_000 } } });
  });

  test("with the switch off a room loads with the sound that names files stopped", async (t) => {
    const f = library(playing(run(), { loops: { l1: { soundId: "rain", at: T0, volume: 70 } } }));
    const h = await load(t, f.state, { roomSound: false });
    await until(() => (h.db.stored.length > 0 ? true : undefined), "the load's stop");
    assert.deepEqual(h.db.stored, [{ t: "sys.sound", from: 4, music: null, loops: {}, effects: [] }]);
  });
});

describe("sound's rules where ops arrive (6.2)", () => {
  test("a sound's length comes from its row, and a row whose facts do not check is refused", async (t) => {
    const f = library();
    const h = await load(t, f.state);
    const dm = await ScopeClient.open(h.actor, f.dm, "dm", () => h.clock.now);
    await dm.apply({ t: "sound.create", id: "s9", assetId: FILE, name: "Tavern", use: "music", ms: 30_000 });
    assert.equal(h.actor.committed.state.sounds?.s9?.ms, 61_234, "the client's number is replaced by the row's");
    const refused = await dm.send({ t: "sound.create", id: "s10", assetId: RAIN_FILE, name: "Rain", use: "loop", ms: 20_000 });
    assert.equal(refused.rejects?.[0]?.code, "gone");
  });

  test("with the switch off ops that name a sound file are refused, and stops, volumes and built-ins pass", async (t) => {
    const f = library(playing(null));
    const h = await load(t, f.state, { roomSound: false });
    const dm = await ScopeClient.open(h.actor, f.dm, "dm", () => h.clock.now);
    for (const op of [
      { t: "sound.create", id: "s9", assetId: FILE, name: "Tavern", use: "music", ms: 60_000 },
      { t: "music.play", run: "r1", playlistId: "night", order: ["a", "b", "c"], repeat: "all", fade: 5 },
      { t: "loop.start", id: "l1", soundId: "rain", volume: 70 },
      { t: "effect.fire", id: "e1", soundId: "boom" },
    ]) {
      const ev: Event = await dm.send(op);
      assert.equal(ev.rejects?.[0]?.message, SOUND_OFF, op.t);
    }
    for (const op of [{ t: "effect.fire", id: "e2", builtin: "crash" }, { t: "sound.mix", music: 40 }, { t: "sound.stopAll" }, { t: "playlist.delete", id: "night" }, { t: "sound.delete", id: "boom" }]) await dm.apply(op);
  });

  test("a room at its quota can always fall silent: stops, pause, deletes and quieter volumes pass, a play and a louder volume do not", async (t) => {
    const f = library(playing(run(), { loops: { l1: { soundId: "rain", at: T0, volume: 70 }, l2: { soundId: "rain2", at: T0, volume: 70 } } }));
    f.state.sounds!.rain2 = sound("rain2", "loop", 20_000);
    const h = await load(t, f.state, { readOnly: true });
    const dm = await ScopeClient.open(h.actor, f.dm, "dm", () => h.clock.now);
    for (const op of [{ t: "sound.mix", music: 60 }, { t: "loop.set", id: "l1", volume: 70 }, { t: "loop.set", id: "l1", volume: 40 }, { t: "music.pause" }, { t: "loop.stop", id: "l2" }, { t: "sound.delete", id: "boom" }, { t: "playlist.delete", id: "night" }, { t: "music.stop" }, { t: "sound.stopAll" }]) {
      await dm.apply(op);
    }
    for (const op of [{ t: "sound.mix", music: 80 }, { t: "music.play", run: "r2", soundId: "a", order: ["a"], repeat: "all", fade: 5 }, { t: "effect.fire", id: "e1", builtin: "crash" }]) {
      const ev = await dm.send(op);
      assert.equal(ev.rejects?.[0]?.code, "quota", op.t);
    }
  });
});
