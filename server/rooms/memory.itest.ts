import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { uuidv7 } from "#shared/ids.ts";
import { chunkKey } from "#shared/keys.ts";
import type { BuildChunk, RoomState } from "#shared/model.ts";
import { applyChanges, stableStringify, type ProjectedState } from "#shared/project.ts";
import type { Change, Op, ServerMessage } from "#shared/protocol.ts";
import { loadRoom } from "./persistence.ts";
import { Socket, startEngine, type Engine, type TestClient } from "./testing.ts";

/**
 * Players' maps over real sockets and Postgres (docs/design-v1-map-discovery.md
 * 5.3, 6 and rule 3, lane MD3): with real sight, an edit out of the party's
 * sight on ground it explored is remembered in the batch that makes it, so no
 * frame a player's socket gets holds it, a replay of the stored ops and a
 * snapshot rebuild the same memory, and a reconnect shows the ground as last
 * seen. A player's walk the real build stops in the dark lands at its last
 * clear spot, stored as made, and only the sender is told it was blocked.
 */

const inline = (senses: string) => ({
  inline: { hp: { cur: 12, max: 12, temp: 0 }, life: "alive", ac: 14, speeds: { walk: 30 }, initBonus: 2, passivePerception: 12, senses, effects: [], deathSaves: { ok: 0, fail: 0 }, notes: "", dmNotes: "" },
});

/** A socket and the projection its snapshot and every `ev` since built, with every change it was sent. */
type Seat = { socket: Socket; view: ProjectedState; changes: Change[] };

async function seat(socket: Socket, clientId: string): Promise<Seat> {
  const snap = await socket.snapshot(clientId);
  return { socket, view: snap.state as ProjectedState, changes: [] };
}

/** Folds every `ev` the socket was sent into its view, in order, up to the one that moves the marker to `x`. */
async function catchUp(s: Seat, markerId: string, x: number): Promise<void> {
  const moved = (m: ServerMessage) => m.t === "ev" && m.changes.some((c) => c.key === `token:${markerId}` && "value" in c && (c.value as { x?: number } | null)?.x === x);
  for (;;) {
    const msg = s.socket.received.shift() ?? (await s.socket.next("ev"));
    if (msg.t === "ev") {
      s.changes.push(...(msg.changes as Change[]));
      s.view = applyChanges(s.view, msg.changes as Change[]);
    }
    if (moved(msg)) return;
  }
}

function chunkIn(view: ProjectedState | RoomState, sceneId: string, cx: number, cy: number): BuildChunk | undefined {
  return Object.values(view.buildChunks).find((c) => c.sceneId === sceneId && c.cx === cx && c.cy === cy);
}

type Table = { roomId: string; dm: TestClient; pip: TestClient; sceneId: string; dmSocket: Socket; pipSeat: Seat; pc: string; sync: () => Promise<void> };

/**
 * A dark battle mat with fog and party vision on, a stone corridor along
 * rows 3 to 7, and Pip's character with darkvision 30 ft at (2, 5), so the
 * party sees the corridor out to x = 8.
 */
async function table(t: Engine): Promise<Table> {
  const dm = t.client();
  const { roomId } = await dm.createRoom("Players' maps");
  const pip = t.client();
  const pipId = await pip.join(roomId, "Pip");
  const dmSocket = await t.connect(roomId, dm);
  const sceneId = ((await dmSocket.snapshot("dm")).state as ProjectedState).meta.playerSceneId!;
  await dmSocket.apply({ t: "scene.update", sceneId, patch: { fogEnabled: true, blockMovement: true, vision: { on: true, light: "dark" } } });
  const cells: string[] = [];
  for (let y = 3; y < 8; y++) for (let x = 0; x < 30; x++) cells.push(`${x},${y}`);
  await dmSocket.apply({ t: "build.paint", sceneId, terrain: "stone", cells });
  // The marker stands where every player sees it, so a move of it reaches every seat.
  const marker = uuidv7();
  const pc = uuidv7();
  await dmSocket.apply({ t: "token.create", token: { id: marker, sceneId, kind: "object", name: "Marker", size: "medium", x: 15, y: 18, fogExempt: true, actor: inline("") } } as Op);
  await dmSocket.apply({ t: "token.create", token: { id: pc, sceneId, kind: "pc", name: "Pip's", disposition: "ally", size: "medium", ownerIds: [pipId], x: 2, y: 5, actor: inline("Darkvision 30 ft.") } } as Op);
  const pipSeat = await seat(await t.connect(roomId, pip), "pip");
  let markerX = 15;
  const sync = async () => {
    markerX = markerX === 15 ? 16 : 15;
    await dmSocket.apply({ t: "token.move", tokenId: marker, x: markerX, y: 18 });
    await catchUp(pipSeat, marker, markerX);
  };
  return { roomId, dm, pip, sceneId, dmSocket, pipSeat, pc, sync };
}

describe("players' maps over the socket and the store", () => {
  let t: Engine;
  before(async () => {
    t = await startEngine({ rooms: { idleUnloadMs: 60_000, actor: { snapshotOps: 1_000, snapshotIdleMs: 60_000 } } });
  });
  after(() => t.close());

  test("an edit out of sight is remembered in its own batch, reaches no frame of the player's, and a replay, a snapshot and a reconnect keep it", async () => {
    const { roomId, pip, sceneId, dmSocket, pipSeat, pc, sync } = await table(t);
    // Pip's character walks east and back, so the corridor out to x = 18 is explored, and 9 to 18 out of sight.
    await dmSocket.apply({ t: "token.move", tokenId: pc, x: 12, y: 5 });
    await dmSocket.apply({ t: "token.move", tokenId: pc, x: 2, y: 5 });
    await sync();
    const mark = pipSeat.changes.length;
    const paint = await dmSocket.apply({ t: "build.paint", sceneId, terrain: "wood", cells: ["14,5"] });
    await dmSocket.apply({ t: "build.edge", sceneId, edges: [{ key: "15,5,w", feature: { kind: "wall" } }] });
    await sync();

    // The ev names its batch's last seq: the map step's, right after the paint and any explore.
    const ops = await t.pool.query<{ t: string }>("select op->>'t' as t from room_ops where room_id = $1 and seq <= $2 order by seq desc limit 2", [roomId, paint.seq]);
    assert.deepEqual(ops.rows.map((r) => r.t), ["sys.remember", "build.paint"], "the map step ends the edit's own batch");
    const live = t.manager.get(roomId)!.committed.state;
    assert.equal(live.memory?.[chunkKey(sceneId, 0, 0)]?.cells?.["14,5"], "stone");
    assert.equal(live.memory?.[chunkKey(sceneId, 0, 0)]?.edges?.["15,5,w"], null, "the wall was not there when they looked");

    const sent = JSON.stringify(pipSeat.changes.slice(mark));
    assert.ok(!sent.includes('"14,5":"wood"'), "no frame shows the wood");
    assert.ok(!sent.includes('"15,5,w"'), "no frame shows the wall");
    assert.ok(!pipSeat.changes.some((c) => /^(memory|memoryBy|played|memoryShared)/.test(c.key)), "no memory key reaches the player");
    assert.equal(chunkIn(pipSeat.view, sceneId, 0, 0)?.cells["14,5"], "stone", "the player's map shows the corridor as last seen");

    // A replay of the stored ops rebuilds the same memory.
    await t.manager.unload(roomId, 1011, false);
    await pipSeat.socket.waitClosed();
    const replayed = await loadRoom(t.pool, roomId);
    assert.ok(replayed && !replayed.replayFailed);
    assert.equal(stableStringify(replayed.state.memory), stableStringify(live.memory));
    assert.equal(stableStringify(replayed.state.playedScenes), stableStringify(live.playedScenes));

    // So does a snapshot, and a reconnect shows the ground as last seen.
    const back = await t.connect(roomId, pip);
    const again = (await back.snapshot("pip2")).state as ProjectedState;
    assert.equal(chunkIn(again, sceneId, 0, 0)?.cells["14,5"], "stone");
    assert.ok(!JSON.stringify(again).includes('"15,5,w"'));
    back.close();
    await back.waitClosed();
    await t.manager.unload(roomId);
    const snapshot = await t.pool.query<{ state: RoomState }>("select state from room_snapshots where room_id = $1", [roomId]);
    assert.equal(stableStringify(snapshot.rows[0]!.state.memory), stableStringify(live.memory));
    const reloaded = await loadRoom(t.pool, roomId);
    assert.equal(stableStringify(reloaded!.state.memory), stableStringify(live.memory));
  });

  test("a walk the real build stops in the dark lands at its last clear spot, stored as made, and only the sender hears it was blocked (MD-R9-1)", async () => {
    const { roomId, pip, sceneId, dmSocket, pc } = await table(t);
    // A wall across the corridor at x = 11, past the party's sight and never seen.
    await dmSocket.apply({ t: "build.edge", sceneId, edges: [3, 4, 5, 6, 7].map((y) => ({ key: `11,${y},w`, feature: { kind: "wall" as const } })) });
    const phone = await t.connect(roomId, pip);
    await phone.snapshot("pip-walk");
    const walked = await phone.apply({ t: "token.move", tokenId: pc, x: 14, y: 5 });
    const n = phone.n;
    assert.deepEqual(walked.acks, [n], "the walk is taken, not refused");
    assert.deepEqual(walked.blocked, [n], "and the sender is told it was blocked");
    assert.equal(walked.rejects, undefined);
    const token = t.manager.get(roomId)!.committed.state.tokens[pc]!;
    assert.deepEqual([token.x, token.y], [10, 5], "it lands at its last clear spot, before the wall");
    const stored = await t.pool.query<{ op: Op }>("select op from room_ops where room_id = $1 and op->>'t' = 'token.move' and op->>'tokenId' = $2 order by seq desc limit 1", [roomId, pc]);
    const op = stored.rows[0]!.op as Extract<Op, { t: "token.move" }>;
    assert.deepEqual([op.x, op.y], [10, 5], "the landed move is the one stored");
    // The DM's socket heard the move, not the block.
    const dmEv = await dmSocket.next("ev", (m) => m.changes.some((c) => c.key === `token:${pc}`));
    assert.equal(dmEv.blocked, undefined);
    phone.close();
    await phone.waitClosed();
  });
});
