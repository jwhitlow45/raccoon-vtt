import type { BuildChunk, EdgeFeature, TerrainId } from "#shared/model.ts";
import { MAX_BUILD_CELLS, MAX_BUILD_EDGES, type ClientOp, type OpOf } from "#shared/protocol.ts";
import { SQUARES } from "#shared/rules/grid.ts";
import type { LevelBand } from "#shared/srd/traps.ts";
import type { SceneInput } from "../scenes/create.ts";
import { newTrapInput } from "../traps/rules.ts";
import { batchByBytes, OP_BYTES } from "../uvtt/batch.ts";
import type { DungeonPlan } from "./plan.ts";

/*
 * A plan as the ops Make sends (docs/design/design-v1-dungeon-generator.md
 * 5.5): ordinary bounded builder ops, which the server checks as it checks
 * any DM's, so the stored ops hold the whole dungeon and replay never runs
 * the generator. The worker writes them with placeholder ids, and Make
 * gives every id a fresh one (`withIds`), so no id comes from the seed's
 * stream and a second Make never resends one.
 */

/** Ops one Make sends at most (phase 2, section 6): past the server's burst of 60, paced by the store's busy retry. */
export const MAX_OPS = 100;

/** The scene's id while the dungeon is only a preview. */
export const SCENE_PLACEHOLDER = "dungeon-scene";

/** A trap's id while the dungeon is only a preview, by its place in the plan. */
export function trapPlaceholder(i: number): string {
  return `dungeon-trap-${i}`;
}

/**
 * Floors before overlays, in the builder's own order. A cell holds one
 * terrain (shared/rules/autoWalls.ts) and the plan paints each cell once,
 * so the order only keeps the ops the same on every run.
 */
const TERRAIN_ORDER: readonly TerrainId[] = ["stone", "wood", "grass", "dirt", "cave", "water", "difficult", "rubble", "pit", "pillar", "stairs"];

function door(state: DungeonPlan["doors"][number]["state"]): EdgeFeature {
  if (state === "secret") return { kind: "door", state: "closed", secret: true, discovered: false };
  return { kind: "door", state, secret: false, discovered: false };
}

/** Cells cut into ops of at most MAX_BUILD_CELLS cells and OP_BYTES each. */
function cellOps(cells: readonly string[], wrap: (cells: string[]) => ClientOp): ClientOp[] {
  return batchByBytes(cells, MAX_BUILD_CELLS, OP_BYTES, wrap).map(wrap);
}

/**
 * Every op but the traps, in the order they apply: the scene, a paint per
 * terrain, the doors, a height per value and a stair mark per facing. The
 * scene never carries a starting view, which would tell players where the
 * entrance is through the fog (D-261102-387), and no op draws a wall, since
 * every wall is automatic (D-261102-022).
 */
export function buildOps(plan: DungeonPlan, scene: SceneInput): ClientOp[] {
  const { defaultView: _view, ...bare } = scene;
  const sceneId = bare.id;
  const ops: ClientOp[] = [{ t: "scene.create", scene: bare }];
  for (const terrain of TERRAIN_ORDER) {
    const cells = plan.paint[terrain];
    if (cells && cells.length > 0) ops.push(...cellOps(cells, (c) => ({ t: "build.paint", sceneId, terrain, cells: c })));
  }
  const edges: OpOf<"build.edge">["edges"] = plan.doors.map((d) => ({ key: d.edge, feature: door(d.state) }));
  const edgeOp = (e: OpOf<"build.edge">["edges"]): ClientOp => ({ t: "build.edge", sceneId, edges: e });
  if (edges.length > 0) ops.push(...batchByBytes(edges, MAX_BUILD_EDGES, OP_BYTES, edgeOp).map(edgeOp));
  for (const { ft, cells } of plan.heights) {
    if (ft !== 0 && cells.length > 0) ops.push(...cellOps(cells, (c) => ({ t: "build.height", sceneId, cells: c, height: ft })));
  }
  for (const { up, cells } of plan.stairs) {
    if (cells.length > 0) ops.push(...cellOps(cells, (c) => ({ t: "build.stairs", sceneId, cells: c, up })));
  }
  return ops;
}

/**
 * One `trap.create` per planned trap, each the SRD preset at the party's
 * level as the Trap tool makes it (traps/rules.ts `newTrapInput`), read
 * from the scratch room's chunks so a pit's floor sits under the ground the
 * build ops left there. Each starts armed and unfound, so no player gets it
 * until it is found.
 */
export function trapOps(plan: DungeonPlan, chunks: Readonly<Record<string, BuildChunk>>, band: LevelBand, sceneId: string): ClientOp[] {
  return plan.traps.map((trap, i) => ({
    t: "trap.create",
    trap: newTrapInput({ grid: SQUARES, id: trapPlaceholder(i), sceneId, start: trap.preset, band, zone: trap.zone, chunks }),
  }));
}

/**
 * The dressing's ops (phase 2, section 6): the stamps, 100 an op, the
 * lights in one op, and a hidden token per Rolling Stone. Contract stub:
 * lane DG2-B builds the body.
 */
export function dressOps(plan: DungeonPlan, sceneId: string): ClientOp[] {
  throw new Error(`not built: ${plan.stamps.length} stamps on ${sceneId}`);
}

/**
 * The ops with every id fresh: the scene's and each trap's. Every op must
 * name the one scene the first op makes, since an op naming any other
 * would land on a scene the DM never meant. `ids` maps each placeholder to
 * its fresh id, so the outcome's check follows a reference through it
 * (phase 2, section 6).
 */
export function withIds(ops: ClientOp[], newId: () => string): { ops: ClientOp[]; sceneId: string; ids: ReadonlyMap<string, string> } {
  const create = ops[0];
  if (create?.t !== "scene.create") throw new Error("a dungeon's ops start with its scene");
  const was = create.scene.id;
  const sceneId = newId();
  const ids = new Map<string, string>([[was, sceneId]]);
  const fresh = (placeholder: string): string => {
    const id = newId();
    ids.set(placeholder, id);
    return id;
  };
  const onScene = (id: string): string => {
    if (id !== was) throw new Error("a dungeon op names another scene");
    return sceneId;
  };
  const out = ops.map((op, i): ClientOp => {
    switch (op.t) {
      case "scene.create":
        if (i !== 0) throw new Error("a dungeon makes one scene");
        return { ...op, scene: { ...op.scene, id: sceneId } };
      case "build.paint":
      case "build.edge":
      case "build.height":
      case "build.stairs":
        return { ...op, sceneId: onScene(op.sceneId) };
      case "trap.create":
        return { ...op, trap: { ...op.trap, id: fresh(op.trap.id), sceneId: onScene(op.trap.sceneId) } };
      default:
        throw new Error(`a dungeon sends no ${op.t}`);
    }
  });
  return { ops: out, sceneId, ids };
}
