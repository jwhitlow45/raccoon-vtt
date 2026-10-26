import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { chunkKey, keys, tileKey, type EntityKey } from "#shared/keys.ts";
import type { BuildChunk, Label, RoomState, Viewer } from "#shared/model.ts";
import { applyChanges, diffProjection, hashValue, perPlayerScene, projectEntity, projectState, stableStringify, viewerSceneId, type ProjectedState } from "#shared/project.ts";
import { opSchema, type Change, type Op, type ServerMessage } from "#shared/protocol.ts";
import { applyOp } from "#shared/reducer.ts";
import { encodeTile, fullTileBits } from "#shared/rules/fog.ts";
import { clearVisionCache } from "#shared/rules/vision.ts";
import { exploreFor, perPlayerOp, perPlayerState, playersOf, withCellVision } from "#shared/perPlayerTestutil.ts";
import { DM, env, pick, rng, room, scene, trap } from "#shared/testutil.ts";
import { Connection } from "./connection.ts";
import { buildSnapshot, candidateKeys, publishBatch, type CommittedBatch } from "./fanout.ts";

/**
 * The fan-out's projection classes (docs/design-v1-per-player-vision.md
 * 6.9, lane PV3) against projecting every viewer alone: over random
 * per-player rooms and ops, each socket's `ev` from the classes is
 * byte for byte the one it would get were nothing shared, and applying it
 * to the socket's snapshot gives that viewer's fresh projection.
 */

type Socket = { conn: Connection; sent: string[] };

function socket(state: RoomState, viewer: Viewer & { display?: boolean }, sceneId: string | null, n: number): Socket {
  const sent: string[] = [];
  const raw = { readyState: 1, OPEN: 1, CONNECTING: 0, send: (text: string) => sent.push(text), close: () => undefined, terminate: () => undefined };
  const conn = new Connection(raw as never, { sessionId: `s-${viewer.memberId}-${n}`, roomId: "CLASSES1", memberId: viewer.memberId, role: viewer.role, display: viewer.display === true }, "203.0.113.9");
  conn.sceneId = sceneId;
  conn.held = buildSnapshot(state, 0, conn, 0).held;
  return { conn, sent };
}

/** The DM on each scene, every player with two sockets, and a table display, opened in pairs: one for the classes, one alone. */
function table(state: RoomState): { classes: Socket[]; alone: Socket[] } {
  const viewers: [Viewer & { display?: boolean }, string | null][] = [
    [DM, "s1"],
    [DM, "s2"],
    ...playersOf(state).flatMap((p): [Viewer, null][] => [
      [p, null],
      [p, null],
    ]),
    [{ memberId: "display:abcdefghijkl", role: "player", display: true }, null],
  ];
  return { classes: viewers.map(([v, s], i) => socket(state, v, s, i)), alone: viewers.map(([v, s], i) => socket(state, v, s, i)) };
}

/** The fan-out as it was before the classes: every viewer projected alone, every candidate key, nothing shared. */
function publishAlone(batch: CommittedBatch, sockets: readonly Socket[]): void {
  const live = sockets.map((s) => s.conn).filter((c) => !c.closed && c.held !== null);
  const watched = new Set<string>();
  for (const c of live) {
    const sceneId = viewerSceneId(batch.after, c.viewer, { sceneId: c.sceneId });
    if (sceneId !== null) watched.add(sceneId);
  }
  const candidates = [...candidateKeys(batch, watched, live.map((c) => c.viewer))].sort();
  for (const conn of live) {
    const next = new Map<EntityKey, unknown>();
    for (const key of candidates) next.set(key, projectEntity(key, batch.after, conn.viewer, { sceneId: conn.sceneId }));
    const diff = diffProjection(conn.held!, next, hashValue);
    conn.held = diff.held;
    if (diff.changes.length > 0) conn.send({ t: "ev", seq: batch.seq, changes: diff.changes });
  }
}

function batchOf(seq: number, before: RoomState, after: RoomState, touched: EntityKey[], global: boolean): CommittedBatch {
  return { seq, before, after, touched, global, acks: new Map(), rejects: new Map(), restored: new Map() };
}

describe("the fan-out's projection classes", () => {
  test("give every socket byte for byte the events it would get projected alone, over random per-player rooms", () => {
    withCellVision(() => {
      let compared = 0;
      let perPlayerBatches = 0;
      let sharedSight = 0;
      for (let seed = 1; seed <= 40; seed++) {
        clearVisionCache();
        const r = rng(seed * 9173);
        let state = perPlayerState(r);
        let { classes, alone } = table(state);
        for (let i = 0; i < 40; i++) {
          const players = playersOf(state);
          const who: Viewer = i % 4 === 3 && players.length > 0 ? pick(r, players) : DM;
          const raw: Op = perPlayerOp(r, state, who);
          const parsed = opSchema.safeParse(raw);
          if (!parsed.success) continue;
          const before = state;
          const first = applyOp(state, parsed.data, who, env(100 + 2 * i));
          if (!first.ok) continue;
          let after = first.state;
          const touched = [...first.touched];
          let global = first.global;
          // The explore step in the same batch, as the actor appends it.
          const explore = exploreFor(after);
          if (explore) {
            const second = applyOp(after, opSchema.parse(explore), DM, env(101 + 2 * i));
            assert.ok(second.ok, `seed ${seed} op ${i}: the explore step was refused`);
            after = second.state;
            touched.push(...second.touched);
            global ||= second.global;
          }
          const batch = batchOf(100 + i, before, after, touched, global);
          publishBatch(batch, classes.map((s) => s.conn), () => undefined);
          publishAlone(batch, alone);
          const scene = after.meta.playerSceneId === null ? undefined : after.scenes[after.meta.playerSceneId];
          if (perPlayerScene(scene)) perPlayerBatches++;
          for (const [k, a] of classes.entries()) {
            const b = alone[k]!;
            assert.deepEqual(a.sent, b.sent, `seed ${seed} op ${i} (${raw.t}): ${a.conn.memberId}@${a.conn.sceneId ?? "players"}`);
            compared += a.sent.length;
            a.sent.length = 0;
            b.sent.length = 0;
          }
          if (scene && perPlayerScene(scene)) {
            const holders = players.filter((p) => after.holders[scene.id]?.entries.some((e) => e.on && e.memberId === p.memberId));
            const sights = new Set(holders.map((p) => stableStringify(projectState(after, p, { sceneId: null }).sight)));
            if (holders.length > 1 && sights.size < holders.length) sharedSight++;
          }
          // Members who joined get sockets, and members who left lose theirs, on both sides alike.
          if (playersOf(after).map((p) => p.memberId).join() !== players.map((p) => p.memberId).join()) ({ classes, alone } = table(after));
          state = after;
        }
      }
      assert.ok(compared > 2000, `only ${compared} events compared`);
      assert.ok(perPlayerBatches > 500, `only ${perPlayerBatches} batches on a per-player scene`);
      assert.ok(sharedSight > 20, `only ${sharedSight} batches with holders sharing a raster`);
    });
  });

  test("a socket's events still give its fresh projection after many batches", () => {
    withCellVision(() => {
      for (let seed = 1; seed <= 12; seed++) {
        clearVisionCache();
        const r = rng(seed * 31);
        let state = perPlayerState(r);
        const { classes } = table(state);
        const views = classes.map((s) => projectState(state, s.conn.viewer, { sceneId: s.conn.sceneId }));
        const players = playersOf(state).map((p) => p.memberId).join();
        for (let i = 0; i < 30; i++) {
          const parsed = opSchema.safeParse(perPlayerOp(r, state, DM));
          if (!parsed.success) continue;
          const result = applyOp(state, parsed.data, DM, env(100 + i));
          if (!result.ok || parsed.data.t === "sys.memberRemove" || parsed.data.t === "sys.memberJoin") continue;
          publishBatch(batchOf(100 + i, state, result.state, result.touched, result.global), classes.map((s) => s.conn), () => undefined);
          state = result.state;
          for (const [k, s] of classes.entries()) {
            for (const text of s.sent.splice(0)) {
              const msg = JSON.parse(text) as ServerMessage;
              if (msg.t === "ev") views[k] = applyChanges(views[k]!, msg.changes as Change[]);
            }
            const fresh = projectState(state, s.conn.viewer, { sceneId: s.conn.sceneId });
            assert.equal(stableStringify(views[k]), stableStringify(fresh), `seed ${seed} op ${i}: ${s.conn.memberId}`);
          }
        }
        assert.equal(playersOf(state).map((p) => p.memberId).join(), players);
      }
    });
  });
});

// ---------------------------------------------------------------------------
// The memo's warm cache (6.9)

/**
 * A per-player scene with fog, p1 seeing for themselves with a layer of
 * their own over the room's west half, p2 not: p1's projection is the
 * holder class's, p2's and the display's the shared class's.
 */
function foggy(): RoomState {
  const state = room();
  state.scenes = { s1: scene("s1", { bounds: { w: 48, h: 16 }, fogEnabled: true, vision: { on: false, light: "bright", perPlayer: true } }), s2: scene("s2", { order: 1 }) };
  state.holders = { s1: { sceneId: "s1", rev: 0, entries: [{ memberId: "p1", on: true }] } };
  state.exploredBy = { [`s1:p1:0,0`]: { sceneId: "s1", memberId: "p1", tx: 0, ty: 0, rev: 0, bits: encodeTile(fullTileBits()) } };
  return state;
}

function label(id: string, fields: Pick<Label, "sceneId" | "x" | "y" | "text">): Label {
  return { id, rev: 0, size: 1, ...fields };
}

type Watch = { sockets: Socket[]; views: ProjectedState[]; seq: number; state: RoomState };

function watch(state: RoomState): Watch {
  const sockets = [socket(state, { memberId: "p1", role: "player" }, null, 0), socket(state, { memberId: "p2", role: "player" }, null, 1), socket(state, { memberId: "display:abcdefghijkl", role: "player", display: true }, null, 2)];
  return { sockets, views: sockets.map((s) => projectState(state, s.conn.viewer, { sceneId: null })), seq: 1, state };
}

/** A batch from `w.state` to `next` touching `touched`, sent to the three sockets and applied to their views. */
function step(w: Watch, next: RoomState, touched: EntityKey[], global = false): void {
  publishBatch(batchOf(++w.seq, w.state, next, touched, global), w.sockets.map((s) => s.conn), () => undefined);
  w.state = next;
  for (const [k, s] of w.sockets.entries()) {
    for (const text of s.sent.splice(0)) {
      const msg = JSON.parse(text) as ServerMessage;
      if (msg.t === "ev") w.views[k] = applyChanges(w.views[k]!, msg.changes as Change[]);
    }
    assert.equal(stableStringify(w.views[k]), stableStringify(projectState(next, s.conn.viewer, { sceneId: null })), `batch ${w.seq}: ${s.conn.memberId}`);
  }
}

const has = (w: Watch, k: number, collection: "labels" | "traps" | "stamps", id: string) => Object.hasOwn(w.views[k]![collection] ?? {}, id);

describe("the memo of labels, stamps and traps per fog class", () => {
  test("fog turned off and on again withholds a label under the fog again", () => {
    const state = foggy();
    state.labels = { far: label("far", { sceneId: "s1", x: 40, y: 8, text: "Trap" }), near: label("near", { sceneId: "s1", x: 4, y: 8, text: "Camp" }) };
    const w = watch(state);
    assert.ok(!has(w, 0, "labels", "far") && has(w, 0, "labels", "near") && !has(w, 1, "labels", "near"), "p1 remembers the camp, p2 nothing");
    const off = { ...w.state, scenes: { ...w.state.scenes, s1: { ...w.state.scenes.s1!, fogEnabled: false } } };
    step(w, off, [keys.scene("s1")], true);
    assert.ok(has(w, 0, "labels", "far") && has(w, 1, "labels", "far") && has(w, 2, "labels", "far"), "fog off shows every label");
    const on = { ...w.state, scenes: { ...w.state.scenes, s1: { ...w.state.scenes.s1!, fogEnabled: true } } };
    step(w, on, [keys.scene("s1")], true);
    assert.ok(!has(w, 0, "labels", "far") && !has(w, 1, "labels", "far") && !has(w, 2, "labels", "far"), "fog on again withholds it from every class");
    assert.ok(has(w, 0, "labels", "near") && !has(w, 1, "labels", "near"));
  });

  test("a label across two tiles comes when only its second tile is revealed", () => {
    const state = foggy();
    state.labels = { wide: label("wide", { sceneId: "s1", x: 32, y: 8, text: "A long hall of statues" }) };
    const w = watch(state);
    assert.ok(!has(w, 1, "labels", "wide"));
    const result = applyOp(w.state, { t: "fog.live", sceneId: "s1", ops: [{ id: "r1", mode: "reveal", shape: { kind: "rect", x: 33, y: 7, w: 8, h: 3 } }] }, DM, env(5));
    assert.ok(result.ok);
    assert.ok(!result.state.fogTiles[tileKey("s1", 1, 0)], "the reveal lies in the label's second tile alone");
    step(w, result.state, result.touched, result.global);
    assert.ok(has(w, 1, "labels", "wide") && has(w, 0, "labels", "wide"));
  });

  test("a secret door hidden again takes its found trap away", () => {
    const state = foggy();
    const door = (discovered: boolean): BuildChunk => ({ sceneId: "s1", cx: 0, cy: 0, rev: 1, cells: {}, edges: { "6,8,w": { kind: "door", state: "closed", secret: true, discovered } } });
    state.buildChunks = { [chunkKey("s1", 0, 0)]: door(true) };
    state.traps = { t: trap("t", { sceneId: "s1", found: true, zone: { door: { edge: "6,8,w" } } }) };
    const w = watch(state);
    assert.ok(has(w, 0, "traps", "t"), "p1 remembers the door's ground and sees its found trap");
    for (const [i, discovered] of [false, true, false, true].entries()) {
      step(w, { ...w.state, buildChunks: { [chunkKey("s1", 0, 0)]: door(discovered) } }, [keys.chunk("s1", 0, 0)]);
      assert.equal(has(w, 0, "traps", "t"), discovered, `step ${i}`);
    }
  });

  test("a free door moved under the fog takes its found trap away", () => {
    const state = foggy();
    // p1's layer holds only the tile's west half: a fresh layer tile revealing columns 0 to 7.
    const bits = fullTileBits().map((_, i) => (i % 8 < 4 ? 0xff : 0));
    state.exploredBy = { [`s1:p1:0,0`]: { sceneId: "s1", memberId: "p1", tx: 0, ty: 0, rev: 0, bits: encodeTile(bits) } };
    const at = (x: number): BuildChunk => ({ sceneId: "s1", cx: 0, cy: 0, rev: 1, cells: {}, edges: {}, walls: [{ id: "abcdefghijkl", a: [x, 4], b: [x, 5], f: { kind: "door", state: "closed", secret: false, discovered: false } }] });
    state.buildChunks = { [chunkKey("s1", 0, 0)]: at(4) };
    state.traps = { t: trap("t", { sceneId: "s1", found: true, zone: { door: { cx: 0, cy: 0, id: "abcdefghijkl" } } }) };
    const w = watch(state);
    assert.ok(has(w, 0, "traps", "t"), "the door stands on ground p1 remembers");
    step(w, { ...w.state, buildChunks: { [chunkKey("s1", 0, 0)]: at(12) } }, [keys.chunk("s1", 0, 0)]);
    assert.ok(!has(w, 0, "traps", "t"), "moved into p1's fog, in the same tile");
    step(w, { ...w.state, buildChunks: { [chunkKey("s1", 0, 0)]: at(5) } }, [keys.chunk("s1", 0, 0)]);
    assert.ok(has(w, 0, "traps", "t"), "and back");
  });
});
