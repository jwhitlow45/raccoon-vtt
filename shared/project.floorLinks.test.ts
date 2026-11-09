import assert from "node:assert/strict";
import { describe, test } from "node:test";
import fc from "fast-check";
import { floorOfKey } from "#server/rooms/fanout.ts";
import { ANA, ATTIC, BREE, GROUND, UPPER, applied, onThornsTurn, putOp, run, tower, withStairs } from "./floorLinksTestutil.ts";
import { keys, readEntity, tileKey, type EntityKey } from "./keys.ts";
import type { FloorLink, RoomState, Token, Viewer } from "./model.ts";
import { LINK_FOR_PLAYERS, allKeys, applyChanges, dependents, diffProjection, heldOf, projectEntity, projectState, stableStringify, type HeldEntry, type ProjectedState } from "./project.ts";
import { opSchema, type Op } from "./protocol.ts";
import { applyOp, type Applied } from "./reducer.ts";
import { heldFloors } from "./rules/floors.ts";
import { DM, FULL_TILE_BITS, env, reveal, token } from "./testutil.ts";

/*
 * Stairs and ladders in a viewer's copy (docs/design/design-v1-floors.md
 * phase 2, 4, lane FL2-B): the DM gets every end on the scene's floors as
 * stored, a player an end on a floor they hold and on revealed ground, cut
 * to ProjectedFloorLink, with `to` only while they hold that floor. Each
 * key the fan-out projects alone agrees with the snapshot, and a copy kept
 * up to date by changes alone stays the fresh projection through every
 * re-projection an end needs. Thorn's path keeps `prior` whole for its
 * owners and `seenDiag` alone for everyone else.
 *
 * The tower (floorLinksTestutil.ts): Ground floor (the players' start),
 * Upper floor and Attic. Ana owns Thorn. Bree owns nothing.
 */

const DISPLAY: Viewer = { memberId: "display:abcdefghijkl", role: "player" };
const PLAYERS: readonly Viewer[] = [ANA, BREE, DISPLAY];

const opened = (state: RoomState, ...ids: string[]): RoomState => ({ ...state, openFloors: { ...state.openFloors, ...Object.fromEntries(ids.map((id) => [id, { sceneId: id, rev: 1 }])) } });
/** Ana's familiar, which the DM hid, so Ana alone holds the floor it stands on. */
const owlOn = (state: RoomState, sceneId: string): RoomState => ({ ...state, tokens: { ...state.tokens, owl: token("owl", { sceneId, kind: "npc", name: "Owl", ownerIds: ["p1"], visibility: "dm", x: 12, y: 12 }) } });
/** A ladder from Upper floor (l3) up to Attic (l4), 1 by 1 at 8, 8. */
const ladderUp = (state: RoomState): RoomState => run(state, putOp({ id: "l3", pairId: "l4", sceneId: UPPER, to: ATTIC, rect: { x: 8, y: 8, w: 1, h: 1 }, kind: "ladder" }));
const withFog = (state: RoomState, ...ids: string[]): RoomState => ({ ...state, scenes: { ...state.scenes, ...Object.fromEntries(ids.map((id) => [id, { ...state.scenes[id]!, fogEnabled: true }])) } });

function copyOf(state: RoomState, viewer: Viewer, sceneId: string | null = viewer.role === "dm" ? GROUND : null): ProjectedState {
  return projectState(state, viewer, { sceneId });
}

/** The ends a viewer's copy holds, by id. */
function ends(state: RoomState, viewer: Viewer, sceneId?: string | null): Record<string, unknown> {
  return (copyOf(state, viewer, sceneId) as unknown as RoomState).floorLinks ?? {};
}

/** Every key the fan-out projects one at a time agrees with the snapshot, so neither path holds what the other does not. */
function agrees(state: RoomState, viewer: Viewer, sceneId: string | null): void {
  const copy = copyOf(state, viewer, sceneId) as unknown as RoomState;
  for (const key of allKeys(state)) {
    if (key === keys.encounterHistory) continue;
    assert.equal(stableStringify(projectEntity(key, state, viewer, { sceneId })), stableStringify(readEntity(copy, key)), `${viewer.memberId}: ${key}`);
  }
}

describe("an end as each viewer gets it (4)", () => {
  test("the DM gets both ends as stored on the scene's floors, and none viewing another scene", () => {
    const s = withStairs();
    assert.deepEqual(ends(s, DM), s.floorLinks);
    assert.deepEqual(ends(s, DM, "s2"), {});
    assert.ok(!("floorLinks" in copyOf(s, DM, "s2")), "a copy holds the field only while it holds an end, as writeEntity keeps it");
    agrees(s, DM, GROUND);
    agrees(s, DM, "s2");
  });

  test("a player gets the end on a floor they hold, cut: rev 0, no pair, ground or seq, and no `to` while they do not hold that floor", () => {
    const s = run(withStairs(), { t: "floorLink.update", linkId: "l1", patch: { locked: true } });
    for (const viewer of PLAYERS) {
      assert.deepEqual(ends(s, viewer), { l1: { id: "l1", rev: 0, sceneId: GROUND, rect: { x: 3, y: 3, w: 2, h: 1 }, kind: "stairs", locked: true, dir: "up" } }, viewer.memberId);
      agrees(s, viewer, null);
    }
  });

  test("once they hold the far floor, both ends arrive, each naming the other's floor, the way each leads from the levels", () => {
    const s = opened(withStairs(), UPPER);
    for (const viewer of PLAYERS) {
      const got = ends(s, viewer);
      assert.deepEqual(got.l1, { id: "l1", rev: 0, sceneId: GROUND, to: UPPER, rect: { x: 3, y: 3, w: 2, h: 1 }, kind: "stairs", dir: "up" }, viewer.memberId);
      assert.deepEqual(got.l2, { id: "l2", rev: 0, sceneId: UPPER, to: GROUND, rect: { x: 3, y: 3, w: 2, h: 1 }, kind: "stairs", dir: "down" }, viewer.memberId);
      agrees(s, viewer, null);
    }
  });

  test("Ana holds Attic through her hidden owl and Bree does not: the ladder up names Attic to Ana alone, and Bree's copy holds no trace of it", () => {
    const s = owlOn(ladderUp(opened(withStairs(), UPPER)), ATTIC);
    assert.ok(heldFloors(s, ANA, { sceneId: null }).has(ATTIC) && !heldFloors(s, BREE, { sceneId: null }).has(ATTIC));
    assert.equal((ends(s, ANA).l3 as { to?: string }).to, ATTIC);
    assert.ok(ends(s, ANA).l4, "Ana holds Attic's end too");
    for (const viewer of [BREE, DISPLAY]) {
      const got = ends(s, viewer);
      assert.deepEqual(got.l3, { id: "l3", rev: 0, sceneId: UPPER, rect: { x: 8, y: 8, w: 1, h: 1 }, kind: "ladder", dir: "up" }, viewer.memberId);
      assert.equal(got.l4, undefined, viewer.memberId);
      const text = JSON.stringify(copyOf(s, viewer));
      assert.doesNotMatch(text, /"at"(?!:)|Attic|"l4"|floorLink:l4/, `${viewer.memberId}'s copy names Attic or its end`);
      agrees(s, viewer, null);
    }
    agrees(s, ANA, null);
  });

  test("every field of an end reaches a player as LINK_FOR_PLAYERS says, and nothing else but `dir`", () => {
    const s = run(withStairs(tower(), { kind: "ladder" }), { t: "floorLink.update", linkId: "l1", patch: { locked: true } });
    const stored: Required<FloorLink> = { ...s.floorLinks!.l1!, locked: true, grid: "hexRows" };
    const state = { ...s, floorLinks: { ...s.floorLinks!, l1: stored } };
    assert.deepEqual(Object.keys(LINK_FOR_PLAYERS).sort(), Object.keys(stored).sort(), "the stored end sets every field the list names");
    for (const viewer of PLAYERS) {
      const copy = projectEntity(keys.floorLink("l1"), state, viewer, { sceneId: null }) as Record<string, unknown>;
      assert.ok(copy, viewer.memberId);
      for (const [field, rule] of Object.entries(LINK_FOR_PLAYERS) as [keyof FloorLink, string][]) {
        if (rule === "copied") assert.deepEqual(copy[field], stored[field], `${field} is copied`);
        else if (rule === "zeroed") assert.equal(copy[field], 0, `${field} is zeroed`);
        else assert.ok(!(field in copy), `${field} stays the DM's or waits for the far floor`);
      }
      for (const field of Object.keys(copy)) assert.ok(field === "dir" || (field in LINK_FOR_PLAYERS && !LINK_FOR_PLAYERS[field as keyof FloorLink].startsWith("dm: ")), `${field} is in the list`);
    }
  });

  test("swapping two linked floors' order turns every end's way for every holder", () => {
    const s = opened(withStairs(), UPPER);
    const r = applied(s, { t: "floor.order", sceneId: GROUND, floors: [UPPER, GROUND, ATTIC] });
    assert.ok(r.global, "a level change re-projects everything (tx.ts isGlobalChange)");
    for (const viewer of [...PLAYERS, DM]) {
      const got = ends(r.state, viewer) as Record<string, { dir?: string }>;
      if (viewer.role === "player") assert.deepEqual([got.l1?.dir, got.l2?.dir], ["down", "up"], viewer.memberId);
      else assert.deepEqual(got, r.state.floorLinks);
    }
  });

  test("under full fog over its squares an end is withheld, and one revealed square sends it, by the labels' rule", () => {
    const fogged = withFog(withStairs(), GROUND);
    for (const viewer of PLAYERS) assert.deepEqual(ends(fogged, viewer), {}, viewer.memberId);
    assert.deepEqual(ends(fogged, DM), fogged.floorLinks, "the DM gets fogged ends");
    const one = structuredClone(fogged);
    reveal(one, GROUND, { x: 4, y: 3, w: 1, h: 1 });
    for (const viewer of PLAYERS) {
      assert.deepEqual(Object.keys(ends(one, viewer)), ["l1"], viewer.memberId);
      agrees(one, viewer, null);
    }
    const beside = structuredClone(fogged);
    reveal(beside, GROUND, { x: 5, y: 3, w: 2, h: 2 });
    for (const viewer of PLAYERS) assert.deepEqual(ends(beside, viewer), {}, `${viewer.memberId}: ground revealed beside it shows nothing`);
  });

  test("on hexes an end is judged by the fog sub-cells inside its hexes", () => {
    const hexes = (s: RoomState): RoomState => ({ ...s, scenes: Object.fromEntries(Object.entries(s.scenes).map(([id, sc]) => [id, { ...sc, gridShape: "hexRows" as const }])) });
    const fogged = withFog(withStairs(hexes(tower())), GROUND);
    assert.equal(fogged.floorLinks!.l1!.grid, "hexRows");
    for (const viewer of PLAYERS) assert.deepEqual(ends(fogged, viewer), {}, viewer.memberId);
    const shown = structuredClone(fogged);
    reveal(shown, GROUND, { x: 0, y: 0, w: 20, h: 20 });
    for (const viewer of PLAYERS) {
      assert.equal((ends(shown, viewer).l1 as { grid?: string } | undefined)?.grid, "hexRows", `${viewer.memberId} gets the shape it was written under`);
      agrees(shown, viewer, null);
    }
  });

  test("behind a blackout a player and a display get no end, the DM every one", () => {
    const s = opened(withStairs(), UPPER);
    s.meta.view = { ...s.meta.view, blackout: true };
    for (const viewer of PLAYERS) {
      assert.deepEqual(ends(s, viewer), {}, viewer.memberId);
      agrees(s, viewer, null);
    }
    assert.deepEqual(ends(s, DM), s.floorLinks);
  });

  test("the fan-out files an end under its own floor, so a socket that does not hold it is sent nothing before any projection, and a gone end under none", () => {
    const s = withStairs();
    assert.equal(floorOfKey(s, keys.floorLink("l1")), GROUND);
    assert.equal(floorOfKey(s, keys.floorLink("l2")), UPPER);
    assert.equal(floorOfKey(s, keys.floorLink("gone")), null);
  });

  test("a room without stairs projects as before: no field at all", () => {
    const s = tower();
    for (const viewer of [...PLAYERS, DM]) assert.ok(!("floorLinks" in copyOf(s, viewer)), viewer.memberId);
    assert.ok(!allKeys(s).some((key) => key.startsWith("floorLink:")));
  });
});

/*
 * The fan-out's way of keeping a copy (server/rooms/fanout.ts): on a
 * global batch or a change of the floors a viewer holds, every key, else
 * the touched keys and their dependents in both states. Applying the
 * changes to the copy must give the fresh projection.
 */
type Copy = { viewer: Viewer; sceneId: string | null; held: Map<EntityKey, HeldEntry>; view: ProjectedState; floors: string };

const floorsKey = (state: RoomState, c: Pick<Copy, "viewer" | "sceneId">) => [...heldFloors(state, c.viewer, { sceneId: c.sceneId })].sort().join(",");

function connect(state: RoomState, viewer: Viewer, sceneId: string | null = viewer.role === "dm" ? GROUND : null): Copy {
  const view = projectState(state, viewer, { sceneId });
  return { viewer, sceneId, held: heldOf(view), view, floors: floorsKey(state, { viewer, sceneId }) };
}

/** Fields a copy built from changes holds empty where a fresh snapshot leaves them out (keys.ts writeEntity), which read the same. */
function normalized(view: ProjectedState): unknown {
  const out: Record<string, unknown> = { ...view };
  for (const field of ["sounds", "playlists", "openFloors", "holders", "sightAll", "fogAll", "exploredAny", "floorLinks"]) {
    const value = out[field];
    if (value !== undefined && value !== null && typeof value === "object" && Object.keys(value).length === 0) delete out[field];
  }
  if (out.playing === null) delete out.playing;
  return JSON.parse(stableStringify(out));
}

/** Sends each copy what the fan-out would for a batch, and checks it against the fresh projection. */
function publish(copies: readonly Copy[], before: RoomState, after: RoomState, touched: readonly EntityKey[], global: boolean, where: string): void {
  for (const c of copies) {
    const floors = floorsKey(after, c);
    const whole = global || floors !== c.floors;
    c.floors = floors;
    const candidates = whole ? new Set([...allKeys(before), ...allKeys(after)]) : new Set([...touched, ...dependents(before, [...touched], after), ...dependents(after, [...touched], before)]);
    const next = new Map<EntityKey, unknown>();
    for (const key of [...candidates].sort()) next.set(key, projectEntity(key, after, c.viewer, { sceneId: c.sceneId }));
    const diff = diffProjection(c.held, next);
    c.held = diff.held;
    c.view = applyChanges(c.view, diff.changes);
    assert.deepEqual(normalized(c.view), normalized(projectState(after, c.viewer, { sceneId: c.sceneId })), `${where}: ${c.viewer.memberId}'s copy is the fresh projection`);
  }
}

function applyAll(copies: readonly Copy[], state: RoomState, op: Op, who: Viewer, seq: number, where: string): RoomState {
  const r = applyOp(state, opSchema.parse(op), who, env(seq));
  assert.ok(r.ok, `${where}: ${r.ok ? "" : `${r.code}: ${r.message}`}`);
  publish(copies, state, r.state, r.touched, r.global, where);
  return r.state;
}

/** The party exploring a tile, as the server's explore writes it (server/rooms/explore.ts): its key alone, no global batch. */
function explore(copies: readonly Copy[], state: RoomState, sceneId: string, tx: number, ty: number, where: string): RoomState {
  const after = { ...state, exploredTiles: { ...state.exploredTiles, [tileKey(sceneId, tx, ty)]: { sceneId, tx, ty, rev: 1, bits: FULL_TILE_BITS, memberId: "p1" } } };
  publish(copies, state, after, [keys.explored(sceneId, tx, ty)], false, where);
  return after;
}

describe("a copy kept by changes stays the fresh projection (4: what re-projects an end)", () => {
  test("its own key, the party exploring its squares, a level change, a held floor gained and a blackout", () => {
    let s = withFog(owlOn(tower(), ATTIC), GROUND, UPPER);
    const copies = [connect(s, ANA), connect(s, BREE), connect(s, DISPLAY), connect(s, DM)];
    let seq = 900;
    const step = (op: Op, where: string, who: Viewer = DM) => (s = applyAll(copies, s, op, who, seq++, where));
    step(putOp(), "stairs placed under the fog");
    step(putOp({ id: "l3", pairId: "l4", sceneId: UPPER, to: ATTIC, rect: { x: 8, y: 8, w: 1, h: 1 }, kind: "ladder" }), "a ladder placed");
    assert.deepEqual(Object.keys((copies[1]!.view as unknown as RoomState).floorLinks ?? {}), [], "Bree gets nothing under the fog");
    s = explore(copies, s, GROUND, 0, 0, "the party explores Ground floor's corner");
    assert.deepEqual(Object.keys((copies[1]!.view as unknown as RoomState).floorLinks ?? {}), ["l1"], "the explored squares bring the end");
    step({ t: "floor.open", sceneId: UPPER, open: true }, "Upper floor opened");
    s = explore(copies, s, UPPER, 0, 0, "the party explores Upper floor's corner");
    assert.equal((((copies[0]!.view as unknown as RoomState).floorLinks ?? {}).l3 as { to?: string } | undefined)?.to, ATTIC, "Ana holds Attic");
    assert.equal((((copies[1]!.view as unknown as RoomState).floorLinks ?? {}).l3 as { to?: string } | undefined)?.to, undefined, "Bree does not");
    step({ t: "floorLink.update", linkId: "l4", patch: { locked: true } }, "the ladder locked from Attic's end");
    step({ t: "floor.order", sceneId: GROUND, floors: [ATTIC, UPPER, GROUND] }, "the tower turned over");
    step({ t: "floor.order", sceneId: GROUND, floors: [GROUND, UPPER, ATTIC] }, "and back");
    step({ t: "floor.open", sceneId: ATTIC, open: true }, "Attic opened: Bree holds it now");
    assert.equal((((copies[1]!.view as unknown as RoomState).floorLinks ?? {}).l3 as { to?: string } | undefined)?.to, ATTIC);
    step({ t: "floor.open", sceneId: ATTIC, open: false }, "Attic hidden again");
    step({ t: "view.blackout", blackout: true }, "a blackout");
    step({ t: "view.blackout", blackout: false }, "the blackout lifted");
    step({ t: "floorLink.delete", linkId: "l3" }, "the ladder removed");
    step({ t: "scene.delete", sceneId: UPPER }, "Upper floor removed, with the stairs to it");
    assert.deepEqual(s.floorLinks ?? {}, {});
  });

  test("random puts, locks, removals, climbs, reveals, explores, reorders, opened floors and blackouts", () => {
    type Act =
      | { k: "put"; up: boolean; x: number; y: number; w: number; h: number }
      | { k: "lock"; i: number; on: boolean }
      | { k: "remove"; i: number }
      | { k: "climb"; i: number }
      | { k: "explore"; floor: number; tx: number; ty: number }
      | { k: "reveal"; floor: number; x: number; y: number }
      | { k: "order"; turn: number }
      | { k: "open"; floor: number; open: boolean }
      | { k: "blackout"; on: boolean };
    const n = fc.nat({ max: 30 });
    const act: fc.Arbitrary<Act> = fc.oneof(
      { weight: 4, arbitrary: fc.record({ k: fc.constant("put" as const), up: fc.boolean(), x: fc.nat({ max: 16 }), y: fc.nat({ max: 16 }), w: fc.integer({ min: 1, max: 4 }), h: fc.integer({ min: 1, max: 4 }) }) },
      { weight: 1, arbitrary: fc.record({ k: fc.constant("lock" as const), i: n, on: fc.boolean() }) },
      { weight: 1, arbitrary: fc.record({ k: fc.constant("remove" as const), i: n }) },
      { weight: 3, arbitrary: fc.record({ k: fc.constant("climb" as const), i: n }) },
      { weight: 2, arbitrary: fc.record({ k: fc.constant("explore" as const), floor: n, tx: fc.nat({ max: 1 }), ty: fc.nat({ max: 1 }) }) },
      { weight: 2, arbitrary: fc.record({ k: fc.constant("reveal" as const), floor: n, x: fc.nat({ max: 18 }), y: fc.nat({ max: 18 }) }) },
      { weight: 1, arbitrary: fc.record({ k: fc.constant("order" as const), turn: n }) },
      { weight: 1, arbitrary: fc.record({ k: fc.constant("open" as const), floor: n, open: fc.boolean() }) },
      { weight: 1, arbitrary: fc.record({ k: fc.constant("blackout" as const), on: fc.boolean() }) },
    );
    const FLOORS = [GROUND, UPPER, ATTIC];
    let puts = 0;
    let climbs = 0;
    let shown = 0;
    fc.assert(
      fc.property(fc.array(act, { minLength: 5, maxLength: 30 }), (acts) => {
        let s = withFog(owlOn(tower(), ATTIC), GROUND, UPPER, ATTIC);
        // Half of each floor in the open, so ends come and go under the fog's edge.
        for (const id of FLOORS) reveal(s, id, { x: 0, y: 0, w: 10, h: 20 });
        const copies = [connect(s, ANA), connect(s, BREE), connect(s, DISPLAY), connect(s, DM)];
        let seq = 1000;
        let next = 0;
        for (const [i, a] of acts.entries()) {
          const where = `act ${i} (${a.k})`;
          const ids = Object.keys(s.floorLinks ?? {}).sort();
          let op: Op | null = null;
          let who: Viewer = DM;
          switch (a.k) {
            case "put": {
              const thorn = s.tokens.thorn!;
              const at = FLOORS.indexOf(thorn.sceneId);
              const to = FLOORS[a.up ? at + 1 : at - 1];
              if (to === undefined) break;
              op = putOp({ id: `e${next}`, pairId: `e${next + 1}`, sceneId: thorn.sceneId, to, rect: { x: a.x, y: a.y, w: a.w, h: a.h } });
              next += 2;
              break;
            }
            case "lock":
              if (ids.length > 0) op = { t: "floorLink.update", linkId: ids[a.i % ids.length]!, patch: { locked: a.on } };
              break;
            case "remove":
              if (ids.length > 0) op = { t: "floorLink.delete", linkId: ids[a.i % ids.length]! };
              break;
            case "climb": {
              // Onto the end first, then up or down it, as Ana would.
              const here = ids.map((id) => s.floorLinks![id]!).filter((l) => l.sceneId === s.tokens.thorn!.sceneId);
              const link = here[a.i % Math.max(1, here.length)];
              if (!link) break;
              s = applyAll(copies, s, { t: "token.update", tokenId: "thorn", patch: { x: link.rect.x, y: link.rect.y, elevation: link.ground } }, DM, seq++, `${where}: onto ${link.id}`);
              if (link.locked) break;
              op = { t: "token.climb", tokenId: "thorn", linkId: link.id };
              who = ANA;
              break;
            }
            case "explore":
              s = explore(copies, s, FLOORS[a.floor % FLOORS.length]!, a.tx, a.ty, where);
              break;
            case "reveal":
              op = { t: "fog.live", sceneId: FLOORS[a.floor % FLOORS.length]!, ops: [{ id: `r${i}`, mode: "reveal", shape: { kind: "rect", x: a.x, y: a.y, w: 2, h: 2 } }] } as Op;
              break;
            // Upside down or back, which keeps every pair's floors next to each other.
            case "order":
              op = { t: "floor.order", sceneId: GROUND, floors: a.turn % 2 === 0 ? [...FLOORS] : [...FLOORS].reverse() };
              break;
            case "open":
              op = { t: "floor.open", sceneId: FLOORS[a.floor % FLOORS.length]!, open: a.open };
              break;
            case "blackout":
              op = { t: "view.blackout", blackout: a.on };
              break;
          }
          if (op === null) continue;
          const r = applyOp(s, opSchema.parse(op), who, env(seq++));
          if (!r.ok) continue;
          if (op.t === "floorLink.put") puts++;
          if (op.t === "token.climb") climbs++;
          publish(copies, s, r.state, r.touched, r.global, where);
          s = r.state;
          if (Object.keys((copies[1]!.view as unknown as RoomState).floorLinks ?? {}).length > 0) shown++;
        }
      }),
      { numRuns: 200 },
    );
    assert.ok(puts > 200 && climbs > 100 && shown > 300, `${puts} puts, ${climbs} climbs, ${shown} steps where Bree held an end`);
  });
});

/** Thorn's path in a viewer's copy. */
const pathOf = (state: RoomState, viewer: Viewer, id = "thorn"): Token["path"] => copyOf(state, viewer).tokens[id]?.path;

describe("the turn's path after a change of floor (4, 5)", () => {
  test("owners get `prior` whole, everyone else no `prior` while players could count no diagonal", () => {
    let s = onThornsTurn(opened(withStairs(tower(), { rect: { x: 3, y: 8, w: 1, h: 1 } }), UPPER));
    s = run(s, { t: "token.move", tokenId: "thorn", x: 3, y: 8 }, ANA);
    s = run(s, { t: "token.climb", tokenId: "thorn", linkId: "l1" }, ANA);
    const stored = s.tokens.thorn!.path!;
    assert.deepEqual(stored.prior, { moved: 25, cost: 25, seenDiag: [0, 0] });
    assert.deepEqual(pathOf(s, ANA)!.prior, stored.prior);
    for (const viewer of [BREE, DISPLAY]) {
      const path = pathOf(s, viewer)!;
      assert.equal(path.prior, undefined, viewer.memberId);
      assert.equal(path.stops.length, 2, `${viewer.memberId} sees the landing's two stops`);
      assert.ok(path.stops.every((stop) => stop.moved === undefined && stop.cost === undefined), "what the climb took is the owners'");
    }
    agrees(s, BREE, null);
    agrees(s, ANA, null);
  });

  test("with a diagonal every player saw, everyone else gets `seenDiag` alone, the count the server runs on from", () => {
    const fiveTen = tower();
    fiveTen.meta = { ...fiveTen.meta, settings: { ...fiveTen.meta.settings, diagonal: "fiveTen" } };
    let s = onThornsTurn(opened(withStairs(fiveTen, { rect: { x: 4, y: 4, w: 1, h: 1 } }), UPPER));
    s = run(s, { t: "token.move", tokenId: "thorn", x: 4, y: 4 }, ANA);
    s = run(s, { t: "token.climb", tokenId: "thorn", linkId: "l1" }, ANA);
    const prior = s.tokens.thorn!.path!.prior!;
    assert.ok(prior.seenDiag[0] + prior.seenDiag[1] > 0, "players saw the diagonal");
    assert.deepEqual(pathOf(s, ANA)!.prior, prior);
    for (const viewer of [BREE, DISPLAY]) assert.deepEqual(pathOf(s, viewer)!.prior, { seenDiag: prior.seenDiag }, viewer.memberId);
  });

  test("a creature players see whose stops here they saw none of still sends `seenDiag`, with no stops", () => {
    const fiveTen = tower({ tokens: { goblin: token("goblin", { sceneId: GROUND, x: 3, y: 3 }) } });
    fiveTen.meta = { ...fiveTen.meta, settings: { ...fiveTen.meta.settings, diagonal: "fiveTen" } };
    let s = opened(withStairs(fiveTen, { rect: { x: 4, y: 4, w: 1, h: 1 } }), UPPER);
    s = run(run(s, { t: "encounter.start", entries: [{ id: "g", tokenId: "goblin", value: 20 }] }), { t: "encounter.next" });
    s = run(s, { t: "token.move", tokenId: "goblin", x: 4, y: 4 });
    s = run(s, { t: "token.update", tokenId: "goblin", patch: { visibility: "dm" } });
    s = run(s, { t: "token.climb", tokenId: "goblin", linkId: "l1" });
    s = run(s, { t: "token.update", tokenId: "goblin", patch: { visibility: "all" } });
    const stored = s.tokens.goblin!.path!;
    assert.equal(stored.stops.length, 2);
    assert.ok(stored.prior!.seenDiag[0] + stored.prior!.seenDiag[1] > 0);
    for (const viewer of [ANA, BREE, DISPLAY]) {
      assert.ok(copyOf(s, viewer).tokens.goblin, `${viewer.memberId} sees the goblin now`);
      assert.deepEqual(pathOf(s, viewer, "goblin"), { turn: stored.turn, prior: { seenDiag: stored.prior!.seenDiag }, stops: [] }, viewer.memberId);
      agrees(s, viewer, null);
    }
  });

  test("with no seen stop and no diagonal there is no path at all, as before stairs", () => {
    let s = opened(withStairs(tower({ tokens: { goblin: token("goblin", { sceneId: GROUND, x: 3, y: 3 }) } })), UPPER);
    s = run(run(s, { t: "encounter.start", entries: [{ id: "g", tokenId: "goblin", value: 20 }] }), { t: "encounter.next" });
    s = run(s, { t: "token.update", tokenId: "goblin", patch: { visibility: "dm" } });
    s = run(s, { t: "token.climb", tokenId: "goblin", linkId: "l1" });
    s = run(s, { t: "token.update", tokenId: "goblin", patch: { visibility: "all" } });
    assert.ok(s.tokens.goblin!.path, "the DM's copy holds its path");
    for (const viewer of [ANA, BREE, DISPLAY]) assert.equal(pathOf(s, viewer, "goblin"), undefined, viewer.memberId);
  });
});
