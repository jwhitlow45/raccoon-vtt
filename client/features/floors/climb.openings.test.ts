import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { ANA, GROUND, OPENING_RECT, UPPER, thornToken, tower, withOpening } from "#shared/floorLinksTestutil.ts";
import type { FloorLink, RoomState, Token } from "#shared/model.ts";
import { LINK_WORDS } from "#shared/rules/floorLinks.ts";
import { DM, token } from "#shared/testutil.ts";
import { climbKey, climbOffer } from "./climb.ts";
import { FLY_ONLY } from "./linkWords.ts";

/*
 * Fly up and Fly down (docs/design/design-v1-floors.md phase 4, 5): an
 * opening's end is offered only to a creature in the air with its space
 * inside the squares, on the tower's opening from Upper floor (o1, the
 * hole, 2 by 2 at 6, 6) down to Ground floor (o2).
 */

const at = (sceneId: string, elevation: number, over: Partial<Token> = {}): Token => token("bat", { sceneId, x: OPENING_RECT.x, y: OPENING_RECT.y, elevation, name: "Bat", ...over });

function room(...made: Token[]): RoomState {
  const s = withOpening(tower());
  return { ...s, tokens: { ...s.tokens, ...Object.fromEntries(made.map((t) => [t.id, t])) } };
}

const offerOf = (s: RoomState, t: Token) => {
  const offer = climbOffer(s, DM, t);
  return offer && { link: offer.link.id, dir: offer.dir, kind: offer.kind, floor: offer.floor, off: offer.off };
};

describe("Fly up and Fly down's offer (phase 4, 5)", () => {
  test("a bat in the air over the hole flies down to Ground floor, and one in the air under it flies up", () => {
    const over = at(UPPER, 5);
    assert.deepEqual(offerOf(room(over), over), { link: "o1", dir: "down", kind: "opening", floor: "Ground floor", off: null });
    const under = at(GROUND, 5);
    assert.deepEqual(offerOf(room(under), under), { link: "o2", dir: "up", kind: "opening", floor: "Upper floor", off: null });
    assert.equal("climb" in climbKey(room(over), DM, over, "down", "Bat"), true);
  });

  test("a goblin on the ground under the hole, or over it, gets no button, and } or { says only a flier goes through", () => {
    const goblin = at(GROUND, 0, { id: "goblin", name: "Goblin" });
    const s = room(goblin);
    assert.equal(climbOffer(s, DM, goblin), null);
    assert.deepEqual(climbKey(s, DM, goblin, "up", "Goblin"), { say: FLY_ONLY });
    assert.deepEqual(climbKey(s, DM, goblin, "down", "Goblin"), { say: FLY_ONLY });
    // Placed over the hole by the DM, where no move made it fall: still only a flier goes through.
    const placed = at(UPPER, 0, { id: "goblin", name: "Goblin" });
    assert.equal(climbOffer(room(placed), DM, placed), null);
    assert.deepEqual(climbKey(room(placed), DM, placed, "down", "Goblin"), { say: FLY_ONLY });
  });

  test("off the squares, the key says what it says of stairs", () => {
    const away = at(GROUND, 0, { id: "goblin", name: "Goblin", x: 12, y: 12 });
    assert.deepEqual(climbKey(room(away), DM, away, "up", "Goblin"), { say: "Goblin isn't on stairs or a ladder." });
    const high = at(GROUND, 5, { id: "goblin", name: "Goblin", x: 12, y: 12 });
    assert.equal(climbOffer(room(high), DM, high), null, "in the air away from the squares");
  });

  test("a creature its viewer may not move gets neither the button nor the flier's words", () => {
    const goblin = at(GROUND, 0, { id: "goblin", name: "Goblin" });
    assert.deepEqual(climbKey(room(goblin), ANA, goblin, "up", "Goblin"), { say: "Goblin isn't on stairs or a ladder." });
  });

  test("a rider of a mount the viewer receives waits for its mount, which flies, and one whose mount they do not receive flies alone", () => {
    const horse = at(UPPER, 5, { id: "horse", name: "Horse", size: "large" });
    const thorn = thornToken({ sceneId: UPPER, x: OPENING_RECT.x, y: OPENING_RECT.y, elevation: 5, attached: { kind: "ride", to: "horse" } });
    const s = room(horse, thorn);
    assert.equal(climbOffer(s, DM, thorn), null);
    assert.equal(climbOffer(s, DM, horse)?.link.id, "o1");
    assert.deepEqual(climbKey(s, DM, thorn, "down", "Thorn"), { say: LINK_WORDS.carried("Thorn", "opening") });
    const { horse: _horse, ...unseen } = s.tokens;
    assert.equal(climbOffer({ ...s, tokens: unseen }, DM, thorn)?.link.id, "o1");
  });

  test("an end of stairs on the same floor keeps its own rule beside an opening", () => {
    const s = room();
    const stairs: FloorLink = { id: "l1", rev: 0, sceneId: GROUND, to: UPPER, pair: "l2", rect: { x: 3, y: 3, w: 1, h: 1 }, kind: "stairs", ground: 0, made: 1 };
    const pair: FloorLink = { ...stairs, id: "l2", sceneId: UPPER, to: GROUND, pair: "l1" };
    const both: RoomState = { ...s, floorLinks: { ...s.floorLinks, l1: stairs, l2: pair } };
    assert.equal(climbOffer(both, DM, both.tokens.thorn!)?.kind, "stairs");
  });
});
