import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, describe, test } from "node:test";
import yauzl from "yauzl";
import yazl from "yazl";
import type { RoomState } from "#shared/model.ts";
import type { ServerMessage } from "#shared/protocol.ts";
import { IMAGE, numbersIn, seqTwins, T0 } from "#shared/seqTestutil.ts";
import { forgetRememberedStamps } from "../assets/cleanup.ts";
import { startEngine, type Engine, type Socket, type TestClient } from "./testing.ts";

/**
 * Room numbers on the database once they follow the clock: an old room
 * whose count stands in the thousands moves to the clock at its next
 * answer, and its log pages, sessions, receipts, export and import read
 * across the jump. A read hands a device a number the room never stores,
 * so a cleanup after it and a restart never repeat or lower it.
 */

async function unzip(buffer: Buffer): Promise<Map<string, Buffer>> {
  const zip = await yauzl.fromBufferPromise(buffer);
  const out = new Map<string, Buffer>();
  for await (const entry of zip.eachEntry()) {
    const stream = await zip.openReadStreamPromise(entry);
    const chunks: Buffer[] = [];
    for await (const chunk of stream as AsyncIterable<Buffer>) chunks.push(chunk);
    out.set(entry.fileName, Buffer.concat(chunks));
  }
  return out;
}

function zipOf(entries: Record<string, string>): Promise<Buffer> {
  const zip = new yazl.ZipFile();
  for (const [name, data] of Object.entries(entries)) zip.addBuffer(Buffer.from(data), name);
  zip.end();
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    zip.outputStream.on("data", (c: Buffer) => chunks.push(c));
    zip.outputStream.on("end", () => resolve(Buffer.concat(chunks)));
    zip.outputStream.on("error", reject);
  });
}

const draw = (sides: number) => Math.ceil(sides / 2);
const settle = () => new Promise((resolve) => setTimeout(resolve, 60));
const clock = { now: T0 };
/** While set, numbers count by one, as they did before they followed the clock. */
let counting = false;
let t: Engine;

type Event = Extract<ServerMessage, { t: "ev" }>;

/** Each request of a device answers in under a second. */
async function timed<T>(what: string, run: () => Promise<T>): Promise<T> {
  const start = Date.now();
  const out = await run();
  assert.ok(Date.now() - start < 1_000, `${what} answered in under a second (${Date.now() - start} ms)`);
  return out;
}

async function lineIds(client: TestClient, roomId: string): Promise<{ ids: string[]; pages: number }> {
  const ids: string[] = [];
  let before: string | null | undefined;
  let pages = 0;
  for (let i = 0; i < 50; i++) {
    const res = await timed("a log page", () => client.get(`/api/rooms/${roomId}/log?limit=2${before ? `&before=${encodeURIComponent(before)}` : ""}`));
    assert.equal(res.statusCode, 200, res.body);
    const page = res.json<{ entries: Array<{ id: string }>; nextBefore: string | null }>();
    ids.unshift(...page.entries.map((e) => e.id));
    pages++;
    before = page.nextBefore;
    if (before === null) break;
  }
  return { ids, pages };
}

const numberOf = (id: string) => Number(id.split(":")[0]);

/** Ids that rise, line by line, each once. */
function rising(ids: readonly string[], what: string): void {
  assert.equal(new Set(ids).size, ids.length, `${what}: no id repeats`);
  for (let i = 1; i < ids.length; i++) {
    const [a, b] = [ids[i - 1]!, ids[i]!].map((id) => id.split(":").map(Number)) as [[number, number], [number, number]];
    assert.ok(a[0] < b[0] || (a[0] === b[0] && a[1] < b[1]), `${what}: ${ids[i - 1]} before ${ids[i]}`);
  }
}

describe("room numbers on the database follow the clock", () => {
  before(async () => {
    t = await startEngine({ rooms: { idleUnloadMs: 60_000, actor: { now: () => clock.now, numberClock: () => (counting ? 0 : clock.now), draw, snapshotIdleMs: 60_000 } } });
  });
  after(() => t.close());

  test("an old room at a count of 3,000 jumps to the clock, and its log pages, sessions, receipt, export and import read across the jump, and a backup dated ahead of the clock is refused", async () => {
    counting = true;
    const dm = t.client();
    const { roomId } = await dm.createRoom("Old count");
    const pip = t.client();
    await pip.join(roomId, "Pip");
    await t.manager.unload(roomId);
    await t.pool.query("update rooms set pub = 2997 where id = $1", [roomId]);
    let socket: Socket = await t.connect(roomId, pip);
    await socket.snapshot(randomUUID());
    for (const text of ["one", "two", "three"]) {
      clock.now += 1_000;
      assert.equal((await socket.apply({ t: "log.chat", text })).rejects, undefined);
    }
    const old = (await lineIds(pip, roomId)).ids;
    assert.ok(old.length >= 3 && numberOf(old.at(-1)!) >= 3_000 && numberOf(old.at(-1)!) < 3_100, `the room counted on from 3,000: ${old.join(", ")}`);
    // The update: numbers follow the clock from here, and a long gap starts a new session.
    counting = false;
    clock.now += 5 * 3_600_000;
    const jumped = await timed("the chat across the jump", () => socket.apply({ t: "log.chat", text: "after the update" }));
    const jump = jumped.changes.find((c) => c.key.startsWith("log:"))!.key;
    assert.ok(Number(jump.split(":")[1]) >= clock.now, `the chat's number is the clock's: ${jump}`);
    socket.close();
    await socket.waitClosed();
    clock.now += 1_000;
    await t.restart();
    socket = await t.connect(roomId, pip);
    const snap = await timed("the snapshot after the restart", () => socket.snapshot(randomUUID()));
    assert.ok(snap.seq >= clock.now, "the snapshot after the restart is numbered at the clock");
    const tag = randomUUID();
    clock.now += 1_000;
    const rolled = await timed("a tagged roll", () => socket.apply({ t: "dice.roll", tag, to: "all", rolls: [{ formula: "1d20" }] }));
    assert.equal(rolled.rejects, undefined);
    clock.now += 1_000;
    await socket.apply({ t: "log.chat", text: "last" });
    await settle();
    const { ids, pages } = await lineIds(pip, roomId);
    rising(ids, "the log across the jump");
    assert.ok(pages >= 3, `the pages cross the jump (${pages})`);
    assert.deepEqual(ids.slice(0, old.length), old, "the old lines keep their ids");
    const sessions = await timed("the sessions page", () => pip.get(`/api/rooms/${roomId}/log/sessions?limit=10`));
    assert.equal(sessions.statusCode, 200, sessions.body);
    const read = sessions.json<{ sessions: unknown[]; lines: number }>();
    assert.equal(read.lines, ids.length, "the sessions count every line");
    assert.equal(read.sessions.length, 2, "one session before the gap and one after");
    const receipt = await timed("the receipt", () => pip.get(`/api/rooms/${roomId}/receipts/${tag}`));
    assert.equal(receipt.statusCode, 200, receipt.body);
    const parts = receipt.json<{ parts: Array<{ seq: number | null }> }>().parts;
    assert.ok(parts.length === 1 && ids.some((id) => numberOf(id) === parts[0]!.seq), "the receipt names the roll's line");
    const exported = await timed("the export", () => dm.get(`/api/rooms/${roomId}/export`));
    assert.equal(exported.statusCode, 200);
    const file = JSON.parse((await unzip(exported.rawPayload)).get("room.json")!.toString()) as { state: RoomState };
    rising(file.state.log.map((l) => l.id), "the exported log");
    const fields = { playerPassword: "mossy-stone-lamp", dmName: "Importer" };
    const headers = { "content-type": "application/zip", "x-import-form": Buffer.from(JSON.stringify(fields)).toString("base64url") };
    const res = await timed("the import", async () => t.client().request("POST", "/api/rooms/import", undefined, headers, await zipOf({ "room.json": JSON.stringify(file) })));
    assert.equal(res.statusCode, 201, res.body);
    const imported = res.json<{ roomId: string }>().roomId;
    t.track(imported);
    const { rows } = await t.pool.query<{ state: RoomState }>("select state from room_snapshots where room_id = $1", [imported]);
    assert.deepEqual(rows[0]!.state.log.map((l) => l.id), file.state.log.map((l) => l.id), "the import keeps every id");
    // A backup whose newest line is dated past this server's clock by more than five minutes is refused, at four it is taken.
    const ahead = async (minutes: number) => {
      const at = Date.now() + minutes * 60_000;
      const log = [...file.state.log, { ...file.state.log.at(-1)!, id: `${at}:0`, at: new Date(at).toISOString() }];
      return t.client().request("POST", "/api/rooms/import", undefined, headers, await zipOf({ "room.json": JSON.stringify({ ...file, state: { ...file.state, log } }) }));
    };
    const refused = await ahead(6);
    assert.equal(refused.statusCode, 400, refused.body);
    assert.ok(refused.body.includes("state.log"), `the refusal names the log: ${refused.body}`);
    const taken = await ahead(4);
    assert.equal(taken.statusCode, 201, taken.body);
    t.track(taken.json<{ roomId: string }>().roomId);
    socket.close();
    await socket.waitClosed();
  });

  test("a number a read handed out is never stored by a cleanup after it, and a restart numbers above it", async () => {
    counting = false;
    const w = seqTwins({ stamp: true });
    const dm = t.client();
    const { roomId } = await dm.createRoom("Read then cleanup");
    const p1 = t.client();
    const p1Id = await p1.join(roomId, "P1");
    const p2 = t.client();
    const p2Id = await p2.join(roomId, "P2");
    const dmId = (await dm.me(roomId)).memberId!;
    await t.manager.unload(roomId);
    for (const [real, fixture] of Object.entries({ [dmId]: "dm1", [p1Id]: "p1", [p2Id]: "p2" })) {
      await t.pool.query("update grants set member_id = $3 where room_id = $1 and member_id = $2", [roomId, real, fixture]);
      await t.pool.query("update room_dm_members set member_id = $3 where room_id = $1 and member_id = $2", [roomId, real, fixture]);
    }
    await t.pool.query("delete from room_log_access where room_id = $1", [roomId]);
    await t.pool.query("delete from room_log where room_id = $1", [roomId]);
    await t.pool.query("delete from room_ops where room_id = $1", [roomId]);
    await t.pool.query("update room_snapshots set state = $2::jsonb where room_id = $1", [roomId, JSON.stringify(w.door)]);
    clock.now += 1_000;
    let socket = await t.connect(roomId, p1);
    await socket.snapshot(randomUUID());
    clock.now += 1_000;
    await socket.apply({ t: "log.chat", text: "ready" });
    await settle();
    const stored = async () => Number((await t.pool.query<{ pub: string }>("select pub::text from rooms where id = $1", [roomId])).rows[0]!.pub);
    const kept = await stored();
    // The reconnect is a read: its batch stores nothing and hands P1 the clock.
    clock.now += 5_000;
    socket.close();
    await socket.waitClosed();
    socket = await t.connect(roomId, p1);
    const handed = (await socket.snapshot(randomUUID())).seq;
    assert.ok(handed > kept, `the read handed out ${handed}, above the stored ${kept}`);
    // A cleanup alone: its row's envelope is the stored number, never the one handed out.
    clock.now += 1_000;
    const actor = t.manager.get(roomId)!;
    for (const op of forgetRememberedStamps(actor.committed.state, new Set([IMAGE]))) await actor.sys(op);
    await settle();
    const { rows } = await t.pool.query<{ pub: string }>("select pub::text from room_ops where room_id = $1 and op->>'t' = 'sys.remember' order by seq desc limit 1", [roomId]);
    assert.equal(Number(rows[0]!.pub), kept, "the cleanup row carries the stored number");
    assert.equal(await stored(), kept, "and the room's stored number is unmoved");
    socket.close();
    await socket.waitClosed();
    clock.now += 1_000;
    await t.restart();
    socket = await t.connect(roomId, p1);
    const back = await socket.snapshot(randomUUID());
    assert.ok(back.seq > handed, `the reconnect after the restart is numbered ${back.seq}, above ${handed}`);
    clock.now += 1_000;
    const ev: Event = await socket.apply({ t: "log.chat", text: "after" });
    const line = numbersIn([ev]).find((g) => g.what === "id")!;
    assert.ok(line.n > handed, `the chat's number ${line.n} is above ${handed}`);
    socket.close();
    await socket.waitClosed();
  });
});
