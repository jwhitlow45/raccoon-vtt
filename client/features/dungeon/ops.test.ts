import assert from "node:assert/strict";
import { test } from "node:test";
import { serializedBytes } from "#shared/limits.ts";
import { clientOpSchema, MAX_BUILD_CELLS, type ClientOp } from "#shared/protocol.ts";
import { trapPreset } from "#shared/srd/traps.ts";
import { groundAt } from "#shared/rules/heights.ts";
import { dialogScene, dressedRooms, hundredOps, hundredPlan, twoRooms, widestDoors } from "./handPlans.ts";
import { buildOps, dressOps, MAX_OPS, PAGE_PLACEHOLDER, SCENE_PLACEHOLDER, stonePlaceholder, trapInputOf, trapOps, trapPlaceholder, withIds } from "./ops.ts";
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
  assert.deepEqual(summarize(plan), { rooms: 0, asked: 40, doors: 99, locked: 15, traps: 0, secretDoors: 0, secretRooms: 0, lights: 0 });
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

/** The 100-op hand plan's ops, as the worker writes them. */
function hundred(): ClientOp[] {
  const plan = hundredPlan();
  return hundredOps({ ...dialogScene(plan), id: SCENE_PLACEHOLDER });
}

test("DG2B: the 100-op hand plan lands exactly MAX_OPS ops through the scratch room, each a valid op within its bytes", () => {
  const ops = hundred();
  assert.equal(ops.length, MAX_OPS);
  const landed = landAll(scratchRoom(), ops);
  assert.ok(landed.ok, landed.ok ? "" : landed.why);
  for (const op of ops) assert.ok(clientOpSchema.safeParse(op).success, `${op.t} parses`);
  for (const op of ops) assert.ok(serializedBytes(op) <= OP_BYTES, `${op.t} within an op's bytes`);
});

test("DG2B: Make's ids are fresh for every stamp, light, stone, trap, the key page, its blocks and every pin, and references follow them", () => {
  const ops = hundred();
  let n = 0;
  let b = 0;
  const made = withIds(ops, () => `fresh-${++n}`, () => `block${String(++b).padStart(7, "0")}`);
  const text = JSON.stringify(made.ops);
  for (const placeholder of made.ids.keys()) assert.ok(!text.includes(JSON.stringify(placeholder)), `${placeholder} replaced`);
  const fresh = [...made.ids.values()];
  assert.equal(new Set(fresh).size, fresh.length, "every id once");
  const of = <T extends ClientOp["t"]>(t: T) => made.ops.filter((op): op is Extract<ClientOp, { t: T }> => op.t === t);
  const stamps = of("build.stamps").flatMap((op) => op.put ?? []);
  const lights = of("build.lights").flatMap((op) => op.put ?? []);
  const tokens = of("token.create").map((op) => op.token);
  const page = of("journal.create")[0]!.page;
  const pins = of("pin.put").map((op) => op.pin);
  assert.deepEqual([stamps.length, lights.length, tokens.length, pins.length, page.blocks.length], [160, 40, 2, 40, 41]);
  for (const id of [...stamps, ...lights, ...tokens, page, ...pins].map((x) => x.id)) assert.match(id, /^fresh-\d+$/);
  for (const block of page.blocks) assert.match(block.id, /^[A-Za-z0-9_-]{12}$/, "a block id is 12 characters");
  assert.equal(made.ids.get(PAGE_PLACEHOLDER), page.id);
  for (const pin of pins) {
    assert.equal(pin.pageId, page.id, "each pin links the page this send made");
    assert.equal(pin.sceneId, made.sceneId);
  }
  const shows = of("trap.create").flatMap((op) => op.trap.rig.actions.flatMap((a) => ("show" in a && "tokenId" in a.show ? [a.show.tokenId] : [])));
  for (const id of shows) assert.ok(tokens.some((t) => t.id === id), "a show action names a stone this send made");
  const again = withIds(ops, () => `again-${++n}`);
  assert.equal([...again.ids.values()].filter((id) => made.ids.has(id) || fresh.includes(id)).length, 0, "a second Make repeats no id");
  assert.ok(landAll(scratchRoom(), made.ops).ok, "the fresh ops land as the preview's did");
});

test("DG2B: a block id drawn twice in one page is drawn again", () => {
  const ops = hundred();
  const draws = ["AAAAAAAAAAAA", "AAAAAAAAAAAA", "BBBBBBBBBBBB"];
  let k = 0;
  const made = withIds(ops, () => `id-${k++}`, () => draws.shift() ?? `C${String(k++).padStart(11, "0")}`);
  const blocks = made.ops.flatMap((op) => (op.t === "journal.create" ? op.page.blocks.map((x) => x.id) : []));
  assert.deepEqual(blocks.slice(0, 2), ["AAAAAAAAAAAA", "BBBBBBBBBBBB"]);
  assert.equal(new Set(blocks).size, blocks.length);
});

test("DG2B: withIds refuses a reference to anything this send did not make before it, an id made twice, and a removal", () => {
  const ops = hundred();
  const id = (() => {
    let n = 0;
    return () => `x${++n}`;
  })();
  const at = (t: ClientOp["t"]) => ops.findIndex((op) => op.t === t);
  const pinFirst = [...ops];
  const [pin] = pinFirst.splice(at("pin.put"), 1);
  pinFirst.splice(1, 0, pin!);
  assert.throws(() => withIds(pinFirst, id), /names dungeon-key, which it has not made/);
  const stray = ops.map((op) => (op.t === "pin.put" ? { ...op, pin: { ...op.pin, pageId: "someone-elses-page" } } : op));
  assert.throws(() => withIds(stray, id), /names someone-elses-page/);
  const showFirst = ops.filter((op) => op.t !== "token.create");
  assert.throws(() => withIds(showFirst, id), /names dungeon-stone-0/);
  const showsScene = ops.map((op) => (op.t === "trap.create" && op.trap.rig.actions.length > 0 ? { ...op, trap: { ...op.trap, rig: { ...op.trap.rig, actions: [{ show: { tokenId: SCENE_PLACEHOLDER } }] } } } : op));
  assert.throws(() => withIds(showsScene, id), /which it has not made/);
  const twice = [...ops, ops.find((op) => op.t === "token.create")!];
  assert.throws(() => withIds(twice, id), /makes dungeon-stone-0 twice/);
  const removes = ops.map((op) => (op.t === "build.stamps" ? { ...op, remove: ["old"] } : op));
  assert.throws(() => withIds(removes, id), /removes no stamp/);
  const pinElsewhere = ops.map((op) => (op.t === "pin.put" ? { ...op, pin: { ...op.pin, sceneId: "elsewhere" } } : op));
  assert.throws(() => withIds(pinElsewhere, id), /another scene/);
});

test("DG2B: stamps go 100 an op in plan order, drawn in that order, for everyone, at the plan's place, size and turn", () => {
  const plan = hundredPlan();
  const ops = dressOps(plan, SCENE_PLACEHOLDER);
  const stampOps = ops.filter((op) => op.t === "build.stamps");
  assert.deepEqual(stampOps.map((op) => (op.t === "build.stamps" ? op.put?.length : 0)), [100, 60]);
  const put = stampOps.flatMap((op) => (op.t === "build.stamps" ? op.put ?? [] : []));
  assert.deepEqual(put.map((p) => p.z), plan.stamps.map((_, i) => i), "z in placement order");
  for (const [i, p] of put.entries()) {
    const s = plan.stamps[i]!;
    assert.deepEqual({ art: p.art, x: p.x, y: p.y, w: p.w, h: p.h, rotation: p.rotation, visibility: p.visibility }, { art: { key: s.key }, x: s.x, y: s.y, w: s.w, h: s.h, rotation: s.rotation, visibility: "all" });
  }
  for (const op of ops) assert.ok(clientOpSchema.safeParse(op).success && serializedBytes(op) <= OP_BYTES, op.t);
});

test("DG2B: lights go in one op with their SRD preset's radii, lit, casting shadows, labeled", () => {
  const plan = twoRooms();
  plan.lights = [
    { x: 4.5, y: 4.5, preset: "Torch", label: "Fire pit", stamp: "fire-pit" },
    { x: 16.5, y: 3.5, preset: "Candle", label: "Candelabra", stamp: "ph-candelabra" },
    { x: 20.25, y: 8.75, preset: "Hooded Lantern", label: "Lantern", stamp: "ph-lantern" },
  ];
  const lights = dressOps(plan, SCENE_PLACEHOLDER).filter((op) => op.t === "build.lights");
  assert.equal(lights.length, 1);
  const put = lights[0]!.t === "build.lights" ? lights[0]!.put ?? [] : [];
  assert.deepEqual(put.map(({ id: _id, ...l }) => l), [
    { x: 4.5, y: 4.5, bright: 20, dim: 20, on: true, walls: true, label: "Fire pit" },
    { x: 16.5, y: 3.5, bright: 5, dim: 5, on: true, walls: true, label: "Candelabra" },
    { x: 20.25, y: 8.75, bright: 30, dim: 30, on: true, walls: true, label: "Lantern" },
  ]);
});

test("DG2B: a Rolling Stone's token is a hidden Large object with the stone's numbers, and its trap's one action shows it", () => {
  const plan = dressedRooms();
  const tokens = dressOps(plan, SCENE_PLACEHOLDER).flatMap((op) => (op.t === "token.create" ? [op.token] : []));
  assert.equal(tokens.length, 1);
  const stone = tokens[0]!;
  assert.deepEqual({ id: stone.id, kind: stone.kind, name: stone.name, size: stone.size, x: stone.x, y: stone.y, visibility: stone.visibility, image: stone.image, notes: stone.notes }, {
    id: stonePlaceholder(0),
    kind: "object",
    name: "Rolling stone",
    size: "large",
    x: 8,
    y: 4,
    visibility: "dm",
    image: { icon: "lorc/stone-sphere", color: "#2a2a32" },
    notes: "Damage Threshold 10. A Large object.",
  });
  const actor = "inline" in stone.actor ? stone.actor.inline : null;
  assert.deepEqual([actor?.initBonus, actor?.speeds, actor?.ac, actor?.hp], [8, { walk: 60 }, 17, { cur: 100, max: 100, temp: 0 }]);
  const landed = landAll(scratchRoom(), [...buildOps(plan, { ...dialogScene(plan), id: SCENE_PLACEHOLDER }), ...dressOps(plan, SCENE_PLACEHOLDER)]);
  assert.ok(landed.ok, landed.ok ? "" : landed.why);
  const roll = trapOps(plan, landed.room.buildChunks, "11-16", SCENE_PLACEHOLDER).find((op) => op.t === "trap.create" && op.trap.rig.preset === "rolling-stone");
  assert.ok(roll?.t === "trap.create");
  assert.deepEqual(roll.trap.rig.actions, [{ show: { tokenId: stonePlaceholder(0) } }]);
});

test("DG2B: a trap's planned hits replace the zone's squares, and a cone takes the plan's origin at the ground there and its yaw", () => {
  const plan = dressedRooms();
  const landed = landAll(scratchRoom(), buildOps(plan, { ...dialogScene(plan), id: SCENE_PLACEHOLDER }));
  assert.ok(landed.ok);
  const chunks = landed.room.buildChunks;
  const darts = trapInputOf(plan.traps[3]!, "t", chunks, "1-4", SCENE_PLACEHOLDER);
  assert.deepEqual(darts.rig.hits, { cells: [{ x: 8, y: 5, w: 4, h: 1 }] });
  assert.deepEqual(darts.zone, { cells: [{ x: 9, y: 5, w: 1, h: 1 }] }, "the zone stays the plate");
  const statue = trapInputOf(plan.traps[4]!, "t", chunks, "5-10", SCENE_PLACEHOLDER);
  const hits = statue.rig.hits;
  assert.ok(typeof hits === "object" && "area" in hits);
  assert.equal(groundAt(chunks, SCENE_PLACEHOLDER, 20, 8), 5, "the statue stands in the raised room");
  assert.deepEqual({ origin: hits.area.origin, yaw: hits.area.yaw, shape: hits.area.shape, size: hits.area.size }, { origin: { x: 20.5, y: 8.5, z: 5 }, yaw: 225, shape: "cone", size: 30 });
  const plain = trapInputOf({ preset: "hidden-pit", zone: { cells: [{ x: 17, y: 4, w: 2, h: 2 }] } }, "t", chunks, "1-4", SCENE_PLACEHOLDER);
  assert.equal(plain.rig.hits, "trigger", "a trap without planned hits keeps the preset's");
  assert.deepEqual(plain.rig.actions, []);
  assert.throws(() => trapInputOf({ preset: "hidden-pit", zone: { cells: [{ x: 17, y: 4, w: 2, h: 2 }] }, cone: { origin: [1, 1], yaw: 0 } }, "t", chunks, "1-4", SCENE_PLACEHOLDER), /no cone/);
});

test("DG2B: a secret door is written closed, hidden and unfound until drules lane B's cover lands", () => {
  const plan = twoRooms();
  plan.doors = [...plan.doors, { edge: "8,6,w", state: "secret" }];
  const edges = buildOps(plan, { ...dialogScene(plan), id: SCENE_PLACEHOLDER }).flatMap((op) => (op.t === "build.edge" ? op.edges : []));
  assert.deepEqual(edges.at(-1), { key: "8,6,w", feature: { kind: "door", state: "closed", secret: true, discovered: false } });
});
