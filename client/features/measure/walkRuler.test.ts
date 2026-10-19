import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { chunkKey } from "#shared/keys.ts";
import type { RoomState } from "#shared/model.ts";
import { projectState } from "#shared/project.ts";
import { P1, reveal, template, token } from "#shared/testutil.ts";
import { line, world } from "../movement/testing.ts";
import { tokenStop, type RulerStop } from "./ruler.ts";
import { measureWalk, saveWalk, savedWalk, walkText } from "./walkRuler.ts";

/** The ruler's walking mode (docs/design-v1-movement.md 3.3). */

/** A wall along x = 6 from the top down to y = 10, so a walk from the left side to the right goes round its end. */
function room(): RoomState {
  return world({ edges: line("w", 6, 0, 10) });
}

const free = (x: number, y: number): RulerStop => ({ x: x + 0.5, y: y + 0.5 });

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
    const stops = [tokenStop(state.tokens.ogre!), free(10, 5)];
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
    // Only above the wall's end is seen, so the way round it is not.
    const dark = read(fogged(10), stops);
    assert.deepEqual(dark.onDm, dark.onPlayer);
    assert.deepEqual(dark.onDm, [35, true]);
    const lit = read(fogged(12), stops);
    assert.deepEqual(lit.onDm, lit.onPlayer);
    assert.deepEqual(lit.onDm, [55, false]);
    // On a monster too, which a DM's drag would walk on the DM's own map.
    const monster = fogged(10);
    monster.tokens.gob = token("gob", { x: 2, y: 5 });
    const onGob = read(monster, [tokenStop(monster.tokens.gob), free(9, 5)]);
    assert.deepEqual(onGob.onDm, onGob.onPlayer);
    assert.deepEqual(onGob.onDm, [35, true]);
    assert.deepEqual(read(fogged(10), stops, true).onDm, [55, false], "the DM's own ruler, before it is shared, reads the DM's map");
  });

  test("a walk over a rise and down again counts both climbs", () => {
    // A ridge 10 ft high along x = 5, so there is no way round it.
    const state = world({ blockMovement: false, heights: Object.fromEntries(Array.from({ length: 30 }, (_, y) => [`5,${y}`, 10])) });
    const m = measureWalk({ view: state, sceneId: "s1", stops: [free(4, 5), free(6, 5)], viewer: { role: "player" }, everything: false })!;
    assert.equal(m.totalFt, 20, "10 ft up and 10 ft down, where the straight ruler reads 10 ft");
  });

  test("the 5-10-5 count runs on across the stops", () => {
    const state = world({});
    state.meta = { ...state.meta, settings: { ...state.meta.settings, diagonal: "fiveTen" } };
    const m = measureWalk({ view: state, sceneId: "s1", stops: [free(0, 0), free(1, 1), free(2, 2)], viewer: { role: "player" }, everything: false })!;
    assert.deepEqual(m.legs.map((l) => l.ft), [5, 10]);
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
