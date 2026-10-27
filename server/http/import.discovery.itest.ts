import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import yauzl from "yauzl";
import yazl from "yazl";
import type { RoomState } from "#shared/model.ts";
import type { RoomExport } from "../rooms/exportRoom.ts";
import { startEngine, type Engine, type TestClient } from "../rooms/testing.ts";

/**
 * A room import takes the map discovery upgrade step (docs/design-v1-map-discovery.md
 * 5.5): every scene it brings is marked played, and each with fog and party vision on
 * shares the room, whatever the file's version, since the room is stored at today's
 * version and loadRoom never upgrades it.
 */

async function unzip(buffer: Buffer): Promise<Map<string, Buffer>> {
  const zip = await yauzl.fromBufferPromise(buffer);
  const out = new Map<string, Buffer>();
  for await (const entry of zip.eachEntry()) {
    const stream = await zip.openReadStreamPromise(entry);
    const chunks: Buffer[] = [];
    for await (const chunk of stream as AsyncIterable<Buffer>) chunks.push(chunk);
    out.set(entry.fileName, Buffer.concat(chunks));
  }
  return out;
}

function zipOf(entries: Record<string, string>): Promise<Buffer> {
  const zip = new yazl.ZipFile();
  for (const [name, data] of Object.entries(entries)) zip.addBuffer(Buffer.from(data), name);
  zip.end();
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    zip.outputStream.on("data", (c: Buffer) => chunks.push(c));
    zip.outputStream.on("end", () => resolve(Buffer.concat(chunks)));
    zip.outputStream.on("error", reject);
  });
}

const S3 = { id: "0199f0a0-0000-7000-8000-000000000003", rev: 0, name: "Crypt", order: 1, bounds: { w: 20, h: 20 }, grid: { show: true, color: "#ffffff", opacity: 0.25, lineWidth: 1 }, background: "#2b2b31", fogEnabled: true, vision: { on: true, light: "dark" }, wallsVersion: 0 };

describe("a room import and the map discovery upgrade (5.5)", () => {
  let t: Engine;
  before(async () => {
    t = await startEngine();
  });
  after(() => t.close());

  async function exported(client: TestClient): Promise<RoomExport> {
    const { roomId } = await client.createRoom("Before discovery");
    const res = await client.get(`/api/rooms/${roomId}/export`);
    const room = JSON.parse((await unzip(res.rawPayload)).get("room.json")!.toString()) as RoomExport;
    return { ...room, state: { ...room.state, scenes: { ...room.state.scenes, [S3.id]: S3 as RoomState["scenes"][string] } } };
  }

  async function imported(file: RoomExport): Promise<RoomState> {
    const fields = { playerPassword: "owlbear-druid-wand", dmName: "Importer" };
    const headers = { "content-type": "application/zip", "x-import-form": Buffer.from(JSON.stringify(fields)).toString("base64url") };
    const res = await t.client().request("POST", "/api/rooms/import", undefined, headers, await zipOf({ "room.json": JSON.stringify(file) }));
    assert.equal(res.statusCode, 201, res.body);
    const roomId = res.json<{ roomId: string }>().roomId;
    t.track(roomId);
    const { rows } = await t.pool.query<{ state: RoomState }>("select state from room_snapshots where room_id = $1", [roomId]);
    return rows[0]!.state;
  }

  const crypt = (state: RoomState) => Object.values(state.scenes).find((s) => s.name === "Crypt")!.id;

  test("a file from before map discovery: every scene marked played, the one with fog and party vision sharing", async () => {
    const file = await exported(t.client());
    const { memory: _m, memoryBy: _b, playedScenes: _p, memoryShared: _s, ...v26 } = file.state;
    const state = await imported({ ...file, schemaVersion: 26, state: v26 as RoomState });
    assert.deepEqual(Object.keys(state.playedScenes!).sort(), Object.keys(state.scenes).sort());
    assert.ok(Object.keys(state.scenes).length >= 2);
    assert.deepEqual(Object.keys(state.memoryShared!), [crypt(state)]);
    assert.deepEqual([state.memory, state.memoryBy], [{}, {}]);
  });

  test("a file from today: its scenes come back marked too, under their new ids", async () => {
    const state = await imported(await exported(t.client()));
    assert.deepEqual(Object.keys(state.playedScenes!).sort(), Object.keys(state.scenes).sort());
    for (const [id, mark] of Object.entries(state.playedScenes!)) assert.deepEqual(mark, { sceneId: id, rev: 0 });
    assert.deepEqual(Object.keys(state.memoryShared!), [crypt(state)]);
  });
});
