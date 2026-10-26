import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { chunkKey, keys } from "./keys.ts";
import type { BuildChunk, RoomState, Scene, Trap, Viewer } from "./model.ts";
import { CHUNK_FOR_PLAYERS, SCENE_FOR_PLAYERS, TRAP_FOR_PLAYERS, projectChunkForPlayer, projectEntity, projectState, type PlayerField } from "./project.ts";
import { applyOp } from "./reducer.ts";
import { DM, P1, env, room, template, trap } from "./testutil.ts";

/**
 * Every field of a stored scene, chunk and trap reaches a player's or table
 * display's copy as its list in project.ts says, or stays the DM's for the
 * reason it names. Each entity here sets every field its type has
 * (`Required<...>`), so a new field fails the typecheck here as in the
 * list, until someone decides.
 */
const DISPLAY: Viewer = { memberId: "display:abcdefghijkl", role: "player" };
const PLAYERS: readonly Viewer[] = [P1, DISPLAY];

/** Holds a player's copy to a list: copied fields equal, zeroed ones 0, the DM's absent, and nothing else but `extra`. */
function holds(list: Record<string, PlayerField>, stored: object, copy: object | null, extra: readonly string[] = []): void {
  assert.ok(copy, "the player gets a copy");
  const from = stored as Record<string, unknown>;
  const to = copy as Record<string, unknown>;
  for (const [field, rule] of Object.entries(list)) {
    if (rule === "copied") assert.deepEqual(to[field], from[field], `${field} is copied`);
    else if (rule === "zeroed") assert.equal(to[field], 0, `${field} is zeroed`);
    else if (rule.startsWith("dm: ")) assert.ok(!(field in to), `${field} stays the DM's`);
  }
  for (const field of Object.keys(to)) assert.ok(field in list ? !list[field]!.startsWith("dm: ") : extra.includes(field), `${field} is in the list`);
  assert.deepEqual(Object.keys(list).sort(), Object.keys(from).sort(), "the stored entity sets every field the list names");
}

const map = { assetId: "a1", widthPx: 700, heightPx: 700, cellPx: 70, originPx: { x: 10, y: 10 } };

function fullScene(): Required<Scene> {
  return {
    id: "s1",
    rev: 7,
    name: "Crypt",
    order: 3,
    bounds: { w: 30, h: 20 },
    map,
    grid: { show: true, color: "#ffffff", opacity: 0.25, lineWidth: 1 },
    background: "#2b2b31",
    fogEnabled: false,
    wallsVersion: 9,
    defaultView: { x: 1, y: 2, zoom: 1.5 },
    autoWalls: "floor",
    folder: "Act 2",
    thumb: "t1",
    phases: [{ id: "day", name: "Day", assetId: "a1", widthPx: 700, heightPx: 700 }],
    phaseId: "day",
    phaseGrid: { refWidthPx: 700, refHeightPx: 700, cellPx: 70, originPx: { x: 10, y: 10 } },
    blockMovement: true,
    vision: { on: false, light: "bright" },
    gridFromFile: true,
    gridShape: "hexRows",
  };
}

function fullChunk(): Required<BuildChunk> {
  return {
    sceneId: "s1",
    cx: 0,
    cy: 0,
    rev: 4,
    cells: { "1,1": "stone" },
    edges: { "1,1,n": { kind: "door", state: "locked", secret: false, discovered: false }, "2,1,n": { kind: "wall" } },
    walls: [{ id: "w00000000001", a: [1, 1], b: [3, 1], f: { kind: "wall" } }],
    heights: "A".repeat(683) + "=",
    up: ".".repeat(256),
    rough: "d".padEnd(256, "."),
    grid: "hexRows",
  };
}

function fullTrap(): Required<Trap> {
  return { ...(trap("t1", { found: true, state: "disarmed", rev: 3 }) as Required<Trap>), grid: "hexRows" };
}

describe("what a player's copy takes of each field", () => {
  test("a scene, as SCENE_FOR_PLAYERS says, for a player and a table display", () => {
    const scene = fullScene();
    const state = room({ scenes: { s1: scene, s2: room().scenes.s2! } });
    for (const viewer of PLAYERS) holds(SCENE_FOR_PLAYERS, scene, projectEntity(keys.scene("s1"), state, viewer, { sceneId: "s1" }) as object);
    assert.equal(projectEntity(keys.scene("s1"), state, DM, { sceneId: "s1" }), scene, "the DM gets it whole");
  });

  test("a chunk, as CHUNK_FOR_PLAYERS says", () => {
    const chunk = fullChunk();
    const out = projectChunkForPlayer({ [chunkKey("s1", 0, 0)]: chunk }, chunk, "off");
    holds(CHUNK_FOR_PLAYERS, chunk, out);
    assert.deepEqual(out!.edges["1,1,n"], { kind: "door", state: "closed", secret: false, discovered: false }, "a lock reads closed");
  });

  test("a found trap, as TRAP_FOR_PLAYERS says, Disarmed read as `disarmed`", () => {
    const t = fullTrap();
    const state = room({ traps: { t1: t } });
    for (const viewer of PLAYERS) {
      const copy = projectEntity(keys.trap("t1"), state, viewer, { sceneId: "s1" }) as Record<string, unknown>;
      holds(TRAP_FOR_PLAYERS, t, copy, ["disarmed"]);
      assert.equal(copy.disarmed, true);
    }
  });
});

describe("a hex scene reaches players as hexes (docs/design-v1-hex-grids.md section 7)", () => {
  const hexRoom = (): RoomState => room({ scenes: { s1: { ...room().scenes.s1!, gridShape: "hexRows" }, s2: room().scenes.s2! } });

  test("in a snapshot, for a player and a table display", () => {
    for (const viewer of PLAYERS) assert.equal(projectState(hexRoom(), viewer, { sceneId: "s1" }).scenes.s1!.gridShape, "hexRows");
  });

  test("as the scene changes shape, and back to squares", () => {
    let state = hexRoom();
    for (const shape of ["hexColumns", "squares", "hexRows"] as const) {
      const r = applyOp(state, { t: "scene.update", sceneId: "s1", patch: { gridShape: shape } }, DM, env(1));
      assert.ok(r.ok && r.global);
      state = r.state;
      for (const viewer of PLAYERS) {
        const copy = projectEntity(keys.scene("s1"), state, viewer, { sceneId: "s1" }) as Scene;
        assert.equal(copy.gridShape, shape === "squares" ? undefined : shape, `${shape} for ${viewer.memberId}`);
        assert.equal("gridShape" in copy, shape !== "squares", "squares carry no shape, as before hex grids");
      }
    }
  });

  test("a stationary emanation's size reaches players with its footprint", () => {
    const area = template("a1", { shape: "emanation", footprint: { w: 2, h: 2, elevation: 0, height: 10, size: "large" } });
    const state = { ...hexRoom(), templates: { a1: area } };
    assert.equal(projectState(state, P1, { sceneId: "s1" }).templates.a1!.footprint?.size, "large");
  });
});
