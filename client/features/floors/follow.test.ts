import assert from "node:assert/strict";
import { describe, test } from "node:test";
import fc from "fast-check";
import type { RoomState } from "#shared/model.ts";
import { entry, token } from "#shared/testutil.ts";
import { floorBeside, followedOf, heldHere, nextFloor, pickOf, type FloorInput, type FloorPick } from "./follow.ts";
import { ATTIC, CAVE, playerCopy, TOWER, tower, UPPER } from "./testing.ts";

/*
 * Which floor a device shows (docs/design/design-v1-floors.md 7.3): a
 * player's follow and pick, a DM's pick and follows, and their invariants
 * over many changes in a row.
 */

const FLOORS = [TOWER, UPPER, ATTIC];

function input(over: Partial<FloorInput> & Pick<FloorInput, "view">): FloorInput {
  return { role: "player", display: false, memberId: "p1", before: null, anchor: TOWER, shown: TOWER, pick: null, selected: [], dmFloor: null, followsTurn: false, ...over };
}

describe("the creature a player's device follows", () => {
  test("the selected creature they own, else their character's token on the floor shown, else on the lowest, else any creature they own by the same order", () => {
    const state = tower();
    state.tokens.thorn = { ...state.tokens.thorn!, sceneId: ATTIC };
    state.tokens.thorn2 = token("thorn2", { sceneId: UPPER, kind: "pc", name: "Thorn", actor: { ref: "thorn" } });
    state.tokens.owl = token("owl", { sceneId: TOWER, kind: "npc", name: "Owl", ownerIds: ["p1"] });
    state.tokens.door = token("door", { sceneId: TOWER, kind: "object", name: "Door", ownerIds: ["p1"] });
    const view = playerCopy(state, FLOORS);
    const held = heldHere(view, TOWER);
    assert.deepEqual(held.map((f) => f.id), FLOORS, "bottom first");
    const at = (shown: string, selected: string[] = []) => followedOf({ view, memberId: "p1", held, shown, selected });
    assert.deepEqual(at(TOWER, ["owl"]), { tokenId: "owl", sceneId: TOWER }, "the selection first");
    assert.deepEqual(at(TOWER, ["door"]), { tokenId: "thorn2", sceneId: UPPER }, "never an object: the character's token on the lowest floor it has one");
    assert.deepEqual(at(ATTIC), { tokenId: "thorn", sceneId: ATTIC }, "the character's token on the floor shown");
    assert.deepEqual(at(TOWER, ["bree"]), { tokenId: "thorn2", sceneId: UPPER }, "another's creature is no pick of theirs");
    const noCharacter = playerCopy(tower({ characters: {}, tokens: { owl: token("owl", { sceneId: UPPER, kind: "npc", ownerIds: ["p1"] }) } }), FLOORS);
    assert.deepEqual(followedOf({ view: noCharacter, memberId: "p1", held, shown: TOWER, selected: [] }), { tokenId: "owl", sceneId: UPPER }, "any creature they own");
    assert.equal(followedOf({ view: noCharacter, memberId: "p2", held, shown: TOWER, selected: [] }), null);
  });

  test("a pick of the floor they follow anyway, or of one they do not hold, is none, and Back is none", () => {
    const held = heldHere(playerCopy(tower(), [TOWER, UPPER]), TOWER);
    const follow = { sceneId: TOWER, tokenId: "thorn" };
    assert.deepEqual(pickOf(UPPER, follow, held), { sceneId: UPPER, followed: TOWER });
    assert.equal(pickOf(TOWER, follow, held), null);
    assert.equal(pickOf(ATTIC, follow, held), null);
    assert.equal(pickOf(null, follow, held), null);
  });

  test("[ and ] step through the held floors, bottom first, with none past the top or the bottom", () => {
    const held = heldHere(tower(), TOWER);
    assert.equal(floorBeside(held, TOWER, 1), UPPER);
    assert.equal(floorBeside(held, UPPER, -1), TOWER);
    assert.equal(floorBeside(held, ATTIC, 1), null);
    assert.equal(floorBeside(held, TOWER, -1), null);
    assert.equal(floorBeside(heldHere(tower(), CAVE), CAVE, 1), null, "a scene of one floor");
  });
});

describe("a DM's floor", () => {
  test("the floor picked while the scene holds it, else the main floor, and the selected token's Move to floor", () => {
    const state = tower();
    const dm = (over: Partial<FloorInput>) => nextFloor(input({ role: "dm", memberId: "dm1", view: state, ...over })).sceneId;
    assert.equal(dm({ shown: UPPER }), UPPER);
    assert.equal(dm({ shown: CAVE }), TOWER, "a floor of another scene is not held");
    assert.equal(dm({ shown: null }), TOWER);
    const moved = { ...state, tokens: { ...state.tokens, thorn: { ...state.tokens.thorn!, sceneId: ATTIC } } };
    assert.equal(nextFloor(input({ role: "dm", memberId: "dm1", view: moved, before: state, selected: ["thorn"] })).sceneId, ATTIC);
    assert.equal(nextFloor(input({ role: "dm", memberId: "dm1", view: moved, before: state, selected: ["bree"] })).sceneId, TOWER);
    assert.equal(nextFloor(input({ role: "dm", memberId: "dm1", view: moved, before: state, selected: ["thorn"], shown: UPPER })).sceneId, UPPER, "a move from another floor than the one shown takes the DM nowhere");
  });
});

/*
 * Many changes in a row on a player's device: creatures moving between
 * floors, picks and Backs, turns, floors gained and lost, blackouts.
 * Invariants:
 *   HELD   the floor shown is a held floor, or null only while none is held,
 *   PICK   a pick never outlives a change of its followed creature's floor,
 *   FOLLOW with no pick, the floor shown is the followed creature's or the start floor,
 *   NOTICE the device follows a held floor whenever it holds any.
 */
describe("a player's floor over many changes", () => {
  type Step =
    | { t: "move"; token: "thorn" | "owl"; to: number }
    | { t: "pick"; to: number }
    | { t: "back" }
    | { t: "turn"; to: "thorn" | "bree" }
    | { t: "hold"; floors: boolean[] }
    | { t: "blackout"; on: boolean };
  const step: fc.Arbitrary<Step> = fc.oneof(
    fc.record({ t: fc.constant("move" as const), token: fc.constantFrom("thorn" as const, "owl" as const), to: fc.integer({ min: 0, max: 2 }) }),
    fc.record({ t: fc.constant("pick" as const), to: fc.integer({ min: 0, max: 2 }) }),
    fc.constant({ t: "back" as const }),
    fc.record({ t: fc.constant("turn" as const), to: fc.constantFrom("thorn" as const, "bree" as const) }),
    fc.record({ t: fc.constant("hold" as const), floors: fc.array(fc.boolean(), { minLength: 3, maxLength: 3 }) }),
    fc.record({ t: fc.constant("blackout" as const), on: fc.boolean() }),
  );

  test("HELD, PICK, FOLLOW and NOTICE hold after every change", () => {
    fc.assert(
      fc.property(fc.array(step, { minLength: 1, maxLength: 40 }), (steps) => {
        let state: RoomState = tower({ tokens: { ...tower().tokens, owl: token("owl", { sceneId: UPPER, kind: "npc", name: "Owl", ownerIds: ["p1"] }) } });
        state.encounter = { rev: 0, round: 1, activeEntryId: "e-bree", entries: [entry("e-thorn", { tokenId: "thorn", value: 10 }), entry("e-bree", { tokenId: "bree", value: 20 })] };
        let holds = [true, true, true];
        let blackout = false;
        let before: RoomState | null = null;
        let shown: string | null = TOWER;
        let pick: FloorPick | null = null;
        let follow: { sceneId: string | null; tokenId: string | null } | null = null;
        for (const s of steps) {
          if (s.t === "move") state = { ...state, tokens: { ...state.tokens, [s.token]: { ...state.tokens[s.token]!, sceneId: FLOORS[s.to]! } } };
          if (s.t === "turn") state = { ...state, encounter: { ...state.encounter!, activeEntryId: `e-${s.to}` } };
          if (s.t === "hold") holds = s.floors;
          if (s.t === "blackout") blackout = s.on;
          // The start floor is always held, and a floor their own creature stands on (8): the copy holds those and the ones picked to hold.
          const own = new Set(["thorn", "owl"].map((id) => state.tokens[id]!.sceneId));
          const held: string[] = blackout ? [] : FLOORS.filter((f, i) => f === TOWER || own.has(f) || holds[i]);
          const view = playerCopy(state, held);
          const anchor = blackout ? null : TOWER;
          if (s.t === "pick") pick = pickOf(FLOORS[s.to]!, follow, heldHere(view, anchor));
          if (s.t === "back") pick = null;
          const out = nextFloor(input({ view, before, anchor, shown, pick, selected: [] }));
          const ids: readonly string[] = held;
          // HELD
          if (ids.length === 0) assert.equal(out.sceneId, null);
          else assert.ok(out.sceneId !== null && ids.includes(out.sceneId), `shows ${out.sceneId}, holds ${ids.join(" ")}`);
          // PICK
          if (out.pick !== null) assert.equal(out.pick.followed, out.follow?.sceneId ?? null);
          // FOLLOW
          if (out.pick === null && ids.length > 0) assert.equal(out.sceneId, out.follow?.sceneId);
          // NOTICE
          if (ids.length > 0) assert.ok(out.follow?.sceneId !== null && ids.includes(out.follow!.sceneId!));
          before = view;
          shown = out.sceneId;
          pick = out.pick;
          follow = out.follow;
        }
      }),
      { numRuns: 500 },
    );
  });
});
