import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { uuidv7 } from "#shared/ids.ts";
import type { LogEntry } from "#shared/model.ts";
import { stableStringify, type ProjectedState } from "#shared/project.ts";
import type { Op, ServerMessage } from "#shared/protocol.ts";
import { formatDisplayCode } from "../auth/displaySessions.ts";
import { startEngine, type Engine, type Socket, type TestClient } from "./testing.ts";

/*
 * Spell slots' and Hit Point Dice's privacy twins over real sockets
 * (docs/design/design-v1-slots.md 7): pairs of rooms alike but for what Pat,
 * a player who does not play Bree, may not learn, the same steps in both,
 * and every frame Pat (and the table display, and Lou, who is lent only
 * Bree's token) is sent compared whole once normalized: ids read by the
 * role the test gave them or by where the seat first met them, times as
 * "time", and the room's op count left out (every `seq` and the number of a
 * log line's id), since a hidden op moves it too. Kim plays Bree, and Lee
 * plays her too.
 */

const draws = { faces: [] as number[] };

const inline = { hp: { cur: 12, max: 12, temp: 0 }, life: "alive", ac: 14, speeds: { walk: 30 }, initBonus: 2, passivePerception: 12, senses: "", effects: [], deathSaves: { ok: 0, fail: 0 }, notes: "", dmNotes: "" };

type Seat = { socket: Socket; frames: string[]; memberId: string };

type Twin = {
  roomId: string;
  dm: Socket;
  clients: { kim: TestClient; pat: TestClient; lee: TestClient; lou: TestClient; tv: TestClient };
  ids: Record<string, string>;
  seats: { kim: Seat; pat: Seat; lee: Seat; lou: Seat; tv: Seat };
  marker: string;
  x: number;
};

async function seat(socket: Socket, clientId: string): Promise<Seat> {
  const frames: string[] = [];
  socket.ws.on("message", (data) => frames.push(data.toString()));
  const snap = await socket.snapshot(clientId);
  return { socket, frames, memberId: snap.you.memberId };
}

async function ok(socket: Socket, op: Op): Promise<void> {
  const ev = await socket.apply(op);
  assert.deepEqual(ev.rejects ?? [], [], `${op.t} was refused`);
}

/** The answer an op of a seat's got: applied, or the refusal's code and words. */
async function answer(s: Seat, op: Op): Promise<string> {
  const n = s.socket.op(op);
  const ev = await s.socket.next("ev", (m) => (m.acks?.includes(n) ?? false) || (m.rejects?.some((r) => r.n === n) ?? false));
  const no = ev.rejects?.find((r) => r.n === n);
  return no ? `refused ${no.code}: ${no.message}` : "applied";
}

/**
 * A room: the DM, Kim and Lee who play Bree (a Fighter 5, Wizard 5 and
 * Warlock 5 at 5 of 40 HP, no stat block), Pat who plays Ash, Lou who is
 * lent Bree's second token, and the table display, every one seated, with a
 * marker each sees, whose move syncs them.
 */
async function twin(t: Engine, name: string, partyHp: boolean): Promise<Twin> {
  const dmClient = t.client();
  const { roomId } = await dmClient.createRoom(name);
  const clients = { kim: t.client(), pat: t.client(), lee: t.client(), lou: t.client(), tv: t.client() };
  const members: Record<string, string> = {};
  for (const who of ["kim", "pat", "lee", "lou"] as const) members[who] = await clients[who].join(roomId, who);
  const dm = await t.connect(roomId, dmClient);
  const snap = await dm.snapshot("dm");
  const sceneId = (snap.state as ProjectedState).meta.playerSceneId!;
  const ids = { bree: uuidv7(), ash: uuidv7(), breeToken: uuidv7(), lentToken: uuidv7(), ashToken: uuidv7(), marker: uuidv7(), ...members, dm: snap.you.memberId, room: roomId };
  await ok(dm, { t: "room.update", settings: { pcHpVisibleToParty: partyHp } } as Op);
  await ok(dm, { t: "character.create", character: { id: ids.bree, name: "Bree", size: "medium", ownerIds: [members.kim!, members.lee!], actor: { ...inline, hp: { cur: 5, max: 40, temp: 0 } } } } as Op);
  await ok(dm, { t: "character.create", character: { id: ids.ash, name: "Ash", size: "medium", ownerIds: [members.pat!], actor: inline } } as Op);
  await ok(dm, { t: "token.create", token: { id: ids.breeToken, sceneId, kind: "pc", name: "Bree", size: "medium", x: 2, y: 2, ownerIds: [members.kim!, members.lee!], actor: { ref: ids.bree } } } as Op);
  await ok(dm, { t: "token.create", token: { id: ids.lentToken, sceneId, kind: "pc", name: "Bree", size: "medium", x: 3, y: 2, ownerIds: [members.lou!], actor: { ref: ids.bree } } } as Op);
  await ok(dm, { t: "token.create", token: { id: ids.ashToken, sceneId, kind: "pc", name: "Ash", size: "medium", x: 4, y: 2, ownerIds: [members.pat!], actor: { ref: ids.ash } } } as Op);
  await ok(dm, { t: "token.create", token: { id: ids.marker, sceneId, kind: "object", name: "Marker", size: "medium", x: 15, y: 18, fogExempt: true, actor: { inline } } } as Op);
  const code = await dmClient.post(`/api/rooms/${roomId}/display/code`);
  assert.equal((await clients.tv.post("/api/display/redeem", { code: formatDisplayCode(code.json<{ code: string }>().code) })).statusCode, 200);
  const seats = {
    kim: await seat(await t.connect(roomId, clients.kim), "kim"),
    pat: await seat(await t.connect(roomId, clients.pat), "pat"),
    lee: await seat(await t.connect(roomId, clients.lee), "lee"),
    lou: await seat(await t.connect(roomId, clients.lou), "lou"),
    tv: await seat(await t.connectDisplay(roomId, clients.tv), "tv"),
  };
  const out: Twin = { roomId, dm, clients, ids, seats, marker: ids.marker, x: 15 };
  await sync(out);
  return out;
}

/** The DM moves the marker, and every seat is waited for until it was sent the move. */
async function sync(x: Twin): Promise<void> {
  x.x = x.x === 15 ? 16 : 15;
  await ok(x.dm, { t: "token.move", tokenId: x.marker, x: x.x, y: 18 });
  const want = x.x;
  for (const s of Object.values(x.seats)) {
    for (let i = 0; i < 200; i++) {
      if (s.frames.some((f) => f.includes(x.marker) && f.includes(`"x":${want}`))) break;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
  await new Promise((resolve) => setTimeout(resolve, 60));
}

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g;
const TIME = /\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d+)?Z/g;

/** A seat's frames made comparable between two rooms: ids by role, the server's own by where the seat met them, no op count. */
function normal(x: Twin, s: Seat): unknown[] {
  const names = new Map<string, string>(Object.entries(x.ids).map(([role, id]) => [id, role]));
  let made = 0;
  const text = (raw: string) =>
    raw
      .split(x.seats.tv.memberId)
      .join("tv")
      .replace(UUID, (id) => {
        if (!names.has(id)) names.set(id, `id${++made}`);
        return names.get(id)!;
      })
      .replace(TIME, "time")
      .replace(/^(log:)?\d+:(\d+)$/, "$1n:$2");
  const walk = (v: unknown, key: string): unknown => {
    if (typeof v === "string") return text(v);
    if (Array.isArray(v)) return key === "online" || key === "changes" ? v.map((inner) => walk(inner, "")).sort((p, q) => (stableStringify(p) < stableStringify(q) ? -1 : 1)) : v.map((inner) => walk(inner, ""));
    if (v === null || typeof v !== "object") return v;
    return Object.fromEntries(
      Object.entries(v)
        .filter(([k]) => k !== "seq" && k !== "at" && !(key === "path" && k === "turn"))
        .map(([k, inner]) => [text(k), walk(inner, k)]),
    );
  };
  const out: unknown[] = [];
  for (const frame of s.frames) {
    const m = JSON.parse(frame) as Record<string, unknown>;
    // An `ev` with nothing in it says only that the room moved on, which a hidden op does too.
    if (m.t === "ev" && Object.keys(m).every((k) => k === "t" || k === "seq" || k === "changes") && (m.changes as unknown[]).length === 0) continue;
    out.push(JSON.parse(stableStringify(walk(m, ""))));
  }
  return out;
}

/** The seats named were sent the same frames in both rooms, whole, once normalized. */
function same(a: Twin, b: Twin, who: readonly (keyof Twin["seats"])[], when: string): void {
  for (const w of who) {
    const [fa, fb] = [normal(a, a.seats[w]), normal(b, b.seats[w])];
    const at = fa.findIndex((f, i) => stableStringify(f) !== stableStringify(fb[i]));
    const [ja, jb] = at < 0 ? ["", ""] : [stableStringify(fa[at]), stableStringify(fb[at])];
    let c = 0;
    while (c < ja.length && ja[c] === jb[c]) c++;
    const shown = at < 0 ? "" : `, frame ${at}:\n${ja.slice(Math.max(0, c - 200), c + 200)}\n${jb.slice(Math.max(0, c - 200), c + 200)}`;
    assert.deepEqual(fa, fb, `${when}: ${w} was sent the same frames${shown}`);
  }
}

/** No field of the three, and no slot or die line, in what a seat was sent. */
function holdsNone(s: Seat, when: string): void {
  for (const frame of s.frames) {
    assert.doesNotMatch(frame, /"(classes|spent|useRev|hitDie)"/, `${when}: a frame holds a slot field`);
    assert.doesNotMatch(frame, /"what":"(slot|pact|hitDie)"/, `${when}: a frame holds a slot or die line`);
  }
}

const close = (...rooms: Twin[]) => {
  for (const x of rooms) for (const s of Object.values(x.seats)) s.socket.close();
};

const classes = (x: Twin): Op => ({ t: "character.update", characterId: x.ids.bree!, patch: { classes: [{ id: "fighter", level: 5 }, { id: "wizard", level: 5 }, { id: "warlock", level: 5 }], level: 15 } }) as Op;
const use = (x: Twin, u: Record<string, unknown>, target: "bree" | "breeToken" | "lentToken" = "breeToken", back = false): Op =>
  ({ t: "actor.use", target: "bree" === target ? { characterId: x.ids.bree } : { tokenId: x.ids[target] }, use: u, ...(back ? { back: true } : {}) }) as Op;

describe("spell slots and Hit Point Dice: the privacy twins (docs/design/design-v1-slots.md 7)", () => {
  let t: Engine;
  before(async () => {
    t = await startEngine({
      rooms: {
        actor: {
          draw: (sides) => {
            draws.faces.push(sides);
            return Math.min(sides, 7);
          },
        },
      },
    });
  });
  after(() => t.close());

  test("1. Pat's snapshot and every frame are the same whether Bree has classes, slots spent and a moved stamp, or none", async () => {
    const a = await twin(t, "Twin 1", true);
    const b = await twin(t, "Twin 1", true);
    await ok(a.dm, classes(a));
    assert.equal(await answer(a.seats.kim, use(a, { kind: "slot", level: 2 })), "applied");
    assert.equal(await answer(a.seats.kim, use(a, { kind: "pact" })), "applied");
    assert.equal(await answer(a.seats.kim, { t: "actor.rest", target: { tokenId: a.ids.breeToken! }, kind: "short" } as Op), "applied");
    assert.equal(await answer(b.seats.kim, { t: "actor.rest", target: { tokenId: b.ids.breeToken! }, kind: "short" } as Op), "applied");
    for (const x of [a, b]) await sync(x);
    same(a, b, ["pat", "tv", "lou"], "after the classes and spends");
    // A fresh snapshot of each room reads alike for Pat too.
    for (const x of [a, b]) {
      x.seats.pat.socket.close();
      x.seats.pat = await seat(await t.connect(x.roomId, x.clients.pat), "pat-again");
      await sync(x);
    }
    same(a, b, ["pat"], "Pat's fresh snapshot");
    holdsNone(a.seats.pat, "twin 1");
    close(a, b);
  });

  test("2. Kim spends and restores a level 3 slot and a Pact Magic slot: Pat gets no frame, against a twin where Kim does nothing", async () => {
    const a = await twin(t, "Twin 2", true);
    const b = await twin(t, "Twin 2", true);
    for (const x of [a, b]) await ok(x.dm, classes(x));
    for (const x of [a, b]) await sync(x);
    const before = { a: a.seats.pat.frames.length, b: b.seats.pat.frames.length };
    for (const op of [use(a, { kind: "slot", level: 3 }), use(a, { kind: "slot", level: 3 }, "breeToken", true), use(a, { kind: "pact" }), use(a, { kind: "pact" }, "breeToken", true)]) assert.equal(await answer(a.seats.kim, op), "applied");
    for (const x of [a, b]) await sync(x);
    same(a, b, ["pat", "tv", "lou"], "after Kim's spends");
    // Past the marker's move, Pat's frames since are as many in both rooms: none of Kim's four reached Pat.
    assert.equal(a.seats.pat.frames.length - before.a, b.seats.pat.frames.length - before.b);
    holdsNone(a.seats.pat, "twin 2");
    close(a, b);
  });

  for (const partyHp of [true, false]) {
    test(`3. Kim's Hit Point Die roll that heals Bree 9 and her typed one read for Pat as the DM's heals of 9, line ids included (party HP ${partyHp ? "on" : "off"})`, async () => {
      const a = await twin(t, "Twin 3", partyHp);
      const b = await twin(t, "Twin 3", partyHp);
      for (const x of [a, b]) await ok(x.dm, classes(x));
      for (const x of [a, b]) await sync(x);
      draws.faces = [];
      assert.equal(await answer(a.seats.kim, { t: "actor.hitDieRoll", tag: uuidv7(), target: { tokenId: a.ids.breeToken! }, die: 10, con: 2 } as Op), "applied");
      assert.deepEqual(draws.faces, [10], "one d10, a 7");
      assert.equal(await answer(a.seats.kim, use(a, { kind: "hitDie", die: 10, heal: 9 })), "applied");
      await ok(b.dm, { t: "actor.hp", target: { tokenId: b.ids.breeToken! }, change: { kind: "heal", amount: 9 } } as Op);
      await ok(b.dm, { t: "actor.hp", target: { tokenId: b.ids.breeToken! }, change: { kind: "heal", amount: 9 } } as Op);
      for (const x of [a, b]) await sync(x);
      same(a, b, ["pat", "tv", "lou"], "after the heals");
      holdsNone(a.seats.pat, "twin 3");
      close(a, b);
    });
  }

  test("4. a player lent only Bree's token gets no classes, counts or lines, and the same refusal with 0 or 4 level 1 slots left", async () => {
    const a = await twin(t, "Twin 4", true);
    const b = await twin(t, "Twin 4", true);
    for (const x of [a, b]) await ok(x.dm, classes(x));
    for (let i = 0; i < 4; i++) assert.equal(await answer(a.seats.kim, use(a, { kind: "slot", level: 1 })), "applied");
    for (const x of [a, b]) await sync(x);
    const answers: string[] = [];
    for (const x of [a, b]) {
      for (const op of [use(x, { kind: "slot", level: 1 }, "lentToken"), use(x, { kind: "hitDie", die: 10, heal: 3 }, "lentToken"), { t: "actor.hitDieRoll", tag: uuidv7(), target: { tokenId: x.ids.lentToken! }, die: 10 } as Op]) answers.push(await answer(x.seats.lou, op));
      await sync(x);
    }
    assert.deepEqual(answers, Array(6).fill("refused forbidden: that is not yours"));
    same(a, b, ["lou", "pat", "tv"], "after Lou's tries");
    holdsNone(a.seats.lou, "twin 4");
    close(a, b);
  });

  test("5. the table display's frames hold none of the three fields, and Pat's log pages hold none of Bree's slot or die lines", async () => {
    const a = await twin(t, "Twin 5", true);
    await ok(a.dm, classes(a));
    for (const op of [use(a, { kind: "slot", level: 1 }), use(a, { kind: "pact" }), use(a, { kind: "hitDie", die: 6, heal: 2 })]) assert.equal(await answer(a.seats.kim, op), "applied");
    assert.equal(await answer(a.seats.kim, { t: "actor.hitDieRoll", tag: uuidv7(), target: { tokenId: a.ids.breeToken! }, die: 10, con: 0 } as Op), "applied");
    await sync(a);
    holdsNone(a.seats.tv, "the display");
    const page = (await a.clients.pat.get(`/api/rooms/${a.roomId}/log?limit=100`)).json<{ entries: LogEntry[] }>();
    assert.ok(page.entries.length > 0, "Pat reads a page");
    const text = JSON.stringify(page.entries);
    assert.doesNotMatch(text, /"what":"(slot|pact|hitDie)"/);
    assert.doesNotMatch(text, /"hitDie"/);
    // Kim's own page holds them all, so the page is the one that would show them.
    const kims = JSON.stringify((await a.clients.kim.get(`/api/rooms/${a.roomId}/log?limit=100`)).json<{ entries: LogEntry[] }>().entries);
    for (const what of ["slot", "pact", "hitDie"]) assert.match(kims, new RegExp(`"what":"${what}"`));
    assert.match(kims, /"hitDie":10/);
    close(a);
  });

  test("6. Bree's co-owner gets the counts and the roll", async () => {
    const a = await twin(t, "Twin 6", true);
    await ok(a.dm, classes(a));
    assert.equal(await answer(a.seats.kim, use(a, { kind: "slot", level: 3 })), "applied");
    assert.equal(await answer(a.seats.kim, { t: "actor.hitDieRoll", tag: uuidv7(), target: { tokenId: a.ids.breeToken! }, die: 10, con: 2 } as Op), "applied");
    await sync(a);
    const lee = a.seats.lee.frames.join("\n");
    assert.match(lee, /"classes":\[/);
    assert.match(lee, /"spent":\{/);
    assert.match(lee, /"useRev":2/);
    assert.match(lee, /"what":"slot"/);
    assert.match(lee, /"hitDie":10/, "the roll reached Lee");
    const messages = a.seats.lee.frames.map((f) => JSON.parse(f) as ServerMessage);
    const roll = messages.flatMap((m) => (m.t === "ev" ? m.changes : [])).find((c) => "value" in c && (c.value as LogEntry | null)?.data?.type === "dice");
    assert.ok(roll, "Lee holds the dice line");
    close(a);
  });
});
