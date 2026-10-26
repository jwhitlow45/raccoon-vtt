import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { BuildChunk, FogTile, RoomState } from "./model.ts";
import { keys } from "./keys.ts";
import { projectEntity } from "./project.ts";
import { applyOp } from "./reducer.ts";
import { Tx } from "./reducer/tx.ts";
import { visionRules } from "./ruleHooks.ts";
import { sceneWalls } from "./rules/walls.ts";
import { DM, FULL_TILE_BITS, P1, env, room, scene, token } from "./testutil.ts";
import { isWritable, markFinished, markWritable } from "./writable.ts";
import { SQUARES } from "./rules/grid.ts";

/**
 * Caches keyed on a state or a collection keep nothing about one an op may
 * still write into (W4-ASTRA-01). Each case asks while the object is marked
 * writable, changes it in place as a transaction does, and asks again.
 */
describe("caches and objects an op still writes into", () => {
  test("a transaction's state and the collections it copies are writable until the op finishes", () => {
    const before = room({ tokens: { a: token("a") } });
    const result = applyOp(before, { t: "token.move", tokenId: "a", x: 5, y: 5 }, DM, env(1));
    assert.ok(result.ok);
    assert.equal(isWritable(result.state), false);
    assert.equal(isWritable(result.state.tokens), false);
    assert.equal(isWritable(before.tokens), false, "a collection the op did not copy was never writable");
  });

  test("the party's sight and its token lists", () => {
    const s = room({ scenes: { s1: scene("s1", { bounds: { w: 20, h: 10 }, vision: { on: true, light: "bright" }, autoWalls: "off" }) }, tokens: { hero: token("hero", { kind: "pc", ownerIds: ["p1"], x: 2, y: 2 }) } });
    markWritable(s);
    markWritable(s.tokens);
    assert.ok(visionRules.partySight(s, "s1").tiles.size > 0);
    delete s.tokens.hero;
    assert.equal(visionRules.partySight(s, "s1").tiles.size, 0, "the token gone from the collection is gone from sight");
    markFinished(s);
    markFinished(s.tokens);
  });

  test("the walls' chunk lists", () => {
    const sc = scene("s1", { bounds: { w: 20, h: 10 }, autoWalls: "off" });
    const chunks: Record<string, BuildChunk> = { "s1:0,0": { sceneId: "s1", cx: 0, cy: 0, rev: 0, cells: {}, edges: {} } };
    markWritable(chunks);
    assert.equal(sceneWalls(sc, chunks).stored.n, 0);
    chunks["s1:1,0"] = { sceneId: "s1", cx: 1, cy: 0, rev: 0, cells: {}, edges: { "17,2,w": { kind: "wall" } } };
    assert.equal(sceneWalls(sc, chunks).stored.n, 1, "a chunk written in since is read");
    markFinished(chunks);
  });

  /*
   * W4-F-7: no op does this today, so a transaction does it by hand. The
   * first write copies the chunk collection, the read caches what it can,
   * and the second write goes into that same collection object.
   */
  test("two chunks written in one op with a sight read between them", () => {
    const s = room({
      scenes: { s1: scene("s1", { bounds: { w: 40, h: 16 }, vision: { on: true, light: "bright" }, autoWalls: "off" }) },
      tokens: { hero: token("hero", { kind: "pc", ownerIds: ["p1"], x: 2, y: 8 }) },
    });
    const tx = new Tx(s, DM, env(1));
    const wall = (x: number): BuildChunk => ({
      sceneId: "s1",
      cx: Math.floor(x / 16),
      cy: 0,
      rev: 0,
      cells: {},
      edges: Object.fromEntries(Array.from({ length: 16 }, (_, y) => [`${x},${y},w`, { kind: "wall" as const }])),
    });
    tx.write(keys.chunk("s1", 0, 0), wall(10));
    const between = visionRules.partySight(tx.state, "s1");
    assert.equal(between.seesToken({ size: "medium", x: 20, y: 8 }, SQUARES), false, "the first wall hides the far side");
    assert.equal(between.seesToken({ size: "medium", x: 5, y: 8 }, SQUARES), true);
    assert.equal(sceneWalls(tx.state.scenes.s1!, tx.state.buildChunks).stored.xy[0], 10);
    tx.write(keys.chunk("s1", 0, 0), { ...wall(10), edges: {} });
    tx.write(keys.chunk("s1", 1, 0), wall(20));
    tx.finish();
    const done = tx.state;
    const walls = sceneWalls(done.scenes.s1!, done.buildChunks);
    assert.deepEqual([walls.stored.n, walls.stored.xy[0]], [1, 20], "the finished build has the second chunk's wall in place of the first's");
    const sight = visionRules.partySight(done, "s1");
    assert.equal(sight.seesToken({ size: "medium", x: 15, y: 8 }, SQUARES), true, "the first wall is gone");
    assert.equal(sight.seesToken({ size: "medium", x: 25, y: 8 }, SQUARES), false, "the second one stands");
    assert.deepEqual([...sight.tiles], [...visionRules.partySight(JSON.parse(JSON.stringify(done)) as RoomState, "s1").tiles], "and it is what a fresh copy sees");
  });

  test("the fog presence labels and stamps are judged by", () => {
    const tile: FogTile = { sceneId: "s1", tx: 0, ty: 0, rev: 0, bits: FULL_TILE_BITS };
    const s: RoomState = room({
      scenes: { s1: scene("s1", { fogEnabled: true }) },
      labels: { l1: { id: "l1", rev: 0, sceneId: "s1", x: 3, y: 3, text: "Crypt", size: 1 } },
      exploredTiles: { "s1:2,1": { ...tile, tx: 2, ty: 1 } },
    });
    markWritable(s.fogTiles);
    assert.equal(projectEntity(keys.label("l1"), s, P1, { sceneId: "s1" }), null, "under the fog");
    s.fogTiles["s1:0,0"] = tile;
    assert.ok(projectEntity(keys.label("l1"), s, P1, { sceneId: "s1" }), "a fog tile revealed since is read");
    markFinished(s.fogTiles);
  });
});
