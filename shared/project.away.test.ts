import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { keys, type EntityKey } from "./keys.ts";
import type { RoomState, TrapDue, Viewer } from "./model.ts";
import { dependents, diffProjection, heldOf, projectEntity, projectState, type ProjectedFall, type ProjectedTrap } from "./project.ts";
import type { Change, Op } from "./protocol.ts";
import { applyOp } from "./reducer.ts";
import { DM, P1, P2, character, env, numbered, room, token, trap } from "./testutil.ts";

/*
 * The DM's trap and fall cards name the creatures they name that the DM's
 * copy lacks (`away`, LP53-TRAP-2, D-261128-037, 038), worked out on the
 * server, never stored and never sent to anyone else. A token's write
 * projects every card naming it again through one index (D-261128-049).
 */

const DISPLAY: Viewer = { memberId: "display:abcdefghijkl", role: "player" };

const due = (id: string, over: Partial<TrapDue> = {}): TrapDue => ({ id, at: "2026-10-22T10:00:00.000Z", how: "enter", by: ["rookA"], hits: ["rookA"], ...over });

/** Rook with a token on each scene, Bree away on s2, Snik here, a found pit waiting on Rook and Bree, a found net with none waiting, and a fall card for Bree. Snik and the Ogre hold the numbers their names gave them. */
function rooms(): RoomState {
  return numbered(room({
    characters: { rook: character("rook", { name: "Rook", ownerIds: ["p1"] }), bree: character("bree", { name: "Bree", ownerIds: ["p2"] }) },
    tokens: {
      rookA: token("rookA", { name: "Rook", kind: "pc", ownerIds: ["p1"], actor: { ref: "rook" } }),
      rookB: token("rookB", { name: "Rook", kind: "pc", sceneId: "s2", ownerIds: ["p1"], actor: { ref: "rook" } }),
      bree: token("bree", { name: "Bree", kind: "pc", sceneId: "s2", ownerIds: ["p2"], actor: { ref: "bree" } }),
      snik: token("snik", { name: "Snik", number: 3 }),
      ogre: token("ogre", { name: "Ogre", sceneId: "s2", number: 2 }),
    },
    traps: {
      pit: trap("pit", { found: true, rig: { ...trap("x").rig!, due: [due("12:0", { by: ["rookA", "ogre"], hits: ["rookA", "rookB", "bree", "snik"] })] } }),
      net: trap("net", { name: "Falling Net", found: true, zone: { cells: [{ x: 20, y: 20, w: 1, h: 1 }] } }),
    },
    falls: { "120:0": { id: "120:0", rev: 0, tokenId: "bree", riders: ["ogre"], sceneId: "s2", from: "s1", ft: 10, made: 120 } },
  }));
}

const dmTrap = (state: RoomState, id: string, sceneId = "s1") => projectEntity(keys.trap(id), state, DM, { sceneId }) as ProjectedTrap | null;

/** What one DM op sends a viewer, by the server fan-out's own rule: the touched keys and their dependents, compared by hash with what the viewer holds. */
function sent(before: RoomState, op: Op, viewer: Viewer, sceneId: string): { state: RoomState; changes: Change[] } {
  const result = applyOp(before, op, DM, env(50));
  assert.ok(result.ok, result.ok ? "" : result.message);
  const after = result.state;
  const held = heldOf(projectState(before, viewer, { sceneId }));
  const candidates = new Set<EntityKey>([...result.touched, ...dependents(before, result.touched, after), ...dependents(after, result.touched, before)]);
  const next = new Map<EntityKey, unknown>();
  for (const key of [...candidates].sort()) next.set(key, projectEntity(key, after, viewer, { sceneId }));
  return { state: after, changes: diffProjection(held, next).changes };
}

describe("away names on the DM's cards (LP53-TRAP-2)", () => {
  test("the DM's trap names those its waiting springing names off the copy, with table number and character, and the snapshot agrees", () => {
    const state = rooms();
    assert.deepEqual(dmTrap(state, "pit")!.away, { bree: { name: "Bree", ref: "bree" }, ogre: { name: "Ogre", number: 2 }, rookB: { name: "Rook", ref: "rook" } });
    assert.deepEqual(projectState(state, DM, { sceneId: "s1" }).traps.pit, dmTrap(state, "pit"));
    assert.equal(state.traps.pit!.rig!.due![0]!.hits.length, 4);
    assert.equal("away" in state.traps.pit!, false, "never stored");
  });

  test("left out where it would be empty: a trap with none waiting is the stored trap itself, and one whose creatures all stand in the copy too", () => {
    const state = rooms();
    assert.equal(dmTrap(state, "net"), state.traps.net, "no springing waits");
    const here = { ...state, tokens: { ...state.tokens, rookB: { ...state.tokens.rookB!, sceneId: "s1" }, bree: { ...state.tokens.bree!, sceneId: "s1" }, ogre: { ...state.tokens.ogre!, sceneId: "s1" } } };
    assert.equal(dmTrap(here, "pit"), here.traps.pit, "every one it names is in the copy");
    assert.ok(!("away" in dmTrap(here, "pit")!));
  });

  test("a fall card names its creature and riders off the copy, on every scene the DM shows", () => {
    const state = rooms();
    const card = (sceneId: string) => projectEntity(keys.fall("120:0"), state, DM, { sceneId }) as ProjectedFall | null;
    assert.deepEqual(card("s1")!.away, { bree: { name: "Bree", ref: "bree" }, ogre: { name: "Ogre", number: 2 } });
    assert.deepEqual(projectState(state, DM, { sceneId: "s1" }).falls!["120:0"], card("s1"), "the snapshot agrees");
    assert.equal(card("s2"), state.falls!["120:0"], "on s2 both stand in the copy, so the card is as stored");
  });

  test("a player, another player and a table display get no away, no rig and no fall card, so no away creature's name", () => {
    const state = rooms();
    for (const viewer of [P1, P2, DISPLAY]) {
      const copy = projectState(state, viewer, { sceneId: "s1" });
      const pit = copy.traps.pit;
      assert.ok(pit, "the found pit reaches them");
      assert.ok(!("away" in pit) && !("rig" in pit), viewer.memberId);
      assert.equal(copy.falls, undefined);
      assert.equal(projectEntity(keys.fall("120:0"), state, viewer, { sceneId: "s1" }), null);
      for (const key of [keys.trap("pit"), keys.trap("net")]) assert.ok(!JSON.stringify(projectEntity(key, state, viewer, { sceneId: "s1" })).includes("Ogre"), `${viewer.memberId} ${key}`);
      assert.ok(!JSON.stringify(copy).includes("Ogre"), `${viewer.memberId}: the hidden-from-them Ogre on s2 is named nowhere`);
    }
  });

  test("an away creature renamed on its scene renames the DM's cards without a reload", () => {
    const { changes } = sent(rooms(), { t: "token.update", tokenId: "ogre", patch: { name: "Ogre Chief" } }, DM, "s1");
    const pit = changes.find((c) => c.key === keys.trap("pit"));
    const fall = changes.find((c) => c.key === keys.fall("120:0"));
    assert.ok(pit && "value" in pit && fall && "value" in fall, "both cards naming the Ogre are sent");
    assert.equal((pit.value as ProjectedTrap).away?.ogre?.name, "Ogre Chief");
    assert.equal((fall.value as ProjectedFall).away?.ogre?.name, "Ogre Chief");
  });

  test("an away creature carries the table's number, never a stored one its name no longer gives, and a rename sends the cards without it", () => {
    const state = rooms();
    // A number from before numbers were given by the table, or copied, is no member's: the table reads none.
    state.tokens.ogre = { ...state.tokens.ogre!, met: undefined };
    assert.deepEqual(dmTrap(state, "pit")!.away?.ogre, { name: "Ogre" }, "its token's own copy reads no number either");
    const { changes } = sent(rooms(), { t: "token.update", tokenId: "ogre", patch: { name: "Troll" } }, DM, "s1");
    const pit = changes.find((c) => c.key === keys.trap("pit"));
    const fall = changes.find((c) => c.key === keys.fall("120:0"));
    assert.ok(pit && "value" in pit && fall && "value" in fall, "both cards naming it are sent");
    assert.deepEqual((pit.value as ProjectedTrap).away?.ogre, { name: "Troll" }, "the stored 2 was the Ogres' number, not the Troll's");
    assert.deepEqual((fall.value as ProjectedFall).away?.ogre, { name: "Troll" });
  });

  test("a creature that leaves the DM's copy is named away at once, and one back in it drops out", () => {
    const left = sent(rooms(), { t: "token.update", tokenId: "snik", patch: { sceneId: "s2" } }, DM, "s1");
    const pit = left.changes.find((c) => c.key === keys.trap("pit"));
    assert.ok(pit && "value" in pit);
    // Its 3 was given on s1, which s2's numbers do not hold, so it reads plain there, as its label does.
    assert.deepEqual((pit.value as ProjectedTrap).away?.snik, { name: "Snik" });
    const label = projectEntity(keys.token("snik"), left.state, DM, { sceneId: "s2" }) as { number?: number } | null;
    assert.ok(label && label.number === undefined, "its own copy on s2 carries no number");
    const back = sent(left.state, { t: "token.update", tokenId: "snik", patch: { sceneId: "s1" } }, DM, "s1");
    const again = back.changes.find((c) => c.key === keys.trap("pit"));
    assert.ok(again && "value" in again);
    assert.equal((again.value as ProjectedTrap).away?.snik, undefined);
  });

  test("a token write sends no trap or fall frame to anyone where no waiting springing or card names it (the no-update regression)", () => {
    const state = rooms();
    for (const op of [
      { t: "token.update", tokenId: "rookA", patch: { name: "Rook the Red" } },
      { t: "token.move", tokenId: "rookA", x: 1, y: 1 },
    ] as Op[]) {
      for (const viewer of [DM, P1, DISPLAY]) {
        const { changes } = sent(state, op, viewer, "s1");
        assert.ok(!changes.some((c) => c.key === keys.trap("net")), `${op.t} ${viewer.memberId}: the net waits on no one`);
        if (viewer !== DM) assert.ok(!changes.some((c) => c.key.startsWith("trap:") || c.key.startsWith("fall:")), `${op.t} ${viewer.memberId}: nothing of the DM's cards`);
      }
    }
    // Rook A stands in the copy, so the pit's away list holds the same names: it re-projects to what the DM holds.
    const { changes } = sent(state, { t: "token.move", tokenId: "rookA", x: 1, y: 1 }, DM, "s1");
    assert.ok(!changes.some((c) => c.key.startsWith("trap:") || c.key.startsWith("fall:")), "the DM's cards re-project to nothing new");
    assert.ok(!dependents(state, [keys.token("snik")]).includes(keys.trap("net")), "the index lists only the cards that name a token");
    assert.ok(dependents(state, [keys.token("snik")]).includes(keys.trap("pit")));
    assert.ok(dependents(state, [keys.token("ogre")]).includes(keys.fall("120:0")));
  });
});
