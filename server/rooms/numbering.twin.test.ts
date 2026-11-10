import assert from "node:assert/strict";
import { describe, test, type TestContext } from "node:test";
import { NUMBERING_SNAPSHOT_VERSION } from "#shared/migrate.ts";
import { NUMBERS_MOST } from "#shared/numbering.ts";
import type { RoomState, Scene, Token } from "#shared/model.ts";
import { character, member, scene, token } from "#shared/testutil.ts";
import { creature, each, inF, inR, make, move, numberingRoom, numbersIn, openRooms, patch, same, viewOf, type Room, type Rooms } from "./numberingTesting.ts";
import type { Op } from "#shared/protocol.ts";

/**
 * Creature numbers in rooms P1 cannot tell apart: room A and room B differ
 * only where P1's copy never reaches, take the same members' ops, and give
 * P1 the same frames, whose raw text holds no group mark, scene numbers or
 * group count and none of what the rooms hold apart. Ids and names only
 * one room holds carry a "zq" no frame text holds by chance.
 */

/** The snapshot format before creature numbers came from the table. */
const OLD = NUMBERING_SNAPSHOT_VERSION - 1;

/** Both rooms from one fixture, with what each holds apart added. */
function states(build: (state: RoomState) => void, a: (state: RoomState) => void = () => {}, b: (state: RoomState) => void = () => {}): [RoomState, RoomState] {
  const out = [numberingRoom(), numberingRoom()] as [RoomState, RoomState];
  for (const s of out) build(s);
  a(out[0]);
  b(out[1]);
  return out;
}

/** P1's numbers now, the same in both rooms. */
function p1Numbers(pair: Rooms, what: string): Record<string, number> {
  const numbers = pair.map((room: Room) => numbersIn(room.p1View()));
  assert.deepEqual(numbers[0], numbers[1], `${what}: P1 reads the same numbers in both rooms`);
  return numbers[0]!;
}

/** P1's names for creatures now, by id, the same in both rooms. */
function p1Names(pair: Rooms, ids: readonly string[], what: string): Record<string, string> {
  const names = pair.map((room: Room) => {
    const tokens = room.p1View().tokens as Record<string, Partial<Token>>;
    return Object.fromEntries(ids.map((id) => [id, tokens[id] ? `${tokens[id].name}${tokens[id].number === undefined ? "" : ` ${tokens[id].number}`}` : "-"]));
  });
  assert.deepEqual(names[0], names[1], `${what}: P1 reads the same names in both rooms`);
  return names[0]!;
}

/** Each step in both rooms, then the raw scan and the comparison. */
async function steps(pair: Rooms, hidden: { a?: readonly string[]; b?: readonly string[] }, list: Array<[string, (room: Room) => Promise<unknown>]>): Promise<void> {
  for (const [what, step] of list) {
    await each(pair, step);
    same(pair, what, hidden);
  }
}

/** A step one room alone takes, then the raw scan and the comparison. */
async function inOne(pair: Rooms, which: 0 | 1, hidden: { a?: readonly string[]; b?: readonly string[] }, what: string, step: (room: Room) => Promise<unknown>): Promise<void> {
  await step(pair[which]);
  // Clocks move alike in both rooms, as the steps both take move them, so the room count reads alike.
  pair[1 - which]!.clock.now = pair[which].clock.now;
  same(pair, what, hidden);
}

/** A DM's newest step in a history scope taken back, or put back. */
async function undoNewest(room: Room, direction: "undo" | "redo" = "undo", scope: "play" | "setup" = "play", who: "dm" | "dm2" = "dm"): Promise<void> {
  await room.restore(direction, scope, who);
}

const goblins = (s: RoomState, list: Array<[string, { x: number; y: number }, Partial<Token>?]>) => {
  for (const [id, at, over] of list) s.tokens[id] = creature(id, at, over);
};

/** Both rooms opened, with P1's first chat taken in each, whose batch explores the sight the fixture shows. */
async function open(t: TestContext, [a, b]: [RoomState, RoomState], version?: number): Promise<Rooms> {
  const pair = await openRooms(t, a, b, {}, version);
  await each(pair, (room) => room.apply("p1", { t: "log.chat", text: "ready" }));
  return pair;
}

describe("creature numbers read alike in rooms that differ out of the party's sight", () => {
  test("K1: one Goblin in sight and a second walking in read 1 and 2, with three more under fog in room A only", async (t) => {
    const hidden = { a: ["zq1", "zq2", "zq3"] };
    const pair = await open(
      t,
      states(
        (s) => goblins(s, [["g1", inR(0)], ["w", inF(0)]]),
        (s) => goblins(s, [["zq1", inF(1, 0)], ["zq2", inF(1, 1)], ["zq3", inF(1, 2)]]),
      ),
    );
    same(pair, "opened", hidden);
    await steps(pair, hidden, [["g1 seen", (room) => room.apply("dm", move("g1", inR(1)))]]);
    assert.deepEqual(p1Numbers(pair, "g1 seen"), {});
    await steps(pair, hidden, [["w walks in", (room) => room.apply("dm", move("w", inR(0, 2)))]]);
    assert.deepEqual(p1Numbers(pair, "w walks in"), { g1: 1, w: 2 });
  });

  test("K2: two DM-hidden Goblins in room A, one P2's, change nothing P1 reads, and P2 reads no number on its hidden one", async (t) => {
    const hidden = { a: ["zq1", "zq2"] };
    const pair = await open(
      t,
      states(
        (s) => goblins(s, [["g1", inR(0)], ["w", inF(0)]]),
        (s) => goblins(s, [["zq1", inR(2), { visibility: "dm" }], ["zq2", inR(2, 1), { visibility: "dm", ownerIds: ["p2"] }]]),
      ),
    );
    await steps(pair, hidden, [
      ["g1 seen", (room) => room.apply("dm", move("g1", inR(1)))],
      ["w walks in", (room) => room.apply("dm", move("w", inR(0, 2)))],
    ]);
    assert.deepEqual(p1Numbers(pair, "w walks in"), { g1: 1, w: 2 });
    const p2 = viewOf(pair[0].clients.p2.sent);
    assert.ok(p2.tokens.zq2, "P2 holds its own hidden Goblin");
    assert.equal((p2.tokens.zq2 as Partial<Token>).number, undefined, "P2 reads no number on its hidden Goblin");
    assert.ok(!JSON.stringify(pair[0].clients.p2.sent).includes('"met"'), "P2's frames hold no group mark");
  });

  test("K3: an Orc shown as a Goblin in room A and a real Goblin in room B number alike beside Goblins", async (t) => {
    const hidden = { a: ["Zqorc"] };
    const pair = await open(
      t,
      states(
        (s) => goblins(s, [["g1", inR(0)], ["w", inF(0)]]),
        (s) => goblins(s, [["o", inR(1), { name: "Zqorc", nameHidden: true, publicName: "Goblin" }]]),
        (s) => goblins(s, [["o", inR(1)]]),
      ),
    );
    await steps(pair, hidden, [
      ["the two in sight met", (room) => room.apply("dm", move("g1", inR(0, 1)))],
      ["another arrives", (room) => room.apply("dm", move("w", inR(2, 2)))],
    ]);
    const numbers = p1Numbers(pair, "another arrives");
    assert.deepEqual(Object.keys(numbers).sort(), ["g1", "o", "w"]);
    assert.equal(numbers.w, 3, "the one who arrived takes 3");
  });

  test('K4: "Unknown creature" by default in room A and a creature really named that in room B number 1 and 2 alike', async (t) => {
    const hidden = { a: ["Zqkobold"] };
    const pair = await open(
      t,
      states(
        () => {},
        (s) => goblins(s, [["u1", inF(0), { name: "Zqkobold", nameHidden: true }], ["u2", inF(1), { name: "Zqkobold", nameHidden: true }]]),
        (s) => goblins(s, [["u1", inF(0), { name: "Unknown creature" }], ["u2", inF(1), { name: "Unknown creature" }]]),
      ),
    );
    await steps(pair, hidden, [
      ["the first in sight", (room) => room.apply("dm", move("u1", inR(0)))],
      ["the second in sight", (room) => room.apply("dm", move("u2", inR(1)))],
    ]);
    assert.deepEqual(p1Names(pair, ["u1", "u2"], "both in sight"), { u1: "Unknown creature 1", u2: "Unknown creature 2" });
  });

  test("K5: a name-hidden member renamed by the DM in room A alone changes nothing anyone reads", async (t) => {
    const hidden = { a: ["Zqvaro"] };
    const pair = await open(
      t,
      states((s) => goblins(s, [["x1", inR(0), { name: "Varo", nameHidden: true, publicName: "Hooded figure" }], ["x2", inF(0), { name: "Varo", nameHidden: true, publicName: "Hooded figure" }]])),
    );
    await steps(pair, hidden, [
      ["x1 met", (room) => room.apply("dm", move("x1", inR(1)))],
      ["x2 met", (room) => room.apply("dm", move("x2", inR(0, 2)))],
    ]);
    await inOne(pair, 0, hidden, "x1 renamed in A", (room) => room.apply("dm2", patch("x1", { name: "Zqvaro" })));
    await steps(pair, hidden, [["a later move", (room) => room.apply("dm", move("x1", inR(2)))]]);
    assert.deepEqual(p1Names(pair, ["x1", "x2"], "after"), { x1: "Hooded figure 1", x2: "Hooded figure 2" });
  });

  test("K6: Goblin 2 renamed and back, and its name hidden and shown, out of sight in room A alone, returns as Goblin 2", async (t) => {
    const pair = await open(t, states((s) => goblins(s, [["g1", inR(0)], ["g2", inF(0)]])));
    await steps(pair, {}, [
      ["g1 met", (room) => room.apply("dm", move("g1", inR(1)))],
      ["g2 met", (room) => room.apply("dm", move("g2", inR(0, 2)))],
      ["g2 leaves", (room) => room.apply("dm", move("g2", inF(2)))],
    ]);
    for (const p of [{ name: "Zqorc" }, { name: "Goblin" }, { nameHidden: true }, { nameHidden: false }]) {
      await inOne(pair, 0, { a: ["Zqorc"] }, `g2 ${JSON.stringify(p)} in A`, (room) => room.apply("dm2", patch("g2", p)));
    }
    await steps(pair, {}, [["g2 back", (room) => room.apply("dm", move("g2", inR(0, 2)))]]);
    assert.deepEqual(p1Names(pair, ["g1", "g2"], "back"), { g1: "Goblin 1", g2: "Goblin 2" });
  });

  test("K8: an unseen Goblin 3 deleted in room B leaves the next Goblin met as 4 in both", async (t) => {
    const pair = await open(t, states((s) => goblins(s, [["g1", inF(0)], ["g2", inF(1)], ["g3", inF(2)], ["g4", inF(3)]])));
    await steps(pair, {}, [
      ["g1 met", (room) => room.apply("dm", move("g1", inR(0)))],
      ["g2 met", (room) => room.apply("dm", move("g2", inR(1)))],
      ["g3 met", (room) => room.apply("dm", move("g3", inR(2)))],
      ["g3 leaves", (room) => room.apply("dm", move("g3", inF(2, 3)))],
    ]);
    await inOne(pair, 1, {}, "g3 deleted in B", (room) => room.apply("dm2", { t: "token.delete", tokenId: "g3" }));
    await steps(pair, {}, [["g4 met", (room) => room.apply("dm", move("g4", inR(0, 2)))]]);
    assert.deepEqual(p1Numbers(pair, "g4 met"), { g1: 1, g2: 2, g4: 4 });
  });

  test("K9: an unseen first-met Goblin deleted in room B, a second met, then B's brought back by undo and seen: 2, then 1", async (t) => {
    const pair = await open(t, states((s) => goblins(s, [["g1", inR(0)], ["g2", inF(1)]])));
    await steps(pair, {}, [
      ["g1 met alone", (room) => room.apply("dm", move("g1", inR(1)))],
      ["g1 leaves", (room) => room.apply("dm", move("g1", inF(0)))],
    ]);
    await inOne(pair, 1, {}, "g1 deleted in B", (room) => room.apply("dm2", { t: "token.delete", tokenId: "g1" }));
    await steps(pair, {}, [["g2 met", (room) => room.apply("dm", move("g2", inR(1)))]]);
    assert.deepEqual(p1Numbers(pair, "g2 met"), { g2: 2 });
    await inOne(pair, 1, {}, "the delete taken back in B", (room) => undoNewest(room, "undo", "play", "dm2"));
    assert.ok(pair[1].state.tokens.g1, "g1 is back in B");
    await steps(pair, {}, [["g1 seen", (room) => room.apply("dm", move("g1", inR(0)))]]);
    assert.deepEqual(p1Numbers(pair, "g1 seen"), { g1: 1, g2: 2 });
  });

  test("K10: a plain-looking companion of a character no player plays in room A numbers as the plain Goblin in room B", async (t) => {
    const pair = await open(
      t,
      states(
        (s) => {
          goblins(s, [["g1", inR(0)], ["w", inF(0)]]);
          s.characters.zqnpc = character("zqnpc", { name: "Zqcaptain", ownerIds: [] });
        },
        (s) => goblins(s, [["c", inF(1), { kind: "npc", companion: { of: "zqnpc", turn: "shared" } }]]),
        (s) => goblins(s, [["c", inF(1), { kind: "npc" }]]),
      ),
    );
    await steps(pair, {}, [
      ["g1 met", (room) => room.apply("dm", move("g1", inR(1)))],
      ["c walks in", (room) => room.apply("dm", move("c", inR(0, 2)))],
      ["w walks in", (room) => room.apply("dm", move("w", inR(2, 2)))],
    ]);
    assert.deepEqual(p1Numbers(pair, "all in"), { g1: 1, c: 2, w: 3 });
  });

  test("K10b: Goblin 2, hidden, attached to an unplayed character in room A alone and then revealed in both, stays Goblin 2", async (t) => {
    const hidden = {};
    const pair = await open(
      t,
      states((s) => {
        goblins(s, [["g1", inR(0)], ["g2", inF(0)]]);
        s.characters.zqnpc = character("zqnpc", { name: "Captain", ownerIds: [] });
        s.characters.played = character("played", { name: "Thorn", ownerIds: ["p1"] });
      }),
    );
    await steps(pair, {}, [
      ["g1 met", (room) => room.apply("dm", move("g1", inR(1)))],
      ["g2 met", (room) => room.apply("dm", move("g2", inR(0, 2)))],
      ["g2 hidden", (room) => room.apply("dm", patch("g2", { visibility: "dm" }))],
    ]);
    await inOne(pair, 0, hidden, "g2 attached in A", (room) => room.apply("dm2", patch("g2", { companion: { of: "zqnpc", turn: "shared" } })));
    await steps(pair, hidden, [["g2 revealed", (room) => room.apply("dm", patch("g2", { visibility: "all" }))]]);
    assert.deepEqual(p1Names(pair, ["g1", "g2"], "revealed"), { g1: "Goblin 1", g2: "Goblin 2" });
    await steps(pair, hidden, [["g2 hidden again", (room) => room.apply("dm", patch("g2", { visibility: "dm" }))]]);
    await inOne(pair, 0, hidden, "g2 detached in A", (room) => room.apply("dm2", patch("g2", { companion: null })));
    await inOne(pair, 0, hidden, "the detach taken back in A", (room) => undoNewest(room, "undo", "setup", "dm2"));
    await inOne(pair, 0, hidden, "and put back in A", (room) => undoNewest(room, "redo", "setup", "dm2"));
    await steps(pair, hidden, [["g2 revealed again", (room) => room.apply("dm", patch("g2", { visibility: "all" }))]]);
    assert.deepEqual(p1Names(pair, ["g1", "g2"], "revealed again"), { g1: "Goblin 1", g2: "Goblin 2" });
    // A party member's companion is never numbered: attached to Thorn in both, it reads plain to P1.
    await steps(pair, hidden, [["g2 Thorn's companion", (room) => room.apply("dm", patch("g2", { companion: { of: "played", turn: "shared" } }))]]);
    assert.deepEqual(p1Names(pair, ["g1", "g2"], "Thorn's"), { g1: "Goblin 1", g2: "Goblin" });
    await steps(pair, hidden, [["back to the DM's", (room) => undoNewest(room, "undo", "setup")]]);
    assert.deepEqual(p1Names(pair, ["g1", "g2"], "undone"), { g1: "Goblin 1", g2: "Goblin 2" });
  });

  test("K24: Goblin 2 climbing to a floor that holds Goblin 1 stays 2, with namesakes on an unopened floor in room A alone", async (t) => {
    const floored = (s: RoomState) => {
      const ground = s.scenes.s1!;
      s.scenes.s1 = { ...ground, floor: { of: "s1", level: 0, name: "Ground floor", height: 10 } } as Scene;
      s.scenes.up = scene("up", { name: ground.name, order: 0, bounds: ground.bounds, floor: { of: "s1", level: 1, name: "Upper floor", height: 10 } });
      s.scenes.at = scene("at", { name: ground.name, order: 0, bounds: ground.bounds, floor: { of: "s1", level: 2, name: "Attic", height: 10 } });
      s.openFloors = { up: { sceneId: "up", rev: 0 } } as RoomState["openFloors"];
      goblins(s, [["g1", inR(0)], ["g2", inF(0)]]);
    };
    const hidden = { a: ["zq1", "zq2"] };
    const pair = await open(t, states(floored, (s) => goblins(s, [["zq1", { x: 4, y: 4 }, { sceneId: "at" }], ["zq2", { x: 5, y: 4 }, { sceneId: "at" }]])));
    await steps(pair, hidden, [
      ["g1 met", (room) => room.apply("dm", move("g1", inR(1)))],
      ["g2 met", (room) => room.apply("dm", move("g2", inR(0, 2)))],
      ["g1 upstairs", (room) => room.apply("dm", patch("g1", { sceneId: "up", x: 4, y: 4 }))],
      ["g2 upstairs", (room) => room.apply("dm", patch("g2", { sceneId: "up", x: 5, y: 4 }))],
    ]);
    for (const room of pair) {
      assert.equal(room.state.tokens.g2?.number, 2, `${room.name}: g2 is still 2 upstairs`);
      assert.equal(room.state.tokens.g1?.number, 1, `${room.name}: g1 is still 1 upstairs`);
    }
  });

  test("K25: Goblin 2 taken to another scene and back unseen in room A alone returns as Goblin 2, and one moved where that scene's Goblins have given 1 takes 2 when met there", async (t) => {
    const marked = (s: RoomState) => {
      goblins(s, [["g1", inR(0), { number: 1, met: 1 }], ["g2", inR(1), { number: 2, met: 1, visibility: "dm" }], ["g3", inR(2), { number: 3, met: 1 }], ["h", { x: 4, y: 4 }, { sceneId: "s2", met: 2 }]]);
      s.scenes.s1 = { ...s.scenes.s1!, numbers: { names: { Goblin: [1, 3] } } };
      s.scenes.s2 = { ...s.scenes.s2!, fogEnabled: false, numbers: { names: { Goblin: [2, 1] } } };
      s.numbering = { rev: 0, groups: 2 };
      s.tokens.pc2 = token("pc2", { kind: "pc", name: "Ayla", ownerIds: ["p1"], disposition: "ally", sceneId: "s2", x: 1, y: 1 });
    };
    const pair = await open(t, states(marked));
    same(pair, "opened");
    for (const p of [{ sceneId: "s2", x: 6, y: 6 }, { sceneId: "s1", ...inR(1) }]) {
      await inOne(pair, 0, {}, `g2 to ${p.sceneId} in A`, (room) => room.apply("dm2", patch("g2", p)));
    }
    await steps(pair, {}, [["g2 shown", (room) => room.apply("dm", patch("g2", { visibility: "all" }))]]);
    assert.deepEqual(p1Numbers(pair, "g2 shown"), { g1: 1, g2: 2, g3: 3 });
    await steps(pair, {}, [
      ["g3 to s2", (room) => room.apply("dm", patch("g3", { sceneId: "s2", x: 6, y: 6 }))],
      ["the players go to s2", (room) => room.apply("dm", { t: "room.setPlayerScene", sceneId: "s2" })],
    ]);
    assert.deepEqual(p1Numbers(pair, "on s2"), { h: 1, g3: 2 }, "no second Goblin 1, and Goblin 3 meets s2's Goblins as their second");
  });

  test("K28: on a scene where players see for themselves, a namesake no holder sees changes nothing, and one P2 alone was sent counts", async (t) => {
    const perPlayer = (s: RoomState) => {
      s.scenes.s1 = { ...s.scenes.s1!, vision: { on: true, light: "bright", perPlayer: true } };
      s.holders = { s1: { sceneId: "s1", rev: 0, entries: [{ memberId: "p1", on: true }, { memberId: "p2", on: true }] } };
      s.tokens.b = { ...s.tokens.b!, ...inF(0, 4) };
      goblins(s, [["gf", inF(1, 1)], ["gr", inF(4, 4), { visibility: "dm" }]]);
    };
    const hidden = { a: ["zq1"] };
    const pair = await open(t, states(perPlayer, (s) => goblins(s, [["zq1", { x: 40, y: 20 }]])));
    await steps(pair, hidden, [
      ["P2 meets one", (room) => room.apply("p2", move("b", inF(0, 3)))],
      ["P1 meets another", (room) => room.apply("dm", patch("gr", { visibility: "all", ...inR(0) }))],
    ]);
    const p1 = p1Numbers(pair, "P1 meets another");
    assert.equal(p1.gr, 2, "P1 reads Goblin 2 beside the one P2 alone was sent");
    assert.equal(pair[0].p1View().tokens.gf, undefined, "P1 holds no copy of the first");
  });

  test("K33b: with a name at its most numbers, the first-met Goblin, hidden and kept in room A and brought back by undo in room B, reads Goblin 1 in both", async (t) => {
    const full = (s: RoomState) => {
      goblins(s, [["g1", inR(0), { met: 1, visibility: "dm" }]]);
      s.scenes.s1 = { ...s.scenes.s1!, numbers: { names: { Goblin: [1, NUMBERS_MOST] } } };
      s.numbering = { rev: 0, groups: 1 };
    };
    const pair = await open(t, states(full));
    await inOne(pair, 1, {}, "g1 deleted in B", (room) => room.apply("dm2", { t: "token.delete", tokenId: "g1" }));
    await inOne(pair, 1, {}, "and brought back", (room) => undoNewest(room, "undo", "play", "dm2"));
    await steps(pair, {}, [["g1 shown", (room) => room.apply("dm", patch("g1", { visibility: "all" }))]]);
    assert.deepEqual(p1Names(pair, ["g1"], "shown"), { g1: "Goblin 1" });
  });

  test("K41: a met creature P1 owns reads the table's number and no group mark, in rooms that differ out of sight", async (t) => {
    const hidden = { a: ["zq1"] };
    const pair = await open(
      t,
      states(
        (s) => goblins(s, [["g1", inR(0), { ownerIds: ["p1"] }], ["g2", inF(0)]]),
        (s) => goblins(s, [["zq1", inF(1, 2)]]),
      ),
    );
    await steps(pair, hidden, [
      ["g1 met", (room) => room.apply("dm", move("g1", inR(1)))],
      ["g2 met", (room) => room.apply("dm", move("g2", inR(0, 2)))],
      ["g1 renamed by the DM", (room) => room.apply("dm", patch("g1", { name: "Orc" }))],
      ["g1 named back", (room) => room.apply("dm", patch("g1", { name: "Goblin" }))],
    ]);
    const view = pair[0].p1View().tokens.g1 as Partial<Token>;
    assert.equal(view.met, undefined, "P1's own creature carries no group mark");
    assert.equal(view.number, pair[0].state.tokens.g1!.number, "P1's own creature carries the table's number");
  });
});

describe("old rooms keep the numbers the party sees, once", () => {
  test("K12: Goblins 1 and 2 in sight stay, 3 to 6 hidden in room A alone are dropped, and the next met is 3 in both", async (t) => {
    const hidden = { a: ["zq3", "zq4", "zq5", "zq6"] };
    const pair = await open(
      t,
      states(
        (s) => goblins(s, [["g1", inR(0), { number: 1 }], ["g2", inR(1), { number: 2 }], ["g7", inF(0)]]),
        (s) => goblins(s, [3, 4, 5, 6].map((n) => [`zq${n}`, inF(1, n - 3), { number: n }] as [string, { x: number; y: number }, Partial<Token>])),
      ),
      OLD,
    );
    same(pair, "loaded", hidden);
    assert.deepEqual(p1Numbers(pair, "the first snapshot"), { g1: 1, g2: 2 });
    await steps(pair, hidden, [["a new one met", (room) => room.apply("dm", move("g7", inR(2)))]]);
    assert.deepEqual(p1Numbers(pair, "a new one met"), { g1: 1, g2: 2, g7: 3 });
  });

  test("K13: an old Goblin 7 on a scene players had not reached reads plain when they go there, as a plain Goblin does", async (t) => {
    const second = (s: RoomState) => {
      s.scenes.s2 = { ...s.scenes.s2!, fogEnabled: false };
      s.tokens.pc2 = token("pc2", { kind: "pc", name: "Ayla", ownerIds: ["p1"], disposition: "ally", sceneId: "s2", x: 1, y: 1 });
    };
    const pair = await open(
      t,
      states(
        second,
        // And one P1 owns there, hidden from the party, which no meeting reaches.
        (s) => goblins(s, [["g", { x: 4, y: 4 }, { sceneId: "s2", number: 7 }], ["own", { x: 6, y: 4 }, { sceneId: "s2", name: "Kobold", number: 3, ownerIds: ["p1"], visibility: "dm" }]]),
        (s) => goblins(s, [["g", { x: 4, y: 4 }, { sceneId: "s2" }], ["own", { x: 6, y: 4 }, { sceneId: "s2", name: "Kobold", ownerIds: ["p1"], visibility: "dm" }]]),
      ),
      OLD,
    );
    await steps(pair, {}, [["the players go there", (room) => room.apply("dm", { t: "room.setPlayerScene", sceneId: "s2" })]]);
    assert.ok(pair[0].p1View().tokens.own, "P1 holds its own hidden Goblin");
    assert.deepEqual(p1Names(pair, ["g", "own"], "there"), { g: "Goblin", own: "Kobold" });
    assert.deepEqual(p1Numbers(pair, "there"), {});
  });

  test("K14: an old Goblin 7 on a floor players had not opened reads plain once it is shown, as a plain Goblin does", async (t) => {
    const floored = (s: RoomState) => {
      const ground = s.scenes.s1!;
      s.scenes.s1 = { ...ground, floor: { of: "s1", level: 0, name: "Ground floor", height: 10 } } as Scene;
      s.scenes.up = scene("up", { name: ground.name, order: 0, bounds: ground.bounds, floor: { of: "s1", level: 1, name: "Upper floor", height: 10 } });
    };
    const pair = await open(
      t,
      states(
        floored,
        (s) => goblins(s, [["g", { x: 4, y: 4 }, { sceneId: "up", number: 7 }]]),
        (s) => goblins(s, [["g", { x: 4, y: 4 }, { sceneId: "up" }]]),
      ),
      OLD,
    );
    await steps(pair, {}, [["the floor shown", (room) => room.apply("dm", { t: "floor.open", sceneId: "up", open: true })]]);
    assert.ok(pair[0].p1View().tokens.g, "P1 holds the Goblin upstairs");
    assert.deepEqual(p1Names(pair, ["g"], "shown"), { g: "Goblin" });
  });

  test("K15: with a blackout on at the update nothing is adopted, and the creatures are met when it lifts", async (t) => {
    const pair = await open(
      t,
      states(
        (s) => (s.meta = { ...s.meta, view: { follow: false, blackout: true } }),
        (s) => goblins(s, [["g1", inR(0), { number: 5 }], ["g2", inR(1), { number: 9 }]]),
        (s) => goblins(s, [["g1", inR(0)], ["g2", inR(1)]]),
      ),
      OLD,
    );
    same(pair, "loaded");
    await steps(pair, {}, [["the blackout lifts", (room) => room.apply("dm", { t: "view.blackout", blackout: false })]]);
    assert.deepEqual(p1Numbers(pair, "lifted"), { g1: 1, g2: 2 });
  });

  test("K16: a creature revealed as the first op after the update takes a fresh number", async (t) => {
    const pair = await open(
      t,
      states(
        (s) => goblins(s, [["g1", inR(0), { number: 1 }], ["g2", inR(1), { number: 2 }]]),
        (s) => goblins(s, [["h", inR(2), { number: 4, visibility: "dm" }]]),
        (s) => goblins(s, [["h", inR(2), { visibility: "dm" }]]),
      ),
      OLD,
    );
    await steps(pair, {}, [["revealed", (room) => room.apply("dm", patch("h", { visibility: "all" }))]]);
    assert.deepEqual(p1Numbers(pair, "revealed"), { g1: 1, g2: 2, h: 3 });
  });

  test("K40: of 101 numbered names in sight, the 100 whose lowest creature in sight comes first keep their numbers, alike in rooms that differ out of sight", async (t) => {
    const names = Array.from({ length: 101 }, (_, i) => `Kind ${String(i).padStart(3, "0")}`);
    const pad = (n: number) => String(n).padStart(3, "0");
    const build = (s: RoomState) => {
      s.scenes.s1 = { ...s.scenes.s1!, fogEnabled: false, vision: undefined } as Scene;
      names.forEach((name, i) => {
        goblins(s, [
          [`m${pad(i)}a`, { x: i % 40, y: Math.floor(i / 40) * 2 }, { name, number: 1 }],
          [`m${pad(i)}b`, { x: i % 40, y: Math.floor(i / 40) * 2 + 1 }, { name, number: 2 }],
        ]);
      });
      for (const n of ["x", "y", "z"]) goblins(s, [[`s${n}`, { x: 45, y: 10 }, { name: `Lone ${n}` }]]);
    };
    // Room A holds, out of sight, a namesake of the last name whose id comes before every other creature's.
    const pair = await open(t, states(build, (s) => goblins(s, [["a0zq", { x: 45, y: 20 }, { name: names[100]!, visibility: "dm", number: 3 }]])), OLD);
    same(pair, "loaded", { a: ["a0zq"] });
    const numbers = p1Numbers(pair, "loaded");
    for (let i = 0; i < 100; i++) assert.equal(numbers[`m${pad(i)}a`], 1, `${names[i]} keeps its 1`);
    assert.equal(numbers[`m${pad(100)}a`], undefined, `${names[100]} reads plain`);
    assert.equal(numbers[`m${pad(100)}b`], undefined, `${names[100]}'s second reads plain`);
  });
});

describe("a batch numbers what the party holds as it closes", () => {
  // Ayla goes into room F and back in one batch, so the party's copy holds room A's Goblin there only between the two.
  const there = inF(0);
  const back = { x: 3, y: 3 };
  const bursts: Array<[string, Op[]]> = [
    ["two moves", [move("a", there), move("a", back)]],
    ["two group moves", [{ t: "token.moveMany", moves: [{ tokenId: "a", ...there }] } as Op, { t: "token.moveMany", moves: [{ tokenId: "a", ...back }] } as Op]],
  ];
  for (const [kind, burst] of bursts) {
    test(`${kind} of a party member into a room and back in one batch number nothing either room shows, and the next Goblin reads 2 in both, for P1 and the display`, async (t) => {
      const hidden = { a: ["zq1"] };
      // Batches wait as long as the app's, so both moves land in one.
      const pair = await openRooms(t, ...states((s) => goblins(s, [["g1", inR(1)]]), (s) => goblins(s, [["zq1", inF(1)]])), { batchMs: 20 });
      await each(pair, (room) => room.apply("p1", { t: "log.chat", text: "ready" }));
      same(pair, "opened", hidden);
      for (const room of pair) assert.deepEqual(await room.queue("dm2", burst), ["taken", "taken"], `${room.name}: both moves taken`);
      same(pair, `${kind} there and back`, hidden);
      assert.deepEqual(p1Numbers(pair, `${kind} there and back`), {});
      assert.equal(pair[0].state.tokens.zq1!.met, undefined, "room A's Goblin in room F was never met");
      await steps(pair, hidden, [["a Goblin made in sight", (room) => room.apply("dm", make("w", inR(0)))]]);
      assert.deepEqual(p1Numbers(pair, "a Goblin made in sight"), { g1: 1, w: 2 });
    });
  }

  test("a character's change before a walk in the same batch still gives its companion on another scene the 1 it lacked", async (t) => {
    // On s2, out of the party's copy: Goblin 2, and the first-met Goblin, which met as P2's character's companion and took no 1.
    const fixture = (s: RoomState) => {
      s.characters.c2 = character("c2", { name: "Cora", ownerIds: ["p2"] });
      s.tokens.x = creature("x", { x: 3, y: 3 }, { sceneId: "s2", met: 1, companion: { of: "c2", turn: "shared" } });
      s.tokens.y = creature("y", { x: 5, y: 3 }, { sceneId: "s2", met: 1, number: 2 });
      s.scenes.s2 = { ...s.scenes.s2!, numbers: { names: { Goblin: [1, 2] } } };
      s.numbering = { rev: 0, groups: 1 };
    };
    const pair = await openRooms(t, ...states(fixture), { batchMs: 20 });
    await each(pair, (room) => room.apply("p1", { t: "log.chat", text: "ready" }));
    for (const room of pair) assert.equal(room.state.tokens.x!.number, undefined, `${room.name}: a companion P2 plays takes no 1`);
    // No player plays Cora now, so her companion reads as a plain Goblin, and Ayla's move after it steps the batch in place.
    for (const room of pair) assert.deepEqual(await room.queue("dm", [{ t: "character.update", characterId: "c2", patch: { ownerIds: [] } } as Op, move("a", { x: 3, y: 4 })]), ["taken", "taken"]);
    same(pair, "the change and the walk");
    for (const room of pair) assert.equal(room.state.tokens.x!.number, 1, `${room.name}: the first-met Goblin takes its 1 at the batch's close`);
  });
});

void member;
