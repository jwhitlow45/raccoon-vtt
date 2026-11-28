import assert from "node:assert/strict";
import { describe, test } from "node:test";
import fc from "fast-check";
import type { PathStop, RoomState, Token, Viewer } from "../model.ts";
import { projectState } from "../project.ts";
import { DM, P1, actor, customMonster, effect, room, token } from "../testutil.ts";
import { reachInput, turnReach, type Chunks } from "./opportunity.ts";

/**
 * Opportunity Attack notices read each device's own copy
 * (docs/design/design-v1-opportunity-attacks.md 3): a player's scan is a
 * function of their projection alone. It names only creatures the
 * projection holds, never a hidden one, ignores a condition the DM hid,
 * reads 5 ft for a block it lacks, and nothing the DM changes out of their
 * sight changes it.
 */

const NONE: Chunks = { rolls: {}, monsters: [] };

/** The player's copy, as their device holds it. */
function seen(state: RoomState, viewer: Viewer = P1): RoomState {
  return projectState(state, viewer, { sceneId: null }) as unknown as RoomState;
}

function leftIn(view: RoomState, stops: readonly PathStop[], viewer: Viewer): string[] {
  const read = reachInput(view, "bree", { turn: 1, stops: [...stops] }, NONE, viewer);
  assert.ok(read);
  return turnReach(read.input, read.legs).flatMap((l) => (l.leaves === "over" ? [] : l.leaves.map((x) => x.id)));
}

function reactorsIn(view: RoomState, stops: readonly PathStop[], viewer: Viewer) {
  return reachInput(view, "bree", { turn: 1, stops: [...stops] }, NONE, viewer)!.input.reactors;
}

const bree = () => token("bree", { kind: "pc", name: "Bree", disposition: "ally", ownerIds: ["p1"], x: 2, y: 2 });
const ogreBlock = () => customMonster("ogre", { name: "Ogre", actions: [{ name: "Greatclub", text: "Melee Attack Roll: +6, reach 10 ft. Hit: 13." }] });
const away = [{ x: 2, y: 2, elevation: 0 }, { x: 2, y: 6, elevation: 0 }];

describe("a player's notices read their own copy (docs/design/design-v1-opportunity-attacks.md 3)", () => {
  test("a hidden goblin beside Bree's path: the player's scan names nothing, the DM's names it", () => {
    const state = room({ tokens: { bree: bree(), gob: token("gob", { name: "Goblin 2", x: 3, y: 2, visibility: "dm" }) } });
    assert.deepEqual(leftIn(state, away, DM), ["gob"]);
    assert.deepEqual(leftIn(seen(state), away, P1), []);
  });

  test("a hidden Incapacitated on a seen goblin: a row for the player, none for the DM", () => {
    const state = room({ tokens: { bree: bree(), gob: token("gob", { x: 3, y: 2, actor: { inline: actor({ effects: [effect("e", { key: "incapacitated", hiddenFromPlayers: true })] }) } }) } });
    assert.deepEqual(leftIn(state, away, DM), []);
    assert.deepEqual(leftIn(seen(state), away, P1), ["gob"]);
  });

  test("a step from 5 ft to 10 ft of an Ogre with 10 ft: the player's row, read at 5 ft, and none for the DM", () => {
    const state = room({ tokens: { bree: bree(), ogre: token("ogre", { name: "Ogre", x: 3, y: 2, actor: { inline: actor({ monsterId: "ogre" }) } }) }, monsters: { ogre: ogreBlock() } });
    const step = [{ x: 2, y: 2, elevation: 0 }, { x: 1, y: 2, elevation: 0 }];
    assert.deepEqual(leftIn(state, step, DM), []);
    assert.deepEqual(leftIn(seen(state), step, P1), ["ogre"]);
    const [read] = reactorsIn(seen(state), step, P1);
    assert.deepEqual([read?.reaches, read?.known], [[5], false], "5 ft counted, for want of its block");
  });

  type Spec = { x: number; y: number; hidden: boolean; secretCondition: boolean; block: boolean };
  const creature = fc.record({ x: fc.integer({ min: 0, max: 8 }), y: fc.integer({ min: 0, max: 8 }), hidden: fc.boolean(), secretCondition: fc.boolean(), block: fc.boolean() });
  const walk = fc.array(fc.record({ x: fc.integer({ min: 0, max: 8 }), y: fc.integer({ min: 0, max: 8 }), elevation: fc.constant(0) }), { minLength: 2, maxLength: 4 });

  function world(specs: readonly Spec[], start: { x: number; y: number }): RoomState {
    const tokens: Record<string, Token> = { bree: { ...bree(), x: start.x, y: start.y } };
    specs.forEach((c, i) => {
      const effects = c.secretCondition ? [effect(`e${i}`, { key: "stunned", hiddenFromPlayers: true })] : [];
      tokens[`g${i}`] = token(`g${i}`, { name: `Goblin ${i}`, x: c.x, y: c.y, visibility: c.hidden ? "dm" : "all", actor: { inline: actor({ effects, senses: "Blindsight 30 ft.", ...(c.block ? { monsterId: "ogre" } : {}) }) } });
    });
    return room({ tokens, monsters: { ogre: ogreBlock() } });
  }

  test("a player's scan names only creatures their copy holds, and is the same whatever the DM changes out of their sight", () => {
    fc.assert(
      fc.property(fc.array(creature, { maxLength: 8 }), walk, fc.nat(), (specs, stops, pick) => {
        const state = world(specs, stops[0]!);
        const view = seen(state);
        const hidden = new Set(Object.values(state.tokens).filter((t) => t.visibility === "dm").map((t) => t.id));
        const reactors = reactorsIn(view, stops, P1);
        const left = leftIn(view, stops, P1);
        for (const id of [...reactors.map((r) => r.id), ...left]) {
          assert.ok(view.tokens[id], `${id} is in the player's copy`);
          assert.ok(!hidden.has(id), `${id} is hidden from players`);
        }
        for (const r of reactors) assert.deepEqual([r.reaches, r.known, r.blindsight], [[5], false, 0], "no block, reach or senses of a creature they do not own");
        // What the DM changes out of the player's sight: a hidden creature moved, a condition hidden, a block's reach.
        const changed: RoomState = structuredClone(state);
        const ids = Object.keys(changed.tokens).filter((id) => id !== "bree");
        const id = ids[pick % Math.max(1, ids.length)];
        if (id !== undefined) {
          const t = changed.tokens[id]!;
          if (t.visibility === "dm") changed.tokens[id] = { ...t, x: (t.x + 3) % 9, y: (t.y + 1) % 9 };
          if ("inline" in t.actor) t.actor.inline.effects.push(effect("late", { key: "unconscious", hiddenFromPlayers: true }));
        }
        changed.monsters.ogre = customMonster("ogre", { name: "Ogre", actions: [{ name: "Tail", text: "Melee Attack Roll: +6, reach 30 ft. Hit: 13." }] });
        const after = seen(changed);
        assert.deepEqual(reactorsIn(after, stops, P1), reactors);
        assert.deepEqual(leftIn(after, stops, P1), left);
      }),
      { numRuns: 200 },
    );
  });
});
