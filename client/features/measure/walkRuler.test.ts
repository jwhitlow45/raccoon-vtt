import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { SQUARES } from "#shared/rules/grid.ts";
import { chunkKey, holderTileKey } from "#shared/keys.ts";
import type { EdgeFeature, RoomState } from "#shared/model.ts";
import { mapSchemas } from "#shared/protocol.ts";
import { projectState } from "#shared/project.ts";
import { DM, P1, P2, reveal, room as baseRoom, scene, template, token } from "#shared/testutil.ts";
import { wall } from "#shared/discoveryTestutil.ts";
import { rasterizeFogOps } from "#shared/rules/fog.ts";
import { line, world } from "../movement/testing.ts";
import { keptDrawing, keptStops, tokenStop, type RulerStop } from "./ruler.ts";
import { WorkBudget } from "#shared/rules/walk.ts";
import { heldKey, legReading, measureWalk, nextHeld, saveWalk, savedWalk, walkShown, walkText, type HeldWalk, type WalkMeasure } from "./walkRuler.ts";

/** The ruler's walking mode (docs/design-v1-movement.md 3.3). */

function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A wall along x = 6 from the top down to y = 10, so a walk from the left side to the right goes round its end. */
function room(): RoomState {
  return world({ edges: line("w", 6, 0, 10) });
}

const free = (x: number, y: number): RulerStop => ({ x: x + 0.5, y: y + 0.5 });
const WALL: EdgeFeature = { kind: "wall" };

describe("the walking ruler", () => {
  test("a Medium creature from empty ground walks round the wall's end, and the total says so", () => {
    const m = measureWalk({ view: room(), sceneId: "s1", stops: [free(2, 5), free(9, 5)], viewer: { role: "player" }, everything: false })!;
    assert.equal(m.legs.length, 1);
    assert.ok(m.legs[0]!.corners.length > 0, "it bends");
    assert.ok(m.totalFt > 35, "longer than the 35 ft straight through the wall");
    assert.equal(walkText(m), `Walking ${m.totalFt} ft`);
    assert.equal(m.legs[0]!.none, false);
  });

  test("open ground reads as the straight ruler, and terrain that costs is named under the total", () => {
    const open = measureWalk({ view: world({}), sceneId: "s1", stops: [free(2, 5), free(9, 5)], viewer: { role: "player" }, everything: false })!;
    assert.deepEqual([open.totalFt, open.legs[0]!.corners], [35, []]);
    const state = world({});
    state.buildChunks[chunkKey("s1", 0, 0)] = { sceneId: "s1", cx: 0, cy: 0, rev: 1, cells: Object.fromEntries([4, 5, 6].flatMap((y) => [4, 5, 6].map((x) => [`${x},${y}`, "rubble" as const]))), edges: {} };
    const rough = measureWalk({ view: state, sceneId: "s1", stops: [free(2, 5), free(9, 5)], viewer: { role: "player" }, everything: false })!;
    assert.equal(rough.totalFt, 35, "round the rubble costs what the straight walk would, 15 ft less than through it");
    assert.ok(rough.legs[0]!.corners.length > 0);
    assert.equal(rough.extra, null);
    const through = measureWalk({ view: state, sceneId: "s1", stops: [free(2, 5), free(5, 5)], viewer: { role: "player" }, everything: false })!;
    assert.equal(walkText(through), "Walking 25 ft\n+10 ft for difficult terrain");
  });

  test("a stop past a wall with no way round reads No way through, drawn straight", () => {
    const state = world({ edges: line("w", 6, 0, 30) });
    const m = measureWalk({ view: state, sceneId: "s1", stops: [free(2, 5), free(9, 5)], viewer: { role: "player" }, everything: false })!;
    assert.deepEqual([m.legs[0]!.none, m.legs[0]!.corners], [true, []]);
  });

  test("it walks the token it starts on, leaves out other creatures, and only the DM's own ruler reads a DM-only area", () => {
    const state = world({ tokens: [token("ogre", { size: "large", x: 1, y: 4 }), token("wall", { x: 5, y: 5 })] });
    state.templates.web = template("web", { shape: "sphere", size: 10, origin: { x: 6, y: 5, z: 0 }, visibility: "dm", ownerId: "dm1", slows: { kind: "difficult" } });
    const stops = [tokenStop(SQUARES, state.tokens.ogre!), free(10, 5)];
    const shared = measureWalk({ view: state, sceneId: "s1", stops, viewer: { role: "dm" }, everything: false })!;
    assert.deepEqual(shared.size, { w: 2, h: 2 });
    assert.equal(shared.totalFt, 45, "the goblin in the way will have moved, and players do not see the web");
    const mine = measureWalk({ view: state, sceneId: "s1", stops, viewer: { role: "dm" }, everything: true })!;
    assert.ok(mine.totalFt > 45, "the DM's own ruler counts the web it knows of");
  });

  test("a shared ruler keeps to ground players have seen, the same on the DM's device as on a player's", () => {
    const fogged = (h: number): RoomState => {
      const state = room();
      state.scenes.s1 = { ...state.scenes.s1!, fogEnabled: true };
      reveal(state, "s1", { x: 0, y: 0, w: 30, h });
      return state;
    };
    const read = (state: RoomState, stops: RulerStop[], everything = false) => {
      const onDm = measureWalk({ view: state, sceneId: "s1", stops, viewer: { role: "dm" }, everything })!;
      const view = projectState(state, P1, { sceneId: "s1" }) as unknown as RoomState;
      const onPlayer = measureWalk({ view, sceneId: "s1", stops, viewer: { role: "player" }, everything: false })!;
      return { onDm: [onDm.totalFt, onDm.legs[0]!.none], onPlayer: [onPlayer.totalFt, onPlayer.legs[0]!.none] };
    };
    const stops = [free(2, 5), free(9, 5)];
    // Only above the wall's end is seen, so the way round it is not, and the walk is held at the wall as a player's drag is.
    const dark = read(fogged(10), stops);
    assert.deepEqual(dark.onDm, dark.onPlayer);
    assert.deepEqual(dark.onDm, [15, true]);
    const lit = read(fogged(12), stops);
    assert.deepEqual(lit.onDm, lit.onPlayer);
    assert.deepEqual(lit.onDm, [55, false]);
    // On a monster too, which a DM's drag would walk on the DM's own map.
    const monster = fogged(10);
    monster.tokens.gob = token("gob", { x: 2, y: 5 });
    const onGob = read(monster, [tokenStop(SQUARES, monster.tokens.gob), free(9, 5)]);
    assert.deepEqual(onGob.onDm, onGob.onPlayer);
    assert.deepEqual(onGob.onDm, [15, true]);
    assert.deepEqual(read(fogged(10), stops, true).onDm, [55, false], "the DM's own ruler, before it is shared, reads the DM's map");
  });

  test("on a per-player scene a shared ruler keeps to the ground every player shares, on every device, though a holder remembers the way round (docs/design-v1-per-player-vision.md 6.6)", () => {
    const state = room();
    state.scenes.s1 = { ...state.scenes.s1!, fogEnabled: true, vision: { on: false, light: "dark", perPlayer: true } };
    reveal(state, "s1", { x: 0, y: 0, w: 30, h: 10 });
    state.holders.s1 = { sceneId: "s1", rev: 1, entries: [{ memberId: "p1", on: true }] };
    // p1 alone remembers the ground below the wall's end, so p1's own map shows the way round.
    const own = Object.values(rasterizeFogOps({}, "s1", state.scenes.s1!.bounds, [{ id: "r", mode: "reveal", shape: { kind: "rect", x: 0, y: 0, w: 30, h: 12 } }]))[0]!;
    state.exploredBy[holderTileKey("s1", "p1", own.tx, own.ty)] = { ...own, memberId: "p1" };
    const stops = [free(2, 5), free(9, 5)];
    const read = (viewer: typeof P1) => {
      const view = projectState(state, viewer, { sceneId: "s1" }) as unknown as RoomState;
      const m = measureWalk({ view, sceneId: "s1", stops, viewer: { role: viewer.role }, everything: false })!;
      return [m.totalFt, m.legs[0]!.none];
    };
    assert.deepEqual(read(P1), [15, true], "held at the wall, as on every other device");
    assert.deepEqual(read(P2), [15, true]);
    assert.deepEqual(read(DM), [15, true]);
  });

  test("a ruler is walked again when only the shared fog or sight a copy holds changes, as when the DM reveals the way round on a per-player scene", () => {
    const fogged = (h: number) => {
      const state = room();
      state.scenes.s1 = { ...state.scenes.s1!, fogEnabled: true, vision: { on: false, light: "dark", perPlayer: true } };
      reveal(state, "s1", { x: 0, y: 0, w: 30, h });
      return projectState(state, P1, { sceneId: "s1" }) as unknown as RoomState;
    };
    const stops = [free(2, 5), free(9, 5)];
    const first = fogged(10);
    const walk = (view: RoomState) => measureWalk({ view, sceneId: "s1", stops, viewer: { role: "player" }, everything: false })!.totalFt;
    assert.equal(walk(first), 15);
    const wider = fogged(12) as RoomState & { fogAll?: unknown; sightAll?: unknown };
    assert.equal(walk({ ...first, fogAll: wider.fogAll } as RoomState), 55, "only the shared fog changed");
  });

  test("a player's ruler under true distance into ground the party never explored reads the straight walk, not No way through (review MV-O-21)", () => {
    const state = world({ blockMovement: false });
    state.scenes.s1 = { ...state.scenes.s1!, fogEnabled: true };
    state.meta = { ...state.meta, settings: { ...state.meta.settings, diagonal: "euclid" } };
    reveal(state, "s1", { x: 0, y: 0, w: 12, h: 30 });
    const view = projectState(state, P1, { sceneId: "s1" }) as unknown as RoomState;
    for (const [end, ft] of [[free(20, 2), 90], [free(20, 20), 127], [free(20, 8), 95]] as const) {
      const m = measureWalk({ view, sceneId: "s1", stops: [free(2, 2), end], viewer: { role: "player" }, everything: false })!;
      assert.deepEqual([m.totalFt, m.legs[0]!.none, m.legs[0]!.corners], [ft, false, []], `to ${end.x}, ${end.y}`);
    }
  });

  test("a walk over a rise and down again counts both climbs", () => {
    // A ridge 10 ft high along x = 5, so there is no way round it.
    const state = world({ blockMovement: false, heights: Object.fromEntries(Array.from({ length: 30 }, (_, y) => [`5,${y}`, 10])) });
    const m = measureWalk({ view: state, sceneId: "s1", stops: [free(4, 5), free(6, 5)], viewer: { role: "player" }, everything: false })!;
    assert.equal(m.totalFt, 20, "10 ft up and 10 ft down, where the straight ruler reads 10 ft");
  });

  test("a kept walking ruler follows every token it is anchored to", () => {
    const state = world({ blockMovement: false, tokens: [token("a", { x: 1, y: 1 }), token("b", { x: 4, y: 1 })] });
    const kept = keptDrawing({ id: "k", sceneId: "s1", stops: [tokenStop(SQUARES, state.tokens.a!), tokenStop(SQUARES, state.tokens.b!)], ownerId: "dm1", color: "#fff", shared: true, walk: true })!;
    const read = (view: RoomState) => measureWalk({ view, sceneId: "s1", stops: keptStops(kept), viewer: { role: "dm" }, everything: false })!;
    assert.deepEqual([read(state).totalFt, read(state).legs[0]!.to], [15, { x: 4, y: 1 }]);
    const moved = { ...state, tokens: { ...state.tokens, b: { ...state.tokens.b!, x: 8 } } };
    assert.deepEqual([read(moved).totalFt, read(moved).legs[0]!.to], [35, { x: 8, y: 1 }], "the second anchor moved on, and the ruler with it");
  });

  test("the 5-10-5 count runs on across the stops", () => {
    const state = world({});
    state.meta = { ...state.meta, settings: { ...state.meta.settings, diagonal: "fiveTen" } };
    const m = measureWalk({ view: state, sceneId: "s1", stops: [free(0, 0), free(1, 1), free(2, 2)], viewer: { role: "player" }, everything: false })!;
    assert.deepEqual(m.legs.map((l) => l.ft), [5, 10]);
  });

  test("a ruler is walked again only when the room it reads changes, and a long search goes a slice at a time", () => {
    // A closed room far off on a 200 by 200 map: a stop inside it has no way through, and the search floods everything it can reach.
    const edges: Record<string, EdgeFeature> = {};
    for (let k = 190; k < 194; k++) Object.assign(edges, { [`${k},190,n`]: WALL, [`${k},194,n`]: WALL, [`190,${k},w`]: WALL, [`194,${k},w`]: WALL });
    const state = world({ edges });
    state.scenes.s1 = { ...state.scenes.s1!, bounds: { w: 200, h: 200 } };
    const stops = [free(10, 10), free(191, 191)];
    const input = { view: state, sceneId: "s1", stops, viewer: { role: "player" as const }, everything: false };
    const first = measureWalk({ ...input, deadline: 0 })!;
    assert.equal(first.searching, true, "the first slice runs out");
    assert.equal(first.legs[0]!.searching, true);
    let m = first;
    let slices = 1;
    while (m.searching && slices < 10_000) {
      m = measureWalk({ ...input, deadline: performance.now() + 4 })!;
      slices++;
    }
    assert.ok(slices > 1);
    assert.deepEqual([m.searching, m.legs[0]!.none], [false, true], "it goes on where it stopped, to No way through");
    // An op that leaves the walk's inputs alone, a chat line, finds the walk kept.
    const chat = { ...state, log: [...state.log] };
    assert.equal(measureWalk({ ...input, view: chat }), m);
    // A token moved is an input: walked again, to the same answer.
    const moved = { ...chat, tokens: { ...chat.tokens } };
    const again = measureWalk({ ...input, view: moved })!;
    assert.notEqual(again, m);
    assert.deepEqual(again.legs, m.legs);
  });

  test("a ruler of 34 stops whose first leg searches long still finishes: no later leg's search pushes the first one out", () => {
    const edges: Record<string, EdgeFeature> = {};
    for (let k = 190; k < 194; k++) Object.assign(edges, { [`${k},190,n`]: WALL, [`${k},194,n`]: WALL, [`190,${k},w`]: WALL, [`194,${k},w`]: WALL });
    const state = world({ edges });
    state.scenes.s1 = { ...state.scenes.s1!, bounds: { w: 200, h: 200 } };
    // Into the closed room, then 32 short legs elsewhere, each from a spot of its own.
    const stops = [free(10, 10), free(191, 191), ...Array.from({ length: 32 }, (_, k) => free(20 + k, 50))];
    const input = { view: state, sceneId: "s1", stops, viewer: { role: "player" as const }, everything: false };
    let m = measureWalk({ ...input, deadline: performance.now() + 4 })!;
    let slices = 1;
    while (m.searching && slices < 2_000) {
      m = measureWalk({ ...input, deadline: performance.now() + 4 })!;
      slices++;
    }
    assert.equal(m.searching, false, `still searching after ${slices} slices`);
    assert.equal(m.legs.length, 33);
    assert.equal(m.legs[0]!.none, true, "No way through");
  });

  test("a ruler whose last stop moves keeps every leg before it, planned and simulated once, so a call with no budget left reads them all (review AT-O-33)", () => {
    const view = room();
    const stops = [free(2, 5), ...Array.from({ length: 30 }, (_, k) => free(k % 2 === 0 ? 9 : 2, 5 + Math.floor(k / 2)))];
    const input = { view, sceneId: "s1", viewer: { role: "player" as const }, everything: false };
    const whole = measureWalk({ ...input, stops })!;
    assert.equal(whole.searching, false);
    const moved = measureWalk({ ...input, stops: [...stops.slice(0, -1), free(8, 3)], budget: WorkBudget.none() })!;
    assert.deepEqual(moved.legs.slice(0, -1), whole.legs.slice(0, -1));
    assert.equal(moved.legs.at(-1)!.searching, true);
  });

  test("past its deadline a slice begins no leg but its first, so a ruler of many legs never builds every leg's world in one frame (review ASTRA-08)", () => {
    // 20 legs round the wall's end, each from a spot of its own, so each has a search and a world of its own.
    const stops = [free(2, 5), ...Array.from({ length: 20 }, (_, k) => free(k % 2 === 0 ? 9 : 2, 5 + Math.floor(k / 2)))];
    const input = { sceneId: "s1", stops, viewer: { role: "player" as const }, everything: false };
    const whole = measureWalk({ ...input, view: room() })!;
    const view = room();
    const answered = (w: typeof whole) => w.legs.filter((l) => !l.searching).length;
    let m = measureWalk({ ...input, view, deadline: -Infinity })!;
    let slices = 1;
    while (m.searching && slices < 1_000) {
      const before = answered(m);
      m = measureWalk({ ...input, view, deadline: -Infinity })!;
      assert.ok(answered(m) - before <= 1, `slice ${slices + 1} answered ${answered(m) - before} legs`);
      slices++;
    }
    assert.ok(slices >= 20, `${slices} slices`);
    assert.deepEqual(m.legs, whole.legs);
  });

  test("rulers searching by turns all finish: two from one creature on one search, and more than the searches kept (review ASTRA-12)", () => {
    // Two rulers from a Large creature past a short wall, ends five squares apart, as astra drew them.
    const state = world({ edges: line("w", 20, 0, 5), tokens: [token("ogre", { size: "large", x: 2, y: 2 })] });
    state.scenes.s1 = { ...state.scenes.s1!, bounds: { w: 200, h: 200 } };
    const at = tokenStop(SQUARES, state.tokens.ogre!);
    const byTurns = (rulers: RulerStop[][], view: RoomState, turns: number) => {
      const got: (ReturnType<typeof measureWalk> | undefined)[] = rulers.map(() => undefined);
      let t = 0;
      for (; t < turns && got.some((m) => m?.searching !== false); t++) {
        const k = t % rulers.length;
        if (got[k]?.searching === false) continue;
        got[k] = measureWalk({ view, sceneId: "s1", stops: rulers[k]!, viewer: { role: "player" }, everything: false, deadline: -Infinity });
      }
      assert.ok(got.every((m) => m?.searching === false), `still searching after ${t} turns`);
      return got.map((m) => m!);
    };
    // Each alone in a copy of the room, so it shares nothing kept with the others.
    const alone = (view: RoomState, stops: RulerStop[]) => measureWalk({ view: structuredClone(view), sceneId: "s1", stops, viewer: { role: "player" }, everything: false })!.legs;
    const two = [
      [at, free(81, 3)],
      [at, free(86, 3)],
    ];
    assert.deepEqual(
      byTurns(two, state, 20_000).map((m) => m.legs),
      two.map((stops) => alone(state, stops)),
    );
    // 40 rulers at once, each from a spot of its own, round a wall: more searches than are kept, none pushes out another's.
    const walled = world({ edges: line("w", 6, 0, 28) });
    const many = Array.from({ length: 40 }, (_, k) => [free(1 + (k % 4), 1 + Math.floor(k / 4) * 2), free(9 + (k % 3), 2 + (k % 20))]);
    assert.deepEqual(
      byTurns(many, walled, 200_000).map((m) => m.legs),
      many.map((stops) => alone(walled, stops)),
    );
  });

  test("random rulers searched by turns, their stops moved and the room changed between, all finish with the walk each reads alone", () => {
    for (let seed = 1; seed <= 40; seed++) {
      const rand = mulberry32(seed);
      const edgesOf = () => {
        const edges: Record<string, EdgeFeature> = {};
        for (let y = 0; y < 30; y++) for (let x = 1; x < 30; x++) if (rand() < 0.12) edges[`${x},${y},${rand() < 0.5 ? "w" : "n"}`] = WALL;
        return edges;
      };
      const ogre = token("ogre", { size: rand() < 0.3 ? "large" : "medium", x: 0, y: 0 });
      let view = world({ edges: edgesOf(), tokens: [ogre] });
      const spot = () => free(Math.floor(rand() * 28), Math.floor(rand() * 28));
      // Rulers often start on one creature or spot, so they share searches.
      const starts = [tokenStop(SQUARES, ogre), free(1, 1)];
      const rulers = Array.from({ length: 2 + Math.floor(rand() * 4) }, () => [starts[Math.floor(rand() * 2)]!, ...Array.from({ length: 1 + Math.floor(rand() * 3) }, spot)]);
      const measure = (k: number) => measureWalk({ view, sceneId: "s1", stops: rulers[k]!, viewer: { role: "player" }, everything: false, deadline: -Infinity })!;
      for (let turn = 0; turn < 300; turn++) {
        const r = rand();
        const k = Math.floor(rand() * rulers.length);
        if (r < 0.8) measure(k);
        else if (r < 0.95) {
          // A stop dragged to a new spot: a new stops list, as the board makes one.
          const moved = [...rulers[k]!];
          moved[1 + Math.floor(rand() * (moved.length - 1))] = spot();
          rulers[k] = moved;
        } else view = world({ edges: edgesOf(), tokens: [ogre] });
      }
      const done = rulers.map(() => false);
      for (let turn = 0; turn < 100_000 && done.includes(false); turn++) {
        const k = turn % rulers.length;
        if (!done[k]) done[k] = !measure(k).searching;
      }
      assert.ok(!done.includes(false), `seed ${seed}: a ruler never finished`);
      const finals = rulers.map((_, k) => measure(k));
      for (const [k, stops] of rulers.entries()) {
        assert.deepEqual(finals[k]!.legs, measureWalk({ view: structuredClone(view), sceneId: "s1", stops, viewer: { role: "player" }, everything: false })!.legs, `seed ${seed}: ruler ${k}`);
      }
    }
  });

  test("Measure is remembered on the device, Straight when storage fails", () => {
    const items = new Map<string, string>();
    const storage = () => ({ getItem: (k: string) => items.get(k) ?? null, setItem: (k: string, v: string) => void items.set(k, v) }) as unknown as Storage;
    assert.equal(savedWalk(storage), false);
    saveWalk(true, storage);
    assert.equal(savedWalk(storage), true);
    const broken = () => {
      throw new Error("blocked");
    };
    assert.equal(savedWalk(broken), false);
    assert.doesNotThrow(() => saveWalk(true, broken));
  });
});

describe("a walking ruler while its walk is searched", () => {
  const leg = (searching: boolean) => ({ from: { x: 0, y: 0 }, to: { x: 4, y: 0 }, corners: [], ft: searching ? 0 : 20, none: false, ...(searching ? { searching: true as const } : {}) });
  const done: WalkMeasure = { legs: [leg(false)], totalFt: 20, extra: null, size: { w: 1, h: 1 }, searching: false };
  const searching: WalkMeasure = { legs: [leg(false), leg(true)], totalFt: 20, extra: null, size: { w: 1, h: 1 }, searching: true };

  test("a finished walk reads itself", () => {
    assert.deepEqual(walkShown(done, null, false), { reading: done, finding: false });
  });

  test("a search that has just started keeps the last walk's reading, and nothing waits grey yet", () => {
    assert.deepEqual(walkShown(searching, done, false), { reading: done, finding: false });
  });

  test("only past the shared loading delay does it say it is finding the way", () => {
    assert.deepEqual(walkShown(searching, done, true), { reading: null, finding: true });
  });

  test("a first search, with no walk to keep, reads nothing until then", () => {
    assert.deepEqual(walkShown(searching, null, false), { reading: null, finding: false });
  });

  test("a random run of frames never leaves the ruler without a reading once it has had one, until the delay passes", () => {
    let seed = 7;
    const random = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
    let held: WalkMeasure | null = null;
    let since = 0;
    for (let frame = 0; frame < 2000; frame++) {
      const m = random() < 0.6 ? searching : { ...done, totalFt: 5 * Math.floor(random() * 20) };
      since = m.searching ? since + 16 : 0;
      const slow = since >= 200;
      const shown = walkShown(m, held, slow);
      if (!m.searching) held = m;
      // Invariants: a reading or the wait shows whenever a walk was ever finished, and the wait shows only past the delay.
      if (held) assert.ok(shown.reading !== null || shown.finding, `frame ${frame} shows nothing`);
      assert.equal(shown.finding, m.searching && slow, `frame ${frame} waits at the wrong time`);
      if (shown.reading) assert.equal(shown.reading.searching, false, "a reading is always a finished walk");
    }
  });
});

describe("a walking ruler's leg costs while a stop is dragged (review LP2L2-P3-4)", () => {
  const leg = (ft: number, extra: { searching?: true; none?: boolean } = {}) => ({ from: { x: 0, y: 0 }, to: { x: 4, y: 0 }, corners: [], ft, none: extra.none ?? false, ...(extra.searching ? { searching: true as const } : {}) });
  const held: WalkMeasure = { legs: [leg(20), leg(15), leg(10, { none: true })], totalFt: 45, extra: null, size: { w: 1, h: 1 }, searching: false };
  const dragging: WalkMeasure = { legs: [leg(20), leg(0, { searching: true }), leg(0, { searching: true }), leg(0, { searching: true })], totalFt: 20, extra: null, size: { w: 1, h: 1 }, searching: true };

  test("a found leg reads its own cost", () => {
    assert.equal(legReading(dragging, 0, held, false), dragging.legs[0]);
    assert.equal(legReading(dragging, 0, held, true), dragging.legs[0], "and still once the search is slow");
  });

  test("a leg still searching keeps the held walk's leg of the same index, its \"No way through\" too, until the delay passes", () => {
    assert.equal(legReading(dragging, 1, held, false)?.ft, 15);
    assert.equal(legReading(dragging, 2, held, false)?.none, true);
    assert.equal(legReading(dragging, 1, held, true), null, "past the delay it waits with no cost");
  });

  test("a searching leg the held walk did not have, or a first search, reads nothing", () => {
    assert.equal(legReading(dragging, 3, held, false), null);
    assert.equal(legReading(dragging, 1, null, false), null);
    assert.equal(legReading(dragging, 9, held, false), null);
  });
});

describe("the walk a ruler holds (review LP2L2-ASTRA-1)", () => {
  const leg = { from: { x: 0, y: 0 }, to: { x: 4, y: 0 }, corners: [], ft: 20, none: false };
  const done: WalkMeasure = { legs: [leg], totalFt: 120, extra: null, size: { w: 1, h: 1 }, searching: false };
  const searching: WalkMeasure = { legs: [{ ...leg, ft: 0, searching: true }], totalFt: 0, extra: null, size: { w: 1, h: 1 }, searching: true };
  /** The reading after each render of `steps`, each what the render measured and for which ruler. */
  function run(steps: [WalkMeasure | null, string][]): (WalkMeasure | null)[] {
    let held: HeldWalk = null;
    return steps.map(([m, ruler]) => {
      held = nextHeld(held, m, ruler);
      return m ? walkShown(m, held?.walk ?? null, false).reading : null;
    });
  }

  test("a finished walk, then a search of the same ruler, keeps the walk", () => {
    assert.deepEqual(run([[done, "a"], [searching, "a"]]), [done, done]);
  });

  test("a finished walk, then nothing measured (Clear, Keep, Straight), then a new search, reads nothing", () => {
    assert.deepEqual(run([[done, "a"], [null, "a"], [searching, "a"]]), [done, null, null]);
    assert.deepEqual(run([[done, "a"], [null, ""], [searching, "b"]]), [done, null, null]);
  });

  test("a new ruler's first search never reads the last ruler's walk", () => {
    assert.deepEqual(run([[done, "a"], [searching, "b"]]), [done, null]);
  });

  test("a ruler started afresh under the same id, from another start, reads nothing while it searches (review LP2L2-OPUS-9)", () => {
    const from = (x: number) => [{ x, y: 2.5 }, { x: x + 4, y: 2.5 }];
    const before = heldKey("r1", from(1.5));
    const restarted = heldKey("r1", from(7.5));
    assert.notEqual(before, restarted);
    assert.equal(heldKey("r1", [{ x: 1.5, y: 2.5 }, { x: 9.5, y: 2.5 }]), before, "a stop dragged further keeps the ruler");
    assert.deepEqual(run([[done, before], [searching, restarted]]), [done, null]);
  });

  test("a ruler that starts on a token is that token's wherever it moves, so a kept ruler on a walking creature keeps its walk (review LP2L2-OPUS-11)", () => {
    const on = (x: number) => [{ x, y: 2.5, tokenId: "thorn" }, { x: 9.5, y: 2.5 }];
    const before = heldKey("k1", on(1.5));
    const moved = heldKey("k1", on(4.5));
    assert.equal(moved, before, "the token moved, the ruler is the same");
    assert.notEqual(heldKey("k1", [{ x: 1.5, y: 2.5, tokenId: "goblin" }]), before, "another token is another start");
    assert.deepEqual(run([[done, before], [searching, moved]]), [done, done]);
  });
});

describe("the walking ruler from a rider of a Large mount into a corridor one square wide (D-261029-53)", () => {
  test("from every seat its legs run where the rider sits, on the mount's square in the corridor, never across the rock", () => {
    const s = baseRoom({ scenes: { s1: scene("s1", { bounds: { w: 30, h: 20 }, blockMovement: true, autoWalls: "off" }) } });
    s.buildChunks = {};
    const runs: [[number, number], [number, number]][] = [
      ...[8, 16].flatMap((x): [[number, number], [number, number]][] => [[[x, 0], [x, 5]], [[x, 5], [x, 10]], [[x, 11], [x, 16]], [[x, 16], [x, 20]]]),
      [[8, 10], [16, 10]],
      [[8, 11], [16, 11]],
    ];
    runs.forEach(([a, b], i) => assert.ok(mapSchemas.freeWall.safeParse(wall(s, `fu35ru${String(i).padStart(6, "0")}`, a, b)).success, "every corridor wall meets the protocol"));
    const rock = (x: number, y: number) => x >= 8 && x < 16 && (y < 10 || y >= 11);
    s.tokens.horse = token("horse", { size: "large", x: 3, y: 9, name: "Warhorse" });
    for (const [x, y] of [[3, 9], [4, 9], [3, 10], [4, 10]] as const) {
      s.tokens.brom = token("brom", { x, y, name: "Brom", attached: { to: "horse", kind: "ride", steer: true } });
      const m = measureWalk({ view: s, sceneId: "s1", stops: [{ x: 0, y: 0, tokenId: "brom" }, free(12, 10)], viewer: { role: "dm" }, everything: true })!;
      assert.equal(m.legs.length, 1);
      const leg = m.legs[0]!;
      for (const p of [leg.from, ...leg.corners, leg.to]) {
        const cells = [[Math.floor(p.x), Math.floor(p.y)], [Math.ceil(p.x + 1 - 1e-9) - 1, Math.ceil(p.y + 1 - 1e-9) - 1]];
        assert.ok(cells.every(([cx, cy]) => !rock(cx!, cy!)), `${p.x}, ${p.y} from seat ${x}, ${y}: never across the rock`);
      }
      // The drag aims the mount by the rider's place on it, and the rider sits on whichever corridor square it squeezes onto.
      assert.ok(leg.to.y === 10 && Number.isInteger(leg.to.x) && leg.to.x >= 8 && leg.to.x < 16, `from seat ${x}, ${y}: ${leg.to.x}, ${leg.to.y} on the mount's square in the corridor`);
    }
  });
});
