import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { uuidv7 } from "#shared/ids.ts";
import { randomToken, sha256 } from "../auth/tokens.ts";
import type { LogNames } from "#shared/logText.ts";
import type { LogEntry } from "#shared/model.ts";
import type { Op } from "#shared/protocol.ts";
import { startEngine, type Engine, type Socket, type TestClient } from "../rooms/testing.ts";
import { renderLogExport } from "./logExport.ts";

/**
 * The session log listing and export (docs/design-v1-dm-tools.md 3.10):
 * projected for the caller before sessions, counts or lines are found, so
 * hidden rows change nothing a player gets, and every request charged the
 * same.
 */

function tokenOp(sceneId: string, name: string, overrides: Record<string, unknown> = {}): Extract<Op, { t: "token.create" }> {
  return {
    t: "token.create",
    token: {
      id: uuidv7(),
      sceneId,
      kind: "monster",
      name,
      size: "medium",
      x: 2,
      y: 2,
      actor: {
        inline: {
          hp: { cur: 30, max: 30, temp: 0 },
          life: "alive",
          ac: 15,
          speeds: { walk: 30 },
          initBonus: 2,
          passivePerception: 9,
          senses: "",
          effects: [],
          deathSaves: { ok: 0, fail: 0 },
          notes: "",
          dmNotes: "",
        },
      },
      ...overrides,
    },
  } as Extract<Op, { t: "token.create" }>;
}

type Listing = { sessions: { firstId: string; lastId: string; from: string; to: string; lines: number }[]; lines: number; nextSessionsBefore: string | null };

describe("the session log export", () => {
  let t: Engine;
  before(async () => {
    t = await startEngine();
  });
  after(() => t.close());

  async function room(name: string): Promise<{ dm: TestClient; roomId: string; socket: Socket; sceneId: string }> {
    const dm = t.client();
    const { roomId } = await dm.createRoom(name);
    const socket = await t.connect(roomId, dm);
    const snap = await socket.snapshot("dm");
    return { dm, roomId, socket, sceneId: (snap.state as { meta: { playerSceneId: string } }).meta.playerSceneId };
  }

  /**
   * Writes stored log rows from evenings a year ago. A row's id orders the
   * log as play did, so the ids here sit before every live row, in the
   * order of their times.
   */
  async function storeRows(roomId: string, rows: (Omit<LogEntry, "id"> & { index: number })[]): Promise<void> {
    for (const { index, ...row } of rows) {
      const entry = { ...row, id: `0:${index}` };
      await t.pool.query("insert into room_log (room_id, id, at, entry) values ($1, $2, $3, $4)", [roomId, entry.id, entry.at, JSON.stringify(entry)]);
    }
  }

  test("hidden rows change neither a player's listing, nor their file, nor the limit they have left", async () => {
    const { dm, roomId, socket, sceneId } = await room("Crypt Crawlers");
    const pip = t.client();
    const pipId = await pip.join(roomId, "Pip");
    const quin = t.client();
    const quinId = await quin.join(roomId, "Quin");
    const lurker = tokenOp(sceneId, "Lurker", { visibility: "dm" });
    await socket.apply(lurker);
    const dmId = (await dm.me(roomId)).memberId!;
    await storeRows(roomId, [
      { index: 100, at: "2025-10-01T19:00:00.000Z", kind: "chat", from: pipId, text: "Is the door locked?" },
      { index: 200, at: "2025-10-01T20:00:00.000Z", kind: "chat", from: pipId, text: "I kick it." },
      { index: 300, at: "2025-10-01T21:00:00.000Z", kind: "chat", from: dmId, text: "It holds." },
      { index: 500, at: "2025-10-08T19:00:00.000Z", kind: "chat", from: dmId, text: "Last time, a door." },
    ]);

    const ask = async () => {
      const listing = await pip.get(`/api/rooms/${roomId}/log/sessions`);
      assert.equal(listing.statusCode, 200, listing.body);
      const sessions = listing.json<Listing>();
      const evening = sessions.sessions.find((s) => s.from.startsWith("2025-10-01"))!;
      const one = await pip.get(`/api/rooms/${roomId}/log/export?from=${encodeURIComponent(evening.from)}&to=${encodeURIComponent(evening.to)}&tz=UTC`);
      assert.equal(one.statusCode, 200, one.body);
      const all = await pip.get(`/api/rooms/${roomId}/log/export?tz=UTC`);
      return { sessions, one: one.body, all: all.body, headers: one.headers };
    };
    const first = await ask();
    assert.equal(first.sessions.sessions.length, 3);
    assert.deepEqual(first.sessions.sessions.slice(1), [
      { firstId: "0:500", lastId: "0:500", from: "2025-10-08T19:00:00.000Z", to: "2025-10-08T19:00:00.000Z", lines: 1 },
      { firstId: "0:100", lastId: "0:300", from: "2025-10-01T19:00:00.000Z", to: "2025-10-01T21:00:00.000Z", lines: 3 },
    ]);
    assert.equal(first.one, "# Crypt Crawlers: log of October 1, 2025\n\n- 7:00 PM **Pip**: Is the door locked?\n- 8:00 PM **Pip**: I kick it.\n- 9:00 PM **Dungeon Master**: It holds.\n");
    assert.equal(first.headers["content-type"], "text/markdown; charset=utf-8");
    assert.equal(first.headers["content-disposition"], 'attachment; filename="crypt-crawlers-log-2025-10-01.md"');

    // Whispers between others and a hidden creature's lines: inside an evening, between the two, and live.
    await storeRows(roomId, [
      { index: 250, at: "2025-10-01T20:30:00.000Z", kind: "whisper", from: dmId, to: [quinId], text: "Quin, you hear something." },
      { index: 400, at: "2025-10-04T12:00:00.000Z", kind: "whisper", from: quinId, to: [dmId], text: "Can I scout ahead?" },
      { index: 450, at: "2025-10-05T12:00:00.000Z", kind: "event", data: { type: "hp", tokenId: lurker.token.id, change: "damage", amount: 3 } as LogEntry["data"] },
      { index: 600, at: "2025-10-08T22:30:00.000Z", kind: "event", data: { type: "hp", tokenId: lurker.token.id, change: "heal", amount: 3 } as LogEntry["data"] },
    ]);
    await socket.apply({ t: "actor.hp", target: { tokenId: lurker.token.id }, change: { kind: "damage", amount: 4 } } as Op);
    await socket.apply({ t: "log.whisper", to: [quinId], text: "psst" });
    const second = await ask();
    assert.deepEqual(second.sessions, first.sessions);
    assert.equal(second.one, first.one);
    assert.equal(second.all, first.all);

    // A player's file is their projected pages' text, read with their own view's names.
    const pages: LogEntry[] = [];
    let before: string | null = null;
    do {
      const page: { entries: LogEntry[]; nextBefore: string | null } = (await pip.get(`/api/rooms/${roomId}/log?limit=100${before ? `&before=${before}` : ""}`)).json();
      pages.unshift(...page.entries);
      before = page.nextBefore;
    } while (before !== null);
    const pipSocket = await t.connect(roomId, pip);
    const view = (await pipSocket.snapshot("pip")).state as LogNames & { meta: { name: string } };
    assert.equal(second.all, renderLogExport({ roomName: view.meta.name, entries: pages, names: view, me: pipId, tz: "UTC" }));

    // Six requests so far, each charged however hidden ops moved the room between them, so four are left.
    for (let i = 0; i < 4; i++) assert.equal((await pip.get(`/api/rooms/${roomId}/log/sessions`)).statusCode, 200);
    const over = await pip.get(`/api/rooms/${roomId}/log/export?tz=UTC`);
    assert.equal(over.statusCode, 429);
    assert.ok(Number(over.headers["retry-after"]) > 3000);
    // The limit is per member: Quin at the same table still has all of theirs.
    assert.equal((await quin.get(`/api/rooms/${roomId}/log/sessions`)).statusCode, 200);
  });

  test("the DM's file names creatures on every scene, and one member's two grants each get their own", async () => {
    const { dm, roomId, socket, sceneId } = await room("Two hats");
    const prep = uuidv7();
    await socket.apply({ t: "scene.create", scene: { id: prep, name: "Prep", bounds: { w: 10, h: 10 } } });
    const owlbear = tokenOp(prep, "Owlbear");
    const goblin = tokenOp(sceneId, "Goblin", { visibility: "dm" });
    await socket.apply(owlbear);
    await socket.apply(goblin);
    await socket.apply({ t: "actor.hp", target: { tokenId: owlbear.token.id }, change: { kind: "damage", amount: 5 } } as Op);
    await socket.apply({ t: "actor.hp", target: { tokenId: goblin.token.id }, change: { kind: "damage", amount: 6 } } as Op);

    // Pip plays on a phone, and the same member's laptop claims the DM key: one member, a player grant and a DM grant.
    const phone = t.client();
    const pipId = await phone.join(roomId, "Pip");
    const laptop = t.client();
    const ticket = (await laptop.post(`/api/rooms/${roomId}/join`, { password: "owlbear-druid-wand" })).json<{ ticket: string }>().ticket;
    assert.equal((await laptop.post(`/api/rooms/${roomId}/join/complete`, { ticket, memberId: pipId })).statusCode, 200);
    const dmKey = (await dm.post(`/api/rooms/${roomId}/dm/replace-link`)).json<{ dmLink: string }>().dmLink.split("#dm=")[1]!;
    assert.equal((await laptop.post(`/api/rooms/${roomId}/dm`, { key: dmKey })).statusCode, 200);
    assert.equal((await laptop.me(roomId)).role, "dm");
    assert.equal((await phone.me(roomId)).role, "player");

    const file = async (c: TestClient) => {
      const res = await c.get(`/api/rooms/${roomId}/log/export?tz=America/Chicago`);
      assert.equal(res.statusCode, 200, res.body);
      return res.body;
    };
    // The listings too, at one seq: the player grant's never comes from the DM grant's.
    const listed = async (c: TestClient) => (await c.get(`/api/rooms/${roomId}/log/sessions`)).json<Listing>().lines;
    const dmLines = await listed(laptop);
    const playerLines = await listed(phone);
    assert.ok(dmLines > playerLines, `${dmLines} > ${playerLines}`);
    assert.equal(await listed(phone), playerLines);
    const asDm = await file(laptop);
    const asPlayer = await file(phone);
    assert.match(asDm, /Owlbear takes 5 damage/);
    assert.match(asDm, /Goblin takes 6 damage/);
    assert.doesNotMatch(asPlayer, /Goblin|Owlbear/);
    // The other order, at a new seq.
    await socket.apply({ t: "log.chat", text: "Next round." });
    assert.doesNotMatch(await file(phone), /Goblin|Owlbear/);
    assert.match(await file(laptop), /Goblin takes 6 damage/);
  });

  test("time zones, grants and the display cookie", async () => {
    const { dm, roomId } = await room("Zones");
    assert.equal((await dm.get(`/api/rooms/${roomId}/log/export?tz=UTC`)).statusCode, 200);
    assert.equal((await dm.get(`/api/rooms/${roomId}/log/export?tz=Europe/Berlin`)).statusCode, 200);
    assert.equal((await dm.get(`/api/rooms/${roomId}/log/export?tz=Mars/Olympus_Mons`)).statusCode, 400);
    assert.equal((await dm.get(`/api/rooms/${roomId}/log/export?from=yesterday`)).statusCode, 400);
    assert.equal((await t.client().get(`/api/rooms/${roomId}/log/sessions`)).statusCode, 403);
    const tv = t.client();
    const code = (await dm.post(`/api/rooms/${roomId}/display/code`)).json<{ code: string }>().code;
    await tv.post("/api/display/redeem", { code });
    assert.equal((await tv.get(`/api/rooms/${roomId}/log/export?tz=UTC`)).statusCode, 403);
    const swapped = t.client();
    swapped.token = tv.displayToken;
    assert.equal((await swapped.get(`/api/rooms/${roomId}/log/export?tz=UTC`)).statusCode, 403);
    assert.equal((await swapped.get(`/api/rooms/${roomId}/log/sessions`)).statusCode, 403);
  });

  /** Whispers from `from` to `to` at seq 0, indexes `lo` to `hi`, at one time. */
  async function storeWhispers(roomId: string, from: string, to: string, lo: number, hi: number, at: string): Promise<void> {
    await t.pool.query(
      `insert into room_log (room_id, id, at, entry)
       select $1, '0:' || g, $4::timestamptz,
         jsonb_build_object('id', '0:' || g, 'at', $4::text, 'kind', 'whisper', 'from', $5::text, 'to', jsonb_build_array($6::text), 'text', 'psst ' || g)
       from generate_series($2::int, $3::int) g`,
      [roomId, lo, hi, at, from, to],
    );
  }

  /** A listing and the whole file, and their counts, which must agree. */
  async function look(c: TestClient, roomId: string): Promise<{ listing: Listing; all: string }> {
    const res = await c.get(`/api/rooms/${roomId}/log/sessions?limit=50`);
    assert.equal(res.statusCode, 200, res.body);
    assert.equal(res.headers["cache-control"], "no-store");
    const listing = res.json<Listing>();
    const file = await c.get(`/api/rooms/${roomId}/log/export?tz=UTC`);
    assert.equal(file.statusCode, 200, file.body);
    assert.equal(file.headers["cache-control"], "no-store");
    const bullets = file.body.split("\n").filter((l) => l.startsWith("- ")).length;
    assert.equal(listing.sessions.reduce((n, x) => n + x.lines, 0), listing.lines);
    assert.equal(bullets, listing.lines);
    return { listing, all: file.body };
  }

  test("over 10,000 rows a viewer may not read survive a snapshot and a reload, and nobody's history, count or sessions change", async () => {
    const { dm, roomId, socket } = await room("Long archive");
    const dmId = (await dm.me(roomId)).memberId!;
    const pip = t.client();
    const pipId = await pip.join(roomId, "Pip");
    const quin = t.client();
    const quinId = await quin.join(roomId, "Quin");
    const rho = t.client();
    await rho.join(roomId, "Rho");
    await storeRows(
      roomId,
      [0, 1, 2, 3, 4].map((i) => ({ index: i, at: `2025-03-01T19:${String(i * 10).padStart(2, "0")}:00.000Z`, kind: "chat", from: dmId, text: `table ${i}` })),
    );
    await storeRows(roomId, [{ index: 5, at: "2025-03-01T19:50:00.000Z", kind: "whisper", from: pipId, to: [quinId], text: "pass it on" }]);
    // 10,050 whispers from the DM to Quin a week later: Quin and the DM read them, Pip and Rho read none.
    await storeWhispers(roomId, dmId, quinId, 10, 10_059, "2025-03-08T19:00:00.000Z");
    // An op since the last snapshot, so unloading writes one.
    await socket.apply({ t: "log.chat", text: "tonight" });
    const viewers = { dm, pip, quin, rho };
    const before: Record<string, { listing: Listing; all: string }> = {};
    for (const [name, c] of Object.entries(viewers)) before[name] = await look(c, roomId);
    socket.close();
    // A deploy: the room's snapshot is written as the server stops, and a fresh server loads it.
    await t.restart();
    const { rows } = await t.pool.query<{ seq: string }>("select seq from room_snapshots where room_id = $1", [roomId]);
    assert.ok(Number(rows[0]!.seq) > 0, "the snapshot was written");
    for (const [name, c] of Object.entries(viewers)) assert.deepEqual(await look(c, roomId), before[name], name);

    const evening = (name: string, day: string) => before[name]!.listing.sessions.find((x) => x.from.startsWith(day));
    assert.equal(evening("rho", "2025-03-01")?.lines, 5, "the nonparticipant keeps the table's evening");
    assert.equal(evening("rho", "2025-03-08"), undefined);
    assert.equal(evening("pip", "2025-03-01")?.lines, 6, "the sender keeps their whisper");
    assert.equal(evening("quin", "2025-03-01")?.lines, 6);
    assert.equal(evening("quin", "2025-03-08")?.lines, 10_050, "the recipient keeps every whisper");
    assert.equal(evening("dm", "2025-03-08")?.lines, 10_050);
    assert.equal(evening("dm", "2025-03-01")?.lines, 5, "the DM is no party to Pip's whisper");
  });

  test("a session exports by its first and last ids, exactly its lines, whatever its times say", async () => {
    const { dm, roomId } = await room("Clock");
    const dmId = (await dm.me(roomId)).memberId!;
    // 10:00, then 16:00 begins another session, which a clock set back carries on to 09:00 and 10:30.
    await storeRows(roomId, [
      { index: 1, at: "2025-04-01T10:00:00.000Z", kind: "chat", from: dmId, text: "a" },
      { index: 2, at: "2025-04-01T16:00:00.000Z", kind: "chat", from: dmId, text: "b" },
      { index: 3, at: "2025-04-01T09:00:00.000Z", kind: "chat", from: dmId, text: "c" },
      { index: 4, at: "2025-04-01T10:30:00.000Z", kind: "chat", from: dmId, text: "d" },
    ]);
    const listing = (await dm.get(`/api/rooms/${roomId}/log/sessions`)).json<Listing>();
    const stored = listing.sessions.filter((x) => x.firstId.startsWith("0:"));
    assert.deepEqual(
      stored.map((x) => [x.firstId, x.lastId, x.lines]),
      [
        ["0:2", "0:4", 3],
        ["0:1", "0:1", 1],
      ],
    );
    const lines = async (q: string) => {
      const res = await dm.get(`/api/rooms/${roomId}/log/export?tz=UTC&${q}`);
      assert.equal(res.statusCode, 200, res.body);
      assert.equal(res.headers["content-length"], undefined, "a streamed file names no length");
      return { text: res.body.split("\n").filter((l) => l.startsWith("- ")).map((l) => l.slice(l.lastIndexOf(" ") + 1)), name: res.headers["content-disposition"] };
    };
    assert.deepEqual((await lines("fromId=0:1&toId=0:1")).text, ["a"]);
    const second = await lines("fromId=0:2&toId=0:4");
    assert.deepEqual(second.text, ["b", "c", "d"]);
    assert.equal(second.name, 'attachment; filename="clock-log-2025-04-01.md"');
    assert.deepEqual((await lines("fromId=0:3&toId=0:3")).text, ["c"]);
    for (const q of ["fromId=0:1", "toId=0:1", "fromId=0:1&toId=0:1&from=2025-04-01T00:00:00Z", "fromId=0:4&toId=0:2", "fromId=x&toId=0:2"]) {
      assert.equal((await dm.get(`/api/rooms/${roomId}/log/export?tz=UTC&${q}`)).statusCode, 400, q);
    }
  });

  /** 30 one-line evenings, five hours apart, before the room's own lines. */
  async function thirtyEvenings(roomId: string, from: string): Promise<void> {
    const start = Date.parse("2025-05-01T00:00:00.000Z");
    await storeRows(
      roomId,
      Array.from({ length: 30 }, (_, i) => ({ index: i + 1, at: new Date(start + i * 5 * 3_600_000).toISOString(), kind: "chat" as const, from, text: `evening ${i + 1}` })),
    );
  }

  test("session pages slice one canonical list: limits 1 then 50, or 50 then 1, give the same sessions and total, each request charged", async () => {
    const { dm, roomId } = await room("Many evenings");
    const dmId = (await dm.me(roomId)).memberId!;
    const pip = t.client();
    await pip.join(roomId, "Pip");
    await thirtyEvenings(roomId, dmId);
    const get = async (c: TestClient, q: string) => {
      const res = await c.get(`/api/rooms/${roomId}/log/sessions?${q}`);
      assert.equal(res.statusCode, 200, res.body);
      return res.json<Listing>();
    };
    for (const [c, order] of [
      [dm, ["limit=1", "limit=50"]],
      [pip, ["limit=50", "limit=1"]],
    ] as const) {
      const first = await get(c, order[0]);
      const second = await get(c, order[1]);
      const [one, all] = order[0] === "limit=1" ? [first, second] : [second, first];
      assert.equal(all.sessions.length, 31);
      assert.equal(all.nextSessionsBefore, null);
      assert.equal(one.lines, all.lines);
      assert.deepEqual(one.sessions, all.sessions.slice(0, 1));
      assert.equal(one.nextSessionsBefore, all.sessions[0]!.firstId);
      // Walking back one at a time meets the same sessions.
      const next = await get(c, `limit=2&before=${one.nextSessionsBefore}`);
      assert.deepEqual(next.sessions, all.sessions.slice(1, 3));
      assert.equal(next.lines, all.lines);
      assert.equal(next.nextSessionsBefore, all.sessions[2]!.firstId);
      const tail = await get(c, `limit=50&before=${all.sessions[29]!.firstId}`);
      assert.deepEqual(tail.sessions, all.sessions.slice(30));
      assert.equal(tail.nextSessionsBefore, null);
    }
    // Four listings each, so six are left of the hour's ten, cached answers or not.
    for (let i = 0; i < 6; i++) assert.equal((await dm.get(`/api/rooms/${roomId}/log/sessions?limit=1`)).statusCode, 200);
    assert.equal((await dm.get(`/api/rooms/${roomId}/log/sessions?limit=1`)).statusCode, 429);
    assert.equal((await dm.get(`/api/rooms/${roomId}/log/sessions?limit=51`)).statusCode, 400);
    assert.equal((await pip.get(`/api/rooms/${roomId}/log/sessions?limit=0`)).statusCode, 400);
  });

  test("a session list too large to keep is found again for each request, with the same pages", async () => {
    const small = await startEngine({ log: { history: { summaryBytes: 64 } } });
    try {
      const pages = async (e: Engine) => {
        const dm = e.client();
        const { roomId } = await dm.createRoom("Many evenings");
        const dmId = (await dm.me(roomId)).memberId!;
        const start = Date.parse("2025-05-01T00:00:00.000Z");
        for (let i = 0; i < 30; i++) {
          const entry = { id: `0:${i + 1}`, at: new Date(start + i * 5 * 3_600_000).toISOString(), kind: "chat", from: dmId, text: `evening ${i + 1}` };
          await e.pool.query("insert into room_log (room_id, id, at, entry) values ($1, $2, $3, $4)", [roomId, entry.id, entry.at, JSON.stringify(entry)]);
        }
        const out: Listing[] = [];
        for (const q of ["limit=1", "limit=50", "limit=3&before=0:20", "limit=50&before=0:2", "limit=1&before=0:1"]) {
          const res = await dm.get(`/api/rooms/${roomId}/log/sessions?${q}`);
          assert.equal(res.statusCode, 200, res.body);
          const body = res.json<Listing>();
          // The room's own session (its DM's join, now) differs from room to room. Its line count stays in `lines`.
          out.push({ ...body, sessions: body.sessions.filter((x) => x.firstId.startsWith("0:")) });
        }
        return out;
      };
      assert.deepEqual(await pages(small), await pages(t));
    } finally {
      await small.close();
    }
  });
});

describe("a streamed export", () => {
  let t: Engine;
  let gate: { pass: string; reached: () => void; release: Promise<void> } | null = null;
  before(async () => {
    t = await startEngine({
      log: {
        history: {
          batchRows: 2,
          onBatch: async ({ pass }) => {
            const g = gate;
            if (!g || g.pass !== pass) return;
            gate = null;
            g.reached();
            await g.release;
          },
        },
      },
    });
  });
  after(() => t.close());

  /** Pauses the next batch of `pass` until the returned release, and says when it is reached. */
  function pause(pass: string): { reached: Promise<void>; release: () => void } {
    let reached!: () => void;
    let release!: () => void;
    const at = new Promise<void>((r) => (reached = r));
    gate = { pass, reached, release: new Promise<void>((r) => (release = r)) };
    return { reached: at, release };
  }

  function fetchExport(c: TestClient, roomId: string): Promise<Response> {
    return fetch(`${t.url.replace(/^ws/, "http")}/api/rooms/${roomId}/log/export?tz=UTC`, {
      headers: { cookie: `rvtt=${c.token}`, "cf-connecting-ip": c.ip, "sec-fetch-site": "same-origin" },
    });
  }

  async function readAll(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<string> {
    const decoder = new TextDecoder();
    let text = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return text;
      text += decoder.decode(value, { stream: true });
    }
  }

  async function exportRoom(): Promise<{ dm: TestClient; roomId: string; sessionId: string; pip: TestClient; pipId: string }> {
    const dm = t.client();
    const { roomId } = await dm.createRoom("Streamed");
    const dmId = (await dm.me(roomId)).memberId!;
    const pip = t.client();
    const pipId = await pip.join(roomId, "Pip");
    for (let i = 0; i < 6; i++) {
      const entry = { id: `0:${i}`, at: `2025-06-01T19:0${i}:00.000Z`, kind: "chat", from: dmId, text: `line ${i}` };
      await t.pool.query("insert into room_log (room_id, id, at, entry) values ($1, $2, $3, $4)", [roomId, entry.id, entry.at, JSON.stringify(entry)]);
    }
    const { rows } = await t.pool.query<{ id: string }>("select id from sessions where token_hash = $1", [sha256(dm.token!)]);
    return { dm, roomId, sessionId: rows[0]!.id, pip, pipId };
  }

  /** Reads an export's first chunk, then makes `change` while its next batch waits, and says how the body ended. */
  async function cutAfterFirstChunk(change: (r: Awaited<ReturnType<typeof exportRoom>>) => Promise<unknown>): Promise<{ first: string; ended: "aborted" | string }> {
    const r = await exportRoom();
    const paused = pause("lines");
    const res = await fetchExport(r.dm, r.roomId);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("content-length"), null);
    const reader = res.body!.getReader();
    const first = new TextDecoder().decode((await reader.read()).value);
    await paused.reached;
    await change(r);
    paused.release();
    const ended = await readAll(reader).catch(() => "aborted" as const);
    // The room's export slot and the scan's lease are free again at once.
    for (let i = 0; i < 50; i++) {
      const again = await r.pip.get(`/api/rooms/${r.roomId}/log/export?tz=UTC`);
      if (again.statusCode === 200) return { first, ended };
      assert.equal(again.statusCode, 429, again.body);
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.fail("the export slot was never released");
  }

  test("a file whose writer waits mid-stream ends whole when nothing changes", async () => {
    const { first, ended } = await cutAfterFirstChunk(async () => undefined);
    assert.match(first, /^# Streamed: log of /);
    assert.notEqual(ended, "aborted");
    assert.match(first + ended, /line 0\n[^]*line 5\n[^]*Pip joins the room\.\n$/);
  });

  test("a rotated token, expiry, sign-out, a role or member change, or a new epoch stops the file before its next chunk, without a clean end", async () => {
    const changes: Record<string, (r: Awaited<ReturnType<typeof exportRoom>>) => Promise<unknown>> = {
      // Rotation keeps the session id, its grant, member, role and epoch: only the token's hash moves.
      rotated: (r) => t.pool.query("update sessions set token_hash = $2 where id = $1", [r.sessionId, sha256(randomToken())]),
      expired: (r) => t.pool.query("update sessions set expires_at = now() - interval '1 second' where id = $1", [r.sessionId]),
      "signed out": (r) => t.pool.query("delete from sessions where id = $1", [r.sessionId]),
      "made a player": (r) => t.pool.query("update grants set role = 'player', epoch = (select player_epoch from rooms where id = $2) where session_id = $1 and room_id = $2", [r.sessionId, r.roomId]),
      "another member": (r) => t.pool.query("update grants set member_id = $3 where session_id = $1 and room_id = $2", [r.sessionId, r.roomId, r.pipId]),
      "new DM epoch": (r) => t.pool.query("update rooms set dm_epoch = dm_epoch + 1 where id = $1", [r.roomId]),
    };
    for (const [name, change] of Object.entries(changes)) {
      const { first, ended } = await cutAfterFirstChunk(change);
      assert.match(first, /^# Streamed: log of /, name);
      assert.equal(ended, "aborted", name);
    }
  });

  test("a change before the headers is an ordinary refusal", async () => {
    const r = await exportRoom();
    const paused = pause("bounds");
    const pending = r.dm.get(`/api/rooms/${r.roomId}/log/export?tz=UTC`);
    await paused.reached;
    await t.pool.query("update sessions set token_hash = $2 where id = $1", [r.sessionId, sha256(randomToken())]);
    paused.release();
    const res = await pending;
    assert.equal(res.statusCode, 403);
    assert.deepEqual(res.json(), { error: "no_access" });
  });
});
