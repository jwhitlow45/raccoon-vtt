import { keys, sightOf } from "../keys.ts";
import { LIMITS } from "../limits.ts";
import type { RoomState, Scene } from "../model.ts";
import { FLOOR_HEIGHT, type OpOf } from "../protocol.ts";
import { FLOOR_WORDS, floorsOf, startFloor, unhiddenPartyMember } from "../rules/floors.ts";
import { ownEntry } from "../records.ts";
import { invalid, type Tx } from "./tx.ts";

/*
 * The floor ops (docs/design/design-v1-floors.md 9): adding a floor beside
 * another, the order of a scene's floors, Show and Hide, and the opened
 * marks. Renaming and removing floors ride `scene.update` and
 * `scene.delete` (reducer/room.ts).
 */

/** The name the scene's first floor takes at its first add, unless the add names it. */
export const GROUND_FLOOR = "Ground floor";
/** The name a new floor takes, numbered from 2 while it is taken, so consecutive and concurrent adds never clash. */
export const NEW_FLOOR = "New floor";

/** The refusal of a floor op on a scene with one floor. */
export const ONE_FLOOR = "this scene has one floor";

/** The first of "New floor", "New floor 2", "New floor 3" and on that no floor of the scene has. */
export function freeFloorName(taken: ReadonlySet<string>): string {
  if (!taken.has(NEW_FLOOR)) return NEW_FLOOR;
  for (let n = 2; ; n++) {
    const name = `${NEW_FLOOR} ${n}`;
    if (!taken.has(name)) return name;
  }
}

/**
 * A new floor's settings, copied from the floor beside it
 * (docs/design/design-v1-floors.md 6, D-261102-483, D-261107-211): its size,
 * background, grid lines' look and shape, what players see with the light
 * (Time of day included) and Sight, walls block moves, automatic walls and
 * the suggested view. No map, phases, build, fog, contents, weather or
 * scene sound, and the folder and thumbnail stay the main floor's. It
 * carries the main floor's order, as every floor does.
 */
export function newFloorFrom(beside: Scene, id: string, name: string, main: Pick<Scene, "id" | "order">): Scene {
  const scene: Scene = {
    id,
    rev: 0,
    name: beside.name,
    order: main.order,
    bounds: beside.bounds,
    grid: beside.grid,
    background: beside.background,
    fogEnabled: beside.fogEnabled,
    wallsVersion: 0,
    floor: { of: main.id, level: 0, name, height: FLOOR_HEIGHT.initial },
  };
  if (beside.vision !== undefined) scene.vision = beside.vision;
  if (beside.blockMovement !== undefined) scene.blockMovement = beside.blockMovement;
  if (beside.autoWalls !== undefined) scene.autoWalls = beside.autoWalls;
  if (beside.gridShape !== undefined) scene.gridShape = beside.gridShape;
  if (beside.suggestedView !== undefined) scene.suggestedView = beside.suggestedView;
  return scene;
}

/**
 * Add a floor (`scene.create` with `floor`): the new floor goes just above
 * or below the one beside, every floor's level is renumbered, and on the
 * scene's first add the floor beside becomes the main floor, named by the
 * op or "Ground floor".
 */
export function floorAdd(tx: Tx, op: OpOf<"scene.create">): void {
  const add = op.floor;
  if (add === undefined) return;
  if (ownEntry(tx.state.scenes, op.scene.id)) throw invalid("scene already exists");
  const beside = tx.scene(add.beside);
  const group = floorsOf(tx.state, beside.id);
  const main = beside.floor?.of === undefined ? beside : tx.scene(beside.floor.of);
  if (group.length >= LIMITS.floorsPerScene) throw invalid(FLOOR_WORDS.tooMany(main.name));
  const named: Scene = beside.floor ? beside : { ...beside, floor: { of: beside.id, level: 0, name: add.besideName ?? GROUND_FLOOR, height: FLOOR_HEIGHT.initial } };
  const floors = group.map((s) => (s.id === beside.id ? named : s));
  const fresh = newFloorFrom(named, op.scene.id, freeFloorName(new Set(floors.map((s) => s.floor?.name ?? ""))), main);
  floors.splice(floors.indexOf(named) + (add.side === "above" ? 1 : 0), 0, fresh);
  writeLevels(tx, floors, new Set([named.id, fresh.id]));
}

/** Writes each floor whose level is not its place in `floors`, bottom first, and every floor `always` names. */
function writeLevels(tx: Tx, floors: readonly Scene[], always: ReadonlySet<string> = new Set()): void {
  floors.forEach((scene, level) => {
    const floor = scene.floor;
    if (floor === undefined) throw invalid(ONE_FLOOR);
    if (floor.level !== level || always.has(scene.id)) tx.write(keys.scene(scene.id), { ...scene, floor: { ...floor, level } });
  });
}

/** Reorders a scene's floors (`floor.order`): every floor of the scene once, bottom first. */
export function floorOrder(tx: Tx, op: OpOf<"floor.order">): void {
  const scene = tx.scene(op.sceneId);
  if (scene.floor === undefined) throw invalid(ONE_FLOOR);
  const group = floorsOf(tx.state, scene.id);
  const ids = new Set(group.map((s) => s.id));
  if (op.floors.length !== group.length || !op.floors.every((id) => ids.has(id))) throw invalid("list every floor of the scene once");
  writeLevels(
    tx,
    op.floors.map((id) => tx.scene(id)),
  );
}

/** Shows a floor to players or hides it (`floor.open`): its opened mark, an ordinary write in the op's undo step. */
export function floorOpen(tx: Tx, op: OpOf<"floor.open">): void {
  const scene = tx.scene(op.sceneId);
  if (scene.floor === undefined) throw invalid(ONE_FLOOR);
  const mark = ownEntry(tx.state.openFloors, scene.id);
  if (op.open && mark === undefined) tx.write(keys.opened(scene.id), { sceneId: scene.id, rev: 0 });
  else if (!op.open && mark !== undefined) tx.remove(keys.opened(scene.id));
}

/**
 * The opened marks (9, D-261102-482), after every op's dispatch beside
 * `markPlayed`, as bookkeeping outside undo: on the players' scene, when it
 * has floors, the start floor and each floor where an unhidden party
 * member stands, every floor of it marked played too, and then no opened
 * mark on a scene that is gone or has no `floor`, so an undo that takes a
 * scene's floors away leaves no stray mark. Nothing on a projected copy,
 * which lacks what it reads: only the server marks.
 */
export function markOpened(tx: Tx, _before: RoomState): void {
  const s = tx.state;
  if (sightOf(s) !== undefined) return;
  const start = startFloor(s);
  if (start !== null && ownEntry(s.scenes, start)?.floor !== undefined) {
    const floors = floorsOf(s, start);
    const here = new Set(floors.map((f) => f.id));
    const party = new Set<string>();
    for (const token of Object.values(s.tokens)) if (here.has(token.sceneId) && unhiddenPartyMember(s, token)) party.add(token.sceneId);
    for (const floor of floors) {
      if ((floor.id === start || party.has(floor.id)) && ownEntry(tx.state.openFloors, floor.id) === undefined) {
        tx.writeBookkeeping(keys.opened(floor.id), { sceneId: floor.id, rev: 0 });
      }
      if (ownEntry(tx.state.playedScenes, floor.id) === undefined) tx.writeBookkeeping(keys.played(floor.id), { sceneId: floor.id, rev: 0 });
    }
  }
  for (const id of Object.keys(tx.state.openFloors ?? {}).sort()) {
    if (ownEntry(tx.state.scenes, id)?.floor === undefined) tx.writeBookkeeping(keys.opened(id), null);
  }
}

/**
 * The asks for saves on a floor that stopped being one in this op, after
 * every op's dispatch beside `markOpened`: a floor removed, by Remove,
 * Delete or a restore such as the undo of its add, and a record that lost
 * its `floor`, as the floor left alone by a removal and the main floor
 * after the undo of a scene's first add. An ask names its floor, which a
 * player who never held it must never learn (rules/floors.ts holdsRecordOn),
 * and a scene without floors sends its asks wherever their players went, so
 * each goes, as an ordinary write in the op's undo step, and the undo brings
 * it back with the floor (FLRBUILD-ASTRA-07, FLRBUILD-PRIV-04, FLRB-OPUS-09,
 * D-261108-426). Asks made before a first add go with its undo too, and come
 * back with its redo.
 */
export function dropFloorAsks(tx: Tx, before: RoomState): void {
  const gone = new Set<string>();
  for (const key of tx.touched()) {
    if (!key.startsWith("scene:")) continue;
    const id = key.slice("scene:".length);
    if (ownEntry(before.scenes, id)?.floor !== undefined && ownEntry(tx.state.scenes, id)?.floor === undefined) gone.add(id);
  }
  if (gone.size === 0) return;
  for (const ask of Object.values(tx.state.casts).sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))) {
    if (gone.has(ask.sceneId)) tx.remove(keys.cast(ask.id));
  }
}

/**
 * What a removal of one floor leaves (`scene.delete` of a floor other than
 * the main one): the floors left renumbered, and a last floor a plain scene
 * again, its `floor` and its opened mark gone with ordinary writes inside
 * the undo step, so the undo puts both back (FLR-OPUS-33, OPUS-39). Its
 * played mark stays.
 */
export function afterRemoval(tx: Tx, mainId: string): void {
  const left = floorsOf(tx.state, mainId);
  if (left.length === 1 && left[0]!.floor !== undefined) {
    const { floor: _floor, ...plain } = left[0]!;
    tx.write(keys.scene(plain.id), plain);
    if (ownEntry(tx.state.openFloors, plain.id) !== undefined) tx.remove(keys.opened(plain.id));
    return;
  }
  writeLevels(tx, left);
}
