import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import type { LogEntry } from "#shared/model.ts";
import { startEngine, type Engine } from "../rooms/testing.ts";

describe("GET /api/rooms/:id/log", () => {
  let t: Engine;
  before(async () => {
    t = await startEngine();
  });
  after(() => t.close());

  test("pages older entries newest first, projected for the caller", async () => {
    const dm = t.client();
    const { roomId } = await dm.createRoom("Log");
    const p1 = t.client();
    const p1Id = await p1.join(roomId, "Pip");
    const p2 = t.client();
    await p2.join(roomId, "Quin");
    const s = await t.connect(roomId, dm);
    await s.snapshot("dm");
    for (let i = 0; i < 5; i++) await s.apply({ t: "log.chat", text: `c${i}` });
    await s.apply({ t: "log.whisper", to: [p1Id], text: "psst" });
    const page = await dm.get(`/api/rooms/${roomId}/log?limit=3`);
    assert.equal(page.statusCode, 200, page.body);
    const body = page.json<{ entries: LogEntry[]; nextBefore: string | null }>();
    assert.deepEqual(body.entries.map((e) => e.text), ["c3", "c4", "psst"]);
    assert.equal(body.nextBefore, body.entries[0]?.id);
    const older = (await dm.get(`/api/rooms/${roomId}/log?limit=3&before=${body.nextBefore}`)).json<{ entries: LogEntry[]; nextBefore: string | null }>();
    assert.deepEqual(older.entries.map((e) => e.text), ["c0", "c1", "c2"]);
    // The join events and chats are under the last page.
    assert.equal(older.nextBefore, older.entries[0]?.id);
    const quin = (await p2.get(`/api/rooms/${roomId}/log?limit=10`)).json<{ entries: LogEntry[] }>();
    assert.ok(!quin.entries.some((e) => e.text === "psst"));
    const pip = (await p1.get(`/api/rooms/${roomId}/log?limit=10`)).json<{ entries: LogEntry[] }>();
    assert.ok(pip.entries.some((e) => e.text === "psst"));
    assert.equal((await t.client().get(`/api/rooms/${roomId}/log`)).statusCode, 403);
    assert.equal((await dm.get(`/api/rooms/${roomId}/log?before=nope`)).statusCode, 400);
    s.close();
  });

  test("a page and its cursor name only entries the caller may see, however many hidden rows lie between", async () => {
    const dm = t.client();
    const { roomId } = await dm.createRoom("Log secrets");
    const p1 = t.client();
    const pipId = await p1.join(roomId, "Pip");
    const p2 = t.client();
    await p2.join(roomId, "Quin");
    const s = await t.connect(roomId, dm);
    await s.snapshot("dm");
    await s.apply({ t: "log.chat", text: "hello all" });
    for (let i = 0; i < 4; i++) await s.apply({ t: "log.whisper", to: [pipId], text: `psst ${i}` });
    const whispers = (await dm.get(`/api/rooms/${roomId}/log?limit=10`)).json<{ entries: LogEntry[] }>().entries.filter((e) => e.kind === "whisper");
    assert.equal(whispers.length, 4);
    const pages: string[] = [];
    const named: string[] = [];
    const seen: string[] = [];
    let before: string | null = null;
    do {
      const res = await p2.get(`/api/rooms/${roomId}/log?limit=1${before ? `&before=${before}` : ""}`);
      assert.equal(res.statusCode, 200, res.body);
      pages.push(res.body);
      const page = res.json<{ entries: LogEntry[]; nextBefore: string | null }>();
      seen.push(...page.entries.map((e) => e.text ?? e.data?.type ?? ""));
      named.push(...page.entries.map((e) => e.id));
      if (page.nextBefore !== null) named.push(page.nextBefore);
      if (page.nextBefore !== null) assert.equal(page.nextBefore, page.entries[0]?.id);
      before = page.nextBefore;
    } while (before !== null && pages.length < 10);
    // The chat first, then the two joins, one a page, and no whisper between them or in a cursor.
    assert.deepEqual(seen, ["hello all", "member", "member"]);
    // Ids, not a substring of the body: an id such as 6:0 also turns up inside a timestamp.
    for (const w of whispers) assert.ok(!named.includes(w.id), `whisper ${w.id} named in a page`);
    s.close();
  });

  test("how many hidden rows lie between changes no page or cursor a player gets", async () => {
    // Every page Quin gets: its lines, and whether its cursor names its own oldest line, another row or none. The
    // rows' ids follow the room's seq, so they differ from room to room. Pip joins, the DM whispers to Pip `hidden`
    // times, then Quin joins and the DM chats, so Quin's last line, Pip's join, sits under the whispers.
    const pagesWith = async (hidden: number) => {
      const dm = t.client();
      const { roomId } = await dm.createRoom(`Log ${hidden}`);
      const p1 = t.client();
      const pipId = await p1.join(roomId, "Pip");
      const s = await t.connect(roomId, dm);
      await s.snapshot("dm");
      for (let i = 0; i < hidden; i++) {
        await s.apply({ t: "log.whisper", to: [pipId], text: `psst ${i}` });
        // Under the socket's op rate, so no whisper is answered busy.
        await new Promise((r) => setTimeout(r, 40));
      }
      const p2 = t.client();
      await p2.join(roomId, "Quin");
      await s.apply({ t: "log.chat", text: "hello all" });
      s.close();
      const pages: { lines: string[]; next: "its oldest" | "another row" | null }[] = [];
      let before: string | null = null;
      do {
        const res = await p2.get(`/api/rooms/${roomId}/log?limit=1${before ? `&before=${before}` : ""}`);
        assert.equal(res.statusCode, 200, res.body);
        const page = res.json<{ entries: LogEntry[]; nextBefore: string | null }>();
        const next = page.nextBefore === null ? null : page.nextBefore === page.entries[0]?.id ? "its oldest" : "another row";
        pages.push({ lines: page.entries.map((e) => e.text ?? e.data?.type ?? ""), next });
        before = page.nextBefore;
      } while (before !== null && pages.length < 10);
      return pages;
    };
    const none = await pagesWith(0);
    // With 98 the rows under Quin's join fit one 100-row read and with 99 they do not, which once decided whether
    // the page with Pip's join offered another.
    assert.deepEqual(await pagesWith(98), none);
    assert.deepEqual(await pagesWith(99), none);
    // The chat, the two joins, then an empty page that ends it: a full page always offers the next.
    assert.deepEqual(none, [
      { lines: ["hello all"], next: "its oldest" },
      { lines: ["member"], next: "its oldest" },
      { lines: ["member"], next: "its oldest" },
      { lines: [], next: null },
    ]);
  });
});
