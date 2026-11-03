import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import yauzl from "yauzl";
import yazl from "yazl";
import { uuidv7 } from "#shared/ids.ts";
import { OP_VERSION, SNAPSHOT_VERSION } from "#shared/migrate.ts";
import type { RoomState } from "#shared/model.ts";
import type { ProjectedState } from "#shared/project.ts";
import type { Change, Op } from "#shared/protocol.ts";
import type { RoomExport } from "./exportRoom.ts";
import { loadRoom } from "./persistence.ts";
import { startEngine, type Engine, type TestClient } from "./testing.ts";

/**
 * A scene's weather over the socket, in Postgres and through a backup
 * (docs/design/design-v1-weather.md 7, 9.3 and 9.4, lane WX-A).
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

function importZip(client: TestClient, zip: Buffer) {
  const form = Buffer.from(JSON.stringify({ playerPassword: "owlbear-druid-wand", dmName: "Importer" })).toString("base64url");
  return client.request("POST", "/api/rooms/import", undefined, { "content-type": "application/zip", "x-import-form": form }, zip);
}

const sceneChange = (changes: Change[], sceneId: string) => changes.find((c) => c.key === `scene:${sceneId}`);

describe("a scene's weather in a live room", () => {
  let t: Engine;
  before(async () => {
    t = await startEngine({ rooms: { idleUnloadMs: 60_000, actor: { snapshotOps: 1_000, snapshotIdleMs: 60_000 } } });
  });
  after(() => t.close());

  test("reaches a player on that scene only, and a player's own weather is refused", async () => {
    const dmClient = t.client();
    const { roomId } = await dmClient.createRoom("Weather");
    const playerClient = t.client();
    await playerClient.join(roomId, "Pat");
    const dm = await t.connect(roomId, dmClient);
    const road = ((await dm.snapshot("dm")).state as ProjectedState).meta.playerSceneId!;
    const player = await t.connect(roomId, playerClient);
    await player.snapshot("pat");

    const cave = uuidv7();
    await dm.apply({ t: "scene.create", scene: { id: cave, name: "Cave", bounds: { w: 20, h: 20 } } });
    // Weather the DM sets up on another scene never reaches the player's socket in any form.
    const fog = await dm.apply({ t: "scene.update", sceneId: cave, patch: { weather: { kind: "fog", heavy: true } } });
    assert.equal(fog.rejects, undefined);
    assert.equal(await player.maybe("ev", (m) => JSON.stringify(m).includes('"weather"'), 400), null);

    await dm.apply({ t: "scene.update", sceneId: road, patch: { weather: { kind: "rain", heavy: true, wind: "strong", toward: 135 } } });
    const seen = await player.next("ev", (m) => sceneChange(m.changes, road) !== undefined);
    const change = sceneChange(seen.changes, road);
    assert.ok(change && "value" in change);
    assert.deepEqual((change.value as { weather?: unknown }).weather, { kind: "rain", heavy: true, wind: "strong" }, "in its one stored form");

    const refused = await player.apply({ t: "scene.update", sceneId: road, patch: { weather: null } });
    assert.equal(refused.rejects?.[0]?.code, "forbidden");

    // Moved to the cave, the player gets its weather with it.
    await dm.apply({ t: "room.setPlayerScene", sceneId: cave });
    const moved = await player.next("ev", (m) => sceneChange(m.changes, cave) !== undefined);
    const caveChange = sceneChange(moved.changes, cave);
    assert.ok(caveChange && "value" in caveChange);
    assert.deepEqual((caveChange.value as { weather?: unknown }).weather, { kind: "fog", heavy: true });
    dm.close();
    player.close();
  });

  test("a stored version 42 op then a version 43 op replay, and a backup keeps the weather in its stored form", async () => {
    const owner = t.client();
    const { roomId } = await owner.createRoom("Stored weather");
    const s = await t.connect(roomId, owner);
    const road = ((await s.snapshot("c1")).state as ProjectedState).meta.playerSceneId!;
    s.close();
    await s.waitClosed();
    await t.manager.unload(roomId);

    const stored = await t.pool.query<{ seq: string; state: RoomState }>("select seq::text, state from room_snapshots where room_id = $1", [roomId]);
    const base = Number(stored.rows[0]!.seq);
    const dmId = Object.values(stored.rows[0]!.state.members).find((m) => m.kind === "dm")!.id;
    const ops: [Op, number][] = [
      [{ t: "scene.update", sceneId: road, patch: { name: "Forest road" } }, 42],
      [{ t: "scene.update", sceneId: road, patch: { weather: { kind: "snow", heavy: true, wind: "moderate", toward: 135 } } }, 43],
    ];
    for (const [i, [op, version]] of ops.entries()) {
      await t.pool.query(
        `insert into room_ops (room_id, seq, at, actor_member_id, actor_role, op, op_version)
         values ($1, $2, now(), $3, 'dm', $4::jsonb, $5)`,
        [roomId, base + 1 + i, dmId, JSON.stringify(op), version],
      );
    }
    const loaded = await loadRoom(t.pool, roomId);
    assert.ok(loaded && !loaded.replayFailed);
    assert.equal(loaded.state.scenes[road]!.name, "Forest road");
    assert.deepEqual(loaded.state.scenes[road]!.weather, { kind: "snow", heavy: true, wind: "moderate" });

    const back = await t.connect(roomId, owner);
    await back.snapshot("c2");
    const res = await owner.get(`/api/rooms/${roomId}/export`);
    assert.equal(res.statusCode, 200, res.body);
    const room = JSON.parse((await unzip(res.rawPayload)).get("room.json")!.toString()) as RoomExport;
    assert.equal(room.schemaVersion, SNAPSHOT_VERSION);
    assert.ok(OP_VERSION >= 43);
    assert.deepEqual(room.state.scenes[road]!.weather, { kind: "snow", heavy: true, wind: "moderate" });

    // A backup spelled longhand lands in the one stored form.
    room.state.scenes[road]!.weather = { kind: "snow", heavy: true, wind: "moderate", toward: 135 };
    const imported = await importZip(t.client(), await zipOf({ "room.json": JSON.stringify(room) }));
    assert.equal(imported.statusCode, 201, imported.body);
    const newId = imported.json<{ roomId: string }>().roomId;
    t.track(newId);
    const { rows } = await t.pool.query<{ state: RoomState }>("select state from room_snapshots where room_id = $1", [newId]);
    const scenes = Object.values(rows[0]!.state.scenes);
    assert.deepEqual(scenes.find((sc) => sc.name === "Forest road")!.weather, { kind: "snow", heavy: true, wind: "moderate" });

    // An impossible weather in a hand-made backup is refused whole.
    for (const bad of [{ kind: "fog", wind: "strong" }, { kind: "sand", heavy: true }, { kind: "clear" }]) {
      (room.state.scenes[road] as unknown as { weather: unknown }).weather = bad;
      const refused = await importZip(t.client(), await zipOf({ "room.json": JSON.stringify(room) }));
      assert.equal(refused.statusCode, 400, `${JSON.stringify(bad)}: ${refused.body}`);
    }
    back.close();
  });
});
