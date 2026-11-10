import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { after, before, describe, test } from "node:test";
import { uuidv7 } from "#shared/ids.ts";
import type { RoomState, Scene, Viewer } from "#shared/model.ts";
import { ONE_FLOOR_MOVE } from "#shared/permissions.ts";
import { applyChanges, stableStringify, type ProjectedState } from "#shared/project.ts";
import { outboundEph, serverMessageSchema, type Change, type EphEvent, type Op, type ServerMessage } from "#shared/protocol.ts";
import { solid } from "../assets/testImages.ts";
import { encodeWebm, webmWithSecrets } from "../assets/video/videoTestutil.ts";
import { formatDisplayCode } from "../auth/displaySessions.ts";
import { Connection } from "./connection.ts";
import { buildSnapshot } from "./fanout.ts";
import { Socket, startEngine, type Engine, type TestClient } from "./testing.ts";

/**
 * Several floors over real sockets (docs/design/design-v1-floors.md 8 and 15,
 * lane FLR-C), the shipping gate: every frame each recipient is sent, the
 * DM, two players, a table display and a DM's view as a player, through the
 * actor and the fan-out. A floor a recipient does not hold sends nothing:
 * no record, id, name, level, token, row or line. And after every step each
 * socket's view, its snapshot with every `ev` since folded in, is exactly a
 * fresh snapshot of the committed room (the oracle of 8.1).
 */

const inline = (senses = "") => ({
  inline: { hp: { cur: 12, max: 12, temp: 0 }, life: "alive", ac: 14, speeds: { walk: 30 }, initBonus: 2, passivePerception: 12, senses, effects: [], deathSaves: { ok: 0, fail: 0 }, notes: "", dmNotes: "" },
});

/** Every frame the socket receives from now on, as the text that crossed the wire. */
function wire(socket: Socket): string[] {
  const frames: string[] = [];
  socket.ws.on("message", (data) => frames.push(data.toString()));
  return frames;
}

/** Who a seat is, as its socket's grant says, for the oracle's fresh snapshot. */
type Who = { memberId: string; role: Viewer["role"]; display?: true; previewOf?: string; sceneId?: string };

/** A socket, the view its snapshot and every `ev` since built, and every frame it was sent. */
type Seat = { name: string; socket: Socket; who: Who; view: ProjectedState; you: { sceneId: string | null }; frames: string[] };

async function seat(name: string, socket: Socket, who: Who, clientId = name): Promise<Seat> {
  const frames = wire(socket);
  const snap = await socket.snapshot(clientId, undefined, who.sceneId);
  return { name, socket, who, view: snap.state as ProjectedState, you: snap.you, frames };
}

/** Folds every `ev` the seat was sent into its view, in order, up to the one that moves the marker to `x`. */
async function catchUp(s: Seat, markerId: string, x: number): Promise<void> {
  const moved = (m: ServerMessage) => m.t === "ev" && m.changes.some((c) => c.key === `token:${markerId}` && "value" in c && (c.value as { x?: number } | null)?.x === x);
  for (;;) {
    const msg = s.socket.received.shift() ?? (await s.socket.next("ev"));
    if (msg.t === "ev") s.view = applyChanges(s.view, msg.changes as Change[]);
    if (moved(msg)) return;
  }
}

/** Folds whatever the seat holds now, after a wait long enough for one batch, for a seat the marker cannot reach (a blackout). */
async function settle(s: Seat): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 150));
  for (let msg = s.socket.received.shift(); msg; msg = s.socket.received.shift()) if (msg.t === "ev") s.view = applyChanges(s.view, msg.changes as Change[]);
}

const silent = { readyState: 1, OPEN: 1, CONNECTING: 0, send: () => undefined, close: () => undefined, terminate: () => undefined };

/**
 * The oracle (docs/design/design-v1-floors.md 8.1): each seat's view is what a
 * fresh snapshot of the committed room gives its socket's grant.
 */
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

/** Every frame that names one of `secrets`, for a recipient who must never learn them. */
function naming(s: Seat, secrets: readonly string[]): string[] {
  return s.frames.filter((frame) => secrets.some((secret) => frame.includes(secret))).map((frame) => frame.slice(0, 300));
}

type Room = {
  roomId: string;
  dm: TestClient;
  ana: TestClient;
  bree: TestClient;
  tv: TestClient;
  dmId: string;
  anaId: string;
  breeId: string;
  /** The room's first scene, Tower's Ground floor once a floor is added beside it. */
  ground: string;
  dmSocket: Socket;
  /** The key a co-DM claims the room with. */
  dmKey: string;
};

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
  const dmId = snap.you.memberId;
  const ground = view.meta.playerSceneId!;
  const tv = t.client();
  const code = await dm.post(`/api/rooms/${roomId}/display/code`);
  assert.equal((await tv.post("/api/display/redeem", { code: formatDisplayCode(code.json<{ code: string }>().code) })).statusCode, 200);
  return { roomId, dm, ana, bree, tv, dmId, anaId, breeId, ground, dmSocket, dmKey };
}

async function ok(socket: Socket, op: Op): Promise<Extract<ServerMessage, { t: "ev" }>> {
  const ev = await socket.apply(op);
  assert.deepEqual(ev.rejects ?? [], [], `${op.t} was refused`);
  return ev;
}

/** Adds a floor beside another and names it, as Floors' Add a floor and the floor's page do. */
async function addFloor(r: Room, beside: string, side: "above" | "below", name: string): Promise<string> {
  const id = uuidv7();
  await ok(r.dmSocket, { t: "scene.create", scene: { id, name: "Tower", bounds: { w: 30, h: 20 } }, floor: { beside, side } } as Op);
  await ok(r.dmSocket, { t: "scene.update", sceneId: id, patch: { floor: { name } } } as Op);
  return id;
}

async function create(r: Room, sceneId: string, fields: Record<string, unknown>): Promise<string> {
  const id = uuidv7();
  await ok(r.dmSocket, { t: "token.create", token: { id, sceneId, kind: "monster", name: "Goblin", size: "medium", x: 2, y: 2, actor: inline(), ...fields } } as Op);
  return id;
}

/** Tower's floors and the seats around it, with a marker every seat sees on `markerScene` for syncing. */
type Table = Room & {
  seats: Seat[];
  marker: string;
  /** Moves the marker and folds every seat's events up to that move, then checks the oracle. */
  sync: (when: string, seats?: readonly Seat[]) => Promise<RoomState>;
  /** Applies a DM op, then syncs. */
  apply: (op: Op, when?: string) => Promise<RoomState>;
};

async function withMarker(t: Engine, r: Room, markerScene: string): Promise<Pick<Table, "marker" | "sync" | "apply"> & { attach: (seats: Seat[]) => void }> {
  const marker = await create(r, markerScene, { name: "Marker", kind: "object", x: 15, y: 18, fogExempt: true });
  let x = 15;
  let seats: Seat[] = [];
  const sync = async (when: string, only: readonly Seat[] = seats) => {
    x = x === 15 ? 16 : 15;
    await ok(r.dmSocket, { t: "token.move", tokenId: marker, x, y: 18 });
    for (const s of only) await catchUp(s, marker, x);
    return oracle(t, r.roomId, only, when);
  };
  return {
    marker,
    sync,
    apply: async (op, when = op.t) => {
      await ok(r.dmSocket, op);
      return sync(when);
    },
    attach: (list) => {
      seats = list;
    },
  };
}

async function players(t: Engine, r: Room, order: "ana first" | "bree first", preview = true): Promise<{ ana: Seat; bree: Seat; tv: Seat; asAna?: Seat }> {
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
  const socket = await Socket.open(`${t.url}/ws?room=${r.roomId}&as=${r.anaId}`, { origin: t.config.publicOrigin, cookie: `rvtt=${r.dm.token}`, "cf-connecting-ip": r.dm.ip, "user-agent": "floors-wire-itest" });
  const asAna = await seat("the DM's view as Ana", socket, { memberId: r.dmId, role: "dm", previewOf: r.anaId }, "dm-preview");
  return { ana, bree, tv, asAna };
}

describe("several floors over the wire (docs/design/design-v1-floors.md 8, the shipping gate)", () => {
  let t: Engine;
  before(async () => {
    t = await startEngine({ env: { ANIMATED_MAPS: "1" }, rooms: { idleUnloadMs: 60_000 } });
  });
  after(() => t.close());

  for (const look of ["no fog", "whole party", "per player"] as const) {
    for (const order of ["ana first", "bree first"] as const) {
      test(`Ana's hidden creature upstairs: Ana holds Upper, Bree and the TV get nothing of it (${look}, ${order})`, async () => {
        const r = await newRoom(t, "Hidden upstairs");
        await ok(r.dmSocket, { t: "scene.update", sceneId: r.ground, patch: { name: "Tower" } });
        const upper = await addFloor(r, r.ground, "above", "Upper floor");
        const vision = look === "no fog" ? null : { on: true, light: "dark" as const, ...(look === "per player" ? { perPlayer: true as const } : {}) };
        for (const sceneId of [r.ground, upper]) if (vision) await ok(r.dmSocket, { t: "scene.update", sceneId, patch: { fogEnabled: true, vision } } as Op);
        await create(r, r.ground, { kind: "pc", name: "Thorn", disposition: "ally", ownerIds: [r.anaId], x: 4, y: 4, actor: inline("Darkvision 60 ft.") });
        await create(r, r.ground, { kind: "pc", name: "Wren", disposition: "ally", ownerIds: [r.breeId], x: 6, y: 4, actor: inline("Darkvision 60 ft.") });
        const scout = await create(r, upper, { kind: "pc", name: "Shade", disposition: "ally", ownerIds: [r.anaId], visibility: "dm", x: 5, y: 5, actor: inline("Darkvision 60 ft.") });
        const m = await withMarker(t, r, r.ground);
        const s = await players(t, r, order);
        const all = [s.ana, s.bree, s.tv, s.asAna!];
        m.attach(all);
        await m.sync("seated");

        assert.ok(upper in s.ana.view.scenes, "Ana holds Upper, where her own creature stands");
        assert.ok(scout in s.ana.view.tokens);
        assert.equal(stableStringify(s.asAna!.view.scenes), stableStringify(s.ana.view.scenes), "the DM's view as Ana holds what Ana holds");
        assert.deepEqual(s.ana.view.scenes[upper]?.floor, { level: 1, name: "Upper floor", unseen: true }, "a player's floor is its level and name alone, and no player sees one held through a hidden creature");
        // Upper's own content, set up while the players watch.
        const gargoyle = await create(r, upper, { name: "Gargoyle", x: 6, y: 5 });
        await m.apply({ t: "build.label", sceneId: upper, labelId: uuidv7(), label: { x: 7, y: 6, text: "Belfry", size: 1 } } as Op, "a label upstairs");
        await m.apply({ t: "token.move", tokenId: gargoyle, x: 7, y: 5 }, "a move upstairs");
        await m.apply({ t: "actor.hp", target: { tokenId: gargoyle }, change: { kind: "damage", amount: 3 } } as Op, "a line upstairs");
        await m.apply({ t: "scene.update", sceneId: upper, patch: { weather: { kind: "rain", heavy: true } } } as Op, "rain upstairs");
        for (const other of [s.bree, s.tv]) {
          assert.deepEqual(naming(other, [upper, scout, gargoyle, "Upper floor", "Belfry", "Gargoyle", "Shade"]), [], `${other.name} gets nothing of Upper`);
          assert.equal(other.view.scenes[r.ground]?.floor, undefined, `${other.name} holds one floor, so its record carries no floor`);
        }
        assert.deepEqual(naming(s.ana, [`"of":"${r.ground}"`, '"height":']), [], "no player learns a floor's main floor or height");
        assert.deepEqual(naming(s.bree, [`"of":"${r.ground}"`, '"height":', '"openFloors"', "opened:"]), []);

        // The log page Bree asks for holds no line of Upper.
        const page = await r.bree.get(`/api/rooms/${r.roomId}/log?limit=100`);
        assert.equal(page.statusCode, 200);
        assert.ok(!page.body.includes("Gargoyle") && !page.body.includes(gargoyle), "Bree's log page");
        for (const x of all) x.socket.close();
      });
    }
  }

  test("players started straight on Upper before Ground is ever held: their snapshot names Upper, and no frame carries Ground's id, name or main floor, through a reconnect (FLR32-OPUS-14)", async () => {
    const r = await newRoom(t, "Straight up");
    const ground = uuidv7();
    // Tower is built while the players are on another scene, so Ground is never their start floor.
    await ok(r.dmSocket, { t: "scene.create", scene: { id: ground, name: "Tower", bounds: { w: 30, h: 20 } } });
    const upper = await addFloor(r, ground, "above", "Upper floor");
    const lurker = await create(r, ground, { name: "Lurker", x: 3, y: 3 });
    await ok(r.dmSocket, { t: "build.label", sceneId: ground, labelId: uuidv7(), label: { x: 2, y: 2, text: "Cellar door", size: 1 } } as Op);
    await ok(r.dmSocket, { t: "room.setPlayerScene", sceneId: upper });
    await create(r, upper, { kind: "pc", name: "Thorn", disposition: "ally", ownerIds: [r.anaId], x: 4, y: 4 });
    const m = await withMarker(t, r, upper);
    const s = await players(t, r, "ana first");
    const all = [s.ana, s.bree, s.tv, s.asAna!];
    m.attach(all);
    await m.sync("seated on Upper");
    for (const x of [s.ana, s.bree, s.tv]) assert.equal(x.you.sceneId, upper, `${x.name}'s snapshot names Upper as sent, never a main floor`);
    // The DM works on Ground meanwhile.
    await m.apply({ t: "token.move", tokenId: lurker, x: 5, y: 5 }, "a move on Ground");
    await m.apply({ t: "scene.update", sceneId: ground, patch: { background: "#102030" } } as Op, "Ground's settings");
    // A reconnect, and a second one on the same client, each a fresh snapshot.
    s.ana.socket.close();
    const again = await seat("Ana again", await t.connect(r.roomId, r.ana), { memberId: r.anaId, role: "player" });
    assert.equal(again.you.sceneId, upper);
    m.attach([again, s.bree, s.tv, s.asAna!]);
    await m.sync("after Ana reconnects");
    // Every floor's record name is the scene's, so "Tower" is expected: Ground's own name and id never are.
    for (const x of [s.ana, again, s.bree, s.tv, s.asAna!]) {
      assert.deepEqual(naming(x, [ground, "Ground floor", lurker, "Cellar door"]), [], `${x.name} never learns Ground's id, name or contents`);
    }
    for (const x of [again, s.bree, s.tv, s.asAna!]) x.socket.close();
  });

  test("creating, then deleting, Ana's only creature on Attic: Attic arrives for her, then every key of it goes", async () => {
    const r = await newRoom(t, "Loft");
    await ok(r.dmSocket, { t: "scene.update", sceneId: r.ground, patch: { name: "Tower" } });
    const attic = await addFloor(r, r.ground, "above", "Attic");
    await ok(r.dmSocket, { t: "build.label", sceneId: attic, labelId: uuidv7(), label: { x: 2, y: 2, text: "Old trunk", size: 1 } } as Op);
    await create(r, attic, { name: "Bat", x: 3, y: 3 });
    const m = await withMarker(t, r, r.ground);
    const s = await players(t, r, "bree first");
    const all = [s.ana, s.bree, s.tv, s.asAna!];
    m.attach(all);
    await m.sync("seated");
    assert.ok(!(attic in s.ana.view.scenes));
    const owl = await create(r, attic, { kind: "pc", name: "Owl", ownerIds: [r.anaId], visibility: "dm", x: 5, y: 5 });
    await m.sync("Ana's creature on Attic");
    assert.ok(attic in s.ana.view.scenes, "Attic arrives with Ana's creature");
    assert.ok(Object.values(s.ana.view.labels).some((l) => l.text === "Old trunk"), "with what stands on it");
    // A ruler the DM shows on Attic reaches Ana alone, and ends for her when Attic goes, though no batch re-projects everything.
    r.dmSocket.send({ t: "eph", sceneId: attic, e: { k: "ruler", id: "attic-ruler", shared: true, points: [{ x: 1.5, y: 1.5 }, { x: 4.5, y: 1.5 }] } });
    await m.sync("a ruler on Attic");
    const rulers = (x: Seat) => x.frames.filter((f) => f.includes("attic-ruler")).map((f) => (JSON.parse(f) as { e: EphEvent }).e.k);
    assert.deepEqual(rulers(s.ana), ["ruler"]);
    await m.apply({ t: "token.delete", tokenId: owl } as Op, "the creature deleted");
    assert.deepEqual(rulers(s.ana), ["ruler", "rulerEnd"], "the ruler ends for Ana with the floor");
    for (const x of [s.bree, s.tv]) assert.deepEqual(rulers(x), [], x.name);
    assert.ok(!(attic in s.ana.view.scenes), "and every key of Attic goes with it");
    assert.ok(!stableStringify(s.ana.view).includes(attic));
    for (const x of [s.bree, s.tv]) assert.deepEqual(naming(x, [attic, "Attic", "Old trunk", "Bat"]), [], x.name);
    for (const x of all) x.socket.close();
  });

  test("Ana asks for saves upstairs with her hidden creature, which the DM brings down and gives to Bree: no frame or snapshot of Bree's names Upper (FLRBUILD-PRIV-01)", async () => {
    const r = await newRoom(t, "Handed down");
    await ok(r.dmSocket, { t: "scene.update", sceneId: r.ground, patch: { name: "Tower" } });
    const upper = await addFloor(r, r.ground, "above", "Upper floor");
    await create(r, r.ground, { kind: "pc", name: "Wren", disposition: "ally", ownerIds: [r.breeId], x: 6, y: 4 });
    const shade = await create(r, upper, { kind: "pc", name: "Shade", disposition: "ally", ownerIds: [r.anaId], visibility: "dm", x: 5, y: 5 });
    const m = await withMarker(t, r, r.ground);
    const s = await players(t, r, "ana first", false);
    // Ana's own socket sends the ask and reads its answer, so her view is not folded here, and the oracle checks the others.
    m.attach([s.bree, s.tv]);
    await m.sync("seated");
    const asked = await ok(s.ana.socket, { t: "cast.ask", cast: { id: uuidv7(), caster: shade, sceneId: upper, spell: "Fireball", targets: [shade] } } as Op);
    assert.ok(JSON.stringify(asked.changes).includes(upper), "Ana's ask names Upper, which she holds through Shade");
    await m.sync("Ana asked upstairs");
    await m.apply({ t: "token.update", tokenId: shade, patch: { sceneId: r.ground, ownerIds: [r.breeId] } } as Op, "Shade brought down and given to Bree");
    assert.ok(Object.values(s.bree.view.tokens).some((x) => x.id === shade), "Bree holds Shade now");
    const again = await seat("Bree again", await t.connect(r.roomId, r.bree), { memberId: r.breeId, role: "player" });
    for (const x of [s.bree, again, s.tv]) assert.deepEqual(naming(x, [upper, "Upper floor"]), [], `${x.name} never learns Upper's id or name`);
    for (const x of [s.ana, s.bree, again, s.tv]) x.socket.close();
  });

  test("Hide, then Show, Upper with a fight, its rows and its lines on it: they leave and come back with the floor", async () => {
    const r = await newRoom(t, "Show and hide");
    await ok(r.dmSocket, { t: "scene.update", sceneId: r.ground, patch: { name: "Tower" } });
    // Every row shows from the start, so only its floor decides who gets it.
    await ok(r.dmSocket, { t: "room.update", settings: { playersSeeOrder: "all" } } as Op);
    const upper = await addFloor(r, r.ground, "above", "Upper floor");
    const thorn = await create(r, r.ground, { kind: "pc", name: "Thorn", disposition: "ally", ownerIds: [r.anaId], x: 4, y: 4 });
    const gargoyle = await create(r, upper, { name: "Gargoyle", x: 6, y: 5 });
    const m = await withMarker(t, r, r.ground);
    const s = await players(t, r, "ana first");
    const all = [s.ana, s.bree, s.tv, s.asAna!];
    m.attach(all);
    await m.sync("seated");
    for (const x of all) assert.ok(!(upper in x.view.scenes), `${x.name}: Upper is not reached`);
    await m.apply({ t: "floor.open", sceneId: upper, open: true } as Op, "Show Upper");
    // The fight starts across both floors while players see both, so every row is seen from the start.
    await m.apply({ t: "encounter.start", entries: [{ id: uuidv7(), tokenId: thorn, value: 12 }, { id: uuidv7(), tokenId: gargoyle, value: 15 }] } as Op, "a fight across floors");
    await m.apply({ t: "actor.hp", target: { tokenId: gargoyle }, change: { kind: "damage", amount: 3 } } as Op, "a line upstairs");
    const rowsOf = (v: ProjectedState) => (v.encounter?.entries ?? []).map((e) => e.tokenId).sort();
    const gargoyleLines = (v: ProjectedState) => v.log.filter((l) => JSON.stringify(l).includes(gargoyle)).length;
    const shown = (when: string) => {
      for (const x of all) {
        assert.ok(upper in x.view.scenes && gargoyle in x.view.tokens, `${when}: ${x.name} holds Upper and its Gargoyle`);
        assert.deepEqual(rowsOf(x.view), [gargoyle, thorn].sort(), `${when}: ${x.name} gets the Gargoyle's row`);
        // A display reads no member's lines, so only the players' sockets carry it.
        if (!x.who.display) assert.ok(gargoyleLines(x.view) > 0, `${when}: ${x.name} gets the line`);
      }
    };
    shown("shown");
    await m.apply({ t: "floor.open", sceneId: upper, open: false } as Op, "Hide Upper");
    for (const x of all) {
      assert.ok(!(upper in x.view.scenes), `${x.name} lets Upper go`);
      assert.ok(!(gargoyle in x.view.tokens));
      assert.deepEqual(rowsOf(x.view), [thorn], `${x.name}'s row of the Gargoyle goes with it`);
      assert.ok(!stableStringify(x.view).includes(gargoyle), `${x.name}: no line or row names it`);
    }
    await m.apply({ t: "floor.open", sceneId: upper, open: true } as Op, "Show Upper again");
    shown("shown again");
    for (const x of all) x.socket.close();
  });

  test("players on Ground hold no floor below, between or above them that is not reached, and their levels never show a gap", async () => {
    const r = await newRoom(t, "Gaps");
    await ok(r.dmSocket, { t: "scene.update", sceneId: r.ground, patch: { name: "Tower" } });
    const cellar = await addFloor(r, r.ground, "below", "Cellar");
    const upper = await addFloor(r, r.ground, "above", "Upper floor");
    const attic = await addFloor(r, upper, "above", "Attic");
    await create(r, r.ground, { kind: "pc", name: "Thorn", ownerIds: [r.anaId], x: 4, y: 4 });
    // Ana's hidden scout on Attic gives her Attic alone, with Upper between unreached.
    await create(r, attic, { kind: "pc", name: "Shade", ownerIds: [r.anaId], visibility: "dm", x: 4, y: 4 });
    const m = await withMarker(t, r, r.ground);
    const s = await players(t, r, "ana first");
    const all = [s.ana, s.bree, s.tv, s.asAna!];
    m.attach(all);
    await m.sync("seated");
    assert.deepEqual(s.ana.view.scenes[r.ground]?.floor, { level: 0, name: "Ground floor" });
    assert.deepEqual(s.ana.view.scenes[attic]?.floor, { level: 1, name: "Attic", unseen: true }, "levels renumbered among the floors held");
    for (const x of all) assert.deepEqual(naming(x, [cellar, upper, "Cellar", "Upper floor"]), [], `${x.name} gets nothing of Cellar or Upper`);
    // A ping on Cellar reaches only the DM, who holds every floor of the scene.
    r.dmSocket.send({ t: "eph", sceneId: cellar, e: { k: "ping", x: 2, y: 2 } });
    await m.sync("a ping on Cellar");
    for (const x of all) assert.deepEqual(naming(x, [cellar]), [], x.name);
    for (const x of all) x.socket.close();
  });

  test("the DM moves Thorn to Upper: Upper opens to every player, the undo leaves it reached, and each step's views are fresh snapshots", async () => {
    const r = await newRoom(t, "Move to floor");
    await ok(r.dmSocket, { t: "scene.update", sceneId: r.ground, patch: { name: "Tower" } });
    const upper = await addFloor(r, r.ground, "above", "Upper floor");
    const thorn = await create(r, r.ground, { kind: "pc", name: "Thorn", ownerIds: [r.anaId], x: 4, y: 4 });
    await create(r, upper, { name: "Gargoyle", x: 6, y: 5 });
    const m = await withMarker(t, r, r.ground);
    const s = await players(t, r, "bree first");
    const all = [s.ana, s.bree, s.tv, s.asAna!];
    m.attach(all);
    await m.sync("seated");
    for (const x of all) assert.ok(!(upper in x.view.scenes), x.name);
    await m.apply({ t: "token.update", tokenId: thorn, patch: { sceneId: upper } } as Op, "Move to floor");
    for (const x of all) assert.ok(upper in x.view.scenes, `${x.name} holds Upper once Thorn stands there`);
    await ok(r.dmSocket, { t: "undo", head: (await r.dmSocket.historyHead("play", "undo"))! } as Op);
    await m.sync("the move undone");
    for (const x of all) assert.ok(upper in x.view.scenes, `${x.name}: Upper stays reached after the undo, its mark outside undo`);
    for (const x of all) x.socket.close();
  });

  test("sight on a floor beside the start floor follows its party member's walk there, for every player who holds it", async () => {
    const r = await newRoom(t, "Sight upstairs");
    await ok(r.dmSocket, { t: "scene.update", sceneId: r.ground, patch: { name: "Tower", fogEnabled: true, vision: { on: true, light: "dark" } } } as Op);
    const upper = await addFloor(r, r.ground, "above", "Upper floor");
    await create(r, r.ground, { kind: "pc", name: "Thorn", ownerIds: [r.anaId], x: 4, y: 4, actor: inline("Darkvision 30 ft.") });
    const wren = await create(r, upper, { kind: "pc", name: "Wren", ownerIds: [r.breeId], x: 3, y: 3, actor: inline("Darkvision 30 ft.") });
    const m = await withMarker(t, r, r.ground);
    const s = await players(t, r, "ana first");
    const all = [s.ana, s.bree, s.tv, s.asAna!];
    m.attach(all);
    await m.sync("seated");
    const upperSight = (v: ProjectedState) => Object.keys(v.sight ?? {}).filter((k) => k.startsWith(`${upper}:`)).length;
    for (const x of all) assert.ok(upperSight(x.view) > 0, `${x.name} holds Upper's sight, Wren's floor`);
    // Each walk changes only Wren's token and the sight it lends: the sight's tiles reach every holder of Upper.
    for (const [i, x] of [20, 21, 28].entries()) await m.apply({ t: "token.move", tokenId: wren, x, y: 12 }, `Wren's walk ${i + 1}`);
    for (const x of all) x.socket.close();
  });

  test("a trap on a floor players have not reached, or under a hidden party member, never goes off by itself, and one on a floor they see does", async () => {
    const r = await newRoom(t, "Traps");
    await ok(r.dmSocket, { t: "scene.update", sceneId: r.ground, patch: { name: "Tower" } });
    const upper = await addFloor(r, r.ground, "above", "Upper floor");
    const rig = { on: ["enter"], who: "any", floor: true, resets: "never", stops: false, foundOnSpring: true, hits: "trigger", actions: [], find: [], notice: false };
    const plate = async (sceneId: string, y: number) => {
      const id = `plate-${uuidv7()}`;
      await ok(r.dmSocket, { t: "trap.create", trap: { id, sceneId, name: "Plate", zone: { cells: [{ x: 5, y, w: 1, h: 1 }] }, rig } } as Op);
      return id;
    };
    const below = await plate(r.ground, 5);
    const above = await plate(upper, 5);
    const underShade = await plate(upper, 8);
    const goblin = await create(r, r.ground, { name: "Goblin", x: 3, y: 5 });
    const gargoyle = await create(r, upper, { name: "Gargoyle", x: 3, y: 5 });
    const shade = await create(r, upper, { kind: "pc", name: "Shade", ownerIds: [r.anaId], visibility: "dm", x: 3, y: 8 });
    const m = await withMarker(t, r, r.ground);
    const s = await players(t, r, "ana first", false);
    const all = [s.ana, s.bree, s.tv];
    m.attach(all);
    await m.sync("seated");
    const stateOf = (id: string) => t.manager.get(r.roomId)!.committed.state.traps[id]?.state;
    await m.apply({ t: "token.move", tokenId: goblin, x: 7, y: 5 }, "the goblin over Ground's plate");
    assert.equal(stateOf(below), "sprung", "the plate on Ground, the start floor, goes off");
    await m.apply({ t: "token.move", tokenId: gargoyle, x: 7, y: 5 }, "the gargoyle over Upper's plate");
    assert.equal(stateOf(above), "armed", "the plate on Upper, which players have not reached, does not");
    await m.apply({ t: "token.move", tokenId: shade, x: 7, y: 8 }, "Ana's hidden creature over a plate");
    assert.equal(stateOf(underShade), "armed", "nor does Ana's hidden creature open Upper or set off its plate");
    for (const x of [s.bree, s.tv]) assert.deepEqual(naming(x, [above, underShade, upper]), [], `${x.name} gets nothing of Upper's plates`);
    await m.apply({ t: "floor.open", sceneId: upper, open: true } as Op, "Show Upper");
    await m.apply({ t: "token.move", tokenId: gargoyle, x: 3, y: 5 }, "the gargoyle back over the plate");
    assert.equal(stateOf(above), "sprung", "once Upper is shown, its plate goes off");
    for (const x of all) x.socket.close();
  });

  test("a hand-made group move of Ana's creatures on Ground and Upper, both reached, is refused whole, so neither plate is walked past, and the walks one at a time set off both (FLRBUILD-ASTRA-03)", async () => {
    const r = await newRoom(t, "Two plates");
    await ok(r.dmSocket, { t: "scene.update", sceneId: r.ground, patch: { name: "Tower" } });
    const upper = await addFloor(r, r.ground, "above", "Upper floor");
    const rig = { on: ["enter"], who: "any", floor: true, resets: "never", stops: false, foundOnSpring: true, hits: "trigger", actions: [], find: [], notice: false };
    const plate = async (sceneId: string) => {
      const id = `plate-${uuidv7()}`;
      await ok(r.dmSocket, { t: "trap.create", trap: { id, sceneId, name: "Plate", zone: { cells: [{ x: 5, y: 5, w: 1, h: 1 }] }, rig } } as Op);
      return id;
    };
    const below = await plate(r.ground);
    const above = await plate(upper);
    const thorn = await create(r, r.ground, { kind: "pc", name: "Thorn", disposition: "ally", ownerIds: [r.anaId], x: 3, y: 5 });
    const owl = await create(r, upper, { kind: "npc", name: "Owl", disposition: "ally", ownerIds: [r.anaId], x: 3, y: 5 });
    const ana = await t.connect(r.roomId, r.ana);
    await ana.snapshot("ana-plates");
    const stateOf = (id: string) => t.manager.get(r.roomId)!.committed.state.traps[id]?.state;
    const across = await ana.apply({ t: "token.moveMany", moves: [{ tokenId: thorn, x: 7, y: 5 }, { tokenId: owl, x: 7, y: 5 }] } as Op);
    assert.deepEqual(across.rejects?.map((x) => x.message), [ONE_FLOOR_MOVE], "refused whole");
    assert.deepEqual([stateOf(below), stateOf(above)], ["armed", "armed"]);
    const tokens = t.manager.get(r.roomId)!.committed.state.tokens;
    assert.deepEqual([tokens[thorn]?.x, tokens[owl]?.x], [3, 3], "neither moved");
    await ok(ana, { t: "token.move", tokenId: thorn, x: 7, y: 5 } as Op);
    await ok(ana, { t: "token.move", tokenId: owl, x: 7, y: 5 } as Op);
    assert.deepEqual([stateOf(below), stateOf(above)], ["sprung", "sprung"], "each floor's walk sets off its own plate");
    ana.close();
  });

  test("Ana holds Roof with rain and a phase video, Bree Ground alone: Bree's copy has no Roof, and the asset route answers 404 for Roof's video and still to her and the TV", async () => {
    const r = await newRoom(t, "Roof assets");
    await ok(r.dmSocket, { t: "scene.update", sceneId: r.ground, patch: { name: "Tower" } });
    const roof = await addFloor(r, r.ground, "above", "Roof");
    const put = async (body: Buffer, kind: string, type: string) => {
      const res = await r.dm.request("PUT", `/api/rooms/${r.roomId}/assets?kind=${kind}`, undefined, { "content-type": type }, body);
      assert.equal(res.statusCode, 200, res.body);
      return res.json<{ id: string }>().id;
    };
    const still = await put(await solid(640, 360, "#264").png().toBuffer(), "map", "image/png");
    const video = await put(encodeWebm(webmWithSecrets()), "video", "video/webm");
    const groundStill = await put(await solid(640, 360, "#642").png().toBuffer(), "map", "image/png");
    const map = (assetId: string) => ({ assetId, widthPx: 640, heightPx: 360, cellPx: 40, originPx: { x: 0, y: 0 } });
    await ok(r.dmSocket, { t: "scene.setMap", sceneId: roof, map: { ...map(still), video: { assetId: video, widthPx: 640, heightPx: 360, container: "webm", video: "vp8", fps: 1, durationMs: 1_000, kbps: 1 } } } as Op);
    await ok(r.dmSocket, { t: "scene.setMap", sceneId: r.ground, map: map(groundStill) } as Op);
    await ok(r.dmSocket, { t: "scene.update", sceneId: roof, patch: { weather: { kind: "rain", heavy: true, wind: "strong", toward: 90 } } } as Op);
    await create(r, roof, { kind: "pc", name: "Shade", ownerIds: [r.anaId], visibility: "dm", x: 4, y: 4 });
    const m = await withMarker(t, r, r.ground);
    const s = await players(t, r, "ana first", false);
    const all = [s.ana, s.bree, s.tv];
    m.attach(all);
    await m.sync("seated");
    assert.ok(roof in s.ana.view.scenes && s.ana.view.scenes[roof]?.weather !== undefined, "Ana gets Roof with its rain");
    assert.equal(s.ana.view.scenes[roof]?.map?.video?.assetId, video);
    for (const x of [s.bree, s.tv]) assert.deepEqual(naming(x, [roof, still, video, '"rain"']), [], x.name);
    const get = (c: TestClient, id: string) => c.request("GET", `/api/assets/${id}/full`).then((res) => res.statusCode);
    assert.equal(await get(r.ana, still), 200);
    assert.equal(await get(r.ana, video), 200);
    assert.equal(await get(r.bree, still), 404);
    assert.equal(await get(r.bree, video), 404);
    assert.equal(await get(r.tv, still), 404, "the display's assets hold no floor players have not reached");
    assert.equal(await get(r.tv, video), 404);
    assert.equal(await get(r.bree, groundStill), 200, "Ground's still is Bree's");
    for (const x of all) x.socket.close();
  });

  test("a drag frame from Ground arriving after its token moved to Roof reaches nobody, and the preview it left ends", async () => {
    const r = await newRoom(t, "Late frame");
    await ok(r.dmSocket, { t: "scene.update", sceneId: r.ground, patch: { name: "Tower" } });
    const roof = await addFloor(r, r.ground, "above", "Roof");
    await create(r, r.ground, { kind: "pc", name: "Thorn", ownerIds: [r.anaId], x: 4, y: 4 });
    // Ana holds Roof too, where her scout stands, so a frame of Roof's would reach her.
    await create(r, roof, { kind: "pc", name: "Shade", ownerIds: [r.anaId], visibility: "dm", x: 4, y: 4 });
    const gob = await create(r, r.ground, { name: "Goblin", x: 8, y: 8 });
    const m = await withMarker(t, r, r.ground);
    const s = await players(t, r, "ana first", false);
    const all = [s.ana, s.bree, s.tv];
    m.attach(all);
    await m.sync("seated");
    const ephs = (x: Seat) => x.frames.filter((f) => f.includes('"t":"eph"')).map((f) => JSON.parse(f) as { sceneId: string; e: EphEvent });
    r.dmSocket.send({ t: "eph", sceneId: r.ground, e: { k: "dragStart", tokenId: gob, x: 8, y: 8 } });
    await m.sync("a drag on Ground");
    for (const x of all) assert.deepEqual(ephs(x).map((e) => [e.sceneId, e.e.k]), [[r.ground, "dragStart"]], x.name);
    await m.apply({ t: "token.update", tokenId: gob, patch: { sceneId: roof } } as Op, "the goblin moved to Roof");
    r.dmSocket.send({ t: "eph", sceneId: r.ground, e: { k: "dragMove", tokenId: gob, x: 9, y: 8 } });
    await m.sync("a late frame from Ground");
    for (const x of all) {
      const got = ephs(x).map((e) => [e.sceneId, e.e.k]);
      assert.deepEqual(got, [[r.ground, "dragStart"], [r.ground, "dragCancel"]], `${x.name}: the shown preview ends, and the late frame goes nowhere`);
    }
    for (const x of all) x.socket.close();
  });

  test("behind a blackout a player's snapshot names no floor, and an update after it keeps them there (FLR32-ASTRA-07)", async () => {
    const r = await newRoom(t, "Blackout");
    await ok(r.dmSocket, { t: "scene.update", sceneId: r.ground, patch: { name: "Tower" } });
    const upper = await addFloor(r, r.ground, "above", "Upper floor");
    await create(r, upper, { kind: "pc", name: "Thorn", ownerIds: [r.anaId], x: 4, y: 4 });
    await ok(r.dmSocket, { t: "view.blackout", blackout: true } as Op);
    const s = await players(t, r, "ana first", false);
    const all = [s.ana, s.bree, s.tv];
    for (const x of all) {
      assert.equal(x.you.sceneId, null, `${x.name}'s snapshot behind a blackout names no floor`);
      assert.deepEqual(Object.keys(x.view.scenes), [], `${x.name} holds no floor at all`);
    }
    // An update that has nothing to do with the floors: the anchor stays null, `blackout ? null : playerSceneId`.
    await ok(r.dmSocket, { t: "room.update", name: "Blackout, renamed" } as Op);
    for (const x of all) {
      await settle(x);
      assert.equal(x.view.meta.view.blackout, true, `${x.name}'s copy still reads the blackout, so its anchor stays null`);
      assert.deepEqual(Object.keys(x.view.scenes), []);
    }
    await oracle(t, r.roomId, all, "behind the blackout");
    for (const x of all) assert.deepEqual(naming(x, [upper, "Upper floor"]), [], x.name);
    for (const x of all) x.socket.close();
  });

  test("a DM's socket on any floor is the scene's: its hello names the main floor, and it holds every floor", async () => {
    const r = await newRoom(t, "DM floors");
    await ok(r.dmSocket, { t: "scene.update", sceneId: r.ground, patch: { name: "Tower" } });
    const upper = await addFloor(r, r.ground, "above", "Upper floor");
    const gargoyle = await create(r, upper, { name: "Gargoyle", x: 6, y: 5 });
    const second = await seat("a DM asking for Upper", await t.connect(r.roomId, r.dm), { memberId: r.dmId, role: "dm", sceneId: upper }, "dm-upper");
    assert.equal(second.you.sceneId, r.ground, "named by its main floor");
    assert.ok(gargoyle in second.view.tokens, "holding every floor's tokens");
    assert.ok(upper in second.view.scenes && r.ground in second.view.scenes);
    second.who.sceneId = r.ground;
    await oracle(t, r.roomId, [second], "a DM on Upper");
    // A resync asked for Upper answers the same way: the scene, by its main floor.
    second.socket.send({ t: "scene", sceneId: upper });
    await second.socket.next("resync");
    const again = await second.socket.snapshot("dm-upper", undefined, upper);
    assert.equal(again.you.sceneId, r.ground);
    second.socket.close();
  });

  test("a scene with one floor is as before: its record carries no floor, and the room's frames name none", async () => {
    const r = await newRoom(t, "One floor");
    await create(r, r.ground, { kind: "pc", name: "Thorn", ownerIds: [r.anaId], x: 4, y: 4 });
    const m = await withMarker(t, r, r.ground);
    const s = await players(t, r, "ana first");
    const all = [s.ana, s.bree, s.tv, s.asAna!];
    m.attach(all);
    await m.sync("seated");
    for (const x of all) {
      assert.equal((x.view.scenes[r.ground] as Scene | undefined)?.floor, undefined);
      assert.deepEqual(naming(x, ['"floor":{', '"openFloors"', "opened:"]), [], x.name);
    }
    for (const x of all) x.socket.close();
  });
});

/*
 * Two rooms compared over the wire (FL2-SOL-04): each seat of one is sent
 * the same frames, whole, as the same seat of the other, and holds the same
 * room, once both are normalized, and no frame or view carries a forbidden
 * id or name, read raw. The phase 2 climb twins and the phase 3 twins
 * (docs/design/design-v1-floors.md phase 3, 6) both read them.
 */

/** A room of a twin pair: its seats, the ids its players may hold by role, what they must never receive, and its marker's sync. */
type Compared = Room &
  Pick<Table, "sync" | "marker"> & {
    attach: (seats: Seat[]) => void;
    seats: { ana: Seat; bree: Seat; tv: Seat };
    /** The ids the test made for things players may hold, each with the role it reads by in both rooms. */
    roles: readonly (readonly [string, string])[];
    forbidden: string[];
    /** Where Ana's frames since she last connected begin. */
    anaFrom: number;
  };

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g;
const TIME = /\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d+)?Z/g;

/**
 * The names a seat's ids read by, so two rooms compare (FL2-SOL-04). An
 * id the test made for something players may hold reads as its role
 * ("thorn", "upper"). Any other id the seat was sent is the server's own
 * (a history step, a history epoch) and reads "id1", "id2" and on by
 * where the seat's frames first carry it, so two of them never read
 * alike, one swapped for another shows, and two records keyed by them
 * stay two. Such a name is allowed only where the server's ids belong
 * (GENERATED_AT, checked in `normal`). A hidden thing's id has no role
 * here: `leaks` refuses it raw, before any name is given.
 */
function aliases(x: Compared, s: Seat): Names {
  const names = new Map<string, string>([[x.roomId, "room"], [x.dmId, "dm"], [x.anaId, "ana"], [x.breeId, "bree"], ...x.roles]);
  let made = 0;
  const meet = (text: string) => {
    for (const id of text.match(UUID) ?? []) if (!names.has(id)) names.set(id, `id${++made}`);
  };
  for (const frame of s.frames) meet(frame);
  // What only the view holds, if anything, in the order its own text gives.
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

/** A seat's names for its ids (`aliases`), and whether a text carries an id that got a generated name. */
type Names = { text: (raw: string) => string; generated: (raw: string) => boolean };

/**
 * The only places the server's own ids may stand: a history line's epoch
 * and the id of the step at the head of each stack. Anywhere else an id
 * the test did not make is refused, so a generated name never covers one.
 */
const GENERATED_AT = [/^epoch$/, /^(play|setup)\.(undo|redo)\.head\.id$/];

/**
 * Something a seat holds or was sent, made comparable between two rooms
 * (FL2-SOL-04): ids by `aliases`, each time as "time", on values and on
 * keys, which are then sorted again, as are who is online and a frame's
 * changes, which the server sends in the order of their ids. One
 * accepted channel is left out by name, the room's count of ops, which
 * a hidden op moves too: every `seq`, a path's `turn`, which is that
 * count where the turn began, the log line ids made from it ("13:0"
 * reads "n:0", and its key "log:13:0" reads "log:n:0"), and an `ev` that
 * carries nothing else. Two keys never
 * fold into one, which would drop a record unseen, and a generated name
 * stands only where GENERATED_AT allows.
 */
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

/** A seat's frames, every connection's, normalized, without the room's op count (`normal`). */
function sent(names: Names, s: Seat): unknown[] {
  const out: unknown[] = [];
  for (const frame of s.frames) {
    const m = JSON.parse(frame) as Record<string, unknown>;
    if (m.t === "ev" && Object.keys(m).every((k) => k === "t" || k === "seq" || k === "changes") && (m.changes as unknown[]).length === 0) continue;
    out.push(normal(names, m));
  }
  return out;
}

/** No frame a seat was ever sent, nor its view, carries a forbidden id or name, read raw, before any normalizing could hide it. */
function leaks(x: Compared, when: string): void {
  for (const s of [x.seats.ana, x.seats.bree, x.seats.tv]) {
    assert.deepEqual(naming(s, x.forbidden), [], `${when}: ${s.name} was sent something hidden`);
    const view = JSON.stringify(s.view);
    assert.deepEqual(x.forbidden.filter((secret) => view.includes(secret)), [], `${when}: ${s.name} holds something hidden`);
  }
}

/** Waits until no seat of the rooms has been sent a frame for a moment, so a history line that trails its `ev` is in before frames are compared. */
async function quiet(...rooms: Compared[]): Promise<void> {
  const count = () => rooms.reduce((n, x) => n + x.seats.ana.frames.length + x.seats.bree.frames.length + x.seats.tv.frames.length, 0);
  for (let last = -1, now = count(); now !== last; last = now, now = count()) await new Promise((resolve) => setTimeout(resolve, 120));
}

/** Every seat of both rooms was sent nothing hidden, holds the same room and was sent the same frames, whole (FL2-SOL-04). */
function same(a: Compared, b: Compared, when: string): void {
  for (const x of [a, b]) leaks(x, when);
  for (const who of ["ana", "bree", "tv"] as const) {
    const [ta, tb] = [aliases(a, a.seats[who]), aliases(b, b.seats[who])];
    assert.deepEqual(normal(ta, a.seats[who].view), normal(tb, b.seats[who].view), `${when}: ${who} holds the same room`);
    assert.deepEqual(normal(ta, a.seats[who].you), normal(tb, b.seats[who].you), `${when}: ${who} is told the same floor`);
    assert.deepEqual(sent(ta, a.seats[who]), sent(tb, b.seats[who]), `${when}: ${who} was sent the same frames`);
  }
}

async function alike(a: Compared, b: Compared, when: string): Promise<void> {
  await quiet(a, b);
  same(a, b, when);
}

/** The answer Ana's op `n` got, from her frames since she last connected (`from`): refused with its code and words, or applied with the toast's words, if any. */
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

/** Ana's device drops and comes back in both rooms: her new snapshot is the same room, her next ops go on it, and what she was sent before stays compared. */
async function reconnectBoth(t: Engine, a: Compared, b: Compared, when: string): Promise<void> {
  for (const x of [a, b]) {
    const earlier = x.seats.ana;
    earlier.socket.close();
    await earlier.socket.waitClosed();
    x.seats.ana = await seat("Ana", await t.connect(x.roomId, x.ana), { memberId: x.anaId, role: "player" }, "ana-again");
    // Her first connection's frames stay in the record, ahead of the new ones, so every later scan and comparison reads both.
    x.seats.ana.frames.unshift(...earlier.frames);
    x.anaFrom = earlier.frames.length;
    x.attach([x.seats.ana, x.seats.bree, x.seats.tv]);
    await x.sync(when);
  }
  await alike(a, b, when);
}

/**
 * A climb's undo and redo twins over the wire (docs/design/design-v1-floors.md
 * phase 2, 4 and 8, lane FL2-C, D-261109-137): two rooms alike but for a
 * hidden owl perched on Thorn, a DM-only area on the owl and one on Thorn,
 * none of which Ana or Bree receives. Ana climbs, the DM may change one of
 * them unseen, and Ana's Undo and Redo go back and forth twice. Each
 * step's answer, toast and every player's reading of Thorn agree across
 * the rooms, every seat's view is a fresh snapshot, and no frame to a
 * player names a hidden thing.
 */
describe("a climb's undo and redo over the wire with passengers and areas players do not receive (phase 2, D-261109-137)", () => {
  let t: Engine;
  before(async () => {
    t = await startEngine({ rooms: { idleUnloadMs: 60_000 } });
  });
  after(() => t.close());

  type Twin = Compared & { upper: string; thorn: string; link: string; pair: string; gob: string; row: string; hidden: { owl?: string; aura?: string; ward?: string } };

  const area = (id: string, sceneId: string, ownerId: string, on: string) => ({ id, sceneId, shape: "sphere", size: 10, origin: { x: 3.5, y: 3.5, z: 0 }, yaw: 0, includeOrigin: true, color: "#e5484d", ownerId, visibility: "dm", attachedTo: on });

  async function twin(hidden: boolean): Promise<Twin> {
    // One name for both rooms: a room's name is every member's to read.
    const r = await newRoom(t, "Twin tower");
    await ok(r.dmSocket, { t: "scene.update", sceneId: r.ground, patch: { name: "Tower" } });
    const upper = await addFloor(r, r.ground, "above", "Upper floor");
    const thorn = await create(r, r.ground, { kind: "pc", name: "Thorn", disposition: "ally", ownerIds: [r.anaId], x: 3, y: 3 });
    const gob = await create(r, upper, { name: "Goblin", x: 12, y: 12, visibility: "dm" });
    const link = uuidv7();
    const pair = uuidv7();
    await ok(r.dmSocket, { t: "floorLink.put", link: { id: link, pairId: pair, sceneId: r.ground, to: upper, rect: { x: 3, y: 3, w: 2, h: 1 }, kind: "stairs" } } as Op);
    const secrets: Twin["hidden"] = {};
    if (hidden) {
      secrets.owl = await create(r, r.ground, { name: "Owl", kind: "npc", size: "tiny", visibility: "dm", x: 3, y: 3 });
      await ok(r.dmSocket, { t: "token.attach", tokenId: secrets.owl, to: thorn, kind: "perch", x: 3, y: 3, elevation: 0 } as Op);
      secrets.aura = uuidv7();
      secrets.ward = uuidv7();
      await ok(r.dmSocket, { t: "template.create", template: area(secrets.aura, r.ground, r.dmId, secrets.owl) } as Op);
      await ok(r.dmSocket, { t: "template.create", template: area(secrets.ward, r.ground, r.dmId, thorn) } as Op);
    }
    const row = uuidv7();
    await ok(r.dmSocket, { t: "encounter.start", entries: [{ id: row, tokenId: thorn, value: 20 }] } as Op);
    await ok(r.dmSocket, { t: "encounter.next" } as Op);
    const m = await withMarker(t, r, r.ground);
    const seats = await players(t, r, "ana first", false);
    m.attach([seats.ana, seats.bree, seats.tv]);
    await m.sync("seated");
    // What no player's frame may carry, by id or by name: the hidden goblin upstairs, and the owl and the areas where the room has them.
    const forbidden = [gob, '"Goblin"', ...(hidden ? [secrets.owl!, secrets.aura!, secrets.ward!, '"Owl"'] : [])];
    // The ids players may hold, each read by its role when two rooms compare (aliases).
    const roles: [string, string][] = [[r.ground, "ground"], [upper, "upper"], [thorn, "thorn"], [link, "link"], [pair, "pair"], [row, "row"], [m.marker, "marker"]];
    return { ...r, sync: m.sync, marker: m.marker, attach: m.attach, upper, thorn, link, pair, gob, row, seats, hidden: secrets, forbidden, anaFrom: 0, roles };
  }



  /** One step of Ana's in both rooms: the same answer, and every seat holding and sent the same. */
  async function step(a: Twin, b: Twin, op: (x: Twin) => Promise<Op>, when: string): Promise<string> {
    const answers: string[] = [];
    for (const x of [a, b]) {
      const n = x.seats.ana.socket.op(await op(x));
      answers.push(await answered(x.seats.ana, n, x.anaFrom));
      await x.sync(when);
    }
    assert.equal(answers[0], answers[1], `${when}: the answer`);
    await alike(a, b, when);
    return answers[0]!;
  }

  /** The DM's ops in the first room alone, which no player may tell from none: both rooms sync, and every seat holds and was sent the same. */
  async function unseen(a: Twin, b: Twin, ops: readonly Op[], when: string): Promise<void> {
    for (const op of ops) await ok(a.dmSocket, op);
    for (const x of [a, b]) await x.sync(when);
    await alike(a, b, when);
  }


  const reconnect = (a: Twin, b: Twin, when: string) => reconnectBoth(t, a, b, when);
  const climb = async (x: Twin): Promise<Op> => ({ t: "token.climb", tokenId: x.thorn, linkId: x.link });
  const undo = async (x: Twin): Promise<Op> => ({ t: "undo", head: (await x.seats.ana.socket.historyHead("play", "undo"))! }) as Op;
  const redo = async (x: Twin): Promise<Op> => ({ t: "redo", head: (await x.seats.ana.socket.historyHead("play", "redo"))! }) as Op;
  const all = (x: Twin) => [x.seats.ana, x.seats.bree, x.seats.tv];
  const close = (...rooms: Twin[]) => {
    for (const x of rooms) for (const s of all(x)) s.socket.close();
  };

  test("the comparison itself: a hidden id in place of a step's id, one step's id in place of another's, and a record too many each fail it (FL2-SOL-04)", async () => {
    const a = await twin(true);
    const b = await twin(false);
    assert.equal(await step(a, b, climb, "Go up"), "applied: ");
    assert.equal(await step(a, b, undo, "undo"), "applied: moving Thorn up the stairs");
    await reconnect(a, b, "Ana back");
    same(a, b, "untouched");
    /** A room as it is, with Ana's frames or view changed by hand. */
    const with_ = (x: Twin, over: Partial<Seat>): Twin => ({ ...x, seats: { ...x.seats, ana: { ...x.seats.ana, ...over } } });
    const frames = a.seats.ana.frames;
    // The last history line of her first connection: its epoch and its redo step's id are the server's own.
    const at = frames.slice(0, a.anaFrom).findLastIndex((f) => f.includes('"t":"history"'));
    const line = JSON.parse(frames[at]!) as { epoch: string; play: { redo: { head: { id: string } } } };
    const [epoch, head] = [line.epoch, line.play.redo.head.id];
    assert.ok(epoch.match(UUID) && head.match(UUID) && epoch !== head);
    const swapped = (to: string) => frames.map((f, k) => (k === at ? f.split(head).join(to) : f));
    assert.throws(() => same(with_(a, { frames: swapped(a.hidden.owl!) }), b, "an owl for a step"), /was sent something hidden/, "a hidden id in her first connection's frames is refused raw");
    assert.throws(() => same(with_(a, { frames: swapped(epoch) }), b, "an epoch for a step"), /was sent the same frames/, "two of the server's ids do not read alike");
    assert.throws(() => same(with_(a, { frames: swapped(uuidv7()) }), b, "a new id for a step"), /was sent the same frames/, "an id met once more than in the other room shifts the names");
    const extra = (x: Twin, n: number) => with_(x, { view: { ...x.seats.ana.view, templates: { ...x.seats.ana.view.templates, ...Object.fromEntries(Array.from({ length: n }, () => [uuidv7(), { shape: "sphere" }])) } } as ProjectedState });
    assert.throws(() => same(extra(a, 1), b, "a record too many"), /an id the test did not make stands at templates/);
    assert.throws(() => same(extra(a, 2), extra(b, 2), "the same records too many in both"), /an id the test did not make stands at templates/, "a generated name covers no record's key, alike in both rooms or not");
    // An id of the server's own outside its places, the same way in both rooms, is refused too.
    const moved = (x: Twin) => with_(x, { you: { ...x.seats.ana.you, sceneId: (JSON.parse(x.seats.ana.frames.find((f) => f.includes('"t":"history"'))!) as { epoch: string }).epoch } });
    assert.throws(() => same(moved(a), moved(b), "an epoch for a floor"), /an id the test did not make stands at sceneId/);
    const named = (x: Twin, n: number) => with_(x, { view: { ...x.seats.ana.view, templates: { ...x.seats.ana.view.templates, ...Object.fromEntries(Array.from({ length: n }, (_, k) => [`extra${k}`, { shape: "sphere" }])) } } as ProjectedState });
    assert.throws(() => same(named(a, 2), named(b, 1), "two records against one"), /holds the same room/);
    assert.throws(() => same(with_(a, { view: { ...a.seats.ana.view, note: a.hidden.ward } as unknown as ProjectedState }), b, "a hidden id held"), /holds something hidden/);
    same(a, b, "untouched still");
    close(a, b);
  });

  for (const [name, change] of [
    ["kept as they are", null],
    ["the area on Thorn deleted after the climb", (x: Twin): Op => ({ t: "template.delete", templateId: x.hidden.ward! })],
    ["the area on Thorn moved to a goblin after the climb", (x: Twin): Op => ({ t: "template.update", templateId: x.hidden.ward!, patch: { attachedTo: x.gob } }) as Op],
    ["the owl's area deleted after the climb", (x: Twin): Op => ({ t: "template.delete", templateId: x.hidden.aura! })],
    ["the owl taken off Thorn after the climb", (x: Twin): Op => ({ t: "token.detach", tokenId: x.hidden.owl!, x: 3, y: 4 }) as Op],
  ] as const) {
    test(`a hidden owl and DM-only areas, ${name}: Ana's climb, Undo and Redo answer as in a room without them, through a reconnect`, async () => {
      const a = await twin(true);
      const b = await twin(false);
      await alike(a, b, "seated");
      assert.equal(await step(a, b, climb, "Go up"), "applied: ");
      await unseen(a, b, change ? [change(a)] : [], "the DM's change unseen");
      for (const [i, [op, words]] of ([[undo, "undo"], [redo, "redo"], [undo, "undo"], [redo, "redo"]] as const).entries()) {
        assert.equal(await step(a, b, op, `${words} ${i + 1}`), "applied: moving Thorn up the stairs", `${words} ${i + 1}`);
        const where = words === "undo" ? a.ground : a.upper;
        const state = await oracle(t, a.roomId, all(a), `${words} ${i + 1}`);
        assert.equal(state.tokens[a.thorn]!.sceneId, where);
        const owl = state.tokens[a.hidden.owl!]!;
        assert.equal(owl.sceneId, owl.attached ? where : a.upper, "the owl rides back and forth while it sits on Thorn, and stays where the DM set it down");
        for (const id of [a.hidden.aura!, a.hidden.ward!]) {
          const follows = state.templates[id]?.attachedTo;
          if (follows !== undefined) assert.equal(state.templates[id]!.sceneId, state.tokens[follows]!.sceneId, `${id} stays with what it follows`);
        }
        // Her device drops between the first undo and its redo: the step is the member's, and the new snapshot tells nothing more.
        if (i === 0) await reconnect(a, b, "Ana back");
      }
      close(a, b);
    });
  }

  for (const from of ["undo", "redo"] as const) {
    test(`a DM-only area attached to Thorn after the climb${from === "redo" ? "'s undo" : ""} crosses with him on Ana's ${from} and back, answering as a room with none (FL2-OPUS-1)`, async () => {
      const a = await twin(false);
      const b = await twin(false);
      assert.equal(await step(a, b, climb, "Go up"), "applied: ");
      if (from === "redo") assert.equal(await step(a, b, undo, "undo first"), "applied: moving Thorn up the stairs");
      const late = uuidv7();
      a.forbidden.push(late);
      await unseen(a, b, [{ t: "template.create", template: area(late, from === "undo" ? a.upper : a.ground, a.dmId, a.thorn) } as Op], "the DM's area unseen");
      const steps = from === "undo" ? ([[undo, "undo"], [redo, "redo"], [undo, "undo"]] as const) : ([[redo, "redo"], [undo, "undo"], [redo, "redo"]] as const);
      for (const [i, [op, words]] of steps.entries()) {
        assert.equal(await step(a, b, op, `${words} ${i + 1}`), "applied: moving Thorn up the stairs", `${words} ${i + 1}`);
        const state = await oracle(t, a.roomId, all(a), `${words} ${i + 1}`);
        const where = words === "undo" ? a.ground : a.upper;
        assert.deepEqual([state.tokens[a.thorn]!.sceneId, state.templates[late]!.sceneId, state.templates[late]!.attachedTo], [where, where, a.thorn], `${words} ${i + 1}: the area is on Thorn's floor, still attached`);
        if (i === 0) await reconnect(a, b, "Ana back");
      }
      close(a, b);
    });

    test(`under fog the stairs turned to a ladder refuse Ana's ${from} of her climb in the words of stairs left alone, every frame alike (FL2-ASTRA-01)`, async () => {
      const a = await twin(false);
      const b = await twin(false);
      assert.equal(await step(a, b, climb, "Go up"), "applied: ");
      if (from === "redo") assert.equal(await step(a, b, undo, "undo first"), "applied: moving Thorn up the stairs");
      for (const x of [a, b]) {
        for (const sceneId of [x.ground, x.upper]) await ok(x.dmSocket, { t: "scene.update", sceneId, patch: { fogEnabled: true } } as Op);
        await x.sync("fog on both floors");
      }
      await alike(a, b, "fog on both floors");
      for (const s of all(a)) assert.deepEqual(Object.keys((s.view as { floorLinks?: object }).floorLinks ?? {}), [], `${s.name} holds no end under the fog`);
      // No frame so far names a ladder, and none may from here on.
      a.forbidden.push("ladder");
      await unseen(a, b, [{ t: "floorLink.update", linkId: a.link, patch: { kind: "ladder" } } as Op], "the kind changed unseen");
      assert.equal(await step(a, b, from === "undo" ? undo : redo, from), `refused invalid: could not ${from} moving Thorn up the stairs: the stairs changed`);
      await reconnect(a, b, "Ana back");
      close(a, b);
    });
  }
});

/**
 * Floors phase 3's privacy twins over the wire (docs/design/design-v1-floors.md
 * phase 3, 6, T1 to T6, lane FL3-B). Each pair of rooms differs only in
 * what a player may not learn: a floor from a file or a dungeon against a
 * blank one, a climb's height, a carried ruler's walker, or stairs under
 * the fog. Every frame each player and the display is sent, and the room
 * each holds, compares equal once normalized (`same`), beside the raw
 * scans for forbidden ids and names, through Bree's log page, a real
 * reconnect, Undo and Redo, and a co-DM's edit. T6 holds one room: every
 * way a shown preview's creature or stairs leaves a screen's copy ends the
 * preview there in that batch.
 */
describe("floors phase 3 over the wire: the privacy twins (phase 3, 6)", () => {
  let t: Engine;
  before(async () => {
    t = await startEngine({ rooms: { idleUnloadMs: 60_000 } });
  });
  after(() => t.close());

  type Eph = Extract<ServerMessage, { t: "eph" }>;
  const live = (roomId: string): RoomState => t.manager.get(roomId)!.committed.state;

  /** Seats Ana, Bree and the display on the room, with a marker on `markerScene`, as one room of a pair. */
  async function seated(r: Room, markerScene: string, roles: [string, string][], forbidden: string[]): Promise<Compared & { roles: [string, string][] }> {
    const m = await withMarker(t, r, markerScene);
    const seats = await players(t, r, "ana first", false);
    m.attach([seats.ana, seats.bree, seats.tv]);
    await m.sync("seated");
    return { ...r, sync: m.sync, marker: m.marker, attach: m.attach, seats, roles: [...roles, [m.marker, "marker"]], forbidden, anaFrom: 0 };
  }

  /** A co-DM, whose member record players hold, so its id reads by its role in both rooms. */
  async function coDm(x: Compared & { roles: [string, string][] }): Promise<Socket> {
    const client = t.client();
    const memberId = await client.claimDm(x.roomId, x.dmKey);
    x.roles.push([memberId, "co-dm"]);
    const socket = await t.connect(x.roomId, client);
    await socket.snapshot("co-dm");
    return socket;
  }

  /** The DM's ops in both rooms, each made for its room, which no player may tell apart: both sync, and every seat holds and was sent the same. */
  async function both(a: Compared, b: Compared, op: (x: Compared) => Op | Promise<Op>, when: string, socket: (x: Compared) => Socket = (x) => x.dmSocket): Promise<void> {
    for (const x of [a, b]) {
      await ok(socket(x), await op(x));
      await x.sync(when);
    }
    await alike(a, b, when);
  }

  /** The DM's Undo or Redo of its newest step of `scope` in both rooms. */
  async function stepBoth(a: Compared, b: Compared, direction: "undo" | "redo", scope: "play" | "setup", when: string, socket: (x: Compared) => Socket = (x) => x.dmSocket): Promise<void> {
    for (const x of [a, b]) {
      const ev = await socket(x).step(direction, scope);
      assert.deepEqual(ev.rejects ?? [], [], `${when}: the ${direction} was refused`);
      await x.sync(when);
    }
    await alike(a, b, when);
  }

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

  /** Every `eph` the seat was sent, as its device parses it. */
  const ephs = (s: Seat): Eph[] => s.frames.filter((f) => f.includes('"t":"eph"')).map((f) => serverMessageSchema.parse(JSON.parse(f)) as Eph);
  const send = (socket: Socket, sceneId: string, e: EphEvent) => socket.send({ t: "eph", sceneId, e });
  /** The climb's height on a seat's copy of an end, which only a player's copy carries (phase 3, 4.3). */
  const riseOf = (s: Seat, linkId: string) => (s.view.floorLinks?.[linkId] as { rise?: number } | undefined)?.rise;
  /** No frame names a carried ruler's provenance: the server forwards it without both arrays. */
  const PROVENANCE = ['"anchors"', '"ends"'];

  /** Adds a floor beside another under its name, as the Floors group's add does with phase 3's name. */
  async function floor(r: Room, beside: string, side: "above" | "below", name: string): Promise<string> {
    const id = uuidv7();
    await ok(r.dmSocket, { t: "scene.create", scene: { id, name: "Tower", bounds: { w: 30, h: 20 } }, floor: { beside, side, name } } as Op);
    return id;
  }

  async function stairs(r: Room, sceneId: string, to: string, rect: { x: number; y: number; w: number; h: number }, kind: "stairs" | "ladder" = "stairs"): Promise<{ link: string; far: string }> {
    const link = uuidv7();
    const far = uuidv7();
    await ok(r.dmSocket, { t: "floorLink.put", link: { id: link, pairId: far, sceneId, to, rect, kind } } as Op);
    return { link, far };
  }

  /** Sends ops in one Setup group, as the import and Make send them, and waits for every answer, none refused. */
  async function setupGroup(socket: Socket, ops: readonly Op[]): Promise<void> {
    const g = uuidv7();
    const waiting = new Set<number>();
    for (const op of ops) {
      const n = socket.nextN();
      waiting.add(n);
      socket.send({ t: "op", n, op, g, groupScope: "setup" });
    }
    while (waiting.size > 0) {
      const ev = await socket.next("ev", (m) => (m.acks ?? []).some((n) => waiting.has(n)) || (m.rejects ?? []).some((r) => waiting.has(r.n)), 30_000);
      assert.deepEqual(ev.rejects?.filter((r) => waiting.has(r.n)) ?? [], [], "an op of the group was refused");
      for (const n of ev.acks ?? []) waiting.delete(n);
    }
  }

  const GRID = { show: true, color: "#ffffff", opacity: 0.25, lineWidth: 1 };
  const close = (...rooms: Compared[]) => {
    for (const x of rooms) for (const s of [x.seats.ana, x.seats.bree, x.seats.tv]) s.socket.close();
  };

  /** The blank twin of a sourced floor: "Attic", 20 by 20, added below Ground in one Setup group. */
  async function blankTwin(): Promise<Compared & { roles: [string, string][]; floorId: string }> {
    const r = await newRoom(t, "Sourced floor");
    await ok(r.dmSocket, { t: "scene.update", sceneId: r.ground, patch: { name: "Tower" } });
    const thorn = await create(r, r.ground, { kind: "pc", name: "Thorn", ownerIds: [r.anaId], x: 4, y: 4 });
    const x = await seated(r, r.ground, [[r.ground, "ground"], [thorn, "thorn"]], []);
    const floorId = uuidv7();
    await setupGroup(r.dmSocket, [{ t: "scene.create", scene: { id: floorId, name: "Tower", bounds: { w: 20, h: 20 } }, floor: { beside: r.ground, side: "below", name: "Attic" } } as Op]);
    x.forbidden.push(floorId);
    await x.sync("the blank floor added");
    return { ...x, floorId };
  }

  /** Undo setup, Redo setup, a co-DM's rename of the new floor, Ana's reconnect and Bree's log page, alike in both rooms of a sourced floor's pair. */
  async function sourcedSteps(a: Compared & { roles: [string, string][]; floorId: string }, b: Compared & { roles: [string, string][]; floorId: string }): Promise<void> {
    await alike(a, b, "the floor added");
    await logPages(a, b, "the floor added");
    await stepBoth(a, b, "undo", "setup", "Undo setup");
    for (const x of [a, b]) assert.equal(live(x.roomId).scenes[x.floorId], undefined, "Undo setup takes the floor");
    await stepBoth(a, b, "redo", "setup", "Redo setup");
    const co = new Map<Compared, Socket>();
    for (const x of [a, b]) co.set(x, await coDm(x));
    for (const x of [a, b]) x.forbidden.push("Vault");
    await both(a, b, (x) => ({ t: "scene.update", sceneId: (x as typeof a).floorId, patch: { floor: { name: "Vault" } } }) as Op, "a co-DM renames the floor", (x) => co.get(x)!);
    await reconnectBoth(t, a, b, "Ana back");
    await logPages(a, b, "after all");
    for (const s of co.values()) s.close();
  }

  test("T1, a file floor: Crypt level 2, 40 by 30 with walls, a door and a light, against a blank Attic, 20 by 20, alike for Ana, Bree and the display, its map 404 to Ana until it shows", async () => {
    const b = await blankTwin();
    const r = await newRoom(t, "Sourced floor");
    await ok(r.dmSocket, { t: "scene.update", sceneId: r.ground, patch: { name: "Tower" } });
    const thorn = await create(r, r.ground, { kind: "pc", name: "Thorn", ownerIds: [r.anaId], x: 4, y: 4 });
    const x = await seated(r, r.ground, [[r.ground, "ground"], [thorn, "thorn"]], []);
    const res = await r.dm.request("PUT", `/api/rooms/${r.roomId}/assets?kind=map`, undefined, { "content-type": "image/png" }, await solid(640, 480, "#264").png().toBuffer());
    assert.equal(res.statusCode, 200, res.body);
    const asset = res.json<{ id: string; width: number; height: number }>();
    const crypt = uuidv7();
    const light = uuidv7();
    const own = { bounds: { w: 40, h: 30 }, background: "#1b1b20", grid: GRID, autoWalls: "off", map: { assetId: asset.id, widthPx: asset.width, heightPx: asset.height, cellPx: 16, originPx: { x: 0, y: 0 } }, gridFromFile: true, fogEnabled: true, vision: { on: true, light: "dark", byClock: false } };
    await setupGroup(r.dmSocket, [
      { t: "scene.create", scene: { id: crypt, name: "Tower", bounds: { w: 40, h: 30 } }, floor: { beside: r.ground, side: "below", name: "Crypt level 2", own } },
      { t: "build.edge", sceneId: crypt, edges: [{ key: "4,3,w", feature: { kind: "wall" } }, { key: "5,3,n", feature: { kind: "door", state: "closed", secret: false, discovered: false } }] },
      { t: "build.walls", sceneId: crypt, put: [{ id: "w00000000001", a: [1, 1], b: [6, 1], f: { kind: "wall" } }] },
      { t: "build.lights", sceneId: crypt, put: [{ id: light, x: 3, y: 3, bright: 20, dim: 40, on: true, walls: true }] },
    ] as Op[]);
    await x.sync("the file floor added");
    const a = { ...x, floorId: crypt };
    const names = ["Crypt level 2", "Attic", '{"w":40,"h":30}', '{"w":20,"h":20}'];
    a.forbidden.push(crypt, asset.id, light, "w00000000001", ...names);
    b.forbidden.push(...names);
    assert.deepEqual(live(r.roomId).scenes[crypt]?.bounds, { w: 40, h: 30 }, "the floor takes the file's size");
    const get = (c: TestClient) => c.request("GET", `/api/assets/${asset.id}/full`).then((reply) => reply.statusCode);
    assert.deepEqual([await get(r.ana), await get(r.tv), await get(r.dm)], [404, 404, 200], "the map is 404 to Ana and the display, 200 to the DM");
    await sourcedSteps(a, b);
    assert.deepEqual([await get(r.ana), await get(r.tv)], [404, 404], "still 404 after Undo, Redo and the rename");
    // Shown to players, the floor and its map are theirs.
    await ok(r.dmSocket, { t: "floor.open", sceneId: crypt, open: true } as Op);
    await a.sync("the DM shows the floor");
    assert.equal(await get(r.ana), 200, "200 to Ana once the floor shows");
    assert.ok(crypt in a.seats.ana.view.scenes);
    close(a, b);
  });

  test("T2, a dungeon floor: the dressed fixture's 30 by 30 Crypt with traps, a stone, a key page and its pins, against a blank Attic, alike for every player", async () => {
    const b = await blankTwin();
    const r = await newRoom(t, "Sourced floor");
    await ok(r.dmSocket, { t: "scene.update", sceneId: r.ground, patch: { name: "Tower" } });
    const thorn = await create(r, r.ground, { kind: "pc", name: "Thorn", ownerIds: [r.anaId], x: 4, y: 4 });
    const x = await seated(r, r.ground, [[r.ground, "ground"], [thorn, "thorn"]], []);
    type FixtureDungeon = { name: string; sceneId: string; placeholders: string[]; ops: Op[] };
    const fixture = JSON.parse(readFileSync(new URL("./dungeon.fixture.json", import.meta.url), "utf8")) as { dungeons: FixtureDungeon[] };
    const dressed = fixture.dungeons.find((d) => d.name === "dressed")!;
    const crypt = uuidv7();
    const ids = new Map<string, string>([[dressed.sceneId, crypt]]);
    // Every id Make gives a fresh one, a key block's 12 characters.
    for (const [i, id] of dressed.placeholders.entries()) ids.set(id, id.startsWith("dungeonblk") ? `blk${String(i).padStart(9, "0")}` : uuidv7());
    let text = JSON.stringify(dressed.ops);
    for (const [was, now] of ids) text = text.replaceAll(JSON.stringify(was), JSON.stringify(now));
    const [made, ...rest] = JSON.parse(text) as Op[];
    assert.ok(made?.t === "scene.create");
    const own = { bounds: made.scene.bounds, background: made.scene.background!, grid: made.scene.grid!, autoWalls: "all", fogEnabled: true, vision: { on: false, light: "bright", byClock: false } };
    await setupGroup(r.dmSocket, [{ t: "scene.create", scene: { id: crypt, name: "Tower", bounds: made.scene.bounds }, floor: { beside: r.ground, side: "below", name: "Crypt", own } } as Op, ...rest]);
    await x.sync("the dungeon floor added");
    const a = { ...x, floorId: crypt };
    const names = ["Crypt", "Attic", "Rolling stone", "Hidden Pit", "Poisoned", '{"w":30,"h":30}', '{"w":20,"h":20}'];
    a.forbidden.push(...ids.values(), ...names);
    b.forbidden.push(...names);
    const state = live(r.roomId);
    assert.deepEqual([state.scenes[crypt]?.bounds, Object.values(state.traps ?? {}).filter((trap) => trap.sceneId === crypt).length], [{ w: 30, h: 30 }, 5], "the floor stands with its traps");
    await sourcedSteps(a, b);
    close(a, b);
  });

  /** Tower: Ground floor and Attic above it, `height` ft high, stairs from Ground (link) up to Attic (far) under Thorn, and Wren, Bree's, beside him. */
  async function riseRoom(height: number, fogged: boolean): Promise<Compared & { roles: [string, string][]; attic: string; link: string; far: string; thorn: string }> {
    const r = await newRoom(t, "Rise");
    await ok(r.dmSocket, { t: "scene.update", sceneId: r.ground, patch: { name: "Tower" } });
    const attic = await floor(r, r.ground, "above", "Attic");
    await ok(r.dmSocket, { t: "scene.update", sceneId: attic, patch: { floor: { height } } } as Op);
    const thorn = await create(r, r.ground, { kind: "pc", name: "Thorn", ownerIds: [r.anaId], x: 3, y: 3 });
    const wren = await create(r, r.ground, { kind: "pc", name: "Wren", ownerIds: [r.breeId], x: 8, y: 8 });
    const { link, far } = await stairs(r, r.ground, attic, { x: 3, y: 3, w: 2, h: 1 });
    const roles: [string, string][] = [[r.ground, "ground"], [thorn, "thorn"], [wren, "wren"]];
    if (fogged) {
      // Both floors held by every player, the stairs under the fog at both ends.
      await ok(r.dmSocket, { t: "floor.open", sceneId: attic, open: true } as Op);
      for (const sceneId of [r.ground, attic]) await ok(r.dmSocket, { t: "scene.update", sceneId, patch: { fogEnabled: true } } as Op);
      roles.push([attic, "attic"]);
    } else roles.push([link, "link"]);
    const forbidden = fogged ? [link, far, '"rise"'] : [attic, far, "Attic", '"rise"', '"height":'];
    const x = await seated(r, r.ground, roles, forbidden);
    return { ...x, attic, link, far, thorn };
  }

  /** A height edit, its Undo and Redo, a co-DM's rename of Attic, Ana's reconnect and Bree's log page, alike in both rooms of a `rise` pair. */
  async function riseSteps(a: Awaited<ReturnType<typeof riseRoom>>, b: Awaited<ReturnType<typeof riseRoom>>, atticHeld: boolean): Promise<void> {
    await alike(a, b, "seated");
    await both(a, b, (x) => ({ t: "scene.update", sceneId: (x as typeof a).attic, patch: { floor: { height: x === a ? 20 : 40 } } }) as Op, "Attic's height edited");
    await stepBoth(a, b, "undo", "setup", "the height edit undone");
    await stepBoth(a, b, "redo", "setup", "and redone");
    await both(a, b, (x) => ({ t: "floorLink.update", linkId: (x as typeof a).link, patch: { locked: true } }) as Op, "the stairs locked");
    const co = new Map<Compared, Socket>();
    for (const x of [a, b]) co.set(x, await coDm(x));
    if (!atticHeld) for (const x of [a, b]) x.forbidden.push("Loft");
    await both(a, b, (x) => ({ t: "scene.update", sceneId: (x as typeof a).attic, patch: { floor: { name: "Loft" } } }) as Op, "a co-DM renames Attic", (x) => co.get(x)!);
    await reconnectBoth(t, a, b, "Ana back");
    await logPages(a, b, "after all");
    for (const s of co.values()) s.close();
  }

  test("T3, `rise` while players hold Ground alone: Attic 10 ft against 30 ft is one room to every player, then once Attic shows the copies differ in `rise` alone and a height edit reaches it", async () => {
    const a = await riseRoom(10, false);
    const b = await riseRoom(30, false);
    await riseSteps(a, b, false);
    // Attic shown to players: its record, its end and the climb's height are theirs now.
    for (const x of [a, b]) {
      await ok(x.dmSocket, { t: "floor.open", sceneId: x.attic, open: true } as Op);
      await x.sync("Attic shown");
      x.forbidden = [];
      x.roles.push([x.attic, "attic"], [x.far, "far"], [x.link, "link"]);
    }
    const strip = (x: typeof a, s: Seat) => normal(aliases(x, s), JSON.parse(JSON.stringify(s.view), (k, v: unknown) => (k === "rise" ? "the climb's" : v)));
    for (const who of ["ana", "bree", "tv"] as const) {
      assert.deepEqual(strip(a, a.seats[who]), strip(b, b.seats[who]), `${who}: the copies differ in \`rise\` alone`);
      assert.deepEqual([riseOf(a.seats[who], a.link), riseOf(a.seats[who], a.far), riseOf(b.seats[who], b.link)], [20, 20, 40], `${who} reads each room's climb on both ends`);
    }
    await ok(a.dmSocket, { t: "scene.update", sceneId: a.attic, patch: { floor: { height: 25 } } } as Op);
    await a.sync("Attic's height edited while it shows");
    assert.equal(riseOf(a.seats.ana, a.link), 25, "the edit reaches Ana's copy");
    close(a, b);
  });

  test("T3, `rise` under the fog: every player holds both floors with the stairs fogged at both ends, so no end and no `rise`, Attic 10 ft against 30 ft alike", async () => {
    const a = await riseRoom(10, true);
    const b = await riseRoom(30, true);
    for (const s of [a.seats.ana, a.seats.bree, a.seats.tv]) assert.ok(a.attic in s.view.scenes && !("floorLinks" in s.view), `${s.name} holds Attic and no end`);
    await riseSteps(a, b, true);
    close(a, b);
  });

  test("T3, a height edit judges no preview again: Ana drags Thorn, the DM locks him, then sets hidden Attic to 30 ft where it was 10 against 30, and Bree's frames stay alike (FL3-SOL-01)", async () => {
    const a = await riseRoom(10, false);
    const b = await riseRoom(30, false);
    for (const x of [a, b]) {
      send(x.seats.ana.socket, x.ground, { k: "dragMove", tokenId: x.thorn, x: 5, y: 5 });
      await x.sync("Ana drags Thorn");
      assert.deepEqual(ephs(x.seats.bree).at(-1)?.e, { k: "dragMove", tokenId: x.thorn, x: 5, y: 5 }, "Bree shows the drag");
    }
    await alike(a, b, "Ana drags Thorn");
    await both(a, b, (x) => ({ t: "token.update", tokenId: (x as typeof a).thorn, patch: { locked: true } }) as Op, "the DM locks Thorn");
    await both(a, b, (x) => ({ t: "scene.update", sceneId: (x as typeof a).attic, patch: { floor: { height: 30 } } }) as Op, "hidden Attic set to 30 ft");
    for (const x of [a, b]) assert.equal(live(x.roomId).scenes[x.attic]?.floor?.height, 30);
    close(a, b);
  });

  /**
   * Tower for the carried rulers: Cellar below Ground floor, which the DM
   * has shown players, so Bree holds both. Stairs from Cellar (down) up to
   * Ground (up). Shade, Ana's, stands hidden on Cellar at the stairs' foot,
   * Wren, Bree's, on Ground.
   */
  async function cellarRoom(): Promise<Compared & { roles: [string, string][]; cellar: string; shade: string; down: string; up: string }> {
    const r = await newRoom(t, "Carried");
    await ok(r.dmSocket, { t: "scene.update", sceneId: r.ground, patch: { name: "Tower" } });
    const cellar = await floor(r, r.ground, "below", "Cellar");
    await ok(r.dmSocket, { t: "floor.open", sceneId: cellar, open: true } as Op);
    const shade = await create(r, cellar, { kind: "pc", name: "Shade", ownerIds: [r.anaId], visibility: "dm", x: 2, y: 2 });
    const wren = await create(r, r.ground, { kind: "pc", name: "Wren", ownerIds: [r.breeId], x: 8, y: 8 });
    const { link: down, far: up } = await stairs(r, cellar, r.ground, { x: 2, y: 2, w: 1, h: 1 });
    // Shade is Ana's own, so only Bree's and the display's frames are scanned for it (`unseenShade`).
    const x = await seated(r, r.ground, [[r.ground, "ground"], [cellar, "cellar"], [wren, "wren"], [down, "down"], [up, "up"], [shade, "shade"]], [...PROVENANCE]);
    return { ...x, cellar, shade, down, up };
  }

  test("T4, carried anchors: Ana's ruler from her hidden Shade up the stairs, Medium against Large on different walks, reaches neither Bree nor the display, through a co-DM's edit, a reconnect and her log page", async () => {
    const a = await cellarRoom();
    const b = await cellarRoom();
    await alike(a, b, "seated");
    const carry = (x: typeof a, k: number): EphEvent => ({
      k: "ruler",
      id: "walk-up",
      walk: true,
      points: x === a ? [{ x: 2.5, y: 2.5 }, { x: 5.5 + k, y: 2.5 }] : [{ x: 3, y: 3 }, { x: 9 + k, y: 6 }],
      prior: { ft: x === a ? 25 : 45, diag: { h: x === a ? 0 : 2, v: 0 }, walker: { size: x === a ? "medium" : "large" }, anchors: [x.shade], ends: [x.down] },
    });
    for (const x of [a, b]) {
      send(x.seats.ana.socket, x.ground, carry(x, 0));
      await x.sync("Ana's carried ruler");
    }
    await alike(a, b, "Ana's carried ruler");
    // The DM sees every creature, so it gets the frame, without the ids it named.
    const dmGot = await a.dmSocket.next("eph", (m) => m.e.k === "ruler" && m.e.id === "walk-up");
    assert.deepEqual(Object.keys((dmGot.e as { prior: object }).prior).sort(), ["diag", "ft", "walker"]);
    const co = new Map<Compared, Socket>();
    for (const x of [a, b]) co.set(x, await coDm(x));
    await both(a, b, (x) => ({ t: "token.update", tokenId: (x as typeof a).shade, patch: { name: "Umbra" } }) as Op, "a co-DM renames Shade", (x) => co.get(x)!);
    for (const x of [a, b]) {
      send(x.seats.ana.socket, x.ground, carry(x, 1));
      await x.sync("the next frame");
    }
    await alike(a, b, "the next frame");
    await reconnectBoth(t, a, b, "Ana back");
    for (const x of [a, b]) {
      send(x.seats.ana.socket, x.ground, carry(x, 2));
      await x.sync("a frame from her new socket");
    }
    await alike(a, b, "a frame from her new socket");
    await logPages(a, b, "after all");
    for (const x of [a, b]) {
      for (const s of [x.seats.bree, x.seats.tv]) {
        assert.deepEqual(ephs(s), [], `${s.name} was sent no frame of it`);
        assert.deepEqual(naming(s, [x.shade, "Shade", "Umbra"]), [], `${s.name} was sent nothing of Shade`);
        assert.ok(!JSON.stringify(s.view).includes(x.shade), `${s.name} holds nothing of Shade`);
      }
    }
    for (const s of co.values()) s.close();
    close(a, b);
  });

  test("T4, a hidden other anchor and the DM's carried ruler from a hidden monster: no player gets either, a co-DM gets the DM's without its ids, and Show then Hide brings it and ends it", async () => {
    const x = await cellarRoom();
    // Thorn, Ana's, visible on Cellar, and a goblin the DM hid there, which a stop of her ruler sat on.
    const thorn = await create(x, x.cellar, { kind: "pc", name: "Thorn", ownerIds: [x.anaId], x: 3, y: 2 });
    const gob = await create(x, x.cellar, { name: "Lurker", visibility: "dm", x: 6, y: 6 });
    const ogre = await create(x, x.cellar, { name: "Brute", visibility: "dm", x: 2, y: 3 });
    x.forbidden.push(gob, ogre, "Lurker", "Brute");
    await x.sync("creatures placed");
    const co = await coDm(x);
    send(x.seats.ana.socket, x.ground, { k: "ruler", id: "walk-two", walk: true, points: [{ x: 2.5, y: 2.5 }, { x: 6.5, y: 2.5 }], prior: { ft: 30, diag: { h: 0, v: 0 }, walker: { size: "medium" }, anchors: [thorn, gob], ends: [x.down] } });
    const dmCarry: EphEvent = { k: "ruler", id: "dm-walk", walk: true, shared: true, points: [{ x: 2.5, y: 2.5 }, { x: 4.5, y: 4.5 }], prior: { ft: 15, diag: { h: 1, v: 0 }, walker: { size: "large" }, anchors: [ogre], ends: [x.down] } };
    send(x.dmSocket, x.ground, dmCarry);
    await x.sync("the two carried rulers");
    leaks(x, "the two carried rulers");
    for (const s of [x.seats.bree, x.seats.tv]) assert.deepEqual(ephs(s), [], `${s.name} gets neither`);
    const coGot = await co.next("eph", (m) => m.e.k === "ruler" && m.e.id === "dm-walk");
    assert.deepEqual(coGot.e, { ...dmCarry, prior: { ft: 15, diag: { h: 1, v: 0 }, walker: { size: "large" } } }, "a co-DM gets the DM's carried ruler without anchors and ends");
    // The DM shows the brute: the next frame reaches every player, and hiding it again ends it on their screens in that batch.
    await ok(x.dmSocket, { t: "token.update", tokenId: ogre, patch: { visibility: "all" } } as Op);
    x.forbidden = x.forbidden.filter((secret) => secret !== ogre && secret !== "Brute");
    send(x.dmSocket, x.ground, dmCarry);
    await x.sync("the brute shown");
    for (const s of [x.seats.ana, x.seats.bree, x.seats.tv]) assert.deepEqual(ephs(s).map((m) => m.e), [{ ...dmCarry, prior: { ft: 15, diag: { h: 1, v: 0 }, walker: { size: "large" } } }], `${s.name} gets it once the brute shows`);
    await ok(x.dmSocket, { t: "token.update", tokenId: ogre, patch: { visibility: "dm" } } as Op);
    await x.sync("the brute hidden again");
    for (const s of [x.seats.ana, x.seats.bree, x.seats.tv]) assert.deepEqual(ephs(s).at(-1)?.e, { k: "rulerEnd", id: "dm-walk" }, `${s.name}'s screen ends it`);
    leaks(x, "after all");
    co.close();
    close(x);
  });

  test("T5, fogged stairs: a DM socket's shared carried ruler naming an end under every player's fog reaches neither Ana nor the display, stairs at 10 ft against a ladder at 30 ft, until the DM reveals the end", async () => {
    const room = async (kind: "stairs" | "ladder", height: number) => {
      const r = await newRoom(t, "Fogged stairs");
      await ok(r.dmSocket, { t: "scene.update", sceneId: r.ground, patch: { name: "Tower" } });
      const attic = await floor(r, r.ground, "above", "Attic");
      await ok(r.dmSocket, { t: "scene.update", sceneId: attic, patch: { floor: { height } } } as Op);
      await ok(r.dmSocket, { t: "floor.open", sceneId: attic, open: true } as Op);
      for (const sceneId of [r.ground, attic]) await ok(r.dmSocket, { t: "scene.update", sceneId, patch: { fogEnabled: true } } as Op);
      const thorn = await create(r, r.ground, { kind: "pc", name: "Thorn", ownerIds: [r.anaId], x: 3, y: 3 });
      const { link, far } = await stairs(r, r.ground, attic, { x: 3, y: 3, w: 1, h: 1 }, kind);
      const x = await seated(r, r.ground, [[r.ground, "ground"], [attic, "attic"], [thorn, "thorn"]], [link, far, '"rise"', ...PROVENANCE]);
      return { ...x, attic, thorn, link, far };
    };
    const a = await room("stairs", 10);
    const b = await room("ladder", 30);
    await alike(a, b, "seated");
    const carry = (x: typeof a): EphEvent => ({ k: "ruler", id: "dm-up", walk: true, shared: true, points: [{ x: 3.5, y: 3.5 }, { x: 7.5, y: 3.5 }], prior: { ft: x === a ? 10 : 60, diag: { h: 0, v: 0 }, walker: { size: "medium" }, anchors: [x.thorn], ends: [x.link] } });
    const frame = async (when: string) => {
      for (const x of [a, b]) {
        send(x.dmSocket, x.attic, carry(x));
        await x.sync(when);
      }
      await alike(a, b, when);
    };
    await frame("the DM's carried ruler");
    for (const s of [a.seats.ana, a.seats.tv]) assert.deepEqual(ephs(s), [], `${s.name} gets none while the end is fogged`);
    const co = new Map<Compared, Socket>();
    for (const x of [a, b]) co.set(x, await coDm(x));
    await both(a, b, (x) => ({ t: "floorLink.update", linkId: (x as typeof a).link, patch: { locked: true } }) as Op, "a co-DM locks the end", (x) => co.get(x)!);
    await stepBoth(a, b, "undo", "play", "the lock undone", (x) => co.get(x)!);
    await stepBoth(a, b, "redo", "play", "and redone", (x) => co.get(x)!);
    await frame("another frame");
    await reconnectBoth(t, a, b, "Ana back");
    await frame("a frame after her reconnect");
    await logPages(a, b, "after all");
    // Revealed over the end: both get the next frame, without the ids, and the end with its height.
    for (const x of [a, b]) {
      await ok(x.dmSocket, { t: "fog.live", sceneId: x.ground, ops: [{ id: uuidv7(), mode: "reveal", shape: { kind: "rect", x: 2, y: 2, w: 3, h: 3 } }] } as Op);
      send(x.dmSocket, x.attic, carry(x));
      await x.sync("the end revealed");
      for (const s of [x.seats.ana, x.seats.tv]) {
        assert.deepEqual(ephs(s).map((m) => m.e), [{ ...carry(x), prior: { ft: x === a ? 10 : 60, diag: { h: 0, v: 0 }, walker: { size: "medium" } } }], `${s.name} gets the frame once the end shows`);
        assert.equal(riseOf(s, x.link), x === a ? 10 : 30, `${s.name} reads the climb's height with the end`);
      }
    }
    for (const s of co.values()) s.close();
    close(a, b);
  });

  /*
   * T6: one room. Ground floor is dark with party vision and no fog. Wren,
   * Bree's, and Thorn, Ana's, stand west of a wall down column 6, whose one
   * door at row 5 stands open. East of it a goblin stands in a lamp's light,
   * so every player sees it through the door. Stairs at (2, 10) lead down
   * to Cellar, which the DM has shown players. Cora, a co-DM, makes each
   * change and its Undo and Redo, so the DM's marker moves never sit
   * between them on one stack.
   */
  test("T6, judged again: each way a shown preview's creature or stairs leaves a player's copy ends it there in that batch, for a carried ruler, a plain one and a drag, again after Undo and Redo", async () => {
    const r = await newRoom(t, "Judged again");
    // Fog stays off, so the stairs show wherever they stand and the goblin shows only by sight.
    await ok(r.dmSocket, { t: "scene.update", sceneId: r.ground, patch: { name: "Tower", fogEnabled: false, vision: { on: true, light: "dark" } } } as Op);
    const cellar = await floor(r, r.ground, "below", "Cellar");
    await ok(r.dmSocket, { t: "floor.open", sceneId: cellar, open: true } as Op);
    await create(r, r.ground, { kind: "pc", name: "Wren", ownerIds: [r.breeId], x: 2, y: 5 });
    await create(r, r.ground, { kind: "pc", name: "Thorn", ownerIds: [r.anaId], x: 2, y: 7 });
    const gob = await create(r, r.ground, { name: "Goblin", x: 10, y: 5 });
    const edges = Array.from({ length: 20 }, (_, y) => ({ key: `6,${y},w`, feature: y === 5 ? { kind: "door", state: "open", secret: false, discovered: false } : { kind: "wall" } }));
    await ok(r.dmSocket, { t: "build.edge", sceneId: r.ground, edges } as Op);
    const lamp = { id: uuidv7(), x: 10.5, y: 5.5, bright: 10, dim: 10, on: true, walls: true };
    await ok(r.dmSocket, { t: "build.lights", sceneId: r.ground, put: [lamp] } as Op);
    const { link: down } = await stairs(r, r.ground, cellar, { x: 2, y: 10, w: 1, h: 1 });
    const m = await withMarker(t, r, r.ground);
    const s = await players(t, r, "ana first", false);
    const watching = [s.bree, s.tv];
    m.attach([s.ana, s.bree, s.tv]);
    await m.sync("seated");
    for (const x of watching) assert.ok(gob in x.view.tokens, `${x.name} sees the goblin in the lamp's light through the door`);
    const cora = t.client();
    await cora.claimDm(r.roomId, r.dmKey, "Cora");
    const co = await t.connect(r.roomId, cora);
    await co.snapshot("cora");

    type Preview = { name: string; from: Socket; sceneId: string; frame: (id: string) => EphEvent; end: (id: string) => EphEvent };
    const carried: Preview = {
      name: "a carried ruler",
      from: s.ana.socket,
      sceneId: cellar,
      frame: (id) => ({ k: "ruler", id, walk: true, points: [{ x: 2.5, y: 10.5 }, { x: 6.5, y: 10.5 }], prior: { ft: 40, diag: { h: 0, v: 0 }, walker: { size: "medium" }, anchors: [gob], ends: [down] } }),
      end: (id) => ({ k: "rulerEnd", id }),
    };
    const plain: Preview = { name: "a plain ruler", from: s.ana.socket, sceneId: r.ground, frame: (id) => ({ k: "ruler", id, points: [{ x: 10.5, y: 5.5, tokenId: gob }, { x: 8.5, y: 5.5 }] }), end: (id) => ({ k: "rulerEnd", id }) };
    const drag: Preview = { name: "a drag", from: r.dmSocket, sceneId: r.ground, frame: () => ({ k: "dragMove", tokenId: gob, x: 10, y: 5 }), end: () => ({ k: "dragCancel", tokenId: gob }) };
    const changes: { name: string; op: Op; scope: "play" | "setup"; previews: Preview[] }[] = [
      { name: "the goblin hidden", op: { t: "token.update", tokenId: gob, patch: { visibility: "dm" } } as Op, scope: "play", previews: [carried, plain, drag] },
      { name: "the lamp turned off", op: { t: "build.lights", sceneId: r.ground, put: [{ ...lamp, on: false }] } as Op, scope: "play", previews: [carried, plain, drag] },
      { name: "the door closed", op: { t: "door.set", sceneId: r.ground, door: { edge: "6,5,w" }, state: "closed" } as Op, scope: "play", previews: [carried, plain, drag] },
      { name: "the stairs removed", op: { t: "floorLink.delete", linkId: down } as Op, scope: "setup", previews: [carried] },
      { name: "Cellar hidden from players", op: { t: "floor.open", sceneId: cellar, open: false } as Op, scope: "play", previews: [carried] },
    ];

    /** Sends the preview's frame and checks every watching screen shows it, as its device parses it, without the ids it named. */
    const shown = async (p: Preview, id: string, when: string) => {
      send(p.from, p.sceneId, p.frame(id));
      await m.sync(when);
      for (const x of watching) {
        const last = ephs(x).at(-1);
        assert.equal(last?.sceneId, p.sceneId, `${when}: ${x.name}`);
        assert.equal(stableStringify(last?.e), stableStringify(outboundEph(p.frame(id))), `${when}: ${x.name} shows it, without anchors and ends`);
      }
    };
    /** Applies the change by Cora and checks each watching screen got the bare end right after the batch's own `ev`, before the marker's next one. */
    const ended = async (p: Preview, id: string, apply: () => Promise<Extract<ServerMessage, { t: "ev" }>>, when: string) => {
      const from = new Map(watching.map((x) => [x, x.frames.length]));
      const ev = await apply();
      assert.deepEqual(ev.rejects ?? [], [], `${when}: refused`);
      await m.sync(when);
      for (const x of watching) {
        const frames = x.frames.slice(from.get(x)).map((f) => JSON.parse(f) as ServerMessage);
        const at = frames.findIndex((f) => f.t === "eph");
        assert.ok(at > 0, `${when}: ${x.name} got the bare end`);
        assert.deepEqual((frames[at] as Eph).e, p.end(id), `${when}: ${x.name} got the bare end`);
        assert.ok(frames.slice(0, at).some((f) => f.t === "ev"), `${when}: ${x.name}'s end follows the batch's ev`);
        assert.ok(!frames.slice(0, at).some((f) => f.t === "ev" && f.changes.some((c) => c.key === `token:${m.marker}`)), `${when}: ${x.name}'s end comes in that batch, before the marker's`);
        assert.equal(frames.filter((f) => f.t === "eph").length, 1, `${when}: one end and nothing else`);
      }
    };
    let n = 0;
    for (const change of changes) {
      for (const p of change.previews) {
        const id = `preview-${++n}`;
        const when = `${change.name}, ${p.name}`;
        await shown(p, id, `${when}: shown`);
        await ended(p, id, () => co.apply(change.op), when);
        assert.deepEqual((await co.step("undo", change.scope)).rejects ?? [], [], `${when}: the Undo`);
        await m.sync(`${when}: undone`);
        for (const x of watching) assert.ok(gob in x.view.tokens, `${when}: ${x.name} sees the goblin after the Undo`);
        await shown(p, id, `${when}: shown after the Undo`);
        await ended(p, id, () => co.step("redo", change.scope), `${when}, redone`);
        assert.deepEqual((await co.step("undo", change.scope)).rejects ?? [], [], `${when}: the second Undo`);
        await m.sync(`${when}: undone again`);
      }
    }
    // An inbound carried frame without its provenance never parses, so it reaches nobody.
    const before = watching.map((x) => ephs(x).length);
    const { prior, ...bare } = carried.frame("bare") as Extract<EphEvent, { k: "ruler" }>;
    send(s.ana.socket, cellar, { ...bare, prior: { ft: prior!.ft, diag: prior!.diag, walker: prior!.walker } } as EphEvent);
    await m.sync("a carried frame without anchors and ends");
    assert.deepEqual(watching.map((x) => ephs(x).length), before, "refused inbound");
    for (const x of [s.ana, s.bree, s.tv]) assert.deepEqual(naming(x, PROVENANCE), [], `${x.name} was never sent a carried frame's ids`);
    co.close();
    for (const x of [s.ana, s.bree, s.tv]) x.socket.close();
  });
});
