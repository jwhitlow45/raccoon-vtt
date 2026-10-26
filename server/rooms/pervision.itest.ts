import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { uuidv7 } from "#shared/ids.ts";
import { tileKey } from "#shared/keys.ts";
import type { LogEntry } from "#shared/model.ts";
import { applyChanges, stableStringify, type ProjectedState } from "#shared/project.ts";
import type { Change, Op, ServerMessage } from "#shared/protocol.ts";
import { formatDisplayCode } from "../auth/displaySessions.ts";
import { Socket, startEngine, type Engine, type TestClient } from "./testing.ts";

/**
 * Per-player vision over real sockets (docs/design-v1-per-player-vision.md
 * sections 6 and 7, lane PV3): two players on one dark per-player scene,
 * each with a character the other's cannot see. Each player's socket gets
 * only their own sight, fog, labels and stamps, a table display only what
 * every player shares, a DM's view as a player that player's view with no
 * whisper between players, and a reconnect's snapshot is what the `ev`
 * stream built.
 */

const inline = (senses: string) => ({
  inline: { hp: { cur: 12, max: 12, temp: 0 }, life: "alive", ac: 14, speeds: { walk: 30 }, initBonus: 2, passivePerception: 12, senses, effects: [], deathSaves: { ok: 0, fail: 0 }, notes: "", dmNotes: "" },
});

/** A socket and the projection its snapshot and every `ev` since built. */
type Seat = { socket: Socket; view: ProjectedState };

async function seat(socket: Socket, clientId: string): Promise<Seat> {
  const snap = await socket.snapshot(clientId);
  return { socket, view: snap.state as ProjectedState };
}

/** Folds every `ev` the socket was sent into its view, in order, up to the one that moves the marker to `x`. */
async function catchUp(s: Seat, markerId: string, x: number): Promise<void> {
  const moved = (m: ServerMessage) => m.t === "ev" && m.changes.some((c) => c.key === `token:${markerId}` && "value" in c && (c.value as { x?: number } | null)?.x === x);
  for (;;) {
    const msg = s.socket.received.shift() ?? (await s.socket.next("ev"));
    if (msg.t === "ev") s.view = applyChanges(s.view, msg.changes as Change[]);
    if (moved(msg)) return;
  }
}

type Table = {
  roomId: string;
  dm: TestClient;
  pip: TestClient;
  quin: TestClient;
  pipId: string;
  quinId: string;
  sceneId: string;
  dmSocket: Socket;
  seats: { pip: Seat; quin: Seat; display: Seat };
  ids: { pc: string; qc: string; gob: string; marker: string };
  /** Applies an op as the DM, then moves the marker every viewer sees, and folds every seat's events up to that move. */
  apply: (op: Op) => Promise<Extract<ServerMessage, { t: "ev" }>>;
  /** Moves the marker and folds every seat's events, and those of `more`, up to that move. */
  sync: (more?: Seat[]) => Promise<void>;
};

async function table(t: Engine): Promise<Table> {
  const dm = t.client();
  const { roomId } = await dm.createRoom("Per-player table");
  const pip = t.client();
  const pipId = await pip.join(roomId, "Pip");
  const quin = t.client();
  const quinId = await quin.join(roomId, "Quin");
  const dmSocket = await t.connect(roomId, dm);
  const dmView = (await dmSocket.snapshot("dm")).state as ProjectedState;
  const sceneId = dmView.meta.playerSceneId!;
  const code = await dm.post(`/api/rooms/${roomId}/display/code`);
  const tv = t.client();
  assert.equal((await tv.post("/api/display/redeem", { code: formatDisplayCode(code.json<{ code: string }>().code) })).statusCode, 200);
  const ids = { pc: uuidv7(), qc: uuidv7(), gob: uuidv7(), marker: uuidv7() };
  const create = (id: string, fields: Record<string, unknown>) => dmSocket.apply({ t: "token.create", token: { id, sceneId, kind: "monster", name: "Goblin", size: "medium", x: 2, y: 2, actor: inline(""), ...fields } } as Op);
  await dmSocket.apply({ t: "scene.update", sceneId, patch: { vision: { on: true, light: "dark", perPlayer: true } } });
  // The marker stands where every player sees it, exempt from fog and sight, so a move of it reaches every seat.
  // The battle mat is 30 by 20: Pip's character sees the west tile alone and Quin's the east one, 6 cells each way.
  await create(ids.marker, { name: "Marker", kind: "object", x: 15, y: 18, fogExempt: true });
  await create(ids.pc, { kind: "pc", name: "Pip's", disposition: "ally", ownerIds: [pipId], x: 3, y: 8, actor: inline("Darkvision 30 ft.") });
  await create(ids.qc, { kind: "pc", name: "Quin's", disposition: "ally", ownerIds: [quinId], x: 26, y: 8, actor: inline("Darkvision 30 ft.") });
  await create(ids.gob, { x: 6, y: 8 });
  await dmSocket.apply({ t: "build.label", sceneId, labelId: uuidv7(), label: { x: 5, y: 9, text: "Pip's camp", size: 1 } });
  await dmSocket.apply({ t: "build.label", sceneId, labelId: uuidv7(), label: { x: 25, y: 9, text: "Quin's cave", size: 1 } });
  await dmSocket.apply({ t: "build.stamps", sceneId, put: [{ id: uuidv7(), art: { key: "barrel" }, x: 4.5, y: 6.5, w: 1, h: 1, rotation: 0, z: 1, visibility: "all" }] } as Op);
  const seats = {
    pip: await seat(await t.connect(roomId, pip), "pip"),
    quin: await seat(await t.connect(roomId, quin), "quin"),
    display: await seat(await t.connectDisplay(roomId, tv), "tv"),
  };
  let markerX = 15;
  const sync = async (more: Seat[] = []) => {
    markerX = markerX === 15 ? 16 : 15;
    await dmSocket.apply({ t: "token.move", tokenId: ids.marker, x: markerX, y: 18 });
    for (const s of [...Object.values(seats), ...more]) await catchUp(s, ids.marker, markerX);
  };
  const apply = async (op: Op) => {
    const answered = await dmSocket.apply(op);
    await sync();
    return answered;
  };
  return { roomId, dm, pip, quin, pipId, quinId, sceneId, dmSocket, seats, ids, apply, sync };
}

const labelTexts = (v: ProjectedState) =>
  Object.values(v.labels)
    .map((l) => l.text)
    .sort();
const sightTiles = (v: ProjectedState) => Object.keys(v.sight ?? {}).sort();

describe("per-player vision over the socket", () => {
  let t: Engine;
  before(async () => {
    t = await startEngine();
  });
  after(() => t.close());

  test("a drag every player shows ends for the player who no longer sees it once the DM makes sight per player", async () => {
    const dm = t.client();
    const { roomId } = await dm.createRoom("Held drag");
    const pip = t.client();
    const pipId = await pip.join(roomId, "Pip");
    const quin = t.client();
    const quinId = await quin.join(roomId, "Quin");
    const dmSocket = await t.connect(roomId, dm);
    const sceneId = ((await dmSocket.snapshot("dm")).state as ProjectedState).meta.playerSceneId!;
    await dmSocket.apply({ t: "scene.update", sceneId, patch: { vision: { on: true, light: "dark" } } });
    const gob = uuidv7();
    for (const [id, fields] of [
      [uuidv7(), { kind: "pc", name: "Pip's", disposition: "ally", ownerIds: [pipId], x: 3, y: 8, actor: inline("Darkvision 30 ft.") }],
      [uuidv7(), { kind: "pc", name: "Quin's", disposition: "ally", ownerIds: [quinId], x: 26, y: 8, actor: inline("Darkvision 30 ft.") }],
      [gob, { x: 6, y: 8 }],
    ] as const) {
      await dmSocket.apply({ t: "token.create", token: { id, sceneId, kind: "monster", name: "Goblin", size: "medium", actor: inline(""), ...fields } } as Op);
    }
    const pipSocket = await t.connect(roomId, pip);
    await pipSocket.snapshot("pip");
    const quinSocket = await t.connect(roomId, quin);
    await quinSocket.snapshot("quin");
    // The party sees the goblin by Pip's character, so both players show the DM's drag of it.
    dmSocket.send({ t: "eph", sceneId, e: { k: "dragStart", tokenId: gob, x: 6, y: 8 } });
    for (const s of [pipSocket, quinSocket]) await s.next("eph", (m) => m.e.k === "dragStart");
    await dmSocket.apply({ t: "scene.update", sceneId, patch: { vision: { on: true, light: "dark", perPlayer: true } } });
    const ended = await quinSocket.next("eph", (m) => m.e.k === "dragCancel");
    assert.deepEqual(ended.e, { k: "dragCancel", tokenId: gob }, "Quin's character does not see the goblin, so Quin's drag ends");
    assert.equal(await pipSocket.maybe("eph", (m) => m.e.k === "dragCancel"), null, "Pip's sees it, so Pip's stays");
  });

  test("each player gets only their own sight, fog, labels, stamps and creatures, and the display only what every player shares", async () => {
    const tbl = await table(t);
    const { pip, quin, display } = tbl.seats;
    const s = tbl.sceneId;
    assert.deepEqual(sightTiles(pip.view), [`${s}:0,0`], "Pip's character sees the west tile");
    assert.deepEqual(sightTiles(quin.view), [`${s}:1,0`], "Quin's the east one");
    assert.deepEqual(sightTiles(display.view), [], "and the display, which shares only what every player sees, nothing");
    assert.ok(tbl.ids.gob in pip.view.tokens && !(tbl.ids.gob in quin.view.tokens) && !(tbl.ids.gob in display.view.tokens), "only Pip sees the goblin");
    assert.deepEqual(labelTexts(pip.view), ["Pip's camp"]);
    assert.deepEqual(labelTexts(quin.view), ["Quin's cave"]);
    assert.deepEqual(labelTexts(display.view), []);
    assert.equal(Object.keys(pip.view.stamps).length, 1, "Pip remembers the barrel's ground");
    assert.equal(Object.keys(quin.view.stamps).length + Object.keys(display.view.stamps).length, 0);
    assert.ok(pip.view.fogTiles[tileKey(s, 0, 0)] && !quin.view.fogTiles[tileKey(s, 0, 0)], "Pip's fog holds the ground Pip explored, Quin's does not");
    for (const v of [pip.view, quin.view, display.view]) assert.equal(stableStringify(v.sightAll ?? {}), stableStringify(pip.view.sightAll ?? {}), "the shared sight is the same for every viewer");
    for (const v of [pip.view, quin.view, display.view]) assert.ok(v.holders === undefined && v.exploredAny === undefined, "no player gets the DM's maps");

    // One batch: the goblin walks from Pip's sight into Quin's.
    await tbl.apply({ t: "token.move", tokenId: tbl.ids.gob, x: 24, y: 8 });
    assert.ok(!(tbl.ids.gob in pip.view.tokens) && tbl.ids.gob in quin.view.tokens && !(tbl.ids.gob in display.view.tokens));
  });

  test("a DM's view as Pip is Pip's view with no whisper between players, and a reconnect's snapshot is what the events built", async () => {
    const tbl = await table(t);
    const { pip, quin } = tbl.seats;
    pip.socket.op({ t: "log.whisper", to: [tbl.quinId], text: "meet me by the cave" });
    await tbl.sync();
    await tbl.apply({ t: "log.whisper", to: [tbl.pipId], text: "you hear a drip" });
    await tbl.apply({ t: "token.move", tokenId: tbl.ids.gob, x: 7, y: 9 });
    const preview = await Socket.open(`${t.url}/ws?room=${tbl.roomId}&as=${tbl.pipId}`, { origin: t.config.publicOrigin, cookie: `rvtt=${tbl.dm.token}`, "cf-connecting-ip": tbl.dm.ip, "user-agent": "pervision-itest" });
    const viewAsPip = await seat(preview, "dm");
    const whispers = (v: ProjectedState) => v.log.filter((l: LogEntry) => l.kind === "whisper").map((l) => l.text);
    assert.deepEqual(whispers(pip.view), ["meet me by the cave", "you hear a drip"]);
    assert.deepEqual(whispers(viewAsPip.view), ["you hear a drip"], "the preview leaves out the whisper between players");
    const unlike = (v: ProjectedState) => ({ ...v, log: v.log.filter((l) => !(l.kind === "whisper" && l.text === "meet me by the cave")) });
    assert.equal(stableStringify(viewAsPip.view), stableStringify(unlike(pip.view)), "otherwise it is Pip's view");
    // A batch later, Pip reconnects: the snapshot is the view Pip's events built, and the preview's events kept it Pip's.
    await tbl.dmSocket.apply({ t: "token.move", tokenId: tbl.ids.gob, x: 5, y: 7 });
    await tbl.sync([viewAsPip]);
    assert.equal(stableStringify(viewAsPip.view), stableStringify(unlike(pip.view)));
    pip.socket.close();
    const again = await seat(await t.connect(tbl.roomId, tbl.pip), "pip");
    assert.equal(stableStringify(again.view), stableStringify(pip.view), "Pip's snapshot after a reconnect");
    quin.socket.close();
    const quinAgain = await seat(await t.connect(tbl.roomId, tbl.quin), "quin");
    assert.equal(stableStringify(quinAgain.view), stableStringify(quin.view), "and Quin's");
    preview.close();
  });
});
