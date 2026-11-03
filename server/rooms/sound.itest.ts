import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { OP_VERSION } from "#shared/migrate.ts";
import type { RoomState } from "#shared/model.ts";
import type { ProjectedState } from "#shared/project.ts";
import type { Op, ServerMessage } from "#shared/protocol.ts";
import { SOUND_LIMITS } from "#shared/limits.ts";
import type { Playing, Sound } from "#shared/sound.ts";
import { formatDisplayCode } from "../auth/displaySessions.ts";
import { loadRoom } from "./persistence.ts";
import { startEngine, type Engine } from "./testing.ts";

/**
 * Synced music and sound in a live room, in Postgres and through replay
 * (docs/design/design-v1-sound.md 6.4, 6.5, 6.7 and section 12, lane SN-A):
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

