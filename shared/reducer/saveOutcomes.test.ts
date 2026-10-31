import assert from "node:assert/strict";
import { test } from "node:test";
import { uuidv7 } from "../ids.ts";
import { keys, readEntity } from "../keys.ts";
import { serializedBytes } from "../limits.ts";
import { OP_VERSION, SNAPSHOT_VERSION, migrateOp, migrateSnapshot, runMigrations, snapshotMigrations } from "../migrate.ts";
import type { Actor, RoomState, Viewer } from "../model.ts";
import { canApply } from "../permissions.ts";
import { projectState } from "../project.ts";
import { clientOpSchema, serverOnlyOpSchema, type Op, type OpOf, type RestoreEntry } from "../protocol.ts";
import { applyOp } from "../reducer.ts";
import type { SaveOutcomeFields, SaveOutcomeLedger, SaveOutcomeRestoreFields, SavePageAskFields, SaveRechargeSpend } from "../saveOutcomeContract.ts";
import { SAVE_OUTCOME_RETENTION_MS, SAVE_OUTCOME_LEDGER_BYTES } from "../saveOutcomeContract.ts";
import { MAX_OP_AGE_MS } from "../pendingOps.ts";
import { AT, DM, P1, actor, castAsk, character, customMonster, member, room, token, trap } from "../testutil.ts";
import { undoScope } from "../undoScope.ts";
import { guardHash } from "./tx.ts";

const time = Date.parse(AT);
type Tracked = RoomState & { saveOutcomes?: SaveOutcomeLedger };
type Outcome = OpOf<"actor.outcome"> & SaveOutcomeFields;
const ledger = (state: RoomState) => (state as Tracked).saveOutcomes ?? {};
const inline = (state: RoomState, id = "dragon"): Actor => (state.tokens[id]!.actor as { inline: Actor }).inline;
const recharge: SaveRechargeSpend = { target: { tokenId: "dragon" }, use: { kind: "ability", key: "actions:fire-breath", name: "Fire Breath", limit: "recharge", max: 1, min: 5, ifReady: true } };

function table(): Tracked {
  return room({
    monsters: { resistant: customMonster("resistant", { resistances: "Fire" }) },
    tokens: {
      dragon: token("dragon", { actor: { inline: actor({ hp: { cur: 30, max: 30, temp: 0 }, legendary: { actionsMax: 3, actionsUsed: 0, resistMax: 3, resistUsed: 0 } }) } }),
      goblin: token("goblin", { actor: { inline: actor({ monsterId: "resistant", hp: { cur: 20, max: 20, temp: 0 } }) } }),
    },
    characters: {
      alice: character("alice", { ownerIds: ["p1"] }),
      bob: character("bob", { ownerIds: ["p1"] }),
    },
  });
}

function outcome(id = uuidv7(time), targets: Outcome["targets"] = [{ target: { tokenId: "dragon" }, amount: 3 }], expectRevision = 0, plan = id): Outcome {
  return { t: "actor.outcome", plan, page: { id, expectRevision }, label: "Fire Breath", targets };
}

function run(state: RoomState, op: Op, seq = 1, who: Viewer = DM, at = AT, opVersion?: number) {
  return applyOp(state, op, who, { seq, at, ...(opVersion === undefined ? {} : { opVersion }) });
}

function accepted(state: RoomState, op: Op, seq = 1, who = DM, at = AT, opVersion?: number) {
  const result = run(state, op, seq, who, at, opVersion);
  assert.ok(result.ok, result.ok ? "" : result.message);
  return result;
}

function restore(id: string, plan: string, expectRevision: number, from: "undo" | "redo", entries: RestoreEntry[] = []): OpOf<"sys.restore"> & SaveOutcomeRestoreFields {
  return { t: "sys.restore", entries, from, scope: "play", deps: true, saveOutcome: { id, plan, expectRevision, state: from === "undo" ? "undone" : "applied" } };
}

test("tracked Apply, whole Undo, Redo and new Apply advance one lifecycle without generic rev or ledger inverses", () => {
  const id = uuidv7(time);
  const before = table();
  const applied = accepted(before, outcome(id));
  assert.deepEqual(ledger(applied.state)[id], { memberId: DM.memberId, plan: id, revision: 1, state: "applied", firstAppliedAt: AT, seq: 1 });
  assert.ok(applied.touched.includes(`saveOutcome:${id}`));
  assert.ok(applied.inverse?.length);
  assert.ok(applied.inverse.every((entry) => !entry.key.startsWith("saveOutcome:")));
  assert.equal(inline(before).hp.cur, 30, "copy-on-write preserves the prior state");
  const undone = accepted(applied.state, restore(id, id, 1, "undo", applied.inverse), 2);
  assert.equal(inline(undone.state).hp.cur, 30);
  assert.equal(ledger(undone.state)[id]?.revision, 2);
  assert.equal(ledger(undone.state)[id]?.state, "undone");
  const redone = accepted(undone.state, restore(id, id, 2, "redo", undone.inverse!), 3);
  assert.equal(ledger(redone.state)[id]?.revision, 3);
  assert.equal(ledger(redone.state)[id]?.state, "applied");
  const back = accepted(redone.state, restore(id, id, 3, "undo", redone.inverse!), 4);
  const planB = uuidv7(time + 1);
  const next = accepted(back.state, outcome(id, undefined, 4, planB), 5);
  assert.deepEqual(ledger(next.state)[id], { memberId: DM.memberId, plan: planB, revision: 5, state: "applied", firstAppliedAt: AT, seq: 5 });
});

test("2 fire with a passed save and resistance records lifecycle despite a null entity inverse", () => {
  const id = uuidv7(time);
  const before = table();
  const damage = { parts: [{ amount: 2, type: "fire" as const }], save: { result: "pass" as const, onPass: "half" as const, dex: true, evasion: false } };
  const applied = accepted(before, outcome(id, [{ target: { tokenId: "goblin" }, damage }]));
  assert.equal(inline(applied.state, "goblin").hp.cur, 20);
  assert.equal(applied.inverse, null);
  assert.equal(ledger(applied.state)[id]?.state, "applied");
  const undone = accepted(applied.state, restore(id, id, 1, "undo"), 2);
  assert.equal(undone.inverse, null);
  assert.equal(ledger(undone.state)[id]?.state, "undone");
  const redone = accepted(undone.state, restore(id, id, 2, "redo"), 3);
  assert.equal(ledger(redone.state)[id]?.revision, 3);
  for (const result of [undone, redone]) {
    assert.deepEqual(result.log, [], "lifecycle alone writes no notice or visible counter event");
    assert.deepEqual(projectState(result.state, P1, { sceneId: "s1" }), projectState(applied.state, P1, { sceneId: "s1" }));
  }
});

test("empty restores need a retained exact authorized transition, not metadata presence", () => {
  const id = uuidv7(time);
  const state = accepted(table(), outcome(id)).state;
  assert.equal(serverOnlyOpSchema.safeParse({ t: "sys.restore", entries: [], from: "undo" }).success, false);
  assert.ok(serverOnlyOpSchema.safeParse(restore(id, id, 1, "undo")).success);
  const wrong = [
    restore(uuidv7(time), id, 1, "undo"), restore(id, uuidv7(time), 1, "undo"),
    restore(id, id, 0, "undo"), restore(id, id, 2, "undo"), restore(id, id, 1, "redo"),
  ];
  for (const op of wrong) assert.equal(run(state, op, 2).ok, false, JSON.stringify(op));
  assert.equal(run(state, restore(id, id, 1, "undo"), 2, { memberId: "dm2", role: "dm" }).ok, false);
  assert.equal(run(state, restore(id, id, 1, "undo"), 2, P1).ok, false);
  assert.equal(run(state, { t: "sys.restore", entries: [], from: "undo" }, 2).ok, false);
});

test("first Apply admits pending age and clock lead boundaries, refuses stale identities and mismatched first plan", () => {
  for (const age of [-5 * 60 * 1000, MAX_OP_AGE_MS]) {
    assert.ok(run(table(), outcome(uuidv7(time - age))).ok, `accepted boundary ${age}`);
  }
  for (const age of [-5 * 60 * 1000 - 1, MAX_OP_AGE_MS + 1]) {
    assert.equal(run(table(), outcome(uuidv7(time - age))).ok, false, `refused boundary ${age}`);
  }
  const id = uuidv7(time);
  assert.equal(run(table(), outcome(id, undefined, 1)).ok, false);
  assert.equal(run(table(), outcome(id, undefined, 0, uuidv7(time))).ok, false);
  const state = accepted(table(), outcome(id)).state;
  for (const op of [outcome(id), outcome(id, undefined, 1, uuidv7(time))]) assert.equal(run(state, op, 2).ok, false);
  const undone = accepted(state, restore(id, id, 1, "undo", accepted(table(), outcome(id)).inverse!), 2).state;
  assert.equal(run(undone, outcome(id, undefined, 1, uuidv7(time)), 3).ok, false);
  assert.equal(run(undone, outcome(id, undefined, 2, uuidv7(time)), 3, { memberId: "dm2", role: "dm" }).ok, false);
});

function fullLedger(at = AT, count = 200): SaveOutcomeLedger {
  return Object.fromEntries(Array.from({ length: count }, (_, i) => {
    const id = `019a5d70-0000-7000-8000-${String(i).padStart(12, "0")}`;
    return [id, { memberId: DM.memberId, plan: id, revision: 1, state: "applied", firstAppliedAt: at, seq: i + 1 }];
  }));
}

test("201st Apply evicts by first time then tracking id, retains its own status, and never exposes eviction inverses", () => {
  for (const targets of [[{ target: { tokenId: "dragon" }, amount: 3 }], [{ target: { tokenId: "goblin" } }]]) {
    const before = table();
    before.saveOutcomes = fullLedger();
    const oldest = Object.keys(before.saveOutcomes).sort()[0]!;
    const id = uuidv7(time);
    const applied = accepted(before, outcome(id, targets), 201);
    assert.equal(Object.keys(ledger(applied.state)).length, 200);
    assert.equal(ledger(applied.state)[oldest], undefined);
    assert.equal(ledger(applied.state)[id]?.state, "applied");
    assert.ok(serializedBytes(ledger(applied.state)) <= SAVE_OUTCOME_LEDGER_BYTES);
    assert.ok(applied.touched.includes(`saveOutcome:${oldest}`));
    assert.ok((applied.inverse ?? []).every((entry) => !entry.key.startsWith("saveOutcome:")));
    assert.equal(Object.keys(before.saveOutcomes).length, 200);
  }
});

test("expiry uses stored envelope time from first Apply, stages pruning atomically and excludes its keys from inverses", () => {
  const before = table();
  before.saveOutcomes = fullLedger(new Date(time - SAVE_OUTCOME_RETENTION_MS).toISOString(), 2);
  const id = uuidv7(time);
  const applied = accepted(before, outcome(id));
  assert.deepEqual(Object.keys(ledger(applied.state)), [id]);
  assert.ok((applied.inverse ?? []).every((entry) => !entry.key.startsWith("saveOutcome:")));
  for (const oldId of Object.keys(before.saveOutcomes)) assert.ok(applied.touched.includes(`saveOutcome:${oldId}`));
  for (const initial of [fullLedger(), fullLedger(new Date(time - SAVE_OUTCOME_RETENTION_MS).toISOString())]) {
    const failedState = { ...table(), saveOutcomes: initial };
    const saved = structuredClone(failedState);
    const rejected = run(failedState, outcome(id, [{ target: { tokenId: "dragon" }, amount: 3 }, { target: { tokenId: "gone" }, amount: 1 }]));
    assert.equal(rejected.ok, false);
    assert.deepEqual(failedState, saved, "refusal evicts/prunes/spends nothing");
  }
});

test("reapplying near expiry keeps the original first-Apply time and pruning follows the replay envelope", () => {
  const id = uuidv7(time);
  const applied = accepted(table(), outcome(id));
  const undone = accepted(applied.state, restore(id, id, 1, "undo", applied.inverse!), 2);
  const later = time + SAVE_OUTCOME_RETENTION_MS - 1;
  const reapplied = accepted(undone.state, outcome(id, undefined, 2, uuidv7(later)), 3, DM, new Date(later).toISOString());
  assert.equal(ledger(reapplied.state)[id]?.firstAppliedAt, AT);
  const expiry = time + SAVE_OUTCOME_RETENTION_MS;
  const nextId = uuidv7(expiry);
  const pruned = accepted(reapplied.state, outcome(nextId), 4, DM, new Date(expiry).toISOString());
  assert.equal(ledger(pruned.state)[id], undefined, "reapplication never renews the retention period");
  assert.ok(pruned.touched.includes(`saveOutcome:${id}`));
  assert.ok(pruned.inverse?.every((entry) => !entry.key.startsWith("saveOutcome:")));
});

test("capacity evicts the oldest first-Apply time before tracking id or latest sequence", () => {
  const before = table();
  before.saveOutcomes = fullLedger();
  const oldestId = Object.keys(before.saveOutcomes).sort().at(-1)!;
  before.saveOutcomes[oldestId] = { ...before.saveOutcomes[oldestId]!, firstAppliedAt: new Date(time - 1000).toISOString(), seq: 99999 };
  const applied = accepted(before, outcome());
  assert.equal(ledger(applied.state)[oldestId], undefined);
  assert.ok(ledger(applied.state)[Object.keys(before.saveOutcomes).sort()[0]!]);
});

test("capacity evicts enough oldest records to honor serialized bytes including escaped member ids and map keys", () => {
  const before = table();
  before.saveOutcomes = fullLedger(AT, 199);
  // JSON-escaped member ids reach the aggregate cap before the 200-record cap.
  for (const record of Object.values(before.saveOutcomes)) {
    record.memberId = "\ud800".repeat(50);
    record.revision = Number.MAX_SAFE_INTEGER;
    record.seq = Number.MAX_SAFE_INTEGER;
  }
  assert.ok(serializedBytes(before.saveOutcomes) <= SAVE_OUTCOME_LEDGER_BYTES);
  const who = { memberId: "\ud800".repeat(56), role: "dm" as const };
  before.members[who.memberId] = member(who.memberId, "dm");
  const id = uuidv7(time);
  const applied = accepted(before, outcome(id), Number.MAX_SAFE_INTEGER, who);
  assert.ok(ledger(applied.state)[id], "byte pressure must not downgrade or refuse the tracked Apply");
  assert.ok(serializedBytes(ledger(applied.state)) <= SAVE_OUTCOME_LEDGER_BYTES);
  assert.ok(Object.keys(ledger(applied.state)).length === 199);
  assert.ok(applied.inverse?.every((entry) => !entry.key.startsWith("saveOutcome:")));
});

test("lifecycle guards refuse before actor restoration, and generic restores cannot write ledger keys", () => {
  const id = uuidv7(time);
  const applied = accepted(table(), outcome(id));
  assert.ok(applied.inverse);
  const saved = structuredClone(applied.state);
  for (const op of [restore(id, uuidv7(time), 1, "undo", applied.inverse), restore(id, id, 2, "undo", applied.inverse)]) {
    assert.equal(run(applied.state, op, 2).ok, false);
    assert.deepEqual(applied.state, saved);
  }
  const generic: Op = { t: "sys.restore", entries: [{ key: `saveOutcome:${id}`, value: null }], from: "undo" };
  assert.equal(serverOnlyOpSchema.safeParse(generic).success, false);
  assert.equal(run(applied.state, generic, 2).ok, false);
});

test("embedded recharge, targets, effects and Resistance restore together, and refusal rolls all of them back", () => {
  const before = table();
  const id = uuidv7(time);
  const op = { ...outcome(id, [
    { target: { tokenId: "dragon" }, amount: 3, resist: true, effects: [{ id: "fear", key: "frightened" }] },
    { target: { tokenId: "goblin" }, amount: 4 },
  ]), recharge };
  const applied = accepted(before, op);
  assert.equal(inline(applied.state).uses?.[recharge.use.key]?.used, 1);
  assert.equal(inline(applied.state).legendary?.resistUsed, 1);
  assert.equal(inline(applied.state).effects[0]?.id, "fear");
  assert.equal(inline(applied.state, "goblin").hp.cur, 16);
  const undone = accepted(applied.state, restore(id, id, 1, "undo", applied.inverse!), 2);
  assert.deepEqual(inline(undone.state), inline(before));
  assert.deepEqual(inline(undone.state, "goblin"), inline(before, "goblin"));
  for (const target of [{ tokenId: "gone" }, { tokenId: "goblin" }]) {
    const bad = { ...op, targets: [...op.targets, { target, remove: ["missing"] }] };
    const saved = structuredClone(before);
    assert.equal(run(before, bad).ok, false);
    assert.deepEqual(before, saved);
  }
  const invalidSpend = { ...op, recharge: { ...recharge, use: { ...recharge.use, back: true } } };
  assert.equal(clientOpSchema.safeParse(invalidSpend).success, false);
});

test("an already-spent ifReady recharge survives outcome Undo and secret use lines retain their audience", () => {
  const before = table();
  inline(before).uses = { [recharge.use.key]: { kind: "recharge", name: recharge.use.name, used: 1, max: 1, min: 5 } };
  const id = uuidv7(time);
  const applied = accepted(before, { ...outcome(id), recharge: { ...recharge, quiet: true } } as Outcome);
  assert.equal(applied.log.filter((line) => line.data?.type === "use").length, 0);
  const undone = accepted(applied.state, restore(id, id, 1, "undo", applied.inverse!), 2);
  assert.deepEqual(inline(undone.state).uses, inline(before).uses);
  const quiet = accepted(table(), { ...outcome(uuidv7(time)), recharge: { ...recharge, quiet: true } } as Outcome);
  assert.ok(quiet.log.some((line) => line.data?.type === "use" && line.data.hidden));
  assert.ok(!projectState(quiet.state, P1, { sceneId: "s1" }).log.some((line) => line.data?.type === "use"));
});

test("tracked cast resolution restores the exact ask and lifecycle together, while stale competing Applies change nothing", () => {
  const before = table();
  before.casts.cast = castAsk("cast", { caster: "dragon", by: P1.memberId });
  const id = uuidv7(time);
  const op = { ...outcome(id), cast: "cast", recharge };
  const applied = accepted(before, op);
  assert.equal(applied.state.casts.cast, undefined);
  assert.equal(ledger(applied.state)[id]?.state, "applied");
  const undone = accepted(applied.state, restore(id, id, 1, "undo", applied.inverse!), 2);
  assert.deepEqual({ ...undone.state.casts.cast, rev: 0 }, { ...before.casts.cast, rev: 0 });
  assert.equal(ledger(undone.state)[id]?.state, "undone");
  const saved = structuredClone(applied.state);
  assert.equal(run(applied.state, { ...outcome(uuidv7(time)), cast: "cast", recharge } as Outcome, 2).ok, false);
  assert.deepEqual(applied.state, saved);
  const bad = { ...op, targets: [...op.targets, { target: { tokenId: "gone" }, amount: 2 }] };
  const original = structuredClone(before);
  assert.equal(run(before, bad).ok, false);
  assert.deepEqual(before, original, "staged cast closure and recharge roll back with refused targets");
  for (const end of ["withdrawn", "dismissed"] as const) {
    const closed = accepted(before, { t: "cast.close", castId: "cast", end }, 1, end === "withdrawn" ? P1 : DM);
    const plainId = uuidv7(time);
    const plain = accepted(closed.state, outcome(plainId), 2);
    const back = accepted(plain.state, restore(plainId, plainId, 1, "undo", plain.inverse!), 3);
    assert.equal(back.state.casts.cast, undefined, "plain pages never resurrect a final closed ask");
  }
});

test("tracked trap outcome restores only its exact occurrence and refuses changed or deleted trap inverses atomically", () => {
  const before = table();
  const base = trap("pit");
  before.traps.pit = { ...base, state: "sprung", rig: { ...base.rig!, due: [{ id: "1:900000", at: AT, how: "enter", by: ["dragon"], hits: ["dragon"] }] } };
  const id = uuidv7(time);
  const op = { ...outcome(id), trap: { trapId: "pit", due: "1:900000" } };
  const applied = accepted(before, op);
  assert.equal(applied.state.traps.pit!.rig!.due, undefined);
  const back = accepted(applied.state, restore(id, id, 1, "undo", applied.inverse!), 2);
  assert.deepEqual(back.state.traps.pit!.rig!.due, before.traps.pit!.rig!.due);
  assert.equal(ledger(back.state)[id]?.state, "undone");
  for (const change of ["rig", "deleted", "new occurrence"] as const) {
    const changed = structuredClone(applied.state);
    if (change === "deleted") delete changed.traps.pit;
    else if (change === "rig") changed.traps.pit!.rig!.note = "Changed since Apply";
    else changed.traps.pit!.rig!.due = [{ id: "2:900000", at: AT, how: "enter", by: ["dragon"], hits: ["dragon"] }];
    const saved = structuredClone(changed);
    assert.equal(run(changed, restore(id, id, 1, "undo", applied.inverse!), 3).ok, false, change);
    assert.deepEqual(changed, saved, "failed whole restore cannot unlock or overwrite a newer occurrence");
  }
});

function ask(id: string, replaces?: SavePageAskFields["replaces"]): OpOf<"roll.ask"> & SavePageAskFields {
  return { t: "roll.ask", reason: "savePage", ...(replaces ? { replaces } : {}), request: { id, test: { kind: "save", choices: [{ ability: "dex" }] }, dc: 13, dcShown: true, resultShown: true, targets: [{ characterId: "alice" }, { characterId: "bob" }] } };
}

test("page asks/closes have None scope while explicit controls stay Play and page metadata is DM-only", () => {
  const before = table();
  const automatic = ask("old");
  const { reason: _reason, ...explicit } = automatic;
  assert.equal(undoScope(automatic, before), "none");
  assert.equal(undoScope({ t: "roll.close", rollIds: ["old"], reason: "savePage" } as Op, before), "none");
  assert.equal(undoScope(explicit, before), "play");
  assert.equal(undoScope({ t: "roll.close", rollIds: ["old"] }, before), "play");
  for (const op of [automatic, { ...automatic, request: { ...automatic.request, id: "fresh" }, replaces: [{ id: "old", expectHash: "a".repeat(32) }] }, { t: "roll.close", rollIds: ["old"], reason: "savePage" } as Op]) {
    assert.equal(canApply(op, P1, before, { canUseAsset: () => true }).ok, false);
  }
});

test("replacement retires requests as bookkeeping atomically, including when room capacity is full", () => {
  let state = table();
  for (let i = 0; i < 20; i++) state = accepted(state, ask(`old${i}`), i + 1).state;
  const old = state.rolls.old0!;
  const r = accepted(state, ask("fresh", [{ id: old.id, expectHash: guardHash(keys.roll(old.id), old) }]), 21);
  assert.equal(r.state.rolls.old0, undefined);
  assert.ok(r.state.rolls.fresh);
  assert.equal(Object.keys(r.state.rolls).length, 20);
  assert.ok((r.inverse ?? []).every((entry) => entry.key !== keys.roll(old.id)), "Undo never revives an automatically retired request");
});

test("selected Alice/unselected Bob answering races a replacement, including Close/Undo Close resetting rev", () => {
  for (const restoreClosed of [false, true]) {
    const initial = accepted(table(), ask("old")).state;
    const prepared = ask("fresh", [{ id: "old", expectHash: guardHash(keys.roll("old"), initial.rolls.old) }]);
    let current = accepted(initial, { t: "roll.answer", rollId: "old", target: { characterId: "bob" }, total: 18, tag: "answer" }, 2, P1).state;
    if (restoreClosed) {
      const closed = accepted(current, { t: "roll.close", rollIds: ["old"] }, 3);
      current = accepted(closed.state, { t: "sys.restore", entries: closed.inverse!, from: "undo", deps: true }, 4).state;
      assert.equal(current.rolls.old!.rev, initial.rolls.old!.rev, "equal revisions cannot prove equal request values");
    }
    const saved = structuredClone(current);
    const rejected = run(current, prepared, 5);
    assert.equal(rejected.ok, false);
    assert.deepEqual(current, saved);
    assert.equal(current.rolls.old!.targets[1]?.total, 18);
    assert.equal(current.rolls.fresh, undefined);
    const retry = ask("retry", [{ id: "old", expectHash: guardHash(keys.roll("old"), current.rolls.old) }]);
    retry.request.targets = [{ characterId: "alice" }];
    const applied = accepted(current, retry, 6);
    assert.equal(applied.state.rolls.old, undefined);
    assert.deepEqual(applied.state.rolls.retry!.targets, [{ characterId: "alice" }]);
    assert.ok(applied.state.log.some((line) => line.data?.type === "roll" && line.data.characterId === "bob" && line.data.total === 18));
  }
});

test("all replacement hashes and fresh targets validate before any retired request is deleted", () => {
  const initial = accepted(accepted(table(), ask("one")).state, ask("two"), 2).state;
  const replacements = ["one", "two"].map((id) => ({ id, expectHash: guardHash(keys.roll(id), initial.rolls[id]) }));
  for (const op of [
    ask("fresh", [replacements[0]!, { ...replacements[1]!, expectHash: "0".repeat(32) }]),
    { ...ask("fresh", replacements), request: { ...ask("fresh").request, targets: [{ characterId: "gone" }] } },
  ]) {
    const saved = structuredClone(initial);
    assert.equal(run(initial, op, 3).ok, false);
    assert.deepEqual(initial, saved);
  }
});

test("DM status projects through entity reads, while player/display/View-as serialized states expose no metadata", () => {
  const id = uuidv7(time);
  const state = accepted(table(), outcome(id)).state;
  assert.deepEqual(readEntity(state, `saveOutcome:${id}`), ledger(state)[id]);
  const dm = JSON.stringify(projectState(state, DM, { sceneId: "s1" }));
  assert.ok(dm.includes(id));
  for (const who of [P1, { memberId: "display:table", role: "player" as const }, { ...DM, role: "player" as const }]) {
    const bytes = JSON.stringify(projectState(state, who, { sceneId: "s1" }));
    for (const secret of ["saveOutcomes", id, "firstAppliedAt", "checkpoint", "beforeApply", "saveOutcome:"]) assert.ok(!bytes.includes(secret), secret);
  }
});

test("op 33/34 history replays unchanged and snapshot 29/30/31 never invents status", () => {
  assert.equal(OP_VERSION, 35);
  assert.equal(SNAPSHOT_VERSION, 31);
  const { page: _page, ...legacy } = outcome();
  for (const version of [33, 34, 35]) {
    assert.deepEqual(migrateOp(legacy, version), legacy);
    const r = accepted(table(), migrateOp(legacy, version), 7, DM, AT, version);
    assert.equal(inline(r.state).hp.cur, 27);
    assert.equal((r.state as Tracked).saveOutcomes, undefined);
    assert.deepEqual(r.log.map((line) => line.id), ["7:0"]);
  }
  for (const version of [29, 30, 31]) {
    const before = table();
    assert.deepEqual(migrateSnapshot(before, version), before);
    assert.equal((migrateSnapshot(before, version) as Tracked).saveOutcomes, undefined);
  }
  assert.throws(() => runMigrations({ ...table(), saveOutcomes: {} }, 31, 30, snapshotMigrations), /cannot migrate/);
});

test("a first Apply minted further ahead than the clock lead allows is refused for the clock, and an old one as unavailable", () => {
  const ahead = run(table(), outcome(uuidv7(time + 5 * 60 * 1000 + 1)));
  assert.equal(ahead.ok, false);
  assert.equal(ahead.ok ? "" : ahead.message, "This device's clock is ahead of the server's. Correct it and apply again.");
  const old = run(table(), outcome(uuidv7(time - MAX_OP_AGE_MS - 1)));
  assert.equal(old.ok ? "" : old.message, "This save's outcome cannot be checked. Start a new group save to continue.");
});

test("a DM's entity-only Undo past a record's retention prunes it as bookkeeping, and inside retention keeps it", () => {
  const id = uuidv7(time);
  const applied = accepted(table(), outcome(id));
  const entityOnly = { t: "sys.restore" as const, entries: applied.inverse!, from: "undo" as const, scope: "play" as const, deps: true as const };
  const late = new Date(time + SAVE_OUTCOME_RETENTION_MS).toISOString();
  const pruned = accepted(applied.state, entityOnly, 2, DM, late);
  assert.equal(ledger(pruned.state)[id], undefined, "the expired record no longer claims a status the restore made untrue");
  assert.ok(!(pruned.inverse ?? []).some((entry) => entry.key === keys.saveOutcome(id)), "pruning is bookkeeping, never an inverse");
  const early = new Date(time + SAVE_OUTCOME_RETENTION_MS - 1).toISOString();
  assert.equal(ledger(accepted(applied.state, entityOnly, 2, DM, early).state)[id]?.state, "applied");
});
