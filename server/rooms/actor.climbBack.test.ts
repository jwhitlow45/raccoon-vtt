import assert from "node:assert/strict";
import { describe, test, type TestContext } from "node:test";
import { ANA, GROUND, UPPER, thornToken, tower, withOpening, withStairs } from "#shared/floorLinksTestutil.ts";
import type { RoomState } from "#shared/model.ts";
import { projectState } from "#shared/project.ts";
import type { Op } from "#shared/protocol.ts";
import { scopeActor } from "./undoScopeTesting.ts";

/*
 * A player's undo and redo of a climb read the stairs' rev and `made`, which
 * no player gets, only while the player's copy holds both ends
 * (docs/design/design-v1-floors.md phase 4, 8.2, FLR4-SOL-01 and
 * FLR4-OPUS-6). An edit of one end moves both ends' rev, so a check that
 * compared the end Ana sees would answer for a far end the DM moved under
 * fog. Twin rooms, through the room actor itself, differ only in that
 * hidden edit and give Ana the same copy, the same answer and the same
 * words.
 *
 * The tower's stairs: l1 on Ground floor at 3, 3, 2 by 1, up to l2 on Upper
 * floor at the same squares. Ana (p1) owns Thorn, who stands on l1.
 */

const climb: Op = { t: "token.climb", tokenId: "thorn", linkId: "l1" };
const fog = (sceneId: string): Op => ({ t: "scene.update", sceneId, patch: { fogEnabled: true } });
/** Moves one end alone to other squares of its floor, which stairs on squares may do (8.2). */
const moveEnd = (linkId: string): Op => ({ t: "floorLink.update", linkId, patch: { rect: { x: 12, y: 12, w: 2, h: 1 } } });

async function room(t: TestContext, state: RoomState) {
  const { actor, connect } = await scopeActor(t, state, { idGate: false });
  const dm = await connect(state.members.dm1!, "dm");
  const ana = await connect(state.members.p1!, "player");
  return { dm, ana, now: () => actor.committed.state };
}

type Twin = Awaited<ReturnType<typeof room>>;

const copy = (r: Twin) => projectState(r.now(), ANA, { sceneId: null });
const words = (ev: { rejects?: { message: string }[] }) => ev.rejects?.[0]?.message ?? "ok";

/**
 * Two rooms through the same ops, but for `edit`, which the second alone
 * plays on the end Ana is about to be withheld, and her undo or redo in
 * each. The first plays the DM's fog op again in its place, so both rooms
 * count the same ops.
 */
async function twins(t: TestContext, before: (r: Twin) => Promise<void>, fogged: string, edited: string, direction: "undo" | "redo") {
  const [plain, edited_] = [await room(t, withStairs(tower())), await room(t, withStairs(tower()))];
  for (const r of [plain, edited_]) {
    await before(r);
    await r.dm.apply(fog(fogged));
  }
  await plain.dm.apply(fog(fogged));
  await edited_.dm.apply(moveEnd(edited));
  assert.notDeepEqual(plain.now().floorLinks![edited]!.rect, edited_.now().floorLinks![edited]!.rect, "the second room's far end moved");
  assert.deepEqual(copy(plain), copy(edited_), "Ana's copies match before she answers");
  const answers = [];
  for (const r of [plain, edited_]) answers.push(words(await r.ana.send({ t: direction, scope: "play", head: r.ana.head("play", direction).id })));
  assert.deepEqual(copy(plain), copy(edited_), "Ana's copies match after");
  return answers;
}

describe("a climb's undo and redo with a far end withheld (FLR4-SOL-01, FLR4-OPUS-6)", () => {
  test("Redo: Ana climbs and undoes, the DM fogs Upper floor and moves l2 alone in one room, and both rooms answer alike", async (t) => {
    const answers = await twins(
      t,
      async (r) => {
        await r.ana.apply(climb);
        await r.ana.restore("play", "undo");
        assert.equal(r.now().tokens.thorn!.sceneId, GROUND);
      },
      UPPER,
      "l2",
      "redo",
    );
    assert.equal(answers[0], answers[1]);
    assert.match(answers[0]!, /the stairs changed$/);
  });

  test("Undo: Ana climbs, the DM fogs Ground floor and moves l1 alone in one room, and both rooms answer alike", async (t) => {
    const answers = await twins(
      t,
      async (r) => {
        await r.ana.apply(climb);
        assert.equal(r.now().tokens.thorn!.sceneId, UPPER);
      },
      GROUND,
      "l1",
      "undo",
    );
    assert.equal(answers[0], answers[1]);
    assert.match(answers[0]!, /the stairs changed$/);
  });

  test("with both ends in her copy Ana's undo and redo still cross, and a far end she sees move answers the stairs changed", async (t) => {
    const r = await room(t, withStairs(tower()));
    await r.ana.apply(climb);
    await r.ana.restore("play", "undo");
    await r.ana.restore("play", "redo");
    assert.equal(r.now().tokens.thorn!.sceneId, UPPER);
    await r.dm.apply(moveEnd("l1"));
    assert.match(words(await r.ana.send({ t: "undo", scope: "play", head: r.ana.head("play", "undo").id })), /the stairs changed$/);
    assert.equal(r.now().tokens.thorn!.sceneId, UPPER);
  });

  test("a fall's undo with the hole withheld, and its redo with the floor below withheld, answer as an end gone does (4.5)", async (t) => {
    const holed = () => withOpening(tower({ tokens: { thorn: thornToken({ sceneId: UPPER, x: 4, y: 6 }) } }));
    const fell = async () => {
      const r = await room(t, holed());
      await r.ana.apply({ t: "token.move", tokenId: "thorn", x: 6, y: 6 });
      assert.equal(r.now().tokens.thorn!.sceneId, GROUND);
      return r;
    };
    const undo = await fell();
    await undo.dm.apply(fog(UPPER));
    assert.match(words(await undo.ana.send({ t: "undo", scope: "play", head: undo.ana.head("play", "undo").id })), /the stairs changed$/);
    assert.equal(undo.now().tokens.thorn!.sceneId, GROUND);
    const redo = await fell();
    await redo.ana.restore("play", "undo");
    await redo.dm.apply(fog(GROUND));
    assert.match(words(await redo.ana.send({ t: "redo", scope: "play", head: redo.ana.head("play", "redo").id })), /the stairs changed$/);
    assert.equal(redo.now().tokens.thorn!.sceneId, UPPER);
  });
});
