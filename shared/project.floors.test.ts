import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { holderTileKey, keys, readEntity } from "./keys.ts";
import { OP_VERSION } from "./migrate.ts";
import type { MapVideo, RoomState, Scene, SceneFloor, Viewer } from "./model.ts";
import {
  activeRowShownTo,
  allKeys,
  areaSeenMark,
  dependents,
  heldOf,
  inSightOfNonOwners,
  projectEntity,
  projectState,
  rowSeenMark,
  seenAtEvery,
  seenByNonOwners,
  seenMark,
  stableStringify,
  visibleAssetIds,
  type ProjectedState,
} from "./project.ts";
import type { Op } from "./protocol.ts";
import { applyOp, type Applied } from "./reducer.ts";
import { unseenFloor } from "./rules/floors.ts";
import { DM, FULL_TILE_BITS, P1, P2, character, drawing, entry, env, imageRef, member, reveal, room, scene, template, token, trap } from "./testutil.ts";

/**
 * The projection of a scene with floors (docs/design/design-v1-floors.md 8,
 * lane FLR-B): each viewer's snapshot and per-key answers cover the floors
 * they hold and nothing else, levels renumbered among those held, the
 * marks and `floor.of` the DM's, `partyFloors` a display's, and the seen
 * marks asking whether players see a floor.
 *
 * The tower: Cellar (level 0), Ground floor (1, the main floor and the
 * start floor), Upper floor (2, reached before: an opened mark) and Attic
 * (3), with Road a plain scene beside it. Thorn is p1's, Bree p2's, and
 * the display owns nothing. Cellar and Attic hold one of everything a
 * scene can, under names found nowhere else, so a snapshot that holds any
 * of them names it.
 */
const DISPLAY: Viewer = { memberId: "display:abcdefghijkl", role: "player" };
const PLAYERS: readonly Viewer[] = [P1, P2, DISPLAY];
const NOW = { opVersion: OP_VERSION };

const video = (assetId: string): MapVideo => ({ assetId, widthPx: 700, heightPx: 700, container: "webm", video: "vp09.00.40.08", fps: 30, durationMs: 1000, kbps: 100 });

function floorOf(id: string, level: number, name: string, overrides: Partial<Scene> = {}): Scene {
  const floor: SceneFloor = { of: "ground", level, name, height: 10 };
  return scene(id, { name: "Tower", floor, ...overrides });
}

/** Everything a floor can hold, each named for the floor (`tag`), so a stray name in a snapshot points at its floor. */
function furnish(s: RoomState, sceneId: string, tag: string): void {
  s.scenes[sceneId] = {
    ...s.scenes[sceneId]!,
    map: { assetId: `${tag}-map`, widthPx: 700, heightPx: 700, cellPx: 70, originPx: { x: 0, y: 0 }, video: video(`${tag}-video`) },
    phases: [{ id: `${tag}-phase`, name: `${tag} burning`, assetId: `${tag}-still`, widthPx: 700, heightPx: 700, video: video(`${tag}-phase-video`) }],
    weather: { kind: "snow", heavy: true, wind: "strong", toward: 90 },
  };
  s.tokens[`${tag}-beast`] = token(`${tag}-beast`, { sceneId, name: `${tag} beast`, image: imageRef(`${tag}-face`) });
  s.buildChunks[`${sceneId}:0,0`] = { sceneId, cx: 0, cy: 0, rev: 1, cells: { "1,1": "stone" }, edges: {} };
  s.labels[`${tag}-label`] = { id: `${tag}-label`, rev: 0, sceneId, x: 2, y: 2, text: `${tag} hoard`, size: 1 };
  s.stamps[`${tag}-stamp`] = { id: `${tag}-stamp`, rev: 0, sceneId, art: { assetId: `${tag}-art` }, x: 3, y: 3, w: 1, h: 1, rotation: 0, z: 0, visibility: "all" };
  s.lights[`${tag}-light`] = { id: `${tag}-light`, rev: 0, sceneId, x: 4, y: 4, bright: 10, dim: 10, on: true, walls: true };
  s.pins[`${tag}-pin`] = { id: `${tag}-pin`, rev: 0, sceneId, x: 5, y: 5, label: `${tag} note`, color: "#ffffff", visibility: "all" };
  s.traps[`${tag}-trap`] = trap(`${tag}-trap`, { sceneId, name: `${tag} pit`, found: true });
  s.templates[`${tag}-area`] = template(`${tag}-area`, { sceneId, ownerId: "dm1" });
  s.drawings[`${tag}-ink`] = drawing(`${tag}-ink`, { sceneId, ownerId: "dm1" });
  s.fogDrafts[sceneId] = { sceneId, rev: 0, ops: [] };
}

function tower(): RoomState {
  const s = room({ members: { dm1: member("dm1", "dm"), p1: member("p1"), p2: member("p2") } });
  s.meta.playerSceneId = "ground";
  s.scenes = {
    cellar: floorOf("cellar", 0, "Cellar"),
    ground: floorOf("ground", 1, "Ground floor"),
    upper: floorOf("upper", 2, "Upper floor"),
    attic: floorOf("attic", 3, "Attic"),
    road: scene("road", { name: "Road", order: 1 }),
  };
  s.openFloors = { upper: { sceneId: "upper", rev: 1 } };
  s.characters.c1 = character("c1", { name: "Thorn", ownerIds: ["p1"] });
  s.tokens.thorn = token("thorn", { kind: "pc", name: "Thorn", sceneId: "ground", actor: { ref: "c1" }, disposition: "ally" });
  s.tokens.bree = token("bree", { kind: "pc", name: "Bree", sceneId: "ground", ownerIds: ["p2"], disposition: "ally", x: 5 });
  s.tokens.goblin = token("goblin", { sceneId: "upper", name: "Goblin" });
  furnish(s, "cellar", "zyx");
  furnish(s, "attic", "qwv");
  return s;
}

/** The snapshot as text, with each unheld floor's names, so one search finds any of them. */
function traces(copy: unknown, tags: readonly string[]): string[] {
  const text = JSON.stringify(copy);
  return tags.filter((tag) => text.includes(tag));
}

/** Each unheld floor's id as it opens a JSON string (a key, a value or a tile's key), its name, and its contents' tag. */
const UNHELD = ['"cellar', '"attic', "Cellar", "Attic", "zyx", "qwv"];

/** Every key the fan-out projects one at a time agrees with the snapshot, so neither path holds what the other does not. */
function agrees(state: RoomState, viewer: Viewer, sceneId: string | null, copy: ProjectedState): void {
  for (const key of allKeys(state)) {
    if (key === keys.encounterHistory) continue;
    assert.equal(stableStringify(projectEntity(key, state, viewer, { sceneId })), stableStringify(readEntity(copy as unknown as RoomState, key)), `${viewer.memberId}: ${key}`);
  }
}

describe("a floor not held sends nothing (design 8)", () => {
  test("players and the display hold the start floor and the reached one, and no record, name, image, video or id of the others", () => {
    const state = tower();
    for (const viewer of PLAYERS) {
      const copy = projectState(state, viewer, { sceneId: "attic" });
      assert.deepEqual(Object.keys(copy.scenes).sort(), ["ground", "upper"], viewer.memberId);
      assert.deepEqual(traces(copy, UNHELD), [], `${viewer.memberId}'s snapshot names an unheld floor`);
      assert.deepEqual(traces([...visibleAssetIds(state, viewer, { sceneId: "attic" })], UNHELD), [], `${viewer.memberId}'s assets`);
      assert.ok(copy.tokens.goblin, "the reached floor's creatures arrive");
      agrees(state, viewer, "attic", copy);
    }
  });

  test("a held floor's map, phase video and contents arrive with it, by its own rules", () => {
    const state = tower();
    furnish(state, "upper", "upr");
    const copy = projectState(state, P2, { sceneId: null });
    for (const key of ["upr-beast"]) assert.ok(copy.tokens[key], key);
    assert.ok(copy.labels["upr-label"] && copy.stamps["upr-stamp"] && copy.pins["upr-pin"] && copy.traps["upr-trap"] && copy.templates["upr-area"] && copy.drawings["upr-ink"]);
    assert.ok(copy.buildChunks["upper:0,0"], "the floor's build");
    assert.equal(copy.lights["upr-light"], undefined, "lights stay the DM's on every floor");
    assert.equal(copy.scenes.upper!.weather?.kind, "snow", "each floor's own weather");
    const assets = visibleAssetIds(state, P2, { sceneId: null });
    assert.ok(assets.has("upr-map") && assets.has("upr-video") && assets.has("upr-face") && assets.has("upr-art"));
    assert.ok(!assets.has("upr-still") && !assets.has("upr-phase-video"), "only the showing phase, as on any scene");
  });

  test("the floors a player's own creature stands on are theirs alone, hidden or not", () => {
    const state = tower();
    state.tokens.owl = token("owl", { sceneId: "attic", kind: "npc", name: "Familiar", ownerIds: ["p1"], visibility: "dm" });
    const ana = projectState(state, P1, { sceneId: null });
    assert.deepEqual(Object.keys(ana.scenes).sort(), ["attic", "ground", "upper"]);
    assert.ok(ana.tokens.owl && ana.tokens["qwv-beast"], "Ana holds the attic and what stands there by its own rules");
    for (const viewer of [P2, DISPLAY]) {
      const copy = projectState(state, viewer, { sceneId: null });
      assert.deepEqual(traces(copy, UNHELD), [], viewer.memberId);
      agrees(state, viewer, null, copy);
    }
    agrees(state, P1, null, ana);
  });

  test("behind a blackout a player and a display hold no floor", () => {
    const state = tower();
    state.meta.view = { ...state.meta.view, blackout: true };
    for (const viewer of PLAYERS) {
      const copy = projectState(state, viewer, { sceneId: null });
      assert.deepEqual(copy.scenes, {}, viewer.memberId);
      assert.deepEqual(copy.tokens, {}, viewer.memberId);
      assert.equal(copy.meta.partyFloors, undefined);
    }
  });

  test("a prep scene with floors that players are not on sends nothing, its start floor included", () => {
    const state = tower();
    state.meta.playerSceneId = "road";
    state.tokens.thorn = { ...state.tokens.thorn!, sceneId: "road" };
    state.tokens.bree = { ...state.tokens.bree!, sceneId: "road" };
    for (const viewer of PLAYERS) {
      const copy = projectState(state, viewer, { sceneId: null });
      assert.deepEqual(Object.keys(copy.scenes), ["road"], viewer.memberId);
      assert.deepEqual(traces(copy, [...UNHELD, '"ground', '"upper', "Goblin"]), [], viewer.memberId);
    }
  });
});

describe("a floor's place for players (D-261102-492)", () => {
  test("levels count up from 0 among the floors held, with no gap for an unheld one, and never the main floor or the height", () => {
    const state = tower();
    const copy = projectState(state, P1, { sceneId: null });
    assert.deepEqual(copy.scenes.ground!.floor, { level: 0, name: "Ground floor" });
    assert.deepEqual(copy.scenes.upper!.floor, { level: 1, name: "Upper floor" });
    assert.equal(copy.scenes.upper!.name, "Tower", "every floor's record carries the scene's name");
    const owned = { ...state, tokens: { ...state.tokens, owl: token("owl", { sceneId: "cellar", ownerIds: ["p1"], visibility: "dm" }) } };
    const deeper = projectState(owned, P1, { sceneId: null });
    assert.deepEqual(
      Object.fromEntries(Object.entries(deeper.scenes).map(([id, s]) => [id, s.floor])),
      { cellar: { level: 0, name: "Cellar", unseen: true }, ground: { level: 1, name: "Ground floor" }, upper: { level: 2, name: "Upper floor" } },
    );
  });

  test("holding one floor reads as a scene without floors: no `floor` at all", () => {
    const state = tower();
    delete state.openFloors;
    for (const viewer of PLAYERS) {
      const copy = projectState(state, viewer, { sceneId: null });
      assert.deepEqual(Object.keys(copy.scenes), ["ground"]);
      assert.ok(!("floor" in copy.scenes.ground!), viewer.memberId);
      assert.ok(!("floor" in (projectEntity(keys.scene("ground"), state, viewer, { sceneId: null }) as Scene)));
    }
  });

  test("a device's copy reads its floors back as it holds them, as its replay of an op does", () => {
    const copy = projectState(tower(), P1, { sceneId: null }) as unknown as RoomState;
    for (const id of Object.keys(copy.scenes)) assert.deepEqual(projectEntity(keys.scene(id), copy, P1, { sceneId: null }), copy.scenes[id], id);
  });
});

describe("a room-level record names only a floor the viewer holds (FLRBUILD-PRIV-01)", () => {
  /**
   * Ana's owl, which the DM hid, on the Attic, which nobody reached: her
   * ask for saves there and the owl's turn starting there. Then the DM
   * moves the owl down to Ground and gives it to Bree.
   */
  function handedDown(): RoomState {
    const state = tower();
    state.tokens.owl = token("owl", { sceneId: "attic", kind: "npc", name: "Owl", ownerIds: ["p1"], visibility: "dm", x: 2, y: 2 });
    state.casts = { k1: { id: "k1", rev: 0, by: "p1", caster: "owl", sceneId: "attic", spell: "Fireball", targets: ["owl"], at: "2026-11-08T00:00:00Z" } };
    state.encounter = { rev: 0, round: 1, activeEntryId: "e-owl", entries: [entry("e-owl", { tokenId: "owl", value: 12 })], turnStart: { entryId: "e-owl", tokenId: "owl", sceneId: "attic", x: 2, y: 2, elevation: 0, seen: true } };
    const held = projectState(state, P1, { sceneId: null });
    assert.equal(held.casts.k1?.sceneId, "attic", "Ana holds the Attic through her owl, so her ask names it");
    // A new room object, as each op makes one, since the held floors are kept per finished state.
    return { ...state, tokens: { ...state.tokens, owl: { ...state.tokens.owl!, sceneId: "ground", ownerIds: ["p2"] } } };
  }

  test("an ask for saves made on a floor the caster's new owner does not hold reaches them as nothing, by snapshot and by key", () => {
    const state = handedDown();
    for (const viewer of PLAYERS) {
      const copy = projectState(state, viewer, { sceneId: null });
      assert.deepEqual(traces(copy, UNHELD), [], `${viewer.memberId}'s snapshot names the Attic`);
      assert.equal(projectEntity(keys.cast("k1"), state, viewer, { sceneId: null }), null, viewer.memberId);
      agrees(state, viewer, null, copy);
    }
    assert.equal(projectState(state, DM, { sceneId: "ground" }).casts.k1?.sceneId, "attic", "the DM's ask is whole");
  });

  test("an ask on a scene without floors, or naming no scene the room has, reaches its caster's players as before floors", () => {
    for (const sceneId of ["road", "gone", "__proto__", "constructor"]) {
      const state = handedDown();
      state.casts.k1 = { ...state.casts.k1!, sceneId };
      assert.equal(projectState(state, P2, { sceneId: null }).casts.k1?.sceneId, sceneId, sceneId);
      assert.equal(projectState(state, P1, { sceneId: null }).casts.k1, undefined, `${sceneId}: Ana no longer owns the owl`);
    }
  });

  test("the same ask on a floor Bree holds reaches her as before", () => {
    const state = handedDown();
    state.casts.k1 = { ...state.casts.k1!, sceneId: "ground" };
    assert.equal(projectState(state, P2, { sceneId: null }).casts.k1?.sceneId, "ground");
  });
});

describe("an ask whose floor stops being one goes with it, and the undo brings it back (FLRBUILD-ASTRA-07, PRIV-04, FLRB-OPUS-09)", () => {
  let seq = 100;
  const run = (state: RoomState, op: Op): Applied => {
    const r = applyOp(state, op, DM, env(seq++));
    assert.ok(r.ok, `${op.t}: ${r.ok ? "" : `${r.code}: ${r.message}`}`);
    return r;
  };
  const back = (r: Applied, from: "undo" | "redo" = "undo"): Op => ({ t: "sys.restore", entries: [...(r.inverse ?? [])], from, deps: true });
  /** An ask as the reducer writes it on a floor, marked, or unmarked as one made before its scene had floors. */
  const ask = (sceneId: string, marked: boolean) => ({ k1: { id: "k1", rev: 0, by: "p1", caster: "owl", sceneId, spell: "Fireball", targets: ["owl"], at: "2026-11-08T00:00:00Z", ...(marked ? { onFloor: true as const } : {}) } });
  /** Ana's owl, which the DM hid, asked on `floor`, then went to `to` as Bree's, as the DM's moves leave it. */
  const handed = (state: RoomState, floor: string, to: string, marked = false): RoomState => ({
    ...state,
    casts: ask(floor, marked),
    tokens: { ...state.tokens, owl: token("owl", { sceneId: to, kind: "npc", name: "Owl", ownerIds: ["p2"], visibility: "dm", x: 2, y: 2 }) },
  });
  /** Bree gets no ask and no trace of the floor, and the DM's ask is there or not as `dm` says. */
  const check = (state: RoomState, floor: string, dm: boolean, where: string) => {
    const bree = projectState(state, P2, { sceneId: null });
    assert.equal(bree.casts.k1, undefined, `${where}: Bree's ask`);
    assert.ok(!JSON.stringify(bree).includes(`"${floor}"`), `${where}: Bree's copy names the floor`);
    assert.equal(state.casts.k1 !== undefined, dm, `${where}: the room's ask`);
    agrees(state, P2, null, bree);
  };

  // Each path with an ask marked as made on a floor, as the reducer marks every ask made on one.
  test("a floor removed, while a floor changed and still one keeps its asks", () => {
    const state = handed(tower(), "attic", "ground", true);
    assert.ok(run(state, { t: "scene.update", sceneId: "attic", patch: { floor: { name: "Loft" } } } as Op).state.casts.k1, "a renamed floor keeps its ask");
    const removed = run(state, { t: "scene.delete", sceneId: "attic" });
    check(removed.state, "attic", false, "removed");
    check(run(removed.state, back(removed)).state, "attic", true, "its undo");
  });

  test("a floor's add undone, which removes it by a restore", () => {
    const added = run(tower(), { t: "scene.create", scene: { id: "loft", name: "Tower", bounds: { w: 30, h: 20 } }, floor: { beside: "attic", side: "above" } } as Op);
    const state = handed(added.state, "loft", "ground", true);
    const undone = run(state, back(added));
    assert.equal(undone.state.scenes.loft, undefined);
    check(undone.state, "loft", false, "the add undone");
    check(run(undone.state, back(undone, "redo")).state, "loft", true, "its redo");
  });

  test("a removal that leaves one floor, which makes the private main floor a plain scene (D-261108-426)", () => {
    const base = room({ members: { dm1: member("dm1", "dm"), p1: member("p1"), p2: member("p2") } });
    base.scenes = {
      tower: scene("tower", { name: "Tower", floor: { of: "tower", level: 0, name: "Ground floor", height: 10 } }),
      up: scene("up", { name: "Tower", floor: { of: "tower", level: 1, name: "Upstairs", height: 10 } }),
      road: scene("road", { name: "Road", order: 1 }),
    };
    base.meta.playerSceneId = "road";
    const state = handed(base, "tower", "road", true);
    const removed = run(state, { t: "scene.delete", sceneId: "up" });
    assert.equal(removed.state.scenes.tower?.floor, undefined, "Tower is a plain scene again");
    check(removed.state, "tower", false, "collapsed");
    check(run(removed.state, back(removed)).state, "tower", true, "its undo");
  });

  /** Tower, a plain scene, and Road, where the players are. */
  const plainTower = () => {
    const base = room({ members: { dm1: member("dm1", "dm"), p1: member("p1"), p2: member("p2") } });
    base.scenes = { tower: scene("tower", { name: "Tower" }), road: scene("road", { name: "Road", order: 1 }) };
    base.meta.playerSceneId = "road";
    return base;
  };
  const addUpstairs: Op = { t: "scene.create", scene: { id: "up", name: "Tower", bounds: { w: 30, h: 20 } }, floor: { beside: "tower", side: "above" } } as Op;

  test("a scene's first floor add undone, which writes the main floor back without its floor", () => {
    const added = run(plainTower(), addUpstairs);
    assert.ok(added.state.scenes.tower?.floor, "Tower's record now has its floor");
    const state = handed(added.state, "tower", "road", true);
    const undone = run(state, back(added));
    assert.equal(undone.state.scenes.tower?.floor, undefined);
    check(undone.state, "tower", false, "the add undone");
    check(run(undone.state, back(undone, "redo")).state, "tower", true, "its redo");
  });

  test("an ask made on the scene before its first add stays through that add's undo, and reaches its caster's players as before floors (D-261108-431)", () => {
    const before = handed(plainTower(), "tower", "road");
    const added = run(before, addUpstairs);
    assert.equal(projectState(added.state, P2, { sceneId: null }).casts.k1, undefined, "while Tower has floors, Bree holds none of them");
    const undone = run(added.state, back(added));
    assert.ok(undone.state.casts.k1, "the undo leaves the ask");
    assert.equal(projectState(undone.state, P2, { sceneId: null }).casts.k1?.sceneId, "tower", "a plain scene's ask follows its player");
  });

  test("an ask closed, its floor removed, then the close undone: the ask comes back marked and still reaches no one who never held its floor (FLRBUILD-PRIV-05)", () => {
    const closes: { name: string; who: Viewer; op: Op }[] = [
      { name: "Apply", who: DM, op: { t: "actor.outcome", plan: "pl1", cast: "k1", targets: [{ target: { tokenId: "owl" }, amount: 1 }] } as Op },
      { name: "the DM's dismissal", who: DM, op: { t: "cast.close", castId: "k1", end: "dismissed" } },
      { name: "Ana's withdrawal", who: P1, op: { t: "cast.close", castId: "k1", end: "withdrawn" } },
    ];
    for (const close of closes) {
      const by = (who: Viewer) => (state: RoomState, op: Op): Applied => {
        const r = applyOp(state, op, who, env(seq++));
        assert.ok(r.ok, `${close.name}, ${op.t}: ${r.ok ? "" : `${r.code}: ${r.message}`}`);
        return r;
      };
      let state = tower();
      state = { ...state, tokens: { ...state.tokens, owl: token("owl", { sceneId: "attic", kind: "npc", name: "Owl", ownerIds: ["p1"], visibility: "dm", x: 2, y: 2 }) } };
      // 1. Ana asks from the Attic, which she holds only through her hidden owl, and the reducer marks the ask.
      const asking: Op = { t: "cast.ask", cast: { id: "k1", caster: "owl", sceneId: "attic", spell: "Fireball", targets: ["owl"] } };
      const device = projectState(state, P1, { sceneId: null }) as unknown as RoomState;
      state = by(P1)(state, asking).state;
      assert.equal(state.casts.k1?.onFloor, true, `${close.name}: the ask is marked`);
      const sent = projectState(state, P1, { sceneId: null }).casts.k1;
      assert.equal(sent?.onFloor, undefined, `${close.name}: the mark is the DM's`);
      const predicted = applyOp(device, asking, P1, env(seq++));
      assert.ok(predicted.ok);
      assert.deepEqual(predicted.state.casts.k1, sent, `${close.name}: Ana's device predicts the ask as it is sent to her, unmarked`);
      // A withdrawal is Ana's, while the owl is still hers.
      let closed = close.who === P1 ? by(P1)(state, close.op) : null;
      // 2. The DM brings the owl down and gives it to Bree.
      state = run(closed?.state ?? state, { t: "token.update", tokenId: "owl", patch: { sceneId: "ground", ownerIds: ["p2"] } } as Op).state;
      // 3. The DM resolves or dismisses the ask.
      if (closed === null) {
        closed = by(DM)(state, close.op);
        state = closed.state;
      }
      assert.equal(state.casts.k1, undefined, `${close.name}: closed`);
      // 4. The DM removes the Attic, with no ask left on it to drop.
      state = run(state, { t: "scene.delete", sceneId: "attic" }).state;
      // 5. The close is undone.
      state = run(state, back(closed)).state;
      assert.ok(state.casts.k1, `${close.name}: the undo brings the ask back`);
      check(state, "attic", true, `${close.name}, its undo after the floor went`);
    }
  });
});

describe("a floor held only through a hidden creature says no player sees it (FLRBUILD-PRIV-03)", () => {
  const owlUpstairs = (over: Partial<RoomState> = {}): RoomState => {
    const state = { ...tower(), ...over };
    state.tokens = { ...state.tokens, owl: token("owl", { sceneId: "attic", kind: "npc", name: "Owl", ownerIds: ["p1"], visibility: "dm" }) };
    return state;
  };

  test("Ana's copy marks the Attic `unseen`, every floor players see goes unmarked, and the device reads it as the server does", () => {
    const state = owlUpstairs();
    const ana = projectState(state, P1, { sceneId: null });
    assert.deepEqual(ana.scenes.attic?.floor, { level: 2, name: "Attic", unseen: true });
    for (const id of ["ground", "upper"]) assert.equal(ana.scenes[id]?.floor?.unseen, undefined, id);
    for (const viewer of [P2, DISPLAY]) assert.ok(Object.values(projectState(state, viewer, { sceneId: null }).scenes).every((s) => s.floor?.unseen === undefined), viewer.memberId);
    assert.equal(projectState(state, DM, { sceneId: "ground" }).scenes.attic?.floor?.unseen, undefined, "the DM's floors are the stored ones");
    const copy = ana as unknown as RoomState;
    for (const id of ["ground", "upper", "attic"]) assert.equal(unseenFloor(copy, id), unseenFloor(state, id), `Ana's device and the server agree on ${id}`);
    agrees(state, P1, null, ana);
  });

  test("shown to players, the Attic loses its mark, by a key the opened mark's change projects again", () => {
    const shown = owlUpstairs({ openFloors: { ...tower().openFloors, attic: { sceneId: "attic", rev: 0 } } });
    assert.equal(projectState(shown, P1, { sceneId: null }).scenes.attic?.floor?.unseen, undefined);
    assert.ok(dependents(shown, [keys.opened("attic")], owlUpstairs()).includes(keys.scene("attic")), "the floor's record goes again with its mark");
    const dark = { ...owlUpstairs(), meta: { ...owlUpstairs().meta, view: { ...owlUpstairs().meta.view, blackout: true } } };
    assert.deepEqual(projectState(dark, P1, { sceneId: null }).scenes, {}, "behind a blackout Ana holds nothing to mark");
  });
});

describe("the DM's projection", () => {
  test("a DM holds every floor of the scene they view, by any floor, with the marks, and nothing of another scene's contents", () => {
    const state = tower();
    for (const sceneId of ["upper", "ground", "attic"]) {
      const copy = projectState(state, DM, { sceneId });
      assert.ok(copy.tokens.thorn && copy.tokens.goblin && copy.tokens["zyx-beast"] && copy.tokens["qwv-beast"], sceneId);
      assert.deepEqual(copy.scenes.attic!.floor, { of: "ground", level: 3, name: "Attic", height: 10 });
      assert.deepEqual(copy.openFloors, { upper: { sceneId: "upper", rev: 1 } });
      assert.ok(copy.lights["qwv-light"] && copy.fogDrafts.attic);
      agrees(state, DM, sceneId, copy);
    }
    const road = projectState(state, DM, { sceneId: "road" });
    assert.deepEqual([...Object.keys(road.tokens), ...Object.keys(road.lights), ...Object.keys(road.labels), ...Object.keys(road.fogDrafts)], []);
    assert.ok(road.scenes.attic, "every scene's record, as today");
  });

  test("the opened marks are the DM's: a key of their own, which no player's projection holds", () => {
    const state = tower();
    assert.ok(allKeys(state).includes(keys.opened("upper")));
    assert.deepEqual(projectEntity(keys.opened("upper"), state, DM, { sceneId: "ground" }), { sceneId: "upper", rev: 1 });
    assert.ok(heldOf(projectState(state, DM, { sceneId: "ground" })).has(keys.opened("upper")));
    for (const viewer of PLAYERS) {
      assert.equal(projectEntity(keys.opened("upper"), state, viewer, { sceneId: null }), null);
      assert.equal(projectState(state, viewer, { sceneId: null }).openFloors, undefined);
    }
    delete state.openFloors;
    assert.ok(!("openFloors" in projectState(state, DM, { sceneId: "ground" })), "absent once empty, as a copy built from changes holds it");
  });
});

describe("the floors a display follows (meta.partyFloors, D-261102-491)", () => {
  test("only a display gets the held floors with the most unhidden party members, bottom first", () => {
    const state = tower();
    assert.deepEqual(projectState(state, DISPLAY, { sceneId: null }).meta.partyFloors, ["ground"]);
    for (const viewer of [P1, P2, DM]) assert.equal(projectState(state, viewer, { sceneId: "ground" }).meta.partyFloors, undefined, viewer.memberId);
    state.tokens.bree = { ...state.tokens.bree!, sceneId: "upper" };
    assert.deepEqual(projectState(state, DISPLAY, { sceneId: null }).meta.partyFloors, ["ground", "upper"], "a tie, bottom first");
    state.tokens.wolf = token("wolf", { sceneId: "upper", kind: "npc", partyVision: true });
    assert.deepEqual(projectState(state, DISPLAY, { sceneId: null }).meta.partyFloors, ["upper"], "an ally lending sight counts");
    state.tokens.wolf = { ...state.tokens.wolf, visibility: "dm" };
    state.tokens.bree = { ...state.tokens.bree, visibility: "dm" };
    assert.deepEqual(projectState(state, DISPLAY, { sceneId: null }).meta.partyFloors, ["ground"], "a party member the DM hid counts for nothing");
    assert.deepEqual(projectEntity(keys.meta, state, DISPLAY, { sceneId: null }), projectState(state, DISPLAY, { sceneId: null }).meta);
  });

  test("absent while the display holds one floor, or no party member stands on any", () => {
    const state = tower();
    delete state.openFloors;
    assert.ok(!("partyFloors" in projectState(state, DISPLAY, { sceneId: null }).meta));
    const empty = tower();
    delete empty.tokens.thorn;
    delete empty.tokens.bree;
    assert.ok(!("partyFloors" in projectState(empty, DISPLAY, { sceneId: null }).meta));
  });

  test("a token's floor, standing and coming or going re-project the meta, and a step on its floor does not", () => {
    const before = tower();
    const at = (patch: object) => ({ ...before, tokens: { ...before.tokens, bree: { ...before.tokens.bree!, ...patch } } });
    const touched = [keys.token("bree")];
    const metaOf = (after: RoomState) => dependents(after, touched, before).includes(keys.meta) || dependents(before, touched, after).includes(keys.meta);
    assert.equal(metaOf(at({ x: 9 })), false, "a step within its floor");
    assert.equal(metaOf(at({ sceneId: "upper" })), true, "to another floor");
    assert.equal(metaOf(at({ visibility: "dm" })), true, "hidden");
    const gone = { ...before, tokens: { ...before.tokens } };
    delete gone.tokens.bree;
    assert.equal(metaOf(gone), true, "deleted");
    assert.equal(dependents(before, touched).includes(keys.meta), true, "one state alone");
    const road = { ...before, tokens: { ...before.tokens, cart: token("cart", { sceneId: "road" }) } };
    assert.equal(metaOf({ ...road, tokens: { ...road.tokens, cart: { ...road.tokens.cart!, partyVision: true } } }), false, "a scene without floors");
  });
});

describe("seen marks ask whether players see the floor (8.3)", () => {
  test("a creature on a floor players see is seen, on an unopened one never, wherever the question asks", () => {
    const state = tower();
    const goblin = state.tokens.goblin!;
    const wraith = state.tokens["zyx-beast"]!;
    assert.equal(seenByNonOwners(state, goblin, NOW), true, "Upper was reached");
    assert.deepEqual(seenMark(state, goblin, NOW, "here"), { seen: true });
    for (const [name, mark] of [
      ["here", seenByNonOwners(state, wraith, NOW)],
      ["anywhere", inSightOfNonOwners(state, wraith, NOW)],
      ["every spot", seenAtEvery(state, wraith, [{ x: 1, y: 1, elevation: 0 }], NOW)],
    ] as const) {
      assert.equal(mark, false, name);
    }
    assert.deepEqual(seenMark(state, wraith, NOW, "anywhere"), {});
    assert.deepEqual(seenMark(state, wraith, NOW, "here"), {});
  });

  test("off the players' scene a plain scene keeps its rule, a scene with floors sees nothing", () => {
    const state = tower();
    state.tokens.cart = token("cart", { sceneId: "road" });
    assert.equal(seenByNonOwners(state, state.tokens.cart, NOW), false);
    assert.equal(inSightOfNonOwners(state, state.tokens.cart, NOW), true, "stored moves off the players' scene replay unchanged");
    assert.deepEqual(seenMark(state, state.tokens.cart, NOW, "anywhere"), { seen: true });
    state.meta.playerSceneId = "road";
    assert.equal(inSightOfNonOwners(state, state.tokens.goblin!, NOW), false, "no floor of a scene players are not on is seen");
  });

  test("on a per-player floor players see, the holders who saw a creature are listed, the start floor or not", () => {
    const state = tower();
    delete state.openFloors;
    state.scenes.upper = { ...state.scenes.upper!, vision: { on: true, light: "bright", perPlayer: true } };
    state.holders.upper = { sceneId: "upper", rev: 1, entries: [{ memberId: "p1", on: true }] };
    // Thorn on Upper opens it, and his own sight sees the goblin, which no one else's does.
    state.tokens.thorn = { ...state.tokens.thorn!, sceneId: "upper", x: 3, y: 4 };
    const goblin = state.tokens.goblin!;
    assert.equal(seenByNonOwners(state, goblin, NOW), false);
    assert.deepEqual(seenMark(state, goblin, NOW, "here"), { seenBy: ["p1"] });
    assert.deepEqual(rowSeenMark(state, entry("eg", { tokenId: "goblin" }), NOW), { seenBy: ["p1"] });
    const area = template("blast", { sceneId: "upper", ownerId: "dm1" });
    assert.deepEqual(areaSeenMark(state, area, goblin, NOW), { seenBy: ["p1"] });
  });

  test("a player's Next or Previous reads the acting row on any floor they hold", () => {
    const state = tower();
    state.encounter = { rev: 0, round: 1, activeEntryId: "eg", entries: [entry("eg", { tokenId: "goblin", value: 15 }), entry("ew", { tokenId: "zyx-beast", value: 10 })] };
    assert.equal(activeRowShownTo(state, P2, NOW), true);
    assert.deepEqual(projectState(state, P2, { sceneId: null }).encounter?.entries.map((e) => e.id), ["eg"], "no row of an unheld floor, and no gap in the order");
    assert.equal(projectState(state, P2, { sceneId: null }).encounter?.entries[0]?.tieOrder, 0);
    state.encounter = { ...state.encounter, activeEntryId: "ew" };
    assert.equal(activeRowShownTo(state, P2, NOW), false);
  });
});

describe("each held floor projects by its own fog, sight and memory", () => {
  test("fog, chunks, sight and remembered labels of two held floors both arrive, each keyed by its floor", () => {
    const state = tower();
    for (const id of ["ground", "upper"]) {
      state.scenes[id] = { ...state.scenes[id]!, fogEnabled: true, vision: { on: true, light: "bright" } };
      reveal(state, id, { x: 0, y: 0, w: 4, h: 4 });
      state.buildChunks[`${id}:0,0`] = { sceneId: id, cx: 0, cy: 0, rev: 1, cells: { "1,1": "wood" }, edges: {} };
    }
    // Ground the party explored on Upper with nothing in sight there now: memory shows the label it saw, which is gone.
    for (const id of ["upper", "attic"]) state.exploredTiles[`${id}:0,0`] = { sceneId: id, tx: 0, ty: 0, rev: 1, bits: FULL_TILE_BITS };
    state.scenes.attic = { ...state.scenes.attic!, fogEnabled: true, vision: { on: true, light: "bright" } };
    state.memory = {
      "upper:0,0": { sceneId: "upper", cx: 0, cy: 0, rev: 1, labels: { gone: { id: "gone", rev: 0, sceneId: "upper", x: 10, y: 10, text: "Old sign", size: 1 } } },
      "attic:0,0": { sceneId: "attic", cx: 0, cy: 0, rev: 1, labels: { ghost: { id: "ghost", rev: 0, sceneId: "attic", x: 10, y: 10, text: "qwv sign", size: 1 } } },
    };
    const copy = projectState(state, P2, { sceneId: null });
    assert.ok(Object.keys(copy.fogTiles).some((k) => k.startsWith("ground:")) && Object.keys(copy.fogTiles).some((k) => k.startsWith("upper:")), "fog of both");
    assert.ok(copy.buildChunks["ground:0,0"] && copy.buildChunks["upper:0,0"], "chunks of both");
    assert.ok(Object.keys(copy.sight).some((k) => k.startsWith("ground:")), "Ground's sight, from the party there");
    assert.equal(copy.labels.gone?.text, "Old sign", "Upper's memory");
    assert.equal(copy.labels.ghost, undefined, "an unheld floor's memory");
    assert.deepEqual(traces(copy, UNHELD), []);
    agrees(state, P2, null, copy);
  });

  test("each floor's party sight, from the party members on it", () => {
    const state = tower();
    for (const id of ["ground", "upper"]) state.scenes[id] = { ...state.scenes[id]!, vision: { on: true, light: "bright" } };
    state.tokens.bree = { ...state.tokens.bree!, sceneId: "upper" };
    const copy = projectState(state, P1, { sceneId: null });
    const floors = new Set(Object.keys(copy.sight).map((k) => k.split(":")[0]));
    assert.deepEqual([...floors].sort(), ["ground", "upper"]);
    agrees(state, P1, null, copy);
  });

  test("a sight holder's own layer on each per-player floor they hold joins their fog", () => {
    const state = tower();
    for (const id of ["ground", "upper"]) {
      state.scenes[id] = { ...state.scenes[id]!, fogEnabled: true, vision: { on: false, light: "bright", perPlayer: true } };
      state.holders[id] = { sceneId: id, rev: 1, entries: [{ memberId: "p1", on: true }] };
      state.exploredBy[holderTileKey(id, "p1", 1, 1)] = { sceneId: id, tx: 1, ty: 1, rev: 1, bits: FULL_TILE_BITS, memberId: "p1" };
    }
    const own = projectState(state, P1, { sceneId: null });
    assert.ok(own.fogTiles["ground:1,1"] && own.fogTiles["upper:1,1"], "p1's own explored ground on both floors");
    assert.equal(projectState(state, P2, { sceneId: null }).fogTiles["upper:1,1"], undefined, "no one else's");
    agrees(state, P1, null, own);
  });

  test("per-player floors each send their own shared maps, and the DM each holder list", () => {
    const state = tower();
    for (const id of ["ground", "upper"]) {
      state.scenes[id] = { ...state.scenes[id]!, fogEnabled: true, vision: { on: false, light: "bright", perPlayer: true } };
      state.holders[id] = { sceneId: id, rev: 1, entries: [{ memberId: "p1", on: true }] };
      reveal(state, id, { x: 0, y: 0, w: 4, h: 4 });
    }
    state.scenes.attic = { ...state.scenes.attic!, fogEnabled: true, vision: { on: false, light: "bright", perPlayer: true } };
    state.holders.attic = { sceneId: "attic", rev: 1, entries: [{ memberId: "p1", on: true }] };
    reveal(state, "attic", { x: 0, y: 0, w: 4, h: 4 });
    const dm = projectState(state, DM, { sceneId: "ground" });
    assert.deepEqual(Object.keys(dm.holders ?? {}).sort(), ["attic", "ground", "upper"]);
    const p2 = projectState(state, P2, { sceneId: null });
    assert.deepEqual([...new Set(Object.keys(p2.fogAll ?? {}).map((k) => k.split(":")[0]))].sort(), ["ground", "upper"]);
    assert.equal(p2.holders, undefined);
    agrees(state, P2, null, p2);
    agrees(state, DM, "ground", dm);
  });
});
