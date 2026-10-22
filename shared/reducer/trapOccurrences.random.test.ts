import assert from "node:assert/strict";
import { test } from "node:test";
import { LIMITS } from "../limits.ts";
import type { RoomState, Token, Trap, TrapRig, Viewer } from "../model.ts";
import { canApply } from "../permissions.ts";
import type { Op, RestoreEntry } from "../protocol.ts";
import { applyOp } from "../reducer.ts";
import { DM, P1, chance, env, int, pick, rng, room, token } from "../testutil.ts";

/**
 * Trap occurrences over many random sequences (docs/design-v1-traps.md 11,
 * "The occurrence state machine, randomized"): springings public (Thorn's
 * walks) and private (the player's hidden imp, the DM's hidden goblin),
 * Apply from two DM devices that may hold a stale view, Dismiss, Mark
 * sprung, Do its effects, a lost answer sent again under the same op, Set
 * it off, re-arming, and the DM's undo and redo. The invariants, checked
 * after every step:
 *
 * 1. An occurrence is applied at most once, and its actions run at most once.
 * 2. It is never both applied and dismissed.
 * 3. At most 3 a trap and 10 a room, each id once.
 * 4. One no longer waiting (applied, dismissed or dropped) never applies.
 * 5. An undone Apply brings its occurrence back exactly once.
 */

const SEEDS = 600;
const STEPS = 40;

function rig(overrides: Partial<TrapRig>): TrapRig {
  return { on: ["enter"], who: "any", floor: true, resets: "nextTurn", stops: false, foundOnSpring: true, hits: "trigger", actions: [], find: [], notice: false, message: "Click.", damage: [{ formula: "1d6", type: "fire" }], ...overrides };
}

function trap(id: string, x: number, overrides: Partial<TrapRig> = {}): Trap {
  return { id, rev: 0, sceneId: "s1", name: id, zone: { cells: [{ x, y: 5, w: 1, h: 3 }] }, state: "armed", found: false, rig: rig(overrides) };
}

function world(): RoomState {
  const tokens: Record<string, Token> = {
    thorn: token("thorn", { name: "Thorn", kind: "pc", ownerIds: ["p1"], x: 0, y: 5 }),
    imp: token("imp", { name: "Imp", kind: "npc", ownerIds: ["p1"], visibility: "dm", x: 0, y: 6 }),
    gob: token("gob", { name: "Goblin", visibility: "dm", x: 0, y: 7 }),
  };
  // Four traps of three occurrences each can pass the room's ten.
  const traps = { a: trap("a", 3), b: trap("b", 6, { stops: true }), c: trap("c", 9, { usesLeft: 5, conditions: ["prone"] }), d: trap("d", 1, { actions: [{ show: { tokenId: "gob" } }] }) };
  return room({ tokens, traps });
}

type Kind = "apply" | "dismiss" | "sprung" | "act" | "other";
type Done = { kind: Kind; due?: string; inverse: RestoreEntry[] };

function dues(state: RoomState): { trap: string; id: string; acted: boolean }[] {
  return Object.values(state.traps).flatMap((t) => (t.rig?.due ?? []).map((d) => ({ trap: t.id, id: d.id, acted: d.acted === true })));
}

test("trap occurrences: applied and acted at most once, never both applied and dismissed, within their caps, through undo and redo", () => {
  let steps = 0;
  let applies = 0;
  let undoneApplies = 0;
  let fullRooms = 0;
  for (let seed = 1; seed <= SEEDS; seed++) {
    const r = rng(seed);
    let state = world();
    let seq = 10;
    // Two DM devices, each holding the room as it last heard it.
    const views: RoomState[] = [state, state];
    const applied = new Set<string>();
    const dismissed = new Set<string>();
    const actions = new Map<string, number>();
    const undo: Done[] = [];
    const redo: Done[] = [];
    let last: { op: Op; who: Viewer } | null = null;

    const run = (op: Op, who: Viewer): { ok: true; state: RoomState; inverse: RestoreEntry[] | null } | null => {
      if (!canApply(op, who, state, { canUseAsset: () => true }).ok) return null;
      const res = applyOp(state, op, who, env(seq++));
      if (!res.ok) return null;
      return { ok: true, state: res.state, inverse: res.inverse };
    };
    const where = (n: number, note: string) => `seed ${seed} step ${n} (${note})`;

    for (let n = 0; n < STEPS; n++) {
      const before = state;
      const waiting = new Set(dues(before).map((d) => d.id));
      const view = views[int(r, 0, 1)]!;
      const known = dues(view);
      const someDue = known.length > 0 && chance(r, 0.9) ? pick(r, known) : { trap: pick(r, ["a", "b", "c", "d"]), id: `${int(r, 1, 99)}:0`, acted: false };
      const choice = int(r, 0, 12);
      let op: Op;
      let who: Viewer = DM;
      let kind: Kind = "other";
      if (choice <= 1) {
        who = P1;
        op = { t: "token.move", tokenId: "thorn", x: int(r, 0, 11), y: 5 };
      } else if (choice === 2) {
        who = P1;
        op = { t: "token.moveMany", moves: [{ tokenId: "imp", x: int(r, 0, 11), y: 6 }] };
      } else if (choice === 3) {
        op = { t: "token.move", tokenId: "gob", x: int(r, 0, 11), y: 7 };
      } else if (choice <= 5) {
        op = { t: "actor.outcome", plan: `p${n}`, trap: { trapId: someDue.trap, due: someDue.id }, targets: [{ target: { tokenId: "thorn" }, amount: 1 }] };
        kind = "apply";
      } else if (choice === 6) {
        op = { t: "trap.settle", trapId: someDue.trap, due: someDue.id, ...(chance(r, 0.5) ? { sprung: true as const } : {}) };
        kind = op.sprung ? "sprung" : "dismiss";
      } else if (choice === 7) {
        op = { t: "trap.act", trapId: someDue.trap, due: someDue.id };
        kind = "act";
      } else if (choice === 8 && last) {
        // A lost answer: the same op sent again.
        op = last.op;
        who = last.who;
        kind = op.t === "actor.outcome" ? "apply" : op.t === "trap.settle" ? (op.sprung ? "sprung" : "dismiss") : op.t === "trap.act" ? "act" : "other";
      } else if (choice === 9 && undo.length > 0) {
        const done = undo.pop()!;
        const res = run({ t: "sys.restore", entries: done.inverse, from: "undo", deps: true }, DM);
        if (res) {
          state = res.state;
          if (done.kind === "apply") {
            applied.delete(done.due!);
            undoneApplies++;
            assert.equal(dues(state).filter((d) => d.id === done.due).length, 1, where(n, "an undone Apply brings its occurrence back once"));
          }
          if (done.kind === "dismiss" || done.kind === "sprung") dismissed.delete(done.due!);
          if (done.kind === "act") actions.set(done.due!, (actions.get(done.due!) ?? 1) - 1);
          if (res.inverse) redo.push({ ...done, inverse: res.inverse });
        }
        check(state, n, "undo");
        continue;
      } else if (choice === 10 && redo.length > 0) {
        const done = redo.pop()!;
        const res = run({ t: "sys.restore", entries: done.inverse, from: "redo", deps: true }, DM);
        if (res) {
          state = res.state;
          if (done.kind === "apply") {
            assert.ok(!applied.has(done.due!) && !dismissed.has(done.due!), where(n, "a redone Apply"));
            applied.add(done.due!);
          }
          if (done.kind === "dismiss" || done.kind === "sprung") dismissed.add(done.due!);
          if (done.kind === "act") actions.set(done.due!, (actions.get(done.due!) ?? 0) + 1);
          if (res.inverse) undo.push({ ...done, inverse: res.inverse });
        }
        check(state, n, "redo");
        continue;
      } else if (choice === 11) {
        op = chance(r, 0.5) ? { t: "trap.update", trapId: pick(r, ["a", "b", "c", "d"]), patch: { state: "armed", rig: { usesLeft: 3 } } } : { t: "trap.spring", trapId: pick(r, ["a", "b", "c", "d"]), tokenIds: ["thorn"] };
      } else {
        views[int(r, 0, 1)] = state;
        continue;
      }
      const res = run(op, who);
      last = { op, who };
      if (!res) {
        check(state, n, `${op.t} refused`);
        continue;
      }
      state = res.state;
      steps++;
      const due = op.t === "actor.outcome" ? op.trap?.due : op.t === "trap.settle" || op.t === "trap.act" ? op.due : undefined;
      if (due !== undefined) {
        // Invariant 4: only an occurrence still waiting is applied, dismissed or done.
        assert.ok(waiting.has(due), where(n, `${op.t} of ${due}, not waiting`));
        assert.ok(!applied.has(due) && !dismissed.has(due), where(n, `${op.t} of ${due}, already settled`));
      }
      if (kind === "apply") {
        applied.add(due!);
        applies++;
      }
      if (kind === "dismiss" || kind === "sprung") dismissed.add(due!);
      if (kind === "act") actions.set(due!, (actions.get(due!) ?? 0) + 1);
      // Springings that ran their actions as they went off.
      for (const d of dues(state)) if (!waiting.has(d.id) && d.acted) actions.set(d.id, (actions.get(d.id) ?? 0) + 1);
      if (who.role === "dm" && res.inverse) {
        undo.push({ kind, ...(due !== undefined ? { due } : {}), inverse: res.inverse });
        redo.length = 0;
      }
      check(state, n, op.t);
    }

    function check(s: RoomState, n: number, note: string): void {
      const all = dues(s);
      if (all.length === LIMITS.trapDuePerRoom) fullRooms++;
      // Invariant 3.
      assert.equal(new Set(all.map((d) => d.id)).size, all.length, where(n, `${note}: an occurrence twice`));
      assert.ok(all.length <= LIMITS.trapDuePerRoom, where(n, `${note}: ${all.length} in the room`));
      for (const t of Object.values(s.traps)) assert.ok((t.rig?.due?.length ?? 0) <= LIMITS.trapDuePerTrap, where(n, `${note}: ${t.id} holds too many`));
      // Invariants 1 and 2.
      for (const id of applied) assert.ok(!dismissed.has(id), where(n, `${note}: ${id} applied and dismissed`));
      for (const [id, count] of actions) assert.ok(count <= 1, where(n, `${note}: ${id}'s actions ran ${count} times`));
      for (const d of all) assert.ok(!applied.has(d.id) && !dismissed.has(d.id), where(n, `${note}: ${d.id} settled and still waiting`));
    }
  }
  assert.ok(steps > SEEDS * 10, `${steps} steps applied`);
  assert.ok(applies > 100 && undoneApplies > 10, `${applies} applies, ${undoneApplies} undone`);
  assert.ok(fullRooms > 100, `${fullRooms} steps with the room full`);
});
