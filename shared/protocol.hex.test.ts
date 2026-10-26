import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { clientOpSchema } from "./protocol.ts";

/** The ops' grid shape fields (docs/design-v1-hex-grids.md section 7). */
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
