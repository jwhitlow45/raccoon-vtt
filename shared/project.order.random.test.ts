import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { ORDER_REVEALS, type OrderReveal, type RoomState, type Viewer } from "./model.ts";
import type { ActorTarget, EntryInput, Op, OpOf } from "./protocol.ts";
import { projectState } from "./project.ts";
import { applyOp } from "./reducer.ts";
import { DM, P1, P2, chance, character, env, int, pick, rng, room, token } from "./testutil.ts";

/**
 * Many random fights under the order setting (docs/design-v1-combat-flow.md
 * 11): Next, Previous, drags, new values, adds, removes, hides, ring and
 * setting changes, the DM's initiative rolls, open and secret, and fights
 * ended and started again. The test keeps its
 * own record of which rows have had their turn, from the acting row after
 * each op, with Previous taking back what its step showed, and checks after
 * every op:
 *
 * - each player's and a table display's order is exactly the rows the older
 *   rules give them (the same state under "Everyone") that the setting
 *   shows by that record, in turn order, numbered 0 to n-1;
 * - no other row's id, and no `hadTurn`, is anywhere in their snapshot;
 * - the DM holds every row, and the stored marks agree with the record;
 * - no initiative roll made while the record kept its creature's place from
 *   players ever reaches one, as a total or as a bare line.
 */

const DISPLAY: Viewer = { memberId: "display:abcdefghijkl", role: "player" };
const PLAYERS = [P1, P2, DISPLAY];

/** Creatures the fights draw from: the party's, an ally, goblins, a hidden one, and the DM's NPC character. */
function table(): RoomState {
  const state = room();
  state.characters.c1 = character("c1", { ownerIds: ["p1"], name: "Bree" });
  state.characters.npc = character("npc", { ownerIds: [], name: "Captain" });
  state.tokens.pc1 = token("pc1", { kind: "pc", actor: { ref: "c1" }, x: 1, y: 1 });
  state.tokens.comp = token("comp", { kind: "npc", name: "Owl", ownerIds: ["p1"], companion: { of: "c1", turn: "own" }, x: 2, y: 1 });
  state.tokens.lent = token("lent", { name: "Wolf", ownerIds: ["p2"], x: 3, y: 1 });
  state.tokens.ally = token("ally", { kind: "npc", name: "Guard", disposition: "ally", x: 4, y: 1 });
  for (let i = 1; i <= 4; i++) state.tokens[`g${i}`] = token(`g${i}`, { x: 4 + i, y: 2 });
  state.tokens.hid = token("hid", { visibility: "dm", x: 9, y: 1 });
  return state;
}

const CREATURES: ActorTarget[] = [
  ...["pc1", "comp", "lent", "ally", "g1", "g2", "g3", "g4", "hid"].map((tokenId) => ({ tokenId })),
  { characterId: "npc" },
];

/** What the test itself knows: the rows whose turn came, and what each Next found, for Previous. */
type Record_ = { turned: Set<string>; steps: Set<string>[] };

function shownByRecord(state: RoomState, record: Record_, id: string): boolean {
  const reveal: OrderReveal = state.meta.settings.playersSeeOrder ?? "all";
  if (reveal === "all" || record.turned.has(id) || state.encounter?.activeEntryId === id) return true;
  const row = state.encounter!.entries.find((e) => e.id === id)!;
  if (row.characterId === "npc" || row.label !== undefined) return false;
  const t = state.tokens[row.tokenId!]!;
  if (t.id === "pc1" || t.id === "comp" || t.id === "lent") return true;
  return reveal === "allies" && t.disposition === "ally";
}

function randomOp(r: () => number, state: RoomState, n: number): Op {
  const encounter = state.encounter;
  if (!encounter) {
    const chosen = CREATURES.filter(() => chance(r, 0.6));
    const rows: EntryInput[] = chosen.map((c, i) => ({ id: `n${n}-${i}`, ...c, value: int(r, 1, 20), ...(chance(r, 0.15) ? { hidden: true } : {}) }));
    if (chance(r, 0.2)) rows.push({ id: `n${n}-lair`, label: "Lair", value: 20 });
    return { t: "encounter.start", entries: rows.length > 0 ? rows : [{ id: `n${n}-0`, tokenId: "pc1", value: 10 }] };
  }
  const rows = encounter.entries;
  const anyRow = () => pick(r, rows).id;
  const roll = r();
  if (roll < 0.35) return { t: "encounter.next" };
  if (roll < 0.45) return state.encounterHistory.length > 0 ? { t: "encounter.prev" } : { t: "encounter.next" };
  if (roll < 0.5) {
    const shuffled = [...rows].sort(() => r() - 0.5).map((e) => e.id);
    return { t: "encounter.reorder", entryIds: shuffled };
  }
  if (roll < 0.58) return { t: "encounter.setValue", entryId: anyRow(), value: int(r, 1, 20) };
  if (roll < 0.66) {
    const free = CREATURES.filter((c) => !rows.some((e) => ("tokenId" in c ? e.tokenId === c.tokenId : e.characterId === c.characterId)));
    return free.length > 0 ? { t: "encounter.add", entries: [{ id: `n${n}`, ...pick(r, free), value: int(r, 1, 20) }] } : { t: "encounter.next" };
  }
  if (roll < 0.72) return rows.length > 1 ? { t: "encounter.remove", entryIds: [anyRow()] } : { t: "encounter.next" };
  if (roll < 0.78) return { t: "encounter.update", entryId: anyRow(), patch: { hidden: chance(r, 0.4) } };
  if (roll < 0.84) return { t: "token.update", tokenId: pick(r, ["ally", "g1", "g2", "lent"]), patch: { disposition: pick(r, ["ally", "neutral", "hostile"] as const) } };
  if (roll < 0.88) return { t: "room.update", settings: { playersSeeOrder: pick(r, ORDER_REVEALS) } };
  if (roll < 0.92) {
    const creature = pick(r, CREATURES);
    const asked: OpOf<"dice.roll"> = { t: "dice.roll", tag: `0192f0a8-6c1e-7a4b-9c3d-${String(n).padStart(12, "0")}`, to: pick(r, ["all", "dm"] as const), rolls: [{ formula: "1d20+2", label: "Initiative", creature, initiative: true }] };
    return { t: "sys.dice", asked, batch: "AbCdEfGhIjKlMnOp", results: [{ formula: "1d20+2", faces: [int(r, 1, 20)], total: 0 }] };
  }
  if (roll < 0.96) return { t: "token.update", tokenId: "hid", patch: { visibility: pick(r, ["all", "dm"] as const) } };
  return { t: "encounter.end" };
}

/** The record after an op that applied. */
function follow(record: Record_, after: RoomState, op: Op): Record_ {
  if (op.t === "encounter.end") return { turned: new Set(), steps: [] };
  if (op.t === "encounter.start") return { turned: new Set(), steps: [] };
  let next = record;
  // Each Next the DM makes saves a step, the last 20 kept (MAX_HISTORY).
  if (op.t === "encounter.next") {
    next = { turned: new Set(record.turned), steps: [...record.steps, new Set(record.turned)].slice(-20) };
  } else if (op.t === "encounter.prev") {
    const steps = [...record.steps];
    next = { turned: steps.pop() ?? new Set(), steps };
  }
  const active = after.encounter?.activeEntryId;
  if (active && !next.turned.has(active)) next = { ...next, turned: new Set([...next.turned, active]) };
  return next;
}

/** How often the setting kept a row out, and how often a row showed only because its turn had come, so the run is known to reach both. */
const seen = { withheld: 0, revealed: 0 };

/** Whether the record keeps a creature's place from players now: what the DM's initiative roll for it must not tell them. */
function placeSecret(state: RoomState, record: Record_, creature: ActorTarget): boolean {
  const reveal = state.meta.settings.playersSeeOrder ?? "all";
  if (reveal === "all") return false;
  if ("characterId" in creature) {
    if (creature.characterId === "c1") return false;
  } else {
    if (["pc1", "comp", "lent"].includes(creature.tokenId)) return false;
    if (reveal === "allies" && state.tokens[creature.tokenId]!.disposition === "ally") return false;
  }
  const rows = state.encounter?.entries ?? [];
  const its = rows.filter((e) => ("tokenId" in creature ? e.tokenId === creature.tokenId : e.characterId === creature.characterId));
  return !its.some((e) => record.turned.has(e.id) || state.encounter!.activeEntryId === e.id);
}

/** The ids of this run's initiative lines written while their creature's place was secret, and how many all runs wrote. */
const secretLines = new Set<string>();
let secretRolls = 0;

function check(state: RoomState, record: Record_, label: string): void {
  for (const viewer of PLAYERS) {
    const leaked = projectState(state, viewer, { sceneId: "s1" }).log.filter((l) => secretLines.has(l.id));
    assert.deepEqual(leaked, [], `${label}: a secret initiative roll reaches ${viewer.memberId}`);
  }
  const encounter = state.encounter;
  const dm = projectState(state, DM, { sceneId: "s1" }).encounter;
  assert.deepEqual(dm?.entries.map((e) => e.id) ?? [], encounter?.entries.map((e) => e.id) ?? [], `${label}: the DM holds every row`);
  if (!encounter) return;
  for (const e of encounter.entries) assert.equal(e.hadTurn === true, record.turned.has(e.id), `${label}: ${e.id}'s mark`);
  const everyone: RoomState = { ...state, meta: { ...state.meta, settings: { ...state.meta.settings, playersSeeOrder: "all" } } };
  for (const viewer of PLAYERS) {
    const snapshot = projectState(state, viewer, { sceneId: "s1" });
    const older = projectState(everyone, viewer, { sceneId: "s1" }).encounter!.entries.map((e) => e.id);
    const want = older.filter((id) => shownByRecord(state, record, id));
    if (want.length < older.length) seen.withheld++;
    if (state.meta.settings.playersSeeOrder !== "all" && want.some((id) => record.turned.has(id) && id !== encounter.activeEntryId && !shownByRecord({ ...state, encounter: { ...encounter, activeEntryId: null } }, { turned: new Set(), steps: [] }, id))) seen.revealed++;
    const got = snapshot.encounter!.entries;
    assert.deepEqual(got.map((e) => e.id), want, `${label}: ${viewer.memberId}'s order`);
    assert.deepEqual(got.map((e) => e.tieOrder), want.map((_, i) => i), `${label}: numbered without gaps`);
    assert.ok(got.every((e) => !("hadTurn" in e)), `${label}: no marks`);
    const active = snapshot.encounter!.activeEntryId;
    assert.ok(active === null || want.includes(active), `${label}: the acting row is one they hold`);
    const text = JSON.stringify(snapshot);
    for (const e of encounter.entries) if (!want.includes(e.id)) assert.ok(!text.includes(`"${e.id}"`), `${label}: ${e.id} reaches ${viewer.memberId}`);
  }
}

describe("the order setting over random fights (docs/design-v1-combat-flow.md 11)", () => {
  test("no player ever receives a row the setting hides, and every row it shows is there", () => {
    for (let s = 1; s <= 100; s++) {
      const r = rng(s);
      let state = table();
      state.meta.settings.playersSeeOrder = pick(r, ORDER_REVEALS);
      state.meta.settings.revealHiddenOnTurn = chance(r, 0.6);
      state.meta.settings.skipDefeated = chance(r, 0.5);
      let record: Record_ = { turned: new Set(), steps: [] };
      secretLines.clear();
      for (let n = 1; n <= 60; n++) {
        const op = randomOp(r, state, n);
        const result = applyOp(state, op, DM, env(n));
        if (!result.ok) continue;
        if (op.t === "sys.dice" && op.asked.t === "dice.roll" && placeSecret(state, record, op.asked.rolls[0]!.creature!)) {
          secretLines.add(result.state.log.at(-1)!.id);
          secretRolls++;
        }
        record = follow(record, result.state, op);
        state = result.state;
        check(state, record, `seed ${s}, op ${n} (${op.t})`);
      }
    }
    assert.ok(seen.withheld > 1000 && seen.revealed > 1000, `withheld ${seen.withheld}, revealed ${seen.revealed}`);
    assert.ok(secretRolls > 50, `${secretRolls} secret rolls`);
  });
});
