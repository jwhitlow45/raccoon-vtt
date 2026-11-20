import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { readEntity, type EntityKey } from "#shared/keys.ts";
import type { RoomState, Viewer } from "#shared/model.ts";
import { projectState, stableStringify } from "#shared/project.ts";
import type { Op } from "#shared/protocol.ts";
import { applyOp } from "#shared/reducer.ts";
import { actor, character, DM, drawing, entry, env, randomOp, randomState, rng, room, scene, template, token } from "#shared/testutil.ts";
import { exactCopies } from "./sizeGuard.ts";

/*
 * D-261116-015 and D-261119-021: a player's exact part counts only what
 * their copy shows, so an op that leaves their copy as it was leaves what
 * the exact part shows, and where, as it was. The exceptions, tracked
 * privately as residuals: a thing of theirs the op makes or removes
 * outright, which shows once, and the DM putting an area of theirs their
 * copy does not hold on a creature or taking it off one. One the DM hid
 * counts as a deleted one does (LP43-PRIV-1), so only what it follows
 * decides whether it is held then.
 */

const copyOf = (state: RoomState, memberId: string) => stableStringify(projectState(state, { memberId, role: "player" }, { sceneId: null }));

const there = (state: RoomState, key: string) => (key.startsWith("row:") ? (state.encounter?.entries.some((e) => `row:${e.id}` === key) ?? false) : readEntity(state, key as EntityKey) != null);

/** Whether the op put an area on a creature or took it off one. */
function reattached(before: RoomState, after: RoomState, key: string): boolean {
  if (!key.startsWith("template:")) return false;
  const area = (state: RoomState) => readEntity(state, key as EntityKey) as { attachedTo?: string } | undefined;
  return area(before)?.attachedTo !== area(after)?.attachedTo;
}

/** What of `memberId`'s exact part shows otherwise, or counts in another scope, after the op, but for things it made or removed. */
function shownMoved(before: RoomState, after: RoomState, memberId: string): string[] {
  const [was, is] = [exactCopies(before, memberId), exactCopies(after, memberId)];
  const out: string[] = [];
  for (const key of new Set([...was.keys(), ...is.keys()])) {
    const [a, b] = [was.get(key), is.get(key)];
    if (a && b) {
      const [from, to] = [a.shownOn ?? a.on, b.shownOn ?? b.on];
      if (a.shown !== b.shown || from !== to) out.push(`${key}: ${a.shown} B on ${from}, then ${b.shown} B on ${to}`);
    } else if (there(before, key) && there(after, key) && !reattached(before, after, key)) out.push(`${key} ${a ? "left" : "came into"} the exact part`);
  }
  return out;
}

const players = (state: RoomState) => Object.keys(state.members).filter((id) => state.members[id]!.kind === "player");

/** `op` by `who` on `state`, and for each player whose copy it leaves as it was, what of their exact part it moved. */
function moves(state: RoomState, op: Op, who: Viewer = DM): { next: RoomState | null; moved: string[]; unchanged: number } {
  const result = applyOp(state, op, who, env(6_000_000));
  if (!result.ok) return { next: null, moved: [], unchanged: 0 };
  const moved: string[] = [];
  let unchanged = 0;
  for (const id of players(state)) {
    if (copyOf(state, id) !== copyOf(result.state, id)) continue;
    unchanged++;
    moved.push(...shownMoved(state, result.state, id).map((why) => `${id}: ${why}`));
  }
  return { next: result.state, moved, unchanged };
}

/** P1's riding area and kept ruler on a hidden creature `y`, which stands on a floor P1 holds, and a scene P1 does not hold. */
function onHidden(): RoomState {
  const state = room({ scenes: { s1: scene("s1"), s2: scene("s2", { order: 1 }) } });
  state.characters.c1 = character("c1", { ownerIds: ["p1"], actor: actor() });
  state.tokens.hero = token("hero", { kind: "pc", actor: { ref: "c1" }, ownerIds: ["p1"], x: 2, y: 2 });
  state.tokens.y = token("y", { x: 9, y: 9, visibility: "dm" });
  state.templates.a1 = template("a1", { ownerId: "p1", attachedTo: "y", casterId: "hero", label: "Faerie Fire" });
  state.drawings.r1 = drawing("r1", { kind: "ruler", ownerId: "p1", anchors: ["hero", "y"], points: [2.5, 2.5, 9.5, 9.5] });
  return state;
}

describe("D-261119-021: an op that leaves a player's copy as it was leaves what their exact part shows as it was", () => {
  test("the DM moves the hidden creature P1's area and ruler are on to a scene P1 does not hold", () => {
    const { moved, unchanged } = moves(onHidden(), { t: "token.update", tokenId: "y", patch: { sceneId: "s2", x: 3, y: 3 } } as Op);
    assert.ok(unchanged > 0, "P1's copy is as it was");
    assert.deepEqual(moved, []);
  });

  test("the DM hides P1's area, renames it or resizes it while its creature is out of P1's sight", () => {
    for (const patch of [{ visibility: "dm" }, { label: "A much longer name for the area" }, { size: 60 }]) {
      const { moved, unchanged } = moves(onHidden(), { t: "template.update", templateId: "a1", patch } as Op);
      assert.ok(unchanged > 0, `P1's copy is as it was after ${JSON.stringify(patch)}`);
      assert.deepEqual(moved, [], JSON.stringify(patch));
    }
  });

  test("the DM deletes the hidden creature, which takes P1's area with it, or deletes P1's ruler: only that thing leaves, once (a residual)", () => {
    for (const op of [{ t: "token.delete", tokenId: "y" }, { t: "drawing.delete", drawingId: "r1" }] as Op[]) {
      const state = onHidden();
      const { next, moved, unchanged } = moves(state, op);
      assert.ok(unchanged > 0 && next);
      assert.deepEqual(moved, []);
      const [was, is] = [exactCopies(state, "p1"), exactCopies(next, "p1")];
      const gone = [...was.keys()].filter((key) => !is.has(key));
      assert.deepEqual(gone, [op.t === "token.delete" ? "template:a1" : "drawing:r1"]);
    }
  });

  test("random rooms through the DM's ops, P1's areas and rulers on hidden creatures among them", () => {
    const found: string[] = [];
    let checked = 0;
    for (let seed = 1; seed <= 300 && found.length < 10; seed++) {
      const r = rng(seed * 17 + 3);
      let state = randomState(r);
      // P1's area and ruler on a hidden creature in half the rooms, and a fight in a third.
      const hidden = Object.values(state.tokens).find((t) => t.visibility === "dm" && t.ownerIds.length === 0);
      if (hidden && seed % 2 === 0) {
        state.templates.pa = template("pa", { sceneId: hidden.sceneId, ownerId: "p1", attachedTo: hidden.id, label: "Bless" });
        state.drawings.pr = drawing("pr", { sceneId: hidden.sceneId, kind: "ruler", ownerId: "p1", anchors: [null, hidden.id], points: [1.5, 1.5, hidden.x + 0.5, hidden.y + 0.5] });
      }
      if (seed % 3 === 0 && !state.encounter && hidden) state.encounter = { rev: 0, round: 1, activeEntryId: "rh", entries: [entry("rh", { tokenId: hidden.id, hidden: true })] };
      for (let k = 0; k < 10; k++) {
        const op = randomOp(r, state, DM);
        const { next, moved, unchanged } = moves(state, op);
        if (!next) continue;
        checked += unchanged;
        found.push(...moved.map((why) => `seed ${seed}, ${op.t}: ${why}`));
        state = next;
      }
    }
    assert.deepEqual(found.slice(0, 10), []);
    assert.ok(checked > 500, `${checked} ops left a player's copy as it was`);
  });
});
