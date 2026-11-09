import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, describe, test } from "node:test";
import { OP_VERSION, SNAPSHOT_VERSION } from "#shared/migrate.ts";
import type { RoomState } from "#shared/model.ts";
import type { Op, ServerMessage } from "#shared/protocol.ts";
import { FAMILIAR, FrameReader, IN_Q, numbersIn, seqTwins, T0, type SeqTwinOptions } from "#shared/seqTestutil.ts";
import { startEngine, type Engine, type Socket, type TestClient } from "./testing.ts";

/**
 * Twin rooms on the database (docs/design, the room count): the secret
 * door twins (shared/seqTestutil.ts seqTwins) as two rooms of one engine,
 * which take the same members' ops while P2 walks in room Q, painted in one
 * and rock in the other, so the server's own explore and map steps differ.
 * P1's every frame, compared whole, and P1's log pages and sessions read
 * over HTTP are the same in both, across restarts of the engine that write
 * and reload what the database holds. Each room is made through the app,
 * then its snapshot is rewritten with its twin's state, and its grants with
 * the fixture's member ids, so both rooms name their members alike. The
 * actors read one clock, which only the steps move, so every time a frame
 * carries is the same in both rooms and frames compare byte for byte.
 */

type Who = "dm" | "p1" | "p2";
type Event = Extract<ServerMessage, { t: "ev" }>;
/** Every die lands on its middle, the same in both rooms. */
const draw = (sides: number) => Math.ceil(sides / 2);
const BOOKKEEPING = ["sys.explore", "sys.remember", "sys.sound"];
const settle = () => new Promise((resolve) => setTimeout(resolve, 60));

const clock = { now: T0 };
let t: Engine;

/** One twin room on the engine: the members' devices, and P1's sockets, each restart's in turn, whose frames are compared. */
class RoomTwin {
  readonly name: string;
  readonly roomId: string;
  readonly clients: Record<Who, TestClient>;
  sockets!: Record<Who, Socket>;
  readonly watched: Array<{ label: string; frames: unknown[] }> = [];
  #opened = 0;

  constructor(name: string, roomId: string, clients: Record<Who, TestClient>) {
    this.name = name;
    this.roomId = roomId;
    this.clients = clients;
  }

  /** Opens each member's socket and takes its snapshot. Only P1's frames are kept for comparison. */
  async connect(): Promise<void> {
    const open = async (who: Who): Promise<Socket> => {
      const socket = await t.connect(this.roomId, this.clients[who]);
      if (who === "p1") {
        const frames: unknown[] = [...socket.received];
        socket.ws.on("message", (data) => frames.push(JSON.parse(data.toString())));
        this.watched.push({ label: `p1#${++this.#opened}`, frames });
      }
      await socket.snapshot(randomUUID());
      return socket;
    };
    this.sockets = { dm: await open("dm"), p1: await open("p1"), p2: await open("p2") };
  }

  async send(who: Who, op: Op | Record<string, unknown>): Promise<Event> {
    return this.sockets[who].apply(op);
  }

  async apply(who: Who, op: Op | Record<string, unknown>): Promise<Event> {
    const event = await this.send(who, op);
    assert.equal(event.rejects, undefined, `${this.name}: ${who}'s ${String(op.t)} taken`);
    return event;
  }

  frames(): string[] {
    const reader = new FrameReader();
    return this.watched.flatMap((w) => w.frames.map((f) => `${w.label} ${reader.text(f)}`));
  }

  async bookkeeping(): Promise<string[]> {
    const { rows } = await t.pool.query<{ t: string }>("select op->>'t' as t from room_ops where room_id = $1 and op->>'t' = any($2::text[]) order by seq", [this.roomId, BOOKKEEPING]);
    return rows.map((r) => r.t);
  }

  async count(): Promise<number | null> {
    const { rows } = await t.pool.query<{ pub: string | null }>("select pub::text as pub from rooms where id = $1", [this.roomId]);
    return rows[0]?.pub === null || rows[0]?.pub === undefined ? null : Number(rows[0].pub);
  }
}

/**
 * A room made through the app, with a DM and two joined players, then
 * unloaded and rewritten as `state`: its snapshot holds the twin's state,
 * its grants name the fixture's members, and the lines and rows the making
 * wrote are gone, so the room loads as the twin alone.
 */
async function makeRoom(name: string, state: RoomState): Promise<RoomTwin> {
  const dm = t.client();
  const { roomId } = await dm.createRoom(`Twin ${name}`);
  const p1 = t.client();
  const p1Id = await p1.join(roomId, "P1");
  const p2 = t.client();
  const p2Id = await p2.join(roomId, "P2");
  const dmId = (await dm.me(roomId)).memberId!;
  await t.manager.unload(roomId);
  const ids: Record<string, string> = { [dmId]: "dm1", [p1Id]: "p1", [p2Id]: "p2" };
  for (const [real, fixture] of Object.entries(ids)) {
    await t.pool.query("update grants set member_id = $3 where room_id = $1 and member_id = $2", [roomId, real, fixture]);
    await t.pool.query("update room_dm_members set member_id = $3 where room_id = $1 and member_id = $2", [roomId, real, fixture]);
  }
  await t.pool.query("delete from room_log_access where room_id = $1", [roomId]);
  await t.pool.query("delete from room_log where room_id = $1", [roomId]);
  await t.pool.query("delete from room_ops where room_id = $1", [roomId]);
  await t.pool.query("update room_snapshots set state = $2::jsonb, schema_version = $3 where room_id = $1", [roomId, JSON.stringify(state), SNAPSHOT_VERSION]);
  const twin = new RoomTwin(name, roomId, { dm, p1, p2 });
  await twin.connect();
  return twin;
}

type Pair = [RoomTwin, RoomTwin];

/** The twins, opened, with P1's first chat taken in both: a room's first commit explores what its loaded state shows. */
async function twins(opts: SeqTwinOptions = {}): Promise<Pair> {
  const w = seqTwins(opts);
  const pair: Pair = [await makeRoom("door", w.door), await makeRoom("rock", w.rock)];
  await step(pair, (twin) => twin.apply("p1", { t: "log.chat", text: "ready" }));
  return pair;
}

/** Moves the shared clock, then runs the step in each room in turn, the door's first, and lets each room's own work land. */
async function step(pair: Pair, run: (twin: RoomTwin) => Promise<unknown>, ms = 1_000): Promise<void> {
  clock.now += ms;
  for (const twin of pair) {
    await run(twin);
    await settle();
  }
}

/** The engine stops every room as a deploy does, each writing its snapshot, and the members' devices connect again. */
async function restart(pair: Pair): Promise<void> {
  clock.now += 1_000;
  await t.restart();
  for (const twin of pair) await twin.connect();
  await settle();
}

function same(pair: Pair, what: string): void {
  assert.deepEqual(pair[0].frames(), pair[1].frames(), `${what}: P1 gets the same frames in both rooms`);
}

async function bookkeepingDiffers(pair: Pair, what: string): Promise<void> {
  assert.notDeepEqual(await pair[0].bookkeeping(), await pair[1].bookkeeping(), `${what}: the rooms' own work differs`);
}

const move = (tokenId: string, x: number, y: number): Op => ({ t: "token.move", tokenId, x, y });

const C1: Array<[Who, Op]> = [
  ["dm", move("b", IN_Q.x, IN_Q.y)],
  ["p2", move("b", 23, 6)],
  ["p2", move("b", 24, 8)],
  ["p2", move("b", 20, 4)],
  ["p1", { t: "log.chat", text: "hi" }],
];

async function c1(pair: Pair): Promise<void> {
  for (const [who, op] of C1) await step(pair, (twin) => twin.apply(who, op));
}

describe("twin rooms on the database give their devices the same frames", () => {
  before(async () => {
    t = await startEngine({ rooms: { idleUnloadMs: 60_000, actor: { now: () => clock.now, draw, snapshotOps: 1_000, snapshotIdleMs: 60_000 } } });
  });
  after(() => t.close());

  test("C5: after C1, P1's log pages and sessions, private lines across their edges, hold the same ids, cursors and counts", async () => {
    const pair = await twins();
    await c1(pair);
    const tag = () => randomUUID();
    // Lines P1 may not read, and session edges: the clock jumps past the four-hour gap twice.
    const lines: Array<[Who, Record<string, unknown>, number?]> = [
      ["p2", { t: "log.whisper", to: ["dm1"], text: "to the DM" }],
      ["dm", { t: "log.whisper", to: ["p2"], text: "to P2" }],
      ["dm", { t: "dice.roll", tag: "", to: "dm", rolls: [{ formula: "1d20" }] }],
      ["p1", { t: "log.chat", text: "first session ends" }],
      ["p2", { t: "dice.roll", tag: "", to: "dm", rolls: [{ formula: "1d6" }] }, 5 * 3_600_000],
      ["p1", { t: "log.chat", text: "second session" }],
      ["dm", { t: "log.whisper", to: ["p2"], text: "again" }],
      ["p2", move("b", 23, 6)],
      ["p1", { t: "log.chat", text: "third session" }, 5 * 3_600_000],
      ["dm", { t: "log.chat", text: "everyone" }],
    ];
    for (const [who, op, ms] of lines) {
      const tagged = op.t === "dice.roll" ? { ...op, tag: tag() } : op;
      // One tag for both rooms, so their receipts and lines match.
      await step(pair, (twin) => twin.apply(who, tagged), ms);
    }
    await bookkeepingDiffers(pair, "C5");
    same(pair, "C5");
    const read = async (twin: RoomTwin) => {
      const p1 = twin.clients.p1;
      const pages: unknown[] = [];
      let before: string | null | undefined;
      for (let i = 0; i < 20; i++) {
        const res = await p1.get(`/api/rooms/${twin.roomId}/log?limit=2${before ? `&before=${encodeURIComponent(before)}` : ""}`);
        assert.equal(res.statusCode, 200, res.body);
        const page = res.json<{ entries: Array<{ id: string }>; nextBefore: string | null; nextAfter: string | null }>();
        pages.push({ ids: page.entries.map((e) => e.id), nextBefore: page.nextBefore, nextAfter: page.nextAfter });
        before = page.nextBefore;
        if (before === null) break;
      }
      const sessions: unknown[] = [];
      let sessionsBefore: string | null | undefined;
      for (let i = 0; i < 10; i++) {
        const res = await p1.get(`/api/rooms/${twin.roomId}/log/sessions?limit=1${sessionsBefore ? `&before=${encodeURIComponent(sessionsBefore)}` : ""}`);
        assert.equal(res.statusCode, 200, res.body);
        const page = res.json<{ sessions: unknown[]; lines: number; nextSessionsBefore: string | null }>();
        sessions.push(page);
        sessionsBefore = page.nextSessionsBefore;
        if (sessionsBefore === null) break;
      }
      return { pages, sessions };
    };
    const got = [await read(pair[0]), await read(pair[1])];
    assert.deepEqual(got[0], got[1], "P1's log pages and sessions are the same in both rooms");
    assert.ok(got[0]!.pages.length >= 4, `the pages cross edges (${got[0]!.pages.length} pages)`);
    assert.equal(got[0]!.sessions.length, 3, "three sessions, one a page");
  });

  test("C11: P2's op on a token P1 never sees, taken in one room and refused in the other, then a restart, then P1's chat, gives P1 the same frames", async () => {
    const pair = await twins({ familiar: true });
    const refused: boolean[] = [];
    await step(pair, async (twin) => refused.push(((await twin.send("p2", { t: "token.update", tokenId: FAMILIAR, patch: { name: "Hoot" } })).rejects?.length ?? 0) > 0));
    assert.deepEqual(refused, [false, true], "taken in the door room, refused in the room of rock");
    same(pair, "C11, at once");
    await restart(pair);
    same(pair, "C11, after the restart");
    await step(pair, (twin) => twin.apply("p1", { t: "log.chat", text: "after" }));
    same(pair, "C11, after P1's chat");
    assert.deepEqual(await pair[0].count(), await pair[1].count(), "the stored count is the same in both rooms");
  });

  test("C15: C1 with the engine restarted after each step gives P1 the same frames and C1's numbers", async () => {
    const plain = await twins();
    await c1(plain);
    const pair = await twins();
    // A restart's snapshot prunes the rows it covers, written at the steps' clock, so each room's own work is read before each restart.
    const kept: [string[], string[]] = [[], []];
    for (const [who, op] of C1) {
      await step(pair, (twin) => twin.apply(who, op));
      for (const [i, twin] of pair.entries()) kept[i]!.push(...(await twin.bookkeeping()), "restart");
      await restart(pair);
    }
    assert.notDeepEqual(kept[0], kept[1], "C15: the rooms' own work differs");
    same(pair, "C15");
    const last = (twin: RoomTwin) => numbersIn(twin.watched.at(-1)!.frames).find((g) => g.what === "snapshot")?.n;
    const plainLast = (twin: RoomTwin) => numbersIn(twin.watched.flatMap((w) => w.frames)).filter((g) => g.what === "ev").at(-1)?.n;
    for (const [i, twin] of pair.entries()) {
      assert.equal(last(twin), plainLast(plain[i]!), `${twin.name}: the snapshot after the last restart carries C1's last number`);
      const { rows } = await t.pool.query<{ ids: string[] }>("select array_agg(id order by split_part(id, ':', 1)::bigint, split_part(id, ':', 2)::int) as ids from room_log where room_id = $1", [twin.roomId]);
      const { rows: plainRows } = await t.pool.query<{ ids: string[] }>("select array_agg(id order by split_part(id, ':', 1)::bigint, split_part(id, ':', 2)::int) as ids from room_log where room_id = $1", [plain[i]!.roomId]);
      assert.deepEqual(rows[0]!.ids, plainRows[0]!.ids, `${twin.name}: the archive's line ids are C1's`);
    }
  });

  test("C16: an old room, a format 43 snapshot and op version 56 rows, loads, numbers its next line after its last row and saves the snapshot at 44 with that line", async () => {
    const owner = t.client();
    const { roomId } = await owner.createRoom("Before the count");
    const s = await t.connect(roomId, owner);
    await s.snapshot(randomUUID());
    s.close();
    await s.waitClosed();
    await t.manager.unload(roomId);
    const { rows } = await t.pool.query<{ seq: string; state: RoomState }>("select seq::text, state from room_snapshots where room_id = $1", [roomId]);
    const base = Number(rows[0]!.seq);
    const dmId = Object.values(rows[0]!.state.members).find((m) => m.kind === "dm")!.id;
    // As a build before the count left it: no `rooms.pub`, a format 43 snapshot, and rows at op version 56 without `pub`.
    await t.pool.query("update rooms set pub = null where id = $1", [roomId]);
    await t.pool.query("update room_snapshots set schema_version = 43 where room_id = $1", [roomId]);
    for (let i = 1; i <= 3; i++) {
      await t.pool.query(
        `insert into room_ops (room_id, seq, at, actor_member_id, actor_role, op, op_version)
         values ($1, $2, now(), $3, 'dm', $4::jsonb, 56)`,
        [roomId, base + i, dmId, JSON.stringify({ t: "log.chat", text: `old ${i}` })],
      );
    }
    // A snapshot prunes covered rows older than an hour by the database's clock, so the new row is written at today's time and kept to be read.
    clock.now = Math.max(clock.now, Date.now());
    const back = await t.connect(roomId, owner);
    const snap = await back.snapshot(randomUUID());
    assert.equal(snap.seq, base + 3, "the room counts on from its last row");
    const ev = await back.apply({ t: "log.chat", text: "new" });
    assert.ok(ev.changes.some((c) => c.key === `log:${base + 4}:0`), `the next line is ${base + 4}:0`);
    const stored = await t.pool.query<{ schema_version: number; seq: string }>("select schema_version, seq::text from room_snapshots where room_id = $1", [roomId]);
    assert.equal(stored.rows[0]!.schema_version, SNAPSHOT_VERSION, "the first commit saved the snapshot at today's format");
    assert.equal(SNAPSHOT_VERSION, 44);
    const op = await t.pool.query<{ op_version: number; pub: string | null }>("select op_version, pub::text from room_ops where room_id = $1 and seq = $2", [roomId, base + 4]);
    assert.deepEqual([op.rows[0]?.op_version, op.rows[0]?.pub], [OP_VERSION, String(base + 4)], "the new row carries its number");
    const room = await t.pool.query<{ pub: string | null }>("select pub::text from rooms where id = $1", [roomId]);
    assert.equal(room.rows[0]!.pub, String(base + 4), "the room's count is stored");
    back.close();
    await back.waitClosed();
  });

  test("C18: refusals alone, then a shutdown with its snapshot and a restart, reload with the count that holds them, not the snapshot's seq", async () => {
    const pair = await twins();
    const room = pair[0];
    const before = t.manager.get(room.roomId)!.committed.pub;
    // P2 renames P1's creature, which only its owner may: refused, three times.
    for (let i = 0; i < 3; i++) {
      clock.now += 1_000;
      const ev = await room.send("p2", { t: "token.update", tokenId: "a", patch: { name: `Not mine ${i}` } });
      assert.equal(ev.rejects?.length, 1, "refused");
    }
    await settle();
    assert.equal(await room.count(), before + 3, "each refusal moved the stored count");
    await t.restart();
    const { rows } = await t.pool.query<{ seq: string }>("select seq::text from room_snapshots where room_id = $1", [room.roomId]);
    await room.connect();
    const snap = numbersIn(room.watched.at(-1)!.frames).find((g) => g.what === "snapshot")!.n;
    assert.equal(snap, before + 3, "the reloaded count holds the refusals");
    assert.notEqual(snap, Number(rows[0]!.seq), "and is not the snapshot's seq");
    const ev = await room.apply("p1", { t: "log.chat", text: "after" });
    assert.ok(ev.changes.some((c) => c.key === `log:${before + 4}:0`), "the next line numbers on from the refusals");
  });
});
