import { createInitialState } from "#shared/initial.ts";
import { checkLimits } from "#shared/limits.ts";
import type { Member, RoomState, Viewer } from "#shared/model.ts";
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
import { buildOps, dressOps, MAX_OPS, SCENE_PLACEHOLDER, trapOps } from "./ops.ts";
import { generate, type DungeonPlan } from "./plan.ts";
import type { Seed } from "./seed.ts";
import { MIN_ROOMS, type DungeonSettings, type PlanContext } from "./settings.ts";

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
export function previewScene(scene: SceneInput, plan: Pick<DungeonPlan, "w" | "h">): SceneInput {
  const { gridShape: _shape, defaultView: _view, ...rest } = scene;
  return { ...rest, id: SCENE_PLACEHOLDER, bounds: { w: plan.w, h: plan.h } };
}

/**
 * The foot's counts. A Wide doorway's two door edges are one double door,
 * so doors count doorways: door edges in a line, touching end to end, are
 * one, which is exact since doorways keep a square apart (5.3 step 4).
 */
export function summarize(plan: Pick<DungeonPlan, "rooms" | "asked" | "doors" | "traps" | "lights">): Summary {
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
  return { rooms: plan.rooms.length, asked: plan.asked, doors, locked, traps: plan.traps.length, secretDoors, secretRooms: plan.rooms.filter((r) => r.secret).length, lights: plan.lights.length };
}

/**
 * A preview whole, as the worker answers it: the plan, the ops Make sends,
 * the room they make and the foot's counts, the key's page and pins among
 * the ops when `key` is given and DM key is on. Fewer than two rooms is the
 * "fit" error, and anything thrown or refused is a generator bug.
 */
export function previewOf(
  settings: DungeonSettings,
  seed: Seed,
  scene: SceneInput,
  context: PlanContext,
  key: KeyInput | null,
  make: (settings: DungeonSettings, seed: Seed, context: PlanContext) => DungeonPlan = generate,
): Preview {
  let plan: DungeonPlan;
  try {
    plan = make(settings, seed, context);
  } catch (err) {
    console.error("raccoon: the dungeon generator failed", err);
    return { ok: false, error: "bug" };
  }
  if (plan.rooms.length < MIN_ROOMS) return { ok: false, error: "fit" };
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
  return { ok: true, plan, ops: landed.ops, room: landed.room, summary: summarize(plan) };
}
