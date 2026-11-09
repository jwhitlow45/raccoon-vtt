import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { uuidv7 } from "#shared/ids.ts";
import type { RoomState, Scene, Viewer } from "#shared/model.ts";
import { ONE_FLOOR_MOVE } from "#shared/permissions.ts";
import { applyChanges, stableStringify, type ProjectedState } from "#shared/project.ts";
import type { Change, EphEvent, Op, ServerMessage } from "#shared/protocol.ts";
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
};

async function newRoom(t: Engine, name: string): Promise<Room> {
  const dm = t.client();
  const { roomId } = await dm.createRoom(name);
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
  return { roomId, dm, ana, bree, tv, dmId, anaId, breeId, ground, dmSocket };
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
        assert.deepEqual(s.ana.view.scenes[upper]?.floor, { level: 1, name: "Upper floor" }, "a player's floor is its level and name alone");
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
    assert.deepEqual(s.ana.view.scenes[attic]?.floor, { level: 1, name: "Attic" }, "levels renumbered among the floors held");
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
