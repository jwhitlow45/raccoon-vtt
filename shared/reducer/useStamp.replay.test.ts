import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { describe, test } from "node:test";
import type { RoomState, Viewer } from "../model.ts";
import { hash128, stableStringify } from "../project.ts";
import { opSchema, type Op, type RestoreEntry } from "../protocol.ts";
import { applyOp } from "../reducer.ts";
import { AT, DM, P1, actor, character, chance, int, pick, rng, room, token } from "../testutil.ts";

/*
 * Stored ops of change formats 65 to 67 replay to what they made, whatever
 * change format 68 (migrate.ts usesStamped, docs/design/design-v1-slots.md 6)
 * changes: from 68 every rest of a character, and every use that changes
 * one, moves its `useRev`, which a stored op never did. The rooms: 120
 * seeded runs of 30 ops each on a table of Bree (Ana's, with class
 * resources), Thorn (the DM's, whose second token Ana is lent) and a
 * goblin with Legendary Actions, the DM and Ana resting, spending and
 * giving back resources, abilities, legendary actions and Legendary
 * Resistance, editing the characters, hurting and healing, and the DM's
 * undo and redo of each step as the server builds them. The fixture holds a
 * hash of the runs and, for each run at each format, a hash of every op's
 * result (the state, what it touched and its inverse), written by the base
 * build of change format 67. Write it again with
 * REPLAY_USE_STAMP=write only from that build.
 */

const FIXTURE = new URL("./useStamp.replay.fixture.json", import.meta.url);
const VERSIONS = [65, 66, 67] as const;
const SEEDS = 120;
const STEPS = 30;

type Stored = { op: Op; who: Viewer; seq: number };
/** A run: its ops as stored, on the one table every run starts from (`table`), which the fixture does not repeat. */
type Chain = { name: string; ops: Stored[] };
/** The fixture: a hash of the runs, and each run's result hash at each format. */
type Fixture = { runs: string } & Record<string, string[] | string>;

function table(): RoomState {
  const base = room();
  const goblin = actor({ hp: { cur: 30, max: 30, temp: 0 }, legendary: { actionsMax: 3, actionsUsed: 0, resistMax: 2, resistUsed: 0 } });
  return {
    ...base,
    characters: {
      bree: character("bree", {
        name: "Bree",
        ownerIds: ["p1"],
        level: 5,
        actor: actor({ hp: { cur: 20, max: 40, temp: 0 } }),
        resources: [
          { id: "rage", name: "Rage", max: 3, used: 0, reset: "shortOne" },
          { id: "ki", name: "Focus Points", max: 5, used: 0, reset: "short", pool: true },
          { id: "wild", name: "Wild Shape", max: 2, used: 0, reset: "long" },
        ],
      }),
      thorn: character("thorn", { name: "Thorn", ownerIds: [], actor: actor({ hp: { cur: 12, max: 30, temp: 0 } }) }),
    },
    tokens: {
      t1: token("t1", { kind: "pc", name: "Bree", actor: { ref: "bree" }, ownerIds: ["p1"] }),
      t2: token("t2", { kind: "pc", name: "Thorn", actor: { ref: "thorn" }, ownerIds: ["p1"], x: 3 }),
      gob: token("gob", { name: "Goblin Boss", actor: { inline: goblin }, x: 5 }),
    },
  };
}

const TARGETS = [{ characterId: "bree" }, { tokenId: "t1" }, { characterId: "thorn" }, { tokenId: "t2" }] as const;

function randomOp(r: () => number): { op: Op; who: Viewer } {
  const who = chance(r, 0.5) ? P1 : DM;
  const target = pick(r, TARGETS);
  const back = chance(r, 0.3) ? { back: true as const } : {};
  const c = r();
  if (c < 0.2) return { op: { t: "actor.rest", target, kind: pick(r, ["short", "long"] as const), ...(chance(r, 0.3) ? {} : {}) }, who };
  if (c < 0.4) {
    const id = pick(r, ["rage", "ki", "wild", "gone"]);
    return { op: { t: "actor.use", target: pick(r, [{ characterId: "bree" }, { tokenId: "t1" }] as const), use: { kind: "resource", id, ...(id === "ki" && chance(r, 0.5) ? { amount: int(r, 1, 3) } : {}) }, ...back }, who };
  }
  if (c < 0.55) {
    const limit = pick(r, ["recharge", "rest", "day"] as const);
    const use = { kind: "ability" as const, key: `actions:${pick(r, ["bite", "breath", "spell"])}`, name: "Bite", limit, max: limit === "day" ? 3 : 1, ...(limit === "recharge" ? { min: 5 } : {}), ...(!back.back && chance(r, 0.2) ? { ifReady: true as const } : {}) };
    return { op: { t: "actor.use", target: pick(r, [...TARGETS, { tokenId: "gob" }]), use, ...back } as Op, who };
  }
  if (c < 0.62) return { op: { t: "actor.use", target: { tokenId: "gob" }, use: chance(r, 0.5) ? { kind: "resist" } : { kind: "legendary", cost: int(r, 1, 2) }, ...back }, who: DM };
  if (c < 0.72) return { op: { t: "actor.hp", target, change: chance(r, 0.6) ? { kind: "damage", amount: int(r, 1, 15) } : { kind: "heal", amount: int(r, 1, 15) } }, who: DM };
  if (c < 0.8) return { op: { t: "character.update", characterId: pick(r, ["bree", "thorn"]), patch: chance(r, 0.5) ? { level: int(r, 1, 20) } : { actor: { notes: `n${int(r, 0, 99)}` } } }, who };
  if (c < 0.86) return { op: { t: "character.update", characterId: "bree", patch: { resources: [{ id: "rage", name: "Rage", max: int(r, 2, 5), reset: "shortOne" }, { id: "ki", name: "Focus Points", max: 5, reset: "short", pool: true }] } }, who };
  return { op: { t: "actor.rest", target: { characterId: pick(r, ["bree", "thorn"]) }, kind: "long" }, who: DM };
}

/** The runs, each as a server would have stored it at 67: the DM's undos and redos built from the run's inverses. */
function chains(): Chain[] {
  const out: Chain[] = [];
  for (let seed = 1; seed <= SEEDS; seed++) {
    const r = rng(seed * 7919);
    let state = table();
    const ops: Stored[] = [];
    const undo: RestoreEntry[][] = [];
    const redo: RestoreEntry[][] = [];
    for (let seq = 1; ops.length < STEPS && seq < STEPS * 4; seq++) {
      let op: Op;
      let who: Viewer = DM;
      let from: "undo" | "redo" | null = null;
      if (chance(r, 0.12) && undo.length > 0) {
        op = { t: "sys.restore", entries: undo.pop()!, from: "undo", deps: true, scope: "play" } as Op;
        from = "undo";
      } else if (chance(r, 0.05) && redo.length > 0) {
        op = { t: "sys.restore", entries: redo.pop()!, from: "redo", deps: true, scope: "play" } as Op;
        from = "redo";
      } else ({ op, who } = randomOp(r));
      const result = applyOp(state, opSchema.parse(op), who, { seq, at: AT, opVersion: 67 });
      if (!result.ok) continue;
      ops.push({ op, who, seq });
      state = result.state;
      if (result.inverse && who.role === "dm") {
        if (from === "undo") redo.push(result.inverse);
        else {
          undo.push(result.inverse);
          if (from === null) redo.length = 0;
        }
      }
    }
    out.push({ name: `seed ${seed}`, ops });
  }
  return out;
}

function resultHash(state: RoomState, s: Stored, opVersion: number | undefined): { hash: string; state: RoomState } {
  const r = applyOp(state, opSchema.parse(s.op), s.who, { seq: s.seq, at: AT, ...(opVersion !== undefined ? { opVersion } : {}) });
  if (!r.ok) return { hash: hash128(stableStringify({ refused: r.code, message: r.message })), state };
  return { hash: hash128(stableStringify({ state: r.state, touched: r.touched, inverse: r.inverse })), state: r.state };
}

function replay(c: Chain, opVersion: number | undefined): string[] {
  let state = table();
  return c.ops.map((s) => {
    const out = resultHash(state, s, opVersion);
    state = out.state;
    return out.hash;
  });
}

/** One hash a run at a format: of every op's result in order. */
function runHash(c: Chain, opVersion: number | undefined): string {
  return hash128(replay(c, opVersion).join(","));
}

describe("stored ops of change formats 65 to 67 replay to what they made (usesStamped)", () => {
  const runs = chains();
  if (process.env.REPLAY_USE_STAMP === "write") {
    const fixture: Fixture = { runs: hash128(stableStringify(runs)), ...Object.fromEntries(VERSIONS.map((v) => [String(v), runs.map((c) => runHash(c, v))])) };
    writeFileSync(FIXTURE, `${JSON.stringify(fixture, null, 2)}\n`);
  }
  const pinned = JSON.parse(readFileSync(FIXTURE, "utf8")) as Fixture;

  test("the runs are the ones the fixture was written from, so a change to the table shows here", () => {
    assert.equal(hash128(stableStringify(runs)), pinned.runs);
    const ops = runs.reduce((n, c) => n + c.ops.length, 0);
    assert.ok(ops >= SEEDS * STEPS * 0.9, `${ops} stored ops`);
  });

  test("every run's ops replay to the pinned results at each format, byte for byte", () => {
    for (const v of VERSIONS) assert.deepEqual(runs.map((c) => runHash(c, v)), pinned[String(v)], `at ${v}`);
  });

  test("live, the same ops on the room as format 67 left it move the use stamp of every rest and every use that changed a character", () => {
    // Each op reads the room its stored run left before it, so one op's change never moves what the next is asked on.
    let differs = 0;
    let stamped = 0;
    let total = 0;
    for (const c of runs) {
      let state = table();
      for (const s of c.ops) {
        total++;
        const old = resultHash(state, s, 67);
        const live = resultHash(state, s, undefined);
        if (live.hash !== old.hash) {
          differs++;
          if (["bree", "thorn"].some((id) => (live.state.characters[id]?.useRev ?? 0) !== (state.characters[id]?.useRev ?? 0))) stamped++;
        }
        // At 67 no stored op ever writes the stamp.
        for (const id of ["bree", "thorn"]) assert.equal(old.state.characters[id]?.useRev, undefined);
        state = old.state;
      }
    }
    // Every op that lands otherwise live does so by the stamp, and the stamp is common enough to bite.
    assert.equal(stamped, differs, `${differs} of ${total} ops land otherwise live, ${stamped} by the stamp`);
    assert.ok(differs > total / 5, `${differs} of ${total} ops land otherwise live`);
  });
});
