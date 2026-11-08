import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { keys } from "#shared/keys.ts";
import type { RoomState, Token, Viewer } from "#shared/model.ts";
import type { Change, ClientOp } from "#shared/protocol.ts";
import { DM, entry, P1, P2, token } from "#shared/testutil.ts";
import { setFollowTurn } from "../features/encounter/followTurn.ts";
import { ATTIC, CAVE, playerCopy, TOWER, tower, UPPER } from "../features/floors/testing.ts";
import { createRoomStore } from "./store.ts";
import { FakeClock, FakeOutbox } from "./testing.ts";

/*
 * The store on a scene of several floors (docs/design/design-v1-floors.md
 * 7.3, 8.2, 10): the floor shown apart from the scene projected, the
 * board's cut, the follow of each role, events kept per floor, and
 * prediction through the scene projected. The snapshots stand in for the
 * server's projections (FLR-B): a DM's copy holds every floor of the scene,
 * a player's only the floors they hold.
 */

const dmCopy = (state: RoomState) => ({ ...state, sight: {} });

function storeOf(viewer: Viewer, state: unknown, sceneId: string | null, role: "dm" | "player" | "display" = viewer.role) {
  const clock = new FakeClock();
  const outbox = new FakeOutbox();
  const room = createRoomStore({ roomId: "R1", you: viewer, clock, random: () => 0.5, clientId: "c1" });
  room.setOutbox(outbox);
  room.setConnection("open");
  room.applySnapshot({ t: "snapshot", seq: 1, state, you: { memberId: viewer.memberId, role, sceneId }, watermark: 0 });
  let seq = 1;
  const ev = (changes: Change[]) => room.applyEv({ t: "ev", seq: ++seq, changes });
  return { room, outbox, clock, ev, state: () => room.store.getState() };
}

const tokenAt = (state: RoomState, id: string, over: Partial<Token>): Change => ({ key: keys.token(id), value: { ...state.tokens[id]!, ...over } });

describe("a DM's floors", () => {
  test("a snapshot shows the scene's main floor, and a switch shows another floor with nothing sent and the scene projected kept", () => {
    const state = tower({ tokens: { ...tower().tokens, imp: token("imp", { sceneId: UPPER, name: "Imp" }) } });
    const s = storeOf(DM, dmCopy(state), TOWER);
    assert.deepEqual([s.state().sceneId, s.state().projectedSceneId], [TOWER, TOWER]);
    assert.deepEqual(Object.keys(s.state().floorView!.tokens).sort(), ["bree", "thorn"], "the board's cut holds the floor shown");
    assert.deepEqual(Object.keys(s.state().view!.tokens).sort(), ["bree", "imp", "thorn"], "the view keeps every floor");
    s.outbox.sent = [];
    s.room.showFloor(UPPER);
    assert.deepEqual([s.state().sceneId, s.state().projectedSceneId], [UPPER, TOWER]);
    assert.deepEqual(Object.keys(s.state().floorView!.tokens), ["imp"]);
    assert.deepEqual(s.state().floorShift, { n: 1, tokenId: null });
    assert.deepEqual(s.outbox.sent, [], "a switch of floors sends nothing");
    s.room.showFloor(CAVE);
    assert.equal(s.state().sceneId, UPPER, "another scene is no floor to show: the socket asks for it");
  });

  test("a reconnect keeps the floor shown while the snapshot holds it, and a deleted floor falls back to the main floor", () => {
    const s = storeOf(DM, dmCopy(tower()), TOWER);
    s.room.showFloor(ATTIC);
    s.room.applySnapshot({ t: "snapshot", seq: 9, state: dmCopy(tower()), you: { memberId: "dm1", role: "dm", sceneId: TOWER }, watermark: 0 });
    assert.equal(s.state().sceneId, ATTIC);
    s.ev([{ key: keys.scene(ATTIC), deleted: true }]);
    assert.equal(s.state().sceneId, TOWER);
  });

  test("a switch to a floor of another scene shows that floor once its scene's snapshot lands", () => {
    const keep = tower();
    const s = storeOf(DM, dmCopy(keep), CAVE);
    assert.equal(s.state().sceneId, CAVE);
    s.room.wantFloor(UPPER);
    s.room.trackScene({ t: "request", sceneId: TOWER });
    s.room.applySnapshot({ t: "snapshot", seq: 5, state: dmCopy(keep), you: { memberId: "dm1", role: "dm", sceneId: TOWER }, watermark: 0 });
    assert.deepEqual([s.state().sceneId, s.state().projectedSceneId], [UPPER, TOWER]);
  });

  test("a Move to floor of the selected token follows it, and another token's does not", () => {
    const state = tower();
    const s = storeOf(DM, dmCopy(state), TOWER);
    s.room.ui.select("thorn");
    s.ev([tokenAt(state, "bree", { sceneId: ATTIC })]);
    assert.equal(s.state().sceneId, TOWER, "Bree is not selected");
    s.ev([tokenAt(state, "thorn", { sceneId: UPPER })]);
    assert.equal(s.state().sceneId, UPPER);
    assert.deepEqual(s.state().floorShift, { n: 1, tokenId: "thorn" }, "the status says Thorn is on Upper floor");
  });

  test("Camera follows the turn shows the floor of whoever acts, in the same change as the turn", () => {
    const state = tower({ encounter: { rev: 0, round: 1, activeEntryId: "e-bree", entries: [entry("e-bree", { tokenId: "bree", value: 20 }), entry("e-imp", { tokenId: "imp", value: 10 })] } });
    state.tokens.imp = token("imp", { sceneId: UPPER, name: "Imp" });
    try {
      setFollowTurn(true);
      const s = storeOf(DM, dmCopy(state), TOWER);
      s.ev([{ key: keys.encounter, value: { ...state.encounter!, activeEntryId: "e-imp" } }]);
      assert.equal(s.state().sceneId, UPPER);
      setFollowTurn(false);
      s.room.showFloor(TOWER);
      s.ev([{ key: keys.encounter, value: { ...state.encounter!, activeEntryId: "e-bree", rev: 1 } }]);
      s.ev([{ key: keys.encounter, value: { ...state.encounter!, activeEntryId: "e-imp", rev: 2 } }]);
      assert.equal(s.state().sceneId, TOWER, "with the setting off, the DM stays where they are");
    } finally {
      setFollowTurn(false);
    }
  });

  test("a pending numbered create on Ground stays predicted after the DM switches to Upper: prediction reads the scene projected (FLR32-OPUS-04)", () => {
    const s = storeOf(DM, dmCopy(tower()), TOWER);
    const { rev: _rev, fogExemptAuto: _auto, ...made } = token("gob", { sceneId: TOWER, name: "Goblin" });
    const create = { t: "token.create", token: made } as ClientOp;
    s.room.dispatch(create);
    assert.ok(s.state().view!.tokens.gob, "predicted on Ground");
    s.room.showFloor(UPPER);
    // A second create while Upper shows replays the queue again, so the replay must read the scene projected, not the floor shown.
    const { rev: _rev2, fogExemptAuto: _auto2, ...second } = token("gob2", { sceneId: TOWER, name: "Goblin" });
    s.room.dispatch({ t: "token.create", token: second } as ClientOp);
    assert.ok(s.state().view!.tokens.gob, "still predicted on Upper");
    assert.ok(s.state().view!.tokens.gob2, "and the second too");
    assert.equal(s.state().floorView!.tokens.gob, undefined, "and the board on Upper draws none of it");
    assert.deepEqual(s.state().busy, {});
  });
});

describe("a player's floors (7.3)", () => {
  const opened = () => tower({ openFloors: { [UPPER]: { sceneId: UPPER, rev: 0 } } });

  test("the device follows their character, a pick holds until Back, and Back returns to the creature", () => {
    const state = opened();
    const s = storeOf(P1, playerCopy(state, [TOWER, UPPER]), TOWER);
    assert.deepEqual([s.state().sceneId, s.state().floorFollow], [TOWER, { sceneId: TOWER, tokenId: "thorn" }]);
    s.room.showFloor(UPPER);
    assert.equal(s.state().sceneId, UPPER, "a pick");
    assert.deepEqual(s.state().floorFollow, { sceneId: TOWER, tokenId: "thorn" }, "the notice's Back goes to Thorn");
    s.ev([tokenAt(state, "bree", { x: 9 })]);
    assert.equal(s.state().sceneId, UPPER, "an unrelated change keeps the pick");
    s.room.showFloor(null);
    assert.equal(s.state().sceneId, TOWER);
    s.room.showFloor(ATTIC);
    assert.equal(s.state().sceneId, TOWER, "a floor not held is no pick");
  });

  test("a pick drops when the followed creature changes floor, and the status says so", () => {
    const state = opened();
    const s = storeOf(P1, playerCopy(state, [TOWER, UPPER]), TOWER);
    s.room.showFloor(UPPER);
    s.ev([tokenAt(state, "thorn", { sceneId: UPPER })]);
    assert.equal(s.state().sceneId, UPPER);
    // Picked Ground while Thorn stands on Upper: his move down drops the pick, with no switch to say.
    s.room.showFloor(TOWER);
    const n = s.state().floorShift!.n;
    s.ev([tokenAt(state, "thorn", { sceneId: TOWER })]);
    assert.deepEqual([s.state().sceneId, s.state().floorShift?.n], [TOWER, n]);
    // Followed without a pick: Thorn moves, the device goes with him and says "Thorn is on Upper floor."
    s.ev([tokenAt(state, "thorn", { sceneId: UPPER })]);
    assert.deepEqual([s.state().sceneId, s.state().floorShift], [UPPER, { n: n + 1, tokenId: "thorn" }]);
    s.room.showFloor(TOWER);
    assert.equal(s.state().sceneId, TOWER, "a pick again, which the next move ends");
  });

  test("a pick drops when the player's turn starts, and their creature's floor shows", () => {
    const state = opened();
    state.encounter = { rev: 0, round: 1, activeEntryId: "e-bree", entries: [entry("e-thorn", { tokenId: "thorn", value: 10 }), entry("e-bree", { tokenId: "bree", value: 20 })] };
    const s = storeOf(P1, playerCopy(state, [TOWER, UPPER]), TOWER);
    s.room.showFloor(UPPER);
    s.ev([{ key: keys.encounter, value: { ...state.encounter, rev: 1, round: 1, activeEntryId: "e-thorn" } }]);
    assert.equal(s.state().sceneId, TOWER);
  });

  test("a selected creature they own is the one followed", () => {
    const state = opened();
    state.tokens.owl = token("owl", { sceneId: UPPER, name: "Owl", kind: "npc", ownerIds: ["p1"] });
    const s = storeOf(P1, playerCopy(state, [TOWER, UPPER]), TOWER);
    assert.equal(s.state().sceneId, TOWER, "their character first");
    s.room.ui.select("owl");
    assert.deepEqual(s.state().floorFollow, { sceneId: UPPER, tokenId: "owl" });
    assert.equal(s.state().sceneId, UPPER);
  });

  test("players started straight on Upper anchor there, never on a main floor they do not hold, and a blackout anchors nowhere (FLR32-ASTRA-04, ASTRA-07)", () => {
    const state = tower({ meta: { ...tower().meta, playerSceneId: UPPER } });
    const copy = playerCopy(state, [UPPER]);
    const s = storeOf(P2, copy, UPPER);
    assert.deepEqual([s.state().projectedSceneId, s.state().sceneId], [UPPER, UPPER]);
    assert.equal(s.state().view!.scenes[TOWER], undefined);
    // A blackout snapshot, then an unrelated change: the anchor stays null, though meta keeps the start floor.
    const dark = { ...copy, meta: { ...copy.meta, view: { follow: false, blackout: true } } };
    s.room.applySnapshot({ t: "snapshot", seq: 7, state: dark, you: { memberId: "p2", role: "player", sceneId: null }, watermark: 0 });
    assert.equal(s.state().projectedSceneId, null);
    s.ev([{ key: keys.member("p2"), value: { ...copy.members.p2!, name: "Bree's player" } }]);
    assert.deepEqual([s.state().projectedSceneId, s.state().sceneId], [null, null]);
    s.ev([{ key: keys.meta, value: { ...copy.meta, view: { follow: false, blackout: false } } }]);
    assert.equal(s.state().projectedSceneId, UPPER, "the blackout's end anchors on the start floor again");
  });

  test("a Look here on a floor they hold shows it, and the event lands on its own floor", () => {
    const s = storeOf(P1, playerCopy(opened(), [TOWER, UPPER]), TOWER);
    s.room.receiveEph("dm1", UPPER, { k: "focus", x: 4, y: 4, zoom: 40 });
    assert.equal(s.state().sceneId, UPPER);
    assert.equal(s.state().ephemeral.focus?.zoom, 40);
    s.room.receiveEph("dm1", ATTIC, { k: "focus", x: 1, y: 1, zoom: 20 });
    assert.equal(s.state().sceneId, UPPER, "a floor they do not hold sends nothing their way, and one that slipped through moves nothing");
  });
});

describe("events kept per floor (8.2)", () => {
  test("a ping on Upper waits on Upper while the board shows Ground, and a switch clears none", () => {
    const s = storeOf(DM, dmCopy(tower()), TOWER);
    s.room.receiveEph("p1", UPPER, { k: "ping", x: 2, y: 2 });
    s.room.receiveEph("p1", TOWER, { k: "ruler", id: "r1", points: [{ x: 1, y: 1 }], shared: true });
    assert.deepEqual([s.state().ephemeral.pings.length, Object.keys(s.state().ephemeral.rulers)], [0, ["p1|r1"]]);
    s.room.showFloor(UPPER);
    assert.deepEqual([s.state().ephemeral.pings.length, Object.keys(s.state().ephemeral.rulers)], [1, []]);
    s.room.showFloor(TOWER);
    assert.deepEqual(Object.keys(s.state().ephemeral.rulers), ["p1|r1"], "Ground's ruler is still there");
    // This device's own ping lands on the floor shown.
    s.room.recordLocalEph({ k: "ping", x: 3, y: 3 });
    s.room.showFloor(UPPER);
    assert.equal(s.state().ephemeral.pings.length, 1, "Upper keeps its one ping");
  });

  test("events time out on every floor, and nothing stays of a floor no longer held", () => {
    const s = storeOf(DM, dmCopy(tower()), TOWER);
    s.room.receiveEph("p1", UPPER, { k: "ping", x: 2, y: 2 });
    s.clock.advance(3_000);
    assert.deepEqual(s.state().ephemeralFloors, {});
    s.room.receiveEph("p1", ATTIC, { k: "ruler", id: "r2", points: [{ x: 1, y: 1 }], shared: true });
    s.ev([{ key: keys.scene(ATTIC), deleted: true }]);
    assert.deepEqual(Object.keys(s.state().ephemeralFloors), []);
  });
});

describe("a table display follows the party (7.3, D-261102-491)", () => {
  const displayCopy = (state: RoomState, partyFloors: string[]) => {
    const copy = playerCopy(state, [TOWER, UPPER, ATTIC]);
    return { ...copy, meta: { ...copy.meta, partyFloors } };
  };
  const TV: Viewer = { memberId: "tv1", role: "player" };

  test("the floor with the most party members, the one shown last on a tie, else the lowest, and the start floor with none", () => {
    const state = tower();
    const s = storeOf(TV, displayCopy(state, [UPPER]), TOWER, "display");
    assert.equal(s.state().sceneId, UPPER);
    s.ev([{ key: keys.meta, value: { ...displayCopy(state, [TOWER, UPPER]).meta } }]);
    assert.equal(s.state().sceneId, UPPER, "a tie keeps the floor shown");
    s.ev([{ key: keys.meta, value: { ...displayCopy(state, [ATTIC, TOWER]).meta } }]);
    assert.equal(s.state().sceneId, TOWER, "the lowest of them");
    s.ev([{ key: keys.meta, value: { ...displayCopy(state, []).meta } }]);
    assert.equal(s.state().sceneId, TOWER, "the start floor");
    s.room.showFloor(ATTIC);
    assert.equal(s.state().sceneId, TOWER, "a display picks nothing");
  });

  test("following the DM, it shows the DM's floor while it holds it", () => {
    const s = storeOf(TV, displayCopy(tower(), [TOWER]), TOWER, "display");
    s.room.receiveEph("dm1", ATTIC, { k: "view", x: 4, y: 4, w: 10, h: 8 });
    assert.equal(s.state().sceneId, TOWER, "Fit the map keeps the party's floor");
    s.room.followDm(true);
    assert.equal(s.state().sceneId, ATTIC);
    assert.equal(s.state().ephemeral.view?.w, 10);
    s.room.followDm(false);
    assert.equal(s.state().sceneId, TOWER);
  });
});
