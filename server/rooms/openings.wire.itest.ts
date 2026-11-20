import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { uuidv7 } from "#shared/ids.ts";
import type { RoomState, Viewer } from "#shared/model.ts";
import { applyChanges, stableStringify, type ProjectedState } from "#shared/project.ts";
import type { Change, Op, ServerMessage } from "#shared/protocol.ts";
import { solid } from "../assets/testImages.ts";
import { formatDisplayCode } from "../auth/displaySessions.ts";
import { Connection } from "./connection.ts";
import { buildSnapshot } from "./fanout.ts";
import { Socket, startEngine, type Engine, type TestClient } from "./testing.ts";

/*
 * Openings' privacy twins over real sockets (docs/design/design-v1-floors.md
 * phase 4, 10.5): pairs of rooms alike but for what a player may not learn,
 * the same steps in both, and every frame Ana, Bree and the table display
 * are sent compared whole once normalized, with the room each holds and a
 * raw scan for every hidden id and name, through the actor and the fan-out,
 * with the players connected in both orders where the order could matter.
 * The DM's view as Ana is compared where the pair names it. Ana's undo and
 * redo, a reconnect, Bree's log page and a co-DM's edit run where a pair
 * reads them. Each seat's view is also checked against a fresh snapshot of
 * the committed room (the oracle).
 *
 * The comparison is floors.wire.itest.ts's (FL2-SOL-04), kept here whole
 * since a test file exports nothing: ids read by the role the test gave
 * them, the server's own ids by where a seat first met them, times as
 * "time". Inherited residuals it leaves out by name: the room's op count
 * (every `seq`, a path's `turn`, log line ids and an `ev` with nothing
 * else), which a hidden op moves too, and delivery timing, which rides on
 * the batch clock. The reducer's and projection's side of each twin is in
 * shared/openings.differential.test.ts, and sight's in
 * shared/openingSight.twins.test.ts and project.openings.test.ts. O10 and
 * O10b, areas through openings, are 4B-2's. O11b's stepped part and
 * admission answer wait for the size guard's stepped widths.
 */

const inline = (senses = "") => ({
  inline: { hp: { cur: 12, max: 12, temp: 0 }, life: "alive", ac: 14, speeds: { walk: 30 }, initBonus: 2, passivePerception: 12, senses, effects: [], deathSaves: { ok: 0, fail: 0 }, notes: "", dmNotes: "" },
});

/** The hole: 2 by 2 on the floor above, over the same squares on the floor below. */
const HOLE = { x: 6, y: 6, w: 2, h: 2 };

function wire(socket: Socket): string[] {
  const frames: string[] = [];
  socket.ws.on("message", (data) => frames.push(data.toString()));
  return frames;
}

type Who = { memberId: string; role: Viewer["role"]; display?: true; previewOf?: string; sceneId?: string };
type Seat = { name: string; socket: Socket; who: Who; view: ProjectedState; you: { sceneId: string | null }; frames: string[] };

async function seat(name: string, socket: Socket, who: Who, clientId = name): Promise<Seat> {
  const frames = wire(socket);
  const snap = await socket.snapshot(clientId, undefined, who.sceneId);
  return { name, socket, who, view: snap.state as ProjectedState, you: snap.you, frames };
}

async function catchUp(s: Seat, markerId: string, x: number): Promise<void> {
  const moved = (m: ServerMessage) => m.t === "ev" && m.changes.some((c) => c.key === `token:${markerId}` && "value" in c && (c.value as { x?: number } | null)?.x === x);
  for (;;) {
    const msg = s.socket.received.shift() ?? (await s.socket.next("ev"));
    if (msg.t === "ev") s.view = applyChanges(s.view, msg.changes as Change[]);
    if (moved(msg)) return;
  }
}

/** Folds whatever the seat holds now, after a wait long enough for one batch, for a seat the marker cannot reach. */
async function settle(s: Seat): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 150));
  for (let msg = s.socket.received.shift(); msg; msg = s.socket.received.shift()) if (msg.t === "ev") s.view = applyChanges(s.view, msg.changes as Change[]);
}

const silent = { readyState: 1, OPEN: 1, CONNECTING: 0, send: () => undefined, close: () => undefined, terminate: () => undefined };

/** Each seat's view is what a fresh snapshot of the committed room gives its socket's grant. */
async function oracle(t: Engine, roomId: string, seats: readonly Seat[], when: string): Promise<RoomState> {
  const actor = await t.manager.acquire(roomId);
  const state = await actor.read((s) => s);
  for (const s of seats) {
    const grant = s.who.previewOf
      ? { sessionId: "oracle", roomId, memberId: s.who.memberId, role: "dm" as const, previewOf: s.who.previewOf }
      : { sessionId: "oracle", roomId, memberId: s.who.memberId, role: s.who.role, ...(s.who.display ? { display: true } : {}) };
    const conn = new Connection(silent as never, grant, "203.0.113.9");
    conn.sceneId = s.who.sceneId ?? null;
    const fresh = JSON.parse(JSON.stringify(buildSnapshot(state, 0, conn, 0).message.state)) as ProjectedState;
    assert.equal(stableStringify(s.view), stableStringify(fresh), `${when}: ${s.name}'s view is a fresh snapshot`);
  }
  return state;
}

function naming(s: Seat, secrets: readonly string[]): string[] {
  return s.frames.filter((frame) => secrets.some((secret) => frame.includes(secret))).map((frame) => frame.slice(0, 300));
}

type Room = { roomId: string; dm: TestClient; ana: TestClient; bree: TestClient; tv: TestClient; dmId: string; anaId: string; breeId: string; ground: string; dmSocket: Socket; dmKey: string };

async function newRoom(t: Engine, name: string): Promise<Room> {
  const dm = t.client();
  const { roomId, dmKey } = await dm.createRoom(name);
  const ana = t.client();
  const anaId = await ana.join(roomId, "Ana");
  const bree = t.client();
  const breeId = await bree.join(roomId, "Bree");
  const dmSocket = await t.connect(roomId, dm);
  const snap = await dmSocket.snapshot("dm-main");
  const view = snap.state as ProjectedState;
  const tv = t.client();
  const code = await dm.post(`/api/rooms/${roomId}/display/code`);
  assert.equal((await tv.post("/api/display/redeem", { code: formatDisplayCode(code.json<{ code: string }>().code) })).statusCode, 200);
  return { roomId, dm, ana, bree, tv, dmId: snap.you.memberId, anaId, breeId, ground: view.meta.playerSceneId!, dmSocket, dmKey };
}

async function ok(socket: Socket, op: Op): Promise<Extract<ServerMessage, { t: "ev" }>> {
  const ev = await socket.apply(op);
  assert.deepEqual(ev.rejects ?? [], [], `${op.t} was refused`);
  return ev;
}

async function addFloor(r: Room, beside: string, side: "above" | "below", name: string): Promise<string> {
  const id = uuidv7();
  await ok(r.dmSocket, { t: "scene.create", scene: { id, name: "Tower", bounds: { w: 30, h: 20 } }, floor: { beside, side, name } } as Op);
  return id;
}

async function create(r: Room, sceneId: string, fields: Record<string, unknown>): Promise<string> {
  const id = uuidv7();
  await ok(r.dmSocket, { t: "token.create", token: { id, sceneId, kind: "monster", name: "Goblin", size: "medium", x: 2, y: 2, actor: inline(), ...fields } } as Op);
  return id;
}

async function players(t: Engine, r: Room, order: "ana first" | "bree first", preview: boolean): Promise<{ ana: Seat; bree: Seat; tv: Seat; asAna?: Seat }> {
  const open = {
    ana: async () => seat("Ana", await t.connect(r.roomId, r.ana), { memberId: r.anaId, role: "player" }),
    bree: async () => seat("Bree", await t.connect(r.roomId, r.bree), { memberId: r.breeId, role: "player" }),
  };
  const first = order === "ana first" ? await open.ana() : await open.bree();
  const second = order === "ana first" ? await open.bree() : await open.ana();
  const [ana, bree] = order === "ana first" ? [first, second] : [second, first];
  const tv = await seat("the TV", await t.connectDisplay(r.roomId, r.tv), { memberId: "", role: "player", display: true }, "tv");
  // A display's member id is its own, which only its snapshot says.
  tv.who.memberId = (JSON.parse(tv.frames.find((f) => f.includes('"t":"snapshot"'))!) as { you: { memberId: string } }).you.memberId;
  if (!preview) return { ana, bree, tv };
  const socket = await Socket.open(`${t.url}/ws?room=${r.roomId}&as=${r.anaId}`, { origin: t.config.publicOrigin, cookie: `rvtt=${r.dm.token}`, "cf-connecting-ip": r.dm.ip, "user-agent": "openings-wire-itest" });
  const asAna = await seat("the DM's view as Ana", socket, { memberId: r.dmId, role: "dm", previewOf: r.anaId }, "dm-preview");
  return { ana, bree, tv, asAna };
}

/** A room of a twin pair: its seats, the ids its players may hold by role, what they must never receive, and its marker's sync. */
type Compared = Room & {
  marker: string;
  sync: (when: string) => Promise<RoomState>;
  seats: { ana: Seat; bree: Seat; tv: Seat; asAna?: Seat };
  roles: [string, string][];
  forbidden: string[];
  anaFrom: number;
  /** No seat sees the marker (a blackout): a sync folds what one batch sends each seat instead. */
  blind?: boolean;
};

const seatsOf = (x: Compared): Seat[] => [x.seats.ana, x.seats.bree, x.seats.tv, ...(x.seats.asAna ? [x.seats.asAna] : [])];

/** Seats the room's players and display, with a marker every one of them sees on Ground floor, whose move syncs them. */
async function seated(t: Engine, r: Room, roles: [string, string][], forbidden: string[], order: "ana first" | "bree first" = "ana first", preview = false, blind = false): Promise<Compared> {
  const marker = await create(r, r.ground, { name: "Marker", kind: "object", x: 15, y: 18, fogExempt: true });
  const seats = await players(t, r, order, preview);
  let x = 15;
  const out: Compared = {
    ...r,
    marker,
    seats,
    roles: [...roles, [marker, "marker"]],
    forbidden,
    anaFrom: 0,
    blind,
    sync: async (when: string) => {
      x = x === 15 ? 16 : 15;
      await ok(r.dmSocket, { t: "token.move", tokenId: marker, x, y: 18 });
      for (const s of seatsOf(out)) await (out.blind ? settle(s) : catchUp(s, marker, x));
      return oracle(t, r.roomId, seatsOf(out), when);
    },
  };
  await out.sync("seated");
  return out;
}

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g;
const TIME = /\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d+)?Z/g;
/** The only places the server's own ids may stand: a history line's epoch and each stack's head step. */
const GENERATED_AT = [/^epoch$/, /^(play|setup)\.(undo|redo)\.head\.id$/];

type Names = { text: (raw: string) => string; generated: (raw: string) => boolean };

/** The names a seat's ids read by, so two rooms compare: an id the test made by its role, the server's own by where the seat first met it. */
function aliases(x: Compared, s: Seat): Names {
  const names = new Map<string, string>([[x.roomId, "room"], [x.dmId, "dm"], [x.anaId, "ana"], [x.breeId, "bree"], ...x.roles]);
  let made = 0;
  const meet = (text: string) => {
    for (const id of text.match(UUID) ?? []) if (!names.has(id)) names.set(id, `id${++made}`);
  };
  for (const frame of s.frames) meet(frame);
  meet(JSON.stringify(s.view));
  const text = (raw: string) =>
    raw
      .split(x.seats.tv.who.memberId)
      .join("tv")
      .replace(UUID, (id) => names.get(id)!)
      .replace(TIME, "time")
      .replace(/^(log:)?\d+:(\d+)$/, "$1n:$2");
  return { text, generated: (raw) => (raw.match(UUID) ?? []).some((id) => /^id\d+$/.test(names.get(id)!)) };
}

/** Something a seat holds or was sent, made comparable between two rooms, without the room's op count. */
function normal(names: Names, value: unknown): unknown {
  const text = (raw: string, path: string): string => {
    if (names.generated(raw)) assert.ok(GENERATED_AT.some((at) => at.test(path)), `an id the test did not make stands at ${path}: ${raw.slice(0, 80)}`);
    return names.text(raw);
  };
  const walk = (v: unknown, key: string, path: string): unknown => {
    if (typeof v === "string") return text(v, path);
    if (Array.isArray(v)) return key === "online" || key === "changes" ? v.map((inner) => walk(inner, "", path)).sort((p, q) => (stableStringify(p) < stableStringify(q) ? -1 : 1)) : v.map((inner) => walk(inner, "", path));
    if (v === null || typeof v !== "object") return v;
    const entries = Object.entries(v).filter(([k]) => k !== "seq" && !(key === "path" && k === "turn")).map(([k, inner]) => [text(k, `${path} (a key)`), walk(inner, k, path === "" ? k : `${path}.${k}`)] as const);
    assert.equal(new Set(entries.map(([k]) => k)).size, entries.length, `two keys read alike under ${path || "the top"}`);
    return Object.fromEntries(entries);
  };
  return JSON.parse(stableStringify(walk(value, "", "")));
}

function sent(names: Names, s: Seat): unknown[] {
  const out: unknown[] = [];
  for (const frame of s.frames) {
    const m = JSON.parse(frame) as Record<string, unknown>;
    if (m.t === "ev" && Object.keys(m).every((k) => k === "t" || k === "seq" || k === "changes") && (m.changes as unknown[]).length === 0) continue;
    out.push(normal(names, m));
  }
  return out;
}

/** No frame a seat was sent, nor its view, carries a forbidden id or name, read raw. The DM's view as Ana is a DM's socket, and reads Ana's room. */
function leaks(x: Compared, when: string): void {
  for (const s of seatsOf(x)) {
    assert.deepEqual(naming(s, x.forbidden), [], `${when}: ${s.name} was sent something hidden`);
    const view = JSON.stringify(s.view);
    assert.deepEqual(x.forbidden.filter((secret) => view.includes(secret)), [], `${when}: ${s.name} holds something hidden`);
  }
}

async function quiet(...rooms: Compared[]): Promise<void> {
  const count = () => rooms.reduce((n, x) => n + seatsOf(x).reduce((m, s) => m + s.frames.length, 0), 0);
  for (let last = -1, now = count(); now !== last; last = now, now = count()) await new Promise((resolve) => setTimeout(resolve, 120));
}

/** Every seat of both rooms was sent nothing hidden, holds the same room and was sent the same frames, whole, as many and as long once normalized. */
function same(a: Compared, b: Compared, when: string): void {
  for (const x of [a, b]) leaks(x, when);
  for (const who of ["ana", "bree", "tv", "asAna"] as const) {
    const [sa, sb] = [a.seats[who], b.seats[who]];
    if (!sa || !sb) {
      assert.equal(sa, sb, `${when}: ${who} seated in one room alone`);
      continue;
    }
    const [ta, tb] = [aliases(a, sa), aliases(b, sb)];
    assert.deepEqual(normal(ta, sa.view), normal(tb, sb.view), `${when}: ${who} holds the same room`);
    assert.deepEqual(normal(ta, sa.you), normal(tb, sb.you), `${when}: ${who} is told the same floor`);
    const [fa, fb] = [sent(ta, sa), sent(tb, sb)];
    assert.deepEqual(fa.map((f) => JSON.stringify(f).length), fb.map((f) => JSON.stringify(f).length), `${when}: ${who} was sent as many frames, as long`);
    assert.deepEqual(fa, fb, `${when}: ${who} was sent the same frames`);
  }
}

async function alike(a: Compared, b: Compared, when: string): Promise<void> {
  await quiet(a, b);
  same(a, b, when);
}

async function answered(s: Seat, n: number, from: number): Promise<string> {
  for (let i = 0; i < 100; i++) {
    for (const frame of s.frames.slice(from)) {
      const m = JSON.parse(frame) as ServerMessage;
      if (m.t !== "ev") continue;
      const no = m.rejects?.find((x) => x.n === n);
      if (no) return `refused ${no.code}: ${no.message}`;
      if (m.acks?.includes(n)) return `applied: ${m.restored?.find((x) => x.n === n)?.what ?? ""}`;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return "no answer";
}

/** Ana's device drops and comes back in both rooms: her new snapshot is the same room, and what she was sent before stays compared. */
async function reconnectBoth(t: Engine, a: Compared, b: Compared, when: string): Promise<void> {
  for (const x of [a, b]) {
    const earlier = x.seats.ana;
    earlier.socket.close();
    await earlier.socket.waitClosed();
    x.seats.ana = await seat("Ana", await t.connect(x.roomId, x.ana), { memberId: x.anaId, role: "player" }, "ana-again");
    x.seats.ana.frames.unshift(...earlier.frames);
    x.anaFrom = earlier.frames.length;
    await x.sync(when);
  }
  await alike(a, b, when);
}

/** The DM's ops in the first room alone, which no player may tell from none. */
async function unseen(a: Compared, b: Compared, ops: readonly Op[], when: string): Promise<void> {
  for (const op of ops) await ok(a.dmSocket, op);
  for (const x of [a, b]) await x.sync(when);
  await alike(a, b, when);
}

/** A DM's op in both rooms, each made for its room. */
async function both(a: Compared, b: Compared, op: (x: Compared) => Op, when: string, socket: (x: Compared) => Socket = (x) => x.dmSocket): Promise<void> {
  for (const x of [a, b]) {
    await ok(socket(x), op(x));
    await x.sync(when);
  }
  await alike(a, b, when);
}

/** One step of a player's in both rooms: the same answer, and every seat holding and sent the same. */
async function step(a: Compared, b: Compared, op: (x: Compared) => Promise<Op> | Op, when: string, by: (x: Compared) => Seat = (x) => x.seats.ana): Promise<string> {
  const answers: string[] = [];
  for (const x of [a, b]) {
    const s = by(x);
    const n = s.socket.op(await op(x));
    answers.push(await answered(s, n, s === x.seats.ana ? x.anaFrom : 0));
    await x.sync(when);
  }
  assert.equal(answers[0], answers[1], `${when}: the answer`);
  await alike(a, b, when);
  return answers[0]!;
}

const undo = async (x: Compared): Promise<Op> => ({ t: "undo", head: (await x.seats.ana.socket.historyHead("play", "undo"))! }) as Op;
const redo = async (x: Compared): Promise<Op> => ({ t: "redo", head: (await x.seats.ana.socket.historyHead("play", "redo"))! }) as Op;

const close = (...rooms: Compared[]) => {
  for (const x of rooms) for (const s of seatsOf(x)) s.socket.close();
};

describe("openings over the wire: the privacy twins (phase 4, 10.5)", () => {
  let t: Engine;
  before(async () => {
    t = await startEngine({ rooms: { idleUnloadMs: 60_000 } });
  });
  after(() => t.close());

  const live = (roomId: string): RoomState => t.manager.get(roomId)!.committed.state;

  /** Bree's log page in both rooms: it names nothing forbidden, and reads the same once normalized. */
  async function logPages(a: Compared, b: Compared, when: string): Promise<void> {
    const page = async (x: Compared) => {
      const res = await x.bree.get(`/api/rooms/${x.roomId}/log?limit=100`);
      assert.equal(res.statusCode, 200);
      assert.deepEqual(x.forbidden.filter((secret) => res.body.includes(secret)), [], `${when}: Bree's log page names something hidden`);
      return normal(aliases(x, x.seats.bree), JSON.parse(res.body));
    };
    assert.deepEqual(await page(a), await page(b), `${when}: Bree's log pages`);
  }

  /** A co-DM, whose member record players hold, so its id reads by its role in both rooms. */
  async function coDm(x: Compared): Promise<Socket> {
    const client = t.client();
    const memberId = await client.claimDm(x.roomId, x.dmKey);
    x.roles.push([memberId, "co-dm"]);
    const socket = await t.connect(x.roomId, client);
    await socket.snapshot("co-dm");
    return socket;
  }

  /**
   * Tower: Upper floor above Ground floor, the opening between them at
   * HOLE (`hole` on Upper floor, `below` its end on Ground floor), Thorn,
   * Ana's, on Upper floor, so every player holds it, and Wren, Bree's, on
   * Ground floor. `light` sets both floors' party vision, off without it.
   */
  async function holed(name: string, light?: "bright" | "dark") {
    const r = await newRoom(t, name);
    await ok(r.dmSocket, { t: "scene.update", sceneId: r.ground, patch: { name: "Tower" } });
    const upper = await addFloor(r, r.ground, "above", "Upper floor");
    if (light) for (const sceneId of [r.ground, upper]) await ok(r.dmSocket, { t: "scene.update", sceneId, patch: { vision: { on: true, light, byClock: false } } } as Op);
    const hole = uuidv7();
    const below = uuidv7();
    await ok(r.dmSocket, { t: "floorLink.put", link: { id: hole, pairId: below, sceneId: upper, to: r.ground, rect: HOLE, kind: "opening" } } as Op);
    const thorn = await create(r, upper, { kind: "pc", name: "Thorn", disposition: "ally", ownerIds: [r.anaId], x: 3, y: 7, actor: inline("Darkvision 60 ft") });
    const wren = await create(r, r.ground, { kind: "pc", name: "Wren", disposition: "ally", ownerIds: [r.breeId], x: 12, y: 12, actor: inline("Darkvision 60 ft") });
    const roles: [string, string][] = [[r.ground, "ground"], [upper, "upper"], [hole, "hole"], [below, "below"], [thorn, "thorn"], [wren, "wren"]];
    return { r, upper, hole, below, thorn, wren, roles };
  }

  for (const order of ["ana first", "bree first"] as const) {
    test(`O1, both floors open and lit: a hidden goblin walking in the column 20 times, or none, sends no frame and alike (${order})`, async () => {
      const make = async (goblin: boolean) => {
        const h = await holed("O1", "bright");
        const secret = goblin ? await create(h.r, h.r.ground, { name: "Goblin", visibility: "dm", x: 6, y: 6 }) : null;
        const x = await seated(t, h.r, h.roles, secret ? [secret, '"Goblin"'] : ['"Goblin"'], order);
        return { ...x, goblin: secret };
      };
      const a = await make(true);
      const b = await make(false);
      await alike(a, b, "seated");
      const walks = Array.from({ length: 20 }, (_, i): Op => ({ t: "token.move", tokenId: a.goblin!, x: 6 + (i % 2), y: 6 + (i % 2) }));
      await unseen(a, b, walks, "20 walks in the column");
      await both(a, b, (x) => ({ t: "token.move", tokenId: x.roles.find(([, role]) => role === "wren")![0], x: 13, y: 12 }), "Wren steps");
      close(a, b);
    });
  }

  test("O3, the floor below not reached: a map, a lamp under the hole, goblins and hidden stairs on a floor named Crypt, or an empty Attic, the map 404 to players, through a co-DM's rename, Bree's log page, Ana's reconnect and the DM's view as Ana", async () => {
    const make = async (full: boolean) => {
      const r = await newRoom(t, "O3");
      await ok(r.dmSocket, { t: "scene.update", sceneId: r.ground, patch: { name: "Tower" } });
      const name = full ? "Crypt" : "Attic";
      const cellar = await addFloor(r, r.ground, "below", name);
      for (const sceneId of [r.ground, cellar]) await ok(r.dmSocket, { t: "scene.update", sceneId, patch: { vision: { on: true, light: "dark", byClock: false } } } as Op);
      const hole = uuidv7();
      await ok(r.dmSocket, { t: "floorLink.put", link: { id: hole, pairId: uuidv7(), sceneId: r.ground, to: cellar, rect: HOLE, kind: "opening" } } as Op);
      const thorn = await create(r, r.ground, { kind: "pc", name: "Thorn", disposition: "ally", ownerIds: [r.anaId], x: 4, y: 7, actor: inline("Darkvision 60 ft") });
      const secrets = [cellar, name, live(r.roomId).floorLinks![hole]!.pair];
      let map: string | null = null;
      if (full) {
        const res = await r.dm.request("PUT", `/api/rooms/${r.roomId}/assets?kind=map`, undefined, { "content-type": "image/png" }, await solid(640, 480, "#264").png().toBuffer());
        assert.equal(res.statusCode, 200, res.body);
        const asset = res.json<{ id: string; width: number; height: number }>();
        map = asset.id;
        await ok(r.dmSocket, { t: "scene.setMap", sceneId: cellar, map: { assetId: asset.id, widthPx: asset.width, heightPx: asset.height, cellPx: 16, originPx: { x: 0, y: 0 } } } as Op);
        secrets.push(asset.id);
        const lamp = uuidv7();
        await ok(r.dmSocket, { t: "build.lights", sceneId: cellar, put: [{ id: lamp, x: 7, y: 7, bright: 20, dim: 20, on: true, walls: true }] } as Op);
        const goblins = [await create(r, cellar, { name: "Cellar goblin", x: 6, y: 6 }), await create(r, cellar, { name: "Cellar goblin", x: 7, y: 6 })];
        const stairs = uuidv7();
        await ok(r.dmSocket, { t: "floorLink.put", link: { id: stairs, pairId: uuidv7(), sceneId: r.ground, to: cellar, rect: { x: 12, y: 3, w: 2, h: 1 }, kind: "stairs" } } as Op);
        await ok(r.dmSocket, { t: "floorLink.update", linkId: stairs, patch: { hidden: true } } as Op);
        secrets.push(lamp, ...goblins, stairs, live(r.roomId).floorLinks![stairs]!.pair, "Cellar goblin");
      }
      const x = await seated(t, r, [[r.ground, "ground"], [hole, "hole"], [thorn, "thorn"]], [...secrets, "Crypt", "Attic"], "ana first", true);
      return { ...x, cellar, thorn, hole, map };
    };
    /** The floor below's map as Ana, the display and the DM fetch it. */
    const fetched = async (x: { ana: TestClient; tv: TestClient; dm: TestClient; map: string | null }) => {
      const get = (c: TestClient) => c.request("GET", `/api/assets/${x.map}/full`).then((reply) => reply.statusCode);
      return [await get(x.ana), await get(x.tv), await get(x.dm)];
    };
    const a = await make(true);
    const b = await make(false);
    await alike(a, b, "seated");
    for (const x of [a, b]) assert.equal((x.seats.ana.view.floorLinks?.[x.hole] as { to?: string } | undefined)?.to, undefined, "the hole names no floor below");
    await logPages(a, b, "seated");
    assert.deepEqual(await fetched(a), [404, 404, 200], "the floor below's map is 404 to Ana and the display");
    assert.equal(await step(a, b, (x) => ({ t: "token.move", tokenId: (x as typeof a).thorn, x: 5, y: 7 }), "Thorn walks to the rim"), "applied: ");
    const co = new Map<Compared, Socket>();
    for (const x of [a, b]) co.set(x, await coDm(x));
    for (const x of [a, b]) x.forbidden.push("Vault");
    await both(a, b, (x) => ({ t: "scene.update", sceneId: (x as typeof a).cellar, patch: { floor: { name: "Vault" } } }) as Op, "a co-DM renames the floor below", (x) => co.get(x)!);
    await reconnectBoth(t, a, b, "Ana back");
    await logPages(a, b, "after all");
    assert.deepEqual(await fetched(a), [404, 404, 200], "still 404 after all");
    for (const s of co.values()) s.close();
    close(a, b);
  });

  for (const order of ["ana first", "bree first"] as const) {
    test(`O7, the DM walks a hidden monster onto the hole, or nothing: alike from the fall on (${order})`, async () => {
      const make = async (monster: boolean) => {
        const h = await holed("O7");
        const lurker = monster ? await create(h.r, h.upper, { name: "Lurker", visibility: "dm", x: 10, y: 6 }) : null;
        const x = await seated(t, h.r, h.roles, lurker ? [lurker, '"Lurker"'] : ['"Lurker"'], order);
        return { ...x, lurker };
      };
      const a = await make(true);
      const b = await make(false);
      await alike(a, b, "seated");
      await unseen(a, b, [{ t: "token.move", tokenId: a.lurker!, x: 6, y: 6 }], "the lurker falls");
      assert.equal(live(a.roomId).tokens[a.lurker!]!.sceneId, a.ground, "it fell");
      assert.equal(Object.keys(live(a.roomId).falls ?? {}).length, 1, "with the DM's card");
      close(a, b);
    });
  }

  test("O8, a monster players see falls into a floor not reached, its contents, name and height differing: the same removal and frames, through Bree's log page and a reconnect", async () => {
    const make = async (full: boolean) => {
      const r = await newRoom(t, "O8");
      await ok(r.dmSocket, { t: "scene.update", sceneId: r.ground, patch: { name: "Tower" } });
      const name = full ? "Crypt" : "Cellar";
      const cellar = await addFloor(r, r.ground, "below", name);
      if (!full) await ok(r.dmSocket, { t: "scene.update", sceneId: cellar, patch: { floor: { height: 20 } } } as Op);
      const hole = uuidv7();
      await ok(r.dmSocket, { t: "floorLink.put", link: { id: hole, pairId: uuidv7(), sceneId: r.ground, to: cellar, rect: HOLE, kind: "opening" } } as Op);
      const ogre = await create(r, r.ground, { name: "Ogre", x: 4, y: 6 });
      const secrets = [cellar, name, live(r.roomId).floorLinks![hole]!.pair];
      if (full) secrets.push(await create(r, cellar, { name: "Cellar goblin", x: 9, y: 9 }), "Cellar goblin");
      const x = await seated(t, r, [[r.ground, "ground"], [hole, "hole"], [ogre, "ogre"]], [...secrets, "Crypt", "Cellar"]);
      return { ...x, ogre, cellar };
    };
    const a = await make(true);
    const b = await make(false);
    await alike(a, b, "seated");
    await both(a, b, (x) => ({ t: "token.move", tokenId: (x as typeof a).ogre, x: 6, y: 6 }), "the ogre falls");
    for (const x of [a, b]) {
      assert.equal(live(x.roomId).tokens[(x as typeof a).ogre]!.sceneId, (x as typeof a).cellar);
      assert.equal(x.seats.ana.view.tokens[(x as typeof a).ogre], undefined, "gone from her copy");
    }
    await both(a, b, (x) => ({ t: "token.move", tokenId: (x as typeof a).ogre, x: 10, y: 10 }), "the DM moves it on below");
    await logPages(a, b, "after the fall");
    await reconnectBoth(t, a, b, "Ana back");
    close(a, b);
  });

  test("O9, a blackout over a join: alike to a room without the floor above", async () => {
    const make = async (upper: boolean) => {
      const r = await newRoom(t, "O9");
      await ok(r.dmSocket, { t: "scene.update", sceneId: r.ground, patch: { name: "Tower", vision: { on: true, light: "dark", byClock: false } } } as Op);
      const thorn = await create(r, r.ground, { kind: "pc", name: "Thorn", disposition: "ally", ownerIds: [r.anaId], x: 6, y: 9, actor: inline("Darkvision 60 ft") });
      const secrets: string[] = ["Upper floor"];
      if (upper) {
        const up = await addFloor(r, r.ground, "above", "Upper floor");
        await ok(r.dmSocket, { t: "scene.update", sceneId: up, patch: { vision: { on: true, light: "bright", byClock: false } } } as Op);
        await ok(r.dmSocket, { t: "floor.open", sceneId: up, open: true } as Op);
        const hole = uuidv7();
        await ok(r.dmSocket, { t: "floorLink.put", link: { id: hole, pairId: uuidv7(), sceneId: up, to: r.ground, rect: HOLE, kind: "opening" } } as Op);
        secrets.push(up, hole, live(r.roomId).floorLinks![hole]!.pair);
      }
      await ok(r.dmSocket, { t: "view.blackout", blackout: true } as Op);
      // Behind the blackout no seat sees the marker, so each folds what one batch sends it.
      const x = await seated(t, r, [[r.ground, "ground"], [thorn, "thorn"]], secrets, "ana first", false, true);
      return { ...x, thorn };
    };
    const a = await make(true);
    const b = await make(false);
    await alike(a, b, "behind the blackout");
    await both(a, b, (x) => ({ t: "token.move", tokenId: (x as typeof a).thorn, x: 6, y: 8 }), "Thorn steps under the hole");
    close(a, b);
  });

  test("O11c, Thorn drags a hidden goblin over the hole, or none: Ana's walk, Undo and Redo twice answer and send alike, through a reconnect, the goblin's card kept", async () => {
    const make = async (goblin: boolean) => {
      const r = await newRoom(t, "O11c");
      await ok(r.dmSocket, { t: "scene.update", sceneId: r.ground, patch: { name: "Tower" } });
      const upper = await addFloor(r, r.ground, "above", "Upper floor");
      const hole = uuidv7();
      const below = uuidv7();
      await ok(r.dmSocket, { t: "floorLink.put", link: { id: hole, pairId: below, sceneId: upper, to: r.ground, rect: { x: 6, y: 6, w: 4, h: 4 }, kind: "opening" } } as Op);
      const thorn = await create(r, upper, { kind: "pc", name: "Thorn", disposition: "ally", ownerIds: [r.anaId], x: 3, y: 7 });
      const secrets = ['"Goblin"'];
      let gob: string | null = null;
      if (goblin) {
        gob = await create(r, upper, { name: "Goblin", visibility: "dm", x: 2, y: 7 });
        await ok(r.dmSocket, { t: "token.attach", tokenId: gob, to: thorn, kind: "drag", x: 2, y: 7, elevation: 0 } as Op);
        secrets.push(gob);
      }
      const x = await seated(t, r, [[r.ground, "ground"], [upper, "upper"], [hole, "hole"], [below, "below"], [thorn, "thorn"]], secrets);
      return { ...x, thorn, gob, upper };
    };
    const a = await make(true);
    const b = await make(false);
    await alike(a, b, "seated");
    assert.equal(await step(a, b, (x) => ({ t: "token.move", tokenId: (x as typeof a).thorn, x: 8, y: 7 }), "onto the hole"), "applied: ");
    const state = live(a.roomId);
    assert.deepEqual([state.tokens[a.thorn]!.sceneId, state.tokens[a.gob!]!.sceneId], [a.ground, a.ground], "both fell");
    const goblinCard = Object.values(state.falls ?? {}).find((c) => c.tokenId === a.gob)!;
    assert.ok(goblinCard);
    for (const [i, [op, words]] of ([[undo, "undo"], [redo, "redo"], [undo, "undo"], [redo, "redo"]] as const).entries()) {
      assert.equal(await step(a, b, op, `${words} ${i + 1}`), "applied: moving Thorn", `${words} ${i + 1}`);
      const now = live(a.roomId);
      const where = words === "undo" ? a.upper : a.ground;
      assert.deepEqual([now.tokens[a.thorn]!.sceneId, now.tokens[a.gob!]!.sceneId], [where, where], `${words} ${i + 1}: the goblin rides with Thorn`);
      assert.deepEqual(now.falls?.[goblinCard.id], goblinCard, `${words} ${i + 1}: the goblin's card kept`);
      if (i === 0) await reconnectBoth(t, a, b, "Ana back");
    }
    close(a, b);
  });

  test("O13, Wren on a hidden horse straddling the rim, walked by Bree onto the hole, or Wren alone: she falls alone, alike", async () => {
    const make = async (horse: boolean) => {
      const h = await holed("O13");
      const wren = h.roles.find(([, role]) => role === "wren")![0];
      await ok(h.r.dmSocket, { t: "token.update", tokenId: wren, patch: { sceneId: h.upper, x: 8, y: 6 } } as Op);
      const secrets = ['"Horse"'];
      let mount: string | null = null;
      if (horse) {
        mount = await create(h.r, h.upper, { name: "Horse", size: "large", visibility: "dm", x: 7, y: 6 });
        await ok(h.r.dmSocket, { t: "token.attach", tokenId: wren, to: mount, kind: "ride", x: 8, y: 6, elevation: 0 } as Op);
        secrets.push(mount);
      }
      const x = await seated(t, h.r, h.roles, secrets);
      return { ...x, wren, mount, upper: h.upper };
    };
    const a = await make(true);
    const b = await make(false);
    await alike(a, b, "seated");
    assert.equal(await step(a, b, (x) => ({ t: "token.move", tokenId: (x as typeof a).wren, x: 7, y: 6 }), "Wren onto the hole", (x) => x.seats.bree), "applied: ");
    for (const x of [a, b]) assert.equal(live(x.roomId).tokens[(x as typeof a).wren]!.sceneId, x.ground);
    assert.equal(live(a.roomId).tokens[a.mount!]!.sceneId, a.upper, "the horse stays");
    close(a, b);
  });
});
