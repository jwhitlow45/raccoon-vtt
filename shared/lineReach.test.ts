import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { resolveDiceOp, type DiceOp } from "./dice/resolve.ts";
import { dmNumbered, eventLines, lineAudience } from "./logRings.ts";
import type { LogEntry, LogEvent, RoomState, Viewer } from "./model.ts";
import { projectState } from "./project.ts";
import type { Op } from "./protocol.ts";
import { applyOp, type Applied } from "./reducer.ts";
import { Tx } from "./reducer/tx.ts";
import { AT, DM, P1, P2, entry, env, room, template, token } from "./testutil.ts";

/**
 * A log line's readers and its parts' readers, fixed when its op is done
 * by the real projection of the room (shared/project.ts lineReach). Every
 * case runs real ops, paired with the same room where the one rule that
 * decides it is the other way.
 */

function run(state: RoomState, op: Op, who: Viewer = DM, seq = 2, opVersion?: number): Applied {
  const r = applyOp(state, op, who, { ...env(seq), ...(opVersion !== undefined ? { opVersion } : {}) });
  assert.ok(r.ok, r.ok ? "" : `${op.t}: ${r.message}`);
  return r;
}

/** A `dice.roll` as the server stores it, every die showing its highest face. */
function rolled(state: RoomState, op: DiceOp, who: Viewer, seq: number): Applied {
  const resolved = resolveDiceOp(op, state, { draw: (sides) => sides, batch: "AbCdEfGhIjKlMnOp" });
  assert.ok(resolved.ok, resolved.ok ? "" : resolved.message);
  return run(state, resolved.op, who, seq);
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

describe("a part of a line keeps the readers it had when written (LineParts)", () => {
  /** A wolf everyone sees, whose HP others read only as a label, and a goblin no player sees. */
  function table(): RoomState {
    const state = room();
    state.tokens.wolf = token("wolf", { name: "Wolf", hpVisibility: "label" });
    state.tokens.gob = token("gob", { name: "Goblin", visibility: "dm" });
    return state;
  }

  const lend = (state: RoomState, tokenId: string, ownerIds: string[], seq: number) => run(state, { t: "token.update", tokenId, patch: { ownerIds } }, DM, seq).state;
  const dice = (line: LogEntry | undefined) => (line?.data?.type === "dice" ? line.data.rolls.map((r) => r.tokenId) : null);

  test("a DM's batch for a creature everyone sees and one no player sees keeps the hidden roll from a player lent that creature later", () => {
    const op: DiceOp = { t: "dice.roll", tag: "t1", to: "all", rolls: [{ formula: "1d20", label: "Bite", creature: { tokenId: "wolf" } }, { formula: "1d20", label: "Stab", creature: { tokenId: "gob" } }] };
    const first = rolled(table(), op, DM, 2);
    const line = first.state.log.find((e) => e.data?.type === "dice")!;
    assert.equal(lineAudience(line), "shared");
    assert.deepEqual(line.parts, { rolls: [null, []] }, "no player could read the goblin's roll");
    assert.deepEqual(dice(live(first.state, P1).at(-1)), ["wolf"]);
    const lent = lend(first.state, "gob", ["p1"], 3);
    assert.deepEqual(dice(live(lent, P1).find((e) => e.id === line.id)), ["wolf"], "the old line stays as P1 read it");
    // A batch rolled now, the goblin P1's, reaches P1 whole.
    const now = rolled(lent, { ...op, tag: "t2" }, DM, 4);
    assert.deepEqual(dice(live(now.state, P1).at(-1)), ["wolf", "gob"]);
  });

  test("an HP line's numbers stay with those who could read them, so a player lent the creature later reads only its label", () => {
    const hit = run(table(), { t: "actor.damageMany", hits: [{ target: { tokenId: "wolf" }, amount: 3 }] }, DM, 2);
    const line = hit.state.log.find((e) => e.data?.type === "hp")!;
    assert.deepEqual(line.parts, { exact: [] });
    const lent = lend(hit.state, "wolf", ["p1"], 3);
    const old = live(lent, P1).find((e) => e.id === line.id)!.data as Extract<LogEvent, { type: "hp" }>;
    assert.deepEqual([old.amount, old.left, old.label], [undefined, undefined, "Healthy"]);
    const again = run(lent, { t: "actor.damageMany", hits: [{ target: { tokenId: "wolf" }, amount: 2 }] }, DM, 4);
    const now = live(again.state, P1).at(-1)!.data as Extract<LogEvent, { type: "hp" }>;
    assert.equal(now.amount, 2, "a line written now gives its owner the numbers");
  });

  test("a take-back's resumed row stays with those who could see it resume", () => {
    const state = room();
    state.tokens.hero = token("hero", { kind: "pc", name: "Ayla", ownerIds: ["p1"] });
    state.tokens.shade = token("shade", { name: "Shade", visibility: "dm", ownerIds: ["p2"] });
    state.encounter = { rev: 0, round: 1, activeEntryId: "e-shade", entries: [entry("e-hero", { tokenId: "hero", value: 15 }), entry("e-shade", { tokenId: "shade", value: 10, tieOrder: 1 })] };
    const tx = new Tx(state, DM, { seq: 2, at: AT });
    tx.addEvent({ type: "turn", entryId: "e-hero", round: 1, seen: true, back: true, to: "e-shade" });
    tx.finish();
    const line = tx.state.log.find((e) => e.data?.type === "turn")!;
    assert.deepEqual(line.parts, { to: ["p2"] }, "only the shade's player saw it resume");
    const read = (s: RoomState, viewer: Viewer) => live(s, viewer).find((e) => e.id === line.id)!.data as Extract<LogEvent, { type: "turn" }>;
    assert.equal(read(tx.state, P2).to, "e-shade");
    const lent = { ...tx.state, tokens: { ...tx.state.tokens, shade: { ...tx.state.tokens.shade!, ownerIds: ["p1", "p2"] } } };
    assert.ok(projectState(lent, P1, { sceneId: "s1" }).encounter!.entries.some((e) => e.id === "e-shade"), "P1 sees the shade's row now");
    assert.equal(read(lent, P1).to, undefined, "and still not the old resume");
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
