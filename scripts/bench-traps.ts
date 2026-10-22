/**
 * Traps' worst cases on the server (docs/design-v1-traps.md section 9),
 * each at a scene's 50 traps, alone, with every spot over armed squares,
 * and gated:
 *
 * - A 500-token group on a 300-square route: one public Gargantuan holder
 *   carrying 499 hidden passengers, each walking its own offset route in
 *   the private pass, about 300,000 spots, at 40 ms.
 * - A `token.moveMany` of 100 Gargantuan walkers carrying 400 more in the
 *   open, each on a straight leg of 199 squares, about 199,000 spots, at
 *   25 ms.
 * - An `encounter.next` springing all 50 traps twice, at the turn that
 *   ends and, after the `nextTurn` reset, at the turn that starts, with
 *   500 tokens in the room, at 15 ms.
 *
 * The first two time the trap step's plan of the move (`planTrapMove`):
 * the walks, both passes and every springing's frozen hits. The third
 * times the whole op, which walks nothing. Each also reports the whole op
 * for the record. The traps stop nothing, so every walk runs to its end.
 * The walkers fly, and 49 of the traps take only creatures on the floor,
 * so none of those ever goes off and every spot reads its squares and its
 * ground to the end, the most a walk can cost. The 50th takes fliers too
 * and lies near where the walks end, so it goes off late, its hits read at
 * a moment of 500 tokens.
 *
 * Run it alone on the machine being measured, since parallel load skews it:
 *
 *   node scripts/bench-traps.ts
 *
 * It exits 1 when a gate fails.
 */
import type { RoomState, Token, Trap } from "../shared/model.ts";
import type { Op } from "../shared/protocol.ts";
import { applyOp } from "../shared/reducer.ts";
import { planTrapMove, type TrapRoom } from "../shared/rules/traps.ts";
import { actor, room, token } from "../shared/testutil.ts";

type Ms = { median: number; max: number };

const DM = { memberId: "dm1", role: "dm" as const };
const ENV = { seq: 1000, at: "2026-10-22T20:00:00.000Z" };

function stats(times: number[]): Ms {
  const sorted = [...times].sort((a, b) => a - b);
  return { median: sorted[Math.floor(sorted.length / 2)]!, max: sorted[sorted.length - 1]! };
}

/** The same room with fresh records, so nothing cached per record (the trap index, the children index) carries over. */
function fresh(state: RoomState): RoomState {
  return { ...state, tokens: { ...state.tokens }, traps: { ...state.traps } };
}

function time(runs: number, state: RoomState, body: (state: RoomState) => unknown): Ms {
  const times: number[] = [];
  for (let r = 0; r < runs + 3; r++) {
    const s = fresh(state);
    const t = performance.now();
    body(s);
    // The first runs warm the engine up.
    if (r >= 3) times.push(performance.now() - t);
  }
  return stats(times);
}

/** A scene's traps, each 400 squares in a 20 by 20 square, overlapping so that every square of the band is armed, none stopping a creature. */
function traps(band: { x0: number; y0: number; columns: number; rows: number }, rig: Partial<NonNullable<Trap["rig"]>> = {}, count = 50): Record<string, Trap> {
  const out: Record<string, Trap> = {};
  for (let i = 0; i < count; i++) {
    const x = band.x0 + (i % band.columns) * 4;
    const y = band.y0 + Math.floor(i / band.columns) * 4 * (band.rows > 1 ? 1 : 0);
    out[`trap${String(i).padStart(2, "0")}`] = {
      id: `trap${String(i).padStart(2, "0")}`,
      rev: 0,
      sceneId: "s1",
      name: `Plate ${i}`,
      zone: { cells: [{ x, y, w: 20, h: 20 }] },
      state: "armed",
      found: false,
      rig: { on: ["enter"], who: "any", floor: true, resets: "never", stops: false, foundOnSpring: true, hits: "zone", actions: [], find: [], notice: false, message: "Click.", damage: [{ formula: "1d6", type: "piercing" }], ...rig },
    };
  }
  return out;
}

/** The 50th trap: 20 by 20 squares near where the walks end, taking fliers too, so it goes off late. */
function lastTrap(at: { x: number; y: number }): Record<string, Trap> {
  const t = traps({ x0: at.x, y0: at.y, columns: 1, rows: 1 }, { floor: false }, 1).trap00!;
  return { trap49: { ...t, id: "trap49", name: "Plate 49" } };
}

/** A flying Gargantuan holder at 2,2 carrying 499 hidden tokens, a route of 300 squares in six pieces back and forth over a band of armed squares. */
function groupRoom(): { state: RoomState; op: Op } {
  const state = room();
  state.scenes.s1 = { ...state.scenes.s1!, bounds: { w: 140, h: 60 } };
  state.tokens.h = token("h", { name: "Roc", kind: "npc", size: "gargantuan", x: 2, y: 2, elevation: 30, actor: { inline: actor({ speeds: { walk: 2000, fly: 2000 } }) } });
  for (let i = 0; i < 499; i++) {
    state.tokens[`p${i}`] = token(`p${i}`, { name: `Passenger ${i}`, size: "tiny", visibility: "dm", x: 2 + (i % 8) * 0.5, y: 2 + (Math.floor(i / 8) % 8) * 0.5, elevation: 30, attached: { to: "h", kind: "carry" } }) as Token;
  }
  state.traps = { ...traps({ x0: 0, y0: 0, columns: 25, rows: 2 }, {}, 49), ...lastTrap({ x: 92, y: 12 }) };
  // 96 east, 4 south, 96 west, 4 south, 96 east, 4 south: 300 squares.
  const route: [number, number, number, 0 | 1][] = [
    [98, 2, 0, 0],
    [98, 6, 0, 0],
    [2, 6, 0, 0],
    [2, 10, 0, 0],
    [98, 10, 0, 0],
    [98, 14, 0, 0],
  ];
  return { state, op: { t: "token.move", tokenId: "h", x: 98, y: 14, route } };
}

/** 100 flying Gargantuan walkers in a 20-row band, each carrying 4 tokens in the open, each flying 199 squares east over armed squares. */
function manyRoom(): { state: RoomState; op: Op } {
  const state = room();
  state.scenes.s1 = { ...state.scenes.s1!, bounds: { w: 220, h: 30 } };
  const moves: { tokenId: string; x: number; y: number }[] = [];
  for (let i = 0; i < 100; i++) {
    const y = (i % 5) * 4;
    state.tokens[`w${i}`] = token(`w${i}`, { name: `Walker ${i}`, kind: "npc", size: "gargantuan", x: 0, y, elevation: 30, actor: { inline: actor({ speeds: { walk: 2000, fly: 2000 } }) } });
    for (let k = 0; k < 4; k++) state.tokens[`w${i}c${k}`] = token(`w${i}c${k}`, { name: `Pack ${i}.${k}`, size: "tiny", x: k, y, elevation: 30, attached: { to: `w${i}`, kind: "carry" } }) as Token;
    moves.push({ tokenId: `w${i}`, x: 199, y });
  }
  state.traps = { ...traps({ x0: 0, y0: 0, columns: 50, rows: 1 }, {}, 49), ...lastTrap({ x: 196, y: 0 }) };
  return { state, op: { t: "token.moveMany", moves } };
}

/** 500 tokens, two in a fight standing on all 50 traps, each going off at a turn's end and start and arming again for the next. */
function turnRoom(): { state: RoomState; op: Op } {
  const state = room();
  state.scenes.s1 = { ...state.scenes.s1!, bounds: { w: 120, h: 120 } };
  state.tokens.a = token("a", { name: "Thorn", kind: "pc", ownerIds: ["p1"], x: 10, y: 10 });
  state.tokens.b = token("b", { name: "Goblin", x: 11, y: 10 });
  for (let i = 0; Object.keys(state.tokens).length < 500; i++) state.tokens[`t${i}`] = token(`t${i}`, { name: `Goblin ${i}`, x: 40 + (i % 60), y: 40 + Math.floor(i / 60) });
  const all = traps({ x0: 0, y0: 0, columns: 1, rows: 1 }, { on: ["turnStart", "turnEnd"], resets: "nextTurn" });
  // All 50 on the same squares under both creatures.
  for (const t of Object.values(all)) t.zone = { cells: [{ x: 0, y: 0, w: 20, h: 20 }] };
  state.traps = all;
  state.encounter = {
    rev: 0,
    round: 1,
    activeEntryId: "e1",
    entries: [
      { id: "e1", tokenId: "a", value: 20, order: 0 } as never,
      { id: "e2", tokenId: "b", value: 10, order: 1 } as never,
    ],
  };
  return { state, op: { t: "encounter.next" } };
}

type Row = { row: string; ms: Ms; gate?: number };

export function runTrapRows(runs = 15): Row[] {
  const rows: Row[] = [];
  const group = groupRoom();
  const many = manyRoom();
  const turn = turnRoom();
  const plan = (op: Op) => (s: RoomState) => planTrapMove(op, s as TrapRoom, DM, {});
  const apply = (op: Op) => (s: RoomState) => {
    const r = applyOp(s, op, DM, ENV);
    if (!r.ok) throw new Error(`${op.t}: ${r.message}`);
    return r;
  };
  const sprung = (s: RoomState, op: Op) => planTrapMove(op, s as TrapRoom, DM, {}).springings.length;
  const groupSprung = sprung(fresh(group.state), group.op);
  const manySprung = sprung(fresh(many.state), many.op);
  rows.push({ row: `500-token group, 300-square route, plan (${groupSprung} springings)`, ms: time(runs, group.state, plan(group.op)), gate: 40 });
  rows.push({ row: "500-token group, 300-square route, whole op", ms: time(runs, group.state, apply(group.op)) });
  rows.push({ row: `500-walker token.moveMany, plan (${manySprung} springings)`, ms: time(runs, many.state, plan(many.op)), gate: 25 });
  rows.push({ row: "500-walker token.moveMany, whole op", ms: time(runs, many.state, apply(many.op)) });
  rows.push({ row: "encounter.next, 50 traps going off twice, whole op", ms: time(runs, turn.state, apply(turn.op)), gate: 15 });
  return rows;
}

export function formatTrapRows(rows: readonly Row[]): string {
  const lines = ["50 traps, every spot over armed squares | ms (median / max) | gate", "--- | --- | ---"];
  for (const r of rows) lines.push(`${r.row} | ${r.ms.median.toFixed(2)} / ${r.ms.max.toFixed(2)} | ${r.gate === undefined ? "" : `${r.gate}${r.ms.median <= r.gate ? " pass" : " FAIL"}`}`);
  return lines.join("\n");
}

const argv = (globalThis as { process?: { argv?: string[]; exitCode?: number } }).process;
if (argv?.argv?.[1] && import.meta.url.endsWith(argv.argv[1].replace(/^.*scripts\//, "scripts/"))) {
  const rows = runTrapRows();
  console.log(formatTrapRows(rows));
  if (rows.some((r) => r.gate !== undefined && r.ms.median > r.gate)) argv.exitCode = 1;
}
