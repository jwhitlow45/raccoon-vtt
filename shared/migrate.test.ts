import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { readEntity } from "./keys.ts";
import {
  OP_VERSION,
  SNAPSHOT_VERSION,
  healRevivesDead,
  migrateOp,
  migrateSnapshot,
  opMigrations,
  oneLinkPerActor,
  resizeStop,
  reviveToOne,
  runMigrations,
  snapshotMigrations,
  type MigrationStep,
} from "./migrate.ts";
import type { Encounter, RoomState } from "./model.ts";
import { opSchema, type Op, type RestoreEntry } from "./protocol.ts";
import { applyOp } from "./reducer.ts";
import { CHANGED_SINCE, guardMatches } from "./reducer/misc.ts";
import { guardHash } from "./reducer/tx.ts";
import { DM, character, companionBlock, comparable, env, room, token } from "./testutil.ts";

/** What the v1 reducer left: today's state without the spot each turn began on. */
function v1Shape(state: RoomState): RoomState {
  const strip = (encounter: Encounter): Encounter => {
    const { turnStart: _spot, ...rest } = encounter;
    return rest;
  };
  return {
    ...state,
    encounter: state.encounter && strip(state.encounter),
    encounterHistory: state.encounterHistory.map((snapshot) => ({ ...snapshot, encounter: strip(snapshot.encounter) })),
  };
}

/** What the v2 reducer left: today's state without paths, and without the seq that names each turn. */
function v2Shape(state: RoomState): RoomState {
  const strip = (encounter: Encounter): Encounter => {
    if (!encounter.turnStart) return encounter;
    const { seq: _seq, ...spot } = encounter.turnStart;
    return { ...encounter, turnStart: spot };
  };
  const tokens = Object.fromEntries(
    Object.entries(state.tokens).map(([id, t]) => {
      const { path: _path, ...rest } = t;
      return [id, rest];
    }),
  );
  return {
    ...state,
    tokens,
    encounter: state.encounter && strip(state.encounter),
    encounterHistory: state.encounterHistory.map((snapshot) => ({ ...snapshot, encounter: strip(snapshot.encounter) })),
  };
}

/** Only the 1 to 2 step, for what it did on its own. */
const toV2 = (op: unknown) => runMigrations(op, 1, 2, opMigrations);

/**
 * The ops a v1 server stored for these DM steps, each "undo" resolved to
 * the restore its stack held, guarded by hashes of the states the v1
 * reducer left. Every op applies to the state before it, as it did then.
 */
function v1Log(start: RoomState, steps: (Op | "undo")[], shape: (state: RoomState) => RoomState = v1Shape): { ops: Op[]; end: RoomState } {
  let state = start;
  const ops: Op[] = [];
  const stack: RestoreEntry[][] = [];
  for (const [i, step] of steps.entries()) {
    const op: Op = step === "undo" ? { t: "sys.restore", entries: stack.pop()!, from: "undo", deps: true } : step;
    const result = applyOp(state, op, DM, env(i + 1));
    assert.ok(result.ok, `v1 step ${i} (${op.t}): ${result.ok ? "" : result.message}`);
    const after = shape(result.state);
    if (step !== "undo") {
      stack.push(result.inverse!.map((e) => (e.expectHash === undefined ? e : { ...e, expectHash: guardHash(e.key, readEntity(after, e.key)) })));
    }
    ops.push(op);
    state = after;
  }
  return { ops, end: state };
}

type Replayed = { ok: true; state: RoomState } | { ok: false; at: number; message: string; state: RoomState };

/** Replays stored ops of a version the way loading a room does, with or without the op migrations. */
function replay(start: RoomState, ops: Op[], migrate: boolean, version = 1): Replayed {
  let state = start;
  for (const [i, stored] of ops.entries()) {
    const op = opSchema.parse(migrate ? migrateOp(stored, version) : stored) as Op;
    const result = applyOp(state, op, DM, env(i + 1));
    if (!result.ok) return { ok: false, at: i, message: result.message, state };
    state = result.state;
  }
  return { ok: true, state };
}

/** A room with three goblins on the player scene, for v1 fights to replay in. */
function fightRoom(): RoomState {
  return room({ tokens: { a: token("a", { x: 1, y: 1 }), b: token("b", { x: 4, y: 1 }), c: token("c", { x: 7, y: 1 }) } });
}

const START: Op = {
  t: "encounter.start",
  entries: [
    { id: "n1", tokenId: "a", value: 15 },
    { id: "n2", tokenId: "b", value: 10 },
    { id: "n3", tokenId: "c", value: 5 },
  ],
};
const NEXT: Op = { t: "encounter.next" };

describe("migrations", () => {
  test("the current versions pass through unchanged", () => {
    const state = room();
    assert.equal(migrateSnapshot(state, SNAPSHOT_VERSION), state);
    const op = { t: "log.chat", text: "x" };
    assert.equal(migrateOp(op, OP_VERSION), op);
  });

  test("a room from before custom monsters gets none, and anything else passes through for the schema to judge", () => {
    const { monsters: _monsters, ...old } = room();
    const migrated = migrateSnapshot(old, 1);
    assert.deepEqual(migrated, room());
    const current = room();
    assert.equal(migrateSnapshot(current, 1), current);
    assert.equal(migrateSnapshot(null, 1), null);
    assert.equal(migrateSnapshot("garbage", 1), "garbage");
  });

  test("a room from before SRD monster images gets none, from either older version", () => {
    const { srdImages: _srdImages, savedEncounters: _saved, ...v2 } = room();
    assert.deepEqual(migrateSnapshot(v2, 2), room());
    const { srdImages: _again, monsters: _monsters, savedEncounters: _savedAgain, ...v1 } = room();
    assert.deepEqual(migrateSnapshot(v1, 1), room());
  });

  test("a room from before saved encounters gets none, and one that has them keeps them", () => {
    const { savedEncounters: _saved, ...v4 } = room();
    assert.deepEqual(migrateSnapshot(v4, 4), room());
    const withOne = room({ savedEncounters: { e1: { id: "e1", rev: 0, name: "Wolves", monsters: [] } } });
    assert.equal(migrateSnapshot(withOne, 4), withOne);
  });

  test("a room from before stamps and lights gets none of them, and nothing else about it changes", () => {
    const { stamps: _stamps, lights: _lights, ...v5 } = room();
    const migrated = migrateSnapshot(v5, 5);
    assert.deepEqual(migrated, room());
    assert.equal(migrated.scenes, v5.scenes, "its scenes read as before, under today's automatic walls");
    const withOne = room({ lights: { l1: { id: "l1", rev: 0, sceneId: "s1", x: 1, y: 1, bright: 20, dim: 20, on: true, walls: true } } });
    assert.equal(migrateSnapshot(withOne, 5), withOne);
  });

  test("a room from before the explored layer gets an empty one, and nothing else about it changes", () => {
    const { exploredTiles: _explored, ...v6 } = room();
    const migrated = migrateSnapshot(v6, 6);
    assert.deepEqual(migrated, room());
    assert.equal(migrated.scenes, v6.scenes, "its scenes read as before: movement not blocked, vision off");
    assert.equal(migrated.tokens, v6.tokens);
    const tile = { sceneId: "s1", tx: 0, ty: 0, rev: 1, bits: "A".repeat(683) + "=" };
    const withOne = room({ exploredTiles: { "s1:0,0": tile } });
    assert.equal(migrateSnapshot(withOne, 6), withOne);
    // Older steps reach it too.
    const { exploredTiles: _again, stamps: _stamps, lights: _lights, ...v5 } = room();
    assert.deepEqual(migrateSnapshot(v5, 5), room());
  });

  test("a room from before wave 5 gets no pages, pins or rolls, and nothing else about it changes (docs/design-v1-dm-tools.md 2.3)", () => {
    const { journal: _journal, pins: _pins, rolls: _rolls, ...v7 } = room();
    const migrated = migrateSnapshot(v7, 7);
    assert.deepEqual(migrated, room());
    assert.equal(migrated.meta, v7.meta, "everyone may draw, as before");
    assert.equal(migrated.tokens, v7.tokens);
    const withOne = room({ journal: { pg1: { id: "pg1", rev: 0, title: "P", access: "dm", blocks: [] } } });
    assert.equal(migrateSnapshot(withOne, 7), withOne);
    // Every older version reaches it.
    const { journal: _j, pins: _p, rolls: _r, exploredTiles: _e, stamps: _s, lights: _l, ...v5 } = room();
    assert.deepEqual(migrateSnapshot(v5, 5), room());
  });

  test("a room from before pdf handouts gets no documents, and nothing else about it changes (docs/design-v1-pdf-handouts.md 3.8)", () => {
    const { handoutDocs: _docs, ...v8 } = room({ handouts: { h1: { id: "h1", rev: 0, assetId: "a", title: "Letter", to: "all", shownAt: "" } } });
    const migrated = migrateSnapshot(v8, 8);
    assert.deepEqual(migrated, { ...v8, handoutDocs: {} });
    assert.equal(migrated.handouts, v8.handouts, "a stored handout reads as one image, as before");
    const withOne = room({ handoutDocs: { d1: { id: "d1", rev: 0, title: "Strange letter", pages: [{ assetId: "a", width: 1, height: 1 }], createdAt: "" } } });
    assert.equal(migrateSnapshot(withOne, 8), withOne);
    // Every older version reaches it.
    const { handoutDocs: _d, journal: _j, pins: _p, rolls: _r, ...v7 } = room();
    assert.deepEqual(migrateSnapshot(v7, 7), room());
  });

  test("a version 9 snapshot never migrates down to 8, so going back to an older build is a restore (docs/design-v1-pdf-handouts.md 3.8)", () => {
    assert.ok(SNAPSHOT_VERSION >= 9);
    assert.throws(() => runMigrations(room(), 9, 8, snapshotMigrations), /down/);
  });

  test("a room from before companion stat blocks gets none, and nothing else about it changes (docs/design-v1-companion-stat-blocks.md 3.6)", () => {
    const { companionBlocks: _blocks, ...v9 } = room({ characters: { c1: character("c1") } });
    const migrated = migrateSnapshot(v9, 9);
    assert.deepEqual(migrated, { ...v9, companionBlocks: {} });
    const withOne = room({ characters: { c1: character("c1") }, companionBlocks: { b1: companionBlock("b1", "c1") } });
    assert.equal(migrateSnapshot(withOne, 9), withOne, "a state that has them is left alone");
    // Every older version reaches it.
    const { companionBlocks: _c, handoutDocs: _d, journal: _j, pins: _p, rolls: _r, ...v7 } = room();
    assert.deepEqual(migrateSnapshot(v7, 7), room());
  });

  test("a version 10 snapshot never migrates down to 9, so going back to an older build is a restore (docs/design-v1-companion-stat-blocks.md 3.6)", () => {
    assert.ok(SNAPSHOT_VERSION >= 10);
    assert.throws(() => runMigrations(room(), 10, 9, snapshotMigrations), /down/);
  });

  test("a room's stored undo from before wave 5 replays onto the migrated room, its guards matching as they did", () => {
    // A token's guard hashes the token alone, which wave 5 did not change, so the run that stored the undo is today's.
    const live = room({ tokens: { t1: token("t1", { name: "Goblin" }) } });
    const renamed = applyOp(live, { t: "token.update", tokenId: "t1", patch: { name: "Snik" } }, DM, env(1));
    assert.ok(renamed.ok && renamed.inverse);
    const stored = { t: "sys.restore", entries: renamed.inverse, from: "undo", deps: true } as Op;
    // The snapshot from before the ops as a v7 room stored it, migrated as a load does, then the ops replayed.
    const { journal: _journal, pins: _pins, rolls: _rolls, ...v7 } = live;
    let replayed = migrateSnapshot(JSON.parse(JSON.stringify(v7)), 7);
    for (const [seq, op] of [
      [1, { t: "token.update", tokenId: "t1", patch: { name: "Snik" } }],
      [2, { t: "sys.memberRemove", memberId: "p1" }],
      [3, { t: "scene.delete", sceneId: "s2" }],
      [4, stored],
    ] as [number, Op][]) {
      const result = applyOp(replayed, migrateOp(JSON.parse(JSON.stringify(op)), OP_VERSION), DM, env(seq));
      assert.ok(result.ok, `${op.t}: ${result.ok ? "" : result.message}`);
      replayed = result.state;
    }
    assert.equal(replayed.tokens.t1!.name, "Goblin");
    assert.deepEqual(replayed.journal, {});
    assert.deepEqual(replayed.pins, {});
  });

  test("a room from before who may move any token takes the switch's answer: on is every player, off is no one", () => {
    const v3 = (on: boolean | undefined) => {
      const state = room();
      const { playersMoveAny: _new, ...settings } = state.meta.settings;
      return { ...state, meta: { ...state.meta, settings: on === undefined ? settings : { ...settings, playersMoveAnyToken: on } } };
    };
    assert.equal(migrateSnapshot(v3(true), 3).meta.settings.playersMoveAny, "all");
    assert.equal(migrateSnapshot(v3(false), 3).meta.settings.playersMoveAny, "none");
    assert.equal(migrateSnapshot(v3(undefined), 3).meta.settings.playersMoveAny, "none");
    assert.equal("playersMoveAnyToken" in migrateSnapshot(v3(true), 3).meta.settings, false);
    assert.equal(migrateSnapshot(v3(true), 1).meta.settings.playersMoveAny, "all", "from the oldest version too");
    assert.deepEqual(migrateSnapshot(room(), 3), room());
  });

  test("older ops that set the switch, or undo to settings that had it, take the new setting", () => {
    const parses = (op: unknown) => opSchema.safeParse(op).success;
    const on = migrateOp({ t: "room.update", settings: { playersMoveAnyToken: true, skipDefeated: false } }, 1);
    assert.deepEqual(on, { t: "room.update", settings: { skipDefeated: false, playersMoveAny: "all" } });
    assert.ok(parses(on));
    assert.deepEqual(migrateOp({ t: "room.update", settings: { playersMoveAnyToken: false } }, 1), { t: "room.update", settings: { playersMoveAny: "none" } });
    assert.deepEqual(migrateOp({ t: "room.update", settings: { skipDefeated: true } }, 1), { t: "room.update", settings: { skipDefeated: true } });
    assert.deepEqual(migrateOp({ t: "room.update", name: "Crypt" }, 1), { t: "room.update", name: "Crypt" });
    const { playersMoveAny: _new, ...oldSettings } = room().meta.settings;
    const oldMeta = { ...room().meta, settings: { ...oldSettings, playersMoveAnyToken: true } };
    const restore = toV2({
      t: "sys.restore",
      entries: [
        { key: "meta", value: oldMeta, expectHash: "a".repeat(32) },
        { key: "token:t1", value: null, expectHash: "b".repeat(32) },
      ],
      from: "undo",
      deps: true,
    });
    assert.deepEqual(restore, {
      t: "sys.restore",
      entries: [
        { key: "meta", value: { ...oldMeta, settings: { ...oldSettings, playersMoveAny: "all" } } },
        { key: "token:t1", value: null, expectHash: "b".repeat(32) },
      ],
      from: "undo",
      deps: true,
    });
    assert.ok(parses(restore));
    const chat = { t: "log.chat", text: "x" };
    assert.equal(migrateOp(chat, 1), chat);
  });

  test("an older undo of turns advanced replays, though turns now record where they began", () => {
    const start = fightRoom();
    const { ops, end } = v1Log(start, [START, NEXT, NEXT, NEXT, "undo", "undo", NEXT]);

    const raw = replay(start, ops, false);
    assert.ok(!raw.ok);
    assert.equal(raw.at, 4, "the first undo, of the third turn");
    assert.equal(raw.message, CHANGED_SINCE);
    const undo = ops[4] as Extract<Op, { t: "sys.restore" }>;
    const stale = undo.entries.filter((e) => !guardMatches(e, readEntity(raw.state, e.key))).map((e) => e.key);
    assert.deepEqual(stale.sort(), ["encounter", "encounterHistory"], "both the encounter and its history hold a spot they did not");

    const migrated = toV2(undo) as Extract<Op, { t: "sys.restore" }>;
    for (const entry of migrated.entries) {
      assert.equal(entry.expectHash, undefined, `${entry.key} drops its guard`);
      assert.deepEqual(entry.value, undo.entries.find((e) => e.key === entry.key)!.value, `${entry.key} puts back what it did`);
    }

    const replayed = replay(start, ops, true);
    assert.ok(replayed.ok, replayed.ok ? "" : `op ${replayed.at}: ${replayed.message}`);
    assert.deepEqual(comparable(v1Shape(replayed.state)), comparable(end));
    assert.equal(replayed.state.encounter!.turnStart!.tokenId, "b", "the turn advanced after the undos records its spot");
  });

  test("an older undo of a removal that passed the turn on, a turn taken back, or a token deleted on its turn replays", () => {
    const cases: [string, Op][] = [
      ["a removal", { t: "encounter.remove", entryIds: ["n2"] }],
      ["a turn taken back", { t: "encounter.prev" }],
      ["a token deleted", { t: "token.delete", tokenId: "b" }],
    ];
    for (const [name, op] of cases) {
      const start = fightRoom();
      const { ops, end } = v1Log(start, [START, NEXT, NEXT, op, "undo", NEXT]);
      const raw = replay(start, ops, false);
      assert.ok(!raw.ok && raw.at === 4 && raw.message === CHANGED_SINCE, `${name}: refused without the migration`);
      const replayed = replay(start, ops, true);
      assert.ok(replayed.ok, `${name}: ${replayed.ok ? "" : `op ${replayed.at}: ${replayed.message}`}`);
      assert.deepEqual(comparable(v1Shape(replayed.state)), comparable(end), name);
    }
  });

  test("a v1 undo keeps its guards on everything but the meta, the encounter and its history", () => {
    const guarded = { key: "token:t1", value: null, expectHash: "b".repeat(32) };
    const gone = { key: "encounter", value: { rev: 0 }, expectRev: null };
    const restore = toV2({ t: "sys.restore", entries: [guarded, gone, { key: "encounterHistory", value: [], expectHash: "c".repeat(32) }], from: "undo" });
    assert.deepEqual(restore, { t: "sys.restore", entries: [guarded, gone, { key: "encounterHistory", value: [] }], from: "undo" });
  });

  test("a v2 undo drops its guards on tokens, the encounter and its history, and keeps the rest", () => {
    const entries = [
      { key: "token:t1", value: { id: "t1" }, expectHash: "a".repeat(32) },
      { key: "token:t2", value: null, expectRev: null },
      { key: "encounter", value: { rev: 0 }, expectHash: "b".repeat(32) },
      { key: "encounterHistory", value: [], expectHash: "c".repeat(32) },
      { key: "drawing:d1", value: null, expectHash: "d".repeat(32) },
      { key: "meta", value: room().meta, expectHash: "e".repeat(32) },
    ];
    assert.deepEqual(migrateOp({ t: "sys.restore", entries, from: "redo", deps: true }, 2), {
      t: "sys.restore",
      entries: [
        { key: "token:t1", value: { id: "t1" } },
        { key: "token:t2", value: null, expectRev: null },
        { key: "encounter", value: { rev: 0 } },
        { key: "encounterHistory", value: [] },
        { key: "drawing:d1", value: null, expectHash: "d".repeat(32) },
        { key: "meta", value: room().meta, expectHash: "e".repeat(32) },
      ],
      from: "redo",
      deps: true,
    });
    const move = { t: "token.move", tokenId: "t1", x: 2, y: 2 };
    assert.equal(migrateOp(move, 2), move);
  });

  test("a v2 undo of the active creature's moves and of a turn replays, though moves now record a path", () => {
    const start = fightRoom();
    const move = (tokenId: string, x: number): Op => ({ t: "token.move", tokenId, x, y: 1 });
    // A's turn: it moves twice and the DM takes the second back. B's turn: C, not B, is moved and that is taken back, then the turn too.
    const { ops, end } = v1Log(start, [START, NEXT, move("a", 2), move("a", 3), "undo", NEXT, move("c", 9), "undo", "undo"], v2Shape);
    const raw = replay(start, ops, false, 2);
    assert.ok(!raw.ok);
    assert.equal(raw.at, 4, "the undo of a's second move");
    assert.equal(raw.message, CHANGED_SINCE);
    const replayed = replay(start, ops, true, 2);
    assert.ok(replayed.ok, replayed.ok ? "" : `op ${replayed.at}: ${replayed.message}`);
    assert.deepEqual(comparable(v2Shape(replayed.state)), comparable(end));
  });

  test("steps run in order and stop at the target", () => {
    const steps: MigrationStep[] = [
      { from: 1, to: 2, apply: (v) => ({ ...(v as object), a: 1 }) },
      { from: 2, to: 3, apply: (v) => ({ ...(v as object), b: 2 }) },
    ];
    assert.deepEqual(runMigrations({}, 1, 3, steps), { a: 1, b: 2 });
    assert.deepEqual(runMigrations({}, 2, 3, steps), { b: 2 });
    assert.deepEqual(runMigrations({ z: 0 }, 3, 3, steps), { z: 0 });
  });

  test("a version with no path, a downgrade, and a bad step all throw", () => {
    const steps: MigrationStep[] = [{ from: 1, to: 2, apply: (v) => v }];
    assert.throws(() => runMigrations({}, 1, 3, steps), /no migration from version 2/);
    assert.throws(() => runMigrations({}, 3, 1, steps), /down/);
    assert.throws(() => runMigrations({}, 1, 2, [{ from: 1, to: 1, apply: (v) => v }]), /no migration/);
    assert.throws(() => migrateSnapshot({}, 0), /no migration/);
  });
});

describe("op version 5: healing the dead and Revive (docs/design-v1-combat-flow.md 4.7)", () => {
  test("the step from 4 returns every op unchanged", () => {
    assert.ok(OP_VERSION >= 5);
    const ops: unknown[] = [
      { t: "actor.hp", target: { tokenId: "g1" }, change: { kind: "heal", amount: 5 } },
      { t: "actor.life", target: { tokenId: "g1" }, life: "alive" },
      { t: "sys.restore", entries: [{ key: "token:g1", value: null, expectHash: "abc" }], from: "undo", deps: true },
    ];
    for (const op of ops) assert.equal(runMigrations(op, 4, 5, opMigrations), op);
  });

  test("healRevivesDead is false for a version 4 op whatever the setting, and otherwise reads absent as on", () => {
    assert.equal(healRevivesDead({ healRevives: true }, 4), false);
    assert.equal(healRevivesDead({}, 4), false);
    assert.equal(healRevivesDead({}, 3), false);
    assert.equal(healRevivesDead({ healRevives: true }, 5), true);
    assert.equal(healRevivesDead({}, 5), true);
    assert.equal(healRevivesDead({}), true, "a live op carries no version");
    assert.equal(healRevivesDead({ healRevives: true }), true);
    assert.equal(healRevivesDead({ healRevives: false }), false);
    assert.equal(healRevivesDead({ healRevives: false }, 5), false);
  });

  test("reviveToOne is false at version 4 and true at 5 and for a live op", () => {
    assert.equal(reviveToOne(4), false);
    assert.equal(reviveToOne(1), false);
    assert.equal(reviveToOne(5), true);
    assert.equal(reviveToOne(undefined), true);
  });
});

describe("op version 6: a resize is not movement (docs/design-v1-token-window.md 8.7)", () => {
  test("the step from 5 returns every op unchanged", () => {
    assert.ok(OP_VERSION >= 6);
    const ops: unknown[] = [
      { t: "token.update", tokenId: "g1", patch: { size: "large", x: 3, y: 0 } },
      { t: "token.update", tokenId: "g1", patch: { size: "huge" } },
      { t: "sys.restore", entries: [{ key: "token:g1", value: null, expectHash: "abc" }], from: "undo", deps: true },
    ];
    for (const op of ops) assert.equal(runMigrations(op, 5, 6, opMigrations), op);
    assert.equal(migrateOp(ops[0], 5), ops[0]);
  });

  test("resizeStop is false before version 6, and true at 6 and for a live op", () => {
    assert.equal(resizeStop(5), false);
    assert.equal(resizeStop(1), false);
    assert.equal(resizeStop(6), true);
    assert.equal(resizeStop(undefined), true);
  });
});

describe("op version 6: an actor links one stat block (docs/design-v1-companion-stat-blocks.md 3.2 and 3.6)", () => {
  test("the step from 5 returns every op unchanged", () => {
    assert.ok(OP_VERSION >= 6);
    const ops: unknown[] = [
      { t: "token.update", tokenId: "g1", patch: { actor: { srdId: "owl" } } },
      { t: "token.update", tokenId: "g1", patch: { actor: { srdId: "owl", monsterId: null } } },
      { t: "token.update", tokenId: "g1", patch: { size: "large", x: 3, y: 4 } },
      { t: "sys.restore", entries: [{ key: "token:g1", value: null, expectHash: "abc" }], from: "undo", deps: true },
    ];
    for (const op of ops) assert.equal(runMigrations(op, 5, 6, opMigrations), op);
    // Every older version reaches it.
    assert.deepEqual(migrateOp({ t: "log.chat", text: "hi" }, 4), { t: "log.chat", text: "hi" });
  });

  test("oneLinkPerActor is false at version 5 and before, and true at 6 and for a live op", () => {
    assert.equal(oneLinkPerActor(5), false);
    assert.equal(oneLinkPerActor(1), false);
    assert.equal(oneLinkPerActor(6), true);
    assert.equal(oneLinkPerActor(undefined), true);
  });

  test("a version 6 op never migrates down to 5", () => {
    assert.throws(() => runMigrations({ t: "log.chat", text: "hi" }, 6, 5, opMigrations), /down/);
  });
});

describe("wave 7's one bump: op version 7 and snapshot version 11 (docs/design-v1-roll-request.md 7.5)", () => {
  test("is the version now, and both steps return what they are given", () => {
    assert.equal(OP_VERSION, 7);
    assert.equal(SNAPSHOT_VERSION, 11);
    const ops: unknown[] = [
      { t: "roll.answer", rollId: "r1", target: { tokenId: "g1" }, total: 12 },
      { t: "log.chat", text: "hi" },
      { t: "sys.restore", entries: [{ key: "token:g1", value: null, expectHash: "abc" }], from: "undo", deps: true },
    ];
    for (const op of ops) assert.equal(runMigrations(op, 6, 7, opMigrations), op);
    const state = room();
    assert.equal(runMigrations(state, 10, 11, snapshotMigrations), state);
    // Every older version reaches it.
    assert.deepEqual(migrateOp({ t: "log.chat", text: "hi" }, 4), { t: "log.chat", text: "hi" });
    const { companionBlocks: _c, ...v9 } = room();
    assert.deepEqual(migrateSnapshot(v9, 9), room());
  });

  test("a version 7 op and a version 11 snapshot never migrate down, so going back is the backup's restore", () => {
    assert.throws(() => runMigrations({ t: "log.chat", text: "hi" }, 7, 6, opMigrations), /down/);
    assert.throws(() => runMigrations(room(), 11, 10, snapshotMigrations), /down/);
  });
});
