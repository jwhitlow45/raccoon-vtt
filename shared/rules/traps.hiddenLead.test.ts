import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { RoomState, Token } from "../model.ts";
import { projectState, stableStringify } from "../project.ts";
import type { Op } from "../protocol.ts";
import { applyOp } from "../reducer.ts";
import { DM, env, member, P1, P2, room, scene, token, trap } from "../testutil.ts";
import { footprintRect } from "./footprint.ts";
import { SQUARES } from "./grid.ts";
import { planWalks } from "./moveLeg.ts";
import { planTrapMove, trapLandings, trapWalks } from "./traps.ts";

/**
 * A trap stop with a lead players cannot see, and what they see in its
 * file (review FU48-OPUS-10). From op version 41 each creature in single
 * file steps back off the stopped lead's box (traps.ts fileApart), so the
 * hidden lead's size decides where a creature players see stands. Every
 * creature in a lead's file is under the lead, so where the lead is hidden
 * all that steps back is under a holder players cannot see: what the
 * carried reveal already lets show (design-v1-traps.md, "Its reveals"),
 * as the file's line itself does, which runs on the hidden lead's middle.
 * Two rooms that differ only in the hidden horse's size, Large or Huge,
 * give every player the same copy, its log and the undo mark included,
 * the tokens they see under a hidden holder left out, as in the twin rooms
 * of review FU45BR-OPUS-13.
 */

type Shape = "carried" | "dragged";

/**
 * The DM drags a hidden horse east along row 6 and ends it squeezed, so
 * what it drags follows in single file. "carried": a hidden goblin it drags
 * carries an owl every player sees. "dragged": it drags a goblin every
 * player sees. Pat's fighter stands far off, and a trap that stops a walk
 * lies across x 8.
 */
function twin(size: "large" | "huge", shape: Shape): RoomState {
  const s = room({ members: { dm1: member("dm1", "dm"), p1: member("p1"), p2: member("p2") }, scenes: { s1: scene("s1", { bounds: { w: 30, h: 20 }, blockMovement: true, autoWalls: "off" }) } });
  s.buildChunks = {};
  const hidden = { visibility: "dm" as const };
  s.tokens.horse = token("horse", { size, x: 2, y: 5, name: "Horse", kind: "npc", ownerIds: [], ...hidden });
  s.tokens.gob = token("gob", { size: "small", x: 1, y: 6, name: "Gob", kind: "npc", ownerIds: [], ...(shape === "carried" ? hidden : {}), attached: { to: "horse", kind: "drag" } });
  if (shape === "carried") s.tokens.owl = token("owl", { size: "tiny", x: 1, y: 6, name: "Owl", kind: "npc", ownerIds: [], attached: { to: "gob", kind: "carry" } });
  s.tokens.pc = token("pc", { x: 20, y: 15, name: "Pc", kind: "pc", ownerIds: ["p1"] });
  s.traps.t1 = trap("t1", { zone: { cells: [{ x: 8, y: 4, w: 1, h: 5 }] }, rig: { on: ["enter"], who: "any", floor: true, resets: "never", stops: true, foundOnSpring: true, hits: "trigger", actions: [], find: [], notice: false } });
  return s;
}

const east: Op = { t: "token.move", tokenId: "horse", x: 14, y: 5, squeeze: true, route: [[3, 6, 1, 0], [15, 6, 1, 0]] };

/** The tokens players see that a holder they cannot see carries, drags or seats, at any depth up the chain of holders. */
function underHidden(s: RoomState): Set<string> {
  const out = new Set<string>();
  for (const t of Object.values(s.tokens)) {
    if (!t || t.visibility === "dm") continue;
    for (let up = t.attached ? s.tokens[t.attached.to] : undefined; up; up = up.attached ? s.tokens[up.attached.to] : undefined) {
      if (up.visibility !== "dm") continue;
      out.add(t.id);
      break;
    }
  }
  return out;
}

/** Every player's copy of the scene without the tokens `left` names, a player at a time. */
function copies(s: RoomState, left: ReadonlySet<string> = new Set()): string[] {
  return [P1, P2].map((v) => {
    const copy = projectState(s, v, { sceneId: "s1" });
    return stableStringify({ ...copy, tokens: Object.fromEntries(Object.entries(copy.tokens).filter(([id]) => !left.has(id))) });
  });
}

/**
 * Plays the move in both twins, after `each` checks each room's plan, and
 * compares every player's copy: whole, where the one they see under the
 * hidden horse must land apart, so the comparison is live, and without the
 * tokens under a hidden holder, where they must match.
 */
function compareTwins(shape: Shape, seen: string, each: (s: RoomState, size: string) => void): void {
  const rooms = (["large", "huge"] as const).map((size) => twin(size, shape));
  const [large, huge] = rooms as [RoomState, RoomState];
  assert.deepEqual(copies(huge), copies(large), "the players' copies start the same");
  const under = underHidden(large);
  assert.deepEqual([...under], [seen], "the one players see is under the hidden horse");
  const [a, b] = rooms.map((s) => {
    const size = s.tokens.horse!.size!;
    const walk = trapWalks(east, s, DM, {}).find((w) => w.tokenId === seen)!;
    assert.deepEqual([walk.isPublic, walk.walker], [true, true], `${size}: a public walker`);
    assert.equal(planWalks(east, s, DM, {}).find((m) => m.tokenId === "gob")?.file, true, `${size}: the goblin in single file`);
    assert.deepEqual(planTrapMove(east, s, DM, {}).springings.map((x) => [x.trap.id, x.pass, x.by]), [["t1", "public", [seen]]], `${size}: the one players see sets it off`);
    each(s, size);
    const r = applyOp(structuredClone(s), east, DM, env(5));
    assert.ok(r.ok, r.ok ? "" : r.message);
    return r;
  });
  assert.ok(a?.ok && b?.ok);
  const pose = (st: RoomState) => [st.tokens[seen]!.x, st.tokens[seen]!.y];
  assert.notDeepEqual(pose(b.state), pose(a.state), "the hidden horse's size reaches where it lands: the carried reveal, live here");
  assert.notEqual(copies(b.state)[0], copies(a.state)[0], "so the whole copies differ");
  const [pa, pb] = [copies(a.state, under), copies(b.state, under)];
  assert.equal(pb[0], pa[0], "Pat's copy, the tokens under a hidden holder left out");
  assert.equal(pb[1], pa[1], "the other player's copy, the tokens under a hidden holder left out");
  assert.deepEqual([b.trapped, b.log.length], [a.trapped, a.log.length], "the undo mark and the log");
}

describe("a hidden lead's box at a trap stop moves only what players see under a hidden holder (review FU48-OPUS-10)", () => {
  test("an owl every player sees, on a hidden goblin in the file, steps back off the hidden horse, Large or Huge, and nothing else they see changes", () => {
    compareTwins("carried", "owl", (s, size) => {
      assert.notEqual(planTrapMove(east, s, DM, {}).op, east, `${size}: the trap cuts the move`);
      // Clear of the horse's box where the stop leaves the horse, so its step back read the hidden lead's size.
      const landed = trapLandings(east, s, DM, {});
      const box = (id: string) => footprintRect(SQUARES, { ...(s.tokens[id] as Token), ...landed.get(id)! });
      const [h, t] = [box("horse"), box("owl")];
      assert.ok(t.x + t.w <= h.x || t.y + t.h <= h.y || t.y >= h.y + h.h, `${size}: the owl at ${t.x}, ${t.y} clear of the horse's box at ${h.x}, ${h.y}`);
    });
  });

  test("a goblin every player sees in the hidden horse's file: the group stops behind either horse, and still nothing else they see changes", () => {
    // The file runs on the horse's middle, so behind a Large horse it leaves the goblin half a square off its grid. From op version
    // 52 it is judged there on its own grid's spot beside it, on ground every player sees (TRAP-FILE-HALF-OFF), so the trap stops
    // the group behind the Large horse too. At 51 only behind the Huge one did it.
    compareTwins("dragged", "gob", (s, size) => {
      assert.notEqual(planTrapMove(east, s, DM, {}).op, east, `${size}: the trap cuts the move`);
      assert.equal(planTrapMove(east, s, DM, { opVersion: 51 }).op !== east, size === "huge", `${size}: whether the trap cut the move at op 51`);
    });
  });
});
