import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { keys } from "../keys.ts";
import type { RoomState, Scene, Viewer } from "../model.ts";
import { opSchema, type Op, type RestoreEntry } from "../protocol.ts";
import { applyOp, type Applied } from "../reducer.ts";
import { floorProblem, floorsOf } from "../rules/floors.ts";
import { DM, actor, character, entry, env, room, scene, token } from "../testutil.ts";
import { GROUND_FLOOR, NEW_FLOOR, freeFloorName } from "./floors.ts";

/*
 * The floors reducer (docs/design/design-v1-floors.md 6, 7.1, 9): adds, the
 * copy rule, names, levels, Show and Hide, removals and deletes, Duplicate,
 * the Scenes order and the opened marks, each with its undo.
 */

const DM2: Viewer = { memberId: "dm2", role: "dm" };
let seq = 1;
function applied(state: RoomState, op: Op, who: Viewer = DM): Applied {
  const r = applyOp(state, opSchema.parse(op), who, env(seq++));
  assert.ok(r.ok, `${op.t}: ${r.ok ? "" : `${r.code}: ${r.message}`}`);
  return r;
}
const run = (state: RoomState, op: Op, who: Viewer = DM) => applied(state, op, who).state;
function refusal(state: RoomState, op: Op, who: Viewer = DM): string {
  const r = applyOp(state, opSchema.parse(op), who, env(seq++));
  assert.ok(!r.ok, `${op.t} should be refused`);
  return r.message;
}
function undo(state: RoomState, entries: readonly RestoreEntry[] | null): RoomState {
  return run(state, { t: "sys.restore", entries: [...(entries ?? [])], from: "undo" });
}

const add = (id: string, beside: string, side: "above" | "below" = "above", besideName?: string): Op => ({
  t: "scene.create",
  scene: { id, name: "Tower", bounds: { w: 10, h: 10 } },
  floor: { beside, side, ...(besideName ? { besideName } : {}) },
});
const names = (state: RoomState, id: string) => floorsOf(state, id).map((s) => s.floor?.name);
const ids = (state: RoomState, id: string) => floorsOf(state, id).map((s) => s.id);
const marked = (state: RoomState) => Object.keys(state.openFloors ?? {}).sort();
const tower = (over: Partial<Scene> = {}) => scene("s1", { name: "Tower", ...over });

function towerOf(n: number, base: RoomState = room({ scenes: { s1: tower(), s2: scene("s2", { order: 1 }) } })): RoomState {
  let state = base;
  for (let i = 2; i <= n; i++) state = run(state, add(`f${i}`, i === 2 ? "s1" : `f${i - 1}`));
  return state;
}

describe("adding floors (7.1, 9)", () => {
  test("the first add above names the floor beside Ground floor, then New floor and New floor 2, bottom first", () => {
    const one = run(room({ scenes: { s1: tower() } }), add("up", "s1"));
    assert.deepEqual(one.scenes.s1!.floor, { of: "s1", level: 0, name: GROUND_FLOOR, height: 10 });
    assert.deepEqual(one.scenes.up!.floor, { of: "s1", level: 1, name: NEW_FLOOR, height: 10 });
    const two = run(one, add("up2", "up"));
    assert.deepEqual(names(two, "s1"), [GROUND_FLOOR, NEW_FLOOR, "New floor 2"]);
    assert.deepEqual(ids(two, "up2"), ["s1", "up", "up2"]);
    assert.equal(floorProblem(two, "s1"), null);
  });

  test("two DMs adding at once both get a free name, whichever lands second", () => {
    const one = run(room({ scenes: { s1: tower() } }), add("a", "s1"), DM);
    const two = run(one, add("b", "s1"), DM2);
    assert.deepEqual(names(two, "s1"), [GROUND_FLOOR, "New floor 2", NEW_FLOOR], "b goes just above Ground, a above it");
    assert.equal(floorProblem(two, "s1"), null);
  });

  test("an add below goes under the floor beside and renumbers every level", () => {
    const state = run(run(room({ scenes: { s1: tower() } }), add("up", "s1")), add("cellar", "s1", "below"));
    assert.deepEqual(ids(state, "s1"), ["cellar", "s1", "up"]);
    assert.deepEqual(
      floorsOf(state, "s1").map((s) => s.floor?.level),
      [0, 1, 2],
    );
  });

  test("the first add may name the floor beside", () => {
    const state = run(room({ scenes: { s1: tower() } }), add("up", "s1", "above", "Hall"));
    assert.equal(state.scenes.s1!.floor?.name, "Hall");
  });

  test("a new floor copies the settings of the floor beside, and none of its map, weather, sound, folder or contents", () => {
    const roof = tower({
      bounds: { w: 30, h: 18 },
      background: "#112233",
      grid: { show: false, color: "#000000", opacity: 0.5, lineWidth: 2 },
      gridShape: "hexRows",
      fogEnabled: true,
      vision: { on: true, light: "dim", perPlayer: true, byClock: true },
      blockMovement: true,
      autoWalls: "floor",
      suggestedView: "isometric",
      defaultView: { x: 1, y: 1, zoom: 2 },
      weather: { kind: "rain", heavy: true, wind: "strong", toward: 90 },
      sound: { music: null, loops: [] },
      folder: "Act 1",
      thumb: "t1",
      order: 4,
      map: { assetId: "a1", widthPx: 700, heightPx: 700, cellPx: 70, originPx: { x: 0, y: 0 } },
    });
    const state = run(room({ scenes: { s1: roof, s2: scene("s2") }, tokens: { gob: token("gob", { sceneId: "s1" }) } }), add("up", "s1"));
    const up = state.scenes.up!;
    const { floor: _f, rev: _r, ...rest } = up;
    assert.deepEqual(rest, {
      id: "up",
      name: "Tower",
      order: 4,
      bounds: { w: 30, h: 18 },
      grid: roof.grid,
      background: "#112233",
      fogEnabled: true,
      wallsVersion: 0,
      vision: roof.vision,
      blockMovement: true,
      autoWalls: "floor",
      gridShape: "hexRows",
      suggestedView: "isometric",
    });
    assert.ok(!Object.values(state.tokens).some((t) => t.sceneId === "up"));
  });

  test("a ninth floor is refused in the DM's words", () => {
    const eight = towerOf(8);
    assert.equal(floorsOf(eight, "s1").length, 8);
    assert.equal(refusal(eight, add("f9", "f8")), "Tower already has 8 floors, the most a scene can have.");
  });

  test("freeFloorName skips every taken number", () => {
    assert.equal(freeFloorName(new Set()), NEW_FLOOR);
    assert.equal(freeFloorName(new Set([NEW_FLOOR, "New floor 2", "New floor 4"])), "New floor 3");
  });

  test("undoing the first add makes the scene plain again and leaves no stray mark, and its redo marks again", () => {
    const base = room({ scenes: { s1: tower(), s2: scene("s2", { order: 1 }) } });
    const added = applied(base, add("up", "s1"));
    assert.deepEqual(marked(added.state), ["s1"], "the start floor is marked once its scene has floors");
    const back = applied(added.state, { t: "sys.restore", entries: [...(added.inverse ?? [])], from: "undo" });
    assert.equal(back.state.scenes.s1!.floor, undefined);
    assert.equal(back.state.scenes.up, undefined);
    assert.deepEqual(marked(back.state), [], "no mark on a scene without floors");
    assert.equal(floorProblem(back.state, "s1"), null);
    const redo = run(back.state, { t: "sys.restore", entries: [...(back.inverse ?? [])], from: "redo" });
    assert.ok(redo.scenes.s1!.floor);
    assert.deepEqual(marked(redo), ["s1"]);
  });
});

describe("the opened marks (9, D-261102-482)", () => {
  test("an empty Ground the players started on stays reached after they move to Upper", () => {
    const state = run(run(room({ scenes: { s1: tower() } }), add("up", "s1")), { t: "room.setPlayerScene", sceneId: "up" });
    assert.deepEqual(marked(state), ["s1", "up"]);
  });

  test("a floor where an unhidden party member stands opens, and a hidden one opens nothing", () => {
    const base = run(room({ scenes: { s1: tower() }, characters: { c: character("c") } }), add("up", "s1"));
    const hidden = run(base, { t: "token.create", token: { id: "thorn", sceneId: "up", kind: "pc", name: "Thorn", size: "medium", x: 1, y: 1, actor: { ref: "c" }, visibility: "dm" } });
    assert.deepEqual(marked(hidden), ["s1"]);
    const shown = run(hidden, { t: "token.update", tokenId: "thorn", patch: { visibility: "all" } });
    assert.deepEqual(marked(shown), ["s1", "up"]);
  });

  test("every floor of the players' scene is marked played, and a prep scene's floors open nothing", () => {
    const state = run(run(room({ scenes: { s1: tower(), s2: scene("s2", { order: 1 }) } }), add("up", "s1")), add("s2up", "s2"));
    assert.ok(state.playedScenes?.up, "a floor added on the players' scene is played");
    assert.deepEqual(marked(state), ["s1"], "nothing on the prep scene");
  });

  test("Show and Hide write and take the mark in the op's undo step", () => {
    const base = run(room({ scenes: { s1: tower() } }), add("up", "s1"));
    const shown = applied(base, { t: "floor.open", sceneId: "up", open: true });
    assert.deepEqual(marked(shown.state), ["s1", "up"]);
    assert.ok(shown.inverse?.some((e) => e.key === keys.opened("up")), "Show is undoable");
    assert.deepEqual(marked(undo(shown.state, shown.inverse)), ["s1"]);
    assert.deepEqual(marked(run(shown.state, { t: "floor.open", sceneId: "up", open: false })), ["s1"]);
    assert.equal(refusal(room(), { t: "floor.open", sceneId: "s1", open: true }), "this scene has one floor");
  });

  test("an op stored before floors replays without the pass, and a live one marks", () => {
    const state = run(room({ scenes: { s1: tower() } }), add("up", "s1"));
    const unmarked: RoomState = { ...state, openFloors: {} };
    const op: Op = { t: "view.follow", follow: true };
    const old = applyOp(unmarked, op, DM, { ...env(seq++), opVersion: 55 });
    assert.ok(old.ok);
    assert.deepEqual(marked(old.state), []);
    assert.deepEqual(marked(run(unmarked, op)), ["s1"]);
  });
});

describe("floor.order (9)", () => {
  test("renumbers every floor, and an incomplete list is refused", () => {
    const state = towerOf(3);
    const moved = run(state, { t: "floor.order", sceneId: "s1", floors: ["f2", "s1", "f3"] });
    assert.deepEqual(ids(moved, "s1"), ["f2", "s1", "f3"]);
    assert.equal(floorProblem(moved, "s1"), null);
    assert.equal(refusal(state, { t: "floor.order", sceneId: "s1", floors: ["f2", "s1"] }), "list every floor of the scene once");
    assert.equal(refusal(state, { t: "floor.order", sceneId: "s1", floors: ["f2", "s1", "s2"] }), "list every floor of the scene once");
  });

  test("a level change is global, so every recipient re-projects", () => {
    assert.equal(applied(towerOf(3), { t: "floor.order", sceneId: "s1", floors: ["f2", "s1", "f3"] }).global, true);
  });
});

describe("renaming and settings (9)", () => {
  test("the scene's name renames every floor, and a floor's own name must be free", () => {
    const state = towerOf(3);
    const renamed = run(state, { t: "scene.update", sceneId: "f2", patch: { name: "Spire" } });
    assert.deepEqual(
      floorsOf(renamed, "s1").map((s) => s.name),
      ["Spire", "Spire", "Spire"],
    );
    assert.equal(run(state, { t: "scene.update", sceneId: "f2", patch: { floor: { name: "Attic", height: 25 } } }).scenes.f2!.floor?.name, "Attic");
    assert.equal(refusal(state, { t: "scene.update", sceneId: "f2", patch: { floor: { name: GROUND_FLOOR } } }), "Tower already has a floor named Ground floor.");
    assert.equal(refusal(room(), { t: "scene.update", sceneId: "s1", patch: { floor: { name: "Up" } } }), "this scene has one floor");
  });

  test("a grid shape change, and a folder or thumbnail on another floor than the main one, are refused", () => {
    const state = towerOf(2);
    assert.equal(refusal(state, { t: "scene.update", sceneId: "s1", patch: { gridShape: "hexRows" } }), "Floors share one grid shape, so it can't change while Tower has more than one floor.");
    assert.equal(refusal(state, { t: "scene.update", sceneId: "f2", patch: { folder: "Act 2" } }), "a scene's folder and thumbnail are its main floor's");
    assert.equal(run(state, { t: "scene.update", sceneId: "s1", patch: { folder: "Act 2" } }).scenes.s1!.folder, "Act 2");
  });

  test("reorder lists main floors and writes each one's order onto its floors", () => {
    const state = towerOf(2, room({ scenes: { s1: tower(), s2: scene("s2", { order: 1 }) } }));
    const moved = run(state, { t: "scene.reorder", order: ["s2", "s1"] });
    assert.deepEqual([moved.scenes.s2!.order, moved.scenes.s1!.order, moved.scenes.f2!.order], [0, 1, 1]);
    assert.equal(refusal(state, { t: "scene.reorder", order: ["s2", "f2"] }), "a scene with floors is listed by its main floor");
  });
});

describe("removing and deleting floors (7.1, 9, D-261102-493)", () => {
  test("a reached empty floor goes with its mark, the others renumber, and the players stay where they start", () => {
    let state = towerOf(3);
    state = run(state, { t: "floor.open", sceneId: "f2", open: true });
    const removed = applied(state, { t: "scene.delete", sceneId: "f2" });
    assert.deepEqual(ids(removed.state, "s1"), ["s1", "f3"]);
    assert.deepEqual(marked(removed.state), ["s1"]);
    assert.equal(removed.state.meta.playerSceneId, "s1");
    assert.equal(floorProblem(removed.state, "s1"), null);
    const back = undo(removed.state, removed.inverse);
    assert.deepEqual(ids(back, "s1"), ["s1", "f2", "f3"]);
    assert.deepEqual(marked(back), ["f2", "s1"]);
  });

  test("a removal that leaves one floor makes a plain scene, and its undo brings the floors and marks back", () => {
    let state = towerOf(2);
    state = run(state, { t: "token.create", token: { id: "gob", sceneId: "f2", kind: "monster", name: "Goblin", size: "small", x: 1, y: 1, actor: { inline: actor() } } } as Op);
    const removed = applied(state, { t: "scene.delete", sceneId: "f2" });
    assert.equal(removed.state.scenes.s1!.floor, undefined);
    assert.deepEqual(marked(removed.state), []);
    assert.equal(removed.state.tokens.gob, undefined, "everything on it goes");
    assert.ok(removed.state.playedScenes?.s1, "the played mark stays");
    const back = undo(removed.state, removed.inverse);
    assert.deepEqual(names(back, "s1"), [GROUND_FLOOR, NEW_FLOOR]);
    assert.deepEqual(marked(back), ["s1"]);
    assert.ok(back.tokens.gob);
    assert.equal(floorProblem(back, "s1"), null);
  });

  test("a delete of the main floor takes every floor, and one holding the start floor moves the players to a main floor", () => {
    const state = towerOf(3, room({ scenes: { s1: tower(), s2: scene("s2", { order: 1 }) } }));
    const upper = { ...state, meta: { ...state.meta, playerSceneId: "f3" } };
    const gone = run(upper, { t: "scene.delete", sceneId: "s1" });
    assert.deepEqual(Object.keys(gone.scenes), ["s2"]);
    assert.equal(gone.meta.playerSceneId, "s2");
    assert.deepEqual(marked(gone), []);
  });

  test("a delete that takes the start floor moves the players to a main floor, never another floor", () => {
    let state = towerOf(2);
    state = run(state, { t: "scene.update", sceneId: "s2", patch: { name: "Keep" } });
    state = run(state, add("k2", "s2"));
    // The Keep's upper floor first in the record, so only the rule picks its main floor.
    const { k2, ...rest } = state.scenes;
    const upper: RoomState = { ...state, scenes: { k2: k2!, ...rest }, meta: { ...state.meta, playerSceneId: "f2" } };
    assert.equal(run(upper, { t: "scene.delete", sceneId: "s1" }).meta.playerSceneId, "s2");
  });

  test("the last scene of a room stays", () => {
    assert.equal(refusal(towerOf(2, room({ scenes: { s1: tower() } })), { t: "scene.delete", sceneId: "s1" }), "a room needs at least one scene");
  });
});

describe("Duplicate (D-261102-494)", () => {
  test("copies every floor with its weather and scene sound and its contents, and no opened mark", () => {
    let state = towerOf(2);
    state = run(state, { t: "scene.update", sceneId: "f2", patch: { weather: { kind: "rain", heavy: true } } });
    state = run(state, { t: "token.create", token: { id: "gob", sceneId: "f2", kind: "monster", name: "Goblin", size: "small", x: 1, y: 1, actor: { inline: actor() } } } as Op);
    state = run(state, { t: "floor.open", sceneId: "f2", open: true });
    const copy = run(state, { t: "scene.duplicate", sceneId: "s1", newSceneId: "c1", name: "Tower copy", include: { creatures: true, characters: true, fog: false, drawings: false } });
    const floors = floorsOf(copy, "c1");
    assert.equal(floors.length, 2);
    assert.deepEqual(
      floors.map((s) => [s.floor?.of, s.floor?.name, s.name]),
      [
        ["c1", GROUND_FLOOR, "Tower copy"],
        ["c1", NEW_FLOOR, "Tower copy"],
      ],
    );
    assert.ok(floors[1]!.weather, "the upper floor's weather comes along");
    assert.ok(Object.values(copy.tokens).some((t) => t.sceneId === floors[1]!.id && t.name === "Goblin"));
    assert.deepEqual(marked(copy), marked(state), "no mark comes with the copy");
    assert.equal(floorProblem(copy, "c1"), null);
    assert.equal(refusal(state, { t: "scene.duplicate", sceneId: "f2", newSceneId: "c2", name: "x", include: { creatures: false, characters: false, fog: false, drawings: false } }), "a scene with floors is copied by its main floor");
  });
});

describe("Move to floor is a scene move (7.4, D-261108-093, D-261107-289)", () => {
  test("a nudged token lands without its nudge, a squeezed one unsqueezed, and the undo puts both back", () => {
    let state = towerOf(2);
    state = { ...state, tokens: { thorn: token("thorn", { sceneId: "s1", x: 3, y: 3, nudge: { x: 2, y: 2 } }), gob: token("gob", { sceneId: "s1", x: 6, y: 3, squeeze: true }) } };
    const moved = applied(state, { t: "token.update", tokenId: "thorn", patch: { sceneId: "f2" } });
    assert.equal(moved.state.tokens.thorn!.sceneId, "f2");
    assert.equal(moved.state.tokens.thorn!.nudge, undefined);
    assert.deepEqual(undo(moved.state, moved.inverse).tokens.thorn!.nudge, { x: 2, y: 2 });
    const squeezed = applied(state, { t: "token.update", tokenId: "gob", patch: { sceneId: "f2" } });
    assert.equal(squeezed.state.tokens.gob!.squeeze, undefined);
    assert.equal(undo(squeezed.state, squeezed.inverse).tokens.gob!.squeeze, true);
  });

  test("a horse's nudged rider keeps its nudge and the horse loses its own", () => {
    let state = towerOf(2);
    state = {
      ...state,
      tokens: {
        horse: token("horse", { name: "Warhorse", kind: "npc", size: "large", x: 4, y: 4, nudge: { x: 1, y: 1 } }),
        bree: token("bree", { name: "Bree", kind: "pc", ownerIds: ["p1"], x: 4, y: 4, nudge: { x: 2, y: 2 }, attached: { to: "horse", kind: "ride", steer: true } }),
      },
    };
    const moved = run(state, { t: "token.update", tokenId: "horse", patch: { sceneId: "f2" } });
    assert.equal(moved.tokens.bree!.sceneId, "f2");
    assert.equal(moved.tokens.horse!.nudge, undefined);
    assert.deepEqual(moved.tokens.bree!.nudge, { x: 2, y: 2 });
  });
});

describe("the players' sound follows their floor (D-261107-212)", () => {
  test("Move players here to Upper starts its sound, then to a floor with none keeps what plays", () => {
    let state = towerOf(3);
    state = { ...state, sounds: { wind: { id: "wind", rev: 0, name: "Wind", assetId: "a-wind", ms: 60_000, use: "loop" } } };
    state = run(state, { t: "scene.update", sceneId: "f2", patch: { sound: { music: null, loops: [{ soundId: "wind", volume: 70 }] } } });
    state = run(state, { t: "room.setPlayerScene", sceneId: "f2" });
    state = run(state, { t: "sound.scene", sceneId: "f2", onMove: true, order: [], run: "r1" });
    const playing = state.playing;
    assert.equal(Object.values(playing?.loops ?? {}).length, 1, "Upper's sound starts");
    state = run(state, { t: "room.setPlayerScene", sceneId: "f3" });
    state = run(state, { t: "sound.scene", sceneId: "f3", onMove: true, order: [], run: "r2" });
    assert.deepEqual(state.playing, playing, "a floor with no sound keeps what plays");
  });
});

describe("a character-only row's companions (8.3)", () => {
  test("Next clears them on every floor players reached, and not on one they have not", () => {
    let state = towerOf(3);
    const spirit = (id: string, sceneId: string, over = {}) => token(id, { sceneId, kind: "npc", ownerIds: ["p1"], companion: { of: "bree", turn: "shared", reactionUsed: true }, ...over });
    state = {
      ...state,
      characters: { bree: character("bree", { name: "Bree", ownerIds: ["p1"] }) },
      tokens: { gob: token("gob", { sceneId: "s1" }), up: spirit("up", "f2"), attic: spirit("attic", "f3", { visibility: "dm" }) },
      encounter: { rev: 0, round: 1, activeEntryId: "e-gob", entries: [entry("e-gob", { tokenId: "gob", value: 20 }), entry("e-c", { characterId: "bree", value: 10, tieOrder: 1 })] },
    };
    const next = run(state, { t: "encounter.next" });
    assert.equal(next.tokens.up!.companion?.reactionUsed, undefined, "Upper, where the spirit stands, is open");
    assert.equal(next.tokens.attic!.companion?.reactionUsed, true, "a hidden spirit opens nothing");
  });
});
