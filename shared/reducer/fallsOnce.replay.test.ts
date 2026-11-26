import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { describe, test } from "node:test";
import { ANA, ATTIC, GROUND, UPPER, putOpeningOp, thornToken, tower, trapdoor, withOpening, withTrapdoor } from "../floorLinksTestutil.ts";
import type { FallRecord, RoomState, Token, Viewer } from "../model.ts";
import { hash128, stableStringify } from "../project.ts";
import { opSchema, type Op, type RestoreEntry } from "../protocol.ts";
import { applyOp, type Applied } from "../reducer.ts";
import { AT, DM, actor, character, token } from "../testutil.ts";

/*
 * Stored ops of change formats 64 to 66 replay to what they made
 * (docs/design/design-v1-floors.md phase 4), whatever change format 67
 * (migrate.ts fallsOnce) changes: two tokens of one character that fall in
 * one op made a card each, and a player's undo of a fall removed its
 * record's card whole. The rooms: an opening placed under both of Shade's
 * tokens, a trapdoor dropping both, both dropped from the Attic onto the
 * opening below, a horse carrying one while the other falls alone, Ana's
 * group move of both of Thorn's tokens onto the hole with the server's
 * undo and redo, and Ana's horse falling with a hidden rider that the
 * undo leaves below. The fixture holds each room and its ops as stored,
 * the undo and redo built from the stored run as the server built them,
 * and a hash of every result at each format. Write it again with
 * REPLAY_FALLS_ONCE=write only from the build the stored ops were written
 * by.
 */

const FIXTURE = new URL("./fallsOnce.replay.fixture.json", import.meta.url);
const VERSIONS = [64, 65, 66] as const;
const BUILT_AT = 66;

type Stored = { op: Op; who: Viewer; seq: number };
type Chain = { name: string; initial: RoomState; ops: Stored[] };
type Fixture = { chains: (Chain & { hashes: Record<string, string[]> })[] };

/** Shade, the DM's character, and Thorn, Ana's. */
function room(tokens: Token[], over: Partial<RoomState> = {}): RoomState {
  const base = tower({ tokens: Object.fromEntries(tokens.map((t) => [t.id, t])), ...over });
  return { ...base, characters: { ...base.characters, shade: character("shade", { name: "Shade", ownerIds: [], actor: actor({ speeds: { walk: 30 } }) }) } };
}

const shade = (id: string, over: Partial<Token>): Token => token(id, { kind: "pc", name: "Shade", ownerIds: [], actor: { ref: "shade" }, sceneId: UPPER, ...over });
const up = (id: string, over: Partial<Token>): Token => token(id, { sceneId: UPPER, name: id, ...over });

/** A step of the chain: a stored op, or one the server built from the stored run so far. */
type Make = (run: { ops: readonly Stored[]; history: readonly Applied[]; states: readonly RoomState[] }) => [Op, Viewer];

/** A player's undo of the step `at`, as the server built one: the step's token entries less `left`, and its fall records. */
function undoOf(at: number, left: readonly string[] = []): Make {
  return ({ history }) => {
    const r = history[at]!;
    const entries = (r.inverse ?? []).filter((e) => e.key.startsWith("token:") && !left.includes(e.key.slice("token:".length)));
    return [{ t: "sys.restore", from: "undo", entries, deps: true, ...(r.falls ? { falls: r.falls } : {}) } as Op, ANA];
  };
}

/** The redo of the undo `at`, as the server built one at 66: each record carrying the card the undo removed. */
function redoOf(at: number): Make {
  return ({ ops, history, states }) => {
    const r = history[at]!;
    const before = states[at]!;
    const undone = ops[at]!.op as Op & { falls?: FallRecord[] };
    const falls = (undone.falls ?? []).map((f) => {
      const card = before.falls?.[f.fallId];
      return card && r.state.falls?.[f.fallId] === undefined ? { ...f, card } : f;
    });
    const entries: RestoreEntry[] = (r.inverse ?? []).filter((e) => e.key.startsWith("token:"));
    return [{ t: "sys.restore", from: "redo", entries, deps: true, ...(falls.length > 0 ? { falls } : {}) } as Op, ANA];
  };
}

/** The rooms and their ops as the build at change format 66 stored them, its undo and redo built from its own run. */
function chains(): Chain[] {
  const anyMove = (s: RoomState): RoomState => ({ ...s, meta: { ...s.meta, settings: { ...s.meta.settings, playersMoveAny: "all" as const } } });
  const specs: { name: string; initial: RoomState; steps: (Make | [Op, Viewer])[] }[] = [
    {
      name: "the DM places an opening under both of Shade's tokens",
      initial: room([shade("shade1", { x: 6, y: 6 }), shade("shade2", { x: 7, y: 7 })]),
      steps: [[putOpeningOp(), DM]],
    },
    {
      name: "the DM places an opening under both of Shade's tokens and Thorn",
      initial: room([shade("shade1", { x: 6, y: 6 }), shade("shade2", { x: 7, y: 7 }), thornToken({ sceneId: UPPER, x: 7, y: 6 })]),
      steps: [[putOpeningOp(), DM]],
    },
    {
      name: "a trapdoor drops both of Shade's tokens and a goblin",
      initial: withTrapdoor(room([shade("shade1", { x: 10, y: 10 }), shade("shade2", { x: 11, y: 11 }), up("goblin", { x: 10, y: 11 })])),
      steps: [[{ t: "trap.spring", trapId: "td1", tokenIds: ["goblin", "shade1", "shade2"] }, DM]],
    },
    {
      name: "a trapdoor on the Attic drops both of Shade's tokens onto the opening below, and both fall on",
      initial: withTrapdoor(withOpening(room([shade("shade1", { sceneId: ATTIC, x: 6, y: 6 }), shade("shade2", { sceneId: ATTIC, x: 7, y: 7 })])), trapdoor("td1", { sceneId: ATTIC, zone: { cells: [{ x: 6, y: 6, w: 2, h: 2 }] } })),
      steps: [[{ t: "trap.spring", trapId: "td1", tokenIds: ["shade1", "shade2"] }, DM]],
    },
    {
      name: "a horse carrying one of Shade's tokens falls while the other falls alone",
      initial: withOpening(room([up("horse", { size: "large", x: 2, y: 6 }), shade("shade1", { x: 2, y: 6, attached: { to: "horse", kind: "ride" } }), shade("shade2", { x: 6, y: 9 })]), { rect: { x: 6, y: 6, w: 4, h: 4 } }),
      steps: [[{ t: "token.moveMany", moves: [{ tokenId: "horse", x: 6, y: 6 }, { tokenId: "shade2", x: 8, y: 8 }] }, DM]],
    },
    {
      name: "Ana walks both of Thorn's tokens onto the hole in one group move, undoes it and redoes it",
      initial: withOpening(room([thornToken({ sceneId: UPPER, x: 6, y: 4 }), thornToken({ id: "thorn2", sceneId: UPPER, x: 7, y: 4 })])),
      steps: [[{ t: "token.moveMany", moves: [{ tokenId: "thorn", x: 6, y: 6 }, { tokenId: "thorn2", x: 7, y: 7 }] }, ANA], undoOf(0), redoOf(1)],
    },
    {
      name: "Ana's horse falls with a hidden rider, and her undo takes the horse back up and leaves the rider below, then her redo",
      initial: anyMove(withOpening(room([up("horse", { size: "large", ownerIds: ["p1"], x: 2, y: 6 }), up("goblin", { x: 2, y: 6, visibility: "dm", attached: { to: "horse", kind: "ride" } })], { openFloors: { [UPPER]: { sceneId: UPPER, rev: 1 } } }))),
      steps: [[{ t: "token.move", tokenId: "horse", x: 6, y: 6 }, ANA], undoOf(0, ["goblin"]), redoOf(1)],
    },
  ];
  return specs.map((spec) => {
    let state = spec.initial;
    let seq = 300;
    const history: Applied[] = [];
    const states: RoomState[] = [];
    const ops: Stored[] = [];
    for (const make of spec.steps) {
      const [op, who] = typeof make === "function" ? make({ ops, history, states }) : make;
      const s: Stored = { op, who, seq: seq++ };
      ops.push(s);
      const r = applyOp(state, opSchema.parse(op), who, { seq: s.seq, at: AT, opVersion: BUILT_AT });
      assert.ok(r.ok, `${spec.name}: ${op.t} ${r.ok ? "" : r.message}`);
      states.push(state);
      history.push(r);
      state = r.state;
    }
    return { name: spec.name, initial: spec.initial, ops };
  });
}

/** One result as a hash: the state, the keys written, the fall records and the undo, or the refusal. */
function resultHash(state: RoomState, s: Stored, opVersion: number | undefined): { hash: string; state: RoomState } {
  const r = applyOp(state, opSchema.parse(s.op), s.who, { seq: s.seq, at: AT, ...(opVersion !== undefined ? { opVersion } : {}) });
  if (!r.ok) return { hash: hash128(stableStringify({ refused: r.code, message: r.message })), state };
  return { hash: hash128(stableStringify({ state: r.state, touched: r.touched, falls: r.falls ?? null, inverse: r.inverse })), state: r.state };
}

function replay(c: Chain, opVersion: number | undefined): string[] {
  let state = c.initial;
  return c.ops.map((s) => {
    const out = resultHash(state, s, opVersion);
    state = out.state;
    return out.hash;
  });
}

describe("stored ops of change formats 64 to 66 replay to what they made (fallsOnce)", () => {
  if (process.env.REPLAY_FALLS_ONCE === "write") {
    const fixture: Fixture = { chains: chains().map((c) => ({ ...c, hashes: Object.fromEntries(VERSIONS.map((v) => [String(v), replay(c, v)])) })) };
    writeFileSync(FIXTURE, `${JSON.stringify(fixture)}\n`);
  }
  const pinned = existsSync(FIXTURE) ? (JSON.parse(readFileSync(FIXTURE, "utf8")) as Fixture) : { chains: [] };

  test("every room's ops replay to the pinned results at each format", () => {
    assert.equal(pinned.chains.length, 7, "seven rooms pinned");
    for (const c of pinned.chains) for (const v of VERSIONS) assert.deepEqual(replay(c, v), c.hashes[String(v)], `${c.name} at ${v}`);
  });

  test("at 66 each of Shade's or Thorn's tokens that fell has a card of its own, and the undo removed its record's card whole", () => {
    const cardsAfter = (c: Chain, k: number) => {
      let state = c.initial;
      for (const s of c.ops.slice(0, k + 1)) state = resultHash(state, s, 66).state;
      return Object.values(state.falls ?? {}).map((f) => [f.tokenId, ...(f.riders ?? [])].join(" "));
    };
    const [put, , trap, attic, horse, group, rider] = pinned.chains;
    assert.deepEqual(cardsAfter(put!, 0).sort(), ["shade1", "shade2"]);
    assert.equal(cardsAfter(trap!, 0).length, 3);
    assert.equal(cardsAfter(attic!, 0).length, 4);
    assert.deepEqual(cardsAfter(horse!, 0).sort(), ["horse shade1", "shade2"]);
    assert.deepEqual([cardsAfter(group!, 0).length, cardsAfter(group!, 1).length, cardsAfter(group!, 2).length], [2, 0, 2]);
    assert.deepEqual([cardsAfter(rider!, 0), cardsAfter(rider!, 1)], [["horse goblin"], []]);
  });

  test("the pinned rooms are the rooms this file builds, so a change to the fixtures shows here", () => {
    assert.deepEqual(
      pinned.chains.map((c) => c.name),
      chains().map((c) => c.name),
    );
  });
});
