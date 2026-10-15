import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { uuidv7 } from "#shared/ids.ts";
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

type Listing = { sessions: { from: string; to: string; lines: number }[]; lines: number };

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
      { from: "2025-10-08T19:00:00.000Z", to: "2025-10-08T19:00:00.000Z", lines: 1 },
      { from: "2025-10-01T19:00:00.000Z", to: "2025-10-01T21:00:00.000Z", lines: 3 },
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
});
