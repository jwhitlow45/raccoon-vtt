import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { describe, test } from "node:test";
import { ANA, GROUND, UPPER, putOp, thornToken, tower } from "./floorLinksTestutil.ts";
import type { RoomState, Scene, Viewer } from "./model.ts";
import { hash128, stableStringify } from "./project.ts";
import { opSchema, type Op } from "./protocol.ts";
import { applyOp } from "./reducer.ts";
import { placedOnHex } from "./rules/footprint.ts";
import { gridOfShape, isHex } from "./rules/grid.ts";
import { AT, DM, template, token, trap } from "./testutil.ts";

/*
 * Stored ops of change formats 62 and 63 replay to what they made
 * (docs/design/design-v1-floors.md phase 4, 11), whatever change format 64
 * (migrate.ts OPENINGS_OP_VERSION) changes: climbs up and down stairs and
 * a ladder onto trapped squares and into an area on a creature's turn, a
 * pit a walk springs, and Move to floor, by Ana and by the DM, on squares
 * and on hexes. The fixture holds each room and its ops as stored, and a
 * hash of every result as the build before openings made it: its state,
 * the keys it wrote, its trap marks and its undo. Write it again with
 * REPLAY_FLOORS4=write only from the build the stored ops were written by.
 */

const FIXTURE = new URL("./floors4.replay.fixture.json", import.meta.url);
const VERSIONS = [62, 63] as const;

type Stored = { op: Op; who: Viewer; seq: number };
type Tail = { name: string; initial: RoomState; ops: Stored[] };
type Fixture = { tails: (Tail & { hashes: Record<string, string[]> })[] };

const hexes = (s: RoomState): RoomState => ({ ...s, scenes: Object.fromEntries(Object.entries(s.scenes).map(([id, sc]) => [id, sc.floor ? ({ ...sc, gridShape: "hexRows" } as Scene) : sc])) });

/** Where a Medium creature's box goes to stand on a cell: its corner on squares, placed on the hex on hexes (footprint.ts placedOnHex). */
function at(hex: boolean, col: number, row: number): { x: number; y: number } {
  const g = gridOfShape(hex ? "hexRows" : undefined);
  return isHex(g) ? placedOnHex(g, token("medium", { x: 0, y: 0 }), { col, row }) : { x: col, y: row };
}

/**
 * The tower with stairs under Thorn and a ladder under a goblin, Upper
 * floor's landing armed with a trap that goes off on entering and covered
 * by Spirit Guardians, a pit on Ground floor's way east, and Thorn's turn
 * under way, every piece put there by stored ops.
 */
function room(hex: boolean): { initial: RoomState; setup: Op[] } {
  const base = tower({ tokens: { thorn: thornToken(at(hex, 3, 3)), goblin: token("goblin", { sceneId: GROUND, ...at(hex, 10, 10), name: "Goblin", kind: "npc", disposition: "hostile" }) } });
  const initial = hex ? hexes(base) : base;
  const landing = { cells: [{ x: 3, y: 3, w: 2, h: 1 }] };
  const rig = { on: ["enter" as const], who: "any" as const, floor: true, resets: "never" as const, stops: false, foundOnSpring: true, hits: "trigger" as const, actions: [], find: [], notice: false };
  const { rev: _rev, state: _state, found: _found, ...pit } = trap("tp", { sceneId: GROUND, name: "Pit", zone: { cells: [{ x: 6, y: 3, w: 1, h: 1 }] }, rig: { ...rig, stops: true, pit: { floor: -10 } } });
  const { rev: _r2, state: _s2, found: _f2, ...lid } = trap("tu", { sceneId: UPPER, name: "Snare", zone: landing, rig: { ...rig, hits: "zone" } });
  const { rev: _r3, ...guardians } = template("sg", { sceneId: UPPER, shape: "sphere", size: 10, origin: { x: 4, y: 3.5, z: 0 }, ownerId: "dm1", spell: "Spirit Guardians", triggers: ["enter", "turnEnd"] });
  const setup: Op[] = [
    putOp(),
    putOp({ id: "l3", pairId: "l4", rect: { x: 10, y: 10, w: 1, h: 1 }, kind: "ladder" }),
    { t: "trap.create", trap: pit },
    { t: "trap.create", trap: lid },
    { t: "template.create", template: guardians },
    { t: "encounter.start", entries: [{ id: "n1", tokenId: "thorn", value: 20 }, { id: "n2", tokenId: "goblin", value: 10 }] },
    { t: "encounter.next" },
  ] as Op[];
  return { initial, setup };
}

function tail(name: string, hex: boolean, moves: [Op, Viewer][]): Tail {
  const { initial, setup } = room(hex);
  let seq = 200;
  const ops: Stored[] = [...setup.map((op) => [op, DM] as [Op, Viewer]), ...moves].map(([op, who]) => ({ op, who, seq: seq++ }));
  return { name, initial, ops };
}

/** The rooms and their ops as the build before openings stores them. */
function tails(): Tail[] {
  const out: Tail[] = [];
  for (const hex of [false, true]) {
    const grid = hex ? "hexes" : "squares";
    out.push(
      tail(`Ana climbs Thorn up onto the snare in Spirit Guardians, walks off and back, and climbs down (${grid})`, hex, [
        [{ t: "token.climb", tokenId: "thorn", linkId: "l1" }, ANA],
        [{ t: "token.move", tokenId: "thorn", ...at(hex, 6, 3) }, ANA],
        [{ t: "token.move", tokenId: "thorn", ...at(hex, 3, 3) }, ANA],
        [{ t: "token.climb", tokenId: "thorn", linkId: "l2" }, ANA],
      ]),
      tail(`the DM takes the goblin up the ladder, onto the snare, and Moves it to Ground floor (${grid})`, hex, [
        [{ t: "token.climb", tokenId: "goblin", linkId: "l3" }, DM],
        [{ t: "token.move", tokenId: "goblin", ...at(hex, 4, 3) }, DM],
        [{ t: "token.update", tokenId: "goblin", patch: { sceneId: GROUND } }, DM],
      ]),
      tail(`Ana walks Thorn east over the pit, and the DM Moves Thorn onto the snare upstairs (${grid})`, hex, [
        [{ t: "token.move", tokenId: "thorn", ...at(hex, 8, 3) }, ANA],
        [{ t: "token.update", tokenId: "thorn", patch: { sceneId: UPPER } }, DM],
        [{ t: "token.move", tokenId: "thorn", ...at(hex, 6, 6) }, ANA],
      ]),
    );
  }
  return out;
}

/** One result as a hash: the state, the keys written, the trap marks and the undo, or the refusal. */
function resultHash(state: RoomState, s: Stored, opVersion: number | undefined): { hash: string; state: RoomState } {
  const r = applyOp(state, opSchema.parse(s.op), s.who, { seq: s.seq, at: AT, ...(opVersion !== undefined ? { opVersion } : {}) });
  if (!r.ok) return { hash: hash128(stableStringify({ refused: r.code, message: r.message })), state };
  const marks = { trapped: r.trapped ?? null, trapWrote: r.trapWrote ? [...r.trapWrote].sort() : null };
  return { hash: hash128(stableStringify({ state: r.state, touched: r.touched, global: r.global, marks, inverse: r.inverse })), state: r.state };
}

function replay(t: Tail, opVersion: number | undefined): string[] {
  let state = t.initial;
  return t.ops.map((s) => {
    const out = resultHash(state, s, opVersion);
    state = out.state;
    return out.hash;
  });
}

describe("stored ops of change formats 62 and 63 replay to what they made (OPENINGS_OP_VERSION)", () => {
  if (process.env.REPLAY_FLOORS4 === "write") {
    const fixture: Fixture = { tails: tails().map((t) => ({ ...t, hashes: Object.fromEntries(VERSIONS.map((v) => [String(v), replay(t, v)])) })) };
    writeFileSync(FIXTURE, `${JSON.stringify(fixture)}\n`);
  }
  const pinned = existsSync(FIXTURE) ? (JSON.parse(readFileSync(FIXTURE, "utf8")) as Fixture) : { tails: [] };

  test("every room's ops replay to the pinned results at each format", () => {
    assert.equal(pinned.tails.length, 6, "six rooms pinned");
    for (const t of pinned.tails) {
      for (const v of VERSIONS) assert.deepEqual(replay(t, v), t.hashes[String(v)], `${t.name} at ${v}`);
    }
  });

  test("each pinned room applies every op, and the climbs land on the snare in the area", () => {
    for (const t of pinned.tails) {
      let state = t.initial;
      for (const s of t.ops) {
        const r = applyOp(state, opSchema.parse(s.op), s.who, { seq: s.seq, at: AT, opVersion: 63 });
        assert.ok(r.ok, `${t.name}: ${s.op.t} ${r.ok ? "" : r.message}`);
        state = r.state;
      }
    }
    const climbed = pinned.tails[0]!;
    let state = climbed.initial;
    for (const s of climbed.ops.slice(0, 8)) state = (applyOp(state, opSchema.parse(s.op), s.who, { seq: s.seq, at: AT, opVersion: 63 }) as { state: RoomState }).state;
    assert.equal(state.tokens.thorn!.sceneId, UPPER, "Thorn stands on Upper floor's landing");
  });

  test("live, each op on the room as format 63 left it lands as at 63, except a climb an arrival meets", () => {
    // Each op reads the room its stored run left before it, so one op's arrival never changes what the next is asked on.
    const differs: string[] = [];
    for (const [i, t] of pinned.tails.entries()) {
      let state = t.initial;
      for (const [k, s] of t.ops.entries()) {
        const at63 = resultHash(state, s, 63);
        if (resultHash(state, s, undefined).hash !== at63.hash) differs.push(`${i}:${k}`);
        state = at63.state;
      }
    }
    // The first room's climb up, on squares and on hexes: the ops before it are its setup, seven of them.
    assert.deepEqual(differs, ["0:7", "3:7"]);
  });

  test("live, the climb onto the snare in Spirit Guardians springs the snare and reminds about Thorn", () => {
    for (const i of [0, 3]) {
      const t = pinned.tails[i]!;
      let state = t.initial;
      for (const s of t.ops.slice(0, 7)) state = resultHash(state, s, 63).state;
      const climb = t.ops[7]!;
      assert.equal(climb.op.t, "token.climb");
      const live = applyOp(state, opSchema.parse(climb.op), climb.who, { seq: climb.seq, at: AT });
      const old = applyOp(state, opSchema.parse(climb.op), climb.who, { seq: climb.seq, at: AT, opVersion: 63 });
      assert.ok(live.ok && old.ok);
      assert.equal(live.state.tokens.thorn!.sceneId, UPPER);
      assert.equal(live.state.traps.tu!.state, "sprung", `${t.name}: the snare goes off on the landing`);
      assert.equal(old.state.traps.tu!.state, "armed", `${t.name}: at 63 a climb sets off nothing`);
      const reminded = (log: readonly { data?: { type?: string; templateId?: string; tokenId?: string } }[]) => log.some((l) => l.data?.type === "area" && l.data.templateId === "sg" && l.data.tokenId === "thorn");
      assert.ok(reminded(live.log), `${t.name}: Spirit Guardians reminds about Thorn`);
      assert.ok(!reminded(old.log), `${t.name}: at 63 a climb reminds about nobody`);
    }
  });

  test("the pinned rooms are the rooms this file builds, so a change to the fixtures shows here", () => {
    assert.deepEqual(
      pinned.tails.map((t) => t.name),
      tails().map((t) => t.name),
    );
  });
});
