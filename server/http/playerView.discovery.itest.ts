import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { lift, remember } from "#shared/discoveryTestutil.ts";
import { uuidv7 } from "#shared/ids.ts";
import { chunkKey, tileKey } from "#shared/keys.ts";
import { CHUNK_CELLS, type BuildChunk, type RoomState, type Scene, type TerrainId } from "#shared/model.ts";
import type { ProjectedState } from "#shared/project.ts";
import { decodeTile } from "#shared/rules/fog.ts";
import { token } from "#shared/testutil.ts";
import { formatDisplayCode } from "../auth/displaySessions.ts";
import { startEngine, type Engine, type TestClient } from "../rooms/testing.ts";
import type { PlayerView } from "./playerView.ts";

/*
 * The map export's player view (docs/design-v1-map-discovery.md 4 and 5.1):
 * a scene the players left answers what they hold of it, remembered ground
 * as last seen, nothing of ground never seen, the live build where the DM
 * revealed it, and the players' own scene what a table display holds.
 */

type Rect = { x: number; y: number; w: number; h: number };

/** Paints cells into a scene's chunks, new chunk objects in a new collection, as the reducer writes them. */
function paint(state: RoomState, sceneId: string, r: Rect, terrain: TerrainId = "stone"): void {
  for (let y = r.y; y < r.y + r.h; y++) {
    for (let x = r.x; x < r.x + r.w; x++) {
      const cx = Math.floor(x / CHUNK_CELLS);
      const cy = Math.floor(y / CHUNK_CELLS);
      const key = chunkKey(sceneId, cx, cy);
      const old: BuildChunk = state.buildChunks[key] ?? { sceneId, cx, cy, rev: 1, cells: {}, edges: {} };
      state.buildChunks = { ...state.buildChunks, [key]: { ...old, cells: { ...old.cells, [`${x},${y}`]: terrain } } };
    }
  }
}

function addScene(state: RoomState, name: string, patch: Partial<Scene>): string {
  const base = state.scenes[state.meta.playerSceneId!]!;
  const id = uuidv7();
  state.scenes = { ...state.scenes, [id]: { ...base, id, name, order: Object.keys(state.scenes).length, fogEnabled: true, vision: { on: true, light: "bright" }, bounds: { w: 32, h: 16 }, ...patch } };
  return id;
}

const stamp = (sceneId: string, x: number, y: number, visibility: "all" | "dm") => ({ id: uuidv7(), rev: 0, sceneId, art: { key: "chest" }, x, y, w: 1, h: 1, rotation: 0, z: 0, visibility });

type Table = {
  t: Engine;
  roomId: string;
  dm: TestClient;
  pip: TestClient;
  tv: TestClient;
  /** The scene the players left, a per-player one they left too, and theirs, with the ids of what each case reads. */
  crypt: string;
  tower: string;
  camp: string;
  ids: { altar: string; hoard: string; seen: string; hidden: string; campSign: string; campDark: string; campHidden: string };
  state: RoomState;
};

/**
 * A room whose players have left the Crypt for the Camp. In the Crypt the
 * DM revealed the west end, the party explored as far as x = 11 and never
 * saw the rest, and since they left the DM turned (8, 4) and (2, 4) to wood
 * and renamed the altar, which the party remembers as before. Pip's
 * character still stands there, whose sight would cover all of it. The
 * room is written straight into the stored snapshot, since memory is the
 * server's own to write.
 */
async function table(t: Engine, edit: (s: RoomState) => void = () => {}): Promise<Table> {
  const dm = t.client();
  const { roomId } = await dm.createRoom("Player view");
  const pip = t.client();
  const pipId = await pip.join(roomId, "Pip");
  const code = await dm.post(`/api/rooms/${roomId}/display/code`);
  const tv = t.client();
  assert.equal((await tv.post("/api/display/redeem", { code: formatDisplayCode(code.json<{ code: string }>().code) })).statusCode, 200);
  // Loaded, then unloaded with a snapshot, so the stored snapshot is the whole room and no op replays over the edit.
  await t.manager.acquire(roomId);
  await t.manager.unload(roomId);
  const { rows } = await t.pool.query<{ state: RoomState }>("select state from room_snapshots where room_id = $1", [roomId]);
  const state = rows[0]!.state;
  const camp = state.meta.playerSceneId!;
  const crypt = addScene(state, "Crypt", {});
  const tower = addScene(state, "Tower", { vision: { on: true, light: "bright", perPlayer: true } });
  const seen = stamp(crypt, 1.5, 2.5, "all");
  const hidden = stamp(crypt, 1.5, 1.5, "dm");
  const campHidden = stamp(camp, 1.5, 1.5, "dm");
  const ids = { altar: uuidv7(), hoard: uuidv7(), seen: seen.id, hidden: hidden.id, campSign: uuidv7(), campDark: uuidv7(), campHidden: campHidden.id };

  paint(state, crypt, { x: 0, y: 0, w: 12, h: 8 });
  paint(state, crypt, { x: 12, y: 0, w: 4, h: 8 }, "water");
  paint(state, crypt, { x: 2, y: 4, w: 1, h: 1 }, "wood");
  paint(state, crypt, { x: 8, y: 4, w: 1, h: 1 }, "wood");
  lift(state, "dm", { x: 0, y: 0, w: 4, h: 8 }, crypt);
  lift(state, "party", { x: 0, y: 0, w: 12, h: 8 }, crypt);
  remember(state, null, 0, 0, { cells: { "2,4": "stone", "8,4": "stone" }, labels: { [ids.altar]: { id: ids.altar, rev: 0, sceneId: crypt, x: 9, y: 5, text: "Altar", size: 1 } } }, crypt);
  state.labels = {
    ...state.labels,
    [ids.altar]: { id: ids.altar, rev: 1, sceneId: crypt, x: 9, y: 5, text: "Pit trap", size: 1 },
    [ids.hoard]: { id: ids.hoard, rev: 0, sceneId: crypt, x: 26, y: 5, text: "Hoard", size: 1 },
  };
  state.stamps = { ...state.stamps, [seen.id]: seen, [hidden.id]: hidden };
  const pc = (sceneId: string, x: number, y: number) => token(uuidv7(), { sceneId, kind: "pc", name: "Pip's", disposition: "ally", ownerIds: [pipId], x, y });
  const inCrypt = pc(crypt, 4, 4);

  // The Tower: per player, Pip seeing for himself. The party explored its west half and Pip alone its east half.
  paint(state, tower, { x: 0, y: 0, w: 10, h: 4 });
  lift(state, "party", { x: 0, y: 0, w: 5, h: 4 }, tower);
  lift(state, { holder: pipId }, { x: 5, y: 0, w: 5, h: 4 }, tower);
  remember(state, pipId, 0, 0, { cells: { "6,1": "wood" } }, tower);
  state.holders = { ...state.holders, [tower]: { sceneId: tower, rev: 1, entries: [{ memberId: pipId, on: true }] } };

  // The Camp, where the players are: fog and party vision on, Pip's character in a room the party explored, which
  // the DM changed at (5, 3) in their sight, a sign in the dark and a stamp the DM keeps to themselves.
  state.scenes = { ...state.scenes, [camp]: { ...state.scenes[camp]!, fogEnabled: true, vision: { on: true, light: "bright" } } };
  paint(state, camp, { x: 0, y: 0, w: 10, h: 6 });
  paint(state, camp, { x: 5, y: 3, w: 1, h: 1 }, "wood");
  paint(state, camp, { x: 14, y: 8, w: 4, h: 4 }, "dirt");
  lift(state, "dm", { x: 0, y: 0, w: 3, h: 6 }, camp);
  lift(state, "party", { x: 0, y: 0, w: 10, h: 6 }, camp);
  remember(state, null, 0, 0, { cells: { "5,3": "stone" } }, camp);
  const inCamp = pc(camp, 2, 2);
  state.labels = {
    ...state.labels,
    [ids.campSign]: { id: ids.campSign, rev: 0, sceneId: camp, x: 4, y: 2, text: "Camp", size: 1 },
    [ids.campDark]: { id: ids.campDark, rev: 0, sceneId: camp, x: 15, y: 9, text: "Ambush", size: 1 },
  };
  state.stamps = { ...state.stamps, [campHidden.id]: campHidden };
  state.tokens = { ...state.tokens, [inCrypt.id]: inCrypt, [inCamp.id]: inCamp };
  edit(state);
  await t.pool.query("update room_snapshots set state = $2 where room_id = $1", [roomId, JSON.stringify(state)]);
  return { t, roomId, dm, pip, tv, crypt, tower, camp, ids, state };
}

const url = (roomId: string, sceneId: string) => `/api/rooms/${roomId}/scenes/${sceneId}/player-view`;

async function viewOf(table: Table, sceneId: string): Promise<PlayerView> {
  const res = await table.dm.get(url(table.roomId, sceneId));
  assert.equal(res.statusCode, 200, res.body);
  assert.equal(res.headers["cache-control"], "no-store");
  return res.json<PlayerView>();
}

const cellsOf = (view: PlayerView): Record<string, string> => Object.assign({}, ...Object.values(view.buildChunks).map((c) => c.cells));

describe("the map export's player view (map discovery 4, 5.1)", () => {
  let t: Engine;
  before(async () => {
    t = await startEngine();
  });
  after(() => t.close());

  test("a scene the players left: remembered ground as last seen, nothing never seen, the live build where the DM revealed it", async () => {
    const room = await table(t);
    const view = await viewOf(room, room.crypt);
    assert.deepEqual(Object.keys(view).sort(), ["buildChunks", "fogTiles", "labels", "scene", "stamps"]);
    const cells = cellsOf(view);
    // Out of everyone's sight now, though Pip's character stands beside it: as the party last saw it.
    assert.equal(cells["8,4"], "stone");
    // The DM revealed it, so it is live, and the memory there counts for nothing.
    assert.equal(cells["2,4"], "wood");
    assert.equal(cells["5,4"], "stone");
    for (let y = 0; y < 8; y++) for (let x = 12; x < 16; x++) assert.equal(cells[`${x},${y}`], undefined, `never-seen cell ${x},${y}`);
    assert.ok(!JSON.stringify(view).includes("water"), "nothing of the unexplored end");
    assert.deepEqual(Object.keys(view.buildChunks), [chunkKey(room.crypt, 0, 0)]);
    assert.equal(view.labels[room.ids.altar]?.text, "Altar");
    assert.equal(view.labels[room.ids.hoard], undefined);
    assert.deepEqual(Object.keys(view.stamps), [room.ids.seen]);
    assert.equal(view.scene.id, room.crypt);
    assert.equal(view.scene.autoWalls, "off");
    // The fog is the DM's layer and the party's merged, and no memory or explored layer goes on its own.
    const key = tileKey(room.crypt, 0, 0);
    assert.deepEqual(Object.keys(view.fogTiles), [key]);
    assert.equal(view.fogTiles[key]!.rev, 0);
    assert.deepEqual(decodeTile(view.fogTiles[key]!.bits), decodeTile(room.state.exploredTiles[key]!.bits));
    const text = JSON.stringify(view);
    for (const word of ["memory", "explored", "holders", "Pit trap", "Hoard"]) assert.ok(!text.includes(word), `${word} in the answer`);
    for (const value of [...Object.values(view.buildChunks), ...Object.values(view.labels), ...Object.values(view.stamps), ...Object.values(view.fogTiles)]) {
      assert.equal(value.sceneId, room.crypt);
    }
  });

  test("a per-player scene answers the shared class: a sight holder's own ground and memory stay theirs", async () => {
    const room = await table(t);
    const cells = cellsOf(await viewOf(room, room.tower));
    for (let x = 0; x < 10; x++) assert.equal(cells[`${x},1`], x < 5 ? "stone" : undefined, `cell ${x},1`);
  });

  test("the players' own scene answers what a table display's snapshot holds of it", async () => {
    const room = await table(t);
    const view = await viewOf(room, room.camp);
    const socket = await t.connectDisplay(room.roomId, room.tv);
    const shown = (await socket.snapshot("tv")).state as ProjectedState;
    assert.deepEqual(view, { scene: shown.scenes[room.camp], buildChunks: shown.buildChunks, labels: shown.labels, stamps: shown.stamps, fogTiles: shown.fogTiles });
    const cells = cellsOf(view);
    // In the party's sight it is live. Out of it, as they remember it.
    assert.equal(cells["5,3"], "wood");
    assert.equal(cells["14,8"], undefined);
    assert.deepEqual(Object.keys(view.labels), [room.ids.campSign]);
    assert.deepEqual(view.stamps, {});
    socket.ws.close();
  });

  test("behind a blackout the players' scene answers what they remember, as nobody looks at it", async () => {
    const room = await table(t, (s) => (s.meta.view = { ...s.meta.view, blackout: true }));
    const cells = cellsOf(await viewOf(room, room.camp));
    assert.equal(cells["5,3"], "stone");
    assert.equal(cells["1,3"], "stone");
    assert.equal(cells["14,8"], undefined);
  });

  test("DM only, by scene, and limited", async () => {
    const room = await table(t);
    const player = await room.pip.get(url(room.roomId, room.crypt));
    assert.equal(player.statusCode, 403);
    assert.equal(player.json<{ error: string }>().error, "dm_only");
    assert.equal((await room.tv.get(url(room.roomId, room.crypt))).statusCode, 403);
    assert.equal((await t.client().get(url(room.roomId, room.crypt))).statusCode, 403);
    let last = player;
    for (const id of [uuidv7(), "__proto__", "constructor", "x".repeat(65)]) {
      last = await room.dm.get(url(room.roomId, id));
      assert.equal(last.statusCode, 404, id);
      assert.equal(last.json<{ error: string }>().error, "not_found");
    }
    for (let i = 0; i < 40 && last.statusCode !== 429; i++) last = await room.dm.get(url(room.roomId, room.crypt));
    assert.equal(last.statusCode, 429);
    assert.ok(Number(last.headers["retry-after"]) > 0);
  });
});
