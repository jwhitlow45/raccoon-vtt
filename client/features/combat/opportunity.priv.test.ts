import "../../components/testing/register.ts";
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { RoomState, Viewer } from "#shared/model.ts";
import { APART, AYLA, limitsRoom, ROOM_R } from "#shared/privTestutil.ts";
import { projectState } from "#shared/project.ts";
import type { Op } from "#shared/protocol.ts";
import { applyOp } from "#shared/reducer.ts";
import { reachInput, turnReach } from "#shared/rules/opportunity.ts";
import { actor, customMonster, DM, effect, env, int, P1, rng, token } from "#shared/testutil.ts";
import { pathNow } from "../measure/movement.ts";

const { LegJobs } = await import("./opportunity.ts");

/*
 * A player's Opportunity Attack notices read their projection alone
 * (docs/design/design-v1-opportunity-attacks.md 3): over random rooms of the
 * player limits twins' kind, with Ayla (P1's) walking among creatures she
 * sees and creatures only the DM sees, the leg jobs and the scan over
 * projectState(state, P1) name only creatures P1's copy holds, and say the
 * same when a hidden creature moves, a condition is hidden from players or
 * a room monster's block changes. The DM's, read from the whole room, may
 * name the hidden ones, which keeps the property from passing on nothing.
 */

const NO_CHUNKS = { rolls: "failed", monsters: "failed" } as const;

function run(state: RoomState, op: Op, who: Viewer = DM, seq = 100): RoomState {
  const r = applyOp(state, op, who, env(seq));
  if (!r.ok) throw new Error(`${op.t}: ${r.message}`);
  return r.state;
}

/** The copy a viewer holds: the DM's whole room, a player's projection. */
const copyOf = (state: RoomState, viewer: Viewer) => (viewer.role === "dm" ? state : (projectState(state, viewer, { sceneId: null }) as unknown as RoomState));

/** What the leg jobs publish for a viewer of `state`: each row's creature, and each leg's leaves. */
function jobsSay(state: RoomState, viewer: Viewer): { rows: string[]; leaves: string[]; text: string } {
  const timers: (() => void)[] = [];
  const jobs = new LegJobs({ later: (r) => (timers.push(r), () => {}), load: { rolls: () => Promise.reject(new Error("none")), monsters: () => Promise.reject(new Error("none")) }, storage: null });
  // The chunks never load here: no creature in these rooms needs them, so none is waited for.
  jobs.sync({ key: `k|${viewer.memberId}`, view: copyOf(state, viewer), viewer, on: true });
  for (let i = 0; i < 100_000 && timers.length > 0; i++) timers.shift()!();
  const mover = jobs.store.getState().movers[AYLA];
  return { rows: mover?.rows.map((r) => r.left.id) ?? [], leaves: mover?.legs.flatMap((l) => l.leaves.map((x) => x.id)) ?? [], text: JSON.stringify([jobs.store.getState(), jobs.leaves.getState(), [...(jobs.leaves.getState().movers[AYLA]?.skip ?? [])]]) };
}

/** The whole turn's scan of the copy, as the shared rules read it. */
function scanSays(state: RoomState, viewer: Viewer): string[] {
  const copy = copyOf(state, viewer);
  const built = reachInput(copy, AYLA, pathNow(copy.encounter, copy.tokens[AYLA]!, viewer.role), NO_CHUNKS, viewer);
  if (!built) return [];
  return turnReach(built.input, built.legs).flatMap((l) => (l.leaves === "over" ? [] : l.leaves.map((x) => x.id)));
}

type Room = { state: RoomState; hidden: string[]; seen: string[]; stunned: string; lurker: string };

/** Ayla on her turn in room R among seen goblins, a seen goblin Stunned in secret, a room monster and creatures only the DM sees, then a random walk. */
function room(seed: number): Room {
  const r = rng(seed);
  let state = limitsRoom();
  const at = () => ({ x: int(r, ROOM_R.x + 1, ROOM_R.x + ROOM_R.w - 2), y: int(r, ROOM_R.y + 1, ROOM_R.y + ROOM_R.h - 2) });
  const seen: string[] = [];
  const hidden: string[] = [];
  for (let i = 0; i < 3; i++) {
    const id = `goblin${i}`;
    state.tokens[id] = token(id, { name: "Goblin", number: i + 1, ...at() });
    seen.push(id);
  }
  for (let i = 0; i < 3; i++) {
    const id = `${APART}shade${i}`;
    state.tokens[id] = token(id, { name: `${APART}shade ${i}`, visibility: "dm", ...at() });
    hidden.push(id);
  }
  const stunned = "stunned";
  state.tokens[stunned] = token(stunned, { name: "Hobgoblin", ...at() });
  seen.push(stunned);
  // A room monster with a 10 ft Glaive, whose block only the DM reads.
  state.monsters.m1 = customMonster("m1", { name: "Pole Lurker", actions: [{ name: "Glaive", text: "Melee Attack Roll: +5, reach 10 ft. Hit: 8 (1d10 + 3) Slashing damage." }] });
  const lurker = "lurker";
  state.tokens[lurker] = token(lurker, { name: "Pole Lurker", size: "medium", ...at(), actor: { inline: actor({ monsterId: "m1" }) } });
  seen.push(lurker);
  state.tokens[AYLA] = { ...state.tokens[AYLA]!, ...at(), ownerIds: ["p1"] };
  state = run(state, { t: "encounter.start", entries: [{ id: "ea", tokenId: AYLA, value: 20 }] } as Op);
  state = run(state, { t: "encounter.next" } as Op, DM, 101);
  for (let k = 0; k < int(r, 1, 4); k++) {
    const to = at();
    state = run(state, { t: "token.move", tokenId: AYLA, x: to.x, y: to.y } as Op, P1, 110 + k);
  }
  return { state, hidden, seen, stunned, lurker };
}

describe("a player's notices read their projection alone", () => {
  test("rows and leaves name only creatures P1's copy holds, the jobs' and the scan's alike", () => {
    let dmNamedHidden = 0;
    for (let seed = 1; seed <= 60; seed++) {
      const { state, hidden } = room(seed);
      const copy = copyOf(state, P1);
      // Every id and name of a creature only the DM sees carries APART, so nothing the jobs publish for P1 may.
      assert.ok(!jobsSay(state, P1).text.includes(APART), `seed ${seed}: the jobs published a hidden creature to P1`);
      for (const said of [jobsSay(state, P1).leaves, jobsSay(state, P1).rows, scanSays(state, P1)]) {
        for (const id of said) assert.ok(copy.tokens[id] !== undefined, `seed ${seed}: ${id} is not in P1's copy`);
        for (const id of hidden) assert.ok(!said.includes(id), `seed ${seed}: the hidden ${id} named to P1`);
      }
      // Each job scans its leg with no one skipped, and the turn takes each creature's first leave, as the turn's scan does by its skip.
      assert.deepEqual([...new Set(jobsSay(state, P1).leaves)].sort(), scanSays(state, P1).sort(), `seed ${seed}: the jobs and the turn's scan agree`);
      if (scanSays(state, DM).some((id) => hidden.includes(id))) dmNamedHidden++;
    }
    assert.ok(dmNamedHidden > 5, `the DM's scan named a hidden creature in only ${dmNamedHidden} rooms, so the property read little`);
  });

  test("unchanged when a hidden creature moves, a condition is hidden from players, or a room monster's block changes", () => {
    let stunnedCounts = 0;
    let lurkerLeft = 0;
    for (let seed = 1; seed <= 60; seed++) {
      const { state, hidden, stunned, lurker } = room(seed);
      const before = jobsSay(state, P1);
      const moved = structuredClone(state);
      const shade = moved.tokens[hidden[0]!]!;
      moved.tokens[shade.id] = { ...shade, x: shade.x + 1, y: shade.y };
      assert.deepEqual(jobsSay(moved, P1), before, `seed ${seed}: a hidden creature moved`);
      const secret = structuredClone(state);
      const hob = secret.tokens[stunned]!;
      secret.tokens[stunned] = { ...hob, actor: { inline: actor({ effects: [effect("x1", { key: "stunned", hiddenFromPlayers: true })] }) } };
      assert.deepEqual(jobsSay(secret, P1), before, `seed ${seed}: a condition hidden from players`);
      // The DM's copy reads the condition: a Stunned creature has no Reaction to take.
      if (scanSays(state, DM).includes(stunned)) {
        stunnedCounts++;
        assert.ok(!jobsSay(secret, DM).rows.includes(stunned), `seed ${seed}: the DM's row of a Stunned creature`);
      }
      const reblocked = structuredClone(state);
      reblocked.monsters.m1 = { ...reblocked.monsters.m1!, actions: [{ name: "Tail", text: "Melee Attack Roll: +5, reach 15 ft. Hit: 8 (1d10 + 3) Bludgeoning damage." }] };
      assert.deepEqual(jobsSay(reblocked, P1), before, `seed ${seed}: a room monster's block changed`);
      if (scanSays(state, P1).includes(lurker)) lurkerLeft++;
    }
    assert.ok(stunnedCounts > 3 && lurkerLeft > 3, `too few rooms met the cases: ${stunnedCounts} with the Stunned one left, ${lurkerLeft} with the lurker`);
  });
});
