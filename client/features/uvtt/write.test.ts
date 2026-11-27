import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { BuildChunk, Light } from "#shared/model.ts";
import { chunksOf as heldChunks, edge, fogRoom, lift, paint } from "#shared/discoveryTestutil.ts";
import { projectChunkForPlayer } from "#shared/project.ts";
import { P1 } from "#shared/testutil.ts";
import { chunksOf, door, importBack, light, WALL, WINDOW, type BuildInput } from "./exportTestutil.ts";
import { checkExport } from "./steps.ts";
import { fileColor, lengthened, uvttGeometry, type UvttSource } from "./write.ts";

/*
 * The export's writer (docs/design/design-v1-uvtt-export.md sections 2, 5
 * and 6): each of the app's parts as the file holds it, clipped and
 * lengthened, and a player view file that holds nothing players do not.
 */

type Pt = { x: number; y: number };
type Line = Pt[];

function source(build: BuildInput, more: Partial<Omit<UvttSource, "scene">> & { scene?: Partial<UvttSource["scene"]> } = {}): UvttSource {
  return {
    chunks: chunksOf(build),
    rule: "all",
    lights: [],
    feetPerCell: 5,
    pxPerCell: 70,
    ...more,
    scene: { bounds: { w: 20, h: 20 }, ...more.scene },
  };
}

const lines = (json: Record<string, unknown>) => json.line_of_sight as Line[];
const objects = (json: Record<string, unknown>) => json.objects_line_of_sight as Line[];
const portals = (json: Record<string, unknown>) => json.portals as { position: Pt; bounds: [Pt, Pt]; rotation: number; closed: boolean; freestanding: boolean }[];
const lightsOf = (json: Record<string, unknown>) => json.lights as { position: Pt; range: number; intensity: number; color: string; shadows: boolean }[];
const len = (a: Pt, b: Pt) => Math.hypot(b.x - a.x, b.y - a.y);
const onLattice = (v: number) => Number.isInteger(v * 64);

/** Floor cells over [x, x + w) by [y, y + h). */
function room(x: number, y: number, w: number, h: number): Record<string, "stone"> {
  const out: Record<string, "stone"> = {};
  for (let j = y; j < y + h; j++) for (let i = x; i < x + w; i++) out[`${i},${j}`] = "stone";
  return out;
}

describe("what the file holds", () => {
  test("keys in Dungeondraft's order, the scene's size and scale, the origin at 0", () => {
    const { json } = uvttGeometry(source({}, { scene: { bounds: { w: 12, h: 7 } }, pxPerCell: 100 }), "dm");
    assert.deepEqual(Object.keys(json), ["format", "software", "resolution", "line_of_sight", "objects_line_of_sight", "portals", "environment", "lights"]);
    assert.equal(json.format, 0.3);
    assert.equal(json.software, "Raccoon VTT");
    assert.deepEqual(json.resolution, { map_origin: { x: 0, y: 0 }, map_size: { x: 12, y: 7 }, pixels_per_grid: 100 });
  });

  test("automatic walls merge into runs along each grid line, and a none edge removes one first", () => {
    const { json } = uvttGeometry(source({ cells: room(2, 3, 3, 2), edges: { "3,3,n": { kind: "none" } } }), "dm");
    const got = lines(json).map((l) => JSON.stringify(l)).sort();
    const want = [
      [{ x: 2, y: 3 }, { x: 3, y: 3 }],
      [{ x: 4, y: 3 }, { x: 5, y: 3 }],
      [{ x: 2, y: 5 }, { x: 5, y: 5 }],
      [{ x: 2, y: 3 }, { x: 2, y: 5 }],
      [{ x: 5, y: 3 }, { x: 5, y: 5 }],
    ].map((l) => JSON.stringify(l)).sort();
    assert.deepEqual(got, want);
  });

  test("a drawn wall joins the automatic run it continues, under the scene's rule", () => {
    const off = uvttGeometry(source({ cells: room(2, 3, 3, 2), edges: { "5,3,n": WALL } }, { rule: "off" }), "dm");
    assert.deepEqual(lines(off.json), [[{ x: 5, y: 3 }, { x: 6, y: 3 }]], "rule off: only the drawn wall");
    const all = uvttGeometry(source({ cells: room(2, 3, 3, 2), edges: { "5,3,n": WALL } }), "dm");
    assert.ok(lines(all.json).some((l) => JSON.stringify(l) === JSON.stringify([{ x: 2, y: 3 }, { x: 6, y: 3 }])));
  });

  test("locked and open doors are closed portals, windows open ones, each with its midpoint and rotation", () => {
    const { json, counts } = uvttGeometry(
      source({ edges: { "3,2,n": door({ state: "locked" }), "6,2,w": door({ state: "open" }), "9,2,n": WINDOW }, walls: [{ a: [1, 10], b: [2, 11], f: door() }] }),
      "dm",
    );
    const ps = portals(json);
    assert.equal(ps.length, 4);
    const at = (x: number, y: number) => ps.find((p) => p.position.x === x && p.position.y === y)!;
    assert.deepEqual(at(3.5, 2), { position: { x: 3.5, y: 2 }, bounds: [{ x: 3, y: 2 }, { x: 4, y: 2 }], rotation: 0, closed: true, freestanding: false });
    assert.equal(at(6, 2.5).closed, true, "an open door is written closed");
    assert.equal(at(6, 2.5).rotation, Math.PI / 2);
    assert.equal(at(9.5, 2).closed, false, "a window is open");
    assert.equal(at(1.5, 10.5).rotation, Math.PI / 4);
    assert.deepEqual([counts.doors, counts.windows], [3, 1]);
    const plan = importBack({ json, counts });
    assert.ok(plan.edges.every((e) => e.feature.kind !== "door" || e.feature.state === "closed"), "every door back closed");
  });

  test("a pillar is its square at PILLAR_INSET, one closed five-point line", () => {
    const { json } = uvttGeometry(source({ cells: { "4,6": "pillar" } }, { rule: "off" }), "dm");
    const lo = 9 / 64;
    const hi = 1 - lo;
    assert.deepEqual(objects(json), [
      [
        { x: 4 + lo, y: 6 + lo },
        { x: 4 + hi, y: 6 + lo },
        { x: 4 + hi, y: 6 + hi },
        { x: 4 + lo, y: 6 + hi },
        { x: 4 + lo, y: 6 + lo },
      ],
    ]);
    const plan = importBack(uvttGeometry(source({ cells: { "4,6": "pillar" } }, { rule: "off" }), "dm"));
    assert.equal(plan.walls.length, 4, "back as four free walls");
  });

  test("environment from the light level now, never baked", () => {
    for (const [light, ambient] of [
      ["bright", "ffffffff"],
      ["dim", "ff808080"],
      ["dark", "ff000000"],
    ] as const) {
      const { json } = uvttGeometry(source({}, { scene: { vision: { on: true, light } } }), "dm");
      assert.deepEqual(json.environment, { baked_lighting: false, ambient_light: ambient });
    }
    assert.deepEqual(uvttGeometry(source({}), "dm").json.environment, { baked_lighting: false, ambient_light: "ffffffff" }, "no vision reads as Bright");
  });
});

describe("lights", () => {
  test("a lamp of 15 and 30 ft colored #ffcc88aa: range 9 at 5 ft, ffffcc88, and back as 22.5 and 22.5", () => {
    const head = uvttGeometry(source({}, { lights: [light({ x: 4.5, y: 4.5, bright: 15, dim: 30, color: "#ffcc88aa", walls: false })] }), "dm");
    assert.deepEqual(lightsOf(head.json), [{ position: { x: 4.5, y: 4.5 }, range: 9, intensity: 1, color: "ffffcc88", shadows: false }]);
    const back = importBack(head).lights;
    assert.equal(back.length, 1);
    assert.deepEqual([back[0]!.x, back[0]!.y, back[0]!.bright, back[0]!.dim, back[0]!.color, back[0]!.walls], [4.5, 4.5, 22.5, 22.5, "#ffcc88", false]);
  });

  test("bright equal to dim comes back exactly", () => {
    const back = importBack(uvttGeometry(source({}, { lights: [light({ x: 3, y: 3.5, bright: 20, dim: 20 })] }), "dm")).lights;
    assert.deepEqual([back[0]!.bright, back[0]!.dim], [20, 20]);
  });

  test("an off light is left out and counted, and a color the file cannot use is white", () => {
    const head = uvttGeometry(source({}, { lights: [light({ on: false }), light({ id: "l2", color: "tomato" })] }), "dm");
    assert.equal(lightsOf(head.json).length, 1);
    assert.equal(lightsOf(head.json)[0]!.color, "ffffffff");
    assert.equal(head.counts.lightsOff, 1);
    assert.equal(fileColor("#AbCdEf"), "ffabcdef");
    assert.equal(fileColor("#abc"), "ffffffff");
  });
});

describe("secret doors and the player view", () => {
  const secret = { "3,2,n": door({ secret: true }), "7,2,n": door({ secret: true, discovered: true }) };
  const freeSecret = [{ a: [10, 10] as [number, number], b: [11, 11] as [number, number], f: door({ secret: true }) }];

  test("the DM view writes every secret door as a plain closed door and counts them", () => {
    const head = uvttGeometry(source({ edges: secret, walls: freeSecret }, { rule: "off" }), "dm");
    assert.equal(portals(head.json).length, 3);
    assert.ok(portals(head.json).every((p) => p.closed));
    assert.equal(head.counts.secretAsDoors, 3);
  });

  test("a player view file writes an undiscovered secret door, on an edge and free, as a wall and holds no light", () => {
    const src = source({ edges: secret, walls: freeSecret }, { rule: "off", lights: [light()] });
    // The writer's own rule, even on the DM's chunks, and on the players' projection the image is drawn from.
    const projected = { ...src, chunks: src.chunks.map((c) => projectChunkForPlayer(Object.fromEntries(src.chunks.map((k) => [`s:${k.cx},${k.cy}`, k])), c, "off")).filter((c): c is BuildChunk => c !== null) };
    for (const input of [src, projected]) {
      const head = uvttGeometry(input, "player");
      const doors = portals(head.json);
      assert.equal(doors.length, 1, "only the found door is a door");
      assert.deepEqual(doors[0]!.bounds, [{ x: 7, y: 2 }, { x: 8, y: 2 }]);
      const walls = lines(head.json).map((l) => JSON.stringify(l));
      assert.ok(walls.includes(JSON.stringify([{ x: 3, y: 2 }, { x: 4, y: 2 }])), "the edge door is a wall");
      assert.ok(walls.includes(JSON.stringify([{ x: 10, y: 10 }, { x: 11, y: 11 }])), "the free door is a wall");
      assert.deepEqual(head.json.lights, []);
      assert.equal(head.counts.secretAsDoors, 0);
    }
  });

  test("fog on: walls only on the chunks players hold, under the rule off, and no secret door", () => {
    const state = fogRoom({ bounds: { w: 40, h: 20 } });
    paint(state, { x: 2, y: 2, w: 4, h: 3 });
    paint(state, { x: 22, y: 2, w: 4, h: 3 });
    edge(state, "6,3,w", door({ secret: true }));
    lift(state, "dm", { x: 0, y: 0, w: 8, h: 8 });
    const held = Object.values(heldChunks(state, P1));
    const head = uvttGeometry({ ...source({}, { scene: { bounds: { w: 40, h: 20 } } }), chunks: held, rule: "off" }, "player");
    const xs = lines(head.json).flatMap((l) => l.map((p) => p.x));
    assert.ok(xs.length > 0, "the held room's walls are written");
    assert.ok(xs.every((x) => x <= 16), "nothing of the room players never saw");
    assert.equal(portals(head.json).length, 0, "the secret door is a wall");
  });
});

describe("the scene's edge and short pieces", () => {
  test("walls, a door and a light past a shrunk scene are cut at its edge or left out, and counted", () => {
    const head = uvttGeometry(
      source(
        { cells: room(8, 2, 4, 2), walls: [{ a: [15, 15], b: [18, 15], f: door() }] },
        { scene: { bounds: { w: 10, h: 10 } }, lights: [light({ x: 12, y: 3 }), light({ id: "l2", x: 5, y: 5 })] },
      ),
      "dm",
    );
    for (const l of lines(head.json)) for (const p of l) assert.ok(p.x <= 10 && p.y <= 10, JSON.stringify(l));
    assert.equal(portals(head.json).length, 0, "the door wholly outside is left out");
    assert.equal(lightsOf(head.json).length, 1);
    // Two runs cut at x = 10, the run along x = 12 left out, the door, the light.
    assert.equal(head.counts.clipped, 5);
    assert.deepEqual(checkExport(head.json, 5), { changes: false }, "the import takes it unchanged");
  });

  test("a free wall 3/64 long is written 7/64 about its midpoint and comes back", () => {
    const head = uvttGeometry(source({ walls: [{ a: [5, 5], b: [5 + 3 / 64, 5], f: WALL }] }, { rule: "off" }), "dm");
    const [line] = lines(head.json);
    assert.deepEqual(line, [
      { x: 5 - 2 / 64, y: 5 },
      { x: 5 + 5 / 64, y: 5 },
    ]);
    assert.equal(head.counts.short, true);
    assert.equal(importBack(head).walls.length, 1);
  });

  test("a short piece on the scene's edge grows inward, and a short diagonal stays on the lattice and at least 7/64", () => {
    const edge = uvttGeometry(source({ walls: [{ a: [10 - 2 / 64, 3], b: [10 + 1 / 64, 3], f: WALL }] }, { scene: { bounds: { w: 10, h: 10 } }, rule: "off" }), "dm");
    const [e] = lines(edge.json);
    assert.equal(e![1]!.x, 10, "the end on the edge stays there");
    assert.ok(len(e![0]!, e![1]!) >= 7 / 64);
    assert.equal(edge.counts.clipped, 1);
    const diag = uvttGeometry(source({ walls: [{ a: [4, 4], b: [4 + 2 / 64, 4 + 1 / 64], f: WALL }] }, { rule: "off" }), "dm");
    const [d] = lines(diag.json);
    assert.ok(d!.every((p) => onLattice(p.x) && onLattice(p.y)));
    assert.ok(len(d![0]!, d![1]!) >= 7 / 64);
    assert.equal(importBack(diag).walls.length, 1, "it comes back");
  });

  test("lengthening never moves an end more than a tenth of a square, and a piece of no length is dropped", () => {
    for (let dx = 0; dx <= 6; dx++) {
      for (let dy = 0; dy <= 6; dy++) {
        const p = { ax: 640, ay: 640, bx: 640 + dx, by: 640 + dy };
        const q = lengthened(p, 6400, 6400);
        if (dx === 0 && dy === 0) {
          assert.equal(q, null);
          continue;
        }
        assert.ok(q && Math.hypot(q.bx - q.ax, q.by - q.ay) >= 7, `${dx},${dy}`);
        assert.ok(Math.hypot(q.ax - p.ax, q.ay - p.ay) < 6.4 && Math.hypot(q.bx - p.bx, q.by - p.by) < 6.4);
      }
    }
  });
});

describe("hex scenes", () => {
  for (const gridShape of ["hexRows", "hexColumns"] as const) {
    test(`${gridShape}: a stair mark writes no walls, and free walls are written at their exact ends`, () => {
      const up = ".".repeat(256).split("");
      up[3 * 16 + 3] = "a";
      const chunk = { ...chunksOf({ walls: [{ a: [2 + 5 / 64, 3], b: [4, 3 + 33 / 64], f: WALL }] })[0]!, up: up.join(""), grid: gridShape } as BuildChunk;
      const head = uvttGeometry({ ...source({}), chunks: [chunk], scene: { bounds: { w: 20, h: 20 }, gridShape } }, "dm");
      assert.deepEqual(lines(head.json), [
        [
          { x: 2 + 5 / 64, y: 3 },
          { x: 4, y: 3 + 33 / 64 },
        ],
      ]);
    });
  }
});

/** Kept so a light's type stays in step with the model's. */
export const _light: Light = light();
