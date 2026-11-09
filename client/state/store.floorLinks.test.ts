import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { ANA, GROUND, UPPER, onThornsTurn, tower, withStairs } from "#shared/floorLinksTestutil.ts";
import { keys } from "#shared/keys.ts";
import type { FloorLink, RoomState, Viewer } from "#shared/model.ts";
import { ownEntry } from "#shared/records.ts";
import { DM } from "#shared/testutil.ts";
import { createRoomStore } from "./store.ts";
import { FakeClock, FakeOutbox } from "./testing.ts";

/*
 * A climb's prediction in the store (docs/design/design-v1-floors.md
 * phase 2, 6.4, D-261109-102): the DM viewing the tower's floors predicts
 * a climb at once, pricing it by the upper floor's height, or 10 ft where
 * it stores none. A player's waits for the server, even holding both
 * ends, since their copy holds no heights. The snapshots stand in for the
 * server's projections: the DM's holds every end as stored, the player's
 * the ends cut as project.ts cuts them.
 */

const climb = (linkId: string) => ({ t: "token.climb" as const, tokenId: "thorn", linkId });

function storeOf(viewer: Viewer, state: unknown, sceneId: string) {
  const clock = new FakeClock();
  const outbox = new FakeOutbox();
  const room = createRoomStore({ roomId: "R1", you: viewer, clock, random: () => 0.5, clientId: "c1" });
  room.setOutbox(outbox);
  room.setConnection("open");
  room.applySnapshot({ t: "snapshot", seq: 1, state, you: { memberId: viewer.memberId, role: viewer.role, sceneId }, watermark: 0 });
  return { room, outbox, state: () => room.store.getState() };
}

/** Upper floor's height set, or taken away so it reads 10 ft. */
function withHeight(s: RoomState, height: number | undefined): RoomState {
  const { height: _h, ...floor } = s.scenes[UPPER]!.floor!;
  return { ...s, scenes: { ...s.scenes, [UPPER]: { ...s.scenes[UPPER]!, floor: height === undefined ? floor : { ...floor, height } } } };
}

/** Ana's copy holding both floors: every end cut (no pair, ground or seq, its way), and no floor's height. */
function anaCopy(s: RoomState): RoomState {
  const scenes = Object.fromEntries(
    Object.entries(s.scenes).map(([id, scene]) => {
      if (!scene.floor) return [id, scene];
      const { height: _h, ...floor } = scene.floor;
      return [id, { ...scene, floor }];
    }),
  );
  const cut = (l: FloorLink, dir: "up" | "down") => {
    const { pair: _p, ground: _g, made: _m, ...rest } = l;
    return { ...rest, dir };
  };
  return { ...s, scenes, sight: {}, floorLinks: { l1: cut(s.floorLinks!.l1!, "up"), l2: cut(s.floorLinks!.l2!, "down") } } as unknown as RoomState;
}

describe("a climb's prediction (6.4)", () => {
  test("the DM's predicts it up and down, its leg priced by Upper floor's height, 20 ft, then 10 ft where none is stored", () => {
    for (const [height, ft] of [[20, 20], [undefined, 10]] as const) {
      const s = onThornsTurn(withHeight(withStairs(tower(), { rect: { x: 3, y: 3, w: 1, h: 1 } }), height));
      const dm = storeOf(DM, { ...s, sight: {} }, GROUND);
      dm.room.dispatch(climb("l1"));
      const up = ownEntry(dm.state().view!.tokens, "thorn")!;
      assert.equal(up.sceneId, UPPER, `predicted up, ${height}`);
      assert.equal(up.path?.stops.at(-1)?.moved, ft, `the leg up costs ${ft} ft`);
      assert.equal(dm.state().pending.length, 1);
      dm.room.dispatch(climb("l2"));
      const down = ownEntry(dm.state().view!.tokens, "thorn")!;
      assert.equal(down.sceneId, GROUND, `predicted down, ${height}`);
      assert.equal(down.path?.stops.at(-1)?.moved, ft, `the leg down costs ${ft} ft`);
      assert.equal(down.path?.prior?.moved, ft, "and the climb up is in prior");
    }
  });

  test("a player holding both ends waits for the server: pending, nothing predicted, until the server's change lands", () => {
    const s = withHeight(withStairs(tower(), { rect: { x: 3, y: 3, w: 1, h: 1 } }), 20);
    const ana = storeOf(ANA, anaCopy(s), GROUND);
    ana.room.dispatch(climb("l1"));
    assert.equal(ana.state().pending.length, 1, "sent");
    assert.equal(ownEntry(ana.state().view!.tokens, "thorn")!.sceneId, GROUND, "no predicted move");
    assert.equal(ana.state().sceneId, GROUND);
    // The server's change and its answer: the device follows Thorn upstairs.
    const thorn = ownEntry(ana.state().view!.tokens, "thorn")!;
    const n = ana.state().pending[0]!.n;
    ana.room.applyEv({ t: "ev", seq: 2, changes: [{ key: keys.token("thorn"), value: { ...thorn, sceneId: UPPER, rev: thorn.rev + 1 } }], acks: [n] });
    assert.deepEqual(ana.state().pending, [], "answered");
    assert.equal(ownEntry(ana.state().view!.tokens, "thorn")!.sceneId, UPPER);
    assert.equal(ana.state().sceneId, UPPER, "the device follows Thorn");
  });
});
