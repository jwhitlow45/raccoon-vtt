import { LIMITS } from "#shared/limits.ts";
import type { BuildChunk, EdgeFeature, TerrainId, TrapRig } from "#shared/model.ts";
import { MAX_ASK_BYTES, MAX_BUILD_CELLS, MAX_BUILD_EDGES, type ClientOp, type OpOf, type TokenInput, type TrapInput } from "#shared/protocol.ts";
import { gridOfShape, SQUARES, type Grid } from "#shared/rules/grid.ts";
import { groundAt } from "#shared/rules/heights.ts";
import { hexAt } from "#shared/rules/hex.ts";
import type { LevelBand } from "#shared/srd/traps.ts";
import { newWallId } from "../builder/hexBuild.ts";
import { DEFAULT_ICON_COLOR } from "../images/iconColors.ts";
import { newBlockId } from "../journal/draft.ts";
import type { SceneInput } from "../scenes/create.ts";
import { blankActor, blankToken } from "../tokens/factory.ts";
import { newTrapInput } from "../traps/rules.ts";
import { batchByBytes, OP_BYTES } from "../uvtt/batch.ts";
import { PLACED_LIGHTS } from "../vision/presets.ts";
import { wallPlaceholder } from "./hexWalls.ts";
import type { DungeonPlan, PlanTrap } from "./plan.ts";

/*
 * A plan as the ops Make sends (docs/design/design-v1-dungeon-generator.md
 * 5.5, phase 2 section 6): ordinary bounded DM ops, which the server checks
 * as it checks any DM's, so the stored ops hold the whole dungeon and
 * replay never runs the generator. The worker writes them with placeholder
 * ids, and Make gives every id a fresh one (`withIds`), so no id comes from
 * the seed's stream and a second Make never resends one.
 */

/** Ops one Make sends at most (phase 2, section 6): past the server's burst of 60, paced by the store's busy retry. */
export const MAX_OPS = 100;

/** The scene's id while the dungeon is only a preview. */
export const SCENE_PLACEHOLDER = "dungeon-scene";
/** The key's page while the dungeon is only a preview. */
export const PAGE_PLACEHOLDER = "dungeon-key";

/** A trap's id while the dungeon is only a preview, by its place in the plan. */
export function trapPlaceholder(i: number): string {
  return `dungeon-trap-${i}`;
}

export function stampPlaceholder(i: number): string {
  return `dungeon-stamp-${i}`;
}

export function lightPlaceholder(i: number): string {
  return `dungeon-light-${i}`;
}

/** A Rolling Stone's token, by its place in the plan's `stones`. */
export function stonePlaceholder(i: number): string {
  return `dungeon-stone-${i}`;
}

export function pinPlaceholder(i: number): string {
  return `dungeon-pin-${i}`;
}

/** A key block's id while the dungeon is only a preview: 12 characters, as a journal block id must be. */
export function blockPlaceholder(i: number): string {
  return `dungeonblk${String(i).padStart(2, "0")}`;
}

/**
 * Floors before overlays, in the builder's own order. A cell holds one
 * terrain (shared/rules/autoWalls.ts) and the plan paints each cell once,
 * so the order only keeps the ops the same on every run.
 */
const TERRAIN_ORDER: readonly TerrainId[] = ["stone", "wood", "grass", "dirt", "cave", "water", "difficult", "rubble", "pit", "pillar", "stairs"];

/**
 * A planned door as `build.edge` writes it. A secret door names its cover
 * itself (lane B's SB1), so while hidden it reaches every fog class as an
 * automatic wall bit beside the room's automatic walls, never as a drawn
 * wall that would mark it out, whatever kind lane B would read off its line.
 */
function door(state: DungeonPlan["doors"][number]["state"]): EdgeFeature {
  if (state === "secret") return { kind: "door", state: "closed", secret: true, discovered: false, cover: "auto" };
  return { kind: "door", state, secret: false, discovered: false };
}

/** Free walls one op puts at most, as a Wall line batches them (builder/hexBuild.ts): each is under 128 bytes, so the count binds before the bytes. */
export const WALLS_PER_OP = 384;

/**
 * Bytes one of a wing's map ops holds at most, so each rides in an ask
 * with the ask's own fields and the wing's clear (phase 3, 3.6). The floor
 * runs ride the smallest op, which leaves them the room.
 */
export const WING_OP_BYTES = MAX_ASK_BYTES - 4 * 1024;

/**
 * A plan's map ops on a scene, in the order they apply: on squares a paint
 * per terrain and the doors, on hexes the free walls (each a placeholder
 * id Make replaces, sorted by their ends), then a height per value, a stair
 * mark per facing, and difficult ground where the plan marks it (hexes and
 * a wing on a "floor" scene). A hex wing's join goes in an op of its own
 * first: the wall it stood as removed and its leaf put, in one op, since a
 * put on the same ends as a standing wall would double it.
 */
export function mapOps(plan: DungeonPlan, sceneId: string, bytes: number = OP_BYTES): ClientOp[] {
  const ops: ClientOp[] = [];
  const cellOps = (cells: readonly string[], wrap: (cells: string[]) => ClientOp) => batchByBytes(cells, MAX_BUILD_CELLS, bytes, wrap).map(wrap);
  for (const terrain of TERRAIN_ORDER) {
    const cells = plan.paint[terrain];
    if (cells && cells.length > 0) ops.push(...cellOps(cells, (c) => ({ t: "build.paint", sceneId, terrain, cells: c })));
  }
  const edges: OpOf<"build.edge">["edges"] = plan.doors.map((d) => ({ key: d.edge, feature: door(d.state) }));
  const edgeOp = (e: OpOf<"build.edge">["edges"]): ClientOp => ({ t: "build.edge", sceneId, edges: e });
  if (edges.length > 0) ops.push(...batchByBytes(edges, MAX_BUILD_EDGES, bytes, edgeOp).map(edgeOp));
  ops.push(...wallOps(plan, sceneId, bytes));
  for (const { ft, cells } of plan.heights) {
    if (ft !== 0 && cells.length > 0) ops.push(...cellOps(cells, (c) => ({ t: "build.height", sceneId, cells: c, height: ft })));
  }
  for (const { up, cells } of plan.stairs) {
    if (cells.length > 0) ops.push(...cellOps(cells, (c) => ({ t: "build.stairs", sceneId, cells: c, up })));
  }
  if (plan.rough && plan.rough.length > 0) ops.push(...cellOps(plan.rough, (c) => ({ t: "build.rough", sceneId, cells: c, on: true })));
  return ops;
}

type WallPut = NonNullable<OpOf<"build.walls">["put"]>[number];

/** A plan wall's feature as a free wall carries it: a leaf's door in its doorway's state, a secret one hidden. */
function wallFeature(f: NonNullable<DungeonPlan["walls"]>[number]["f"]): WallPut["f"] {
  if (f === "wall") return { kind: "wall" };
  if (f === "secret") return { kind: "door", state: "closed", secret: true, discovered: false };
  return { kind: "door", state: f, secret: false, discovered: false };
}

/** The plan's free walls as ops (2.2), a hex wing's join first in an op of its own with the wall it replaces removed. */
function wallOps(plan: DungeonPlan, sceneId: string, bytes: number): ClientOp[] {
  if (!plan.walls || plan.walls.length === 0) return [];
  const join = plan.join?.grid === "hex" ? plan.join.walls : [];
  const same = (a: readonly [number, number], b: readonly [number, number], p: readonly [number, number], q: readonly [number, number]) =>
    (a[0] === p[0] && a[1] === p[1] && b[0] === q[0] && b[1] === q[1]) || (a[0] === q[0] && a[1] === q[1] && b[0] === p[0] && b[1] === p[1]);
  const puts: WallPut[] = plan.walls.map((w, i) => ({ id: wallPlaceholder(i), a: w.a, b: w.b, f: wallFeature(w.f) }));
  // A join that was a wall takes a leaf on its ends. A door there keeps standing as it is, and gets no put.
  const leaves = puts.filter((p) => join.some((j) => same(p.a, p.b, j.a, j.b)));
  const replaced = join.filter((j) => leaves.some((p) => same(p.a, p.b, j.a, j.b))).map((j) => ({ cx: j.cx, cy: j.cy, id: j.id }));
  const rest = puts.filter((p) => !leaves.includes(p));
  const wallOp = (put: WallPut[]): ClientOp => ({ t: "build.walls", sceneId, put });
  const ops: ClientOp[] = leaves.length > 0 ? [{ t: "build.walls", sceneId, remove: replaced, put: leaves }] : [];
  for (const put of batchByBytes(rest, WALLS_PER_OP, bytes, wallOp)) ops.push(wallOp(put));
  return ops;
}

/**
 * The ground ops, in the order they apply: the scene, then its map ops
 * (`mapOps`). The scene never carries a starting view, which would tell
 * players where the entrance is through the fog (D-261102-387). On squares
 * no op draws a wall, since every wall is automatic (D-261102-022), and on
 * hexes the walls are free walls (phase 3, D-261110-160).
 */
export function buildOps(plan: DungeonPlan, scene: SceneInput): ClientOp[] {
  const { defaultView: _view, ...bare } = scene;
  return [{ t: "scene.create", scene: bare }, ...mapOps(plan, bare.id)];
}

/**
 * A wing's ops on the scene it joins (phase 3, 3.5): no scene, its map ops
 * cut to ride in its asks, then its dressing and traps as a new scene's.
 * Every id is a placeholder until Make, but the join's, which names the
 * standing wall the wing replaces.
 */
export function wingMapOps(plan: DungeonPlan, sceneId: string): ClientOp[] {
  return mapOps(plan, sceneId, WING_OP_BYTES);
}

/** A planned light's SRD radii as the Lights mode's preset holds them, so the Lights pane shows that preset chosen. */
function lightRadii(preset: DungeonPlan["lights"][number]["preset"]): { bright: number; dim: number } {
  const found = PLACED_LIGHTS.find((p) => p.name === preset);
  if (!found) throw new Error(`no light preset ${preset}`);
  return { bright: found.bright, dim: found.dim };
}

/**
 * A Rolling Stone's hidden token (phase 2, 5.4, D-261107-265): a Large
 * object on its 2 by 2 squares, with the speed and initiative its roll
 * needs. The SRD's threshold and size go in the note, which reaches only
 * those who see the token, and the token stays the DM's until its trap
 * shows it.
 */
export function stoneToken(id: string, sceneId: string, at: readonly [number, number]): TokenInput {
  return {
    ...blankToken({ id, sceneId, kind: "object", at: { x: at[0], y: at[1] } }),
    name: "Rolling stone",
    size: "large",
    visibility: "dm",
    image: { icon: "lorc/stone-sphere", color: DEFAULT_ICON_COLOR },
    notes: "Damage Threshold 10. A Large object.",
    actor: { inline: blankActor({ hp: { cur: 100, max: 100, temp: 0 }, ac: 17, speeds: { walk: 60 }, initBonus: 8 }) },
  };
}

/**
 * The dressing's ops (phase 2, section 6): the stamps at most 100 an op,
 * drawn in plan order, the lights in one op, and a hidden token per
 * Rolling Stone. A stamp is for everyone, since map discovery withholds one
 * on ground a player has not seen and each lies inside one room or
 * corridor. A light is DM-only state, lit and casting shadows from walls.
 */
export function dressOps(plan: DungeonPlan, sceneId: string, bytes: number = OP_BYTES): ClientOp[] {
  const ops: ClientOp[] = [];
  const stamps: NonNullable<OpOf<"build.stamps">["put"]> = plan.stamps.map((s, i) => ({ id: stampPlaceholder(i), art: { key: s.key }, x: s.x, y: s.y, w: s.w, h: s.h, rotation: s.rotation, z: i, visibility: "all" }));
  const stampOp = (put: NonNullable<OpOf<"build.stamps">["put"]>): ClientOp => ({ t: "build.stamps", sceneId, put });
  for (const put of batchByBytes(stamps, LIMITS.stampsPerOp, bytes, stampOp)) ops.push(stampOp(put));
  const lights: NonNullable<OpOf<"build.lights">["put"]> = plan.lights.map((l, i) => ({ id: lightPlaceholder(i), x: l.x, y: l.y, ...lightRadii(l.preset), on: true, walls: true, label: l.label }));
  const lightOp = (put: NonNullable<OpOf<"build.lights">["put"]>): ClientOp => ({ t: "build.lights", sceneId, put });
  for (const put of batchByBytes(lights, LIMITS.lightsPerOp, OP_BYTES, lightOp)) ops.push(lightOp(put));
  for (const [i, at] of plan.stones.entries()) ops.push({ t: "token.create", token: stoneToken(stonePlaceholder(i), sceneId, at) });
  return ops;
}

/** The sentence the Fire-Casting Statue's preset opens its note with (shared/srd/traps.ts). */
const PLACE_THE_CONE = /^Place the \d+-foot cone from the statue\. /;

/**
 * One planned trap as the Trap tool makes it (traps/rules.ts
 * `newTrapInput`), then what the generator set: its squares in place of
 * the zone's, its cone from the plan's origin, at the ground there, along
 * the plan's yaw, and its one action showing the stone it rolls. The
 * generator's reach check (trapSpots.ts `statueReaches`) can land this same
 * input, so the trap it kept is the trap Make sends.
 */
export function trapInputOf(trap: PlanTrap, id: string, chunks: Readonly<Record<string, BuildChunk>>, band: LevelBand, sceneId: string, grid: Grid = SQUARES): TrapInput {
  const input = newTrapInput({ grid, id, sceneId, start: trap.preset, band, zone: trap.zone, chunks });
  const rig: TrapRig = { ...input.rig };
  if (trap.hits) rig.hits = { cells: trap.hits.map((r) => ({ ...r })) };
  if (trap.cone) {
    const hits = rig.hits;
    if (typeof hits !== "object" || !("area" in hits)) throw new Error(`${trap.preset} has no cone to place`);
    const [x, y] = trap.cone.origin;
    // The ground under the cone's origin: its square's, or on hexes the hex's that holds it.
    const at = grid.shape === "hex" ? hexAt(grid, { x, y }) : { col: Math.floor(x), row: Math.floor(y) };
    rig.hits = { area: { ...hits.area, origin: { x, y, z: groundAt(chunks, sceneId, at.col, at.row) }, yaw: trap.cone.yaw } };
    // The preset's note tells the DM to place the cone, which the generator just did.
    if (rig.note) rig.note = rig.note.replace(PLACE_THE_CONE, "");
  }
  if (trap.stone !== undefined) rig.actions = [...rig.actions, { show: { tokenId: stonePlaceholder(trap.stone) } }];
  return { ...input, rig };
}

/**
 * One `trap.create` per planned trap, each the SRD preset at the party's
 * level, read from the scratch room's chunks so a pit's floor sits under
 * the ground the build ops left there. Each starts armed and unfound, so
 * no player gets it until it is found, and each follows the stone it shows.
 */
export function trapOps(plan: DungeonPlan, chunks: Readonly<Record<string, BuildChunk>>, band: LevelBand, sceneId: string): ClientOp[] {
  const grid = gridOfShape(plan.grid === "hexRows" || plan.grid === "hexColumns" ? plan.grid : undefined);
  return plan.traps.map((trap, i) => ({ t: "trap.create", trap: trapInputOf(trap, trapPlaceholder(i), chunks, band, sceneId, grid) }));
}

/**
 * The ops with every id fresh: the scene's, each free wall's, stamp's,
 * light's, token's and trap's, the key page's and each of its blocks', and
 * each pin's. A trap's show action, a Poisoned Needle's leaf and a pin's
 * page follow their targets. Every op must name the one scene the first op
 * makes, since an op naming any other would land on a scene the DM never
 * meant, and a reference must name an id made before it here, as the
 * server would refuse one it cannot find. `ids` maps each placeholder to
 * its fresh id, so the outcome's check follows a reference through it
 * (phase 2, section 6). A block's id is 12 characters, unique in its page,
 * as the journal's own are, and a free wall's is a free wall id
 * (builder/hexBuild.ts `newWallId`).
 */
export function withIds(
  ops: ClientOp[],
  newId: () => string,
  newBlock: () => string = () => newBlockId(),
  newWall: () => string = newWallId,
): { ops: ClientOp[]; sceneId: string; ids: ReadonlyMap<string, string> } {
  const create = ops[0];
  if (create?.t !== "scene.create") throw new Error("a dungeon's ops start with its scene");
  const sceneId = newId();
  return { ...freshIds(ops, { was: create.scene.id, now: sceneId, made: true }, newId, newBlock, newWall), sceneId };
}

/**
 * A wing's ops with every id fresh as `withIds` makes a dungeon's, on the
 * scene it joins (phase 3, 3.5): no op makes a scene, and every op must
 * name the scene the worker planned it on, which Make sends to `sceneId`.
 * A removal names a standing wall, the join's, and keeps its id.
 */
export function wingIds(
  ops: ClientOp[],
  planned: string,
  sceneId: string,
  newId: () => string,
  newBlock: () => string = () => newBlockId(),
  newWall: () => string = newWallId,
): { ops: ClientOp[]; sceneId: string; ids: ReadonlyMap<string, string> } {
  return { ...freshIds(ops, { was: planned, now: sceneId, made: false }, newId, newBlock, newWall), sceneId };
}

function freshIds(
  ops: ClientOp[],
  scene: { was: string; now: string; made: boolean },
  newId: () => string,
  newBlock: () => string,
  newWall: () => string,
): { ops: ClientOp[]; ids: ReadonlyMap<string, string> } {
  const { was, now: sceneId } = scene;
  const ids = new Map<string, string>(scene.made ? [[was, sceneId]] : []);
  const fresh = (placeholder: string, make: () => string = newId): string => {
    if (ids.has(placeholder)) throw new Error(`a dungeon makes ${placeholder} twice`);
    const id = make();
    ids.set(placeholder, id);
    return id;
  };
  const made = (placeholder: string): string => {
    const id = ids.get(placeholder);
    if (id === undefined || placeholder === was) throw new Error(`a dungeon op names ${placeholder}, which it has not made`);
    return id;
  };
  const onScene = (id: string): string => {
    if (id !== was) throw new Error("a dungeon op names another scene");
    return sceneId;
  };
  const out = ops.map((op, i): ClientOp => {
    switch (op.t) {
      case "scene.create":
        if (!scene.made) throw new Error("a wing makes no scene");
        if (i !== 0) throw new Error("a dungeon makes one scene");
        return { ...op, scene: { ...op.scene, id: sceneId } };
      case "build.paint":
      case "build.edge":
      case "build.height":
      case "build.stairs":
      case "build.rough":
        return { ...op, sceneId: onScene(op.sceneId) };
      case "build.walls":
        if (op.remove !== undefined && scene.made) throw new Error("a dungeon removes no wall");
        return { ...op, sceneId: onScene(op.sceneId), put: (op.put ?? []).map((w) => ({ ...w, id: fresh(w.id, newWall) })) };
      case "build.stamps":
        if (op.remove !== undefined) throw new Error("a dungeon removes no stamp");
        return { ...op, sceneId: onScene(op.sceneId), put: (op.put ?? []).map((s) => ({ ...s, id: fresh(s.id) })) };
      case "build.lights":
        if (op.remove !== undefined) throw new Error("a dungeon removes no light");
        return { ...op, sceneId: onScene(op.sceneId), put: (op.put ?? []).map((l) => ({ ...l, id: fresh(l.id) })) };
      case "token.create":
        return { ...op, token: { ...op.token, id: fresh(op.token.id), sceneId: onScene(op.token.sceneId) } };
      case "trap.create": {
        const actions = op.trap.rig.actions.map((a) => {
          if ("show" in a && "tokenId" in a.show) return { show: { tokenId: made(a.show.tokenId) } };
          throw new Error("a dungeon's trap only shows a token it made");
        });
        const zone = op.trap.zone;
        // A Poisoned Needle on a hex door names its leaf by chunk and id (phase 3, 2.4), which Make gave a fresh one.
        const z = "door" in zone && "id" in zone.door ? { door: { ...zone.door, id: made(zone.door.id) } } : zone;
        return { ...op, trap: { ...op.trap, id: fresh(op.trap.id), sceneId: onScene(op.trap.sceneId), zone: z, rig: { ...op.trap.rig, actions } } };
      }
      case "journal.create": {
        const taken = new Set<string>();
        const blocks = op.page.blocks.map((b) => {
          let id = newBlock();
          while (taken.has(id)) id = newBlock();
          taken.add(id);
          if (ids.has(b.id)) throw new Error(`a dungeon makes ${b.id} twice`);
          ids.set(b.id, id);
          return { ...b, id };
        });
        return { ...op, page: { ...op.page, id: fresh(op.page.id), blocks } };
      }
      case "pin.put": {
        const { pageId, ...pin } = op.pin;
        return { ...op, pin: { ...pin, id: fresh(pin.id), sceneId: onScene(pin.sceneId), ...(pageId !== undefined ? { pageId: made(pageId) } : {}) } };
      }
      default:
        throw new Error(`a dungeon sends no ${op.t}`);
    }
  });
  return { ops: out, ids };
}
