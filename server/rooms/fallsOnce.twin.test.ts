import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { describe, test, type TestContext } from "node:test";
import { GROUND, UPPER, thornToken, tower, trapdoor, withOpening, withTrapdoor } from "#shared/floorLinksTestutil.ts";
import type { RoomState, Token } from "#shared/model.ts";
import type { Op } from "#shared/protocol.ts";
import { FrameReader } from "#shared/seqTestutil.ts";
import { actor, character, token } from "#shared/testutil.ts";
import { scopeActor, scopeObserver } from "./undoScopeTesting.ts";

/*
 * What a player receives depends only on what they see
 * (docs/design/design-v1-floors.md phase 4, change format 67). Fall cards
 * are the DM's, so whether two tokens of one creature fold onto one card,
 * and whether a player's undo trims a card or removes it, changes only DM
 * state. Each pair of twins differs in what a trapdoor that Ana's walk
 * sets off on its way to the hole drops, all of it hidden from her: the
 * trapdoor does not stop her, and its drop waits until her walk ends, so
 * it takes only what stands on its squares then, and her step stays hers
 * to undo. Ana's, the other player's and the table display's every frame
 * are the same in both twins after the walk, her undo and her redo.
 */

const DISPLAY = "display:abcdefghijkl";

/** Shade, the DM's character, which every character's projection shows every player, so both twins hold it alike. */
function room(hidden: Token[], walker: Token): RoomState {
  const td = trapdoor("td1", { zone: { cells: [{ x: 9, y: 6, w: 1, h: 2 }] }, rig: { ...trapdoor().rig!, stops: false, foundOnSpring: false } });
  const base = withTrapdoor(withOpening(tower({ tokens: Object.fromEntries([walker, ...hidden].map((t) => [t.id, t])) })), td);
  return {
    ...base,
    characters: { ...base.characters, shade: character("shade", { name: "Shade", ownerIds: [], actor: actor() }) },
    // Ana may move Shade's token, and holds Upper floor without a creature of hers there.
    meta: { ...base.meta, settings: { ...base.meta.settings, playersMoveAny: "all" as const } },
    openFloors: { [UPPER]: { sceneId: UPPER, rev: 1 } },
  };
}

const shade = (id: string, over: Partial<Token>): Token => token(id, { kind: "pc", name: "Shade", ownerIds: [], actor: { ref: "shade" }, sceneId: UPPER, ...over });
const goblin = (id: string, over: Partial<Token>): Token => token(id, { name: "Goblin", sceneId: UPPER, ...over });

/** One twin's run: Ana's walk past the trapdoor onto the hole, her undo and her redo, and every frame the players and the display were sent. */
async function run(t: TestContext, state: RoomState, walker: string): Promise<{ frames: string[][]; cards: string[][] }> {
  const clock = { now: 1_000_000 };
  const now = () => clock.now;
  const h = await scopeActor(t, state, { now, idGate: false });
  const p1 = await h.connect(state.members.p1!, "player", now);
  const p2 = await h.connect(state.members.p2!, "player", now);
  await h.connect(state.members.dm1!, "dm", now);
  const display = await scopeObserver(h.actor, { memberId: DISPLAY, role: "player", display: true });
  const settle = async () => {
    for (let i = 0; i < 20 && h.actor.queueLength > 0; i++) await delay(10);
    await delay(20);
  };
  const reader = new FrameReader();
  const frames: string[][] = [];
  const cards: string[][] = [];
  const mark = () => {
    frames.push([...p1.sent.map((m) => `p1 ${reader.text(m)}`), ...p2.sent.map((m) => `p2 ${reader.text(m)}`), ...display.sent.map((m) => `display ${reader.text(m)}`)]);
    cards.push(Object.values(h.actor.committed.state.falls ?? {}).map((c) => [c.tokenId, ...(c.riders ?? [])].join(" ")).sort());
  };
  clock.now += 1_000;
  await p1.apply({ t: "token.move", tokenId: walker, x: 6, y: 6, route: [[9, 6, 0, 0], [6, 6, 0, 0]] } satisfies Op);
  await settle();
  assert.equal(h.actor.committed.state.tokens[walker]!.sceneId, GROUND, "the walker fell");
  mark();
  clock.now += 1_000;
  await p1.restore("play", "undo");
  await settle();
  assert.equal(h.actor.committed.state.tokens[walker]!.sceneId, UPPER, "Ana's undo took it back up");
  mark();
  clock.now += 1_000;
  await p1.restore("play", "redo");
  await settle();
  assert.equal(h.actor.committed.state.tokens[walker]!.sceneId, GROUND, "her redo took it down again");
  mark();
  return { frames, cards };
}

describe("one card a creature reaches the players alike (change format 67)", () => {
  test("a trapdoor drops two hidden tokens of Shade onto one card, or two hidden goblins onto two, while Thorn falls: every player frame is equal", async (t) => {
    const thorn = thornToken({ sceneId: UPPER, x: 11, y: 6 });
    const one = await run(t, room([shade("h1", { x: 9, y: 6, visibility: "dm" }), shade("h2", { x: 9, y: 7, visibility: "dm" })], thorn), "thorn");
    const two = await run(t, room([goblin("h1", { x: 9, y: 6, visibility: "dm" }), goblin("h2", { x: 9, y: 7, visibility: "dm" })], thorn), "thorn");
    // The twins did differ: Shade's drop is one card, the goblins' two, and Thorn's card goes and comes back beside them.
    assert.deepEqual(one.cards, [["h1 h2", "thorn"], ["h1 h2"], ["h1 h2", "thorn"]]);
    assert.deepEqual(two.cards, [["h1", "h2", "thorn"], ["h1", "h2"], ["h1", "h2", "thorn"]]);
    for (const [i, when] of ["the walk", "the undo", "the redo"].entries()) assert.deepEqual(one.frames[i], two.frames[i], `after ${when}`);
  });

  test("Ana walks Shade's token onto the hole while the trapdoor drops its hidden other token or a hidden goblin: every player frame is equal", async (t) => {
    const walker = shade("s1", { x: 11, y: 6 });
    const joined = await run(t, room([shade("h1", { x: 9, y: 7, visibility: "dm" })], walker), "s1");
    const apart = await run(t, room([goblin("h1", { x: 9, y: 7, visibility: "dm" })], walker), "s1");
    // Shade's walked token joins its hidden token's card, which her undo leaves whole and her redo leaves as it is. Beside the
    // goblin her token has a card of its own, which her undo removes and her redo writes back.
    assert.deepEqual(joined.cards, [["h1 s1"], ["h1 s1"], ["h1 s1"]]);
    assert.deepEqual(apart.cards, [["h1", "s1"], ["h1"], ["h1", "s1"]]);
    for (const [i, when] of ["the walk", "the undo", "the redo"].entries()) assert.deepEqual(joined.frames[i], apart.frames[i], `after ${when}`);
  });
});
