import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, test } from "node:test";
import { keys } from "../keys.ts";
import { eventLines } from "../logRings.ts";
import { migrateOp, migrateSnapshot } from "../migrate.ts";
import type { LogEntry, RoomState, Viewer } from "../model.ts";
import { hash128, projectEntity, stableStringify } from "../project.ts";
import type { Op } from "../protocol.ts";
import { applyOp } from "../reducer.ts";
import { resultOf } from "../rules/rolls.ts";
import { DM, P1 } from "../testutil.ts";
import { guardHash } from "./tx.ts";

/**
 * Answers from before wave 7 keep their decision (docs/design-v1-roll-request.md
 * 7.5). The fixture is a history the build before wave 7 (7cbc2560) played:
 * the DM asks Thorn for a Dexterity save against a hidden DC 13 with pass or
 * fail hidden, Thorn's player types 3, the DM marks it a pass, then undoes
 * the mark. The build stored each op at op version 6 and wrote the state
 * after the mark as a version 10 snapshot, and each step keeps a hash of the
 * state and log it made.
 *
 * Those ops replay by the rule they were written under (answerProvenance),
 * and the snapshot's answer reads its stored result (resultOf), so both
 * histories rebuild the very state, the stored undo's guard still matches,
 * and the mark's archived line stays the DM's. A change that breaks this
 * must keep version 6 answers on their old rule, rather than record the
 * fixture again.
 */
type Step = { who: "dm" | "player"; op: Op; after: string };
type Fixture = { build: string; snapshotVersion: number; opVersion: number; state: RoomState; snapshot: RoomState; steps: Step[] };

const fixture = JSON.parse(readFileSync(new URL("./rolls.legacy.fixture.json", import.meta.url), "utf8")) as Fixture;
const MARK = 2;
const UNDO = 3;
const envelope = (i: number, opVersion?: number) => ({ seq: 2000 + i, at: new Date(Date.UTC(2026, 9, 1, 20, 0, i)).toISOString(), ...(opVersion === undefined ? {} : { opVersion }) });
const viewer = (step: Step): Viewer => (step.who === "dm" ? DM : P1);

/**
 * A state as that build would have written it: without the collections added
 * since, while they are empty. The snapshot migration adds them empty (asks
 * for saves at version 16, traps and their logs at 19, sight holders and
 * their layers at 24, memory and the scenes' marks at 27), and nothing in
 * this history fills them, so the build's bytes are the rest.
 */
function asThatBuild(state: RoomState): unknown {
  const { casts, traps, trapLog, trapSeen, holders, exploredBy, memory, memoryBy, playedScenes, memoryShared, ...rest } = state;
  const empty =
    Object.keys(casts ?? {}).length === 0 &&
    Object.keys(traps ?? {}).length === 0 &&
    (trapLog ?? []).length === 0 &&
    (trapSeen ?? []).length === 0 &&
    Object.keys(holders ?? {}).length === 0 &&
    Object.keys(exploredBy ?? {}).length === 0 &&
    [memory, memoryBy, playedScenes, memoryShared].every((c) => Object.keys(c ?? {}).length === 0);
  return empty ? rest : state;
}

/** The fixture's steps from `from` on, each op migrated from its stored version, at a replay version (none: as live ops). */
function replay(start: RoomState, from: number, opVersion: number | undefined, change: (op: Op) => Op = (op) => op) {
  let state = start;
  const states: RoomState[] = [];
  const hashes: string[] = [];
  const logs: LogEntry[][] = [];
  const refusals: (string | null)[] = [];
  for (let i = from; i < fixture.steps.length; i++) {
    const step = fixture.steps[i]!;
    const r = applyOp(state, change(migrateOp(step.op, fixture.opVersion)), viewer(step), envelope(i, opVersion));
    refusals.push(r.ok ? null : r.message);
    if (!r.ok) break;
    hashes.push(hash128(stableStringify({ state: asThatBuild(r.state), log: r.log })));
    logs.push(r.log);
    states.push(r.state);
    state = r.state;
  }
  return { state, states, hashes, logs, refusals };
}

/** A log line as a member reads it from the archive, projected as the actor projects stored rows (actor.ts projectLog). */
function archived(state: RoomState, entry: LogEntry, who: Viewer): LogEntry | null {
  return projectEntity(keys.log(entry.id), { ...state, log: [entry] }, who, { sceneId: "s1" }) as LogEntry | null;
}

const thorn = (state: RoomState) => state.rolls.r1!.targets[0]!;

describe("a DM's Pass mark from before wave 7", () => {
  test("the fixture is the build's own: a version 10 snapshot and version 6 ops", () => {
    assert.equal(fixture.build, "7cbc2560");
    assert.equal(fixture.snapshotVersion, 10);
    assert.equal(fixture.opVersion, 6);
    assert.deepEqual(fixture.steps.map((s) => s.op.t), ["roll.ask", "roll.answer", "roll.answer", "sys.restore"]);
  });

  test("replayed from version 6 ops, every step makes the bytes that build made, its undo included", () => {
    const { hashes, refusals } = replay(fixture.state, 0, fixture.opVersion);
    assert.deepEqual(refusals, fixture.steps.map(() => null), "the stored undo's guard matches");
    assert.deepEqual(hashes, fixture.steps.map((s) => s.after));
  });

  test("loaded from the version 10 snapshot, the state is the replay's, with equal hashes, and the undo's guard matches there too", () => {
    const loaded = migrateSnapshot(structuredClone(fixture.snapshot), fixture.snapshotVersion);
    const replayed = replay(fixture.state, 0, fixture.opVersion);
    // The replay starts from the build's own state, so it lacks what the migration adds empty.
    const atMark = migrateSnapshot(structuredClone(replayed.states[MARK]!), fixture.snapshotVersion);
    assert.deepEqual(loaded, atMark, "equal states");
    assert.equal(hash128(stableStringify(loaded)), hash128(stableStringify(atMark)), "equal hashes");
    const restore = fixture.steps[UNDO]!.op;
    assert.ok(restore.t === "sys.restore");
    const guard = restore.entries.find((e) => e.key === keys.roll("r1"))?.expectHash;
    assert.equal(guardHash(keys.roll("r1"), loaded.rolls.r1), guard, "the request hashes as the stored undo expects");
    const undone = replay(loaded, UNDO, fixture.opVersion);
    assert.deepEqual(undone.refusals, [null], "the stored undo applies on the snapshot");
    assert.deepEqual(undone.hashes, [fixture.steps[UNDO]!.after]);
    assert.deepEqual(undone.state, migrateSnapshot(structuredClone(replayed.state), fixture.snapshotVersion), "both histories end the same");
  });

  test("the answer reads Pass from resultOf: a total of 3 against DC 13, by the stored result of an answer with no tag", () => {
    const loaded = migrateSnapshot(structuredClone(fixture.snapshot), fixture.snapshotVersion);
    const target = thorn(loaded);
    assert.equal(target.total, 3);
    assert.equal(target.tag, undefined);
    assert.equal(target.mark, undefined);
    assert.equal(resultOf(target, loaded.rolls.r1!.dc), "pass");
    const undone = replay(loaded, UNDO, fixture.opVersion).state;
    assert.equal(resultOf(thorn(undone), undone.rolls.r1!.dc), "fail", "the undo brings back the player's own fail");
  });

  test("archived lines keep today's filter: the DM reads the mark, and Thorn's player reads only their own 3", () => {
    const loaded = migrateSnapshot(structuredClone(fixture.snapshot), fixture.snapshotVersion);
    const [answer, mark] = loaded.log;
    assert.ok(answer && mark);
    assert.equal(mark.data?.type === "roll" ? mark.data.tag : "", undefined, "an untagged line, judged by isMarkLine");
    assert.deepEqual(archived(loaded, mark, DM), mark);
    assert.equal(archived(loaded, mark, P1), null, "the mark is the DM's while pass or fail is hidden");
    assert.deepEqual(archived(loaded, answer, P1)?.data, { type: "roll", test: { kind: "save", choices: [{ ability: "dex" }] }, characterId: "thorn", total: 3 });
  });

  test("a tag on a version 6 op changes nothing, and only today's tagged rule would miss the stored guard", () => {
    const tagged = (op: Op): Op => (op.t === "roll.answer" ? { ...op, tag: `legacy-${op.result ?? op.total}` } : op);
    const old = replay(fixture.state, 0, fixture.opVersion, tagged);
    assert.deepEqual(old.hashes, fixture.steps.map((s) => s.after), "version 6 keeps the old rule whatever the op holds");
    const today = replay(fixture.state, 0, undefined, tagged);
    assert.notEqual(today.refusals.at(-1), null, "today's rule writes the tag and the mark, so the stored undo refuses");
    // Today each log line keeps its readers (op version 19, shared/logRings.ts): one only some read is the DM's, with a
    // copy for each reader, and its id differs. So the lines are compared one per event, without their ids.
    const plain = (run: ReturnType<typeof replay>) =>
      run.states.map((state, i) => {
        const line = ({ id: _id, parts: _parts, ...rest }: LogEntry) => stableStringify(rest);
        return stableStringify({ state: asThatBuild({ ...state, log: [] }), log: eventLines(state.log).map(line).sort(), wrote: eventLines(run.logs[i]!).map(line) });
      });
    assert.deepEqual(plain(replay(fixture.state, 0, undefined)), plain(replay(fixture.state, 0, fixture.opVersion)), "an untagged live op is judged by the old rule too");
  });

  test("a new mark on the legacy answer wins: the DM's Fail keeps the 3, takes its tag, and its line says a mark wrote it", () => {
    const loaded = migrateSnapshot(structuredClone(fixture.snapshot), fixture.snapshotVersion);
    const r = applyOp(loaded, { t: "roll.answer", rollId: "r1", target: { characterId: "thorn" }, result: "fail", tag: "now-1" }, DM, envelope(10));
    assert.ok(r.ok);
    const target = thorn(r.state);
    assert.deepEqual({ total: target.total, mark: target.mark, result: target.result, tag: target.tag }, { total: 3, mark: "fail", result: "fail", tag: "now-1" });
    assert.equal(resultOf(target, 13), "fail");
    assert.equal(resultOf(target, 2), "fail", "a mark wins whatever the DC");
    const line = r.log.at(-1)!;
    assert.deepEqual(line.data, { type: "roll", test: { kind: "save", choices: [{ ability: "dex" }] }, characterId: "thorn", total: 3, result: "fail", dc: 13, tag: "now-1", mark: true });
    assert.equal(archived(r.state, line, P1), null, "dropped by its own mark field");
    const pass = applyOp(replay(loaded, UNDO, fixture.opVersion).state, { t: "roll.answer", rollId: "r1", target: { characterId: "thorn" }, result: "pass", tag: "now-2" }, DM, envelope(11));
    assert.ok(pass.ok);
    assert.equal(resultOf(thorn(pass.state), 13), "pass", "a Pass mark on the undone 3 beats the DC");
  });
});
