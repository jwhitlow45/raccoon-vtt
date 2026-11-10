import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { RoomState, Token } from "#shared/model.ts";
import { character, reveal, scene } from "#shared/testutil.ts";
import { creature, freshView, inF, inR, liveIsFresh, move, numberingRoom, patch, Room, viewOf, type Who } from "./numberingTesting.ts";

/**
 * Creature numbers on every copy at once: an open DM socket, a second DM's,
 * each player's and a fresh snapshot of each read the same number for a
 * creature at every step, across restarts and a replay from a snapshot
 * and the rows after it.
 */

function fixture(): RoomState {
  const s = numberingRoom();
  s.characters.thorn = character("thorn", { name: "Thorn", ownerIds: ["p2"] });
  s.tokens.g1 = creature("g1", inR(0));
  s.tokens.g2 = creature("g2", inF(0));
  s.tokens.g3 = creature("g3", inF(1));
  return s;
}

const SOCKETS: Who[] = ["dm", "dm2", "p1", "p2"];

/** Every open socket's view is a fresh snapshot, and each reads the creature's number as the DM's does, where it holds the creature. */
function alike(room: Room, ids: readonly string[], what: string): Record<string, number | undefined> {
  for (const who of SOCKETS) liveIsFresh(room, who, what);
  const dm = viewOf(room.clients.dm.sent).tokens as Record<string, Partial<Token>>;
  const out: Record<string, number | undefined> = {};
  for (const id of ids) {
    out[id] = dm[id]?.number;
    for (const who of SOCKETS) {
      const t = (viewOf(room.clients[who].sent).tokens as Record<string, Partial<Token>>)[id];
      if (t) assert.equal(t.number, dm[id]?.number, `${what}: ${who} reads ${id}'s number as the DM does`);
    }
  }
  return out;
}

describe("creature numbers read alike on every copy", () => {
  test("K30: restarts between meetings, a replay from a snapshot and its rows, and two DM sockets keep one set of numbers and labels", async (t) => {
    const room = new Room(t, "room", fixture(), { snapshotOps: 3 });
    await room.load();
    await room.apply("dm", move("g1", inR(1)));
    await room.apply("dm", move("g2", inR(0, 2)));
    assert.deepEqual(alike(room, ["g1", "g2", "g3"], "two met"), { g1: 1, g2: 2, g3: undefined });
    await room.restart(false);
    assert.deepEqual(alike(room, ["g1", "g2", "g3"], "after a crash"), { g1: 1, g2: 2, g3: undefined });
    await room.apply("dm", move("g3", inR(2, 2)));
    const register = structuredClone(room.state.scenes.s1!.numbers);
    await room.restart(true);
    assert.deepEqual(alike(room, ["g1", "g2", "g3"], "after a deploy"), { g1: 1, g2: 2, g3: 3 });
    assert.deepEqual(room.state.scenes.s1!.numbers, register, "the register after a deploy");
    // Rows after the snapshot replay to the same room.
    await room.apply("dm", patch("g2", { name: "Orc" }));
    await room.apply("dm", patch("g2", { name: "Goblin" }));
    const before = structuredClone(room.state);
    await room.restart(false);
    assert.deepEqual(room.state.tokens, before.tokens, "the creatures after a replay");
    assert.deepEqual(room.state.scenes, before.scenes, "the scenes after a replay");
    assert.deepEqual(room.state.numbering, before.numbering, "the group count after a replay");
    assert.deepEqual(alike(room, ["g1", "g2", "g3"], "after a replay"), { g1: 1, g2: 4, g3: 3 });
  });

  test("K39: a numbered creature made a player's companion, that player made a DM and back, and its character's owner changed, reads one number everywhere", async (t) => {
    // A hex scene under fog with its middle revealed, so the DM's copy of a creature players see there carries that mark beside its number.
    const s = fixture();
    s.scenes.s1 = scene("s1", { gridShape: "hexRows", fogEnabled: true });
    s.buildChunks = {};
    reveal(s, "s1", { x: 0, y: 0, w: 16, h: 12 });
    s.tokens.g2 = creature("g2", { x: 20, y: 20 });
    const room = new Room(t, "room", s);
    await room.load();
    await room.apply("dm", move("g1", { x: 4, y: 4 }));
    await room.apply("dm", move("g2", { x: 6, y: 4 }));
    const ids = ["g1", "g2"];
    assert.deepEqual(alike(room, ids, "two met"), { g1: 1, g2: 2 });
    await room.apply("dm", patch("g2", { companion: { of: "thorn", turn: "shared" } }));
    assert.deepEqual(alike(room, ids, "P2's companion"), { g1: 1, g2: undefined });
    room.clock.now += 1_000;
    await room.actor.sys({ t: "sys.memberSetKind", memberId: "p2", kind: "dm" });
    await room.settle();
    assert.deepEqual(alike(room, ids, "P2 a DM"), { g1: 1, g2: 2 });
    room.clock.now += 1_000;
    await room.actor.sys({ t: "sys.memberSetKind", memberId: "p2", kind: "player" });
    await room.settle();
    assert.deepEqual(alike(room, ids, "P2 a player again"), { g1: 1, g2: undefined });
    await room.apply("dm", { t: "character.update", characterId: "thorn", patch: { ownerIds: [] } });
    assert.deepEqual(alike(room, ids, "Thorn no player's"), { g1: 1, g2: 2 });
    await room.apply("dm", { t: "character.update", characterId: "thorn", patch: { ownerIds: ["p1"] } });
    assert.deepEqual(alike(room, ids, "Thorn P1's"), { g1: 1, g2: undefined });
    assert.equal((viewOf(room.clients.dm.sent).tokens.g1 as Partial<Token> & { seenAll?: true }).seenAll, true, "the DM's copy marks what every holder saw");
    const fresh = freshView(room, "dm1", "dm", room.clients.dm.conn.sceneId).tokens as Record<string, Partial<Token>>;
    assert.equal(fresh.g2?.number, undefined, "a fresh DM snapshot reads no number on a party member's companion");
  });
});
