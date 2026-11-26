import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { ANA, ATTIC, GROUND, UPPER, applied, fallCard, fallRecord, nextSeq, onThornsTurn, putOpeningOp, run, thornToken, tower, trapdoor, withFalls, withOpening, withStairs, withTrapdoor } from "../floorLinksTestutil.ts";
import { FALL_RIDERS_MOST, type FallRecord, type RoomState, type Token } from "../model.ts";
import { LIMITS } from "../limits.ts";
import { opSchema, type Op } from "../protocol.ts";
import { applyOp } from "../reducer.ts";
import { byFallAge } from "../rules/fallCards.ts";
import { DM, actor, character, env, token } from "../testutil.ts";
import { FALL_SETTLED } from "./falls.ts";

/*
 * Falls through openings between floors (docs/design/design-v1-floors.md
 * phase 4, 4): who falls, the landing, the cards, their end, and the
 * opened marks a landing leaves. The tower's opening (o1, the hole on
 * Upper floor, over o2 on Ground floor) lies 2 by 2 at 6, 6.
 */

/** A creature on Upper floor, Medium unless told otherwise. */
function up(id: string, over: Partial<Token> = {}): Token {
  return token(id, { sceneId: UPPER, name: id, ...over });
}

/** The tower with the opening and Thorn on Upper floor at 3, 3. */
function holed(over: Partial<RoomState> = {}, thorn: Partial<Token> = {}): RoomState {
  return withOpening(tower({ tokens: { thorn: thornToken({ sceneId: UPPER, ...thorn }) }, ...over }));
}

function withTokens(state: RoomState, ...tokens: Token[]): RoomState {
  return { ...state, tokens: { ...state.tokens, ...Object.fromEntries(tokens.map((t) => [t.id, t])) } };
}

function move(tokenId: string, x: number, y: number): Op {
  return { t: "token.move", tokenId, x, y };
}

function cards(state: RoomState): string[] {
  return Object.values(state.falls ?? {})
    .map((c) => `${c.tokenId} ${c.from}>${c.sceneId} ${c.ft}`)
    .sort();
}

describe("who falls (4.1)", () => {
  test("Thorn onto a 2 by 2 hole falls to Ground floor's same squares, on its ground, with a card and a record", () => {
    const r = applied(holed(), move("thorn", 6, 6), ANA);
    const thorn = r.state.tokens.thorn!;
    assert.deepEqual([thorn.sceneId, thorn.x, thorn.y, thorn.elevation], [GROUND, 6, 6, 0]);
    const [card] = Object.values(r.state.falls ?? {});
    assert.ok(card);
    assert.deepEqual({ ...card, rev: 0 }, { id: card.id, rev: 0, tokenId: "thorn", sceneId: GROUND, from: UPPER, ft: 10, made: card.made });
    assert.match(card.id, /^\d+:0$/);
    assert.deepEqual(r.falls, [{ tokenId: "thorn", linkId: "o1", rev: 0, made: 90, from: UPPER, to: GROUND, fallId: card.id, shown: { kind: "opening", rect: { x: 6, y: 6, w: 2, h: 2 }, pairRect: { x: 6, y: 6, w: 2, h: 2 } } }]);
  });

  test("a Large ogre half over the hole stays, and one wholly over it falls", () => {
    const state = withTokens(holed(), up("ogre", { size: "large", x: 1, y: 6 }), up("ogre2", { size: "large", x: 10, y: 10 }));
    const half = applied(state, move("ogre", 5, 6));
    assert.equal(half.state.tokens.ogre!.sceneId, UPPER);
    assert.equal(half.falls, undefined);
    const whole = applied(state, move("ogre2", 6, 6));
    assert.equal(whole.state.tokens.ogre2!.sceneId, GROUND);
    assert.deepEqual(cards(whole.state), [`ogre2 ${UPPER}>${GROUND} 10`]);
  });

  test("a walk across the hole that ends past it, a flier over it, and a rider on a seen mount on its rim fall not", () => {
    const crossed = applied(holed({}, { x: 4, y: 6 }), { t: "token.move", tokenId: "thorn", x: 9, y: 6, route: [[6, 6, 0, 0], [9, 6, 0, 0]] }, ANA);
    assert.equal(crossed.state.tokens.thorn!.sceneId, UPPER);
    const bat = applied(withTokens(holed(), up("bat", { size: "tiny", x: 2, y: 2, elevation: 5 })), move("bat", 6, 6));
    assert.equal(bat.state.tokens.bat!.sceneId, UPPER);
    // The horse straddles the rim at 7, 6 (7 to 9 by 6 to 8), and Thorn sits on its square over the hole.
    const rim = withTokens(holed({}, { x: 8, y: 6, attached: { to: "horse", kind: "ride" } }), up("horse", { size: "large", x: 7, y: 6 }));
    for (const who of [ANA, DM]) {
      const seated = applied(rim, move("thorn", 7, 6), who);
      assert.equal(seated.state.tokens.thorn!.sceneId, UPPER, who.role);
      assert.equal(seated.state.tokens.thorn!.attached?.to, "horse", who.role);
      assert.equal(seated.falls, undefined, who.role);
    }
  });

  test("Ana's rider on a hidden mount on the rim walked onto the hole falls alone and leaves the seat, and the DM's stays", () => {
    const rim = withTokens(holed({}, { x: 8, y: 6, attached: { to: "horse", kind: "ride" } }), up("horse", { size: "large", x: 7, y: 6, visibility: "dm" }));
    const ana = applied(rim, move("thorn", 7, 6), ANA);
    assert.equal(ana.state.tokens.thorn!.sceneId, GROUND);
    assert.equal(ana.state.tokens.thorn!.attached, undefined, "the seat goes");
    assert.equal(ana.state.tokens.horse!.sceneId, UPPER, "the hidden horse stays");
    assert.deepEqual(cards(ana.state), [`thorn ${UPPER}>${GROUND} 10`]);
    const dm = applied(rim, move("thorn", 7, 6), DM);
    assert.equal(dm.state.tokens.thorn!.sceneId, UPPER);
    assert.equal(dm.state.tokens.thorn!.attached?.to, "horse");
  });

  test("a goblin the DM creates on the hole stands, then falls when nudged, and placing or moving an opening under a goblin drops it", () => {
    const empty = tower({ tokens: {} });
    const { rev: _rev, fogExemptAuto: _auto, ...made } = up("g1", { x: 6, y: 6 });
    const created = applied(withOpening(empty), { t: "token.create", token: made } as Op);
    assert.equal(created.state.tokens.g1!.sceneId, UPPER, "a create never falls");
    const nudged = applied(created.state, move("g1", 7, 7));
    assert.equal(nudged.state.tokens.g1!.sceneId, GROUND);
    const placed = applied(withTokens(empty, up("g2", { x: 6, y: 6 })), putOpeningOp());
    assert.equal(placed.state.tokens.g2!.sceneId, GROUND, "placing an opening under it");
    const moved = applied(withTokens(withOpening(empty), up("g3", { x: 12, y: 12 })), { t: "floorLink.update", linkId: "o1", patch: { rect: { x: 12, y: 12, w: 2, h: 2 } } });
    assert.equal(moved.state.tokens.g3!.sceneId, GROUND, "moving an opening under it");
    assert.deepEqual([moved.state.floorLinks!.o1!.rect, moved.state.floorLinks!.o2!.rect], [{ x: 12, y: 12, w: 2, h: 2 }, { x: 12, y: 12, w: 2, h: 2 }]);
  });

  test("a copy of the tower with its creatures keeps a goblin on the hole standing, with no card (FLR4-OPUS-1, D-261120-008)", () => {
    const state = withTokens(withOpening(tower({ tokens: {} })), up("g1", { x: 6, y: 6 }));
    const r = applied(state, { t: "scene.duplicate", sceneId: GROUND, newSceneId: "copy", name: "Tower 2", include: { creatures: true, characters: true, fog: false, drawings: false } });
    const copies = Object.values(r.state.tokens).filter((t) => t.id !== "g1");
    assert.equal(copies.length, 1, "the goblin is copied");
    const copyFloor = r.state.scenes[copies[0]!.sceneId]!;
    assert.deepEqual([copyFloor.floor?.level, copies[0]!.x, copies[0]!.y], [1, 6, 6], "on the copy's Upper floor, over its hole");
    assert.ok(Object.values(r.state.floorLinks ?? {}).some((l) => l.sceneId === copyFloor.id && l.kind === "opening"), "the copy has its own opening");
    assert.equal(r.state.tokens.g1!.sceneId, UPPER);
    assert.deepEqual([r.state.falls, r.falls], [undefined, undefined]);
  });

  test("a floor reorder that makes the floor below the upper one leaves a goblin on what is now the hole standing, with no card (D-261120-008)", () => {
    const state = withTokens(withOpening(tower({ tokens: {} })), token("g1", { sceneId: GROUND, name: "g1", x: 6, y: 6 }));
    const r = applied(state, { t: "floor.order", sceneId: GROUND, floors: [UPPER, GROUND, ATTIC] });
    assert.ok((r.state.scenes[GROUND]!.floor?.level ?? 0) > (r.state.scenes[UPPER]!.floor?.level ?? 0), "Ground floor now lies above");
    assert.equal(r.state.tokens.g1!.sceneId, GROUND);
    assert.deepEqual([r.state.falls, r.falls], [undefined, undefined]);
  });

  test("an elevation lowered to the ground, a resize and a detach over the hole each fall with a card and a record", () => {
    const lowered = applied(withTokens(holed(), up("bat", { x: 6, y: 6, elevation: 10 })), { t: "token.update", tokenId: "bat", patch: { elevation: 0 } });
    assert.equal(lowered.state.tokens.bat!.sceneId, GROUND);
    assert.equal(lowered.falls?.length, 1);
    const shrunk = applied(withTokens(holed(), up("giant", { size: "huge", x: 6, y: 6 })), { t: "token.update", tokenId: "giant", patch: { size: "medium" } });
    assert.equal(shrunk.state.tokens.giant!.sceneId, GROUND);
    assert.equal(shrunk.falls?.length, 1);
    // Put down where it perches: a perch lets go in place.
    const rim = withTokens(holed({}, { x: 7, y: 6, attached: { to: "horse", kind: "perch" } }), up("horse", { size: "large", x: 7, y: 6 }));
    const off = applied(rim, { t: "token.detach", tokenId: "thorn" });
    assert.equal(off.state.tokens.thorn!.sceneId, GROUND);
    assert.equal(off.state.tokens.horse!.sceneId, UPPER);
    assert.equal(off.falls?.length, 1);
    for (const r of [lowered, shrunk, off]) assert.equal(Object.keys(r.state.falls ?? {}).length, 1);
  });

  test("a mount carrying Thorn onto the hole while dragging a goblin lands with Thorn seated, and the goblin's drag lets go", () => {
    const state = withTokens(holed({}, { x: 3, y: 6, attached: { to: "horse", kind: "ride" } }), up("horse", { size: "large", x: 3, y: 6 }), up("goblin", { x: 2, y: 6, attached: { to: "horse", kind: "drag" } }));
    const r = applied(state, move("horse", 6, 6));
    assert.deepEqual([r.state.tokens.horse!.sceneId, r.state.tokens.thorn!.sceneId], [GROUND, GROUND]);
    assert.equal(r.state.tokens.thorn!.attached?.to, "horse", "Thorn rides down seated");
    assert.equal(r.state.tokens.goblin!.sceneId, UPPER);
    assert.equal(r.state.tokens.goblin!.attached, undefined, "the drag lets go");
    assert.deepEqual(cards(r.state), [`horse ${UPPER}>${GROUND} 10`], "one card, the root's");
    assert.deepEqual(Object.values(r.state.falls ?? {})[0]!.riders, ["thorn"], "naming Thorn, who fell with it, and not the goblin it dragged");
    assert.equal(r.falls?.length, 1);
  });

  test("a rider falls by either road (D-261120-007): named on its mount's card where the mount counts, on a card of its own where it falls alone", () => {
    // One opening 4 by 4 at 6, 6. Pip walks onto it dragging the zebra, which Thorn rides. In id order Thorn is asked before the zebra.
    const named = (state: RoomState) => Object.values(state.falls ?? {}).flatMap((c) => [c.tokenId, ...(c.riders ?? [])]).sort();
    for (const visibility of ["all", "dm"] as const) {
      const wide = withOpening(tower({ tokens: {} }), { rect: { x: 6, y: 6, w: 4, h: 4 } });
      const state = withTokens(
        wide,
        thornToken({ sceneId: UPPER, x: 2, y: 6, attached: { to: "zebra", kind: "ride" } }),
        up("pip", { kind: "pc", ownerIds: ["p1"], x: 4, y: 8 }),
        up("zebra", { size: "large", x: 2, y: 6, visibility, attached: { to: "pip", kind: "drag" } }),
      );
      const r = applied(state, move("pip", 8, 8), ANA);
      assert.deepEqual([r.state.tokens.thorn!.sceneId, r.state.tokens.zebra!.sceneId], [GROUND, GROUND], visibility);
      assert.deepEqual(named(r.state), ["pip", "thorn", "zebra"], `${visibility}: each one that fell is on a card once`);
      const zebra = Object.values(r.state.falls ?? {}).find((c) => c.tokenId === "zebra");
      assert.deepEqual(zebra?.riders, visibility === "all" ? ["thorn"] : undefined, `${visibility}: Thorn rides down on the zebra's card, or falls alone off a zebra no player sees`);
    }
  });

  test("a card names only creatures, and a trapdoor's drop names what rode down with its victim", () => {
    const state = withTokens(
      withTrapdoor(tower({ tokens: {} }), trapdoor("td1", { zone: { cells: [{ x: 10, y: 10, w: 2, h: 2 }] } })),
      up("horse", { size: "large", x: 10, y: 10 }),
      thornToken({ sceneId: UPPER, x: 10, y: 10, attached: { to: "horse", kind: "ride" } }),
      up("lamp", { kind: "object", x: 11, y: 11, attached: { to: "horse", kind: "carry" } }),
    );
    const r = applied(state, { t: "trap.spring", trapId: "td1", tokenIds: ["horse"] });
    assert.deepEqual([r.state.tokens.horse!.sceneId, r.state.tokens.thorn!.sceneId, r.state.tokens.lamp!.sceneId], [GROUND, GROUND, GROUND]);
    const [card, ...more] = Object.values(r.state.falls ?? {});
    assert.deepEqual([card?.tokenId, card?.riders, more.length], ["horse", ["thorn"], 0]);
  });

  test("the most riders a card names is a group's most tokens less the one that fell", () => {
    assert.equal(FALL_RIDERS_MOST, LIMITS.groupTokens - 1);
  });

  test("two creatures through two openings in one group move make two cards and two records", () => {
    const two = withOpening(withOpening(tower({ tokens: {} })), { id: "o3", pairId: "o4", rect: { x: 12, y: 12, w: 2, h: 2 } });
    const state = withTokens(two, up("g1", { x: 6, y: 4 }), up("g2", { x: 12, y: 10 }));
    const r = applied(state, { t: "token.moveMany", moves: [{ tokenId: "g1", x: 6, y: 6 }, { tokenId: "g2", x: 12, y: 12 }] });
    assert.deepEqual(cards(r.state), [`g1 ${UPPER}>${GROUND} 10`, `g2 ${UPPER}>${GROUND} 10`]);
    assert.deepEqual(r.falls?.map((f) => [f.tokenId, f.linkId, f.fallId.endsWith(":0") || f.fallId.endsWith(":1")]), [["g1", "o1", true], ["g2", "o3", true]]);
    assert.notEqual(r.falls![0]!.fallId, r.falls![1]!.fallId);
  });

  test("a trapdoor on the Attic dropping Thorn onto the opening below makes two cards for Thorn, and one record", () => {
    const state = withTrapdoor(holed({}, { sceneId: ATTIC, x: 6, y: 6 }), trapdoor("td1", { sceneId: ATTIC, zone: { cells: [{ x: 6, y: 6, w: 2, h: 2 }] } }));
    const r = applied(state, { t: "trap.spring", trapId: "td1", tokenIds: ["thorn"] });
    assert.equal(r.state.tokens.thorn!.sceneId, GROUND);
    assert.deepEqual(cards(r.state), [`thorn ${ATTIC}>${UPPER} 10`, `thorn ${UPPER}>${GROUND} 10`]);
    assert.equal(r.falls?.length, 1);
    assert.equal(r.falls![0]!.from, UPPER);
  });

  test("Thorn falling alone off a hidden horse leaves its seat, though the horse Ana's other creature drags falls after him", () => {
    // One opening 4 by 4 at 6, 6. Pip drags the hidden horse, which Thorn rides. In id order Thorn falls before the horse.
    const wide = withOpening(tower({ tokens: {} }), { rect: { x: 6, y: 6, w: 4, h: 4 } });
    const state = withTokens(
      wide,
      thornToken({ sceneId: UPPER, x: 2, y: 6, attached: { to: "zebra", kind: "ride" } }),
      up("pip", { kind: "pc", ownerIds: ["p1"], x: 4, y: 8 }),
      up("zebra", { size: "large", x: 2, y: 6, visibility: "dm", attached: { to: "pip", kind: "drag" } }),
    );
    const r = applied(state, move("pip", 8, 8), ANA);
    assert.deepEqual([r.state.tokens.thorn!.sceneId, r.state.tokens.zebra!.sceneId], [GROUND, GROUND]);
    assert.equal(r.state.tokens.thorn!.attached, undefined, "the seat on a horse no player sees goes, as in a room without it");
  });

  test("a projected copy never falls: only the server lands a creature", () => {
    const copy = { ...holed(), sight: {} } as RoomState;
    const r = applied(copy, move("thorn", 6, 6), ANA);
    assert.equal(r.state.tokens.thorn!.sceneId, UPPER);
    assert.equal(r.state.falls, undefined);
  });

  test("the drop counts the floor's height and the two grounds, a climb's taller floor too", () => {
    const raised = (sceneId: string, height: number): RoomState => {
      const s = run(tower({ tokens: {} }), { t: "build.height", sceneId, cells: ["6,6", "7,6", "6,7", "7,7"], height });
      return withTokens(withOpening(s), thornToken({ sceneId: UPPER, x: 3, y: 3 }));
    };
    // A walk onto raised ground lands at its height, as a device sends it.
    const higher = applied(raised(UPPER, 5), { t: "token.move", tokenId: "thorn", x: 6, y: 6, elevation: 5 }, ANA);
    assert.deepEqual(cards(higher.state), [`thorn ${UPPER}>${GROUND} 15`], "a hole on raised ground drops further");
    const lower = applied(raised(GROUND, 5), move("thorn", 6, 6), ANA);
    assert.deepEqual(cards(lower.state), [`thorn ${UPPER}>${GROUND} 5`], "onto raised ground below, less");
    assert.equal(lower.state.tokens.thorn!.elevation, 5);
    const tall = tower();
    tall.scenes[UPPER] = { ...tall.scenes[UPPER]!, floor: { ...tall.scenes[UPPER]!.floor!, height: 25 } };
    const r = applied(withOpening({ ...tall, tokens: { thorn: thornToken({ sceneId: UPPER }) } }), move("thorn", 6, 6), ANA);
    assert.deepEqual(cards(r.state), [`thorn ${UPPER}>${GROUND} 25`]);
  });
});

describe("the cards (4.4)", () => {
  test("a fall and then a climb back up, a move to another floor and a player's dismissal keep the card, and a DM's delete ends it", () => {
    // Stairs from Ground floor up at 10, 10, clear of the opening.
    const state = withStairs(holed(), { rect: { x: 10, y: 10, w: 1, h: 1 } });
    const down = run(state, move("thorn", 6, 6), ANA);
    assert.equal(Object.keys(down.falls ?? {}).length, 1);
    const walked = run(down, move("thorn", 10, 10), ANA);
    const climbed = run(walked, { t: "token.climb", tokenId: "thorn", linkId: "l1" }, ANA);
    assert.equal(climbed.tokens.thorn!.sceneId, UPPER);
    assert.equal(Object.keys(climbed.falls ?? {}).length, 1, "a climb back up keeps it");
    const moved = run(climbed, { t: "token.update", tokenId: "thorn", patch: { sceneId: ATTIC } });
    assert.equal(Object.keys(moved.falls ?? {}).length, 1, "a move to another floor keeps it");
    const deleted = applied(moved, { t: "token.delete", tokenId: "thorn" });
    assert.equal(Object.keys(deleted.state.falls ?? {}).length, 0, "a DM's delete ends it");
    assert.ok(deleted.touched.some((k) => k.startsWith("fall:")) && deleted.inverse!.some((e) => e.key.startsWith("fall:") && e.value !== null), "in the delete's undo step");
    const dismissed = run(moved, { t: "token.delete", tokenId: "thorn" }, ANA);
    assert.equal(Object.keys(dismissed.falls ?? {}).length, 1, "a player's dismissal leaves it");
  });

  test("a DM's delete of the mount keeps its card while its rider stands, and the delete of both ends it (D-261120-007)", () => {
    const state = withTokens(holed({}, { x: 3, y: 6, attached: { to: "horse", kind: "ride" } }), up("horse", { size: "large", x: 3, y: 6 }));
    const fell = run(state, move("horse", 6, 6));
    const [card] = Object.values(fell.falls ?? {});
    assert.deepEqual([card?.tokenId, card?.riders], ["horse", ["thorn"]]);
    const mountGone = run(fell, { t: "token.delete", tokenId: "horse" });
    assert.deepEqual(Object.keys(mountGone.falls ?? {}), [card!.id], "Thorn's fall still waits");
    const bothGone = run(mountGone, { t: "token.delete", tokenId: "thorn" });
    assert.deepEqual(Object.keys(bothGone.falls ?? {}), [], "no creature it names is left");
  });

  test("eleven falls leave ten cards, the oldest gone", () => {
    const old = Array.from({ length: 10 }, (_, i) => fallCard({ made: 50 + i, tokenId: `t${i}` }));
    const r = applied(withFalls(holed(), ...old), move("thorn", 6, 6), ANA);
    const ids = Object.keys(r.state.falls ?? {});
    assert.equal(ids.length, 10);
    assert.ok(!ids.includes("50:0"), "the oldest goes");
    assert.ok(ids.includes("51:0") && Object.values(r.state.falls!).some((c) => c.tokenId === "thorn"));
  });

  test("Dismiss and a group save's outcome remove the card, and a second is refused as settled meanwhile", () => {
    const state = withFalls(holed(), fallCard());
    const dismissed = applied(state, { t: "fall.settle", fallId: "120:0" });
    assert.equal(dismissed.state.falls?.["120:0"], undefined);
    const again = applyOp(dismissed.state, opSchema.parse({ t: "fall.settle", fallId: "120:0" }), DM, env(nextSeq()));
    assert.deepEqual(again.ok ? null : again.message, FALL_SETTLED);
    const outcome: Op = { t: "actor.outcome", plan: "p1", fall: { fallId: "120:0", tokenIds: ["thorn"] }, targets: [{ target: { tokenId: "thorn" }, amount: 3 }] };
    const applied1 = applied(state, outcome);
    assert.equal(applied1.state.falls?.["120:0"], undefined);
    const twice = applyOp(applied1.state, opSchema.parse(outcome), DM, env(nextSeq()));
    assert.deepEqual(twice.ok ? null : twice.message, FALL_SETTLED);
  });

  test("an outcome takes off its card only the creatures it settles, and the card stays for one still in the room (FLR4INT-ASTRA-05)", () => {
    const ridden = withTokens(holed({}, { sceneId: GROUND, x: 6, y: 6 }), token("horse", { sceneId: GROUND, name: "Horse", x: 6, y: 6 }), token("bree", { sceneId: "s2", name: "Bree" }));
    const state = withFalls(ridden, fallCard({ tokenId: "horse", riders: ["thorn", "bree"] }));
    const outcome = (tokenIds: string[]): Op => ({ t: "actor.outcome", plan: "p1", fall: { fallId: "120:0", tokenIds }, targets: [{ target: { tokenId: "horse" }, amount: 3 }] });
    const part = applied(state, outcome(["horse", "thorn"]));
    assert.deepEqual([part.state.falls?.["120:0"]?.tokenId, part.state.falls?.["120:0"]?.riders], ["bree", undefined], "Bree, on another scene, keeps her fall");
    assert.ok(part.inverse!.some((e) => e.key === "fall:120:0" && (e.value as { riders?: string[] }).riders?.length === 2), "the DM's undo puts the whole card back");
    const twice = applyOp(part.state, opSchema.parse(outcome(["horse", "thorn"])), DM, env(nextSeq()));
    assert.deepEqual(twice.ok ? null : twice.message, FALL_SETTLED, "a creature already settled is never applied again");
    assert.equal(applied(part.state, outcome(["bree"])).state.falls?.["120:0"], undefined, "the last creature settled ends it");
    const breeGone = { ...state, tokens: Object.fromEntries(Object.entries(state.tokens).filter(([id]) => id !== "bree")) };
    assert.equal(applied(breeGone, outcome(["horse", "thorn"])).state.falls?.["120:0"], undefined, "one no longer in the room holds nothing to apply");
    const none = applied(state, { ...outcome([]), targets: [] } as Op);
    assert.deepEqual(none.state.falls?.["120:0"], state.falls!["120:0"], "an outcome that settles no one leaves the card as it was");
  });

  test("a creature the card names by two tokens leaves it whole when either takes the fall, on whatever scene, and takes it once (FLR4-SOL-22)", () => {
    const base = withTokens(holed({}, { sceneId: GROUND, x: 6, y: 6 }), token("horse", { sceneId: GROUND, name: "Horse", x: 6, y: 6 }), thornToken({ id: "thorn2", sceneId: "s2" }), token("bree", { sceneId: "s2", name: "Bree" }));
    const state = withFalls(base, fallCard({ tokenId: "horse", riders: ["thorn", "thorn2", "bree"] }));
    const hp = (s: RoomState) => s.characters.thorn!.actor.hp!.cur;
    // Apply on Ground floor reaches Horse and Thorn: Thorn's other token, on another scene, leaves with Thorn, and Bree stays.
    const first = applied(state, { t: "actor.outcome", plan: "p1", fall: { fallId: "120:0", tokenIds: ["horse", "thorn"] }, targets: [{ target: { tokenId: "horse" }, amount: 6 }, { target: { tokenId: "thorn" }, amount: 6 }] });
    assert.equal(hp(first.state), 14);
    assert.deepEqual([first.state.falls?.["120:0"]?.tokenId, first.state.falls?.["120:0"]?.riders], ["bree", undefined]);
    // On the other scene the DM's Apply names thorn2 again: refused, so 14 never becomes 8.
    const again = applyOp(first.state, opSchema.parse({ t: "actor.outcome", plan: "p2", fall: { fallId: "120:0", tokenIds: ["thorn2", "bree"] }, targets: [{ target: { tokenId: "thorn2" }, amount: 6 }] }), DM, env(nextSeq()));
    assert.deepEqual(again.ok ? null : again.message, FALL_SETTLED);
    const last = applied(first.state, { t: "actor.outcome", plan: "p3", fall: { fallId: "120:0", tokenIds: ["bree"] }, targets: [{ target: { tokenId: "bree" }, amount: 6 }] });
    assert.deepEqual([hp(last.state), last.state.falls?.["120:0"]], [14, undefined], "Bree's Apply ends the card");
    // A creature the outcome damages through a token the outcome does not settle leaves the card with all its tokens too.
    const targeted = applied(state, { t: "actor.outcome", plan: "p4", fall: { fallId: "120:0", tokenIds: ["horse"] }, targets: [{ target: { tokenId: "thorn" }, amount: 6 }] });
    assert.deepEqual([targeted.state.falls?.["120:0"]?.tokenId, targeted.state.falls?.["120:0"]?.riders], ["bree", undefined]);
    // A skipped Thorn, settled with no damage, takes its other token off too.
    const skipped = applied(state, { t: "actor.outcome", plan: "p6", fall: { fallId: "120:0", tokenIds: ["horse", "thorn"] }, targets: [] });
    assert.deepEqual([skipped.state.falls?.["120:0"]?.tokenId, skipped.state.falls?.["120:0"]?.riders], ["bree", undefined]);
    // Settling only Horse keeps both of Thorn's tokens and Bree.
    const horse = applied(state, { t: "actor.outcome", plan: "p5", fall: { fallId: "120:0", tokenIds: ["horse"] }, targets: [] });
    assert.deepEqual([horse.state.falls?.["120:0"]?.tokenId, horse.state.falls?.["120:0"]?.riders], ["thorn", ["thorn2", "bree"]]);
  });

  test("a fall made under fall cards at the cap evicts within the op's undo, so the DM's undo puts the evicted card back", () => {
    const old = Array.from({ length: 10 }, (_, i) => fallCard({ made: 50 + i, tokenId: `t${i}` }));
    const r = applied(withFalls(holed(), ...old), move("thorn", 6, 6), DM);
    const back = r.inverse!.find((e) => e.key === "fall:50:0");
    assert.ok(back && back.value !== null);
  });
});

describe("a player's undo and redo of a fall in the reducer (4.5)", () => {
  function fallen(): { state: RoomState; record: FallRecord } {
    const r = applied(holed(), move("thorn", 6, 6), ANA);
    return { state: r.state, record: r.falls![0]! };
  }

  test("the undo removes the card while it is there and never refuses for one, and the redo writes back only a card its record carries", () => {
    const { state, record } = fallen();
    const back = { ...state.tokens.thorn!, sceneId: UPPER, x: 6, y: 6, elevation: 0 };
    const undo: Op = { t: "sys.restore", from: "undo", entries: [{ key: "token:thorn", value: back }], falls: [record] } as Op;
    const undone = applied(state, undo, ANA);
    assert.equal(Object.keys(undone.state.falls ?? {}).length, 0);
    assert.equal(undone.state.tokens.thorn!.sceneId, UPPER);
    const gone = { ...state, falls: {} };
    assert.ok(applied(gone, undo, ANA).state.tokens.thorn!.sceneId === UPPER, "a card gone before never refuses the undo");
    const card = state.falls![record.fallId]!;
    const below = state.tokens.thorn!;
    const redo = (with_card: boolean): Op => ({ t: "sys.restore", from: "redo", entries: [{ key: "token:thorn", value: below }], falls: [{ ...record, ...(with_card ? { card } : {}) }] }) as Op;
    assert.deepEqual(Object.keys(applied(undone.state, redo(true), ANA).state.falls ?? {}), [record.fallId]);
    assert.deepEqual(Object.keys(applied(undone.state, redo(false), ANA).state.falls ?? {}), [], "no second card after an Apply");
  });

  test("a restore never falls, though it puts a creature back over the hole", () => {
    const { state } = fallen();
    const back = { ...state.tokens.thorn!, sceneId: UPPER, x: 6, y: 6, elevation: 0 };
    const r = applied(state, { t: "sys.restore", from: "undo", entries: [{ key: "token:thorn", value: back }] } as Op, DM);
    assert.equal(r.state.tokens.thorn!.sceneId, UPPER);
    assert.equal(r.falls, undefined);
  });
});

describe("the floors a landing reaches (4.3 step 9)", () => {
  function reachedOf(state: RoomState): string[] {
    return Object.keys(state.openFloors ?? {}).sort();
  }

  test("a trapdoor from the Attic onto the opening on Upper floor, falling to Ground floor, marks both reached, and they stay after Thorn leaves", () => {
    const base = withTrapdoor(holed({}, { sceneId: ATTIC, x: 6, y: 6 }), trapdoor("td1", { sceneId: ATTIC, zone: { cells: [{ x: 6, y: 6, w: 2, h: 2 }] } }));
    const start: RoomState = { ...base, meta: { ...base.meta, playerSceneId: ATTIC }, openFloors: {} };
    const r = run(start, { t: "trap.spring", trapId: "td1", tokenIds: ["thorn"] });
    assert.equal(r.tokens.thorn!.sceneId, GROUND);
    assert.deepEqual(reachedOf(r), [GROUND, UPPER, ATTIC].sort());
    const left = run(r, { t: "token.update", tokenId: "thorn", patch: { sceneId: ATTIC } });
    assert.deepEqual(reachedOf(left), [GROUND, UPPER, ATTIC].sort());
  });

  test("a fall onto a floor not reached marks it reached, and the mark outlives the undo and a departure", () => {
    const base = holed();
    const start: RoomState = { ...base, meta: { ...base.meta, playerSceneId: UPPER }, openFloors: {} };
    const r = applied(start, move("thorn", 6, 6), ANA);
    assert.ok(reachedOf(r.state).includes(GROUND));
    assert.ok(!r.inverse!.some((e) => e.key.startsWith("opened:")), "bookkeeping outside the undo");
    const back = { ...r.state.tokens.thorn!, sceneId: UPPER, x: 6, y: 6, elevation: 0 };
    const undone = run(r.state, { t: "sys.restore", from: "undo", entries: [{ key: "token:thorn", value: back }], falls: r.falls } as Op, ANA);
    assert.ok(reachedOf(undone).includes(GROUND));
  });
});

describe("before change format 64 (opensOps)", () => {
  test("a move onto the hole at 63 stands where it ends, and makes no card", () => {
    const r = applied(holed(), move("thorn", 6, 6), ANA, 63);
    assert.equal(r.state.tokens.thorn!.sceneId, UPPER);
    assert.equal(r.state.falls, undefined);
    assert.equal(r.falls, undefined);
  });
});

describe("a creature a fall or a trapdoor lands outside its turn keeps its old path from 64 (D-261119-016)", () => {
  test("a goblin an opening placed under it drops outside its turn, and one a trapdoor drops, keep their old paths at 64", () => {
    const old = { turn: 1, stops: [{ x: 0, y: 0, elevation: 0 }] } as unknown as Token["path"];
    // A room kept from before change format 65 may hold them past their turn: from 65 a turn's end takes every walk off (D-261120-100).
    const fight = onThornsTurn(withTokens(tower(), up("goblin", { x: 6, y: 6 }), up("rat", { x: 10, y: 10 })));
    const state = { ...fight, tokens: { ...fight.tokens, goblin: { ...fight.tokens.goblin!, path: old }, rat: { ...fight.tokens.rat!, path: old } } };
    const r = applied(state, putOpeningOp());
    assert.equal(r.state.tokens.goblin!.sceneId, GROUND);
    assert.deepEqual(r.state.tokens.goblin!.path, old);
    const dropped = applied(withTrapdoor(state), { t: "trap.spring", trapId: "td1", tokenIds: ["rat"] });
    assert.equal(dropped.state.tokens.rat!.sceneId, GROUND);
    assert.deepEqual(dropped.state.tokens.rat!.path, old);
  });
});

describe("a creature falls once a step (change format 67, fallsOnce)", () => {
  /** Shade, the DM's character (20 HP), shown by tokens on Upper floor. */
  function withShade(state: RoomState, ...tokens: Token[]): RoomState {
    const s = withTokens(state, ...tokens);
    return { ...s, characters: { ...s.characters, shade: character("shade", { name: "Shade", ownerIds: [], actor: actor() }) } };
  }
  const shade = (id: string, over: Partial<Token> = {}): Token => up(id, { kind: "pc", name: "Shade", actor: { ref: "shade" }, ...over });
  const named = (state: RoomState) =>
    Object.values(state.falls ?? {})
      .sort(byFallAge)
      .map((c) => `${[c.tokenId, ...(c.riders ?? [])].join(" ")} ${c.from}>${c.sceneId} ${c.ft}`);
  const empty = () => tower({ tokens: {} });
  const shadeHp = (s: RoomState) => s.characters.shade!.actor.hp.cur;

  test("an opening placed under both tokens of Shade makes one card naming both, and its Apply takes the fall once", () => {
    const state = withShade(empty(), shade("shade1", { x: 6, y: 6 }), shade("shade2", { x: 7, y: 7 }));
    const r = applied(state, putOpeningOp());
    assert.deepEqual(named(r.state), [`shade1 shade2 ${UPPER}>${GROUND} 10`]);
    assert.deepEqual(r.falls?.map((f) => [f.tokenId, f.fallId]), [["shade1", Object.keys(r.state.falls!)[0]], ["shade2", Object.keys(r.state.falls!)[0]]], "each root's record names the one card");
    const fallId = Object.keys(r.state.falls!)[0]!;
    const outcome: Op = { t: "actor.outcome", plan: "p1", fall: { fallId, tokenIds: ["shade1"] }, targets: [{ target: { tokenId: "shade1" }, amount: 3 }] };
    const hurt = applied(r.state, outcome);
    assert.deepEqual([shadeHp(hurt.state), hurt.state.falls?.[fallId]], [17, undefined], "both tokens settled with one Apply");
    const again = applyOp(hurt.state, opSchema.parse({ ...outcome, fall: { fallId, tokenIds: ["shade2"] } }), DM, env(nextSeq()));
    assert.deepEqual(again.ok ? null : again.message, FALL_SETTLED);
    // A stored op of change format 66 replays as it ran: a card for each token.
    assert.deepEqual(named(applied(state, putOpeningOp(), DM, 66).state).length, 2);
  });

  test("a trapdoor that drops both tokens of Shade makes one card, and a goblin beside them its own", () => {
    const state = withTrapdoor(withShade(empty(), shade("shade1", { x: 10, y: 10 }), shade("shade2", { x: 11, y: 11 }), up("goblin", { x: 10, y: 11 })));
    const r = applied(state, { t: "trap.spring", trapId: "td1", tokenIds: ["goblin", "shade1", "shade2"] });
    assert.deepEqual(named(r.state).sort(), [`goblin ${UPPER}>${GROUND} 10`, `shade1 shade2 ${UPPER}>${GROUND} 10`]);
  });

  test("a horse carrying one token of Shade and the other falling alone share the horse's card, whichever falls first", () => {
    // In id order the horse (a) falls before Shade's other token (s), or after it (z), which then carries Shade's rider over.
    for (const [horse, alone] of [["a-horse", "shade2"], ["z-horse", "shade2"]] as const) {
      const wide = withOpening(empty(), { rect: { x: 6, y: 6, w: 4, h: 4 } });
      const state = withShade(wide, up(horse, { size: "large", x: 2, y: 6 }), shade("shade1", { x: 2, y: 6, attached: { to: horse, kind: "ride" } }), shade(alone, { x: 6, y: 10 }));
      const r = applied(state, { t: "token.moveMany", moves: [{ tokenId: horse, x: 6, y: 6 }, { tokenId: alone, x: 8, y: 8 }] });
      const cards = named(r.state);
      if (horse === "a-horse") {
        assert.deepEqual(cards, [`a-horse shade1 shade2 ${UPPER}>${GROUND} 10`], "the token that fell alone joins the horse's card");
        assert.deepEqual(new Set(r.falls?.map((f) => f.fallId)).size, 1, "two records of different creatures share it");
      } else {
        assert.deepEqual(cards, [`shade2 shade1 ${UPPER}>${GROUND} 10`, `z-horse ${UPPER}>${GROUND} 10`], "the horse's rider joins the card of the token that fell first");
        assert.deepEqual(new Set(r.falls?.map((f) => f.fallId)).size, 2, "the horse's record names its own new card");
      }
    }
  });

  test("both tokens through a trapdoor on the Attic and on through the opening below make two cards, each naming both", () => {
    const td = trapdoor("td1", { sceneId: ATTIC, zone: { cells: [{ x: 6, y: 6, w: 2, h: 2 }] } });
    const state = withTrapdoor(withShade(withOpening(empty()), shade("shade1", { sceneId: ATTIC, x: 6, y: 6 }), shade("shade2", { sceneId: ATTIC, x: 7, y: 7 })), td);
    const r = applied(state, { t: "trap.spring", trapId: "td1", tokenIds: ["shade1", "shade2"] });
    assert.deepEqual(named(r.state), [`shade1 shade2 ${ATTIC}>${UPPER} 10`, `shade1 shade2 ${UPPER}>${GROUND} 10`]);
    assert.deepEqual([r.state.tokens.shade1!.sceneId, r.state.tokens.shade2!.sceneId], [GROUND, GROUND]);
  });

  test("two damaging drops of different heights make one card at the first's drop", () => {
    // Shade's second token stands 10 ft up on Upper floor's raised squares, so it drops 20 ft.
    const raised = run(empty(), { t: "build.height", sceneId: UPPER, cells: ["11,11"], height: 10 });
    const state = withTrapdoor(withShade(raised, shade("shade1", { x: 10, y: 10 }), shade("shade2", { x: 11, y: 11, elevation: 10 })));
    const r = applied(state, { t: "trap.spring", trapId: "td1", tokenIds: ["shade1", "shade2"] });
    assert.deepEqual(named(r.state), [`shade1 shade2 ${UPPER}>${GROUND} 10`]);
  });

  test("a drop under 10 ft and one that deals damage keep two cards, and the damaging one's Apply hurts once", () => {
    // Ground floor rises 5 ft under Shade's first token, so it drops 5 ft: a card with no Apply.
    const raised = run(empty(), { t: "build.height", sceneId: GROUND, cells: ["10,10"], height: 5 });
    const state = withTrapdoor(withShade(raised, shade("shade1", { x: 10, y: 10 }), shade("shade2", { x: 11, y: 11 })));
    const r = applied(state, { t: "trap.spring", trapId: "td1", tokenIds: ["shade1", "shade2"] });
    assert.deepEqual(named(r.state), [`shade1 ${UPPER}>${GROUND} 5`, `shade2 ${UPPER}>${GROUND} 10`]);
    const damaging = Object.values(r.state.falls!).find((c) => c.ft === 10)!;
    const hurt = run(r.state, { t: "actor.outcome", plan: "p1", fall: { fallId: damaging.id, tokenIds: ["shade2"] }, targets: [{ target: { tokenId: "shade2" }, amount: 4 }] });
    assert.deepEqual([shadeHp(hurt), named(hurt)], [16, [`shade1 ${UPPER}>${GROUND} 5`]], "the no-damage card waits only for Dismiss");
  });

  test("a trapdoor on the Attic drops one token onto a trapdoor on Upper floor, which drops it on with the other: the other joins the card on its own floor", () => {
    // The lower trapdoor goes off on the landing and drops in id order (traps.ts dropVictims), so which token drops first is pinned
    // both ways: the one that came down first (h) before the other (s), then after it (a).
    for (const [hId, sId] of [["h-shade", "s-shade"], ["h-shade", "a-shade"]] as const) {
      const t1 = trapdoor("t1", { sceneId: ATTIC, zone: { cells: [{ x: 10, y: 10, w: 1, h: 1 }] } });
      const t2 = trapdoor("t2", { sceneId: UPPER, zone: { cells: [{ x: 10, y: 10, w: 2, h: 1 }] } });
      const base = withTrapdoor(withTrapdoor(withShade(empty(), shade(hId, { sceneId: ATTIC, x: 10, y: 10 }), shade(sId, { x: 11, y: 10 })), t1), t2);
      const state: RoomState = { ...base, openFloors: { [UPPER]: { sceneId: UPPER, rev: 1 }, [ATTIC]: { sceneId: ATTIC, rev: 1 } } };
      const r = applied(state, { t: "trap.spring", trapId: "t1", tokenIds: [hId] });
      assert.deepEqual([r.state.tokens[hId]!.sceneId, r.state.tokens[sId]!.sceneId], [GROUND, GROUND], `${sId}: the lower trapdoor dropped both`);
      const cards = named(r.state);
      if (sId === "s-shade") assert.deepEqual(cards, [`h-shade ${ATTIC}>${UPPER} 10`, `h-shade s-shade ${UPPER}>${GROUND} 10`], "the other joins the card on Ground floor, where it lands");
      // Dropped first, the other finds only the Attic's card to join: the creature still has its two damaging cards, one a drop.
      else assert.deepEqual(cards, [`h-shade a-shade ${ATTIC}>${UPPER} 10`, `h-shade ${UPPER}>${GROUND} 10`]);
    }
  });

  /** 21 tokens of Shade on Upper floor, t01 to t21, in a 5 by 5 block at 6, 6 that leaves its last four squares empty. */
  function crowd(sceneId = UPPER): Token[] {
    return Array.from({ length: 21 }, (_, i) => shade(`t${String(i + 1).padStart(2, "0")}`, { sceneId, x: 6 + (i % 5), y: 6 + Math.floor(i / 5) }));
  }

  test("21 tokens of one character that a trapdoor drops, where only the 21st falls on, make two cards: the full one and the 21st's second fall", () => {
    const td = trapdoor("td1", { sceneId: ATTIC, zone: { cells: [{ x: 6, y: 6, w: 5, h: 5 }] } });
    // The opening on Upper floor lies under the 21st token alone, at 6, 10.
    const state = withTrapdoor(withShade(withOpening(empty(), { rect: { x: 6, y: 10, w: 1, h: 1 } }), ...crowd(ATTIC)), td);
    const r = applied(state, { t: "trap.spring", trapId: "td1", tokenIds: crowd().map((t) => t.id) });
    const [full, second, ...more] = Object.values(r.state.falls ?? {}).sort(byFallAge);
    assert.deepEqual([full?.tokenId, full?.riders?.length, full?.riders?.includes("t21"), full?.sceneId], ["t01", FALL_RIDERS_MOST, false, UPPER], "the full card leaves the 21st off");
    assert.deepEqual([second?.tokenId, second?.riders, second?.sceneId, more.length], ["t21", undefined, GROUND, 0], "its fall below keeps a card of its own");
    assert.deepEqual(r.falls?.map((f) => [f.tokenId, f.fallId]), [["t21", second?.id]]);
  });

  test("21 tokens of one character an opening is placed under make one full card, and the 21st's record names it", () => {
    const state = withShade(empty(), ...crowd());
    const r = applied(state, putOpeningOp({ rect: { x: 6, y: 6, w: 5, h: 5 } }));
    const cards = Object.values(r.state.falls ?? {});
    assert.equal(cards.length, 1);
    assert.deepEqual([cards[0]!.tokenId, cards[0]!.riders?.length, cards[0]!.riders?.includes("t21")], ["t01", FALL_RIDERS_MOST, false]);
    assert.equal(r.falls?.length, 21, "a record for each root, for the undo");
    assert.deepEqual(new Set(r.falls?.map((f) => f.fallId)), new Set([cards[0]!.id]), "the 21st's record names the full card that left it off");
  });

  test("a token whose creature's card the op itself evicted gets a card of its own", () => {
    // In id order: Shade's first token, ten goblins whose cards evict it, then Shade's second token.
    const goblins = Array.from({ length: 10 }, (_, i) => up(`b${String(i).padStart(2, "0")}`, { x: 6 + (i % 4), y: 6 + Math.floor(i / 4) }));
    const state = withShade(empty(), shade("a-shade", { x: 9, y: 8 }), ...goblins, shade("c-shade", { x: 6, y: 9 }));
    const r = applied(state, putOpeningOp({ rect: { x: 6, y: 6, w: 4, h: 4 } }));
    const cards = named(r.state);
    assert.equal(cards.length, LIMITS.fallsPerRoom);
    assert.ok(!cards.some((c) => c.startsWith("a-shade")), "the first card went");
    assert.ok(cards.includes(`c-shade ${UPPER}>${GROUND} 10`), "Shade's second token has a card of its own");
  });

  test("both of Thorn's tokens walked onto the hole in one group move make one card with two records, which the undo takes away and the redo writes once", () => {
    const state = withTokens(holed({}, { x: 6, y: 4 }), thornToken({ id: "thorn2", sceneId: UPPER, x: 7, y: 4 }));
    const r = applied(state, { t: "token.moveMany", moves: [{ tokenId: "thorn", x: 6, y: 6 }, { tokenId: "thorn2", x: 7, y: 7 }] }, ANA);
    assert.deepEqual(named(r.state), [`thorn thorn2 ${UPPER}>${GROUND} 10`]);
    const card = Object.values(r.state.falls!)[0]!;
    assert.deepEqual(r.falls?.map((f) => f.fallId), [card.id, card.id]);
    const entries = r.inverse!.filter((e) => e.key.startsWith("token:"));
    const undone = applied(r.state, { t: "sys.restore", from: "undo", entries: entries.map(({ expectHash: _h, ...e }) => e), falls: r.falls } as Op, ANA);
    assert.deepEqual([undone.state.tokens.thorn!.sceneId, undone.state.tokens.thorn2!.sceneId, undone.state.falls?.[card.id]], [UPPER, UPPER, undefined]);
    const below = [r.state.tokens.thorn!, r.state.tokens.thorn2!].map((t) => ({ key: `token:${t.id}`, value: t }));
    const redone = applied(undone.state, { t: "sys.restore", from: "redo", entries: below, falls: r.falls!.map((f) => ({ ...f, card })) } as Op, ANA);
    assert.deepEqual(named(redone.state), [`thorn thorn2 ${UPPER}>${GROUND} 10`], "two records carrying one card write it once, each token named once");
  });

  /** A player's undo of a step, built as the server builds it: the tokens it puts back, as they stood, and its fall records. */
  const undoOp = (was: RoomState, ids: readonly string[], falls: readonly FallRecord[]): Op => ({ t: "sys.restore", from: "undo", entries: ids.map((id) => ({ key: `token:${id}`, value: was.tokens[id]! })), falls } as Op);
  const redoOp = (below: RoomState, ids: readonly string[], falls: readonly FallRecord[]): Op => ({ t: "sys.restore", from: "redo", entries: ids.map((id) => ({ key: `token:${id}`, value: below.tokens[id]! })), falls } as Op);
  const anyMove = (state: RoomState): RoomState => ({ ...state, meta: { ...state.meta, settings: { ...state.meta.settings, playersMoveAny: "all" as const } } });

  test("Ana's undo of her root that joined the card of Shade's hidden token leaves the card whole, so the redo has nothing to put back", () => {
    // A card from earlier in the op names H, Shade's hidden token, and Ana's walk of Shade's other token S joined it.
    const card = fallCard({ id: `${nextSeq()}:0`, tokenId: "h-shade", riders: ["s-shade"] });
    const state = withFalls(withShade(holed(), shade("h-shade", { sceneId: GROUND, x: 10, y: 10, visibility: "dm" }), shade("s-shade", { sceneId: GROUND, x: 6, y: 6 })), card);
    const was = { ...state, tokens: { ...state.tokens, "s-shade": { ...state.tokens["s-shade"]!, sceneId: UPPER } } };
    const record = fallRecord({ tokenId: "s-shade", fallId: card.id });
    const undone = applied(state, undoOp(was, ["s-shade"], [record]), ANA);
    assert.equal(undone.state.tokens["s-shade"]!.sceneId, UPPER);
    assert.deepEqual(undone.state.falls?.[card.id], card, "Shade stays on the card whole, H still below");
    assert.ok(!undone.touched.includes(`fall:${card.id}`), "the undo writes no card");
  });

  test("H drops from the Attic and falls on, V of the same character falls from the Attic and joins H's first card, and V's undo keeps both cards", () => {
    // The trapdoor on the Attic does not stop V's walk, which springs it on the way to the Attic's own opening at 10, 6.
    const td = trapdoor("td1", { sceneId: ATTIC, zone: { cells: [{ x: 6, y: 6, w: 2, h: 2 }] }, rig: { ...trapdoor().rig!, stops: false, foundOnSpring: false } });
    const holes = withOpening(withOpening(empty()), { id: "o3", pairId: "o4", upper: ATTIC, lower: UPPER, rect: { x: 10, y: 6, w: 2, h: 2 } });
    const base = withTrapdoor(withShade(holes, shade("h-shade", { sceneId: ATTIC, x: 6, y: 6, visibility: "dm" }), shade("v-shade", { sceneId: ATTIC, x: 4, y: 6 })), td);
    const state = anyMove({ ...base, openFloors: { [UPPER]: { sceneId: UPPER, rev: 1 }, [ATTIC]: { sceneId: ATTIC, rev: 1 } } });
    const r = applied(state, { t: "token.move", tokenId: "v-shade", x: 10, y: 6, route: [[6, 6, 0, 0], [10, 6, 0, 0]] }, ANA);
    assert.deepEqual([r.state.tokens["h-shade"]!.sceneId, r.state.tokens["v-shade"]!.sceneId], [GROUND, UPPER]);
    assert.deepEqual(named(r.state), [`h-shade v-shade ${ATTIC}>${UPPER} 10`, `h-shade ${UPPER}>${GROUND} 10`], "V joins H's card on its own floor");
    const v = r.falls!.find((f) => f.tokenId === "v-shade")!;
    const undone = applied(r.state, undoOp(state, ["v-shade"], [v]), ANA);
    assert.equal(undone.state.tokens["v-shade"]!.sceneId, ATTIC);
    assert.deepEqual(named(undone.state), named(r.state), "H still owes both falls, so both cards stay");
  });

  test("a rider left below by the root's undo keeps the card, the redo puts the root back after it, and after the rider's Apply writes the root's card", () => {
    // Ana's horse carries the goblin onto the hole. Her undo takes the horse back up and leaves the goblin below, as the server
    // leaves a rider the DM hid after the fall or a hidden one the DM took off the mount.
    const state = withTokens(holed({}, { x: 15, y: 15 }), up("horse", { size: "large", ownerIds: ["p1"], x: 2, y: 6 }), up("goblin", { x: 2, y: 6, attached: { to: "horse", kind: "ride" } }));
    const r = applied(state, move("horse", 6, 6), ANA);
    const card = Object.values(r.state.falls!)[0]!;
    assert.deepEqual([card.tokenId, card.riders], ["horse", ["goblin"]]);
    const off = run(r.state, { t: "token.detach", tokenId: "goblin", x: 8, y: 6, elevation: 0 });
    const undone = applied(off, undoOp(state, ["horse"], r.falls!), ANA);
    assert.deepEqual([undone.state.tokens.horse!.sceneId, undone.state.tokens.goblin!.sceneId], [UPPER, GROUND]);
    assert.deepEqual([undone.state.falls?.[card.id]?.tokenId, undone.state.falls?.[card.id]?.riders], ["goblin", undefined], "the goblin's fall still waits");
    // The redo's record carries the part the undo took off (server/rooms/undo.ts fallsRestored).
    const part = { ...card, tokenId: "horse", riders: undefined };
    delete part.riders;
    const redo = redoOp(r.state, ["horse"], r.falls!.map((f) => ({ ...f, card: part })));
    const redone = applied(undone.state, redo, ANA);
    assert.deepEqual([redone.state.falls?.[card.id]?.tokenId, redone.state.falls?.[card.id]?.riders], ["goblin", ["horse"]], "the root goes back after the rider");
    const settled = run(undone.state, { t: "actor.outcome", plan: "p1", fall: { fallId: card.id, tokenIds: ["goblin"] }, targets: [{ target: { tokenId: "goblin" }, amount: 3 }] });
    assert.equal(settled.falls?.[card.id], undefined);
    const after = applied(settled, redo, ANA);
    assert.deepEqual([after.state.falls?.[card.id]?.tokenId, after.state.falls?.[card.id]?.riders], ["horse", undefined], "the redo writes the root's card");
    // At change format 66 the undo removed the card whole, and the redo wrote its record's card over what stood.
    assert.equal(applied(off, undoOp(state, ["horse"], r.falls!), ANA, 66).state.falls?.[card.id], undefined);
    const over = applied(undone.state, redo, ANA, 66).state.falls?.[card.id];
    assert.deepEqual([over?.tokenId, over?.riders], ["horse", undefined], "the goblin's waiting fall written over");
  });

  test("a token the DM deleted after the fall counts as gone from the card at the undo, beside a rider or another token of its creature", () => {
    const state = withTokens(holed({}, { x: 15, y: 15 }), up("horse", { size: "large", ownerIds: ["p1"], x: 2, y: 6 }), up("goblin", { x: 2, y: 6, attached: { to: "horse", kind: "ride" } }));
    const r = applied(state, move("horse", 6, 6), ANA);
    const card = Object.values(r.state.falls!)[0]!;
    const gone = run(r.state, { t: "token.delete", tokenId: "goblin" });
    assert.ok(gone.falls?.[card.id], "the card stays while the horse stands");
    assert.equal(applied(gone, undoOp(state, ["horse"], r.falls!), ANA).state.falls?.[card.id], undefined, "the card names nothing left, so it goes");
    // Both of Thorn's tokens on one card, the second deleted since: the first's undo clears the creature.
    const two = withTokens(holed({}, { x: 6, y: 4 }), thornToken({ id: "thorn2", sceneId: UPPER, x: 7, y: 4 }));
    const fell = applied(two, { t: "token.moveMany", moves: [{ tokenId: "thorn", x: 6, y: 6 }, { tokenId: "thorn2", x: 7, y: 7 }] }, ANA);
    const one = Object.values(fell.state.falls!)[0]!;
    const less = run(fell.state, { t: "token.delete", tokenId: "thorn2" });
    assert.equal(applied(less, undoOp(two, ["thorn"], [fell.falls![0]!]), ANA).state.falls?.[one.id], undefined);
  });
});

