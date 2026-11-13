import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { ATTIC, GROUND, UPPER, tower, withStairs } from "#shared/floorLinksTestutil.ts";
import type { RoomState, SceneId, Token } from "#shared/model.ts";
import { ephEventOutSchema, ephEventSchema, outboundEph, type EphEvent, type Op } from "#shared/protocol.ts";
import { chunkKey } from "#shared/keys.ts";
import { SQUARES } from "#shared/rules/grid.ts";
import { projectState } from "#shared/project.ts";
import { standsOn } from "#shared/rules/floorLinks.ts";
import { actor, character, DM, env, P1, reveal } from "#shared/testutil.ts";
import { applyOp } from "#shared/reducer.ts";
import { RoomScope } from "../../state/scope.ts";
import type { ToolContext } from "../tools.ts";
import { CARRIED_NO_KEEP, CARRIED_STAIRS_GONE, CARRIED_TOO_LONG, CARRIED_WALKS } from "../floors/linkWords.ts";
import { climbFeet, frameFits, priorOut, rulerAnchors, rulerFrame, shareLocked, stairsOffer, stairsPlan, stillCarried, type Carry, type Stairs } from "./carry.ts";
import { tokenStop, type RulerState, type RulerStop } from "./ruler.ts";
import { createStore } from "zustand/vanilla";
import { endGoneCarry, watchGoneStairs, pickMeasure, publish, refuseKeep, restoreRuler, rulerActivated, rulerDeactivated, rulerSlot, takeStairs } from "./rulerStore.ts";
import { measureWalk, walkText, type WalkInput } from "./walkRuler.ts";

/*
 * The walking ruler over stairs (docs/design/design-v1-floors.md phase 3,
 * 4.1 and 4.2), on the shared tower: Thorn, a Medium creature, at 3, 3 on
 * Ground floor, and stairs one square wide at 8, 3 up to Upper floor, 10 ft
 * above. A ruler from Thorn to the stairs walks 25 ft.
 */

const free = (x: number, y: number): RulerStop => ({ x: x + 0.5, y: y + 0.5 });
const STAIRS = { x: 8, y: 3, w: 1, h: 1 };
const ALL: SceneId[] = [GROUND, UPPER, ATTIC];

function stairsRoom(over: { kind?: "stairs" | "ladder"; rect?: typeof STAIRS; thorn?: Partial<Token> } = {}): RoomState {
  const s = withStairs(tower(), { rect: over.rect ?? STAIRS, kind: over.kind ?? "stairs" });
  return over.thorn ? { ...s, tokens: { ...s.tokens, thorn: { ...s.tokens.thorn!, ...over.thorn } } } : s;
}

function walkOf(view: RoomState, sceneId: SceneId, stops: RulerStop[], who: { role: "dm" | "player"; share: boolean }, carried: Carry | null = null): WalkInput {
  return { view, sceneId, stops, viewer: { role: who.role }, everything: who.role === "dm" && !who.share, ...(carried ? { prior: priorOut(carried.prior) } : {}) };
}

/** The stairs plan for a ruler on `view`, as the row reads it. */
function plan(view: RoomState, stops: RulerStop[], who: { role: "dm" | "player"; share: boolean }, opts: { carried?: Carry | null; held?: SceneId[]; sceneId?: SceneId } = {}): Stairs | null {
  const carried = opts.carried ?? null;
  const walkInput = walkOf(view, opts.sceneId ?? GROUND, stops, who, carried);
  const walked = stops.length > 1 || carried ? measureWalk(walkInput) : null;
  return stairsPlan({ role: who.role, share: who.share, rulerId: "r1", walkInput, walked, carried, held: opts.held ?? ALL, whole: view });
}

const DM_OWN = { role: "dm" as const, share: false };
const DM_SHARED = { role: "dm" as const, share: true };
const PLAYER = { role: "player" as const, share: false };
const thornStop = (s: RoomState) => tokenStop(SQUARES, s.tokens.thorn!);

describe("the stairs button's offer (4.1)", () => {
  test("a walk that ends on stairs to a held floor offers them, and the press measures on from the landing, the climb counted", () => {
    const s = stairsRoom();
    const stairs = plan(s, [thornStop(s), free(8, 3)], DM_OWN)!;
    assert.deepEqual([stairs.offer.link.id, stairs.offer.to, stairs.offer.dir, stairs.offer.kind, stairs.offer.floor], ["l1", UPPER, "up", "stairs", "Upper floor"]);
    const { carry, stop } = stairs.plan;
    assert.deepEqual(stop, { x: 8.5, y: 3.5 }, "a free stop at the walker's middle on the same square");
    assert.deepEqual(carry.prior, { ft: 35, diag: { h: 0, v: 0 }, walker: { size: "medium" }, anchors: ["thorn"], ends: ["l1"] });
    assert.deepEqual([carry.floor, carry.shared, carry.tokenId], [UPPER, false, "thorn"]);
    const far = measureWalk(walkOf(s, UPPER, [stop], DM_OWN, carry))!;
    assert.deepEqual([far.legs.length, far.totalFt, walkText(far)], [0, 35, "Walking 35 ft\n35 ft before this floor"]);
    const on = measureWalk(walkOf(s, UPPER, [stop, free(10, 3)], DM_OWN, carry))!;
    assert.equal(walkText(on), "Walking 45 ft\n35 ft before this floor");
  });

  test("a ruler of one stop on a creature standing on stairs offers them too", () => {
    const s = stairsRoom({ thorn: { x: 8, y: 3 } });
    assert.equal(plan(s, [thornStop(s)], DM_OWN)?.plan.carry.prior.ft, 10);
  });

  test("no button for locked stairs, stairs to a floor not held, a walk still searching or a leg with no way", () => {
    const s = stairsRoom();
    const stops = [thornStop(s), free(8, 3)];
    const locked: RoomState = { ...s, floorLinks: { ...s.floorLinks!, l1: { ...s.floorLinks!.l1!, locked: true as const } } };
    assert.equal(plan(locked, stops, DM_OWN), null, "locked");
    assert.equal(plan(s, stops, DM_OWN, { held: [GROUND] }), null, "Upper floor not held");
    const walkInput = walkOf(s, GROUND, stops, DM_OWN);
    const walked = measureWalk(walkInput)!;
    const searching = { ...walked, searching: true };
    assert.equal(stairsPlan({ role: "dm", share: false, rulerId: "r1", walkInput, walked: searching, carried: null, held: ALL, whole: s }), null, "still searching");
    const noWay = { ...walked, legs: walked.legs.map((l) => ({ ...l, none: true })) };
    assert.equal(stairsPlan({ role: "dm", share: false, rulerId: "r1", walkInput, walked: noWay, carried: null, held: ALL, whole: s }), null, "a leg with no way");
    assert.equal(plan(s, [thornStop(s), free(7, 3)], DM_OWN), null, "off the stairs");
  });

  test("a shared ruler counts only stairs players can see, and the DM's private ruler counts every end", () => {
    const s = stairsRoom();
    s.scenes[GROUND] = { ...s.scenes[GROUND]!, fogEnabled: true };
    // The way to the stairs is revealed, the stairs' square is not.
    reveal(s, GROUND, { x: 0, y: 0, w: 8, h: 20 });
    const stops = [thornStop(s), free(8, 3)];
    assert.notEqual(plan(s, stops, DM_OWN), null, "the DM's private ruler");
    assert.equal(plan(s, stops, DM_SHARED), null, "the DM's shared ruler");
    reveal(s, GROUND, { x: 8, y: 3, w: 1, h: 1 });
    assert.notEqual(plan(s, stops, DM_SHARED), null, "once revealed");
    assert.equal(plan(s, stops, DM_SHARED)?.plan.carry.shared, true);
  });

  test("an unsqueezed Large walker ending on 1 by 1 stairs gets no button, as Go up refuses it, and a squeezed one lands squeezed", () => {
    const large = stairsRoom({ thorn: { size: "large", x: 2, y: 2 } });
    // Its middle on the stairs' middle: unsqueezed it would hang over them.
    assert.equal(plan(large, [thornStop(large), free(8, 3)], DM_OWN), null);
    // Standing over them unsqueezed in a stairwell, where Go up would ask it to squeeze first (standsOn "squeeze", D-261110-184).
    const well = stairsRoom({ thorn: { size: "large", x: 7.5, y: 2.5 } });
    const walls = Object.fromEntries(["8,2,w", "8,3,w", "8,4,w", "9,2,w", "9,3,w", "9,4,w"].map((k) => [k, { kind: "wall" as const }]));
    const over: RoomState = { ...well, scenes: { ...well.scenes, [GROUND]: { ...well.scenes[GROUND]!, blockMovement: true, autoWalls: "off" } }, buildChunks: { ...well.buildChunks, [chunkKey(GROUND, 0, 0)]: { sceneId: GROUND, cx: 0, cy: 0, rev: 1, cells: {}, edges: walls } } };
    assert.equal(standsOn(over, DM, over.tokens.thorn!, over.floorLinks!.l1!), "squeeze");
    assert.equal(plan(over, [thornStop(over)], DM_OWN), null);
    const squeezed = stairsRoom({ thorn: { size: "large", x: 7.5, y: 2.5, squeeze: true } });
    const stairs = plan(squeezed, [thornStop(squeezed)], DM_OWN)!;
    assert.deepEqual(stairs.plan.carry.prior.walker, { size: "large", squeeze: true });
    assert.deepEqual(stairs.plan.stop, { x: 8.5, y: 3.5 });
  });

  test("a squeezed Large walker lands squeezed, walks a corridor one square wide squeezed, and the second stairs offer as Go up would", () => {
    let s = stairsRoom({ thorn: { size: "large", x: 7.5, y: 2.5, squeeze: true } });
    // On Upper floor a corridor one square wide along y = 3 from the stairs to a ladder at 14, 3 up to Attic.
    const edges: Record<string, { kind: "wall" }> = {};
    for (let x = 9; x < 14; x++) Object.assign(edges, { [`${x},3,n`]: { kind: "wall" }, [`${x},4,n`]: { kind: "wall" } });
    s = { ...s, scenes: { ...s.scenes, [UPPER]: { ...s.scenes[UPPER]!, blockMovement: true, autoWalls: "off" } }, buildChunks: { ...s.buildChunks, [chunkKey(UPPER, 0, 0)]: { sceneId: UPPER, cx: 0, cy: 0, rev: 1, cells: {}, edges } } };
    s = withStairs(s, { id: "l3", pairId: "l4", sceneId: UPPER, to: ATTIC, rect: { x: 14, y: 3, w: 1, h: 1 }, kind: "ladder" });
    const one = plan(s, [thornStop(s)], DM_SHARED)!;
    assert.deepEqual(one.plan.carry.prior.walker, { size: "large", squeeze: true });
    const two = plan(s, [one.plan.stop, free(14, 3)], DM_SHARED, { carried: one.plan.carry, sceneId: UPPER })!;
    assert.deepEqual([two.offer.link.id, two.offer.to, two.plan.carry.prior.walker], ["l3", ATTIC, { size: "large", squeeze: true }]);
    const corridor = measureWalk(walkOf(s, UPPER, [one.plan.stop, free(14, 3)], DM_SHARED, one.plan.carry))!;
    assert.equal(corridor.end.walker.squeeze, true);
    assert.ok(corridor.totalFt > 10 + 30, "squeezing costs more than the six squares walked");
    assert.equal(two.plan.carry.prior.ft, corridor.totalFt + 20, "and the ladder twice its height");
  });

  test("a Tiny walker carries its half squares: 2.5 ft and half a diagonal before the stairs stay 12.5 ft and h 0.5, and walk on from there (FL3-ASTRA-01)", () => {
    const tiny = (x: number, y: number, diagonal: "five" | "fiveTen") => {
      const s = stairsRoom({ thorn: { size: "tiny", x, y } });
      return { ...s, meta: { ...s.meta, settings: { ...s.meta.settings, diagonal } } };
    };
    const across = tiny(7.5, 3, "five");
    const straight = plan(across, [thornStop(across), { x: 8.25, y: 3.25 }], DM_OWN)!.plan.carry;
    assert.deepEqual([straight.prior.ft, straight.prior.diag], [12.5, { h: 0, v: 0 }]);
    assert.equal(walkText(measureWalk(walkOf(across, UPPER, [{ x: 8.25, y: 3.25 }], DM_OWN, straight))!), "Walking 12.5 ft\n12.5 ft before this floor");
    const slant = tiny(6.5, 1.5, "fiveTen");
    const diagonal = plan(slant, [thornStop(slant), { x: 8.25, y: 3.25 }], DM_OWN)!.plan.carry;
    assert.deepEqual([diagonal.prior.ft, diagonal.prior.diag], [17.5, { h: 1.5, v: 0 }], "three half diagonals, 2.5, 5 and 2.5 ft, and the 10 ft climb");
    const frame = rulerFrame("r1", [{ x: 8.25, y: 3.25 }], false, true, diagonal);
    assert.ok(ephEventSchema.safeParse(frame).success, "the server takes the halves");
    assert.ok(ephEventOutSchema.safeParse(outboundEph(frame)).success, "and every receiver does");
  });

  test("a rise's fifth of a diagonal carries over the stairs: 1 ft down to them under 5-10-5 leaves v 0.2, so rising 4 then 5 ft on Upper reads 30 ft, not 25 (FL3-ASTRA-01)", () => {
    const raise = (st: RoomState, sceneId: SceneId, cells: [string, number][]) =>
      cells.reduce((acc, [cell, height], i) => {
        const r = applyOp(acc, { t: "build.height", sceneId, cells: [cell], height } as Op, DM, env(900 + i));
        assert.ok(r.ok, r.ok ? "" : r.message);
        return r.state;
      }, st);
    let s = stairsRoom({ thorn: { x: 7, y: 3, elevation: 1 } });
    s = { ...s, meta: { ...s.meta, settings: { ...s.meta.settings, diagonal: "fiveTen" as const } } };
    s = raise(raise(s, GROUND, [["7,3", 1]]), UPPER, [["9,3", 4], ["10,3", 9]]);
    const { carry, stop } = plan(s, [thornStop(s), free(8, 3)], DM_OWN)!.plan;
    assert.deepEqual([carry.prior.ft, carry.prior.diag], [15, { h: 0, v: 0.2 }]);
    assert.ok(ephEventSchema.safeParse(rulerFrame("r1", [stop], false, true, carry)).success, "the server takes the fifth");
    const on = (c: Carry) => measureWalk(walkOf(s, UPPER, [stop, { x: 9.5, y: 3.5, z: 4 }, { x: 10.5, y: 3.5, z: 9 }], DM_OWN, c))!.totalFt;
    assert.equal(on(carry), 30, "the second climb is the count's second diagonal, 10 ft");
    assert.equal(on({ ...carry, prior: { ...carry.prior, diag: { h: 0, v: 0 } } }), 25, "as it would read with the fifth rounded away");
  });

  test("a custom walker carries its sides", () => {
    const s = stairsRoom({ rect: { x: 8, y: 3, w: 1, h: 3 }, thorn: { size: "custom", w: 1, h: 3, x: 8, y: 3 } });
    assert.deepEqual(plan(s, [thornStop(s)], DM_OWN)?.plan.carry.prior.walker, { size: "custom", w: 1, h: 3 });
  });
});

describe("the climb's price (4.1, D-261110-082)", () => {
  const climber = (s: RoomState): RoomState => ({ ...s, characters: { ...s.characters, thorn: character("thorn", { name: "Thorn", ownerIds: ["p1"], actor: actor({ speeds: { walk: 30, climb: 30 } }) }) } });

  test("stairs cost the height, a ladder twice that, and a Climb Speed halves a ladder only on the DM's private ruler", () => {
    const stairs = stairsRoom({ thorn: { x: 8, y: 3 } });
    const ladder = climber(stairsRoom({ kind: "ladder", thorn: { x: 8, y: 3 } }));
    const ft = (s: RoomState, who: { role: "dm" | "player"; share: boolean }) => plan(s, [thornStop(s)], who)?.plan.carry.prior.ft;
    assert.equal(ft(stairs, DM_OWN), 10);
    assert.deepEqual([ft(ladder, DM_OWN), ft(ladder, DM_SHARED), ft(ladder, PLAYER)], [10, 20, 20]);
  });

  test("a player's copy prices the climb by the end's `rise`, as the DM's prices it by the floors' heights", () => {
    const base = stairsRoom({ thorn: { x: 8, y: 3 } });
    const tall = { ...base, scenes: { ...base.scenes, [UPPER]: { ...base.scenes[UPPER]!, floor: { ...base.scenes[UPPER]!.floor!, height: 30 } } }, openFloors: { [UPPER]: { sceneId: UPPER, rev: 1 } } };
    const ana = projectState(tall, P1, { sceneId: GROUND }) as unknown as RoomState;
    assert.equal(ana.floorLinks?.l1 && "rise" in ana.floorLinks.l1 ? ana.floorLinks.l1.rise : undefined, 30, "her end carries the climb's height");
    assert.equal(ana.scenes[UPPER]?.floor && "height" in ana.scenes[UPPER].floor ? ana.scenes[UPPER].floor.height : undefined, undefined, "and her floors none");
    const stops = [tokenStop(SQUARES, ana.tokens.thorn!)];
    const walkInput = walkOf(ana, GROUND, stops, PLAYER);
    const stairs = stairsPlan({ role: "player", share: false, rulerId: "r1", walkInput, walked: null, carried: null, held: [GROUND, UPPER], whole: ana });
    assert.equal(stairs?.plan.carry.prior.ft, 30);
    assert.equal(plan(tall, [thornStop(tall)], DM_SHARED)?.plan.carry.prior.ft, 30, "the same on the DM's");
  });

  test("crawling never counts: a Prone walker climbs stairs at their height", () => {
    const s = stairsRoom({ thorn: { x: 8, y: 3 } });
    const prone = { ...s, characters: { ...s.characters, thorn: character("thorn", { name: "Thorn", ownerIds: ["p1"], actor: actor({ effects: [{ key: "prone" }] as never }) }) } };
    assert.equal(climbFeet(prone, prone.tokens.thorn!, { ...prone.floorLinks!.l1!, to: UPPER }, true), 10);
  });

  test("two ladders in a row: the private ruler's fresh walker keeps the real creature's Climb Speed, the shared ones never read it", () => {
    let s = climber(stairsRoom({ kind: "ladder", thorn: { x: 8, y: 3 } }));
    s = withStairs(s, { id: "l3", pairId: "l4", sceneId: UPPER, to: ATTIC, rect: { x: 10, y: 3, w: 1, h: 1 }, kind: "ladder" });
    for (const [who, first, second] of [
      // The second adds the 10 ft walked between the ladders.
      [DM_OWN, 10, 30],
      [DM_SHARED, 20, 50],
      [PLAYER, 20, 50],
    ] as const) {
      const one = plan(s, [thornStop(s)], who)!;
      assert.equal(one.plan.carry.prior.ft, first);
      const input = walkOf(s, UPPER, [one.plan.stop, free(10, 3)], who, one.plan.carry);
      // Only the DM's private ruler gives the fresh walker the real creature's actor (RulerTool.tsx).
      const withActor = who === DM_OWN ? { ...input, actor: s.characters.thorn!.actor } : input;
      const two = stairsPlan({ role: who.role, share: who.share, rulerId: "r1", walkInput: withActor, walked: measureWalk(withActor), carried: one.plan.carry, held: ALL, whole: s })!;
      assert.equal(two.plan.carry.prior.ft, second, `${who.role} ${who.share}`);
      assert.deepEqual(two.plan.carry.prior.ends, ["l1", "l3"]);
      assert.equal(two.plan.carry.tokenId, "thorn", "the real walker stays the first crossing's");
    }
  });
});

describe("the frame a carried ruler sends (4.2, 4.4)", () => {
  test("every creature a stop sat on, on every floor, and the walker, each named once", () => {
    const carried = { prior: { ft: 35, diag: { h: 0, v: 0 }, walker: { size: "medium" as const }, anchors: ["thorn", "gob"], ends: ["l1"] }, floor: UPPER, shared: true, tokenId: "thorn", landing: free(8, 3) };
    assert.deepEqual(rulerAnchors(carried, [free(8, 3), { x: 3, y: 3, tokenId: "ogre" }, { x: 4, y: 3, tokenId: "gob" }], null), ["thorn", "gob", "ogre"]);
    assert.deepEqual(rulerAnchors(null, [{ x: 3, y: 3, tokenId: "rider" }], "mount"), ["mount", "rider"]);
  });

  test("a ruler started afresh away from the landing is carried no more", () => {
    const carried = { prior: { ft: 35, diag: { h: 0, v: 0 }, walker: { size: "medium" as const }, anchors: [], ends: ["l1"] }, floor: UPPER, shared: true, tokenId: null, landing: free(8, 3) };
    assert.equal(stillCarried(carried, [free(8, 3), free(9, 3)]), carried);
    assert.equal(stillCarried(carried, [free(2, 3), free(9, 3)]), null);
    assert.equal(stillCarried(carried, []), null);
  });

  test("a frame near the server's 4 KB cap is measured: 50 creatures and 8 ends leave room for few stops on creatures", () => {
    const id = (n: number) => `0190a1b2-c3d4-7e5f-8a9b-${String(n).padStart(12, "0")}`;
    const prior = { ft: 35, diag: { h: 0, v: 0 }, walker: { size: "medium" as const }, anchors: Array.from({ length: 50 }, (_, i) => id(i)), ends: Array.from({ length: 8 }, (_, i) => id(100 + i)) };
    const carry: Carry = { prior, floor: UPPER, shared: true, tokenId: null, landing: free(8, 3) };
    const stops = (n: number) => [free(8, 3), ...Array.from({ length: n }, (_, i) => ({ x: i + 0.5, y: 9.5, tokenId: id(i) }))];
    assert.equal(frameFits(rulerFrame(id(999), stops(0), true, true, carry)), true);
    assert.equal(frameFits(rulerFrame(id(999), stops(30), true, true, carry)), false);
  });
});

// ------------------------------------------------------------ the tool's rules over a fake Room

type Sent = { e: EphEvent; localOnly: boolean };

/** A Ruler tool's context over a room whose floor shown the store switches at once, as a DM's held floor does. */
function fakeCtx(view: RoomState, role: "dm" | "player" = "dm") {
  const scope = new RoomScope();
  const sent: Sent[] = [];
  const said: string[] = [];
  const state = { sceneId: GROUND as SceneId, floorView: view, view };
  const ctx = {
    scope,
    role,
    get scene() {
      return view.scenes[state.sceneId]!;
    },
    getState: () => state,
    ui: { notify: (words: string) => void said.push(words) },
    actions: {
      sendEph: (e: EphEvent, opts?: { localOnly?: boolean }) => void sent.push({ e, localOnly: opts?.localOnly === true }),
      showFloor: (id: SceneId | null) => {
        if (id) state.sceneId = id;
      },
      newId: () => "r1",
    },
  } as unknown as ToolContext;
  return { ctx, scope, sent, said, state };
}

/** Thorn's ruler to the stairs, then a press, as the row and the board would make them. */
function carryUp(s: RoomState, who: { role: "dm" | "player"; share: boolean } = DM_OWN) {
  const f = fakeCtx(s, who.role);
  rulerActivated(f.ctx);
  const tool = f.scope.get(rulerSlot);
  tool.store.setState({ share: who.share, walk: true });
  const ruler: RulerState = { id: "r1", stops: [thornStop(s), free(8, 3)], live: null, shared: false };
  publish(f.ctx, ruler);
  const stairs = plan(s, ruler.stops, who)!;
  assert.equal(takeStairs(f.ctx, stairs.plan), true);
  // The board deactivates and activates the tool for the switch (canvas/Stage.tsx).
  rulerDeactivated(f.ctx);
  rulerActivated(f.ctx);
  return { ...f, tool, stairs };
}

describe("a press, the switch and the edges (4.2, D-261110-078)", () => {
  test("the press shows the far floor and sends the ruler from the landing under the same id with its prior, kept across the board's switch", () => {
    const { tool, sent, state, stairs } = carryUp(stairsRoom(), DM_SHARED);
    assert.equal(state.sceneId, UPPER);
    const last = sent[sent.length - 1]!;
    assert.deepEqual(last, { e: { k: "ruler", id: "r1", points: [stairs.plan.stop], shared: true, walk: true, prior: stairs.plan.carry.prior }, localOnly: false });
    assert.equal(sent.some((s) => s.e.k === "rulerEnd"), false, "the socket ends it on the floor left, not the tool");
    assert.deepEqual(tool.store.getState().ruler?.stops, [stairs.plan.stop]);
    assert.equal(tool.store.getState().share, true, "still shared");
    assert.equal(tool.store.getState().carry, stairs.plan.carry);
  });

  test("Keep and a double tap leave a carried ruler as it is, with the hint", () => {
    const { ctx, tool, said } = carryUp(stairsRoom());
    const before = tool.store.getState().ruler!;
    const grown: RulerState = { ...before, stops: [...before.stops, free(11, 3)] };
    publish(ctx, grown);
    // Keep: the ruler as it is.
    assert.equal(refuseKeep(ctx, tool.store.getState().ruler), true);
    assert.deepEqual(tool.store.getState().ruler?.stops, grown.stops);
    // A double tap whose first tap added a waypoint: the ruler as it was before the pair.
    publish(ctx, { ...grown, stops: [...grown.stops, free(12, 3)] });
    assert.equal(refuseKeep(ctx, grown), true);
    assert.deepEqual(tool.store.getState().ruler?.stops, grown.stops);
    assert.deepEqual(said, [CARRIED_NO_KEEP, CARRIED_NO_KEEP]);
    // A ruler started afresh away from the landing is kept as any ruler is.
    publish(ctx, { id: "r1", stops: [free(2, 2), free(5, 2)], live: null, shared: false });
    assert.equal(refuseKeep(ctx, tool.store.getState().ruler), false);
    assert.equal(tool.store.getState().carry, null);
  });

  test("a replacement drag a second finger cancels puts back the carried ruler with its carry, and its next frame carries the prior (FL3-ASTRA-02)", () => {
    const { ctx, tool, sent, stairs } = carryUp(stairsRoom(), DM_SHARED);
    const { ruler: before, carry } = tool.store.getState();
    // The press away from the landing starts a new ruler, which drops the carry at its first move.
    publish(ctx, { id: "r2", stops: [free(2, 2), free(5, 2)], live: null, shared: true });
    assert.equal(tool.store.getState().carry, null);
    restoreRuler(ctx, before, carry);
    assert.equal(tool.store.getState().carry, stairs.plan.carry);
    assert.deepEqual(tool.store.getState().ruler?.stops, before!.stops);
    assert.deepEqual(sent.at(-1)?.e, { k: "ruler", id: "r1", points: [stairs.plan.stop], shared: true, walk: true, prior: stairs.plan.carry.prior });
    // A cancelled first ruler leaves none.
    restoreRuler(ctx, null, null);
    assert.deepEqual([tool.store.getState().ruler, tool.store.getState().carry], [null, null]);
  });

  test("Straight is refused while carried, with its words", () => {
    const { ctx, scope, tool, said } = carryUp(stairsRoom());
    tool.activeCtx = ctx;
    pickMeasure(scope, "straight");
    assert.equal(tool.store.getState().walk, true);
    assert.deepEqual(said, [CARRIED_WALKS]);
  });

  test("the DM's Shared is off on a ruler carried private, and stays free on one carried shared", () => {
    const own = carryUp(stairsRoom(), DM_OWN).tool.store.getState().carry;
    const shared = carryUp(stairsRoom(), DM_SHARED).tool.store.getState().carry;
    assert.equal(shareLocked(own, false), true);
    assert.deepEqual([shareLocked(shared, false), shareLocked(shared, true)], [false, false]);
    assert.equal(shareLocked(null, false), false);
  });

  test("a DM's private carry is never sent, and its carry says it cannot be shared", () => {
    const { sent, tool } = carryUp(stairsRoom(), DM_OWN);
    assert.ok(sent.every((s) => s.localOnly));
    assert.equal(tool.store.getState().carry?.shared, false);
  });

  test("any other switch of floors drops the carry with the ruler, as `[` or `]` does, and ends it", () => {
    const { ctx, tool, state, sent } = carryUp(stairsRoom(), DM_SHARED);
    state.sceneId = GROUND;
    assert.equal(rulerDeactivated(ctx), false);
    rulerActivated(ctx);
    assert.deepEqual([tool.store.getState().ruler, tool.store.getState().carry], [null, null]);
    assert.deepEqual(sent[sent.length - 1], { e: { k: "rulerEnd", id: "r1" }, localOnly: false });
  });

  test("a ruler that has crossed eight ends, or would name more than 50 creatures, is offered no more stairs", () => {
    const s = stairsRoom({ thorn: { x: 8, y: 3 } });
    const end = { walker: s.tokens.thorn!, counter: { h: 0, v: 0 }, ft: 0 };
    const carry = (ends: number): Carry => ({ prior: { ft: 0, diag: { h: 0, v: 0 }, walker: { size: "medium" }, anchors: [], ends: Array.from({ length: ends }, (_, i) => `e${i}`) }, floor: GROUND, shared: true, tokenId: null, landing: free(8, 3) });
    const offer = (c: Carry | null, anchors: number) => stairsOffer({ view: s, held: ALL, end, shared: false, role: "dm", carry: c, anchors: Array.from({ length: anchors }, (_, i) => `t${i}`) });
    assert.notEqual(offer(carry(7), 50), null);
    assert.equal(offer(carry(8), 1), null, "eight ends crossed");
    assert.equal(offer(null, 51), null, "51 creatures");
  });

  test("up and down the stairs again and again: eight crossings, then no button", () => {
    const s = stairsRoom();
    const f = carryUp(s, DM_SHARED);
    for (let n = 2; n <= 9; n++) {
      const { ruler, carry } = f.tool.store.getState();
      const stairs = plan(s, ruler!.stops, DM_SHARED, { carried: carry, sceneId: f.state.sceneId });
      if (n > 8) {
        assert.equal(stairs, null, "past eight ends");
        break;
      }
      assert.ok(stairs, `crossing ${n}`);
      assert.equal(takeStairs(f.ctx, stairs.plan), true);
      rulerDeactivated(f.ctx);
      rulerActivated(f.ctx);
      assert.deepEqual(f.tool.store.getState().carry?.prior.ends.length, n);
      assert.equal(f.tool.store.getState().carry?.prior.ft, 10 * n + 25);
    }
    assert.deepEqual(f.tool.store.getState().carry?.prior.ends, ["l1", "l2", "l1", "l2", "l1", "l2", "l1", "l2"]);
  });

  test("stairs a co-DM removed end the carried ruler on this device, with a word and an end frame, and a copy that still holds them leaves it", () => {
    for (const who of [DM_OWN, DM_SHARED, PLAYER]) {
      const s = stairsRoom();
      const { ctx, tool, sent, said, state } = carryUp(s, who);
      assert.equal(endGoneCarry(ctx), false, "the stairs are still there");
      assert.ok(tool.store.getState().carry);
      // Only the far end goes: the other end of the pair is not the one the ruler took.
      const { l2, ...rest } = s.floorLinks!;
      state.view = { ...s, floorLinks: rest } as RoomState;
      assert.equal(endGoneCarry(ctx), false, "an end the ruler did not take");
      const { l1, ...none } = s.floorLinks!;
      state.view = { ...s, floorLinks: none } as RoomState;
      assert.equal(endGoneCarry(ctx), true, who.role);
      assert.deepEqual([tool.store.getState().ruler, tool.store.getState().carry], [null, null]);
      assert.deepEqual(said, [CARRIED_STAIRS_GONE]);
      assert.equal(sent[sent.length - 1]!.e.k, "rulerEnd");
      assert.equal(endGoneCarry(ctx), false, "nothing left to end");
    }
  });

  test("the watch ends a carried ruler when co-DM removes its stairs, with no options row mounted", () => {
    const s = stairsRoom();
    const { ctx, tool, scope, state, said } = carryUp(s);
    tool.activeCtx = ctx;
    const room = createStore<{ view: RoomState }>(() => ({ view: s }));
    const stop = watchGoneStairs(room as never, scope);
    // An unrelated change leaves the ends as they are and the ruler stands.
    room.setState({ view: { ...s } });
    assert.ok(tool.store.getState().ruler);
    const { l1, ...none } = s.floorLinks!;
    state.view = { ...s, floorLinks: none } as RoomState;
    room.setState({ view: state.view });
    assert.deepEqual([tool.store.getState().ruler, tool.store.getState().carry], [null, null]);
    assert.deepEqual(said, [CARRIED_STAIRS_GONE]);
    stop();
  });

  test("the last stairs removed end the carried ruler, though the copy then holds no ends field", () => {
    for (const who of [DM_OWN, DM_SHARED, PLAYER]) {
      const s = stairsRoom();
      const { ctx, tool, state, said } = carryUp(s, who);
      const { floorLinks: _gone, ...noField } = s;
      state.view = noField as RoomState;
      assert.equal(endGoneCarry(ctx), true, who.role);
      assert.deepEqual([tool.store.getState().ruler, tool.store.getState().carry], [null, null]);
      assert.deepEqual(said, [CARRIED_STAIRS_GONE]);
    }
  });

  test("a copy that has not loaded, or a ruler that is not carried, is left alone", () => {
    const s = stairsRoom();
    const { ctx, tool, state } = carryUp(s);
    state.view = undefined as unknown as RoomState;
    assert.equal(endGoneCarry(ctx), false, "no copy yet");
    state.view = { ...s, floorLinks: {} } as RoomState;
    tool.store.setState({ carry: null });
    assert.equal(endGoneCarry(ctx), false, "a plain ruler");
    assert.ok(tool.store.getState().ruler);
  });

  test("Clear drops the carry with the ruler", () => {
    const { ctx, tool } = carryUp(stairsRoom());
    publish(ctx, null);
    assert.equal(tool.store.getState().carry, null);
  });

  test("a stop that would take the frame past the cap is refused once with the hint, and the ruler keeps the last frame that fit", () => {
    const { ctx, tool, said, sent } = carryUp(stairsRoom(), DM_SHARED);
    const id = (n: number) => `0190a1b2-c3d4-7e5f-8a9b-${String(n).padStart(12, "0")}`;
    const carry = tool.store.getState().carry!;
    tool.store.setState({ carry: { ...carry, prior: { ...carry.prior, anchors: Array.from({ length: 50 }, (_, i) => id(i)) } } });
    const ruler = tool.store.getState().ruler!;
    const before = sent.length;
    let fitted = ruler;
    for (let n = 1; n <= 40; n++) {
      const next: RulerState = { ...ruler, stops: [...ruler.stops, ...Array.from({ length: n }, (_, i) => ({ x: i + 0.5, y: 9.5, tokenId: id(i) }))] };
      if (publish(ctx, next)) fitted = next;
    }
    assert.deepEqual(said, [CARRIED_TOO_LONG]);
    assert.equal(tool.store.getState().ruler?.stops.length, fitted.stops.length);
    assert.ok(fitted.stops.length > 1 && fitted.stops.length < 41);
    assert.ok(sent.slice(before).every((s) => s.e.k !== "ruler" || frameFits(s.e)));
  });
});
