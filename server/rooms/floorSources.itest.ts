import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { uuidv7 } from "#shared/ids.ts";
import { createInitialState } from "#shared/initial.ts";
import { LIMITS } from "#shared/limits.ts";
import type { Member, RoomState } from "#shared/model.ts";
import type { ProjectedState } from "#shared/project.ts";
import { clientOpSchema, type Op, type ServerMessage } from "#shared/protocol.ts";
import { applyOp } from "#shared/reducer.ts";
import { floorProblem, floorsOf } from "#shared/rules/floors.ts";
import { solid } from "../assets/testImages.ts";
import { floorFullWords } from "./actor.ts";
import { projectedSceneBytes } from "./sizeGuard.ts";
import { startEngine, type Engine, type Socket, type TestClient } from "./testing.ts";

/**
 * Floors from a file or a dungeon on the server (docs/design/design-v1-floors.md
 * phase 3, 3.1 to 3.4): a file floor's import is one Setup step that Undo
 * setup takes whole, a build op past the scene's budget keeps its plain
 * words while the floor stands, an answer lost to a dropped socket leaves
 * the floor under the name the server stored, and a co-DM's edit of the
 * floor beside changes a Like floor but never a picked one, whichever side
 * of the add it lands. The privacy twins live in floors.wire.itest.ts.
 */

type Table = { roomId: string; dm: TestClient; dmKey: string; dmSocket: Socket; ground: string };

async function table(t: Engine, name: string): Promise<Table> {
  const dm = t.client();
  const { roomId, dmKey } = await dm.createRoom(name);
  const dmSocket = await t.connect(roomId, dm);
  const ground = ((await dmSocket.snapshot("dm")).state as ProjectedState).meta.playerSceneId!;
  await ok(dmSocket, { t: "scene.update", sceneId: ground, patch: { name: "Tower" } });
  return { roomId, dm, dmKey, dmSocket, ground };
}

async function ok(socket: Socket, op: Op): Promise<Extract<ServerMessage, { t: "ev" }>> {
  const ev = await socket.apply(op);
  assert.deepEqual(ev.rejects ?? [], [], `${op.t} was refused`);
  return ev;
}

/** Sends ops in one Setup group, as the import sends them, and waits for every answer, returning the refusals by each op's place in `ops`. */
async function send(socket: Socket, ops: readonly Op[], g: string = uuidv7()): Promise<{ n: number; code: string; message: string }[]> {
  const waiting = new Map<number, number>();
  for (const [i, op] of ops.entries()) {
    const n = socket.nextN();
    waiting.set(n, i);
    socket.send({ t: "op", n, op, g, groupScope: "setup" });
  }
  const refused: { n: number; code: string; message: string }[] = [];
  while (waiting.size > 0) {
    const ev = await socket.next("ev", (m) => (m.acks ?? []).some((n) => waiting.has(n)) || (m.rejects ?? []).some((r) => waiting.has(r.n)), 30_000);
    for (const n of ev.acks ?? []) waiting.delete(n);
    for (const r of ev.rejects ?? []) {
      const i = waiting.get(r.n);
      if (i === undefined) continue;
      refused.push({ n: i, code: r.code, message: r.message });
      waiting.delete(r.n);
    }
  }
  return refused;
}

/** The label of the newest Setup step, once the history covers every op the socket sent, left in the backlog for `step` to name the head from. */
async function setupLabel(socket: Socket): Promise<string | null> {
  const h = (await socket.next("history", (m) => m.watermark >= socket.n, 10_000)) as Extract<ServerMessage, { t: "history" }>;
  socket.received.push(h);
  return h.setup?.undo.head?.label ?? null;
}

const GRID = { show: true, color: "#ffffff", opacity: 0.25, lineWidth: 1 };
const live = (t: Engine, roomId: string): RoomState => t.manager.get(roomId)!.committed.state;
const on = <T extends { sceneId: string }>(records: Readonly<Record<string, T>> | undefined, sceneId: string) => Object.values(records ?? {}).filter((r) => r.sceneId === sceneId);
const wallId = (i: number) => `w${String(i).padStart(11, "0")}`;

/** A file floor's ops as the import sends them (uvtt/batch.ts importOps behind floorCreateOf): the add, its edges, free walls and lights. */
function fileFloor(sceneId: string, beside: string, map: { assetId: string; widthPx: number; heightPx: number }, name = "Crypt level 2"): Op[] {
  const own = { bounds: { w: 40, h: 30 }, background: "#1b1b20", grid: GRID, autoWalls: "off", map: { ...map, cellPx: 16, originPx: { x: 0, y: 0 } }, gridFromFile: true, fogEnabled: true, vision: { on: true, light: "dark", byClock: false } };
  return [
    { t: "scene.create", scene: { id: sceneId, name, bounds: { w: 40, h: 30 } }, floor: { beside, side: "above", name, own } },
    { t: "build.edge", sceneId, edges: [{ key: "4,3,w", feature: { kind: "wall" } }, { key: "5,3,n", feature: { kind: "door", state: "closed", secret: false, discovered: false } }] },
    { t: "build.walls", sceneId, put: [{ id: wallId(1), a: [1, 1], b: [6, 1], f: { kind: "wall" } }, { id: wallId(2), a: [6, 1], b: [6, 4.5], f: { kind: "window" } }] },
    { t: "build.lights", sceneId, put: [{ id: uuidv7(), x: 3, y: 3, bright: 20, dim: 40, on: true, walls: true }] },
  ] as Op[];
}

describe("floors from a file or a dungeon on the server (phase 3)", () => {
  let t: Engine;
  before(async () => {
    t = await startEngine({ rooms: { idleUnloadMs: 60_000, actor: { snapshotOps: 1_000, snapshotIdleMs: 60_000 } } });
  });
  after(() => t.close());

  async function uploadMap(r: Table) {
    const res = await r.dm.request("PUT", `/api/rooms/${r.roomId}/assets?kind=map`, undefined, { "content-type": "image/png" }, await solid(640, 480, "#264").png().toBuffer());
    assert.equal(res.statusCode, 200);
    const asset = res.json<{ id: string; width: number; height: number }>();
    return { assetId: asset.id, widthPx: asset.width, heightPx: asset.height };
  }

  test("a file floor's import is one Setup step named by its floor: Undo setup takes the floor and every wall, door and light, and Redo brings them back", async () => {
    const r = await table(t, "File floor");
    const crypt = uuidv7();
    assert.deepEqual(await send(r.dmSocket, fileFloor(crypt, r.ground, await uploadMap(r))), []);
    const made = live(t, r.roomId);
    assert.equal(made.scenes[crypt]?.floor?.name, "Crypt level 2");
    assert.deepEqual([made.scenes[crypt]?.bounds, made.scenes[crypt]?.gridFromFile, made.scenes[crypt]?.autoWalls], [{ w: 40, h: 30 }, true, "off"]);
    assert.equal(on(made.lights, crypt).length, 1);
    assert.ok(on(made.buildChunks, crypt).length > 0, "its edges and free walls stand");
    assert.equal(floorProblem(made, r.ground), null);
    assert.match((await setupLabel(r.dmSocket)) ?? "", /^adding .*Crypt level 2/);

    const undone = await r.dmSocket.step("undo", "setup");
    assert.equal(undone.rejects, undefined);
    const back = live(t, r.roomId);
    assert.equal(back.scenes[crypt], undefined);
    assert.equal(back.scenes[r.ground]?.floor, undefined, "Tower is a plain scene again");
    assert.deepEqual([on(back.lights, crypt).length, on(back.buildChunks, crypt).length], [0, 0]);

    assert.equal((await r.dmSocket.step("redo", "setup")).rejects, undefined);
    const redone = live(t, r.roomId);
    // A restore writes its own revision and walls version, so the floor is compared without them.
    const settings = (state: RoomState) => {
      const { rev: _rev, wallsVersion: _walls, ...rest } = state.scenes[crypt]!;
      return rest;
    };
    assert.deepEqual(settings(redone), settings(made));
    assert.deepEqual([on(redone.lights, crypt).length, on(redone.buildChunks, crypt).length], [on(made.lights, crypt).length, on(made.buildChunks, crypt).length]);
    r.dmSocket.close();
  });

  test("an answer lost to a dropped socket leaves the floor under the name the server stored, numbered when taken", async () => {
    const r = await table(t, "Lost answer");
    const first = uuidv7();
    assert.deepEqual(await send(r.dmSocket, fileFloor(first, r.ground, await uploadMap(r), "Crypt")), []);
    const second = uuidv7();
    const [create] = fileFloor(second, first, await uploadMap(r), "Crypt");
    r.dmSocket.send({ t: "op", n: r.dmSocket.nextN(), op: create, g: uuidv7(), groupScope: "setup" });
    for (let i = 0; i < 50 && !live(t, r.roomId).scenes[second]; i++) await new Promise((resolve) => setTimeout(resolve, 20));
    // The connection drops before the device reads its answer.
    r.dmSocket.terminate();
    const again = await t.connect(r.roomId, r.dm);
    const seen = (await again.snapshot("dm-again")).state as ProjectedState;
    assert.equal(seen?.scenes[second]?.floor?.name, "Crypt 2");
    assert.deepEqual(floorsOf(live(t, r.roomId), r.ground).map((s) => s.floor?.name), ["Ground floor", "Crypt", "Crypt 2"]);
    again.close();
  });

  test("a co-DM's edit of the floor beside: a picked floor holds its pick whichever side of the add the edit lands, and a Like floor takes the floor beside as it is then", async () => {
    for (const editFirst of [true, false]) {
      const r = await table(t, editFirst ? "Edit before" : "Edit after");
      const co = t.client();
      await co.claimDm(r.roomId, r.dmKey);
      const coSocket = await t.connect(r.roomId, co);
      await coSocket.snapshot("co");
      await ok(r.dmSocket, { t: "scene.update", sceneId: r.ground, patch: { fogEnabled: true, vision: { on: true, light: "bright" } } } as Op);
      const own = { bounds: { w: 30, h: 30 }, background: "#141418", grid: GRID, autoWalls: "all" };
      const picked = uuidv7();
      const like = uuidv7();
      const edit: Op = { t: "scene.update", sceneId: r.ground, patch: { fogEnabled: true, vision: { on: false, light: "bright" } } };
      if (editFirst) await ok(coSocket, edit);
      await ok(r.dmSocket, { t: "scene.create", scene: { id: picked, name: "Tower", bounds: { w: 30, h: 30 } }, floor: { beside: r.ground, side: "above", name: "Crypt", own: { ...own, fogEnabled: true, vision: { on: true, light: "bright", byClock: false } } } } as Op);
      await ok(r.dmSocket, { t: "scene.create", scene: { id: like, name: "Tower", bounds: { w: 30, h: 30 } }, floor: { beside: r.ground, side: "above", name: "Attic", own } } as Op);
      if (!editFirst) await ok(coSocket, edit);
      const state = live(t, r.roomId);
      assert.deepEqual(state.scenes[picked]?.vision, { on: true, light: "bright" }, `${editFirst ? "before" : "after"}: the picked floor holds Explore`);
      assert.deepEqual(state.scenes[like]?.vision, editFirst ? { on: false, light: "bright" } : { on: true, light: "bright" }, `${editFirst ? "before" : "after"}: Like copies the floor beside as the add found it`);
      coSocket.close();
      r.dmSocket.close();
    }
  });
});

/** Free walls as the import sends them, filling `ops` ops of the most walls each, in rows across the floor. */
function wallOps(sceneId: string, ops: number): Op[] {
  return Array.from({ length: ops }, (_, k): Op => ({
    t: "build.walls",
    sceneId,
    put: Array.from({ length: LIMITS.freeWallsPerOp }, (_, i) => {
      const x = 1 + (i % 38);
      const y = 1 + Math.floor(i / 38) / 2 + k * 0.125;
      return { id: wallId(k * LIMITS.freeWallsPerOp + i), a: [x, y] as [number, number], b: [x + 0.5, y] as [number, number], f: { kind: "wall" as const } };
    }),
  }));
}

describe("a file floor refused partway (phase 3, 3.4)", () => {
  let t: Engine;
  const OWN = { bounds: { w: 40, h: 30 }, background: "#1b1b20", grid: GRID, autoWalls: "off", fogEnabled: true, vision: { on: true, light: "dark", byClock: false } };
  const importOf = (ground: string, crypt: string): Op[] => [
    { t: "scene.update", sceneId: ground, patch: { name: "Tower" } },
    { t: "scene.create", scene: { id: crypt, name: "Crypt", bounds: { w: 40, h: 30 } }, floor: { beside: ground, side: "above", name: "Crypt", own: OWN } } as Op,
    ...wallOps(crypt, LIMITS.freeWallsPerScene / LIMITS.freeWallsPerOp),
  ];
  // The scene's projected bytes after the floor's add and after its last walls, by the shared reducer, so the limit falls between them.
  const bytes = (() => {
    const dm: Member = { id: uuidv7(), rev: 1, name: "DM", color: "#ffffff", kind: "dm", createdAt: "2026-01-01T00:00:00.000Z" };
    let state = createInitialState({ roomName: "Full tower", dm, now: dm.createdAt });
    const ground = state.meta.playerSceneId!;
    const out: number[] = [];
    for (const [i, op] of importOf(ground, uuidv7()).entries()) {
      const r = applyOp(state, clientOpSchema.parse(op) as Op, { memberId: dm.id, role: "dm" }, { seq: i + 1, at: dm.createdAt });
      assert.ok(r.ok, `${op.t}: ${r.ok ? "" : r.message}`);
      state = r.state;
      out.push(projectedSceneBytes(state, ground));
    }
    return out;
  })();
  before(async () => {
    t = await startEngine({ rooms: { idleUnloadMs: 60_000, actor: { sizeLimits: { sceneLimit: Math.round((bytes[1]! + bytes.at(-1)!) / 2) } } } });
  });
  after(() => t.close());

  test("the floor stands, a build op after it is refused in its own words, not the floors', and one Undo setup takes back what landed", async () => {
    assert.ok(bytes.at(-1)! - bytes[1]! > 64 * 1024, `the walls weigh ${bytes.at(-1)! - bytes[1]!} bytes`);
    const r = await table(t, "Full tower");
    const crypt = uuidv7();
    const [, ...ops] = importOf(r.ground, crypt);
    const refused = await send(r.dmSocket, ops);
    assert.ok(refused.length > 0, "the scene's budget refuses part of the import");
    assert.ok(refused.every((x) => x.n > 0), "never the floor itself");
    assert.ok(refused.every((x) => x.code === "quota" && x.message !== floorFullWords("Tower")), JSON.stringify(refused));
    assert.equal(live(t, r.roomId).scenes[crypt]?.floor?.name, "Crypt");
    // One step, as the import's outcome says: the refused ops left the group whole.
    assert.equal((await r.dmSocket.step("undo", "setup")).rejects, undefined);
    const back = live(t, r.roomId);
    assert.equal(back.scenes[crypt], undefined);
    assert.equal(on(back.buildChunks, crypt).length, 0);
    r.dmSocket.close();
  });
});
