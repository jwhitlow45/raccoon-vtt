import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { EntityKey } from "#shared/keys.ts";
import type { RoomState, Viewer } from "#shared/model.ts";
import { applyChanges, changedSightKeys, hashValue, heldOf, projectState, stableStringify, type ProjectedState } from "#shared/project.ts";
import { opSchema, type Change, type Op, type ServerMessage } from "#shared/protocol.ts";
import { applyOp } from "#shared/reducer.ts";
import { DM, P1, P2, env, randomOp, randomState, reveal, rng, room, scene, token } from "#shared/testutil.ts";
import { Connection } from "./connection.ts";
import { exploreOp } from "./explore.ts";
import { buildSnapshot, publishBatch } from "./fanout.ts";

/**
 * The design 7.3 invariant through the server's own fan-out
 * (docs/design-v1-maps-vision.md 4.3.5 and section 6): batches of random
 * ops, each followed by the explore step the actor appends, published by
 * `publishBatch` with its narrow sight diff to DMs on both scenes and two
 * players. Applying each socket's `ev`s to its snapshot must give exactly a
 * fresh projection, sight tiles and the merged fog included.
 */
type Viewing = { conn: Connection; view: ProjectedState; inbox: ServerMessage[] };

function open(state: RoomState, who: Viewer, sceneId: string): Viewing {
  const inbox: ServerMessage[] = [];
  const socket = { readyState: 1, OPEN: 1, CONNECTING: 0, send: (text: string) => inbox.push(JSON.parse(text) as ServerMessage), close: () => undefined, terminate: () => undefined };
  const conn = new Connection(socket as never, { sessionId: `s-${who.memberId}-${sceneId}`, roomId: "FANOUT00", memberId: who.memberId, role: who.role }, "203.0.113.4");
  conn.sceneId = sceneId;
  const snapshot = buildSnapshot(state, 0, conn, 0);
  conn.held = snapshot.held;
  return { conn, view: snapshot.message.state as ProjectedState, inbox };
}

/*
 * Most random rooms explore nothing: the party must stand on the player
 * scene with vision and fog on and see something. Every other seed puts
 * it there, with darkvision for the player characters, so the explore step
 * and the sight diff run on most batches.
 */
function exploring(state: RoomState, seed: number): RoomState {
  if (seed % 2 === 1) return state;
  const s1 = state.scenes.s1!;
  const characters = Object.fromEntries(Object.entries(state.characters).map(([id, c]) => [id, { ...c, actor: { ...c.actor, senses: "Darkvision 30 ft." } }]));
  return {
    ...state,
    meta: { ...state.meta, playerSceneId: "s1" },
    scenes: { ...state.scenes, s1: { ...s1, fogEnabled: true, vision: { on: true, light: s1.vision?.light ?? "dark" } } },
    characters,
  };
}

/** A DM's move of any token on the first scene, party members included, so sight and what it shows change often. */
function walk(r: () => number, state: RoomState): Op {
  const ids = Object.values(state.tokens)
    .filter((t) => t.sceneId === "s1")
    .map((t) => t.id);
  const tokenId = ids[Math.floor(r() * ids.length)] ?? "none";
  return { t: "token.move", tokenId, x: Math.floor(r() * 30), y: Math.floor(r() * 30) };
}

type Tally = { batches: number; explores: number; narrowSight: number };

function run(seed: number, batches: number, tally: Tally): void {
  const r = rng(seed);
  let state = exploring(randomState(r), seed);
  const viewers = [open(state, DM, "s1"), open(state, DM, "s2"), open(state, P1, "s1"), open(state, P2, "s1")];
  // Past every log id the random room holds, so new log lines sort after them as the state appends them.
  let seq = 100;
  for (let b = 0; b < batches; b++) {
    const before = state;
    const touched: EntityKey[] = [];
    let global = false;
    const size = 1 + Math.floor(r() * 3);
    for (let i = 0; i < size; i++) {
      const who = (b + i) % 5 === 4 ? ((b + i) % 2 === 0 ? P1 : P2) : DM;
      const parsed = opSchema.safeParse(r() < 0.4 ? walk(r, state) : randomOp(r, state, who));
      assert.ok(parsed.success);
      const result = applyOp(state, parsed.data, who, env(++seq));
      if (!result.ok) continue;
      state = result.state;
      touched.push(...result.touched);
      global ||= result.global;
    }
    if (state === before) continue;
    // The actor's explore step, at the end of the batch.
    const explore = exploreOp(state);
    if (explore) {
      const result = applyOp(state, explore, { memberId: "server", role: "dm" }, env(++seq));
      assert.ok(result.ok, result.ok ? "" : result.message);
      state = result.state;
      touched.push(...result.touched);
      global ||= result.global;
      tally.explores++;
    }
    tally.batches++;
    if (!global && changedSightKeys(before, state, ["s1", "s2"]).length > 0) tally.narrowSight++;
    publishBatch({ seq, before, after: state, touched, global, acks: new Map(), rejects: new Map(), restored: new Map() }, viewers.map((v) => v.conn), () => undefined);
    for (const v of viewers) {
      for (const msg of v.inbox.splice(0)) if (msg.t === "ev") v.view = applyChanges(v.view, msg.changes as Change[]);
      const fresh = projectState(state, v.conn.viewer, { sceneId: v.conn.sceneId });
      if (stableStringify(v.view) !== stableStringify(fresh)) {
        assert.deepEqual(JSON.parse(JSON.stringify(v.view)), JSON.parse(JSON.stringify(fresh)), `seed ${seed} batch ${b} viewer ${v.conn.memberId}@${v.conn.sceneId}`);
      }
      // The server keeps a snapshot's values unhashed until a batch compares them: each stands for its hash.
      const held = [...v.conn.held!.entries()].map(([k, e]) => [k, typeof e === "string" ? e : hashValue(e)]);
      assert.deepEqual(held.sort(), [...heldOf(v.view).entries()].sort(), `seed ${seed} batch ${b} held map for ${v.conn.memberId}`);
    }
  }
}

describe("the server's fan-out with the explore step", () => {
  test("applying each socket's events to its snapshot equals a fresh projection, over random batches with real sight", () => {
    const tally: Tally = { batches: 0, explores: 0, narrowSight: 0 };
    for (let seed = 201; seed <= 260; seed++) run(seed, 30, tally);
    assert.ok(tally.batches > 1_000, `only ${tally.batches} batches`);
    assert.ok(tally.explores > 50, `only ${tally.explores} explores`);
    assert.ok(tally.narrowSight > 100, `sight changed outside a global batch only ${tally.narrowSight} times`);
  });
});

describe("the server's held maps", () => {
  test("a snapshot keeps the map's values unhashed, and a batch that re-projects an unchanged map leaves them so and sends none of it", () => {
    const state = room();
    state.scenes.s1 = scene("s1", { fogEnabled: true });
    state.buildChunks["s1:0,0"] = { sceneId: "s1", cx: 0, cy: 0, rev: 1, cells: { "1,1": "stone", "2,1": "stone" }, edges: { "3,1,w": { kind: "door", state: "closed", secret: true, discovered: false } } };
    state.buildChunks["s1:1,0"] = { sceneId: "s1", cx: 1, cy: 0, rev: 1, cells: { "17,1": "wood" }, edges: {} };
    reveal(state, "s1", { x: 0, y: 0, w: 20, h: 4 });
    const viewers = [open(state, DM, "s1"), open(state, P1, "s1")];
    for (const v of viewers) {
      const chunkKeys = [...v.conn.held!.keys()].filter((k) => k.startsWith("chunk:"));
      assert.ok(chunkKeys.length > 0);
      for (const key of chunkKeys) assert.equal(typeof v.conn.held!.get(key), "object", key);
      assert.equal(typeof v.conn.held!.get("meta"), "string", "the rest is hashed at once");
    }
    // A settings change re-projects everything (global), the map included, and the map is as it was.
    const result = applyOp(state, { t: "room.update", settings: { skipDefeated: !state.meta.settings.skipDefeated } }, DM, env(500));
    assert.ok(result.ok && result.global);
    publishBatch({ seq: 500, before: state, after: result.state, touched: result.touched, global: true, acks: new Map(), rejects: new Map(), restored: new Map() }, viewers.map((v) => v.conn), () => undefined);
    for (const v of viewers) {
      const ev = v.inbox.find((m): m is Extract<ServerMessage, { t: "ev" }> => m.t === "ev");
      assert.ok(ev && ev.changes.every((c) => !c.key.startsWith("chunk:") && !c.key.startsWith("fog:")), v.conn.memberId);
      for (const [key, entry] of v.conn.held!) if (key.startsWith("chunk:")) assert.equal(typeof entry, "object", `${v.conn.memberId} ${key} was never hashed`);
    }
  });
});

describe("a mount's path in its rider's turn (docs/design-v1-attach.md 7.2)", () => {
  test("reaches a player's socket and leaves it as the rider's row comes into sight and goes out of it, with no change to the mount", () => {
    // The DM's goblin rides P1's horse under control on its own turn, both in the lifted fog. Then the goblin gets off into
    // the fog and back out: its row is hidden and shown again, and with it the horse's path of the turn.
    let state = room({
      tokens: {
        horse: token("horse", { name: "Warhorse", kind: "npc", size: "large", ownerIds: ["p1"], x: 2, y: 2 }),
        gob: token("gob", { name: "Goblin", x: 2, y: 2, attached: { to: "horse", kind: "ride", steer: true } }),
        thorn: token("thorn", { name: "Thorn", kind: "pc", ownerIds: ["p1"], x: 0, y: 8 }),
      },
    });
    state.scenes.s1 = scene("s1", { fogEnabled: true });
    reveal(state, "s1", { x: 0, y: 0, w: 10, h: 10 });
    const viewers = [open(state, P1, "s1")];
    let seq = 600;
    const step = (op: Op) => {
      const before = state;
      const result = applyOp(state, op, DM, env(++seq));
      assert.ok(result.ok, result.ok ? "" : result.message);
      state = result.state;
      publishBatch({ seq, before, after: state, touched: result.touched, global: result.global, acks: new Map(), rejects: new Map(), restored: new Map() }, viewers.map((v) => v.conn), () => undefined);
      for (const v of viewers) {
        for (const msg of v.inbox.splice(0)) if (msg.t === "ev") v.view = applyChanges(v.view, msg.changes as Change[]);
        assert.deepEqual(JSON.parse(JSON.stringify(v.view.tokens)), JSON.parse(JSON.stringify(projectState(state, P1, { sceneId: "s1" }).tokens)), `after ${op.t}`);
      }
    };
    step({ t: "encounter.start", entries: [{ id: "eg", tokenId: "gob", value: 20 }, { id: "et", tokenId: "thorn", value: 5 }] });
    step({ t: "encounter.next" });
    assert.deepEqual(state.encounter?.turnStart?.mounts, ["horse"]);
    step({ t: "token.move", tokenId: "horse", x: 4, y: 2 });
    assert.ok(viewers[0]!.view.tokens.horse?.path, "the horse's path of the goblin's turn reaches P1");
    step({ t: "token.detach", tokenId: "gob", x: 6, y: 2 });
    step({ t: "token.move", tokenId: "gob", x: 15, y: 2 });
    assert.equal(viewers[0]!.view.tokens.horse?.path, undefined, "with the goblin's row out of sight, so is the path");
    step({ t: "token.move", tokenId: "gob", x: 7, y: 2 });
    assert.ok(viewers[0]!.view.tokens.horse?.path, "and back with it");
  });
});
