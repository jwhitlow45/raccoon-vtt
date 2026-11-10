import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { clientOpSchema, MAX_ASK_BYTES, MAX_WING_FLOOR_RUNS } from "./protocol.ts";

/** The ops' grid shape fields (docs/design/design-v1-hex-grids.md section 7). */
const ok = (value: unknown) => assert.ok(clientOpSchema.safeParse(value).success, JSON.stringify(value));
const no = (value: unknown) => assert.ok(!clientOpSchema.safeParse(value).success, JSON.stringify(value));

const create = (scene: object) => ({ t: "scene.create", scene: { id: "mat", name: "Mat", bounds: { w: 30, h: 20 }, ...scene } });
const area = (footprint: object) => ({
  t: "template.create",
  template: {
    id: "a1",
    sceneId: "s1",
    shape: "emanation",
    size: 10,
    origin: { x: 5, y: 5, z: 0 },
    yaw: 0,
    footprint: { w: 2, h: 2, elevation: 0, height: 10, ...footprint },
    includeOrigin: false,
    color: "#ff0000",
    ownerId: "dm1",
    visibility: "all",
  },
});

describe("grid shapes in ops", () => {
  test("a create and a patch name squares or either hex shape, and nothing else", () => {
    for (const shape of ["squares", "hexRows", "hexColumns"]) {
      ok(create({ gridShape: shape }));
      ok({ t: "scene.update", sceneId: "s1", patch: { gridShape: shape } });
      ok({ t: "room.update", settings: { newScenes: shape } });
    }
    ok(create({}));
    for (const shape of ["hex", "hexes", "", null, 1]) {
      no(create({ gridShape: shape }));
      no({ t: "scene.update", sceneId: "s1", patch: { gridShape: shape } });
      no({ t: "room.update", settings: { newScenes: shape } });
    }
  });

  test("a stationary footprint names the size it was cast from, never custom", () => {
    ok(area({}));
    for (const size of ["tiny", "small", "medium", "large", "huge", "gargantuan"]) ok(area({ size }));
    no(area({ size: "custom" }));
    no(area({ size: "enormous" }));
  });
});

describe("a wing's ask (dungeon generator phase 3, 3.6 and 5)", () => {
  const wall = { id: "w00000000001", a: [2, 2], b: [2.5, 2.5], f: { kind: "wall" } };
  const ask = (more: object = {}) => ({
    t: "build.ask",
    sceneId: "s1",
    part: 0,
    ops: [
      { t: "build.walls", sceneId: "s1", put: [wall], remove: [{ cx: 0, cy: 0, id: "w00000000002" }] },
      { t: "build.stamps", sceneId: "s1", put: [{ id: "st1", art: { key: "barrel" }, x: 3, y: 3, w: 1, h: 1, rotation: 0, z: 0, visibility: "all" }] },
    ],
    ...more,
  });
  const hexJoin = { grid: "hex", walls: [{ cx: 0, cy: 0, id: "w00000000002", a: [1, 1], b: [1.5, 1.25], f: { kind: "wall" } }], ground: 5 };
  const squareJoin = { grid: "squares", edges: [{ key: "4,5,n", feature: null, ground: 0 }] };

  test("carries free walls and stamps, and a clear on squares or hexes", () => {
    ok(ask());
    ok(ask({ clear: { margin: 2, join: squareJoin, autoWalls: "all" } }));
    ok(ask({ clear: { margin: 3, join: { ...squareJoin, edges: [...squareJoin.edges, { key: "5,5,n", feature: { kind: "door", state: "closed", secret: false, discovered: false }, ground: 0 }] }, autoWalls: "floor" } }));
    ok(ask({ clear: { margin: 2, join: hexJoin, autoWalls: "all", floor: [[3, 1, 4], [4, 0, 6]], inside: ["2,3"] } }));
  });

  test("refuses a clear out of shape", () => {
    no(ask({ clear: { margin: 1, join: squareJoin, autoWalls: "all" } }));
    no(ask({ clear: { margin: 2, join: squareJoin, autoWalls: "some" } }));
    no(ask({ clear: { margin: 2, join: { ...squareJoin, edges: [] }, autoWalls: "all" } }));
    no(ask({ clear: { margin: 2, join: { ...hexJoin, walls: [...hexJoin.walls, ...hexJoin.walls, ...hexJoin.walls, ...hexJoin.walls] }, autoWalls: "all" } }));
    no(ask({ clear: { margin: 2, join: { ...hexJoin, ground: 1000 }, autoWalls: "all" } }));
    no(ask({ clear: { margin: 2, join: hexJoin, autoWalls: "all", floor: [[3, 4, 1]] } }));
    no(ask({ clear: { margin: 2, join: hexJoin, autoWalls: "all", floor: [] } }));
    no(ask({ clear: { margin: 2, join: hexJoin, autoWalls: "all", extra: true } }));
  });

  test("the floor runs ride inside the ask's bytes", () => {
    const runs = Array.from({ length: MAX_WING_FLOOR_RUNS + 1 }, (_, i) => [i % 100, 0, 1]);
    no(ask({ clear: { margin: 2, join: hexJoin, autoWalls: "all", floor: runs } }));
    const fat = Array.from({ length: MAX_WING_FLOOR_RUNS }, () => [99, 100, 199]);
    assert.ok(JSON.stringify(fat).length > MAX_ASK_BYTES);
    no(ask({ clear: { margin: 2, join: hexJoin, autoWalls: "all", floor: fat } }));
  });
});
