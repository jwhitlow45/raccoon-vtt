import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { UndoTable } from "#server/rooms/undoTesting.ts";
import { checkOps, serverApply, type OpPair } from "./differential.ts";
import { ANA, ATTIC, BREE, GROUND, UPPER, fallCard, putOp, run, thornToken, tower, trapdoor, withFalls, withOpening } from "./floorLinksTestutil.ts";
import type { RoomState, Scene, Token, Viewer } from "./model.ts";
import { projectState } from "./project.ts";
import type { Op } from "./protocol.ts";
import { DM, character, token, trap } from "./testutil.ts";

/*
 * Openings' privacy twins in the reducer, permissions and projection
 * (docs/design/design-v1-floors.md phase 4, 10.5): pairs of rooms that
 * differ only in what a player may not learn, the same steps made in
 * both, and every answer and each player's and the display's copy after
 * each step compared (shared/differential.ts). The twins that need a
 * player's history run through the room actor's own steps
 * (server/rooms/undoTesting.ts), the answers and copies compared the same
 * way. Over real sockets, frames and all, they run again in
 * server/rooms/openings.wire.itest.ts. Sight's twins are in
 * openingSight.twins.test.ts and project.openings.test.ts.
 *
 * The tower (floorLinksTestutil.ts): Ground floor (the players' start),
 * Upper floor, reached, and Attic. Its opening, o1 on Upper floor over o2
 * on Ground floor, lies 2 by 2 at 6, 6. Ana owns Thorn, Bree owns Wren.
 */

const DISPLAY: Viewer = { memberId: "display:abcdefghijkl", role: "player" };
const WATCHED = [ANA, BREE, DISPLAY] as const;

const move = (tokenId: string, x: number, y: number): Op => ({ t: "token.move", tokenId, x, y });
const reached = (state: RoomState, ...ids: string[]): RoomState => ({ ...state, openFloors: { ...state.openFloors, ...Object.fromEntries(ids.map((id) => [id, { sceneId: id, rev: 1 }])) } });

function withTokens(state: RoomState, ...tokens: Token[]): RoomState {
  return { ...state, tokens: { ...state.tokens, ...Object.fromEntries(tokens.map((t) => [t.id, t])) } };
}

/** Bree's creature, a PC. */
function wren(over: Partial<Token> = {}): Token {
  return token("wren", { kind: "pc", name: "Wren", disposition: "ally", ownerIds: ["p2"], actor: { ref: "wren" }, sceneId: UPPER, x: 4, y: 6, ...over });
}

/** The tower with Upper floor reached, its opening, and Thorn and Wren as told. */
function holed(over: { thorn?: Partial<Token>; wren?: Partial<Token>; rect?: { x: number; y: number; w: number; h: number } } = {}): RoomState {
  const base = tower({ tokens: { thorn: thornToken({ sceneId: UPPER, x: 4, y: 8, ...over.thorn }), wren: wren(over.wren) } });
  const s = { ...base, characters: { ...base.characters, wren: character("wren", { name: "Wren", ownerIds: ["p2"] }) } };
  return withOpening(reached(s, UPPER), over.rect ? { rect: over.rect } : {});
}

function pair(name: string, a: RoomState, b: RoomState, steps: OpPair["steps"]): void {
  checkOps({ name, a, b, equal: WATCHED, steps }, serverApply);
}

/** A hidden creature of the DM's, Medium unless told. */
const hidden = (id: string, over: Partial<Token>): Token => token(id, { name: "Goblin", visibility: "dm", sceneId: UPPER, ...over });

describe("O7: the DM's hidden monster over a hole", () => {
  test("walked onto the hole, or elsewhere upstairs: every player and the display observe the same", () => {
    const room = withTokens(holed(), hidden("lurker", { x: 10, y: 10 }));
    pair("O7", room, room, [{ who: DM, op: move("lurker", 6, 6), note: "onto the hole" }]);
    const fell = run(room, move("lurker", 6, 6));
    assert.equal(fell.tokens.lurker!.sceneId, GROUND, "it fell in the room the pair compares");
    pair("O7 apart", room, room, [{ who: DM, op: move("lurker", 12, 12), note: "off the hole" }]);
    // The two rooms after each, side by side: one fell, one did not.
    pair("O7 after", fell, run(room, move("lurker", 12, 12)), [{ who: BREE, op: { t: "log.chat", text: "Hm?" } }]);
  });
});

describe("O8: a monster players see falls into a floor not reached", () => {
  /**
   * Players hold Ground floor and the Attic. The Attic's hole drops to Upper
   * floor, not reached. In one room Upper floor is "Upper floor", 10 ft
   * high, with a goblin. In the other it is "Crypt", 20 ft high, raised
   * under the hole, with nothing on it.
   */
  function rooms(): { a: RoomState; b: RoomState } {
    const base = (upper: Partial<Scene>, more: Token[]) => {
      const t = tower({ tokens: { ogre: token("ogre", { name: "Ogre", sceneId: ATTIC, x: 4, y: 6 }), ...Object.fromEntries(more.map((m) => [m.id, m])) } });
      const s = reached({ ...t, scenes: { ...t.scenes, [UPPER]: { ...t.scenes[UPPER]!, ...upper } } }, ATTIC);
      return withOpening(s, { upper: ATTIC, lower: UPPER });
    };
    const a = base({}, [token("goblin", { name: "Goblin", sceneId: UPPER, x: 6, y: 9 })]);
    let b = base({ floor: { ...tower().scenes[UPPER]!.floor!, name: "Crypt", height: 20 } }, []);
    b = run(b, { t: "build.height", sceneId: UPPER, cells: ["6,6", "7,6", "6,7", "7,7"], height: 5 });
    b = withOpening(b, { upper: ATTIC, lower: UPPER });
    return { a, b };
  }

  test("the fall, a chat and Bree's own creature's walk: the same removal and copies, from the fall on", () => {
    const { a, b } = rooms();
    const [fa, fb] = [a, b].map((s) => run(s, move("ogre", 6, 6)));
    assert.deepEqual([fa!.tokens.ogre!.sceneId, fb!.tokens.ogre!.sceneId], [UPPER, UPPER], "the ogre falls in both");
    const ft = (s: RoomState) => Object.values(s.falls ?? {}).map((c) => c.ft);
    assert.notDeepEqual(ft(fa!), ft(fb!), "the drops differ, on the DM's cards alone");
    pair("O8", a, b, [
      { who: DM, op: move("ogre", 6, 6), note: "the ogre falls" },
      { who: BREE, op: { t: "log.chat", text: "Where did it go?" } },
      { who: DM, op: { t: "token.move", tokenId: "ogre", x: 8, y: 9 }, note: "the DM moves it below" },
    ]);
  });
});

describe("O13: a visible rider on a hidden mount straddling the rim", () => {
  /** Wren rides a hidden horse whose space straddles the hole's rim (7 to 9 by 6 to 8), or stands there alone. */
  function rooms(over: { wren?: Partial<Token>; horse?: Partial<Token> } = {}, rect?: { x: number; y: number; w: number; h: number }) {
    const a = withTokens(holed({ wren: { x: 8, y: 6, attached: { to: "horse", kind: "ride" }, ...over.wren }, ...(rect ? { rect } : {}) }), hidden("horse", { name: "Horse", size: "large", x: 7, y: 6, ...over.horse }));
    const b = holed({ wren: { x: 8, y: 6, ...over.wren }, ...(rect ? { rect } : {}) });
    return { a, b };
  }

  test("walked by Bree onto the hole: she falls alone, as with no mount", () => {
    const { a, b } = rooms();
    const fell = run(a, move("wren", 7, 6), BREE);
    assert.deepEqual([fell.tokens.wren!.sceneId, fell.tokens.horse!.sceneId], [GROUND, UPPER]);
    pair("O13 walk", a, b, [
      { who: BREE, op: move("wren", 7, 6), note: "onto the hole" },
      { who: BREE, op: move("wren", 8, 8), note: "on below" },
    ]);
  });

  test("seated on its rim over an armed trapdoor her other creature's walk springs: Wren drops alone, as with no mount", () => {
    // The trapdoor's 2 by 2 squares at 11 to 13. The horse stands at 12 to 14, Wren on its square over the trapdoor.
    const td = trapdoor("td1", { zone: { cells: [{ x: 11, y: 12, w: 2, h: 2 }] } });
    const kit = token("kit", { kind: "pc", name: "Kit", disposition: "ally", ownerIds: ["p2"], sceneId: UPPER, x: 9, y: 12 });
    const { a, b } = rooms({ wren: { x: 12, y: 12 }, horse: { x: 12, y: 12 } });
    const [ta, tb] = [a, b].map((s) => withTokens({ ...s, traps: { ...s.traps, td1: td } }, kit));
    const dropped = run(ta!, move("kit", 11, 12), BREE);
    assert.deepEqual([dropped.tokens.kit!.sceneId, dropped.tokens.wren!.sceneId, dropped.tokens.horse!.sceneId], [GROUND, GROUND, UPPER], "Kit and Wren drop, the horse stays");
    pair("O13 trapdoor", ta!, tb!, [{ who: BREE, op: move("kit", 11, 12), note: "Kit onto the trapdoor" }]);
  });

  test("on a hidden flying mount over the hole, Fly down: Wren flies alone, as with no mount", () => {
    const { a, b } = rooms({ wren: { x: 6, y: 6, elevation: 10 }, horse: { x: 6, y: 6, elevation: 10 } });
    const flown = run(a, { t: "token.climb", tokenId: "wren", linkId: "o1" }, BREE);
    assert.deepEqual([flown.tokens.wren!.sceneId, flown.tokens.horse!.sceneId], [GROUND, UPPER]);
    pair("O13 flight", a, b, [{ who: BREE, op: { t: "token.climb", tokenId: "wren", linkId: "o1" }, note: "Fly down" }]);
  });
});

describe("O6: a hidden pair or none", () => {
  test("Bree on its squares presses Go up: the same refusal as where none stands", () => {
    const base = withTokens(tower({ tokens: {} }), wren({ sceneId: GROUND, x: 3, y: 3 }));
    const withPair = run(base, putOp());
    const hiddenPair = { ...withPair, floorLinks: Object.fromEntries(Object.entries(withPair.floorLinks!).map(([id, link]) => [id, { ...link, hidden: true as const }])) };
    pair("O6", hiddenPair, base, [
      { who: BREE, op: { t: "token.climb", tokenId: "wren", linkId: "l1" }, note: "Go up" },
      { who: BREE, op: move("wren", 4, 3), note: "along" },
    ]);
  });
});

describe("O12: landings on armed traps, with a hidden rider or none", () => {
  /** An enter trap on squares, armed, public, stopping, as the trap pane makes one. */
  const enter = (id: string, sceneId: string, x: number, y: number, w = 2, h = 2) => trap(id, { sceneId, name: "Snare", zone: { cells: [{ x, y, w, h }] }, rig: { ...trap(id).rig!, floor: false } });
  /** An owl the DM hid, perched on Wren. */
  const owl = (w: Token) => hidden("owl", { name: "Owl", size: "tiny", sceneId: w.sceneId, x: w.x, y: w.y, attached: { to: "wren", kind: "perch" } });

  function rooms(state: RoomState): { a: RoomState; b: RoomState } {
    return { a: withTokens(state, owl(state.tokens.wren!)), b: state };
  }

  test("Wren climbs onto an enter trap on the landing floor", () => {
    let s = holed({ wren: { sceneId: GROUND, x: 3, y: 3 } });
    s = run(s, putOp());
    s = { ...s, traps: { ...s.traps, snare: enter("snare", UPPER, 3, 3) } };
    const { a, b } = rooms(s);
    const up = run(a, { t: "token.climb", tokenId: "wren", linkId: "l1" }, BREE);
    assert.equal(up.traps!.snare!.state, "sprung", "it springs on arrival");
    pair("O12 climb", a, b, [{ who: BREE, op: { t: "token.climb", tokenId: "wren", linkId: "l1" }, note: "Go up" }]);
  });

  test("Wren falls through the hole onto an enter trap below", () => {
    let s = holed();
    s = { ...s, traps: { ...s.traps, snare: enter("snare", GROUND, 6, 6) } };
    const { a, b } = rooms(s);
    const down = run(a, move("wren", 6, 6), BREE);
    assert.deepEqual([down.tokens.wren!.sceneId, down.traps!.snare!.state], [GROUND, "sprung"]);
    pair("O12 fall", a, b, [{ who: BREE, op: move("wren", 6, 6), note: "onto the hole" }]);
  });

  test("Wren's walk springs a trapdoor on the Attic that drops her onto a second trapdoor on Upper floor, and on to Ground floor", () => {
    let s = reached(holed({ wren: { sceneId: ATTIC, x: 10, y: 8 } }), ATTIC);
    s = { ...s, traps: { ...s.traps, top: trapdoor("top", { sceneId: ATTIC }), mid: trapdoor("mid") } };
    const { a, b } = rooms(s);
    const down = run(a, move("wren", 10, 10), BREE);
    assert.deepEqual([down.tokens.wren!.sceneId, down.traps!.top!.state, down.traps!.mid!.state], [GROUND, "sprung", "sprung"]);
    pair("O12 trapdoors", a, b, [{ who: BREE, op: move("wren", 10, 10), note: "onto the trapdoor" }]);
  });
});

/**
 * A twin pair through a player's history (undoTesting.ts): each step an op,
 * or an undo or a redo of the step's viewer, made in both rooms, the same
 * answer in both, and every watched copy the same after it.
 */
function historyTwins(name: string, a: RoomState, b: RoomState, steps: readonly { who: Viewer; op: Op | "undo" | "redo"; note?: string }[]): { a: UndoTable; b: UndoTable } {
  const ta = new UndoTable(a);
  const tb = new UndoTable(b);
  const copies = (t: UndoTable) => WATCHED.map((who) => projectState(t.state, who, { sceneId: t.state.meta.playerSceneId }));
  assert.deepEqual(copies(ta), copies(tb), `${name}: the copies start equal`);
  for (const [i, step] of steps.entries()) {
    const where = `${name}, step ${i + 1}${step.note ? ` (${step.note})` : ""}`;
    const go = (t: UndoTable) => (step.op === "undo" ? t.undo(step.who) : step.op === "redo" ? t.redo(step.who) : t.play(step.who, step.op));
    const answer = go(ta);
    assert.equal(go(tb), answer, `${where}: the answer`);
    assert.equal(answer, "ok", `${where}: applied`);
    assert.deepEqual(copies(ta), copies(tb), `${where}: every copy the same`);
  }
  return { a: ta, b: tb };
}

describe("O11c: a player's fall with hidden company, undone and redone", () => {
  test("Thorn drags a hidden goblin over the hole, or none: Ana's walk, Undo and Redo twice answer and read alike, and the goblin's card stays", () => {
    const wide = { x: 6, y: 6, w: 4, h: 4 };
    const base = holed({ thorn: { x: 3, y: 7 }, rect: wide });
    const a = withTokens(base, hidden("goblin", { x: 2, y: 7, attached: { to: "thorn", kind: "drag" } }));
    const steps = [{ who: ANA, op: move("thorn", 8, 7) as Op, note: "onto the hole" }, ...(["undo", "redo", "undo", "redo"] as const).map((op) => ({ who: ANA, op, note: op }))];
    const { a: ta } = historyTwins("O11c drag", a, base, steps);
    assert.equal(Object.values(ta.state.falls ?? {}).filter((c) => c.tokenId === "goblin").length, 1, "the goblin's card kept throughout");
  });

  test("Thorn's walk past a trapdoor drops a hidden goblin onto the hole, or no goblin: Ana's walk, Undo and Redo answer and read alike, and the goblin stays below", () => {
    const td = trapdoor("td1", { sceneId: ATTIC, zone: { cells: [{ x: 6, y: 6, w: 2, h: 2 }] }, rig: { ...trapdoor().rig!, stops: false, foundOnSpring: false } });
    const base = reached(holed({ thorn: { sceneId: ATTIC, x: 4, y: 6 } }), ATTIC);
    const b = { ...base, traps: { ...base.traps, td1: td } };
    const a = withTokens(b, hidden("goblin", { sceneId: ATTIC, x: 7, y: 7 }));
    const walk: Op = { t: "token.move", tokenId: "thorn", x: 9, y: 6, route: [[6, 6, 0, 0], [9, 6, 0, 0]] };
    const { a: ta } = historyTwins("O11c trapdoor", a, b, [
      { who: ANA, op: walk, note: "past the trapdoor" },
      { who: ANA, op: "undo" },
      { who: ANA, op: "redo" },
    ]);
    assert.equal(ta.state.tokens.goblin!.sceneId, GROUND);
    assert.equal(Object.values(ta.state.falls ?? {}).filter((c) => c.tokenId === "goblin").length, 2, "its drop's card and its fall's");
  });
});

describe("O11: a player's fall beside the DM's cards", () => {
  test("with no card or ten, the eleventh evicting the oldest: Ana's fall, Undo and Redo twice answer and read alike", () => {
    const cards = Array.from({ length: 10 }, (_, i) => fallCard({ id: `${20 + i}:0`, made: 20 + i, tokenId: `gone${i}` }));
    const b = holed({ thorn: { x: 4, y: 6 } });
    const a = withFalls(b, ...cards);
    const { a: ta, b: tb } = historyTwins("O11", a, b, [{ who: ANA, op: move("thorn", 6, 6), note: "onto the hole" }, ...(["undo", "redo", "undo", "redo"] as const).map((op) => ({ who: ANA, op, note: op }))]);
    assert.equal(Object.keys(ta.state.falls ?? {}).length, 10, "the room holds ten cards at most");
    assert.equal(Object.keys(tb.state.falls ?? {}).length, 1);
  });
});
