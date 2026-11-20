import assert from "node:assert/strict";
import { test } from "node:test";
import { visionRules } from "../shared/ruleHooks.ts";

/*
 * The server bench times holders' rasters through a wrapper on the vision
 * hook, which only its run puts in place (review PV2-BENCH-PROXY): a file
 * that imports the bench keeps the hook every other module reads.
 */

test("importing the server bench leaves the holder sight and class sight hooks as they were", async () => {
  const before = { holderSight: visionRules.holderSight, sightFor: visionRules.sightFor };
  await import("./bench-server4.ts");
  assert.equal(visionRules.holderSight, before.holderSight);
  assert.equal(visionRules.sightFor, before.sightFor);
});

/*
 * Row OPEN-1 (docs/design/design-v1-floors.md phase 4, 13) times sight
 * through openings against the same room without them, and the timing hook
 * times a floor's joined answer, which raises its tiles when first read.
 */

test("the openings row's two rooms differ in their 16 openings of 8 by 8 alone, which join both dark floors", async () => {
  const { openingsBenchRoom } = await import("./bench-server4.ts");
  const { openingJoins } = await import("../shared/rules/openingSight.ts");
  const open = openingsBenchRoom(true);
  const shut = openingsBenchRoom(false);
  assert.deepEqual({ ...open, floorLinks: {} }, shut);
  const ends = Object.values(open.floorLinks ?? {});
  assert.equal(ends.length, 32);
  assert.ok(ends.every((l) => l?.kind === "opening" && l.rect.w === 8 && l.rect.h === 8));
  for (const sceneId of ["bench", "benchup"]) {
    const scene = open.scenes[sceneId]!;
    assert.deepEqual([scene.bounds, scene.vision?.light], [{ w: 100, h: 100 }, "dark"]);
    assert.equal(openingJoins(open, sceneId).length, 16, `${sceneId} joins through every opening`);
    assert.equal(openingJoins(shut, sceneId).length, 0);
  }
});

test("the timing hook times a joined answer's tiles once, and leaves each floor's own answer as it was", async () => {
  const { timeSight } = await import("./bench-server4.ts");
  const { clearVisionCache } = await import("../shared/rules/vision.ts");
  const { ATTIC, GROUND, UPPER } = await import("../shared/floorLinksTestutil.ts");
  const { openTower, pc, withAll } = await import("../shared/openingsTestutil.ts");
  const before = { holderSight: visionRules.holderSight, sightFor: visionRules.sightFor };
  let clock = 0;
  const span = { commitAt: 1, drawn: 0, read: 0 };
  clearVisionCache();
  const untime = timeSight(() => span, () => ++clock);
  try {
    // Thorn upstairs over the opening to Ground floor, every floor per player, and Attic with no opening.
    const s = withAll(openTower({}, { perPlayer: [GROUND, UPPER, ATTIC] }), [pc("thorn", "p1", UPPER, 6, 6, {}, "Darkvision 60 ft")]);
    const own = visionRules.holderSight(s, ATTIC, "p1");
    assert.equal(visionRules.sightFor(s, ATTIC, { holder: "p1" }), own, "a holder's own answer, timed once by the holder hook");
    const union = visionRules.partySight(s, ATTIC);
    assert.equal(visionRules.sightFor(s, ATTIC, "union"), union, "the party's own answer, which no row timed");
    const joined = visionRules.sightFor(s, UPPER, { holder: "p1" });
    assert.notEqual(joined, visionRules.holderSight(s, UPPER, "p1"), "Upper floor's answer is joined through the opening");
    const start = clock;
    const tiles = joined.tiles;
    // Only the outer read's own two clock reads count: the holder answers it reads inside add nothing of their own.
    assert.equal(span.drawn, clock - (start + 1));
    assert.ok(span.drawn > 1, "the joined read reads its own answer's tiles inside it");
    assert.equal(span.read, span.drawn);
    assert.deepEqual([...tiles.keys()], [...before.sightFor(s, UPPER, { holder: "p1" }).tiles.keys()], "the wrapper answers as the joined answer does");
  } finally {
    untime();
  }
  assert.equal(visionRules.holderSight, before.holderSight);
  assert.equal(visionRules.sightFor, before.sightFor);
});

test("the openings row's report holds each batch to 1.3 times its time without openings and the first snapshots to the gate", async () => {
  const { formatOpeningsBench } = await import("./bench-server4.ts");
  const moves = (ms: number) => Array.from({ length: 3 }, () => ({ total: ms, fanout: ms / 2, drawn: 0, read: ms / 4 }));
  const run = (party: number, carrier: number, first: number) => ({ party: moves(party), carrier: moves(carrier), first: [first], later: [first / 2] });
  const fits = formatOpeningsBench({ without: run(10, 2, 50), with: run(13, 2.6, 160) }, false, REVISION);
  assert.ok(fits.includes(`Revision: ${REVISION}`));
  assert.ok(fits.includes("the party's move 1.30, the goblin's 1.30, limit 1.30: yes"));
  assert.ok(fits.includes("the DM's 160.0 ms, a player's 80.0 ms, limit 166.7 ms: yes"));
  assert.ok(fits.includes("16 openings of 8 by 8 | 13.0 / 13.0 | 6.5 | 3.3 | 2.6 / 2.6 | 0.7 | 160.0 / 160.0 | 80.0 / 80.0"));
  const over = formatOpeningsBench({ without: run(10, 2, 50), with: run(10, 2.7, 170) }, false);
  assert.ok(over.includes("the goblin's 1.35, limit 1.30: NO"), "either move past the ratio fails the row");
  assert.ok(over.includes("limit 166.7 ms: NO"));
  assert.ok(formatOpeningsBench({ without: run(10, 2, 50), with: run(10, 2, 170) }, true).includes("limit 250.0 ms: yes"), "the server box's gate is the budget itself");
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

test("an op whose commit a loaded machine holds well past half a second still gets its answer, timed to its frames", async () => {
  const { send } = await import("./bench-server4.ts");
  const table = await shortDiscoveryTable();
  try {
    // Longer than any window of polls the bench once gave an answer (100 waits of 5 ms), as a loaded machine can be.
    table.db.hold = new Promise((resolve) => setTimeout(resolve, 1_500));
    const timing = await send(table, table.dm, { t: "encounter.next" });
    assert.equal(table.db.hold, null, "the commit took the hold");
    assert.ok(timing.total >= 1_400, `the op is timed to the frames after its held commit, not ${timing.total} ms`);
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

test("the creature numbers row's room hides its Goblins behind a closed door, monsters or objects as asked", async () => {
  const { numbersBenchRoom } = await import("./bench-server4.ts");
  const { projectState } = await import("../shared/project.ts");
  for (const monsters of [0, 50, 100]) {
    const room = numbersBenchRoom(monsters);
    const goblins = Object.values(room.tokens).filter((t) => t.name === "Goblin");
    assert.equal(goblins.length, 100);
    assert.equal(goblins.filter((t) => t.kind === "monster").length, monsters);
    assert.ok(goblins.every((t) => t.number === undefined && t.met === undefined), "no Goblin starts with a number");
    assert.equal(Object.values(room.tokens).filter((t) => t.kind === "pc").length, 4);
    const view = projectState(room, { memberId: "p1", role: "player" }, { sceneId: "bench" });
    assert.equal(Object.values(view.tokens).filter((t) => t.name === "Goblin").length, 0, "the party holds none of them");
  }
});
