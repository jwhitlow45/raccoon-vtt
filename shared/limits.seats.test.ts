import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { opKind } from "./farLine.ts";
import { FAR, LIMITS, SEAT, SEAT_FULL, admitLimits, farLimits, seatCheck, seatCounts, seatHeld, seatWork, serializedBytes, type LimitSender } from "./limits.ts";
import type { RoomState } from "./model.ts";
import { seatView } from "./project.ts";
import type { Op } from "./protocol.ts";
import { castAsk, character, companionBlock, drawing, entry, rng, room, scene, template, token } from "./testutil.ts";

const P1: LimitSender = { role: "player", memberId: "p1", viewOf: (state) => seatView(state, "p1") };
const DM: LimitSender = { role: "dm" };
const CREATE = { far: "meets", seats: true } as const;

/** A room where p1 plays Hero (c1) with a token on s1. */
function table(overrides: Partial<RoomState> = {}): RoomState {
  return room({
    characters: { c1: character("c1", { ownerIds: ["p1"] }) },
    tokens: { hero: token("hero", { kind: "pc", actor: { ref: "c1" }, ownerIds: ["p1"], x: 2, y: 2 }) },
    ...overrides,
  });
}

/** The table with s1 as the Keep's ground floor and `up` as its Upper floor. */
function keep(): RoomState {
  return table({ scenes: { s1: scene("s1", { floor: { of: "s1", level: 0, name: "Ground" } }), up: scene("up", { order: 1, floor: { of: "s1", level: 1, name: "Upper" } }), s2: scene("s2", { order: 2 }) } });
}

/** An index as fixed-width digits, so ids sort by it. */
function pad(i: number): string {
  return String(i).padStart(5, "0");
}

function companions(state: RoomState, count: number, sceneId = "s1", from = 0): void {
  for (let i = from; i < from + count; i++) state.tokens[`k${String(i).padStart(3, "0")}`] = token(`k${String(i).padStart(3, "0")}`, { sceneId, companion: { of: "c1", turn: "own" }, ownerIds: ["p1"], x: 1 + (i % 30), y: 1 + Math.floor(i / 30) });
}

function withAdded(state: RoomState, add: (s: RoomState) => void): RoomState {
  const next = structuredClone(state);
  add(next);
  return next;
}

describe("seats", () => {
  test("each seat refuses one more with its own words, and takes it again once one is removed", () => {
    const cases: { seat: keyof typeof SEAT; fill: (s: RoomState, n: number) => void }[] = [
      { seat: "tokens", fill: (s, n) => companions(s, n - 1) },
      { seat: "ridingAreas", fill: (s, n) => { for (let i = 0; i < n; i++) s.templates[`r${i}`] = template(`r${i}`, { attachedTo: "hero" }); } },
      { seat: "freeAreas", fill: (s, n) => { for (let i = 0; i < n; i++) s.templates[`f${i}`] = template(`f${i}`); } },
      { seat: "drawings", fill: (s, n) => { for (let i = 0; i < n; i++) s.drawings[`d${i}`] = drawing(`d${i}`); } },
      { seat: "pointValues", fill: (s, n) => { for (let i = 0; i < n / 2_000; i++) s.drawings[`d${i}`] = drawing(`d${i}`, { points: new Array(2_000).fill(1) }); } },
      { seat: "rows", fill: (s, n) => { s.encounter = { rev: 0, round: 1, activeEntryId: null, entries: Array.from({ length: n }, (_, i) => entry(`e${String(i).padStart(3, "0")}`, { characterId: "c1", tieOrder: i })) }; } },
    ];
    for (const { seat, fill } of cases) {
      const full = table();
      fill(full, SEAT[seat]);
      assert.equal(seatCounts(full, "p1", "s1", seatView(full, "p1"))[seat], SEAT[seat], seat);
      const one = withAdded(full, (s) => {
        if (seat === "tokens") companions(s, 1, "s1", 900);
        else if (seat === "ridingAreas") s.templates.zz = template("zz", { attachedTo: "hero" });
        else if (seat === "freeAreas") s.templates.zz = template("zz");
        else if (seat === "drawings") s.drawings.zz = drawing("zz");
        else if (seat === "pointValues") s.drawings.zz = drawing("zz", { points: [0, 0] });
        else s.encounter!.entries.push(entry("zz", { characterId: "c1" }));
      });
      assert.deepEqual(admitLimits(one, "s1", full, P1, CREATE), { ok: false, code: "quota", message: SEAT_FULL[seat] }, seat);
      const freed = withAdded(full, (s) => {
        if (seat === "tokens") delete s.tokens.k000;
        else if (seat === "ridingAreas") delete s.templates.r0;
        else if (seat === "freeAreas") delete s.templates.f0;
        else if (seat === "drawings" || seat === "pointValues") delete s.drawings.d0;
        else s.encounter!.entries.shift();
      });
      const again = withAdded(one, (s) => {
        if (seat === "tokens") delete s.tokens.k000;
        else if (seat === "ridingAreas") delete s.templates.r0;
        else if (seat === "freeAreas") delete s.templates.f0;
        else if (seat === "drawings" || seat === "pointValues") delete s.drawings.d0;
        else s.encounter!.entries.shift();
      });
      assert.deepEqual(admitLimits(again, "s1", freed, P1, CREATE), { ok: true }, `${seat} after one is removed`);
    }
  });

  test("the token seat counts the scene's floors together, so the 34th is refused on whichever floor it is made", () => {
    const state = table({ scenes: { s1: scene("s1", { floor: { of: "s1", level: 0, name: "Ground" } }), up: scene("up", { order: 1, floor: { of: "s1", level: 1, name: "Upper" } }), s2: scene("s2", { order: 2 }) } });
    companions(state, 20, "s1");
    companions(state, 12, "up", 20);
    const before = structuredClone(state);
    companions(state, 1, "up", 900);
    const counts = seatCounts(state, "p1", "up", seatView(state, "p1"));
    assert.equal(counts.tokens, SEAT.tokens + 1);
    assert.equal(seatCheck(before, state, "p1", "up", (s) => seatView(s, "p1")).ok, false);
    assert.equal(seatCheck(before, state, "p1", "s1", (s) => seatView(s, "p1")).ok, false, "and from the floor below");
  });

  test("a creature the DM lends is no seat's", () => {
    const state = table();
    for (let i = 0; i < 35; i++) state.tokens[`m${i}`] = token(`m${i}`, { ownerIds: ["p1"] });
    assert.equal(seatCounts(state, "p1", "s1", seatView(state, "p1")).tokens, 1);
    const more = withAdded(state, (s) => companions(s, 1));
    assert.deepEqual(admitLimits(more, "s1", state, P1, CREATE), { ok: true });
  });

  test("an area on a creature its owner cannot see counts in no seat, and a hidden drawing counts in none", () => {
    const state = table({ tokens: { hero: token("hero", { kind: "pc", actor: { ref: "c1" }, ownerIds: ["p1"] }), orc: token("orc", { visibility: "dm" }) } });
    state.templates.on = template("on", { attachedTo: "orc" });
    state.drawings.kept = drawing("kept", { visibility: "dm" });
    const counts = seatCounts(state, "p1", "s1", seatView(state, "p1"));
    assert.equal(counts.ridingAreas, 0);
    assert.equal(counts.drawings, 0);
    const dark: RoomState = { ...state, meta: { ...state.meta, view: { ...state.meta.view, blackout: true } } };
    assert.equal(seatCounts(dark, "p1", "s1", seatView(dark, "p1")).tokens, 0, "behind a blackout the copy holds no creature");
  });

  test("a member over a seat by the DM's doing is refused only an op that raises it", () => {
    const state = table();
    companions(state, SEAT.tokens + 4);
    const moved = withAdded(state, (s) => { s.tokens.k000!.x = 9; });
    assert.deepEqual(admitLimits(moved, "s1", state, P1, CREATE), { ok: true });
    const removed = withAdded(state, (s) => { delete s.tokens.k000; });
    assert.deepEqual(admitLimits(removed, "s1", state, P1, CREATE), { ok: true });
  });

  test("moves are bookkeeping and meet no seat, while creates, restores and an area's attach do", () => {
    const kinds = (op: Op) => opKind(op);
    assert.deepEqual(kinds({ t: "token.move", tokenId: "hero", x: 1, y: 1 }), { far: "exempt", seats: false });
    assert.deepEqual(kinds({ t: "token.climb", tokenId: "hero", linkId: "l1" }), { far: "exempt", seats: false });
    assert.deepEqual(kinds({ t: "template.update", templateId: "a", patch: { attachedTo: "hero" } } as Op), { far: "meets", seats: true });
    assert.deepEqual(kinds({ t: "template.update", templateId: "a", patch: { origin: { x: 1, y: 1, z: 0 } } }), { far: "exempt", seats: true });
    assert.deepEqual(kinds({ t: "drawing.clear", sceneId: "s1", scope: "own" }), { far: "deletion", seats: false });
    assert.deepEqual(opKind({ t: "undo" } as Op, true), { far: "exempt", seats: true });
    assert.deepEqual(opKind({ t: "undo" } as Op), { far: "meets", seats: true });
  });

  test("a player's op never meets the room caps the DM's things fill", () => {
    const state = table();
    for (let i = 0; i < LIMITS.templatesPerScene; i++) state.templates[`dm${i}`] = template(`dm${i}`, { ownerId: "dm1", visibility: "dm" });
    const more = withAdded(state, (s) => { s.templates.mine = template("mine"); });
    assert.deepEqual(admitLimits(more, "s1", state, P1, CREATE), { ok: true });
    assert.equal(admitLimits(withAdded(state, (s) => { s.templates.dmx = template("dmx", { ownerId: "dm1" }); }), "s1", state, DM, CREATE).ok, false);
  });
});

describe("the DM's caps over the rest", () => {
  test("seat-held things leave the DM's caps, and a DM op that adds nothing passes past them", () => {
    const state = table();
    companions(state, SEAT.tokens - 1);
    for (let i = 0; i < LIMITS.tokensPerScene; i++) state.tokens[`g${String(i).padStart(3, "0")}`] = token(`g${String(i).padStart(3, "0")}`);
    assert.equal(seatHeld(state, "s1").tokens.size, SEAT.tokens);
    const past = withAdded(state, (s) => { s.tokens.old = token("old"); });
    const hidden = withAdded(past, (s) => { s.tokens.g000!.visibility = "dm"; });
    assert.deepEqual(admitLimits(hidden, "s1", past, DM, CREATE), { ok: true }, "a hide adds nothing, even past the cap");
    const one = withAdded(state, (s) => { s.tokens.zz = token("zz"); });
    assert.equal(admitLimits(one, "s1", state, DM, CREATE).ok, false, "the 501st of the DM's own");
    const deleted = withAdded(one, (s) => { delete s.tokens.g001; });
    assert.deepEqual(admitLimits(deleted, "s1", one, DM, { far: "deletion", seats: false }), { ok: true });
  });

  test("LP43-LIMITS-1: a player's free areas on another floor of the scene leave the DM all 200 of theirs on this one", () => {
    const state = keep();
    for (let i = 0; i < 31; i++) state.templates[`pu${pad(i)}`] = template(`pu${pad(i)}`, { sceneId: "up" });
    for (let i = 0; i < LIMITS.templatesPerScene - 1; i++) state.templates[`dm${pad(i)}`] = template(`dm${pad(i)}`, { ownerId: "dm1", visibility: "dm" });
    assert.equal(seatHeld(state, "s1").templates.size, 31, "the free areas on Upper are held from the ground floor");
    const last = withAdded(state, (s) => { s.templates.dmz = template("dmz", { ownerId: "dm1", visibility: "dm" }); });
    assert.deepEqual(admitLimits(last, "s1", state, DM, CREATE), { ok: true }, "the DM's 200th");
    const past = withAdded(last, (s) => { s.templates.dmzz = template("dmzz", { ownerId: "dm1", visibility: "dm" }); });
    assert.equal(admitLimits(past, "s1", last, DM, CREATE).ok, false, "the DM's 201st");
    // Each floor holds 40 of the member's: the 41st on Upper is the DM's rest, so the DM's 200th passes the cap.
    const upper = withAdded(state, (s) => { for (let i = 31; i <= SEAT.freeAreas; i++) s.templates[`pu${pad(i)}`] = template(`pu${pad(i)}`, { sceneId: "up" }); });
    assert.equal(seatHeld(upper, "up").templates.size, SEAT.freeAreas);
    assert.equal(admitLimits(withAdded(upper, (s) => { s.templates.dmz = template("dmz", { ownerId: "dm1", visibility: "dm" }); }), "s1", upper, DM, CREATE).ok, false, "one past the seat on Upper is the DM's");
    // A seat for each floor, not one 40 for the scene: 31 upstairs and 18 on the ground are all held.
    const both = withAdded(state, (s) => { for (let i = 0; i < 18; i++) s.templates[`pg${pad(i)}`] = template(`pg${pad(i)}`); });
    assert.equal(seatHeld(both, "s1").templates.size, 49);
    assert.deepEqual(admitLimits(withAdded(both, (s) => { s.templates.dmz = template("dmz", { ownerId: "dm1", visibility: "dm" }); }), "s1", both, DM, CREATE), { ok: true }, "the DM's 200th beside both floors' areas");
  });

  test("a thing several players own is held by its first owner by id", () => {
    const state = table({ characters: { c1: character("c1", { ownerIds: ["p2", "p1"] }) } });
    const held = seatHeld(state, "s1");
    assert.ok(held.tokens.has("hero"));
  });

  test("a seat past its number holds its member's first things by id, whatever order the room holds them in", () => {
    const state = table();
    for (let i = SEAT.tokens + 5; i >= 0; i--) state.tokens[`k${pad(i)}`] = token(`k${pad(i)}`, { companion: { of: "c1", turn: "own" }, ownerIds: ["p1"], x: 1 + (i % 30), y: 1 });
    const byId = ["hero", ...Array.from({ length: SEAT.tokens + 6 }, (_, i) => `k${pad(i)}`)].sort();
    assert.deepEqual([...seatHeld(state, "s1").tokens], byId.slice(0, SEAT.tokens));
  });

  test("the seats put every thing in id order, whoever owns it: the DM's hidden areas or a player's, and hidden creatures with a character or none, make as many comparisons", () => {
    // One shuffle for every twin, so only who owns the things and what they are differ.
    const r = rng(9);
    const order = Array.from({ length: 150 }, (_, i) => i).sort(() => r() - 0.5);
    const compared = (fill: (state: RoomState, i: number) => void) => {
      const state = table();
      for (const i of order) fill(state, i);
      const was = { ...seatWork };
      seatHeld(state, "s1");
      return { compared: seatWork.compared - was.compared, read: seatWork.read - was.read };
    };
    const areas = (["dm1", "p2"] as const).map((ownerId) => compared((s, i) => { s.templates[`t${pad(i)}`] = template(`t${pad(i)}`, { ownerId, visibility: "dm" }); }));
    assert.ok(areas[0]!.compared > 0 && areas[0]!.read > 0);
    assert.deepEqual(areas[1], areas[0], "the DM's areas or P2's");
    const creatures = [false, true].map((theirs) => compared((s, i) => { s.tokens[`m${pad(i)}`] = token(`m${pad(i)}`, { visibility: "dm", ...(theirs ? { companion: { of: "c1", turn: "own" as const } } : {}) }); }));
    assert.ok(creatures[0]!.compared > 0 && creatures[0]!.read > 0);
    assert.deepEqual(creatures[1], creatures[0], "hidden creatures with a character's companionship or none");
  });

  test("the DM's token cap counts the creatures on every floor of the scene, from whichever floor it is met", () => {
    const state = keep();
    for (let i = 0; i < 300; i++) state.tokens[`g${pad(i)}`] = token(`g${pad(i)}`);
    for (let i = 300; i < LIMITS.tokensPerScene; i++) state.tokens[`g${pad(i)}`] = token(`g${pad(i)}`, { sceneId: "up" });
    for (const floor of ["s1", "up"]) {
      const past = withAdded(state, (s) => { s.tokens.gz = token("gz", { sceneId: floor }); });
      assert.equal(admitLimits(past, floor, state, DM, CREATE).ok, false, `the DM's 501st across the floors, on ${floor}`);
    }
    const elsewhere = withAdded(state, (s) => { s.tokens.gz = token("gz", { sceneId: "s2" }); });
    assert.deepEqual(admitLimits(elsewhere, "s2", state, DM, CREATE), { ok: true }, "another scene's first");
  });
});

describe("the far line", () => {
  test("reads the DM's part in steps of 50 and the players' part exactly", () => {
    // P1's rows on top of the DM's: within one step of the DM's part every count answers alike, the next step answers apart.
    const answers = (dmRows: number) => {
      const state = table();
      state.encounter = { rev: 0, round: 1, activeEntryId: null, entries: [] };
      for (let i = 0; i < dmRows; i++) state.encounter.entries.push(entry(`d${String(i).padStart(4, "0")}`, { label: "x" }));
      const out: boolean[] = [];
      for (let i = 0; i < SEAT.rows; i++) {
        const before = structuredClone(state);
        state.encounter.entries.push(entry(`p${String(i).padStart(2, "0")}`, { characterId: "c1" }));
        out.push(farLimits(state, null, before).ok);
      }
      return out;
    };
    const low = answers(FAR.rows - 2 * FAR.countStep + 1);
    assert.deepEqual(answers(FAR.rows - FAR.countStep), low, "the same step");
    assert.ok(low.every(Boolean), "every row fits under the line");
    const next = answers(FAR.rows - FAR.countStep + 1);
    assert.notDeepEqual(next, low, "the next step");
    assert.equal(next.filter(Boolean).length, 0, "at the line the first row is refused");
  });

  test("the DM keeps the room's 20 asks beside every seat full", () => {
    const state = table();
    const members = Object.fromEntries(Array.from({ length: LIMITS.membersPerRoom }, (_, i) => [`m${String(i).padStart(2, "0")}`, { id: `m${String(i).padStart(2, "0")}`, rev: 0, name: "m", color: "#ff0000", kind: "player" as const, createdAt: "2026-10-12T20:00:00.000Z" }]));
    state.members = members;
    state.casts = {};
    let n = 0;
    const next = () => `c${String(n++).padStart(5, "0")}`;
    for (const id of Object.keys(members)) for (let i = 0; i < 24; i++) {
      const key = next();
      state.casts[key] = { id: key, rev: 0, by: id, caster: "hero", sceneId: "s1", spell: "x", targets: ["hero"], at: "2026-10-12T20:00:00.000Z" };
    }
    const before = structuredClone(state);
    for (let i = 0; i < LIMITS.openCastsPerRoom; i++) state.casts[`z${i}`] = { id: `z${i}`, rev: 0, by: "dm1", caster: "hero", sceneId: "s1", spell: "x", targets: ["hero"], at: "2026-10-12T20:00:00.000Z" };
    assert.deepEqual(farLimits(state, null, before), { ok: true });
  });

  test("LP43-LIMITS-1: a player's own free areas on another floor they hold count exactly, not in the part the line rounds up", () => {
    // The rest a whole number of steps and the player's own part exact, so the reading after their op is the line. Their
    // companion upstairs means they hold Upper, so their copy holds their areas there.
    const state = keep();
    companions(state, 1, "up", 900);
    for (let i = 0; i < 31; i++) state.templates[`pu${pad(i)}`] = template(`pu${pad(i)}`, { sceneId: "up" });
    for (let i = 0; i < 18; i++) state.templates[`pg${pad(i)}`] = template(`pg${pad(i)}`);
    const dmPart = FAR.areas - FAR.countStep;
    for (let i = 0; i < dmPart; i++) state.templates[`dm${pad(i)}`] = template(`dm${pad(i)}`, { ownerId: "dm1", visibility: "dm" });
    assert.equal(dmPart + 31 + 19, FAR.areas, "the reading after the op is the line");
    const one = withAdded(state, (s) => { s.templates.pgz = template("pgz"); });
    assert.deepEqual(admitLimits(one, "s1", state, P1, CREATE), { ok: true }, "the player's 19th on the ground floor");
    const more = withAdded(one, (s) => { s.templates.pgzz = template("pgzz"); });
    assert.equal(admitLimits(more, "s1", one, P1, CREATE).ok, false, "and the next passes the line");
  });

  test("an import is held to it absolutely", () => {
    const state = table();
    state.encounter = { rev: 0, round: 1, activeEntryId: null, entries: Array.from({ length: FAR.rows + 1 }, (_, i) => entry(`d${i}`, { label: "x" })) };
    assert.equal(farLimits(state, null).ok, false);
  });
});

/** A room's collections as new objects, as an op leaves them, so nothing read from the last state is taken for this one. */
function fresh(state: RoomState): RoomState {
  return { ...state, tokens: { ...state.tokens }, templates: { ...state.templates }, drawings: { ...state.drawings }, casts: { ...state.casts }, encounter: state.encounter ? { ...state.encounter, entries: [...state.encounter.entries] } : null };
}

/**
 * P1's create in twin rooms that differ only in whose one thing P1 cannot
 * see is, P2's or the DM's, at every fill from `from` to `to` of the DM's
 * hidden things of its class. The window holds the far count's line and a
 * whole step below it, so the DM's part meets every place in its step.
 */
function twinAnswers(build: (owner: "p2" | "dm1") => RoomState, fill: (s: RoomState, i: number) => void, create: (s: RoomState) => void, [from, to]: [number, number]): Array<[boolean, boolean]> {
  const rooms = (["p2", "dm1"] as const).map((owner) => {
    const state = build(owner);
    for (let i = 0; i < from; i++) fill(state, i);
    return state;
  });
  const out: Array<[boolean, boolean]> = [];
  for (let i = from; i < to; i++) {
    const [a, b] = rooms.map((state) => {
      fill(state, i);
      const after = fresh(state);
      create(after);
      return admitLimits(after, "s1", fresh(state), P1, CREATE).ok;
    });
    out.push([a!, b!]);
  }
  return out;
}

/** The twins answer alike at every fill, and the window meets the line: the first create taken, the last refused. */
function assertTwinsAlike(answers: Array<[boolean, boolean]>, what: string): void {
  const apart = answers.findIndex(([a, b]) => a !== b);
  assert.equal(apart, -1, `${what}: the twins answer apart ${apart} into the window`);
  assert.ok(answers[0]![0] && !answers.at(-1)![0], `${what}: the window holds the line`);
}

describe("LP43-PRIV-1: a player's far counts never read whose an unseen thing is", () => {
  /** The fills around `line` for a room that holds `base` of the class besides the DM's fill and P1's create. */
  const around = (line: number, base: number): [number, number] => [line - base - FAR.countStep - 2, line - base + 1];
  const withP2Upstairs = (state: RoomState) => {
    state.characters = { ...state.characters, c2: character("c2", { ownerIds: ["p2"] }) };
    state.tokens.p2up = token("p2up", { kind: "pc", sceneId: "up", actor: { ref: "c2" }, ownerIds: ["p2"] });
    return state;
  };
  const dmArea = (s: RoomState, i: number) => (s.templates[`dm${pad(i)}`] = template(`dm${pad(i)}`, { ownerId: "dm1", visibility: "dm" }));
  const p1Area = (s: RoomState) => (s.templates.pz = template("pz"));

  test("an area on an upper floor P1 has never held, P2's or the DM's", () => {
    const build = (owner: "p2" | "dm1") => {
      const state = keep();
      state.templates.zup = template("zup", { sceneId: "up", ownerId: owner });
      return state;
    };
    assertTwinsAlike(twinAnswers(build, dmArea, p1Area, around(FAR.areas, 1)), "a free area");
  });

  test("an area riding P2's creature upstairs, P2's or the DM's", () => {
    const build = (owner: "p2" | "dm1") => {
      const state = withP2Upstairs(keep());
      state.templates.zup = template("zup", { sceneId: "up", ownerId: owner, attachedTo: "p2up" });
      return state;
    };
    assertTwinsAlike(twinAnswers(build, dmArea, p1Area, around(FAR.areas, 1)), "a riding area");
  });

  test("a token upstairs, P2's companion or the DM's creature", () => {
    const build = (owner: "p2" | "dm1") => {
      const state = withP2Upstairs(keep());
      state.tokens.zup = owner === "p2" ? token("zup", { sceneId: "up", companion: { of: "c2", turn: "own" }, ownerIds: ["p2"] }) : token("zup", { sceneId: "up" });
      return state;
    };
    const dmToken = (s: RoomState, i: number) => (s.tokens[`dm${pad(i)}`] = token(`dm${pad(i)}`, { visibility: "dm", x: 30, y: 20 }));
    assertTwinsAlike(twinAnswers(build, dmToken, (s) => companions(s, 1, "s1", 900), around(FAR.tokens, 3)), "a token");
  });

  test("a drawing the DM hid on P1's floor, P2's or the DM's", () => {
    const build = (owner: "p2" | "dm1") => {
      const state = keep();
      state.drawings.zhid = drawing("zhid", { ownerId: owner, visibility: "dm" });
      return state;
    };
    const dmDrawing = (s: RoomState, i: number) => (s.drawings[`dm${pad(i)}`] = drawing(`dm${pad(i)}`, { ownerId: "dm1", visibility: "dm" }));
    assertTwinsAlike(twinAnswers(build, dmDrawing, (s) => (s.drawings.pz = drawing("pz")), around(FAR.drawings, 1)), "a drawing");
  });

  test("a hidden row of a hidden creature, P2's or the DM's", () => {
    const build = (owner: "p2" | "dm1") => {
      const state = keep();
      state.tokens.zhid = token("zhid", { visibility: "dm", ownerIds: owner === "p2" ? ["p2"] : [] });
      state.encounter = { rev: 0, round: 1, activeEntryId: null, entries: [entry("zrow", { tokenId: "zhid", hidden: true })] };
      return state;
    };
    const dmRow = (s: RoomState, i: number) => s.encounter!.entries.push(entry(`dm${pad(i)}`, { label: "Goblin", hidden: true }));
    assertTwinsAlike(twinAnswers(build, dmRow, (s) => s.encounter!.entries.push(entry("pz", { characterId: "c1" })), around(FAR.rows, 1)), "a row");
  });

  test("an ask upstairs for P2's creature, P2's or the DM's", () => {
    const build = (owner: "p2" | "dm1") => {
      const state = withP2Upstairs(keep());
      state.casts = { zask: castAsk("zask", { by: owner, caster: "p2up", sceneId: "up", area: undefined, targets: ["p2up"] }) };
      return state;
    };
    const dmAsk = (s: RoomState, i: number) => (s.casts[`dm${pad(i)}`] = castAsk(`dm${pad(i)}`, { by: "dm1", caster: "hero", area: undefined, targets: ["hero"] }));
    assertTwinsAlike(twinAnswers(build, dmAsk, (s) => (s.casts.pz = castAsk("pz", { by: "p1", caster: "hero", area: undefined, targets: ["hero"] })), around(FAR.asks, 1)), "an ask");
  });
});

describe("LP43-PRIV-3: behind a blackout P1's copy holds none of their own things, so P1's own and the DM's answer alike", () => {
  // The twins differ in whose one thing is, P1's or the DM's. While the DM blacks the table out P1's copy holds
  // neither, on a scene without floors too, so neither is in P1's exact part.
  const dark = (state: RoomState): RoomState => ({ ...state, meta: { ...state.meta, view: { follow: false, blackout: true } } });
  const around = (line: number, base: number): [number, number] => [line - base - FAR.countStep - 2, line - base + 1];

  test("an ask", () => {
    const build = (owner: "p2" | "dm1") => {
      const state = dark(table());
      state.casts = { zask: castAsk("zask", { by: owner === "p2" ? "p1" : "dm1", caster: "hero", area: undefined, targets: ["hero"] }) };
      return state;
    };
    const dmAsk = (s: RoomState, i: number) => (s.casts[`dm${pad(i)}`] = castAsk(`dm${pad(i)}`, { by: "dm1", caster: "hero", area: undefined, targets: ["hero"] }));
    const p1Ask = (s: RoomState) => (s.casts.pz = castAsk("pz", { by: "p1", caster: "hero", area: undefined, targets: ["hero"] }));
    assertTwinsAlike(twinAnswers(build, dmAsk, p1Ask, around(FAR.asks, 2)), "an ask");
  });

  test("a token", () => {
    const build = (owner: "p2" | "dm1") => {
      const state = dark(table());
      state.tokens.zone = owner === "p2" ? token("zone", { companion: { of: "c1", turn: "own" }, ownerIds: ["p1"] }) : token("zone");
      return state;
    };
    const dmToken = (s: RoomState, i: number) => (s.tokens[`dm${pad(i)}`] = token(`dm${pad(i)}`, { visibility: "dm", x: 30, y: 20 }));
    assertTwinsAlike(twinAnswers(build, dmToken, (s) => companions(s, 1, "s1", 900), around(FAR.tokens, 3)), "a token");
  });

  test("an area", () => {
    const build = (owner: "p2" | "dm1") => {
      const state = dark(table());
      state.templates.zone = template("zone", { ownerId: owner === "p2" ? "p1" : "dm1" });
      return state;
    };
    const dmArea = (s: RoomState, i: number) => (s.templates[`dm${pad(i)}`] = template(`dm${pad(i)}`, { ownerId: "dm1", visibility: "dm" }));
    assertTwinsAlike(twinAnswers(build, dmArea, (s) => (s.templates.pz = template("pz")), around(FAR.areas, 2)), "an area");
  });

  test("a drawing", () => {
    const build = (owner: "p2" | "dm1") => {
      const state = dark(table());
      state.drawings.zone = drawing("zone", { ownerId: owner === "p2" ? "p1" : "dm1" });
      return state;
    };
    const dmDrawing = (s: RoomState, i: number) => (s.drawings[`dm${pad(i)}`] = drawing(`dm${pad(i)}`, { ownerId: "dm1", visibility: "dm" }));
    assertTwinsAlike(twinAnswers(build, dmDrawing, (s) => (s.drawings.pz = drawing("pz")), around(FAR.drawings, 2)), "a drawing");
  });

  test("a row", () => {
    const build = (owner: "p2" | "dm1") => {
      const state = dark(table());
      state.encounter = { rev: 0, round: 1, activeEntryId: null, entries: [owner === "p2" ? entry("zone", { tokenId: "hero" }) : entry("zone", { label: "Goblin" })] };
      return state;
    };
    const dmRow = (s: RoomState, i: number) => s.encounter!.entries.push(entry(`dm${pad(i)}`, { label: "Goblin", hidden: true }));
    assertTwinsAlike(twinAnswers(build, dmRow, (s) => s.encounter!.entries.push(entry("pz", { characterId: "c1" })), around(FAR.rows, 2)), "a row");
  });
});

test("LP43-PRIV-1: P1's own area the DM hid counts as their copy has it, so hidden and deleted answer alike wherever the DM's part keeps its step", () => {
  // Hidden, the area is in the stepped part, as a deleted one is not: the twins may part only where that one area crosses
  // a step's edge, the far line's own grain. Counted exactly as P1's, it would part them where P1's 49 others put the
  // line inside a step. P1 holds Upper by a companion there.
  const own = (s: RoomState) => {
    companions(s, 1, "up", 900);
    for (let i = 0; i < 30; i++) s.templates[`pg${pad(i)}`] = template(`pg${pad(i)}`);
    for (let i = 0; i < 19; i++) s.templates[`pu${pad(i)}`] = template(`pu${pad(i)}`, { sceneId: "up" });
    return s;
  };
  const rooms = [own(keep()), own(keep())];
  rooms[0]!.templates.mine = template("mine", { visibility: "dm" });
  const [from, to] = [FAR.areas - 50 - FAR.countStep - 3, FAR.areas - 50 + 1];
  const dmArea = (s: RoomState, i: number) => (s.templates[`dm${pad(i)}`] = template(`dm${pad(i)}`, { ownerId: "dm1", visibility: "dm" }));
  for (const s of rooms) for (let i = 0; i < from; i++) dmArea(s, i);
  const apart: number[] = [];
  const answers: boolean[] = [];
  for (let i = from; i < to; i++) {
    const [hidden, deleted] = rooms.map((s) => {
      dmArea(s, i);
      const after = fresh(s);
      after.templates.pz = template("pz");
      return admitLimits(after, "s1", fresh(s), P1, CREATE).ok;
    });
    answers.push(deleted!);
    // The DM's fill is i + 1 areas, and the hidden one makes the stepped part one more.
    if ((i + 1) % FAR.countStep !== 0 && hidden !== deleted) apart.push(i);
  }
  assert.deepEqual(apart, [], "alike inside every step");
  assert.ok(answers[0] && !answers.at(-1), "the window holds the line");
});

describe("LP44-PRIV-1: a player's own companion blocks never move their far blocks lines", () => {
  /** The table with P2's Bree (c2), whose blocks P1's copy does not hold, and `ghosts` characters of the DM's for the DM's blocks. */
  const blocksRoom = (ghosts: number): RoomState => {
    const state = table();
    state.characters.c2 = character("c2", { name: "Bree", ownerIds: ["p2"] });
    for (let i = 0; i < ghosts; i++) state.characters[`dm${pad(i)}`] = character(`dm${pad(i)}`, { name: `Ghost ${i}`, ownerIds: [] });
    state.companionBlocks = {};
    return state;
  };
  const block = (id: string, characterId: string, chars: number) => companionBlock(id, characterId, { traits: [{ name: "Notes", text: "t".repeat(chars) }] });
  const withBlock = (state: RoomState, id: string, characterId: string, chars: number): RoomState => ({ ...state, companionBlocks: { ...state.companionBlocks, [id]: block(id, characterId, chars) } });

  test("the count: P1's every add of a block answers alike whether P2 has one block more", () => {
    // The DM's 1,129 blocks and P2's 1 or 2 leave the stepped count inside the step under 1,150, so P1's own blocks meet
    // the line of 1,200 at their 51st, and P1's 100 adds sweep two steps of it.
    const answers = [1, 2].map((p2) => {
      let state = blocksRoom(12);
      for (let i = 0; i < 1_129; i++) state.companionBlocks[`dmb${pad(i)}`] = block(`dmb${pad(i)}`, `dm${pad(i % 12)}`, 0);
      for (let i = 0; i < p2; i++) state.companionBlocks[`p2b${i}`] = block(`p2b${i}`, "c2", 0);
      const out: boolean[] = [];
      for (let n = 1; n <= 100; n++) {
        const next = withBlock(state, `p1b${pad(n)}`, "c1", 0);
        out.push(admitLimits(next, "s1", state, P1, CREATE).ok);
        state = next;
      }
      return out;
    });
    assert.deepEqual(answers[1], answers[0]);
    assert.equal(answers[0]!.indexOf(false), 50, "P1's 51st block is the first refused");
  });

  test("the bytes: P1's every length of their own block answers alike whether P2's block is 100 bytes longer", () => {
    // The DM's blocks leave the stepped bytes 600 under 23 steps, so P1's own blocks meet the 6 MiB line at one step of
    // their own. P1's 20 blocks hold that less 2,000 bytes, and their last block's text sweeps 4,000 characters across it.
    const step = FAR.byteStep;
    const bytesOf = (id: string, characterId: string, chars: number) => serializedBytes(block(id, characterId, chars));
    const overhead = (id: string, characterId: string) => bytesOf(id, characterId, 0);
    let base = withBlock(blocksRoom(16), "p2b", "c2", 0);
    const stepped = () => Object.values(base.companionBlocks).reduce((sum, b) => sum + serializedBytes(b), 0);
    const target = 23 * step - 600;
    for (let i = 0; stepped() + 13_000 < target; i++) base = withBlock(base, `dmb${pad(i)}`, `dm${pad(i % 16)}`, 13_000 - overhead(`dmb${pad(i)}`, `dm${pad(i % 16)}`));
    base = withBlock(base, "dmlast", "dm00015", target - stepped() - overhead("dmlast", "dm00015"));
    assert.equal(stepped(), target);
    const sweptOverhead = overhead("p1last", "c1");
    let own = step - 2_000 - sweptOverhead;
    for (let i = 0; i < 20; i++) {
      const chars = i < 19 ? Math.floor(own / (20 - i)) - overhead(`p1b${pad(i)}`, "c1") : own - overhead(`p1b${pad(i)}`, "c1");
      own -= bytesOf(`p1b${pad(i)}`, "c1", chars);
      base = withBlock(base, `p1b${pad(i)}`, "c1", chars);
    }
    assert.equal(own, 0);
    const first = (state: RoomState) => {
      const before = withBlock(state, "p1last", "c1", 0);
      const takes = (chars: number) => admitLimits(withBlock(before, "p1last", "c1", chars), "s1", before, P1, CREATE).ok;
      let [taken, refused] = [0, 4_000];
      assert.ok(takes(taken) && !takes(refused), "the sweep holds the line");
      while (refused - taken > 1) {
        const mid = Math.floor((taken + refused) / 2);
        if (takes(mid)) taken = mid;
        else refused = mid;
      }
      return refused;
    };
    const longer = withBlock(base, "p2b", "c2", 100);
    assert.equal(first(longer), first(base));
    // P1's 21 blocks count with their revs at their widest, 15 bytes more each than their copies' 0.
    assert.equal(first(base), 2_001 - 21 * (String(Number.MAX_SAFE_INTEGER).length - 1), "P1's own blocks meet the line at one step of their own");
  });
});
