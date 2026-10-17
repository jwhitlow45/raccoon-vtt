import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { uuidv7 } from "#shared/ids.ts";
import { LIMITS, PLAYER_ROLLED_TOO_MUCH, PLAYERS_ROLLED_TOO_MUCH, ROLLING_TOO_FAST, ROOM_ROLLED_TOO_MUCH } from "#shared/limits.ts";
import { OP_VERSION } from "#shared/migrate.ts";
import type { LogEntry, LogEvent } from "#shared/model.ts";
import type { ProjectedState } from "#shared/project.ts";
import type { Change, Op, ServerMessage } from "#shared/protocol.ts";
import { pruneReceipts } from "./persistence.ts";
import { failCommits, startEngine, type Engine, type Socket, type TestClient } from "./testing.ts";

/**
 * Dice on the real server and Postgres (docs/design-v1-dice.md 4.2 and
 * 1.2): the pipeline's order, the budget, a resend rolling once, stored ops
 * replaying, and receipts, written with their batch, kept across a restart,
 * answered by the lookup to their own member only, pruned without ever
 * touching one younger than 24 hours, and the day's caps with their floods.
 */
const actorStats = { draws: 0 };

type Ev = Extract<ServerMessage, { t: "ev" }>;
type Lookup = { parts: ({ part: number; state: "committed"; seq: number; lines: LogEntry[] } | { part: number; state: "refused"; code: string; message: string })[] };

const inline = { hp: { cur: 7, max: 7, temp: 0 }, life: "alive", ac: 15, speeds: { walk: 30 }, initBonus: 2, passivePerception: 9, senses: "", effects: [], deathSaves: { ok: 0, fail: 0 }, notes: "", dmNotes: "" };

function roll(tag = uuidv7(), extra: Record<string, unknown> = {}): Op {
  return { t: "dice.roll", tag, to: "all", rolls: [{ formula: "2d6+3", label: "Longsword" }], ...extra } as Op;
}

function diceLines(changes: Change[]): LogEntry[] {
  return changes.flatMap((c) => ("value" in c && c.key.startsWith("log:") && (c.value as LogEntry | null)?.data?.type === "dice" ? [c.value as LogEntry] : []));
}

function answer(ev: Ev, n: number): { ok: true } | { ok: false; code: string; message: string } {
  if (ev.acks?.includes(n)) return { ok: true };
  const r = ev.rejects?.find((x) => x.n === n);
  assert.ok(r, `ev answers ${n}`);
  return { ok: false, code: r.code, message: r.message };
}

async function send(socket: Socket, op: Op): Promise<{ n: number; ev: Ev; answer: ReturnType<typeof answer> }> {
  const n = socket.op(op);
  const ev = await socket.next("ev", (m) => (m.acks?.includes(n) ?? false) || (m.rejects?.some((r) => r.n === n) ?? false));
  return { n, ev, answer: answer(ev, n) };
}

async function receiptRows(t: Engine, roomId: string, memberId?: string): Promise<{ tag: string; part: number; state: string; seq: string | null; code: string | null; message: string | null }[]> {
  const { rows } = await t.pool.query(
    `select tag, part, state, seq::text, code, message from roll_receipts where room_id = $1 ${memberId ? "and member_id = $2" : ""} order by at`,
    memberId ? [roomId, memberId] : [roomId],
  );
  return rows;
}

/** Young receipts written straight into the table, as a busy day would leave them, then the room reloaded to read them. */
async function fillReceipts(t: Engine, roomId: string, memberId: string, count: number, prefix = "fill"): Promise<void> {
  await t.pool.query(
    `insert into roll_receipts (room_id, member_id, tag, part, state, seq, at)
     select $1, $2, $3 || '-' || g, 0, 'committed', 1, now() - interval '1 hour' + g * interval '1 millisecond' from generate_series(1, $4) g`,
    [roomId, memberId, prefix, count],
  );
}

type Room = { roomId: string; dmClient: TestClient; dm: Socket; dmId: string; sceneId: string; players: { client: TestClient; socket: Socket; id: string }[] };

async function setup(t: Engine, name: string, players = 1): Promise<Room> {
  const dmClient = t.client();
  const { roomId } = await dmClient.createRoom(name);
  const joined: Room["players"] = [];
  for (let i = 0; i < players; i++) {
    const client = t.client();
    const id = await client.join(roomId, `P${i + 1}`);
    joined.push({ client, socket: undefined as unknown as Socket, id });
  }
  const dm = await t.connect(roomId, dmClient);
  const snap = await dm.snapshot(uuidv7());
  for (const p of joined) {
    p.socket = await t.connect(roomId, p.client);
    await p.socket.snapshot(uuidv7());
  }
  return { roomId, dmClient, dm, dmId: snap.you.memberId, sceneId: (snap.state as ProjectedState).meta.playerSceneId ?? "", players: joined };
}

async function reconnect(t: Engine, roomId: string, client: TestClient): Promise<Socket> {
  const socket = await t.connect(roomId, client);
  await socket.snapshot(uuidv7());
  return socket;
}

describe("dice on the server", () => {
  let t: Engine;
  before(async () => {
    t = await startEngine({
      rooms: {
        actor: {
          draw: (sides) => {
            actorStats.draws++;
            return 1 + (actorStats.draws % sides);
          },
        },
      },
    });
  });
  after(() => t.close());

  test("a player's roll is drawn once on the server, the DM reads the same dice, and the stored sys.dice replays to the same line", async () => {
    const room = await setup(t, "Dice pipeline");
    const pip = room.players[0]!;
    const before = actorStats.draws;
    const sent = await send(pip.socket, roll());
    assert.deepEqual(sent.answer, { ok: true });
    assert.equal(actorStats.draws - before, 2, "two d6");
    const mine = diceLines(sent.ev.changes)[0];
    assert.ok(mine);
    const dmEv = await room.dm.next("ev", (m) => diceLines(m.changes).length > 0);
    const theirs = diceLines(dmEv.changes)[0]!;
    assert.deepEqual((theirs.data as Extract<LogEvent, { type: "dice" }>).rolls, (mine.data as Extract<LogEvent, { type: "dice" }>).rolls);
    const { rows } = await t.pool.query<{ op: Op; op_version: number }>("select op, op_version from room_ops where room_id = $1 order by seq desc limit 1", [room.roomId]);
    assert.equal(rows[0]?.op.t, "sys.dice");
    assert.equal(rows[0]?.op_version, OP_VERSION);
    // A restart replays the stored op from the log rows, with nothing drawn again.
    await t.restart();
    const drawsAfter = actorStats.draws;
    await reconnect(t, room.roomId, room.dmClient);
    const page = (await room.dmClient.get(`/api/rooms/${room.roomId}/log?limit=5`)).json<{ entries: LogEntry[] }>();
    const replayed = page.entries.find((e) => e.id === theirs.id);
    assert.deepEqual(replayed?.data, theirs.data);
    assert.equal(actorStats.draws, drawsAfter);
  });

  test("permissions come before the draw: a hidden creature is gone, a seen one not yours is refused, and nothing is drawn", async () => {
    const room = await setup(t, "Dice order");
    const hidden = uuidv7();
    const seen = uuidv7();
    for (const [id, visibility] of [
      [hidden, "dm"],
      [seen, "all"],
    ] as const) {
      await room.dm.apply({ t: "token.create", token: { id, sceneId: room.sceneId, kind: "monster", name: "Goblin", size: "medium", x: 2, y: 2, visibility, actor: { inline } } } as Op);
    }
    const pip = room.players[0]!;
    const before = actorStats.draws;
    const gone = await send(pip.socket, roll(uuidv7(), { rolls: [{ formula: "1d20", creature: { tokenId: hidden } }] }));
    assert.equal(gone.answer.ok === false && gone.answer.code, "gone");
    const theirs = await send(pip.socket, roll(uuidv7(), { rolls: [{ formula: "1d20", creature: { tokenId: seen } }] }));
    assert.deepEqual(theirs.answer, { ok: false, code: "forbidden", message: "You roll only for your own creatures." });
    assert.equal(actorStats.draws, before, "no refusal draws a die");
    // Each refusal after admission has its receipt.
    const rows = await receiptRows(t, room.roomId, pip.id);
    assert.deepEqual(
      rows.map((r) => [r.state, r.code]),
      [
        ["refused", "gone"],
        ["refused", "forbidden"],
      ],
    );
  });

  test("a roll sent again with its op number, or its tag from a new device, rolls once", async () => {
    const room = await setup(t, "Dice resend");
    const pip = room.players[0]!;
    const op = roll();
    const first = await send(pip.socket, op);
    assert.deepEqual(first.answer, { ok: true });
    const before = actorStats.draws;
    // The same n after a dropped answer is a duplicate by the watermark.
    pip.socket.op(op, first.n);
    const resent = await pip.socket.next("ev", (m) => m.acks?.includes(first.n) ?? false);
    assert.equal(diceLines(resent.changes).length, 0);
    // A new tab of the same member: a new client id, the same tag.
    const tab = await reconnect(t, room.roomId, pip.client);
    const again = await send(tab, op);
    assert.deepEqual(again.answer, { ok: true });
    assert.equal(diceLines(again.ev.changes).length, 0, "no second line");
    assert.equal(actorStats.draws, before, "nothing drawn again");
    assert.equal((await receiptRows(t, room.roomId, pip.id)).length, 1);
    // A refused tag answers with the same refusal.
    const theft = roll(uuidv7(), { rolls: [{ formula: "1d20", creature: { tokenId: uuidv7() } }] });
    const refused = await send(pip.socket, theft);
    const refusedAgain = await send(tab, theft);
    assert.deepEqual(refusedAgain.answer, refused.answer);
    assert.equal((await receiptRows(t, room.roomId, pip.id)).length, 2);
  });

  test("a restart keeps the receipts: the oldest tag of the day is answered from its receipt and applies nothing", async () => {
    const room = await setup(t, "Dice restart");
    const pip = room.players[0]!;
    const op = roll();
    assert.deepEqual((await send(pip.socket, op)).answer, { ok: true });
    await t.restart();
    const socket = await reconnect(t, room.roomId, pip.client);
    const before = actorStats.draws;
    const again = await send(socket, op);
    assert.deepEqual(again.answer, { ok: true });
    assert.equal(diceLines(again.ev.changes).length, 0);
    assert.equal(actorStats.draws, before);
  });

  test("the lookup answers the caller's own receipts alone: committed with its lines, refused with its words, else nothing", async () => {
    const room = await setup(t, "Dice lookup", 2);
    const [pip, quin] = [room.players[0]!, room.players[1]!];
    const tag = uuidv7();
    await send(pip.socket, roll(tag));
    const refusedTag = uuidv7();
    await send(pip.socket, roll(refusedTag, { rolls: [{ formula: "1d20", creature: { tokenId: uuidv7() } }] }));
    const own = await pip.client.get(`/api/rooms/${room.roomId}/receipts/${tag}`);
    assert.equal(own.statusCode, 200, own.body);
    assert.equal(own.headers["cache-control"], "no-store");
    const body = own.json<Lookup>();
    assert.equal(body.parts.length, 1);
    const part = body.parts[0]!;
    assert.equal(part.state, "committed");
    assert.ok(part.state === "committed" && part.lines.length === 1 && part.lines[0]!.data?.type === "dice");
    assert.equal(part.state === "committed" && (part.lines[0]!.data as Extract<LogEvent, { type: "dice" }>).tag, tag, "the roller's own line carries the tag");
    assert.deepEqual((await pip.client.get(`/api/rooms/${room.roomId}/receipts/${refusedTag}`)).json<Lookup>(), { parts: [{ part: 0, state: "refused", code: "gone", message: "that is not here" }] });
    // Another member's tag, and a tag never seen, answer the same: nothing.
    assert.deepEqual((await quin.client.get(`/api/rooms/${room.roomId}/receipts/${tag}`)).json<Lookup>(), { parts: [] });
    assert.deepEqual((await room.dmClient.get(`/api/rooms/${room.roomId}/receipts/${tag}`)).json<Lookup>(), { parts: [] });
    assert.deepEqual((await pip.client.get(`/api/rooms/${room.roomId}/receipts/${uuidv7()}`)).json<Lookup>(), { parts: [] });
    assert.equal((await t.client().get(`/api/rooms/${room.roomId}/receipts/${tag}`)).statusCode, 403, "behind the room's grant");
    assert.equal((await pip.client.get(`/api/rooms/${room.roomId}/receipts/${"x".repeat(65)}`)).statusCode, 400);
  });

  test("a committed op whose lines are pruned, or now hidden from the roller, is still committed, with no lines", async () => {
    const room = await setup(t, "Dice pruned");
    const pip = room.players[0]!;
    // A receipt whose op's lines the archive no longer holds, as the log's count prune leaves one.
    const pruned = uuidv7();
    await t.pool.query(`insert into roll_receipts (room_id, member_id, tag, part, state, seq, at) values ($1, $2, $3, 0, 'committed', 999999, now())`, [room.roomId, pip.id, pruned]);
    assert.deepEqual((await pip.client.get(`/api/rooms/${room.roomId}/receipts/${pruned}`)).json<Lookup>(), { parts: [{ part: 0, state: "committed", seq: 999999, lines: [] }] });
    // Pip rolls for a token of theirs, then the DM takes it and hides it.
    const id = uuidv7();
    await room.dm.apply({ t: "token.create", token: { id, sceneId: room.sceneId, kind: "npc", name: "Wolf", size: "medium", x: 2, y: 2, ownerIds: [pip.id], actor: { inline } } } as Op);
    const tag = uuidv7();
    assert.deepEqual((await send(pip.socket, roll(tag, { rolls: [{ formula: "1d20", creature: { tokenId: id } }] }))).answer, { ok: true });
    await room.dm.apply({ t: "token.update", tokenId: id, patch: { ownerIds: [], visibility: "dm" } } as Op);
    const body = (await pip.client.get(`/api/rooms/${room.roomId}/receipts/${tag}`)).json<Lookup>();
    assert.equal(body.parts[0]?.state, "committed");
    assert.deepEqual(body.parts[0]?.state === "committed" && body.parts[0].lines, []);
  });

  test("the lookup is limited per member and room", async () => {
    const room = await setup(t, "Dice lookup limit");
    const pip = room.players[0]!;
    for (let i = 0; i < LIMITS.receiptLookupsPerHour; i++) assert.equal((await pip.client.get(`/api/rooms/${room.roomId}/receipts/${uuidv7()}`)).statusCode, 200);
    assert.equal((await pip.client.get(`/api/rooms/${room.roomId}/receipts/${uuidv7()}`)).statusCode, 429);
    assert.equal((await room.dmClient.get(`/api/rooms/${room.roomId}/receipts/${uuidv7()}`)).statusCode, 200, "another member's limit is their own");
  });

  test("pruning deletes rows older than 7 days and keeps a room's newest 10,000 of those past a day, never one younger than 24 hours", async () => {
    const room = await setup(t, "Dice prune");
    const insert = (count: number, age: string, prefix: string) =>
      t.pool.query(
        `insert into roll_receipts (room_id, member_id, tag, part, state, seq, at)
         select $1, 'm', $2 || g, 0, 'committed', 1, now() - $3::interval - g * interval '1 second' from generate_series(1, $4) g`,
        [room.roomId, prefix, age, count],
      );
    await insert(5, "1 hour", "young-");
    await insert(LIMITS.receiptsKeptOlder + 3, "2 days", "aged-");
    await insert(4, "8 days", "old-");
    await pruneReceipts(t.pool);
    const { rows } = await t.pool.query<{ kind: string; n: string }>(`select split_part(tag, '-', 1) as kind, count(*)::text as n from roll_receipts where room_id = $1 group by 1`, [room.roomId]);
    const counts = Object.fromEntries(rows.map((r) => [r.kind, Number(r.n)]));
    assert.deepEqual(counts, { young: 5, aged: LIMITS.receiptsKeptOlder });
    const kept = await t.pool.query<{ tag: string }>(`select tag from roll_receipts where room_id = $1 and tag like 'aged-%' order by at asc limit 1`, [room.roomId]);
    assert.equal(kept.rows[0]?.tag, `aged-${LIMITS.receiptsKeptOlder}`, "the newest of them stay");
  });
});

describe("a request's answer and a death save rolled on the server", () => {
  let t: Engine;
  before(async () => {
    t = await startEngine();
  });
  after(() => t.close());

  test("a player's Roll with a typed bonus answers once, its tag answers again from its receipt, and a second Roll finds it answered", async () => {
    const room = await setup(t, "Dice answer");
    const pip = room.players[0]!;
    const bree = uuidv7();
    await room.dm.apply({ t: "character.create", character: { id: bree, name: "Bree", size: "medium", ownerIds: [pip.id], actor: inline } } as Op);
    await room.dm.apply({ t: "roll.ask", request: { id: "r1", test: { kind: "save", choices: [{ ability: "dex" }] }, dc: 13, dcShown: true, resultShown: true, targets: [{ characterId: bree }] } } as Op);
    const tag = uuidv7();
    const op = { t: "roll.dice", tag, rollId: "r1", target: { characterId: bree }, bonus: 4 } as Op;
    const sent = await send(pip.socket, op);
    assert.deepEqual(sent.answer, { ok: true });
    const target = (sent.ev.changes.find((c) => c.key === "roll:r1") as { value: { targets: { total?: number; dice?: unknown; typedBonus?: true; tag?: string }[] } } | undefined)?.value.targets[0];
    assert.ok(target?.dice, "the player's own view holds the dice");
    assert.equal(target.typedBonus, true);
    assert.equal(target.tag, tag);
    const tab = await reconnect(t, room.roomId, pip.client);
    const again = await send(tab, op);
    assert.deepEqual(again.answer, { ok: true });
    assert.equal(again.ev.changes.length, 0, "nothing applied twice");
    const second = await send(pip.socket, { t: "roll.dice", tag: uuidv7(), rollId: "r1", target: { characterId: bree }, bonus: 4 } as Op);
    assert.deepEqual(second.answer, { ok: false, code: "invalid", message: "It was answered meanwhile." });
    const lookup = (await pip.client.get(`/api/rooms/${room.roomId}/receipts/${tag}`)).json<Lookup>();
    assert.equal(lookup.parts[0]?.state, "committed");
    assert.equal(lookup.parts[0]?.state === "committed" && lookup.parts[0].lines[0]?.data?.type, "roll");
  });

  test("a death save rolled for a dying token is counted by the server in the same op", async () => {
    const room = await setup(t, "Dice death");
    const pip = room.players[0]!;
    const id = uuidv7();
    await room.dm.apply({ t: "token.create", token: { id, sceneId: room.sceneId, kind: "pc", name: "Thorn", size: "medium", x: 2, y: 2, ownerIds: [pip.id], actor: { inline: { ...inline, hp: { cur: 0, max: 7, temp: 0 }, life: "dying" } } } } as Op);
    const sent = await send(pip.socket, { t: "actor.deathRoll", tag: uuidv7(), target: { tokenId: id } } as Op);
    assert.deepEqual(sent.answer, { ok: true });
    const token = sent.ev.changes.find((c) => c.key === `token:${id}`) as { value: { actor: { inline: { deathSaves: { ok: number; fail: number }; life: string; hp: { cur: number } } } } } | undefined;
    const after = token?.value.actor.inline;
    assert.ok(after, "the token changed with the roll");
    assert.ok(after.deathSaves.ok + after.deathSaves.fail > 0 || after.life === "alive");
  });
});

describe("the day's caps and floods (docs/design-v1-dice.md 1.2 and 4.4)", () => {
  let t: Engine;
  before(async () => {
    t = await startEngine();
  });
  after(() => t.close());

  test("a player's flood of new tags: each charged at admission, refused with a receipt after it, and with none once the budget is out", async () => {
    const room = await setup(t, "Dice flood");
    const pip = room.players[0]!;
    const results: { answer: ReturnType<typeof answer> }[] = [];
    // Answers naming no request and rolls for a creature not theirs: permissions refuse each after admission.
    for (let i = 0; i < 30; i++) {
      const op = i % 2 === 0 ? ({ t: "roll.answer", rollId: uuidv7(), target: { tokenId: uuidv7() }, total: 12, tag: uuidv7() } as Op) : roll(uuidv7(), { rolls: [{ formula: "1d20", creature: { tokenId: uuidv7() } }] });
      results.push(await send(pip.socket, op));
    }
    const fast = results.filter((r) => !r.answer.ok && r.answer.message === ROLLING_TOO_FAST).length;
    const after = results.filter((r) => !r.answer.ok && r.answer.code === "gone").length;
    assert.ok(after >= LIMITS.playerRollBurst && after <= LIMITS.playerRollBurst + 2, `${after} were admitted`);
    assert.equal(fast + after, 30);
    const rows = await receiptRows(t, room.roomId, pip.id);
    assert.equal(rows.length, after, "a receipt for each admitted op, none for the budget's refusals");
    assert.ok(rows.every((r) => r.state === "refused" && r.code === "gone"));
    // The DM and other members are still admitted, and the counts hold across a restart.
    assert.deepEqual((await send(room.dm, roll())).answer, { ok: true });
    await t.restart();
    const socket = await reconnect(t, room.roomId, pip.client);
    assert.equal((await receiptRows(t, room.roomId, pip.id)).length, after);
    const lost = results.find((r) => !r.answer.ok && r.answer.message === ROLLING_TOO_FAST);
    assert.ok(lost);
    socket.close();
  });

  test("a lost admission refusal reads unknown: the lookup knows no receipt", async () => {
    const room = await setup(t, "Dice unknown");
    const pip = room.players[0]!;
    const tags: string[] = [];
    let refusedTag: string | null = null;
    for (let i = 0; i < 25 && refusedTag === null; i++) {
      const tag = uuidv7();
      tags.push(tag);
      const sent = await send(pip.socket, roll(tag));
      if (!sent.answer.ok && sent.answer.message === ROLLING_TOO_FAST) refusedTag = tag;
    }
    assert.ok(refusedTag);
    assert.deepEqual((await pip.client.get(`/api/rooms/${room.roomId}/receipts/${refusedTag}`)).json<Lookup>(), { parts: [] });
  });

  test("at the room's cap, a new tagged op is refused with no receipt, a settled one is answered from its receipt, and work in flight counts", async () => {
    const room = await setup(t, "Dice cap");
    const pip = room.players[0]!;
    await t.restart();
    await fillReceipts(t, room.roomId, room.dmId, LIMITS.receiptsPerDay - 1);
    // The oldest receipt of the day, an op the DM's device may still retry by its tag.
    await t.pool.query(`update roll_receipts set at = now() - interval '23 hours' where room_id = $1 and tag = 'fill-1'`, [room.roomId]);
    const dm = await reconnect(t, room.roomId, room.dmClient);
    const socket = await reconnect(t, room.roomId, pip.client);
    // Two ops in one batch: the first takes the last slot while it is staged, so the second is refused.
    const a = socket.op(roll());
    const b = socket.op(roll());
    const evA = await socket.next("ev", (m) => (m.acks?.includes(a) ?? false) || (m.rejects?.some((r) => r.n === a) ?? false));
    assert.deepEqual(answer(evA, a), { ok: true });
    const evB = evA.acks?.includes(b) || evA.rejects?.some((r) => r.n === b) ? evA : await socket.next("ev", (m) => (m.acks?.includes(b) ?? false) || (m.rejects?.some((r) => r.n === b) ?? false));
    assert.deepEqual(answer(evB, b), { ok: false, code: "quota", message: ROOM_ROLLED_TOO_MUCH });
    assert.equal((await receiptRows(t, room.roomId)).length, LIMITS.receiptsPerDay, "the refusal took no slot");
    const oldest = await send(dm, roll("fill-1"));
    assert.deepEqual(oldest.answer, { ok: true }, "answered from its receipt");
    assert.equal(diceLines(oldest.ev.changes).length, 0, "and nothing applied");
    assert.deepEqual((await send(dm, roll())).answer, { ok: false, code: "quota", message: ROOM_ROLLED_TOO_MUCH }, "the cap never evicts, for the DM too");
  });

  test("a player's share stops them alone, and the players together leave the DMs' floor", async () => {
    const room = await setup(t, "Dice shares", 5);
    const [p1, p2, p3, p4, p5] = room.players as [Room["players"][number], Room["players"][number], Room["players"][number], Room["players"][number], Room["players"][number]];
    await t.restart();
    await fillReceipts(t, room.roomId, p1.id, LIMITS.receiptsPerPlayerDay, "p1");
    const s1 = await reconnect(t, room.roomId, p1.client);
    const s2 = await reconnect(t, room.roomId, p2.client);
    assert.deepEqual((await send(s1, roll())).answer, { ok: false, code: "quota", message: PLAYER_ROLLED_TOO_MUCH });
    assert.deepEqual((await send(s2, roll())).answer, { ok: true }, "another player goes on");
    await t.restart();
    for (const [p, prefix] of [
      [p2, "p2"],
      [p3, "p3"],
    ] as const) {
      await fillReceipts(t, room.roomId, p.id, LIMITS.receiptsPerPlayerDay - (p === p2 ? 1 : 0), prefix);
    }
    await fillReceipts(t, room.roomId, p4.id, LIMITS.receiptsPerDay - LIMITS.receiptsDmFloor - 3 * LIMITS.receiptsPerPlayerDay, "p4");
    const s5 = await reconnect(t, room.roomId, p5.client);
    const dm = await reconnect(t, room.roomId, room.dmClient);
    assert.deepEqual((await send(s5, roll())).answer, { ok: false, code: "quota", message: PLAYERS_ROLLED_TOO_MUCH });
    assert.deepEqual((await send(dm, roll())).answer, { ok: true }, "the DMs' floor is free");
  });

  test("a batch that never commits gives its slot back", async () => {
    const room = await setup(t, "Dice slot back");
    const pip = room.players[0]!;
    await t.restart();
    await fillReceipts(t, room.roomId, room.dmId, LIMITS.receiptsPerDay - 1);
    const socket = await reconnect(t, room.roomId, pip.client);
    const failing = failCommits(t.pool, Array.from({ length: 1_000 }, () => "before" as const));
    socket.op(roll());
    await new Promise((resolve) => setTimeout(resolve, 300));
    await t.restart();
    failing.restore();
    assert.equal((await receiptRows(t, room.roomId, pip.id)).length, 0);
    const again = await reconnect(t, room.roomId, pip.client);
    assert.deepEqual((await send(again, roll())).answer, { ok: true }, "the abandoned batch's slot came back");
  });
});
