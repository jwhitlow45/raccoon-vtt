import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { discoveryOp, discoveryState, fogRoom, lift, remember, TERRAINS } from "#shared/discoveryTestutil.ts";
import { keys, type EntityKey } from "#shared/keys.ts";
import { CHUNK_CELLS, type Label, type MemoryEntries, type RoomState, type Stamp, type Viewer } from "#shared/model.ts";
import { applyChanges, projectState, stableStringify, type ProjectedState } from "#shared/project.ts";
import { exploreFor, playersOf, withCellVision } from "#shared/perPlayerTestutil.ts";
import { opSchema, type Change, type Op, type ServerMessage } from "#shared/protocol.ts";
import { applyOp } from "#shared/reducer.ts";
import { clearVisionCache } from "#shared/rules/vision.ts";
import { DM, P1, P2, actor, chance, deepClone, env, int, pick, rng, room, scene, token } from "#shared/testutil.ts";
import { Connection } from "./connection.ts";
import { buildSnapshot, publishBatch, type CommittedBatch } from "./fanout.ts";

/**
 * The fan-out over map discovery's rooms (docs/design-v1-map-discovery.md
 * 5.6, MD2-O-1, MD2-LK-2, MD2-ASTRA-2): whatever a socket's events add up
 * to after every batch is the fresh projection of a copy of the room that
 * shares no object with it, so no answer kept across batches, the fan-out's
 * or the projection's, outlives an input it read.
 */

type Socket = { conn: Connection; sent: string[]; view: ProjectedState };

const DISPLAY: Viewer = { memberId: "display:abcdefghijkl", role: "player" };

function socket(state: RoomState, viewer: Viewer, sceneId: string | null, n: number): Socket {
  const sent: string[] = [];
  const raw = { readyState: 1, OPEN: 1, CONNECTING: 0, send: (text: string) => sent.push(text), close: () => undefined, terminate: () => undefined };
  const grant = { sessionId: `s-${viewer.memberId}-${n}`, roomId: "DISCOVR1", memberId: viewer.memberId, role: viewer.role, display: viewer === DISPLAY };
  const conn = new Connection(raw as never, grant, "203.0.113.9");
  conn.sceneId = sceneId;
  const snapshot = buildSnapshot(state, 0, conn, 0);
  conn.held = snapshot.held;
  return { conn, sent, view: snapshot.message.state as ProjectedState };
}

/** Every player twice, so two sockets share a class, the display, and the DM on each scene. */
function sockets(state: RoomState): Socket[] {
  const viewers: [Viewer, string | null][] = [[DM, "s1"], [DM, "s2"], ...playersOf(state).flatMap((p): [Viewer, null][] => [[p, null], [p, null]]), [DISPLAY, null]];
  return viewers.map(([v, s], i) => socket(state, v, s, i));
}

function batchOf(seq: number, before: RoomState, after: RoomState, touched: EntityKey[], global: boolean): CommittedBatch {
  return { seq, before, after, touched, global, acks: new Map(), rejects: new Map(), restored: new Map() };
}

/** Publishes a batch, applies each socket's events, and checks each view against a fresh projection of a copy of the room. */
function publish(where: string, all: Socket[], batch: CommittedBatch): void {
  publishBatch(batch, all.map((s) => s.conn), () => undefined);
  const cold = deepClone(batch.after);
  for (const s of all) {
    for (const text of s.sent.splice(0)) {
      const msg = JSON.parse(text) as ServerMessage;
      if (msg.t === "ev") s.view = applyChanges(s.view, msg.changes as Change[]);
    }
    const fresh = projectState(cold, s.conn.viewer, { sceneId: s.conn.sceneId });
    if (stableStringify(s.view) !== stableStringify(fresh)) assert.deepEqual(JSON.parse(JSON.stringify(s.view)), JSON.parse(JSON.stringify(fresh)), `${where}: ${s.conn.memberId}@${s.conn.sceneId ?? "players"}`);
  }
}

/**
 * A memory write as the map step makes one, but at random: a chunk of the
 * party's or a holder's layer with labels and stamps remembered elsewhere,
 * with other text or absent, and cells and edges remembered otherwise.
 */
function memoryWrite(r: () => number, state: RoomState): { after: RoomState; touched: EntityKey[] } | null {
  const sceneId = pick(r, ["s1", "s1", "s2"]);
  const sc = state.scenes[sceneId];
  if (!sc) return null;
  const holders = state.holders[sceneId]?.entries.map((e) => e.memberId) ?? [];
  const layer = holders.length > 0 && chance(r, 0.5) ? pick(r, holders) : null;
  const cx = int(r, 0, Math.ceil(sc.bounds.w / CHUNK_CELLS) - 1);
  const cy = int(r, 0, Math.ceil(sc.bounds.h / CHUNK_CELLS) - 1);
  const after: RoomState = { ...state };
  if (chance(r, 0.15)) {
    // The map step dropped the chunk: the layer sees it again.
    const key = layer === null ? `${sceneId}:${cx},${cy}` : `${sceneId}:${layer}:${cx},${cy}`;
    const all = layer === null ? state.memory : state.memoryBy;
    if (!all?.[key]) return null;
    const { [key]: _, ...rest } = all;
    if (layer === null) after.memory = rest;
    else after.memoryBy = rest;
  } else {
    const at = () => ({ x: cx * CHUNK_CELLS + int(r, 0, CHUNK_CELLS - 1) + 0.5, y: cy * CHUNK_CELLS + int(r, 0, CHUNK_CELLS - 1) + 0.5 });
    const entries: MemoryEntries = {};
    const labels = Object.values(state.labels).filter((l) => l.sceneId === sceneId);
    if (labels.length > 0 && chance(r, 0.8)) {
      const live = pick(r, labels);
      entries.labels = { [live.id]: chance(r, 0.2) ? null : ({ ...live, ...at(), text: pick(r, ["Old", "Older", live.text]) } satisfies Label) };
    }
    const stamps = Object.values(state.stamps).filter((s) => s.sceneId === sceneId);
    if (stamps.length > 0 && chance(r, 0.4)) {
      const live = pick(r, stamps);
      entries.stamps = { [live.id]: chance(r, 0.2) ? null : ({ ...live, ...at() } satisfies Stamp) };
    }
    if (chance(r, 0.5)) {
      const { x, y } = at();
      entries.cells = { [`${Math.floor(x)},${Math.floor(y)}`]: chance(r, 0.2) ? null : pick(r, TERRAINS) };
      entries.edges = { [`${Math.floor(x)},${Math.floor(y)},${pick(r, ["n", "w"])}`]: chance(r, 0.3) ? null : { kind: "wall" } };
    }
    remember(after, layer, cx, cy, entries, sceneId);
  }
  return { after, touched: [layer === null ? keys.memory(sceneId, cx, cy) : keys.memoryBy(sceneId, layer, cx, cy)] };
}

describe("the fan-out over map discovery", () => {
  test("every socket's events add up to the fresh projection, over random rooms, holders, memory and batches", () => {
    withCellVision(() => {
      const counts = { batches: 0, memory: 0, remembered: 0 };
      for (let seed = 1; seed <= 16; seed++) {
        clearVisionCache();
        const r = rng(seed * 7919);
        let state = discoveryState(r);
        // Labels and stamps for memory to name, on both scenes.
        for (let i = 0; i < 4; i++) {
          const sceneId = pick(r, ["s1", "s2"]);
          state.labels[`lb${i}`] = { id: `lb${i}`, rev: 0, sceneId, x: int(r, 0, 30) + 0.5, y: int(r, 0, 30) + 0.5, text: `Label ${i}`, size: 1 };
        }
        let all = sockets(state);
        const players = () => playersOf(state).map((p) => p.memberId).join();
        let members = players();
        for (let i = 0; i < 40; i++) {
          const where = `seed ${seed} batch ${i}`;
          if (chance(r, 0.3)) {
            const write = memoryWrite(r, state);
            if (!write) continue;
            publish(`${where} (memory)`, all, batchOf(100 + i, state, write.after, write.touched, false));
            state = write.after;
            counts.memory++;
            continue;
          }
          const ps = playersOf(state);
          const who: Viewer = i % 4 === 3 && ps.length > 0 ? pick(r, ps) : DM;
          const parsed = opSchema.safeParse(discoveryOp(r, state, who) satisfies Op);
          if (!parsed.success) continue;
          const first = applyOp(state, parsed.data, who, env(200 + 2 * i));
          if (!first.ok) continue;
          let after = first.state;
          const touched = [...first.touched];
          let global = first.global;
          const explore = exploreFor(after);
          if (explore) {
            const second = applyOp(after, opSchema.parse(explore), DM, env(201 + 2 * i));
            assert.ok(second.ok, `${where}: the explore step was refused`);
            after = second.state;
            touched.push(...second.touched);
            global ||= second.global;
          }
          publish(`${where} (${parsed.data.t})`, all, batchOf(100 + i, state, after, touched, global));
          state = after;
          counts.batches++;
          if (Object.keys(state.memory ?? {}).length + Object.keys(state.memoryBy ?? {}).length > 0) counts.remembered++;
          // Members who joined get sockets, and members who left lose theirs.
          if (players() !== members) {
            all = sockets(state);
            members = players();
          }
        }
      }
      assert.ok(counts.batches > 300 && counts.memory > 100 && counts.remembered > 200, JSON.stringify(counts));
    });
  });
});

/*
 * The reviewers' cases, fixed: a label some layer remembers, its answer
 * kept across batches while its memory, the class's sight or another
 * class's answer changed under it.
 */
describe("a remembered label through the fan-out", () => {
  const altar = (x: number, y: number, text = "Altar"): Label => ({ id: "altar", rev: 0, size: 1, sceneId: "s1", x, y, text });

  test("its memory dropped while nothing else changed: the remembered copy leaves the map (MD2-LK-2)", () => {
    const s0 = fogRoom({ vision: true });
    lift(s0, "party", { x: 0, y: 0, w: 8, h: 3 });
    s0.labels = { altar: altar(30, 1) };
    remember(s0, null, 0, 0, { labels: { altar: altar(2, 1) } });
    const all = [socket(s0, P1, "s1", 0)];
    assert.equal(all[0]!.view.labels.altar?.x, 2);
    // A batch naming the label warms the fan-out's answer for it.
    publish("warm", all, batchOf(1, s0, s0, [keys.label("altar")], false));
    publish("dropped", all, batchOf(2, s0, { ...s0, memory: {} }, [keys.memory("s1", 0, 0)], false));
    assert.equal(all[0]!.view.labels.altar, undefined);
  });

  /** A dark scene the party explored whole, the label "New" on the build and "Old" in the party's memory, creatures with darkvision. */
  function darkRoom(perPlayer: boolean): RoomState {
    clearVisionCache();
    const state = room();
    state.scenes = { s1: scene("s1", { bounds: { w: 32, h: 16 }, fogEnabled: true, vision: { on: true, light: "dark", ...(perPlayer ? { perPlayer: true } : {}) }, autoWalls: "off" }) };
    state.meta = { ...state.meta, playerSceneId: "s1" };
    if (perPlayer) state.holders = { s1: { sceneId: "s1", rev: 0, entries: [P1, P2].map((v) => ({ memberId: v.memberId, on: true })) } };
    const seer = (id: string, owner: string, x: number) => token(id, { kind: "pc", ownerIds: [owner], x, y: 8, actor: { inline: actor({ senses: "darkvision 30 ft" }) } });
    state.tokens = { a: seer("a", P1.memberId, perPlayer ? 12 : 2), ...(perPlayer ? { b: seer("b", P2.memberId, 2) } : {}) };
    state.labels = { L: { id: "L", rev: 1, sceneId: "s1", x: 24.5, y: 8.5, text: "New", size: 1 } };
    lift(state, "party", { x: 0, y: 0, w: 32, h: 16 });
    remember(state, null, 1, 0, { labels: { L: { id: "L", rev: 0, sceneId: "s1", x: 24.5, y: 8.5, text: "Old", size: 1 } } });
    return state;
  }

  function moveTo(all: Socket[], state: RoomState, x: number, seq: number): RoomState {
    const r = applyOp(state, { t: "token.move", tokenId: "a", x, y: 8 }, DM, env(seq));
    assert.ok(r.ok);
    publish(`move to ${x}`, all, batchOf(seq, state, r.state, r.touched, r.global));
    return r.state;
  }

  test("the party's sight moving onto it: the live text replaces the remembered one (MD2-O-1, whole party)", () => {
    let state = darkRoom(false);
    const all = [socket(state, P1, "s1", 0)];
    assert.equal(all[0]!.view.labels.L?.text, "Old");
    state = moveTo(all, state, 12, 11);
    state = moveTo(all, state, 20, 12);
    assert.equal(all[0]!.view.labels.L?.text, "New");
  });

  test("one holder's private sight of it never reaches another holder, whose class shares the fog tiles (MD2-O-1, MD2-ASTRA-2)", () => {
    let state = darkRoom(true);
    const all = [socket(state, P1, "s1", 0), socket(state, P2, "s1", 1)];
    state = moveTo(all, state, 20, 11);
    assert.equal(all[0]!.view.labels.L?.text, "New");
    assert.equal(all[1]!.view.labels.L?.text, "Old");
    // The DM edits it while p1 sees it: p1 reads the edit, p2 still the old text.
    const edited = applyOp(state, { t: "build.label", sceneId: "s1", labelId: "L", label: { x: 24.5, y: 8.5, text: "Newer", size: 1 } }, DM, env(12));
    assert.ok(edited.ok);
    publish("edited", all, batchOf(12, state, edited.state, edited.touched, edited.global));
    assert.equal(all[0]!.view.labels.L?.text, "Newer");
    assert.equal(all[1]!.view.labels.L?.text, "Old");
  });
});
