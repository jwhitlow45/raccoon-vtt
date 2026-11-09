import { sightOf } from "../keys.ts";
import { LIMITS } from "../limits.ts";
import type { RoomState, Scene, SceneId, Token, Viewer } from "../model.ts";
import type { ProjectOpts } from "../project.ts";
import { ownEntry } from "../records.ts";
import { isWritable } from "../writable.ts";

/*
 * Several floors in one scene (docs/design/design-v1-floors.md): a floor is a
 * scene record linked into its scene by `Scene.floor`. Each rule that used
 * to ask "the players' scene" asks one of the questions here (8.3), and on
 * a scene without `floor` each gives exactly the answer it gave before.
 *
 * Every question works on the server's state and on a device's projected
 * copy (one that holds `sight`). A DM's copy holds every floor with its
 * `floor.of`, so it reads by the rule. A player's copy holds only the
 * floors the player holds, without `of`, so there a floor with `floor` but
 * no `of` is "a delivered floor", all the copy knows.
 */

/** A scene's floors, bottom first: the scene alone when it has no `floor`, none when it is gone. */
export function floorsOf(state: Pick<RoomState, "scenes">, sceneId: SceneId): Scene[] {
  const scene = ownEntry(state.scenes, sceneId);
  if (scene === undefined) return [];
  if (scene.floor === undefined) return [scene];
  return groupsOf(state.scenes).get(groupKey(scene)) ?? [scene];
}

/**
 * The floors a `scene.delete` takes (D-261102-493): a main floor takes every
 * floor of its scene, any other floor only itself, and a scene without
 * floors itself. Bottom first.
 */
export function deleteSet(state: Pick<RoomState, "scenes">, scene: Scene): Scene[] {
  if (scene.floor === undefined || scene.floor.of !== scene.id) return [scene];
  return floorsOf(state, scene.id);
}

/**
 * The main floor's id: the floor that holds the scene's place, folder and
 * thumbnail, the scene's own id on a scene without floors. A player's copy
 * lacks `floor.of`, so there every floor reads as its own main floor: a
 * player's device never learns another floor's id (D-261107-288).
 */
export function mainFloorId(state: Pick<RoomState, "scenes">, sceneId: SceneId): SceneId {
  return ownEntry(state.scenes, sceneId)?.floor?.of ?? sceneId;
}

/** Whether the two ids name floors of one scene, the same floor included. On a player's copy, any two delivered floors. */
export function sameScene(state: Pick<RoomState, "scenes">, a: SceneId, b: SceneId): boolean {
  if (a === b) return true;
  const one = ownEntry(state.scenes, a)?.floor;
  const two = ownEntry(state.scenes, b)?.floor;
  return one !== undefined && two !== undefined && one.of === two.of;
}

/** The start floor: the floor players start on, `meta.playerSceneId`. */
export function startFloor(state: Pick<RoomState, "meta">): SceneId | null {
  return state.meta.playerSceneId;
}

/** Whether the floor lies in the players' scene: the start floor or another floor of its scene. */
export function onPlayersScene(state: Pick<RoomState, "meta" | "scenes">, sceneId: SceneId): boolean {
  const start = startFloor(state);
  if (start === null) return false;
  return sameScene(state, start, sceneId);
}

/**
 * Whether players have reached the floor, whatever a blackout hides: a
 * floor of the players' scene that is the start floor, has an unhidden
 * party member on it, or carries an opened mark (Show, or reached before).
 * On a scene without floors, the players' scene.
 */
export function openFloor(state: RoomState, sceneId: SceneId): boolean {
  if (!onPlayersScene(state, sceneId)) return false;
  const floor = ownEntry(state.scenes, sceneId)?.floor;
  if (floor === undefined || floor.of === undefined) return true;
  if (sceneId === startFloor(state) || ownEntry(state.openFloors, sceneId) !== undefined) return true;
  return partyFloorsOf(state).has(sceneId);
}

/** Whether players see the floor now: an open floor, and none behind a blackout. */
export function playersSee(state: RoomState, sceneId: SceneId): boolean {
  return state.meta.view?.blackout !== true && openFloor(state, sceneId);
}

/**
 * Whether no player sees the floor now, so no creature on it counts as
 * seen by every player (8.3): a floor of a scene with floors that players
 * do not see. On a scene without floors never. The server's state and a
 * DM's copy hold the opened marks and read it by the rule. A player's copy
 * holds neither the marks nor `of`, so there the projection says it of a
 * floor they hold only through a creature the DM hid (`unseen`), and the
 * device agrees with the server on what every player sees
 * (FLRBUILD-PRIV-03).
 */
export function unseenFloor(state: RoomState, sceneId: SceneId): boolean {
  const floor = ownEntry(state.scenes, sceneId)?.floor;
  if (floor === undefined) return false;
  return floor.of === undefined ? floor.unseen === true : !playersSee(state, sceneId);
}

/**
 * The floors a viewer holds (8, 8.3): what a projection covers and what
 * access checks read. A DM holds every floor of the scene they view. A
 * player holds none behind a blackout, else the open floors of the
 * players' scene and the floors there where a creature they own stands,
 * hidden or not. A table display owns nothing, so it holds the open
 * floors. On a projected copy, the delivered floors: a player's scene
 * records are exactly their held floors, and a DM's the floors of the
 * scene it projects.
 */
export function heldFloors(state: RoomState, viewer: Viewer, opts: ProjectOpts): ReadonlySet<SceneId> {
  if (viewer.role === "player" && sightOf(state) !== undefined) return new Set(Object.keys(state.scenes));
  const plain = plainHeld(state, viewer, opts);
  if (plain !== undefined) return plain;
  // A floor's answer reads the tokens, so it is kept for each finished state, under what a test may still set in place.
  const key = `${viewer.role}\u0000${viewer.memberId}\u0000${opts.sceneId ?? ""}\u0000${state.meta.playerSceneId ?? ""}\u0000${state.meta.view?.blackout === true}`;
  const cache = finished(state) ? heldCache(state) : undefined;
  const known = cache?.get(key);
  if (known !== undefined) return known;
  const held = new Set(heldNow(state, viewer, opts));
  cache?.set(key, held);
  return held;
}

/**
 * Whether a viewer who holds `held` holds a record that names `sceneId` and
 * outlives a move of the players, as an ask for saves does
 * (docs/design/design-v1-player-save-spell.md 5.5): on a floor of a scene
 * with floors only while they hold that floor, since a floor not held sends
 * nothing, its id included (8, FLRBUILD-PRIV-01). Anything else keeps the
 * rule from before floors, which follows its player to another scene
 * (SSB-A-03): a scene without floors, and an id naming no scene, as ops
 * stored before own-key reads may (opVersion40.differential.test.ts). An
 * ask goes when its floor stops being one, removed or made a plain scene,
 * however that happens (reducer/floors.ts dropFloorAsks), so no ask names a
 * floor that is gone, or a former floor as a scene without floors.
 */
export function holdsRecordOn(state: Pick<RoomState, "scenes">, held: ReadonlySet<SceneId>, sceneId: SceneId): boolean {
  return ownEntry(state.scenes, sceneId)?.floor === undefined || held.has(sceneId);
}

const NONE: ReadonlySet<SceneId> = new Set();

/** The held set where the scene in question has no floors, the one scene as before floors, or undefined where it has floors. */
function plainHeld(state: RoomState, viewer: Viewer, opts: ProjectOpts): ReadonlySet<SceneId> | undefined {
  const sceneId = viewer.role === "dm" ? opts.sceneId : state.meta.view?.blackout === true ? null : startFloor(state);
  if (sceneId === null) return NONE;
  const scene = ownEntry(state.scenes, sceneId);
  if (scene === undefined) return NONE;
  return scene.floor === undefined ? new Set([sceneId]) : undefined;
}

function heldNow(state: RoomState, viewer: Viewer, opts: ProjectOpts): SceneId[] {
  if (viewer.role === "dm") return opts.sceneId === null ? [] : floorsOf(state, opts.sceneId).map((s) => s.id);
  // plainHeld answered a blackout and a room without a start floor already.
  const floors = floorsOf(state, startFloor(state)!);
  const here = new Set(floors.map((floor) => floor.id));
  const owned = new Set<SceneId>();
  for (const token of Object.values(state.tokens)) if (here.has(token.sceneId) && ownedBy(state, viewer.memberId, token)) owned.add(token.sceneId);
  return floors.filter((floor) => owned.has(floor.id) || openFloor(state, floor.id)).map((floor) => floor.id);
}

/** Words for a refusal that names a scene's floors (docs/design/design-v1-floors.md 7.1, 9). */
export const FLOOR_WORDS = {
  sameName: (scene: string, floor: string) => `${scene} already has a floor named ${floor}.`,
  tooMany: (scene: string) => `${scene} already has ${LIMITS.floorsPerScene} floors, the most a scene can have.`,
  oneShape: (scene: string) => `Floors share one grid shape, so it can't change while ${scene} has more than one floor.`,
  broken: (scene: string) => `${scene}'s floors don't fit together any more.`,
} as const;

/**
 * The first floor invariant the floor's scene breaks, in the DM's words, or
 * null (9, D-261107-221): the floors share a grid shape, their levels run 0
 * to n - 1, their names are unique, there are at most
 * LIMITS.floorsPerScene, `of` names a main floor whose `of` is itself, a
 * lone scene has no `floor`, and opened marks lie on floors of scenes with
 * floors. Run on the server's own state only, in the actor beside the
 * limits and on import, never in the reducer, so a device's replay on its
 * copy never meets it. A gone `sceneId` checks the floors and marks that
 * still name it.
 */
export function floorProblem(state: RoomState, sceneId: SceneId): string | null {
  const scene = ownEntry(state.scenes, sceneId);
  const main = scene?.floor?.of ?? sceneId;
  const group = Object.values(state.scenes).filter((s) => s.id === main || s.floor?.of === main || (scene !== undefined && s.id === scene.id));
  const named = ownEntry(state.scenes, main) ?? scene ?? group[0];
  const name = named?.name ?? "This scene";
  const floors = group.filter((s) => s.floor !== undefined);
  for (const id of [sceneId, ...group.map((s) => s.id)]) {
    if (ownEntry(state.openFloors, id) !== undefined && ownEntry(state.scenes, id)?.floor === undefined) return FLOOR_WORDS.broken(name);
  }
  if (floors.length === 0) return null;
  const mainScene = ownEntry(state.scenes, main);
  if (mainScene?.floor?.of !== main || floors.length !== group.length || floors.length < 2) return FLOOR_WORDS.broken(name);
  if (floors.length > LIMITS.floorsPerScene) return FLOOR_WORDS.tooMany(name);
  if (new Set(floors.map(shapeOf)).size > 1) return FLOOR_WORDS.oneShape(name);
  const levels = floors.map((s) => s.floor?.level).sort((a, b) => (a ?? -1) - (b ?? -1));
  if (levels.some((level, i) => level !== i)) return FLOOR_WORDS.broken(name);
  const seen = new Set<string>();
  for (const floor of floors) {
    const own = floor.floor?.name ?? "";
    if (seen.has(own)) return FLOOR_WORDS.sameName(name, own);
    seen.add(own);
    if (floor.name !== mainScene.name) return FLOOR_WORDS.broken(name);
  }
  return null;
}

function shapeOf(scene: Pick<Scene, "gridShape">): string {
  return scene.gridShape ?? "squares";
}

/** The key a floor's group is filed under: its main floor's id, or on a player's copy one key for every delivered floor. */
function groupKey(scene: Scene): string {
  return scene.floor?.of ?? "\u0000delivered";
}

const groupCache = new WeakMap<object, Map<string, Scene[]>>();

/** Every scene's floors by groupKey, bottom first, worked out once for each finished record of scenes. */
function groupsOf(scenes: Readonly<Record<SceneId, Scene>>): Map<string, Scene[]> {
  const known = isWritable(scenes) ? undefined : groupCache.get(scenes);
  if (known !== undefined) return known;
  const groups = new Map<string, Scene[]>();
  for (const scene of Object.values(scenes)) {
    if (scene.floor === undefined) continue;
    const key = groupKey(scene);
    const list = groups.get(key);
    if (list) list.push(scene);
    else groups.set(key, [scene]);
  }
  for (const list of groups.values()) list.sort((a, b) => (a.floor?.level ?? 0) - (b.floor?.level ?? 0) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  if (!isWritable(scenes)) groupCache.set(scenes, groups);
  return groups;
}

const partyCache = new WeakMap<object, ReadonlySet<SceneId>>();

/** The floors an unhidden party member stands on, worked out once for each finished state. */
function partyFloorsOf(state: RoomState): ReadonlySet<SceneId> {
  const keep = finished(state);
  const known = keep ? partyCache.get(state) : undefined;
  if (known !== undefined) return known;
  const floors = new Set<SceneId>();
  for (const token of Object.values(state.tokens)) if (unhiddenPartyMember(state, token)) floors.add(token.sceneId);
  if (keep) partyCache.set(state, floors);
  return floors;
}

/*
 * The two ownership rules below are project.ts's `isPartyMember` and
 * `ownsToken`, restated here so the limits, which sight's arithmetic check
 * reads with everything they import (segments.test.ts), can ask these
 * questions without importing the projection. floors.test.ts holds them
 * to project.ts's over random rooms.
 */

/** A party member the DM has not hidden: only such a creature opens a floor (D-261102-482). */
export function unhiddenPartyMember(state: Pick<RoomState, "characters">, token: Token): boolean {
  if (token.visibility === "dm") return false;
  if (token.partyVision === true || (token.ownerIds?.length ?? 0) > 0) return true;
  const character = "ref" in token.actor ? ownEntry(state.characters, token.actor.ref) : undefined;
  return character !== undefined && (character.ownerIds?.length ?? 0) > 0;
}

/** Whether the member owns the token, directly or through its character. A record without owners, as older fixtures hold, has none. */
export function ownedBy(state: Pick<RoomState, "characters">, memberId: string, token: Token): boolean {
  if (token.ownerIds?.includes(memberId) === true) return true;
  const character = "ref" in token.actor ? ownEntry(state.characters, token.actor.ref) : undefined;
  return character?.ownerIds?.includes(memberId) === true;
}

/**
 * Whether no transaction writes into the state or a collection these
 * answers read any more (writable.ts), so an answer kept for it holds. A
 * room spread from a transaction's state shares its collections, so they
 * are asked too.
 */
function finished(state: RoomState): boolean {
  return !isWritable(state) && !isWritable(state.scenes) && !isWritable(state.tokens) && !isWritable(state.characters) && !isWritable(state.openFloors) && !isWritable(state.meta);
}

const heldCaches = new WeakMap<object, Map<string, ReadonlySet<SceneId>>>();

function heldCache(state: RoomState): Map<string, ReadonlySet<SceneId>> {
  let cache = heldCaches.get(state);
  if (cache === undefined) heldCaches.set(state, (cache = new Map()));
  return cache;
}
