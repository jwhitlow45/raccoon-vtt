import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { RoomState, Trap, TrapRig, Viewer } from "../model.ts";
import type { Op } from "../protocol.ts";
import { applyOp } from "../reducer.ts";
import { groundAt } from "../rules/heights.ts";
import { DM, env, P1, room, token, trap as trapOf } from "../testutil.ts";

/** Pits open the ground (docs/design-v1-traps.md 5.7, build step 11). */

const pitRig = (over: Partial<TrapRig> = {}): TrapRig => ({ ...trapOf("x").rig!, who: "any", stops: true, pit: { floor: -10 }, ...over });
const pit = (over: Partial<Trap> = {}): Trap => trapOf("pit", { zone: { cells: [{ x: 4, y: 4, w: 2, h: 2 }] }, rig: pitRig(), ...over });

function world(): RoomState {
  return room({
    tokens: {
      thorn: token("thorn", { name: "Thorn", kind: "pc", ownerIds: ["p1"], x: 0, y: 4 }),
      gob: token("gob", { name: "Goblin", x: 0, y: 8 }),
    },
    traps: { pit: pit() },
  });
}

let seq = 50;
function run(state: RoomState, op: Op, who: Viewer = DM) {
  const res = applyOp(state, op, who, env(seq++));
  assert.ok(res.ok, res.ok ? "" : res.message);
  return res;
}

const cells = (s: RoomState) => [groundAt(s.buildChunks, "s1", 4, 4), groundAt(s.buildChunks, "s1", 5, 4), groundAt(s.buildChunks, "s1", 4, 5), groundAt(s.buildChunks, "s1", 5, 5)];

describe("a pit opens", () => {
  test("its squares take the floor, the creature that stopped on its lid falls with it, and the DM's line says it opened", () => {
    const res = run(world(), { t: "token.move", tokenId: "thorn", x: 9, y: 4 }, P1);
    const s = res.state;
    assert.deepEqual(cells(s), [-10, -10, -10, -10]);
    assert.equal(s.tokens.thorn!.x, 4, "stopped where it stepped on");
    assert.equal(s.tokens.thorn!.elevation, -10, "and fell to the floor");
    const line = s.trapLog.at(-1)!.data;
    assert.ok(line?.type === "trap");
    assert.deepEqual(line.did, [{ action: -1, ok: true }]);
    assert.equal(groundAt(s.buildChunks, "s1", 6, 4), 0, "beside it the ground stays");
  });

  test("a holder landing on the lid takes its rider down with it, offsets kept", () => {
    const s = world();
    s.tokens.horse = token("horse", { name: "Warhorse", kind: "npc", size: "large", x: 1, y: 4 });
    s.tokens.thorn = { ...s.tokens.thorn!, x: 1, y: 4, elevation: 0, attached: { to: "horse", kind: "ride" } };
    // A Large walk sets it off half a square in and stops on its last whole square, beside the lid, so the horse lands on it instead.
    const res = run(s, { t: "token.move", tokenId: "horse", x: 4, y: 4, teleport: "wall" });
    assert.equal(res.state.tokens.horse!.x, 4);
    assert.equal(res.state.tokens.horse!.elevation, -10);
    assert.equal(res.state.tokens.thorn!.elevation, -10, "the rider rides down with it");
    assert.equal(res.state.tokens.thorn!.attached?.to, "horse");
  });

  test("a dragged creature left 10 ft above its fallen holder comes loose in the second link pass", () => {
    const s = world();
    s.tokens.gob = { ...s.tokens.gob!, x: 1, y: 4 };
    s.tokens.thorn = { ...s.tokens.thorn!, x: 0, y: 4, attached: { to: "gob", kind: "drag" } };
    const res = run(s, { t: "token.move", tokenId: "gob", x: 8, y: 4 });
    assert.equal(res.state.tokens.gob!.x, 4);
    assert.equal(res.state.tokens.gob!.elevation, -10);
    assert.equal(res.state.tokens.thorn!.elevation, 0, "the dragged creature stays on its own ground");
    assert.equal(res.state.tokens.thorn!.attached, undefined, "out of reach, it came loose");
  });

  test("a pit opens once: a re-armed pit that goes off again changes no ground and names no pit", () => {
    const first = run(world(), { t: "token.move", tokenId: "thorn", x: 9, y: 4 }, P1).state;
    assert.deepEqual(cells(first), [-10, -10, -10, -10]);
    const chunks = first.buildChunks;
    const armed = run(first, { t: "trap.update", trapId: "pit", patch: { state: "armed" } }).state;
    const again = run(armed, { t: "trap.spring", trapId: "pit", tokenIds: ["thorn"] });
    assert.equal(again.state.traps.pit!.state, "sprung");
    assert.equal(again.state.buildChunks, chunks, "no chunk written");
    const line = again.state.trapLog.at(-1)!.data;
    assert.ok(line?.type === "trap");
    assert.deepEqual(line.did, []);
  });

  test("a hidden springing in a player's op leaves the lid shut until Do its effects opens it", () => {
    const s = world();
    s.tokens.imp = token("imp", { name: "Imp", kind: "npc", ownerIds: ["p1"], visibility: "dm", x: 0, y: 5 });
    const hidden = run(s, { t: "token.moveMany", moves: [{ tokenId: "imp", x: 9, y: 5 }] }, P1).state;
    assert.deepEqual(cells(hidden), [0, 0, 0, 0]);
    const due = hidden.traps.pit!.rig!.due![0]!;
    assert.equal(due.hidden, true);
    const acted = run(hidden, { t: "trap.act", trapId: "pit", due: due.id }).state;
    assert.deepEqual(cells(acted), [-10, -10, -10, -10]);
    assert.equal(acted.tokens.imp!.elevation, 0, "the imp walked on past the lid");
  });

  test("the DM's undo of the move closes the pit and puts the creature back", () => {
    const before = world();
    before.tokens.gob = { ...before.tokens.gob!, y: 4, x: 0 };
    before.tokens.thorn = { ...before.tokens.thorn!, y: 0 };
    const res = run(before, { t: "token.move", tokenId: "gob", x: 9, y: 4 }, DM);
    assert.deepEqual(cells(res.state), [-10, -10, -10, -10]);
    assert.equal(res.state.tokens.gob!.elevation, -10);
    const undone = run(res.state, { t: "sys.restore", entries: res.inverse!, from: "undo", deps: true });
    assert.deepEqual(cells(undone.state), [0, 0, 0, 0]);
    assert.equal(undone.state.tokens.gob!.x, 0);
    assert.equal(undone.state.tokens.gob!.elevation, 0);
  });
});
