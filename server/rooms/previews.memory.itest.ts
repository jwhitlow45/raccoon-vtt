import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { setFlagsFromString } from "node:v8";
import { runInNewContext } from "node:vm";
import { uuidv7 } from "#shared/ids.ts";
import { clientMessageSchema, type EphEvent, type GroupFrame } from "#shared/protocol.ts";
import { member, token } from "#shared/testutil.ts";
import { MAX_HELD_BYTES, MAX_HELD_BYTES_OFF, MAX_HELD_FRAMES, MAX_ROOM_HELD_SENDS, RoomActor } from "./actor.ts";
import { FULL_ALLOWANCE_BYTES, OFF_ALLOWANCE_BYTES, PreviewPool, SnapshotBudget } from "./budgets.ts";
import { Connection } from "./connection.ts";
import { Outbox } from "./ephemeral.ts";
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
 * default pool comes down. That release is measured apart (release below):
 * the frames of 10 sockets dragging 100 tokens each to a full room.
 */

const MiB = 1024 * 1024;
const T0 = Date.parse("2026-11-26T20:00:00.000Z");
/** A 100 megapixel map upload's peak for the whole container, as measured (docker-compose.server.yml). */
const UPLOAD_PEAK_MIB = 750;
const CONTAINER_MIB = 1_536;
/** The fewest rooms 400 sockets fill, at 64 a room (budgets.ts DEFAULT_SOCKET_CAPS). */
const ROOMS = Math.ceil(400 / 64);
/**
 * The most a tick's release holds at once: the messages it hands 63
 * receivers, at most MAX_ROOM_HELD_SENDS each, and what waits to be sent as
 * it starts, its records and the group frames they name (measured below).
 */
const RELEASE_MOST = 63 * MAX_ROOM_HELD_SENDS + 8 * 1024 * 1024;

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
/** An id of 64 units JSON escapes to 6 characters each, the widest a message sends, apart for each `i`: unpaired surrogates and a control character. */
const escaped = (i: number) => String.fromCharCode(0xdc00 + (i % 1024), 0xdc00 + Math.floor(i / 1024)) + "\u0001".repeat(62);
/** The widest a coordinate and a cost are as JSON, at 25 and 24 characters. */
const WIDEST_COORD = -0.0000012345678901234567;
const WIDEST_FT = 0.0000012345678901234567;

async function flush(): Promise<void> {
  for (let i = 0; i < 40; i++) await new Promise((resolve) => setImmediate(resolve));
}

test("154 full sockets and 246 off, each at its caps, its member's share or the room's count through an uncovered tick, fit their charges and the container", { timeout: 600_000 }, async (t: TestContext) => {
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
      // Its rosters at their cap, each of 99 members of the widest ids, then moves at their widest to its held cap, or as many
      // as its member's share and the room's count of held frames take (MEMBER_HELD_SHARE, MAX_ROOM_HELD_SENDS).
      for (let v = 0; v < MAX_VERSIONS; v++, g++) send(conn, { k: "dragStart", tokenId: wide(5_000_000 + i), g, x: N, y: N, with: Array.from({ length: 99 }, (_, m) => ({ tokenId: wide(i * 10_000 + v * 100 + m), x: N, y: N })), from: { x: N, y: N } });
      for (let k = 0; k < MAX_HELD_FRAMES && actor.heldOf(conn).frames < MAX_HELD_FRAMES && actor.heldOf(conn).bytes + 3 * 1024 <= MAX_HELD_BYTES; k++) send(conn, { k: "dragMove", tokenId: wide(5_000_000 + i), g: g - 1, x: N, y: N, free: true, fts: Array.from({ length: 99 }, () => N), lead: { i: 98, x: N, y: N, path: Array.from({ length: 200 }, () => N), ft: N, squeeze: true } });
      assert.equal(conn.gestures.retained.versions, MAX_VERSIONS);
    } else {
      for (let k = 0; k < MAX_HELD_FRAMES && actor.heldOf(conn).bytes + 512 <= MAX_HELD_BYTES_OFF; k++) send(conn, { k: "laser", x: k / 1000, y: 1, on: true });
    }
  }
  const held = used() - held0;
  const charged = 154 * FULL_ALLOWANCE_BYTES + 246 * OFF_ALLOWANCE_BYTES;
  const room = fullRoom().state;
  const r0 = used();
  const rooms = Array.from({ length: ROOMS }, () => structuredClone(room));
  const perRoom = (used() - r0) / ROOMS;
  assert.equal(rooms.length, ROOMS);
  // A tick's release holds what it sends in the same process, at most RELEASE_MOST.
  const total = process.memoryUsage().rss / MiB + (ROOMS * perRoom) / MiB + UPLOAD_PEAK_MIB + RELEASE_MOST / MiB;
  t.diagnostic(`held previews and rosters: ${(held / MiB).toFixed(1)} MiB, charged ${(charged / MiB).toFixed(1)} MiB`);
  t.diagnostic(`receivers' preview state: ${(receivers / MiB).toFixed(1)} MiB`);
  t.diagnostic(`a full room's state: ${(perRoom / MiB).toFixed(1)} MiB, ${ROOMS} rooms`);
  t.diagnostic(`process ${(process.memoryUsage().rss / MiB).toFixed(0)} MiB, with ${ROOMS} full rooms, an upload's peak and a release's staging: ${total.toFixed(0)} MiB of ${CONTAINER_MIB}`);
  assert.ok(held <= charged, `held ${held} against ${charged} charged`);
  assert.ok(total < CONTAINER_MIB, `${total} MiB`);
});

/**
 * A room of 64 sockets, the first `senders.length` of them DM devices, each
 * of a DM of its own, and the rest players, whose pages keep nothing they
 * are sent. Through an uncovered tick each sender drags its own tokens 60
 * times at 30 a second, and then the tick is covered and every frame
 * released. What the release holds as it starts to send is measured, and
 * every preview message is numbered in the order the room sent it, with
 * the socket it went to.
 *
 * To the room's count every socket is a DM's, every id the widest a
 * message sends and every number the longest, and each sender's frames
 * carry rosters that take turns between two sets of 100 tokens, so each
 * after its first also ends the other set's.
 */
async function release(t: TestContext, senders: readonly { shown: number; hidden: number }[], moves: "60 at 30 a second" | "to the room's count" = "60 at 30 a second") {
  const f = scopeFixture();
  const most = moves === "to the room's count";
  let sceneId = f.sceneId;
  if (most) {
    sceneId = "\u0002".repeat(64);
    f.state = JSON.parse(JSON.stringify(f.state).replaceAll(f.sceneId, JSON.stringify(sceneId).slice(1, -1))) as typeof f.state;
  }
  const dms = Array.from({ length: most ? 64 : senders.length }, () => member(uuidv7(), "dm"));
  for (const m of dms) f.state.members[m.id] = m;
  const tokens = senders.map((s, i) =>
    most
      ? Array.from({ length: 200 }, (_, k) => ({ id: escaped(200 * i + k), x: WIDEST_COORD, y: WIDEST_COORD, hidden: false }))
      : [
          ...Array.from({ length: s.shown }, (_, k) => ({ id: `s${i}-${k}`, x: (k % 40) + 0.5, y: 10 + 4 * i + Math.floor(k / 40), hidden: false })),
          ...Array.from({ length: s.hidden }, (_, k) => ({ id: `h${i}-${k}`, x: (k % 40) + 0.5, y: 40 + 4 * i + Math.floor(k / 40), hidden: true })),
        ],
  );
  for (const list of tokens) for (const m of list) f.state.tokens[m.id] = token(m.id, { sceneId, x: m.x, y: m.y, ...(m.hidden ? { visibility: "dm" as const } : {}) });
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
  let numbered = 0;
  let bytes = 0;
  const received = new Array<number>(64).fill(0);
  const sent: { n: number; to: number; text: string }[] = [];
  const conns: Connection[] = [];
  for (let i = 0; i < 64; i++) {
    const to = i;
    const socket = {
      readyState: 1,
      OPEN: 1,
      CONNECTING: 0,
      send: (text: string) => {
        if (!text.startsWith('{"t":"eph"')) return;
        const n = numbered++;
        const length = Buffer.byteLength(text);
        bytes += length;
        received[to]! += length;
        // The last socket is the watching player: its messages are kept whole, the rest only counted.
        if (to === 63) sent.push({ n, to, text });
      },
      close() {},
      terminate() {},
    };
    const dm = dms[i];
    const conn = new Connection(socket as never, { sessionId: uuidv7(), roomId: "UNDOSCOPE", memberId: dm ? dm.id : f.player.id, role: dm ? "dm" : "player" }, "203.0.113.9", { now });
    actor.attach(conn);
    conns.push(conn);
    void actor.hello(conn, { clientId: uuidv7(), resumeFrom: 1 });
  }
  for (let i = 0; i < 200 && conns.some((c) => c.held === null); i++) await flush();
  assert.ok(conns.every((c) => c.held !== null && c.pace === "full"));
  const send = (conn: Connection, e: unknown) => {
    const parsed = clientMessageSchema.parse({ t: "eph", sceneId, e });
    actor.ephemeral(conn, { sceneId, e: (parsed as { e: EphEvent | GroupFrame }).e });
  };

  // An uncovered tick, through which every sender's 60 frames wait.
  db.beforeCommit = () => new Promise<void>((resolve) => (gate = resolve));
  clock.now = T0 + 5;
  void actor.op(conns[63]!, 1, { t: "log.chat", text: "held" });
  await flush();
  clock.now = T0 + 25;
  await new Promise((resolve) => setTimeout(resolve, 60));
  await flush();
  // To the room's count, each sender's frames come at once, within its ephemeral burst of 400 (budgets.ts EPH_RATE), and each
  // carries a roster, so none takes an older one's place, until its member's share or the room's count may send no more.
  const route = Array.from({ length: 200 }, () => WIDEST_COORD);
  for (let m = 0; m < (most ? 10 : 60); m++) {
    if (!most) clock.now = T0 + 25 + Math.round((m * 1000) / 30);
    for (const [i, list] of tokens.entries()) {
      const [first, ...rest] = most ? list.slice(100 * (m % 2), 100 * (m % 2) + 100) : list;
      const roster = { with: rest.map((r) => ({ tokenId: r.id, x: r.x, y: r.y })), from: { x: first!.x, y: first!.y } };
      if (most) send(conns[i]!, { k: "dragMove", tokenId: first!.id, g: 1, x: first!.x, y: first!.y, free: true, fts: rest.map(() => WIDEST_FT), lead: { i: 0, x: rest[0]!.x, y: rest[0]!.y, path: route, ft: WIDEST_FT, squeeze: true }, ...roster });
      else if (m === 0) send(conns[i]!, { k: "dragStart", tokenId: first!.id, g: 1, x: first!.x, y: first!.y, ...roster });
      else send(conns[i]!, { k: "dragMove", tokenId: first!.id, g: 1, x: first!.x + m / 8, y: first!.y });
    }
  }

  // The release, measured as its outbox starts to send, when everything it sends waits in it.
  const base = used();
  const runs: { groups: number; events: number; records: number; bytes: number; heap: number }[] = [];
  Outbox.prototype.deliver = function (this: Outbox) {
    const staged = this.staged;
    if (staged.records > 1_000) runs.push({ ...staged, heap: used() - base });
    deliver.call(this);
  };
  clock.now = most ? T0 + 1_000 : T0 + 25 + 1_970;
  gate!();
  for (let i = 0; i < 400 && conns.slice(0, senders.length).some((c) => actor.heldOf(c).frames > 0); i++) {
    await new Promise((resolve) => setTimeout(resolve, 5));
    await flush();
  }
  assert.ok(conns.slice(0, senders.length).every((c) => actor.heldOf(c).frames === 0), "every frame released");
  return { runs, sent, numbered, bytes, received };
}

/** The runs a socket's messages came in: each a stretch of messages the room sent it with none to any other socket between. */
function runsOf(sent: readonly { n: number }[]): number[] {
  const out: number[] = [];
  for (const [i, m] of sent.entries()) {
    if (i > 0 && m.n === sent[i - 1]!.n + 1) out[out.length - 1]!++;
    else out.push(1);
  }
  return out;
}

test("a release of 10 sockets' 60 held moves of 100 tokens each to 63 receivers waits as records and frames, well within the container", { timeout: 600_000 }, async (t: TestContext) => {
  const { runs, numbered } = await release(t, Array.from({ length: 10 }, () => ({ shown: 100, hidden: 0 })));
  // Each sender's moves took each other's place while they waited: its start and its latest move remain.
  assert.equal(numbered, 10 * 2 * 100 * 63, "every token's frame reached every other socket");
  assert.equal(runs.length, 1, "the release is one pass");
  const [run] = runs;
  t.diagnostic(`${run!.records} records of ${run!.groups} group frames: ${(run!.bytes / MiB).toFixed(1)} MiB as counted, ${(run!.heap / MiB).toFixed(1)} MiB on the heap`);
  assert.ok(run!.heap <= RELEASE_MOST, `${run!.heap}`);
});

test("4 sockets dragging at 30 a second, one with 0 or 99 members a player does not see: that player's messages come alike, in one run", { timeout: 600_000 }, async (t: TestContext) => {
  const twins = [];
  for (const hidden of [0, 99]) {
    const { runs, sent } = await release(t, [{ shown: 100, hidden: 0 }, { shown: 100, hidden: 0 }, { shown: 100, hidden: 0 }, { shown: 1, hidden }]);
    // Each twin's room has ids of its own, so the events are compared without who sent them and where.
    twins.push({ texts: sent.map((m) => JSON.stringify((JSON.parse(m.text) as { e: unknown }).e)), runs: runsOf(sent) });
    t.diagnostic(`${hidden} not shown: ${runs[0]!.records} records, ${(runs[0]!.bytes / MiB).toFixed(1)} MiB as counted, ${(runs[0]!.heap / MiB).toFixed(1)} MiB on the heap`);
  }
  assert.equal(twins[0]!.texts.length, 3 * 2 * 100 + 2);
  assert.deepEqual(twins[0]!.runs, [3 * 2 * 100 + 2], "one run");
  assert.deepEqual(twins[1]!.runs, twins[0]!.runs);
  assert.deepEqual(twins[1]!.texts, twins[0]!.texts);
});

test("the most one release hands out: 6 DMs whose frames all carry rosters that end each other's tokens, routes and the widest ids and numbers, to 63 DMs, stopped by their shares and the room's count", { timeout: 600_000 }, async (t: TestContext) => {
  const { runs, numbered, bytes, received } = await release(t, Array.from({ length: 6 }, () => ({ shown: 200, hidden: 0 })), "to the room's count");
  assert.equal(runs.length, 1, "the release is one pass");
  const [run] = runs;
  const most = Math.max(...received);
  t.diagnostic(`${numbered} messages, ${run!.records} records of ${run!.groups} group frames: ${(run!.bytes / MiB).toFixed(1)} MiB as counted, ${(run!.heap / MiB).toFixed(1)} MiB on the heap`);
  // What the same release hands its sockets to send, which their send buffers hold until the network takes it.
  t.diagnostic(`the messages' text: ${(bytes / MiB).toFixed(1)} MiB, at most ${most} bytes a receiver against ${MAX_ROOM_HELD_SENDS}`);
  t.diagnostic(`heap and text: ${((run!.heap + bytes) / MiB).toFixed(1)} MiB against ${(RELEASE_MOST / MiB).toFixed(1)} MiB`);
  assert.ok(most <= MAX_ROOM_HELD_SENDS, "each receiver gets at most the room's count");
  // The frame that did not fit is charged at most 192 KB, so the count is spent to within that.
  assert.ok(most > 0.85 * MAX_ROOM_HELD_SENDS, "the room's count is all but spent");
  assert.ok(bytes <= 63 * MAX_ROOM_HELD_SENDS, "the release sends at most 63 receivers the room's count each");
  assert.ok(run!.heap + bytes <= RELEASE_MOST, `${run!.heap + bytes}`);
});
