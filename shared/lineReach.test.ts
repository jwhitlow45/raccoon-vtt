import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { dmNumbered, eventLines, lineAudience } from "./logRings.ts";
import type { LogEntry, LogEvent, RoomState, Viewer } from "./model.ts";
import { projectState } from "./project.ts";
import type { Op } from "./protocol.ts";
import { applyOp, type Applied } from "./reducer.ts";
import { Tx } from "./reducer/tx.ts";
import { AT, DM, P1, P2, entry, env, room, template, token } from "./testutil.ts";

/**
 * A log line's readers, fixed when its op is done by the real projection
 * of the room (shared/project.ts lineReach). Every case runs real ops,
 * paired with the same room where the one rule that decides it is the
 * other way.
 */

function run(state: RoomState, op: Op, who: Viewer = DM, seq = 2, opVersion?: number): Applied {
  const r = applyOp(state, op, who, { ...env(seq), ...(opVersion !== undefined ? { opVersion } : {}) });
  assert.ok(r.ok, r.ok ? "" : `${op.t}: ${r.message}`);
  return r;
}

const live = (state: RoomState, viewer: Viewer) => projectState(state, viewer, { sceneId: "s1" }).log;
const chats = (n: number): LogEntry[] => Array.from({ length: n }, (_, i) => ({ id: `1:${i}`, at: AT, kind: "chat", from: "p1", text: `m${i}` }));

describe("a line's readers apply every rule a player's read applies (lineReach)", () => {
  test("a fight started behind the blackout is the DM's line: no player's full log moves for it, and it never comes out when play resumes", () => {
    for (const blackout of [false, true]) {
      let state = room();
      state.tokens.gob = token("gob", { name: "Goblin" });
      state.log = chats(200);
      if (blackout) state = run(state, { t: "view.blackout", blackout: true }, DM, 2).state;
      const before = live(state, P1);
      const started = run(state, { t: "encounter.start", entries: [{ id: "e-gob", tokenId: "gob", value: 12 }] }, DM, 3);
      const line = started.log.find((e) => e.data?.type === "encounter")!;
      if (!blackout) {
        assert.equal(lineAudience(line), "shared");
        assert.equal(live(started.state, P1).at(-1)!.data?.type, "encounter", "in play every player gets it");
        assert.equal(live(started.state, P1).length, 200, "and the oldest chat line went");
        continue;
      }
      assert.ok(dmNumbered(line.id), "behind the blackout no player could read it");
      assert.deepEqual(live(started.state, P1), before, "P1's log is as it was");
      const resumed = run(started.state, { t: "view.blackout", blackout: false }, DM, 4).state;
      assert.equal(live(resumed, P1).filter((e) => e.data?.type === "encounter").length, 0, "the board shows the fight, and the log keeps its line the DM's");
      assert.equal(live(resumed, DM).filter((e) => e.data?.type === "encounter").length, 1);
    }
  });

  /** P1 moves their own hero, on its turn, into P2's Spirit Guardians or past one far off. */
  function aura(x: number, othersSeen: boolean): RoomState {
    const state = room();
    state.meta = { ...state.meta, settings: { ...state.meta.settings, playersSeeAoeOfOthers: othersSeen } };
    state.tokens.hero = token("hero", { kind: "pc", name: "Ayla", x: 2, y: 5, ownerIds: ["p1"], disposition: "ally" });
    state.templates.sg = template("sg", { shape: "sphere", size: 10, origin: { x, y: 5.5, z: 0 }, spell: "Spirit Guardians", ownerId: "p2", triggers: ["enter"] });
    state.encounter = { rev: 0, round: 1, activeEntryId: "e-hero", entries: [entry("e-hero", { tokenId: "hero", value: 15 })], turnStart: { entryId: "e-hero", tokenId: "hero", sceneId: "s1", x: 2, y: 5, elevation: 0, seen: true, seq: 1 } };
    state.log = chats(200);
    return state;
  }

  test("a move into another player's area that players cannot see writes that player's line, and the mover's log is as if the area were far off", () => {
    const move: Op = { t: "token.move", tokenId: "hero", x: 6, y: 5 };
    for (const othersSeen of [false, true]) {
      const into = run(aura(6.5, othersSeen), move, P1);
      const away = run(aura(15.5, othersSeen), move, P1);
      const reminder = eventLines(into.log).find((e) => e.data?.type === "area")!;
      if (othersSeen) {
        assert.equal(lineAudience(reminder), "shared", "with areas shown, every player reads it");
        assert.equal(live(into.state, P1).at(-1)!.data?.type, "area");
        continue;
      }
      assert.ok(dmNumbered(reminder.id), "the line is the DM's");
      assert.deepEqual(into.log.filter((e) => lineAudience(e) === "party").map((e) => e.to), [["p2"]], "with a copy for the area's player");
      assert.deepEqual(live(into.state, P1), live(away.state, P1), "P1's log, its oldest line included, is the same either way");
      assert.equal(live(into.state, P2).at(-1)!.data?.type, "area");
    }
  });
});

describe("a party line's copy is the line as its reader read it", () => {
  test("a copy keeps a resume every player saw, on the turn of a row only its player sees", () => {
    const state = room();
    state.tokens.hero = token("hero", { kind: "pc", name: "Ayla", ownerIds: ["p1"] });
    state.tokens.shade = token("shade", { name: "Shade", visibility: "dm", ownerIds: ["p2"] });
    state.encounter = { rev: 0, round: 1, activeEntryId: "e-hero", entries: [entry("e-hero", { tokenId: "hero", value: 15 }), entry("e-shade", { tokenId: "shade", value: 10, tieOrder: 1 })] };
    const tx = new Tx(state, DM, { seq: 2, at: AT });
    tx.addEvent({ type: "turn", entryId: "e-shade", round: 1, back: true, to: "e-hero", toSeen: true });
    tx.finish();
    const copy = tx.state.log.find((e) => lineAudience(e) === "party")!;
    assert.deepEqual(copy.to, ["p2"]);
    assert.equal(copy.data?.type === "turn" && copy.data.toSeen, undefined, "the copy holds what P2 read, which names no mark");
    const read = live(tx.state, P2).find((e) => e.id === copy.id)!.data as Extract<LogEvent, { type: "turn" }>;
    assert.equal(read.to, "e-hero", "and still names the row every player saw resume");
  });
});
