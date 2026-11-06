import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { uuidv7 } from "#shared/ids.ts";
import type { RoomMeta } from "#shared/model.ts";
import type { ProjectedState } from "#shared/project.ts";
import type { Op, ServerMessage } from "#shared/protocol.ts";
import { PLAYERS_ELSEWHERE } from "#shared/reducer/room.ts";
import { startEngine, type Engine, type Socket, type TestClient } from "./testing.ts";

/**
 * The DM menu's Show players <scene> over the real socket and Postgres
 * (designs/qol plan 3, D-261106-172): the move, then the lift guarded by
 * the scene, under one undo group. No frame a player receives shows the
 * old scene lit, one Undo takes both back, and a move that lost to another
 * DM's or a scene deleted since leaves the blackout on.
 */
type Ev = Extract<ServerMessage, { t: "ev" }>;

/** Sends an op under an undo group, as the client's gesture does, and waits for its answer. */
async function grouped(socket: Socket, op: Op, group: string): Promise<Ev> {
  const n = socket.nextN();
  socket.send({ t: "op", n, op, g: group });
  return socket.next("ev", (m) => (m.acks?.includes(n) ?? false) || (m.rejects?.some((r) => r.n === n) ?? false));
}

const refusal = (ev: Ev) => ev.rejects?.[0];

/** Every meta a socket receives from now on, in order. */
function metas(socket: Socket): RoomMeta[] {
  const seen: RoomMeta[] = [];
  socket.ws.on("message", (data) => {
    const m = JSON.parse(data.toString()) as ServerMessage;
    if (m.t !== "ev") return;
    for (const c of m.changes) if (c.key === "meta" && "value" in c) seen.push(c.value as RoomMeta);
  });
  return seen;
}

describe("a guarded reveal on the server", () => {
  let t: Engine;
  before(async () => {
    t = await startEngine();
  });
  after(() => t.close());

  async function table(name: string) {
    const dmClient = t.client();
    const { roomId, dmKey } = await dmClient.createRoom(name);
    const coClient: TestClient = t.client();
    await coClient.claimDm(roomId, dmKey);
    const playerClient = t.client();
    await playerClient.join(roomId, "Pip");
    const dm = await t.connect(roomId, dmClient);
    const first = (await dm.snapshot("dm")).state as ProjectedState;
    const co = await t.connect(roomId, coClient);
    await co.snapshot("co");
    const player = await t.connect(roomId, playerClient);
    await player.snapshot("p");
    const start = first.meta.playerSceneId!;
    const [crypt, gate] = [uuidv7(), uuidv7()];
    for (const [id, sceneName] of [[crypt, "Crypt"], [gate, "Gate"]] as const) {
      assert.equal(refusal(await dm.apply({ t: "scene.create", scene: { id, name: sceneName, bounds: { w: 10, h: 10 } } })), undefined);
    }
    assert.equal(refusal(await dm.apply({ t: "view.blackout", blackout: true })), undefined);
    const meta = async (label: string) => {
      const s = await t.connect(roomId, dmClient);
      const state = (await s.snapshot(label)).state as ProjectedState;
      s.close();
      return state.meta;
    };
    return { dm, co, player, start, crypt, gate, meta };
  }

  test("the move then the lift: players never see the old scene lit, and one Undo takes both back", async () => {
    const tb = await table("Reveal");
    const seen = metas(tb.player);
    const g = uuidv7();
    // Sent back to back, as the menu sends them, without waiting on the move.
    const nMove = tb.dm.nextN();
    tb.dm.send({ t: "op", n: nMove, op: { t: "room.setPlayerScene", sceneId: tb.crypt }, g });
    const lifted = await grouped(tb.dm, { t: "view.blackout", blackout: false, whilePlayersOn: tb.crypt }, g);
    assert.equal(refusal(lifted), undefined);
    assert.deepEqual([(await tb.meta("after")).playerSceneId, (await tb.meta("after2")).view.blackout], [tb.crypt, false]);
    await tb.player.next("ev", (m) => m.changes.some((c) => c.key === "meta" && "value" in c && (c.value as RoomMeta).view.blackout === false));
    assert.ok(seen.length > 0);
    assert.deepEqual(seen.filter((m) => !m.view.blackout && m.playerSceneId !== tb.crypt), [], "no frame shows the players the old scene lit");

    assert.equal(refusal(await tb.dm.step("undo")), undefined);
    const back = await tb.meta("undone");
    assert.deepEqual([back.playerSceneId, back.view.blackout], [tb.start, true], "one Undo takes the move and the lift back");
  });

  test("another DM's move in between: the lift is refused with its words, the blackout stays, and Undo never takes the other DM's move back", async () => {
    const tb = await table("Overtaken");
    const g = uuidv7();
    assert.equal(refusal(await grouped(tb.dm, { t: "room.setPlayerScene", sceneId: tb.crypt }, g)), undefined);
    assert.equal(refusal(await tb.co.apply({ t: "room.setPlayerScene", sceneId: tb.gate })), undefined);
    const lift = refusal(await grouped(tb.dm, { t: "view.blackout", blackout: false, whilePlayersOn: tb.crypt }, g));
    assert.deepEqual([lift?.code, lift?.message], ["invalid", PLAYERS_ELSEWHERE]);
    const meta = await tb.meta("overtaken");
    assert.deepEqual([meta.playerSceneId, meta.view.blackout], [tb.gate, true]);
    // The DM's step is the move alone, and the room's meta changed since, so its Undo is refused as any such undo is.
    assert.match(refusal(await tb.dm.step("undo"))?.message ?? "", /changed since/);
    assert.equal((await tb.meta("kept")).playerSceneId, tb.gate);
  });

  test("a lift refused after an accepted move leaves the step as the move alone", async () => {
    const tb = await table("Move only");
    const g = uuidv7();
    assert.equal(refusal(await grouped(tb.dm, { t: "room.setPlayerScene", sceneId: tb.crypt }, g)), undefined);
    // The lift names another scene than the move, which stands for any lift the players are not there for.
    assert.equal(refusal(await grouped(tb.dm, { t: "view.blackout", blackout: false, whilePlayersOn: tb.gate }, g))?.message, PLAYERS_ELSEWHERE);
    assert.equal(refusal(await tb.dm.step("undo")), undefined);
    const back = await tb.meta("undone");
    assert.deepEqual([back.playerSceneId, back.view.blackout], [tb.start, true], "Undo takes back the move, and the blackout was never lifted");
  });

  test("a scene another DM deleted: the move is refused, then the lift, and the blackout stays", async () => {
    const tb = await table("Deleted");
    assert.equal(refusal(await tb.co.apply({ t: "scene.delete", sceneId: tb.crypt })), undefined);
    const g = uuidv7();
    assert.equal(refusal(await grouped(tb.dm, { t: "room.setPlayerScene", sceneId: tb.crypt }, g))?.code, "gone");
    assert.equal(refusal(await grouped(tb.dm, { t: "view.blackout", blackout: false, whilePlayersOn: tb.crypt }, g))?.message, PLAYERS_ELSEWHERE);
    const meta = await tb.meta("deleted");
    assert.deepEqual([meta.playerSceneId, meta.view.blackout], [tb.start, true]);
  });
});
