import assert from "node:assert/strict";
import { test } from "node:test";
import type { ServerMessage } from "#shared/protocol.ts";
import type { MusicRun, Playlist, Sound } from "#shared/sound.ts";
import { DM, room } from "#shared/testutil.ts";
import { LocalServer } from "../../../dev/localServer.ts";
import { createRoomStore } from "../../../state/store.ts";
import { applyTestHistory, FakeClock, FakeOutbox } from "../../../state/testing.ts";

/*
 * Shuffle's prediction (docs/design/design-v1-music-player.md 6.5 and
 * 11.1): the DM's device mixes the order from the same seed the server
 * does, so Up next shows the confirmed order at once and never reorders
 * when the answer comes.
 */

const ids = Array.from({ length: 12 }, (_, i) => `m${i + 1}`);
const sounds: Record<string, Sound> = Object.fromEntries(ids.map((id) => [id, { id, rev: 0, name: `Track ${id}`, assetId: `file-${id}`, ms: 200_000, use: "music" }]));
const tavern: Playlist = { id: "tavern", rev: 0, name: "Tavern night", sounds: ids, repeat: "all", fade: 5 };

test("a predicted shuffle equals the confirmed one, and Shuffle off's prediction the playlist's order", () => {
  const clock = new FakeClock();
  // The store stamps a prediction with its clock and the fixture server with the wall clock, so both read the run inside one occurrence.
  clock.t = Date.now();
  const run: MusicRun = { run: "r1", playlistId: "tavern", order: ids, index: 2, repeat: "all", fade: 5, now: { soundId: "m3", at: clock.t - 10_000 } };
  const server = new LocalServer(room({ sounds, playlists: { tavern }, playing: { rev: 1, music: run, loops: {}, effects: [], volume: { music: 100, effects: 100 } } }), DM, "s1");
  const store = createRoomStore({ roomId: "R1", you: DM, clock, random: () => 0.5, clientId: "c1" });
  const outbox = new FakeOutbox();
  store.setOutbox(outbox);
  const hello = store.prepareHello();
  store.setConnection("open");
  store.applySnapshot(server.hello({ resumeFrom: hello.resumeFrom, sceneId: "s1" }));
  applyTestHistory(store, hello.resumeFrom - 1);
  const deliver = () => {
    const ops = outbox.sent.flatMap((m) => (m.t === "op" ? [{ n: m.n, op: m.op }] : []));
    outbox.sent = [];
    for (const msg of server.batch(ops)) receive(msg);
  };
  const receive = (msg: ServerMessage) => {
    if (msg.t === "ev") store.applyEv(msg);
    else if (msg.t === "snapshot") store.applySnapshot(msg);
    else throw new Error(`unexpected ${msg.t}`);
  };
  const music = () => store.store.getState().view?.playing?.music ?? null;

  store.dispatch({ t: "music.queue", from: "r1", edit: { t: "shuffle", seed: "0b7c1d2e-shuffle-seed" } });
  const predicted = music();
  assert.equal(predicted?.shuffle, true);
  assert.notDeepEqual(predicted?.order, ids, "mixed at once");
  assert.equal(predicted?.order?.indexOf("m3"), 2, "still 3 of 12");
  deliver();
  assert.equal(store.store.getState().pending.length, 0, "answered");
  assert.deepEqual(music()?.order, predicted?.order, "the confirmed order is the predicted one");
  assert.equal(music()?.shuffle, true);

  store.dispatch({ t: "music.queue", from: "r1", edit: { t: "unshuffle" } });
  assert.deepEqual(music()?.order, ids, "Shuffle off predicts the playlist's order");
  deliver();
  assert.deepEqual(music()?.order, ids);
  assert.equal(music()?.shuffle, undefined);
});
