import assert from "node:assert/strict";
import { describe, test, type TestContext } from "node:test";
import type { RoomState } from "#shared/model.ts";
import type { Op } from "#shared/protocol.ts";
import { AYLA, BREE, limitsRoom, OGRE, STAIRS_UP, withUpper } from "#shared/privTestutil.ts";
import { template } from "#shared/testutil.ts";
import { Room, viewOf } from "./numberingTesting.ts";

/**
 * An area a player put on a creature, or a ruler a player kept on one,
 * ends when its owner can no longer see the creature (sys.rideEnd), and
 * only then: not behind a blackout, and never on the owner's own creature.
 */

const AREA = "0199f0a0-0000-7000-8000-00000000c101";

async function opened(t: TestContext, state: RoomState): Promise<Room> {
  const room = new Room(t, "R", state);
  await room.load();
  await room.apply("p1", { t: "log.chat", text: "ready" });
  return room;
}

/** The limits room with each player seeing for themselves, P1 through Ayla and P2 through Bree. */
function ownSight(): RoomState {
  const s = limitsRoom();
  s.scenes.s1 = { ...s.scenes.s1!, vision: { on: true, light: "bright", perPlayer: true } };
  s.holders = { s1: { sceneId: "s1", rev: 0, entries: [{ memberId: "p1", on: true }, { memberId: "p2", on: true }] } };
  return s;
}

const areaOn = (s: RoomState, on: string): RoomState => {
  s.templates[AREA] = template(AREA, { ownerId: "p1", attachedTo: on, origin: { x: 3.5, y: 7.5, z: 0 }, size: 5 });
  return s;
};

describe("a rider ends with its owner's sight", () => {
  test("K2: P1's area on Bree ends for everyone when Bree walks out of P1's own sight, while P2 still sees her", async (t) => {
    const room = await opened(t, areaOn(ownSight(), BREE));
    assert.ok(viewOf(room.clients.p2.sent).templates[AREA], "P2 holds the area before");
    await room.apply("dm", { t: "token.move", tokenId: BREE, x: 26, y: 5 } as Op);
    assert.equal(room.state.templates[AREA], undefined, "the area is removed");
    assert.ok(viewOf(room.clients.p2.sent).tokens[BREE], "P2 still sees Bree");
    assert.equal(viewOf(room.clients.p2.sent).templates[AREA], undefined, "P2 sees the area go");
    assert.equal(room.db.stored.at(-1)?.t, "sys.rideEnd", "the server's op removes it");
  });

  test("K5: a blackout over a riding area whose creature stays in sight ends nothing, and the area is there when it lifts", async (t) => {
    const room = await opened(t, areaOn(limitsRoom(), OGRE));
    await room.apply("dm", { t: "view.blackout", blackout: true } as Op);
    assert.ok(room.state.templates[AREA], "the area stays behind the blackout");
    await room.apply("dm", { t: "view.blackout", blackout: false } as Op);
    assert.ok(viewOf(room.clients.p1.sent).templates[AREA], "P1 holds the area again");
  });

  test("K6: an area on P1's own creature stays when the DM hides the creature", async (t) => {
    const room = await opened(t, areaOn(limitsRoom(), AYLA));
    await room.apply("dm", { t: "token.update", tokenId: AYLA, patch: { visibility: "dm" } } as Op);
    assert.ok(room.state.templates[AREA], "the area stays");
  });

  test("K8: P1's area on Bree ends when Bree climbs to a floor P1 does not hold", async (t) => {
    const room = await opened(t, areaOn(withUpper(limitsRoom(), { x: 3, y: 7 }), BREE));
    await room.apply("p2", { t: "token.climb", tokenId: BREE, linkId: STAIRS_UP } as Op);
    assert.equal(room.state.tokens[BREE]!.sceneId, "up", "Bree is on the Upper floor");
    assert.equal(room.state.templates[AREA], undefined, "the area is removed");
    assert.equal(viewOf(room.clients.p1.sent).templates[AREA], undefined, "P1's copy lets it go");
  });

  test("an area on a creature a player still sees stays through the DM's moves", async (t) => {
    const room = await opened(t, areaOn(limitsRoom(), OGRE));
    await room.apply("dm", { t: "token.move", tokenId: OGRE, x: 9, y: 6 } as Op);
    assert.ok(room.state.templates[AREA], "the area stays");
    assert.equal(room.db.stored.some((op) => op.t === "sys.rideEnd"), false, "nothing ends");
  });
});
