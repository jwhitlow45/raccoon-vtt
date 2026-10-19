import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { Encounter, RoomState, Token, TurnStart } from "#shared/model.ts";
import { character, entry, P1, P2, room, token } from "#shared/testutil.ts";
import { dragReading } from "../measure/movement.ts";
import { riderLine, turnMoverId } from "./turns.ts";
import { copyFor } from "./testing.ts";

/** Bree's turn, riding her warhorse controlled, which sits on a giant turtle she also steers through it, all three seen. */
function turn(over: { mounts?: string[]; start?: Partial<TurnStart> } = {}, edit: (state: RoomState) => void = () => {}): RoomState {
  const state = room();
  state.characters.bree = character("bree", { name: "Bree", ownerIds: ["p1"] });
  const list: Token[] = [
    token("bree", { name: "Bree", kind: "pc", actor: { ref: "bree" }, x: 5, y: 5, attached: { to: "horse", kind: "ride", steer: true } }),
    token("horse", { name: "Warhorse", size: "large", x: 5, y: 5, attached: { to: "turtle", kind: "ride", steer: true } }),
    token("turtle", { name: "Turtle", size: "gargantuan", x: 4, y: 4 }),
  ];
  state.tokens = Object.fromEntries(list.map((t) => [t.id, t]));
  state.encounter = {
    rev: 1,
    round: 1,
    activeEntryId: "i-bree",
    entries: [entry("i-bree", { tokenId: "bree", value: 15 })],
    turnStart: { entryId: "i-bree", tokenId: "bree", sceneId: "s1", x: 5, y: 5, elevation: 0, seen: true, seq: 4, mounts: over.mounts ?? ["horse"], ...over.start },
  } as Encounter;
  edit(state);
  return state;
}

describe("whose movement the turn reads", () => {
  test("the active creature, or the mount sharing its turn, the lowest one up a chain each of whose holders is on the list", () => {
    assert.equal(turnMoverId(turn({ mounts: [] })), "bree");
    assert.equal(turnMoverId(turn({ mounts: ["horse"] })), "horse");
    assert.equal(turnMoverId(turn({ mounts: ["horse", "turtle"] })), "turtle");
    assert.equal(turnMoverId(turn({ mounts: ["turtle"] })), "bree", "the chain stops at the first holder off the list");
  });

  test("a free ride, a ride that ended, or a start of another turn shares nothing", () => {
    assert.equal(turnMoverId(turn({}, (s) => (s.tokens.bree = { ...s.tokens.bree!, attached: { to: "horse", kind: "ride" } }))), "bree");
    assert.equal(
      turnMoverId(
        turn({}, (s) => {
          const { attached: _gone, ...off } = s.tokens.bree!;
          s.tokens.bree = off;
        }),
      ),
      "bree",
    );
    assert.equal(turnMoverId(turn({ start: { entryId: "i-other" } })), "bree");
    assert.equal(turnMoverId(turn({}, (s) => (s.encounter!.activeEntryId = null))), undefined);
    assert.equal(turnMoverId(null), undefined);
  });

  test("a player's copy reads its own turn start and links: what they cannot see moves nothing under the pill", () => {
    assert.equal(turnMoverId(copyFor(turn(), P1)), "horse");
    assert.equal(turnMoverId(copyFor(turn(), P2)), "horse");
    const hidden = turn({}, (s) => (s.tokens.horse = { ...s.tokens.horse!, visibility: "dm" }));
    assert.equal(turnMoverId(copyFor(hidden, P2)), "bree", "no mount in the copy, so no link either");
  });

  test("the pill's second line is the rider's own feet, with what they used where it differs, and nothing at 0", () => {
    assert.equal(riderLine("Bree", { movedFt: 15, usedFt: 15 }), "Bree: 15 ft");
    assert.equal(riderLine("Bree", { movedFt: 5, usedFt: 20 }), "Bree: 5 ft, used 20 ft");
    assert.equal(riderLine("Bree", { movedFt: 0, usedFt: 0 }), null);
    assert.equal(riderLine("Bree", null), null);
  });

  test("a drag of the group reads the mount's path and speeds, its band counting on from the mount's walk this turn", () => {
    const state = turn({}, (s) => {
      s.tokens.horse = { ...s.tokens.horse!, path: { turn: 4, stops: [{ x: 3, y: 5, elevation: 0 }, { x: 5, y: 5, elevation: 0 }] } };
    });
    const horse = state.tokens.horse!;
    const rules = { feetPerCell: 5, diagonal: "five" as const };
    const read = (activeTokenId: string | null) => dragReading({ token: horse, to: { x: 7, y: 5 }, encounter: state.encounter, activeTokenId, speeds: { walk: 40 }, rules, role: "dm" });
    assert.deepEqual(read(turnMoverId(state) ?? null).left, { kind: "walk", speed: 40, leftFt: 20, band: "walk" }, "10 ft walked and 10 ft more leave 20 ft of 40 ft");
    assert.equal(read("bree").left, undefined, "read as the rider's turn, the mount is just another creature");
  });
});
