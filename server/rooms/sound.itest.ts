import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { OP_VERSION } from "#shared/migrate.ts";
import type { RoomState } from "#shared/model.ts";
import type { ProjectedState } from "#shared/project.ts";
import type { Op, ServerMessage } from "#shared/protocol.ts";
import { SOUND_LIMITS } from "#shared/limits.ts";
import type { Playing, Sound } from "#shared/sound.ts";
import { framesFor, silentFrames } from "#shared/audio/mp3Testutil.ts";
import { formatDisplayCode } from "../auth/displaySessions.ts";
import { loadRoom } from "./persistence.ts";
import { startEngine, type Engine, type TestClient } from "./testing.ts";

/**
 * Synced music and sound in a live room, in Postgres and through replay
 * (docs/design/design-v1-music.md 6.4, 6.5, 6.7 and section 12):
 * players' and a display's frames, the server's ticks on a clock the test
 * moves, a reclassified effect's entry leaving players' frames in its own
 * batch, Undo and Redo, the `time` frame, the load's stop, and stored ops of
 * both versions replaying to the room they made.
 */

const clock = { now: Date.now() };

/**
 * Words only the DM keeps: the playlist's name, the next track's and the
 * effect's. The track playing now is named to players once the DM turns on
 * Players see what is playing, so its name is no secret then.
 */
const SECRET = ["Tavern night", "Old Road", "Thunderclap"];

function sound(id: string, name: string, use: Sound["use"], ms: number, assetId: string): Sound {
  return { id, rev: 0, name, assetId, ms, use };
}

/** Writes a library into a room's stored snapshot, as an upload and its `sound.create` would leave it. */
async function withLibrary(t: Engine, roomId: string): Promise<{ base: number; initial: RoomState }> {
  await t.manager.unload(roomId);
  const { rows } = await t.pool.query<{ seq: string; state: RoomState }>("select seq::text, state from room_snapshots where room_id = $1", [roomId]);
  const state = rows[0]!.state;
  state.sounds = {
    pony: sound("pony", "Prancing Pony", "music", 60_000, "00000000-0000-7000-8000-00000000000a"),
    road: sound("road", "Old Road", "music", 60_000, "00000000-0000-7000-8000-00000000000b"),
    rain: sound("rain", "Rain", "loop", 20_000, "00000000-0000-7000-8000-00000000000c"),
    thunder: sound("thunder", "Thunderclap", "effect", 3_000, "00000000-0000-7000-8000-00000000000d"),
  };
  state.playlists = { night: { id: "night", rev: 0, name: "Tavern night", sounds: ["pony", "road"], repeat: "all", fade: 5 } };
  await t.pool.query("update room_snapshots set state = $2 where room_id = $1", [roomId, JSON.stringify(state)]);
  return { base: Number(rows[0]!.seq), initial: state };
}

type Sock = Awaited<ReturnType<Engine["connect"]>>;

/** Every frame a socket received, kept for the leak scan, and a wait on the newest. */
function recorder(sock: Sock) {
  const all: ServerMessage[] = [];
  const take = () => all.push(...(sock.received.splice(0) as ServerMessage[]));
  return {
    all,
    async until<T>(find: (frames: ServerMessage[]) => T | undefined, what: string): Promise<T> {
      const deadline = Date.now() + 5_000;
      while (Date.now() < deadline) {
        take();
        const found = find(all);
        if (found !== undefined) return found;
        await delay(5);
      }
      assert.fail(`timed out waiting for ${what}`);
    },
    take,
  };
}

/** The newest value a socket was sent for a key, or undefined. */
function latest(frames: ServerMessage[], key: string): { value: unknown } | { deleted: true } | undefined {
  for (let i = frames.length - 1; i >= 0; i--) {
    const m = frames[i]!;
    if (m.t !== "ev") continue;
    const change = m.changes.findLast((c) => c.key === key);
    if (change) return "deleted" in change ? { deleted: true } : { value: change.value };
  }
  return undefined;
}

describe("synced music and sound in a live room", () => {
  let t: Engine;
  before(async () => {
    t = await startEngine({ rooms: { idleUnloadMs: 60_000, actor: { snapshotOps: 1_000, snapshotIdleMs: 60_000, roomSound: true, now: () => clock.now } } });
  });
  after(() => t.close());

  test("players and a display hear only what plays, the tick reveals the next track late and nameless, and stored ops replay to the same room", async () => {
    const dmClient = t.client();
    const { roomId } = await dmClient.createRoom("Sound");
    const playerClient = t.client();
    await playerClient.join(roomId, "Pat");
    const { base, initial } = await withLibrary(t, roomId);
    const dm = await t.connect(roomId, dmClient);
    const road = ((await dm.snapshot("dm")).state as ProjectedState).meta.playerSceneId!;
    const player = await t.connect(roomId, playerClient);
    await player.snapshot("pat");
    const pat = recorder(player);
    const tv = t.client();
    const code = (await dmClient.post(`/api/rooms/${roomId}/display/code`)).json<{ code: string }>().code;
    assert.equal((await tv.post("/api/display/redeem", { code: formatDisplayCode(code) })).statusCode, 200);
    const display = await t.connectDisplay(roomId, tv);
    await display.snapshot("tv");
    const screen = recorder(display);

    // The `time` frame answers from the clock every op reads, a display's too (5.1).
    player.send({ t: "time", k: 7 });
    display.send({ t: "time", k: 8 });
    const answer = await pat.until((f) => f.find((m) => m.t === "time"), "a time answer");
    assert.deepEqual(answer, { t: "time", k: 7, at: clock.now });
    assert.deepEqual(await screen.until((f) => f.find((m) => m.t === "time"), "the display's time answer"), { t: "time", k: 8, at: clock.now });

    const start = clock.now;
    await dm.apply({ t: "music.play", run: "run1", playlistId: "night", order: ["pony", "road"], repeat: "all", fade: 5 });
    const heard = (await pat.until((f) => {
      const p = latest(f, "playing");
      return p && "value" in p ? (p.value as Playing) : undefined;
    }, "playing")) as Playing;
    assert.deepEqual(heard.music, { run: "run1", repeat: "all", fade: 5, now: { soundId: "pony", at: start + 400 } }, "no order, place or label");
    assert.equal(heard.rev, 0);
    const pony = await pat.until((f) => latest(f, "sound:pony"), "the track's sound");
    assert.ok("value" in pony);
    assert.deepEqual(pony.value, { id: "pony", rev: 0, assetId: "00000000-0000-7000-8000-00000000000a", ms: 60_000, use: "music" }, "no name while the DM keeps names");
    assert.equal(latest(pat.all, "sound:road"), undefined, "no next track before the reveal");

    // The tick's reveal, 20 s before the next track starts: nameless, in its own batch.
    clock.now = start + 400 + 35_000;
    await dm.apply({ t: "sound.mix", music: 80 });
    const revealed = await pat.until((f) => {
      const p = latest(f, "playing");
      return p && "value" in p && (p.value as Playing).music?.next ? (p.value as Playing) : undefined;
    }, "the reveal");
    assert.deepEqual(revealed.music?.next, { soundId: "road", at: start + 400 + 55_000 });
    const next = await pat.until((f) => latest(f, "sound:road"), "the next track's sound");
    assert.ok("value" in next && (next.value as Sound).name === undefined);

    // Names follow the switch, only for now and the loops.
    await dm.apply({ t: "room.update", settings: { soundNames: true } });
    await dm.apply({ t: "loop.start", id: "loop1", soundId: "rain", volume: 70 });
    const named = await pat.until((f) => {
      const v = latest(f, "sound:pony");
      return v && "value" in v && (v.value as Sound).name !== undefined ? (v.value as Sound) : undefined;
    }, "the track's name");
    assert.equal(named.name, "Prancing Pony");
    const rain = await pat.until((f) => {
      const v = latest(f, "sound:rain");
      return v && "value" in v ? (v.value as Sound) : undefined;
    }, "the loop's sound");
    assert.equal(rain.name, "Rain");

    // An effect reaches players nameless, and leaves their frames in the very batch that gives its sound another use.
    await dm.apply({ t: "effect.fire", id: "fx1", soundId: "thunder" });
    await pat.until((f) => {
      const p = latest(f, "playing");
      return p && "value" in p && (p.value as Playing).effects.some((e) => e.id === "fx1") ? true : undefined;
    }, "the effect");
    const reclassified = await dm.apply({ t: "sound.update", id: "thunder", use: "loop" });
    const leaving = await pat.until((f) => f.find((m) => m.t === "ev" && m.seq === reclassified.seq), "the reclassifying batch");
    assert.ok(leaving.t === "ev");
    const left = leaving.changes.find((c) => c.key === "playing");
    assert.ok(left && "value" in left && (left.value as Playing).effects.length === 0, "the entry leaves in that batch, with no other op");
    assert.ok(leaving.changes.some((c) => c.key === "sound:thunder" && "deleted" in c));
    // Undo puts the use back, and the entry, still history in the DM's list, plays again only as the state says.
    const undone = await dm.step("undo", "setup");
    assert.equal(undone.rejects, undefined);
    const redone = await dm.step("redo", "setup");
    assert.equal(redone.rejects, undefined);

    // Behind a blackout players and displays get no sound, and an effect fired there never reaches them.
    await dm.apply({ t: "view.blackout", blackout: true });
    await pat.until((f) => (latest(f, "playing") && "deleted" in latest(f, "playing")! ? true : undefined), "silence behind the blackout");
    await dm.apply({ t: "effect.fire", id: "fx2", builtin: "crash" });
    await dm.apply({ t: "view.blackout", blackout: false });
    const back = await pat.until((f) => {
      const p = latest(f, "playing");
      return p && "value" in p ? (p.value as Playing) : undefined;
    }, "sound after the blackout");
    assert.ok(!back.effects.some((e) => e.id === "fx2"));

    await delay(150);
    pat.take();
    screen.take();
    for (const [who, frames] of [["Pat", pat.all], ["the display", screen.all]] as const) {
      const text = JSON.stringify(frames);
      for (const word of SECRET) assert.ok(!text.includes(word), `${who} never receives "${word}"`);
      // A scene has an `order` of its own, so the run's fields are looked for in what plays and the sounds alone.
      const sound = JSON.stringify(
        frames.flatMap((m): unknown[] => {
          if (m.t === "ev") return m.changes.filter((c) => c.key === "playing" || c.key.startsWith("sound:") || c.key.startsWith("playlist:"));
          if (m.t === "snapshot") {
            const s = m.state as ProjectedState;
            return [s.playing, s.sounds, s.playlists];
          }
          return [];
        }),
      );
      for (const field of ['"order"', '"index"', '"playlistId"', '"paused"', '"dmEffects"', '"playlist:']) assert.ok(!sound.includes(field), `${who} never receives ${field}`);
      assert.ok(!text.includes('"playlists"'), `${who} never receives the playlists`);
    }

    // Stored ops replay to the room they made, the server's ticks as stored.
    const live = t.manager.get(roomId)!.committed.state;
    dm.close();
    player.close();
    display.close();
    await dm.waitClosed();
    await t.manager.unload(roomId);
    await t.pool.query("update room_snapshots set seq = $2, state = $3 where room_id = $1", [roomId, base, JSON.stringify(initial)]);
    const { rows } = await t.pool.query<{ op: Op }>("select op from room_ops where room_id = $1 and seq > $2 order by seq", [roomId, base]);
    assert.ok(rows.some((r) => r.op.t === "sys.sound"), "a tick was stored");
    const loaded = await loadRoom(t.pool, roomId);
    assert.ok(loaded && !loaded.replayFailed);
    assert.deepEqual(loaded.state.playing, live.playing);
    assert.deepEqual(loaded.state.sounds, live.sounds);
    assert.deepEqual(loaded.state.meta.settings.soundNames, true);
    void road;
  });

  test("a stored version 45 op then version 46 sound ops replay, and a room loaded long after its last commit starts silent", async () => {
    const owner = t.client();
    const { roomId } = await owner.createRoom("Stored sound");
    const { base } = await withLibrary(t, roomId);
    const { rows: snap } = await t.pool.query<{ state: RoomState }>("select state from room_snapshots where room_id = $1", [roomId]);
    const dmId = Object.values(snap[0]!.state.members).find((m) => m.kind === "dm")!.id;
    const sceneId = snap[0]!.state.meta.playerSceneId!;
    const ops: [Op, number][] = [
      [{ t: "scene.update", sceneId, patch: { name: "Forest road" } }, 45],
      [{ t: "music.play", run: "run9", soundId: "pony", order: ["pony"], repeat: "one", fade: 2 }, 46],
      [{ t: "loop.start", id: "loop9", soundId: "rain", volume: 60 }, 46],
      [{ t: "scene.update", sceneId, patch: { sound: { music: { playlistId: "night", repeat: "all", fade: 5 }, loops: [{ soundId: "rain", volume: 40 }] } } }, 46],
    ];
    const at = new Date(clock.now).toISOString();
    for (const [i, [op, version]] of ops.entries()) {
      await t.pool.query(
        `insert into room_ops (room_id, seq, at, actor_member_id, actor_role, op, op_version) values ($1, $2, $3, $4, 'dm', $5::jsonb, $6)`,
        [roomId, base + 1 + i, at, dmId, JSON.stringify(op), version],
      );
    }
    assert.ok(OP_VERSION >= 46);
    const loaded = await loadRoom(t.pool, roomId);
    assert.ok(loaded && !loaded.replayFailed);
    assert.equal(loaded.state.scenes[sceneId]!.name, "Forest road");
    assert.deepEqual(loaded.state.playing?.music?.now, { soundId: "pony", at: Date.parse(at) + 400 });
    assert.deepEqual(loaded.state.playing?.loops, { loop9: { soundId: "rain", at: Date.parse(at) + 400, volume: 60 } });
    assert.deepEqual(loaded.state.scenes[sceneId]!.sound, { music: { playlistId: "night", repeat: "all", fade: 5 }, loops: [{ soundId: "rain", volume: 40 }] });

    // Twenty minutes without a commit: the load's own tick stops what played, and stores the stop.
    await t.pool.query("update rooms set last_active_at = now() - interval '20 minutes' where id = $1", [roomId]);
    const dm = await t.connect(roomId, owner);
    await dm.snapshot("late");
    const deadline = Date.now() + 5_000;
    let last: Op | undefined;
    while (Date.now() < deadline) {
      const { rows: stored } = await t.pool.query<{ op: Op }>("select op from room_ops where room_id = $1 order by seq desc limit 1", [roomId]);
      last = stored[0]?.op;
      if (last?.t === "sys.sound") break;
      await delay(10);
    }
    assert.deepEqual(last, { t: "sys.sound", from: 2, music: null, loops: {}, effects: [] });
    const state = t.manager.get(roomId)!.committed.state;
    assert.equal(state.playing?.music ?? null, null);
    assert.deepEqual(state.playing?.loops ?? {}, {});
    assert.ok(SOUND_LIMITS.membersGoneMs < 20 * 60_000);
    dm.close();
  });
});


/**
 * The queue in a live room (docs/design/design-v1-music-player.md 6.6 and
 * the cases of section 10): what players' frames carry of an edit, the old
 * next's file answering 404, two DMs and both orders of an edit around
 * another DM's Play and a promotion, Previous twice and Play then Seek
 * within one round trip, Add to playlist from two DMs at once, a replay of
 * the edits after a crash, and the tick after a jump.
 */
describe("the queue in a live room", () => {
  const qclock = { now: Date.now() };
  let t: Engine;
  before(async () => {
    t = await startEngine({ env: { ROOM_SOUND: "1" }, rooms: { idleUnloadMs: 60_000, actor: { snapshotOps: 1_000, snapshotIdleMs: 60_000, roomSound: true, now: () => qclock.now } } });
  });
  after(() => t.close());

  /** Four 60 s tracks in Night, under Repeat all with a 5 s crossfade, and one outside it, every file made up. */
  async function queueRoom(extra: Record<string, Sound> = {}): Promise<{ roomId: string; dmKey: string; owner: TestClient; base: number; initial: RoomState }> {
    const owner = t.client();
    const { roomId, dmKey } = await owner.createRoom("Queue");
    await t.manager.unload(roomId);
    const { rows } = await t.pool.query<{ seq: string; state: RoomState }>("select seq::text, state from room_snapshots where room_id = $1", [roomId]);
    const state = rows[0]!.state;
    const asset = (i: number) => `00000000-0000-7000-8000-${String(i).padStart(12, "0")}`;
    state.sounds = Object.fromEntries(["a", "b", "c", "d", "e"].map((id, i) => [id, sound(id, `Track ${id}`, "music", 60_000, asset(i + 1))]));
    Object.assign(state.sounds, extra);
    state.playlists = { night: { id: "night", rev: 0, name: "Night", sounds: ["a", "b", "c", "d"], repeat: "all", fade: 5 } };
    await t.pool.query("update room_snapshots set state = $2 where room_id = $1", [roomId, JSON.stringify(state)]);
    return { roomId, dmKey, owner, base: Number(rows[0]!.seq), initial: state };
  }

  const NIGHT = { t: "music.play" as const, playlistId: "night", order: ["a", "b", "c", "d"], repeat: "all" as const, fade: 5 as const };
  const music = (roomId: string) => t.manager.get(roomId)!.committed.state.playing?.music ?? null;
  const refusal = (ev: Extract<ServerMessage, { t: "ev" }>) => ev.rejects?.[0]?.message;
  /** Any op that commits, so the actor arms the music's timer again from the clock the test moved. */
  let level = 50;
  const nudge = (sock: Sock) => sock.apply({ t: "sound.mix", music: level++ });
  /**
   * The answers to ops sent without waiting, as a device sends a second
   * press before the first is answered: by each op's `n`, its refusal's
   * words or undefined. One batch may answer several.
   */
  async function answers(sock: Sock, ns: number[]): Promise<(string | undefined)[]> {
    const out = new Map<number, string | undefined>();
    while (out.size < ns.length) {
      const ev = await sock.next("ev", (m) => ns.some((n) => !out.has(n) && ((m.acks?.includes(n) ?? false) || (m.rejects?.some((r) => r.n === n) ?? false))));
      for (const n of ns) {
        if (ev.acks?.includes(n)) out.set(n, undefined);
        const rejected = ev.rejects?.find((r) => r.n === n);
        if (rejected) out.set(n, rejected.message);
      }
    }
    return ns.map((n) => out.get(n));
  }

  test("Pat gets nothing for a Play next before the reveal, then only the new next, unnamed, and the old next's file answers 404", async () => {
    const dmClient = t.client();
    const { roomId } = await dmClient.createRoom("Queue frames");
    const files: { id: string; audio: { ms: number } }[] = [];
    // One upload at a time, as the server takes them.
    for (const seed of [11, 12, 13]) {
      const body = silentFrames(framesFor(60_000), { bits: (i) => ({ private: ((seed >> i % 30) & 1) === 1 }) });
      const res = await dmClient.request("PUT", `/api/rooms/${roomId}/assets?kind=sound`, undefined, { "content-type": "audio/mpeg" }, Buffer.from(body));
      assert.equal(res.statusCode, 200, res.body);
      files.push(res.json<{ id: string; audio: { ms: number } }>());
    }
    const [fa, fb, fe] = files as [(typeof files)[0], (typeof files)[0], (typeof files)[0]];
    assert.equal(new Set(files.map((f) => f.id)).size, 3, "three files");
    const playerClient = t.client();
    await playerClient.join(roomId, "Pat");
    const dm = await t.connect(roomId, dmClient);
    await dm.snapshot("dm");
    const player = await t.connect(roomId, playerClient);
    await player.snapshot("pat");
    const pat = recorder(player);
    for (const [id, f] of [["a", fa], ["b", fb], ["e", fe]] as const) assert.equal(refusal(await dm.apply({ t: "sound.create", id, assetId: f.id, name: `Secret ${id}`, use: "music", ms: f.audio.ms })), undefined);
    assert.equal(refusal(await dm.apply({ t: "playlist.create", id: "night", name: "Night", sounds: ["a", "b"], repeat: "all", fade: 5 })), undefined);
    const ms = fa.audio.ms;
    const start = qclock.now;
    assert.equal(refusal(await dm.apply({ t: "music.play", run: "q1", playlistId: "night", order: ["a", "b"], repeat: "all", fade: 5 })), undefined);
    await pat.until((f) => (latest(f, "playing") && "value" in latest(f, "playing")! ? true : undefined), "the run");
    const read = (f: { id: string }) => playerClient.request("GET", `/api/assets/${f.id}/full`, undefined, { range: "bytes=0-99" });

    // Before the reveal: the order changes for the DM alone, so Pat's socket gets no frame at all.
    qclock.now = start + 10_000;
    const early = await dm.apply({ t: "music.queue", from: "q1", edit: { t: "next", soundIds: ["e"] } });
    assert.equal(refusal(early), undefined);
    assert.equal(await player.maybe("ev", (m) => m.seq === early.seq, 300), null, "no ev for Pat");
    pat.take();
    assert.ok(!pat.all.some((m) => m.t === "ev" && m.seq === early.seq));
    assert.equal((await read(fe)).statusCode, 404, "a queued track's file is not Pat's");

    // The tick reveals e, the next track now, 20 s before it starts.
    qclock.now = start + 400 + ms - 5_000 - 20_000 + 1_000;
    await nudge(dm);
    const revealed = await pat.until((f) => {
      const p = latest(f, "playing");
      return p && "value" in p && (p.value as Playing).music?.next ? (p.value as Playing) : undefined;
    }, "the reveal");
    const nextAt = start + 400 + ms - 5_000;
    assert.deepEqual(revealed.music?.next, { soundId: "e", at: nextAt });
    assert.equal((await read(fe)).statusCode, 206, "the revealed next's file is Pat's");
    assert.equal((await read(fb)).statusCode, 404);

    // Inside the window Play next b swaps the revealed next at the same start: one ev naming b and not e.
    const swap = await dm.apply({ t: "music.queue", from: "q1", edit: { t: "next", soundIds: ["b"] } });
    assert.equal(refusal(swap), undefined);
    const frame = await pat.until((f) => f.find((m) => m.t === "ev" && m.seq === swap.seq), "the swap's frame");
    assert.ok(frame.t === "ev");
    const playing = frame.changes.find((c) => c.key === "playing");
    assert.ok(playing && "value" in playing);
    assert.deepEqual((playing.value as Playing).music?.next, { soundId: "b", at: nextAt });
    assert.deepEqual(frame.changes.find((c) => c.key === "sound:b"), { key: "sound:b", value: { id: "b", rev: 0, assetId: fb.id, ms: fb.audio.ms, use: "music" } }, "the new next, unnamed");
    assert.deepEqual(frame.changes.find((c) => c.key === "sound:e"), { key: "sound:e", deleted: true }, "the old next leaves");
    assert.ok(!JSON.stringify(frame.changes.filter((c) => c.key !== "sound:e")).includes('"e"'), "nothing else names e");
    assert.equal((await read(fe)).statusCode, 404, "the old next's file answers 404 again");
    assert.equal((await read(fb)).statusCode, 206);

    await delay(150);
    pat.take();
    const text = JSON.stringify(pat.all);
    for (const word of ["Secret", "Night"]) assert.ok(!text.includes(word), `Pat never receives "${word}"`);
    const sounds = JSON.stringify(pat.all.flatMap((m): unknown[] => (m.t === "ev" ? m.changes.filter((c) => c.key === "playing") : m.t === "snapshot" ? [(m.state as ProjectedState).playing] : [])));
    for (const field of ['"order"', '"index"', '"shuffle"', '"playlistId"', '"paused"']) assert.ok(!sounds.includes(field), `Pat never receives ${field}`);
    dm.close();
    player.close();
  });

  test("two DMs: an edit before and after another DM's Play, a seek before and after a promotion, and edits made on the same view", async () => {
    const { roomId, dmKey, owner } = await queueRoom();
    const coClient = t.client();
    await coClient.claimDm(roomId, dmKey);
    const dm = await t.connect(roomId, owner);
    await dm.snapshot("dm");
    const co = await t.connect(roomId, coClient);
    await co.snapshot("co");
    const start = qclock.now;
    assert.equal(refusal(await dm.apply({ ...NIGHT, run: "r1" })), undefined);

    // Before another DM's Play the edit applies, and the Play then replaces it with Night whole.
    assert.equal(refusal(await dm.apply({ t: "music.queue", from: "r1", edit: { t: "remove", soundId: "c" } })), undefined);
    assert.deepEqual(music(roomId)?.order, ["a", "b", "d"]);
    assert.equal(refusal(await co.apply({ ...NIGHT, run: "r2" })), undefined);
    assert.deepEqual(music(roomId)?.order, ["a", "b", "c", "d"]);
    // After it, the edit made on r1 is refused.
    assert.equal(refusal(await dm.apply({ t: "music.queue", from: "r1", edit: { t: "remove", soundId: "c" } })), "The music changed. Try again.");

    // Two DMs on the same view: a remove, then the other's move and remove of the same track, and Shuffle off twice.
    assert.equal(refusal(await dm.apply({ t: "music.queue", from: "r2", edit: { t: "remove", soundId: "d" } })), undefined);
    assert.equal(refusal(await co.apply({ t: "music.queue", from: "r2", edit: { t: "move", soundId: "d", to: "first" } })), "That track left the queue.");
    const second = await co.apply({ t: "music.queue", from: "r2", edit: { t: "remove", soundId: "d" } });
    assert.equal(refusal(second), undefined);
    assert.deepEqual(second.changes, [], "the second remove writes nothing");
    assert.equal(refusal(await dm.apply({ t: "music.queue", from: "r2", edit: { t: "shuffle", seed: "mix1" } })), undefined);
    assert.equal(refusal(await dm.apply({ t: "music.queue", from: "r2", edit: { t: "unshuffle" } })), undefined);
    const off = await co.apply({ t: "music.queue", from: "r2", edit: { t: "unshuffle" } });
    assert.equal(refusal(off), undefined);
    assert.deepEqual(off.changes, [], "the second Shuffle off writes nothing");
    assert.deepEqual(music(roomId)?.order, ["a", "b", "c"]);

    // A seek made on a at 50 s lands before the promotion at b's start, 55 s in, and is refused after it.
    const r2At = music(roomId)!.now.at;
    qclock.now = r2At - 400 + 50_000;
    assert.equal(refusal(await dm.apply({ t: "music.jump", run: "r3", from: "r2", soundId: "a", ms: 40_000, on: "a" })), undefined);
    assert.deepEqual(music(roomId)?.now, { soundId: "a", at: qclock.now + 400 - 40_000 });
    qclock.now = qclock.now + 400 - 40_000 - 400 + 56_000;
    assert.equal(refusal(await co.apply({ t: "music.jump", run: "r4", from: "r3", soundId: "a", ms: 10_000, on: "a" })), "The music moved on. Try again.");
    void start;
    dm.close();
    co.close();
  });

  test("Home on a later row lands right after the track a tick promotes, in both orders, and a move of that row is refused", async () => {
    for (const tickFirst of [true, false]) {
      const { roomId, owner } = await queueRoom();
      const dm = await t.connect(roomId, owner);
      await dm.snapshot("dm");
      const start = qclock.now;
      assert.equal(refusal(await dm.apply({ ...NIGHT, run: "r1" })), undefined);
      // b starts at 55 s and the crossfade ends at 60 s, when the tick promotes it.
      qclock.now = start + 61_000;
      if (tickFirst) {
        await nudge(dm);
        await t.manager.get(roomId)!.read(() => undefined);
      }
      const home = await dm.apply({ t: "music.queue", from: "r1", edit: { t: "move", soundId: "d", to: "first" } });
      assert.equal(refusal(home), undefined, `tick first: ${tickFirst}`);
      await nudge(dm);
      assert.deepEqual(music(roomId), { run: "r1", playlistId: "night", order: ["a", "b", "d", "c"], index: 1, repeat: "all", fade: 5, now: { soundId: "b", at: start + 400 + 55_000 } }, `tick first: ${tickFirst}`);
      assert.equal(refusal(await dm.apply({ t: "music.queue", from: "r1", edit: { t: "move", soundId: "b", to: "passEnd" } })), "The playing track stays in the queue. Skip it or stop the music.");
      dm.close();
    }
  });

  test("Previous twice within a round trip from 0:40 of track 3, and Play then Seek before the Play is answered", async () => {
    const { roomId, owner } = await queueRoom();
    const dm = await t.connect(roomId, owner);
    await dm.snapshot("dm");
    const start = qclock.now;
    assert.equal(refusal(await dm.apply({ ...NIGHT, run: "r1", index: 2 })), undefined);
    qclock.now = start + 40_000;
    // The first restarts c. The second, sent before the first is answered, goes back to b: it names the run the first
    // made and the track the device still shows, its own jump pending.
    const first = dm.op({ t: "music.jump", run: "p1", from: "r1", soundId: "c", on: "c" });
    const second = dm.op({ t: "music.jump", run: "p2", from: "p1", soundId: "b", on: "c" });
    assert.deepEqual(await answers(dm, [first, second]), [undefined, undefined], "no refusal");
    assert.deepEqual(music(roomId), { run: "p2", playlistId: "night", order: ["a", "b", "c", "d"], index: 1, repeat: "all", fade: 5, now: { soundId: "b", at: qclock.now + 400 } });

    const play = dm.op({ ...NIGHT, run: "q1" });
    const seek = dm.op({ t: "music.jump", run: "q2", from: "q1", soundId: "a", ms: 20_000, on: "a" });
    assert.deepEqual(await answers(dm, [play, seek]), [undefined, undefined], "the seek applies to the new run");
    assert.deepEqual(music(roomId)?.run, "q2");
    assert.deepEqual(music(roomId)?.now, { soundId: "a", at: qclock.now + 400 - 20_000 });
    dm.close();
  });

  test("two DMs add to a playlist at once: both land on a 3-track one, and on a 99-track one the second is refused", async () => {
    const many = Object.fromEntries(Array.from({ length: 101 }, (_, i) => [`z${i}`, sound(`z${i}`, `Many ${i}`, "music", 60_000, `00000000-0000-7000-8001-${String(i).padStart(12, "0")}`)]));
    const { roomId, dmKey, owner } = await queueRoom(many);
    const coClient = t.client();
    await coClient.claimDm(roomId, dmKey);
    const dm = await t.connect(roomId, owner);
    await dm.snapshot("dm");
    const co = await t.connect(roomId, coClient);
    await co.snapshot("co");
    assert.equal(refusal(await dm.apply({ t: "playlist.create", id: "three", name: "Three", sounds: ["a", "b", "c"], repeat: "off", fade: 0 })), undefined);
    assert.equal(refusal(await dm.apply({ t: "playlist.create", id: "full", name: "Full", sounds: Object.keys(many).slice(0, 99), repeat: "off", fade: 0 })), undefined);
    const [x, y] = [dm.op({ t: "playlist.add", id: "three", soundId: "d" }), co.op({ t: "playlist.add", id: "three", soundId: "e" })];
    assert.deepEqual([...(await answers(dm, [x])), ...(await answers(co, [y]))], [undefined, undefined]);
    assert.deepEqual([...t.manager.get(roomId)!.committed.state.playlists!.three!.sounds].sort(), ["a", "b", "c", "d", "e"]);
    const [z1, z2] = [dm.op({ t: "playlist.add", id: "full", soundId: "z99" }), co.op({ t: "playlist.add", id: "full", soundId: "z100" })];
    const both = [...(await answers(dm, [z1])), ...(await answers(co, [z2]))];
    assert.deepEqual(both.filter((m) => m !== undefined), ["A playlist holds 100 tracks at most."], "one lands, the other is refused");
    assert.equal(t.manager.get(roomId)!.committed.state.playlists!.full!.sounds.length, 100);
    dm.close();
    co.close();
  });

  test("the edits and jumps replay after a crash to the room they made, and the tick after a jump reveals from the jump's place", async () => {
    const { roomId, owner, base, initial } = await queueRoom();
    const dm = await t.connect(roomId, owner);
    await dm.snapshot("dm");
    const start = qclock.now;
    const ops: Op[] = [
      { ...NIGHT, run: "r1" },
      { t: "music.queue", from: "r1", edit: { t: "shuffle", seed: "Zx-9_q" } },
      { t: "music.queue", from: "r1", edit: { t: "add", soundIds: ["e"] } },
      { t: "music.queue", from: "r1", edit: { t: "move", soundId: "e", to: "first" } },
      { t: "music.queue", from: "r1", edit: { t: "remove", soundId: "c" } },
      { t: "music.jump", run: "r2", from: "r1", soundId: "d" },
    ];
    for (const op of ops) assert.equal(refusal(await dm.apply(op)), undefined, op.t);
    const jumped = music(roomId)!;
    assert.equal(jumped.shuffle, true);
    assert.deepEqual(jumped.now, { soundId: "d", at: start + 400 });
    // The jump's track is revealed on from its own place: 35 s in, its next starts at 55 s.
    qclock.now = start + 36_000;
    await nudge(dm);
    const deadline = Date.now() + 5_000;
    while (music(roomId)?.next === undefined && Date.now() < deadline) await delay(5);
    const order = jumped.order!;
    assert.deepEqual(music(roomId)?.next, { soundId: order[(order.indexOf("d") + 1) % order.length], at: start + 400 + 55_000 });
    const { rows: ticks } = await t.pool.query<{ op: Op }>("select op from room_ops where room_id = $1 and op->>'t' = 'sys.sound' order by seq", [roomId]);
    assert.ok(ticks.some((r) => r.op.t === "sys.sound" && r.op.music?.run === "r2" && r.op.music.shuffle === true), "the tick carries the run whole, Shuffle included");

    // A crash: the snapshot is the one from before every op, so the load replays them all.
    const live = t.manager.get(roomId)!.committed.state;
    dm.close();
    await dm.waitClosed();
    await t.manager.unload(roomId);
    await t.pool.query("update room_snapshots set seq = $2, state = $3 where room_id = $1", [roomId, base, JSON.stringify(initial)]);
    const loaded = await loadRoom(t.pool, roomId);
    assert.ok(loaded && !loaded.replayFailed);
    assert.deepEqual(loaded.state.playing, live.playing);
  });
});
