import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { ANA, ATTIC, GROUND, UPPER, applied, nextSeq, onThornsTurn, run, thornToken, tower, trapdoor, withOpening, withTrapdoor } from "../floorLinksTestutil.ts";
import type { RoomState, Token, Trap } from "../model.ts";
import { opSchema, PIT_OR_BELOW, type Op } from "../protocol.ts";
import { applyOp } from "../reducer.ts";
import { footprintGround } from "../rules/heights.ts";
import { DM, env, template, token, trap } from "../testutil.ts";

/*
 * Trapdoors (docs/design/design-v1-floors.md phase 4, 4.6): a pit trap
 * whose public springing drops each creature standing wholly on its squares
 * to the floor just below, onto the same squares, held up by nothing by the
 * fall pass's rule. The tower's trapdoor (td1) lies on Upper floor's
 * squares 10, 10 to 11, 11, armed and stopping.
 */

function up(id: string, over: Partial<Token> = {}): Token {
  return token(id, { sceneId: UPPER, name: id, ...over });
}

/** The tower with the trapdoor and Thorn on Upper floor, at 10, 10 unless told otherwise. */
function trapped(thorn: Partial<Token> = {}, door: Trap = trapdoor()): RoomState {
  return withTrapdoor(tower({ tokens: { thorn: thornToken({ sceneId: UPPER, x: 10, y: 10, ...thorn }) } }), door);
}

function withTokens(state: RoomState, ...tokens: Token[]): RoomState {
  return { ...state, tokens: { ...state.tokens, ...Object.fromEntries(tokens.map((t) => [t.id, t])) } };
}

function spring(...tokenIds: string[]): Op {
  return { t: "trap.spring", trapId: "td1", tokenIds };
}

function move(tokenId: string, x: number, y: number): Op {
  return { t: "token.move", tokenId, x, y };
}

function cards(state: RoomState): string[] {
  return Object.values(state.falls ?? {})
    .map((c) => `${c.tokenId} ${c.from}>${c.sceneId} ${c.ft}`)
    .sort();
}

function refusal(state: RoomState, op: Op): string {
  const r = applyOp(state, opSchema.parse(op), DM, env(nextSeq()));
  assert.ok(!r.ok, `${op.t} should be refused`);
  return r.message;
}

/** A trapdoor's input as `trap.create` takes it. */
function created(door: Trap): Op {
  const { id, sceneId, name, zone, rig } = door;
  return { t: "trap.create", trap: { id, sceneId, name, zone, rig: rig! } };
}

describe("who a trapdoor drops (4.6)", () => {
  test("Thorn wholly on it drops to the same squares of Ground floor with a card, and an ogre half on it stays", () => {
    const state = withTokens(trapped(), up("ogre", { size: "large", x: 11, y: 11 }));
    const r = applied(state, spring("thorn", "ogre"));
    const thorn = r.state.tokens.thorn!;
    assert.deepEqual([thorn.sceneId, thorn.x, thorn.y, thorn.elevation], [GROUND, 10, 10, 0]);
    assert.equal(r.state.tokens.ogre!.sceneId, UPPER);
    assert.deepEqual(cards(r.state), [`thorn ${UPPER}>${GROUND} 10`]);
    assert.equal(r.falls, undefined, "a drop is no fall through an opening, so it makes no record");
    assert.deepEqual(r.state.traps.td1!.zone, trapdoor().zone, "its squares do not change");
  });

  test("Ana's rider on a hidden mount on its rim falls alone and leaves the seat where her walk springs it, and stays seated where the DM's does", () => {
    // The hidden horse stands on 11, 10 to 12, 11, half over the trapdoor. Thorn rides it from 12, 10 onto 11, 10.
    const state = withTokens(trapped({ x: 12, y: 10, attached: { to: "horse", kind: "ride" } }), up("horse", { size: "large", x: 11, y: 10, visibility: "dm" }));
    const ana = applied(state, move("thorn", 11, 10), ANA);
    assert.equal(ana.state.tokens.thorn!.sceneId, GROUND);
    assert.equal(ana.state.tokens.thorn!.attached, undefined, "the seat goes");
    assert.equal(ana.state.tokens.horse!.sceneId, UPPER);
    assert.deepEqual(cards(ana.state), [`thorn ${UPPER}>${GROUND} 10`]);
    const dm = applied(state, move("thorn", 11, 10), DM);
    assert.equal(dm.state.traps.td1!.state, "sprung", "the DM's walk springs it too");
    assert.equal(dm.state.tokens.thorn!.sceneId, UPPER);
    assert.equal(dm.state.tokens.thorn!.attached?.to, "horse");
  });

  test("a hidden mount wholly on it under a player's springing drops apart from its rider, who drops alone", () => {
    // Both stand wholly on the squares: the rider drops first and lets go, so the horse's own drop never carries it.
    const state = withTokens(trapped({ x: 11, y: 11, attached: { to: "horse", kind: "ride" } }), up("horse", { size: "large", x: 10, y: 10, visibility: "dm" }));
    // A springing in Ana's op, so the hidden horse holds nothing up: the horse sorts first by id, and still never carries Thorn.
    const r = applied(state, spring("horse", "thorn"), ANA);
    assert.deepEqual([r.state.tokens.thorn!.sceneId, r.state.tokens.horse!.sceneId], [GROUND, GROUND]);
    assert.equal(r.state.tokens.thorn!.attached, undefined);
    assert.deepEqual([r.state.tokens.thorn!.x, r.state.tokens.thorn!.y, r.state.tokens.thorn!.elevation], [11, 11, 0]);
    assert.deepEqual(cards(r.state), [`horse ${UPPER}>${GROUND} 10`, `thorn ${UPPER}>${GROUND} 10`]);
  });

  test("what sits on a victim rides down seated, and what it drags stays where it stands and lets go", () => {
    const state = withTokens(
      trapped({ x: 10, y: 10, attached: { to: "horse", kind: "ride" } }),
      up("horse", { size: "large", x: 10, y: 10 }),
      up("goblin", { x: 12, y: 10, attached: { to: "horse", kind: "drag" } }),
    );
    const r = applied(state, spring("horse"));
    assert.deepEqual([r.state.tokens.horse!.sceneId, r.state.tokens.thorn!.sceneId, r.state.tokens.goblin!.sceneId], [GROUND, GROUND, UPPER]);
    assert.equal(r.state.tokens.thorn!.attached?.to, "horse");
    assert.equal(r.state.tokens.goblin!.attached, undefined, "the drag lets go");
    assert.deepEqual(cards(r.state), [`horse ${UPPER}>${GROUND} 10`], "one card, the victim's");
  });

  test("a squeezed creature lands full size on the ground under its full space", () => {
    const below = run(tower(), { t: "build.height", sceneId: GROUND, cells: ["11,11"], height: 5 });
    const state = withTrapdoor({ ...below, tokens: { ogre: up("ogre", { size: "large", x: 10, y: 10, squeeze: true }) } });
    const r = applied(state, spring("ogre"));
    const ogre = r.state.tokens.ogre!;
    assert.equal(ogre.sceneId, GROUND);
    assert.equal(ogre.squeeze, undefined);
    assert.equal(ogre.elevation, 5);
    assert.equal(ogre.elevation, footprintGround(r.state.buildChunks, ogre));
  });

  test("the drop measures from the ground the victim stood on to the ground it lands on", () => {
    const raised = run(tower(), { t: "build.height", sceneId: UPPER, cells: ["10,10", "11,10", "10,11", "11,11"], height: 5 });
    const state = withTrapdoor({ ...raised, tokens: { thorn: thornToken({ sceneId: UPPER, x: 10, y: 10, elevation: 5 }) } });
    const r = applied(state, spring("thorn"));
    assert.equal(r.state.tokens.thorn!.elevation, 0);
    assert.deepEqual(cards(r.state), [`thorn ${UPPER}>${GROUND} 15`]);
  });

  test("a victim whose space would leave the floor below stays where it stands", () => {
    const base = trapped();
    const state = { ...base, scenes: { ...base.scenes, [GROUND]: { ...base.scenes[GROUND]!, bounds: { w: 10, h: 10 } } } };
    const r = applied(state, spring("thorn"));
    assert.equal(r.state.tokens.thorn!.sceneId, UPPER);
    assert.deepEqual(cards(r.state), []);
  });

  test("a creature in the air over it, an object on it and one held up by a holder every player sees stay", () => {
    const state = withTokens(
      trapped({ x: 10, y: 10, elevation: 10 }),
      up("chest", { kind: "object", x: 11, y: 10 }),
      up("cat", { size: "tiny", x: 11, y: 11, attached: { to: "ogre", kind: "perch" } }),
      up("ogre", { size: "large", x: 11, y: 11 }),
    );
    const r = applied(state, spring("thorn"), ANA);
    assert.deepEqual([r.state.tokens.thorn!.sceneId, r.state.tokens.chest!.sceneId, r.state.tokens.cat!.sceneId], [UPPER, UPPER, UPPER]);
  });

  test("a victim dropped onto an opening below falls on through it, a card for each, and a record for the fall", () => {
    const door = trapdoor("td1", { sceneId: ATTIC, zone: { cells: [{ x: 6, y: 6, w: 2, h: 2 }] } });
    const state = withTrapdoor(withOpening(tower({ tokens: { thorn: thornToken({ sceneId: ATTIC, x: 4, y: 6 }) } })), door);
    const r = applied(state, move("thorn", 6, 6), ANA);
    assert.equal(r.state.tokens.thorn!.sceneId, GROUND);
    assert.deepEqual(cards(r.state), [`thorn ${ATTIC}>${UPPER} 10`, `thorn ${UPPER}>${GROUND} 10`]);
    assert.equal(r.falls?.length, 1);
    // The drop's card is first written at step 4b, a trap key. The fall's is the fall pass's, which is no trap's.
    const [drop, fall] = Object.values(r.state.falls ?? {}).sort((a, b) => (a.id < b.id ? -1 : 1));
    assert.deepEqual([drop?.from, fall?.from], [ATTIC, UPPER]);
    assert.ok(r.trapWrote?.has(`fall:${drop!.id}`));
    assert.ok(!r.trapWrote?.has(`fall:${fall!.id}`));
  });

  test("a victim the arrival step's trapdoor drops onto an opening falls on through it, and lands on nothing more", () => {
    // Four floors: a cellar under Ground floor, and a hole in Ground floor at 10, 10 onto it.
    const base = tower({ tokens: { thorn: thornToken({ sceneId: ATTIC, x: 10, y: 10 }) } });
    const cellar = { ...base.scenes[GROUND]!, id: "cl", name: "Tower", floor: { of: GROUND, level: -1, name: "Cellar", height: 10 } };
    const four = withOpening({ ...base, scenes: { ...base.scenes, cl: cellar } }, { id: "o5", pairId: "o6", upper: GROUND, lower: "cl", rect: { x: 10, y: 10, w: 2, h: 2 } });
    const state = withTrapdoor(withTrapdoor(four, trapdoor("td1", { sceneId: ATTIC })), trapdoor("td2"));
    const r = applied(state, spring("thorn"));
    assert.equal(r.state.tokens.thorn!.sceneId, "cl");
    assert.deepEqual(cards(r.state), [`thorn ${ATTIC}>${UPPER} 10`, `thorn ${GROUND}>cl 10`, `thorn ${UPPER}>${GROUND} 10`]);
    assert.deepEqual(
      r.falls?.map((f) => [f.from, f.to]),
      [[GROUND, "cl"]],
    );
  });

  test("Do its effects drops at once what stands on it", () => {
    const door = trapdoor();
    const waiting: Trap = { ...door, rig: { ...door.rig!, due: [{ id: "90:0", at: "2026-10-12T20:00:00.000Z", how: "enter", by: ["thorn"], hits: ["thorn"], hidden: true }] } };
    const r = applied(trapped({}, waiting), { t: "trap.act", trapId: "td1", due: "90:0" });
    assert.equal(r.state.tokens.thorn!.sceneId, GROUND);
    assert.deepEqual(cards(r.state), [`thorn ${UPPER}>${GROUND} 10`]);
  });
});

describe("a walk onto a trapdoor (4.3 steps 2 to 4b)", () => {
  test("a stopping trapdoor stops a walk across it over its squares, and drops the walker there", () => {
    const r = applied(trapped({ x: 7, y: 10 }), { t: "token.move", tokenId: "thorn", x: 14, y: 10, route: [[14, 10, 0, 0]] }, ANA);
    const thorn = r.state.tokens.thorn!;
    assert.deepEqual([thorn.sceneId, thorn.x, thorn.y], [GROUND, 10, 10]);
  });

  test("a Large walker stops wholly over it, past where it first stepped on, and drops", () => {
    // Its first stand on the squares, at 9, 10, is half over them: the stop walks on to where all of it stands there.
    const state = withTokens(trapped({ x: 2, y: 2 }), up("ogre", { size: "large", x: 5, y: 10 }));
    const r = applied(state, { t: "token.move", tokenId: "ogre", x: 14, y: 10, route: [[14, 10, 0, 0]] });
    const ogre = r.state.tokens.ogre!;
    assert.deepEqual([ogre.sceneId, ogre.x, ogre.y], [GROUND, 10, 10]);
  });

  test("one that stops nothing lets the walk on past it, and drops no one", () => {
    const door = trapdoor();
    const r = applied(trapped({ x: 7, y: 10 }, { ...door, rig: { ...door.rig!, stops: false } }), { t: "token.move", tokenId: "thorn", x: 14, y: 10, route: [[14, 10, 0, 0]] }, ANA);
    assert.deepEqual([r.state.tokens.thorn!.sceneId, r.state.tokens.thorn!.x], [UPPER, 14]);
    assert.equal(r.state.traps.td1!.state, "sprung");
    assert.deepEqual(cards(r.state), []);
  });

  test("the walk's reminders read the stopped walk before the drop, and the drop's writes are trap keys of a step Ana cannot undo herself", () => {
    const guardians = template("sg", { sceneId: UPPER, shape: "sphere", size: 10, origin: { x: 11, y: 11, z: 0 }, ownerId: "dm1", spell: "Spirit Guardians", triggers: ["enter"] });
    const state = onThornsTurn({ ...trapped({ x: 4, y: 10 }), templates: { sg: guardians } });
    const r = applied(state, move("thorn", 10, 10), ANA);
    assert.equal(r.state.tokens.thorn!.sceneId, GROUND);
    const reminders = r.state.log.filter((l) => l.data?.type === "area").map((l) => (l.data as { templateId: string }).templateId);
    assert.deepEqual(reminders, ["sg"], "reminded on Upper floor, where the walk stopped");
    const card = Object.keys(r.state.falls ?? {})[0]!;
    assert.ok(r.trapWrote?.has(`fall:${card}`));
    assert.ok(!r.trapWrote?.has("token:thorn"), "the walk wrote Thorn first, so its write stays the move's");
    assert.equal(r.trapped, true);
  });

  test("a private springing in a player's walk drops nothing", () => {
    // The DM hid Thorn, and players reached Upper floor before.
    const base = trapped({ x: 7, y: 10, visibility: "dm" });
    const state = { ...base, openFloors: { [UPPER]: { sceneId: UPPER, rev: 0 } } };
    const r = applied(state, move("thorn", 10, 10), ANA);
    assert.deepEqual([r.state.tokens.thorn!.sceneId, r.state.traps.td1!.state], [UPPER, "armed"]);
    assert.equal(r.state.traps.td1!.rig!.due?.[0]?.hidden, true, "its effects wait for the DM");
    assert.deepEqual(cards(r.state), []);
  });
});

describe("a trapdoor's rig (4.6)", () => {
  test("the lowest floor refuses one", () => {
    assert.equal(refusal(tower(), created(trapdoor("td1", { sceneId: GROUND }))), "There is no floor below Ground floor.");
    assert.equal(refusal(tower(), created(trapdoor("td1", { sceneId: "s2" }))), "There is no floor below this scene.");
  });

  test("a rig never opens a pit and drops to the floor below at once, and a trip wire never drops", () => {
    const pit = trap("tp", { sceneId: UPPER, zone: { cells: [{ x: 10, y: 10, w: 2, h: 2 }] }, rig: { ...trap("tp").rig!, pit: { floor: -10 } } });
    assert.equal(refusal({ ...tower(), traps: { tp: pit } }, { t: "trap.update", trapId: "tp", patch: { rig: { below: true } } }), PIT_OR_BELOW);
    const wire = trapdoor("tw", { zone: { wire: { a: [2, 2], b: [4, 2] } } as Trap["zone"], rig: { ...trapdoor().rig!, on: [] } });
    assert.equal(refusal(tower(), created(wire)), "only a trap on squares drops to the floor below");
  });

  test("one whose floor below has gone since drops no one, and its line says it could not open", () => {
    const door = trapdoor("td1", { sceneId: GROUND });
    const r = applied(withTrapdoor(tower({ tokens: { thorn: thornToken({ x: 10, y: 10 }) } }), door), spring("thorn"));
    assert.equal(r.state.tokens.thorn!.sceneId, GROUND);
    const line = (r.state.trapLog ?? []).find((l) => l.data?.type === "trap");
    assert.deepEqual(line?.data?.type === "trap" ? line.data.did : null, [{ action: -1, ok: false }]);
    assert.deepEqual(cards(r.state), []);
  });

  test("a trapdoor's springing at change format 63 runs no drop", () => {
    // No stored op makes one, so this reads only that the drops are of 64 alone.
    const r = applied(trapped(), spring("thorn"), DM, 63);
    assert.equal(r.state.tokens.thorn!.sceneId, UPPER);
  });
});

describe("a trapdoor whose floor below was removed since", () => {
  test("still takes a rename, and refuses only setting `below` again", () => {
    const base = withTrapdoor(tower({ tokens: {} }), trapdoor("td1", { sceneId: UPPER }));
    // Upper floor's floor below gone, as Remove floor would leave it: Upper floor is the lowest now.
    const scenes = { ...base.scenes };
    delete scenes[GROUND];
    scenes[UPPER] = { ...scenes[UPPER]!, floor: { ...scenes[UPPER]!.floor!, of: UPPER, level: 0 } };
    scenes[ATTIC] = { ...scenes[ATTIC]!, floor: { ...scenes[ATTIC]!.floor!, of: UPPER, level: 1 } };
    const lone: RoomState = { ...base, scenes, meta: { ...base.meta, playerSceneId: UPPER } };
    const renamed = applyOp(lone, opSchema.parse({ t: "trap.update", trapId: "td1", patch: { name: "Old trapdoor" } }), DM, env(nextSeq()));
    assert.ok(renamed.ok, renamed.ok ? "" : renamed.message);
    const reset = applyOp(lone, opSchema.parse({ t: "trap.update", trapId: "td1", patch: { rig: { below: true } } }), DM, env(nextSeq()));
    assert.deepEqual(reset.ok ? null : reset.message, "There is no floor below Upper floor.");
  });
});
