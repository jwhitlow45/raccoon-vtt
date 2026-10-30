import assert from "node:assert/strict";
import { test } from "node:test";
import { visionRules } from "../shared/ruleHooks.ts";

/*
 * The server bench times holders' rasters through a wrapper on the vision
 * hook, which only its run puts in place (review PV2-BENCH-PROXY): a file
 * that imports the bench keeps the hook every other module reads.
 */

test("importing the server bench leaves the holder sight hook as it was", async () => {
  const before = visionRules.holderSight;
  await import("./bench-server4.ts");
  assert.equal(visionRules.holderSight, before);
});

const REVISION = "3113e75800000000000000000000000000000000";

test("benchmark provenance requires a complete commit id when supplied", async () => {
  const { benchRevision } = await import("./bench-server4.ts");
  assert.equal(benchRevision([]), undefined);
  assert.equal(benchRevision(["--revision", REVISION]), REVISION);
  for (const args of [["--revision"], ["--revision", "3113e758"], ["--revision", "main"], ["--revision", REVISION, "--revision", REVISION]]) assert.throws(() => benchRevision(args), /full 40-character commit id/);
});

test("each discovery row keeps its target and its whole-party or per-player result under the documented machine scaling", async () => {
  const { formatServerBench } = await import("./bench-server4.ts");
  const rows = [
    { row: "build, whole party", budget: 25, ms: { median: 16.6, max: 80 }, covers: "paint" },
    { row: "build, per player", budget: 25, ms: { median: 16.7, max: 30 }, covers: "paint" },
    { row: "routed walk, per player", budget: 30, ms: { median: 20, max: 25 }, covers: "walk" },
    { row: "fan-out, whole party", budget: 10, ms: { median: 7, max: 9 }, covers: "fan-out" },
    { row: "global, whole party", budget: 250, ms: { median: 167, max: 190 }, covers: "global" },
    { row: "ask turn, per player", budget: 25, ms: { median: 34, max: 40 }, covers: "ask" },
    { row: "near twice, whole party", budget: 25, ms: { median: 100 / 3 + 0.0001, max: 40 }, covers: "paint" },
    { row: "ask answer, per player", budget: 5_000, ms: { median: 3_000, max: 6_000 }, covers: "ask" },
  ];
  const laptop = formatServerBench(rows, false, REVISION);
  assert.ok(laptop.includes(`Revision: ${REVISION}`));
  assert.ok(laptop.includes("laptop measurement, server budgets divided by 1.5"));
  assert.ok(laptop.includes("build, whole party | 16.6 / 80.0 | 25 | 16.7 | 1.00 | yes"));
  assert.ok(laptop.includes("build, per player | 16.7 / 30.0 | 25 | 16.7 | 1.00 | NO"), "the rounded displayed limit must not loosen the comparison");
  assert.ok(laptop.includes("routed walk, per player | 20.0 / 25.0 | 30 | 20.0 | 1.00 | yes"));
  assert.ok(laptop.includes("fan-out, whole party | 7.0 / 9.0 | 10 | 6.7 | 1.05 | NO"));
  assert.ok(laptop.includes("global, whole party | 167.0 / 190.0 | 250 | 166.7 | 1.00 | NO"));
  assert.ok(laptop.includes("ask turn, per player | 34.0 / 40.0 | 25 | 16.7 | 2.04 | NO"), "deploy's two-times condition can be read without changing the target");
  assert.ok(laptop.includes("ask answer, per player | 3000.0 / 6000.0 | 5000 | 3333.3 | 0.90 | yes"));
  assert.ok(laptop.includes("near twice, whole party | 33.3 / 40.0 | 25 | 16.7 | 2.00 | NO | yes"), "rounded timing and ratios must not hide a result above twice the limit");
  const server = formatServerBench(rows, true, REVISION);
  assert.ok(server.includes("server-box measurement, unscaled server budgets"));
  assert.ok(server.includes("build, per player | 16.7 / 30.0 | 25 | 25.0 | 0.67 | yes"));
  assert.ok(server.includes("ask turn, per player | 34.0 / 40.0 | 25 | 25.0 | 1.36 | NO"));
  assert.ok(formatServerBench([], false).includes("Revision: unrecorded"), "a legacy invocation must not claim commit provenance");
});

test("both ask fixtures are unexplored Explore scenes, including every per-player layer", async () => {
  const { askBenchRoom } = await import("./bench-server4.ts");
  for (const perPlayer of [false, true]) {
    const room = askBenchRoom(perPlayer);
    const scene = room.scenes.bench!;
    assert.equal(scene.fogEnabled, true);
    assert.equal(scene.vision?.on, true);
    assert.equal(scene.vision?.perPlayer === true, perPlayer);
    if (perPlayer) assert.equal(room.holders.bench!.entries.filter((e) => e.on).length, 6);
    for (const layer of [room.fogTiles, room.exploredTiles, room.exploredBy, room.memory, room.memoryBy, room.buildChunks]) assert.deepEqual(layer, {}, "a pre-explored layer would skip the ask's worst-case work");
  }
});

/** A small Explore scene keeps the transport regression independent of benchmark caps and timing targets. */
async function shortDiscoveryTable() {
  const { sitDown } = await import("./bench-server4.ts");
  const { member, room, scene, token } = await import("../shared/testutil.ts");
  const state = room();
  state.meta.playerSceneId = "bench";
  state.members = { dm: member("dm", "dm"), ...Object.fromEntries(Array.from({ length: 6 }, (_, i) => [`p${i + 1}`, member(`p${i + 1}`)])) };
  state.scenes = { bench: scene("bench", { bounds: { w: 12, h: 12 }, blockMovement: true, autoWalls: "off", fogEnabled: true, vision: { on: true, light: "bright" } }) };
  state.tokens.pc11 = token("pc11", { sceneId: "bench", kind: "pc", ownerIds: ["p1"], disposition: "ally", x: 2, y: 5 });
  state.playedScenes = { bench: { sceneId: "bench", rev: 0 } };
  state.encounter = { rev: 0, round: 1, activeEntryId: "e11", entries: [{ id: "e11", tokenId: "pc11", value: 15, tieOrder: 0, hidden: false, reactionUsed: false, inLair: false, hadTurn: true }] };
  state.templates.area = { id: "area", rev: 0, sceneId: "bench", shape: "sphere", size: 5, origin: { x: 5, y: 5, z: 0 }, yaw: 0, includeOrigin: true, color: "#ff8800", ownerId: "dm", visibility: "all", triggers: ["enter"] };
  return sitDown(state);
}

test("a short benchmark ask receives its answer after the actor commits", async () => {
  const { askTimed } = await import("./bench-server4.ts");
  const table = await shortDiscoveryTable();
  try {
    try {
      await askTimed(table, [{ t: "build.rect", sceneId: "bench", terrain: "wood", x: 0, y: 0, w: 2, h: 2 }]);
    } catch (error) {
      throw new Error(`last sender frame: ${table.sent.senderMessages.at(-1)}`, { cause: error });
    }
    const messages = table.sent.senderMessages.map((text) => JSON.parse(text) as { t: string; acks?: number[] });
    assert.ok(messages.some((message) => message.t === "ev" && message.acks?.includes(1)), "the ask was acknowledged");
    assert.equal(messages.at(-1)?.t, "history", "the later history frame must not hide the answer");
    assert.deepEqual(table.actor.committed.state.buildChunks, {}, "an ask checks the edit without applying it");
  } finally {
    await table.actor.shutdown({ code: 1012, snapshot: false });
  }
});

test("a short discovery walk receives both turn and routed-move answers", async () => {
  const { send } = await import("./bench-server4.ts");
  const table = await shortDiscoveryTable();
  try {
    try {
      await send(table, table.dm, { t: "encounter.next" });
      await send(table, table.dm, { t: "token.move", tokenId: "pc11", x: 8, y: 5, route: [[4, 5, 0, 0], [8, 5, 0, 0]] });
    } catch (error) {
      throw new Error(`last sender frame: ${table.sent.senderMessages.at(-1)}`, { cause: error });
    }
    const messages = table.sent.senderMessages.map((text) => JSON.parse(text) as { t: string; acks?: number[] });
    assert.ok(messages.some((message) => message.t === "ev" && message.acks?.includes(2)), "the move was acknowledged independently of the previous turn op");
    assert.equal(messages.at(-1)?.t, "history", "the later history frame must not hide the answer");
    assert.ok(!messages.some((message) => message.acks?.includes(1)), "a new op clears the previous op's captured frames");
    assert.equal(table.actor.committed.state.tokens.pc11!.x, 8);
    assert.ok(Object.keys(table.actor.committed.state.exploredTiles).length > 0, "the discovery path explores ground");
    assert.ok(table.actor.committed.state.log.some((line) => line.data?.type === "area"), "the routed walk crosses the area's reminder");
  } finally {
    await table.actor.shutdown({ code: 1012, snapshot: false });
  }
});

test("answer selection keeps operation identity across seeded interleavings of replies and other frames", async () => {
  const { benchAnswer } = await import("./bench-server4.ts");
  let seed = 40;
  const next = () => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0);
  for (let run = 0; run < 200; run++) {
    const n = run + 1;
    const wanted = run % 2 === 0
      ? { t: "ev", seq: run, changes: [], acks: [n] }
      : { t: "ev", seq: run, changes: [], rejects: [{ n, code: "invalid", message: "fixture refusal" }] };
    const unrelated = [
      { t: "history", seq: run },
      { t: "presence" },
      { t: "ev", seq: run, changes: [], acks: [n + 1] },
      { t: "ev", seq: run, changes: [], rejects: [{ n: n + 1, code: "invalid", message: "another op" }] },
      { t: "ev", seq: run, changes: [] },
    ].map((message) => JSON.stringify(message));
    assert.equal(benchAnswer(unrelated, n), null, "unrelated frames never settle the requested op");
    const frames = [...unrelated, JSON.stringify(wanted)];
    for (let i = frames.length - 1; i > 0; i--) {
      const j = next() % (i + 1);
      [frames[i], frames[j]] = [frames[j]!, frames[i]!];
    }
    assert.deepEqual(benchAnswer(frames, n), wanted, "an ack or refusal survives other frames in every position");
  }
});
