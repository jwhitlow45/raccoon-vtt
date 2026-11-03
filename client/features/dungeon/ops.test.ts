import assert from "node:assert/strict";
import { test } from "node:test";
import { serializedBytes } from "#shared/limits.ts";
import { clientOpSchema, MAX_BUILD_CELLS, type ClientOp } from "#shared/protocol.ts";
import { trapPreset } from "#shared/srd/traps.ts";
import { dialogScene, twoRooms, widestDoors } from "./handPlans.ts";
import { buildOps, SCENE_PLACEHOLDER, trapOps, trapPlaceholder, withIds } from "./ops.ts";
import { landAll, scratchRoom, summarize } from "./scratch.ts";
import { OP_BYTES } from "../uvtt/batch.ts";

/** The socket's frame bound (server/rooms/ws.ts), with room for the op message round an op. */
const FRAME_BYTES = 64 * 1024;

function opsOf(plan = twoRooms()): ClientOp[] {
  const scene = { ...dialogScene(plan), id: SCENE_PLACEHOLDER };
  const build = buildOps(plan, scene);
  const landed = landAll(scratchRoom(), build);
  assert.ok(landed.ok, landed.ok ? "" : landed.why);
  return [...build, ...trapOps(plan, landed.room.buildChunks, "1-4", SCENE_PLACEHOLDER)];
}

test("DG-B: the ops run scene first, then floors, overlays, doors, heights and stairs, and traps last", () => {
  const ops = opsOf();
  assert.deepEqual(
    ops.map((op) => (op.t === "build.paint" ? `paint ${op.terrain}` : op.t === "build.stairs" ? `stairs ${op.up}` : op.t)),
    ["scene.create", "paint stone", "paint wood", "paint rubble", "build.edge", "build.height", "stairs e", "stairs w", "trap.create", "trap.create"],
  );
  for (const op of ops) assert.ok(clientOpSchema.safeParse(op).success, `${op.t} parses`);
  for (const op of ops) assert.ok(serializedBytes(op) <= OP_BYTES, `${op.t} within an op's bytes`);
});

test("DG-B: every edge is a door, never a wall, closed or locked and never secret, and the scene has no starting view", () => {
  const plan = twoRooms();
  const scene = { ...dialogScene(plan), id: SCENE_PLACEHOLDER, defaultView: { x: 5, y: 5, zoom: 1 } };
  const ops = buildOps(plan, scene);
  const create = ops[0];
  assert.equal(create?.t, "scene.create");
  if (create?.t === "scene.create") assert.equal("defaultView" in create.scene, false);
  const edges = ops.flatMap((op) => (op.t === "build.edge" ? op.edges : []));
  assert.deepEqual(edges, [
    { key: "3,5,w", feature: { kind: "door", state: "closed", secret: false, discovered: false } },
    { key: "8,5,w", feature: { kind: "door", state: "closed", secret: false, discovered: false } },
    { key: "15,5,w", feature: { kind: "door", state: "locked", secret: false, discovered: false } },
  ]);
});

test("DG-B: heights go one op per value, 0 left out, and cells split at the op's cap", () => {
  const plan = twoRooms();
  plan.heights = [{ ft: 0, cells: ["1,1"] }, ...plan.heights, { ft: -10, cells: ["20,20"] }];
  const many: string[] = [];
  for (let y = 0; y < 100; y++) for (let x = 0; x < 45; x++) many.push(`${x},${y}`);
  plan.w = plan.h = 100;
  plan.paint = { ...plan.paint, cave: many };
  const ops = buildOps(plan, { ...dialogScene(plan), id: SCENE_PLACEHOLDER });
  assert.deepEqual(ops.filter((op) => op.t === "build.height").map((op) => (op.t === "build.height" ? [op.height, op.cells.length] : null)), [[5, 37], [-10, 1]]);
  const caves = ops.filter((op) => op.t === "build.paint" && op.terrain === "cave");
  assert.deepEqual(caves.map((op) => (op.t === "build.paint" ? op.cells.length : 0)), [MAX_BUILD_CELLS, MAX_BUILD_CELLS, 500]);
  assert.deepEqual(caves.flatMap((op) => (op.t === "build.paint" ? op.cells : [])), many, "every cell once, in order");
});

test("DG-B: the largest Wide topology's 198 door edges go in one build.edge, well inside a frame", () => {
  const plan = widestDoors();
  assert.equal(plan.doors.length, 198);
  const ops = buildOps(plan, { ...dialogScene(plan), id: SCENE_PLACEHOLDER });
  const edgeOps = ops.filter((op) => op.t === "build.edge");
  assert.equal(edgeOps.length, 1);
  const only = edgeOps[0]!;
  assert.ok(only.t === "build.edge" && only.edges.length === 198);
  assert.ok(serializedBytes({ t: "op", n: 1_000_000, op: only, g: "0".repeat(36), groupScope: "setup" }) < FRAME_BYTES);
  assert.ok(clientOpSchema.safeParse(only).success);
  // Each doorway's two edges are one double door.
  assert.deepEqual(summarize(plan), { rooms: 0, asked: 40, doors: 99, locked: 15, traps: 0 });
});

test("DG-B: traps are the presets at the party's level, unfound, the pit's floor under the raised room's ground", () => {
  const plan = twoRooms();
  const ops = opsOf(plan).filter((op) => op.t === "trap.create");
  assert.deepEqual(ops.map((op) => (op.t === "trap.create" ? op.trap.id : "")), [trapPlaceholder(0), trapPlaceholder(1)]);
  const [pit, needle] = ops.map((op) => (op.t === "trap.create" ? op.trap : null));
  assert.equal(pit?.name, "Hidden Pit");
  assert.equal(pit?.rig.pit?.floor, 5 - trapPreset("hidden-pit", "1-4")!.pitDepth!, "a 10 ft pit under a floor raised 5 ft");
  assert.equal(pit?.found, undefined, "a new trap is unfound");
  assert.deepEqual(needle?.zone, { door: { edge: "15,5,w" } });
  assert.equal(needle?.rig.save?.dc, trapPreset("poisoned-needle", "1-4")!.rig.save?.dc);
  const high = trapOps(plan, scratchRoom().buildChunks, "11-16", SCENE_PLACEHOLDER);
  const deep = high[0];
  assert.ok(deep?.t === "trap.create");
  assert.equal(deep.trap.rig.pit?.floor, -trapPreset("hidden-pit", "11-16")!.pitDepth!, "over unbuilt ground the floor reads from 0");
  assert.deepEqual(deep.trap.rig.damage, trapPreset("hidden-pit", "11-16")!.rig.damage);
  const deepest = trapOps(plan, scratchRoom().buildChunks, "17-20", SCENE_PLACEHOLDER)[0];
  assert.ok(deepest?.t === "trap.create");
  assert.equal(deepest.trap.rig.pit?.floor, -100, "a 120 ft pit stops at the height rules' lowest ground");
});

test("DG-B: Make's ids are fresh for the scene and every trap, on every op, and a second Make never repeats them", () => {
  const ops = opsOf();
  const before = JSON.stringify(ops);
  let n = 0;
  const first = withIds(ops, () => `fresh-${++n}`);
  assert.equal(JSON.stringify(ops), before, "the preview's ops are left as they were");
  assert.equal(first.sceneId, "fresh-1");
  const text = JSON.stringify(first.ops);
  assert.ok(!text.includes(SCENE_PLACEHOLDER) && !text.includes(trapPlaceholder(0)) && !text.includes(trapPlaceholder(1)));
  for (const op of first.ops) {
    const sceneId = op.t === "scene.create" ? op.scene.id : op.t === "trap.create" ? op.trap.sceneId : "sceneId" in op ? op.sceneId : null;
    assert.equal(sceneId, "fresh-1", op.t);
  }
  assert.deepEqual(first.ops.flatMap((op) => (op.t === "trap.create" ? [op.trap.id] : [])), ["fresh-2", "fresh-3"]);
  const second = withIds(ops, () => `again-${++n}`);
  const ids = (made: typeof first) => new Set([made.sceneId, ...made.ops.flatMap((op) => (op.t === "trap.create" ? [op.trap.id] : []))]);
  assert.equal([...ids(first)].filter((id) => ids(second).has(id)).length, 0);
});

test("DG-B: withIds refuses ops that do not start with the scene, make a second one, or name another scene", () => {
  const ops = opsOf();
  const id = () => "x";
  assert.throws(() => withIds(ops.slice(1), id), /start with its scene/);
  assert.throws(() => withIds([...ops, ops[0]!], id), /one scene/);
  const stray = ops.map((op) => (op.t === "build.edge" ? { ...op, sceneId: "elsewhere" } : op));
  assert.throws(() => withIds(stray, id), /another scene/);
  assert.throws(() => withIds([ops[0]!, { t: "log.chat", text: "hi" }], id), /sends no log.chat/);
});

test("DG-B: nothing of the seed is in the ops", () => {
  const seed = "1K7QH2MXA9F3TWQ5";
  const text = JSON.stringify(opsOf());
  for (const part of [seed, seed.slice(1), "1K7Q", "H2MX", "A9F3", "TWQ5"]) assert.ok(!text.includes(part), part);
});
