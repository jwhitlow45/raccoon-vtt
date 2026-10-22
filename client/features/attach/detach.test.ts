import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { RoomState, Token } from "#shared/model.ts";
import { canApply } from "#shared/permissions.ts";
import { clientOpSchema, type ClientOp, type Op } from "#shared/protocol.ts";
import { applyOp } from "#shared/reducer.ts";
import { DM, P1, env, room, scene, token } from "#shared/testutil.ts";
import { line, raised, world } from "../movement/testing.ts";
import { barSlots, DETACH_WORDS, detachChoice, detachOp, getOffPlace, holderAction } from "./detach.ts";

const dm = { role: "dm" as const, memberId: DM.memberId };
const p1 = { role: "player" as const, memberId: P1.memberId };

function withTokens(list: Token[], state: RoomState = room()): RoomState {
  state.tokens = Object.fromEntries(list.map((t) => [t.id, t]));
  return state;
}

const horse = token("horse", { name: "Warhorse", size: "large", x: 5, y: 5 });
const rider = token("bree", { name: "Bree", ownerIds: ["p1"], x: 5, y: 5, attached: { to: "horse", kind: "ride" } });
const torch = token("torch", { name: "Torch", kind: "object", size: "tiny", x: 6, y: 6, attached: { to: "horse", kind: "carry" } });
const goblin = token("goblin", { name: "Goblin", number: 2, x: 7, y: 5, attached: { to: "horse", kind: "drag" } });

/** The Get off op built from the spot getOffPlace found, and whether the server takes it from that viewer and stores it. */
function takes(state: RoomState, viewer: typeof dm | typeof p1, place: { x: number; y: number; elevation: number } | null): boolean {
  const op = detachOp("bree", place);
  const who = viewer.role === "dm" ? DM : P1;
  return canApply(op, who, state, { canUseAsset: () => true }).ok && applyOp(state, op as Op, who, env(1)).ok;
}

describe("getting off and letting go", () => {
  test("a creature gets off, an object is put down, a dragged creature is let go, and without its holder in the copy nothing", () => {
    const tokens = withTokens([horse, rider, torch, goblin]).tokens;
    assert.equal(detachChoice(tokens, rider), "getOff");
    assert.equal(detachChoice(tokens, torch), "putDown");
    assert.equal(detachChoice(tokens, goblin), "letGo");
    assert.equal(detachChoice(withTokens([rider]).tokens, rider), null);
    assert.equal(detachChoice(tokens, horse), null);
    assert.deepEqual(DETACH_WORDS, { getOff: "Get off", putDown: "Put down", letGo: "Let go" });
  });

  test("the holder's line lets go of a creature it drags or carries and puts down an object, and leaves a rider to its own bar", () => {
    assert.deepEqual(holderAction(goblin), { words: "Let go of Goblin 2", choice: "letGo" });
    assert.deepEqual(holderAction(torch), { words: "Put down Torch", choice: "putDown" });
    assert.equal(holderAction({ ...goblin, attached: { to: "horse", kind: "carry" } })?.words, "Let go of Goblin 2");
    assert.equal(holderAction(rider), null);
  });

  test("Get off takes the first free spot beside the holder, east of its middle first, and never one on a creature the viewer sees", () => {
    const state = withTokens([horse, rider]);
    assert.deepEqual(getOffPlace(state, dm, rider), { x: 7, y: 6, elevation: 0 });
    const blocked = withTokens([horse, rider, token("orc", { x: 7, y: 6 })]);
    assert.deepEqual(getOffPlace(blocked, dm, rider), { x: 7, y: 7, elevation: 0 });
    // What the rider carries gets off with it, so it never blocks the spot.
    const own = withTokens([horse, rider, { ...torch, x: 7, y: 6, attached: { to: "bree", kind: "carry" } }]);
    assert.deepEqual(getOffPlace(own, dm, rider), { x: 7, y: 6, elevation: 0 });
    for (const s of [state, blocked, own]) for (const viewer of [dm, p1]) assert.equal(takes(s, viewer, getOffPlace(s, viewer, s.tokens.bree!)), true);
  });

  test("a player's spot has a clear leg from the seat where walls stop moves, and with no room there is none", () => {
    const walled = world({ edges: line("w", 7, 0, 30), tokens: [horse, rider] });
    const spot = getOffPlace(walled, p1, rider)!;
    assert.ok(spot.x < 7, "the east side is behind the wall");
    assert.deepEqual(getOffPlace(walled, dm, rider), { x: 7, y: 6, elevation: 0 }, "the DM's get off is placed, never walked");
    assert.equal(takes(walled, p1, spot), true);
    assert.equal(takes(walled, dm, getOffPlace(walled, dm, rider)), true);
    const boxed = withTokens([{ ...horse, x: 0, y: 0 }, { ...rider, x: 0, y: 0 }], room({ scenes: { s1: scene("s1", { bounds: { w: 2, h: 2 } }) } }));
    assert.equal(getOffPlace(boxed, dm, boxed.tokens.bree!), null);
  });

  test("nor does what the rider drags walk through a wall on the way, since it follows the rider's leg", () => {
    const kobold = token("kobold", { name: "Kobold", size: "small", x: 4, y: 5, attached: { to: "bree", kind: "drag" } });
    const free = world({ edges: line("w", 5, 0, 30), tokens: [horse, rider] });
    assert.equal(getOffPlace(free, p1, rider)?.x, 7, "alone, Bree gets off east, away from the wall behind her");
    const dragging = world({ edges: line("w", 5, 0, 30), tokens: [horse, rider, kobold] });
    const spot = getOffPlace(dragging, p1, rider)!;
    assert.equal(spot.x, 5, "east takes the kobold through the wall, so she gets off north or south of the seat");
    // The server's walls test agrees on both spots.
    const asP1 = (op: ClientOp) => canApply(op, P1, dragging, { canUseAsset: () => true });
    assert.equal(asP1(detachOp("bree", spot)).ok, true);
    assert.equal(asP1(detachOp("bree", { x: 7, y: 6, elevation: 0 })).ok, false);
    assert.deepEqual(getOffPlace(dragging, dm, rider), { x: 7, y: 6, elevation: 0 }, "the DM's get off is placed, never walked");
  });

  test("a carried creature's bar offers Attach beside Get off, a carried object's Put down alone, a loose token's Attach alone", () => {
    const state = withTokens([horse, rider, torch, goblin]);
    assert.deepEqual(barSlots(state, p1, rider), ["detach", "attach"]);
    assert.deepEqual(barSlots(state, dm, torch), ["detach"]);
    assert.deepEqual(barSlots(state, dm, horse), ["attach"]);
    // A player who may neither undo the goblin's link nor move it gets nothing.
    assert.deepEqual(barSlots(state, p1, goblin), []);
  });

  test("a rider gets off a mount that straddles a step onto the ground there, judged from the mount, never in midair", () => {
    // The warhorse stands at 10 ft on its raised half (x 5 and up), Bree on its low half, over 0 ft ground.
    const tall = { ...horse, x: 4, y: 4, elevation: 10 };
    const seated = { ...rider, x: 4, y: 4, elevation: 10 };
    const state = world({ blockMovement: false, heights: raised(5, 0, 6, 20, 10), tokens: [tall, seated] });
    const place = getOffPlace(state, p1, state.tokens.bree!)!;
    const ground = place.x >= 5 && place.x < 6 ? 10 : 0;
    assert.equal(place.elevation, ground, JSON.stringify(place));
    // Its reach is measured from where it lands: on the low ground 10 ft below the horse, a spot beside it is out of a 5 ft reach (review AT-ASTRA-14).
    for (const viewer of [dm, p1]) assert.equal(takes(state, viewer, getOffPlace(state, viewer, state.tokens.bree!)), true, viewer.role);
  });

  test("the ops: Get off with its place, the others where it stands", () => {
    assert.deepEqual(detachOp("bree", { x: 7, y: 5, elevation: 0 }), { t: "token.detach", tokenId: "bree", x: 7, y: 5, elevation: 0 });
    assert.deepEqual(detachOp("torch", null), { t: "token.detach", tokenId: "torch" });
    assert.ok(clientOpSchema.safeParse(detachOp("bree", { x: 7, y: 5, elevation: 0 })).success);
    assert.ok(clientOpSchema.safeParse(detachOp("torch", null)).success);
  });
});
