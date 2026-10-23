import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { keys } from "./keys.ts";
import type { LogEvent, RoomState, Viewer } from "./model.ts";
import { MAX_NAME, type Op, type RestoreEntry } from "./protocol.ts";
import { LIMITS } from "./limits.ts";
import { DM_LINE_BASE } from "./logRings.ts";
import { applyOp, MAX_LOG } from "./reducer.ts";
import { hashValue } from "./project.ts";
import { MAX_HISTORY } from "./reducer/encounter.ts";
import { guardHash } from "./reducer/tx.ts";
import { FULL_TILE, isTokenFullyFogged } from "./rules/fog.ts";
import { ZERO_HP_UNCONSCIOUS_ID } from "./rules/hp.ts";
import {
  AT,
  DM,
  P1,
  actor,
  apply,
  character,
  comparable,
  blockOf,
  customMonster,
  deepClone,
  effect,
  env,
  handoutPage,
  imageRef,
  refused,
  reveal,
  room,
  scene,
  srdImage,
  template,
  token,
} from "./testutil.ts";

/** A room mid-session: a PC on a character, two goblins, an object, and fog on the player scene. */
function setup() {
  const state = room();
  state.scenes.s1!.fogEnabled = true;
  state.characters.c1 = character("c1", { ownerIds: ["p1"], actor: actor({ initBonus: 3 }) });
  state.tokens.pc1 = token("pc1", { kind: "pc", name: "Ayla", actor: { ref: "c1" }, x: 1, y: 1 });
  state.tokens.gob1 = token("gob1", { name: "Goblin", x: 5, y: 5, actor: { inline: actor({ hp: { cur: 7, max: 7, temp: 0 }, initBonus: 2, initScore: 12 }) } });
  state.tokens.gob2 = token("gob2", { name: "Goblin", x: 6, y: 5, number: 2, actor: { inline: actor({ hp: { cur: 7, max: 7, temp: 0 }, initBonus: 2 }) } });
  state.tokens.crate = token("crate", { kind: "object", name: "Crate", x: 9, y: 9, layer: "object" });
  state.monsters.mon1 = customMonster("mon1", { sizeAlt: "medium", xpInLair: 700, defaultImage: imageRef("lurker") });
  state.srdImages.bandit = srdImage("bandit", "bandit-pic");
  state.savedEncounters.enc1 = { id: "enc1", rev: 0, name: "Ambush", monsters: [{ srdId: "goblin-warrior", count: 4 }, { monsterId: "mon1", count: 1 }], party: [{ count: 4, level: 3 }] };
  state.handoutDocs.doc1 = { id: "doc1", rev: 0, title: "Strange letter", pages: [handoutPage("page1"), handoutPage("page2", 2048, 1584)], createdAt: AT };
  reveal(state, "s1", { x: 0, y: 0, w: 4, h: 4 });
  return state;
}

function fresh(): ReturnType<typeof setup> {
  return setup();
}

describe("the reducer itself", () => {
  test("is deterministic and never mutates its input", () => {
    const state = fresh();
    const snapshot = deepClone(state);
    const op: Op = { t: "actor.hp", target: { tokenId: "gob1" }, change: { kind: "damage", amount: 3 } };
    const a = applyOp(state, op, DM, env(7));
    const b = applyOp(state, op, DM, env(7));
    assert.deepEqual(state, snapshot);
    assert.deepEqual(a, b);
    assert.ok(a.ok && b.ok);
    // No player sees or plays the goblin, so its line counts with the DM's (shared/logRings.ts).
    assert.equal(a.log[0]!.id, `7:${DM_LINE_BASE}`);
    assert.equal(a.log[0]!.at, AT);
    const c = applyOp(state, op, DM, env(8));
    assert.ok(c.ok);
    assert.notEqual(c.log[0]!.id, a.log[0]!.id);
  });

  test("shares structure: untouched collections and entities keep their identity", () => {
    const state = fresh();
    const next = apply(state, { t: "token.move", tokenId: "gob1", x: 8, y: 8 });
    assert.equal(next.scenes, state.scenes);
    assert.equal(next.characters, state.characters);
    assert.equal(next.tokens.gob2, state.tokens.gob2);
    assert.notEqual(next.tokens.gob1, state.tokens.gob1);
    assert.equal(next.tokens.gob1!.rev, state.tokens.gob1!.rev + 1);
  });

  test("refuses undo and redo, which the server resolves first", () => {
    assert.equal(refused(fresh(), { t: "undo" }).code, "invalid");
    assert.equal(refused(fresh(), { t: "redo" }).code, "invalid");
  });

  test("reports touched keys, log entries and the global flag", () => {
    const r = applyOp(fresh(), { t: "room.update", settings: { playersMoveAny: "all" } }, DM, env(1));
    assert.ok(r.ok);
    assert.deepEqual(r.touched, [keys.meta]);
    assert.ok(r.global);
    const named = applyOp(fresh(), { t: "room.update", name: "New name" }, DM, env(1));
    assert.ok(named.ok && !named.global);
    const moved = applyOp(fresh(), { t: "token.move", tokenId: "gob1", x: 2, y: 2 }, DM, env(1));
    assert.ok(moved.ok && !moved.global && moved.log.length === 0);
  });
});

describe("inverses", () => {
  const ops: Op[] = [
    { t: "room.update", name: "Renamed", settings: { feetPerCell: 10 } },
    { t: "room.setPlayerScene", sceneId: "s2" },
    { t: "view.blackout", blackout: true },
    { t: "member.update", memberId: "p1", name: "Pat", color: "#00ff00" },
    { t: "scene.create", scene: { id: "s3", name: "Cave", bounds: { w: 10, h: 10 } } },
    { t: "scene.update", sceneId: "s1", patch: { name: "Renamed", fogEnabled: false } },
    { t: "scene.delete", sceneId: "s1" },
    { t: "scene.reorder", order: ["s2", "s1"] },
    { t: "scene.setMap", sceneId: "s1", map: { assetId: "m", widthPx: 100, heightPx: 100, cellPx: 10, originPx: { x: 0, y: 0 } } },
    { t: "token.create", token: { id: "gob3", sceneId: "s1", kind: "monster", name: "Goblin", size: "medium", x: 1, y: 1, actor: { inline: actor() } } },
    { t: "token.update", tokenId: "gob1", patch: { ownerIds: ["p2"], sceneId: "s2", actor: { hp: { max: 30 }, notes: "n" } } },
    { t: "token.delete", tokenId: "pc1" },
    { t: "token.move", tokenId: "gob1", x: 7, y: 7, elevation: 10, rotation: 45 },
    { t: "token.moveMany", moves: [{ tokenId: "gob1", x: 1, y: 2 }, { tokenId: "gob2", x: 3, y: 4 }] },
    { t: "actor.hp", target: { tokenId: "gob1" }, change: { kind: "damage", amount: 5 } },
    { t: "actor.hp", target: { tokenId: "pc1" }, change: { kind: "damage", amount: 50 } },
    { t: "actor.hp", target: { characterId: "c1" }, change: { kind: "temp", amount: 5 } },
    { t: "actor.damageMany", hits: [{ target: { tokenId: "gob1" }, amount: 8 }, { target: { tokenId: "gob2" }, amount: 4 }, { target: { tokenId: "pc1" }, amount: 4 }] },
    { t: "actor.life", target: { tokenId: "gob2" }, life: "dead" },
    { t: "actor.effect.add", target: { tokenId: "gob1" }, effect: { id: "e1", key: "poisoned", duration: { mode: "rounds", rounds: 2, of: { tokenId: "gob1" } } } },
    { t: "character.create", character: { id: "c2", name: "Bo", size: "small", ownerIds: ["p2"], actor: actor() } },
    { t: "character.update", characterId: "c1", patch: { name: "Ayla the Bold", actor: { hp: { cur: 0 } } } },
    { t: "character.update", characterId: "c1", patch: { level: 7 } },
    { t: "character.delete", characterId: "c1" },
    { t: "template.create", template: { id: "a1", sceneId: "s1", shape: "cone", size: 15, origin: { x: 1, y: 1, z: 0 }, yaw: 0, includeOrigin: false, color: "#ff0000", ownerId: "dm1", visibility: "all", attachedTo: "gob1" } },
    { t: "drawing.create", drawing: { id: "d1", sceneId: "s1", kind: "line", points: [0, 0, 1, 1], style: { stroke: "#ffffff", width: 1, opacity: 1 }, ownerId: "dm1", visibility: "all" } },
    { t: "fog.draft", sceneId: "s1", add: [{ id: "f1", mode: "reveal", shape: { kind: "rect", x: 10, y: 10, w: 5, h: 5 } }] },
    { t: "fog.live", sceneId: "s1", ops: [{ id: "f1", mode: "reveal", shape: { kind: "rect", x: 10, y: 10, w: 5, h: 5 } }] },
    { t: "fog.reset", sceneId: "s1", to: "revealed" },
    { t: "fog.reset", sceneId: "s1", to: "hidden" },
    { t: "build.paint", sceneId: "s1", terrain: "stone", cells: ["1,1", "17,1"] },
    { t: "build.rect", sceneId: "s1", terrain: "wood", x: 0, y: 0, w: 5, h: 5 },
    { t: "build.poly", sceneId: "s1", terrain: "grass", points: [0, 0, 6, 0, 0, 6] },
    { t: "build.edge", sceneId: "s1", edges: [{ key: "2,2,n", feature: { kind: "door", state: "closed", secret: true, discovered: false } }] },
    { t: "build.label", sceneId: "s1", labelId: "l1", label: { x: 1, y: 1, text: "Hall", size: 1 } },
    { t: "encounter.start", entries: [{ id: "n1", tokenId: "pc1", value: 15 }, { id: "n2", tokenId: "gob1", value: 12, hidden: true }] },
    { t: "handout.show", handout: { id: "h1", assetId: "img", title: "Letter", to: ["p1"] } },
    { t: "monster.create", monster: { id: "mon2", ...blockOf(customMonster("mon2", { name: "Mire Wight" })) } },
    { t: "monster.update", monsterId: "mon1", patch: { name: "Deep Lurker", sizeAlt: null, xpInLair: null, actions: [], abilities: { ...customMonster("x").abilities, str: { score: 18, save: 6 } } } },
    { t: "monster.delete", monsterId: "mon1" },
    { t: "monster.update", monsterId: "mon1", patch: { defaultImage: imageRef("lurker-2", 1.5) } },
    { t: "monster.update", monsterId: "mon1", patch: { defaultImage: null } },
    { t: "monster.setSrdImage", srdId: "goblin-warrior", image: imageRef("goblin") },
    { t: "monster.setSrdImage", srdId: "bandit", image: imageRef("bandit-2") },
    { t: "monster.setSrdImage", srdId: "bandit", image: null },
    { t: "savedEncounter.create", encounter: { id: "enc2", name: "Wolves", monsters: [{ srdId: "wolf", count: 3 }] } },
    { t: "savedEncounter.update", encounterId: "enc1", patch: { name: "Ambush at dusk", monsters: [{ srdId: "bandit", count: 2, inLair: true }], party: null } },
    { t: "savedEncounter.delete", encounterId: "enc1" },
    { t: "handout.show", handout: { id: "h2", pages: [handoutPage("page1"), handoutPage("page2", 2048, 1584)], title: "Strange letter", to: "all" } },
    { t: "handoutDoc.create", doc: { id: "doc2", title: "Strange letter", pages: [handoutPage("page3")] } },
    { t: "handoutDoc.delete", docId: "doc1" },
  ];

  for (const op of ops) {
    test(`${op.t} round trips through its inverse`, () => {
      const before = fresh();
      const r = applyOp(before, op, DM, env(1));
      assert.ok(r.ok, `${op.t}: ${r.ok ? "" : r.message}`);
      assert.ok(r.inverse, `${op.t} should be undoable`);
      const back = applyOp(r.state, { t: "sys.restore", entries: r.inverse, from: "undo" }, DM, env(2));
      assert.ok(back.ok, `${op.t} restore: ${back.ok ? "" : back.message}`);
      assert.deepEqual(withoutWalls(back.state), withoutWalls(before));
      // And the restore's own inverse (redo) brings the op's result back.
      assert.ok(back.inverse);
      const again = applyOp(back.state, { t: "sys.restore", entries: back.inverse, from: "redo" }, DM, env(3));
      assert.ok(again.ok);
      assert.deepEqual(withoutWalls(again.state), withoutWalls(r.state));
      // The walls version never goes back, whichever way the restore went.
      for (const [id, scene] of Object.entries(r.state.scenes)) {
        assert.ok((back.state.scenes[id]?.wallsVersion ?? Infinity) >= scene.wallsVersion);
        assert.ok((again.state.scenes[id]?.wallsVersion ?? Infinity) >= (back.state.scenes[id]?.wallsVersion ?? 0));
      }
    });
  }

  /** States compared without walls versions, which an undo moves forward rather than back. */
  function withoutWalls(state: RoomState): unknown {
    const scenes = Object.fromEntries(Object.entries(state.scenes).map(([id, { wallsVersion: _w, ...rest }]) => [id, rest]));
    return comparable({ ...state, scenes } as unknown as RoomState);
  }

  test("an undone build edit moves the walls version on, so the next edit never reuses one", () => {
    const h = history(fresh());
    const seen = [h.state.scenes.s1!.wallsVersion];
    const step = () => {
      const v = h.state.scenes.s1!.wallsVersion;
      assert.ok(v > seen.at(-1)!, `walls version ${v} after ${seen.join(", ")}`);
      seen.push(v);
    };
    h.op({ t: "build.paint", sceneId: "s1", terrain: "stone", cells: ["1,1"] });
    step();
    h.op({ t: "build.edge", sceneId: "s1", edges: [{ key: "1,1,n", feature: { kind: "door", state: "closed", secret: false, discovered: false } }] });
    step();
    assert.ok(h.undo().ok);
    step();
    assert.ok(h.undo().ok);
    step();
    assert.deepEqual(h.state.buildChunks, fresh().buildChunks);
    h.op({ t: "build.paint", sceneId: "s1", terrain: "wood", cells: ["2,2"] });
    step();
    h.op({ t: "build.clear", sceneId: "s1" });
    step();
    assert.ok(h.undo().ok);
    step();
    assert.equal(Object.values(h.state.buildChunks)[0]?.cells["2,2"], "wood");
  });

  test("a stored build undo from before keeps its scene rev, and only its walls version moves on", () => {
    const before = fresh();
    const painted = apply(before, { t: "build.paint", sceneId: "s1", terrain: "stone", cells: ["1,1"] });
    const chunk = keys.chunk("s1", 0, 0);
    // What the rev-guarded inverse of a paint used to hold: the chunk and the scene.
    const entries: RestoreEntry[] = [
      { key: chunk, value: null, expectRev: painted.buildChunks["s1:0,0"]!.rev },
      { key: keys.scene("s1"), value: before.scenes.s1, expectRev: painted.scenes.s1!.rev },
    ];
    const r = applyOp(painted, { t: "sys.restore", entries, from: "undo" }, DM, env(2));
    assert.ok(r.ok);
    assert.equal(r.state.scenes.s1!.rev, painted.scenes.s1!.rev + 1);
    assert.equal(r.state.scenes.s1!.wallsVersion, painted.scenes.s1!.wallsVersion + 1);
  });

  test("build edits leave the scene out of their undo guard", () => {
    const h = history(fresh());
    const other: Viewer = { memberId: "dm2", role: "dm" };
    h.op({ t: "scene.update", sceneId: "s1", patch: { name: "Cave" } });
    h.op({ t: "build.paint", sceneId: "s1", terrain: "stone", cells: ["1,1"] });
    // A second DM device paints another chunk of the same scene meanwhile.
    h.op({ t: "build.paint", sceneId: "s1", terrain: "stone", cells: ["30,20"] }, other);
    h.op({ t: "build.rect", sceneId: "s1", terrain: "stone", x: 31, y: 21, w: 2, h: 2 }, other);
    assert.ok(h.undo().ok, "this device's paint undoes");
    assert.equal(Object.values(h.state.buildChunks).some((c) => c.cells["1,1"] !== undefined), false);
    assert.equal(Object.values(h.state.buildChunks).some((c) => c.cells["30,20"] === "stone"), true);
    assert.ok(h.undo().ok, "and so does the rename before it");
    assert.equal(h.state.scenes.s1!.name, fresh().scenes.s1!.name);
    // Painting the same chunk is a real conflict, and still refused.
    const g = history(fresh());
    g.op({ t: "build.paint", sceneId: "s1", terrain: "stone", cells: ["1,1"] });
    g.op({ t: "build.paint", sceneId: "s1", terrain: "wood", cells: ["2,1"] }, other);
    assert.ok(!g.undo().ok);
  });

  /**
   * Plays ops as one member and keeps their inverses the way the server's
   * stacks do (server/rooms/undo.ts): undo pops the newest, and a restore's
   * own inverse goes on the other stack.
   */
  function history(start: RoomState) {
    let state = start;
    let seq = 0;
    const undo: RestoreEntry[][] = [];
    const redo: RestoreEntry[][] = [];
    const restore = (from: "undo" | "redo") => {
      const entries = (from === "undo" ? undo : redo).pop();
      assert.ok(entries, `nothing to ${from}`);
      const r = applyOp(state, { t: "sys.restore", entries, from }, DM, env(++seq));
      if (!r.ok) return r;
      state = r.state;
      if (r.inverse) (from === "undo" ? redo : undo).push(r.inverse);
      return r;
    };
    return {
      get state() {
        return state;
      },
      op(op: Op, who: Viewer = DM) {
        const r = applyOp(state, op, who, env(++seq));
        assert.ok(r.ok, `${op.t}: ${r.ok ? "" : r.message}`);
        state = r.state;
        if (who === DM && r.inverse) {
          undo.push(r.inverse);
          redo.length = 0;
        }
      },
      undo: () => restore("undo"),
      redo: () => restore("redo"),
    };
  }

  test("three edits of one token undo one after another, and redo back", () => {
    const h = history(fresh());
    h.op({ t: "token.move", tokenId: "gob1", x: 6, y: 6 });
    h.op({ t: "token.move", tokenId: "gob1", x: 7, y: 7 });
    h.op({ t: "token.update", tokenId: "gob1", patch: { name: "Boss" } });
    assert.ok(h.undo().ok);
    assert.equal(h.state.tokens.gob1!.name, "Goblin");
    assert.ok(h.undo().ok);
    assert.equal(h.state.tokens.gob1!.x, 6);
    assert.ok(h.undo().ok);
    assert.deepEqual([h.state.tokens.gob1!.x, h.state.tokens.gob1!.y], [5, 5]);
    assert.deepEqual(comparable(h.state), comparable(fresh()));
    for (let i = 0; i < 3; i++) assert.ok(h.redo().ok);
    assert.deepEqual([h.state.tokens.gob1!.x, h.state.tokens.gob1!.name], [7, "Boss"]);
  });

  test("undo chains across a delete: the token comes back, then its move and rename undo", () => {
    const h = history(fresh());
    h.op({ t: "token.update", tokenId: "gob1", patch: { name: "Snik" } });
    h.op({ t: "token.move", tokenId: "gob1", x: 8, y: 8 });
    h.op({ t: "token.delete", tokenId: "gob1" });
    assert.ok(h.undo().ok);
    assert.equal(h.state.tokens.gob1!.x, 8);
    assert.ok(h.undo().ok);
    assert.equal(h.state.tokens.gob1!.x, 5);
    assert.ok(h.undo().ok);
    assert.equal(h.state.tokens.gob1!.name, "Goblin");
  });

  test("a scene renamed twice undoes twice", () => {
    const h = history(fresh());
    h.op({ t: "scene.update", sceneId: "s1", patch: { name: "Cave" } });
    h.op({ t: "scene.update", sceneId: "s1", patch: { name: "Deep cave" } });
    assert.ok(h.undo().ok);
    assert.ok(h.undo().ok);
    assert.equal(h.state.scenes.s1!.name, fresh().scenes.s1!.name);
  });

  test("chained undos still stop at a change someone else made in between", () => {
    const h = history(fresh());
    h.op({ t: "token.move", tokenId: "gob1", x: 6, y: 6 });
    h.op({ t: "token.move", tokenId: "gob1", x: 7, y: 7 }, { memberId: "dm2", role: "dm" });
    h.op({ t: "token.update", tokenId: "gob1", patch: { name: "Boss" } });
    // The rename is this member's own and undoes.
    assert.ok(h.undo().ok);
    // Their move was overwritten by the other DM's, which an undo must not revert.
    const refused = h.undo();
    assert.ok(!refused.ok && refused.code === "invalid" && /changed/.test(refused.message));
    assert.deepEqual([h.state.tokens.gob1!.x, h.state.tokens.gob1!.name], [7, "Goblin"]);
  });

  test("a restore is refused when someone changed the entity since", () => {
    const state = fresh();
    const r = applyOp(state, { t: "token.move", tokenId: "gob1", x: 7, y: 7 }, DM, env(1));
    assert.ok(r.ok && r.inverse);
    const changed = apply(r.state, { t: "token.move", tokenId: "gob1", x: 8, y: 8 }, DM, 2);
    const back = applyOp(changed, { t: "sys.restore", entries: r.inverse, from: "undo" }, DM, env(3));
    assert.ok(!back.ok && back.code === "invalid" && /changed/.test(back.message));
    const deleted = apply(r.state, { t: "token.delete", tokenId: "gob1" }, DM, 2);
    assert.ok(!applyOp(deleted, { t: "sys.restore", entries: r.inverse, from: "undo" }, DM, env(3)).ok);
  });

  test("a restore of the meta or the history is refused when someone changed it since", () => {
    const renamed = applyOp(fresh(), { t: "room.update", name: "Renamed" }, DM, env(1));
    assert.ok(renamed.ok && renamed.inverse);
    assert.equal(renamed.inverse[0]!.expectHash?.length, 32);
    // Another DM moves the players on. Undoing the rename must not move them back.
    const moved = apply(renamed.state, { t: "room.setPlayerScene", sceneId: "s2" }, { memberId: "dm2", role: "dm" }, 2);
    const back = applyOp(moved, { t: "sys.restore", entries: renamed.inverse, from: "undo" }, DM, env(3));
    assert.ok(!back.ok && back.code === "invalid" && /changed/.test(back.message));
    const untouched = applyOp(renamed.state, { t: "sys.restore", entries: renamed.inverse, from: "undo" }, DM, env(3));
    assert.ok(untouched.ok && untouched.state.meta.name === "Test room");

    let state = apply(fresh(), { t: "encounter.start", entries: [{ id: "n1", tokenId: "pc1", value: 20 }, { id: "n2", tokenId: "gob1", value: 10 }] });
    const next = applyOp(state, { t: "encounter.next" }, DM, env(2));
    assert.ok(next.ok && next.inverse);
    state = apply(next.state, { t: "encounter.next" }, DM, 3);
    const history = next.inverse.filter((e) => e.key === keys.encounterHistory);
    assert.equal(history.length, 1);
    assert.ok(!applyOp(state, { t: "sys.restore", entries: history, from: "undo" }, DM, env(4)).ok);
  });

  test("a stored restore from before value hashes still replays unguarded", () => {
    const state = fresh();
    const r = applyOp(state, { t: "sys.restore", entries: [{ key: keys.meta, value: { ...state.meta, name: "Old" } }], from: "undo" }, DM, env(1));
    assert.ok(r.ok && r.state.meta.name === "Old");
  });

  test("stored guards replay as they applied: rev guards still count, and the meta's hash is unchanged", () => {
    const state = fresh();
    const gob = state.tokens.gob1!;
    assert.ok(applyOp(state, { t: "sys.restore", entries: [{ key: keys.token("gob1"), value: null, expectRev: gob.rev }], from: "undo" }, DM, env(1)).ok);
    assert.ok(!applyOp(state, { t: "sys.restore", entries: [{ key: keys.token("gob1"), value: null, expectRev: gob.rev + 1 }], from: "undo" }, DM, env(1)).ok);
    assert.equal(guardHash(keys.meta, state.meta), hashValue(state.meta));
    assert.equal(guardHash(keys.encounterHistory, state.encounterHistory), hashValue(state.encounterHistory));
  });

  test("a restore applies entirely or not at all, and never touches the log", () => {
    const state = fresh();
    const entries = [
      { key: keys.token("gob1"), value: null, expectRev: 0 },
      { key: keys.token("gob2"), value: null, expectRev: 99 },
    ];
    const r = applyOp(state, { t: "sys.restore", entries, from: "undo" }, DM, env(1));
    assert.ok(!r.ok);
    assert.ok(!applyOp(state, { t: "sys.restore", entries: [{ key: "log:1:0", value: null }], from: "undo" }, DM, env(1)).ok);
    assert.ok(!applyOp(state, { t: "sys.restore", entries: [{ key: "meta", value: null }], from: "undo" }, DM, env(1)).ok);
    assert.ok(!applyOp(state, { t: "sys.restore", entries: [{ key: "bogus:1", value: null }], from: "undo" }, DM, env(1)).ok);
  });

  test("chat has no inverse, because the log is a record", () => {
    const r = applyOp(fresh(), { t: "log.chat", text: "hi" }, P1, env(1));
    assert.ok(r.ok);
    assert.equal(r.inverse, null);
    assert.deepEqual(r.touched, ["log:1:0"]);
  });
});

describe("room, members and scenes", () => {
  test("room ops write the meta", () => {
    let state = apply(fresh(), { t: "room.update", name: "Dungeon", settings: { diagonal: "fiveTen" } });
    assert.equal(state.meta.name, "Dungeon");
    assert.equal(state.meta.settings.diagonal, "fiveTen");
    assert.equal(state.meta.settings.feetPerCell, 5);
    state = apply(state, { t: "room.setPlayerScene", sceneId: "s2" });
    assert.equal(state.meta.playerSceneId, "s2");
    assert.equal(refused(state, { t: "room.setPlayerScene", sceneId: "nope" }).code, "gone");
    state = apply(state, { t: "view.follow", follow: true });
    state = apply(state, { t: "view.blackout", blackout: true });
    assert.deepEqual(state.meta.view, { follow: true, blackout: true });
  });

  test("members join, change kind and edit themselves, all global", () => {
    const join = applyOp(fresh(), { t: "sys.memberJoin", member: { id: "p3", name: "Quinn", color: "#123456", kind: "player", createdAt: AT } }, DM, env(1));
    assert.ok(join.ok && join.global);
    assert.equal(join.state.members.p3!.rev, 1);
    assert.deepEqual(join.log[0]!.data, { type: "member", memberId: "p3", action: "join" });
    assert.equal(refused(join.state, { t: "sys.memberJoin", member: { id: "p3", name: "Q", color: "#123456", kind: "player", createdAt: AT } }).code, "invalid");
    const kind = applyOp(join.state, { t: "sys.memberSetKind", memberId: "p3", kind: "dm" }, DM, env(2));
    assert.ok(kind.ok && kind.state.members.p3!.kind === "dm");
    assert.deepEqual(kind.log[0]!.data, { type: "member", memberId: "p3", action: "dm" });
    const same = applyOp(kind.state, { t: "sys.memberSetKind", memberId: "p3", kind: "dm" }, DM, env(3));
    assert.ok(same.ok && same.touched.length === 0);
    const edit = applyOp(kind.state, { t: "member.update", memberId: "p3", name: "Q" }, { memberId: "p3", role: "player" }, env(4));
    assert.ok(edit.ok && edit.global && edit.state.members.p3!.name === "Q");
    assert.equal(refused(fresh(), { t: "member.update", memberId: "ghost", name: "x" }).code, "gone");
  });

  test("scene.create fills defaults, numbers the order and fogs maps", () => {
    const state = apply(fresh(), { t: "scene.create", scene: { id: "s3", name: "Cave", bounds: { w: 10, h: 10 }, map: { assetId: "m", widthPx: 100, heightPx: 100, cellPx: 10, originPx: { x: 0, y: 0 } } } });
    const s3 = state.scenes.s3!;
    assert.equal(s3.order, 2);
    assert.equal(s3.fogEnabled, true);
    assert.equal(s3.wallsVersion, 0);
    assert.equal(s3.grid.show, true);
    const blank = apply(state, { t: "scene.create", scene: { id: "s4", name: "Mat", bounds: { w: 10, h: 10 } } });
    assert.equal(blank.scenes.s4!.fogEnabled, false);
    assert.equal(refused(state, { t: "scene.create", scene: { id: "s3", name: "Dup", bounds: { w: 1, h: 1 } } }).code, "invalid");
  });

  test("scene.update toggling fog is global, other fields are not", () => {
    const fog = applyOp(fresh(), { t: "scene.update", sceneId: "s1", patch: { fogEnabled: false } }, DM, env(1));
    assert.ok(fog.ok && fog.global);
    const name = applyOp(fresh(), { t: "scene.update", sceneId: "s1", patch: { name: "x", defaultView: { x: 1, y: 1, zoom: 2 } } }, DM, env(1));
    assert.ok(name.ok && !name.global && name.state.scenes.s1!.defaultView?.zoom === 2);
    const cleared = apply(name.state, { t: "scene.update", sceneId: "s1", patch: { defaultView: null } });
    assert.equal(cleared.scenes.s1!.defaultView, undefined);
  });

  test("scene.delete removes everything on the scene and moves the player scene", () => {
    let state = fresh();
    state.templates.a1 = template("a1", { attachedTo: "gob1" });
    state.drawings.d1 = { id: "d1", rev: 0, sceneId: "s1", kind: "line", points: [0, 0, 1, 1], style: { stroke: "#fff000", width: 1, opacity: 1 }, ownerId: "dm1", visibility: "all" };
    state.labels.l1 = { id: "l1", rev: 0, sceneId: "s1", x: 0, y: 0, text: "x", size: 1 };
    state.buildChunks["s1:0,0"] = { sceneId: "s1", cx: 0, cy: 0, rev: 0, cells: { "0,0": "stone" }, edges: {} };
    state.fogDrafts.s1 = { sceneId: "s1", rev: 0, ops: [] };
    state = apply(state, { t: "encounter.start", entries: [{ id: "n1", tokenId: "gob1", value: 10 }] });
    const r = applyOp(state, { t: "scene.delete", sceneId: "s1" }, DM, env(2));
    assert.ok(r.ok && r.global);
    const s = r.state;
    assert.equal(s.scenes.s1, undefined);
    assert.equal(Object.keys(s.tokens).length, 0);
    assert.deepEqual([s.templates, s.drawings, s.labels, s.buildChunks, s.fogTiles, s.fogDrafts], [{}, {}, {}, {}, {}, {}]);
    assert.equal(s.encounter!.entries.length, 0);
    assert.equal(s.meta.playerSceneId, "s2");
    assert.equal(refused(s, { t: "scene.delete", sceneId: "s2" }).code, "invalid");
  });

  test("scene.delete logs the same entries whatever order the tokens were stored in", () => {
    // A snapshot loaded from jsonb loses insertion order, so replay must not depend on it.
    const build = (ids: string[]) => {
      let state = fresh();
      for (const id of ids) state.tokens[id] = token(id, { sceneId: "s2" });
      state = apply(state, { t: "encounter.start", entries: [{ id: "na", tokenId: "ta", value: 10 }, { id: "nz", tokenId: "tz", value: 5 }] });
      state = apply(state, { t: "actor.effect.add", target: { characterId: "c1" }, effect: { id: "ea", key: "blessed", duration: { mode: "rounds", rounds: 2, of: { entryId: "na" } } } }, DM, 2);
      return apply(state, { t: "actor.effect.add", target: { characterId: "c1" }, effect: { id: "ez", key: "hasted", duration: { mode: "rounds", rounds: 2, of: { entryId: "nz" } } } }, DM, 3);
    };
    const sorted = applyOp(build(["ta", "tz"]), { t: "scene.delete", sceneId: "s2" }, DM, env(4));
    const reversed = applyOp(build(["tz", "ta"]), { t: "scene.delete", sceneId: "s2" }, DM, env(4));
    assert.ok(sorted.ok && reversed.ok);
    assert.deepEqual(sorted.log.map((e) => (e.data?.type === "effect" ? e.data.key : null)), ["blessed", "hasted"]);
    assert.deepEqual(reversed.log, sorted.log);
  });

  test("reorder, setMap and setGrid", () => {
    let state = apply(fresh(), { t: "scene.reorder", order: ["s2", "s1"] });
    assert.equal(state.scenes.s2!.order, 0);
    assert.equal(state.scenes.s1!.order, 1);
    assert.equal(refused(state, { t: "scene.reorder", order: ["s1", "s1"] }).code, "invalid");
    assert.equal(refused(state, { t: "scene.setGrid", sceneId: "s1", cellPx: 10, originPx: { x: 0, y: 0 } }).code, "invalid");
    state = apply(state, { t: "scene.setMap", sceneId: "s1", map: { assetId: "m", widthPx: 100, heightPx: 50, cellPx: 10, originPx: { x: 0, y: 0 } } });
    state = apply(state, { t: "scene.setGrid", sceneId: "s1", cellPx: 12.5, originPx: { x: 3, y: 4 } });
    assert.deepEqual(state.scenes.s1!.map, { assetId: "m", widthPx: 100, heightPx: 50, cellPx: 12.5, originPx: { x: 3, y: 4 } });
    state = apply(state, { t: "scene.setMap", sceneId: "s1", map: null });
    assert.equal(state.scenes.s1!.map, undefined);
  });
});

describe("tokens", () => {
  test("create fills defaults by kind and numbers duplicates", () => {
    const state = fresh();
    const r = apply(state, { t: "token.create", token: { id: "gob3", sceneId: "s1", kind: "monster", name: "Goblin", size: "medium", x: 1, y: 1, actor: { inline: actor() } } });
    assert.equal(r.tokens.gob3!.number, 3);
    assert.equal(r.tokens.gob1!.number, 1);
    assert.equal(r.tokens.gob2!.number, 2);
    assert.equal(r.tokens.gob3!.hpVisibility, "label");
    assert.equal(r.tokens.gob3!.disposition, "hostile");
    assert.equal(r.tokens.gob3!.rev, 1);
    const pc = apply(r, { t: "token.create", token: { id: "pc2", sceneId: "s1", kind: "pc", name: "Ayla", size: "medium", x: 1, y: 1, actor: { ref: "c1" } } }, DM, 2);
    assert.equal(pc.tokens.pc2!.number, undefined);
    assert.equal(pc.tokens.pc2!.hpVisibility, "exact");
    assert.equal(pc.tokens.pc2!.disposition, "ally");
    const obj = apply(pc, { t: "token.create", token: { id: "crate2", sceneId: "s1", kind: "object", name: "Crate", size: "medium", x: 1, y: 1, actor: { inline: actor() } } }, DM, 3);
    assert.equal(obj.tokens.crate2!.number, undefined);
    assert.equal(obj.tokens.crate2!.layer, "object");
    const lone = apply(obj, { t: "token.create", token: { id: "orc1", sceneId: "s1", kind: "monster", name: "Orc", size: "medium", x: 1, y: 1, actor: { inline: actor() } } }, DM, 4);
    assert.equal(lone.tokens.orc1!.number, undefined);
  });

  test("create refuses duplicates and missing references", () => {
    assert.equal(refused(fresh(), { t: "token.create", token: { id: "gob1", sceneId: "s1", kind: "monster", name: "G", size: "medium", x: 0, y: 0, actor: { inline: actor() } } }).code, "invalid");
    assert.equal(refused(fresh(), { t: "token.create", token: { id: "x", sceneId: "nope", kind: "monster", name: "G", size: "medium", x: 0, y: 0, actor: { inline: actor() } } }).code, "gone");
    assert.equal(refused(fresh(), { t: "token.create", token: { id: "x", sceneId: "s1", kind: "pc", name: "G", size: "medium", x: 0, y: 0, actor: { ref: "nope" } } }).code, "gone");
  });

  test("update patches fields, routes actor patches to the holder, and flags ownership and scene moves", () => {
    const owners = applyOp(fresh(), { t: "token.update", tokenId: "gob1", patch: { ownerIds: ["p1"], publicName: "Thing", nameHidden: true } }, DM, env(1));
    assert.ok(owners.ok && owners.global);
    assert.equal(owners.state.tokens.gob1!.publicName, "Thing");
    const cleared = apply(owners.state, { t: "token.update", tokenId: "gob1", patch: { publicName: null, image: null } });
    assert.equal(cleared.tokens.gob1!.publicName, undefined);
    const noted = apply(fresh(), { t: "token.update", tokenId: "gob1", patch: { notes: "Wears a red cloak" } });
    assert.equal(noted.tokens.gob1!.notes, "Wears a red cloak");
    assert.equal("notes" in apply(noted, { t: "token.update", tokenId: "gob1", patch: { notes: null } }).tokens.gob1!, false);
    const wolf = { assetId: "wolf", crop: { cx: 0, cy: 0, zoom: 1 } };
    const shapes = apply(fresh(), { t: "token.update", tokenId: "gob1", patch: { altImages: [wolf] } });
    assert.deepEqual(shapes.tokens.gob1!.altImages, [wolf]);
    assert.equal("altImages" in apply(shapes, { t: "token.update", tokenId: "gob1", patch: { altImages: [] } }).tokens.gob1!, false);
    const moved = applyOp(fresh(), { t: "token.update", tokenId: "gob1", patch: { sceneId: "s2" } }, DM, env(1));
    assert.ok(moved.ok && moved.global);
    assert.equal(refused(fresh(), { t: "token.update", tokenId: "gob1", patch: { sceneId: "nope" } }).code, "gone");
    const plain = applyOp(fresh(), { t: "token.update", tokenId: "gob1", patch: { locked: true, actor: { ac: 15, hp: { max: 20 }, initScore: null } } }, DM, env(1));
    assert.ok(plain.ok && !plain.global);
    const inline = plain.state.tokens.gob1!.actor;
    assert.ok("inline" in inline && inline.inline.ac === 15 && inline.inline.hp.max === 20 && inline.inline.initScore === undefined);
    const viaRef = apply(fresh(), { t: "token.update", tokenId: "pc1", patch: { actor: { hp: { cur: 0 } } } });
    assert.equal(viaRef.characters.c1!.actor.hp.cur, 0);
    assert.equal(viaRef.characters.c1!.actor.life, "dying");
  });

  test("delete cascades to attached templates, caster references and initiative rows", () => {
    let state = fresh();
    state.templates.a1 = template("a1", { attachedTo: "gob1" });
    state.templates.a2 = template("a2", { casterId: "gob1" });
    state = apply(state, { t: "encounter.start", entries: [{ id: "n1", tokenId: "gob1", value: 10 }, { id: "n2", tokenId: "gob2", value: 5 }] });
    state = apply(state, { t: "encounter.next" }, DM, 2);
    assert.equal(state.encounter!.activeEntryId, "n1");
    state = apply(state, { t: "token.delete", tokenId: "gob1" }, DM, 3);
    assert.equal(state.tokens.gob1, undefined);
    assert.equal(state.templates.a1, undefined);
    assert.equal(state.templates.a2!.casterId, undefined);
    assert.deepEqual(state.encounter!.entries.map((e) => e.id), ["n2"]);
    assert.equal(state.encounter!.activeEntryId, "n2");
    assert.equal(refused(state, { t: "token.delete", tokenId: "gob1" }).code, "gone");
  });

  test("move and moveMany", () => {
    const state = apply(fresh(), { t: "token.move", tokenId: "gob1", x: 7.5, y: 2, elevation: 10, rotation: 90 });
    const g = state.tokens.gob1!;
    assert.deepEqual([g.x, g.y, g.elevation, g.rotation], [7.5, 2, 10, 90]);
    const many = apply(state, { t: "token.moveMany", moves: [{ tokenId: "gob1", x: 1, y: 1 }, { tokenId: "gob2", x: 2, y: 2 }] });
    assert.equal(many.tokens.gob1!.elevation, 10);
    assert.equal(many.tokens.gob2!.x, 2);
    assert.equal(refused(state, { t: "token.moveMany", moves: [{ tokenId: "gob1", x: 1, y: 1 }, { tokenId: "gob1", x: 2, y: 2 }] }).code, "invalid");
    assert.equal(refused(state, { t: "token.move", tokenId: "nope", x: 1, y: 1 }).code, "gone");
  });
});

describe("actors", () => {
  test("damage reaches the inline actor or the character behind a token, with a labeled log line", () => {
    const r = applyOp(fresh(), { t: "actor.hp", target: { tokenId: "gob1" }, change: { kind: "damage", amount: 4 } }, DM, env(1));
    assert.ok(r.ok);
    const inline = r.state.tokens.gob1!.actor;
    assert.ok("inline" in inline && inline.inline.hp.cur === 3);
    const { revert, ...line } = r.log[0]!.data as Extract<LogEvent, { type: "hp" }>;
    assert.deepEqual(line, { type: "hp", tokenId: "gob1", change: "damage", amount: 4, label: "Bloodied", left: { cur: 3, max: 7, temp: 0 } });
    assert.deepEqual([revert?.before.hp.cur, revert?.after.hp.cur], [7, 3], "the line keeps what the change replaced");
    const viaToken = applyOp(fresh(), { t: "actor.hp", target: { tokenId: "pc1" }, change: { kind: "damage", amount: 20 } }, DM, env(1));
    assert.ok(viaToken.ok);
    assert.equal(viaToken.state.characters.c1!.actor.life, "dying");
    assert.deepEqual(viaToken.touched, [keys.character("c1"), "log:1:0", "log:1:1"]);
    assert.deepEqual(viaToken.log[1]!.data, { type: "life", characterId: "c1", life: "dying" });
    assert.equal(refused(fresh(), { t: "actor.hp", target: { tokenId: "nope" }, change: { kind: "heal", amount: 1 } }).code, "gone");
  });

  test("an area's damage reaches every creature by the same rules, in one step", () => {
    const base = apply(fresh(), { t: "actor.hp", target: { characterId: "c1" }, change: { kind: "temp", amount: 5 } });
    // Fireball for 14: Goblin 1 failed its save, Goblin 2 and Ayla made theirs.
    const r = applyOp(
      base,
      { t: "actor.damageMany", hits: [{ target: { tokenId: "gob1" }, amount: 14 }, { target: { tokenId: "gob2" }, amount: 7 }, { target: { tokenId: "pc1" }, amount: 7 }] },
      DM,
      env(4),
    );
    assert.ok(r.ok);
    const hp = (id: string) => {
      const a = r.state.tokens[id]!.actor;
      return "inline" in a ? a.inline : r.state.characters[a.ref]!.actor;
    };
    assert.equal(hp("gob1").life, "dead");
    assert.equal(hp("gob2").hp.cur, 0);
    // Temporary HP goes first, as everywhere.
    assert.deepEqual(r.state.characters.c1!.actor.hp, { ...base.characters.c1!.actor.hp, temp: 0, cur: base.characters.c1!.actor.hp.cur - 2 });
    assert.deepEqual(
      r.log.filter((e) => e.data?.type === "hp").map((e) => e.data && "amount" in e.data && e.data.amount),
      [14, 7, 7],
    );
    // One inverse takes all of it back.
    const back = applyOp(r.state, { t: "sys.restore", entries: r.inverse!, from: "undo" }, DM, env(5));
    assert.ok(back.ok);
    assert.deepEqual(comparable({ ...back.state, log: [] }), comparable({ ...base, log: [] }));
  });

  test("an area's damage applies whole or not at all, and never hurts one creature twice", () => {
    assert.equal(refused(fresh(), { t: "actor.damageMany", hits: [{ target: { tokenId: "gob1" }, amount: 3 }, { target: { tokenId: "gone" }, amount: 3 }] }).code, "gone");
    const twice = refused(fresh(), { t: "actor.damageMany", hits: [{ target: { tokenId: "pc1" }, amount: 3 }, { target: { characterId: "c1" }, amount: 3 }] });
    assert.equal(twice.code, "invalid");
    assert.match(twice.message, /twice/);
  });

  test("heal, temp and set go through the same rules", () => {
    let state = apply(fresh(), { t: "actor.hp", target: { characterId: "c1" }, change: { kind: "set", cur: 0 } });
    assert.equal(state.characters.c1!.actor.life, "dying");
    state = apply(state, { t: "actor.hp", target: { characterId: "c1" }, change: { kind: "heal", amount: 3 } });
    assert.equal(state.characters.c1!.actor.life, "alive");
    assert.equal(state.characters.c1!.actor.hp.cur, 3);
    state = apply(state, { t: "actor.hp", target: { characterId: "c1" }, change: { kind: "temp", amount: 6 } });
    assert.equal(state.characters.c1!.actor.hp.temp, 6);
    const noop = applyOp(state, { t: "actor.hp", target: { characterId: "c1" }, change: { kind: "damage", amount: 0 } }, DM, env(9));
    assert.ok(noop.ok && noop.touched.length === 0);
  });

  test("death saves only while dying, and the DM's life changes", () => {
    assert.equal(refused(fresh(), { t: "actor.deathSave", target: { characterId: "c1" }, ok: 1, fail: 0 }).code, "invalid");
    let state = apply(fresh(), { t: "actor.life", target: { characterId: "c1" }, life: "dying" });
    const r = applyOp(state, { t: "actor.deathSave", target: { characterId: "c1" }, ok: 3, fail: 0 }, P1, env(2));
    assert.ok(r.ok);
    assert.equal(r.state.characters.c1!.actor.life, "stable");
    assert.deepEqual(r.log.map((e) => e.data?.type), ["deathSave", "life"]);
    state = apply(r.state, { t: "actor.life", target: { characterId: "c1" }, life: "alive" }, DM, 3);
    assert.equal(state.characters.c1!.actor.hp.cur, 1);
    assert.ok(!state.characters.c1!.actor.effects.some((e) => e.id === ZERO_HP_UNCONSCIOUS_ID));
  });

  test("effects: add resolves durations, incapacitation ends concentration, update and remove", () => {
    let state = fresh();
    state = apply(state, { t: "encounter.start", entries: [{ id: "n1", tokenId: "gob1", value: 10 }, { id: "n2", tokenId: "pc1", value: 5 }] });
    state = apply(state, { t: "encounter.next" }, DM, 2);
    state = apply(state, { t: "actor.effect.add", target: { tokenId: "gob1" }, effect: { id: "e1", key: "blessed", duration: { mode: "turnEnd", of: { tokenId: "gob1" } } } }, DM, 3);
    const gob = () => {
      const a = state.tokens.gob1!.actor;
      return "inline" in a ? a.inline : undefined;
    };
    assert.deepEqual(gob()!.effects[0]!.duration, { remaining: 2, boundary: "turnEnd", anchor: { entryId: "n1" } });
    state = apply(state, { t: "actor.effect.add", target: { tokenId: "gob1" }, effect: { id: "e2", key: "concentrating", spell: "Bless" } }, DM, 4);
    const r = applyOp(state, { t: "actor.effect.add", target: { tokenId: "gob1" }, effect: { id: "e3", key: "stunned", duration: { mode: "turnStart", of: { characterId: "c1" } } } }, DM, env(5));
    assert.ok(r.ok);
    state = r.state;
    assert.deepEqual(gob()!.effects.map((e) => e.id), ["e1", "e3"]);
    assert.deepEqual(gob()!.effects[1]!.duration, { remaining: 1, boundary: "turnStart", anchor: { entryId: "n2" } });
    assert.ok(r.log.some((e) => e.data?.type === "concentration" && e.data.ended));
    assert.equal(refused(state, { t: "actor.effect.add", target: { tokenId: "gob1" }, effect: { id: "e1", key: "blessed" } }).code, "invalid");
    state = apply(state, { t: "actor.effect.update", target: { tokenId: "gob1" }, effectId: "e1", patch: { label: "Bless", duration: null, level: 2 } }, DM, 6);
    assert.deepEqual(gob()!.effects[0], { id: "e1", key: "blessed", label: "Bless", level: 2 });
    state = apply(state, { t: "actor.effect.update", target: { tokenId: "gob1" }, effectId: "e1", patch: { label: null, duration: { mode: "rounds", rounds: 3, of: { entryId: "n1" } } } }, DM, 7);
    assert.deepEqual(gob()!.effects[0]!.duration, { remaining: 3, boundary: "turnStart", anchor: { entryId: "n1" } });
    assert.equal(gob()!.effects[0]!.label, undefined);
    const removed = applyOp(state, { t: "actor.effect.remove", target: { tokenId: "gob1" }, effectId: "e3" }, DM, env(8));
    assert.ok(removed.ok);
    assert.deepEqual(removed.log[0]!.data, { type: "effect", tokenId: "gob1", key: "stunned", action: "remove" });
    assert.equal(refused(state, { t: "actor.effect.remove", target: { tokenId: "gob1" }, effectId: "nope" }).code, "gone");
  });

  test("applies any Exhaustion level the protocol takes, as stored ops from before the 1 to 6 rule did", () => {
    // New ops are held to 1 to 6 where they arrive (permissions.ts). Replay must still apply the old ones as they were.
    const target = { characterId: "c1" };
    let state = apply(fresh(), { t: "actor.effect.add", target, effect: { id: "x", key: "exhaustion", level: 7 } });
    state = apply(state, { t: "actor.effect.add", target, effect: { id: "y", key: "exhaustion", level: 0 } }, DM, 2);
    state = apply(state, { t: "actor.effect.update", target, effectId: "x", patch: { level: null } }, DM, 3);
    assert.deepEqual(state.characters.c1!.actor.effects.map((e) => [e.id, e.level]), [["x", undefined], ["y", 0]]);
  });

  test("at most 32 effects per creature", () => {
    const state = fresh();
    state.characters.c1!.actor.effects = Array.from({ length: 32 }, (_, i) => effect(`e${i}`));
    assert.equal(refused(state, { t: "actor.effect.add", target: { characterId: "c1" }, effect: { id: "more", key: "blessed" } }).code, "quota");
  });
});

describe("characters, templates and drawings", () => {
  test("characters are created, patched and deleted with their tokens", () => {
    let state = apply(fresh(), { t: "character.create", character: { id: "c2", name: "Bo", size: "small", ownerIds: ["p2"], actor: actor() } });
    assert.equal(state.characters.c2!.rev, 1);
    assert.equal(refused(state, { t: "character.create", character: { id: "c2", name: "Bo", size: "small", ownerIds: [], actor: actor() } }).code, "invalid");
    const owners = applyOp(state, { t: "character.update", characterId: "c1", patch: { ownerIds: ["p1", "p2"], defaultImage: null, actor: { sheetUrl: "https://x.example" } } }, DM, env(2));
    assert.ok(owners.ok && owners.global);
    assert.equal(owners.state.characters.c1!.actor.sheetUrl, "https://x.example");
    // A level is set, changed and cleared like any optional field.
    const leveled = apply(apply(owners.state, { t: "character.update", characterId: "c1", patch: { level: 3 } }, DM, 3), { t: "character.update", characterId: "c1", patch: { level: 4 } }, DM, 4);
    assert.equal(leveled.characters.c1!.level, 4);
    assert.equal("level" in apply(leveled, { t: "character.update", characterId: "c1", patch: { level: null } }, DM, 5).characters.c1!, false);
    assert.equal(apply(fresh(), { t: "character.create", character: { id: "c3", name: "Cy", size: "medium", ownerIds: [], actor: actor(), level: 9 } }).characters.c3!.level, 9);
    // Known forms are set and replaced whole, and an empty list is stored as none, the other fields kept (docs/design-v1-known-forms.md 3.2).
    const known = apply(apply(leveled, { t: "character.update", characterId: "c1", patch: { knownForms: ["wolf", "owl"] } }, DM, 5), { t: "character.update", characterId: "c1", patch: { knownForms: ["black-bear", "wolf"] } }, DM, 6);
    assert.deepEqual(known.characters.c1!.knownForms, ["black-bear", "wolf"]);
    assert.equal(known.characters.c1!.level, 4);
    const forgotten = apply(known, { t: "character.update", characterId: "c1", patch: { knownForms: [] } }, DM, 7).characters.c1!;
    assert.equal("knownForms" in forgotten, false);
    assert.deepEqual({ ...forgotten, rev: 0 }, { ...leveled.characters.c1!, rev: 0 });
    state = apply(owners.state, { t: "encounter.start", entries: [{ id: "n1", characterId: "c1", value: 10 }, { id: "n2", tokenId: "pc1", value: 9 }] }, DM, 3);
    state = apply(state, { t: "character.delete", characterId: "c1" }, DM, 4);
    assert.equal(state.characters.c1, undefined);
    assert.equal(state.tokens.pc1, undefined);
    assert.equal(state.encounter!.entries.length, 0);
  });

  test("templates check their references and detach with null", () => {
    const base = fresh();
    const input = { id: "a1", sceneId: "s1", shape: "sphere" as const, size: 20, origin: { x: 1, y: 1, z: 0 }, yaw: 0, includeOrigin: true, color: "#ff0000", ownerId: "p1", visibility: "all" as const };
    assert.equal(refused(base, { t: "template.create", template: { ...input, attachedTo: "nope" } }).code, "gone");
    assert.equal(refused(base, { t: "template.create", template: { ...input, sceneId: "nope" } }).code, "gone");
    let state = apply(base, { t: "template.create", template: { ...input, attachedTo: "gob1", casterId: "pc1" } });
    assert.equal(refused(state, { t: "template.create", template: input }).code, "invalid");
    assert.match(refused(base, { t: "template.create", template: { ...input, sceneId: "s2", attachedTo: "gob1" } }).message, /token's scene/);
    state = apply(state, { t: "template.update", templateId: "a1", patch: { attachedTo: null, size: 30, label: "Fireball", anchor: "top" } });
    const a1 = state.templates.a1!;
    assert.equal(a1.attachedTo, undefined);
    assert.equal(a1.size, 30);
    assert.equal(a1.anchor, "top");
    assert.equal(refused(state, { t: "template.update", templateId: "a1", patch: { casterId: "nope" } }).code, "gone");
    const footprint = { w: 2, h: 2, elevation: 0, height: 10 };
    state = apply(state, { t: "template.update", templateId: "a1", patch: { footprint } });
    assert.deepEqual(state.templates.a1!.footprint, footprint);
    state = apply(state, { t: "template.update", templateId: "a1", patch: { footprint: null } });
    assert.equal("footprint" in state.templates.a1!, false);
    // A cone or line aims up or down, and null levels it again.
    state = apply(state, { t: "template.update", templateId: "a1", patch: { shape: "cone", pitch: 30 } });
    assert.equal(state.templates.a1!.pitch, 30);
    state = apply(state, { t: "template.update", templateId: "a1", patch: { pitch: null } });
    assert.equal("pitch" in state.templates.a1!, false);
    // Reminders when it hits a creature again, and null turns them off.
    state = apply(state, { t: "template.update", templateId: "a1", patch: { triggers: ["enter", "turnEnd"] } });
    assert.deepEqual(state.templates.a1!.triggers, ["enter", "turnEnd"]);
    state = apply(state, { t: "template.update", templateId: "a1", patch: { triggers: null } });
    assert.equal("triggers" in state.templates.a1!, false);
    state = apply(state, { t: "template.delete", templateId: "a1" });
    assert.equal(state.templates.a1, undefined);
    assert.equal(refused(state, { t: "template.delete", templateId: "a1" }).code, "gone");
  });

  test("an attached area moves to another scene with its token, and attaching across scenes is refused", () => {
    let state = fresh();
    state.templates.aura = template("aura", { attachedTo: "gob1", ownerId: "dm1" });
    state.templates.cast = template("cast", { casterId: "gob1", ownerId: "dm1" });
    state.tokens.gob3 = token("gob3", { sceneId: "s2" });
    const moved = applyOp(state, { t: "token.update", tokenId: "gob1", patch: { sceneId: "s2" } }, DM, env(1));
    assert.ok(moved.ok);
    assert.equal(moved.state.templates.aura!.sceneId, "s2");
    assert.equal(moved.state.templates.aura!.attachedTo, "gob1");
    assert.equal(moved.state.templates.cast!.sceneId, "s1");
    assert.ok(moved.touched.includes(keys.template("aura")));
    // Undo puts the area back with its token.
    const back = apply(moved.state, { t: "sys.restore", entries: moved.inverse!, from: "undo" }, DM, 2);
    assert.equal(back.templates.aura!.sceneId, "s1");
    state = moved.state;
    assert.equal(refused(state, { t: "template.update", templateId: "cast", patch: { attachedTo: "gob3" } }).code, "invalid");
    state = apply(state, { t: "template.update", templateId: "aura", patch: { attachedTo: "gob3" } }, DM, 3);
    assert.equal(state.templates.aura!.attachedTo, "gob3");
  });

  test("drawings are created, deleted and cleared by owner or scene", () => {
    const d = (id: string, ownerId: string) => ({ id, sceneId: "s1", kind: "line" as const, points: [0, 0, 1, 1], style: { stroke: "#ffffff", width: 1, opacity: 1 }, ownerId, visibility: "all" as const });
    let state = apply(fresh(), { t: "drawing.create", drawing: d("d1", "p1") });
    state = apply(state, { t: "drawing.create", drawing: d("d2", "p2") });
    state = apply(state, { t: "drawing.create", drawing: d("d3", "p1") });
    assert.equal(refused(state, { t: "drawing.create", drawing: d("d1", "p1") }).code, "invalid");
    const own = apply(state, { t: "drawing.clear", sceneId: "s1", scope: "own" }, P1);
    assert.deepEqual(Object.keys(own.drawings), ["d2"]);
    const all = apply(state, { t: "drawing.clear", sceneId: "s1", scope: "all" });
    assert.deepEqual(all.drawings, {});
    state = apply(state, { t: "drawing.delete", drawingId: "d2" });
    assert.equal(state.drawings.d2, undefined);
    assert.equal(refused(state, { t: "drawing.delete", drawingId: "d2" }).code, "gone");
  });

  test("range rings are kept nearest first and each once, and an empty list takes them away", () => {
    let state = fresh();
    const id = Object.keys(state.tokens)[0]!;
    state = apply(state, { t: "token.update", tokenId: id, patch: { rangeRings: [120, 30, 60, 30] } });
    assert.deepEqual(state.tokens[id]!.rangeRings, [30, 60, 120]);
    state = apply(state, { t: "token.update", tokenId: id, patch: { rangeRings: [] } });
    assert.ok(!("rangeRings" in state.tokens[id]!));
  });

  test("a kept ruler has two stops or more and one anchor, token or none, for each", () => {
    const ruler = (points: number[], anchors?: (string | null)[]) => ({
      id: "k1",
      sceneId: "s1",
      kind: "ruler" as const,
      points,
      style: { stroke: "#ffffff", width: 3, opacity: 1 },
      ownerId: "dm1",
      visibility: "dm" as const,
      ...(anchors ? { anchors } : {}),
    });
    const kept = apply(fresh(), { t: "drawing.create", drawing: ruler([0.5, 0.5, 4.5, 0.5], ["t1", null]) });
    assert.deepEqual(kept.drawings.k1!.anchors, ["t1", null]);
    apply(fresh(), { t: "drawing.create", drawing: ruler([0.5, 0.5, 4.5, 0.5, 4.5, 3.5]) });
    assert.equal(refused(fresh(), { t: "drawing.create", drawing: ruler([0.5, 0.5]) }).code, "invalid", "one stop measures nothing");
    assert.equal(refused(fresh(), { t: "drawing.create", drawing: ruler([0.5, 0.5, 4.5]) }).code, "invalid", "half a stop");
    assert.equal(refused(fresh(), { t: "drawing.create", drawing: ruler([0.5, 0.5, 4.5, 0.5], ["t1"]) }).code, "invalid");
    const line = { ...ruler([0, 0, 1, 1], ["t1", null]), kind: "line" as const };
    assert.equal(refused(fresh(), { t: "drawing.create", drawing: line }).code, "invalid", "only a ruler stands on tokens");
  });

  test("a kept ruler names one ground height per stop, 0 on a token, and keeps it through a repaint and a reveal", () => {
    const ruler = (z: number[], anchors?: (string | null)[]) => ({
      id: "k1",
      sceneId: "s1",
      kind: "ruler" as const,
      points: [0.5, 0.5, 4.5, 0.5, 4.5, 3.5],
      style: { stroke: "#ffffff", width: 3, opacity: 1 },
      ownerId: "dm1",
      visibility: "all" as const,
      z,
      ...(anchors ? { anchors } : {}),
    });
    let state = apply(fresh(), { t: "drawing.create", drawing: ruler([0, 10, -5], ["pc1", null, null]) });
    assert.deepEqual(state.drawings.k1!.z, [0, 10, -5]);
    assert.equal(refused(fresh(), { t: "drawing.create", drawing: ruler([0, 10]) }).code, "invalid", "one height short");
    assert.equal(refused(fresh(), { t: "drawing.create", drawing: ruler([0, 10, 0, 0]) }).code, "invalid", "one height over");
    assert.equal(refused(fresh(), { t: "drawing.create", drawing: ruler([5, 10, 0], ["pc1", null, null]) }).code, "invalid", "a stop on a token stands on no ground");
    const line = { ...ruler([0, 10, 0]), kind: "line" as const };
    assert.equal(refused(fresh(), { t: "drawing.create", drawing: line }).code, "invalid", "only a ruler stands on the ground");

    // The ruler keeps the heights it was measured with, whatever the ground and the fog do after.
    state = apply(state, { t: "build.height", sceneId: "s1", cells: ["4,0", "4,3"], height: 20 }, DM, 2);
    state = apply(state, { t: "fog.reset", sceneId: "s1", to: "revealed" }, DM, 3);
    assert.deepEqual(state.drawings.k1!.z, [0, 10, -5]);
  });
});

describe("fog", () => {
  const rect = (id: string, x: number) => ({ id, mode: "reveal" as const, shape: { kind: "rect" as const, x, y: 10, w: 2, h: 2 } });

  test("drafts collect, replace and remove ops, and vanish when empty", () => {
    let state = apply(fresh(), { t: "fog.draft", sceneId: "s1", add: [rect("a", 10), rect("b", 14)] });
    assert.equal(state.fogDrafts.s1!.ops.length, 2);
    state = apply(state, { t: "fog.draft", sceneId: "s1", add: [{ ...rect("a", 20) }], remove: ["b"] });
    assert.deepEqual(state.fogDrafts.s1!.ops.map((o) => [o.id, (o.shape as { x: number }).x]), [["a", 20]]);
    const r = applyOp(state, { t: "fog.draft", sceneId: "s1", remove: ["a"] }, DM, env(3));
    assert.ok(r.ok && !r.global);
    assert.equal(r.state.fogDrafts.s1, undefined);
    const big = fresh();
    big.fogDrafts.s1 = { sceneId: "s1", rev: 0, ops: Array.from({ length: 500 }, (_, i) => rect(`r${i}`, 1)) };
    assert.equal(refused(big, { t: "fog.draft", sceneId: "s1", add: [rect("more", 1)] }).code, "quota");
  });

  test("publish rasterizes the draft into the tiles in order and empties it", () => {
    let state = apply(fresh(), { t: "fog.draft", sceneId: "s1", add: [rect("a", 10), { id: "b", mode: "hide", shape: { kind: "rect", x: 10, y: 10, w: 1, h: 2 } }] });
    assert.ok(isTokenFullyFogged(state.fogTiles, "s1", token("t", { x: 11, y: 10 })));
    const r = applyOp(state, { t: "fog.publish", sceneId: "s1" }, DM, env(2));
    assert.ok(r.ok && r.global);
    state = r.state;
    assert.equal(state.fogDrafts.s1, undefined);
    assert.ok(!isTokenFullyFogged(state.fogTiles, "s1", token("t", { x: 11, y: 10 })));
    assert.ok(isTokenFullyFogged(state.fogTiles, "s1", token("t", { x: 10, y: 10 })));
    assert.equal(refused(state, { t: "fog.publish", sceneId: "s1" }).code, "invalid");
    const discard = apply(apply(state, { t: "fog.draft", sceneId: "s1", add: [rect("c", 30)] }), { t: "fog.discard", sceneId: "s1" });
    assert.equal(discard.fogDrafts.s1, undefined);
  });

  test("live applies at once, and reset fills or empties the scene", () => {
    let state = apply(fresh(), { t: "fog.live", sceneId: "s1", ops: [rect("a", 20)] });
    assert.ok(!isTokenFullyFogged(state.fogTiles, "s1", token("t", { x: 20, y: 10 })));
    const all = applyOp(state, { t: "fog.reset", sceneId: "s1", to: "revealed" }, DM, env(2));
    assert.ok(all.ok && all.global);
    assert.equal(Object.keys(all.state.fogTiles).length, 6);
    assert.ok(Object.values(all.state.fogTiles).some((t) => t.bits === FULL_TILE));
    const again = applyOp(all.state, { t: "fog.reset", sceneId: "s1", to: "revealed" }, DM, env(3));
    assert.ok(again.ok && again.touched.length === 0);
    state = apply(all.state, { t: "fog.reset", sceneId: "s1", to: "hidden" }, DM, 4);
    assert.deepEqual(state.fogTiles, {});
  });
});

describe("builder", () => {
  test("paint and erase write chunked cells and bump the walls version", () => {
    let state = apply(fresh(), { t: "build.paint", sceneId: "s1", terrain: "stone", cells: ["1,1", "2,1", "17,1"] });
    assert.deepEqual(state.buildChunks["s1:0,0"]!.cells, { "1,1": "stone", "2,1": "stone" });
    assert.deepEqual(state.buildChunks["s1:1,0"]!.cells, { "17,1": "stone" });
    assert.equal(state.scenes.s1!.wallsVersion, 1);
    state = apply(state, { t: "build.erase", sceneId: "s1", cells: ["17,1", "1,1"] });
    assert.equal(state.buildChunks["s1:1,0"], undefined);
    assert.deepEqual(state.buildChunks["s1:0,0"]!.cells, { "2,1": "stone" });
    assert.equal(state.scenes.s1!.wallsVersion, 2);
    assert.equal(refused(state, { t: "build.paint", sceneId: "s1", terrain: "stone", cells: ["99,1"] }).code, "invalid");
  });

  test("rect and poly fill cells, bounded by the per-op cap", () => {
    const state = apply(fresh(), { t: "build.rect", sceneId: "s1", terrain: "wood", x: 14, y: 0, w: 4, h: 2 });
    assert.equal(Object.keys(state.buildChunks["s1:0,0"]!.cells).length, 4);
    assert.equal(Object.keys(state.buildChunks["s1:1,0"]!.cells).length, 4);
    assert.equal(refused(fresh(), { t: "build.rect", sceneId: "s1", terrain: "wood", x: 0, y: 0, w: 50, h: 50 }).code, "quota");
    const poly = apply(fresh(), { t: "build.poly", sceneId: "s1", terrain: "grass", points: [0, 0, 4, 0, 4, 4, 0, 4] });
    assert.equal(Object.keys(poly.buildChunks["s1:0,0"]!.cells).length, 16);
    const erased = apply(poly, { t: "build.poly", sceneId: "s1", terrain: null, points: [0, 0, 4, 0, 4, 4, 0, 4] });
    assert.equal(erased.buildChunks["s1:0,0"], undefined);
  });

  test("erase takes the edges on every side of a cell and the labels whose text covers it, across chunk borders", () => {
    const door = { kind: "door", state: "closed", secret: false, discovered: false } as const;
    let state = apply(fresh(), { t: "build.rect", sceneId: "s1", terrain: "stone", x: 14, y: 0, w: 4, h: 3 });
    state = apply(state, {
      t: "build.edge",
      sceneId: "s1",
      edges: [
        // Around cell 15,1: its north and west sides, and its south and east sides filed under the neighbors.
        { key: "15,1,n", feature: door },
        { key: "15,1,w", feature: { kind: "window" } },
        { key: "15,2,n", feature: { kind: "none" } },
        { key: "16,1,w", feature: { kind: "wall" } },
        // Not a side of any erased cell.
        { key: "14,0,w", feature: door },
      ],
    });
    state = apply(state, { t: "build.label", sceneId: "s1", labelId: "in", label: { x: 15.5, y: 1.4, text: "Altar", size: 0.7 } });
    // Anchored two cells west, but its text reaches into 15,1.
    state = apply(state, { t: "build.label", sceneId: "s1", labelId: "over", label: { x: 13.5, y: 1.5, text: "Great hall", size: 0.7 } });
    state = apply(state, { t: "build.label", sceneId: "s1", labelId: "out", label: { x: 12.5, y: 1.5, text: "Hi", size: 0.45 } });
    const erased = apply(state, { t: "build.erase", sceneId: "s1", cells: ["15,1"] });
    assert.deepEqual(erased.buildChunks["s1:0,0"]!.edges, { "14,0,w": door });
    assert.deepEqual(erased.buildChunks["s1:1,0"]!.edges, {});
    assert.equal(erased.buildChunks["s1:0,0"]!.cells["15,1"], undefined);
    assert.deepEqual(Object.keys(erased.labels), ["out"]);
    // A cell with nothing left in it but a door still loses the door.
    const rock = apply(apply(state, { t: "build.rect", sceneId: "s1", terrain: null, x: 14, y: 0, w: 1, h: 1 }), {
      t: "build.edge",
      sceneId: "s1",
      edges: [{ key: "14,0,w", feature: door }],
    });
    const cleared = apply(rock, { t: "build.erase", sceneId: "s1", cells: ["14,0"] });
    assert.equal(cleared.buildChunks["s1:0,0"]!.edges["14,0,w"], undefined);
    // A rectangle or polygon erase clears the same way.
    const rect = apply(state, { t: "build.rect", sceneId: "s1", terrain: null, x: 15, y: 1, w: 1, h: 1 });
    assert.deepEqual(rect.buildChunks, erased.buildChunks);
    assert.deepEqual(rect.labels, erased.labels);
    const poly = apply(state, { t: "build.poly", sceneId: "s1", terrain: null, points: [15, 1, 16, 1, 16, 2, 15, 2] });
    assert.deepEqual(poly.buildChunks, erased.buildChunks);
    assert.deepEqual(poly.labels, erased.labels);
    // A rectangle erase over a label's text, with no floor under it, takes the label too.
    const area = apply(state, { t: "build.rect", sceneId: "s1", terrain: null, x: 10, y: 1, w: 3, h: 1 });
    assert.deepEqual(Object.keys(area.labels).sort(), ["in"]);
    // Painting keeps every edge and label.
    const painted = apply(state, { t: "build.paint", sceneId: "s1", terrain: "wood", cells: ["15,1"] });
    assert.equal(Object.keys(painted.buildChunks["s1:0,0"]!.edges).length, 4);
    assert.equal(Object.keys(painted.labels).length, 3);
  });

  test("an erase stays cheap on a scene full of the largest labels", () => {
    // 500 labels of 80 characters at size 20 each cover about 20,000 cells.
    const big = (y: number) => ({ text: "W".repeat(MAX_NAME), size: 20, x: 100, y });
    const withLabels = (make: (i: number) => { x: number; y: number; text: string; size: number }) => {
      const state = room({ scenes: { s1: scene("s1", { bounds: { w: 200, h: 200 } }) } });
      for (let i = 0; i < LIMITS.labelsPerScene; i++) state.labels[`l${i}`] = { id: `l${i}`, rev: 0, sceneId: "s1", ...make(i) };
      return state;
    };
    // Two columns of 1,000 cells each at the scene's west and east edges, so the cells span the whole scene.
    const columns: string[] = [];
    for (let y = 0; y < 100; y++) for (let x = 0; x < 10; x++) columns.push(`${x},${y}`, `${190 + x},${y}`);
    const cases = [
      { name: "labels far from the cells", state: withLabels(() => big(-900)), cells: columns, left: LIMITS.labelsPerScene },
      { name: "labels over the cells", state: withLabels((i) => big(i % 100)), cells: columns, left: 0 },
      // Small labels between the columns: every label against every cell, the most work the test can make.
      { name: "labels between the cells", state: withLabels((i) => ({ text: "Hall", size: 0.5, x: 100, y: 0.5 + (i % 100) })), cells: columns, left: LIMITS.labelsPerScene },
    ];
    // Each case is timed against the same erase on a scene with no labels,
    // run in turn with it in this process, and each takes its fastest of
    // five runs. A machine busy with other work slows both, so the ratio
    // holds where a fixed budget in milliseconds failed under parallel
    // test runs. Listing every cell of every label took about 400 ms, over
    // 100 times the bare erase, and the cases take 1 to 4 times it now.
    const bare = room({ scenes: { s1: scene("s1", { bounds: { w: 200, h: 200 } }) } });
    const erase = (state: RoomState, cells: string[] = columns) => {
      const started = performance.now();
      const erased = apply(state, { t: "build.erase", sceneId: "s1", cells });
      return { erased, ms: performance.now() - started };
    };
    for (const c of cases) {
      let base = Number.POSITIVE_INFINITY;
      let ms = Number.POSITIVE_INFINITY;
      for (let run = 0; run < 5; run++) {
        base = Math.min(base, erase(bare).ms);
        const timed = erase(c.state, c.cells);
        ms = Math.min(ms, timed.ms);
        if (run === 0) assert.equal(Object.keys(timed.erased.labels).length, c.left, c.name);
      }
      // The floor keeps a very fast bare erase from making the bound too tight to mean anything.
      const bound = Math.max(30, base * 25);
      assert.ok(ms < bound, `${c.name}: took ${ms.toFixed(1)} ms, the bare erase ${base.toFixed(1)} ms`);
    }
  });

  test("edges, labels and clear", () => {
    let state = apply(fresh(), { t: "build.edge", sceneId: "s1", edges: [{ key: "1,1,n", feature: { kind: "wall" } }, { key: "1,1,w", feature: { kind: "door", state: "closed", secret: false, discovered: false } }] });
    assert.equal(Object.keys(state.buildChunks["s1:0,0"]!.edges).length, 2);
    state = apply(state, { t: "build.edge", sceneId: "s1", edges: [{ key: "1,1,n", feature: null }] });
    assert.deepEqual(Object.keys(state.buildChunks["s1:0,0"]!.edges), ["1,1,w"]);
    assert.equal(state.scenes.s1!.wallsVersion, 2);
    state = apply(state, { t: "build.label", sceneId: "s1", labelId: "l1", label: { x: 1, y: 2, text: "Hall", size: 1 } });
    assert.equal(state.labels.l1!.text, "Hall");
    state = apply(state, { t: "build.label", sceneId: "s1", labelId: "l1", label: { x: 1, y: 2, text: "Great hall", size: 2 } });
    assert.equal(state.labels.l1!.rev, 2);
    assert.equal(refused(state, { t: "build.label", sceneId: "s2", labelId: "l1", label: { x: 0, y: 0, text: "x", size: 1 } }).code, "invalid");
    state = apply(state, { t: "build.clear", sceneId: "s1" });
    assert.deepEqual([state.buildChunks, state.labels], [{}, {}]);
    assert.equal(state.scenes.s1!.wallsVersion, 3);
  });
});

describe("encounter", () => {
  test("start sorts rows, fills scores when asked, binds paused durations and clears the history", () => {
    const state = fresh();
    state.meta.settings.monsterInitScore = true;
    state.characters.c1!.actor.effects = [effect("e1", { duration: { remaining: 2, boundary: "turnStart", anchor: { characterId: "c1" } } })];
    state.encounterHistory = [{ encounter: { rev: 0, round: 1, activeEntryId: null, entries: [] }, effects: {}, revealed: [], at: AT }];
    const r = applyOp(state, { t: "encounter.start", entries: [{ id: "n1", tokenId: "pc1", value: 10 }, { id: "n2", tokenId: "gob1" }, { id: "n3", tokenId: "gob2" }, { id: "n4", label: "Lair" }] }, DM, env(1));
    assert.ok(r.ok);
    const enc = r.state.encounter!;
    assert.deepEqual(enc.entries.map((e) => [e.id, e.value, e.tieOrder]), [["n2", 12, 0], ["n1", 10, 1], ["n3", null, 2], ["n4", null, 3]]);
    assert.equal(enc.entries[0]!.groupKey, "Goblin");
    assert.equal(enc.entries[1]!.groupKey, undefined);
    assert.equal(enc.round, 1);
    assert.equal(enc.activeEntryId, null);
    assert.deepEqual(r.state.characters.c1!.actor.effects[0]!.duration!.anchor, { entryId: "n1" });
    assert.deepEqual(r.state.encounterHistory, []);
    assert.deepEqual(r.log[0]!.data, { type: "encounter", action: "start" });
    assert.equal(refused(r.state, { t: "encounter.start", entries: [] }).code, "invalid");
  });

  test("add defaults hidden from the token, refuses duplicates and binds durations", () => {
    let state = fresh();
    state.tokens.gob2!.visibility = "dm";
    state = apply(state, { t: "encounter.start", entries: [] });
    state = apply(state, { t: "actor.effect.add", target: { tokenId: "gob1" }, effect: { id: "e1", key: "blessed", duration: { mode: "turnEnd", of: { tokenId: "gob2" } } } }, DM, 2);
    state = apply(state, { t: "encounter.add", entries: [{ id: "n1", tokenId: "gob2", value: 7 }] }, DM, 3);
    assert.equal(state.encounter!.entries[0]!.hidden, true);
    const a = state.tokens.gob1!.actor;
    assert.ok("inline" in a);
    assert.deepEqual(a.inline.effects[0]!.duration!.anchor, { entryId: "n1" });
    assert.equal(refused(state, { t: "encounter.add", entries: [{ id: "n1", tokenId: "gob1" }] }).code, "invalid");
    assert.equal(refused(state, { t: "encounter.add", entries: [{ id: "n9", tokenId: "nope" }] }).code, "gone");
    assert.equal(refused(fresh(), { t: "encounter.add", entries: [{ id: "n9", tokenId: "gob1" }] }).code, "gone");
  });

  test("next ticks durations, expires them with a log line, resets per-turn resources and counts rounds", () => {
    let state = fresh();
    const gobActor = state.tokens.gob1!.actor;
    if ("inline" in gobActor) gobActor.inline.legendary = { actionsMax: 3, actionsUsed: 2, resistMax: 3, resistUsed: 1 };
    state = apply(state, { t: "encounter.start", entries: [{ id: "n1", tokenId: "pc1", value: 20 }, { id: "n2", tokenId: "gob1", value: 10 }] });
    state = apply(state, { t: "encounter.update", entryId: "n2", patch: { reactionUsed: true } }, DM, 2);
    // Applied during nobody's turn: "end of the goblin's next turn" is one crossing.
    state = apply(state, { t: "actor.effect.add", target: { characterId: "c1" }, effect: { id: "e1", key: "blessed", duration: { mode: "turnEnd", of: { tokenId: "gob1" } } } }, DM, 3);
    state = apply(state, { t: "encounter.next" }, DM, 4);
    assert.equal(state.encounter!.activeEntryId, "n1");
    assert.equal(state.encounter!.round, 1);
    // Applied during the PC's own turn: "end of my next turn" needs two crossings.
    state = apply(state, { t: "actor.effect.add", target: { characterId: "c1" }, effect: { id: "e2", key: "hasted", duration: { mode: "turnEnd", of: { entryId: "n1" } } } }, DM, 5);
    assert.equal(state.characters.c1!.actor.effects[1]!.duration!.remaining, 2);
    const toGoblin = applyOp(state, { t: "encounter.next" }, DM, env(6));
    assert.ok(toGoblin.ok);
    state = toGoblin.state;
    assert.equal(state.encounter!.activeEntryId, "n2");
    assert.equal(state.encounter!.entries.find((e) => e.id === "n2")!.reactionUsed, false);
    const g = state.tokens.gob1!.actor;
    assert.ok("inline" in g && g.inline.legendary!.actionsUsed === 0 && g.inline.legendary!.resistUsed === 1);
    assert.equal(state.characters.c1!.actor.effects[1]!.duration!.remaining, 1);
    assert.deepEqual(toGoblin.log.map((e) => e.data?.type), ["turn"]);
    const wrap = applyOp(state, { t: "encounter.next" }, DM, env(7));
    assert.ok(wrap.ok);
    state = wrap.state;
    assert.equal(state.encounter!.round, 2);
    assert.equal(state.encounter!.activeEntryId, "n1");
    assert.deepEqual(state.characters.c1!.actor.effects.map((e) => e.id), ["e2"]);
    assert.ok(wrap.log.some((e) => e.data?.type === "effect" && e.data.action === "expire" && e.data.key === "blessed"));
    assert.equal(state.encounterHistory.length, 3);
    const prev = applyOp(state, { t: "encounter.prev" }, DM, env(8));
    assert.ok(prev.ok);
    // Previous is logged as taking back the turn that started, so the same turn starting again never reads as a repeat,
    // and names the turn it resumed: the goblin's, out of players' sight under the fog.
    assert.deepEqual(prev.log.map((e) => e.data), [{ type: "turn", entryId: "n1", round: 2, back: true, seen: true, to: "n2" }]);
    const back = prev.state;
    assert.equal(back.encounter!.round, 1);
    assert.equal(back.encounter!.activeEntryId, "n2");
    assert.deepEqual(back.characters.c1!.actor.effects.map((e) => [e.id, e.duration?.remaining]), [["e1", 1], ["e2", 1]]);
    assert.equal(back.encounterHistory.length, 2);
  });

  test("prev gives back the legendary actions next reset", () => {
    let state = fresh();
    const gobActor = state.tokens.gob1!.actor;
    if ("inline" in gobActor) gobActor.inline.legendary = { actionsMax: 3, actionsUsed: 2, resistMax: 3, resistUsed: 1 };
    state = apply(state, { t: "encounter.start", entries: [{ id: "n1", tokenId: "pc1", value: 20 }, { id: "n2", tokenId: "gob1", value: 10 }] });
    state = apply(state, { t: "encounter.next" }, DM, 2);
    state = apply(state, { t: "encounter.next" }, DM, 3);
    const used = (s: typeof state) => {
      const a = s.tokens.gob1!.actor;
      return "inline" in a ? a.inline.legendary?.actionsUsed : undefined;
    };
    assert.equal(used(state), 0);
    assert.deepEqual(state.encounterHistory.at(-1)!.legendary, { holderId: "gob1", actionsUsed: 2 });
    const back = apply(state, { t: "encounter.prev" }, DM, 4);
    assert.equal(back.encounter!.activeEntryId, "n1");
    assert.equal(used(back), 2);
    // A history step from before the field existed still walks back.
    const old = deepClone(state);
    delete old.encounterHistory.at(-1)!.legendary;
    assert.equal(used(apply(old, { t: "encounter.prev" }, DM, 4)), 0);
  });

  test("next reveals a hidden combatant on its turn, even under fog, and prev hides it again", () => {
    let state = fresh();
    state.tokens.gob1!.visibility = "dm";
    state.tokens.gob1!.x = 30;
    assert.ok(isTokenFullyFogged(state.fogTiles, "s1", state.tokens.gob1!));
    state = apply(state, { t: "encounter.start", entries: [{ id: "n1", tokenId: "gob1", value: 20 }] });
    assert.equal(state.encounter!.entries[0]!.hidden, true);
    state = apply(state, { t: "encounter.next" }, DM, 2);
    assert.equal(state.encounter!.entries[0]!.hidden, false);
    assert.equal(state.tokens.gob1!.visibility, "all");
    assert.equal(state.tokens.gob1!.fogExemptAuto, true);
    assert.deepEqual(state.encounterHistory[0]!.revealed, [{ tokenId: "gob1", visibility: "dm", fogExemptAuto: false }]);
    const prev = applyOp(state, { t: "encounter.prev" }, DM, env(3));
    assert.ok(prev.ok);
    // Marked from before the undo, like the turn line it takes back: unseen, as the revealed goblin stands in the fog.
    assert.deepEqual(prev.log.map((e) => e.data), [{ type: "turn", entryId: "n1", round: 1, back: true }]);
    const back = prev.state;
    assert.equal(back.encounter!.entries[0]!.hidden, true);
    assert.equal(back.tokens.gob1!.visibility, "dm");
    assert.equal(back.tokens.gob1!.fogExemptAuto, false);
    assert.equal(refused(back, { t: "encounter.prev" }).code, "invalid");
    const off = fresh();
    off.meta.settings.revealHiddenOnTurn = false;
    off.tokens.gob1!.visibility = "dm";
    const kept = apply(apply(off, { t: "encounter.start", entries: [{ id: "n1", tokenId: "gob1", value: 20 }] }), { t: "encounter.next" }, DM, 2);
    assert.equal(kept.encounter!.entries[0]!.hidden, true);
    assert.equal(kept.tokens.gob1!.visibility, "dm");
  });

  test("next stamps the expiry lines of a creature it reveals as players see it, like its turn line", () => {
    const lines = (at: { x: number; y: number }) => {
      let state = fresh();
      state.tokens.gob1 = { ...state.tokens.gob1!, ...at, visibility: "dm" };
      state = apply(state, { t: "encounter.start", entries: [{ id: "n1", tokenId: "pc1", value: 20 }, { id: "n2", tokenId: "gob1", value: 10 }] });
      state = apply(state, { t: "encounter.next" }, DM, 2);
      state = apply(state, { t: "actor.effect.add", target: { tokenId: "gob1" }, effect: { id: "e1", key: "blessed", duration: { mode: "turnStart", of: { tokenId: "gob1" } } } }, DM, 3);
      const r = applyOp(state, { t: "encounter.next" }, DM, env(4));
      assert.ok(r.ok);
      assert.equal(r.state.tokens.gob1!.visibility, "all");
      const expiry = r.log.find((e) => e.data?.type === "effect" && e.data.action === "expire");
      const turn = r.log.find((e) => e.data?.type === "turn");
      assert.ok(expiry?.data?.type === "effect" && turn?.data?.type === "turn");
      return [turn.data.seen, expiry.data.seen];
    };
    // The reveal comes before the tick, so on revealed ground both lines are seen, though the goblin was hidden until then.
    assert.deepEqual(lines({ x: 2, y: 2 }), [true, true]);
    // In the fog the reveal shows players nothing, so neither line is seen (decided 2026-10-14).
    assert.deepEqual(lines({ x: 5, y: 5 }), [undefined, undefined]);
  });

  test("a creature revealed in the fog is marked unseen until it walks into view, and an op stored before op version 4 marks as it did then", () => {
    const fight = (opVersion?: number) => {
      const at = (seq: number) => ({ ...env(seq), ...(opVersion === undefined ? {} : { opVersion }) });
      const step = (state: RoomState, op: Op, seq: number) => {
        const r = applyOp(state, op, DM, at(seq));
        assert.ok(r.ok);
        return r;
      };
      let state = fresh();
      state.tokens.gob1 = { ...state.tokens.gob1!, x: 30, y: 20, visibility: "dm" };
      state = step(state, { t: "encounter.start", entries: [{ id: "n1", tokenId: "pc1", value: 20 }, { id: "n2", tokenId: "gob1", value: 10 }] }, 1).state;
      state = step(state, { t: "encounter.next" }, 2).state;
      const next = step(state, { t: "encounter.next" }, 3);
      const hp = step(next.state, { t: "actor.hp", target: { tokenId: "gob1" }, change: { kind: "damage", amount: 1 } }, 4);
      const inFog = step(hp.state, { t: "token.move", tokenId: "gob1", x: 29, y: 20 }, 5).state;
      const inView = step(inFog, { t: "token.move", tokenId: "gob1", x: 3, y: 3 }, 6).state;
      return {
        start: next.state.encounter!.turnStart!.seen,
        turn: next.log.find((e) => e.data?.type === "turn")!.data!,
        hp: hp.log[0]!.data!,
        stops: inView.tokens.gob1!.path!.stops.map((stop) => stop.seen ?? false),
      };
    };
    const live = fight();
    assert.equal(live.start, undefined, "where its turn began");
    assert.equal("seen" in live.turn, false, "its turn line");
    assert.equal("seen" in live.hp, false, "the damage it took in the fog");
    assert.deepEqual(live.stops, [false, false, true], "only the stop in view");
    // Replay hands the reducer a stored op's version, and an older op keeps the old rule, so it replays to the same state.
    const stored = fight(3);
    assert.equal(stored.start, true);
    assert.equal("seen" in stored.turn, true);
    assert.equal("seen" in stored.hp, true);
    assert.deepEqual(stored.stops, [true, true, true]);
    assert.deepEqual(fight(4), live, "today's version marks as a live op does");
  });

  test("next skips the defeated and keeps at most 20 history steps", () => {
    let state = fresh();
    state = apply(state, { t: "encounter.start", entries: [{ id: "n1", tokenId: "pc1", value: 20 }, { id: "n2", tokenId: "gob1", value: 10 }, { id: "n3", tokenId: "gob2", value: 5 }] });
    state = apply(state, { t: "actor.life", target: { tokenId: "gob1" }, life: "dead" }, DM, 2);
    state = apply(state, { t: "encounter.next" }, DM, 3);
    state = apply(state, { t: "encounter.next" }, DM, 4);
    assert.equal(state.encounter!.activeEntryId, "n3");
    // A dead player character has no turn either, so Next passes over its row as over a monster's.
    state = apply(state, { t: "actor.life", target: { characterId: "c1" }, life: "dead" }, DM, 5);
    state = apply(state, { t: "encounter.next" }, DM, 6);
    assert.equal(state.encounter!.activeEntryId, "n3", "every other row is dead, so the turn comes back round");
    assert.equal(state.encounter!.round, 2);
    for (let i = 0; i < 30; i++) state = apply(state, { t: "encounter.next" }, DM, 10 + i);
    assert.equal(state.encounterHistory.length, MAX_HISTORY);
    assert.equal(refused(apply(fresh(), { t: "encounter.start", entries: [] }), { t: "encounter.next" }).code, "invalid");
  });

  test("a Next or Previous naming a turn that is already over changes nothing, so a late press never skips a creature", () => {
    let state = fresh();
    state = apply(state, { t: "encounter.start", entries: [{ id: "n1", tokenId: "pc1", value: 20 }, { id: "n2", tokenId: "gob1", value: 10 }, { id: "n3", tokenId: "gob2", value: 5 }] });
    const turn = (entry: string | null, round = 1) => ({ entry, round });
    const unchanged = (op: Op, who = DM, from = state) => {
      const r = applyOp(from, op, who, env(50));
      assert.ok(r.ok, `${op.t} was refused`);
      assert.deepEqual(r.touched, [], `${op.t} wrote something`);
      assert.deepEqual(r.log, []);
      assert.deepEqual(r.state, from);
    };
    // Start ends no turn. Pressed twice, the fight starts on the first row, not the second.
    state = apply(state, { t: "encounter.next", from: turn(null) }, DM, 2);
    assert.equal(state.encounter!.activeEntryId, "n1");
    unchanged({ t: "encounter.next", from: turn(null) });
    // Ayla's player ends her turn as the DM presses Next, from another device or twice on one: one turn passes.
    state = apply(state, { t: "encounter.next", from: turn("n1") }, P1, 3);
    assert.equal(state.encounter!.activeEntryId, "n2");
    unchanged({ t: "encounter.next", from: turn("n1") });
    unchanged({ t: "encounter.next", from: turn("n1") }, P1);
    // A player's press ends only their own turn, whatever it names, so naming the goblin's does nothing either.
    unchanged({ t: "encounter.next", from: turn("n2") }, P1);
    // Previous the same way: a second press for the same turn does not walk back two.
    state = apply(state, { t: "encounter.prev", from: turn("n2") }, DM, 4);
    assert.equal(state.encounter!.activeEntryId, "n1");
    unchanged({ t: "encounter.prev", from: turn("n2") });
    // A press that arrives after the fight ended has no turn left to end.
    unchanged({ t: "encounter.next", from: turn("n1") }, P1, apply(state, { t: "encounter.end" }, DM, 5));
    // Without the field, as in every op stored before it, Next and Previous move the turn as they always did.
    state = apply(state, { t: "encounter.next" }, DM, 7);
    state = apply(state, { t: "encounter.next" }, DM, 8);
    assert.equal(state.encounter!.activeEntryId, "n3");
    state = apply(state, { t: "encounter.prev" }, DM, 9);
    assert.equal(state.encounter!.activeEntryId, "n2");
  });

  test("a player's press never moves their own row's turn while their view does not hold it", () => {
    let acting = apply(fresh(), { t: "encounter.start", entries: [{ id: "n1", tokenId: "pc1", value: 20 }, { id: "n2", tokenId: "gob1", value: 10 }] });
    acting = apply(acting, { t: "encounter.next" }, DM, 2);
    const press = { t: "encounter.next" as const, from: { entry: "n1", round: 1 } };
    const unchanged = (state: RoomState, why: string) => {
      const r = applyOp(state, press, P1, env(9));
      assert.ok(r.ok, why);
      assert.deepEqual(r.touched, [], why);
      assert.deepEqual(r.log, [], why);
      assert.deepEqual(r.state, state, why);
    };
    // The DM hid Ayla's row: her player sees nobody acting, so a press naming her turn exactly must not end it.
    const hidden = deepClone(acting);
    hidden.encounter!.entries.find((e) => e.id === "n1")!.hidden = true;
    unchanged(hidden, "a hidden row");
    // Her token stands on another scene than the players': her row is out of her player's view as well.
    const away = deepClone(acting);
    away.tokens.pc1!.sceneId = "s2";
    unchanged(away, "a row on another scene");
    // In her sight, the same press ends her turn, and the DM's ends a hidden one.
    assert.equal(apply(acting, press, P1, 9).encounter!.activeEntryId, "n2");
    assert.equal(apply(hidden, press, DM, 9).encounter!.activeEntryId, "n2");
  });

  test("a press names its round too, so a lone combatant's next turn is a turn of its own", () => {
    const ticked = (s: RoomState) => s.characters.c1!.actor.effects.find((e) => e.id === "e1")?.duration?.remaining;
    const check = (state: RoomState, entry: string) => {
      state = apply(state, { t: "actor.effect.add", target: { characterId: "c1" }, effect: { id: "e1", key: "blessed", duration: { mode: "rounds", rounds: 5, of: { entryId: entry } } } }, DM, 3);
      assert.equal(ticked(state), 5);
      // Two devices, or a double tap, end the same turn: the round goes up once and durations tick once.
      const press = { t: "encounter.next" as const, from: { entry, round: 1 } };
      state = apply(state, press, DM, 4);
      const once = applyOp(state, press, DM, env(5));
      assert.ok(once.ok);
      assert.deepEqual(once.touched, []);
      assert.equal(once.state.encounter!.round, 2);
      assert.equal(once.state.encounter!.activeEntryId, entry);
      assert.equal(ticked(once.state), 4);
      // The next round's turn is a new one, and its own press moves it.
      const later = apply(state, { t: "encounter.next", from: { entry, round: 2 } }, DM, 6);
      assert.equal(later.encounter!.round, 3);
      assert.equal(ticked(later), 3);
    };
    // One combatant.
    let solo = apply(fresh(), { t: "encounter.start", entries: [{ id: "n1", tokenId: "pc1", value: 20 }] });
    solo = apply(solo, { t: "encounter.next" }, DM, 2);
    check(solo, "n1");
    // One survivor: the others are dead and skipped.
    let last = apply(fresh(), { t: "encounter.start", entries: [{ id: "n1", tokenId: "pc1", value: 20 }, { id: "n2", tokenId: "gob1", value: 10 }, { id: "n3", tokenId: "gob2", value: 5 }] });
    last = apply(last, { t: "actor.life", target: { tokenId: "gob1" }, life: "dead" }, DM, 2);
    last = apply(last, { t: "actor.life", target: { tokenId: "gob2" }, life: "dead" }, DM, 2);
    last = apply(last, { t: "encounter.next" }, DM, 2);
    check(last, "n1");
  });

  test("remove re-anchors durations, pauses them with a log line and passes the turn along", () => {
    let state = fresh();
    state = apply(state, { t: "encounter.start", entries: [{ id: "n1", tokenId: "pc1", value: 20 }, { id: "n2", tokenId: "gob1", value: 10 }, { id: "n3", tokenId: "gob2", value: 5 }] });
    state = apply(state, { t: "encounter.next" }, DM, 2);
    state = apply(state, { t: "encounter.next" }, DM, 3);
    state = apply(state, { t: "actor.effect.add", target: { characterId: "c1" }, effect: { id: "e1", key: "blessed", duration: { mode: "rounds", rounds: 3, of: { tokenId: "gob1" } } } }, DM, 4);
    const r = applyOp(state, { t: "encounter.remove", entryIds: ["n2"] }, DM, env(5));
    assert.ok(r.ok);
    state = r.state;
    assert.deepEqual(state.encounter!.entries.map((e) => e.id), ["n1", "n3"]);
    assert.equal(state.encounter!.activeEntryId, "n3");
    assert.deepEqual(state.characters.c1!.actor.effects[0]!.duration, { remaining: 3, boundary: "turnStart", anchor: { tokenId: "gob1" } });
    assert.deepEqual(r.log[0]!.data, { type: "effect", characterId: "c1", key: "blessed", action: "pause" });
    assert.deepEqual(r.log.at(-1)!.data, { type: "turn", entryId: "n3", round: 1 }, "the turn it passes on starts with its own line, unseen as the goblin is");
    assert.equal(state.tokens.gob1!.fogExemptAuto, false);
    assert.equal(refused(state, { t: "encounter.remove", entryIds: ["n2"] }).code, "gone");
  });

  test("end pauses every duration, clears automatic exemptions and the history", () => {
    let state = fresh();
    state.tokens.gob1!.visibility = "dm";
    state = apply(state, { t: "encounter.start", entries: [{ id: "n1", tokenId: "gob1", value: 20 }, { id: "n2", tokenId: "pc1", value: 10 }] });
    state = apply(state, { t: "encounter.next" }, DM, 2);
    state = apply(state, { t: "actor.effect.add", target: { tokenId: "gob1" }, effect: { id: "e1", key: "blessed", duration: { mode: "turnStart", of: { characterId: "c1" } } } }, DM, 3);
    assert.equal(state.tokens.gob1!.fogExemptAuto, true);
    const r = applyOp(state, { t: "encounter.end" }, DM, env(4));
    assert.ok(r.ok);
    state = r.state;
    assert.equal(state.encounter, null);
    assert.deepEqual(state.encounterHistory, []);
    assert.equal(state.tokens.gob1!.fogExemptAuto, false);
    assert.equal(state.tokens.gob1!.visibility, "all");
    const a = state.tokens.gob1!.actor;
    assert.ok("inline" in a);
    assert.deepEqual(a.inline.effects[0]!.duration!.anchor, { tokenId: "pc1" });
    assert.ok(r.log.some((e) => e.data?.type === "encounter" && e.data.action === "end"));
    assert.equal(refused(state, { t: "encounter.end" }).code, "gone");
  });

  test("setValue, setValues, reorder and update keep the rows sorted", () => {
    let state = fresh();
    state = apply(state, { t: "encounter.start", entries: [{ id: "n1", tokenId: "pc1", value: 20 }, { id: "n2", tokenId: "gob1", value: 10 }, { id: "n3", tokenId: "gob2", value: 10 }] });
    state = apply(state, { t: "encounter.setValue", entryId: "n1", value: 3 });
    assert.deepEqual(state.encounter!.entries.map((e) => e.id), ["n2", "n3", "n1"]);
    state = apply(state, { t: "encounter.setValues", values: [{ entryId: "n1", value: 10 }, { entryId: "n2", value: null }] });
    assert.deepEqual(state.encounter!.entries.map((e) => e.id), ["n1", "n3", "n2"]);
    state = apply(state, { t: "encounter.reorder", entryIds: ["n3", "n1"] });
    assert.deepEqual(state.encounter!.entries.map((e) => [e.id, e.tieOrder]), [["n3", 0], ["n1", 1], ["n2", 2]]);
    assert.equal(refused(state, { t: "encounter.reorder", entryIds: ["n3", "nope"] }).code, "gone");
    assert.equal(refused(state, { t: "encounter.setValue", entryId: "nope", value: 1 }).code, "gone");
    state = apply(state, { t: "encounter.update", entryId: "n1", patch: { inLair: true, advantage: "adv", label: "Boss", groupKey: null } });
    const n1 = state.encounter!.entries.find((e) => e.id === "n1")!;
    assert.deepEqual([n1.inLair, n1.advantage, n1.label, n1.groupKey], [true, "adv", "Boss", undefined]);
    state = apply(state, { t: "encounter.update", entryId: "n1", patch: { advantage: null, label: null } });
    assert.equal(state.encounter!.entries.find((e) => e.id === "n1")!.advantage, undefined);
  });
});

describe("log and handouts", () => {
  test("chat and whispers carry the sender, and whispers need real recipients", () => {
    const chat = applyOp(fresh(), { t: "log.chat", text: "hello" }, P1, env(1));
    assert.ok(chat.ok);
    assert.deepEqual(chat.state.log[0], { id: "1:0", at: AT, kind: "chat", from: "p1", text: "hello" });
    const whisper = applyOp(fresh(), { t: "log.whisper", to: ["dm1"], text: "psst" }, P1, env(1));
    assert.ok(whisper.ok);
    assert.deepEqual(whisper.state.log[0]!.to, ["dm1"]);
    assert.equal(refused(fresh(), { t: "log.whisper", to: ["ghost"], text: "psst" }, P1).code, "gone");
  });

  test("the in-memory log keeps the newest 200 shared lines and reports what it trimmed", () => {
    const state = fresh();
    state.log = Array.from({ length: MAX_LOG }, (_, i) => ({ id: `1:${i}`, at: AT, kind: "chat" as const, text: "x" }));
    const r = applyOp(state, { t: "log.chat", text: "new" }, P1, env(2));
    assert.ok(r.ok);
    assert.equal(r.state.log.length, MAX_LOG);
    assert.equal(r.state.log[MAX_LOG - 1]!.id, "2:0");
    assert.deepEqual(r.touched, ["log:2:0", "log:1:0"]);
  });

  test("handouts show, re-show in place and close", () => {
    const shown = applyOp(fresh(), { t: "handout.show", handout: { id: "h1", assetId: "img", title: "Letter", to: "all" } }, DM, env(1));
    assert.ok(shown.ok);
    assert.equal(shown.state.handouts.h1!.shownAt, AT);
    assert.deepEqual(shown.log[0]!.data, { type: "handout", handoutId: "h1" });
    const again = apply(shown.state, { t: "handout.show", handout: { id: "h1", assetId: "img", title: "Letter", to: ["p1"] } }, DM, 2);
    assert.equal(again.handouts.h1!.rev, 2);
    assert.deepEqual(again.handouts.h1!.to, ["p1"]);
    const closed = apply(again, { t: "handout.close", handoutId: "h1" });
    assert.equal(closed.handouts.h1, undefined);
    assert.equal(refused(closed, { t: "handout.close", handoutId: "h1" }).code, "gone");
  });

  test("a show of pages names its first page as the handout's image, and a re-show as one image drops the pages (docs/design-v1-pdf-handouts.md 3.3)", () => {
    const pages = [
      { assetId: "p1", width: 1584, height: 2048 },
      { assetId: "p2", width: 2048, height: 1584 },
      { assetId: "p1", width: 1584, height: 2048 },
    ];
    const shown = applyOp(fresh(), { t: "handout.show", handout: { id: "h1", pages, title: "Strange letter", to: "all" } }, DM, env(1));
    assert.ok(shown.ok);
    assert.deepEqual(shown.state.handouts.h1, { id: "h1", rev: 1, assetId: "p1", pages, title: "Strange letter", to: "all", shownAt: AT });
    assert.deepEqual(shown.log[0]!.data, { type: "handout", handoutId: "h1" });
    const image = apply(shown.state, { t: "handout.show", handout: { id: "h1", assetId: "img", title: "Letter", to: "all" } }, DM, 2);
    assert.deepEqual(image.handouts.h1, { id: "h1", rev: 2, assetId: "img", title: "Letter", to: "all", shownAt: AT });
    const again = apply(image, { t: "handout.show", handout: { id: "h1", pages: pages.slice(1), title: "Strange letter", to: ["p1"] } }, DM, 3);
    assert.equal(again.handouts.h1!.assetId, "p2");
    assert.deepEqual(again.handouts.h1!.pages, pages.slice(1));
  });

  test("a document is saved under its own id with the time of the save, never twice, logs nothing, and deleting one not there is gone (docs/design-v1-pdf-handouts.md 3.3)", () => {
    const pages = [handoutPage("page3"), handoutPage("page3")];
    const saved = applyOp(fresh(), { t: "handoutDoc.create", doc: { id: "doc2", title: "Map pack", pages } }, DM, env(4));
    assert.ok(saved.ok);
    assert.deepEqual(saved.state.handoutDocs.doc2, { id: "doc2", rev: 1, title: "Map pack", pages, createdAt: AT });
    assert.deepEqual(saved.touched, ["handoutDoc:doc2"]);
    assert.deepEqual(saved.log, []);
    // A create sent again after a lost answer is refused, so it never makes a second document.
    assert.equal(refused(saved.state, { t: "handoutDoc.create", doc: { id: "doc2", title: "Map pack", pages } }).code, "invalid");
    const deleted = applyOp(saved.state, { t: "handoutDoc.delete", docId: "doc2" }, DM, env(5));
    assert.ok(deleted.ok);
    assert.equal(deleted.state.handoutDocs.doc2, undefined);
    assert.deepEqual(deleted.log, []);
    assert.equal(refused(deleted.state, { t: "handoutDoc.delete", docId: "doc2" }).code, "gone");
  });
});

describe("saved encounters", () => {
  test("create stores the encounter, refuses a duplicate id, and touches nothing else", () => {
    const before = fresh();
    const input = { id: "enc2", name: "Wolves", monsters: [{ srdId: "wolf", count: 3 }, { monsterId: "mon1", count: 1, inLair: true }] };
    const r = applyOp(before, { t: "savedEncounter.create", encounter: input }, DM, env(1));
    assert.ok(r.ok);
    assert.deepEqual(r.touched, [keys.savedEncounter("enc2")]);
    assert.ok(!r.global);
    assert.deepEqual(r.log, []);
    assert.deepEqual(r.state.savedEncounters.enc2, { ...input, rev: 1 });
    assert.equal(r.state.tokens, before.tokens);
    assert.equal(r.state.savedEncounters.enc1, before.savedEncounters.enc1);
    assert.equal(refused(r.state, { t: "savedEncounter.create", encounter: input }).code, "invalid");
  });

  test("update writes what it carries, and a null party goes back to the room's characters", () => {
    const state = fresh();
    const renamed = apply(state, { t: "savedEncounter.update", encounterId: "enc1", patch: { name: "Ambush at dusk" } });
    assert.equal(renamed.savedEncounters.enc1!.name, "Ambush at dusk");
    assert.deepEqual(renamed.savedEncounters.enc1!.monsters, state.savedEncounters.enc1!.monsters);
    assert.deepEqual(renamed.savedEncounters.enc1!.party, [{ count: 4, level: 3 }]);
    const roomParty = apply(renamed, { t: "savedEncounter.update", encounterId: "enc1", patch: { party: null, monsters: [] } }, DM, 2);
    assert.equal("party" in roomParty.savedEncounters.enc1!, false);
    assert.deepEqual(roomParty.savedEncounters.enc1!.monsters, []);
    const mixed = apply(roomParty, { t: "savedEncounter.update", encounterId: "enc1", patch: { party: [{ count: 2, level: 5 }, { count: 1, level: 6 }] } }, DM, 3);
    assert.deepEqual(mixed.savedEncounters.enc1!.party, [{ count: 2, level: 5 }, { count: 1, level: 6 }]);
    assert.equal(refused(state, { t: "savedEncounter.update", encounterId: "nope", patch: { name: "x" } }).code, "gone");
  });

  test("delete removes only the encounter, and it may name a room monster deleted since", () => {
    const gone = apply(fresh(), { t: "monster.delete", monsterId: "mon1" });
    assert.deepEqual(gone.savedEncounters.enc1!.monsters[1], { monsterId: "mon1", count: 1 });
    const r = applyOp(gone, { t: "savedEncounter.delete", encounterId: "enc1" }, DM, env(2));
    assert.ok(r.ok);
    assert.deepEqual(r.touched, [keys.savedEncounter("enc1")]);
    assert.equal(r.state.savedEncounters.enc1, undefined);
    assert.equal(refused(r.state, { t: "savedEncounter.delete", encounterId: "enc1" }).code, "gone");
  });
});

describe("custom monsters", () => {
  test("create stores the stat block, refuses a duplicate id, and touches nothing else", () => {
    const block = blockOf(customMonster("mon2", { name: "Mire Wight" }));
    const before = fresh();
    const r = applyOp(before, { t: "monster.create", monster: { id: "mon2", ...block } }, DM, env(1));
    assert.ok(r.ok);
    assert.deepEqual(r.touched, [keys.monster("mon2")]);
    assert.ok(!r.global);
    assert.deepEqual(r.log, []);
    assert.deepEqual(r.state.monsters.mon2, { id: "mon2", ...block, rev: 1 });
    assert.equal(r.state.tokens, before.tokens);
    assert.equal(r.state.monsters.mon1, before.monsters.mon1);
    assert.equal(refused(r.state, { t: "monster.create", monster: { id: "mon2", ...block } }).code, "invalid");
  });

  test("update writes only the lines it carries, and null clears the optional ones", () => {
    const state = fresh();
    const r = applyOp(state, { t: "monster.update", monsterId: "mon1", patch: { ac: 17, sizeAlt: null, speed: "40 ft." } }, DM, env(1));
    assert.ok(r.ok);
    const m = r.state.monsters.mon1!;
    assert.equal(m.ac, 17);
    assert.equal(m.speed, "40 ft.");
    assert.equal("sizeAlt" in m, false);
    assert.equal(m.xpInLair, 700);
    assert.deepEqual(m.actions, state.monsters.mon1!.actions);
    assert.equal(m.rev, state.monsters.mon1!.rev + 1);
    const cleared = apply(r.state, { t: "monster.update", monsterId: "mon1", patch: { xpInLair: null } }, DM, 2);
    assert.equal("xpInLair" in cleared.monsters.mon1!, false);
    const added = apply(cleared, { t: "monster.update", monsterId: "mon1", patch: { sizeAlt: "small", xpInLair: 900 } }, DM, 3);
    assert.equal(added.monsters.mon1!.sizeAlt, "small");
    assert.equal(added.monsters.mon1!.xpInLair, 900);
    assert.equal(refused(state, { t: "monster.update", monsterId: "nope", patch: { ac: 1 } }).code, "gone");
  });

  test("a default image goes in with the block, a patch changes it, and null takes it off", () => {
    const block = { ...blockOf(customMonster("mon2")), defaultImage: imageRef("wight") };
    const created = apply(fresh(), { t: "monster.create", monster: { id: "mon2", ...block } });
    assert.deepEqual(created.monsters.mon2!.defaultImage, imageRef("wight"));
    const r = applyOp(created, { t: "monster.update", monsterId: "mon2", patch: { defaultImage: imageRef("wight", 2) } }, DM, env(2));
    assert.ok(r.ok);
    assert.deepEqual(r.touched, [keys.monster("mon2")]);
    assert.deepEqual(r.state.monsters.mon2!.defaultImage, imageRef("wight", 2));
    assert.equal(r.state.monsters.mon2!.name, created.monsters.mon2!.name);
    const cleared = apply(r.state, { t: "monster.update", monsterId: "mon2", patch: { defaultImage: null } }, DM, 3);
    assert.equal("defaultImage" in cleared.monsters.mon2!, false);
    // A patch without the field leaves the image alone.
    const kept = apply(created, { t: "monster.update", monsterId: "mon2", patch: { ac: 9 } }, DM, 4);
    assert.deepEqual(kept.monsters.mon2!.defaultImage, imageRef("wight"));
  });

  test("an SRD monster's image is set, replaced and cleared by its id, and touches no token", () => {
    const before = fresh();
    const r = applyOp(before, { t: "monster.setSrdImage", srdId: "goblin-warrior", image: imageRef("goblin") }, DM, env(1));
    assert.ok(r.ok);
    assert.deepEqual(r.touched, [keys.srdImage("goblin-warrior")]);
    assert.ok(!r.global);
    assert.deepEqual(r.log, []);
    assert.deepEqual(r.state.srdImages["goblin-warrior"], { id: "goblin-warrior", rev: 1, image: imageRef("goblin") });
    assert.equal(r.state.tokens, before.tokens);
    assert.equal(r.state.srdImages.bandit, before.srdImages.bandit);

    const replaced = apply(r.state, { t: "monster.setSrdImage", srdId: "goblin-warrior", image: imageRef("goblin-2") }, DM, 2);
    assert.deepEqual(replaced.srdImages["goblin-warrior"], { id: "goblin-warrior", rev: 2, image: imageRef("goblin-2") });
    const cleared = apply(replaced, { t: "monster.setSrdImage", srdId: "goblin-warrior", image: null }, DM, 3);
    assert.equal(cleared.srdImages["goblin-warrior"], undefined);

    // Clearing an image the monster does not have changes nothing, and leaves nothing to undo.
    const nothing = applyOp(cleared, { t: "monster.setSrdImage", srdId: "goblin-warrior", image: null }, DM, env(4));
    assert.ok(nothing.ok);
    assert.deepEqual(nothing.touched, []);
    assert.equal(nothing.inverse, null);
    assert.equal(nothing.state.srdImages, cleared.srdImages);
  });

  test("delete removes only the monster: tokens made from it are copies and stay", () => {
    let state = fresh();
    state = apply(state, { t: "token.create", token: { id: "lurk", sceneId: "s1", kind: "monster", name: "Cave Lurker", size: "large", x: 1, y: 1, actor: { inline: actor() } } });
    const r = applyOp(state, { t: "monster.delete", monsterId: "mon1" }, DM, env(2));
    assert.ok(r.ok);
    assert.deepEqual(r.touched, [keys.monster("mon1")]);
    assert.equal(r.state.monsters.mon1, undefined);
    assert.ok(r.state.tokens.lurk);
    assert.equal(refused(r.state, { t: "monster.delete", monsterId: "mon1" }).code, "gone");
  });
});

describe("scene fixtures", () => {
  test("the scene helper matches the model", () => {
    assert.equal(scene("x").wallsVersion, 0);
  });
});
