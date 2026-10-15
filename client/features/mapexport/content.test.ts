import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { BuildChunk, Label, RoomState } from "#shared/model.ts";
import { projectState } from "#shared/project.ts";
import type { StampInput } from "#shared/protocol.ts";
import { decodeTile, rasterizeFogOps } from "#shared/rules/fog.ts";
import { apply, P1, reveal, room, scene } from "#shared/testutil.ts";
import { exportContent, hasBuildOn, playerFog, type ExportView } from "./content.ts";

const SECRET = { kind: "door", state: "closed", secret: true, discovered: false } as const;
const FOUND = { kind: "door", state: "locked", secret: true, discovered: true } as const;

/**
 * Scene s1: a hall with a hidden secret door, a found one, a locked door,
 * a "Hall" label in the revealed part and a "Trap" label in the dark.
 * Scene s2 has its own build, which no export of s1 may pick up.
 */
function built(fogEnabled: boolean): RoomState {
  let state = room({ scenes: { s1: scene("s1", { fogEnabled }), s2: scene("s2", { order: 1 }) } });
  state = apply(state, { t: "build.rect", sceneId: "s1", terrain: "stone", x: 0, y: 0, w: 20, h: 10 });
  state = apply(state, {
    t: "build.edge",
    sceneId: "s1",
    edges: [
      { key: "5,0,n", feature: SECRET },
      { key: "18,3,w", feature: SECRET },
      { key: "6,0,n", feature: FOUND },
      { key: "0,4,w", feature: { kind: "door", state: "locked", secret: false, discovered: false } },
    ],
  });
  state = apply(state, { t: "build.label", sceneId: "s1", labelId: "hall", label: { x: 2, y: 2, text: "Hall", size: 0.7 } });
  state = apply(state, { t: "build.label", sceneId: "s1", labelId: "trap", label: { x: 17, y: 8, text: "Trap", size: 0.7 } });
  state = apply(state, { t: "build.rect", sceneId: "s2", terrain: "wood", x: 0, y: 0, w: 4, h: 4 });
  state = apply(state, { t: "build.label", sceneId: "s2", labelId: "other", label: { x: 1, y: 1, text: "Elsewhere", size: 1 } });
  if (fogEnabled) reveal(state, "s1", { x: 0, y: 0, w: 8, h: 6 });
  return state;
}

function content(state: RoomState, view: ExportView) {
  return exportContent({ scene: state.scenes.s1!, buildChunks: state.buildChunks, labels: state.labels, fogTiles: state.fogTiles, exploredTiles: state.exploredTiles, stamps: state.stamps, view });
}

/** What the party has seen, written into the explored layer as the server's explore step leaves it. */
function explore(state: RoomState, rect: { x: number; y: number; w: number; h: number }): void {
  const changes = rasterizeFogOps(state.exploredTiles, "s1", state.scenes.s1!.bounds, [{ id: "e", mode: "reveal", shape: { kind: "rect", ...rect } }]);
  for (const [key, tile] of Object.entries(changes)) if (tile) state.exploredTiles[key] = tile;
}

function edgesOf(chunks: readonly BuildChunk[]): Record<string, unknown> {
  return Object.assign({}, ...chunks.map((c) => c.edges));
}

function sortedLabels(labels: readonly Label[]): string[] {
  return labels.map((l) => l.text).sort();
}

describe("exportContent", () => {
  test("the DM view keeps every secret door and label of the scene, and only that scene", () => {
    const state = built(true);
    const dm = content(state, "dm");
    assert.equal(dm.role, "dm");
    assert.deepEqual(edgesOf(dm.chunks)["5,0,n"], SECRET);
    assert.deepEqual(sortedLabels(dm.labels), ["Hall", "Trap"]);
    assert.ok(dm.chunks.every((c) => c.sceneId === "s1"));
    assert.deepEqual([dm.secretDoors, dm.hiddenLabels], [0, 0]);
  });

  test("the player view turns hidden secret doors into the walls players see, and keeps found ones as doors without the lock", () => {
    const player = content(built(false), "player");
    assert.equal(player.role, "player");
    const edges = edgesOf(player.chunks);
    // On the hall's outer wall the automatic wall stands, between two floors a drawn one.
    assert.equal(edges["5,0,n"], undefined);
    assert.deepEqual(edges["18,3,w"], { kind: "wall" });
    assert.deepEqual(edges["6,0,n"], { ...FOUND, state: "closed" });
    assert.equal(player.secretDoors, 2);
  });

  test("a hidden secret free door is drawn and counted as a wall, a found one stays a door, and an edge door follows the scene's rule", () => {
    let state = built(false);
    state = apply(state, {
      t: "build.walls",
      sceneId: "s1",
      put: [
        { id: "aaaaaaaaaaaa", a: [2.5, 2], b: [3.5, 3], f: SECRET },
        { id: "bbbbbbbbbbbb", a: [4.5, 2], b: [5.5, 3], f: FOUND },
      ],
    });
    const player = content(state, "player");
    const walls = player.chunks.flatMap((c) => c.walls ?? []);
    assert.deepEqual(walls.map((w) => w.f), [{ kind: "wall" }, { ...FOUND, state: "closed" }]);
    assert.equal(player.secretDoors, 3);
    // With no automatic walls, the hidden door on the hall's outer edge is drawn as the wall players see.
    state.scenes.s1 = { ...state.scenes.s1!, autoWalls: "off" };
    assert.deepEqual(edgesOf(content(state, "player").chunks)["5,0,n"], { kind: "wall" });
  });

  test("the player view leaves out labels under the fog, and keeps them all when fog is off", () => {
    const fogged = content(built(true), "player");
    assert.deepEqual(sortedLabels(fogged.labels), ["Hall"]);
    assert.equal(fogged.hiddenLabels, 1);
    const open = content(built(false), "player");
    assert.deepEqual(sortedLabels(open.labels), ["Hall", "Trap"]);
    assert.equal(open.hiddenLabels, 0);
  });

  test("the player view reads the fog players get, the DM's layer and the party's explored ground merged", () => {
    let state = built(true);
    state = apply(state, { t: "build.label", sceneId: "s1", labelId: "well", label: { x: 10, y: 8, text: "Well", size: 0.7 } });
    state = apply(state, { t: "build.stamps", sceneId: "s1", put: [{ id: "crate", art: { key: "barrel" }, x: 17, y: 7, w: 1, h: 1, rotation: 0, z: 0, visibility: "all" }] });
    // The Well shares a fog tile with the DM's reveal, and the Trap's tile only the party explored.
    explore(state, { x: 9, y: 7, w: 4, h: 3 });
    explore(state, { x: 16, y: 7, w: 4, h: 3 });
    const player = content(state, "player");
    assert.deepEqual(sortedLabels(player.labels), ["Hall", "Trap", "Well"]);
    assert.equal(player.hiddenLabels, 0);
    assert.deepEqual(player.stamps.map((st) => st.id), ["crate"]);
    // Exactly the labels a player's client receives, which projection merges the same way.
    const projected = projectState(state, P1, { sceneId: null });
    assert.deepEqual(sortedLabels(player.labels), sortedLabels(Object.values(projected.labels)));
    // Without the explored layer, as a DM's view read by the DM's fog alone, both would be left out.
    const dmFogOnly = exportContent({ scene: state.scenes.s1!, buildChunks: state.buildChunks, labels: state.labels, fogTiles: state.fogTiles, stamps: state.stamps, view: "player" });
    assert.deepEqual(sortedLabels(dmFogOnly.labels), ["Hall"]);
    assert.deepEqual(dmFogOnly.stamps, []);
  });

  test("merging keeps every sub-cell either layer reveals, and passes a view with no explored layer through", () => {
    const state = built(true);
    explore(state, { x: 9, y: 7, w: 4, h: 3 });
    const fog = playerFog(state.fogTiles, state.exploredTiles, "s1");
    const both = decodeTile(fog["s1:0,0"]!.bits)!;
    const dm = decodeTile(state.fogTiles["s1:0,0"]!.bits)!;
    const seen = decodeTile(state.exploredTiles["s1:0,0"]!.bits)!;
    for (let i = 0; i < both.length; i++) assert.equal(both[i], dm[i]! | seen[i]!);
    assert.notDeepEqual(both, dm);
    // The DM's own layer is left as it was.
    assert.notEqual(fog, state.fogTiles);
    assert.equal(decodeTile(state.fogTiles["s1:0,0"]!.bits)!.every((v, i) => v === dm[i]), true);
    assert.equal(playerFog(state.fogTiles, {}, "s1"), state.fogTiles);
    assert.equal(playerFog(state.fogTiles, state.exploredTiles, "s2"), state.fogTiles);
  });

  test("the player view never changes the DM's own build", () => {
    const state = built(false);
    const before = JSON.stringify(state.buildChunks);
    content(state, "player");
    assert.equal(JSON.stringify(state.buildChunks), before);
  });

  test("the player view holds exactly what a player's client receives for the scene", () => {
    for (const fogEnabled of [true, false]) {
      const state = built(fogEnabled);
      const projected = projectState(state, P1, { sceneId: null });
      const player = content(state, "player");
      const byKey = (chunks: readonly BuildChunk[]) => Object.fromEntries(chunks.map((c) => [`${c.cx},${c.cy}`, c]));
      assert.deepEqual(byKey(player.chunks), byKey(Object.values(projected.buildChunks)));
      assert.deepEqual(sortedLabels(player.labels), sortedLabels(Object.values(projected.labels)));
    }
  });

  test("a scene whose fog flag is missing counts as fogged", () => {
    const state = built(true);
    const s1 = { ...state.scenes.s1!, fogEnabled: undefined as unknown as boolean };
    const player = exportContent({ scene: s1, buildChunks: state.buildChunks, labels: state.labels, fogTiles: state.fogTiles, stamps: state.stamps, view: "player" });
    assert.deepEqual(sortedLabels(player.labels), ["Hall"]);
  });

  test("the player view leaves out a DM-only stamp and one fully under the fog, as the projection does", () => {
    let state = built(true);
    const at = (id: string, x: number, y: number, over: Partial<StampInput> = {}): StampInput => ({
      id,
      art: { key: "barrel" },
      x,
      y,
      w: 1,
      h: 1,
      rotation: 0,
      z: 0,
      visibility: "all",
      ...over,
    });
    state = apply(state, {
      t: "build.stamps",
      sceneId: "s1",
      put: [at("table", 3, 3, { z: 2 }), at("chest", 4, 3, { z: 1 }), at("secret", 2, 2, { visibility: "dm" }), at("dark", 17, 8)],
    });
    state = apply(state, { t: "build.stamps", sceneId: "s2", put: [at("elsewhere", 1, 1)] });
    const dm = content(state, "dm");
    assert.deepEqual(dm.stamps.map((s) => s.id), ["dark", "secret", "chest", "table"]);
    assert.equal(dm.hiddenStamps, 0);
    const player = content(state, "player");
    assert.deepEqual(player.stamps.map((s) => s.id), ["chest", "table"]);
    assert.equal(player.hiddenStamps, 2);
    // The same stamps a player's client receives.
    const projected = Object.values(projectState(state, P1, { sceneId: null }).stamps).map((s) => s?.id).sort();
    assert.deepEqual([...player.stamps.map((s) => s.id)].sort(), projected);
    // With fog off only the DM-only stamp stays out.
    const open = built(false);
    const unfogged = apply(open, { t: "build.stamps", sceneId: "s1", put: [at("secret", 2, 2, { visibility: "dm" }), at("dark", 17, 8)] });
    assert.deepEqual(content(unfogged, "player").stamps.map((s) => s.id), ["dark"]);
  });
});

describe("whether a scene has a build to export", () => {
  test("floor, edges and labels count, and so do heights and stairs painted on their own", () => {
    let state = room({ scenes: { s1: scene("s1"), s2: scene("s2", { order: 1 }) } });
    assert.equal(hasBuildOn("s1", state.buildChunks, state.labels), false);
    state = apply(state, { t: "build.height", sceneId: "s1", cells: ["2,2"], height: 10 });
    assert.equal(hasBuildOn("s1", state.buildChunks, state.labels), true);
    assert.equal(hasBuildOn("s2", state.buildChunks, state.labels), false);
    state = apply(state, { t: "build.stairs", sceneId: "s2", cells: ["1,1"], up: "a" });
    assert.equal(hasBuildOn("s2", state.buildChunks, state.labels), true);
  });
});
