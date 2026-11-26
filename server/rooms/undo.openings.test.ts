import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { ANA, ATTIC, GROUND, UPPER, thornToken, tower, trapdoor, withOpening, withTrapdoor } from "#shared/floorLinksTestutil.ts";
import type { AreaTemplate, FallRecord, RoomState, Token, Viewer } from "#shared/model.ts";
import { projectState } from "#shared/project.ts";
import type { Op, RestoreEntry } from "#shared/protocol.ts";
import { LINK_WORDS } from "#shared/rules/floorLinks.ts";
import { DM, actor, character, token } from "#shared/testutil.ts";
import { fallsKept, fallsRestored, TRAPPED_ON_THE_WAY, UndoStacks, withoutFallCards } from "./undo.ts";
import { UndoTable } from "./undoTesting.ts";

/*
 * A player's undo and redo of a fall through an opening
 * (docs/design/design-v1-floors.md phase 4, 4.5), through the room actor's
 * own steps (undoTesting.ts mirrors actor.ts): the step keeps one record a
 * root the player received whose key it keeps, and no fall card, never
 * merges, and its restore carries the records, so the undo takes the
 * creature back up and removes its card while it is there, and the redo
 * takes it down again and writes back only the card the undo removed.
 *
 * The tower (shared/floorLinksTestutil.ts) with its opening: o1, the hole
 * on Upper floor, 2 by 2 at 6, 6, over o2 on Ground floor. Ana owns Thorn,
 * who starts on Upper floor at 4, 6.
 */

const move = (tokenId: string, x: number, y: number): Op => ({ t: "token.move", tokenId, x, y });

function holed(thorn: Partial<Token> = {}, over: Partial<RoomState> = {}, rect?: { x: number; y: number; w: number; h: number }): RoomState {
  return withOpening(tower({ tokens: { thorn: thornToken({ sceneId: UPPER, x: 4, y: 6, ...thorn }) }, ...over }), rect ? { rect } : {});
}

function withTokens(state: RoomState, ...tokens: Token[]): RoomState {
  return { ...state, tokens: { ...state.tokens, ...Object.fromEntries(tokens.map((t) => [t.id, t])) } };
}

function anyToken(state: RoomState): RoomState {
  return { ...state, meta: { ...state.meta, settings: { ...state.meta.settings, playersMoveAny: "all" as const } } };
}

function blocking(state: RoomState, ...floors: string[]): RoomState {
  const scenes = { ...state.scenes };
  for (const id of floors) scenes[id] = { ...scenes[id]!, blockMovement: true };
  return { ...state, scenes };
}

const up = (id: string, over: Partial<Token> = {}): Token => token(id, { sceneId: UPPER, name: id, ...over });

function where(t: UndoTable, id = "thorn") {
  const token = t.state.tokens[id];
  return token && { sceneId: token.sceneId, x: token.x, y: token.y, elevation: token.elevation, size: token.size };
}

const cardIds = (t: UndoTable) => Object.keys(t.state.falls ?? {}).sort();
const fallKeys = (entries: readonly RestoreEntry[] | undefined) => (entries ?? []).filter((e) => e.key.startsWith("fall:")).map((e) => e.key);

function step(t: UndoTable, who: Viewer = ANA, which: "undo" | "redo" = "undo") {
  const s = t.stacks.peek(who.memberId, which);
  assert.ok(s, `a ${which} step`);
  return s;
}

describe("a player's fall's step (4.5)", () => {
  test("Ana's walk onto the hole is one step with Thorn's record and no card, and Undo and Redo go up and down twice, one card at a time", () => {
    const t = new UndoTable(holed());
    const above = where(t);
    assert.equal(t.play(ANA, move("thorn", 6, 6)), "ok");
    const below = where(t);
    assert.equal(below?.sceneId, GROUND);
    const [card] = Object.values(t.state.falls ?? {});
    assert.ok(card, "the fall made a card");
    const made = step(t);
    assert.deepEqual(made.falls, [{ tokenId: "thorn", linkId: "o1", rev: 0, made: 90, from: UPPER, to: GROUND, fallId: card.id, shown: { kind: "opening", rect: { x: 6, y: 6, w: 2, h: 2 }, pairRect: { x: 6, y: 6, w: 2, h: 2 } } }]);
    assert.deepEqual(fallKeys(made.entries), [], "no card in the step");
    for (let i = 1; i <= 2; i++) {
      assert.equal(t.undo(ANA), "ok", `undo ${i}`);
      assert.deepEqual(where(t), above, `undo ${i}: back up where Thorn stood`);
      assert.deepEqual(cardIds(t), [], `undo ${i}: the card goes`);
      const redo = step(t, ANA, "redo");
      assert.deepEqual(redo.falls, [{ ...made.falls![0]!, card }], `undo ${i}: the redo carries the card the undo removed`);
      assert.deepEqual(fallKeys(redo.entries), [], `undo ${i}: no card in the redo's own entries`);
      assert.equal(t.redo(ANA), "ok", `redo ${i}`);
      assert.deepEqual(where(t), below, `redo ${i}: below again`);
      assert.deepEqual(t.state.falls, { [card.id]: card }, `redo ${i}: the same card, once`);
      assert.deepEqual(step(t).falls, made.falls, `redo ${i}: the step is the fall's again, its record without a card`);
      assert.deepEqual(fallKeys(step(t).entries), []);
    }
  });

  test("a redo after a wall is built across the walk is refused as a wall in the way, and an undo after the DM moved the opening as the opening changed", () => {
    const walled = new UndoTable(blocking(holed(), UPPER));
    assert.equal(walled.play(ANA, move("thorn", 6, 6)), "ok");
    assert.equal(walled.undo(ANA), "ok");
    assert.equal(walled.play(DM, { t: "build.edge", sceneId: UPPER, edges: [{ key: "5,6,w", feature: { kind: "wall" } }] }), "ok");
    assert.equal(walled.redo(ANA), "a wall is in the way");
    assert.equal(where(walled)?.sceneId, UPPER);
    assert.deepEqual(cardIds(walled), []);

    const moved = new UndoTable(holed());
    assert.equal(moved.play(ANA, move("thorn", 6, 6)), "ok");
    assert.equal(moved.play(DM, { t: "floorLink.update", linkId: "o1", patch: { rect: { x: 12, y: 12, w: 2, h: 2 } } }), "ok");
    assert.equal(moved.undo(ANA), LINK_WORDS.changed("opening"));
    assert.equal(where(moved)?.sceneId, GROUND, "Thorn stays below");
    assert.equal(cardIds(moved).length, 1, "and so does the card");
  });

  test("after the DM applies the card, Undo takes Thorn back up with no card and the Redo writes none back, so no damage is asked for twice", () => {
    for (const settle of ["apply", "dismiss"] as const) {
      const t = new UndoTable(holed());
      assert.equal(t.play(ANA, move("thorn", 6, 6)), "ok");
      const fallId = cardIds(t)[0]!;
      const op: Op = settle === "apply" ? { t: "actor.outcome", plan: "plan1", fall: { fallId, tokenIds: ["thorn"] }, targets: [{ target: { tokenId: "thorn" }, amount: 3 }] } : { t: "fall.settle", fallId };
      assert.equal(t.play(DM, op), "ok", settle);
      const hp = t.state.characters.thorn!.actor.hp.cur;
      assert.equal(t.undo(ANA), "ok", settle);
      assert.equal(where(t)?.sceneId, UPPER, settle);
      assert.deepEqual(cardIds(t), [], settle);
      assert.deepEqual(step(t, ANA, "redo").falls?.map((f) => f.card), [undefined], `${settle}: no card to write back`);
      assert.equal(t.redo(ANA), "ok", settle);
      assert.equal(where(t)?.sceneId, GROUND, settle);
      assert.deepEqual(cardIds(t), [], `${settle}: the card stays settled`);
      assert.equal(t.state.characters.thorn!.actor.hp.cur, hp, `${settle}: the damage stands as dealt`);
    }
  });

  test("walks under one gesture before and after a fall are three steps, each undone alone", () => {
    const t = new UndoTable(holed({ x: 2, y: 6 }));
    assert.equal(t.play(ANA, move("thorn", 3, 6), "g"), "ok");
    assert.equal(t.play(ANA, move("thorn", 4, 6), "g"), "ok");
    assert.equal(t.stacks.depth("p1").undo, 1, "two walks are one step");
    assert.equal(t.play(ANA, move("thorn", 6, 6), "g"), "ok");
    assert.equal(t.play(ANA, move("thorn", 5, 7), "g"), "ok");
    assert.equal(t.play(ANA, move("thorn", 4, 8), "g"), "ok");
    assert.equal(t.stacks.depth("p1").undo, 3, "the fall stands apart from the walks on both sides");
    for (const [i, at] of [
      [GROUND, 6, 6],
      [UPPER, 4, 6],
      [UPPER, 2, 6],
    ].entries()) {
      assert.equal(t.undo(ANA), "ok", `undo ${i + 1}`);
      assert.deepEqual([where(t)?.sceneId, where(t)?.x, where(t)?.y], at, `undo ${i + 1}`);
    }
  });

  test("the stacks never merge a fall's step with another either way, and an undone or redone one keeps its records", () => {
    const stacks = new UndoStacks();
    const record: FallRecord = { tokenId: "thorn", linkId: "o1", rev: 0, made: 90, from: UPPER, to: GROUND, fallId: "7:0" };
    const entry = (n: number) => [{ key: "token:thorn", value: thornToken({ x: n }), expectHash: `h${n}` }];
    stacks.push("p1", entry(1), "moving Thorn", "g", {});
    stacks.push("p1", entry(2), "moving Thorn", "g", {}, undefined, undefined, false, undefined, undefined, false, { falls: [record] });
    stacks.push("p1", entry(3), "moving Thorn", "g", {});
    assert.equal(stacks.depth("p1").undo, 3);
    assert.equal(stacks.peek("p1", "undo")?.falls, undefined);
    stacks.popUndo("p1");
    assert.deepEqual(stacks.peek("p1", "undo")?.falls, [record]);
    // An empty list is no fall: the walk merges as any.
    const other = (id: string) => [{ key: `token:${id}`, value: thornToken({ id }), expectHash: id }];
    stacks.push("p1", other("a"), "moving Thorn", "h", {});
    stacks.push("p1", other("b"), "moving Thorn", "h", {}, undefined, undefined, false, undefined, undefined, false, { falls: [] });
    assert.equal(stacks.depth("p1").undo, 3);
    const card = { id: "7:0", rev: 0, tokenId: "thorn", sceneId: GROUND, from: UPPER, ft: 10, made: 7 };
    stacks.pushRestored("p1", "undo", entry(6), "moving Thorn", {}, undefined, false, undefined, { falls: [{ ...record, card }] });
    assert.deepEqual(stacks.peek("p1", "redo")?.falls, [{ ...record, card }]);
    stacks.pushRestored("p1", "redo", entry(7), "moving Thorn", {}, undefined, false, undefined, {});
    assert.equal(stacks.peek("p1", "undo")?.falls, undefined);
  });
});

describe("which falls a player's step keeps (4.5, D-261119-120)", () => {
  test("a hidden goblin Thorn drags falls too: one record, Thorn's, the goblin back up as a silent passenger, its card left for the DM", () => {
    const wide = { x: 6, y: 6, w: 4, h: 4 };
    const state = withTokens(holed({ x: 3, y: 7 }, {}, wide), up("goblin", { x: 2, y: 7, visibility: "dm", attached: { to: "thorn", kind: "drag" } }));
    const t = new UndoTable(state);
    assert.equal(t.play(ANA, move("thorn", 8, 7)), "ok");
    assert.deepEqual([where(t)?.sceneId, where(t, "goblin")?.sceneId], [GROUND, GROUND], "both fell");
    const all = t.last!.applied.falls!;
    assert.deepEqual(all.map((f) => f.tokenId).sort(), ["goblin", "thorn"], "two records from the reducer");
    const goblinCard = all.find((f) => f.tokenId === "goblin")!.fallId;
    const made = step(t);
    assert.deepEqual(made.falls?.map((f) => f.tokenId), ["thorn"], "Ana's step keeps Thorn's alone");
    assert.equal(made.poses?.goblin?.silent, true);
    assert.equal(t.undo(ANA), "ok");
    assert.deepEqual([where(t)?.sceneId, where(t, "goblin")?.sceneId], [UPPER, UPPER], "the goblin rides back up quietly");
    assert.deepEqual(cardIds(t), [goblinCard], "the goblin's card stays");
    assert.equal(t.redo(ANA), "ok");
    assert.equal(where(t)?.sceneId, GROUND);
    assert.equal(cardIds(t).length, 2, "Thorn's card back beside the goblin's");
  });

  test("a goblin in the dark Thorn drags into a lit hall below, unseen at the walk and seen after it, gets no record either", () => {
    const wide = { x: 6, y: 6, w: 4, h: 4 };
    const lit = holed({ x: 3, y: 7 }, {}, wide);
    lit.scenes[UPPER] = { ...lit.scenes[UPPER]!, vision: { on: true, light: "dark" } };
    lit.scenes[GROUND] = { ...lit.scenes[GROUND]!, vision: { on: true, light: "bright" } };
    const t = new UndoTable(withTokens(lit, up("goblin", { x: 2, y: 7, attached: { to: "thorn", kind: "drag" } })));
    const sees = (id: string) => projectState(t.state, ANA, { sceneId: null }).tokens[id] !== undefined;
    assert.equal(sees("goblin"), false, "unseen in the dark upstairs");
    assert.equal(t.play(ANA, move("thorn", 8, 7)), "ok");
    assert.deepEqual([where(t)?.sceneId, where(t, "goblin")?.sceneId], [GROUND, GROUND]);
    assert.equal(sees("goblin"), true, "seen in the lit hall below");
    assert.deepEqual(step(t).falls?.map((f) => f.tokenId), ["thorn"], "received at the op: as the room stood before it");
    const goblinCard = Object.values(t.state.falls ?? {}).find((c) => c.tokenId === "goblin")!.id;
    assert.equal(t.undo(ANA), "ok");
    assert.deepEqual(cardIds(t), [goblinCard]);
  });

  test("an aura following Thorn goes back up with it, and down again", () => {
    const aura = { id: "aura", rev: 0, sceneId: UPPER, shape: "sphere", size: 10, origin: { x: 4.5, y: 6.5, z: 0 }, yaw: 0, includeOrigin: true, ownerId: "p1", attachedTo: "thorn" } as AreaTemplate;
    const t = new UndoTable(holed({}, { templates: { aura } }));
    assert.equal(t.play(ANA, move("thorn", 6, 6)), "ok");
    assert.equal(t.state.templates.aura!.sceneId, GROUND);
    assert.equal(t.undo(ANA), "ok");
    assert.deepEqual([where(t)?.sceneId, t.state.templates.aura!.sceneId], [UPPER, UPPER]);
    assert.equal(t.redo(ANA), "ok");
    assert.deepEqual([where(t)?.sceneId, t.state.templates.aura!.sceneId], [GROUND, GROUND]);
  });

  test("a rat Ana moves under Players move any, hidden from her since, answers that it is not here, the opening gone too", () => {
    for (const gone of [false, true]) {
      const t = new UndoTable(anyToken(withTokens(holed(), up("rat", { x: 4, y: 8 }))));
      assert.equal(t.play(ANA, move("rat", 6, 6)), "ok");
      assert.deepEqual(step(t).falls?.map((f) => f.tokenId), ["rat"]);
      assert.equal(t.play(DM, { t: "token.update", tokenId: "rat", patch: { visibility: "dm" } }), "ok");
      if (gone) assert.equal(t.play(DM, { t: "floorLink.delete", linkId: "o1" }), "ok");
      assert.equal(t.undo(ANA), "that is not here", `opening gone: ${gone}`);
      assert.equal(where(t, "rat")?.sceneId, GROUND);
    }
  });

  test("two creatures through two openings in one group move keep two records, and the undo takes both up and both cards away", () => {
    // Upper floor reached, so Ana holds it without a creature there.
    const two = withOpening(withOpening(tower({ tokens: {}, openFloors: { [UPPER]: { sceneId: UPPER, rev: 1 } } })), { id: "o3", pairId: "o4", rect: { x: 12, y: 12, w: 2, h: 2 } });
    const t = new UndoTable(anyToken(withTokens(two, up("g1", { x: 6, y: 4 }), up("g2", { x: 12, y: 10 }))));
    assert.equal(t.play(ANA, { t: "token.moveMany", moves: [{ tokenId: "g1", x: 6, y: 6 }, { tokenId: "g2", x: 12, y: 12 }] }), "ok");
    assert.deepEqual(step(t).falls?.map((f) => [f.tokenId, f.linkId]), [["g1", "o1"], ["g2", "o3"]]);
    assert.equal(cardIds(t).length, 2);
    assert.equal(t.undo(ANA), "ok");
    assert.deepEqual([where(t, "g1")?.sceneId, where(t, "g2")?.sceneId], [UPPER, UPPER]);
    assert.deepEqual(cardIds(t), []);
    assert.equal(t.redo(ANA), "ok");
    assert.deepEqual([where(t, "g1")?.sceneId, where(t, "g2")?.sceneId], [GROUND, GROUND]);
    assert.equal(cardIds(t).length, 2);
  });

  test("an elevation lowered to the ground, a resize and a detach over the hole each keep a record and undo back up", () => {
    const cases: [string, RoomState, Op][] = [
      ["lowered", holed({ x: 6, y: 6, elevation: 10 }), { t: "token.update", tokenId: "thorn", patch: { elevation: 0 } }],
      ["shrunk", holed({ x: 6, y: 6, size: "large" }), { t: "token.update", tokenId: "thorn", patch: { size: "medium" } }],
      ["detached", withTokens(holed({ x: 7, y: 6, attached: { to: "horse", kind: "perch" } }), up("horse", { size: "large", x: 7, y: 6, ownerIds: ["p1"] })), { t: "token.detach", tokenId: "thorn" }],
    ];
    for (const [name, state, op] of cases) {
      const t = new UndoTable(state);
      const before = where(t);
      assert.equal(t.play(ANA, op), "ok", name);
      assert.equal(where(t)?.sceneId, GROUND, name);
      assert.deepEqual(step(t).falls?.map((f) => f.tokenId), ["thorn"], name);
      assert.equal(t.undo(ANA), "ok", name);
      assert.deepEqual(where(t), before, name);
      assert.deepEqual(cardIds(t), [], name);
    }
  });

  test("a Large Thorn shrinking through a one-square opening goes back up Large and down again, judged on Upper floor where it shrank", () => {
    const one = { x: 6, y: 6, w: 1, h: 1 };
    // A wall inside the Large space on Ground floor alone: judged there, the growth back would not stand clear.
    const base = blocking(holed({ x: 6, y: 6, size: "large" }, {}, one), UPPER, GROUND);
    const t = new UndoTable(base);
    assert.equal(t.play(DM, { t: "build.edge", sceneId: GROUND, edges: [{ key: "7,6,w", feature: { kind: "wall" } }] }), "ok");
    assert.equal(t.play(ANA, { t: "token.update", tokenId: "thorn", patch: { size: "medium" } }), "ok");
    assert.deepEqual([where(t)?.sceneId, where(t)?.size], [GROUND, "medium"]);
    assert.equal(t.undo(ANA), "ok");
    assert.deepEqual([where(t)?.sceneId, where(t)?.size], [UPPER, "large"]);
    assert.equal(t.redo(ANA), "ok");
    assert.deepEqual([where(t)?.sceneId, where(t)?.size], [GROUND, "medium"]);
    // The same wall on Upper floor, where the resize was made, refuses the growth back.
    assert.equal(t.play(DM, { t: "build.edge", sceneId: UPPER, edges: [{ key: "7,6,w", feature: { kind: "wall" } }] }), "ok");
    assert.notEqual(t.undo(ANA), "ok");
    assert.equal(where(t)?.sceneId, GROUND);
  });

  test("Thorn's drop through a trapdoor is the trap's: Ana's undo is refused, the DM's to take back", () => {
    const t = new UndoTable(withTrapdoor(tower({ tokens: { thorn: thornToken({ sceneId: UPPER, x: 8, y: 10 }) } })));
    assert.equal(t.play(ANA, move("thorn", 10, 10)), "ok");
    assert.equal(where(t)?.sceneId, GROUND, "it dropped");
    assert.equal(step(t).trapped, true);
    assert.equal(step(t).falls, undefined, "a drop is no fall's record");
    assert.equal(t.undo(ANA), TRAPPED_ON_THE_WAY);
    assert.equal(where(t)?.sceneId, GROUND);
  });

  /**
   * A trapdoor on the Attic over the opening on Upper floor, which does not
   * stop and is not found when sprung, so Thorn walks on past it and Ana
   * sees nothing of a hidden victim's drop.
   */
  function trapdoorWalk(goblin: Partial<Token>) {
    const td = trapdoor("td1", { sceneId: ATTIC, zone: { cells: [{ x: 6, y: 6, w: 2, h: 2 }] }, rig: { ...trapdoor().rig!, stops: false, foundOnSpring: false } });
    const t = new UndoTable(withTrapdoor(withTokens(holed({ sceneId: ATTIC, x: 4, y: 6 }), token("goblin", { sceneId: ATTIC, name: "Goblin", x: 7, y: 7, ...goblin })), td));
    assert.equal(t.play(ANA, { t: "token.move", tokenId: "thorn", x: 9, y: 6, route: [[6, 6, 0, 0], [9, 6, 0, 0]] }), "ok");
    assert.equal(where(t)?.sceneId, ATTIC, "Thorn walks on");
    assert.equal(where(t, "goblin")?.sceneId, GROUND, "the goblin dropped, then fell");
    assert.deepEqual(t.last!.applied.falls?.map((f) => f.tokenId), ["goblin"]);
    assert.equal(step(t).falls, undefined, "a trap's victim is no root of Ana's step");
    assert.equal(step(t).entries.some((e) => e.key === "token:goblin"), false);
    assert.equal(cardIds(t).length, 2, "a card for the drop and one for the fall");
    return t;
  }

  test("a hidden goblin Thorn's walk drops through a trapdoor onto the hole gets no record, and stays below with its cards through the undo and redo", () => {
    const t = trapdoorWalk({ visibility: "dm" });
    const cards = cardIds(t);
    assert.equal(step(t).trapped, undefined, "Ana saw nothing of it");
    assert.equal(t.undo(ANA), "ok");
    assert.deepEqual([where(t)?.sceneId, where(t)?.x], [ATTIC, 4], "Thorn goes back");
    assert.equal(where(t, "goblin")?.sceneId, GROUND, "the goblin stays below");
    assert.deepEqual(cardIds(t), cards, "with its cards");
    assert.equal(t.redo(ANA), "ok");
    assert.deepEqual([where(t)?.x, where(t, "goblin")?.sceneId, cardIds(t)], [9, GROUND, cards]);
  });

  test("a goblin Ana sees dropped the same way gets no record either, though the step is the trap's", () => {
    const t = trapdoorWalk({});
    assert.equal(step(t).trapped, true);
    assert.equal(t.undo(ANA), TRAPPED_ON_THE_WAY);
  });
});

describe("the DM's fall (4.5)", () => {
  test("the DM's undo puts back every key the op wrote, the card among them, and the redo writes it again", () => {
    const t = new UndoTable(holed());
    assert.equal(t.play(DM, move("thorn", 6, 6)), "ok");
    const card = cardIds(t);
    assert.equal(card.length, 1);
    assert.equal(step(t, DM).falls, undefined, "the DM's step needs no record");
    assert.deepEqual(fallKeys(step(t, DM).entries), card.map((id) => `fall:${id}`));
    assert.equal(t.undo(DM), "ok");
    assert.deepEqual([where(t)?.sceneId, cardIds(t)], [UPPER, []]);
    assert.equal(t.redo(DM), "ok");
    assert.deepEqual([where(t)?.sceneId, cardIds(t)], [GROUND, card]);
  });
});

describe("the helpers (4.5)", () => {
  const record = (tokenId: string, fallId: string): FallRecord => ({ tokenId, linkId: "o1", rev: 0, made: 90, from: UPPER, to: GROUND, fallId });

  test("withoutFallCards takes out every card and nothing else", () => {
    const entries: RestoreEntry[] = [
      { key: "token:thorn", value: null, expectHash: "a" },
      { key: "fall:7:0", value: null, expectRev: null },
      { key: "fall:7:1", value: null, expectRev: null },
      { key: "template:aura", value: null, expectHash: "b" },
    ];
    assert.deepEqual(withoutFallCards(entries).map((e) => e.key), ["token:thorn", "template:aura"]);
    const none = [entries[0]!];
    assert.equal(withoutFallCards(none), none);
  });

  test("fallsKept keeps a record only for a root received whose key the step kept", () => {
    const falls = [record("thorn", "7:0"), record("goblin", "7:1"), record("victim", "7:2")];
    const inverse: RestoreEntry[] = [{ key: "token:thorn", value: null, expectHash: "a" }, { key: "token:goblin", value: null, expectHash: "b" }];
    assert.deepEqual(fallsKept(falls, inverse, (id) => id !== "goblin").map((f) => f.tokenId), ["thorn"]);
    assert.deepEqual(fallsKept(undefined, inverse, () => true), []);
  });

  test("fallsRestored puts on an undo's record the card it removed, none on a redo's or where the card was gone", () => {
    const card = { id: "7:0", rev: 0, tokenId: "thorn", sceneId: GROUND, from: UPPER, ft: 10, made: 7 };
    const before = { ...tower(), falls: { "7:0": card } };
    const after = tower();
    assert.deepEqual(fallsRestored([record("thorn", "7:0")], "undo", before, after), [{ ...record("thorn", "7:0"), card }]);
    assert.deepEqual(fallsRestored([record("thorn", "7:0")], "undo", after, after), [record("thorn", "7:0")]);
    assert.deepEqual(fallsRestored([{ ...record("thorn", "7:0"), card }], "redo", after, before), [record("thorn", "7:0")]);
    // A card still there after the restore was not the undo's to remove.
    assert.deepEqual(fallsRestored([record("thorn", "7:0")], "undo", before, before), [record("thorn", "7:0")]);
    assert.equal(fallsRestored([], "undo", before, after), undefined);
  });
});


describe("a creature falls once a step, and the undo keeps a card for one it leaves below (change format 67)", () => {
  /** Shade, the DM's character at 20 HP, which every player may move here (Players move any), Upper floor reached. */
  function shaded(state: RoomState, ...tokens: Token[]): RoomState {
    const s = anyToken(withTokens(state, ...tokens));
    return { ...s, characters: { ...s.characters, shade: character("shade", { name: "Shade", ownerIds: [], actor: actor() }) }, openFloors: { [UPPER]: { sceneId: UPPER, rev: 1 } } };
  }
  const shade = (id: string, over: Partial<Token> = {}): Token => up(id, { kind: "pc", name: "Shade", actor: { ref: "shade" }, ...over });
  const names = (t: UndoTable, id: string) => {
    const card = t.state.falls?.[id];
    return card && [card.tokenId, ...(card.riders ?? [])];
  };
  const hp = (t: UndoTable) => t.state.characters.shade!.actor.hp.cur;

  /**
   * Ana walks Shade's token S past a trapdoor on Upper floor that does not stop her and onto the hole. The trapdoor drops
   * H, Shade's other token, which the DM hid, so the drop is unseen and her step is her own, and S joins H's card.
   */
  function past(): UndoTable {
    const td = trapdoor("td1", { zone: { cells: [{ x: 9, y: 6, w: 1, h: 1 }] }, rig: { ...trapdoor().rig!, stops: false, foundOnSpring: false } });
    const t = new UndoTable(withTrapdoor(shaded(withOpening(tower({ tokens: {} })), shade("h-shade", { x: 9, y: 6, visibility: "dm" }), shade("s-shade", { x: 11, y: 6 })), td));
    assert.equal(t.play(ANA, { t: "token.move", tokenId: "s-shade", x: 6, y: 6, route: [[9, 6, 0, 0], [6, 6, 0, 0]] }), "ok");
    assert.deepEqual([where(t, "h-shade")?.sceneId, where(t, "s-shade")?.sceneId], [GROUND, GROUND]);
    assert.equal(step(t).trapped, undefined, "Ana saw nothing of the drop");
    return t;
  }

  test("Ana's undo of a root that joined the card of Shade's hidden token leaves it whole, and after the DM's Apply her redo asks nothing again", () => {
    const t = past();
    const [fallId, ...more] = cardIds(t);
    assert.deepEqual([names(t, fallId!), more.length], [["h-shade", "s-shade"], 0], "one card for Shade");
    assert.deepEqual(step(t).falls?.map((f) => [f.tokenId, f.fallId]), [["s-shade", fallId]]);
    assert.equal(t.undo(ANA), "ok");
    assert.equal(where(t, "s-shade")?.sceneId, UPPER);
    assert.deepEqual(names(t, fallId!), ["h-shade", "s-shade"], "H still below, so Shade stays on the card whole");
    assert.deepEqual(step(t, ANA, "redo").falls?.map((f) => f.card), [undefined], "the undo took nothing off");
    assert.equal(t.play(DM, { t: "actor.outcome", plan: "p1", fall: { fallId: fallId!, tokenIds: ["h-shade"] }, targets: [{ target: { tokenId: "h-shade" }, amount: 3 }] }), "ok");
    assert.deepEqual([hp(t), cardIds(t)], [17, []]);
    assert.equal(t.redo(ANA), "ok");
    assert.equal(where(t, "s-shade")?.sceneId, GROUND);
    assert.deepEqual([hp(t), cardIds(t)], [17, []], "Shade took the fall once");
  });

  /** Ana's horse carries a goblin onto the hole, one card naming both, and the DM then changes the goblin so her undo leaves it below. */
  function ridden(goblin: Partial<Token>, after: Op): { t: UndoTable; fallId: string } {
    const t = new UndoTable(withTokens(holed({ x: 15, y: 15 }), up("horse", { size: "large", ownerIds: ["p1"], x: 2, y: 6 }), up("goblin", { x: 2, y: 6, attached: { to: "horse", kind: "ride" }, ...goblin })));
    assert.equal(t.play(ANA, move("horse", 6, 6)), "ok");
    const [fallId] = cardIds(t);
    assert.deepEqual(t.state.falls?.[fallId!]?.riders, ["goblin"]);
    assert.equal(t.play(DM, after), "ok");
    return { t, fallId: fallId! };
  }

  const leftBelow: [string, Partial<Token>, Op][] = [
    ["a rider the DM hid after the fall", {}, { t: "token.update", tokenId: "goblin", patch: { visibility: "dm" } }],
    ["a hidden rider the DM took off the mount", { visibility: "dm" }, { t: "token.detach", tokenId: "goblin", x: 8, y: 6, elevation: 0 }],
  ];

  for (const [name, goblin, after] of leftBelow) {
    test(`${name}: the root's undo keeps the card naming the rider, and the redo puts the root back after it`, () => {
      const { t, fallId } = ridden(goblin, after);
      assert.equal(t.undo(ANA), "ok");
      assert.deepEqual([where(t, "horse")?.sceneId, where(t, "goblin")?.sceneId], [UPPER, GROUND]);
      assert.deepEqual(names(t, fallId), ["goblin"], "the goblin's fall still waits");
      assert.deepEqual(step(t, ANA, "redo").falls?.map((f) => f.card && [f.card.tokenId, f.card.riders]), [["horse", undefined]], "the redo carries the horse alone");
      assert.equal(t.redo(ANA), "ok");
      assert.deepEqual(names(t, fallId), ["goblin", "horse"]);
    });

    test(`${name}: after the DM applies the rider's fall, the redo writes the root's card`, () => {
      const { t, fallId } = ridden(goblin, after);
      assert.equal(t.undo(ANA), "ok");
      assert.equal(t.play(DM, { t: "actor.outcome", plan: "p1", fall: { fallId, tokenIds: ["goblin"] }, targets: [{ target: { tokenId: "goblin" }, amount: 3 }] }), "ok");
      assert.deepEqual(cardIds(t), []);
      assert.equal(t.redo(ANA), "ok");
      assert.deepEqual(names(t, fallId), ["horse"]);
    });
  }

  test("fallsRestored carries the part of a card the undo took off: all of it where it went, none where it lost no one", () => {
    const record: FallRecord = { tokenId: "horse", linkId: "o1", rev: 0, made: 90, from: UPPER, to: GROUND, fallId: "7:0" };
    const card = { id: "7:0", rev: 0, tokenId: "horse", riders: ["goblin", "rat"], sceneId: GROUND, from: UPPER, ft: 10, made: 7 };
    const before = { ...tower(), falls: { "7:0": card } };
    const trimmed = { ...tower(), falls: { "7:0": { ...card, rev: 1, tokenId: "goblin", riders: undefined } } };
    assert.deepEqual(fallsRestored([record], "undo", before, trimmed), [{ ...record, card: { ...card, tokenId: "horse", riders: ["rat"] } }]);
    assert.deepEqual(fallsRestored([record], "undo", before, tower()), [{ ...record, card }]);
    assert.deepEqual(fallsRestored([record], "undo", before, before), [record]);
  });
});
