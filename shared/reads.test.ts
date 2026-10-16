import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { projectState } from "./project.ts";
import { reads, satisfies } from "./reads.ts";
import { DM, P1, actor, blockOf, character, customMonster, entry, reveal, room, token } from "./testutil.ts";

function setup() {
  const state = room();
  state.scenes.s1!.fogEnabled = true;
  state.characters.c1 = character("c1", { ownerIds: ["p1"] });
  state.tokens.pc1 = token("pc1", { kind: "pc", actor: { ref: "c1" }, x: 1, y: 1 });
  state.tokens.gob = token("gob", { x: 2, y: 2, hpVisibility: "label" });
  state.tokens.exact = token("exact", { x: 3, y: 3, hpVisibility: "exact", actor: { inline: actor() } });
  state.tokens.far = token("far", { sceneId: "s2" });
  state.encounter = { rev: 0, round: 1, activeEntryId: "n1", entries: [entry("n1", { tokenId: "pc1" }), entry("n2", { tokenId: "far", tieOrder: 1 })] };
  reveal(state, "s1", { x: 0, y: 0, w: 6, h: 6 });
  return state;
}

const view = (state = setup(), viewer = P1, sceneId = "s1") => ({ state, viewer, projected: projectState(state, viewer, { sceneId }), opts: { sceneId } });

describe("reads", () => {
  test("undo, redo and server ops are never optimistic", () => {
    const v = view(setup(), DM);
    for (const op of [{ t: "undo" as const }, { t: "redo" as const }]) {
      const r = reads(op, v.state);
      assert.ok("never" in r);
      assert.ok(!satisfies(r, v.projected, DM, v.opts));
    }
  });

  test("a DM on any scene replays custom monster edits, a player never holds one to replay", () => {
    const state = setup();
    state.monsters.m1 = customMonster("m1");
    const create = { t: "monster.create" as const, monster: { id: "m2", ...blockOf(customMonster("m2")) } };
    const edit = { t: "monster.update" as const, monsterId: "m1", patch: { ac: 18 } };
    const remove = { t: "monster.delete" as const, monsterId: "m1" };
    for (const sceneId of ["s1", "s2"]) {
      const v = view(state, DM, sceneId);
      for (const op of [create, edit, remove]) assert.ok(satisfies(reads(op, state), v.projected, DM, v.opts), `${op.t} on ${sceneId}`);
    }
    const p = view(state, P1);
    assert.ok(!satisfies(reads(edit, state), p.projected, P1, p.opts));
  });

  test("a DM on any scene replays saved encounter edits, a player never holds one to replay", () => {
    const state = setup();
    state.savedEncounters.e1 = { id: "e1", rev: 0, name: "Wolves", monsters: [{ srdId: "wolf", count: 3 }] };
    const create = { t: "savedEncounter.create" as const, encounter: { id: "e2", name: "Bandits", monsters: [] } };
    const edit = { t: "savedEncounter.update" as const, encounterId: "e1", patch: { name: "Wolf pack" } };
    const remove = { t: "savedEncounter.delete" as const, encounterId: "e1" };
    for (const sceneId of ["s1", "s2"]) {
      const v = view(state, DM, sceneId);
      for (const op of [create, edit, remove]) assert.ok(satisfies(reads(op, state), v.projected, DM, v.opts), `${op.t} on ${sceneId}`);
    }
    const p = view(state, P1);
    assert.ok(!satisfies(reads(edit, state), p.projected, P1, p.opts));
  });

  test("a DM on any scene replays an SRD monster's image", () => {
    const state = setup();
    const set = { t: "monster.setSrdImage" as const, srdId: "goblin-warrior", image: { assetId: "a", crop: { cx: 0, cy: 0, zoom: 1 } } };
    for (const sceneId of ["s1", "s2"]) {
      const v = view(state, DM, sceneId);
      assert.ok(satisfies(reads(set, state), v.projected, DM, v.opts), sceneId);
    }
  });

  test("a player replays a move of a token it sees, but not one it cannot", () => {
    const v = view();
    assert.ok(satisfies(reads({ t: "token.move", tokenId: "pc1", x: 0, y: 0 }, v.state), v.projected, P1, v.opts));
    assert.ok(!satisfies(reads({ t: "token.move", tokenId: "far", x: 0, y: 0 }, v.state), v.projected, P1, v.opts));
    assert.ok(!satisfies(reads({ t: "token.move", tokenId: "nope", x: 0, y: 0 }, v.state), v.projected, P1, v.opts));
  });

  test("damage waits unless the view holds exact HP, and reads the character behind a token", () => {
    const v = view();
    const r = reads({ t: "actor.hp", target: { tokenId: "pc1" }, change: { kind: "damage", amount: 1 } }, v.state);
    assert.ok(!("never" in r));
    assert.deepEqual(r.keys[0], { key: "character:c1", fields: ["actor.hp", "actor.life", "actor.effects"] });
    assert.ok(satisfies(r, v.projected, P1, v.opts));
    const label = reads({ t: "actor.hp", target: { tokenId: "gob" }, change: { kind: "damage", amount: 1 } }, v.state);
    assert.ok(!satisfies(label, v.projected, P1, v.opts));
    const exact = reads({ t: "actor.hp", target: { tokenId: "exact" }, change: { kind: "damage", amount: 1 } }, v.state);
    assert.ok(satisfies(exact, v.projected, P1, v.opts));
    assert.ok(satisfies(label, view(setup(), DM).projected, DM, v.opts));
  });

  test("ops that scan a collection wait for players and for a DM viewing another scene", () => {
    const player = view();
    const next = reads({ t: "encounter.next" }, player.state);
    assert.ok(!("never" in next) && next.complete.includes("encounter"));
    assert.ok(!satisfies(next, player.projected, P1, player.opts));
    const dmOnS1 = view(setup(), DM, "s1");
    assert.ok(!satisfies(next, dmOnS1.projected, DM, dmOnS1.opts), "entry n2's token is on s2");
    const single = setup();
    delete single.tokens.far;
    single.encounter!.entries = [single.encounter!.entries[0]!];
    const dmFull = view(single, DM, "s1");
    // Next reads the scene of the row it lands on too (its companions' Reactions), so it is asked of this room.
    assert.ok(satisfies(reads({ t: "encounter.next" }, single), dmFull.projected, DM, dmFull.opts));
    const create = reads({ t: "token.create", token: { id: "x", sceneId: "s1", kind: "monster", name: "G", size: "medium", x: 0, y: 0, actor: { inline: actor() } } }, single);
    assert.ok(!("never" in create) && create.complete.includes("scene:s1"));
    assert.ok(satisfies(create, dmFull.projected, DM, dmFull.opts));
    const dmOnS2 = view(single, DM, "s2");
    assert.ok(!satisfies(create, dmOnS2.projected, DM, dmOnS2.opts));
    const pcCreate = reads({ t: "token.create", token: { id: "x", sceneId: "s1", kind: "pc", name: "G", size: "medium", x: 0, y: 0, actor: { ref: "c1" } } }, single);
    assert.ok(!("never" in pcCreate) && pcCreate.complete.length === 0);
    const del = reads({ t: "character.delete", characterId: "c1" }, single);
    assert.ok(!satisfies(del, dmFull.projected, DM, dmFull.opts), "two scenes exist");
  });

  test("simple ops read only what they touch", () => {
    const v = view();
    assert.ok(satisfies(reads({ t: "log.chat", text: "x" }, v.state), v.projected, P1, v.opts));
    assert.ok(satisfies(reads({ t: "log.whisper", to: ["p2"], text: "x" }, v.state), v.projected, P1, v.opts));
    assert.ok(!satisfies(reads({ t: "log.whisper", to: ["ghost"], text: "x" }, v.state), v.projected, P1, v.opts));
    const eff = reads({ t: "actor.effect.add", target: { characterId: "c1" }, effect: { id: "e", key: "blessed", duration: { mode: "turnEnd", of: { tokenId: "far" } } } }, v.state);
    assert.ok(!satisfies(eff, v.projected, P1, v.opts));
    assert.ok(satisfies(reads({ t: "drawing.clear", sceneId: "s1", scope: "own" }, v.state), v.projected, P1, v.opts));
    assert.ok(!satisfies(reads({ t: "drawing.clear", sceneId: "s1", scope: "all" }, v.state), v.projected, P1, v.opts));
  });
});

describe("wave 3 map ops", () => {
  test("a DM replays builds of the scene in view, never a duplicate, and a phase switch with the scene at hand", () => {
    const state = setup();
    const here = view(state, DM, "s1");
    const away = view(state, DM, "s2");
    const ops = [
      { t: "build.walls" as const, sceneId: "s1", put: [{ id: "abcdefabcdef", a: [0, 0] as [number, number], b: [1, 1] as [number, number], f: { kind: "wall" as const } }] },
      { t: "build.stamps" as const, sceneId: "s1", remove: ["st"] },
      { t: "build.lights" as const, sceneId: "s1", remove: ["l"] },
    ];
    for (const op of ops) {
      assert.ok(satisfies(reads(op, state), here.projected, DM, here.opts), op.t);
      assert.ok(!satisfies(reads(op, state), away.projected, DM, away.opts), `${op.t} from another scene`);
    }
    assert.ok(satisfies(reads({ t: "scene.setPhase", sceneId: "s2", phaseId: "p" }, state), here.projected, DM, here.opts));
    const duplicate = reads({ t: "scene.duplicate", sceneId: "s1", newSceneId: "s9", name: "Copy", include: { creatures: true, characters: true, fog: true, drawings: true } }, state);
    assert.ok("never" in duplicate);
  });

  test("wave 4: a player replays a door they see and a DM a height paint in view, never the server's explore", () => {
    const state = setup();
    state.buildChunks["s1:0,0"] = { sceneId: "s1", cx: 0, cy: 0, rev: 0, cells: { "1,1": "stone" }, edges: { "2,2,n": { kind: "door", state: "closed", secret: false, discovered: false } } };
    const player = view(state, P1, "s1");
    const door = reads({ t: "door.set", sceneId: "s1", door: { edge: "2,2,n" }, state: "open" }, state);
    assert.ok(satisfies(door, player.projected, P1, player.opts));
    assert.ok(!satisfies(reads({ t: "door.set", sceneId: "s1", door: { edge: "20,2,n" }, state: "open" }, state), player.projected, P1, player.opts));
    const here = view(state, DM, "s1");
    const away = view(state, DM, "s2");
    for (const op of [{ t: "build.height" as const, sceneId: "s1", cells: ["1,1"], height: 10 }, { t: "build.stairs" as const, sceneId: "s1", cells: ["1,1"], up: "a" as const }]) {
      assert.ok(satisfies(reads(op, state), here.projected, DM, here.opts), op.t);
      assert.ok(!satisfies(reads(op, state), away.projected, DM, away.opts), op.t);
      assert.ok(!satisfies(reads(op, state), player.projected, P1, player.opts), op.t);
    }
    assert.ok("never" in reads({ t: "sys.explore", sceneId: "s1", tiles: [{ tx: 0, ty: 0, bits: "A".repeat(683) + "=" }] }, state));
  });
});

describe("wave 5 ops (docs/design-v1-dm-tools.md)", () => {
  test("a DM's group edit on tokens in view replays at once, a player's waits when a target is withheld", () => {
    const state = setup();
    state.tokens.mine = token("mine", { ownerIds: ["p1"], x: 1, y: 2 });
    const dm = view(state, DM);
    assert.ok(satisfies(reads({ t: "token.updateMany", tokenIds: ["gob", "pc1"], patch: { locked: true } }, state), dm.projected, DM, dm.opts));
    assert.ok(!satisfies(reads({ t: "token.updateMany", tokenIds: ["gob", "far"], patch: { locked: true } }, state), dm.projected, DM, dm.opts));
    const p1 = view(state, P1);
    assert.ok(satisfies(reads({ t: "token.updateMany", tokenIds: ["mine", "pc1"], patch: { light: null } }, state), p1.projected, P1, p1.opts));
    assert.ok(!satisfies(reads({ t: "token.updateMany", tokenIds: ["mine", "far"], patch: { light: null } }, state), p1.projected, P1, p1.opts));
    assert.ok(!satisfies(reads({ t: "token.deleteMany", tokenIds: ["gob"] }, state), p1.projected, P1, p1.opts));
    // A deletion takes its tokens' initiative rows, so it waits while the fight holds a creature this view lacks, as token.delete does.
    assert.ok(!satisfies(reads({ t: "token.deleteMany", tokenIds: ["gob"] }, state), dm.projected, DM, dm.opts));
    const calm = { ...state, encounter: null };
    const quiet = view(calm, DM);
    assert.ok(satisfies(reads({ t: "token.deleteMany", tokenIds: ["gob"] }, calm), quiet.projected, DM, quiet.opts));
  });

  test("a player's roll answer always waits for the server, since their view lacks a hidden DC and the other targets", () => {
    const state = setup();
    state.rolls.r1 = { id: "r1", rev: 0, test: { kind: "save", choices: [{ ability: "dex" }] }, dc: 12, dcShown: false, resultShown: true, at: "x", targets: [{ characterId: "c1" }] };
    const op = { t: "roll.answer" as const, rollId: "r1", target: { characterId: "c1" }, total: 14 };
    const p1 = view(state, P1);
    assert.ok(p1.projected.rolls.r1);
    assert.ok(!satisfies(reads(op, state), p1.projected, P1, p1.opts));
    const dm = view(state, DM, "s2");
    assert.ok(satisfies(reads(op, state), dm.projected, DM, dm.opts));
  });

  test("a DM on any scene replays journal edits, and a page's deletion only where every pin is held", () => {
    const state = setup();
    state.journal.pg1 = { id: "pg1", rev: 0, title: "P", access: "dm", blocks: [] };
    for (const sceneId of ["s1", "s2"]) {
      const dm = view(state, DM, sceneId);
      assert.ok(satisfies(reads({ t: "journal.update", pageId: "pg1", patch: { title: "Q" } }, state), dm.projected, DM, dm.opts));
      assert.ok(!satisfies(reads({ t: "journal.delete", pageId: "pg1" }, state), dm.projected, DM, dm.opts), "two scenes, so pins elsewhere");
    }
    const one = { ...state, scenes: { s1: state.scenes.s1! } };
    const dm = view(one, DM, "s1");
    assert.ok(satisfies(reads({ t: "journal.delete", pageId: "pg1" }, one), dm.projected, DM, dm.opts));
  });
});

describe("companion ops (docs/design-v1-combat-flow.md 4.6)", () => {
  function party() {
    const state = setup();
    state.tokens.ws = token("ws", { kind: "npc", x: 2, y: 3, ownerIds: ["p1"], companion: { of: "c1", turn: "shared", reactionUsed: true } });
    return state;
  }

  test("a companion's creation and any change to what it is wait for the server, for the DM too", () => {
    const state = party();
    const dm = view(state, DM);
    const create = reads({ t: "token.create", token: { id: "x", sceneId: "s1", kind: "npc", name: "Owl", size: "tiny", x: 1, y: 2, actor: { inline: actor() }, companion: { of: "c1", turn: "shared" } } }, state);
    assert.ok("never" in create);
    const turn = reads({ t: "token.update", tokenId: "ws", patch: { companion: { of: "c1", turn: "own" } } }, state);
    assert.ok("never" in turn);
    assert.ok(!satisfies(turn, dm.projected, DM, dm.opts));
  });

  test("its Reaction alone reads its companion field, so its owner's device predicts it, and an owner or kind change reads the token as before", () => {
    const state = party();
    const r = reads({ t: "token.update", tokenId: "ws", patch: { companionReaction: false } }, state);
    assert.ok(!("never" in r));
    assert.deepEqual(r.keys, [{ key: "token:ws", fields: ["companion"] }]);
    const owner = view(state, P1);
    assert.ok(satisfies(r, owner.projected, P1, owner.opts));
    // A player who does not get `companion` cannot predict it, which they could not send anyway.
    const stranger = view(state, { memberId: "p2", role: "player" });
    state.tokens.ws = { ...state.tokens.ws!, ownerIds: [] };
    state.characters.c1 = { ...state.characters.c1!, ownerIds: [] };
    assert.ok(!satisfies(reads({ t: "token.update", tokenId: "ws", patch: { companionReaction: false } }, state), view(state, { memberId: "p2", role: "player" }).projected, stranger.viewer, stranger.opts));
    assert.deepEqual(reads({ t: "token.update", tokenId: "ws", patch: { kind: "object" } }, party()), { keys: [{ key: "token:ws" }], complete: [] });
  });

  test("a deletion reads the history, and a character's new owners every token, which only a one-scene room viewed whole holds", () => {
    const state = party();
    const del = reads({ t: "token.delete", tokenId: "ws" }, state);
    assert.ok(!("never" in del) && del.keys.some((k) => k.key === "encounterHistory"));
    const owners = reads({ t: "character.update", characterId: "c1", patch: { ownerIds: ["p2"] } }, state);
    assert.ok(!("never" in owners) && owners.complete.includes("tokens"));
    const two = view(state, DM);
    assert.ok(!satisfies(owners, two.projected, DM, two.opts), "two scenes");
    const single = party();
    delete single.scenes.s2;
    delete single.tokens.far;
    single.encounter!.entries = [single.encounter!.entries[0]!];
    const one = view(single, DM);
    assert.ok(satisfies(reads({ t: "character.update", characterId: "c1", patch: { ownerIds: ["p2"] } }, single), one.projected, DM, one.opts));
    assert.deepEqual(reads({ t: "character.update", characterId: "c1", patch: { name: "Bree" } }, state), { keys: [{ key: "character:c1", fields: [] }], complete: [] });
  });

  test("Next reads the landing row's scene, or the players' scene for a character row, and Previous the companions it set again", () => {
    const state = party();
    delete state.tokens.far;
    state.encounter = { rev: 0, round: 1, activeEntryId: "n1", entries: [entry("n1", { tokenId: "pc1" }), entry("n2", { characterId: "c1", tieOrder: 1 })] };
    const next = reads({ t: "encounter.next" }, state);
    assert.ok(!("never" in next) && next.complete.includes("scene:s1"));
    const onPlayers = view(state, DM, "s1");
    assert.ok(satisfies(next, onPlayers.projected, DM, onPlayers.opts));
    const elsewhere = view(state, DM, "s2");
    assert.ok(!satisfies(next, elsewhere.projected, DM, elsewhere.opts));
    state.encounterHistory = [{ encounter: structuredClone(state.encounter), effects: {}, revealed: [], companionReactions: ["ws"], at: "x" }];
    const prev = reads({ t: "encounter.prev" }, state);
    assert.ok(!("never" in prev) && prev.keys.some((k) => k.key === "token:ws"));
  });
});
