import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { ANA, ATTIC, GROUND, UPPER, applied, onThornsTurn, putOp, refusal, run, thornToken, tower, withStairs } from "../floorLinksTestutil.ts";
import type { RoomState, Token } from "../model.ts";
import type { Op, RestoreEntry } from "../protocol.ts";
import { LINK_WORDS, linksProblem } from "../rules/floorLinks.ts";
import { floorProblem } from "../rules/floors.ts";
import { DM, actor, effect, token } from "../testutil.ts";
import { derivedId } from "./duplicate.ts";

/*
 * The stairs and ladders reducer (docs/design/design-v1-floors.md phase 2,
 * 3, 5): placing, changing and removing a pair, a climb with its path,
 * passengers, squeeze and opened floor, the stairs going with a removed
 * floor, and Duplicate. The ops' undo is the generic restore of their
 * inverse here. A player's climb undo is server/rooms/undo.floorLinks.test.ts.
 */

const climb = (tokenId = "thorn", linkId = "l1"): Op => ({ t: "token.climb", tokenId, linkId });
const move = (x: number, y: number, tokenId = "thorn"): Op => ({ t: "token.move", tokenId, x, y });
const undo = (state: RoomState, entries: readonly RestoreEntry[] | null): RoomState => run(state, { t: "sys.restore", entries: [...(entries ?? [])], from: "undo" });
/** What the turn's path says Thorn moved, as the marker reads it: `prior` and this floor's counted legs. */
function movedFt(t: Token): number {
  const legs = (t.path?.stops ?? []).slice(1).filter((s) => s.uncounted !== true);
  return (t.path?.prior?.moved ?? 0) + legs.reduce((n, s) => n + (s.moved ?? 0), 0);
}
function costFt(t: Token): number {
  const legs = (t.path?.stops ?? []).slice(1).filter((s) => s.uncounted !== true);
  return (t.path?.prior?.cost ?? 0) + legs.reduce((n, s) => n + (s.cost ?? 0), 0);
}
/** A raised square under a floor's cells, by the DM's height brush. */
const raise = (sceneId: string, cells: string[], height: number): Op => ({ t: "build.height", sceneId, cells, height });

describe("placing, changing and removing stairs (3)", () => {
  test("a put writes both ends on the same squares, each with its ground, the op's seq and one rev", () => {
    const base = run(tower(), raise(UPPER, ["3,3", "4,3"], 5));
    const r = applied(base, putOp());
    const [l1, l2] = [r.state.floorLinks!.l1!, r.state.floorLinks!.l2!];
    assert.deepEqual({ ...l1, made: 0 }, { id: "l1", rev: 1, sceneId: GROUND, to: UPPER, pair: "l2", rect: { x: 3, y: 3, w: 2, h: 1 }, kind: "stairs", ground: 0, made: 0 });
    assert.deepEqual({ ...l2, made: 0 }, { id: "l2", rev: 1, sceneId: UPPER, to: GROUND, pair: "l1", rect: { x: 3, y: 3, w: 2, h: 1 }, kind: "stairs", ground: 5, made: 0 });
    assert.equal(l1.made, l2.made);
    assert.ok(l1.made > 0);
    assert.equal(floorProblem(r.state, GROUND), null);
    assert.deepEqual(undo(r.state, r.inverse).floorLinks ?? {}, {});
  });

  test("a lock or a kind changes both ends, each rev moving on, and its undo takes it back", () => {
    const s = withStairs();
    const locked = applied(s, { t: "floorLink.update", linkId: "l2", patch: { locked: true } });
    assert.equal(locked.state.floorLinks!.l1!.locked, true);
    assert.equal(locked.state.floorLinks!.l2!.locked, true);
    assert.deepEqual([locked.state.floorLinks!.l1!.rev, locked.state.floorLinks!.l2!.rev], [2, 2]);
    const ladder = run(locked.state, { t: "floorLink.update", linkId: "l1", patch: { kind: "ladder", locked: false } });
    assert.deepEqual([ladder.floorLinks!.l1!.kind, ladder.floorLinks!.l2!.kind, ladder.floorLinks!.l1!.locked], ["ladder", "ladder", undefined]);
    assert.equal(floorProblem(ladder, GROUND), null);
    assert.equal(undo(locked.state, locked.inverse).floorLinks!.l1!.locked, undefined);
  });

  test("a delete takes both ends, by either end, and its undo puts both back", () => {
    const s = withStairs();
    const r = applied(s, { t: "floorLink.delete", linkId: "l2" });
    assert.deepEqual(r.state.floorLinks ?? {}, {});
    assert.deepEqual(undo(r.state, r.inverse).floorLinks, s.floorLinks);
    assert.match(refusal(r.state, { t: "floorLink.delete", linkId: "l1" }), /not here/);
  });

  test("a put is refused in the builder's words (7.3)", () => {
    const s = tower();
    assert.equal(refusal(s, putOp({ to: ATTIC })), LINK_WORDS.notNext);
    assert.equal(refusal(s, putOp({ to: "s2" })), LINK_WORDS.notNext);
    assert.equal(refusal(s, putOp({ rect: { x: 19, y: 3, w: 2, h: 1 } })), "Ground floor ends before those squares.");
    assert.equal(refusal(run(s, raise(UPPER, ["4,3"], 5)), putOp()), "Those squares aren't one height on Upper floor.");
    assert.equal(refusal(run(s, { t: "build.edge", sceneId: UPPER, edges: [{ key: "4,3,w", feature: { kind: "wall" } }] }), putOp()), "A wall crosses those squares on Upper floor.");
    // A wall along the squares' edge stands beside them, not across them.
    assert.equal(run(run(s, { t: "build.edge", sceneId: UPPER, edges: [{ key: "3,3,n", feature: { kind: "wall" } }] }), putOp()).floorLinks!.l1!.sceneId, GROUND);
    const pit = { ...s, traps: { p: { id: "p", rev: 1, sceneId: GROUND, name: "Pit", zone: { cells: [{ x: 4, y: 3, w: 1, h: 1 }] }, state: "armed" as const, found: false, rig: { on: ["enter" as const], who: "any" as const, floor: true, resets: "never" as const, stops: true, foundOnSpring: true, pit: { floor: -10 }, hits: "trigger" as const, actions: [], find: [], notice: false } } } };
    assert.equal(refusal(pit, putOp()), "A pit trap lies under those squares on Ground floor.");
    const one = withStairs(s);
    assert.equal(refusal(one, putOp({ id: "l3", pairId: "l4", rect: { x: 4, y: 3, w: 1, h: 1 } })), "Those squares already have stairs to Upper floor.");
    assert.equal(refusal(one, putOp({ id: "l3", pairId: "l4", sceneId: UPPER, to: ATTIC, kind: "ladder", rect: { x: 4, y: 3, w: 1, h: 1 } })), "Those squares already have stairs to Ground floor.");
    assert.equal(refusal(one, putOp()), "those stairs are already on the map");
  });

  test("a scene holds 16 pairs, the 17th refused", () => {
    let s = tower();
    for (let i = 0; i < 16; i++) s = run(s, putOp({ id: `a${i}`, pairId: `b${i}`, sceneId: i % 2 === 0 ? GROUND : UPPER, to: i % 2 === 0 ? UPPER : ATTIC, rect: { x: i, y: 10, w: 1, h: 1 } }));
    assert.equal(floorProblem(s, GROUND), null);
    assert.equal(refusal(s, putOp({ id: "a16", pairId: "b16", rect: { x: 0, y: 0, w: 1, h: 1 } })), "Tower has 16 stairs and ladders, the most a scene can hold.");
  });

  test("removing a floor takes the stairs to it, and its undo brings them back", () => {
    const s = run(withStairs(), putOp({ id: "l3", pairId: "l4", sceneId: UPPER, to: ATTIC, kind: "ladder", rect: { x: 8, y: 8, w: 1, h: 1 } }));
    const r = applied(s, { t: "scene.delete", sceneId: UPPER });
    assert.deepEqual(r.state.floorLinks ?? {}, {});
    assert.equal(floorProblem(r.state, GROUND), null);
    const back = undo(r.state, r.inverse);
    assert.deepEqual(back.floorLinks, s.floorLinks);
    assert.equal(floorProblem(back, GROUND), null);
  });

  test("an op stored before the stairs' version leaves stairs to a removed floor, which floorProblem then names", () => {
    const s = withStairs();
    const old = run(s, { t: "scene.delete", sceneId: UPPER }, DM, 57);
    assert.equal(Object.keys(old.floorLinks!).length, 2);
    assert.match(linksProblem(old, GROUND)!, /don't fit its floors/);
  });

  test("Duplicate copies each pair onto the copies of both floors, with derived ids and its own seq", () => {
    const s = run(withStairs(), { t: "floorLink.update", linkId: "l1", patch: { locked: true } });
    const r = applied(s, { t: "scene.duplicate", sceneId: GROUND, newSceneId: "copy", name: "Tower 2", include: { creatures: false, characters: false, fog: false, drawings: false } });
    const upCopy = derivedId("copy", UPPER);
    const a = r.state.floorLinks![derivedId("copy", "l1")]!;
    const b = r.state.floorLinks![derivedId("copy", "l2")]!;
    assert.deepEqual([a.sceneId, a.to, a.pair, b.sceneId, b.to, b.pair], ["copy", upCopy, b.id, upCopy, "copy", a.id]);
    assert.equal(a.locked, true);
    assert.equal(a.made, b.made);
    assert.notEqual(a.made, s.floorLinks!.l1!.made);
    assert.equal(floorProblem(r.state, "copy"), null);
    assert.equal(floorProblem(r.state, GROUND), null);
  });
});

describe("a climb (3, 5)", () => {
  test("a 50 ft walk onto stairs then Go up lands on Upper floor's same squares, on its ground, Moved 60 ft", () => {
    let s = onThornsTurn(withStairs(run(tower(), raise(UPPER, ["3,3", "4,3"], 5))));
    s = run(s, move(3, 8), ANA);
    s = run(s, move(3, 3), ANA);
    const r = applied(s, climb(), ANA);
    const t = r.state.tokens.thorn!;
    assert.deepEqual([t.sceneId, t.x, t.y, t.elevation], [UPPER, 3, 3, 5]);
    assert.deepEqual(t.path!.prior, { moved: 50, cost: 50, seenDiag: [0, 0] });
    assert.equal(t.path!.stops.length, 2);
    assert.deepEqual([t.path!.stops[1]!.moved, t.path!.stops[1]!.cost], [10, 10]);
    assert.equal(movedFt(t), 60);
    assert.equal(floorProblem(r.state, GROUND), null);
  });

  test("the case table's walk: 25 ft, then the climb, reads Moved 35 ft", () => {
    let s = onThornsTurn(withStairs(tower(), { rect: { x: 3, y: 8, w: 1, h: 1 } }));
    s = run(s, move(3, 8), ANA);
    assert.equal(movedFt(s.tokens.thorn!), 25);
    s = run(s, climb(), ANA);
    assert.equal(movedFt(s.tokens.thorn!), 35);
  });

  test("up then down in one turn keeps both floors in prior, and Moved counts both climbs", () => {
    let s = onThornsTurn(withStairs(tower(), { rect: { x: 3, y: 8, w: 1, h: 1 } }));
    s = run(s, move(3, 8), ANA);
    s = run(s, climb(), ANA);
    s = run(s, climb("thorn", "l2"), ANA);
    const t = s.tokens.thorn!;
    assert.equal(t.sceneId, GROUND);
    assert.deepEqual(t.path!.prior, { moved: 35, cost: 35, seenDiag: [0, 0] });
    assert.equal(movedFt(t), 45);
  });

  test("under 5-10-5 a diagonal before a climb runs the count on after it, counted once", () => {
    const fiveTen = tower();
    fiveTen.meta = { ...fiveTen.meta, settings: { ...fiveTen.meta.settings, diagonal: "fiveTen" } };
    let s = onThornsTurn(withStairs(fiveTen, { rect: { x: 4, y: 4, w: 1, h: 1 } }));
    s = run(s, move(4, 4), ANA);
    s = run(s, climb(), ANA);
    const prior = s.tokens.thorn!.path!.prior!;
    assert.equal(prior.moved, 5);
    assert.ok(prior.diag !== undefined && prior.diag[0] + prior.diag[1] > 0, "the diagonal is counted");
    assert.deepEqual(prior.seenDiag, prior.diag, "every player saw it");
    // The turn's second diagonal costs 10 ft, the third 5 ft again.
    s = run(s, move(5, 5), ANA);
    assert.equal(s.tokens.thorn!.path!.stops.at(-1)!.moved, 10);
    s = run(s, move(6, 6), ANA);
    assert.equal(s.tokens.thorn!.path!.stops.at(-1)!.moved, 5);
  });

  test("Doesn't count on the climb leaves the walk before it, and a resize keeps prior", () => {
    let s = onThornsTurn(withStairs(tower(), { rect: { x: 3, y: 8, w: 1, h: 1 } }));
    s = run(s, move(3, 8), ANA);
    s = run(s, climb(), ANA);
    const uncounted = run(s, { t: "token.countLeg", tokenId: "thorn", counts: false }, ANA);
    assert.equal(movedFt(uncounted.tokens.thorn!), 25);
    assert.deepEqual(uncounted.tokens.thorn!.path!.prior, s.tokens.thorn!.path!.prior);
    const grown = run(s, { t: "token.update", tokenId: "thorn", patch: { size: "large" } });
    assert.deepEqual(grown.tokens.thorn!.path!.prior, s.tokens.thorn!.path!.prior);
    const moved = run(s, move(5, 8), ANA);
    assert.deepEqual(moved.tokens.thorn!.path!.prior, s.tokens.thorn!.path!.prior);
  });

  test("Move to floor mid-turn keeps the turn's feet in prior with one stop, and an op of 57 drops the path as stored", () => {
    let s = onThornsTurn(tower());
    s = run(s, move(3, 8), ANA);
    const now = run(s, { t: "token.update", tokenId: "thorn", patch: { sceneId: UPPER } });
    assert.deepEqual(now.tokens.thorn!.path!.prior, { moved: 25, cost: 25, seenDiag: [0, 0] });
    assert.equal(now.tokens.thorn!.path!.stops.length, 1);
    assert.equal(run(s, { t: "token.update", tokenId: "thorn", patch: { sceneId: UPPER } }, DM, 57).tokens.thorn!.path, undefined);
    // To another scene the path still goes.
    assert.equal(run(s, { t: "token.update", tokenId: "thorn", patch: { sceneId: "s2" } }).tokens.thorn!.path, undefined);
  });

  test("off its turn a climb writes no path", () => {
    const s = run(withStairs(), climb(), ANA);
    assert.equal(s.tokens.thorn!.sceneId, UPPER);
    assert.equal(s.tokens.thorn!.path, undefined);
  });

  test("Upper floor 20 ft high: stairs 20 ft, a ladder 40 ft, with a Climb Speed 20 ft", () => {
    const high = (s: RoomState) => ({ ...s, scenes: { ...s.scenes, [UPPER]: { ...s.scenes[UPPER]!, floor: { ...s.scenes[UPPER]!.floor!, height: 20 } } } });
    const leg = (s: RoomState) => s.tokens.thorn!.path!.stops[1]!;
    const stairs = run(onThornsTurn(withStairs(high(tower()))), climb(), ANA);
    assert.deepEqual([leg(stairs).moved, leg(stairs).cost], [20, 20]);
    const ladder = run(onThornsTurn(withStairs(high(tower()), { kind: "ladder" })), climb(), ANA);
    assert.deepEqual([leg(ladder).moved, leg(ladder).cost], [20, 40]);
    const climber = high(tower());
    climber.characters = { ...climber.characters, thorn: { ...climber.characters.thorn!, actor: actor({ speeds: { walk: 30, climb: 30 } }) } };
    const quick = run(onThornsTurn(withStairs(climber, { kind: "ladder" })), climb(), ANA);
    assert.deepEqual([leg(quick).moved, leg(quick).cost], [20, 20]);
    // Down costs as up, and the height read is the upper floor's.
    const down = run(run(onThornsTurn(withStairs(high(tower()))), climb(), ANA), climb("thorn", "l2"), ANA);
    assert.deepEqual([leg(down).moved, leg(down).cost], [20, 20]);
  });

  test("a party member's climb opens a floor the DM hid (D-261109-103)", () => {
    const s = withStairs();
    assert.equal(s.openFloors?.[UPPER], undefined);
    assert.ok(run(s, climb(), ANA).openFloors?.[UPPER]);
  });
});

describe("what a climb takes and leaves (3)", () => {
  test("a torch it carries and an owl on its shoulder go up on their seats, and an ally it drags stays, let go", () => {
    const s = withStairs(
      tower({
        tokens: {
          thorn: thornToken(),
          torch: token("torch", { name: "Torch", kind: "object", size: "tiny", x: 3.5, y: 3.5, attached: { to: "thorn", kind: "carry" } }),
          owl: token("owl", { name: "Owl", size: "tiny", x: 3, y: 3, visibility: "dm", attached: { to: "thorn", kind: "perch" } }),
          ally: token("ally", { name: "Ally", x: 3, y: 4, attached: { to: "thorn", kind: "drag" } }),
        },
      }),
    );
    const r = applied(s, climb(), ANA);
    assert.deepEqual([r.state.tokens.torch!.sceneId, r.state.tokens.torch!.attached?.to], [UPPER, "thorn"]);
    assert.deepEqual([r.state.tokens.owl!.sceneId, r.state.tokens.owl!.attached?.to], [UPPER, "thorn"]);
    assert.equal(r.state.tokens.ally!.sceneId, GROUND);
    assert.equal(r.state.tokens.ally!.attached, undefined);
    const back = undo(r.state, r.inverse).tokens;
    for (const id of Object.keys(s.tokens)) assert.deepEqual({ ...back[id]!, rev: 0 }, { ...s.tokens[id]!, rev: 0 }, id);
  });

  test("its areas follow it up", () => {
    const s = withStairs(tower({ templates: { aura: { id: "aura", rev: 0, sceneId: GROUND, shape: "sphere", size: 10, origin: { x: 3.5, y: 3.5, z: 0 }, yaw: 0, includeOrigin: true, ownerId: "dm1", attachedTo: "thorn" } as RoomState["templates"][string] } }));
    assert.equal(run(s, climb(), ANA).templates.aura!.sceneId, UPPER);
  });

  test("a rider whose holder its player does not receive climbs alone, and the link lets go", () => {
    const s = withStairs(
      tower({
        tokens: {
          thorn: thornToken({ x: 3, y: 3, attached: { to: "mount", kind: "ride" } }),
          mount: token("mount", { name: "Hidden mount", x: 3, y: 3, visibility: "dm" }),
        },
      }),
      { rect: { x: 3, y: 3, w: 2, h: 1 } },
    );
    const r = applied(s, climb(), ANA);
    assert.equal(r.state.tokens.thorn!.sceneId, UPPER);
    assert.equal(r.state.tokens.thorn!.attached, undefined);
    assert.equal(r.state.tokens.mount!.sceneId, GROUND);
    // The DM receives every holder, so for the DM the holder takes the stairs.
    assert.equal(refusal(s, climb()), "Thorn is carried. Its holder takes the stairs.");
  });

  test("a squeezed Large creature keeps its squeeze on 1 by 2 stairs and stands full size off 2 by 2", () => {
    const large = (rect: { x: number; y: number; w: number; h: number }, at: { x: number; y: number }) =>
      withStairs(tower({ tokens: { thorn: thornToken({ size: "large", squeeze: true, ...at }) } }), { rect });
    // Squeezed, a Large creature's 1 by 1 space centered on its 2 by 2 box: stored at 2.5, 2.5 its space is 3, 3.
    const narrow = run(large({ x: 3, y: 3, w: 1, h: 2 }, { x: 2.5, y: 2.5 }), climb(), ANA);
    assert.equal(narrow.tokens.thorn!.squeeze, true);
    const wide = run(large({ x: 3, y: 3, w: 2, h: 2 }, { x: 3, y: 3 }), climb(), ANA);
    assert.equal(wide.tokens.thorn!.squeeze, undefined);
  });

  test("its placement between squares goes", () => {
    const s = withStairs(tower({ tokens: { thorn: thornToken({ nudge: { x: 0.25, y: 0 } } as Partial<Token>) } }));
    assert.equal(run(s, climb(), ANA).tokens.thorn!.nudge, undefined);
  });
});

describe("a climb's refusals (6.3)", () => {
  test("locked, too big, a squeeze that would fit, and stairs not under it, in one set of words", () => {
    const s = withStairs();
    assert.equal(refusal(run(s, { t: "floorLink.update", linkId: "l1", patch: { locked: true } }), climb(), ANA), "It's locked.");
    const big = withStairs(tower({ tokens: { thorn: thornToken({ size: "large", x: 3, y: 3 }) } }), { rect: { x: 3, y: 3, w: 1, h: 1 } });
    assert.equal(refusal(big, climb(), ANA), "Too big for these stairs.");
    const ladder = withStairs(tower({ tokens: { thorn: thornToken({ size: "large", x: 3, y: 3 }) } }), { rect: { x: 3, y: 3, w: 1, h: 1 }, kind: "ladder" });
    assert.equal(refusal(ladder, climb(), ANA), "Too big for this ladder.");
    for (const thorn of [thornToken({ x: 8, y: 8 }), thornToken({ elevation: 10 }), thornToken({ sceneId: UPPER })]) {
      assert.equal(refusal(withStairs(tower({ tokens: { thorn } })), climb(), ANA), LINK_WORDS.noStairs);
    }
    assert.equal(refusal(s, { t: "token.climb", tokenId: "thorn", linkId: "gone" }, ANA), LINK_WORDS.noStairs);
    // The end on the other floor is not the one under it.
    assert.equal(refusal(s, climb("thorn", "l2"), ANA), LINK_WORDS.noStairs);
  });

  test("a hidden Prone adds nothing, a seen one crawling's foot per foot", () => {
    const prone = (hidden: boolean) =>
      tower({ characters: { thorn: { ...tower().characters.thorn!, actor: actor({ effects: [effect("p", { key: "prone", ...(hidden ? { hiddenFromPlayers: true } : {}) })] }) } } });
    const leg = (s: RoomState) => run(onThornsTurn(withStairs(s)), climb(), ANA).tokens.thorn!.path!.stops[1]!;
    assert.deepEqual([leg(prone(true)).moved, leg(prone(true)).cost], [10, 10]);
    assert.deepEqual([leg(prone(false)).moved, leg(prone(false)).cost], [10, 20]);
  });
});

describe("costFt", () => {
  test("reads prior and this floor's counted legs, as the marker does", () => {
    let s = onThornsTurn(withStairs(tower(), { rect: { x: 3, y: 8, w: 1, h: 1 }, kind: "ladder" }));
    s = run(s, move(3, 8), ANA);
    s = run(s, climb(), ANA);
    assert.deepEqual([movedFt(s.tokens.thorn!), costFt(s.tokens.thorn!)], [35, 45]);
  });
});
