import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { opKind } from "#shared/farLine.ts";
import { FAR } from "#shared/limits.ts";
import type { RoomState, Viewer } from "#shared/model.ts";
import type { Op } from "#shared/protocol.ts";
import { applyOp } from "#shared/reducer.ts";
import { actor, character, DM, entry, env, P1, room, token, trap } from "#shared/testutil.ts";
import { MAX_LOG } from "#shared/logRings.ts";
import { knownBy, parked } from "./copyTwinsTesting.ts";
import { exactBuilds, exactReads, growthBound, measuredStateBytes, SizeGuard, touchedScenes } from "./sizeGuard.ts";

/*
 * D-261121-065 and 076 (design 2): a player's far check builds their copy
 * before and after on every op that meets the line, at every line, and
 * reuses none across ops. Twins apart only in the DM's hidden ops
 * between P1's, or in a hidden pit under P1's move, count alike on every
 * op of P1's, at half the room's line, just under it and just past it.
 */

let seq = 5_000;

/** P1's table: their hero on its turn, the DM's goblin, room to walk. */
function table(): RoomState {
  const state = room();
  state.characters.c1 = character("c1", { ownerIds: ["p1"], actor: actor({ notes: "", dmNotes: "", speeds: { walk: 300 } }) });
  state.tokens.hero = token("hero", { kind: "pc", actor: { ref: "c1" }, ownerIds: ["p1"], x: 2, y: 2 });
  state.tokens.gob = token("gob", { x: 9, y: 9, visibility: "dm" });
  state.encounter = { rev: 0, round: 1, activeEntryId: "rhero", entries: [entry("rhero", { tokenId: "hero", value: 20 }), entry("rgob", { tokenId: "gob", value: 5 })], turnStart: { entryId: "rhero", tokenId: "hero", sceneId: "s1", x: 2, y: 2, elevation: 0, seen: true, seq: 7 } };
  return state;
}

/** P1's ops: walks, a create, a chat line, an edit of their notes. */
const P1_OPS: Op[] = [
  { t: "token.move", tokenId: "hero", x: 4, y: 2 },
  { t: "drawing.create", drawing: { id: "t-line", sceneId: "s1", kind: "line", points: [1, 1, 3, 3], style: { stroke: "#ffffff", width: 2, opacity: 1 }, ownerId: "p1", visibility: "all" } } as Op,
  { t: "log.chat", text: "onward" },
  { t: "character.update", characterId: "c1", patch: { actor: { notes: "n".repeat(300) } } } as Op,
  { t: "token.move", tokenId: "hero", x: 6, y: 3 },
];

/** The DM's hidden op between P1's ops in one twin: notes on the hidden goblin, which P1's copy does not hold. */
const hiddenOp = (i: number): Op => ({ t: "token.update", tokenId: "gob", patch: { notes: "h".repeat(40_000 + i * 20_000) } }) as Op;

/** What the DM does before each of P1's ops in one twin: its ops, each counted by the guard, and growth counted as a springing is. */
type Hidden = { ops?: (i: number) => Op[]; springing?: number };

/**
 * The copy builds and exact stepped reads of each of P1's ops on `start`,
 * through one guard as the actor keeps it across a room's ops, with the
 * DM's work of `hidden` before each, or the one hidden op where it is true.
 */
function costs(start: RoomState, hidden: Hidden | boolean, ops: readonly Op[] = P1_OPS, who: Viewer = P1): { builds: number[]; reads: number[] } {
  const guard = new SizeGuard({ stateLimit: 64 * 1024 * 1024, sceneLimit: 64 * 1024 * 1024 });
  guard.stateMeasured(measuredStateBytes(start), start);
  let state = start;
  const out = { builds: [] as number[], reads: [] as number[] };
  const work: Hidden = hidden === true ? { ops: (i) => [hiddenOp(i)] } : hidden === false ? {} : hidden;
  const apply = (op: Op, who: Viewer) => {
    const r = applyOp(state, op, who, env(++seq));
    assert.ok(r.ok, r.ok ? "" : `${op.t}: ${r.message}`);
    const measured = r.withoutTraps ? r.withoutTraps() : r;
    assert.ok(measured.ok);
    const scenes = touchedScenes(state, measured.state, measured.touched);
    const growth = growthBound(state, measured.state, measured.touched);
    if (who.role === "player") {
      const [built, read] = [exactBuilds.count, exactReads.count];
      guard.check(measured.state, scenes, growth, state, "player", "widest", opKind(op).far === "exempt", who.memberId);
      out.builds.push(exactBuilds.count - built);
      out.reads.push(exactReads.count - read);
    } else guard.counted(measured.state, scenes, growth, state);
    state = r.state;
  };
  for (const [i, op] of ops.entries()) {
    for (const dm of work.ops?.(i) ?? []) apply(dm, DM);
    // As the actor counts a springing its op measured without (actor.ts #reduce).
    if (work.springing) guard.grew(work.springing, [Object.keys(state.scenes)[0]!]);
    apply(op, who);
  }
  return out;
}

/** The copy builds of each of P1's ops (costs). */
const builds = (start: RoomState, withHidden: boolean, ops: readonly Op[] = P1_OPS): number[] => costs(start, withHidden, ops).builds;

describe("a player's far check builds both copies on every op (design 2)", () => {
  for (const [what, offset] of [["at half the room's line", -FAR.roomBytes / 2], ["just under it", -40_000], ["just past it", 40_000]] as const) {
    test(`${what}, twins with the DM's hidden ops between P1's or none count two builds on each of P1's ops`, () => {
      const state = table();
      parked([state], "room", "s1", offset);
      const [a, b] = [builds(structuredClone(state), true), builds(structuredClone(state), false)];
      assert.deepEqual(a, b);
      assert.deepEqual(a, P1_OPS.map(() => 2));
    });
  }

  test("a hidden pit springing under P1's move, against no pit, counts alike just under the line and just past it", () => {
    for (const offset of [-40_000, 40_000]) {
      const plain = table();
      const pit = structuredClone(plain);
      pit.traps = { t1: trap("t1", { sceneId: "s1", zone: { cells: [{ x: 4, y: 2, w: 1, h: 1 }] }, rig: { ...trap("t1").rig!, pit: { floor: -10 } } }) };
      parked([plain, pit], "room", "s1", offset);
      assert.deepEqual(builds(pit, false), builds(plain, false), `${offset} from the line`);
    }
  });
});

/*
 * D-261121-017: the check reads both stepped parts exactly on every op, the
 * room's and every scene's, so the bounds the guard keeps for the DM's ops
 * decide nothing of a player's. Hidden work that nets to nothing, a
 * springing the actor counts, and lines P1's own chats drop with hidden
 * bytes each raise those bounds in one twin alone.
 */
describe("a player's far check reads both stepped parts exactly on every op (D-261121-017)", () => {
  /** The DM writes notes on the hidden goblin and takes them off again before each of P1's ops. */
  const churn: Hidden = { ops: () => [{ t: "token.update", tokenId: "gob", patch: { notes: "h".repeat(3_000) } } as Op, { t: "token.update", tokenId: "gob", patch: { notes: "" } } as Op] };
  for (const [what, offset] of [["at half the room's line", -FAR.roomBytes / 2], ["just under it", -40_000], ["just past it", 40_000]] as const) {
    test(`${what}, hidden notes written and taken off before each of P1's ops, or a springing counted, read alike with neither`, () => {
      const state = table();
      parked([state], "room", "s1", offset);
      const plain = costs(structuredClone(state), false);
      for (const [name, work] of [["notes on and off", churn], ["a springing", { springing: 3_000 }]] as const) assert.deepEqual(costs(structuredClone(state), work), plain, name);
      assert.ok(plain.reads.every((n) => n === plain.reads[0]) && plain.reads[0]! >= 4, `the room's and each scene's, both sides: ${plain.reads}`);
    });
  }

  test("P1's chats that drop shared HP lines, whose conditions P1's copy leaves out, read alike with 1 condition a line or 20", () => {
    const twins = [1, 20].map((conditions) => {
      const state = table();
      state.tokens.orc = token("orc", { x: 6, y: 6, visibility: "all", actor: { inline: actor({ dmNotes: "" }) } });
      const vitals = { hp: { cur: 5, max: 20, temp: 0 }, life: "alive" as const, deathSaves: { ok: 0, fail: 0 } };
      const added = Array.from({ length: conditions }, (_, i) => ({ id: `e-hit-${i}`, key: "custom", label: `Hex ${i}` }));
      const hp = Array.from({ length: 8 }, (_, i) => ({ id: `${10 + i}:0`, at: "2026-11-21T20:00:00.000Z", kind: "event", data: { type: "hp", change: "damage", amount: 3, label: "Bloodied", left: vitals.hp, revert: { before: vitals, after: vitals, added }, tokenId: "orc", seen: true } }));
      const chat = Array.from({ length: MAX_LOG - hp.length }, (_, i) => ({ id: `${100 + i}:0`, at: "2026-11-21T20:00:00.000Z", kind: "chat", from: "dm1", text: `Onward ${i}` }));
      state.log = [...hp, ...chat] as RoomState["log"];
      return state;
    }) as [RoomState, RoomState];
    assert.equal(knownBy(twins[0], "p1"), knownBy(twins[1], "p1"), "the twins look alike to P1");
    parked(twins, "room", "s1", -40_000);
    const chats = Array.from({ length: 8 }, (_, i): Op => ({ t: "log.chat", text: `c${i}` }));
    assert.deepEqual(costs(twins[1], false, chats), costs(twins[0], false, chats));
  });
});
