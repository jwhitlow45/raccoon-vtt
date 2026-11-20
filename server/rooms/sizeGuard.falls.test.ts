import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { ANA, GROUND, UPPER, applied, fallCard, run, thornToken, tower, trapdoor, withFalls, withOpening, withTrapdoor } from "#shared/floorLinksTestutil.ts";
import { keys } from "#shared/keys.ts";
import { FAR, LIMITS, roundUp, serializedBytes, utf8Bytes } from "#shared/limits.ts";
import { FALL_RIDERS_MOST, type Fall, type RoomState } from "#shared/model.ts";
import { projectState, stableStringify } from "#shared/project.ts";
import { FALL_FEET_MOST, type Op } from "#shared/protocol.ts";
import { floorsOf } from "#shared/rules/floors.ts";
import { DM, actor, token } from "#shared/testutil.ts";
import { FALL_RESERVE, fallsReserved, farRoomBytes, farWidths, growthBound, measuredFromStored, measuredStateBytes, openedMeasure, ownHeldBytes, projectedSceneBytes, roomLevelBytes } from "./sizeGuard.ts";
import { MADE_MOST, parseRoomState } from "./stateSchema.ts";
import { UndoTable } from "./undoTesting.ts";

/*
 * Fall cards in the size measures (docs/design/design-v1-floors.md phase 4,
 * 4.7, D-261119-089): no card counts at its bytes, and FALL_RESERVE, ten
 * cards at their widest, counts while the room may hold one, so a card's
 * creation, eviction, settlement and cleanup move no measure and how many
 * the DM keeps never shows in a player's answer. The reached floors' marks
 * count at their widest too, so a player's own landing writes nothing into
 * their stepped part. O11's and O11b's stepped parts (10.5) are here: a
 * player's fall, its undo and redo read alike whatever cards, passengers
 * and victims the DM keeps hidden.
 */

const WIDE = "\u0001".repeat(64);

/** A card at the stored schema's widest: every id at 64 escaped characters, every rider, the most feet, the newest op a backup may name. */
function widestCard(i: number): Fall {
  const made = MADE_MOST - i;
  return { id: `${made}:${999_999 - i}`, rev: Number.MAX_SAFE_INTEGER, tokenId: WIDE, riders: Array.from({ length: FALL_RIDERS_MOST }, () => WIDE), sceneId: WIDE, from: WIDE, ft: FALL_FEET_MOST, made };
}

const cards = (n: number, from = 20) => Array.from({ length: n }, (_, i) => fallCard({ id: `${from + i}:0`, made: from + i, tokenId: `gone${i}` }));

const bytesOf = (state: RoomState) => utf8Bytes(JSON.stringify(state));

/**
 * A room after one op of the DM's, which writes the marks of the floors
 * played and reached that a fixture leaves out and every live room holds
 * by then, so a test's own ops write only what they write.
 */
const settled = (state: RoomState): RoomState =>
  run(state, { t: "token.create", token: { id: "pad", sceneId: "s2", kind: "npc", layer: "token", name: "Pad", size: "medium", x: 1, y: 1, visibility: "dm", ownerIds: [], actor: { inline: actor() } } } as Op);

describe("D-261119-089: fall cards count at their widest while the room may hold one", () => {
  test("FALL_RESERVE holds ten of the widest cards a stored room may hold, keys and commas with them", () => {
    const base = withOpening(tower());
    const widest = withFalls(base, ...Array.from({ length: LIMITS.fallsPerRoom }, (_, i) => widestCard(i)));
    const parsed = parseRoomState(JSON.parse(JSON.stringify(widest)));
    assert.ok(parsed.ok, parsed.ok ? "" : parsed.message);
    const stored = serializedBytes({ falls: widest.falls }) - 1;
    assert.ok(stored <= FALL_RESERVE, `${stored} stored against ${FALL_RESERVE}`);
    assert.ok(FALL_RESERVE - stored < 1024, `the reserve is the widest cards': ${FALL_RESERVE - stored} bytes to spare`);
  });

  test("the room may hold a card while it has an opening, a trapdoor or a card, and an emptied record holds none", () => {
    assert.equal(fallsReserved(tower()), false);
    assert.equal(fallsReserved(withOpening(tower())), true);
    assert.equal(fallsReserved(withTrapdoor(tower())), true);
    assert.equal(fallsReserved(withFalls(tower(), fallCard())), true);
    assert.equal(fallsReserved({ ...tower(), falls: {} }), false);
    // A pit that drops into a pit, not a floor, is no trapdoor.
    assert.equal(fallsReserved(withTrapdoor(tower(), { ...trapdoor(), rig: { ...trapdoor().rig!, below: undefined, pit: { floor: -10 } } })), false);
  });

  test("the room's measure counts the reserve and no card, whatever the cards hold, an emptied record as none", () => {
    for (const base of [withOpening(tower()), withTrapdoor(tower())]) {
      const measured = measuredStateBytes(base);
      assert.equal(measuredStateBytes(withFalls(base, ...cards(10))), measured, "ten cards");
      assert.equal(measuredStateBytes(withFalls(base, widestCard(0))), measured, "one at its widest");
      assert.equal(measuredStateBytes({ ...base, falls: {} }), measured, "an emptied record");
    }
    // A card the DM's delete of its opening left: the reserve stays with it, and goes with the last card.
    assert.equal(measuredStateBytes(withFalls(tower(), fallCard())) - measuredStateBytes(tower()), FALL_RESERVE);
    assert.equal(measuredStateBytes({ ...tower(), falls: {} }), measuredStateBytes(tower()));
  });

  test("a DM's projection's room-level part counts the reserve in place of the cards", () => {
    const base = withOpening(tower());
    assert.equal(roomLevelBytes(base) - roomLevelBytes(tower()), FALL_RESERVE);
    assert.equal(roomLevelBytes(withFalls(base, ...cards(10))), roomLevelBytes(base));
    assert.ok(stableStringify(projectState(withFalls(base, ...cards(10)), DM, { sceneId: GROUND }).falls ?? {}).length > 2, "the DM's projection holds the cards");
  });

  test("a snapshot measures as the room does, its cards and marks swapped for their widest, an emptied record and a reload alike", () => {
    const marked = (s: RoomState): RoomState => ({ ...s, openFloors: { [UPPER]: { sceneId: UPPER, rev: 1 }, [GROUND]: { sceneId: GROUND, rev: 7 } } });
    const rooms = [tower(), withOpening(tower()), withFalls(withOpening(tower()), ...cards(10)), { ...withOpening(tower()), falls: {} }, withFalls(tower(), fallCard()), marked(tower()), marked(withFalls(withTrapdoor(tower()), widestCard(0)))];
    for (const state of rooms) {
      assert.equal(measuredFromStored(bytesOf(state), state), measuredStateBytes(state));
      const reloaded = JSON.parse(JSON.stringify(state)) as RoomState;
      assert.equal(measuredStateBytes(reloaded), measuredStateBytes(state));
    }
  });

  test("the growth bound counts the reserve where an op turns it on, and never a card's bytes", () => {
    // The DM's first opening turns the reserve on.
    const before = settled(tower());
    const { state: put, touched } = applied(before, { t: "floorLink.put", link: { id: "o1", pairId: "o2", sceneId: UPPER, to: GROUND, rect: { x: 6, y: 6, w: 2, h: 2 }, kind: "opening" } } as Op);
    const grown = growthBound(before, put, touched);
    assert.ok(grown >= FALL_RESERVE && grown >= measuredStateBytes(put) - measuredStateBytes(before), `${grown} bound for ${measuredStateBytes(put) - measuredStateBytes(before)} grown`);
    // A goblin's fall writes a card and evicts the oldest: the bound counts the goblin alone.
    const holed = settled(withFalls(withOpening(tower({ tokens: { gob: token("gob", { sceneId: UPPER, x: 4, y: 6 }) } })), ...cards(10)));
    const fell = run(holed, { t: "token.move", tokenId: "gob", x: 6, y: 6 } as Op);
    assert.equal(fell.tokens.gob!.sceneId, GROUND, "it fell");
    const written = [keys.token("gob"), ...Object.keys(fell.falls ?? {}).map((id) => keys.fall(id)), keys.fall("20:0")];
    assert.equal(growthBound(holed, fell, written), growthBound(holed, fell, [keys.token("gob")]));
    assert.equal(measuredStateBytes(fell) - measuredStateBytes(holed), measuredStateBytes({ ...fell, falls: holed.falls }) - measuredStateBytes(holed), "the card moved nothing");
  });
});

describe("the reached floors' marks count at their widest on every floor", () => {
  test("a floor's mark, written or not, moves no measure, and only a new floor grows them", () => {
    const base = tower();
    const marked: RoomState = { ...base, openFloors: { [UPPER]: { sceneId: UPPER, rev: 1 } } };
    assert.equal(measuredStateBytes(marked), measuredStateBytes(base));
    const stored = serializedBytes({ openFloors: Object.fromEntries(floorsOf(base, GROUND).map((f) => [f.id, { sceneId: f.id, rev: Number.MAX_SAFE_INTEGER }])) }) - 1;
    assert.ok(stored <= openedMeasure(base), `${stored} stored at the widest against ${openedMeasure(base)}`);
    assert.equal(openedMeasure({ ...base, scenes: { s2: base.scenes.s2! } }), 0, "no floor, no mark");
    assert.equal(growthBound(base, marked, [keys.opened(UPPER)]), 0);
    // A DM's new floor grows its mark's width, which the growth bound holds with the floor.
    const before = settled(base);
    const { state: added, touched } = applied(before, { t: "scene.create", scene: { id: "cellar-of-the-tower", name: "Tower", bounds: { w: 20, h: 20 } }, floor: { beside: "at", side: "above" } } as Op);
    assert.ok(openedMeasure(added) > openedMeasure(before), "the new floor's mark counts");
    const grown = measuredStateBytes(added) - measuredStateBytes(before);
    assert.ok(growthBound(before, added, touched) >= grown, `${growthBound(before, added, touched)} bound for ${grown} grown`);
  });

  test("Ana's climb onto a floor the party never reached writes its mark and moves none of her stepped parts", () => {
    const state = run(tower(), { t: "floorLink.put", link: { id: "l1", pairId: "l2", sceneId: GROUND, to: UPPER, rect: { x: 3, y: 3, w: 1, h: 1 }, kind: "stairs" } } as Op);
    assert.equal(state.openFloors?.[UPPER], undefined, "Upper floor is not reached");
    const up = run(state, { t: "token.climb", tokenId: "thorn", linkId: "l1" } as Op, ANA);
    assert.ok(up.openFloors?.[UPPER] !== undefined, "her climb marks it");
    assert.deepEqual(moved(state, up, "p1"), { room: 0, [GROUND]: 0, s2: 0 });
  });
});

// ---------------------------------------------------------------------------
// O11 and O11b: a player's fall, its undo and its redo read alike beside hidden cards, passengers and victims

/** A player's stepped part of the room and of each scene before rounding and the other reserves (sizeGuard.exact.test.ts). */
function steppedParts(state: RoomState, memberId: string): Map<string, number> {
  const out = new Map<string, number>([["room", measuredStateBytes(state) + farWidths(state) - ownHeldBytes(state, memberId).sub]]);
  for (const s of Object.values(state.scenes)) {
    if (s.floor && s.floor.of !== s.id) continue;
    const floors = new Set(floorsOf(state, s.id).map((floor) => floor.id));
    out.set(s.id, projectedSceneBytes(state, s.id) + farWidths(state, floors) - ownHeldBytes(state, memberId, [s.id]).sub);
  }
  return out;
}

function moved(before: RoomState, after: RoomState, memberId: string): Record<string, number> {
  const [b, a] = [steppedParts(before, memberId), steppedParts(after, memberId)];
  return Object.fromEntries([...a].map(([scope, bytes]) => [scope, bytes - (b.get(scope) ?? bytes)]));
}

/** A player's readings at the widest: the room's and each scene's but s2's, which holds the pad, its stepped part rounded up to a step and its exact part added. */
function readings(state: RoomState, memberId: string): Record<string, number> {
  const out: Record<string, number> = { room: farRoomBytes(state, true, measuredStateBytes(state), ownHeldBytes(state, memberId)) };
  for (const [scope, bytes] of steppedParts(state, memberId)) if (scope !== "room" && scope !== "s2") out[scope] = roundUp(bytes, FAR.byteStep) + ownHeldBytes(state, memberId, [scope]).shown;
  return out;
}

/** `state` with a DM's pad on s2 that puts the player's room stepped part `slack` bytes under a step's edge. */
function atTheEdge(state: RoomState, memberId: string, slack = 0): RoomState {
  const base = settled(state);
  const padded = (n: number): RoomState => ({ ...base, tokens: { ...base.tokens, pad: { ...base.tokens.pad!, notes: "p".repeat(n) } } });
  const at = readings(padded(0), memberId).room!;
  let [lo, hi] = [0, FAR.byteStep + 1];
  while (hi - lo > 1) {
    const mid = Math.floor((lo + hi) / 2);
    if (readings(padded(mid), memberId).room === at) lo = mid;
    else hi = mid;
  }
  assert.ok(readings(padded(lo + 1), memberId).room! > at, "one more stored byte reads a step more");
  return padded(lo - slack);
}

const copyOf = (state: RoomState, memberId: string) => stableStringify(projectState(state, { memberId, role: "player" }, { sceneId: null }));
const reload = (state: RoomState): RoomState => JSON.parse(JSON.stringify(state)) as RoomState;

type Step = { op: Op } | "undo" | "redo";

/**
 * Twin rooms apart only in what `who`'s copy leaves out, each at a step's
 * edge but `slack` bytes for the second, take the same steps through the
 * room actor's undo (undoTesting.ts): every step is taken alike, `who`'s
 * copies stay equal, every one of their stepped parts stays where it was
 * and so they read the twins alike before, after each step and after a
 * reload. Their exact parts are equal throughout.
 */
function assertStill(twins: [RoomState, RoomState], memberId: string, steps: readonly Step[], slack = 0): [UndoTable, UndoTable] {
  const who = { memberId, role: "player" as const };
  const [a, b] = [atTheEdge(twins[0], memberId), atTheEdge(twins[1], memberId, slack)];
  assert.equal(copyOf(a, memberId), copyOf(b, memberId), "the copies are equal");
  assert.notEqual(stableStringify(a), stableStringify(b), "the twins are apart");
  const tables = [new UndoTable(a), new UndoTable(b)] as [UndoTable, UndoTable];
  for (const t of tables) t.seq = 5_000;
  assert.deepEqual(readings(a, memberId), readings(b, memberId), "read alike before");
  const exact = (s: RoomState) => ownHeldBytes(s, memberId).shown;
  for (const [i, step] of steps.entries()) {
    const name = `step ${i + 1} (${typeof step === "string" ? step : step.op.t})`;
    const answers = tables.map((t) => {
      const was = t.state;
      const answer = step === "undo" ? t.undo(who) : step === "redo" ? t.redo(who) : t.play(who, step.op);
      return { answer, was, now: t.state };
    });
    assert.equal(answers[0]!.answer, "ok", `${name}: taken`);
    assert.equal(answers[1]!.answer, answers[0]!.answer, `${name}: the same answer`);
    assert.equal(copyOf(answers[0]!.now, memberId), copyOf(answers[1]!.now, memberId), `${name}: the copies are equal`);
    for (const { was, now } of answers) assert.deepEqual(Object.values(moved(was, now, memberId)).filter((bytes) => bytes !== 0), [], `${name}: no stepped part moved`);
    assert.equal(exact(answers[0]!.now), exact(answers[1]!.now), `${name}: the exact parts are equal`);
    assert.deepEqual(readings(answers[0]!.now, memberId), readings(answers[1]!.now, memberId), `${name}: read alike`);
    for (const { now } of answers) assert.deepEqual(readings(reload(now), memberId), readings(now, memberId), `${name}: and after a reload`);
  }
  return tables;
}

/** Ana's fall through the tower's opening, then her undo and redo twice. */
const FALL: readonly Step[] = [{ op: { t: "token.move", tokenId: "thorn", x: 6, y: 6 } as Op }, "undo", "redo", "undo", "redo"];

describe("O11: Ana's falls, undos and redos beside the DM's hidden cards", () => {
  test("no card or ten, the eleventh evicting the oldest, the DM's part apart inside one step: her stepped parts never move and she reads both alike", () => {
    const b = withOpening(tower({ tokens: { thorn: thornToken({ sceneId: UPPER, x: 4, y: 6 }) } }));
    const a = withFalls(b, ...cards(10));
    const [ta, tb] = assertStill([a, b], "p1", FALL, 7);
    assert.equal(Object.keys(ta.state.falls ?? {}).length, 10, "the room holds ten cards at most");
    assert.ok(Object.values(ta.state.falls!).some((c) => c.tokenId === "thorn"), "her card evicted the oldest");
    assert.equal(Object.keys(tb.state.falls ?? {}).length, 1);
  });

  test("the DM's Dismiss, a card's eviction by a monster's fall and the DM's delete of a card's creature move no measure", () => {
    const base = settled(withFalls(withOpening(tower({ tokens: { gob: token("gob", { sceneId: UPPER, x: 4, y: 6 }) } })), ...cards(10)));
    const measured = measuredStateBytes(base);
    const dismissed = run(base, { t: "fall.settle", fallId: "20:0" } as Op);
    assert.equal(dismissed.falls?.["20:0"], undefined);
    assert.equal(measuredStateBytes(dismissed), measured, "a Dismiss");
    const fell = run(base, { t: "token.move", tokenId: "gob", x: 6, y: 6 } as Op);
    assert.equal(measuredStateBytes({ ...fell, tokens: base.tokens }), measured, "an eviction");
    const gone = run(withFalls(fell), { t: "token.delete", tokenId: "gob" } as Op);
    assert.ok(!Object.values(gone.falls ?? {}).some((c) => c.tokenId === "gob"), "its card went with it");
    assert.equal(measuredStateBytes({ ...gone, tokens: base.tokens, falls: base.falls }), measured, "a delete's cleanup");
  });
});

/**
 * A tower whose ground floor's id is long and whose upper floor's is short,
 * so a fall or a drop lengthens every stored floor id it writes, with the
 * opening 2 by 2 at 6, 6 between them, and Kit, Bree's creature, beside it
 * upstairs. Both floors are reached and players have no vision rules here.
 */
const LONG = "ground-floor-of-the-long-tower";
const SHORT = "u";
function longTower(): RoomState {
  const t = tower();
  const floor = (id: string, level: number, name: string) => ({ ...t.scenes[GROUND]!, id, name: "Tower", floor: { of: LONG, level, name, height: 10 } });
  const state: RoomState = {
    ...t,
    scenes: { [LONG]: floor(LONG, 0, "Ground floor"), [SHORT]: floor(SHORT, 1, "Upper floor"), s2: t.scenes.s2! },
    meta: { ...t.meta, playerSceneId: LONG },
    characters: { ...t.characters, kit: { ...t.characters.thorn!, id: "kit", name: "Kit", ownerIds: ["p2"] } },
    tokens: { kit: thornToken({ id: "kit", name: "Kit", ownerIds: ["p2"], actor: { ref: "kit" }, sceneId: SHORT, x: 4, y: 6, rev: 9 }) },
    openFloors: { [LONG]: { sceneId: LONG, rev: 1 }, [SHORT]: { sceneId: SHORT, rev: 1 } },
  };
  return withOpening(state, { upper: SHORT, lower: LONG });
}

/** What the DM hides around Kit, each a twin's dimension of O11b. */
const hiddenNear = (s: RoomState, at: { x: number; y: number }, over: { nudge?: true; path?: number; rev?: number; link?: "perch" | "drag" } = {}) => {
  const id = `h${Object.keys(s.tokens).length}`;
  s.tokens[id] = token(id, {
    kind: "pc",
    size: "tiny",
    visibility: "dm",
    sceneId: SHORT,
    x: at.x,
    y: at.y,
    rev: 9,
    ...(over.link ? { attached: { to: "kit", kind: over.link } } : {}),
    ...(over.nudge ? { nudge: { x: 0.25, y: -0.25 } } : {}),
    ...(over.path ? { path: { turn: 1, stops: Array.from({ length: over.path }, (_, i) => ({ x: i, y: i, elevation: 0 })) } } : {}),
  });
  s.templates[`${id}a`] = { id: `${id}a`, rev: over.rev ?? 8, sceneId: SHORT, shape: "emanation", size: 10, origin: { x: at.x + 0.5, y: at.y + 0.5, z: 0 }, yaw: 0, includeOrigin: false, color: "#ff0000", ownerId: "dm1", visibility: "dm", attachedTo: id };
  return s;
};

describe("O11b: a public fall and a public trapdoor drop beside hidden passengers and victims", () => {
  test("Kit's fall with no hidden passenger, one, or several with their areas, a dragged one let go, nudges and old walks: Bree's parts never move", () => {
    const none = longTower();
    const one = hiddenNear(structuredClone(none), { x: 4, y: 6 }, { link: "perch", rev: 8 });
    const several = hiddenNear(hiddenNear(hiddenNear(structuredClone(none), { x: 4, y: 6 }, { link: "perch", rev: 9, nudge: true }), { x: 3, y: 6 }, { link: "drag", path: 4 }), { x: 4, y: 6 }, { link: "perch", path: 12, rev: 99 });
    const walk: Step = { op: { t: "token.move", tokenId: "kit", x: 6, y: 6 } as Op };
    for (const twin of [one, several]) assertStill([none, twin], "p2", [walk, "undo", "redo", "undo", "redo"]);
    const fell = run(several, walk.op, { memberId: "p2", role: "player" });
    assert.deepEqual(["kit", "h1", "h3"].map((id) => fell.tokens[id]!.sceneId), [LONG, LONG, LONG], "Kit fell with her riders");
    assert.equal(fell.tokens.h2!.attached, undefined, "the dragged one was let go");
    assert.ok(Object.values(fell.falls ?? {}).some((c) => c.tokenId === "kit" && (c.riders ?? []).length === 2), "her card names the hidden riders");
  });

  test("Bree's own content swept across the step's edge: she reads Kit's fall alike with and without hidden riders at every length", () => {
    const none = longTower();
    const ridden = hiddenNear(structuredClone(none), { x: 4, y: 6 }, { link: "perch" });
    const [a, b] = [atTheEdge(none, "p2"), atTheEdge(ridden, "p2")];
    const walk = { t: "token.move", tokenId: "kit", x: 6, y: 6 } as Op;
    const bree = { memberId: "p2", role: "player" as const };
    for (let extra = -4; extra <= 4; extra++) {
      const notes = (s: RoomState): RoomState => ({ ...s, characters: { ...s.characters, kit: { ...s.characters.kit!, actor: { ...s.characters.kit!.actor, notes: "n".repeat(200 + extra) } } } });
      const [na, nb] = [notes(a), notes(b)];
      assert.deepEqual(readings(na, "p2"), readings(nb, "p2"), `${extra}: before`);
      const [fa, fb] = [run(na, walk, bree), run(nb, walk, bree)];
      assert.deepEqual(readings(fa, "p2"), readings(fb, "p2"), `${extra}: after the fall`);
    }
  });

  test("Kit's walk past a trapdoor drops no hidden goblin, one, or several with their areas onto the ground floor: Bree's parts never move", () => {
    const base = longTower();
    base.traps = { td1: trapdoor("td1", { sceneId: SHORT, zone: { cells: [{ x: 10, y: 6, w: 2, h: 2 }] }, rig: { ...trapdoor().rig!, stops: false, foundOnSpring: false } }) };
    base.tokens.kit = { ...base.tokens.kit!, x: 8, y: 6 };
    const one = hiddenNear(structuredClone(base), { x: 10, y: 6 });
    const several = hiddenNear(hiddenNear(hiddenNear(structuredClone(base), { x: 10, y: 6 }, { path: 6 }), { x: 11, y: 7 }, { nudge: true, rev: 99 }), { x: 10, y: 7 });
    const walk: Step = { op: { t: "token.move", tokenId: "kit", x: 13, y: 6, route: [[10, 6, 0, 0], [13, 6, 0, 0]] } as Op };
    for (const twin of [one, several]) assertStill([base, twin], "p2", [walk, "undo", "redo"]);
    const dropped = run(several, walk.op, { memberId: "p2", role: "player" });
    assert.deepEqual(["h1", "h2", "h3"].map((id) => dropped.tokens[id]!.sceneId), [LONG, LONG, LONG], "every hidden goblin dropped");
    assert.equal(dropped.tokens.kit!.sceneId, SHORT, "Kit walked on");
  });
});
