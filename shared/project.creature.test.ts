import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { keys, type EntityKey } from "./keys.ts";
import type { RoomState, Viewer } from "./model.ts";
import { dependents, diffProjection, heldOf, projectEntity, projectState, type ProjectedEncounter } from "./project.ts";
import type { Change, Op } from "./protocol.ts";
import { applyOp } from "./reducer.ts";
import { DM, P1, character, entry, env, room, token } from "./testutil.ts";

/*
 * The DM's Initiative rows carry the creature each stands for
 * (D-261128-044), read from the room and never stored, so a creature with a
 * row is offered no more from any scene or floor. A player's rows carry
 * none.
 */

/** Shade's two tokens, one on each scene, and a goblin, with a fight that holds Shade A's row and the goblin's. */
function fight(): RoomState {
  return room({
    characters: { shade: character("shade", { name: "Shade", ownerIds: ["p1"] }), mira: character("mira", { name: "Mira", ownerIds: ["p2"] }) },
    tokens: {
      sa: token("sa", { name: "Shade", kind: "pc", sceneId: "s2", ownerIds: ["p1"], actor: { ref: "shade" } }),
      sb: token("sb", { name: "Shade", kind: "pc", sceneId: "s1", ownerIds: ["p1"], actor: { ref: "shade" } }),
      gob: token("gob", { name: "Goblin", sceneId: "s1" }),
    },
    encounter: { rev: 0, round: 1, activeEntryId: null, entries: [entry("e-sa", { tokenId: "sa", tieOrder: 0 }), entry("e-gob", { tokenId: "gob", tieOrder: 1 }), entry("e-label", { label: "Lair", tieOrder: 2 })] },
  });
}

function rows(state: RoomState, viewer: Viewer, sceneId: string) {
  return (projectEntity(keys.encounter, state, viewer, { sceneId }) as ProjectedEncounter | null)?.entries ?? [];
}

/** What one op sends a viewer, by the server fan-out's own rule: the touched keys and their dependents, compared by hash with what the viewer holds. */
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

describe("the DM's rows carry their creature (D-261128-044)", () => {
  test("each row its character or its token, read from the room for a token on another scene, and a label row none", () => {
    const state = fight();
    assert.deepEqual(
      rows(state, DM, "s1").map((e) => [e.id, e.creature]),
      [
        ["e-sa", "character:shade"],
        ["e-gob", "token:gob"],
        ["e-label", undefined],
      ],
    );
    assert.equal(projectState(state, DM, { sceneId: "s1" }).tokens.sa, undefined, "the DM's copy on s1 lacks Shade A, which only the row's creature names");
    assert.deepEqual(projectState(state, DM, { sceneId: "s1" }).encounter, projectEntity(keys.encounter, state, DM, { sceneId: "s1" }), "the snapshot and a frame agree");
    assert.equal(state.encounter!.entries.some((e) => "creature" in e), false, "never stored");
  });

  test("a player's rows carry none", () => {
    const state = fight();
    const own = rows(state, P1, "s1");
    assert.ok(own.length > 0);
    assert.ok(own.every((e) => !("creature" in e)));
    assert.ok(!JSON.stringify(projectState(state, P1, { sceneId: "s1" })).includes("character:"));
  });

  test("a row's creature follows its token's link to another character, and a deleted token's row goes with its creature", () => {
    const state = fight();
    const relinked = { ...state.tokens.sa!, actor: { ref: "mira" } };
    const link = sent(state, { t: "sys.restore", from: "undo", entries: [{ key: keys.token("sa"), value: relinked }] }, DM, "s1");
    const frame = link.changes.find((c) => c.key === keys.encounter);
    assert.ok(frame && "value" in frame, "the link re-projects the DM's fight though Shade A is not in the copy");
    assert.equal((frame.value as ProjectedEncounter).entries.find((e) => e.id === "e-sa")?.creature, "character:mira");
    const gone = sent(state, { t: "token.delete", tokenId: "sa" }, DM, "s1");
    const after = gone.changes.find((c) => c.key === keys.encounter);
    assert.ok(after && "value" in after);
    assert.deepEqual(
      (after.value as ProjectedEncounter).entries.map((e) => e.creature),
      ["token:gob", undefined],
      "Shade's creature leaves the fight with her only row",
    );
  });

  test("a write of a row's token that leaves its creature as it was sends the DM no fight", () => {
    const moved = sent(fight(), { t: "token.move", tokenId: "gob", x: 7, y: 7 }, DM, "s1");
    assert.ok(moved.changes.some((c) => c.key === keys.token("gob")), "the move itself is sent");
    assert.ok(!moved.changes.some((c) => c.key === keys.encounter), "the fight re-projects to what the DM holds");
    const renamed = sent(fight(), { t: "token.update", tokenId: "sa", patch: { name: "Shade the Bold" } }, DM, "s1");
    assert.ok(!renamed.changes.some((c) => c.key === keys.encounter), "a rename keeps the creature");
  });
});
