import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { keys, type EntityKey } from "../keys.ts";
import type { RoomState, Token, Viewer } from "../model.ts";
import { NUMBER_NAMES_MOST, NUMBERS_MOST, tableNumber } from "../numbering.ts";
import { applyOp } from "../reducer.ts";
import type { Op, RestoreEntry } from "../protocol.ts";
import { DM, character, env, member, room, scene, token } from "../testutil.ts";
import { keepNumbering, meetCandidates, numberingUpgrade } from "./numbering.ts";
import { guardHash } from "./tx.ts";

/*
 * The meeting rules as a batch's end applies them (shared/numbering.ts). In
 * these rooms the players' scene s1 has no fog, so the party holds every
 * creature there the DM did not hide, and a hidden one (`visibility: "dm"`)
 * stands out of the party's copy.
 */

const SERVER: Viewer = { memberId: "server", role: "dm" };
const HIDDEN = { visibility: "dm" as const };

function roomWith(tokens: Token[], extra: Partial<RoomState> = {}): RoomState {
  return room({ tokens: Object.fromEntries(tokens.map((t) => [t.id, t])), ...extra });
}

function applied(state: RoomState, op: Op, seq = 1, who: Viewer = DM): { state: RoomState; touched: EntityKey[] } {
  const result = applyOp(state, op, who, env(seq));
  assert.ok(result.ok, `expected ${op.t} to apply, got ${result.ok ? "" : result.message}`);
  return { state: result.state, touched: result.touched };
}

/** A batch's end: the step's candidates met in one `sys.meet`, as the actor appends it. */
function met(state: RoomState, touched: readonly EntityKey[] = []): RoomState {
  const ids = meetCandidates(state, touched, {});
  return ids.length === 0 ? state : applied(state, { t: "sys.meet", tokenIds: ids }, 1, SERVER).state;
}

/** An op, then the batch's end. */
function play(state: RoomState, op: Op, who: Viewer = DM): RoomState {
  const r = applied(state, op, 1, who);
  return met(r.state, r.touched);
}

/** Each creature's number as the table reads it, by id. */
function numbers(state: RoomState): Record<string, number | undefined> {
  return Object.fromEntries(Object.values(state.tokens).map((t) => [t.id, tableNumber(state, t)]));
}

const shown = (id: string) => ({ t: "token.update", tokenId: id, patch: { visibility: "all" } }) as Op;
const gone = (id: string) => ({ t: "token.delete", tokenId: id }) as Op;

describe("meeting creatures", () => {
  test("one met alone reads plain, and a second of its name makes it 1 and itself 2", () => {
    let state = met(roomWith([token("g1")]));
    assert.deepEqual(numbers(state), { g1: undefined });
    assert.equal(state.tokens.g1!.met, 1);
    assert.deepEqual(state.scenes.s1!.numbers, { names: { Goblin: [1, 1] } });
    assert.deepEqual(state.numbering?.groups, 1);
    state = play(state, { t: "token.create", token: { id: "g2", sceneId: "s1", kind: "monster", name: "Goblin", size: "medium", x: 5, y: 5, actor: token("x").actor as never } });
    assert.deepEqual(numbers(state), { g1: 1, g2: 2 });
    assert.deepEqual(state.scenes.s1!.numbers, { names: { Goblin: [1, 2] } });
  });

  test("creatures out of the party's copy are not met and count for no number", () => {
    let state = met(roomWith([token("a", HIDDEN), token("b", HIDDEN), token("c", HIDDEN), token("d")]));
    assert.deepEqual(numbers(state), { a: undefined, b: undefined, c: undefined, d: undefined });
    state = play(state, shown("b"));
    assert.deepEqual(numbers(state), { a: undefined, b: 2, c: undefined, d: 1 });
    assert.equal(state.tokens.a!.met, undefined);
  });

  test("a creature owned by a player and hidden from the rest is not met", () => {
    const state = met(roomWith([token("a"), token("b", { ...HIDDEN, ownerIds: ["p2"] })]));
    assert.deepEqual(numbers(state), { a: undefined, b: undefined });
  });

  test("numbers follow the shown name: a disguise with those it is shown as, a hidden name as Unknown creature", () => {
    const state = met(
      roomWith([
        token("a", { name: "Orc", nameHidden: true, publicName: "Goblin" }),
        token("b"),
        token("c", { name: "Cultist", nameHidden: true }),
        token("d", { name: "Unknown creature" }),
      ]),
    );
    assert.deepEqual(numbers(state), { a: 1, b: 2, c: 1, d: 2 });
    assert.deepEqual(Object.keys(state.scenes.s1!.numbers!.names).sort(), ["Goblin", "Unknown creature"]);
  });

  test("a deleted creature's number is never given again", () => {
    let state = met(roomWith([token("a"), token("b"), token("c")]));
    state = play(state, gone("c"));
    state = play(state, { t: "token.create", token: { id: "d", sceneId: "s1", kind: "monster", name: "Goblin", size: "medium", x: 1, y: 1, actor: token("x").actor as never } });
    assert.deepEqual(numbers(state), { a: 1, b: 2, d: 4 });
  });

  test("a first met creature brought back after the second was met takes 1", () => {
    let state = met(roomWith([token("a"), token("b", HIDDEN)]));
    const before = state.tokens.a!;
    state = play(state, gone("a"));
    state = play(state, shown("b"));
    assert.deepEqual(numbers(state), { b: 2 });
    state = play(state, { t: "sys.restore", from: "undo", entries: [{ key: keys.token("a"), value: before, expectRev: null }] });
    assert.deepEqual(numbers(state), { a: 1, b: 2 });
  });

  test("a creature renamed in sight takes its new name's next number, and a rename back by hand a fresh one", () => {
    let state = met(roomWith([token("g1"), token("g2"), token("g3"), token("o1", { name: "Orc" }), token("o2", { name: "Orc" })]));
    assert.deepEqual(numbers(state), { g1: 1, g2: 2, g3: 3, o1: 1, o2: 2 });
    state = play(state, { t: "token.update", tokenId: "g2", patch: { name: "Orc" } });
    assert.equal(tableNumber(state, state.tokens.g2!), 3);
    state = play(state, { t: "token.update", tokenId: "g2", patch: { name: "Goblin" } });
    assert.equal(tableNumber(state, state.tokens.g2!), 4);
  });

  test("out of sight, a rename there and back and a hide and show of its name keep its number", () => {
    let state = met(roomWith([token("a"), token("b")]));
    state = play(state, { t: "token.update", tokenId: "b", patch: { visibility: "dm" } });
    state = play(state, { t: "token.update", tokenId: "b", patch: { name: "Orc" } });
    assert.equal(tableNumber(state, state.tokens.b!), undefined, "no member under another name");
    state = play(state, { t: "token.update", tokenId: "b", patch: { name: "Goblin", nameHidden: true } });
    state = play(state, { t: "token.update", tokenId: "b", patch: { nameHidden: false } });
    state = play(state, shown("b"));
    assert.deepEqual(numbers(state), { a: 1, b: 2 });
  });

  test("a creature moved to another scene is no member there, met there takes that scene's next number, and moved back unseen is the member it was", () => {
    const s2 = scene("s2", { order: 1 });
    let state = met(roomWith([token("a"), token("b"), token("c", { sceneId: "s2" }), token("d", { sceneId: "s2" })], { scenes: { s1: scene("s1"), s2 } }));
    // The players go to s2, whose Goblins take a group of their own.
    state = play(state, { t: "room.setPlayerScene", sceneId: "s2" });
    assert.deepEqual(numbers(state), { a: 1, b: 2, c: 1, d: 2 });
    state = play(state, { t: "token.update", tokenId: "b", patch: { sceneId: "s2", visibility: "dm" } });
    assert.equal(tableNumber(state, state.tokens.b!), undefined, "no second Goblin 2 on s2");
    state = play(state, { t: "token.update", tokenId: "b", patch: { sceneId: "s1" } });
    assert.equal(tableNumber(state, state.tokens.b!), 2, "back on s1 unseen, the member it was");
    state = play(state, { t: "token.update", tokenId: "b", patch: { sceneId: "s2", visibility: "all" } });
    assert.equal(tableNumber(state, state.tokens.b!), 3);
  });

  test("a first met creature with no number moved to a scene whose name gave 1 and 2 takes 3, never a second 1", () => {
    let state = met(roomWith([token("a"), token("b"), token("c", { sceneId: "s2", ...HIDDEN })]));
    state = play(state, { t: "room.setPlayerScene", sceneId: "s2" });
    state = play(state, shown("c"));
    assert.equal(state.tokens.c!.met, 2);
    assert.equal(tableNumber(state, state.tokens.c!), undefined);
    state = play(state, { t: "token.update", tokenId: "c", patch: { sceneId: "s1" } });
    state = play(state, { t: "room.setPlayerScene", sceneId: "s1" });
    assert.deepEqual(numbers(state), { a: 1, b: 2, c: 3 });
  });

  test("a first met creature that is an object when the second is met takes its 1 once it is a monster again", () => {
    let state = met(roomWith([token("a"), token("b", HIDDEN)]));
    state = play(state, { t: "token.update", tokenId: "a", patch: { kind: "object" } });
    state = play(state, shown("b"));
    assert.equal(state.tokens.a!.number, undefined, "nothing written on the object");
    assert.equal(tableNumber(state, state.tokens.b!), 2);
    state = play(state, { t: "token.update", tokenId: "a", patch: { kind: "monster" } });
    assert.deepEqual(numbers(state), { a: 1, b: 2 });
  });

  test("a party member's companion is never numbered and counts for none", () => {
    const characters = { hero: character("hero", { ownerIds: ["p1"] }) };
    const owl = (id: string) => token(id, { kind: "npc", name: "Owl", companion: { of: "hero", turn: "own" }, ownerIds: ["p1"] });
    const state = met(roomWith([owl("own"), token("dm", { kind: "npc", name: "Owl" })], { characters }));
    assert.deepEqual(numbers(state), { own: undefined, dm: undefined });
    assert.equal(state.tokens.own!.met, undefined);
  });

  test("a companion of a character no player plays is numbered as a plain creature, attaching keeps its number, and a player taking the character on hides it", () => {
    const characters = { npc: character("npc", { ownerIds: [] }) };
    let state = met(roomWith([token("a"), token("b")], { characters }));
    state = play(state, { t: "token.update", tokenId: "b", patch: { companion: { of: "npc", turn: "own" } } });
    assert.deepEqual(numbers(state), { a: 1, b: 2 });
    state = play(state, { t: "character.update", characterId: "npc", patch: { ownerIds: ["p1"] } } as Op);
    assert.deepEqual(numbers(state), { a: 1, b: undefined });
    state = play(state, { t: "character.update", characterId: "npc", patch: { ownerIds: [] } } as Op);
    assert.deepEqual(numbers(state), { a: 1, b: 2 });
  });

  test("a first met companion a member's kind makes plain is found though no creature was touched", () => {
    const characters = { hero: character("hero", { ownerIds: ["p1"] }) };
    let state = met(roomWith([token("a", { kind: "npc", name: "Owl" }), token("b", { kind: "npc", name: "Owl", ...HIDDEN })], { characters }));
    state = play(state, { t: "token.update", tokenId: "a", patch: { companion: { of: "hero", turn: "own" } } });
    state = play(state, shown("b"));
    assert.equal(state.tokens.a!.number, undefined, "a party member's companion takes no 1");
    // The players move on, so the companion stands where no creature is judged unless the batch names it.
    state = play(state, { t: "room.setPlayerScene", sceneId: "s2" });
    const made = applied(state, { t: "sys.memberSetKind", memberId: "p1", kind: "dm" }, 1, SERVER);
    assert.ok(made.touched.every((key) => !key.startsWith("token:")));
    state = met(made.state, made.touched);
    assert.deepEqual(numbers(state), { a: 1, b: 2 });
  });
});

describe("the caps", () => {
  test("a name past the scene's names, or a number past a name's, is not listed and stays unnumbered", () => {
    const names = Object.fromEntries(Array.from({ length: NUMBER_NAMES_MOST }, (_, i) => [`Name ${i}`, [i + 1, 1] as [number, number]]));
    const full = roomWith([token("a", { name: "Kobold" }), token("b", { name: "Kobold" })], { scenes: { s1: scene("s1", { numbers: { names } }), s2: scene("s2") }, numbering: { rev: 0, groups: NUMBER_NAMES_MOST } });
    assert.deepEqual(meetCandidates(full, [], {}), []);
    const most = roomWith([token("a", { met: 1, number: 1 }), token("b")], { scenes: { s1: scene("s1", { numbers: { names: { Goblin: [1, NUMBERS_MOST] } } }), s2: scene("s2") }, numbering: { rev: 0, groups: 1 } });
    assert.deepEqual(meetCandidates(most, [], {}), []);
    // The reducer skips one the room no longer fits, as a second meeting in one batch can find.
    assert.deepEqual(applied(most, { t: "sys.meet", tokenIds: ["b"] }, 1, SERVER).state.tokens.b, most.tokens.b);
  });

  test("at the number cap a first met creature still takes its 1", () => {
    const state = roomWith([token("a", { met: 1, ...HIDDEN }), token("z", { met: 1, number: NUMBERS_MOST })], {
      scenes: { s1: scene("s1", { numbers: { names: { Goblin: [1, NUMBERS_MOST] } } }), s2: scene("s2") },
      numbering: { rev: 0, groups: 1 },
    });
    assert.deepEqual(meetCandidates(state, [keys.token("a")], {}), ["a"]);
    assert.equal(met(state, [keys.token("a")]).tokens.a!.number, 1);
  });
});

describe("restores", () => {
  const goblin2 = (over: Partial<Token> = {}) => token("g", { met: 1, number: 2, ...over });
  const scenes = { s1: scene("s1", { numbers: { names: { Goblin: [1, 3], Orc: [2, 3] } } }), s2: scene("s2") };

  test("a stored mark that fits takes its number back, unless the creature now holds that group's number", () => {
    const state = { scenes };
    assert.deepEqual(keepNumbering(state, goblin2(), token("g", { name: "Orc", met: 2, number: 3 })), goblin2(), "undo of a rename");
    assert.deepEqual(keepNumbering(state, goblin2({ number: undefined }), token("g", { met: 1, number: 1 })), goblin2({ number: 1 }), "the group's number since");
    assert.deepEqual(keepNumbering(state, token("g", { name: "Orc", met: 2, number: 3 }), goblin2()), token("g", { name: "Orc", met: 2, number: 3 }), "redo of a rename");
  });

  test("a stored mark that fits no group keeps the creature's own, or the stored with no creature now", () => {
    const state = { scenes };
    assert.deepEqual(keepNumbering(state, token("g", { name: "Kobold", met: 9, number: 4 }), goblin2({ name: "Kobold" })), token("g", { name: "Kobold", met: 1, number: 2 }));
    assert.deepEqual(keepNumbering(state, token("g", { number: 7 }), undefined), token("g", { number: 7 }));
    assert.deepEqual(keepNumbering(state, token("g", { number: 7 }), goblin2()), goblin2(), "an old number counts for nothing");
  });

  test("undo and redo of a rename in sight give back each number", () => {
    let state = met(roomWith([token("g1"), token("g2"), token("o1", { name: "Orc" }), token("o2", { name: "Orc" })]));
    const renamed = applied(state, { t: "token.update", tokenId: "g2", patch: { name: "Orc" } });
    state = met(renamed.state, renamed.touched);
    assert.equal(tableNumber(state, state.tokens.g2!), 3);
    const inverse = applyOp(met(roomWith([token("g1"), token("g2"), token("o1", { name: "Orc" }), token("o2", { name: "Orc" })])), { t: "token.update", tokenId: "g2", patch: { name: "Orc" } }, DM, env(1));
    assert.ok(inverse.ok && inverse.inverse);
    const undo = applyOp(state, { t: "sys.restore", from: "undo", entries: inverse.inverse }, DM, env(2));
    assert.ok(undo.ok && undo.inverse, undo.ok ? "" : undo.message);
    state = met(undo.state, undo.touched);
    assert.equal(tableNumber(state, state.tokens.g2!), 2, "undo");
    const redo = applyOp(state, { t: "sys.restore", from: "undo", entries: undo.inverse }, DM, env(3));
    assert.ok(redo.ok, redo.ok ? "" : redo.message);
    state = met(redo.state, redo.touched);
    assert.equal(tableNumber(state, state.tokens.g2!), 3, "redo");
  });

  test("a meeting between a move and its undo leaves the undo's guard matching", () => {
    let state = met(roomWith([token("a"), token("b", HIDDEN)]));
    const moved = applied(state, { t: "token.move", tokenId: "a", x: 6, y: 6 } as Op);
    const step = applyOp(state, { t: "token.move", tokenId: "a", x: 6, y: 6 } as Op, DM, env(1));
    assert.ok(step.ok && step.inverse);
    state = play(moved.state, shown("b"));
    assert.equal(tableNumber(state, state.tokens.a!), 1, "the move's creature took 1 since");
    const undo = applyOp(state, { t: "sys.restore", from: "undo", entries: step.inverse }, DM, env(2));
    assert.ok(undo.ok, undo.ok ? "" : undo.message);
    assert.equal(undo.state.tokens.a!.number, 1);
    assert.equal(undo.state.tokens.a!.x, 3);
  });

  test("a guard stored before op version 60 still hashes the number", () => {
    const value = token("a", { number: 2 });
    assert.notEqual(guardHash(keys.token("a"), value, 59), guardHash(keys.token("a"), { ...value, number: 3 }, 59));
    assert.equal(guardHash(keys.token("a"), value), guardHash(keys.token("a"), { ...value, number: 3, met: 4 }));
    assert.equal(guardHash(keys.scene("s1"), scene("s1")), guardHash(keys.scene("s1"), scene("s1", { numbers: { names: { Goblin: [1, 1] } } })));
  });

  test("a scene deleted and brought back returns with its creatures and numbers, and gives no number twice", () => {
    let state = met(roomWith([token("a"), token("b"), token("c", { sceneId: "s2" })]));
    const deleted = applyOp(state, { t: "scene.delete", sceneId: "s1" }, DM, env(1));
    assert.ok(deleted.ok && deleted.inverse, deleted.ok ? "" : deleted.message);
    const undo = applyOp(deleted.state, { t: "sys.restore", from: "undo", entries: deleted.inverse }, DM, env(2));
    assert.ok(undo.ok, undo.ok ? "" : undo.message);
    state = met(undo.state, undo.touched);
    assert.deepEqual(state.scenes.s1!.numbers, { names: { Goblin: [1, 2] } });
    state = play(state, { t: "token.create", token: { id: "d", sceneId: "s1", kind: "monster", name: "Goblin", size: "medium", x: 1, y: 1, actor: token("x").actor as never } });
    assert.deepEqual(numbers(state), { a: 1, b: 2, c: undefined, d: 3 });
  });

  test("a restored scene keeps the numbers it has now", () => {
    let state = met(roomWith([token("a"), token("b", HIDDEN)]));
    const renamed = applyOp(state, { t: "scene.update", sceneId: "s1", patch: { name: "Crypt" } }, DM, env(1));
    assert.ok(renamed.ok && renamed.inverse);
    state = play(renamed.state, shown("b"));
    const undo = applied(state, { t: "sys.restore", from: "undo", entries: renamed.inverse as RestoreEntry[] }, 2);
    assert.deepEqual(undo.state.scenes.s1!.numbers, { names: { Goblin: [1, 2] } });
    assert.equal(undo.state.scenes.s1!.name, "s1");
  });
});

describe("copies", () => {
  test("a duplicated scene's creatures carry no number or mark, and the copy no numbers", () => {
    const state = met(roomWith([token("a"), token("b")]));
    const copy = applied(state, { t: "scene.duplicate", sceneId: "s1", newSceneId: "s9", name: "Copy", include: { creatures: true, characters: true, fog: false, drawings: false } } as Op).state;
    const copies = Object.values(copy.tokens).filter((t) => t.sceneId === "s9");
    assert.equal(copies.length, 2);
    assert.ok(copies.every((t) => t.number === undefined && t.met === undefined));
    assert.equal(copy.scenes.s9!.numbers, undefined);
  });
});

describe("creating creatures", () => {
  const create = (id: string): Op => ({ t: "token.create", token: { id, sceneId: "s1", kind: "monster", name: "Goblin", size: "medium", x: 1, y: 1, actor: token("x").actor as never } });

  test("numbers nothing from op version 60, as an op stored before numbered duplicates", () => {
    const state = roomWith([token("a")]);
    const live = applyOp(state, create("b"), DM, env(1));
    assert.ok(live.ok);
    assert.equal(live.state.tokens.b!.number, undefined);
    assert.equal(live.state.tokens.a!.number, undefined);
    const old = applyOp(state, create("b"), DM, { ...env(1), opVersion: 59 });
    assert.ok(old.ok);
    assert.equal(old.state.tokens.a!.number, 1);
    assert.equal(old.state.tokens.b!.number, 2);
  });

  test("attaching a numbered creature keeps its number from op version 60, and an op stored before cleared it", () => {
    const characters = { npc: character("npc", { ownerIds: [] }) };
    const state = roomWith([token("a", { met: 1, number: 2, kind: "npc" })], { characters, scenes: { s1: scene("s1", { numbers: { names: { Goblin: [1, 2] } } }), s2: scene("s2") } });
    const attach: Op = { t: "token.update", tokenId: "a", patch: { companion: { of: "npc", turn: "own" } } };
    const live = applyOp(state, attach, DM, env(1));
    assert.ok(live.ok, live.ok ? "" : live.message);
    assert.equal(live.state.tokens.a!.number, 2);
    assert.equal(live.state.tokens.a!.met, 1);
    const old = applyOp(state, attach, DM, { ...env(1), opVersion: 59 });
    assert.ok(old.ok, old.ok ? "" : old.message);
    assert.equal(old.state.tokens.a!.number, undefined);
  });
});

describe("the numbering upgrade", () => {
  test("keeps the numbers the party holds on the scene players see and numbers the rest it holds by the rules", () => {
    const state = roomWith([
      token("a", { number: 1 }),
      token("b", { number: 2 }),
      ...["c", "d", "e", "f"].map((id, i) => token(id, { number: i + 3, ...HIDDEN })),
      token("g"),
      token("o1", { name: "Orc", number: 4, sceneId: "s2" }),
    ]);
    const after = numberingUpgrade(state);
    assert.deepEqual(numbers(after), { a: 1, b: 2, c: undefined, d: undefined, e: undefined, f: undefined, g: 3, o1: undefined });
    assert.deepEqual(after.scenes.s1!.numbers, { names: { Goblin: [1, 3] } });
    assert.equal(after.scenes.s2!.numbers, undefined);
    // A hidden one met later counts on from there.
    assert.equal(tableNumber(play(after, shown("c")), play(after, shown("c")).tokens.c!), 4);
  });

  test("of two with one number the lower id keeps it, and hidden names meet under the name players read", () => {
    const floors = {
      s1: scene("s1", { floor: { of: "s1", level: 0, name: "Ground floor", height: 10 } }),
      up: scene("up", { floor: { of: "s1", level: 1, name: "Upper", height: 10 } }),
      s2: scene("s2", { order: 1 }),
    };
    const state = roomWith([token("a", { number: 1 }), token("b", { number: 1, sceneId: "up" }), token("x", { name: "Orc", nameHidden: true, number: 5 }), token("y", { name: "Elf", nameHidden: true })], {
      scenes: floors,
      openFloors: { up: { sceneId: "up", rev: 0 } },
    });
    const after = numberingUpgrade(state);
    assert.deepEqual(numbers(after), { a: 1, b: 2, x: 1, y: 2 });
    assert.deepEqual(after.scenes.s1!.numbers, { names: { Goblin: [1, 2], "Unknown creature": [2, 2] } });
    assert.equal(after.scenes.up!.numbers, undefined);
  });

  test("keeps nothing behind a blackout, and nothing on a scene players are not on", () => {
    const tokens = [token("a", { number: 1 }), token("b", { number: 2 }), token("c", { number: 7, sceneId: "s2" })];
    const dark = roomWith(tokens);
    dark.meta = { ...dark.meta, view: { follow: false, blackout: true } };
    assert.equal(numberingUpgrade(dark), dark);
    const after = numberingUpgrade(roomWith(tokens));
    assert.equal(tableNumber(after, after.tokens.c!), undefined);
    const there = play(after, { t: "room.setPlayerScene", sceneId: "s2" });
    assert.equal(tableNumber(there, there.tokens.c!), undefined, "met alone there, never 7");
  });

  test("keeps at most 100 names, those whose lowest creature in the party's copy comes first, and the rest read plain", () => {
    const tokens: Token[] = [];
    for (let i = 0; i < NUMBER_NAMES_MOST + 1; i++) {
      const name = `Name ${String(i).padStart(3, "0")}`;
      tokens.push(token(`k${String(i).padStart(3, "0")}`, { name, number: 1 }), token(`m${String(i).padStart(3, "0")}`, { name, number: 2 }));
    }
    // A hidden creature of the last name with the lowest id of all decides nothing.
    tokens.push(token("a000", { name: `Name ${NUMBER_NAMES_MOST}`, number: 3, ...HIDDEN }));
    const after = numberingUpgrade(roomWith(tokens));
    const kept = Object.keys(after.scenes.s1!.numbers!.names);
    assert.equal(kept.length, NUMBER_NAMES_MOST);
    assert.ok(!kept.includes(`Name ${NUMBER_NAMES_MOST}`));
    assert.equal(tableNumber(after, after.tokens.k100!), undefined);
    assert.equal(tableNumber(after, after.tokens.m099!), 2);
  });

  test("gives the same state each time it runs on the same room", () => {
    const state = roomWith([token("a", { number: 1 }), token("b", { number: 2 }), token("c")], { members: { dm1: member("dm1", "dm"), p1: member("p1") } });
    assert.deepEqual(numberingUpgrade(structuredClone(state)), numberingUpgrade(structuredClone(state)));
  });
});
