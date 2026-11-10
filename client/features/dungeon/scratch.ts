import { createInitialState } from "#shared/initial.ts";
import { checkLimits } from "#shared/limits.ts";
import type { Member, RoomState, Viewer } from "#shared/model.ts";
import { autoWallsOf } from "#shared/rules/autoWalls.ts";
import type { WingClear } from "#shared/rules/wingClear.ts";
import { clientOpSchema, type ClientOp, type Op } from "#shared/protocol.ts";
import { applyOp } from "#shared/reducer.ts";
import { pitsMoved, withPitsCounted } from "#shared/rules/pitCount.ts";
import { splitCheck } from "#shared/rules/walls.ts";
import type { LevelBand } from "#shared/srd/traps.ts";
import { sightPiecesCheck } from "#shared/visionLimits.ts";
import { boardTheme } from "../../lib/theme.ts";
import type { SceneInput } from "../scenes/create.ts";
import type { Preview, Summary } from "./client.ts";
import { keyOps, type KeyInput } from "./keyPage.ts";
import type { DungeonEdits } from "./edits.ts";
import { NO_SPACE } from "./hexWalls.ts";
import { buildOps, dressOps, MAX_OPS, SCENE_PLACEHOLDER, trapOps, WING_OP_BYTES, wingMapOps } from "./ops.ts";
import { planFitted, type DungeonPlan, type Planned, type WingBase } from "./plan.ts";
import type { Seed } from "./seed.ts";
import { clampSettings, isHexGrid, MIN_ROOMS, type DungeonSettings, type PlanContext } from "./settings.ts";
import { wingSetup } from "./wing.ts";

/*
 * The scratch room (docs/design/design-v1-dungeon-generator.md 5.5): the
 * dungeon's ops applied in order, as the DM, by the one reducer, to a room
 * holding only the new scene, with the server's shared admission checks run
 * on every prefix as its `#reduce` runs them (server/rooms/actor.ts). The
 * preview is drawn from this room, so it shows exactly what Make lands. The
 * size guard and the memory estimate read the live room, so only the server
 * runs them, and a refusal there ends as partial.
 */

// The scratch room's only member. Nothing draws its color, so any token's will do, as long as it is plain hex as a member's color is.
const DM: Member = { id: "scratch-dm", rev: 1, name: "DM", color: boardTheme.color.text, kind: "dm", createdAt: "2026-01-01T00:00:00.000Z" };
const AS_DM: Viewer = { memberId: DM.id, role: "dm" };
const AT = DM.createdAt;

/** A room with no scene, so the new scene is the only one counted and drawn. */
export function scratchRoom(): RoomState {
  const room = createInitialState({ roomName: "Scratch", dm: DM, now: AT });
  return { ...room, meta: { ...room.meta, playerSceneId: null }, scenes: {}, playedScenes: {} };
}

export type Landing = { ok: true; room: RoomState } | { ok: false; at: number; why: string };

/** The scene whose per-scene limits the op can push, as the server's `scenesOf` reads the ops a dungeon sends: none for a trap or a page. */
function limitScene(op: Op): string | null {
  if (op.t === "scene.create") return op.scene.id;
  if (op.t === "token.create") return op.token.sceneId;
  if (op.t === "pin.put") return op.pin.sceneId;
  return "sceneId" in op && typeof op.sceneId === "string" ? op.sceneId : null;
}

/**
 * The walls the sight cap counts, read as if the scene had vision on. The
 * dialog sets Players see on the scene only at Make (it may turn vision on
 * there), so the preview holds the dungeon to the cap whatever is chosen.
 */
function seenWithVision(state: RoomState, sceneId: string): ReturnType<typeof withPitsCounted> {
  const counted = withPitsCounted(state, sceneId);
  const scene = counted.scenes[sceneId];
  if (!scene || scene.vision?.on === true) return counted;
  return { ...counted, scenes: { ...counted.scenes, [sceneId]: { ...scene, vision: { ...scene.vision, on: true, light: scene.vision?.light ?? "bright" } } } };
}

/** Scenes whose walls version the op moved, as the server's `wallsMoved`. */
function wallsMoved(before: RoomState, after: RoomState): string[] {
  if (before.scenes === after.scenes) return [];
  return Object.entries(after.scenes).flatMap(([id, scene]) => (before.scenes[id]?.wallsVersion === scene.wallsVersion ? [] : [id]));
}

/**
 * One op on the room, parsed as `dispatch` parses it, applied as the DM, and
 * checked as `#reduce` checks it: the limits on the op without its trap
 * step, the split's counting pass on every scene whose walls or pits moved,
 * and the sight cap on those and the op's own scene, as if vision were on.
 */
export function landOp(room: RoomState, raw: ClientOp, seq: number): { ok: true; room: RoomState } | { ok: false; why: string } {
  const parsed = clientOpSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, why: `${raw.t} does not parse: ${parsed.error.issues[0]?.message ?? ""}` };
  const op = parsed.data as Op;
  const result = applyOp(room, op, AS_DM, { seq, at: AT });
  if (!result.ok) return { ok: false, why: `${op.t} refused: ${result.message}` };
  const measured = result.withoutTraps ? result.withoutTraps() : result;
  if (!measured.ok) return { ok: false, why: `${op.t} refused: ${measured.message}` };
  const own = limitScene(op);
  const limits = checkLimits(measured.state, own, room, "dm");
  if (!limits.ok) return { ok: false, why: `${op.t} over a limit: ${limits.message}` };
  const traps = measured.touched.flatMap((key) => (key.startsWith("trap:") ? [key.slice(5)] : []));
  const moved = [...new Set([...wallsMoved(room, measured.state), ...pitsMoved(room, measured.state, traps)])];
  for (const sceneId of moved) {
    const split = splitCheck(withPitsCounted(measured.state, sceneId), sceneId);
    if (!split.ok) return { ok: false, why: `${op.t} over the split: ${split.message}` };
  }
  for (const sceneId of new Set([...(own ? [own] : []), ...moved])) {
    const sight = sightPiecesCheck(seenWithVision(measured.state, sceneId), sceneId, seenWithVision(room, sceneId));
    if (!sight.ok) return { ok: false, why: `${op.t} over the sight cap: ${sight.message}` };
  }
  return { ok: true, room: result.state };
}

/** Every op in order. A refusal or a failed check names the op it stopped at. */
export function landAll(room: RoomState, ops: readonly ClientOp[], firstSeq = 1): Landing {
  let state = room;
  for (const [i, op] of ops.entries()) {
    const landed = landOp(state, op, firstSeq + i);
    if (!landed.ok) return { ok: false, at: i, why: landed.why };
    state = landed.room;
  }
  return { ok: true, room: state };
}

export type Landed = { ok: true; ops: ClientOp[]; room: RoomState } | { ok: false; why: string };

/**
 * The whole dungeon through the scratch room, in the order the ops apply
 * (phase 2, section 6): the ground, the stamps, the lights and the stones,
 * then the traps written from the chunks those left, so a pit's floor
 * reads the ground the DM's room will hold and a trap follows the stone it
 * shows, then the key's page and its pins, which follow the page they
 * link. The key needs the choices for its Made with line, and its lengths
 * read in the key's feet per square, the room's, which the plan was made
 * at. Anything refused here, or past MAX_OPS, is a generator bug, which the
 * preview shows as its error with Make off.
 */
export function landDungeon(plan: DungeonPlan, scene: SceneInput, band: LevelBand, key: { input: KeyInput; settings: DungeonSettings } | null): Landed {
  const build = [...buildOps(plan, scene), ...dressOps(plan, scene.id)];
  const built = landAll(scratchRoom(), build);
  if (!built.ok) return { ok: false, why: `op ${built.at}: ${built.why}` };
  const rest = [...trapOps(plan, built.room.buildChunks, band, scene.id), ...(key ? keyOps(plan, key.settings, key.input, scene.id) : [])];
  const ops = [...build, ...rest];
  if (ops.length > MAX_OPS) return { ok: false, why: `${ops.length} ops, past ${MAX_OPS}` };
  const landed = landAll(built.room, rest, build.length + 1);
  if (!landed.ok) return { ok: false, why: `op ${build.length + landed.at}: ${landed.why}` };
  return { ok: true, ops, room: landed.room };
}

/**
 * The scene a preview lands: the dialog's, as a square scene on the plan's
 * own size under a placeholder id. Bounds are the chosen size, never
 * cropped to the rooms, so players learn nothing of the rooms' reach
 * (D-261102-384).
 */
export function previewScene(scene: SceneInput, plan: Pick<DungeonPlan, "w" | "h" | "grid">): SceneInput {
  const { gridShape: _shape, defaultView: _view, ...rest } = scene;
  // A hex plan lands on its grid (phase 3, 2.1), and its bounds are the scene's cells, which its rows lattice covers.
  return { ...rest, id: SCENE_PLACEHOLDER, bounds: { w: plan.w, h: plan.h }, ...(isHexGrid(plan.grid) ? { gridShape: plan.grid } : {}) };
}

/**
 * The foot's counts. A Wide doorway's two door edges are one double door,
 * so doors count doorways: door edges in a line, touching end to end, are
 * one, which is exact since doorways keep a square apart (5.3 step 4). On
 * hexes a doorway's leaves (`leaves`, the plan's walls by doorway) are one
 * door in their doorway's one state (phase 3, 2.2).
 */
export function summarize(plan: Pick<DungeonPlan, "rooms" | "asked" | "doors" | "traps" | "lights" | "walls">, leaves?: readonly (readonly number[])[]): Summary {
  const byKey = new Map(plan.doors.map((d) => [d.edge, d.state]));
  const seen = new Set<string>();
  let doors = 0;
  let locked = 0;
  let secretDoors = 0;
  for (const { edge, state } of plan.doors) {
    if (seen.has(edge)) continue;
    doors++;
    if (state === "locked") locked++;
    if (state === "secret") secretDoors++;
    // Walk the doorway's line both ways, marking each door edge in it.
    const [x, y, side] = edge.split(",") as [string, string, "n" | "w"];
    const step = side === "n" ? [1, 0] : [0, 1];
    for (const dir of [1, -1]) {
      for (let k = dir === 1 ? 0 : -1; ; k += dir) {
        const key = `${Number(x) + step[0]! * k},${Number(y) + step[1]! * k},${side}`;
        if (!byKey.has(key) || seen.has(key)) break;
        seen.add(key);
      }
    }
  }
  for (const doorway of leaves ?? []) {
    const f = plan.walls?.[doorway[0] ?? -1]?.f;
    if (f === undefined || f === "wall") continue;
    doors++;
    if (f === "locked") locked++;
    if (f === "secret") secretDoors++;
  }
  return { rooms: plan.rooms.length, asked: plan.asked, doors, locked, traps: plan.traps.length, secretDoors, secretRooms: plan.rooms.filter((r) => r.secret).length, lights: plan.lights.length };
}

/** What a preview reads of a plan's working. */
type Made = Pick<Planned, "plan" | "facts" | "fitted" | "overBudget" | "leaves">;

/**
 * Why a plan cannot be shown, as the preview says it: under two rooms,
 * past the fit's plans, or a hex plan with edits over the wall budget
 * (phase 3, 2.5 and 4.2), or none.
 */
function fitFailure(planned: Made): Preview | null {
  if (planned.overBudget === "tooMany") return { ok: false, error: "fit", why: "tooMany" };
  if (planned.overBudget === "edits") return { ok: false, error: "fit", why: "edits" };
  if (planned.overBudget === "underTwo" || planned.plan.rooms.length < MIN_ROOMS) return { ok: false, error: "fit", why: "underTwo" };
  return null;
}

/** What the room panel reads of a plan (phase 3, 4.1): each kept room's facts, and the room count the plan asked for. */
function panelOf(planned: Made): { facts: Planned["facts"]; fitted: number } {
  return { facts: planned.facts, fitted: planned.fitted };
}

/**
 * A preview whole, as the worker answers it: the plan, the ops Make sends,
 * the room they make and the foot's counts, the key's page and pins among
 * the ops when `key` is given and DM key is on, and what the room panel
 * reads. On hexes the plan is the first within the wall budget, stepping
 * the room count down, and with edits the count they froze (phase 3, 2.5
 * and 4.2). A failed fit is the "fit" error with why, and anything thrown
 * or refused is a generator bug.
 */
export function previewOf(
  settings: DungeonSettings,
  seed: Seed,
  scene: SceneInput,
  context: PlanContext,
  key: KeyInput | null,
  make: (settings: DungeonSettings, seed: Seed, context: PlanContext, edits: DungeonEdits | null) => Made | DungeonPlan = (s, sd, c, e) => planFitted(s, sd, c, e ? { edits: e } : {}),
  edits: DungeonEdits | null = null,
): Preview {
  let planned: Made;
  try {
    const made = make(settings, seed, context, edits);
    // A plan alone, as a test hands one, has no room panel and asked for its rooms.
    planned = "plan" in made ? made : { plan: made, facts: [], fitted: made.asked, overBudget: null, leaves: [] };
  } catch (err) {
    console.error("raccoon: the dungeon generator failed", err);
    return { ok: false, error: "bug" };
  }
  const failed = fitFailure(planned);
  if (failed) return failed;
  const plan = planned.plan;
  let landed: Landed;
  try {
    landed = landDungeon(plan, previewScene(scene, plan), settings.band, key && { input: key, settings });
  } catch (err) {
    console.error("raccoon: a generated dungeon could not be landed", err);
    return { ok: false, error: "bug" };
  }
  if (!landed.ok) {
    console.error(`raccoon: a generated dungeon was refused at ${landed.why}`);
    return { ok: false, error: "bug" };
  }
  return { ok: true, plan, ops: landed.ops, room: landed.room, summary: summarize(plan, isHexGrid(plan.grid) ? planned.leaves : undefined), ...panelOf(planned) };
}

/** The scene id a wing's scratch room keeps: the base's own, so the ops a wing plans already name the scene it joins. */
function wingScratch(base: WingBase): RoomState {
  const room = scratchRoom();
  return {
    ...room,
    scenes: { [base.scene.id]: base.scene },
    buildChunks: base.state.buildChunks,
    traps: base.state.traps,
    stamps: base.state.stamps,
    lights: base.state.lights,
    labels: base.state.labels,
    pins: base.state.pins,
    tokens: base.state.tokens,
    ...(base.state.floorLinks ? { floorLinks: base.state.floorLinks } : {}),
  };
}

/**
 * A wing through a scratch room holding its base (phase 3, 3.3 and 3.5):
 * the scene it joins with what can stand in the way, then the wing's map
 * ops, stamps, lights and stones, its traps from the chunks those left,
 * and last its key's page and pins. Every check `landOp` runs reads the
 * scene's own counts with the wing's, so a wing the scene has no room for
 * is refused here, as the server would refuse it.
 */
export function landWing(plan: DungeonPlan, base: WingBase, band: LevelBand, key: { input: KeyInput; settings: DungeonSettings } | null): Landed {
  const sceneId = base.scene.id;
  const build = [...wingMapOps(plan, sceneId), ...dressOps(plan, sceneId, WING_OP_BYTES)];
  const built = landAll(wingScratch(base), build);
  if (!built.ok) return { ok: false, why: `op ${built.at}: ${built.why}` };
  const rest = [...trapOps(plan, built.room.buildChunks, band, sceneId), ...(key ? keyOps(plan, key.settings, key.input, sceneId) : [])];
  const ops = [...build, ...rest];
  if (ops.length > MAX_OPS) return { ok: false, why: `${ops.length} ops, past ${MAX_OPS}` };
  const landed = landAll(built.room, rest, build.length + 1);
  if (!landed.ok) return { ok: false, why: `op ${build.length + landed.at}: ${landed.why}` };
  return { ok: true, ops, room: landed.room };
}

/**
 * The wing's floor as row runs of scene keys (phase 3, 3.6): every hex of
 * its rooms, corridors and runs, which its last ask carries for the
 * server's clearance check. Empty on squares, where the paint is the floor.
 */
export function floorRuns(planned: Pick<Planned, "space" | "lattice">): [number, number, number][] {
  const { space, lattice: L } = planned;
  const rows = new Map<number, number[]>();
  for (let k = 0; k < space.length; k++) {
    if (space[k] === NO_SPACE) continue;
    const [x, y] = L.keyOf(k).split(",").map(Number) as [number, number];
    const row = rows.get(y);
    if (row) row.push(x);
    else rows.set(y, [x]);
  }
  const runs: [number, number, number][] = [];
  for (const y of [...rows.keys()].sort((a, b) => a - b)) {
    const xs = rows.get(y)!.sort((a, b) => a - b);
    let from = xs[0]!;
    let to = from;
    for (const x of xs.slice(1)) {
      if (x === to + 1) to = x;
      else {
        runs.push([y, from, to]);
        from = to = x;
      }
    }
    runs.push([y, from, to]);
  }
  return runs;
}

/** What a wing's asks carry (phase 3, 3.6): its margin, join and the scene's wall rule, and on hexes the join's inside hexes and the wing's floor. */
export function wingClearOf(planned: Planned, base: WingBase, settings: DungeonSettings): WingClear | null {
  const join = planned.plan.join;
  if (!join) return null;
  const clear: WingClear = { margin: settings.wide ? 3 : 2, join, autoWalls: autoWallsOf(base.scene) };
  if (join.grid === "squares") return clear;
  const setup = wingSetup(base, clampSettings(settings, base.scene.gridShape ?? "squares"));
  const runs = floorRuns(planned);
  return { ...clear, inside: setup.facts.inside.map((k) => setup.world.L.keyOf(k)), ...(runs.length > 0 ? { floor: runs } : {}) };
}

/**
 * A wing's preview, as the worker answers it (phase 3, 3.3 to 3.5): the
 * plan on its base, the ops Make sends with the key's when DM key is on,
 * the scratch room with the wing landed in it, the counts, the room
 * panel's facts, and what its asks carry. A wing that cannot be planned
 * is the "fit" error with the planner's problem.
 */
export function wingPreviewOf(settings: DungeonSettings, seed: Seed, base: WingBase, context: PlanContext, key: KeyInput | null, edits: DungeonEdits | null = null): Preview {
  let planned: Planned;
  try {
    planned = planFitted(settings, seed, context, { wing: base, ...(edits ? { edits } : {}) });
  } catch (err) {
    console.error("raccoon: the wing planner failed", err);
    return { ok: false, error: "bug" };
  }
  const problem = planned.wing?.problem ?? null;
  if (problem) return { ok: false, error: "fit", problem };
  const failed = fitFailure(planned);
  if (failed) return failed;
  const plan = planned.plan;
  const clear = wingClearOf(planned, base, settings);
  if (!clear) return { ok: false, error: "bug" };
  let landed: Landed;
  try {
    landed = landWing(plan, base, settings.band, key && { input: key, settings });
  } catch (err) {
    console.error("raccoon: a planned wing could not be landed", err);
    return { ok: false, error: "bug" };
  }
  if (!landed.ok) {
    // The scene's counts with the wing's past a cap the planner's allowance did not hold, such as the sight cap: the scene is too full.
    if (/over a limit|over the split|over the sight cap/.test(landed.why)) return { ok: false, error: "fit", problem: "full" };
    console.error(`raccoon: a planned wing was refused at ${landed.why}`);
    return { ok: false, error: "bug" };
  }
  return { ok: true, plan, ops: landed.ops, room: landed.room, summary: summarize(plan, isHexGrid(plan.grid) ? planned.leaves : undefined), ...panelOf(planned), clear };
}
