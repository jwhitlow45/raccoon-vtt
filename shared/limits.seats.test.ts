import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { opKind } from "./farLine.ts";
import { FAR, LIMITS, SEAT, SEAT_FULL, admitLimits, farLimits, seatCheck, seatCounts, seatHeld, type LimitSender } from "./limits.ts";
import type { RoomState } from "./model.ts";
import { seatView } from "./project.ts";
import type { Op } from "./protocol.ts";
import { character, drawing, entry, room, scene, template, token } from "./testutil.ts";

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

  test("a thing several players own is held by its first owner by id", () => {
    const state = table({ characters: { c1: character("c1", { ownerIds: ["p2", "p1"] }) } });
    const held = seatHeld(state, "s1");
    assert.ok(held.tokens.has("hero"));
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

  test("an import is held to it absolutely", () => {
    const state = table();
    state.encounter = { rev: 0, round: 1, activeEntryId: null, entries: Array.from({ length: FAR.rows + 1 }, (_, i) => entry(`d${i}`, { label: "x" })) };
    assert.equal(farLimits(state, null).ok, false);
  });
});
