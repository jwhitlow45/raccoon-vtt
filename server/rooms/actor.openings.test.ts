import assert from "node:assert/strict";
import { describe, test, type TestContext } from "node:test";
import { GROUND, UPPER, thornToken, tower, withOpening } from "#shared/floorLinksTestutil.ts";
import { holderTileKey } from "#shared/keys.ts";
import type { RoomState, Token } from "#shared/model.ts";
import { openTower, pc, subsOf, withAll } from "#shared/openingsTestutil.ts";
import type { Op } from "#shared/protocol.ts";
import { decodeTile, getBit } from "#shared/rules/fog.ts";
import { token } from "#shared/testutil.ts";
import { scopeActor, type ScopeClient } from "./undoScopeTesting.ts";

/*
 * Openings through the room actor itself (docs/design/design-v1-floors.md
 * phase 4): a player's step of a fall keeps its records and no card, its
 * undo and redo go through the actor's restore, and the explore step
 * explores every floor at once with each floor's joins pending (7.2). The
 * reducer's and the stacks' parts have their own tests
 * (shared/reducer/falls.test.ts, undo.openings.test.ts).
 *
 * The tower's opening: o1, the hole on Upper floor, 2 by 2 at 6, 6, over o2
 * on Ground floor. Ana (p1) owns Thorn.
 */

const move = (tokenId: string, x: number, y: number): Op => ({ t: "token.move", tokenId, x, y });

async function room(t: TestContext, state: RoomState) {
  const { actor, connect } = await scopeActor(t, state, { idGate: false });
  const dm = await connect(state.members.dm1!, "dm");
  const ana = await connect(state.members.p1!, "player");
  return { actor, dm, ana, now: () => actor.committed.state };
}

const restore = (client: ScopeClient, direction: "undo" | "redo") => client.send({ t: direction, scope: "play", head: client.head("play", direction).id });
/** The room's fall cards, none read as an empty list: the reducer keeps an emptied collection, a stored room drops it. */
const cards = (r: { now: () => RoomState }) => ({ ...r.now().falls });
const refused = (ev: { rejects?: { message: string }[] }) => ev.rejects?.[0]?.message;

function holed(over: Partial<RoomState> = {}, thorn: Partial<Token> = {}, rect?: { x: number; y: number; w: number; h: number }): RoomState {
  return withOpening(tower({ tokens: { thorn: thornToken({ sceneId: UPPER, x: 4, y: 6, ...thorn }) }, ...over }), rect ? { rect } : {});
}

describe("a player's fall through the actor (4.5)", () => {
  test("Ana's Undo takes Thorn back up and the card away, her Redo down again with the same card, and Undo again", async (t) => {
    const r = await room(t, holed());
    await r.ana.apply(move("thorn", 6, 6));
    const [card] = Object.values(r.now().falls ?? {});
    assert.ok(card);
    assert.equal(r.now().tokens.thorn!.sceneId, GROUND);
    assert.equal(r.ana.head().label, "moving Thorn");
    await restore(r.ana, "undo");
    assert.deepEqual([r.now().tokens.thorn!.sceneId, r.now().tokens.thorn!.x], [UPPER, 4]);
    assert.deepEqual(cards(r), {}, "the card goes with the undo");
    await restore(r.ana, "redo");
    assert.equal(r.now().tokens.thorn!.sceneId, GROUND);
    assert.deepEqual(cards(r), { [card.id]: card }, "the redo writes back the card the undo removed");
    await restore(r.ana, "undo");
    assert.deepEqual([r.now().tokens.thorn!.sceneId, cards(r)], [UPPER, {}]);
  });

  test("after the DM dismisses the card Ana's Undo and Redo move Thorn and write no card back", async (t) => {
    const r = await room(t, holed());
    await r.ana.apply(move("thorn", 6, 6));
    const fallId = Object.keys(r.now().falls ?? {})[0]!;
    await r.dm.apply({ t: "fall.settle", fallId });
    await restore(r.ana, "undo");
    assert.equal(r.now().tokens.thorn!.sceneId, UPPER);
    await restore(r.ana, "redo");
    assert.deepEqual([r.now().tokens.thorn!.sceneId, cards(r)], [GROUND, {}]);
  });

  test("a hidden goblin Thorn drags comes back up as a silent passenger, and its card stays for the DM", async (t) => {
    const wide = { x: 6, y: 6, w: 4, h: 4 };
    const state = holed({}, { x: 3, y: 7 }, wide);
    state.tokens.goblin = token("goblin", { sceneId: UPPER, name: "Goblin", x: 2, y: 7, visibility: "dm", attached: { to: "thorn", kind: "drag" } });
    const r = await room(t, state);
    await r.ana.apply(move("thorn", 8, 7));
    assert.deepEqual([r.now().tokens.thorn!.sceneId, r.now().tokens.goblin!.sceneId], [GROUND, GROUND]);
    const goblinCard = Object.values(r.now().falls ?? {}).find((c) => c.tokenId === "goblin")!;
    assert.ok(goblinCard);
    await restore(r.ana, "undo");
    assert.deepEqual([r.now().tokens.thorn!.sceneId, r.now().tokens.goblin!.sceneId], [UPPER, UPPER]);
    assert.deepEqual(cards(r), { [goblinCard.id]: goblinCard }, "Ana's undo removes Thorn's card alone");
  });

  test("a goblin in the dark Thorn drags into a lit hall below, seen only after the walk, keeps its card through Ana's undo", async (t) => {
    const wide = { x: 6, y: 6, w: 4, h: 4 };
    const state = holed({}, { x: 3, y: 7 }, wide);
    state.scenes[UPPER] = { ...state.scenes[UPPER]!, vision: { on: true, light: "dark" } };
    state.scenes[GROUND] = { ...state.scenes[GROUND]!, vision: { on: true, light: "bright" } };
    state.tokens.goblin = token("goblin", { sceneId: UPPER, name: "Goblin", x: 2, y: 7, attached: { to: "thorn", kind: "drag" } });
    const r = await room(t, state);
    await r.ana.apply(move("thorn", 8, 7));
    assert.deepEqual([r.now().tokens.thorn!.sceneId, r.now().tokens.goblin!.sceneId], [GROUND, GROUND]);
    const goblinCard = Object.values(r.now().falls ?? {}).find((c) => c.tokenId === "goblin")!;
    await restore(r.ana, "undo");
    assert.equal(r.now().tokens.thorn!.sceneId, UPPER);
    assert.deepEqual(cards(r), { [goblinCard.id]: goblinCard }, "received at the op: as the room stood before it");
  });

  test("a redo across a wall built on the walk since is refused, and Thorn stays where the undo left it", async (t) => {
    const blocked = holed();
    blocked.scenes[UPPER] = { ...blocked.scenes[UPPER]!, blockMovement: true };
    const r = await room(t, blocked);
    await r.ana.apply(move("thorn", 6, 6));
    await restore(r.ana, "undo");
    await r.dm.apply({ t: "build.edge", sceneId: UPPER, edges: [{ key: "5,6,w", feature: { kind: "wall" } }] });
    assert.equal(refused(await restore(r.ana, "redo")), "could not redo moving Thorn: a wall is in the way");
    assert.deepEqual([r.now().tokens.thorn!.sceneId, cards(r)], [UPPER, {}]);
  });
});

describe("the explore step through the actor (7.2, D-261119-100)", () => {
  test("Ana joining upstairs borrows her own view above into her column below in the same batch, though Ground floor is explored first", async (t) => {
    // Both floors per-player and dark. Ana's scout upstairs stands beside the hole, her scout below far from it.
    const state = withAll(openTower({}, { perPlayer: [GROUND, UPPER] }), [pc("scoutAbove", "p1", UPPER, 5, 6, {}, "Darkvision 10 ft"), pc("scoutBelow", "p1", GROUND, 15, 15, {}, "Darkvision 10 ft")]);
    const r = await room(t, state);
    await r.ana.apply({ t: "log.chat", text: "ready" });
    const now = r.now();
    assert.deepEqual(now.holders[UPPER]?.entries, [{ memberId: "p1", on: true }]);
    assert.deepEqual(now.holders[GROUND]?.entries, [{ memberId: "p1", on: true }]);
    const tile = now.exploredBy[holderTileKey(GROUND, "p1", 0, 0)];
    const bits = tile ? decodeTile(tile.bits) : null;
    assert.ok(bits && subsOf().some(([sx, sy]) => getBit(bits, sx, sy)), "her own layer below holds the hole her scout above sees");
  });
});
