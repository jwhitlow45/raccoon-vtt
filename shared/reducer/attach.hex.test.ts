import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { RoomState, Token, Viewer } from "../model.ts";
import { opSchema, type Op } from "../protocol.ts";
import { canApply } from "../permissions.ts";
import { applyOp } from "../reducer.ts";
import { getOffSpot, seatSpot } from "../rules/attach.ts";
import { occupiedHexes, placedOnHex } from "../rules/footprint.ts";
import { hexKey, type Hex, type HexGrid } from "../rules/hex.ts";
import { DM, P1, character, env, room, scene, token } from "../testutil.ts";

/**
 * Riding, carrying and dragging on a hex scene (docs/design-v1-hex-grids.md
 * phase H2): the server takes the attach, seats a rider on its mount's
 * hexes, carries the group along a move, drops a link that no longer holds
 * by hexes, and lets a rider off beside its mount.
 */
const ROWS: HexGrid = { shape: "hex", orient: "rows" };

function placed(id: string, size: Token["size"], ref: Hex, overrides: Partial<Token> = {}): Token {
  const base = token(id, { size, x: 0, y: 0, ...overrides });
  return { ...base, ...placedOnHex(ROWS, base, ref) };
}

/** s1 on hex rows: a Large warhorse on 6,6, Bree two hexes east of its top hex, a goblin beside it. */
function stable(): RoomState {
  const state = room({ scenes: { s1: scene("s1", { gridShape: "hexRows" }) } });
  state.characters.bree = character("bree", { name: "Bree", ownerIds: ["p1"] });
  state.tokens = {
    horse: placed("horse", "large", { col: 6, row: 6 }, { name: "Warhorse", kind: "npc", ownerIds: ["p1"] }),
    bree: placed("bree", "medium", { col: 8, row: 6 }, { name: "Bree", kind: "pc", actor: { ref: "bree" }, ownerIds: ["p1"] }),
    gob: placed("gob", "small", { col: 5, row: 6 }, { name: "Goblin", kind: "npc" }),
  };
  return state;
}

function run(state: RoomState, op: Op, who: Viewer = DM): RoomState {
  const parsed = opSchema.parse(op);
  const allowed = canApply(parsed, who, state, { canUseAsset: () => true });
  assert.ok(allowed.ok, `${op.t}: ${allowed.ok ? "" : allowed.message}`);
  const r = applyOp(state, parsed, who, env(1));
  assert.ok(r.ok, `${op.t}: ${r.ok ? "" : `${r.code}: ${r.message}`}`);
  return r.state;
}

function refusal(state: RoomState, op: Op, who: Viewer = DM): string {
  const r = applyOp(state, opSchema.parse(op), who, env(1));
  assert.ok(!r.ok, `${op.t} should be refused`);
  return r.message;
}

const hexesOf = (t: Token | undefined) => occupiedHexes(ROWS, t!).map(hexKey);

describe("attaching on a hex scene", () => {
  test("a player's Bree gets on the warhorse at the seat the list finds, on one of its hexes", () => {
    const state = stable();
    const seat = seatSpot(ROWS, state.tokens.bree!, state.tokens.horse!)!;
    // Bree stands two hexes off, beyond a player's reach: she walks up to it first.
    const near = placedOnHex(ROWS, state.tokens.bree!, { col: 7, row: 6 });
    let next = run(state, { t: "token.move", tokenId: "bree", ...near }, P1);
    next = run(next, { t: "token.attach", tokenId: "bree", to: "horse", kind: "ride", x: seat.x, y: seat.y, elevation: 0 }, P1);
    assert.deepEqual(next.tokens.bree?.attached, { to: "horse", kind: "ride" });
    assert.ok(hexesOf(next.tokens.horse).includes(hexesOf(next.tokens.bree)[0]!), "on the horse's hexes");
  });

  test("a seat beside the horse's hexes, inside its square box, is refused", () => {
    const state = stable();
    const beside = placedOnHex(ROWS, state.tokens.bree!, { col: 7, row: 6 });
    assert.equal(refusal(state, { t: "token.attach", tokenId: "bree", to: "horse", kind: "ride", ...beside, elevation: 0 }), "Bree does not sit on Warhorse there");
  });

  test("the warhorse's move takes Bree along on its hexes, and a drag reaches by hex steps", () => {
    let state = stable();
    const seat = seatSpot(ROWS, state.tokens.bree!, state.tokens.horse!)!;
    state = run(state, { t: "token.attach", tokenId: "bree", to: "horse", kind: "ride", ...seat, elevation: 0 });
    state = run(state, { t: "token.attach", tokenId: "gob", to: "horse", kind: "drag", x: state.tokens.gob!.x, y: state.tokens.gob!.y, elevation: 0 });
    const to = placedOnHex(ROWS, state.tokens.horse!, { col: 9, row: 8 });
    state = run(state, { t: "token.move", tokenId: "horse", ...to });
    assert.ok(hexesOf(state.tokens.horse).includes(hexesOf(state.tokens.bree)[0]!), "still on its hexes");
    assert.equal(state.tokens.bree?.attached?.to, "horse");
    assert.equal(state.tokens.gob?.attached?.kind, "drag", "the goblin, beside it, still within reach");
    // A goblin two hexes off is beyond a drag's reach, though its square box lies within 5 ft of the horse's.
    const far = { ...stable(), tokens: { ...stable().tokens, gob: placed("gob", "small", { col: 7, row: 4 }, { name: "Goblin", kind: "npc" }) } };
    assert.equal(refusal(far, { t: "token.attach", tokenId: "gob", to: "horse", kind: "drag", x: far.tokens.gob!.x, y: far.tokens.gob!.y, elevation: 0 }), "Goblin is too far to drag");
  });

  test("a link that no longer holds by hexes comes off, one that does stays", () => {
    let state = stable();
    const seat = seatSpot(ROWS, state.tokens.bree!, state.tokens.horse!)!;
    state = run(state, { t: "token.attach", tokenId: "bree", to: "horse", kind: "ride", ...seat, elevation: 0 });
    // Moving Bree to the hex beside the horse leaves its hexes, though her box still overlaps its square box.
    const beside = placedOnHex(ROWS, state.tokens.bree!, { col: 7, row: 6 });
    state = run(state, { t: "token.move", tokenId: "bree", ...beside });
    assert.equal(state.tokens.bree?.attached, undefined);
  });

  test("Bree gets off beside the horse at the place the bar finds, and not onto its hexes", () => {
    let state = stable();
    const seat = seatSpot(ROWS, state.tokens.bree!, state.tokens.horse!)!;
    state = run(state, { t: "token.attach", tokenId: "bree", to: "horse", kind: "ride", ...seat, elevation: 0 });
    const scene = state.scenes.s1!;
    const spot = getOffSpot(ROWS, state.meta.settings, scene.bounds, state.tokens.bree!, state.tokens.horse!)!;
    assert.match(refusal(state, { t: "token.detach", tokenId: "bree", ...seat, elevation: 0 }), /can only get off beside Warhorse/);
    state = run(state, { t: "token.detach", tokenId: "bree", ...spot, elevation: 0 });
    assert.equal(state.tokens.bree?.attached, undefined);
    assert.ok(!hexesOf(state.tokens.horse).includes(hexesOf(state.tokens.bree)[0]!));
  });
});
