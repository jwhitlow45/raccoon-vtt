import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { setFlagsFromString } from "node:v8";
import { runInNewContext } from "node:vm";
import { uuidv7 } from "#shared/ids.ts";
import { clientMessageSchema, type EphEvent, type GroupFrame } from "#shared/protocol.ts";
import { token } from "#shared/testutil.ts";
import { MAX_HELD_BYTES, MAX_HELD_BYTES_OFF, MAX_HELD_FRAMES, RoomActor } from "./actor.ts";
import { FULL_ALLOWANCE_BYTES, OFF_ALLOWANCE_BYTES, PreviewPool, SnapshotBudget } from "./budgets.ts";
import { Connection } from "./connection.ts";
import { MAX_STAGED_BYTES, Outbox } from "./ephemeral.ts";
import type { RoomGateway } from "./gateway.ts";
import { MAX_VERSIONS } from "./gestures.ts";
import { fullRoom } from "./limitsTesting.ts";
import { scopeFixture, StoredRoomDb } from "./undoScopeTesting.ts";

/*
 * The preview pool at its worst at once (design 7.6, a build measurement):
 * 154 sockets at full pace and the rest of 400 off, every one at its caps
 * through an uncovered tick, beside every receiver's preview state, measured
 * in the process. A container of 1,536 MiB holds that with the loaded rooms,
 * a map upload's peak and what a tick's release holds to send, or the
 * default pool comes down. That release is measured apart, the frames of
 * 10 sockets dragging 100 tokens each to a full room.
 */

const MiB = 1024 * 1024;
const T0 = Date.parse("2026-11-26T20:00:00.000Z");
/** A 100 megapixel map upload's peak for the whole container, as measured (docker-compose.server.yml). */
const UPLOAD_PEAK_MIB = 750;
const CONTAINER_MIB = 1_536;
/** The fewest rooms 400 sockets fill, at 64 a room (budgets.ts DEFAULT_SOCKET_CAPS). */
const ROOMS = Math.ceil(400 / 64);
/** One frame's messages: at most 100 frames, 99 ends and 100 drops, each made at most three ways and posted to 63 receivers. */
const ONE_FRAME = 300 * 3 * (320 + 8 * 200) + 300 * 63 * 8;
/** The most a tick's release holds to send at once, as its outbox counts it (ephemeral.ts MAX_STAGED_BYTES). */
const STAGED_MOST = MAX_STAGED_BYTES + ONE_FRAME;

setFlagsFromString("--expose-gc");
const gc = runInNewContext("gc") as () => void;
function used(): number {
  gc();
  gc();
  const m = process.memoryUsage();
  return m.heapUsed + m.arrayBuffers;
}

/** An id of 64 two-byte units, the widest a string keeps, apart for each `i`. */
const wide = (i: number) => String.fromCharCode(0x4e00 + (i % 20_000), 0x4e00 + Math.floor(i / 20_000)) + "一".repeat(62);
const N = -1.2345678901234567e-100;

async function flush(): Promise<void> {
  for (let i = 0; i < 40; i++) await new Promise((resolve) => setImmediate(resolve));
}

test("154 full sockets and 246 off, each at its caps through an uncovered tick, fit their charges and the container", { timeout: 600_000 }, async (t: TestContext) => {
  const f = scopeFixture();
  const ids = Array.from({ length: 100 }, (_, i) => `t-${i}`);
  for (const [i, id] of ids.entries()) f.state.tokens[id] = token(id, { sceneId: f.sceneId, x: i % 40, y: 10 + Math.floor(i / 40) });
  const clock = { now: T0 };
  const now = () => clock.now;
  const db = new StoredRoomDb(f.state);
  let gate: (() => void) | null = null;
  const actor = await RoomActor.load({
    pool: db.pool(),
    info: { roomId: "UNDOSCOPE", pinned: false, createdIp: null, readOnly: false },
    log: { info() {}, warn() {}, error() {}, debug() {} },
    budget: new SnapshotBudget({ sessionCount: 10_000, ipCount: 10_000, sessionBytes: Infinity, ipBytes: Infinity }, now),
    previews: new PreviewPool(),
    gateway: {} as RoomGateway,
    options: { batchMs: 20, snapshotIdleMs: 60_000, grantRecheckMs: 60_000, roomOpsPerSec: 100_000, now, numberClock: null, standingClock: true, previewSweepMs: null },
  });
  assert.ok(actor);
  t.after(() => {
    gate?.();
    return actor.shutdown({ code: 1012, snapshot: false });
  });
  // 400 sockets, the first a DM's, each with its snapshot.
  const socket = { readyState: 1, OPEN: 1, CONNECTING: 0, send() {}, close() {}, terminate() {} };
  const conns: Connection[] = [];
  for (let i = 0; i < 400; i++) {
    const who = i === 0 ? f.dm : f.player;
    const conn = new Connection(socket as never, { sessionId: uuidv7(), roomId: "UNDOSCOPE", memberId: who.id, role: i === 0 ? "dm" : "player" }, "203.0.113.9", { now });
    actor.attach(conn);
    conns.push(conn);
    void actor.hello(conn, { clientId: uuidv7(), resumeFrom: 1 });
  }
  for (let i = 0; i < 200 && conns.some((c) => c.held === null); i++) await flush();
  assert.ok(conns.every((c) => c.held !== null), "every socket has its snapshot");
  // The pool of one room keeps only that room's DM share, so the paces are set as 154 full shares across rooms would give them.
  for (const [i, conn] of conns.entries()) conn.pace = i < 154 ? "full" : "off";
  const send = (conn: Connection, e: unknown) => {
    const parsed = clientMessageSchema.parse({ t: "eph", sceneId: f.sceneId, e });
    actor.ephemeral(conn, { sceneId: f.sceneId, e: (parsed as { e: EphEvent | GroupFrame }).e });
  };
  const base = used();

  // Every receiver's preview state: the DM drags 100 tokens, and every player shows them.
  send(conns[0]!, { k: "dragStart", tokenId: ids[0], g: 1, x: 0, y: 10, with: ids.slice(1).map((id, i) => ({ tokenId: id, x: (i + 1) % 40, y: 10 + Math.floor((i + 1) / 40) })), from: { x: 0, y: 10 } });
  send(conns[0]!, { k: "dragMove", tokenId: ids[0], g: 1, x: 0.5, y: 10 });
  assert.equal(conns[399]!.previewsHeld.size, 100);
  const receivers = used() - base;

  // An uncovered tick: a batch whose commit waits.
  db.beforeCommit = () => new Promise<void>((resolve) => (gate = resolve));
  clock.now = T0 + 5;
  void actor.op(conns[1]!, 1, { t: "log.chat", text: "held" });
  await flush();
  clock.now = T0 + 25;
  await new Promise((resolve) => setTimeout(resolve, 60));
  await flush();
  const held0 = used();
  let g = 10;
  for (const [i, conn] of conns.entries()) {
    if (i < 154) {
      // Its rosters at their cap, each of 99 members of the widest ids, then moves at their widest to its held cap.
      for (let v = 0; v < MAX_VERSIONS; v++, g++) send(conn, { k: "dragStart", tokenId: wide(5_000_000 + i), g, x: N, y: N, with: Array.from({ length: 99 }, (_, m) => ({ tokenId: wide(i * 10_000 + v * 100 + m), x: N, y: N })), from: { x: N, y: N } });
      while (actor.heldOf(conn).frames < MAX_HELD_FRAMES && actor.heldOf(conn).bytes + 3 * 1024 <= MAX_HELD_BYTES) send(conn, { k: "dragMove", tokenId: wide(5_000_000 + i), g: g - 1, x: N, y: N, free: true, fts: Array.from({ length: 99 }, () => N), lead: { i: 98, x: N, y: N, path: Array.from({ length: 200 }, () => N), ft: N, squeeze: true } });
      assert.equal(conn.gestures.retained.versions, MAX_VERSIONS);
    } else {
      for (let k = 0; actor.heldOf(conn).bytes + 512 <= MAX_HELD_BYTES_OFF; k++) send(conn, { k: "laser", x: k / 1000, y: 1, on: true });
    }
  }
  const held = used() - held0;
  const charged = 154 * FULL_ALLOWANCE_BYTES + 246 * OFF_ALLOWANCE_BYTES;
  const room = fullRoom().state;
  const r0 = used();
  const rooms = Array.from({ length: ROOMS }, () => structuredClone(room));
  const perRoom = (used() - r0) / ROOMS;
  assert.equal(rooms.length, ROOMS);
  // A tick's release stages its messages in the same process, at most STAGED_MOST at once.
  const total = process.memoryUsage().rss / MiB + (ROOMS * perRoom) / MiB + UPLOAD_PEAK_MIB + STAGED_MOST / MiB;
  t.diagnostic(`held previews and rosters: ${(held / MiB).toFixed(1)} MiB, charged ${(charged / MiB).toFixed(1)} MiB`);
  t.diagnostic(`receivers' preview state: ${(receivers / MiB).toFixed(1)} MiB`);
  t.diagnostic(`a full room's state: ${(perRoom / MiB).toFixed(1)} MiB, ${ROOMS} rooms`);
  t.diagnostic(`process ${(process.memoryUsage().rss / MiB).toFixed(0)} MiB, with ${ROOMS} full rooms, an upload's peak and a release's staging: ${total.toFixed(0)} MiB of ${CONTAINER_MIB}`);
  assert.ok(held <= charged, `held ${held} against ${charged} charged`);
  assert.ok(total < CONTAINER_MIB, `${total} MiB`);
});

test("a release of 10 sockets' 60 held moves of 100 tokens each to 63 receivers holds at most MAX_STAGED_BYTES and a frame's messages at once", { timeout: 600_000 }, async (t: TestContext) => {
  const f = scopeFixture();
  const ids = Array.from({ length: 100 }, (_, i) => `t-${i}`);
  for (const [i, id] of ids.entries()) f.state.tokens[id] = token(id, { sceneId: f.sceneId, x: i % 40, y: 10 + Math.floor(i / 40) });
  const clock = { now: T0 };
  const now = () => clock.now;
  const db = new StoredRoomDb(f.state);
  let gate: (() => void) | null = null;
  const actor = await RoomActor.load({
    pool: db.pool(),
    info: { roomId: "UNDOSCOPE", pinned: false, createdIp: null, readOnly: false },
    log: { info() {}, warn() {}, error() {}, debug() {} },
    budget: new SnapshotBudget({ sessionCount: 10_000, ipCount: 10_000, sessionBytes: Infinity, ipBytes: Infinity }, now),
    previews: new PreviewPool(),
    gateway: {} as RoomGateway,
    options: { batchMs: 20, snapshotIdleMs: 60_000, grantRecheckMs: 60_000, roomOpsPerSec: 100_000, now, numberClock: null, standingClock: true, previewSweepMs: null },
  });
  assert.ok(actor);
  const deliver = Outbox.prototype.deliver;
  t.after(() => {
    Outbox.prototype.deliver = deliver;
    gate?.();
    return actor.shutdown({ code: 1012, snapshot: false });
  });
  // A room's 64 sockets, 10 of them DM devices that drag and the rest players, whose pages keep nothing they are sent.
  let sent = 0;
  const socket = { readyState: 1, OPEN: 1, CONNECTING: 0, send: (text: string) => void (text.startsWith('{"t":"eph"') && sent++), close() {}, terminate() {} };
  const conns: Connection[] = [];
  for (let i = 0; i < 64; i++) {
    const dm = i < 10;
    const conn = new Connection(socket as never, { sessionId: uuidv7(), roomId: "UNDOSCOPE", memberId: dm ? f.dm.id : f.player.id, role: dm ? "dm" : "player" }, "203.0.113.9", { now });
    actor.attach(conn);
    conns.push(conn);
    void actor.hello(conn, { clientId: uuidv7(), resumeFrom: 1 });
  }
  for (let i = 0; i < 200 && conns.some((c) => c.held === null); i++) await flush();
  assert.ok(conns.every((c) => c.held !== null && c.pace === "full"));
  const senders = conns.slice(0, 10);
  const send = (conn: Connection, e: unknown) => {
    const parsed = clientMessageSchema.parse({ t: "eph", sceneId: f.sceneId, e });
    actor.ephemeral(conn, { sceneId: f.sceneId, e: (parsed as { e: EphEvent | GroupFrame }).e });
  };

  // An uncovered tick, through which every sender's 60 frames wait.
  db.beforeCommit = () => new Promise<void>((resolve) => (gate = resolve));
  clock.now = T0 + 5;
  void actor.op(conns[10]!, 1, { t: "log.chat", text: "held" });
  await flush();
  clock.now = T0 + 25;
  await new Promise((resolve) => setTimeout(resolve, 60));
  await flush();
  for (const [s, conn] of senders.entries()) {
    send(conn, { k: "dragStart", tokenId: ids[0], g: 1, x: 0, y: 10, with: ids.slice(1).map((id, i) => ({ tokenId: id, x: (i + 1) % 40, y: 10 + Math.floor((i + 1) / 40) })), from: { x: 0, y: 10 } });
    for (let m = 1; m < 60; m++) send(conn, { k: "dragMove", tokenId: ids[0], g: 1, x: (m + s) / 8, y: 10 });
    assert.equal(actor.heldOf(conn).frames, 60);
  }

  // Each delivery's staged count and heap, measured as it starts, when everything it is about to send is held.
  const base = used();
  const runs: { staged: number; heap: number }[] = [];
  Outbox.prototype.deliver = function (this: Outbox) {
    if (this.staged > 1024 * 1024) runs.push({ staged: this.staged, heap: used() - base });
    deliver.call(this);
  };
  clock.now = T0 + 200;
  gate!();
  for (let i = 0; i < 400 && senders.some((c) => actor.heldOf(c).frames > 0); i++) {
    await new Promise((resolve) => setTimeout(resolve, 5));
    await flush();
  }
  assert.ok(senders.every((c) => actor.heldOf(c).frames === 0), "every frame released");
  const peak = Math.max(...runs.map((r) => r.heap));
  const stagedPeak = Math.max(...runs.map((r) => r.staged));
  t.diagnostic(`${sent} messages in ${runs.length} runs: staged at most ${(stagedPeak / MiB).toFixed(1)} MiB as counted, ${(peak / MiB).toFixed(1)} MiB on the heap`);
  assert.equal(sent, 10 * 60 * 100 * 63, "every token's frame reached every other socket");
  assert.ok(runs.length > 1, "the release went in runs");
  assert.ok(stagedPeak <= STAGED_MOST, `${stagedPeak}`);
  assert.ok(peak <= stagedPeak, `the count holds what the heap does: ${peak} against ${stagedPeak}`);
});
