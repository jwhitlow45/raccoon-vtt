import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { ANA, ATTIC, BREE, GROUND, UPPER, applied, putOp, run, thornToken, tower, withStairs } from "./floorLinksTestutil.ts";
import { keys } from "./keys.ts";
import type { AreaTemplate, RoomState, Token, Trap, Viewer } from "./model.ts";
import { canApply } from "./permissions.ts";
import type { Op, RestoreEntry } from "./protocol.ts";
import { LINK_WORDS } from "./rules/floorLinks.ts";
import { DM, token } from "./testutil.ts";

/*
 * Who may take stairs and how each refusal reads (docs/design/design-v1-floors.md
 * phase 2, 3, 4, 6.3, 8): a player's climb by the end they get on their
 * creature's floor, a holder they receive, one code for every end not
 * there for them, the DM's own ops on stairs, pits over an end, and a
 * player's undo and redo of a climb under its server-made record.
 */

const deps = { canUseAsset: () => true };
const decide = (state: RoomState, op: Op, who: Viewer = ANA) => {
  const d = canApply(op, who, state, deps);
  return d.ok ? "ok" : `${d.code}: ${d.message}`;
};
const climb = (linkId = "l1", tokenId = "thorn"): Op => ({ t: "token.climb", tokenId, linkId });
const NO_STAIRS = `invalid: ${LINK_WORDS.noStairs}`;

describe("a player's climb (4, 6.1)", () => {
  test("Ana takes Thorn up stairs under it, and the DM may too", () => {
    const s = withStairs();
    assert.equal(decide(s, climb()), "ok");
    assert.equal(decide(s, climb(), DM), "ok");
  });

  test("Bree, who owns nothing, may not, as she may not move Thorn", () => {
    assert.notEqual(decide(withStairs(), climb(), BREE), "ok");
  });

  test("an end gone, fogged, on another floor or not under Thorn answers one code and one text", () => {
    const s = withStairs();
    assert.equal(decide(s, climb("gone")), NO_STAIRS);
    assert.equal(decide(s, climb("l2")), NO_STAIRS);
    assert.equal(decide(withStairs(tower({ tokens: { thorn: thornToken({ x: 9, y: 9 }) } })), climb()), NO_STAIRS);
    // Fog over the squares: Thorn stays its owner's to see, the stairs do not.
    const fogged = { ...s, scenes: { ...s.scenes, [GROUND]: { ...s.scenes[GROUND]!, fogEnabled: true } } };
    assert.equal(decide(fogged, climb()), NO_STAIRS);
    // The DM gets every end.
    assert.equal(decide(fogged, climb(), DM), "ok");
  });

  test("locked and too big read the bar's off words, for the DM too", () => {
    const locked = run(withStairs(), { t: "floorLink.update", linkId: "l1", patch: { locked: true } });
    assert.equal(decide(locked, climb()), "invalid: It's locked.");
    const big = withStairs(tower({ tokens: { thorn: thornToken({ size: "large" }) } }), { rect: { x: 3, y: 3, w: 1, h: 1 } });
    assert.equal(decide(big, climb()), "invalid: Too big for these stairs.");
  });

  test("on a holder Ana receives, the holder takes the stairs, and on one she does not Thorn climbs alone", () => {
    const riding = (visibility: Token["visibility"]) =>
      withStairs(tower({ tokens: { thorn: thornToken({ attached: { to: "pony", kind: "ride" } }), pony: token("pony", { name: "Pony", x: 3, y: 3, visibility }) } }));
    assert.equal(decide(riding("all"), climb()), "invalid: Thorn is carried. Its holder takes the stairs.");
    assert.equal(decide(riding("dm"), climb()), "ok");
    // The same Go up, cost and landing as with no holder at all.
    const alone = applied(riding("dm"), climb(), ANA).state.tokens.thorn!;
    const free = applied(withStairs(), climb(), ANA).state.tokens.thorn!;
    assert.deepEqual([alone.sceneId, alone.x, alone.y, alone.elevation, alone.attached], [free.sceneId, free.x, free.y, free.elevation, undefined]);
  });
});

describe("the DM's stairs (3)", () => {
  test("players may not place, change or remove stairs", () => {
    const s = withStairs();
    for (const op of [putOp({ id: "l3", pairId: "l4", rect: { x: 9, y: 9, w: 1, h: 1 } }), { t: "floorLink.update", linkId: "l1", patch: { locked: true } } as Op, { t: "floorLink.delete", linkId: "l1" } as Op]) {
      assert.match(decide(s, op), /^forbidden/, op.t);
      assert.equal(decide(s, op, DM), "ok", op.t);
    }
  });

  test("a pit trap over an end is refused both ways, in the trap pane's words", () => {
    const s = withStairs();
    const rig = { on: ["enter" as const], who: "any" as const, floor: true, resets: "never" as const, stops: true, foundOnSpring: true, hits: "trigger" as const, actions: [], find: [], notice: false };
    const pitOp: Op = { t: "trap.create", trap: { id: "pit", sceneId: GROUND, name: "Pit", zone: { cells: [{ x: 4, y: 3, w: 2, h: 2 }] }, rig: { ...rig, pit: { floor: -10 } } } };
    assert.equal(decide(s, pitOp, DM), "invalid: A pit can't open under stairs. Remove them first.");
    assert.equal(decide(s, { ...pitOp, trap: { ...(pitOp as { trap: object }).trap, zone: { cells: [{ x: 8, y: 3, w: 1, h: 1 }] } } } as Op, DM), "ok");
    const plain = run(s, { t: "trap.create", trap: { id: "t1", sceneId: GROUND, name: "Plate", zone: { cells: [{ x: 4, y: 3, w: 1, h: 1 }] }, rig } });
    assert.equal(decide(plain, { t: "trap.update", trapId: "t1", patch: { rig: { pit: { floor: -10 } } } } as Op, DM), "invalid: A pit can't open under stairs. Remove them first.");
    const away = run(s, { t: "trap.create", trap: { id: "t2", sceneId: GROUND, name: "Pit", zone: { cells: [{ x: 9, y: 9, w: 1, h: 1 }] }, rig: { ...rig, pit: { floor: -10 } } } });
    assert.equal(decide(away, { t: "trap.update", trapId: "t2", patch: { zone: { cells: [{ x: 3, y: 3, w: 1, h: 1 }] } } } as Op, DM), "invalid: A pit can't open under stairs. Remove them first.");
    assert.equal(decide(away, { t: "trap.update", trapId: "t2", patch: { rig: { pit: null } } } as Op, DM), "ok");
    assert.equal((away.traps.t2 as Trap).rig?.pit?.floor, -10);
  });
});

describe("a player's undo and redo of a climb (8)", () => {
  /** Thorn's climb as Ana made it, with the restore the server builds for its undo. */
  function climbed(state: RoomState = withStairs()) {
    const r = applied(state, climb(), ANA);
    const link = state.floorLinks!.l1!;
    const record = { tokenId: "thorn", linkId: "l1", rev: link.rev, made: link.made, from: GROUND, to: UPPER };
    const undo = (entries: readonly RestoreEntry[] | null = r.inverse): Op => ({ t: "sys.restore", entries: [...(entries ?? [])], from: "undo", deps: true, climb: record });
    return { before: state, after: r.state, inverse: r.inverse, record, undo };
  }

  test("the undo takes Thorn back down the stairs it took, and its redo up them again", () => {
    const c = climbed();
    assert.equal(decide(c.after, c.undo()), "ok");
    const down = applied(c.after, c.undo(), ANA);
    assert.equal(down.state.tokens.thorn!.sceneId, GROUND);
    const redo: Op = { t: "sys.restore", entries: [...(down.inverse ?? [])], from: "redo", deps: true, climb: c.record };
    assert.equal(decide(down.state, redo), "ok");
    assert.equal(applied(down.state, redo, ANA).state.tokens.thorn!.sceneId, UPPER);
  });

  test("without the record the change of floor is no move of the player's, and under it only the climb's floors go", () => {
    const c = climbed();
    const { climb: _climb, ...bare } = c.undo() as Extract<Op, { t: "sys.restore" }>;
    assert.match(decide(c.after, bare), /^forbidden/);
    const elsewhere = (c.inverse ?? []).map((e) => (e.key === keys.token("thorn") ? { ...e, value: { ...(e.value as Token), sceneId: ATTIC } } : e));
    assert.match(decide(c.after, c.undo(elsewhere)), /^forbidden/);
    // An undo goes down the way the climb came up, never on up.
    const redoWay = { ...(c.undo() as Extract<Op, { t: "sys.restore" }>), climb: { ...c.record, from: UPPER, to: GROUND } };
    assert.notEqual(decide(c.after, redoWay), "ok");
  });

  test("a lock, a removal, the pair placed again with the same ids, or Thorn off the squares: the stairs changed", () => {
    const changed = "invalid: the stairs changed";
    const c = climbed();
    assert.equal(decide(run(c.after, { t: "floorLink.update", linkId: "l2", patch: { locked: true } }), c.undo()), changed);
    const gone = run(c.after, { t: "floorLink.delete", linkId: "l1" });
    assert.equal(decide(gone, c.undo()), changed);
    assert.equal(decide(run(gone, putOp()), c.undo()), changed, "a new pair has its own made");
    // Its rev moved on. The words name the kind the stairs have now, all the climber's floor holds.
    assert.equal(decide(run(c.after, { t: "floorLink.update", linkId: "l1", patch: { kind: "ladder" } }), c.undo()), "invalid: the ladder changed");
    const moved = run(c.after, { t: "token.move", tokenId: "thorn", x: 9, y: 9 }, ANA);
    assert.equal(decide(moved, c.undo()), changed);
  });

  test("a changed far floor changes no answer: the undo reads the end on Thorn's floor alone", () => {
    const c = climbed();
    const walled = run(c.after, { t: "build.edge", sceneId: GROUND, edges: [{ key: "8,8,n", feature: { kind: "wall" } }] });
    assert.equal(decide(walled, c.undo()), "ok");
    const otherFloorLocked = { ...c.after, floorLinks: { ...c.after.floorLinks!, l1: { ...c.after.floorLinks!.l1!, locked: true as const } } };
    // A lock read on the far end alone (a broken pair floorProblem would refuse) changes nothing here.
    assert.equal(decide(otherFloorLocked, c.undo()), "ok");
  });

  test("an area following Thorn comes back down with it, and one that changed more than its floor does not", () => {
    const aura = { id: "aura", rev: 0, sceneId: GROUND, shape: "sphere", size: 10, origin: { x: 3.5, y: 3.5, z: 0 }, yaw: 0, includeOrigin: true, ownerId: "p1", attachedTo: "thorn" } as AreaTemplate;
    const c = climbed(withStairs(tower({ templates: { aura } })));
    assert.equal(c.after.templates.aura!.sceneId, UPPER);
    assert.equal(decide(c.after, c.undo()), "ok");
    const changed = (c.inverse ?? []).map((e) => (e.key === keys.template("aura") ? { ...e, value: { ...(e.value as AreaTemplate), size: 30 } } : e));
    assert.match(decide(c.after, c.undo(changed)), /^forbidden/);
    // A restore with no climb takes no area at all.
    const { climb: _climb, ...bare } = c.undo() as Extract<Op, { t: "sys.restore" }>;
    assert.match(decide(c.after, bare), /^forbidden/);
  });

  test("a hidden passenger comes back with Thorn, answering as with none", () => {
    const owl = token("owl", { name: "Owl", size: "tiny", x: 3, y: 3, visibility: "dm", attached: { to: "thorn", kind: "perch" } });
    const c = climbed(withStairs(tower({ tokens: { thorn: thornToken(), owl } })));
    assert.equal(c.after.tokens.owl!.sceneId, UPPER);
    assert.equal(decide(c.after, c.undo()), "ok");
    const none = climbed();
    assert.equal(decide(none.after, none.undo()), "ok");
  });
});
