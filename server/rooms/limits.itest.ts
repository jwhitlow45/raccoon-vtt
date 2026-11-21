import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { after, before, describe, test } from "node:test";
import { uuidv7 } from "#shared/ids.ts";
import { BOOKKEEPING_RESERVE, FAR, KEPT_FOR_PLAYERS, KEPT_FOR_PLAYERS_FULL, ROOM_FULL, SEAT_FULL, sizeRemedy } from "#shared/limits.ts";
import type { Op } from "#shared/protocol.ts";
import { farRoomBytes, heldBytes, PER_PLAYER_FULL } from "./sizeGuard.ts";
import { startEngine, type Engine, type Socket } from "./testing.ts";

/*
 * Live play 43's repro over real sockets (LP43-LIMITS-2, D-261116-008): a
 * DM with two players adds per-player scenes until the room refuses one,
 * then creatures of their own until the room refuses those, and four more
 * players join. The room keeps its last 2 MiB (KEPT_FOR_PLAYERS) for what
 * the players add, so each of the six then adds a session's areas and
 * strokes.
 */

type Answer = "taken" | { code: string; message: string };

/** An op's answer, sent again after a `busy` retry, as a device does. */
async function answer(socket: Socket, op: Op): Promise<Answer> {
  const n = socket.nextN();
  socket.op(op, n);
  const deadline = Date.now() + 30_000;
  for (;;) {
    assert.ok(Date.now() < deadline, `${op.t} ${n} unanswered`);
    const ev = await socket.maybe("ev", (m) => (m.acks?.includes(n) ?? false) || (m.rejects?.some((r) => r.n === n) ?? false), 100);
    if (ev) {
      const refusal = ev.rejects?.find((r) => r.n === n);
      return refusal ? { code: refusal.code, message: refusal.message } : "taken";
    }
    const retry = socket.received.findIndex((m) => m.t === "retry" && m.n === n);
    if (retry < 0) continue;
    socket.received.splice(retry, 1);
    await delay(250);
    socket.op(op, n);
  }
}

const inline = { hp: { cur: 7, max: 7, temp: 0 }, life: "alive", ac: 12, speeds: { walk: 30 }, initBonus: 2, passivePerception: 10, senses: "", effects: [], deathSaves: { ok: 0, fail: 0 }, notes: "", dmNotes: "" };

/** A 200 point value stroke, its coordinates two-decimal values across the battle mat. */
function stroke(sceneId: string, ownerId: string, k: number): Op {
  const points = Array.from({ length: 200 }, (_, i) => Math.round((5 + ((k * 7 + i) % 300) / 13) * 100) / 100);
  return { t: "drawing.create", drawing: { id: uuidv7(), sceneId, kind: "free", points, style: { stroke: "#30a46c", width: 2, opacity: 1 }, ownerId, visibility: "all" } } as Op;
}

function area(sceneId: string, ownerId: string, i: number): Op {
  return { t: "template.create", template: { id: uuidv7(), sceneId, shape: "sphere", size: 20, origin: { x: 5.5 + i, y: 5.5, z: 0 }, yaw: 0, includeOrigin: true, color: "#e5484d", ownerId, visibility: "all" } } as Op;
}

describe("the room keeps room for the players (LP43-LIMITS-2)", () => {
  let t: Engine;
  before(async () => {
    t = await startEngine({ rooms: { idleUnloadMs: 60_000, actor: { snapshotOps: 5_000, snapshotIdleMs: 60_000 } } });
  });
  after(() => t.close());

  for (const side of [200, 100]) {
    test(`after per-player scenes of ${side} x ${side} and the DM's own creatures stop, six players each add a session's areas and strokes`, async (c) => {
      const dm = t.client();
      const { roomId } = await dm.createRoom(`Kept ${side}`);
      const dmSocket = await t.connect(roomId, dm);
      await dmSocket.snapshot("dm");
      const room = () => t.manager.get(roomId)!.committed.state;
      const mat = room().meta.playerSceneId!;
      const join = async (name: string) => {
        const client = t.client();
        const id = await client.join(roomId, name);
        const socket = await t.connect(roomId, client);
        await socket.snapshot(name);
        return { id, socket };
      };
      const players = [await join("Pat"), await join("Quinn")];
      const creature = (notes: string): Op => ({ t: "token.create", token: { id: uuidv7(), sceneId: mat, kind: "monster", name: "Bat", size: "tiny", x: 1, y: 1, visibility: "dm", actor: { inline: { ...inline, notes } } } }) as Op;

      let scenes = 0;
      let refused: Answer = "taken";
      for (; scenes < 60; scenes++) {
        refused = await answer(dmSocket, { t: "scene.create", scene: { id: uuidv7(), name: `Wilds ${scenes + 1}`, bounds: { w: side, h: side }, fogEnabled: true, vision: { on: true, light: "dark", perPlayer: true } } } as Op);
        if (refused !== "taken") break;
      }
      assert.deepEqual(refused, { code: "quota", message: PER_PLAYER_FULL }, `refused after ${scenes} scenes`);
      let creatures = 0;
      for (; creatures < 600; creatures++) {
        refused = await answer(dmSocket, creature("n".repeat(4_000)));
        if (refused !== "taken") break;
      }
      assert.deepEqual(refused, { code: "quota", message: sizeRemedy(KEPT_FOR_PLAYERS_FULL, "dm") }, `the DM's creatures refused after ${creatures}`);
      const kept = FAR.roomBytes - BOOKKEEPING_RESERVE.room - farRoomBytes(room(), true);
      assert.ok(kept >= KEPT_FOR_PLAYERS, `the players' kept room is free at the widest: ${kept}`);

      for (const name of ["Rook", "Sage", "Tam", "Uma"]) players.push(await join(name));
      const session: Answer[] = [];
      let k = 0;
      for (const p of players) {
        for (let i = 0; i < 5; i++) session.push(await answer(p.socket, area(mat, p.id, i)));
        for (let i = 0; i < 50; i++) session.push(await answer(p.socket, stroke(mat, p.id, k++)));
      }
      assert.deepEqual(session.filter((a) => a !== "taken"), [], "every player's 5 areas and 50 strokes are taken");
      const sessionBytes = heldBytes(room());
      assert.equal((await answer(dmSocket, creature(""))) === "taken", false, "the DM's add is still refused");

      // Strokes round the table until the room is full. A player whose drawings here hold their seat's point values
      // leaves the round, and once none is left another joins: the kept room outlasts six players' seats.
      let more = 0;
      let last: Answer = "taken";
      const round = [...players];
      for (let late = 0; last === "taken" && more < 4_000; ) {
        if (round.length === 0) round.push(await join(`Late ${++late}`));
        const p = round[more % round.length]!;
        last = await answer(p.socket, stroke(mat, p.id, k++));
        if (last === "taken") more++;
        else if (typeof last !== "string" && last.message === SEAT_FULL.pointValues) {
          round.splice(round.indexOf(p), 1);
          last = "taken";
        }
      }
      assert.deepEqual(last, { code: "quota", message: sizeRemedy(ROOM_FULL, "player") });
      c.diagnostic(`${side}: ${scenes} scenes, the DM's ${creatures} creatures, ${kept} bytes kept; a session for six held ${sessionBytes} bytes, then ${more} more strokes, ${heldBytes(room())} bytes held`);

      // Deleting always works, and frees room for the DM's adds.
      for (const scene of Object.values(room().scenes).filter((s) => s.name.startsWith("Wilds "))) assert.equal(await answer(dmSocket, { t: "scene.delete", sceneId: scene.id }), "taken", `${scene.name}'s delete`);
      assert.equal(await answer(dmSocket, creature("")), "taken", "the DM's add once the scenes are gone");
      for (const s of [dmSocket, ...players.map((p) => p.socket)]) s.close();
    });
  }
});
