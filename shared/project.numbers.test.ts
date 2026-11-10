import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { keys } from "./keys.ts";
import type { RoomState, Scene, Token } from "./model.ts";
import { projectEntity, projectState } from "./project.ts";
import { DM, P1, P2, character, member, reveal, room, scene, token } from "./testutil.ts";
import { markFinished } from "./writable.ts";

/*
 * What each copy carries of a creature's number (shared/numbering.ts):
 * the table's number, the same in every copy, and the mark in the DM's
 * alone. Scene s1 has given Goblin (group 1) two numbers.
 */

const NUMBERS: Scene["numbers"] = { names: { Goblin: [1, 2] } };

function roomWith(tokens: Token[], extra: Partial<RoomState> = {}): RoomState {
  return room({ scenes: { s1: scene("s1", { numbers: NUMBERS }), s2: scene("s2", { order: 1 }) }, tokens: Object.fromEntries(tokens.map((t) => [t.id, t])), ...extra });
}

const copyOf = (state: RoomState, who: typeof DM, id: string) => projectState(state, who, { sceneId: "s1" }).tokens[id];

describe("a creature's number in each copy", () => {
  test("every copy carries the table's number, and no copy a number the table did not give", () => {
    const state = roomWith([token("a", { met: 1, number: 1 }), token("b", { number: 2 }), token("c", { met: 1, number: 2, name: "Orc" })]);
    for (const who of [DM, P1]) {
      assert.equal(copyOf(state, who, "a")?.number, 1, `${who.memberId} reads the member's number`);
      assert.equal(copyOf(state, who, "b")?.number, undefined, `${who.memberId} reads no number without a mark`);
      assert.equal(copyOf(state, who, "c")?.number, undefined, `${who.memberId} reads no number under a name the group is not`);
    }
  });

  test("a player's copy carries no mark, the owner's neither, and the owner reads the number everyone reads", () => {
    const state = roomWith([token("a", { met: 1, number: 1, ownerIds: ["p1"] }), token("b", { met: 1, number: 2, nameHidden: true, publicName: "Goblin", name: "Orc" })]);
    const owner = copyOf(state, P1, "a")!;
    assert.equal("met" in owner, false);
    assert.equal(owner.number, 1);
    const other = copyOf(state, P2, "b")!;
    assert.equal("met" in other, false);
    assert.equal(other.name, "Goblin");
    assert.equal(other.number, 2, "a disguise's number under the name players read");
    assert.equal(copyOf(state, DM, "a")!.met, 1, "the DM's copy keeps the mark");
  });

  test("a party member's companion carries no number for anyone, and one of a character no player plays carries its own", () => {
    const characters = { hero: character("hero", { ownerIds: ["p1"] }), npc: character("npc", { ownerIds: [] }) };
    const state = roomWith([token("a", { kind: "npc", met: 1, number: 1, companion: { of: "hero", turn: "own" }, ownerIds: ["p1"] }), token("b", { kind: "npc", met: 1, number: 2, companion: { of: "npc", turn: "own" } })], { characters });
    for (const who of [DM, P1, P2]) {
      assert.equal(copyOf(state, who, "a")?.number, undefined, `${who.memberId}: a party member's companion`);
      assert.equal(copyOf(state, who, "b")?.number, 2, `${who.memberId}: an unplayed character's companion`);
    }
  });

  test("the DM's copy follows a member's kind change that leaves the creature as it was", () => {
    const characters = { hero: character("hero", { ownerIds: ["p1"] }) };
    const owl = token("a", { kind: "npc", met: 1, number: 1, companion: { of: "hero", turn: "own" }, ownerIds: ["p1"] });
    const state = roomWith([owl], { characters });
    markFinished(state);
    markFinished(state.tokens);
    const before = projectEntity(keys.token("a"), state, DM, { sceneId: "s1" }) as Token;
    assert.equal(before.number, undefined);
    // The same token object, its player now a DM, so the companion is a plain creature to the table.
    const made = { ...state, members: { ...state.members, p1: member("p1", "dm") } };
    markFinished(made);
    const after = projectEntity(keys.token("a"), made, DM, { sceneId: "s1" }) as Token;
    assert.equal(made.tokens.a, owl);
    assert.equal(after.number, 1);
    assert.equal((projectEntity(keys.token("a"), state, DM, { sceneId: "s1" }) as Token).number, undefined, "each result keeps its own copy");
  });

  test("on a scene whose DM copy marks what every player sees, each result of a kind change keeps its own marked copy", () => {
    const characters = { hero: character("hero", { ownerIds: ["p1"] }) };
    const owl = token("a", { kind: "npc", met: 1, number: 1, companion: { of: "hero", turn: "own" }, ownerIds: ["p1"], x: 2, y: 2 });
    const state = roomWith([owl], { characters });
    state.scenes.s1 = { ...state.scenes.s1!, gridShape: "hexRows", fogEnabled: true };
    reveal(state, "s1", { x: 0, y: 0, w: 8, h: 8 });
    markFinished(state);
    markFinished(state.tokens);
    const made = { ...state, members: { ...state.members, p1: member("p1", "dm") } };
    markFinished(made);
    const read = (room: RoomState) => projectEntity(keys.token("a"), room, DM, { sceneId: "s1" }) as Token & { seenAll?: true };
    assert.deepEqual([read(state).seenAll, read(state).number], [true, undefined], "a party member's companion");
    assert.deepEqual([read(made).seenAll, read(made).number], [true, 1], "a plain creature once its player is a DM");
    assert.equal(read(state).number, undefined, "and back");
  });

  test("the DM's copy is the stored token when nothing in it differs", () => {
    const state = roomWith([token("a", { met: 1, number: 1 }), token("b", { met: 1 })]);
    markFinished(state);
    markFinished(state.tokens);
    assert.equal(copyOf(state, DM, "a"), state.tokens.a);
    assert.equal(copyOf(state, DM, "b"), state.tokens.b);
  });
});
