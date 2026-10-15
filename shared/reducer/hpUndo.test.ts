import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { Actor, LogEvent, RoomState } from "../model.ts";
import { projectState } from "../project.ts";
import { MAX_EFFECTS } from "../protocol.ts";
import { applyOp } from "../reducer.ts";
import { actor, apply, character, DM, env, P1, P2, room, token } from "../testutil.ts";
import { hpUndoRestore } from "./hpUndo.ts";

type HpEvent = Extract<LogEvent, { type: "hp" }>;

function lastHpLine(state: RoomState): { id: string; data: HpEvent } {
  const entry = [...state.log].reverse().find((e) => e.data?.type === "hp")!;
  return { id: entry.id, data: entry.data as HpEvent };
}

function goblin(state: RoomState): Actor {
  const t = state.tokens.gob!;
  return "inline" in t.actor ? t.actor.inline : assert.fail("inline");
}

/** Takes a line back as the server does: the restore it builds, applied with the line it names. */
function takeBack(state: RoomState, logId: string, seq: number): RoomState {
  const built = hpUndoRestore(state, logId);
  assert.ok(built.ok, built.ok ? "" : built.message);
  return apply(state, { t: "sys.restore", entries: built.entries, from: "undo", deps: true, undid: logId }, DM, seq);
}

function base(): RoomState {
  const state = room();
  state.tokens.gob = token("gob", { name: "Goblin", kind: "monster", x: 2, y: 2, hpVisibility: "label", actor: { inline: actor({ hp: { cur: 7, max: 7, temp: 0 } }) } });
  state.characters.c1 = character("c1", { ownerIds: ["p1"], name: "Thorn" });
  state.characters.c1.actor.hp = { cur: 20, max: 20, temp: 0 };
  state.tokens.pc = token("pc", { kind: "pc", name: "Thorn", actor: { ref: "c1" }, x: 1, y: 1 });
  return state;
}

describe("HP changes in the log", () => {
  test("each line says what was left, and keeps what the change replaced", () => {
    const state = apply(base(), { t: "actor.hp", target: { tokenId: "gob" }, change: { kind: "damage", amount: 4 } });
    const { data } = lastHpLine(state);
    assert.deepEqual(data.left, { cur: 3, max: 7, temp: 0 });
    assert.deepEqual(data.revert?.before.hp, { cur: 7, max: 7, temp: 0 });
    assert.deepEqual(data.revert?.after.hp, { cur: 3, max: 7, temp: 0 });
  });

  test("players read the line as the HP display setting allows, and never what it replaced", () => {
    let state = apply(base(), { t: "actor.hp", target: { tokenId: "gob" }, change: { kind: "damage", amount: 4 } });
    state = apply(state, { t: "actor.hp", target: { tokenId: "pc" }, change: { kind: "damage", amount: 5 } }, DM, 2);
    const [gob, pc] = state.log.slice(-2).map((e) => e.data as HpEvent);
    const seen = (viewer: typeof P1) => projectState(state, viewer, { sceneId: "s1" }).log.map((e) => e.data as HpEvent);
    // The goblin shows only a label to players.
    for (const viewer of [P1, P2]) {
      const lines = seen(viewer);
      assert.deepEqual(lines[0], { type: "hp", change: "damage", tokenId: "gob", seen: true, label: "Bloodied" });
      assert.ok(lines.every((d) => !("revert" in d) && !("of" in d)), "what a change replaced is the DM's");
    }
    // Thorn's owner sees the numbers, and the party does too while the room lets it.
    assert.deepEqual(seen(P1)[1], { type: "hp", change: "damage", characterId: "c1", amount: 5, left: { cur: 15, max: 20, temp: 0 }, label: "Healthy" });
    state.meta.settings.pcHpVisibleToParty = false;
    assert.deepEqual(seen(P2)[1], { type: "hp", change: "damage", characterId: "c1", label: "Healthy" });
    assert.deepEqual(projectState(state, DM, { sceneId: "s1" }).log.slice(-2).map((e) => e.data), [gob, pc]);
  });
});

describe("taking an HP change back from the log", () => {
  test("puts back what the change replaced, says so in the log, and only once", () => {
    let state = apply(base(), { t: "actor.hp", target: { tokenId: "gob" }, change: { kind: "damage", amount: 4 } });
    const line = lastHpLine(state);
    state = takeBack(state, line.id, 2);
    assert.deepEqual(goblin(state).hp, { cur: 7, max: 7, temp: 0 });
    const back = lastHpLine(state).data;
    assert.deepEqual(back, { type: "hp", change: "damage", amount: 4, back: true, of: line.id, left: { cur: 7, max: 7, temp: 0 }, label: "Healthy", tokenId: "gob", seen: true });
    const again = hpUndoRestore(state, line.id);
    assert.ok(!again.ok && again.message === "it was already taken back");
    assert.ok(!hpUndoRestore(state, lastHpLine(state).id).ok, "a take-back is not itself taken back from the log");
  });

  test("leaves what changed since about the creature, its place and its new conditions", () => {
    let state = apply(base(), { t: "actor.hp", target: { tokenId: "gob" }, change: { kind: "damage", amount: 4 } });
    const line = lastHpLine(state);
    state = apply(state, { t: "token.move", tokenId: "gob", x: 9, y: 9 }, DM, 2);
    state = apply(state, { t: "actor.effect.add", target: { tokenId: "gob" }, effect: { id: "prone", key: "prone" } }, DM, 3);
    state = takeBack(state, line.id, 4);
    assert.deepEqual([state.tokens.gob!.x, goblin(state).hp.cur, goblin(state).effects.map((e) => e.id)], [9, 7, ["prone"]]);
  });

  test("refuses once the creature's HP changed since, and a chain of take-backs, newest first, works", () => {
    let state = apply(base(), { t: "actor.hp", target: { tokenId: "gob" }, change: { kind: "damage", amount: 2 } });
    const first = lastHpLine(state);
    state = apply(state, { t: "actor.hp", target: { tokenId: "gob" }, change: { kind: "damage", amount: 1 } }, DM, 2);
    const second = lastHpLine(state);
    const refused = hpUndoRestore(state, first.id);
    assert.ok(!refused.ok && refused.message === "it was changed since" && refused.code === "invalid");
    state = takeBack(state, second.id, 3);
    state = takeBack(state, first.id, 4);
    assert.equal(goblin(state).hp.cur, 7);
  });

  test("a creature brought to 0 gets back its life, its concentration and no Unconscious from 0 HP", () => {
    let state = base();
    state.meta.settings.monstersDieAtZero = false;
    state = apply(state, { t: "actor.effect.add", target: { characterId: "c1" }, effect: { id: "bless", key: "concentrating", spell: "Bless", hiddenFromPlayers: true } });
    const before = state.characters.c1!.actor;
    state = apply(state, { t: "actor.hp", target: { tokenId: "pc" }, change: { kind: "damage", amount: 25 } }, DM, 2);
    assert.equal(state.characters.c1!.actor.life, "dying");
    const line = lastHpLine(state);
    assert.equal(line.data.characterId, "c1", "a PC's line names its character");
    state = takeBack(state, line.id, 3);
    const after = state.characters.c1!.actor;
    assert.deepEqual([after.hp, after.life, after.deathSaves], [before.hp, before.life, before.deathSaves]);
    assert.deepEqual(after.effects, before.effects, "concentration is back, still hidden, and Unconscious from 0 HP is gone");
  });

  test("a creature that took up a new concentration since keeps it rather than holding two", () => {
    let state = base();
    state = apply(state, { t: "actor.effect.add", target: { characterId: "c1" }, effect: { id: "bless", key: "concentrating", spell: "Bless" } });
    state = apply(state, { t: "actor.hp", target: { characterId: "c1" }, change: { kind: "damage", amount: 25 } }, DM, 2);
    const line = lastHpLine(state);
    state = apply(state, { t: "actor.hp", target: { characterId: "c1" }, change: { kind: "heal", amount: 5 } }, DM, 3);
    // Healing since changed its HP, so that line refuses on its own account. Take the heal back first.
    state = takeBack(state, lastHpLine(state).id, 4);
    state = apply(state, { t: "actor.effect.add", target: { characterId: "c1" }, effect: { id: "hex", key: "concentrating", spell: "Hex" } }, DM, 5);
    const refused = hpUndoRestore(state, line.id);
    assert.ok(!refused.ok && refused.message === "it was changed since");
  });

  test("a line that is gone, from before lines kept what they replaced, or about a creature that is gone, refuses", () => {
    let state = apply(base(), { t: "actor.hp", target: { tokenId: "gob" }, change: { kind: "damage", amount: 4 } });
    const line = lastHpLine(state);
    assert.ok(!hpUndoRestore(state, "999:0").ok);
    const old = { ...state, log: state.log.map((e) => (e.id === line.id ? { ...e, data: { ...line.data, revert: undefined } } : e)) } as RoomState;
    assert.equal((hpUndoRestore(old, line.id) as { message: string }).message, "that change can no longer be taken back");
    state = apply(state, { t: "token.delete", tokenId: "gob" }, DM, 2);
    const gone = hpUndoRestore(state, line.id);
    assert.ok(!gone.ok && gone.code === "gone");
  });

  test("the stored restore replays to the same room", () => {
    let state = apply(base(), { t: "actor.hp", target: { tokenId: "gob" }, change: { kind: "temp", amount: 5 } });
    const line = lastHpLine(state);
    const built = hpUndoRestore(state, line.id);
    assert.ok(built.ok);
    const op = { t: "sys.restore" as const, entries: built.entries, from: "undo" as const, deps: true as const, undid: line.id };
    const once = applyOp(state, op, DM, env(2));
    const twice = applyOp(structuredClone(state), structuredClone(op), DM, env(2));
    assert.ok(once.ok && twice.ok);
    assert.deepEqual(once.state, twice.state);
    assert.equal(goblin(once.state).hp.temp, 0);
  });

  test("a timed condition whose initiative row left the fight comes back paused on its creature, or counting its new row", () => {
    const fight = (): RoomState => {
      let state = apply(base(), { t: "encounter.start", entries: [{ id: "n1", tokenId: "pc", value: 15 }, { id: "n2", tokenId: "gob", value: 10 }] });
      state = apply(state, { t: "encounter.next" }, DM, 2);
      const effect = { id: "conc", key: "concentrating" as const, duration: { mode: "rounds" as const, rounds: 10, of: { tokenId: "pc" } } };
      state = apply(state, { t: "actor.effect.add", target: { characterId: "c1" }, effect }, DM, 3);
      assert.deepEqual(state.characters.c1!.actor.effects[0]!.duration?.anchor, { entryId: "n1" });
      // Down to 0: Unconscious ends the concentration.
      state = apply(state, { t: "actor.hp", target: { tokenId: "pc" }, change: { kind: "damage", amount: 20 } }, DM, 4);
      assert.ok(!state.characters.c1!.actor.effects.some((e) => e.id === "conc"));
      return apply(state, { t: "encounter.remove", entryIds: ["n1"] }, DM, 5);
    };
    const thorn = (state: RoomState) => state.characters.c1!.actor.effects.find((e) => e.id === "conc")!;
    let state = fight();
    const line = [...state.log].reverse().find((e) => e.data?.type === "hp" && e.data.characterId === "c1")!.id;
    state = takeBack(state, line, 6);
    assert.deepEqual(thorn(state).duration, { remaining: 10, boundary: "turnStart", anchor: { tokenId: "pc" } }, "paused, as removing the row left it");
    state = apply(state, { t: "encounter.add", entries: [{ id: "n3", tokenId: "pc", value: 12 }] }, DM, 7);
    assert.deepEqual(thorn(state).duration?.anchor, { entryId: "n3" }, "and it counts again once Thorn joins the fight");
    // Back in the fight before the take-back: it counts the new row at once.
    let rejoined = apply(fight(), { t: "encounter.add", entries: [{ id: "n4", tokenId: "pc", value: 12 }] }, DM, 6);
    rejoined = takeBack(rejoined, line, 7);
    assert.deepEqual(thorn(rejoined).duration?.anchor, { entryId: "n4" });
  });

  test("refuses when the conditions coming back would pass the limit, and keeps those added since", () => {
    let state = apply(base(), { t: "actor.effect.add", target: { tokenId: "gob" }, effect: { id: "conc", key: "concentrating" } });
    state = apply(state, { t: "actor.hp", target: { tokenId: "gob" }, change: { kind: "damage", amount: 7 } }, DM, 2);
    const line = lastHpLine(state);
    assert.deepEqual(line.data.revert?.removed?.map((e) => e.id), ["conc"]);
    let seq = 3;
    for (let i = 0; i < MAX_EFFECTS - 1; i++) state = apply(state, { t: "actor.effect.add", target: { tokenId: "gob" }, effect: { id: `x${i}`, key: "custom", label: `Mark ${i}` } }, DM, seq++);
    assert.ok(hpUndoRestore(state, line.id).ok, "one short of the limit, it fits");
    state = apply(state, { t: "actor.effect.add", target: { tokenId: "gob" }, effect: { id: "last", key: "custom", label: "Last" } }, DM, seq++);
    const full = hpUndoRestore(state, line.id);
    assert.ok(!full.ok);
    assert.deepEqual([full.code, full.message], ["quota", `at most ${MAX_EFFECTS} effects per creature`]);
    assert.equal(goblin(state).effects.length, MAX_EFFECTS);
  });
});
