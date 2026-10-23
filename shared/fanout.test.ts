import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { keys, type EntityKey } from "./keys.ts";
import { lineAudience, linesPastStart } from "./logRings.ts";
import type { RoomState, Viewer } from "./model.ts";
import { opSchema, type Op } from "./protocol.ts";
import { allKeys, applyChanges, changedSightKeys, dependents, diffProjection, hash128, hashValue, heldOf, projectArchivedLog, projectEntity, projectState, stableStringify, viewerSceneId, type HeldEntry, type ProjectedState } from "./project.ts";
import { applyOp } from "./reducer.ts";
import { visionRules, type PartySight, type VisionRules } from "./ruleHooks.ts";
import { clearVisionCache } from "./rules/vision.ts";
import { AT, DM, FULL_TILE_BITS, P1, P2, actor, apply, character, env, randomOp, randomState, reveal, rng, room, scene, token } from "./testutil.ts";

const DISPLAY: Viewer = { memberId: "display:abcdefghijkl", role: "player" };

/**
 * The design 7.3 invariant: for every viewer, applying the events it
 * received to its snapshot gives exactly the fresh projection of the final
 * state. The candidates are computed the way the server's fan-out does: the
 * batch's touched keys and their dependents, or everything when an op set
 * `global`.
 */
type Connection = { viewer: Viewer; sceneId: string; held: Map<EntityKey, HeldEntry>; view: ProjectedState };

function connect(state: RoomState, viewer: Viewer, sceneId: string): Connection {
  const view = projectState(state, viewer, { sceneId });
  return { viewer, sceneId, held: heldOf(view), view };
}

function candidatesFor(before: RoomState, after: RoomState, touched: EntityKey[], global: boolean, connections: readonly Connection[] = []): Set<EntityKey> {
  if (global) return new Set([...allKeys(before), ...allKeys(after)]);
  const all = [...touched, ...changedSightKeys(before, after, watched(after, connections))];
  const passed = linesPastStart(before, after, connections.map((c) => c.viewer)).map((id) => keys.log(id));
  return new Set([...all, ...dependents(before, all), ...dependents(after, all), ...passed]);
}

/*
 * The server's narrow sight diff (docs/design-v1-maps-vision.md 4.3.5,
 * server/rooms/fanout.ts): on each scene a viewer holds, the sight tiles
 * that changed join the touched keys, and `dependents` adds the tokens,
 * labels and stamps on them. Nothing else may need sending.
 */
function watched(state: RoomState, connections: readonly Connection[]): string[] {
  const out: string[] = [];
  for (const c of connections) {
    const scene = viewerSceneId(state, c.viewer, { sceneId: c.sceneId });
    if (scene !== null) out.push(scene);
  }
  return out;
}

function runSequence(seed: number, ops: number): { applied: number; refused: number } {
  const r = rng(seed);
  let state = randomState(r);
  // A table display is one more player who owns nothing (docs/design-v1-dm-tools.md 3.1).
  const connections = [connect(state, DM, "s1"), connect(state, DM, "s2"), connect(state, P1, "s1"), connect(state, P2, "s1"), connect(state, DISPLAY, "s1")];
  let applied = 0;
  let refused = 0;
  for (let i = 0; i < ops; i++) {
    const who = i % 5 === 4 ? (i % 2 === 0 ? P1 : P2) : DM;
    const raw = randomOp(r, state, who);
    const parsed = opSchema.safeParse(raw);
    assert.ok(parsed.success, `seed ${seed} op ${i}: generator produced an invalid ${raw.t}: ${parsed.success ? "" : parsed.error.message}`);
    const op: Op = parsed.data;
    const result = applyOp(state, op, who, env(100 + i));
    if (!result.ok) {
      refused++;
      continue;
    }
    applied++;
    // Each line's readers are fixed by the room as the op leaves it (shared/project.ts lineReach, Tx.settleLog), so
    // every player a line counts for reads it when it arrives: a shared event line every player, and a copy its
    // reader. A line that reached one and read as nothing would move their log for nothing they see.
    for (const line of result.log) {
      const audience = lineAudience(line);
      if (line.kind !== "event" || (audience !== "shared" && audience !== "party")) continue;
      const readers: string[] = audience === "party" ? [line.to![0]!] : Object.values(result.state.members).filter((m) => m.kind === "player").map((m) => m.id);
      for (const memberId of readers) {
        const read = projectArchivedLog(result.state, [line], { memberId, role: "player" }, { sceneId: null });
        assert.equal(read.length, 1, `seed ${seed} op ${i} (${op.t}): ${memberId} cannot read ${line.id} ${line.data?.type} when it arrives`);
      }
    }
    const candidates = candidatesFor(state, result.state, result.touched, result.global, connections);
    for (const c of connections) {
      const next = new Map<EntityKey, unknown>();
      for (const key of candidates) next.set(key, projectEntity(key, result.state, c.viewer, { sceneId: c.sceneId }));
      const diff = diffProjection(c.held, next);
      c.held = diff.held;
      c.view = applyChanges(c.view, diff.changes);
      const fresh = projectState(result.state, c.viewer, { sceneId: c.sceneId });
      if (stableStringify(c.view) !== stableStringify(fresh)) {
        assert.deepEqual(JSON.parse(JSON.stringify(c.view)), JSON.parse(JSON.stringify(fresh)), `seed ${seed} op ${i} (${op.t} by ${who.memberId}) viewer ${c.viewer.memberId}@${c.sceneId}`);
      }
      // The held map must match what the view holds, or the next diff would send too much or too little.
      const rebuilt = heldOf(c.view);
      assert.deepEqual([...c.held.entries()].sort(), [...rebuilt.entries()].sort(), `seed ${seed} op ${i} held map for ${c.viewer.memberId}`);
    }
    state = result.state;
  }
  return { applied, refused };
}

describe("fan-out invariant", () => {
  test("applying each viewer's diffs to its snapshot equals a fresh projection, over random op sequences", () => {
    let applied = 0;
    let refused = 0;
    for (let seed = 1; seed <= 80; seed++) {
      const r = runSequence(seed, 40);
      applied += r.applied;
      refused += r.refused;
    }
    assert.ok(applied > refused, `too many refusals: ${applied} applied, ${refused} refused`);
  });

  test("holds through log trimming, and whispers between others trim nothing a player holds", () => {
    const r = rng(7);
    let state = randomState(r);
    state = { ...state, log: Array.from({ length: 199 }, (_, i) => ({ id: `1:${i}`, at: AT, kind: "chat" as const, from: "p1", text: `m${i}` })) };
    const c = connect(state, P2, "s1");
    for (let i = 0; i < 10; i++) {
      const op: Op = i < 5 ? { t: "log.whisper", to: ["dm1"], text: "x" } : { t: "log.chat", text: "y" };
      const result = applyOp(state, op, P1, env(50 + i));
      assert.ok(result.ok);
      const next = new Map<EntityKey, unknown>();
      for (const key of candidatesFor(state, result.state, result.touched, result.global, [c])) next.set(key, projectEntity(key, result.state, c.viewer, { sceneId: c.sceneId }));
      const diff = diffProjection(c.held, next);
      c.held = diff.held;
      c.view = applyChanges(c.view, diff.changes);
      assert.equal(stableStringify(c.view), stableStringify(projectState(result.state, c.viewer, { sceneId: c.sceneId })));
      state = result.state;
      if (i === 4) assert.equal(c.view.log.length, 199, "five whispers to the DM left the 199 chat lines alone");
    }
    assert.equal(c.view.log.length, 200, "five chat lines then trimmed the oldest four");
    assert.equal(c.view.log[0]!.id, "1:4");
  });
});

describe("fan-out invariant on vision scenes", () => {
  /*
   * A party that sees exactly the creatures standing west of x = 15, so
   * moves, squeezes and teleports carry many creatures in and out of sight,
   * which real sight on a random room does now and then. Each creature's
   * answer depends on nothing but itself, and its tile never changes, so
   * this checks the token side of the narrow diff alone. The test above
   * runs real sight, whose changed tiles the narrow diff finds.
   */
  const fake: VisionRules = {
    partySight: (): PartySight => ({ seesToken: (t) => t.x < 15, tiles: new Map([["0,0", { f: 2 }]]) }),
    sightFromTiles: (tiles, sceneId): PartySight => ({ seesToken: (t) => tiles[`${sceneId}:0,0`] !== undefined && t.x < 15, tiles: new Map() }),
  };
  test("applying each viewer's diffs to its snapshot equals a fresh projection, with creatures walking in and out of sight", () => {
    const real = { ...visionRules };
    Object.assign(visionRules, fake);
    try {
      let applied = 0;
      for (let seed = 101; seed <= 140; seed++) applied += runSequence(seed, 40).applied;
      assert.ok(applied > 600, `only ${applied} ops applied`);
    } finally {
      Object.assign(visionRules, real);
    }
  });
});

describe("narrow sight dependents (docs/design-v1-maps-vision.md 4.3.5)", () => {
  /** A player character with darkvision on a dark vision scene, a goblin it sees and one far off. */
  function dark(): RoomState {
    const state = room();
    state.scenes.s1 = scene("s1", { fogEnabled: true, vision: { on: true, light: "dark" } });
    state.characters.c1 = character("c1", { actor: actor({ senses: "darkvision 30 ft" }) });
    state.tokens.pc = token("pc", { kind: "pc", actor: { ref: "c1" }, x: 4, y: 4 });
    state.tokens.gob = token("gob", { x: 6, y: 4 });
    state.tokens.far = token("far", { x: 35, y: 20 });
    return state;
  }

  test("only the sight tiles whose value changed, kept or computed again", () => {
    const state = dark();
    assert.deepEqual(changedSightKeys(state, { ...state }, ["s1", "s2"]), []);
    // Ten cells east: the tile it leaves goes dark and the next one lights.
    const moved = apply(state, { t: "token.move", tokenId: "pc", x: 14, y: 4 });
    const changed = changedSightKeys(state, moved, ["s1"]);
    assert.ok(changed.length > 0);
    for (const key of changed) assert.match(key, /^sight:s1:[01],0$/);
    assert.deepEqual(changedSightKeys(state, moved, ["s2"]), [], "only the scenes asked about");
    // Computed from nothing, the same sight compares equal by content.
    clearVisionCache();
    assert.deepEqual(changedSightKeys(moved, { ...moved }, ["s1"]), []);
  });

  test("a changed tile brings the tokens, labels and stamps on it and nothing else", () => {
    const state = dark();
    state.labels.near = { id: "near", rev: 0, sceneId: "s1", x: 5.5, y: 6.5, text: "Trap", size: 0.5 };
    state.labels.away = { id: "away", rev: 0, sceneId: "s1", x: 30.5, y: 20.5, text: "Well", size: 0.5 };
    const deps = dependents(state, [keys.sight("s1", 0, 0)]);
    for (const key of [keys.token("pc"), keys.token("gob"), keys.label("near"), keys.character("c1")]) assert.ok(deps.includes(key), key);
    for (const key of [keys.token("far"), keys.label("away"), keys.fog("s1", 0, 0)]) assert.ok(!deps.includes(key), key);
  });

  test("a creature dropped off the grid counts on every tile its sight rectangle reaches", () => {
    const state = dark();
    // Its footprint snaps into column 16, on tile 1, but sight judges it where it stands, from x = 15.6, on tile 0 too.
    state.tokens.gob = token("gob", { x: 15.6, y: 4 });
    assert.ok(dependents(state, [keys.sight("s1", 0, 0)]).includes(keys.token("gob")));
    assert.ok(dependents(state, [keys.sight("s1", 1, 0)]).includes(keys.token("gob")));
  });
});

describe("hashing and the held map", () => {
  test("hash128 gives the digests it gave before it read whole code units", () => {
    const cases = ["", "a", "ab", "abc", "abcdefg", "abcdefgh", "abcdefghi", "x".repeat(15), "x".repeat(16), "x".repeat(17), "梟梟梟梟梟梟梟梟梟", "\u{1F600}" + "y".repeat(30), '{"a":[1,{"c":"x"}],"b":1}'];
    assert.deepEqual(cases.map(hash128), [
      "00000000000000000000000000000000",
      "033bb196ccef4fe1ccef4fe1ccef4fe1",
      "260fb953af22b6fdaf22b6fdaf22b6fd",
      "2b5b97a320f75fb55012c2b45012c2b4",
      "851fde5ef81a9aab2a351f32fa8e8ca7",
      "6c3576558df898a1a76d230d42147114",
      "17a3d73237eee48604d39ee1ee7f6ddc",
      "5552ed85500681af1d95dcad22f1de19",
      "9af80aa91ebf41967d7690db078ba64d",
      "68d40c4a0fc417f63a632e8ab03ce116",
      "61c1a18a51131cc6d636f82656cfa3c2",
      "07e3e08cd6458ecd5cece69f613e3d8c",
      "66cb4aee03ffdff806a9f23c89dfcd76",
    ]);
  });

  test("a held value stands for its hash: the very same object is never hashed, an equal one sends nothing, a different one is sent", () => {
    const chunk = { sceneId: "s1", cx: 0, cy: 0, rev: 0, cells: { "1,1": "stone" }, edges: {} };
    let hashed = 0;
    const counting = (v: unknown) => {
      hashed++;
      return hashValue(v);
    };
    const held = new Map<EntityKey, HeldEntry>([["chunk:s1:0,0", chunk]]);
    const same = diffProjection(held, new Map([["chunk:s1:0,0", chunk]]), counting);
    assert.deepEqual([same.changes, hashed], [[], 0]);
    assert.equal(same.held.get("chunk:s1:0,0"), chunk);
    const equal = diffProjection(held, new Map([["chunk:s1:0,0", { ...chunk }]]), counting);
    assert.deepEqual(equal.changes, []);
    assert.equal(equal.held.get("chunk:s1:0,0"), hashValue(chunk));
    const moved = { ...chunk, cells: { "1,2": "stone" } };
    assert.deepEqual(diffProjection(held, new Map([["chunk:s1:0,0", moved]])).changes, [{ key: "chunk:s1:0,0", value: moved }]);
  });

  test("a player's chunk and fog tiles are the same objects while what they read stands, and new ones when it changes", () => {
    const state = room();
    const door = { kind: "door" as const, state: "closed" as const, secret: true, discovered: false };
    state.buildChunks["s1:0,0"] = { sceneId: "s1", cx: 0, cy: 0, rev: 0, cells: {}, edges: {} };
    state.buildChunks["s1:1,0"] = { sceneId: "s1", cx: 1, cy: 0, rev: 0, cells: { "16,3": "stone" }, edges: { "16,3,w": door } };
    const chunk = () => projectState(state, P1, { sceneId: "s1" }).buildChunks["s1:1,0"]!;
    const first = chunk();
    assert.equal(chunk(), first);
    assert.deepEqual(first.edges, {}, "floor beside nothing has an automatic wall there, so the hidden door is left out");
    // Painting the west neighbor takes that automatic wall away, so the hidden door must now arrive as a plain wall.
    state.buildChunks = { ...state.buildChunks, "s1:0,0": { ...state.buildChunks["s1:0,0"]!, cells: { "15,3": "stone" } } };
    const painted = chunk();
    assert.notEqual(painted, first);
    assert.deepEqual(painted.edges, { "16,3,w": { kind: "wall" } });
    state.scenes.s1 = { ...state.scenes.s1!, autoWalls: "off" };
    assert.notEqual(chunk(), painted, "a new automatic walls rule projects again");

    state.scenes.s1 = { ...state.scenes.s1!, fogEnabled: true };
    reveal(state, "s1", { x: 0, y: 0, w: 4, h: 4 });
    const fog = () => projectState(state, P1, { sceneId: "s1" }).fogTiles["s1:0,0"]!;
    const dmOnly = fog();
    assert.equal(fog(), dmOnly);
    state.exploredTiles = { "s1:0,0": { sceneId: "s1", tx: 0, ty: 0, rev: 1, bits: FULL_TILE_BITS } };
    const merged = fog();
    assert.notEqual(merged, dmOnly);
    assert.equal(fog(), merged);
    assert.equal(merged.bits, FULL_TILE_BITS);
  });
});
