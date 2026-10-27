import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, test } from "node:test";
import { FOG_SUBCELLS, type BuildChunk, type FreeWall, type RoomState } from "#shared/model.ts";
import { chunkKey } from "#shared/keys.ts";
import { defaultIncludeOrigin, SAMPLES, type AreaTemplateInput, type CoverageResult } from "#shared/rules/aoe.ts";
import { sceneGrid, type Grid } from "#shared/rules/grid.ts";
import { hexSubcells } from "#shared/rules/hex.ts";
import { sceneWalls } from "#shared/rules/walls.ts";
import { reveal, room, scene, token } from "#shared/testutil.ts";
import { FogView } from "../../canvas/relief/fogView.ts";
import { cachedCoverage, caughtTokens, contextFrom, heldWalls, shadingClip } from "./coverage.ts";

/*
 * An area being aimed draws above the fog (AreaPreviewLayer.tsx). On a
 * player's device it reads only the walls with a revealed sub-cell beside
 * them, and its shading shows only on revealed sub-cells. Each case pairs
 * two rooms that differ only by a wall wholly under the fog, and reads the
 * sub-cells the shading paints for a viewer: inside the shading and inside
 * its clip. The DM reads every wall, so each pair differs for the DM, which
 * shows the wall matters there.
 */

const BOUNDS = { w: 16, h: 12 };

type Rect = { x: number; y: number; w: number; h: number };
type Layout = {
  name: string;
  reveal: readonly Rect[];
  origin: { x: number; y: number };
  size: number;
  /** West edges of cells, "x,y". */
  edges?: readonly string[];
  free?: readonly FreeWall[];
};

const column = (x: number, skip: readonly number[] = []) => Array.from({ length: BOUNDS.h }, (_, y) => y).filter((y) => !skip.includes(y)).map((y) => `${x},${y}`);
const freeWall = (id: string, a: [number, number], b: [number, number]): FreeWall => ({ id: id.padEnd(12, "0"), a, b, f: { kind: "wall" } });

const LAYOUTS: readonly Layout[] = [
  // The fog's edge at x = 8, the origin west of it, the wall a cell into the fog.
  { name: "a wall past the fog's edge", reveal: [{ x: 0, y: 0, w: 8, h: BOUNDS.h }], origin: { x: 6, y: 6 }, size: 20, edges: column(9) },
  // The origin in the fog beside revealed ground, a wall with a doorway between them.
  { name: "the origin in the fog beside revealed ground", reveal: [{ x: 0, y: 0, w: 8, h: BOUNDS.h }], origin: { x: 11, y: 6 }, size: 30, edges: column(10, [5, 6]) },
  // A fogged strip from x = 5 to 9 between revealed ground, the wall in the strip.
  {
    name: "revealed ground beyond a fogged strip",
    reveal: [
      { x: 0, y: 0, w: 5, h: BOUNDS.h },
      { x: 9, y: 0, w: 7, h: BOUNDS.h },
    ],
    origin: { x: 4, y: 6 },
    size: 30,
    edges: column(7),
  },
  // Revealed to x = 7.5, inside a cell, and a free wall in that cell's fogged half.
  { name: "the fog's edge inside a cell", reveal: [{ x: 0, y: 0, w: 7.5, h: BOUNDS.h }], origin: { x: 10, y: 6 }, size: 30, free: [freeWall("half", [7.75, 2], [7.75, 10])] },
];

function world(layout: Layout, gridShape: "square" | "hexRows", wall: boolean): RoomState {
  const state = room({ scenes: { s1: scene("s1", { bounds: BOUNDS, fogEnabled: true, ...(gridShape === "hexRows" ? { gridShape } : {}) }) } });
  for (const r of layout.reveal) reveal(state, "s1", r);
  const edges: BuildChunk["edges"] = {};
  const walls: FreeWall[] = [];
  if (wall) {
    // On a hex scene the same lines as free walls, a cell each: grid edges are a square scene's.
    if (gridShape === "square") for (const key of layout.edges ?? []) edges[`${key},w`] = { kind: "wall" };
    else
      for (const [i, key] of (layout.edges ?? []).entries()) {
        const [x, y] = key.split(",").map(Number) as [number, number];
        walls.push(freeWall(`e${i}`, [x, y], [x, y + 1]));
      }
    walls.push(...(layout.free ?? []));
  }
  state.buildChunks[chunkKey("s1", 0, 0)] = { sceneId: "s1", cx: 0, cy: 0, rev: 1, cells: {}, edges, ...(walls.length > 0 ? { walls } : {}) };
  return state;
}

function fogOf(state: RoomState, role: "dm" | "player"): FogView {
  return new FogView(role === "player" ? state.fogTiles : null, "s1", BOUNDS);
}

/** The sub-cells whose middles the shading covers: each covered cell's 16, or each covered hex's own. */
function shadedSubs(cov: CoverageResult, g: Grid): Set<string> {
  const out = new Set<string>();
  if (g.shape === "hex") {
    for (const h of cov.hexes ?? []) for (const [sx, sy] of hexSubcells(g, h)) out.add(`${sx},${sy}`);
    return out;
  }
  for (const c of cov.cells) {
    for (let j = 0; j < FOG_SUBCELLS; j++) for (let i = 0; i < FOG_SUBCELLS; i++) out.add(`${c.x * FOG_SUBCELLS + i},${c.y * FOG_SUBCELLS + j}`);
  }
  return out;
}

const subOf = (s: string) => s.split(",").map(Number) as [number, number];

/** What a viewer's board paints of the layout's area, as AreaPreviewLayer draws it: the shaded sub-cells inside the clip, or all of them when it shows whole. */
function painted(layout: Layout, state: RoomState, role: "dm" | "player"): { subs: Set<string>; fog: FogView; clip: ReturnType<typeof shadingClip> } {
  const s = state.scenes.s1!;
  const fog = fogOf(state, role);
  const ctx = contextFrom({ tokens: state.tokens, buildChunks: state.buildChunks, settings: state.meta.settings }, s, SAMPLES, fog);
  const area: AreaTemplateInput = { id: "f", rev: 1, shape: "sphere", size: layout.size, origin: { ...layout.origin, z: 0 }, yaw: 0, includeOrigin: defaultIncludeOrigin("sphere") };
  const cov = cachedCoverage(area, ctx);
  const clip = shadingClip(fog, cov, sceneGrid(s));
  const k = 1 / FOG_SUBCELLS;
  const inClip = (sx: number, sy: number) => clip === null || clip.some((r) => (sx + 0.5) * k > r.x && (sx + 0.5) * k < r.x + r.w && (sy + 0.5) * k > r.y && (sy + 0.5) * k < r.y + r.h);
  const subs = new Set([...shadedSubs(cov, ctx.grid)].filter((sub) => inClip(...subOf(sub))));
  return { subs, fog, clip };
}

function overFog(subs: Set<string>, fog: FogView): string[] {
  return [...subs].filter((s) => !fog.revealed(...subOf(s))).sort();
}

const sorted = (subs: Set<string>) => [...subs].sort();

describe("an aimed area on a player's fogged scene reads only the walls they could know (AreaPreviewLayer.tsx)", () => {
  for (const layout of LAYOUTS) {
    for (const gridShape of ["square", "hexRows"] as const) {
      test(`${gridShape}, ${layout.name}: a player's board paints the same sub-cells with the hidden wall and without it, none of them fogged`, () => {
        const open = painted(layout, world(layout, gridShape, false), "player");
        const walled = painted(layout, world(layout, gridShape, true), "player");
        assert.deepEqual(overFog(open.subs, open.fog), [], "nothing over the fog without the wall");
        assert.deepEqual(overFog(walled.subs, walled.fog), [], "nothing over the fog with it");
        assert.ok(open.subs.size > 0, "the shading shows on revealed ground");
        assert.deepEqual(sorted(walled.subs), sorted(open.subs), "the revealed shading is the same in both rooms");
      });

      test(`${gridShape}, ${layout.name}: the DM's board shows it whole, and the wall changes it`, () => {
        const open = painted(layout, world(layout, gridShape, false), "dm");
        const walled = painted(layout, world(layout, gridShape, true), "dm");
        assert.equal(open.clip, null);
        assert.equal(walled.clip, null);
        assert.notDeepEqual(sorted(walled.subs), sorted(open.subs));
      });
    }
  }

  test("who it rings and lists: a goblin on revealed ground the hidden wall shades from the origin is caught on a player's device either way, and only without the wall on the DM's", () => {
    const layout = LAYOUTS[1]!;
    const caught = (wall: boolean, role: "dm" | "player") => {
      const state = world(layout, "square", wall);
      // At 7, 1: the doorway's light reaches no lower than y = 2.5 there.
      state.tokens.g1 = token("g1", { sceneId: "s1", x: 7, y: 1 });
      const ctx = contextFrom({ tokens: state.tokens, buildChunks: state.buildChunks, settings: state.meta.settings }, state.scenes.s1!, SAMPLES, fogOf(state, role));
      return caughtTokens({ id: "f", rev: 1, shape: "sphere", size: layout.size, origin: { ...layout.origin, z: 0 }, yaw: 0, includeOrigin: true }, ctx, "s1");
    };
    assert.deepEqual(caught(false, "player"), ["g1"]);
    assert.deepEqual(caught(true, "player"), ["g1"]);
    assert.deepEqual(caught(false, "dm"), ["g1"]);
    assert.deepEqual(caught(true, "dm"), []);
  });

  test("a wall beside revealed ground still cuts a player's shading, as the DM's", () => {
    const layout: Layout = { name: "seen", reveal: [{ x: 0, y: 0, w: 8, h: BOUNDS.h }], origin: { x: 3, y: 6 }, size: 20, edges: column(5) };
    const open = painted(layout, world(layout, "square", false), "player");
    const walled = painted(layout, world(layout, "square", true), "player");
    const dm = painted(layout, world(layout, "square", true), "dm");
    assert.ok([...open.subs].some((s) => !walled.subs.has(s)), "the wall takes shading away");
    assert.deepEqual(sorted(walled.subs), sorted(new Set([...dm.subs].filter((s) => walled.fog.revealed(...subOf(s))))));
  });

  test("a window wholly revealed shows whole, and so does a scene without fog", () => {
    const layout = LAYOUTS[0]!;
    const state = world(layout, "square", true);
    reveal(state, "s1", { x: 0, y: 0, w: BOUNDS.w, h: BOUNDS.h });
    assert.equal(painted(layout, state, "player").clip, null);
    const ctx = contextFrom({ tokens: state.tokens, buildChunks: state.buildChunks, settings: state.meta.settings }, state.scenes.s1!);
    const area: AreaTemplateInput = { id: "f", rev: 1, shape: "sphere", size: 20, origin: { x: 6, y: 6, z: 0 }, yaw: 0, includeOrigin: true };
    assert.equal(shadingClip(new FogView(null, "s1", BOUNDS), cachedCoverage(area, ctx), ctx.grid), null);
  });
});

describe("the walls a player could know (coverage.ts heldWalls)", () => {
  /** The stored segments of the set a fog reads, as "ax,ay,bx,by". */
  const segments = (state: RoomState, fog: FogView) => {
    const s = heldWalls(sceneWalls(state.scenes.s1!, state.buildChunks), fog).stored;
    return Array.from({ length: s.n }, (_, k) => [...s.xy.subarray(4 * k, 4 * k + 4)].join(","));
  };

  test("a wall run is cut where the fog's edge crosses it, on the sub-cell line, and none of it under the fog stays", () => {
    const state = world({ name: "", reveal: [{ x: 0, y: 0, w: 16, h: 5.25 }], origin: { x: 0, y: 0 }, size: 5, edges: column(9) }, "square", true);
    // Revealed down to y = 5.25: the wall along x = 9 stays from its top to there, the sub-cell row it reaches into included.
    assert.deepEqual(segments(state, fogOf(state, "player")), ["9,0,9,5.25"]);
    assert.deepEqual(segments(state, fogOf(state, "dm")), ["9,0,9,12"]);
  });

  test("a slanted free wall keeps the stretch over revealed sub-cells, its cut end on the 1/64 lattice", () => {
    const layout: Layout = { name: "", reveal: [{ x: 0, y: 0, w: 4, h: BOUNDS.h }], origin: { x: 0, y: 0 }, size: 5, free: [freeWall("slant", [1, 1], [7, 4])] };
    const state = world(layout, "square", true);
    const [seg, ...rest] = segments(state, fogOf(state, "player"));
    assert.deepEqual(rest, []);
    const [ax, ay, bx, by] = seg!.split(",").map(Number) as [number, number, number, number];
    assert.deepEqual([ax, ay], [1, 1]);
    assert.ok(Math.abs(bx - 4) <= 1 / 64 && Math.abs(by - 2.5) <= 1 / 64, `it ends at the fog's edge: ${seg}`);
    assert.ok(Number.isInteger(bx * 64) && Number.isInteger(by * 64), `on the lattice: ${seg}`);
  });

  test("one set for each fog's tiles, a new version when they change, and the set itself for the DM", () => {
    const state = world(LAYOUTS[0]!, "square", true);
    const walls = sceneWalls(state.scenes.s1!, state.buildChunks);
    const a = heldWalls(walls, fogOf(state, "player"));
    assert.equal(heldWalls(walls, new FogView(state.fogTiles, "s1", BOUNDS)), a, "the same tiles read the same set");
    assert.notEqual(a.version, walls.version);
    reveal(state, "s1", { x: 8, y: 0, w: 2, h: 2 });
    assert.notEqual(heldWalls(walls, new FogView({ ...state.fogTiles }, "s1", BOUNDS)).version, a.version);
    assert.equal(heldWalls(walls, fogOf(state, "dm")), walls);
  });

  test("the previews and the In area list read this viewer's fog and live ground, and both previews shade through the clip", () => {
    const preview = readFileSync(new URL("./AreaPreviewLayer.tsx", import.meta.url), "utf8");
    assert.equal(preview.match(/contextFrom\(\{ tokens, buildChunks, settings, live: ground \}, scene, (undefined|PREVIEW_SAMPLES), fog\)/g)?.length, 2);
    // The only bare Shading is the one ShadingAboveFog wraps, which both previews draw.
    assert.equal(preview.match(/<Shading /g)?.length, 1);
    assert.equal(preview.match(/<ShadingAboveFog /g)?.length, 2);
    const options = readFileSync(new URL("./AreaOptions.tsx", import.meta.url), "utf8");
    assert.match(options, /settings: env\.view\.meta\.settings, live: ground \}, env\.scene, samplesNow\(props\.moving \|\| live\.moving\), fog\);/);
  });

  test("placed areas, the moving auras they drive, and the Areas panel's and a cast block's lists read this viewer's fog and live ground too", () => {
    const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");
    assert.match(read("./TemplateLayer.tsx"), /contextFrom\(\{ tokens, buildChunks, settings, live: ground \}, scene, samplesNow\(moving\), viewer\)/);
    assert.match(read("./AreasPanel.tsx"), /settings: view\.meta\.settings, live: ground \}, scene, samplesNow\(live\.moving\), fog\);/);
    assert.match(read("../dice/cast/CastBlock.tsx"), /settings: view\.meta\.settings, live: ground \}, scene, samplesNow\(live\.moving\), fog\);/);
  });
});
