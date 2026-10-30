import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { LogEntry, RoomState, Viewer } from "../model.ts";
import { projectArchivedLog, projectState } from "../project.ts";
import type { Op, OpOf, RestoreEntry } from "../protocol.ts";
import { applyOp, type Applied } from "../reducer.ts";
import { EMPTY_PC_STATS, namedRollOf } from "../rules/pcStats.ts";
import { AT, DM, P1, P2, actor, character, companionBlock, customMonster, env, room, token } from "../testutil.ts";
import type { CorrectionLogEvent, RestoreHistoryFields } from "../undoContract.ts";
import { hpUndoRestore } from "./hpUndo.ts";

const LABEL = "private correction phrase with secret target and DC 23";
const DISPLAY: Viewer = { role: "player", memberId: "display:abcdefghijkl" };
const PREVIEW: Viewer = { role: "player", memberId: P2.memberId };

function fixture(): RoomState {
  return room({
    characters: { bree: character("bree", { name: "Bree", level: 4, actor: actor({ initBonus: 0, passivePerception: 10 }), stats: structuredClone(EMPTY_PC_STATS) }) },
    tokens: { bree: token("bree", { kind: "pc", name: "Bree", actor: { ref: "bree" } }) },
    companionBlocks: { moth: companionBlock("moth", "bree"), owl: companionBlock("owl", "bree") },
    monsters: { hidden: customMonster("hidden") },
  });
}

function run(state: RoomState, op: Op, seq: number, who = DM, version?: number): Applied {
  const result = applyOp(state, op, who, { ...env(seq), ...(version === undefined ? {} : { opVersion: version }) });
  assert.ok(result.ok, result.ok ? "" : `${op.t}: ${result.message}`);
  return result;
}

function restore(state: RoomState, entries: RestoreEntry[], from: "undo" | "redo" = "undo", seq = 2, version?: number): Applied {
  const op: OpOf<"sys.restore"> & RestoreHistoryFields = { t: "sys.restore", entries, from, deps: true, scope: "setup", correction: { label: LABEL } };
  return run(state, op, seq, DM, version);
}

function notices(lines: readonly LogEntry[]): CorrectionLogEvent[] {
  return lines.flatMap((line) => {
    const data = line.data as LogEntry["data"] | CorrectionLogEvent;
    return data?.type === "correction" ? [data] : [];
  });
}

function seen(state: RoomState, who: Viewer) {
  return projectState(state, who, { sceneId: "s1" });
}

function expectNotice(result: Applied, from: "undo" | "redo", owner: Viewer = P1) {
  const dm = notices(seen(result.state, DM).log).at(-1);
  assert.equal(dm?.label, LABEL, "DM sees the exact correction phrase");
  const own = notices(seen(result.state, owner).log).at(-1);
  assert.ok(own, "the owner gets a gameplay correction even with unchanged Actor");
  assert.equal(own.from, from);
  assert.equal(own.scope, "setup");
  assert.equal(own.label, undefined);
  for (const key of Object.keys(own)) assert.ok(["type", "from", "scope", "name"].includes(key), `player correction has no private ${key} field`);
  for (const viewer of [owner, P2, DISPLAY, PREVIEW]) {
    assert.ok(!JSON.stringify(seen(result.state, viewer)).includes(LABEL));
    const rows = projectArchivedLog(result.state, result.log, viewer, { sceneId: "s1" });
    assert.ok(!JSON.stringify(rows).includes(LABEL), "archive strips the private phrase too");
    if (viewer.memberId !== owner.memberId) assert.equal(notices(rows).length, 0);
  }
  assert.equal(notices(projectArchivedLog(result.state, result.log, owner, { sceneId: "s1" })).length, 1);
}

describe("correction notices compare gameplay beyond Actor", () => {
  const patches: Record<string, OpOf<"character.update">["patch"]> = {
    Charisma: { stats: { abilities: { ...EMPTY_PC_STATS.abilities, cha: 18 } } },
    Evasion: { stats: { evasion: true } },
    "roll formula": { stats: { rolls: [{ id: "flame", name: "Flame", kind: "spell", dice: [{ formula: "2d6", type: "fire" }] }] } },
    "known forms": { knownForms: ["wolf"] },
    resources: { resources: [{ id: "rage", name: "Rage", max: 2, used: 0, reset: "long" }] },
    level: { level: 5 },
  };
  for (const [name, patch] of Object.entries(patches)) {
    test(`${name}: Undo and Redo notify the owner while Actor remains identical`, () => {
      const before = fixture();
      const edited = run(before, { t: "character.update", characterId: "bree", patch }, 1);
      assert.deepEqual(edited.state.characters.bree!.actor, before.characters.bree!.actor, "fixture isolates a non-Actor gameplay change");
      assert.notDeepEqual(edited.state.characters.bree, before.characters.bree);
      assert.ok(edited.inverse);
      const undone = restore(edited.state, edited.inverse);
      expectNotice(undone, "undo");
      assert.ok(undone.inverse);
      const redone = restore(undone.state, undone.inverse, "redo", 3);
      expectNotice(redone, "redo");
      assert.equal(notices(seen(redone.state, P1).log).length, 2);
    });
  }

  for (const [name, patch] of Object.entries({
    ac: { ac: 17 },
    actions: { actions: [{ name: "Dust", text: "The target cannot take reactions until its next turn." }] },
    traits: { traits: [{ name: "Lantern Wings", text: "Its light is bright within 20 feet." }] },
  } satisfies Record<string, OpOf<"companionBlock.update">["patch"]>)) {
    test(`companion ${name}: notify with unchanged Actor and Character`, () => {
      const before = fixture();
      const edited = run(before, { t: "companionBlock.update", blockId: "moth", patch }, 1);
      assert.deepEqual(edited.state.characters, before.characters);
      assert.deepEqual(edited.state.tokens, before.tokens);
      assert.ok(edited.inverse);
      const undone = restore(edited.state, edited.inverse);
      expectNotice(undone, "undo");
      const redone = restore(undone.state, undone.inverse!, "redo", 3);
      expectNotice(redone, "redo");
    });
  }

  test("two companion blocks restored together emit one notice per viewer", () => {
    const before = fixture();
    const first = run(before, { t: "companionBlock.update", blockId: "moth", patch: { ac: 17 } }, 1);
    const second = run(first.state, { t: "companionBlock.update", blockId: "owl", patch: { ac: 18 } }, 2);
    const undone = restore(second.state, [...first.inverse!, ...second.inverse!], "undo", 3);
    expectNotice(undone, "undo");
    assert.equal(notices(seen(undone.state, P1).log).length, 1);
    assert.equal(notices(seen(undone.state, DM).log).length, 1);
  });

  for (const [name, op] of Object.entries({
    "companion name": { t: "companionBlock.update", blockId: "moth", patch: { name: "Cosmetic name" } },
    "companion image": { t: "companionBlock.update", blockId: "moth", patch: { defaultImage: { icon: "lorc/owl", color: "#ff0000" } } },
    "character name": { t: "character.update", characterId: "bree", patch: { name: "Cosmetic name" } },
    "actor notes": { t: "character.update", characterId: "bree", patch: { actor: { notes: "Cosmetic description" } } },
    "monster definition": { t: "monster.update", monsterId: "hidden", patch: { ac: 19 } },
    "board paint": { t: "build.paint", sceneId: "s1", terrain: "stone", cells: ["1,1"] },
  } satisfies Record<string, Op>)) {
    test(`${name} produces no player correction or visible log counter change`, () => {
      const edited = run(fixture(), op, 1);
      assert.ok(edited.inverse);
      const undone = restore(edited.state, edited.inverse);
      for (const viewer of [P1, P2, DISPLAY]) assert.deepEqual(seen(undone.state, viewer).log, seen(edited.state, viewer).log);
    });
  }
});

describe("corrections include effective saves and prompt settlement", () => {
  for (const from of ["undo", "redo"] as const) test(`resolved save behavior notifies on ${from} after a spell rename`, () => {
    const before = fixture();
    const stats = before.characters.bree!.stats!;
    stats.rolls = [{ id: "spell", name: "Fireball", kind: "spell", level: 3, save: { ability: "dex" }, dice: [{ formula: "8d6", type: "fire" }] }];
    const edited = run(before, { t: "character.update", characterId: "bree", patch: { stats: { rolls: [{ ...stats.rolls[0]!, name: "Disintegrate" }] } } }, 1);
    const next = edited.state.characters.bree!.stats!;
    assert.equal(namedRollOf(stats, 4, stats.rolls[0]!).save?.onPass, "half");
    assert.equal(namedRollOf(next, 4, next.rolls[0]!).save?.onPass, "none");
    const undone = restore(edited.state, edited.inverse!);
    const result = from === "undo" ? undone : restore(undone.state, undone.inverse!, "redo", 3);
    expectNotice(result, from);
  });

  test("resolved save behavior stays cosmetic when an explicit result overrides the name", () => {
    const before = fixture();
    before.characters.bree!.stats!.rolls = [{ id: "spell", name: "Fireball", kind: "spell", save: { ability: "dex", onPass: "half" }, dice: [{ formula: "8d6", type: "fire" }] }];
    const rolls = before.characters.bree!.stats!.rolls.map((roll) => ({ ...roll, name: "Disintegrate" }));
    const edited = run(before, { t: "character.update", characterId: "bree", patch: { stats: { rolls } } }, 1);
    const undone = restore(edited.state, edited.inverse!);
    assert.equal(notices(seen(undone.state, P1).log).length, 0);
  });

  for (const field of ["due", "bookkeeping"] as const) test(`turn record ${field} comparison excludes identity and start-of-turn bookkeeping`, () => {
    const before = fixture();
    before.characters.bree!.actor.turnRecord = { id: 1, entryId: "turn", round: 1, hp: 20, life: "alive", due: ["actions:breath"] };
    const after = structuredClone(before);
    after.characters.bree!.actor.turnRecord = field === "due"
      ? { ...before.characters.bree!.actor.turnRecord, due: ["actions:other"] }
      : { ...before.characters.bree!.actor.turnRecord, id: 2, entryId: "next", round: 2, hp: 10, life: "dying", took: ["fire"] };
    const undone = restore(after, [{ key: "character:bree", value: before.characters.bree }]);
    const redone = restore(undone.state, undone.inverse!, "redo", 3);
    if (field === "due") {
      expectNotice(undone, "undo");
      expectNotice(redone, "redo");
    } else for (const result of [undone, redone]) assert.equal(notices(seen(result.state, P1).log).length, 0);
  });

  for (const state of ["skipped", "open"] as const) for (const from of ["undo", "redo"] as const) test(`prompt ${state} notifies its owner on ${from}`, () => {
    const before = fixture();
    before.characters.bree!.actor = actor({ hp: { cur: 0, max: 20, temp: 0 }, life: "dying" });
    const started = run(before, { t: "encounter.start", entries: [{ id: "bree-turn", tokenId: "bree", value: 20 }] }, 1);
    const active = run(started.state, { t: "encounter.next" }, 2);
    const record = active.state.characters.bree!.actor.turnRecord!.id;
    const prompt: Op = { t: "actor.prompt", target: { characterId: "bree" }, record, what: "deathSave", state: "skipped" };
    const skipped = run(active.state, prompt, 3);
    const edited = state === "skipped" ? skipped : run(skipped.state, { ...prompt, state: "open" }, 4);
    const undone = restore(edited.state, edited.inverse!, "undo", 5);
    const result = from === "undo" ? undone : restore(undone.state, undone.inverse!, "redo", 6);
    expectNotice(result, from);
  });
});

describe("correction audiences stay private after persistence and ownership changes", () => {
  test("gaining ownership cannot gain an old notice, and losing ownership removes it from live and archive reads", () => {
    const before = fixture();
    const edited = run(before, { t: "character.update", characterId: "bree", patch: { stats: { evasion: true } } }, 1);
    const undone = restore(edited.state, edited.inverse!);
    expectNotice(undone, "undo");
    const archived = structuredClone(undone.log);
    const reassigned = run(undone.state, { t: "character.update", characterId: "bree", patch: { ownerIds: [P2.memberId] } }, 3);
    for (const viewer of [P1, P2]) {
      assert.equal(notices(seen(reassigned.state, viewer).log).length, 0);
      assert.equal(notices(projectArchivedLog(reassigned.state, archived, viewer, { sceneId: "s1" })).length, 0);
    }
  });

  test("blackout still notifies a character's owner about stats they receive", () => {
    const state = fixture();
    state.meta.view.blackout = true;
    const edited = run(state, { t: "character.update", characterId: "bree", patch: { stats: { evasion: true } } }, 1);
    expectNotice(restore(edited.state, edited.inverse!), "undo");
  });

  test("a hidden actor change leaves unrelated players' entire projections identical", () => {
    const state = fixture();
    state.tokens.hidden = token("hidden", { visibility: "dm", name: "Secret victim" });
    const hit = run(state, { t: "actor.hp", target: { tokenId: "hidden" }, change: { kind: "damage", amount: 3 } }, 1);
    const undone = restore(hit.state, hit.inverse!);
    for (const viewer of [P1, P2, DISPLAY]) assert.deepEqual(seen(undone.state, viewer), seen(hit.state, viewer));
  });

  test("only the owner gets a notice for position, even when others see the token", () => {
    const moved = run(fixture(), { t: "token.move", tokenId: "bree", x: 6, y: 3 }, 1);
    const undone = restore(moved.state, moved.inverse!);
    expectNotice(undone, "undo");
  });

  test("HP Log Undo writes its existing take-back line without a second generic notice", () => {
    const hit = run(fixture(), { t: "actor.hp", target: { characterId: "bree" }, change: { kind: "damage", amount: 4 } }, 1);
    const line = hit.log.find((line) => line.data?.type === "hp" && line.data.revert);
    assert.ok(line);
    const inverse = hpUndoRestore(hit.state, line.id);
    assert.ok(inverse.ok);
    const corrected = run(hit.state, { t: "sys.restore", entries: inverse.entries, from: "undo", undid: line.id, deps: true }, 2);
    assert.equal(notices(corrected.log).length, 0);
    assert.ok(corrected.log.some((line) => line.data?.type === "hp" && line.data.back));
  });

  test("op-33 restores keep their historical log numbering, op-34 replays frozen correction notices", () => {
    const before = fixture();
    const edited = run(before, { t: "character.update", characterId: "bree", patch: { stats: { evasion: true } } }, 1);
    const historical = restore(edited.state, edited.inverse!, "undo", 2, 33);
    assert.deepEqual(historical.state.log, edited.state.log);
    assert.equal(notices(historical.log).length, 0);
    const live = restore(edited.state, edited.inverse!);
    const replay = restore(edited.state, edited.inverse!, "undo", 2, 34);
    expectNotice(replay, "undo");
    assert.deepEqual(replay.state, live.state);
    assert.deepEqual(replay.log, live.log);
    assert.ok(replay.log.every((line) => line.at === AT));
  });
});
