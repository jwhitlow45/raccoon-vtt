import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { encodeHeights } from "#shared/heightCodec.ts";
import { CHUNK_CELLS, type BuildChunk, type Light, type Trap } from "#shared/model.ts";
import { room, scene } from "#shared/testutil.ts";
import { squareWingBase, WING_SETTINGS } from "../dungeon/handPlans.ts";
import { wingPreviewOf } from "../dungeon/scratch.ts";
import { addedChunk, ghostOf, ghostRoomAt, ghostRooms, type WingGhost } from "./wingGhost.ts";

/*
 * The wing's ghost (docs/design: dungeon generator phase 3, 3.3): only what
 * the wing adds to the scene is drawn, its traps' squares, its lights'
 * reach and its rooms' numbers, where the wing stands on the scene.
 */

function chunk(over: Partial<BuildChunk> = {}): BuildChunk {
  return { sceneId: "s1", cx: 0, cy: 0, rev: 1, cells: {}, edges: {}, ...over };
}

function heights(at: Record<number, number>): string {
  const list = new Int16Array(CHUNK_CELLS * CHUNK_CELLS);
  for (const [k, ft] of Object.entries(at)) list[Number(k)] = ft;
  return encodeHeights(list)!;
}

describe("what a scratch chunk adds to the scene's", () => {
  test("cells, edges and walls the scene lacks or holds otherwise, walls compared by ends and feature since the wing's carry fresh ids", () => {
    const base = chunk({ cells: { "1,1": "stone", "2,1": "stone" }, edges: { "3,1,w": { kind: "wall" } }, walls: [{ id: "old", a: [1, 1], b: [2, 1], f: { kind: "wall" } }] });
    const scratch = chunk({
      cells: { "1,1": "stone", "2,1": "wood", "3,1": "stone" },
      edges: { "3,1,w": { kind: "door", state: "closed", secret: false, discovered: false } },
      walls: [
        { id: "new1", a: [1, 1], b: [2, 1], f: { kind: "wall" } },
        { id: "new2", a: [2, 1], b: [3, 1], f: { kind: "wall" } },
      ],
    });
    const added = addedChunk(scratch, base)!;
    assert.deepEqual(added.cells, { "2,1": "wood", "3,1": "stone" });
    assert.deepEqual(Object.keys(added.edges), ["3,1,w"]);
    assert.deepEqual(added.walls?.map((w) => w.id), ["new2"]);
  });

  test("heights, stair and difficult ground marks only where they changed", () => {
    const base = chunk({ heights: heights({ 0: 5, 1: 5 }) });
    const scratch = chunk({ heights: heights({ 0: 5, 1: 10, 2: -5 }), up: `${"n".repeat(1)}${".".repeat(255)}`, rough: `.d${".".repeat(254)}` });
    const added = addedChunk(scratch, base)!;
    assert.equal(added.heights, heights({ 1: 10, 2: -5 }));
    assert.equal(added.up?.[0], "n");
    assert.equal(added.rough?.[1], "d");
  });

  test("nothing where the chunk adds nothing", () => {
    const same = chunk({ cells: { "1,1": "stone" } });
    assert.equal(addedChunk(same, same), null);
  });
});

describe("the ghost of a wing", () => {
  const light = (id: string, sceneId: string): Light => ({ id, rev: 1, sceneId, x: 5, y: 5, bright: 20, dim: 20, on: true, walls: true });
  const trap = (id: string, sceneId: string): Trap => ({ id, rev: 1, sceneId, name: "Pit", zone: { cells: [{ x: 4, y: 4, w: 2, h: 2 }] }, state: "armed", found: false }) as Trap;

  test("landed in a copy of the scene: what it adds, and its own traps and lights by id", () => {
    const s1 = scene("s1", { bounds: { w: 40, h: 40 } });
    const base = room({ scenes: { s1 }, buildChunks: { "s1:0,0": chunk({ cells: { "1,1": "stone" } }) }, lights: { l0: light("l0", "s1") }, traps: { t0: trap("t0", "s1") } });
    const scratch = room({
      scenes: { s1 },
      buildChunks: { "s1:0,0": chunk({ cells: { "1,1": "stone", "8,8": "stone" } }) },
      lights: { l0: light("l0", "s1"), l1: light("l1", "s1") },
      traps: { t0: trap("t0", "s1"), t1: trap("t1", "s1") },
    });
    const ghost = ghostOf({ base, sceneId: "s1", scratch, scratchScene: s1, area: { x: 0, y: 0, w: 20, h: 20 }, offset: { x: 0, y: 0 }, feetPerCell: 5, rooms: [] });
    assert.deepEqual(ghost.chunks.map((c) => c.cells), [{ "8,8": "stone" }]);
    assert.deepEqual(ghost.lights, [{ x: 5, y: 5, reach: 8 }], "40 ft at 5 ft a cell");
    assert.deepEqual(ghost.traps, [{ x: 4, y: 4, w: 2, h: 2 }]);
  });

  test("landed on a scene of its own: all of it, at the area's corner", () => {
    const s1 = scene("s1");
    const own = scene("scratch", { bounds: { w: 20, h: 20 } });
    const scratch = room({ scenes: { scratch: own }, buildChunks: { "scratch:0,0": chunk({ sceneId: "scratch", cells: { "1,1": "stone" } }) }, lights: {}, traps: {} });
    const rooms = [{ n: 1, x: 2, y: 2, rect: { x: 1, y: 1, w: 3, h: 3 } }];
    const ghost = ghostOf({ base: room({ scenes: { s1 } }), sceneId: "s1", scratch, scratchScene: own, area: { x: 10, y: 10, w: 20, h: 20 }, offset: { x: 10, y: 10 }, feetPerCell: 5, rooms });
    assert.equal(ghost.chunks.length, 1);
    assert.deepEqual(ghost.offset, { x: 10, y: 10 });
    assert.equal(ghostRoomAt(ghost, { x: 12.5, y: 12.5 }, 0.5)?.n, 1, "inside the room as it stands on the scene");
    assert.equal(ghostRoomAt(ghost, { x: 14.3, y: 12.5 }, 0.5)?.n, 1, "within reach of its edge");
    assert.equal(ghostRoomAt(ghost, { x: 2.5, y: 2.5 }, 0.5), null, "where the room stands in its own scene is not where it stands on the map");
  });
});

describe("the ghost's rooms (DG3 review round 1)", () => {
  const SEED = "1Q8V2DR4HJ0Y7ZB3";
  /** A ghost of the given rooms where the wing landed in the scene itself. */
  const ghostWith = (rooms: WingGhost["rooms"]) => ({ offset: { x: 0, y: 0 }, rooms }) as WingGhost;

  test("a room's number is its facts' whatever DM key says, so a tap on a room opens the room drawn there", () => {
    const base = squareWingBase();
    const opened = new Map<boolean, Map<number, number>>();
    for (const key of [true, false]) {
      const p = wingPreviewOf({ ...WING_SETTINGS, key }, SEED, base, { feetPerCell: 5 }, null);
      if (!p.ok) throw new Error("the wing plans");
      const { plan, facts } = p;
      assert.equal(plan.key === null, !key);
      if (!key) assert.ok(facts.some((f) => f.n !== f.at + 1), "not vacuous: the key's numbers are not the plan's order");
      const ghost = ghostWith(ghostRooms(plan, facts));
      const rooms = new Map<number, number>();
      for (const f of facts) {
        const r = plan.rooms[f.at]!;
        const n = ghostRoomAt(ghost, { x: r.x + r.w / 2, y: r.y + r.h / 2 }, 0.5)?.n;
        const tapped = facts.find((g) => g.n === n);
        assert.equal(tapped?.room, f.room, `DM key ${key ? "on" : "off"}: a tap in room ${f.room}'s middle opens it`);
        rooms.set(f.room, n!);
      }
      opened.set(key, rooms);
    }
    assert.deepEqual(opened.get(false), opened.get(true), "the same number on each room with DM key off");
  });
});
