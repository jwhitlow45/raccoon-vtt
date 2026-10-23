import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { resolveDiceOp, type DiceOp } from "./dice/resolve.ts";
import { dmNumbered, eventLines, lineAudience, memberRing, PARTY_SLOT } from "./logRings.ts";
import type { LogEntry, LogEvent, RoomState, Viewer } from "./model.ts";
import { projectState } from "./project.ts";
import { MAX_EFFECTS, type Op } from "./protocol.ts";
import { applyOp, type Applied } from "./reducer.ts";
import { Tx } from "./reducer/tx.ts";
import { LIMITS } from "./limits.ts";
import { AT, DM, P1, P2, actor, castTable, effect, entry, env, room, template, token } from "./testutil.ts";

/**
 * A log line's readers and its parts' readers, fixed when it is written by
 * the real projection of the room (shared/project.ts lineReach), and the
 * reducer's reads of the log, one line per event (shared/logRings.ts
 * eventLines). Every case runs real ops, paired with the same room where
 * the one rule that decides it is the other way.
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

describe("each reader's copies count in a run of their own (PARTY_SLOT)", () => {
  /** A creature only its players see, holding 32 effects that end when the hero's turn does. */
  function hidden(id: string, ownerIds: string[]) {
    const effects = Array.from({ length: MAX_EFFECTS }, (_, i) => effect(`${id}-${i}`, { duration: { remaining: 1, boundary: "turnEnd", anchor: { entryId: "e-hero" } } }));
    return token(id, { visibility: "dm", ownerIds, actor: { inline: actor({ effects }) } });
  }

  test("63 creatures of P1's whose effects all end on one turn leave P2 their copy of a creature they share", () => {
    const state = room();
    state.tokens.hero = token("hero", { kind: "pc", name: "Ayla", ownerIds: ["p2"] });
    for (let i = 0; i < 63; i++) state.tokens[`pet${i}`] = hidden(`pet${i}`, ["p1"]);
    state.tokens.mount = hidden("mount", ["p1", "p2"]);
    state.encounter = { rev: 0, round: 1, activeEntryId: "e-hero", entries: [entry("e-hero", { tokenId: "hero", value: 15 }), entry("e-ogre", { tokenId: "pet0", value: 10, tieOrder: 1 })] };
    const next = run(state, { t: "encounter.next" }, DM, 2);
    const copies = (reader: string, tokenId?: string) => next.state.log.filter((e) => e.to?.[0] === reader && e.data?.type === "effect" && (tokenId === undefined || e.data.tokenId === tokenId)).length;
    assert.ok(next.log.filter((e) => e.to?.[0] === "p1").length > 2_000, "more copies for P1 than a run held before");
    assert.equal(copies("p2", "mount"), Math.min(MAX_EFFECTS, memberRing("party", 3).lines), "P2 reads the mount's");
  });

  test("a reader whose run is full gets no more copies, and the next reader still gets theirs", () => {
    const state = room();
    state.tokens.pet = token("pet", { visibility: "dm", ownerIds: ["p1"] });
    state.tokens.mount = token("mount", { visibility: "dm", ownerIds: ["p1", "p2"] });
    const tx = new Tx(state, DM, { seq: 2, at: AT });
    for (let i = 0; i < PARTY_SLOT; i++) tx.addEvent({ type: "hp", tokenId: "pet", change: "damage", amount: 1 });
    tx.addEvent({ type: "hp", tokenId: "mount", change: "damage", amount: 2 });
    tx.finish();
    const mount = tx.log.filter((e) => e.data?.type === "hp" && e.data.tokenId === "mount");
    assert.deepEqual(mount.map((e) => [dmNumbered(e.id), e.to]), [[true, undefined], [false, ["p2"]]], "the DM line, and P2's copy");
    assert.equal(tx.log.filter((e) => e.to?.[0] === "p1").length, PARTY_SLOT, "P1's run took its PARTY_SLOT and no more");
  });
});

describe("the reducer reads the log one line per event (eventLines)", () => {
  test("a damage roll for a caster two players play, which only they see, is read once, so the ask keeps it", () => {
    const state = castTable();
    state.characters["thorn-c"] = { ...state.characters["thorn-c"]!, ownerIds: ["p1", "p2"] };
    state.tokens.thorn = { ...state.tokens.thorn!, visibility: "dm" };
    const roll = rolled(state, { t: "dice.roll", tag: "dmg", to: "all", rolls: [{ formula: "8d6", label: "Fireball damage, Fire", creature: { tokenId: "thorn" } }] }, P1, 2);
    assert.deepEqual(roll.log.filter((e) => lineAudience(e) === "party").map((e) => e.to), [["p1"], ["p2"]], "a copy for each player");
    const askOp: Op = { t: "cast.ask", cast: { id: "k1", caster: "thorn", sceneId: "s1", spell: "Fireball", slot: 3, area: "a1", damage: { tag: "dmg", parts: 1 } } };
    const ask = run(roll.state, askOp, P1, 3);
    assert.deepEqual(ask.state.casts.k1!.rolled, [{ formula: "8d6", total: 48, type: "fire" }]);
    // The client replays the ask on Thorn's player's own projection (design 7.4), which holds their copy and no DM line.
    const mine = projectState(roll.state, P1, { sceneId: "s1" }) as unknown as RoomState;
    assert.deepEqual(run(mine, askOp, P1, 3).state.casts.k1!.rolled, [{ formula: "8d6", total: 48, type: "fire" }]);
  });

  /**
   * A goblin everyone sees inside a glyph that hits once a turn, at its
   * turn's start and on entering, whose row is hidden from players and stays
   * so on its turn: its turn line is the DM's, and the turn's start reminder
   * is everyone's, numbered before it in the op.
   */
  function glyph(): RoomState {
    const state = room();
    state.meta = { ...state.meta, settings: { ...state.meta.settings, revealHiddenOnTurn: false } };
    state.tokens.ogre = token("ogre", { name: "Ogre", x: 20, y: 5 });
    state.tokens.g1 = token("g1", { name: "Goblin", number: 1, x: 5, y: 5 });
    state.templates.glyph = template("glyph", { shape: "sphere", size: 10, origin: { x: 5.5, y: 5.5, z: 0 }, spell: "Glyph", ownerId: "dm1", triggers: ["turnStart", "enter"], oncePerTurn: true });
    state.encounter = { rev: 0, round: 1, activeEntryId: "e-ogre", entries: [entry("e-ogre", { tokenId: "ogre", value: 15 }), entry("e-g1", { tokenId: "g1", value: 10, tieOrder: 1, hidden: true })] };
    return state;
  }

  test("an area that hits once a turn reminds once in a turn whose line sorts after the reminder, as before op version 19", () => {
    for (const opVersion of [18, undefined]) {
      let state = glyph();
      const reminders: string[] = [];
      for (const [i, op] of ([{ t: "encounter.next" }, { t: "token.move", tokenId: "g1", x: 12, y: 5 }, { t: "token.move", tokenId: "g1", x: 5, y: 5 }] as Op[]).entries()) {
        const r = run(state, op, DM, 2 + i, opVersion);
        state = r.state;
        for (const e of eventLines(r.log)) if (e.data?.type === "area") reminders.push(e.data.trigger);
      }
      assert.deepEqual(reminders, ["turnStart"], `op version ${opVersion ?? "now"}`);
      if (opVersion === undefined) {
        const [area, turn] = eventLines(state.log).filter((e) => e.id.startsWith("2:"));
        assert.deepEqual([area?.data?.type, turn?.data?.type, dmNumbered(turn!.id)], ["area", "turn", true], "the turn line sorts after the reminder");
      }
    }
  });
  /**
   * P1's hero on its turn, beside two of P2's areas that other players
   * cannot see, so a reminder of either is the DM's line with a copy for
   * P2, and a goblin no player sees, whose hits put DM lines alone.
   */
  function twoAreas(): RoomState {
    const state = room();
    state.meta = { ...state.meta, settings: { ...state.meta.settings, playersSeeAoeOfOthers: false } };
    state.tokens.hero = token("hero", { kind: "pc", name: "Ayla", x: 2, y: 5, ownerIds: ["p1"], disposition: "ally" });
    state.tokens.gob = token("gob", { visibility: "dm", actor: { inline: actor({ hp: { cur: 1_000, max: 1_000, temp: 0 } }) } });
    for (const [id, x] of [["sg", 6.5], ["moon", 7.5]] as const) state.templates[id] = template(id, { shape: "sphere", size: 10, origin: { x, y: 5.5, z: 0 }, spell: id, ownerId: "p2", triggers: ["enter"] });
    state.encounter = { rev: 0, round: 1, activeEntryId: "e-hero", entries: [entry("e-hero", { tokenId: "hero", value: 15 })], turnStart: { entryId: "e-hero", tokenId: "hero", sceneId: "s1", x: 2, y: 5, elevation: 0, seen: true, seq: 1 } };
    return state;
  }

  test("an area reminds once a turn after the DM ring drops its line, while a later line of the same move stays", () => {
    for (const hits of [0, LIMITS.dmLogLines - 1]) {
      const into = run(twoAreas(), { t: "token.move", tokenId: "hero", x: 6, y: 5 }, P1, 2);
      const lines = into.log.filter((e) => e.data?.type === "area");
      assert.deepEqual(lines.map((e) => [dmNumbered(e.id), e.to, e.copyOf]), [[true, undefined, undefined], [false, ["p2"], lines[0]!.id], [true, undefined, undefined], [false, ["p2"], lines[2]!.id]], "two DM lines, each with P2's copy naming it");
      let state = into.state;
      for (let i = 0; i < hits; i++) state = run(state, { t: "actor.damageMany", hits: [{ target: { tokenId: "gob" }, amount: 1 }] }, DM, 3 + i).state;
      const held = new Set(state.log.map((e) => e.id));
      if (hits > 0) assert.deepEqual(lines.map((e) => held.has(e.id)), [false, true, true, true], "the first reminder's DM line left the ring, its copy and the second's lines stayed");
      state = run(state, { t: "token.move", tokenId: "hero", x: 15, y: 5 }, P1, 3 + hits).state;
      const back = run(state, { t: "token.move", tokenId: "hero", x: 6, y: 5 }, P1, 4 + hits);
      assert.deepEqual(back.log.filter((e) => e.data?.type === "area"), [], `with ${hits} hits between, walking back in reminds of neither`);
    }
  });

  test("a line of an op that writes more DM lines than the ring holds is read once, from its copy, once its own DM line leaves", () => {
    const state = room();
    state.tokens.pet = token("pet", { visibility: "dm", ownerIds: ["p1"] });
    state.tokens.gob = token("gob", { visibility: "dm", actor: { inline: actor({ hp: { cur: 1_000, max: 1_000, temp: 0 } }) } });
    const tx = new Tx(state, DM, { seq: 2, at: AT });
    tx.addEvent({ type: "hp", tokenId: "pet", change: "damage", amount: 1 });
    for (let i = 0; i < LIMITS.dmLogLines; i++) tx.addEvent({ type: "hp", tokenId: "gob", change: "damage", amount: 1 });
    tx.finish();
    const read = eventLines(tx.state.log);
    assert.equal(tx.state.log.filter((e) => dmNumbered(e.id)).length, LIMITS.dmLogLines, "the pet's DM line left the ring");
    assert.deepEqual(read.filter((e) => e.data?.type === "hp" && e.data.tokenId === "pet").map((e) => e.to), [["p1"]], "P1's copy stands for it");
    assert.equal(read.length, LIMITS.dmLogLines + 1, "one line per event");
  });
});
