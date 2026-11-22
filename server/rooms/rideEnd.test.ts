import assert from "node:assert/strict";
import { describe, test, type TestContext } from "node:test";
import type { RoomState } from "#shared/model.ts";
import type { Op } from "#shared/protocol.ts";
import { AYLA, BREE, limitsRoom, OGRE, STAIRS_UP, withUpper } from "#shared/privTestutil.ts";
import { template, token } from "#shared/testutil.ts";
import { Room, viewOf } from "./numberingTesting.ts";

/**
 * An area a player put on a creature, or a ruler a player kept on one,
 * ends when its owner can no longer see the creature (sys.rideEnd), and
 * only then: not behind a blackout, and never on the owner's own creature.
 */

const AREA = "0199f0a0-0000-7000-8000-00000000c101";

async function opened(t: TestContext, state: RoomState): Promise<Room> {
  const room = new Room(t, "R", state, { idGate: true });
  await room.load();
  await room.apply("p1", { t: "log.chat", text: "ready" });
  return room;
}

/** A guide the DM plays, an ally of the party but no party member, so only those who see it hold it. */
const GUIDE = "guide";

function withGuide(s: RoomState, at = { x: 5, y: 7 }): RoomState {
  s.tokens[GUIDE] = token(GUIDE, { kind: "npc", name: "Guide", disposition: "ally", ...at });
  return s;
}

/** The limits room with each player seeing for themselves, P1 through Ayla in room R and P2 through Bree in room F. */
function ownSight(): RoomState {
  const s = limitsRoom();
  s.tokens[BREE] = { ...s.tokens[BREE]!, x: 26, y: 5 };
  s.scenes.s1 = { ...s.scenes.s1!, vision: { on: true, light: "bright", perPlayer: true } };
  s.holders = { s1: { sceneId: "s1", rev: 0, entries: [{ memberId: "p1", on: true }, { memberId: "p2", on: true }] } };
  return s;
}

const areaOn = (s: RoomState, on: string): RoomState => {
  s.templates[AREA] = template(AREA, { ownerId: "p1", attachedTo: on, origin: { x: 3.5, y: 7.5, z: 0 }, size: 5 });
  return s;
};

describe("a rider ends with its owner's sight", () => {
  test("K2: P1's area on the DM's guide ends for everyone when the guide walks out of P1's own sight into P2's", async (t) => {
    const room = await opened(t, areaOn(withGuide(ownSight()), GUIDE));
    assert.ok(viewOf(room.clients.p1.sent).templates[AREA], "P1 holds the area before");
    await room.apply("dm", { t: "token.move", tokenId: GUIDE, x: 27, y: 6 } as Op);
    assert.ok(viewOf(room.clients.p2.sent).tokens[GUIDE], "P2 sees the guide");
    assert.equal(viewOf(room.clients.p1.sent).tokens[GUIDE], undefined, "P1 does not");
    assert.equal(room.state.templates[AREA], undefined, "the area is removed");
    assert.equal(viewOf(room.clients.p2.sent).templates[AREA], undefined, "P2 sees the area go");
    assert.ok(room.db.stored.some((op) => op.t === "sys.rideEnd"), "the server's op removes it");
  });

  test("K5: a blackout over a riding area whose creature stays in sight ends nothing, and the area is there when it lifts", async (t) => {
    const room = await opened(t, areaOn(limitsRoom(), OGRE));
    await room.apply("dm", { t: "view.blackout", blackout: true } as Op);
    assert.ok(room.state.templates[AREA], "the area stays behind the blackout");
    await room.apply("dm", { t: "view.blackout", blackout: false } as Op);
    assert.ok(viewOf(room.clients.p1.sent).templates[AREA], "P1 holds the area again");
    assert.equal(room.db.stored.some((op) => op.t === "sys.rideEnd"), false, "nothing ends");
  });

  test("K6: an area on P1's own creature stays when the DM hides the creature", async (t) => {
    const room = await opened(t, areaOn(limitsRoom(), AYLA));
    await room.apply("dm", { t: "token.update", tokenId: AYLA, patch: { visibility: "dm" } } as Op);
    assert.ok(room.state.templates[AREA], "the area stays");
  });

  test("K8: P1's area on the guide ends when the guide climbs to a floor no creature of the party stands on", async (t) => {
    const room = await opened(t, areaOn(withUpper(withGuide(limitsRoom()), { x: 5, y: 7 }), GUIDE));
    await room.apply("dm", { t: "token.climb", tokenId: GUIDE, linkId: STAIRS_UP } as Op);
    assert.equal(room.state.tokens[GUIDE]!.sceneId, "up", "the guide is on the Upper floor");
    assert.equal(room.state.templates[AREA], undefined, "the area is removed");
    assert.equal(viewOf(room.clients.p1.sent).templates[AREA], undefined, "P1's copy lets it go");
  });

  test("a player who joins the room's sight holders in the batch is read after they join, so their area on a creature their own sight holds stays", async (t) => {
    const state = areaOn(withGuide(limitsRoom()), GUIDE);
    state.scenes.s1 = { ...state.scenes.s1!, vision: { on: true, light: "bright", perPlayer: true } };
    // Nobody holds sight yet: P1 owns Ayla, who sees the guide, and joins when the batch's explore step runs.
    state.holders = {};
    state.tokens[BREE] = { ...state.tokens[BREE]!, ownerIds: [] };
    state.characters[BREE] = { ...state.characters[BREE]!, ownerIds: [] };
    const room = new Room(t, "R", state, { idGate: true });
    await room.load();
    await room.apply("p1", { t: "log.chat", text: "ready" } as Op);
    assert.deepEqual(room.state.holders.s1?.entries, [{ memberId: "p1", on: true }], "P1 joined in that batch");
    assert.ok(viewOf(room.clients.p1.sent).tokens[GUIDE], "and sees the guide for themselves");
    assert.ok(room.state.templates[AREA], "the area stays");
    assert.equal(room.db.stored.some((op) => op.t === "sys.rideEnd"), false, "nothing ends, as it would if the step read P1 before they joined");
  });

  test("an area on a creature a player still sees stays through the DM's moves", async (t) => {
    const room = await opened(t, areaOn(limitsRoom(), OGRE));
    await room.apply("dm", { t: "token.move", tokenId: OGRE, x: 9, y: 6 } as Op);
    assert.ok(room.state.templates[AREA], "the area stays");
    assert.equal(room.db.stored.some((op) => op.t === "sys.rideEnd"), false, "nothing ends");
  });
});
