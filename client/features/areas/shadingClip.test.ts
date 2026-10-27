import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, test } from "node:test";
import { FOG_SUBCELLS, type BuildChunk, type RoomState } from "#shared/model.ts";
import { chunkKey } from "#shared/keys.ts";
import { defaultIncludeOrigin, type AreaTemplateInput, type CoverageResult } from "#shared/rules/aoe.ts";
import { sceneGrid, type Grid } from "#shared/rules/grid.ts";
import { hexSubcells } from "#shared/rules/hex.ts";
import { reveal, room, scene } from "#shared/testutil.ts";
import { FogView } from "../../canvas/relief/fogView.ts";
import { areaContext, cachedCoverage, shadingClip } from "./coverage.ts";

/*
 * An area being aimed draws above the fog (AreaPreviewLayer.tsx), and its
 * shading is cut by every wall the device holds, those under a player's
 * fog too. Each case pairs two rooms that differ only by a wall on fogged
 * ground, and reads the sub-cells the shading paints for a viewer: inside
 * the shading and inside its clip.
 */

const BOUNDS = { w: 16, h: 12 };
/** Every column west of this one revealed, the rest fogged. */
const FOG_EDGE = 8;
/** A 20 ft sphere whose east side reaches into the fog. */
const fireball: AreaTemplateInput = { id: "f", rev: 1, shape: "sphere", size: 20, origin: { x: 6, y: 6, z: 0 }, yaw: 0, includeOrigin: defaultIncludeOrigin("sphere") };

type Sub = string;

function world(gridShape: "square" | "hexRows", wall: boolean): RoomState {
  const state = room({ scenes: { s1: scene("s1", { bounds: BOUNDS, fogEnabled: true, ...(gridShape === "hexRows" ? { gridShape } : {}) }) } });
  reveal(state, "s1", { x: 0, y: 0, w: FOG_EDGE, h: BOUNDS.h });
  const edges: BuildChunk["edges"] = {};
  const walls: BuildChunk["walls"] = [];
  // On fogged ground, a cell and a half east of the fog's edge.
  if (wall && gridShape === "square") for (let y = 0; y < BOUNDS.h; y++) edges[`9,${y},w`] = { kind: "wall" };
  if (wall && gridShape === "hexRows") walls.push({ id: "w00000000001", a: [9.5, 2], b: [9.5, 10], f: { kind: "wall" } });
  state.buildChunks[chunkKey("s1", 0, 0)] = { sceneId: "s1", cx: 0, cy: 0, rev: 1, cells: {}, edges, ...(walls.length > 0 ? { walls } : {}) };
  return state;
}

function fogOf(state: RoomState, role: "dm" | "player"): FogView {
  return new FogView(role === "player" ? state.fogTiles : null, "s1", BOUNDS);
}

/** The sub-cells whose middles the shading covers: each covered cell's 16, or each covered hex's own. */
function shadedSubs(cov: CoverageResult, g: Grid): Set<Sub> {
  const out = new Set<Sub>();
  if (g.shape === "hex") {
    for (const h of cov.hexes ?? []) for (const [sx, sy] of hexSubcells(g, h)) out.add(`${sx},${sy}`);
    return out;
  }
  for (const c of cov.cells) {
    for (let j = 0; j < FOG_SUBCELLS; j++) for (let i = 0; i < FOG_SUBCELLS; i++) out.add(`${c.x * FOG_SUBCELLS + i},${c.y * FOG_SUBCELLS + j}`);
  }
  return out;
}

/** What a viewer's board paints: the shaded sub-cells inside the clip, or all of them when it shows whole. */
function painted(state: RoomState, role: "dm" | "player"): { subs: Set<Sub>; fog: FogView; clip: ReturnType<typeof shadingClip> } {
  const ctx = areaContext(state, state.scenes.s1!);
  const cov = cachedCoverage(fireball, ctx);
  const fog = fogOf(state, role);
  const clip = shadingClip(fog, cov, sceneGrid(state.scenes.s1!));
  const k = 1 / FOG_SUBCELLS;
  const inClip = (sx: number, sy: number) => clip === null || clip.some((r) => (sx + 0.5) * k > r.x && (sx + 0.5) * k < r.x + r.w && (sy + 0.5) * k > r.y && (sy + 0.5) * k < r.y + r.h);
  const subs = new Set([...shadedSubs(cov, ctx.grid)].filter((s) => inClip(...(s.split(",").map(Number) as [number, number]))));
  return { subs, fog, clip };
}

function overFog(subs: Set<Sub>, fog: FogView): Sub[] {
  return [...subs].filter((s) => !fog.revealed(...(s.split(",").map(Number) as [number, number]))).sort();
}

describe("an aimed area's shading over a player's fog (AreaPreviewLayer.tsx)", () => {
  for (const gridShape of ["square", "hexRows"] as const) {
    test(`${gridShape}: a player's board paints the same sub-cells with the hidden wall and without it, none of them fogged`, () => {
      const open = painted(world(gridShape, false), "player");
      const walled = painted(world(gridShape, true), "player");
      assert.ok(open.clip !== null, "the window reaches into the fog, so the shading is clipped");
      assert.deepEqual(overFog(open.subs, open.fog), [], "nothing over the fog without the wall");
      assert.deepEqual(overFog(walled.subs, walled.fog), [], "nothing over the fog with it");
      assert.deepEqual([...walled.subs].sort(), [...open.subs].sort(), "the revealed shading is the same in both rooms");
      assert.ok(open.subs.size > 0, "the shading still shows on revealed ground");
    });

    test(`${gridShape}: the DM's board shows it whole, cut by the wall`, () => {
      const open = painted(world(gridShape, false), "dm");
      const walled = painted(world(gridShape, true), "dm");
      assert.equal(open.clip, null);
      assert.equal(walled.clip, null);
      const cut = [...open.subs].filter((s) => !walled.subs.has(s));
      assert.ok(cut.length > 0, "the wall takes shading away east of it");
      assert.ok(cut.every((s) => Number(s.split(",")[0]) >= 9 * FOG_SUBCELLS), `only east of the wall: ${cut.slice(0, 4).join(" ")}`);
    });
  }

  test("a window wholly revealed shows whole, and so does a scene without fog", () => {
    const state = world("square", true);
    reveal(state, "s1", { x: 0, y: 0, w: BOUNDS.w, h: BOUNDS.h });
    assert.equal(painted(state, "player").clip, null);
    const ctx = areaContext(state, state.scenes.s1!);
    assert.equal(shadingClip(new FogView(null, "s1", BOUNDS), cachedCoverage(fireball, ctx), ctx.grid), null);
  });

  test("both the device's own preview and the shared ones shade through the clip, from this viewer's fog", () => {
    const src = readFileSync(new URL("./AreaPreviewLayer.tsx", import.meta.url), "utf8");
    assert.match(src, /const fog = useViewerFog\(props\);/);
    // The only bare Shading is the one ShadingAboveFog wraps.
    assert.equal(src.match(/<Shading /g)?.length, 1);
    assert.equal(src.match(/<ShadingAboveFog cov=\{cachedCoverage\(t, ctx\)\} grid=\{ctx\.grid\} fog=\{props\.fog\}/g)?.length, 2);
    assert.match(src, /return clip \? <Clipped rects=\{clip\}>\{shading\}<\/Clipped> : shading;/);
  });
});
